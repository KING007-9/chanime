document.addEventListener('DOMContentLoaded', () => {
    const watchlistContent = document.getElementById('watchlist-content');
    const watchlistTabs = document.getElementById('watchlist-tabs');
    const searchInput = document.getElementById('local-search-input');

    // Sentinel for infinite scroll
    let sentinel = null;

    let currentStatus = '';
    let searchQuery = '';
    let currentPage = 1;
    let isLoading = false;
    let hasMore = true;

    // Abort controller to cancel stale fetches on rapid tab switches
    let currentAbortController = null;
    // Generation counter — every new fetch bumps this; stale responses are ignored
    let fetchGeneration = 0;

    // Status labels mapping
    const statusLabels = {
        'watching': 'Watching',
        'completed': 'Completed',
        'on_hold': 'On Hold',
        'dropped': 'Dropped',
        'plan_to_watch': 'Plan to Watch'
    };

    // Convert local statuses to AniList's standard
    const localToAnilistStatus = {
        'watching': 'CURRENT',
        'completed': 'COMPLETED',
        'on_hold': 'PAUSED',
        'dropped': 'DROPPED',
        'plan_to_watch': 'PLANNING'
    };

    // ── Client-side AniList OAuth Token & ID Caching ───────────────────────────
    let accessToken = null;
    let viewerId = null;

    async function initAccessToken() {
        try {
            const response = await fetch('/api/watchlist/token');
            const data = await response.json();
            if (data.access_token) {
                accessToken = data.access_token;
                viewerId = sessionStorage.getItem('__anilist_viewer_id');
                if (!viewerId) {
                    const viewerData = await anilistRequest(`query { Viewer { id } }`);
                    if (viewerData && viewerData.data && viewerData.data.Viewer) {
                        viewerId = viewerData.data.Viewer.id;
                        sessionStorage.setItem('__anilist_viewer_id', viewerId);
                    }
                }
            }
        } catch (e) {

        }
    }

    async function ensureAuth() {
        if (!accessToken || !viewerId) {
            await initAccessToken();
        }
        return !!accessToken;
    }

    // ── Client-side Direct AniList Request Helper ──────────────────────────────
    async function anilistRequest(query, variables = {}, signal = null) {
        if (!accessToken) return null;
        try {
            const response = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ query, variables }),
                signal
            });
            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After') || '60';
                return { _rate_limited: true, _retry_after: parseInt(retryAfter) || 60 };
            }
            if (!response.ok) return null;
            const data = await response.json();
            if (data.errors) {

                return null;
            }
            return data;
        } catch (e) {
            if (e.name === 'AbortError') throw e;

            return null;
        }
    }

    // ── Fetch stats ──
    async function fetchStats() {
        try {
            const authOk = await ensureAuth();
            let stats = null;

            if (authOk && viewerId) {
                const statsQuery = `
                query ($userId: Int) {
                  User(id: $userId) {
                    statistics {
                      anime {
                        count
                        meanScore
                        minutesWatched
                        episodesWatched
                      }
                    }
                  }
                  MediaListCollection(userId: $userId, type: ANIME) {
                    lists {
                      name
                      status
                      entries { id }
                    }
                  }
                }
                `;
                const rawStats = await anilistRequest(statsQuery, { userId: parseInt(viewerId) });
                if (rawStats && !rawStats._rate_limited) {
                    const response = await fetch('/api/watchlist/stats', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ raw_data: rawStats })
                    });
                    stats = await response.json();
                }
            }

            // Fallback to old server-side load if direct stats load failed
            if (!stats) {
                const response = await fetch('/api/watchlist/stats');
                stats = await response.json();
            }

            if (stats) {
                if (document.getElementById('stat-watching')) document.getElementById('stat-watching').textContent = stats.watching || 0;
                if (document.getElementById('stat-total')) document.getElementById('stat-total').textContent = stats.total || stats.total_anime || 0;
                if (document.getElementById('stat-days') && stats.minutes_watched) {
                    document.getElementById('stat-days').textContent = (stats.minutes_watched / 1440).toFixed(1);
                }
            }
        } catch (e) {

        }
    }

    // Create and append loading sentinel
    function createSentinel() {
        if (sentinel) sentinel.remove();

        const sentinelDiv = document.createElement('div');
        sentinelDiv.id = 'watchlist-sentinel';
        sentinelDiv.className = 'watchlist-loading';
        sentinelDiv.style.opacity = '0';
        sentinelDiv.style.minHeight = '1px';
        sentinelDiv.style.transition = 'opacity 0.2s';
        sentinelDiv.innerHTML = `
            <div class="loading-spinner" style="margin: 0 auto;"></div>
            <p class="text-muted" style="margin-top: var(--space-md);">Loading more...</p>
        `;
        if (watchlistContent && watchlistContent.parentNode) {
            watchlistContent.parentNode.appendChild(sentinelDiv);
        }
        return sentinelDiv;
    }

    // Fetch watchlist
    const WATCHLIST_QUERY = `
    query ($userId: Int, $type: MediaType) {
      MediaListCollection(userId: $userId, type: $type) {
        lists {
          name
          entries {
            id
            mediaId
            status
            progress
            score(format: POINT_10_DECIMAL)
            repeat
            notes
            startedAt { year month day }
            completedAt { year month day }
            media {
              id
              title { userPreferred english romaji }
              episodes
              nextAiringEpisode { episode }
              coverImage { large medium }
              bannerImage
              format
              status
            }
          }
        }
      }
    }
    `;

    async function fetchWatchlist(status = '', page = 1, append = false) {
        if (!append) {
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
            }
            isLoading = false;
        }

        if (isLoading) return;
        isLoading = true;

        const thisGeneration = ++fetchGeneration;
        const abortController = new AbortController();
        currentAbortController = abortController;

        if (!append) {
            if (watchlistContent) {
                watchlistContent.innerHTML = `
                    <div class="watchlist-loading">
                        <div class="loading-spinner" style="margin: 0 auto;"></div>
                        <p class="text-muted" style="margin-top: var(--space-md);">Loading watchlist...</p>
                    </div>
                `;
            }
            currentPage = 1;
            hasMore = true;
            if (!sentinel) sentinel = createSentinel();
            sentinel.style.display = 'block';
            sentinel.style.opacity = '0';
        } else {
            if (sentinel) sentinel.style.opacity = '1';
        }

        try {
            const params = new URLSearchParams({ page, limit: 30 });
            if (status) params.append('status', status);

            const authOk = await ensureAuth();
            let rawData = null;

            if (authOk && viewerId) {
                try {
                    rawData = await anilistRequest(WATCHLIST_QUERY, { userId: parseInt(viewerId), type: 'ANIME' }, abortController.signal);
                } catch (err) {
                    if (err.name === 'AbortError') {
                        isLoading = false;
                        return;
                    }

                }
            }

            if (thisGeneration !== fetchGeneration) {
                isLoading = false;
                return;
            }

            let response;
            if (rawData) {
                if (rawData._rate_limited) {
                    // Intercept rate limited error
                    const retryAfter = rawData._retry_after || 60;
                    if (thisGeneration === fetchGeneration && !append && watchlistContent) {
                        watchlistContent.innerHTML = `
                            <div class="watchlist-empty" id="rate-limit-box" style="text-align:center;">
                                <div style="font-size: 3.5rem; margin-bottom: 12px;">⏳</div>
                                <h3 style="margin-bottom: 8px; color: var(--text-primary, #e2e8f0);">Slow Down, Senpai!</h3>
                                <p class="text-muted" style="margin-bottom: 18px; max-width: 380px; margin-left: auto; margin-right: auto; line-height: 1.6;">
                                    AniList is temporarily limiting requests. Please try again shortly.
                                </p>
                                <div id="retry-countdown" style="display:inline-flex;align-items:center;gap:8px;padding:8px 18px;border-radius:10px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.25);color:#818cf8;font-size:0.85rem;font-weight:600;margin-bottom:18px;">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                    <span>Retrying in <span id="retry-seconds">${retryAfter}</span>s</span>
                                </div>
                                <br>
                                <button id="retry-now-btn" onclick="this.disabled=true;this.textContent='Retrying...';window.__retryWatchlist && window.__retryWatchlist();" style="padding:10px 28px;border-radius:10px;border:1px solid rgba(99,102,241,0.3);background:rgba(99,102,241,0.15);color:#a5b4fc;font-size:0.85rem;font-weight:600;cursor:pointer;transition:all 0.2s;">
                                    Retry Now
                                </button>
                            </div>
                        `;
                        let remaining = retryAfter;
                        const countdownEl = document.getElementById('retry-seconds');
                        const countdownInterval = setInterval(() => {
                            remaining--;
                            if (countdownEl) countdownEl.textContent = remaining;
                            if (remaining <= 0) {
                                clearInterval(countdownInterval);
                                isLoading = false;
                                fetchWatchlist(currentStatus, 1, false);
                            }
                        }, 1000);
                        window.__retryWatchlist = () => {
                            clearInterval(countdownInterval);
                            isLoading = false;
                            fetchWatchlist(currentStatus, 1, false);
                        };
                    }
                    isLoading = false;
                    if (sentinel) sentinel.style.display = 'none';
                    return;
                } else {
                    response = await fetch(`/api/watchlist/paginated?${params}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ raw_data: rawData }),
                        signal: abortController.signal
                    });
                }
            } else {
                // GET Fallback
                response = await fetch(`/api/watchlist/paginated?${params}`, {
                    signal: abortController.signal
                });
            }

            if (thisGeneration !== fetchGeneration) {
                isLoading = false;
                return;
            }

            const data = await response.json();

            if (data.error) {
                if (data.error === 'rate_limited') {
                    if (thisGeneration === fetchGeneration && !append && watchlistContent) {
                        const retryAfter = data.retry_after || 30;
                        watchlistContent.innerHTML = `
                            <div class="watchlist-empty" id="rate-limit-box" style="text-align:center;">
                                <div style="font-size: 3.5rem; margin-bottom: 12px;">⏳</div>
                                <h3 style="margin-bottom: 8px; color: var(--text-primary, #e2e8f0);">Slow Down, Senpai!</h3>
                                <p class="text-muted" style="margin-bottom: 18px; max-width: 380px; margin-left: auto; margin-right: auto; line-height: 1.6;">
                                    ${data.message || 'AniList is temporarily limiting requests.'}
                                </p>
                                <div id="retry-countdown" style="display:inline-flex;align-items:center;gap:8px;padding:8px 18px;border-radius:10px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.25);color:#818cf8;font-size:0.85rem;font-weight:600;margin-bottom:18px;">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                    <span>Retrying in <span id="retry-seconds">${retryAfter}</span>s</span>
                                </div>
                                <br>
                                <button id="retry-now-btn" onclick="this.disabled=true;this.textContent='Retrying...';window.__retryWatchlist && window.__retryWatchlist();" style="padding:10px 28px;border-radius:10px;border:1px solid rgba(99,102,241,0.3);background:rgba(99,102,241,0.15);color:#a5b4fc;font-size:0.85rem;font-weight:600;cursor:pointer;transition:all 0.2s;">
                                    Retry Now
                                </button>
                            </div>
                        `;
                        let remaining = retryAfter;
                        const countdownEl = document.getElementById('retry-seconds');
                        const countdownInterval = setInterval(() => {
                            remaining--;
                            if (countdownEl) countdownEl.textContent = remaining;
                            if (remaining <= 0) {
                                clearInterval(countdownInterval);
                                isLoading = false;
                                fetchWatchlist(currentStatus, 1, false);
                            }
                        }, 1000);
                        window.__retryWatchlist = () => {
                            clearInterval(countdownInterval);
                            isLoading = false;
                            fetchWatchlist(currentStatus, 1, false);
                        };
                    }
                    isLoading = false;
                    if (sentinel) sentinel.style.display = 'none';
                    return;
                }
                throw new Error(data.error);
            }

            let items = data.data || [];
            const pagination = data.pagination || {};

            if (searchQuery) {
                items = items.filter(i => {
                    const t = i.anime_title ? i.anime_title.toLowerCase() : '';
                    return t.includes(searchQuery.toLowerCase());
                });
            }

            hasMore = pagination.has_next && page < pagination.total_pages && !searchQuery;

            if (items.length === 0 && !append) {
                if (watchlistContent) {
                    watchlistContent.innerHTML = `
                        <div class="watchlist-empty">
                            <div style="font-size: 4rem; margin-bottom: var(--space-md);">📚</div>
                            <h3>No anime found</h3>
                            <p class="text-muted" style="margin-bottom: var(--space-lg);">
                                ${searchQuery ? 'No results match your search.' : 'Start adding anime to track your progress!'}
                            </p>
                            <a href="/home" class="btn btn-primary">Browse Anime</a>
                        </div>
                    `;
                }
                if (sentinel) sentinel.style.display = 'none';
                return;
            }

            const itemsHTML = items.map(item => {
                const statusClass = 'status-dot-' + (item.status || 'other');

                const mediaHints = {
                    'RELEASING': { label: 'Airing', color: '#2ecc71', bg: 'rgba(46,204,113,0.12)' },
                    'FINISHED': { label: 'Finished', color: '#3498db', bg: 'rgba(52,152,219,0.12)' },
                    'NOT_YET_RELEASED': { label: 'Upcoming', color: '#f1c40f', bg: 'rgba(241,196,15,0.12)' },
                    'CANCELLED': { label: 'Cancelled', color: '#e74c3c', bg: 'rgba(231,76,60,0.12)' },
                    'HIATUS': { label: 'Hiatus', color: '#e67e22', bg: 'rgba(230,126,34,0.12)' },
                };
                const hint = mediaHints[item.media_status] || null;
                const hintHTML = hint
                    ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:0.6rem;color:${hint.color};background:${hint.bg};padding:1px 6px;border-radius:3px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;white-space:nowrap;flex-shrink:0;line-height:1.4;vertical-align:middle;margin-left:6px;"><span style="width:4px;height:4px;border-radius:50%;background:${hint.color};display:inline-block;flex-shrink:0;"></span>${hint.label}</span>`
                    : '';

                const itemData = encodeURIComponent(JSON.stringify(item));

                return `
                <div class="list-row" data-id="${item.anime_id}" onclick="openEditModal(event, this)" data-item="${itemData}">
                    <div>
                        <div class="status-indicator ${statusClass}" title="${statusLabels[item.status] || item.status || 'Unknown'}"></div>
                    </div>
                    
                    <div style="display: flex; align-items: center; gap: 16px; min-width: 0;">
                        <img src="${item.poster_url || item.poster || 'https://via.placeholder.com/48x68?text=No+Image'}" alt="${item.anime_title}" class="row-cover" loading="lazy">
                        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;min-width:0;">
                            <span class="row-title" style="flex-shrink:1;">${item.anime_title}</span>${hintHTML}
                        </div>
                    </div>
                    
                    <div class="row-score">
                        ${item.score && item.score > 0 ? item.score : '-'}
                    </div>
                    
                    <div class="row-progress">
                        <span class="ep-text">${item.watched_episodes || 0} / ${item.total_episodes || '?'}</span>
                    </div>
                </div>
            `}).join('');

            if (watchlistContent) {
                if (!append) {
                    watchlistContent.innerHTML = itemsHTML;
                } else {
                    const loader = watchlistContent.querySelector('.watchlist-loading');
                    if (loader) loader.remove();
                    watchlistContent.insertAdjacentHTML('beforeend', itemsHTML);
                }
            }

        } catch (e) {
            if (e.name === 'AbortError') {
                isLoading = false;
                return;
            }
            if (thisGeneration === fetchGeneration && !append && watchlistContent) {
                const isNetworkErr = e.message && (e.message.includes('fetch') || e.message.includes('network') || e.message.includes('Failed'));
                watchlistContent.innerHTML = `
                    <div class="watchlist-empty">
                        <div style="font-size: 3.5rem; margin-bottom: var(--space-md);">${isNetworkErr ? '🔌' : '⚠️'}</div>
                        <h3>Error loading watchlist</h3>
                        <p class="text-muted" style="margin-bottom: 18px; max-width: 380px; margin-left: auto; margin-right: auto; line-height: 1.6;">${
                            isNetworkErr
                                ? 'Could not connect. Check your internet and try again.'
                                : e.message
                        }</p>
                        <button onclick="this.disabled=true;this.textContent='Retrying...';window.__retryWatchlist && window.__retryWatchlist();" style="padding:10px 28px;border-radius:10px;border:1px solid rgba(99,102,241,0.3);background:rgba(99,102,241,0.15);color:#a5b4fc;font-size:0.85rem;font-weight:600;cursor:pointer;transition:all 0.2s;">
                            Retry
                        </button>
                    </div>
                `;
                window.__retryWatchlist = () => {
                    isLoading = false;
                    fetchWatchlist(currentStatus, 1, false);
                };
            }
        } finally {
            if (thisGeneration === fetchGeneration) {
                isLoading = false;
                if (!hasMore && sentinel) {
                    sentinel.style.display = 'none';
                } else if (sentinel) {
                    sentinel.style.opacity = '0';
                }
            }
        }
    }

    // Intersection Observer
    function initInfiniteScroll() {
        if (!sentinel) sentinel = createSentinel();

        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && hasMore && !isLoading && !searchQuery) {
                sentinel.style.opacity = '1';
                currentPage++;
                fetchWatchlist(currentStatus, currentPage, true);
            }
        }, {
            root: null,
            rootMargin: '100px',
            threshold: 0.1
        });

        if (sentinel) observer.observe(sentinel);
    }

    // Global functions
    window.updateStatus = async function (animeId, status) {
        try {
            const authOk = await ensureAuth();
            let success = false;
            let errMsg = '';

            if (authOk) {
                const alStatus = localToAnilistStatus[status] || 'CURRENT';
                const mutation = `
                mutation ($mediaId: Int, $status: MediaListStatus) {
                  SaveMediaListEntry(mediaId: $mediaId, status: $status) {
                    id status
                  }
                }
                `;
                const res = await anilistRequest(mutation, { mediaId: parseInt(animeId), status: alStatus });
                if (res && res._rate_limited) {
                    errMsg = 'AniList is rate limiting requests. Please try again in a minute.';
                } else if (res && res.data && res.data.SaveMediaListEntry) {
                    success = true;
                    // Trigger async MAL sync on backend
                    fetch('/api/watchlist/sync_mal', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ anime_id: animeId, action: 'status', status })
                    }).catch(() => {});
                } else {
                    errMsg = 'AniList mutation failed';
                }
            } else {
                // Fallback to old server-side sync
                const response = await fetch('/api/watchlist/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ anime_id: animeId, action: 'status', status })
                });
                const data = await response.json();
                success = data.success;
                errMsg = data.message;
            }

            if (!success) {
                alert(errMsg || 'Failed to update status');
            } else {
                if (currentStatus && currentStatus !== status && currentStatus !== '') {
                    const item = document.querySelector(`.list-row[data-id="${animeId}"]`);
                    if (item) {
                        item.style.transform = 'scale(0.95)';
                        item.style.opacity = '0';
                        setTimeout(() => {
                            item.remove();
                            if (document.querySelectorAll('.list-row').length === 0) {
                                fetchWatchlist(currentStatus, 1, false);
                            }
                        }, 200);
                    }
                } else {
                    const item = document.querySelector(`.list-row[data-id="${animeId}"]`);
                    if (item) {
                        const indicator = item.querySelector('.status-indicator');
                        if (indicator) {
                            indicator.className = 'status-indicator status-dot-' + status;
                        }
                    }
                }
                fetchStats();
            }
        } catch (e) {

        }
    };

    // Modal Handlers
    let activeEditItemId = null;

    const localToAnilistStatusMapping = {
        'watching': 'CURRENT',
        'completed': 'COMPLETED',
        'on_hold': 'PAUSED',
        'dropped': 'DROPPED',
        'plan_to_watch': 'PLANNING'
    };

    window.openEditModal = function (e, rowElement) {
        e.preventDefault();
        e.stopPropagation();
        const itemStr = rowElement.getAttribute('data-item');
        if (!itemStr) return;
        const item = JSON.parse(decodeURIComponent(itemStr));

        activeEditItemId = item.anime_id;

        document.getElementById('edit-modal-title').textContent = item.anime_title;
        document.getElementById('edit-modal-poster').src = item.poster_url || item.poster;
        document.getElementById('edit-modal-link').href = '/anime/' + item.anime_id;

        const watchedEps = item.watched_episodes || 0;
        const nextEp = watchedEps + 1;

        const totalEps = item.total_episodes || 0;
        const nextAiring = item.next_airing_episode || 0;
        let maxAvailable = totalEps;
        if (nextAiring > 0) {
            maxAvailable = nextAiring - 1;
        } else if (totalEps === 0 && item.media_status !== 'RELEASING' && item.media_status !== 'NOT_YET_RELEASED') {
            maxAvailable = watchedEps;
        }

        let watchText = '';
        let targetEp = nextEp;

        if (maxAvailable > 0 && nextEp > maxAvailable) {
            if (item.media_status === 'RELEASING') {
                targetEp = maxAvailable;
                watchText = `Caught Up (Wait for Ep ${nextAiring})`;
            } else {
                targetEp = maxAvailable;
                watchText = maxAvailable === 1 ? 'Watch Again' : `Completed (Re-watch Ep ${maxAvailable})`;
            }
        } else {
            if (watchedEps === 0) {
                watchText = 'Start Watching';
                targetEp = 1;
            } else {
                watchText = `Continue Ep ${nextEp}`;
                targetEp = nextEp;
            }
        }

        const watchLink = document.getElementById('edit-modal-watch');
        watchLink.href = '/watch/' + item.anime_id + '/ep-' + targetEp;
        watchLink.textContent = '';
        watchLink.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg> ${watchText}`;

        let mappedStatus = localToAnilistStatusMapping[item.status] || item.status || 'CURRENT';
        if (!['CURRENT', 'COMPLETED', 'PAUSED', 'DROPPED', 'PLANNING'].includes(mappedStatus)) {
            mappedStatus = 'CURRENT';
        }
        document.getElementById('edit-status').value = mappedStatus;

        const displayTotalEps = item.total_episodes || 0;
        const totalEpsDisplay = displayTotalEps > 0 ? displayTotalEps : '?';
        document.getElementById('edit-episode-label').textContent = `Episode Progress (${totalEpsDisplay} EPS)`;

        const progressInput = document.getElementById('edit-progress');
        progressInput.value = item.watched_episodes || 0;
        if (displayTotalEps > 0) {
            progressInput.max = displayTotalEps;
            if (parseInt(progressInput.value) > displayTotalEps) {
                progressInput.value = displayTotalEps;
            }
        } else {
            progressInput.removeAttribute('max');
        }

        document.getElementById('edit-score').value = item.score || '';
        document.getElementById('edit-rewatches').value = item.repeat || 0;
        document.getElementById('edit-notes').value = item.notes || '';

        const formatDateForInput = (dateObj) => {
            if (!dateObj || (!dateObj.year && !dateObj.month && !dateObj.day)) return '';
            const y = dateObj.year || new Date().getFullYear();
            const m = String(dateObj.month || 1).padStart(2, '0');
            const d = String(dateObj.day || 1).padStart(2, '0');
            return `${y}-${m}-${d}`;
        };

        document.getElementById('edit-start-date').value = formatDateForInput(item.startedAt);
        document.getElementById('edit-end-date').value = formatDateForInput(item.completedAt);

        document.getElementById('edit-modal-overlay').classList.add('active');
    };

    window.closeEditModal = function () {
        document.getElementById('edit-modal-overlay').classList.remove('active');
        activeEditItemId = null;
    };

    window.saveEntry = async function () {
        if (!activeEditItemId) return;

        const parseDateInput = (val) => {
            if (!val) return { year: null, month: null, day: null };
            const dt = new Date(val);
            if (isNaN(dt.getTime())) return { year: null, month: null, day: null };
            return {
                year: dt.getUTCFullYear(),
                month: dt.getUTCMonth() + 1,
                day: dt.getUTCDate()
            };
        };

        const progressInput = document.getElementById('edit-progress');
        let progressValue = parseInt(progressInput.value) || 0;
        const maxEps = parseInt(progressInput.max);

        if (!isNaN(maxEps) && maxEps > 0 && progressValue > maxEps) {
            progressValue = maxEps;
            progressInput.value = maxEps;
        }

        const payload = {
            anime_id: activeEditItemId,
            status: document.getElementById('edit-status').value,
            progress: progressValue,
            score: parseFloat(document.getElementById('edit-score').value) || 0,
            repeat: parseInt(document.getElementById('edit-rewatches').value) || 0,
            notes: document.getElementById('edit-notes').value,
            startedAt: parseDateInput(document.getElementById('edit-start-date').value),
            completedAt: parseDateInput(document.getElementById('edit-end-date').value)
        };

        const btn = document.querySelector('.btn-save');
        const originalText = btn.textContent;
        btn.textContent = 'Saving...';
        btn.disabled = true;

        try {
            const authOk = await ensureAuth();
            let success = false;
            let errMsg = '';

            if (authOk) {
                const SAVE_MUTATION = `
                mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int,
                          $score: Int, $repeat: Int, $notes: String,
                          $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput) {
                  SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress,
                                     scoreRaw: $score, repeat: $repeat, notes: $notes,
                                     startedAt: $startedAt, completedAt: $completedAt) {
                    id status progress score(format: POINT_10_DECIMAL)
                  }
                }
                `;
                const vars = {
                    mediaId: parseInt(payload.anime_id),
                    status: payload.status,
                    progress: payload.progress,
                    score: parseInt(payload.score * 10), // expects POINT_100 (0-100) inside API
                    repeat: payload.repeat,
                    notes: payload.notes,
                    startedAt: payload.startedAt,
                    completedAt: payload.completedAt
                };
                const res = await anilistRequest(SAVE_MUTATION, vars);
                if (res && res._rate_limited) {
                    errMsg = 'AniList is rate limiting requests. Please try again in a minute.';
                } else if (res && res.data && res.data.SaveMediaListEntry) {
                    success = true;
                    // Trigger sync_mal
                    fetch('/api/watchlist/sync_mal', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            anime_id: payload.anime_id,
                            action: 'advanced_update',
                            progress: payload.progress,
                            status: payload.status,
                            score: payload.score
                        })
                    }).catch(() => {});
                } else {
                    errMsg = 'AniList mutation failed';
                }
            } else {
                // Fallback
                const response = await fetch('/api/watchlist/advanced_update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await response.json();
                success = data.success;
                errMsg = data.message;
            }

            if (success) {
                closeEditModal();

                const row = document.querySelector(`.list-row[data-id="${activeEditItemId}"]`);
                if (row) {
                    try {
                        const itemDataStr = row.getAttribute('data-item');
                        const itemDataObj = itemDataStr ? JSON.parse(decodeURIComponent(itemDataStr)) : {};

                        const anilistToLocalStatus = {
                            'CURRENT': 'watching',
                            'COMPLETED': 'completed',
                            'PAUSED': 'on_hold',
                            'DROPPED': 'dropped',
                            'PLANNING': 'plan_to_watch',
                            'REPEATING': 'watching'
                        };

                        const newLocalStatus = anilistToLocalStatus[payload.status] || payload.status.toLowerCase();

                        if (currentStatus && currentStatus !== newLocalStatus && currentStatus !== '') {
                            row.style.transform = 'scale(0.95)';
                            row.style.opacity = '0';
                            setTimeout(() => {
                                row.remove();
                                if (document.querySelectorAll('.list-row').length === 0) {
                                    fetchWatchlist(currentStatus, 1, false);
                                }
                                fetchStats();
                            }, 200);
                            return;
                        }

                        itemDataObj.status = newLocalStatus;
                        itemDataObj.watched_episodes = payload.progress;
                        itemDataObj.score = payload.score;
                        itemDataObj.repeat = payload.repeat;
                        itemDataObj.notes = payload.notes;
                        itemDataObj.startedAt = payload.startedAt;
                        itemDataObj.completedAt = payload.completedAt;

                        row.setAttribute('data-item', encodeURIComponent(JSON.stringify(itemDataObj)));

                        const indicator = row.querySelector('.status-indicator');
                        if (indicator) {
                            indicator.className = 'status-indicator status-dot-' + newLocalStatus;
                            indicator.title = statusLabels[newLocalStatus] || newLocalStatus;
                        }

                        const scoreEl = row.querySelector('.row-score');
                        if (scoreEl) {
                            scoreEl.textContent = payload.score && payload.score > 0 ? payload.score : '-';
                        }

                        const progressSpan = row.querySelector('.row-progress .ep-text');
                        if (progressSpan) {
                            progressSpan.textContent = `${payload.progress} / ${itemDataObj.total_episodes || '?'}`;
                        }
                    } catch (e) {
                        fetchWatchlist(currentStatus, 1, false);
                    }
                } else {
                    fetchWatchlist(currentStatus, 1, false);
                }

                fetchStats();
            } else {
                if (errMsg.toLowerCase().includes('token') || errMsg.toLowerCase().includes('forbidden')) {
                    alert('Session expired. Please refresh the page and try again.');
                } else {
                    alert('Error saving: ' + errMsg);
                }
            }
        } catch (e) {
            alert('Connection error. Please refresh the page and try again.');
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    };

    window.deleteEntry = async function () {
        if (!activeEditItemId) return;
        if (!confirm("Are you sure you want to completely remove this from your watchlist?")) return;

        const btn = document.getElementById('edit-delete-btn');
        btn.disabled = true;
        btn.innerHTML = '...';

        try {
            const authOk = await ensureAuth();
            let success = false;
            let errMsg = '';

            if (authOk) {
                const findQuery = `
                query ($userId: Int, $mediaId: Int) {
                  MediaList(userId: $userId, mediaId: $mediaId) {
                    id
                  }
                }
                `;
                const findData = await anilistRequest(findQuery, { userId: parseInt(viewerId), mediaId: parseInt(activeEditItemId) });
                if (findData && findData.data && findData.data.MediaList) {
                    const entryId = findData.data.MediaList.id;
                    const deleteMutation = `
                    mutation ($id: Int) {
                      DeleteMediaListEntry(id: $id) {
                        deleted
                      }
                    }
                    `;
                    const delData = await anilistRequest(deleteMutation, { id: entryId });
                    if (delData && delData.data && delData.data.DeleteMediaListEntry && delData.data.DeleteMediaListEntry.deleted) {
                        success = true;
                    } else {
                        errMsg = 'Failed to delete from AniList';
                    }
                } else if (findData && findData._rate_limited) {
                    errMsg = 'AniList is rate limiting requests. Please try again in a minute.';
                } else {
                    errMsg = 'Could not find entry on AniList';
                }
            } else {
                // Fallback
                const response = await fetch('/api/watchlist/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ anime_id: activeEditItemId })
                });
                const data = await response.json();
                success = data.success;
                errMsg = data.message;
            }

            if (success) {
                closeEditModal();
                fetchWatchlist(currentStatus, 1, false);
            } else {
                alert('Error deleting: ' + errMsg);
            }
        } catch (e) {
            alert('Connection error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>`;
        }
    };

    // Tab handlers
    if (watchlistTabs) {
        watchlistTabs.querySelectorAll('.filter-btn').forEach(tab => {
            tab.addEventListener('click', function () {
                const active = watchlistTabs.querySelector('.active');
                if (active) active.classList.remove('active');
                this.classList.add('active');
                currentStatus = this.dataset.status;

                currentPage = 1;
                hasMore = true;
                isLoading = false;
                fetchWatchlist(currentStatus, 1, false);
            });
        });
    }

    // Local search handler
    if (searchInput) {
        let debounceTimer;
        searchInput.addEventListener('input', function () {
            clearTimeout(debounceTimer);
            searchQuery = this.value;
            debounceTimer = setTimeout(() => {
                currentPage = 1;
                fetchWatchlist(currentStatus, 1, false);
            }, 300);
        });
    }

    // Close modal when clicking overlay
    const editOverlay = document.getElementById('edit-modal-overlay');
    if (editOverlay) {
        editOverlay.addEventListener('click', function (e) {
            if (e.target === editOverlay) {
                closeEditModal();
            }
        });
    }

    // ESC key closes edit modal
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            const overlay = document.getElementById('edit-modal-overlay');
            if (overlay && overlay.classList.contains('active')) {
                closeEditModal();
            }
        }
    });

    // +/- buttons for episode progress in the edit modal
    window.adjustEditProgress = function (delta) {
        const input = document.getElementById('edit-progress');
        const current = parseInt(input.value) || 0;
        const max = parseInt(input.max);
        let newVal = current + delta;
        if (newVal < 0) newVal = 0;
        if (!isNaN(max) && max > 0 && newVal > max) newVal = max;
        input.value = newVal;

        if (!isNaN(max) && max > 0 && newVal === max) {
            document.getElementById('edit-status').value = 'COMPLETED';
        }
        if (!isNaN(max) && max > 0 && newVal < max && document.getElementById('edit-status').value === 'COMPLETED') {
            document.getElementById('edit-status').value = 'CURRENT';
        }
    };

    // Initialize
    fetchStats();
    fetchWatchlist();
    initInfiniteScroll();

});
