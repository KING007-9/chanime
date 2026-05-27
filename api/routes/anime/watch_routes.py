"""
Watch episode routes — Clean URL format: /watch/<anime_id>/ep-<number>
Server, language, and provider are resolved internally (not in URL).
"""

import asyncio
import re
import logging
import time
import aiohttp
from flask import (
    Blueprint,
    request,
    session,
    redirect,
    url_for,
    render_template,
    current_app,
    jsonify,
    make_response,
)
import secrets
from urllib.parse import parse_qs

from ...models.watchlist import get_watchlist_entry
from ...providers.video_utils import WORKER_BASE, proxy_video_sources
from ...utils.cipher import encrypt_payload, obfuscate_key

logger = logging.getLogger(__name__)

watch_routes_bp = Blueprint("watch_routes", __name__)

# Global cache for episode data to avoid session size limits (Flask session is max 4KB)
# Key: fetch_id, Value: all_episodes data
EPS_CACHE = {}
INFO_CACHE = {}
HINDI_CACHE = {}
SCHEDULE_CACHE = {}

def _resolve_anilist_id(anime_id_clean):
    """Resolve numeric AniList ID from numeric string or slug string."""
    if anime_id_clean.isdigit():
        return int(anime_id_clean)
    anime_info = INFO_CACHE.get(anime_id_clean)
    if not anime_info:
        try:
            anime_info = asyncio.run(current_app.ha_scraper.get_anime_info(anime_id_clean))
            if anime_info:
                INFO_CACHE[anime_id_clean] = anime_info
        except Exception:
            pass
    if anime_info and isinstance(anime_info, dict):
        anime = anime_info.get("info", anime_info)
        if isinstance(anime, dict):
            al_id = anime.get("anilistId") or anime.get("alID")
            if al_id:
                try:
                    return int(al_id)
                except (ValueError, TypeError):
                    pass
    return None

def _resolve_fetch_id(anime_id_clean, anilist_id=None):
    """Get the consistent cache key for EPS_CACHE."""
    if anime_id_clean.isdigit():
        return anime_id_clean
    al_id = anilist_id or _resolve_anilist_id(anime_id_clean)
    return str(al_id) if al_id else anime_id_clean


def _get_preferred_lang():
    """Get the user's preferred language from cookie → session → default."""
    lang = request.cookies.get("preferred_language")
    if lang in ("sub", "dub"):
        return lang
    return session.get("preferred_language", "sub")


def _get_preferred_provider():
    """Get the user's preferred provider from cookie → session → default."""
    return request.cookies.get("preferred_server") or session.get(
        "last_used_server", None
    )


def _parse_ep_number(num):
    """
    Safely parse an episode number to float for robust comparison.
    Handles int, float, "1", "1.0", "1.5", etc.
    """
    try:
        return float(str(num).strip())
    except (ValueError, TypeError, AttributeError):
        return -1.0


def _resolve_episode(episodes_data, ep_number, preferred_provider=None):
    """
    Given episodes data and a target episode number, resolve the full internal
    episode ID and provider info.

    FIX 1: Always sort ascending.
    FIX 2: If exact float match fails, fall back to positional lookup
            (handles scrapers that use 0-based numbering, e.g. Miruro ep
            number=1 actually means display episode 2).
    """
    eps_list = episodes_data.get("episodes", []) if episodes_data else []
    providers_map = episodes_data.get("providers_map", {}) if episodes_data else {}
    default_provider = (
        episodes_data.get("default_provider", "kiwi") if episodes_data else "kiwi"
    )

    if not eps_list:
        return None

    try:
        sorted_eps = sorted(
            eps_list, key=lambda e: _parse_ep_number(e.get("number", 0))
        )
    except Exception:
        sorted_eps = list(eps_list)

    ep_num_float = _parse_ep_number(ep_number)

    # ── Pass 1: exact float match ──────────────────────────────────────────
    target_item = None
    target_idx = None
    for i, ep in enumerate(sorted_eps):
        if _parse_ep_number(ep.get("number")) == ep_num_float:
            target_item = ep
            target_idx = i
            break

    # ── Pass 2: positional fallback for 0-based scrapers ──────────────────
    # If Miruro numbers episodes 0, 1, 2, 3… but the URL uses 1, 2, 3, 4…
    # then ep_number=2 won't find number=2 (which is ep 3).
    # Instead use ep_number as a 1-based position: index = ep_number - 1.
    if target_item is None:
        positional_idx = int(ep_num_float) - 1
        if 0 <= positional_idx < len(sorted_eps):
            target_item = sorted_eps[positional_idx]
            target_idx = positional_idx

            logging.getLogger(__name__).warning(
                f"[Watch] Exact ep match failed for {ep_number}, "
                f"using positional fallback → idx {positional_idx}, "
                f"ep.number={target_item.get('number')}"
            )

    if target_item is None:
        return None

    provider_name = preferred_provider or default_provider
    if provider_name not in providers_map:
        provider_name = default_provider

    return {
        "episode_item": target_item,
        "episode_idx": target_idx,
        "episode_id": target_item.get("episodeId", ""),
        "provider_name": provider_name,
        "eps_list": sorted_eps,
    }


def _find_episode_id_for_provider(
    providers_map, provider_name, ep_number, category="sub"
):
    """Find the episode ID for a specific provider and episode number."""
    if not providers_map or provider_name not in providers_map:
        return None

    provider_data = providers_map[provider_name]
    episodes_data = provider_data.get("episodes", {})
    cat_episodes = episodes_data.get(category, [])

    ep_num_float = _parse_ep_number(ep_number)
    for ep in cat_episodes:
        if _parse_ep_number(ep.get("number")) == ep_num_float:
            return ep.get("id", "")

    return None


def _build_clean_url(anime_id, ep_number):
    """Build a clean episode URL."""
    return f"/watch/{anime_id}/ep-{ep_number}"


def _fetch_video_data(full_slug, lang, server, anilist_id):
    """Fetch video data from the scraper and return structured result."""
    raw = asyncio.run(current_app.ha_scraper.video(full_slug, lang, server, anilist_id))
    return _parse_video_raw(raw)


def _parse_video_raw(raw):
    """Parse raw scraper response into structured video data."""
    video_link = None
    subtitle_tracks = []
    intro = outro = None
    video_sources = []
    available_qualities = []
    embed_sources = []
    hls_sources = []
    source_type = None

    if isinstance(raw, dict):
        source_type = raw.get("source_type")
        embed_sources = raw.get("embed_sources", [])
        raw_hls_sources = raw.get("hls_sources", [])
        raw_sources = raw.get("sources", [])
        hls_sources = raw_hls_sources if isinstance(raw_hls_sources, list) else []
        video_link = raw.get("video_link")
        if isinstance(raw_sources, list):
            video_sources = [
                s for s in raw_sources if isinstance(s, dict) and s.get("file")
            ]

        # Prefer HLS over embed when both are available. Direct MP4 sources must
        # not be reported as HLS, or the watch UI marks the wrong capability.
        if hls_sources and source_type != "mp4":
            source_type = "hls"
        elif not source_type:
            if embed_sources:
                source_type = "embed"
            elif video_sources:
                source_type = "mp4"

        # When HLS is selected, ALWAYS use actual HLS URL (not embed URL from scraper)
        if source_type == "hls" and hls_sources:
            first_hls = hls_sources[0] if isinstance(hls_sources, list) else None
            if isinstance(first_hls, dict):
                hls_url = first_hls.get("file") or first_hls.get("url")
                if hls_url:
                    video_link = hls_url
            elif isinstance(first_hls, str):
                video_link = first_hls
        elif source_type == "hls" and not video_link:
            sources = raw.get("sources")
            if isinstance(sources, dict):
                video_link = sources.get("file") or sources.get("url")
            elif isinstance(sources, list) and sources:
                first_source = sources[0]
                if isinstance(first_source, dict):
                    video_link = first_source.get("file") or first_source.get("url")
                elif isinstance(first_source, str):
                    video_link = first_source
        elif source_type == "embed" and embed_sources:
            video_link = embed_sources[0].get("url", "")
        elif source_type == "mp4" and not video_link and video_sources:
            video_link = video_sources[0].get("file") or video_sources[0].get("url")

        available_qualities = raw.get("available_qualities", [])
        subtitle_tracks = raw.get("tracks", [])
        intro = raw.get("intro")
        outro = raw.get("outro")

    logger.debug(
        f"[_fetch_video_data] source_type={source_type}, video_link={str(video_link)[:80] if video_link else 'NONE'}, intro={intro}, outro={outro}"
    )

    return {
        "video_link": video_link,
        "subtitle_tracks": subtitle_tracks,
        "intro": intro,
        "outro": outro,
        "video_sources": video_sources,
        "available_qualities": available_qualities,
        "embed_sources": embed_sources,
        "hls_sources": hls_sources,
        "source_type": source_type,
    }


def _fetch_video_only(
    full_slug, lang, server, anilist_id, providers_map, ep_number=None
):
    """
    Fetch video data for the selected provider ONLY.
    Returns (video_data_dict, provider_capabilities_dict).
    Capabilities are based on what was actually returned — not guessed.
    """
    try:
        raw = asyncio.run(
            current_app.ha_scraper.video(full_slug, lang, server, anilist_id, ep_number=ep_number)
        )
        video_data = _parse_video_raw(raw)
    except Exception as e:
        logger.warning(f"[FetchVideo] Error fetching video: {e}")
        video_data = _parse_video_raw(None)

    # Only report capabilities for the provider we actually fetched
    # Apply backend proxying so the frontend doesn't need to know the WORKER_URL
    video_data = proxy_video_sources(video_data, provider=server)
    
    # Recalculate capabilities based on proxied data
    capabilities = {}
    if server:
        has_hls = bool(video_data.get("hls_sources"))
        has_embed = bool(video_data.get("embed_sources"))
        has_mp4 = bool(video_data.get("video_sources")) or video_data.get("source_type") == "mp4"
        capabilities[server] = {"hls": has_hls or has_mp4, "embed": has_embed, "mp4": has_mp4}

    logger.debug(f"[FetchVideo] Final intro: {video_data.get('intro')}")
    logger.debug(f"[FetchVideo] Final outro: {video_data.get('outro')}")
    logger.debug(f"[FetchVideo] Provider {server}: hls={capabilities.get(server, {}).get('hls')}, embed={capabilities.get(server, {}).get('embed')}")
    return video_data, capabilities


def _scavenge_intro_outro(video_data, providers_map, ep_number, lang, selected_server, anilist_id):
    """
    If the current provider has no intro/outro, try to find them from
    other available providers to ensure global skip availability.
    """
    if not video_data.get("intro") and not video_data.get("outro") and anilist_id:
        other_providers = [p for p in providers_map.keys() if p != selected_server]
        # Prioritize providers likely to have metadata (Arc consistently provides this)
        other_providers.sort(key=lambda p: 0 if p == 'arc' else (1 if p.startswith('ax-') else 2))
        
        for other_p in other_providers[:3]: # try up to 3 other providers
            other_ep_id = _find_episode_id_for_provider(providers_map, other_p, ep_number, lang)
            if other_ep_id:
                try:
                    logger.debug(f"[Scavenge] Checking {other_p} for intro/outro metadata...")
                    # Construct full slug for other provider
                    if other_ep_id.startswith("watch/"):
                        p_parts = other_ep_id.split("/")
                        if len(p_parts) >= 5: p_parts[3] = lang
                        other_full_slug = "/".join(p_parts)
                    else:
                        other_full_slug = other_ep_id

                    # Fetch ONLY to get metadata (scraper cache will help)
                    m_data = asyncio.run(current_app.ha_scraper.video(other_full_slug, lang, other_p, anilist_id))
                    if m_data.get("intro") or m_data.get("outro"):
                        video_data["intro"] = m_data.get("intro")
                        video_data["outro"] = m_data.get("outro")
                        logger.debug(f"[Scavenge] SUCCESS: Found intro/outro from {other_p}!")
                        break
                except Exception as e:
                    logger.debug(f"[Scavenge] Failed to check {other_p}: {e}")
    return video_data


# ──────────────────────────────────────────────────────────────
#  LEGACY REDIRECT: old ?ep= format → new clean URL
# ──────────────────────────────────────────────────────────────


@watch_routes_bp.route("/watch/<eps_title>", methods=["GET"])
def watch_legacy(eps_title):
    """Handle old URL format and redirect to clean URLs."""
    ep_param = request.args.get("ep")

    # If there's no ?ep= param, this is just /watch/<anime_id> — redirect to best episode
    if not ep_param:
        return _redirect_to_best_episode(eps_title)

    # Try to extract episode number from old ep_param formats
    ep_number = _extract_ep_number_from_legacy(ep_param, eps_title)

    if ep_number is not None:
        return redirect(_build_clean_url(eps_title, ep_number), code=301)

    # If we can't extract, try fetching episodes to resolve
    return _redirect_to_best_episode(eps_title)


def _extract_ep_number_from_legacy(ep_param, anime_id):
    """Try to extract a simple episode number from the old ?ep= format."""
    # Format: watch/kiwi/179062/sub/animepahe-1 → extract trailing number
    if ep_param.startswith("watch/"):
        parts = ep_param.split("/")
        if len(parts) >= 5:
            slug = parts[-1]  # e.g. animepahe-1
            num_match = re.search(r"(\d+)$", slug)
            if num_match:
                return int(num_match.group(1))

    # Format: 12345-sub or just 12345
    parts = ep_param.split("-", 1)
    if parts[0].isdigit():
        return int(parts[0])

    # Try extracting trailing number from any format
    num_match = re.search(r"(\d+)$", ep_param.split("-sub")[0].split("-dub")[0])
    if num_match:
        return int(num_match.group(1))

    return None


def _redirect_to_best_episode(anime_id):
    """
    Redirects to the user's next unwatched episode based on DB history.
    Just redirects to episode 1 for now — the full watch route will handle
    episode resolution and clamping once it's loaded.
    """
    anime_id_clean = anime_id.split("?", 1)[0]
    target_ep = 1

    # Check user watchlist for progress if logged in (from DB only, no API calls)
    if "username" in session and "_id" in session:
        watched_count = 0
        try:
            from api.models.watchlist import get_watchlist_entry

            user_id = session.get("_id")
            watchlist_entry = get_watchlist_entry(user_id, anime_id_clean)
            if watchlist_entry:
                watched_count = watchlist_entry.get("watched_episodes", 0)

            if watched_count > 0:
                target_ep = watched_count + 1
        except Exception as e:
            current_app.logger.error(
                f"Error fetching watchlist entry in watch route: {e}"
            )

    return redirect(_build_clean_url(anime_id_clean, target_ep))


# ──────────────────────────────────────────────────────────────
#  MAIN CLEAN ROUTE: /watch/<anime_id>/ep-<number>
# ──────────────────────────────────────────────────────────────


@watch_routes_bp.route("/watch/<anime_id>/ep-<int:ep_number>", methods=["GET", "POST"])
def watch(anime_id, ep_number):
    """Watch episode page — clean URL format. Serves instant loading skeleton."""
    lang = _get_preferred_lang()
    preferred_provider = _get_preferred_provider()

    # ── Fetch anime info (using global cache to avoid slow load times) ──
    anime_id_clean = anime_id.split("?", 1)[0]
    anime_info = INFO_CACHE.get(anime_id_clean)
    anilist_id = None
    anime = None

    if anime_info:
        if isinstance(anime_info, dict):
            if "info" in anime_info and isinstance(anime_info["info"], dict):
                anime = anime_info["info"]
            else:
                anime = anime_info
            anilist_id = anime.get("anilistId") or anime.get("alID")
            if anilist_id:
                try:
                    anilist_id = int(anilist_id)
                except (ValueError, TypeError):
                    anilist_id = None
    else:
        try:
            anime_info = asyncio.run(current_app.ha_scraper.get_anime_info(anime_id_clean))
            if anime_info:
                INFO_CACHE[anime_id_clean] = anime_info
                if isinstance(anime_info, dict):
                    if "info" in anime_info and isinstance(anime_info["info"], dict):
                        anime = anime_info["info"]
                    else:
                        anime = anime_info
                    anilist_id = anime.get("anilistId") or anime.get("alID")
                    if anilist_id:
                        try:
                            anilist_id = int(anilist_id)
                        except (ValueError, TypeError):
                            anilist_id = None
        except Exception as e:
            current_app.logger.error(f"[Watch] Error getting anime info: {e}")

    # Resolve anime info dict
    if (
        isinstance(anime_info, dict)
        and "info" in anime_info
        and isinstance(anime_info["info"], dict)
    ):
        anime = anime_info["info"]
    else:
        anime = anime_info or {}

    actual_title = anime.get("name") or anime.get("title")
    if not actual_title:
        actual_title = anime_id_clean.replace("-", " ").title()

    mal_id = anime.get("malId") or anime.get("malID") if isinstance(anime, dict) else None

    # Next airing episode info from cache/info
    next_episode_schedule = anime.get("nextAiringEpisode") if isinstance(anime, dict) else None

    is_logged_in = "username" in session and "_id" in session

    # Determine server
    selected_server = preferred_provider or "kiwi"

    from api.providers.miruro.episodes import PROVIDER_CAPABILITIES as _PC

    # ── Generate cipher key for frontend AJAX decryption ──
    if "cipher_key" not in session:
        session["cipher_key"] = secrets.token_hex(16)
    cipher_key = session["cipher_key"]
    cipher_key_obfuscated = obfuscate_key(cipher_key)

    # ── Render watch.html instantly with skeleton loaders ──
    try:
        return render_template(
            "anime/watch.html",
            back_to_ep=anime_id_clean,
            anime_id=anime_id_clean,
            video_link=None,
            subtitles=[],
            intro=None,
            outro=None,
            Episode=str(ep_number),
            episode_number=ep_number,
            episode_title=f"Episode {ep_number}",
            episode_image=None,
            prev_episode_url=None,
            next_episode_url=None,
            prev_episode_number=None,
            next_episode_number=None,
            eps_title=anime_id_clean,
            anime_title=actual_title,
            anime=anime,
            lang=lang,
            episodes=None,  # Signifies loading skeleton
            dub_available=False,
            hindi_available=False,
            selected_server=selected_server,
            available_servers=[],
            next_episode_schedule=next_episode_schedule,
            video_sources=[],
            available_qualities=[],
            source_type=None,
            embed_sources=[],
            hls_sources=[],
            server_progress={},
            is_logged_in=is_logged_in,
            provider_capabilities={},
            provider_capabilities_map=_PC,
            sorted_providers=[],
            mal_id=mal_id,
            enc_sources="",
            cipher_key_obfuscated=cipher_key_obfuscated,
        )
    except Exception as e:
        logger.error(f"watch error: {e}")
        return render_template(
            "shared/404.html", error_message="An error occurred while fetching the watch page."
        )


# ──────────────────────────────────────────────────────────────
#  AJAX ENDPOINT: Switch server/language without page reload
# ──────────────────────────────────────────────────────────────


@watch_routes_bp.route("/api/watch/clear-cache", methods=["POST"])
def clear_watch_cache():
    """Clear the global cached providers_map for an anime."""
    data = request.get_json() or {}
    anime_id = data.get("anime_id")
    if not anime_id:
        return jsonify({"success": False, "error": "Missing anime_id"}), 400
    
    clean_id = str(anime_id).split("?", 1)[0]
    fetch_id = _resolve_fetch_id(clean_id)
    
    # Remove from global cache
    removed = 0
    if fetch_id in EPS_CACHE:
        del EPS_CACHE[fetch_id]
        removed += 1
    
    # Also clean up any session junk left over from previous broken implementation
    keys = list(session.keys())
    for k in keys:
        if k.startswith("eps_cache_"):
            session.pop(k, None)
            
    return jsonify({"success": True, "removed_count": removed})


@watch_routes_bp.route("/api/watch/sources", methods=["POST"])
def get_watch_sources():
    """
    AJAX endpoint for switching server/language/provider without changing the URL.
    Accepts JSON: { anime_id, episode_number, language, provider }
    Returns JSON with video sources data.
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "Missing request body"}), 400

    anime_id = data.get("anime_id")
    ep_number = data.get("episode_number")
    lang = data.get("language", "sub")
    provider = data.get("provider")
    anime_slug = data.get("anime_slug")  # May be passed from frontend

    if not anime_id or ep_number is None:
        return jsonify({"error": "Missing anime_id or episode_number"}), 400

    anime_id_clean = str(anime_id).split("?", 1)[0]

    # Resolve anilist_id and construct anime_slug for anidap discovery
    anilist_id = None
    anime_info = None
    try:
        anime_info = asyncio.run(current_app.ha_scraper.get_anime_info(anime_id_clean))
        if isinstance(anime_info, dict):
            info = anime_info.get("info", anime_info)
            if isinstance(info, dict):
                anilist_id = info.get("anilistId") or info.get("alID")
                if anilist_id:
                    anilist_id = int(anilist_id)
    except Exception:
        pass

    # Construct anime_slug if not provided
    if not anime_slug:
        if not anime_id_clean.isdigit():
            anime_slug = anime_id_clean
        elif anime_info and isinstance(anime_info, dict):
            info = anime_info.get("info", anime_info)
            if isinstance(info, dict):
                title = info.get("title") or info.get("name")
                if title:
                    anime_slug = re.sub(r'[^\w\s-]', '', title.lower()).replace(' ', '-').strip('-')

    fetch_id = _resolve_fetch_id(anime_id_clean, anilist_id)

    # Fetch episodes with anime_slug for anidap provider discovery
    try:
        all_episodes = EPS_CACHE.get(fetch_id)
        if not all_episodes:
            all_episodes = asyncio.run(current_app.ha_scraper.episodes(fetch_id, anime_slug))
            if all_episodes and all_episodes.get("providers_map"):
                EPS_CACHE[fetch_id] = all_episodes
    except Exception:
        return jsonify({"error": "Failed to fetch episodes"}), 500

    providers_map = all_episodes.get("providers_map", {}) if all_episodes else {}
    default_provider = (
        all_episodes.get("default_provider", "kiwi") if all_episodes else "kiwi"
    )

    # Resolve provider
    provider_name = provider or default_provider
    if provider_name not in providers_map and provider_name not in ("zoro", "anixtv"):
        provider_name = default_provider

    # Find episode ID for this provider (uses float comparison now)
    episode_id = _find_episode_id_for_provider(
        providers_map, provider_name, ep_number, lang
    )

    # Fallback: try the default episode list
    if not episode_id:
        resolved = _resolve_episode(all_episodes, ep_number, provider_name)
        if resolved:
            episode_id = resolved["episode_id"]

    if not episode_id and provider_name not in ("zoro", "anixtv"):
        return jsonify({"error": f"Episode {ep_number} not found"}), 404

    # Build full slug
    if episode_id and episode_id.startswith("watch/"):
        parts = episode_id.split("/")
        if len(parts) >= 5:
            parts[3] = lang
        full_slug = "/".join(parts)
    else:
        full_slug = episode_id or str(ep_number)

    # Determine server
    selected_server = provider_name

    # Fetch available servers (Obsolete)
    available_servers = []

    # Fetch video data for selected provider only (no scanning)
    video_data, provider_capabilities = _fetch_video_only(
        full_slug, lang, selected_server, anilist_id, providers_map, ep_number=ep_number
    )

    # Scavenge for intro/outro from other providers if missing
    video_data = _scavenge_intro_outro(
        video_data, providers_map, ep_number, lang, selected_server, anilist_id
    )

    # Determine if this provider actually has working sources
    has_hls = bool(video_data.get("hls_sources"))
    has_embed = bool(video_data.get("embed_sources"))
    has_mp4 = bool(video_data.get("video_sources")) or video_data.get("source_type") == "mp4"
    has_sources = has_hls or has_embed or has_mp4

    # Only save preferences if the provider actually had sources
    if selected_server and has_sources:
        session["last_used_server"] = selected_server

    anime_title = ""
    if anime_info and isinstance(anime_info, dict):
        info = anime_info.get("info", anime_info)
        if isinstance(info, dict):
            anime_title = info.get("name") or info.get("title") or ""
            
    if not anime_title and all_episodes:
        anime_title = all_episodes.get("title") or ""
        
    if not anime_title and not anime_id_clean.isdigit():
        anime_title = anime_id_clean.replace("-", " ").title()

    response_data = {
        "video_link": video_data["video_link"],
        "anime_name": anime_title,
        "subtitles": video_data["subtitle_tracks"],
        "intro": video_data["intro"],
        "outro": video_data["outro"],
        "source_type": video_data["source_type"],
        "embed_sources": video_data["embed_sources"],
        "hls_sources": video_data["hls_sources"],
        "video_sources": video_data["video_sources"],
        "available_qualities": video_data["available_qualities"],
        "provider": provider_name,
        "language": lang,
        "available_servers": available_servers,
        "provider_capabilities": provider_capabilities,
        "available": has_sources,
    }
    
    # Apply backend proxying for AJAX response
    response_data = proxy_video_sources(response_data, provider=provider_name)

    # Signal error to frontend when provider has no sources
    if not has_sources:
        response_data["error"] = f"no_sources"
        response_data["message"] = f"Provider '{provider_name}' has no playable sources for this episode."
        logger.warning(f"[API /sources] Provider {provider_name}: NO SOURCES — frontend will auto-fallback")

    # Clean watchdog log - print once per request
    print(f"[Info] Anime ID: {anime_id_clean} | Episode: {ep_number} | Language: {lang}")
    print(f"[Source] Provider: {provider_name} ({response_data.get('source_type') or 'none'}) -> {response_data.get('video_link') or 'None'}")
    print(f"[Time] Intro: {response_data.get('intro')} | Outro: {response_data.get('outro')}")

    # Encrypt the response payload
    if "cipher_key" not in session:
        session["cipher_key"] = secrets.token_hex(16)
    cipher_key = session["cipher_key"]
    
    encrypted_payload = encrypt_payload(response_data, cipher_key)
    
    resp = make_response(jsonify({"ct": encrypted_payload}))
    resp.set_cookie(
        "preferred_language", lang, max_age=365 * 24 * 60 * 60, samesite="Lax"
    )
    if has_sources:
        resp.set_cookie(
            "preferred_server", provider_name, max_age=365 * 24 * 60 * 60, samesite="Lax"
        )

    return resp


# ──────────────────────────────────────────────────────────────
#  AJAX ENDPOINTS FOR ASYNC / PROGRESSIVE PROVIDER LOADING
# ──────────────────────────────────────────────────────────────

@watch_routes_bp.route("/api/watch/<anime_id>/episodes", methods=["GET"])
def get_episodes_list_ajax(anime_id):
    """
    Fast AJAX endpoint returning the basic episodes list and initial providers.
    Uses Miruro (which is extremely fast) to get the first set of providers and episodes.
    """
    anime_id_clean = anime_id.split("?", 1)[0]

    # Resolve anilist_id and anime_slug from INFO_CACHE or scraper
    anilist_id = None
    anime_slug = None
    anime_info = INFO_CACHE.get(anime_id_clean)
    if not anime_info:
        try:
            anime_info = asyncio.run(current_app.ha_scraper.get_anime_info(anime_id_clean))
            if anime_info:
                INFO_CACHE[anime_id_clean] = anime_info
        except Exception:
            pass

    anime = {}
    mal_id = None
    if anime_info:
        if isinstance(anime_info, dict):
            anime = anime_info.get("info", anime_info)
            anilist_id = anime.get("anilistId") or anime.get("alID")
            if anilist_id:
                try:
                    anilist_id = int(anilist_id)
                except (ValueError, TypeError):
                    anilist_id = None
            mal_id = anime.get("malId") or anime.get("malID")

    if not anime_id_clean.isdigit():
        anime_slug = anime_id_clean
    elif anime and isinstance(anime, dict):
        title = anime.get("title") or anime.get("name")
        if title:
            anime_slug = re.sub(r'[^\w\s-]', '', title.lower()).replace(' ', '-').strip('-')

    fetch_id = _resolve_fetch_id(anime_id_clean, anilist_id)

    # Fetch fast using only Miruro episodes!
    try:
        all_episodes = EPS_CACHE.get(fetch_id)
        if not all_episodes:
            all_episodes = asyncio.run(current_app.ha_scraper.miruro.episodes(fetch_id, anime_slug))
            if all_episodes and all_episodes.get("providers_map"):
                # Seed the cache so other routes can use it / write to it
                EPS_CACHE[fetch_id] = all_episodes
    except Exception as e:
        current_app.logger.error(f"[AJAX Episodes] Error: {e}")
        all_episodes = None

    if not all_episodes:
        return jsonify({"success": False, "error": "Failed to fetch episodes"}), 500

    # Determine dub availability from providers_map
    dub_available = False
    providers_map = all_episodes.get("providers_map", {})
    for pv_data in providers_map.values():
        if isinstance(pv_data, dict) and "episodes" in pv_data:
            eps = pv_data["episodes"] or {}
            if eps.get("dub") and len(eps["dub"]) > 0:
                dub_available = True
                break

    from api.providers.miruro.episodes import PROVIDER_PRIORITY as _PP

    allowed_hlss = ["zenith", "kiwi", "ax-mimi", "ax-wave", "ax-shiro", "ax-yuki", "ax-zen", "ax-beep", "bee"]
    sorted_providers = sorted(
        [p for p in providers_map.keys() if p in allowed_hlss],
        key=lambda p: _PP.index(p) if p in _PP else len(_PP),
    )
    if (mal_id or anilist_id) and "zoro" not in sorted_providers:
        sorted_providers.append("zoro")

    anime_title = ""
    if all_episodes:
        anime_title = all_episodes.get("title") or ""
    
    if not anime_title and anime_info:
        if isinstance(anime_info, dict):
            info = anime_info.get("info", anime_info)
            if isinstance(info, dict):
                anime_title = info.get("name") or info.get("title") or ""
                
    if not anime_title and not anime_id_clean.isdigit():
        anime_title = anime_id_clean.replace("-", " ").title()

    return jsonify({
        "success": True,
        "anime_name": anime_title,
        "episodes": all_episodes.get("episodes", []),
        "totalEpisodes": all_episodes.get("totalEpisodes", 0),
        "providers_map": providers_map,
        "default_provider": all_episodes.get("default_provider", "kiwi"),
        "dub_available": dub_available,
        "sorted_providers": sorted_providers
    })


@watch_routes_bp.route("/api/watch/<anime_id>/episodes/zenith", methods=["GET"])
def get_zenith_episodes(anime_id):
    """AJAX endpoint to progressively discover and cache Zenith episodes/provider block."""
    anime_id_clean = anime_id.split("?", 1)[0]

    anime_title = ""
    anime_info = INFO_CACHE.get(anime_id_clean)
    if anime_info and isinstance(anime_info, dict):
        anime = anime_info.get("info", anime_info)
        anime_title = anime.get("title") or anime.get("name") or ""

    if not anime_title:
        anime_title = anime_id_clean.replace("-", " ").title()

    anilist_id = _resolve_anilist_id(anime_id_clean)
    if not anilist_id:
        return jsonify({"success": False, "error": "Zenith requires numeric AniList ID"}), 400

    try:
        zenith_blocks = asyncio.run(current_app.ha_scraper.zenith.build_provider_blocks(anilist_id, anime_title))
        
        # Progressive write-through cache!
        if zenith_blocks:
            fetch_id = _resolve_fetch_id(anime_id_clean, anilist_id)
            all_episodes = EPS_CACHE.get(fetch_id)
            if all_episodes:
                providers_map = all_episodes.setdefault("providers_map", {})
                for server_id, block in zenith_blocks.items():
                    providers_map[server_id] = block
                EPS_CACHE[fetch_id] = all_episodes

        return jsonify({
            "success": True,
            "provider": "zenith",
            "blocks": zenith_blocks
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@watch_routes_bp.route("/api/watch/<anime_id>/episodes/animex", methods=["GET"])
def get_animex_episodes(anime_id):
    """AJAX endpoint to progressively discover and cache AnimeX provider blocks."""
    anime_id_clean = anime_id.split("?", 1)[0]

    anime_title = ""
    anime_info = INFO_CACHE.get(anime_id_clean)
    if anime_info and isinstance(anime_info, dict):
        anime = anime_info.get("info", anime_info)
        anime_title = anime.get("title") or anime.get("name") or ""

    if not anime_title:
        anime_title = anime_id_clean.replace("-", " ").title()

    anilist_id = _resolve_anilist_id(anime_id_clean)
    if not anilist_id:
        return jsonify({"success": False, "error": "AnimeX requires numeric AniList ID"}), 400

    try:
        ax_blocks = asyncio.run(current_app.ha_scraper.animex.build_provider_blocks(anilist_id, anime_title))
        
        # Progressive write-through cache!
        if ax_blocks:
            fetch_id = _resolve_fetch_id(anime_id_clean, anilist_id)
            all_episodes = EPS_CACHE.get(fetch_id)
            if all_episodes:
                providers_map = all_episodes.setdefault("providers_map", {})
                for server_id, block in ax_blocks.items():
                    providers_map[f"ax-{server_id}"] = block
                EPS_CACHE[fetch_id] = all_episodes

        return jsonify({
            "success": True,
            "blocks": ax_blocks
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@watch_routes_bp.route("/api/watch/<anime_id>/episodes/hindi", methods=["GET"])
def check_hindi_dub_ajax(anime_id):
    """AJAX endpoint to progressively check Hindi dub availability for an episode."""
    anime_id_clean = anime_id.split("?", 1)[0]
    ep_number = request.args.get("episode", default=1, type=int)

    anilist_id = None
    anime_info = INFO_CACHE.get(anime_id_clean)
    if not anime_info:
        try:
            anime_info = asyncio.run(current_app.ha_scraper.get_anime_info(anime_id_clean))
            if anime_info:
                INFO_CACHE[anime_id_clean] = anime_info
        except Exception:
            pass

    if anime_info and isinstance(anime_info, dict):
        anime = anime_info.get("info", anime_info)
        anilist_id = anime.get("anilistId") or anime.get("alID")

    if not anilist_id and anime_id_clean.isdigit():
        anilist_id = int(anime_id_clean)

    if not anilist_id:
        return jsonify({"success": True, "hindi_available": False})

    cache_key = f"{anilist_id}_{ep_number}"
    if cache_key in HINDI_CACHE:
        return jsonify({"success": True, "hindi_available": HINDI_CACHE[cache_key]})

    try:
        async def check_hindi():
            embed_url = f"https://anixtv.in/anime-watch?action=hindi_1_player&id={anilist_id}&season=1&episode={ep_number}"
            async with aiohttp.ClientSession() as session:
                async with session.get(embed_url, timeout=5.0) as resp:
                    text = await resp.text()
                    if "We couldn't find a Hindi Dub" not in text and "Error: Could not map" not in text and "<iframe" in text:
                        return True
            return False

        hindi_available = asyncio.run(check_hindi())
        HINDI_CACHE[cache_key] = hindi_available
        return jsonify({"success": True, "hindi_available": hindi_available})
    except Exception:
        return jsonify({"success": True, "hindi_available": False})
