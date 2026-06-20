const API_BASE = '/api/anime';
const RECAPTCHA_SITE_KEY = '6LfzHX8sAAAAAN70WElpj4nM__wxhllZQNZCAFGb';
const API_CACHE = new Map();
const API_INFLIGHT = new Map();

function getApiCacheTtl(path) {
    if (!path) return 0;
    if (path.startsWith('/watch/')) return 0;
    if (path.startsWith('/suggestions')) return 20_000;
    if (path.startsWith('/spotlight')) return 0;
    if (path.startsWith('/trending') || path.startsWith('/popular') || path.startsWith('/upcoming') || path.startsWith('/recent') || path.startsWith('/schedule')) return 45_000;
    if (path.startsWith('/search') || path.startsWith('/filter')) return 30_000;
    if (path.startsWith('/info/') || path.startsWith('/episodes/')) return 300_000;
    if (path.startsWith('/eclipse/map/')) return 86_400_000;
    if (path.startsWith('/eclipse/servers')) return 300_000;
    if (path.startsWith('/eclipse/sources')) return 0;
    if (path.includes('/characters') || path.includes('/recommendations')) return 180_000;
    return 15_000;
}

async function getReCaptchaToken(action) {
    try {

        for (let i = 0; i < 20 && typeof grecaptcha === 'undefined'; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (typeof grecaptcha === 'undefined') return null;
        await new Promise(r => grecaptcha.ready(r));
        return await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action });
    } catch (e) {
        console.warn('[reCAPTCHA v3 API] token error:', e);
        return null;
    }
}

class CryptoManager {
    constructor() {
        this.key = null;
        this.initPromise = this.init();
    }

    async init() {
        const meta = document.querySelector('meta[name="k-session"]');
        if (!meta || !meta.content) {
            console.warn("[Crypto] No session key found, falling back to unencrypted API if possible.");
            return;
        }

        try {
            const rawKey = this.base64ToArrayBuffer(meta.content);
            this.key = await window.crypto.subtle.importKey(
                "raw",
                rawKey,
                { name: "AES-GCM" },
                false,
                ["encrypt", "decrypt"]
            );
        } catch (e) {
            console.error("[Crypto] Key import failed:", e);
        }
    }

    base64ToArrayBuffer(base64) {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    }

    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    async encryptPayload(obj) {
        if (!this.key) return null;
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(JSON.stringify(obj));

        const cipherBuffer = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            this.key,
            encoded
        );

        const payload = new Uint8Array(iv.length + cipherBuffer.byteLength);
        payload.set(iv, 0);
        payload.set(new Uint8Array(cipherBuffer), iv.length);

        return this.arrayBufferToBase64(payload);
    }

    async decryptResponse(base64Str) {
        if (!this.key) return null;
        const buffer = this.base64ToArrayBuffer(base64Str);
        const bytes = new Uint8Array(buffer);

        const iv = bytes.slice(0, 12);
        const ct = bytes.slice(12);

        const decryptedBuffer = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            this.key,
            ct
        );
        return decryptedBuffer;
    }
}

const cryptoInstance = new CryptoManager();
window.cryptoInstance = cryptoInstance;
window.fetchAPI = fetchAPI;

async function decompressGzip(buffer) {

    if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(new Uint8Array(buffer));
        writer.close();
        const response = new Response(ds.readable);
        return await response.arrayBuffer();
    } else {

        console.warn("[Crypto] DecompressionStream not supported");
        return buffer;
    }
}

async function fetchAPI(path) {
    await cryptoInstance.initPromise;
    const cacheKey = path;
    const ttlMs = getApiCacheTtl(path);
    const now = Date.now();

    if (ttlMs > 0) {
        const cached = API_CACHE.get(cacheKey);
        if (cached && cached.expiresAt > now) return cached.data;
        if (cached && cached.expiresAt <= now) API_CACHE.delete(cacheKey);
    }

    if (API_INFLIGHT.has(cacheKey)) {
        return API_INFLIGHT.get(cacheKey);
    }

    const runRequest = async () => {
        if (cryptoInstance.key) {

            const payload = {
                path: path,
                method: 'GET',
                query: {},
                body: null,
                version: '0.1.0'
            };

            const encryptedB64 = await cryptoInstance.encryptPayload(payload);
            const res = await fetch(`/api/secure/pipe?e=${encodeURIComponent(encryptedB64)}`);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const responseB64 = await res.text();
            const decryptedBytes = await cryptoInstance.decryptResponse(responseB64);

            try {
                const decompressedBytes = await decompressGzip(decryptedBytes);
                const jsonText = new TextDecoder().decode(decompressedBytes);
                return JSON.parse(jsonText);
            } catch (e) {
                console.error("[Crypto] Failed to decompress/parse response", e);
                throw e;
            }
        } else {

            const headers = {};
            const res = await fetch(API_BASE + path, { headers });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        }
    };

    const requestPromise = runRequest()
        .then((data) => {
            if (ttlMs > 0) {
                API_CACHE.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
            }
            return data;
        })
        .finally(() => {
            API_INFLIGHT.delete(cacheKey);
        });

    API_INFLIGHT.set(cacheKey, requestPromise);
    return requestPromise;
}

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const ANILIST_CACHE = new Map();
const ANILIST_INFLIGHT = new Map();

const _AL_TITLE = `title{romaji english native userPreferred}`;
const _AL_COVER = `coverImage{extraLarge large medium color}`;

const _AL_CARD_FIELDS = `id idMal ${_AL_TITLE} ${_AL_COVER} bannerImage format status episodes seasonYear season averageScore meanScore popularity genres duration isAdult description(asHtml:false) startDate{year month day} nextAiringEpisode{episode airingAt timeUntilAiring}`;

const _AL_FULL_FIELDS = `${_AL_CARD_FIELDS} synonyms studios(isMain:true){nodes{name}} trailer{id site thumbnail} tags{name rank isGeneralSpoiler isMediaSpoiler} relations{edges{relationType node{id ${_AL_TITLE} ${_AL_COVER} format status episodes seasonYear synonyms}}}`;

function _alCacheTtl(opName) {
    if (!opName) return 0;
    if (opName === 'info' || opName === 'chars' || opName === 'recs') return 300_000;
    if (opName === 'search' || opName === 'filter' || opName === 'suggest') return 30_000;
    if (opName === 'trending' || opName === 'popular' || opName === 'upcoming' || opName === 'recent' || opName === 'movies') return 45_000;
    if (opName === 'schedule') return 60_000;
    if (opName === 'spotlight') return 60_000;
    return 15_000;
}

async function _anilist(opName, query, variables) {
    const cacheKey = opName + '|' + JSON.stringify(variables || {});
    const ttl = _alCacheTtl(opName);
    const now = Date.now();

    if (ttl > 0) {
        const cached = ANILIST_CACHE.get(cacheKey);
        if (cached && cached.expiresAt > now) return cached.data;
        if (cached) ANILIST_CACHE.delete(cacheKey);
    }
    if (ANILIST_INFLIGHT.has(cacheKey)) return ANILIST_INFLIGHT.get(cacheKey);

    const run = (async () => {
        const MAX_TRIES = 3;
        let lastErr;
        for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
            if (attempt > 0) {
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
            try {
                const res = await fetch(ANILIST_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ query, variables: variables || {} }),
                });
                if (res.status === 429) {
                    lastErr = new Error('AniList rate limited');
                    continue;
                }
                if (!res.ok) throw new Error('AniList ' + res.status);
                const json = await res.json();
                if (json && json.errors && json.errors.length) {
                    throw new Error('AniList: ' + json.errors[0].message);
                }
                return (json && json.data) || {};
            } catch (e) {
                lastErr = e;
                if (attempt < MAX_TRIES - 1) continue;
            }
        }
        throw lastErr;
    })();

    const wrapped = run
        .then(data => {
            if (ttl > 0) ANILIST_CACHE.set(cacheKey, { data, expiresAt: Date.now() + ttl });
            return data;
        })
        .finally(() => ANILIST_INFLIGHT.delete(cacheKey));

    ANILIST_INFLIGHT.set(cacheKey, wrapped);
    return wrapped;
}

function _alCurrentSeason() {
    const m = new Date().getUTCMonth();
    if (m <= 1 || m === 11) return 'WINTER';
    if (m <= 4) return 'SPRING';
    if (m <= 7) return 'SUMMER';
    return 'FALL';
}

async function _alPage(opName, page, perPage, extraFilter, sort) {
    const query = `query($page:Int,$perPage:Int${extraFilter.signature ? ',' + extraFilter.signature : ''}){Page(page:$page,perPage:$perPage){pageInfo{total currentPage hasNextPage} media(type:ANIME,isAdult:false,sort:${sort}${extraFilter.where ? ',' + extraFilter.where : ''}){${_AL_CARD_FIELDS}}}}`;
    const data = await _anilist(opName, query, { page, perPage, ...(extraFilter.vars || {}) });
    return ((data.Page || {}).media) || [];
}

const Kurovexa = {

    spotlight: () => _alPage('spotlight', 1, 10, { signature: '', where: '', vars: {} }, 'TRENDING_DESC'),
    trending:  (page = 1, per = 20) => _alPage('trending', page, per, { signature: '', where: '', vars: {} }, 'TRENDING_DESC'),
    popular:   (page = 1, per = 20) => _alPage('popular',  page, per, { signature: '', where: '', vars: {} }, 'POPULARITY_DESC'),
    upcoming:  (page = 1, per = 20) => _alPage('upcoming', page, per, { signature: '', where: 'status:NOT_YET_RELEASED', vars: {} }, 'POPULARITY_DESC'),
    recent:    (page = 1, per = 20) => _alPage('recent',   page, per, { signature: '', where: 'status:RELEASING', vars: {} }, 'UPDATED_AT_DESC'),
    movies:    (page = 1, per = 20) => _alPage('movies',   page, per, { signature: '', where: 'format:MOVIE', vars: {} }, 'POPULARITY_DESC'),

    schedule: async (page = 1) => {
        const nowSec = Math.floor(Date.now() / 1000);
        const query = `query($page:Int,$start:Int,$end:Int){Page(page:$page,perPage:50){pageInfo{hasNextPage} airingSchedules(airingAt_greater:$start,airingAt_lesser:$end,sort:TIME){id airingAt timeUntilAiring episode media{${_AL_CARD_FIELDS}}}}}`;
        const data = await _anilist('schedule', query, { page, start: nowSec, end: nowSec + 7 * 86400 });
        return ((data.Page || {}).airingSchedules) || [];
    },

    search: async (q, page = 1, per = 20) => {
        const query = `query($q:String,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){media(type:ANIME,search:$q,sort:SEARCH_MATCH){${_AL_CARD_FIELDS} synonyms}}}`;
        const data = await _anilist('search', query, { q, page, perPage: per });
        return ((data.Page || {}).media) || [];
    },

    suggest: async (q) => {
        const query = `query($q:String){Page(page:1,perPage:8){media(type:ANIME,search:$q,sort:SEARCH_MATCH){id ${_AL_TITLE} ${_AL_COVER} format seasonYear}}}`;
        const data = await _anilist('suggest', query, { q });
        return ((data.Page || {}).media) || [];
    },

    filter: async (params = {}) => {
        const sigParts = [];
        const whereParts = [];
        const vars = { page: parseInt(params.page || 1, 10), perPage: parseInt(params.per_page || 20, 10) };
        const addVar = (sig, name, value) => {
            sigParts.push(sig);
            whereParts.push(`${name}:$${name}`);
            vars[name] = value;
        };
        if (params.query) addVar('$query:String', 'search', params.query);
        if (params.genres) {
            const g = Array.isArray(params.genres) ? params.genres : [params.genres];
            if (g.length) addVar('$genre_in:[String]', 'genre_in', g);
        }
        if (params.year) addVar('$seasonYear:Int', 'seasonYear', parseInt(params.year, 10));
        if (params.season) addVar('$season:MediaSeason', 'season', String(params.season).toUpperCase());
        if (params.format) addVar('$format:MediaFormat', 'format', String(params.format).toUpperCase());
        if (params.status) addVar('$status:MediaStatus', 'status', String(params.status).toUpperCase());
        const sort = (params.sort || 'POPULARITY_DESC').toUpperCase();
        const extraSig = sigParts.length ? ',' + sigParts.join(',') : '';
        const extraWhere = whereParts.length ? ',' + whereParts.join(',') : '';
        const query = `query($page:Int,$perPage:Int${extraSig}){Page(page:$page,perPage:$perPage){pageInfo{total currentPage hasNextPage} media(type:ANIME,isAdult:false,sort:${sort}${extraWhere}){${_AL_CARD_FIELDS}}}}`;
        const data = await _anilist('filter', query, vars);
        return ((data.Page || {}).media) || [];
    },

    info: async (id) => {
        const query = `query($id:Int){Media(id:$id,type:ANIME){${_AL_FULL_FIELDS}}}`;
        const data = await _anilist('info', query, { id: parseInt(id, 10) });
        return data.Media || null;
    },

    chars: async (id) => {
        const query = `query($id:Int){Media(id:$id,type:ANIME){characters(sort:[ROLE,RELEVANCE],perPage:24){edges{role node{id name{full first last userPreferred} image{large medium}}}}}}`;
        const data = await _anilist('chars', query, { id: parseInt(id, 10) });
        const edges = (((data.Media || {}).characters) || {}).edges || [];
        return edges.map(e => ({
            role: e && e.role,
            name: (e && e.node && e.node.name) || null,
            image: (e && e.node && e.node.image) || null,
        }));
    },

    recs: async (id) => {
        const query = `query($id:Int){Media(id:$id,type:ANIME){recommendations(sort:RATING_DESC,perPage:20){edges{node{rating mediaRecommendation{${_AL_CARD_FIELDS}}}}}}}`;
        const data = await _anilist('recs', query, { id: parseInt(id, 10) });
        const edges = (((data.Media || {}).recommendations) || {}).edges || [];
        return edges
            .map(e => e && e.node && e.node.mediaRecommendation)
            .filter(Boolean);
    },

    episodes: (id) => fetchAPI(`/episodes/${id}`),
    watch: (provider, anilistId, audio, episodeId) =>
        fetchAPI(`/watch/${provider}/${anilistId}/${audio}/${episodeId}`),
    eclipseMap:     (anilistId)             => fetchAPI(`/eclipse/map/${anilistId}`),
    eclipseServers: (slug, ep)              => fetchAPI(`/eclipse/servers?id=${encodeURIComponent(slug)}&epNum=${ep}`),
    eclipseSources: (slug, ep, type, prov)  => fetchAPI(`/eclipse/sources?id=${encodeURIComponent(slug)}&epNum=${ep}&type=${type}&providerId=${prov}`),
};

window.Kurovexa = Kurovexa;

function showToast(title, message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast-item ${type}`;

    const icon = type === 'error' ?
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' :
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';

    toast.innerHTML = `
        <div class="toast-icon">${icon}</div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}
window.showToast = showToast;