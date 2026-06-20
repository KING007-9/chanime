import logging
import re
import time
import aiohttp

logger = logging.getLogger(__name__)

# Simple in-memory cache: anilist_id (int) -> {"entries": list, "expires_at": float}
_watch_order_cache = {}
CACHE_TTL = 7 * 24 * 60 * 60  # 7 days TTL

async def scrape_watch_order(mal_id: int) -> list:
    url = f"https://chiaki.site/?/tools/watch_order/id/{mal_id}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as response:
                if response.status != 200:
                    logger.warning(f"scrape_watch_order: Chiaki returned status {response.status} for MAL ID {mal_id}")
                    return None
                html = await response.text()
    except Exception as e:
        logger.error(f"scrape_watch_order failed for MAL ID {mal_id}: {e}")
        return None

    entries = []
    # Match all tr tag blocks with data-id attribute
    tr_matches = re.finditer(r'<tr[^>]+data-id="(\d+)"[^>]*>([\s\S]*?)</tr>', html)
    
    for match in tr_matches:
        tr_tag = match.group(0)
        content = match.group(2)
        
        id_match = re.search(r'data-id="(\d+)"', tr_tag)
        type_match = re.search(r'data-type="(\d+)"', tr_tag)
        eps_match = re.search(r'data-eps="(\d+)"', tr_tag)
        al_id_match = re.search(r'data-anilist-id="(\d*)"', tr_tag)
        
        if not id_match or not type_match:
            continue
            
        type_val = int(type_match.group(1))
        if type_val not in (1, 3):  # TV=1, Movie=3
            continue
            
        title_match = re.search(r'<span class="wo_title">([\s\S]*?)</span>', content)
        sec_title_match = re.search(r'<span class="uk-text-small">([\s\S]*?)</span>', content)
        image_match = re.search(r"style=\"background-image:url\('([^']+)'\)\"", content)
        meta_match = re.search(r'<span class="wo_meta">([\s\S]*?)</span>', content)
        rating_match = re.search(r'<span class="wo_rating">([\s\S]*?)</span>', content)
        
        meta_raw = ""
        if meta_match:
            meta_raw = re.sub(r'<[^>]*>?', '', meta_match.group(1))
            meta_raw = " ".join(meta_raw.split()).strip()
            
        parts = [p.strip() for p in meta_raw.split("|") if p.strip()]
        parts = [p for p in parts if "★" not in p]
        
        episodes_count = None
        duration = None
        
        ep_info = parts[2] if len(parts) > 2 else ""
        if "×" in ep_info:
            ep_parts = [s.strip() for s in ep_info.split("×")]
            episodes_count = ep_parts[0]
            duration = ep_parts[1]
        elif ep_info:
            duration = ep_info
            
        entries.append({
            "malId": int(id_match.group(1)),
            "anilistId": int(al_id_match.group(1)) if al_id_match and al_id_match.group(1).isdigit() else None,
            "title": title_match.group(1).strip() if title_match else "Unknown",
            "secondaryTitle": sec_title_match.group(1).strip() if sec_title_match else None,
            "type": "TV" if type_val == 1 else "Movie",
            "episodes": int(eps_match.group(1)) if eps_match else 0,
            "image": f"https://chiaki.site/{image_match.group(1)}" if image_match else None,
            "metadata": {
                "date": parts[0] if len(parts) > 0 else None,
                "type": parts[1] if len(parts) > 1 else None,
                "episodes": episodes_count,
                "duration": duration,
            },
            "rating": rating_match.group(1).strip() if rating_match else None
        })
        
    return entries if entries else None

async def fetch_cover_images_by_anilist_ids(anilist_ids: list) -> dict:
    if not anilist_ids:
        return {}
        
    query = """
    query ($ids: [Int]) {
      Page(page: 1, perPage: 50) {
        media(id_in: $ids, type: ANIME) {
          id
          coverImage {
            large
          }
        }
      }
    }
    """
    
    cover_images = {}
    chunk_size = 50
    for i in range(0, len(anilist_ids), chunk_size):
        chunk = anilist_ids[i:i + chunk_size]
        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    "https://graphql.anilist.co",
                    json={"query": query, "variables": {"ids": chunk}}
                ) as r:
                    if r.status == 200:
                        data = await r.json()
                        media_list = data.get("data", {}).get("Page", {}).get("media", [])
                        for media in media_list:
                            media_id = media.get("id")
                            cover = (media.get("coverImage") or {}).get("large")
                            if media_id and cover:
                                cover_images[int(media_id)] = cover
                    else:
                        logger.error(f"fetch_cover_images_by_anilist_ids failed: status {r.status}")
        except Exception as e:
            logger.error(f"fetch_cover_images_by_anilist_ids failed: {e}")
            
    return cover_images

async def get_mal_id(anilist_id: int) -> int:
    query = """
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        idMal
      }
    }
    """
    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                "https://graphql.anilist.co",
                json={"query": query, "variables": {"id": anilist_id}}
            ) as r:
                if r.status == 200:
                    data = await r.json()
                    return data.get("data", {}).get("Media", {}).get("idMal")
    except Exception as e:
        logger.error(f"get_mal_id failed for {anilist_id}: {e}")
    return None

async def enrich_watch_order_images(entries: list) -> list:
    anilist_ids = [
        e["anilistId"] for e in entries
        if isinstance(e.get("anilistId"), int) and e["anilistId"] > 0
    ]
    
    if not anilist_ids:
        return entries
        
    covers = await fetch_cover_images_by_anilist_ids(anilist_ids)
    
    enriched = []
    for e in entries:
        al_id = e.get("anilistId")
        if al_id and al_id in covers:
            e = {**e, "image": covers[al_id]}
        enriched.append(e)
        
    return enriched

async def get_watch_order(anilist_id: int) -> list:
    now = time.time()
    
    # 1. Check local in-memory cache first
    if anilist_id in _watch_order_cache:
        cached = _watch_order_cache[anilist_id]
        if cached["expires_at"] > now:
            logger.info(f"get_watch_order: Cache hit for AniList ID {anilist_id}")
            return cached["entries"]
            
    logger.info(f"get_watch_order: Cache miss for AniList ID {anilist_id}. Fetching...")
    
    # 2. Resolve MAL ID
    mal_id = await get_mal_id(anilist_id)
    if not mal_id:
        logger.warning(f"get_watch_order: No MAL ID resolved for AniList ID {anilist_id}")
        return None
        
    # 3. Scrape chiaki.site
    entries = await scrape_watch_order(mal_id)
    if not entries:
        logger.warning(f"get_watch_order: Scraper returned no entries for MAL ID {mal_id}")
        return None
        
    # 4. Enrich images
    enriched = await enrich_watch_order_images(entries)
    
    # 5. Save to local in-memory cache
    _watch_order_cache[anilist_id] = {
        "entries": enriched,
        "expires_at": now + CACHE_TTL
    }
    
    return enriched
