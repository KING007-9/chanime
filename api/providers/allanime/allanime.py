import asyncio
import base64
import hashlib
import json
import logging
import re
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

logger = logging.getLogger(__name__)


class ZenithScraper:
    """
    Zenith Scraper - Full asynchronous Python port of the zeno-engine (AllAnime).
    Integrates natively with AniList IDs for exact metadata matching.
    """

    AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0"
    ALLANIME_REFR = "https://allmanga.to"
    ALLANIME_BASE = "allanime.day"
    ALLANIME_API = f"https://api.{ALLANIME_BASE}"
    ALLANIME_KEY = hashlib.sha256(b"Xot36i3lK3:v1").hexdigest()

    # Persisted query hash for episode embeds (from ani-cli)
    EPISODE_QUERY_HASH = "d405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec"

    DECODE_MAPPING = {
        "79": "A", "7a": "B", "7b": "C", "7c": "D", "7d": "E", "7e": "F", "7f": "G", "70": "H", "71": "I", "72": "J", "73": "K", "74": "L", "75": "M", "76": "N", "77": "O",
        "68": "P", "69": "Q", "6a": "R", "6b": "S", "6c": "T", "6d": "U", "6e": "V", "6f": "W", "60": "X", "61": "Y", "62": "Z",
        "59": "a", "5a": "b", "5b": "c", "5c": "d", "5d": "e", "5e": "f", "5f": "g", "50": "h", "51": "i", "52": "j", "53": "k", "54": "l", "55": "m", "56": "n", "57": "o",
        "48": "p", "49": "q", "4a": "r", "4b": "s", "4c": "t", "4d": "u", "4e": "v", "4f": "w", "40": "x", "41": "y", "42": "z",
        "08": "0", "09": "1", "0a": "2", "0b": "3", "0c": "4", "0d": "5", "0e": "6", "0f": "7", "00": "8", "01": "9",
        "15": "-", "16": ".", "67": "_", "46": "~", "02": ":", "17": "/", "07": "?", "1b": "#", "63": "[", "65": "]", "78": "@", "19": "!", "1c": "$", "1e": "&", "10": "(", "11": ")", "12": "*", "13": "+", "14": ",", "03": ";", "05": "=", "1d": "%"
    }

    def __init__(self, timeout: int = 8):
        self._timeout = aiohttp.ClientTimeout(total=timeout)
        self._mapping_cache: Dict[int, str] = {}  # anilist_id -> allanime show_id
        self._episodes_cache: Dict[str, Dict[str, Any]] = {}  # show_id -> episodes list
        self._semaphore = asyncio.Semaphore(5)

        logger.debug("[Zenith] Zenith provider initialized.")

    @property
    def headers(self) -> Dict[str, str]:
        return {
            "User-Agent": self.AGENT,
            "Referer": self.ALLANIME_REFR,
            "Origin": self.ALLANIME_REFR,
        }

    # ──────────────────────────────────────────────────────────
    #  Decryption helpers
    # ──────────────────────────────────────────────────────────
    def decrypt(self, blob: str) -> Optional[str]:
        """Decrypt the AllAnime CTR-encrypted source URL blob."""
        try:
            data = base64.b64decode(blob)
            iv = data[1:13]
            ct_len = len(data) - 13 - 16
            ciphertext = data[13:13+ct_len]
            ctr_block = iv + b"\x00\x00\x00\x02"

            key = bytes.fromhex(self.ALLANIME_KEY)
            cipher = Cipher(algorithms.AES(key), modes.CTR(ctr_block), backend=default_backend())
            decryptor = cipher.decryptor()
            decrypted = decryptor.update(ciphertext) + decryptor.finalize()
            return decrypted.decode("utf-8")
        except Exception as e:
            logger.warning(f"[Zenith] Decryption failed: {e}")
            return None

    def b64url_to_hex(self, b64url: str) -> str:
        """Convert base64url string to hex string with proper padding."""
        padded = b64url
        mod = len(padded) % 4
        if mod == 2:
            padded += "=="
        elif mod == 3:
            padded += "="
        b64 = padded.replace("-", "+").replace("_", "/")
        try:
            return base64.b64decode(b64).hex()
        except Exception:
            return ""

    def decode_provider_id(self, hex_str: str) -> str:
        """Custom Hex-to-ASCII decoding with Clock replacements."""
        result = ""
        for i in range(0, len(hex_str), 2):
            part = hex_str[i:i+2]
            result += self.DECODE_MAPPING.get(part, "")
        return result.replace("/clock", "/clock.json")

    # ──────────────────────────────────────────────────────────
    #  Network Request helpers
    # ──────────────────────────────────────────────────────────
    async def _post_json(self, session: aiohttp.ClientSession, url: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        async with self._semaphore:
            try:
                async with session.post(url, json=payload, headers=self.headers) as resp:
                    if resp.status == 200:
                        return await resp.json(content_type=None)
                    else:
                        logger.warning(f"[Zenith] POST {url} returned status {resp.status}")
            except Exception as e:
                logger.warning(f"[Zenith] POST {url} error: {e}")
        return None

    async def _get_json(self, session: aiohttp.ClientSession, url: str) -> Optional[Any]:
        async with self._semaphore:
            try:
                async with session.get(url, headers=self.headers) as resp:
                    if resp.status == 200:
                        return await resp.json(content_type=None)
                    else:
                        logger.warning(f"[Zenith] GET {url} returned status {resp.status}")
            except Exception as e:
                logger.warning(f"[Zenith] GET {url} error: {e}")
        return None

    # ──────────────────────────────────────────────────────────
    #  Provider Decryption Methods (Filemoon & Repackager)
    # ──────────────────────────────────────────────────────────
    async def get_filemoon_links(self, session: aiohttp.ClientSession, provider_path: str) -> List[Dict[str, str]]:
        all_links = []
        fetch_url = provider_path if provider_path.startswith("http") else f"https://{self.ALLANIME_BASE}{provider_path}"

        fm_data = await self._get_json(session, fetch_url)
        if isinstance(fm_data, dict) and fm_data.get("iv") and fm_data.get("payload") and fm_data.get("key_parts"):
            try:
                kp1 = fm_data["key_parts"][0]
                kp2 = fm_data["key_parts"][1]
                key_hex = self.b64url_to_hex(kp1) + self.b64url_to_hex(kp2)
                iv_hex = self.b64url_to_hex(fm_data["iv"]) + "00000002"

                payload_b64 = fm_data["payload"]
                p_mod = len(payload_b64) % 4
                if p_mod == 2:
                    payload_b64 += "=="
                elif p_mod == 3:
                    payload_b64 += "="
                payload_buf = base64.b64decode(payload_b64.replace("-", "+").replace("_", "/"))

                ciphertext = payload_buf[:-16]  # strip auth tag
                key = bytes.fromhex(key_hex)
                iv = bytes.fromhex(iv_hex)

                cipher = Cipher(algorithms.AES(key), modes.CTR(iv), backend=default_backend())
                decryptor = cipher.decryptor()
                plain = (decryptor.update(ciphertext) + decryptor.finalize()).decode("utf-8")

                # Regex extraction
                parts = plain.replace("{", "\n").replace("}", "\n").replace("[", "\n").replace("]", "\n").split("\n")
                for part in parts:
                    m1 = re.search(r'"url":"([^"]*)".*"height":(\d+)', part)
                    m2 = re.search(r'"height":(\d+).*"url":"([^"]*)"', part)
                    if m1:
                        url = m1.group(1).replace(r"\u0026", "&").replace(r"\u003D", "=")
                        all_links.append({"resolution": m1.group(2) + "p", "url": url})
                    elif m2:
                        url = m2.group(2).replace(r"\u0026", "&").replace(r"\u003D", "=")
                        all_links.append({"resolution": m2.group(1) + "p", "url": url})
            except Exception as e:
                logger.warning(f"[Zenith] Filemoon link decryption failed: {e}")

        return all_links

    async def get_links(self, session: aiohttp.ClientSession, provider_path: str) -> List[Dict[str, str]]:
        all_links = []
        if "tools.fast4speed.rsvp" in provider_path:
            all_links.append({"resolution": "1080p", "url": provider_path})
            return all_links

        fetch_url = provider_path if provider_path.startswith("http") else f"https://{self.ALLANIME_BASE}{provider_path}"
        provider_data = await self._get_json(session, fetch_url)

        if isinstance(provider_data, dict):
            links = provider_data.get("links") or []
            for link in links:
                if not isinstance(link, dict):
                    continue
                url = link.get("link")
                res = link.get("resolutionStr") or "unknown"

                if url and "repackager.wixmp.com" in url:
                    cleaned = url.replace("repackager.wixmp.com/", "").split(".urlset")[0]
                    qualities_match = re.search(r"\/,([^/]*),\/mp4", url)
                    if qualities_match:
                        qualities = qualities_match.group(1).split(",")
                        for q in qualities:
                            q_url = re.sub(r",[^/]*", q, cleaned, count=1)
                            all_links.append({"resolution": q, "url": q_url})
                    else:
                        all_links.append({"resolution": res, "url": url})
                elif url:
                    all_links.append({"resolution": res, "url": url})

            hls = provider_data.get("hls")
            if isinstance(hls, dict) and hls.get("url"):
                all_links.append({"resolution": "hls", "url": hls["url"]})

        return all_links

    # ──────────────────────────────────────────────────────────
    #  GraphQL Live Operations
    # ──────────────────────────────────────────────────────────
    async def search_anime(self, session: aiohttp.ClientSession, query_str: str) -> List[Dict[str, Any]]:
        """Search AllAnime shows by title query."""
        search_gql = """query($search: SearchInput $limit: Int $page: Int $countryOrigin: VaildCountryOriginEnumType) {
            shows( search: $search limit: $limit page: $page countryOrigin: $countryOrigin ) {
                edges {
                    _id
                    name
                    englishName
                    nativeName
                    aniListId
                    malId
                    availableEpisodes
                }
            }
        }"""
        payload = {
            "variables": {
                "search": {
                    "allowAdult": True,
                    "allowUnknown": True,
                    "query": query_str
                },
                "limit": 30,
                "page": 1,
                "countryOrigin": "ALL"
            },
            "query": search_gql
        }
        data = await self._post_json(session, f"{self.ALLANIME_API}/api", payload)
        if isinstance(data, dict):
            try:
                edges = data.get("data", {}).get("shows", {}).get("edges", []) or []
                return [e for e in edges if isinstance(e, dict)]
            except Exception:
                pass
        return []

    async def get_anime_details(self, session: aiohttp.ClientSession, show_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve detailed metadata for an AllAnime show ID."""
        query = """query ($showId: String!) {
            show( _id: $showId ) {
                _id
                name
                englishName
                nativeName
                thumbnail
                description
                status
                availableEpisodesDetail
            }
        }"""
        payload = {
            "variables": {"showId": show_id},
            "query": query
        }
        data = await self._post_json(session, f"{self.ALLANIME_API}/api", payload)
        if isinstance(data, dict):
            show = data.get("data", {}).get("show")
            if isinstance(show, dict):
                sub_detail = show.get("availableEpisodesDetail", {}).get("sub", []) or []
                dub_detail = show.get("availableEpisodesDetail", {}).get("dub", []) or []
                return {
                    "id": show.get("_id"),
                    "title": show.get("englishName") or show.get("name"),
                    "title_english": show.get("englishName") or show.get("name"),
                    "thumbnail_url": show.get("thumbnail"),
                    "synopsis": re.sub(r"<[^>]*>?", "", show.get("description") or ""),
                    "status": show.get("status"),
                    "episodes_sub": len(sub_detail),
                    "episodes_dub": len(dub_detail),
                    "episodes": {
                        "sub": sorted(sub_detail, key=lambda x: float(x) if x.replace(".", "", 1).isdigit() else 9999),
                        "dub": sorted(dub_detail, key=lambda x: float(x) if x.replace(".", "", 1).isdigit() else 9999)
                    }
                }
        return None

    # ──────────────────────────────────────────────────────────
    #  Mapping & Episode Blocks
    # ──────────────────────────────────────────────────────────
    async def map_anilist_to_allanime(self, session: aiohttp.ClientSession, anilist_id: int, title: str) -> Optional[str]:
        """Verify and resolve AniList ID to AllAnime ID using GraphQL fields."""
        if not anilist_id:
            return None
        anilist_id = int(anilist_id)

        if anilist_id in self._mapping_cache:
            return self._mapping_cache[anilist_id]

        logger.debug(f"[Zenith] Mapping AniList ID {anilist_id} ({title}) to AllAnime ID...")

        # Form search candidates: primary title, plus some cleaning
        candidates = [title]
        cleaned_title = re.sub(r"\s+\(Dub\)|\s+\(Sub\)|\s+Season\s+\d+.*", "", title, flags=re.IGNORECASE).strip()
        if cleaned_title and cleaned_title not in candidates:
            candidates.append(cleaned_title)

        for candidate in candidates:
            results = await self.search_anime(session, candidate)
            # 1. Exact AniList ID match first
            for edge in results:
                edge_al = edge.get("aniListId")
                if edge_al and str(edge_al) == str(anilist_id):
                    show_id = edge["_id"]
                    self._mapping_cache[anilist_id] = show_id
                    logger.debug(f"[Zenith] Perfect AniList ID Match: {anilist_id} -> {show_id}")
                    return show_id

            # 2. MAL ID match or close title fallback if AniList field is missing
            for edge in results:
                name = edge.get("name", "").lower()
                eng_name = (edge.get("englishName") or "").lower()
                target = candidate.lower()
                if name == target or eng_name == target:
                    show_id = edge["_id"]
                    self._mapping_cache[anilist_id] = show_id
                    logger.debug(f"[Zenith] Match by clean title fallback: {candidate} -> {show_id}")
                    return show_id

        logger.warning(f"[Zenith] Failed to map AniList ID {anilist_id} directly to AllAnime ID.")
        return None

    async def build_provider_blocks(self, anilist_id: int, anime_title: str) -> Dict[str, Dict[str, Any]]:
        """Construct episodes blocks for the unified scraper."""
        async with aiohttp.ClientSession(timeout=self._timeout) as session:
            show_id = await self.map_anilist_to_allanime(session, anilist_id, anime_title)
            if not show_id:
                return {}

            details = await self.get_anime_details(session, show_id)
            if not details:
                return {}

            sub_eps = []
            dub_eps = []

            for ep_num in details["episodes"]["sub"]:
                sub_eps.append({
                    "id": f"watch/zenith/{anilist_id}/sub/zenith-{ep_num}",
                    "number": float(ep_num) if "." in ep_num else int(ep_num),
                    "title": f"Episode {ep_num}",
                    "filler": False
                })

            for ep_num in details["episodes"]["dub"]:
                dub_eps.append({
                    "id": f"watch/zenith/{anilist_id}/dub/zenith-{ep_num}",
                    "number": float(ep_num) if "." in ep_num else int(ep_num),
                    "title": f"Episode {ep_num}",
                    "filler": False
                })

            return {
                "zenith": {
                    "meta": {"title": details["title"]},
                    "episodes": {
                        "sub": sub_eps,
                        "dub": dub_eps
                    }
                }
            }

    # ──────────────────────────────────────────────────────────
    #  Streaming Video Retrieval
    # ──────────────────────────────────────────────────────────
    def parse_source_lines(self, api_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Extract tobeparsed encrypted source URLs or direct source URLs."""
        resp_lines = []
        raw_json = json.dumps(api_data)
        
        if "tobeparsed" in raw_json:
            data = api_data.get("data", {})
            blob = api_data.get("tobeparsed") or data.get("tobeparsed") or data.get("episode", {}).get("tobeparsed")
            
            if not blob:
                tbp_match = re.search(r'"tobeparsed":"([^"]*)"', raw_json)
                if tbp_match:
                    blob = tbp_match.group(1)

            if blob:
                plain = self.decrypt(blob)
                if plain:
                    parts = plain.replace("{", "\n").replace("}", "\n").split("\n")
                    for part in parts:
                        m = re.search(r'"sourceUrl":"--([^"]*)".*"sourceName":"([^"]*)"', part)
                        if m:
                            resp_lines.append({"sourceName": m.group(2), "hex": m.group(1)})
                else:
                    logger.error("[Zenith] Decryption of tobeparsed blob failed.")
        
        elif api_data.get("data", {}).get("episode", {}).get("sourceUrls"):
            source_urls = api_data["data"]["episode"]["sourceUrls"]
            raw = json.dumps(source_urls)
            cleaned = raw.replace(r"\u002F", "/").replace("\\", "")
            parts = cleaned.replace("{", "\n").replace("}", "\n").split("\n")
            for part in parts:
                m = re.search(r'"sourceUrl":"--([^"]*)".*"sourceName":"([^"]*)"', part)
                if m:
                    resp_lines.append({"sourceName": m.group(2), "hex": m.group(1)})

        return resp_lines

    async def get_episode_url(self, anilist_id: int, title: str, ep_no: str, mode: str = "sub", quality: str = "best") -> Optional[Dict[str, Any]]:
        """Main entry point: fetches direct MP4 stream url for watch routes."""
        async with aiohttp.ClientSession(timeout=self._timeout) as session:
            show_id = await self.map_anilist_to_allanime(session, anilist_id, title)
            if not show_id:
                return None

            api_data = None

            # 1. Persisted query GET first
            try:
                query_vars = json.dumps({"showId": show_id, "translationType": mode, "episodeString": ep_no})
                query_ext = json.dumps({"persistedQuery": {"version": 1, "sha256Hash": self.EPISODE_QUERY_HASH}})
                api_url = f"{self.ALLANIME_API}/api?variables={urllib.parse.quote(query_vars)}&extensions={urllib.parse.quote(query_ext)}"

                headers = self.headers.copy()
                headers["Origin"] = "https://youtu-chan.com"

                async with session.get(api_url, headers=headers) as resp:
                    if resp.status == 200:
                        text_data = await resp.text()
                        if "tobeparsed" in text_data:
                            api_data = json.loads(text_data)
            except Exception:
                pass

            # 2. Fallback POST
            if not api_data:
                episode_embed_gql = """query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) {
                    episode( showId: $showId translationType: $translationType episodeString: $episodeString ) {
                        episodeString
                        sourceUrls
                    }
                }"""
                payload = {
                    "variables": {
                        "showId": show_id,
                        "translationType": mode,
                        "episodeString": ep_no
                    },
                    "query": episode_embed_gql
                }
                api_data = await self._post_json(session, f"{self.ALLANIME_API}/api", payload)

            if not api_data:
                return None

            resp_lines = self.parse_source_lines(api_data)
            if not resp_lines:
                return None

            # Provider preference ordering
            provider_defs = [
                {"name": "Yt-mp4", "filemoon": False},
                {"name": "S-mp4", "filemoon": False},
                {"name": "Luf-Mp4", "filemoon": False},
                {"name": "Fm-mp4", "filemoon": True}
            ]
            fallback_provider_defs = [
                {"name": "Default", "filemoon": False},
            ]

            # Parallel link fetching
            tasks = []
            for prov in provider_defs:
                entry = next((r for r in resp_lines if r["sourceName"] == prov["name"]), None)
                if not entry:
                    continue
                decoded_path = self.decode_provider_id(entry["hex"])
                if not decoded_path:
                    continue

                if prov["filemoon"]:
                    tasks.append(self.get_filemoon_links(session, decoded_path))
                else:
                    tasks.append(self.get_links(session, decoded_path))

            all_links = []
            pending_tasks = [asyncio.create_task(task) for task in tasks]
            try:
                for done in asyncio.as_completed(pending_tasks):
                    r = await done
                    if isinstance(r, list) and r:
                        all_links.extend(r)
                        break
            except Exception:
                pass
            finally:
                for task in pending_tasks:
                    if not task.done():
                        task.cancel()

            if not all_links:
                fallback_tasks = []
                for prov in fallback_provider_defs:
                    entry = next((r for r in resp_lines if r["sourceName"] == prov["name"]), None)
                    if not entry:
                        continue
                    decoded_path = self.decode_provider_id(entry["hex"])
                    if not decoded_path:
                        continue
                    fallback_tasks.append(self.get_links(session, decoded_path))

                fallback_results = await asyncio.gather(*fallback_tasks, return_exceptions=True)
                for r in fallback_results:
                    if isinstance(r, list):
                        all_links.extend(r)

            if not all_links:
                return None

            # Sort by quality numerical value descending
            def get_res_val(item) -> int:
                val = re.search(r"(\d+)", item.get("resolution", ""))
                return int(val.group(1)) if val else 0

            all_links.sort(key=get_res_val, reverse=True)

            # Select correct quality
            selected = None
            if quality == "best":
                selected = all_links[0]
            elif quality == "worst":
                numeric = [l for l in all_links if re.search(r"\d+", l["resolution"])]
                selected = numeric[-1] if numeric else all_links[-1]
            else:
                req_res = re.search(r"(\d+)", quality)
                req_val = int(req_res.group(1)) if req_res else 9999
                # Match requested resolution exactly if possible
                selected = next((l for l in all_links if quality in l["resolution"]), None)
                if not selected:
                    # Match closest resolution below requested
                    numeric = [l for l in all_links if re.search(r"\d+", l["resolution"])]
                    below = [l for l in numeric if get_res_val(l) <= req_val]
                    selected = below[0] if below else (numeric[-1] if numeric else all_links[0])

            if not selected:
                return None

            final_url = selected["url"].replace("//", "/").replace("https:/", "https://").replace("http:/", "http://")
            available_qualities = list(dict.fromkeys([l["resolution"] for l in all_links if "hls" not in l["resolution"]]))

            # Format standardized response
            sources = []
            for link in all_links:
                if "hls" not in link["resolution"]:
                    sources.append({
                        "file": link["url"],
                        "label": link["resolution"],
                        "type": "mp4"
                    })

            return {
                "source_type": "mp4",
                "video_link": final_url,
                "sources": sources,
                "available_qualities": available_qualities,
                "intro": {"start": 0, "end": 0},  # AllAnime has no native skip timestamps
                "outro": {"start": 0, "end": 0}
            }

# if __name__ == "__main__":
#     import asyncio
#     import logging

#     logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

#     ANILIST_ID = 21
#     TITLE      = "One Piece"
#     EPISODE    = "1"
#     MODE       = "sub"
#     QUALITY    = "best"

#     async def main():
#         scraper = ZenithScraper(timeout=20)

#         print("\n" + "="*60)
#         print(f"  AniList ID : {ANILIST_ID}  |  Title: {TITLE}")
#         print(f"  Episode    : {EPISODE}  |  Mode: {MODE}  |  Quality: {QUALITY}")
#         print("="*60 + "\n")

#         async with aiohttp.ClientSession(timeout=scraper._timeout) as session:
#             show_id = await scraper.map_anilist_to_allanime(session, ANILIST_ID, TITLE)

#         if not show_id:
#             print("❌  Could not map AniList ID. Aborting.")
#             return
#         print(f"✅  AllAnime Show ID : {show_id}\n")

#         print("🎬  Fetching stream URL...")
#         result = await scraper.get_episode_url(ANILIST_ID, TITLE, EPISODE, MODE, QUALITY)

#         if not result:
#             print("❌  No stream URL returned.")
#             return

#         print(f"\n  ✅  Video URL : {result['video_link']}")
#         print(f"  Qualities   : {', '.join(result['available_qualities'])}")
#         print("\n  All sources:")
#         for src in result["sources"]:
#             print(f"    [{src['label']:>6}]  {src['file']}")

#     asyncio.run(main())
