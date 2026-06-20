/**
 * Watch Order Timeline – Anime Info Page
 * Fetches watch order data from the backend proxy
 * and renders a gorgeous timeline showing chronological seasons.
 */
(() => {
    let loaded = false;

    function initWatchOrderTab() {
        const watchTab = document.getElementById('tab-watch-order');
        if (!watchTab) return;

        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.attributeName === 'class' && watchTab.classList.contains('active') && !loaded) {
                    loaded = true;
                    fetchWatchOrder();
                }
            }
        });
        observer.observe(watchTab, { attributes: true });

        if (watchTab.classList.contains('active') && !loaded) {
            loaded = true;
            fetchWatchOrder();
        }
    }

    async function fetchWatchOrder() {
        const watchTab = document.getElementById('tab-watch-order');
        const anilistId = watchTab?.dataset.anilistId;
        if (!anilistId) { showEmpty(); return; }

        try {
            const resp = await fetch(`/api/anime/${anilistId}/watch-order`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.success && data.entries && data.entries.length > 0) {
                renderWatchOrder(data.entries, parseInt(anilistId));
            } else {
                showEmpty();
            }
        } catch (e) {
            console.error('Failed to fetch anime watch order:', e);
            showEmpty();
        }
    }

    function showEmpty() {
        const loading = document.getElementById('watch-order-loading');
        const empty = document.getElementById('watch-order-empty');
        if (loading) loading.style.display = 'none';
        if (empty) empty.style.display = 'flex';
    }

    function renderWatchOrder(entries, currentAnilistId) {
        const loading = document.getElementById('watch-order-loading');
        const container = document.getElementById('watch-order-container');

        if (loading) loading.style.display = 'none';
        if (!container) return;

        container.style.display = 'block';
        container.innerHTML = entries.map((entry, index) => {
            const isCurrent = entry.anilistId === currentAnilistId;
            const typeClass = (entry.type || '').toLowerCase();
            
            // Build metadata string
            const metaItems = [];
            if (entry.metadata) {
                if (entry.metadata.date) metaItems.push(`<span class="watch-order-meta-item">${entry.metadata.date}</span>`);
                
                let epDuration = '';
                if (entry.metadata.episodes) {
                    epDuration += `${entry.metadata.episodes} Ep`;
                    if (parseInt(entry.metadata.episodes) !== 1) epDuration += 's';
                }
                if (entry.metadata.duration) {
                    if (epDuration) epDuration += ` × `;
                    epDuration += entry.metadata.duration;
                }
                if (epDuration) {
                    metaItems.push(`<span class="watch-order-meta-item">${epDuration}</span>`);
                }
            } else if (entry.episodes) {
                metaItems.push(`<span class="watch-order-meta-item">${entry.episodes} Ep${entry.episodes !== 1 ? 's' : ''}</span>`);
            }
            
            if (entry.rating) {
                const cleanRating = entry.rating.replace(/★/g, '').trim();
                const rParts = cleanRating.split(/\s+/);
                const score = rParts[0];
                const votes = rParts.slice(1).join(' ');
                if (score) {
                    const ratingHtml = `<span class="watch-order-rating-score" style="color: #f59e0b; font-weight: 700;">★ ${score}</span>${votes ? `<span class="watch-order-rating-votes" style="color: var(--text-muted); font-size: 0.72rem; margin-left: 2px;">${votes}</span>` : ''}`;
                    metaItems.push(`<span class="watch-order-meta-item">${ratingHtml}</span>`);
                }
            }

            const metaHtml = metaItems.join('<span class="watch-order-meta-divider">|</span>');
            const hasLink = entry.anilistId && entry.anilistId > 0;
            const detailUrl = hasLink ? `/anime/${entry.anilistId}` : '#';

            return `
            <div class="watch-order-item">
                <div class="watch-order-marker"></div>
                <div class="watch-order-card ${isCurrent ? 'current-anime' : ''}">
                    <div class="watch-order-img-container">
                        <img src="${entry.image || 'https://via.placeholder.com/70x100?text=?'}" alt="" loading="lazy">
                    </div>
                    <div class="watch-order-info">
                        <div class="watch-order-header">
                            <div class="watch-order-title-group">
                                <h3 class="watch-order-title">
                                    ${hasLink ? `<a href="${detailUrl}">${escapeHtml(entry.title)}</a>` : escapeHtml(entry.title)}
                                </h3>
                                ${entry.secondaryTitle ? `<p class="watch-order-subtitle">${escapeHtml(entry.secondaryTitle)}</p>` : ''}
                            </div>
                            <span class="watch-order-badge ${typeClass}">${entry.type || 'TV'}</span>
                        </div>
                        <div class="watch-order-meta">
                            ${metaHtml}
                        </div>
                        ${isCurrent ? `
                        <span class="watch-order-badge active" style="margin-top: var(--space-xs); font-size: 0.62rem; font-weight: 800; background: var(--accent); color: var(--bg-primary); display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: var(--radius-sm);">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                <circle cx="12" cy="12" r="3"></circle>
                            </svg>
                            CURRENT
                        </span>` : ''}
                    </div>
                    ${hasLink ? `
                    <a href="${detailUrl}" class="watch-order-link-btn" title="View details">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </a>` : ''}
                </div>
            </div>`;
        }).join('');
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    document.addEventListener('DOMContentLoaded', initWatchOrderTab);
})();
