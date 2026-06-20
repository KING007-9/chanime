(function () {
    const $ = (s, r) => (r || document).querySelector(s);
    const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

    const audio = $('#pb-audio');
    const video = $('#np-video');
    const view = $('#ms-view');
    const playerBar = $('#player-bar');
    const npModal = $('#np-modal');

    let mediaMode = 'audio';
    function activeMedia() { return mediaMode === 'video' ? video : audio; }

    const STORE = {
        liked: 'kv_music_liked',
        history: 'kv_music_history',
        vol: 'kv_music_vol',
    };

    const state = {
        queue: [],
        index: -1,
        liked: new Set(JSON.parse(localStorage.getItem(STORE.liked) || '[]')),
        history: JSON.parse(localStorage.getItem(STORE.history) || '[]'),
        volume: parseFloat(localStorage.getItem(STORE.vol) || '0.8'),
        muted: false,
        loop: false,
        shuffle: false,
        navStack: [],
        navFwd: [],
        scrubbing: false,
    };

    const api = {
        search:  (q)    => fetchAPI(`/themes/search?q=${encodeURIComponent(q)}`),
        anime:   (id)   => fetchAPI(`/themes/anime/${encodeURIComponent(id)}`),
        artist:  (slug) => fetchAPI(`/themes/artist/${encodeURIComponent(slug)}`),
        recent:  ()     => fetchAPI('/themes/recent'),
        year:    (y)    => fetchAPI(`/themes/year/${encodeURIComponent(y)}`),
        artists: ()     => fetchAPI('/themes/top-artists'),
    };

    const esc = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const fmtTime = (sec) => {
        if (!isFinite(sec) || sec < 0) sec = 0;
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    const placeholderCover = (label) => {
        const t = (label || '?').slice(0, 1).toUpperCase();
        return `<div class="ms-card-cover-fallback"><span style="font-size:2.4rem;font-weight:900;letter-spacing:-0.04em;">${esc(t)}</span></div>`;
    };

    function coverImg(url, label, opts) {
        opts = opts || {};
        const cls = opts.cls || 'ms-card-cover';
        if (!url) return placeholderCover(label || '');
        return `<img class="${cls}" data-cover-fallback="${esc(label || '')}"`
            + ` src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    }

    document.addEventListener('error', (e) => {
        const img = e.target;
        if (!(img instanceof HTMLImageElement)) return;
        if (!img.dataset || img.dataset.coverFallback == null) return;
        const label = img.dataset.coverFallback;
        const wrap  = img.parentNode;
        if (!wrap) return;

        const tmp = document.createElement('div');
        tmp.innerHTML = placeholderCover(label);
        const node = tmp.firstChild;
        if (node) wrap.replaceChild(node, img);
    }, true);

    const coverUrl = (anime) => {
        if (!anime) return '';
        const imgs = anime.images || [];
        const large = imgs.find(i => i.facet === 'Large Cover');
        const small = imgs.find(i => i.facet === 'Small Cover');
        return (large || small || imgs[0])?.link || '';
    };

    const artistImageUrl = (artist) => {
        if (!artist) return '';
        const imgs = artist.images || [];
        const large = imgs.find(i => i.facet === 'Large Cover');
        const small = imgs.find(i => i.facet === 'Small Cover');
        return (large || small || imgs[0])?.link || '';
    };

    function trackFromTheme(anime, theme, animeOverride) {
        const animeRef = animeOverride || theme.anime || anime;
        if (!animeRef) return null;
        const entries = theme.animethemeentries || [];
        let pickedAudio = null, pickedVideo = null, pickedEntry = null;
        for (const e of entries) {
            for (const v of (e.videos || [])) {
                if (v.audio && v.audio.link) {
                    pickedAudio = v.audio;
                    pickedVideo = v;
                    pickedEntry = e;
                    break;
                }
            }
            if (pickedAudio) break;
        }
        if (!pickedAudio) return null;
        const cover = coverUrl(animeRef) || (theme.song?.artists?.[0] && artistImageUrl(theme.song.artists[0])) || '';
        const slug = theme.slug || `${theme.type || ''}${theme.sequence || ''}`;
        return {
            id: `${theme.id}-${pickedAudio.id}`,
            themeId: theme.id,
            title: theme.song?.title || slug || 'Untitled',
            type: slug,
            typeKind: theme.type || '',
            artists: theme.song?.artists || [],
            animeId: animeRef.id,
            animeName: animeRef.name,
            animeSlug: animeRef.slug,
            cover,
            audio: pickedAudio.link,
            videoLink: pickedVideo?.link,
            episodes: pickedEntry?.episodes || '',
        };
    }

    function tracksFromAnime(anime) {
        return (anime.animethemes || [])
            .map(t => trackFromTheme(anime, t))
            .filter(Boolean);
    }

    function persistLiked() { localStorage.setItem(STORE.liked, JSON.stringify(Array.from(state.liked))); }
    function persistHistory() { localStorage.setItem(STORE.history, JSON.stringify(state.history.slice(0, 60))); }
    function persistVol() { localStorage.setItem(STORE.vol, String(state.volume)); }

    function isLiked(track) { return state.liked.has(track.id); }
    function toggleLike(track) {
        if (state.liked.has(track.id)) {
            state.liked.delete(track.id);
            try { localStorage.removeItem(`kv_music_track_${track.id}`); } catch (_) { }
        } else {
            state.liked.add(track.id);
            try { localStorage.setItem(`kv_music_track_${track.id}`, JSON.stringify(track)); } catch (_) { }
        }
        persistLiked();
        updatePlayerLike();
        $$(`.ms-track-like[data-tid="${CSS.escape(track.id)}"]`).forEach(b => {
            b.classList.toggle('is-liked', state.liked.has(track.id));
        });
    }

    function pushHistory(track) {
        try { localStorage.setItem(`kv_music_track_${track.id}`, JSON.stringify(track)); } catch (_) { }
        state.history = [track.id, ...state.history.filter(id => id !== track.id)].slice(0, 60);
        persistHistory();
    }

    function loadStoredTracks(ids) {
        const out = [];
        for (const id of ids) {
            try {
                const raw = localStorage.getItem(`kv_music_track_${id}`);
                if (raw) out.push(JSON.parse(raw));
            } catch (_) { }
        }
        return out;
    }

    function play(queue, idx) {
        if (!queue || !queue.length) return;
        state.queue = queue.slice();
        state.index = Math.max(0, Math.min(idx || 0, state.queue.length - 1));
        loadCurrent(true);
        renderQueue();

        if (window.innerWidth <= 720) openNP();
    }

    function jumpTo(idx) {
        if (idx < 0 || idx >= state.queue.length) return;
        state.index = idx;
        loadCurrent(true);
        renderQueue();
    }

    function renderQueue() {
        const list = $('#np-queue-list');
        const count = $('#np-queue-count');
        if (!list || !count) return;
        const q = state.queue;
        count.textContent = q.length ? `${q.length} track${q.length > 1 ? 's' : ''}` : 'Empty';
        if (!q.length) {
            list.innerHTML = `<div class="np-queue-empty">Pick a song to start playing.</div>`;
            return;
        }
        list.innerHTML = q.map((t, i) => `
            <button class="np-queue-row${i === state.index ? ' is-current' : ''}" data-qjump="${i}">
                <span class="np-queue-cover">
                    ${t.cover ? `<img src="${esc(t.cover)}" alt="" referrerpolicy="no-referrer">` : ''}
                    ${i === state.index ? '<span class="np-queue-eq"><i></i><i></i><i></i></span>' : ''}
                </span>
                <span class="np-queue-text">
                    <span class="np-queue-title">${esc(t.title)}</span>
                    <span class="np-queue-sub">${esc((t.artists || []).map(a => a.name).join(', ') || t.animeName || '')}</span>
                </span>
                <span class="np-queue-tag">${i < state.index ? 'Played' : (i === state.index ? 'Now' : 'Next')}</span>
            </button>
        `).join('');
        $$('[data-qjump]', list).forEach(btn => {
            btn.addEventListener('click', () => jumpTo(parseInt(btn.dataset.qjump, 10)));
        });

        const cur = list.querySelector('.is-current');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
    }

    function loadCurrent(autoplay) {
        const t = state.queue[state.index];
        if (!t) return;
        playerBar.dataset.empty = '0';

        document.body.classList.remove('pb-hidden');

        if (mediaMode === 'video' && !t.videoLink) {
            setVideoMode(false, false);
        }

        if (mediaMode === 'video') {
            video.src = t.videoLink;
            try { audio.removeAttribute('src'); audio.load(); } catch (_) { }
            video.muted = state.muted;
            video.volume = state.volume;
        } else {
            audio.src = t.audio;
            try { video.removeAttribute('src'); video.load(); } catch (_) { }
            audio.muted = state.muted;
            audio.volume = state.volume;
        }

        if (autoplay) {
            const p = activeMedia().play();
            if (p && p.catch) p.catch(() => { });
        }
        renderPlayerMeta(t);
        pushHistory(t);
        updateNowPlayingMarkers();
    }

    function setVideoMode(on, reload = true) {
        const t = state.queue[state.index];
        if (on && (!t || !t.videoLink)) {
            toast && toast('No video available for this track');
            return;
        }
        const wasPaused = activeMedia().paused;
        const ct = activeMedia().currentTime || 0;
        activeMedia().pause();

        mediaMode = on ? 'video' : 'audio';
        document.body.classList.toggle('np-video-on', mediaMode === 'video');
        $('#np-video-btn').classList.toggle('is-on', mediaMode === 'video');
        const npVid = $('#np-video');
        const npCov = $('#np-cover');
        if (npVid) npVid.hidden = mediaMode !== 'video';
        if (npCov) npCov.hidden = mediaMode === 'video';

        if (!t) return;

        if (reload) {
            if (mediaMode === 'video') {
                video.src = t.videoLink;
                try { audio.removeAttribute('src'); audio.load(); } catch (_) { }
            } else {
                audio.src = t.audio;
                try { video.removeAttribute('src'); video.load(); } catch (_) { }
            }
            const m = activeMedia();
            m.muted = state.muted;
            m.volume = state.volume;
            const onMeta = () => {
                try { m.currentTime = ct; } catch (_) { }
                if (!wasPaused) m.play().catch(() => { });
                m.removeEventListener('loadedmetadata', onMeta);
            };
            m.addEventListener('loadedmetadata', onMeta);
        }
    }

    function toast(msg) {
        const c = $('#toast-container');
        if (!c) return;
        const el = document.createElement('div');
        el.className = 'kv-toast';
        el.textContent = msg;
        c.appendChild(el);
        setTimeout(() => el.classList.add('show'), 10);
        setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
    }

    function next(auto) {
        if (!state.queue.length) return;
        if (state.shuffle && state.queue.length > 1) {
            let n;
            do { n = Math.floor(Math.random() * state.queue.length); } while (n === state.index);
            state.index = n;
        } else {
            state.index = state.index + 1;
            if (state.index >= state.queue.length) {
                if (state.loop || !auto) state.index = 0;
                else { state.index = state.queue.length - 1; activeMedia().pause(); return; }
            }
        }
        loadCurrent(true);
        renderQueue();
    }

    function prev() {
        if (!state.queue.length) return;
        if (activeMedia().currentTime > 3) { activeMedia().currentTime = 0; return; }
        state.index = (state.index - 1 + state.queue.length) % state.queue.length;
        loadCurrent(true);
        renderQueue();
    }

    function togglePlay() {
        if (playerBar.dataset.empty === '1') return;
        const m = activeMedia();
        if (m.paused) m.play().catch(() => { });
        else m.pause();
    }

    function setCoverImg(imgEl, btnEl, url) {
        if (!imgEl) return;
        if (url) {
            imgEl.classList.remove('is-failed');
            if (imgEl.getAttribute('src') !== url) imgEl.src = url;
            if (btnEl) btnEl.classList.add('has-cover');
        } else {
            imgEl.removeAttribute('src');
            imgEl.classList.add('is-failed');
            if (btnEl) btnEl.classList.remove('has-cover');
        }
    }

    function renderPlayerMeta(t) {
        const pbCover = $('#pb-cover');
        const pbCoverBtn = $('#pb-expand');
        setCoverImg(pbCover, pbCoverBtn, t.cover || '');
        const titleEl = $('#pb-title');
        titleEl.textContent = t.title;
        titleEl.dataset.animeId = t.animeId || '';
        const artistEl = $('#pb-artist');
        const artistsLabel = (t.artists && t.artists.length)
            ? t.artists.map(a => a.name).join(', ')
            : (t.animeName || '—');
        if (t.artists && t.artists.length) {
            const first = t.artists[0];
            artistEl.textContent = artistsLabel;
            artistEl.href = `#/artist/${encodeURIComponent(first.slug || first.id)}`;
        } else {
            artistEl.textContent = artistsLabel;
            artistEl.href = `#/anime/${encodeURIComponent(t.animeId)}`;
        }

        const npCover = $('#np-cover');
        const npTitle = $('#np-title');
        const npArtist = $('#np-artist');
        const npSource = $('#np-source-name');
        const npBg = $('#np-bg');
        setCoverImg(npCover, null, t.cover || '');
        if (npTitle) { npTitle.textContent = t.title; npTitle.href = `#/anime/${encodeURIComponent(t.animeId)}`; }
        if (npArtist) {
            npArtist.textContent = artistsLabel;
            const first = (t.artists || [])[0];
            npArtist.href = first ? `#/artist/${encodeURIComponent(first.slug || first.id)}` : `#/anime/${encodeURIComponent(t.animeId)}`;
        }
        if (npSource) { npSource.textContent = t.animeName || '—'; npSource.href = `#/anime/${encodeURIComponent(t.animeId)}`; }
        if (npBg && t.cover) npBg.style.backgroundImage = `url("${t.cover}")`;

        const vidBtn = $('#np-video-btn');
        if (vidBtn) vidBtn.classList.toggle('is-disabled', !t.videoLink);

        const lyricsMeta = $('#np-lyrics-meta');
        if (lyricsMeta) {
            lyricsMeta.innerHTML = `
                <div><span>Anime</span><strong>${esc(t.animeName || '—')}</strong></div>
                <div><span>Type</span><strong>${esc(t.type || '—')}</strong></div>
                <div><span>Episodes</span><strong>${esc(t.episodes || '—')}</strong></div>
                <div><span>Artists</span><strong>${esc((t.artists || []).map(a => a.name).join(', ') || '—')}</strong></div>
            `;
        }

        _syncedLines = [];
        _activeLyricIdx = -1;
        const lyricsBody = $('#np-lyrics-body');
        if (lyricsBody) {
            lyricsBody.dataset.trackId = t.id;
            lyricsBody.innerHTML = '<span class="np-lyric-line is-loading">Loading lyrics…</span>';
        }
        fetchLyricsFor(t);

        updatePlayerLike();
    }

    let _lyricsCache = {};
    let _syncedLines = [];
    let _rawSyncedLines = [];
    let _lyricsDuration = 0;
    let _activeLyricIdx = -1;
    let _lyricRaf = null;

    function parseLRC(lrc) {
        const out = [];
        const lineRe = /^((?:\[\d+:\d+(?:\.\d+)?\])+)(.*)$/;
        const tagRe  = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
        for (const raw of String(lrc).split(/\r?\n/)) {
            const m = raw.match(lineRe);
            if (!m) continue;
            const text = m[2].trim();
            let tag;
            while ((tag = tagRe.exec(m[1])) !== null) {
                const t = parseInt(tag[1], 10) * 60 + parseFloat(tag[2]);
                out.push({ t, text });
            }
        }
        out.sort((a, b) => a.t - b.t);
        return out;
    }

    function renderPlainLyrics(text) {
        const body = $('#np-lyrics-body');
        if (!body) return;
        if (!text || !text.trim()) {
            body.innerHTML = '<span class="np-lyric-line is-empty">We couldn\'t find lyrics for this track yet.</span>';
            return;
        }
        const lines = text.split(/\r?\n/);
        body.innerHTML = lines
            .map(l => `<div class="np-lyric-line">${esc(l) || '&nbsp;'}</div>`)
            .join('');
    }

    function renderSyncedLyrics(lines) {
        const body = $('#np-lyrics-body');
        if (!body) return;

        body.style.transform = '';
        body.scrollTop = 0;
        body.innerHTML = lines
            .map((l, i) => `<div class="np-lyric-line" data-i="${i}">${esc(l.text) || '&nbsp;'}</div>`)
            .join('');
    }

    function recomputeSyncedLines() {
        if (!_rawSyncedLines.length) { _syncedLines = []; return; }
        _syncedLines = _rawSyncedLines.slice();
        _activeLyricIdx = -1;
    }

    function updateLyricsHighlight(currentTime) {
        if (!_syncedLines.length) return;

        let lo = 0, hi = _syncedLines.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (_syncedLines[mid].t <= currentTime) { idx = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        if (idx === _activeLyricIdx) return;
        _activeLyricIdx = idx;
        const body = $('#np-lyrics-body');
        if (!body) return;
        const lines = body.querySelectorAll('.np-lyric-line');
        lines.forEach((el, i) => {
            el.classList.toggle('is-active', i === idx);
            el.classList.toggle('is-past',   i < idx);
        });
        if (idx < 0) return;
        const active = lines[idx];
        if (!active) return;

        const viewH = body.clientHeight;
        if (viewH <= 0) return;

        const ACTIVE_RATIO = 0.42;
        const target = active.offsetTop + (active.offsetHeight / 2) - (viewH * ACTIVE_RATIO);
        scrollLyricsTo(body, Math.max(0, target));
    }

    let _lyricScrollRaf = 0;
    function scrollLyricsTo(body, target) {
        if (!body) return;
        target = Math.max(0, Math.min(target, body.scrollHeight - body.clientHeight));
        if (_lyricScrollRaf) cancelAnimationFrame(_lyricScrollRaf);
        const start = body.scrollTop;
        const delta = target - start;
        if (Math.abs(delta) < 0.5) { body.scrollTop = target; return; }

        const dist = Math.abs(delta);
        const dur = Math.min(900, Math.max(280, dist * 0.9));
        const t0 = performance.now();
        const ease = (x) => 1 - Math.pow(1 - x, 3);
        const step = (now) => {
            const k = Math.min(1, (now - t0) / dur);
            body.scrollTop = start + delta * ease(k);
            if (k < 1) _lyricScrollRaf = requestAnimationFrame(step);
            else _lyricScrollRaf = 0;
        };
        _lyricScrollRaf = requestAnimationFrame(step);
    }

    function cleanLyricTitle(raw) {
        if (!raw) return '';
        let s = String(raw);

        s = s.replace(/^\s*(?:OP|ED|IN)\s*\d*\s*[-–:]\s*/i, '');
        s = s.replace(/^\s*(?:Opening|Ending|Insert\s*Song|Theme)\s*\d*\s*[-–:]\s*/i, '');

        s = s.replace(/\([^)]*\)/g, '');
        s = s.replace(/\[[^\]]*\]/g, '');

        s = s.replace(/^[\s"'“”『「]+|[\s"'“”』」]+$/g, '');
        return s.trim();
    }

    function waitForAudioDuration(m, timeoutMs) {
        return new Promise((resolve) => {
            if (!m) return resolve(0);
            if (isFinite(m.duration) && m.duration > 0) return resolve(m.duration);
            let done = false;
            const finish = (v) => {
                if (done) return;
                done = true;
                m.removeEventListener('loadedmetadata', onMeta);
                m.removeEventListener('durationchange', onMeta);
                resolve(v);
            };
            const onMeta = () => {
                if (isFinite(m.duration) && m.duration > 0) finish(m.duration);
            };
            m.addEventListener('loadedmetadata', onMeta);
            m.addEventListener('durationchange', onMeta);
            setTimeout(() => finish(0), timeoutMs || 4000);
        });
    }

    async function fetchLyricsFor(track) {
        if (!track) return;
        const lyricsBody = $('#np-lyrics-body');
        if (!lyricsBody) return;
        const key = track.id;
        const apply = (data) => {
            if (lyricsBody.dataset.trackId !== key) return;
            const synced = data && data.synced;
            const plain  = data && data.lyrics;
            _lyricsDuration = (data && Number(data.duration)) || 0;
            if (synced) {
                _rawSyncedLines = parseLRC(synced).filter(l => l.text || l.text === '');
                if (_rawSyncedLines.length) {
                    recomputeSyncedLines();
                    renderSyncedLyrics(_syncedLines);
                    return;
                }
            }
            _rawSyncedLines = [];
            _syncedLines = [];
            renderPlainLyrics(plain || (synced ? String(synced).replace(/^\[\d+:\d+(?:\.\d+)?\]\s?/gm, '') : ''));
        };

        const audioDur = await waitForAudioDuration(activeMedia(), 4000);
        if (lyricsBody.dataset.trackId !== key) return;

        const durBucket = audioDur ? Math.round(audioDur / 5) * 5 : 0;
        const cacheKey = `${key}|${durBucket}`;
        if (_lyricsCache[cacheKey] != null) { apply(_lyricsCache[cacheKey]); return; }

        const title  = cleanLyricTitle(track.title || '');

        const firstArtist = ((track.artists || [])[0] || {}).name || '';
        try {
            const durQs = audioDur ? `&duration=${audioDur.toFixed(2)}` : '';
            const url = `/api/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(firstArtist)}${durQs}`;
            const res = await fetch(url);
            const data = await res.json();
            _lyricsCache[cacheKey] = data;
            apply(data);
        } catch (_) {
            apply({});
        }
    }

    function updatePlayerLike() {
        const t = state.queue[state.index];
        const btn = $('#pb-like');
        const npBtn = $('#np-like');
        const liked = !!(t && state.liked.has(t.id));
        if (btn) btn.classList.toggle('is-liked', liked);
        if (npBtn) npBtn.classList.toggle('is-liked', liked);
    }

    function updateNowPlayingMarkers() {
        const t = state.queue[state.index];
        $$('.ms-track').forEach(row => {
            row.classList.toggle('is-playing', !!(t && row.dataset.tid === t.id));
        });
    }

    function setPlayUI(playing) {
        const pause = '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>';
        const play = '<path d="M8 5v14l11-7z"/>';
        const ic = playing ? pause : play;
        const set = (id) => {
            const el = $('#' + id);
            if (el) el.outerHTML = `<svg id="${id}" viewBox="0 0 24 24" fill="currentColor">${ic}</svg>`;
        };
        set('pb-play-svg');
        set('pb-play-mobile-svg');
        set('np-play-svg');

        document.body.classList.toggle('is-playing', !!playing);
    }

    function openNP() {
        if (playerBar.dataset.empty === '1') return;
        npModal.hidden = false;
        document.body.classList.add('np-open');

        $('#np-shuffle').classList.toggle('is-on', state.shuffle);
        $('#np-loop').classList.toggle('is-on', state.loop);
        $('#np-video-btn').classList.toggle('is-on', mediaMode === 'video');
        setSeek();
        updatePlayerLike();
    }
    function closeNP() {
        npModal.hidden = true;
        document.body.classList.remove('np-open');
        document.body.classList.remove('np-lyrics-open');
    }

    function setVolUI() {
        const v = state.muted ? 0 : state.volume;
        $('#pb-vol-fill').style.width = (v * 100) + '%';
        const knob = $('#pb-vol-knob');
        if (knob) knob.style.left = (v * 100) + '%';
        const svg = $('#pb-vol-svg');
        if (!svg) return;
        let path;
        if (v === 0) path = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';
        else if (v < 0.5) path = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>';
        else path = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
        svg.innerHTML = path;
    }

    function setSeek(t) {
        const m = activeMedia();
        const dur = m.duration;
        const cur = t == null ? m.currentTime : t;
        $('#pb-cur').textContent = fmtTime(cur);
        $('#pb-dur').textContent = fmtTime(dur);
        const pct = dur ? (cur / dur) * 100 : 0;
        $('#pb-seek-fill').style.width = pct + '%';
        const knob = $('#pb-seek-knob');
        if (knob) knob.style.left = pct + '%';

        const npCur = $('#np-cur'), npDur = $('#np-dur'), npFill = $('#np-seek-fill'), npKnob = $('#np-seek-knob');
        if (npCur) npCur.textContent = fmtTime(cur);
        if (npDur) npDur.textContent = fmtTime(dur);
        if (npFill) npFill.style.width = pct + '%';
        if (npKnob) npKnob.style.left = pct + '%';
    }

    function bindBar(bar, onChange) {
        let pending = null;
        let rafId = 0;
        const flush = () => {
            rafId = 0;
            if (pending != null) { onChange(pending); pending = null; }
        };
        const schedule = (pct) => {
            pending = pct;
            if (!rafId) rafId = requestAnimationFrame(flush);
        };
        const setFromEvent = (e) => {
            const r = bar.getBoundingClientRect();
            const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
            const pct = Math.max(0, Math.min(1, x / r.width));
            schedule(pct);
        };
        let dragging = false;
        const onUp = () => {
            dragging = false;
            state.scrubbing = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchend', onUp);
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; flush(); }
        };
        const onMove = (e) => { if (dragging) setFromEvent(e); };
        bar.addEventListener('mousedown', (e) => {
            dragging = true; state.scrubbing = true; setFromEvent(e);
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        bar.addEventListener('touchstart', (e) => {
            dragging = true; state.scrubbing = true; setFromEvent(e);
            document.addEventListener('touchmove', onMove, { passive: true });
            document.addEventListener('touchend', onUp);
        }, { passive: true });
        bar.addEventListener('click', setFromEvent);
    }

    let _stageSpinnerTimer = 0;
    function showStageLoading(on) {
        const el = $('#np-loading');
        if (!el) return;
        if (on) {
            if (_stageSpinnerTimer) return;
            _stageSpinnerTimer = setTimeout(() => {
                _stageSpinnerTimer = 0;
                el.hidden = false;
            }, 350);
        } else {
            if (_stageSpinnerTimer) { clearTimeout(_stageSpinnerTimer); _stageSpinnerTimer = 0; }
            el.hidden = true;
        }
    }

    function navigate(hash) {
        if (location.hash !== hash) location.hash = hash;
        else handleRoute();
    }

    function handleRoute() {
        const hash = location.hash || '#/';
        if (state.navStack[state.navStack.length - 1] !== hash) {
            state.navStack.push(hash);
            state.navFwd = [];
        }
        $('#ms-back').disabled = state.navStack.length <= 1;
        $('#ms-fwd').disabled = state.navFwd.length === 0;

        $$('.ms-link').forEach(l => {
            l.classList.toggle('active', l.dataset.route === hash || (hash === '#/' && l.dataset.route === '#/'));
        });

        if (hash.startsWith('#/search?')) {
            const q = decodeURIComponent(hash.split('q=')[1] || '');
            $('#ms-search-input').value = q;
            $('#ms-search-clear').hidden = !q;
            renderSearch(q);
        } else if (hash.startsWith('#/anime/')) {
            renderAnime(decodeURIComponent(hash.split('/')[2] || ''));
        } else if (hash.startsWith('#/artist/')) {
            renderArtist(decodeURIComponent(hash.split('/')[2] || ''));
        } else if (hash.startsWith('#/year/')) {
            renderYear(hash.split('/')[2]);
        } else if (hash === '#/recent') renderRecent();
        else if (hash === '#/liked') renderLiked();
        else if (hash === '#/history') renderHistory();
        else if (hash === '#/artists') renderTopArtists();
        else renderHome();

        view.scrollTo({ top: 0 });
        $('#music-main').scrollTo({ top: 0 });
        closeSidebarIfMobile();
    }

    function loadingHTML(label) {
        return `<div class="ms-loading"><div class="ms-spinner"></div><div>${esc(label || 'Loading…')}</div></div>`;
    }

    function emptyHTML(title, sub) {
        return `<div class="ms-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            <h3>${esc(title)}</h3>
            <p>${esc(sub || '')}</p>
        </div>`;
    }

    function animeCardHTML(anime) {
        const cover = coverUrl(anime);
        const themesCount = (anime.animethemes || []).length;
        const sub = themesCount ? `${themesCount} theme${themesCount > 1 ? 's' : ''} · ${anime.year || ''}` : `${anime.year || ''} · ${anime.media_format || ''}`;
        return `<a class="ms-card" data-anime-id="${esc(anime.id)}" href="#/anime/${encodeURIComponent(anime.id)}">
            <div class="ms-card-cover-wrap">
                ${coverImg(cover, anime.name)}
                <button class="ms-card-play" data-play-anime="${esc(anime.id)}" aria-label="Play">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
            </div>
            <div class="ms-card-title">${esc(anime.name)}</div>
            <div class="ms-card-sub">${esc(sub)}</div>
        </a>`;
    }

    function artistCardHTML(artist) {
        const img = artistImageUrl(artist);
        return `<a class="ms-card is-artist" href="#/artist/${encodeURIComponent(artist.slug || artist.id)}">
            <div class="ms-card-cover-wrap">
                ${coverImg(img, artist.name)}
            </div>
            <div class="ms-card-title">${esc(artist.name)}</div>
            <div class="ms-card-sub">Artist</div>
        </a>`;
    }

    function songCardHTML(song) {
        const themes = song.animethemes || [];
        const firstAnime = themes[0]?.anime;
        const artists = (song.artists || []).map(a => a.name).join(', ');
        const href = firstAnime ? `#/anime/${encodeURIComponent(firstAnime.id)}` : '#/';
        return `<a class="ms-card" href="${href}">
            <div class="ms-card-cover-wrap">
                ${placeholderCover(song.title)}
                ${firstAnime ? `<button class="ms-card-play" data-play-song-anime="${esc(firstAnime.id)}" data-song-theme="${esc(themes[0].id)}" aria-label="Play">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>` : ''}
            </div>
            <div class="ms-card-title">${esc(song.title)}</div>
            <div class="ms-card-sub">${esc(artists || (firstAnime?.name || ''))}</div>
        </a>`;
    }

    function bindCardClicks(scope) {
        $$('[data-play-anime]', scope).forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const id = btn.dataset.playAnime;
                btn.disabled = true;
                try {
                    const data = await api.anime(id);
                    const a = data.anime;
                    if (!a) return;
                    const tracks = tracksFromAnime(a);
                    if (tracks.length) play(tracks, 0);
                } finally { btn.disabled = false; }
            });
        });
        $$('[data-play-song-anime]', scope).forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const aid = btn.dataset.playSongAnime;
                const themeId = btn.dataset.songTheme;
                btn.disabled = true;
                try {
                    const data = await api.anime(aid);
                    const a = data.anime;
                    if (!a) return;
                    const tracks = tracksFromAnime(a);
                    if (!tracks.length) return;
                    const idx = Math.max(0, tracks.findIndex(t => String(t.themeId) === String(themeId)));
                    play(tracks, idx);
                } finally { btn.disabled = false; }
            });
        });
    }

    function renderHome() {
        const hour = new Date().getHours();
        const greet = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

        view.innerHTML = `
            <div class="ms-home-hero">
                <h1 class="ms-home-greet">${greet}</h1>
                <div class="ms-quick-grid" id="home-quick"></div>
            </div>

            <div class="ms-section-title">
                <h2>Newest themes</h2>
                <a href="#/recent">View all</a>
            </div>
            <div class="ms-card-grid" id="home-recent">${loadingHTML()}</div>

            <div class="ms-section-title">
                <h2>Popular artists</h2>
                <a href="#/artists">View all</a>
            </div>
            <div class="ms-card-grid" id="home-artists">${loadingHTML()}</div>

            <div class="ms-section-title">
                <h2>From your library</h2>
                <a href="#/liked">View all</a>
            </div>
            <div id="home-liked"></div>

            <div class="ms-section-title">
                <h2>Browse by year</h2>
            </div>
            <div class="ms-card-grid ms-years-grid" id="home-years"></div>
        `;

        const quickEl = $('#home-quick');
        const quickIds = [];
        Array.from(state.liked).slice(0, 4).forEach(id => quickIds.push(id));
        state.history.slice(0, 6).forEach(id => { if (!quickIds.includes(id)) quickIds.push(id); });
        const quickTracks = loadStoredTracks(quickIds.slice(0, 6));
        if (quickTracks.length) {
            quickEl.innerHTML = quickTracks.map(t => `
                <a class="ms-quick-tile" href="#/anime/${encodeURIComponent(t.animeId)}" data-quick-tid="${esc(t.id)}">
                    ${t.cover ? `<img class="ms-quick-cover" src="${esc(t.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ms-quick-cover" style="background:linear-gradient(135deg,#4c1d95,#1e1b4b)"></div>`}
                    <span class="ms-quick-name">${esc(t.title)}</span>
                    <button class="ms-quick-play" data-play-quick="${esc(t.id)}" aria-label="Play">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </button>
                </a>
            `).join('');
            $$('[data-play-quick]', quickEl).forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const t = quickTracks.find(x => x.id === btn.dataset.playQuick);
                    if (t) play([t], 0);
                });
            });
        } else {
            quickEl.innerHTML = `<div class="ms-quick-empty">Like songs and they'll show up here for one-tap play.</div>`;
        }

        api.recent().then(d => {
            const items = (d.anime || []).slice(0, 12);
            $('#home-recent').innerHTML = items.length
                ? items.map(animeCardHTML).join('')
                : emptyHTML('No themes found', '');
            bindCardClicks($('#home-recent'));
        }).catch(() => { $('#home-recent').innerHTML = emptyHTML('Could not load', 'Try again in a moment.'); });

        api.artists().then(d => {
            const items = (d.artists || []).slice(0, 8);
            $('#home-artists').innerHTML = items.length
                ? items.map(artistCardHTML).join('')
                : emptyHTML('No artists', '');
        }).catch(() => { $('#home-artists').innerHTML = emptyHTML('Could not load', 'Try again in a moment.'); });

        const likedEl = $('#home-liked');
        const likedTracks = loadStoredTracks(Array.from(state.liked).slice(0, 6));
        if (likedTracks.length) {
            likedEl.innerHTML = `<div class="ms-card-grid">${likedTracks.map(t => `
                <div class="ms-card" data-tid="${esc(t.id)}">
                    <div class="ms-card-cover-wrap">
                        ${t.cover ? `<img class="ms-card-cover" src="${esc(t.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : placeholderCover(t.title)}
                        <button class="ms-card-play" data-play-liked="${esc(t.id)}" aria-label="Play">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        </button>
                    </div>
                    <div class="ms-card-title">${esc(t.title)}</div>
                    <div class="ms-card-sub">${esc((t.artists || []).map(a => a.name).join(', ') || t.animeName || '')}</div>
                </div>
            `).join('')}</div>`;
            $$('[data-play-liked]', likedEl).forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const t = likedTracks.find(x => x.id === btn.dataset.playLiked);
                    if (t) play([t], 0);
                });
            });
        } else {
            likedEl.innerHTML = `<div class="ms-empty" style="padding:36px 12px"><h3>Your library is empty</h3><p>Like songs to see them here.</p></div>`;
        }

        const yearsEl = $('#home-years');
        const cy = new Date().getFullYear();
        const years = [];
        for (let y = cy; y >= cy - 7; y--) years.push(y);
        const yearGradients = [
            ['#7c3aed', '#1e1b4b'], ['#5b21b6', '#0f172a'], ['#4c1d95', '#1e293b'],
            ['#9d6ef8', '#312e81'], ['#6d28d9', '#0b1023'], ['#7c3aed', '#0f0d1f'],
            ['#5b21b6', '#1f1430'], ['#4c1d95', '#0a0712'],
        ];
        yearsEl.innerHTML = years.map((y, i) => {
            const [a, b] = yearGradients[i % yearGradients.length];
            return `<a class="ms-year-card" href="#/year/${y}">
                <div class="ms-year-cover" style="background:linear-gradient(135deg, ${a} 0%, ${b} 100%);">
                    <span class="ms-year-num">${y}</span>
                </div>
                <div class="ms-card-title">${y}</div>
                <div class="ms-card-sub">Themes from ${y}</div>
            </a>`;
        }).join('');
    }

    function renderRecent() {
        view.innerHTML = `<div class="ms-section-title" style="margin-top:14px"><h2>Newest themes</h2></div>
            <div class="ms-card-grid" id="recent-grid">${loadingHTML()}</div>`;
        api.recent().then(d => {
            const items = d.anime || [];
            $('#recent-grid').innerHTML = items.length
                ? items.map(animeCardHTML).join('')
                : emptyHTML('No themes available', '');
            bindCardClicks($('#recent-grid'));
        });
    }

    function renderYear(y) {
        view.innerHTML = `<div class="ms-section-title" style="margin-top:14px"><h2>Themes from ${esc(y)}</h2></div>
            <div class="ms-card-grid" id="year-grid">${loadingHTML()}</div>`;
        api.year(y).then(d => {
            const items = d.anime || [];
            $('#year-grid').innerHTML = items.length
                ? items.map(animeCardHTML).join('')
                : emptyHTML('Nothing here yet', `No themes catalogued for ${y}.`);
            bindCardClicks($('#year-grid'));
        });
    }

    function renderTopArtists() {
        view.innerHTML = `<div class="ms-section-title" style="margin-top:14px"><h2>Artists</h2></div>
            <div class="ms-card-grid" id="artists-grid">${loadingHTML()}</div>`;
        api.artists().then(d => {
            const items = d.artists || [];
            $('#artists-grid').innerHTML = items.length
                ? items.map(artistCardHTML).join('')
                : emptyHTML('No artists', '');
        });
    }

    function renderLiked() {
        const tracks = loadStoredTracks(Array.from(state.liked));
        if (!tracks.length) {
            view.innerHTML = `<div class="ms-album-hero">
                <div class="ms-album-cover" style="display:flex;align-items:center;justify-content:center;">
                    <svg viewBox="0 0 24 24" width="80" height="80" fill="#fff" style="opacity:0.85"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                </div>
                <div class="ms-album-info">
                    <div class="ms-album-eyebrow">Playlist</div>
                    <h1 class="ms-album-title">Liked Songs</h1>
                    <div class="ms-album-meta">0 tracks</div>
                </div>
            </div>${emptyHTML('No liked songs yet', 'Tap the heart on any track to save it here.')}`;
            return;
        }
        renderTracklist({
            eyebrow: 'Playlist',
            title: 'Liked Songs',
            cover: tracks[0].cover,
            countLabel: `${tracks.length} track${tracks.length > 1 ? 's' : ''}`,
            tracks,
            asPlaylist: true,
        });
    }

    function renderHistory() {
        const tracks = loadStoredTracks(state.history);
        if (!tracks.length) {
            view.innerHTML = emptyHTML('Nothing recently played', 'Play some songs to build your history.');
            return;
        }
        renderTracklist({
            eyebrow: 'History',
            title: 'Recently Played',
            cover: tracks[0].cover,
            countLabel: `${tracks.length} track${tracks.length > 1 ? 's' : ''}`,
            tracks,
            asPlaylist: true,
        });
    }

    async function renderAnime(id) {
        view.innerHTML = loadingHTML('Loading album…');
        try {
            const data = await api.anime(id);
            const a = data.anime;
            if (!a) { view.innerHTML = emptyHTML('Not found', 'This anime has no themes catalogued.'); return; }
            const tracks = tracksFromAnime(a);
            renderTracklist({
                eyebrow: a.media_format || 'Anime',
                title: a.name,
                cover: coverUrl(a),
                countLabel: `${tracks.length} track${tracks.length === 1 ? '' : 's'} · ${a.year || ''}${a.season ? ' · ' + a.season : ''}`,
                tracks,
                asPlaylist: false,
            });
        } catch (e) {
            view.innerHTML = emptyHTML('Could not load', 'Please try again.');
        }
    }

    async function renderArtist(slug) {
        view.innerHTML = loadingHTML('Loading artist…');
        try {
            const data = await api.artist(slug);
            const a = data.artist;
            if (!a) { view.innerHTML = emptyHTML('Artist not found', ''); return; }
            const tracks = [];
            for (const song of (a.songs || [])) {
                for (const theme of (song.animethemes || [])) {
                    if (!theme.anime) continue;
                    const merged = { ...theme, song };
                    const tk = trackFromTheme(theme.anime, merged);
                    if (tk) tracks.push(tk);
                }
            }
            renderTracklist({
                eyebrow: 'Artist',
                title: a.name,
                cover: artistImageUrl(a),
                round: true,
                countLabel: `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
                tracks,
                asPlaylist: true,
            });
        } catch (e) {
            view.innerHTML = emptyHTML('Could not load', 'Please try again.');
        }
    }

    function renderTracklist({ eyebrow, title, cover, countLabel, tracks, asPlaylist, round }) {
        const heroCoverHTML = cover
            ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer">`
            : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:4rem;font-weight:900;">${esc(title.slice(0, 1))}</div>`;
        view.innerHTML = `
            <div class="ms-album-hero">
                <div class="ms-album-cover" ${round ? 'style="border-radius:50%;"' : ''}>${heroCoverHTML}</div>
                <div class="ms-album-info">
                    <div class="ms-album-eyebrow">${esc(eyebrow)}</div>
                    <h1 class="ms-album-title">${esc(title)}</h1>
                    <div class="ms-album-meta">${esc(countLabel)}</div>
                </div>
            </div>
            <div class="ms-album-actions">
                <button class="ms-play-big" id="album-play" aria-label="Play all">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <button class="ms-icon-btn" id="album-shuffle" aria-label="Shuffle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
                </button>
            </div>
            <div class="ms-tracks">
                ${tracks.length ? `
                <div class="ms-tracks-head">
                    <span style="text-align:center">#</span>
                    <span>Title</span>
                    <span class="ms-th-anime">${asPlaylist ? 'Anime' : 'Type'}</span>
                    <span class="ms-th-tag">${asPlaylist ? 'Type' : 'Episodes'}</span>
                    <span></span>
                </div>
                ${tracks.map((t, i) => trackRowHTML(t, i, asPlaylist)).join('')}
                ` : emptyHTML('No tracks found', '')}
            </div>
        `;
        const playAll = $('#album-play');
        if (playAll) playAll.addEventListener('click', () => { if (tracks.length) play(tracks, 0); });
        const shuf = $('#album-shuffle');
        if (shuf) shuf.addEventListener('click', () => {
            if (!tracks.length) return;
            const shuffled = tracks.slice().sort(() => Math.random() - 0.5);
            state.shuffle = false;
            play(shuffled, 0);
        });
        bindTrackRows(tracks);
        updateNowPlayingMarkers();
    }

    function trackRowHTML(t, i, asPlaylist) {
        const tagClass = (t.typeKind || '').toUpperCase() === 'ED' ? 'ed' : ((t.typeKind || '').toUpperCase() === 'IN' ? 'in' : '');
        const artistsText = (t.artists || []).map(a => `<a href="#/artist/${encodeURIComponent(a.slug || a.id)}" data-stop>${esc(a.name)}</a>`).join(', ');
        const middleCol = asPlaylist
            ? `<a class="ms-track-anime" href="#/anime/${encodeURIComponent(t.animeId)}" data-stop>${esc(t.animeName)}</a>`
            : `<span class="ms-track-tag-cell"><span class="ms-track-tag ${tagClass}">${esc(t.type)}</span></span>`;
        const fourthCol = asPlaylist
            ? `<span class="ms-track-tag-cell"><span class="ms-track-tag ${tagClass}">${esc(t.type)}</span></span>`
            : `<span class="ms-track-anime">${esc(t.episodes || '—')}</span>`;
        return `<div class="ms-track" data-tid="${esc(t.id)}" data-idx="${i}">
            <div class="ms-track-num">
                <span class="ms-num">${i + 1}</span>
                <span class="ms-now-bars"><span></span><span></span><span></span></span>
                <span class="ms-play-mini"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>
            </div>
            <div class="ms-track-meta">
                ${t.cover ? `<img class="ms-track-cover" src="${esc(t.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="ms-track-cover"></div>'}
                <div class="ms-track-text">
                    <div class="ms-track-title">${esc(t.title)}</div>
                    <div class="ms-track-sub">${artistsText || esc(t.animeName)}</div>
                </div>
            </div>
            ${middleCol}
            ${fourthCol}
            <button class="ms-track-like ${state.liked.has(t.id) ? 'is-liked' : ''}" data-tid="${esc(t.id)}" data-stop aria-label="Like">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            </button>
        </div>`;
    }

    function bindTrackRows(tracks) {
        $$('.ms-track', view).forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('[data-stop]')) return;
                const idx = parseInt(row.dataset.idx, 10);
                if (!isNaN(idx)) play(tracks, idx);
            });
        });
        $$('.ms-track-like', view).forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                const id = btn.dataset.tid;
                const t = tracks.find(x => x.id === id);
                if (t) toggleLike(t);
            });
        });
    }

    function songRowHTML(track, idx) {
        const artistsText = (track.artists || []).map(a => `<a href="#/artist/${encodeURIComponent(a.slug || a.id)}" data-stop>${esc(a.name)}</a>`).join(', ');
        return `<div class="ms-song-row" data-tid="${esc(track.id)}" data-idx="${idx}">
            <div class="ms-song-cover-wrap">
                ${track.cover ? `<img class="ms-song-cover" src="${esc(track.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="ms-song-cover"></div>'}
                <span class="ms-song-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
            </div>
            <div class="ms-song-text">
                <div class="ms-song-title">${esc(track.title)}</div>
                <div class="ms-song-sub">${artistsText || '<a href="#/anime/' + encodeURIComponent(track.animeId) + '" data-stop>' + esc(track.animeName) + '</a>'}</div>
            </div>
            <button class="ms-song-like ${state.liked.has(track.id) ? 'is-liked' : ''}" data-tid="${esc(track.id)}" data-stop aria-label="Like">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            </button>
        </div>`;
    }

    function bindSongRows(scope, tracks) {
        $$('.ms-song-row', scope).forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('[data-stop]')) return;
                const idx = parseInt(row.dataset.idx, 10);
                if (!isNaN(idx) && tracks[idx]) play(tracks, idx);
            });
        });
        $$('.ms-song-like', scope).forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                const id = btn.dataset.tid;
                const t = tracks.find(x => x.id === id);
                if (t) toggleLike(t);
            });
        });
    }

    async function renderSearch(q) {
        if (!q) { renderHome(); return; }
        view.innerHTML = loadingHTML(`Searching "${q}"…`);
        const filter = (state.searchFilter || 'all');
        try {
            const data = await api.search(q);
            window.__lastSearch = data;
            const anime = data.anime || [];
            const themes = data.animethemes || [];
            const artists = data.artists || [];
            const songs = data.songs || [];

            const themeTracks = themes
                .map(th => th.anime ? trackFromTheme(th.anime, th) : null)
                .filter(Boolean);

            const tabsHTML = `<div class="ms-search-tabs">
                ${['all','anime','songs','artists'].map(f =>
                    `<button class="ms-tab ${filter===f?'active':''}" data-filter="${f}">${f[0].toUpperCase()+f.slice(1)}</button>`
                ).join('')}
            </div>`;

            const noResults = !anime.length && !artists.length && !songs.length && !themeTracks.length;
            if (noResults) {
                view.innerHTML = `${tabsHTML}${emptyHTML(`No results for "${q}"`, 'Try a different anime, song, or artist.')}`;
                bindSearchTabs(q);
                return;
            }

            let topResultHTML = '';
            const topAnime = anime[0];
            if (topAnime && (filter === 'all' || filter === 'anime')) {
                const cover = coverUrl(topAnime);
                topResultHTML = `<div class="ms-top-result">
                    <div>
                        <div class="ms-section-title" style="margin:0 0 14px"><h2>Top result</h2></div>
                        <a class="ms-top-card" href="#/anime/${encodeURIComponent(topAnime.id)}">
                            ${cover ? `<img class="ms-top-cover" src="${esc(cover)}" alt="" referrerpolicy="no-referrer">` : `<div class="ms-top-cover" style="background:linear-gradient(135deg,#4c1d95,#1e1b4b)"></div>`}
                            <div class="ms-top-name">${esc(topAnime.name)}</div>
                            <span class="ms-top-tag">Anime${topAnime.year ? ' · ' + esc(topAnime.year) : ''}</span>
                            <button class="ms-top-play" data-play-anime="${esc(topAnime.id)}" aria-label="Play">
                                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                            </button>
                        </a>
                    </div>
                    ${themeTracks.length ? `<div class="ms-top-songs">
                        <h3>Songs</h3>
                        <div class="ms-songlist" id="search-top-songs">
                            ${themeTracks.slice(0, 4).map((tk, i) => songRowHTML(tk, i)).join('')}
                        </div>
                    </div>` : ''}
                </div>`;
            }

            const animeBlock = (filter === 'all' || filter === 'anime') && anime.length ? `<div class="ms-search-block">
                <div class="ms-section-title"><h2>Anime</h2></div>
                <div class="ms-card-grid">${anime.slice(0, filter === 'anime' ? 24 : 8).map(animeCardHTML).join('')}</div>
            </div>` : '';

            const artistsBlock = (filter === 'all' || filter === 'artists') && artists.length ? `<div class="ms-search-block">
                <div class="ms-section-title"><h2>Artists</h2></div>
                <div class="ms-card-grid">${artists.slice(0, filter === 'artists' ? 24 : 8).map(artistCardHTML).join('')}</div>
            </div>` : '';

            let songsBlock = '';
            if ((filter === 'all' || filter === 'songs')) {
                const songTracksAll = themeTracks.length ? themeTracks : [];
                if (songTracksAll.length) {
                    const limit = filter === 'songs' ? songTracksAll.length : 8;
                    songsBlock = `<div class="ms-search-block">
                        <div class="ms-section-title"><h2>Songs</h2></div>
                        <div class="ms-songlist" id="search-songs-list">
                            ${songTracksAll.slice(0, limit).map((tk, i) => songRowHTML(tk, i)).join('')}
                        </div>
                    </div>`;
                } else if (songs.length) {
                    songsBlock = `<div class="ms-search-block">
                        <div class="ms-section-title"><h2>Songs</h2></div>
                        <div class="ms-card-grid">${songs.slice(0, 8).map(songCardHTML).join('')}</div>
                    </div>`;
                }
            }

            view.innerHTML = `
                ${tabsHTML}
                ${topResultHTML}
                ${animeBlock}
                ${songsBlock}
                ${artistsBlock}
            `;

            bindSearchTabs(q);
            bindCardClicks(view);

            const topListEl = $('#search-top-songs');
            if (topListEl) bindSongRows(topListEl, themeTracks.slice(0, 4));
            const songsListEl = $('#search-songs-list');
            if (songsListEl) {
                const limit = filter === 'songs' ? themeTracks.length : 8;
                bindSongRows(songsListEl, themeTracks.slice(0, limit));
            }
            updateNowPlayingMarkers();
        } catch (e) {
            console.error('[music] search failed', e);
            view.innerHTML = emptyHTML('Search failed', 'Please try again.');
        }
    }

    function bindSearchTabs(q) {
        $$('.ms-tab', view).forEach(tab => {
            tab.addEventListener('click', () => {
                state.searchFilter = tab.dataset.filter;
                renderSearch(q);
            });
        });
    }

    function closeSidebarIfMobile() {
        if (window.innerWidth <= 1024) {
            $('#music-sidebar').classList.remove('open');
            $('#ms-sidebar-backdrop').classList.remove('active');
        }
    }

    function openYearSidebarLinks() {
        const yearGrid = $('#ms-year-grid');
        const cy = new Date().getFullYear();
        const years = [];
        for (let y = cy; y >= cy - 9; y--) years.push(y);
        yearGrid.innerHTML = years.map(y => `<a data-route="#/year/${y}" href="#/year/${y}">${y}</a>`).join('');
    }

    function init() {
        audio.volume = state.volume;
        setVolUI();

        openYearSidebarLinks();

        let searchTimer;
        const searchInput = $('#ms-search-input');
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.trim();
            $('#ms-search-clear').hidden = !q;
            clearTimeout(searchTimer);
            if (!q) {
                if (location.hash.startsWith('#/search')) navigate('#/');
                return;
            }
            searchTimer = setTimeout(() => {
                navigate('#/search?q=' + encodeURIComponent(q));
            }, 320);
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { searchInput.value = ''; navigate('#/'); }
        });
        $('#ms-search-clear').addEventListener('click', () => {
            searchInput.value = '';
            $('#ms-search-clear').hidden = true;
            navigate('#/');
            searchInput.focus();
        });

        $('#pb-play').addEventListener('click', togglePlay);
        $('#pb-play-mobile').addEventListener('click', togglePlay);
        $('#pb-prev').addEventListener('click', prev);
        $('#pb-next').addEventListener('click', () => next(false));
        $('#pb-shuffle').addEventListener('click', () => {
            state.shuffle = !state.shuffle;
            $('#pb-shuffle').classList.toggle('is-on', state.shuffle);
        });
        $('#pb-loop').addEventListener('click', () => {
            state.loop = !state.loop;
            $('#pb-loop').classList.toggle('is-on', state.loop);
            audio.loop = false;
        });
        $('#pb-mute').addEventListener('click', () => {
            state.muted = !state.muted;
            audio.muted = state.muted;
            video.muted = state.muted;
            setVolUI();
        });
        $('#pb-like').addEventListener('click', () => {
            const t = state.queue[state.index];
            if (t) toggleLike(t);
        });

        bindBar($('#pb-seek'), (pct) => {
            const m = activeMedia();
            if (m.duration) m.currentTime = pct * m.duration;
            setSeek(pct * (m.duration || 0));
        });
        bindBar($('#pb-vol'), (pct) => {
            state.volume = pct;
            state.muted = false;
            audio.muted = false;
            video.muted = false;
            audio.volume = pct;
            video.volume = pct;
            persistVol();
            setVolUI();
        });

        [audio, video].forEach((m) => {
            m.addEventListener('play', () => {
                if (m === activeMedia()) { state.isPlaying = true; setPlayUI(true); }
                if (m === video) showStageLoading(false);
            });
            m.addEventListener('pause', () => {
                if (m === activeMedia()) { state.isPlaying = false; setPlayUI(false); }
                if (m === video) showStageLoading(false);
            });
            m.addEventListener('ended', () => {
                if (m !== activeMedia()) return;
                if (state.loop) { m.currentTime = 0; m.play().catch(() => { }); }
                else next(true);
            });
            m.addEventListener('timeupdate', () => {
                if (m === activeMedia() && !state.scrubbing) setSeek();
                if (m === activeMedia() && _syncedLines.length) updateLyricsHighlight(m.currentTime);
            });

            m.addEventListener('play', () => {
                if (m !== activeMedia()) return;
                if (_lyricRaf) cancelAnimationFrame(_lyricRaf);
                const tick = () => {
                    if (m !== activeMedia() || m.paused || m.ended) {
                        _lyricRaf = null;
                        return;
                    }
                    if (_syncedLines.length && document.body.classList.contains('np-lyrics-open')) {
                        updateLyricsHighlight(m.currentTime);
                    }
                    _lyricRaf = requestAnimationFrame(tick);
                };
                _lyricRaf = requestAnimationFrame(tick);
            });
            m.addEventListener('loadedmetadata', () => {
                if (m !== activeMedia()) return;
                setSeek();

                if (_rawSyncedLines.length) {
                    recomputeSyncedLines();
                    renderSyncedLyrics(_syncedLines);
                }
            });
            m.addEventListener('durationchange', () => {
                if (m !== activeMedia() || !_rawSyncedLines.length) return;
                recomputeSyncedLines();
                renderSyncedLyrics(_syncedLines);
            });

            m.addEventListener('seeked', () => {
                if (m !== activeMedia() || !_syncedLines.length) return;
                _activeLyricIdx = -2;
                updateLyricsHighlight(m.currentTime || 0);
            });
            m.addEventListener('error', () => {
                if (m !== activeMedia()) return;
                if (m === video) showStageLoading(false);
                const t = state.queue[state.index];
                if (t) console.warn('[music] failed to play', t.title);
                setTimeout(() => next(true), 800);
            });
        });

        video.addEventListener('waiting',   () => { if (mediaMode === 'video' && !video.paused) showStageLoading(true); });
        video.addEventListener('loadstart', () => { if (mediaMode === 'video') showStageLoading(true); });
        video.addEventListener('seeking',   () => { if (mediaMode === 'video') showStageLoading(true); });
        video.addEventListener('stalled',   () => { if (mediaMode === 'video' && !video.paused) showStageLoading(true); });
        video.addEventListener('canplay',   () => showStageLoading(false));
        video.addEventListener('canplaythrough', () => showStageLoading(false));
        video.addEventListener('playing',   () => showStageLoading(false));
        video.addEventListener('seeked',    () => showStageLoading(false));
        video.addEventListener('progress',  () => { if (video.readyState >= 3) showStageLoading(false); });

        $('#pb-expand').addEventListener('click', openNP);
        $('#np-close').addEventListener('click', closeNP);
        $('#np-shuffle').addEventListener('click', () => {
            state.shuffle = !state.shuffle;
            $('#pb-shuffle').classList.toggle('is-on', state.shuffle);
            $('#np-shuffle').classList.toggle('is-on', state.shuffle);
        });
        $('#np-loop').addEventListener('click', () => {
            state.loop = !state.loop;
            $('#pb-loop').classList.toggle('is-on', state.loop);
            $('#np-loop').classList.toggle('is-on', state.loop);
        });
        $('#np-prev').addEventListener('click', prev);
        $('#np-next').addEventListener('click', () => next(false));
        $('#np-play').addEventListener('click', togglePlay);
        $('#np-like').addEventListener('click', () => {
            const t = state.queue[state.index];
            if (!t) return;
            toggleLike(t);
            const btn = $('#np-like');
            if (btn) {
                btn.classList.remove('just-liked');

                void btn.offsetWidth;
                btn.classList.add('just-liked');
            }
        });
        bindBar($('#np-seek'), (pct) => {
            const m = activeMedia();
            if (m.duration) m.currentTime = pct * m.duration;
            setSeek(pct * (m.duration || 0));
        });
        function setPanel(which) {

            $('#np-lyrics').hidden = which !== 'lyrics';
            $('#np-queue').hidden = which !== 'queue';
            $('#np-lyrics-btn').classList.toggle('is-on', which === 'lyrics');
            $('#np-queue-btn').classList.toggle('is-on', which === 'queue');

            document.body.classList.toggle('np-lyrics-open', which === 'lyrics');
            if (which === 'queue') renderQueue();

            if (which === 'lyrics' && _syncedLines.length) {
                _activeLyricIdx = -2;
                requestAnimationFrame(() => {
                    updateLyricsHighlight(activeMedia().currentTime || 0);
                });
            }
        }
        $('#np-video-btn').addEventListener('click', () => {
            const t = state.queue[state.index];
            if (!t) return;
            if (!t.videoLink) { toast('No video available for this track'); return; }
            setPanel(null);
            setVideoMode(mediaMode !== 'video');
        });
        $('#np-lyrics-btn').addEventListener('click', () => {
            const showing = $('#np-lyrics').hidden;
            setPanel(showing ? 'lyrics' : null);
        });
        $('#np-queue-btn').addEventListener('click', () => {
            const showing = $('#np-queue').hidden;
            setPanel(showing ? 'queue' : null);
        });

        $('#np-lyrics-close')?.addEventListener('click', () => setPanel(null));
        $('#np-queue-close') ?.addEventListener('click', () => setPanel(null));

        $('#np-bg').addEventListener('click', closeNP);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !npModal.hidden) closeNP();
        });

        $('#pb-title').addEventListener('click', () => {
            if (playerBar.dataset.empty === '1') return;
            openNP();
        });

        $('#pb-dismiss')?.addEventListener('click', () => {
            try { audio.pause(); video.pause(); } catch (_) {}
            document.body.classList.add('pb-hidden');
        });

        $('#ms-back').addEventListener('click', () => {
            if (state.navStack.length > 1) {
                const cur = state.navStack.pop();
                state.navFwd.push(cur);
                const prev = state.navStack[state.navStack.length - 1];
                state.navStack.pop();
                location.hash = prev;
            }
        });
        $('#ms-fwd').addEventListener('click', () => {
            const fwd = state.navFwd.pop();
            if (fwd) location.hash = fwd;
        });

        $('#ms-sidebar-toggle').addEventListener('click', () => {
            const isDesktop = window.innerWidth > 1024;
            if (isDesktop) {
                $('#music-app').classList.toggle('sb-collapsed');
            } else {
                $('#music-sidebar').classList.toggle('open');
                $('#ms-sidebar-backdrop').classList.toggle('active');
            }
        });
        $('#ms-sidebar-backdrop').addEventListener('click', closeSidebarIfMobile);

        const sidebarEl = $('#music-sidebar');
        if (sidebarEl) {
            let downTarget = null;
            let downX = 0, downY = 0;
            let pointerHandledAt = 0;
            const TAP_SLOP = 10;

            sidebarEl.addEventListener('pointerdown', (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                downTarget = e.target.closest('a, .ms-link, [data-route]');
                downX = e.clientX; downY = e.clientY;
            });

            const fireTap = (e) => {
                const link = e.target.closest('a, .ms-link, [data-route]');
                if (!link || !sidebarEl.contains(link)) return false;

                if (downTarget && downTarget !== link) return false;
                if (Math.abs(e.clientX - downX) > TAP_SLOP) return false;
                if (Math.abs(e.clientY - downY) > TAP_SLOP) return false;
                const route = link.dataset.route || link.getAttribute('href');
                if (route && route.startsWith('#')) {
                    navigate(route);
                } else {
                    closeSidebarIfMobile();
                }
                return true;
            };

            sidebarEl.addEventListener('pointerup', (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                if (fireTap(e)) pointerHandledAt = performance.now();
                downTarget = null;
            });

            sidebarEl.addEventListener('click', (e) => {
                const link = e.target.closest('a, .ms-link, [data-route]');
                if (!link || !sidebarEl.contains(link)) return;
                e.preventDefault();
                if (performance.now() - pointerHandledAt < 600) return;
                const route = link.dataset.route || link.getAttribute('href');
                if (route && route.startsWith('#')) navigate(route);
                else closeSidebarIfMobile();
            });

            sidebarEl.addEventListener('pointercancel', () => { downTarget = null; });
        }

        document.body.classList.remove('header-hidden');
        const _hdr = document.getElementById('header');
        if (_hdr) _hdr.classList.remove('is-hidden');
        const musicMain = document.querySelector('.music-main');
        if (musicMain && _hdr) {
            let lastY = 0;
            let ticking = false;
            const SCROLL_THRESHOLD = 8;
            const apply = () => {
                ticking = false;
                if (window.innerWidth > 1024) {

                    _hdr.classList.remove('is-hidden');
                    document.body.classList.remove('header-hidden');
                    return;
                }
                const y = musicMain.scrollTop;
                const dy = y - lastY;
                if (Math.abs(dy) < SCROLL_THRESHOLD) return;
                if (dy > 0 && y > 40) {
                    _hdr.classList.add('is-hidden');
                    document.body.classList.add('header-hidden');
                } else if (dy < 0) {
                    _hdr.classList.remove('is-hidden');
                    document.body.classList.remove('header-hidden');
                }
                lastY = y;
            };
            musicMain.addEventListener('scroll', () => {
                if (ticking) return;
                ticking = true;
                requestAnimationFrame(apply);
            }, { passive: true });
            window.addEventListener('resize', apply);
        }

        window.addEventListener('hashchange', handleRoute);

        document.addEventListener('keydown', (e) => {
            if (e.target.matches('input, textarea')) return;
            if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
            else if (e.key === 'ArrowRight' && e.shiftKey) next(false);
            else if (e.key === 'ArrowLeft' && e.shiftKey) prev();
        });

        handleRoute();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();