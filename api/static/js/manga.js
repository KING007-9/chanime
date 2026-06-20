/**
 * Manga Module — client-side logic for manga pages
 * Handles source switching, search, reader controls, NSFW filtering,
 * and premium detail page upgrades (interactive chapter search, filters, pagination, favorites).
 */

(function () {
    'use strict';

    // ── NSFW Filter ──────────────────────────────────────────────────
    const NSFW_KEY = 'yume_manga_hide_nsfw';

    function isNsfwHidden() {
        return localStorage.getItem(NSFW_KEY) === 'true';
    }

    function applyNsfwFilter() {
        const hide = isNsfwHidden();
        document.querySelectorAll('[data-is-adult="true"]').forEach(el => {
            el.style.display = hide ? 'none' : '';
        });
    }

    // ── Source Tab Switching ──────────────────────────────────────────
    function initSourceTabs() {
        const tabs = document.querySelectorAll('.manga-source-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', function (e) {
                // If it's an anchor, let it navigate
                if (this.tagName === 'A') return;
                e.preventDefault();
                const source = this.dataset.source;
                if (source) {
                    const url = new URL(window.location);
                    url.searchParams.set('source', source);
                    url.searchParams.delete('q');
                    window.location.href = url.pathname + '?' + url.searchParams.toString();
                }
            });
        });
    }

    // ── Manga Search ─────────────────────────────────────────────────
    function initMangaSearch() {
        const form = document.getElementById('manga-search-form');
        if (!form) return;

        form.addEventListener('submit', function (e) {
            const input = form.querySelector('input[name="q"]');
            if (!input || !input.value.trim()) {
                e.preventDefault();
                return;
            }
        });
    }

    // ── Reader Controls ──────────────────────────────────────────────
    function initReader() {
        const readerImages = document.querySelector('.manga-reader-images');
        if (!readerImages) return;

        // Lazy load images
        const images = readerImages.querySelectorAll('img[data-src]');
        if ('IntersectionObserver' in window) {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                        observer.unobserve(img);

                        // Remove loading placeholder
                        const placeholder = img.previousElementSibling;
                        if (placeholder && placeholder.classList.contains('page-loading')) {
                            placeholder.remove();
                        }
                    }
                });
            }, { rootMargin: '600px' });

            images.forEach(img => observer.observe(img));
        } else {
            // Fallback: load all
            images.forEach(img => {
                img.src = img.dataset.src;
                img.removeAttribute('data-src');
            });
        }

        // Keyboard navigation
        document.addEventListener('keydown', function (e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            const prevBtn = document.getElementById('reader-prev');
            const nextBtn = document.getElementById('reader-next');

            if (e.key === 'ArrowLeft' && prevBtn && !prevBtn.disabled) {
                prevBtn.click();
            } else if (e.key === 'ArrowRight' && nextBtn && !nextBtn.disabled) {
                nextBtn.click();
            }
        });

        // Progress tracking
        let ticking = false;
        window.addEventListener('scroll', function () {
            if (!ticking) {
                requestAnimationFrame(() => {
                    updateReadProgress();
                    ticking = false;
                });
                ticking = true;
            }
        });
    }

    function updateReadProgress() {
        const progressBar = document.getElementById('reader-progress');
        if (!progressBar) return;

        const scrollTop = window.scrollY;
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        const progress = docHeight > 0 ? Math.min((scrollTop / docHeight) * 100, 100) : 0;
        progressBar.style.width = progress + '%';
    }

    // ── Image Error Handling ─────────────────────────────────────────
    function initImageErrors() {
        document.querySelectorAll('.manga-card-poster img, .manga-detail-cover img').forEach(img => {
            img.addEventListener('error', function () {
                this.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjIwIiBoZWlnaHQ9IjMwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgZmlsbD0iIzFhMWEyZSIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBDb3ZlcjwvdGV4dD48L3N2Zz4=';
            });
        });
    }

    // ── Premium Detail Page Upgrades ─────────────────────────────────
    function initInteractiveDetailPage() {
        const path = window.location.pathname;
        // Match /manga/<source>/<mangaId> or /manga/<source>/<mangaId>/read/<chapterId>
        const match = path.match(/\/manga\/([^/]+)\/([^/]+)(?:\/read\/([^/]+))?/);
        if (!match) return;

        const source = match[1];
        const mangaId = match[2];
        const chapterId = match[3];

        // ── Case 1: On Reader Page ──
        if (chapterId) {
            const readKey = `yume_manga_read_chapters_${source}_${mangaId}`;
            let readChapters = [];
            try {
                readChapters = JSON.parse(localStorage.getItem(readKey)) || [];
            } catch (e) {}

            if (!readChapters.includes(String(chapterId))) {
                readChapters.push(String(chapterId));
                localStorage.setItem(readKey, JSON.stringify(readChapters));
            }

            // Record as last read
            const lastReadKey = `yume_manga_last_read_${source}_${mangaId}`;
            localStorage.setItem(lastReadKey, JSON.stringify({
                id: String(chapterId),
                timestamp: Date.now()
            }));
            return;
        }

        // ── Case 2: On Detail/Info Page ──
        const chaptersScript = document.getElementById('manga-chapters-data');
        if (!chaptersScript) return;

        let chapters = [];
        try {
            chapters = JSON.parse(chaptersScript.textContent) || [];
        } catch (e) {

            return;
        }

        // Setup Reading progress storage keys
        const readKey = `yume_manga_read_chapters_${source}_${mangaId}`;
        const lastReadKey = `yume_manga_last_read_${source}_${mangaId}`;
        let readChapters = [];
        let lastRead = null;

        try {
            readChapters = JSON.parse(localStorage.getItem(readKey)) || [];
        } catch (e) {}

        try {
            lastRead = JSON.parse(localStorage.getItem(lastReadKey));
        } catch (e) {}

        // 1. Resume Reading Button Display
        if (lastRead && chapters.length > 0) {
            // Find index of last read chapter (comparing as strings)
            const lastReadIdx = chapters.findIndex(c => String(c.id) === String(lastRead.id));
            if (lastReadIdx !== -1) {
                // Scraper order: Descending index 0 is newest.
                // Next chapter to read is index - 1 (closer to newest)
                let resumeChapter = chapters[lastReadIdx];
                if (lastReadIdx > 0) {
                    resumeChapter = chapters[lastReadIdx - 1];
                }

                const resumeBtn = document.getElementById('btn-resume-reading');
                if (resumeBtn) {
                    resumeBtn.href = resumeChapter.readUrl;
                    resumeBtn.style.display = 'inline-flex';
                    resumeBtn.innerHTML = `
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                        Resume ${resumeChapter.title}
                    `;
                }
            }
        }

        // 2. Start Reading Button Auto-update to Point to Oldest (First) Chapter
        if (chapters.length > 0) {
            const startBtn = document.getElementById('btn-start-reading');
            if (startBtn) {
                // Scraper array: index 0 is newest, index length-1 is oldest
                const oldestChapter = chapters[chapters.length - 1];
                startBtn.href = oldestChapter.readUrl;
            }
        }

        // 3. Favorite heart toggler with local storage
        const favKey = 'yume_manga_favorites';
        let favorites = [];
        try {
            favorites = JSON.parse(localStorage.getItem(favKey)) || [];
        } catch (e) {}

        const isFavorited = favorites.some(fav => fav.id === mangaId && fav.source === source);
        const favBtn = document.getElementById('btn-favorite');

        function updateFavBtnStyle(active) {
            if (!favBtn) return;
            if (active) {
                favBtn.classList.add('btn-fav-active');
                favBtn.title = 'Remove from Favorites';
            } else {
                favBtn.classList.remove('btn-fav-active');
                favBtn.title = 'Add to Favorites';
            }
        }

        if (favBtn) {
            updateFavBtnStyle(isFavorited);

            favBtn.addEventListener('click', () => {
                let currentFavs = [];
                try {
                    currentFavs = JSON.parse(localStorage.getItem(favKey)) || [];
                } catch (e) {}

                const existingIdx = currentFavs.findIndex(fav => fav.id === mangaId && fav.source === source);
                if (existingIdx !== -1) {
                    currentFavs.splice(existingIdx, 1);
                    updateFavBtnStyle(false);
                } else {
                    const titleEl = document.querySelector('.manga-detail-title');
                    const coverImgEl = document.querySelector('.manga-detail-cover img');
                    
                    const title = titleEl ? titleEl.textContent.trim() : 'Unknown Title';
                    const poster = coverImgEl ? coverImgEl.src : '';

                    currentFavs.push({
                        id: mangaId,
                        source: source,
                        title: title,
                        poster: poster,
                        addedAt: Date.now()
                    });
                    updateFavBtnStyle(true);
                }
                localStorage.setItem(favKey, JSON.stringify(currentFavs));
            });
        }

        // 4. Interactive Copy Share Link
        const shareBtn = document.getElementById('btn-share');
        if (shareBtn) {
            shareBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(window.location.href).then(() => {
                    const originalHtml = shareBtn.innerHTML;
                    shareBtn.innerHTML = `
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    `;
                    const originalTitle = shareBtn.title;
                    shareBtn.title = 'Link Copied!';
                    setTimeout(() => {
                        shareBtn.innerHTML = originalHtml;
                        shareBtn.title = originalTitle;
                    }, 2000);
                }).catch(err => {

                });
            });
        }

        // 5. Synopsis Expansion Handler
        const descEl = document.getElementById('manga-description');
        const toggleBtn = document.getElementById('manga-description-toggle');
        if (descEl && toggleBtn) {
            // Check actual scroll height vs CSS limit (80px)
            if (descEl.scrollHeight > 85) {
                toggleBtn.style.display = 'inline-flex';
                toggleBtn.addEventListener('click', () => {
                    const isExpanded = descEl.classList.toggle('expanded');
                    toggleBtn.classList.toggle('expanded', isExpanded);
                    toggleBtn.querySelector('span').textContent = isExpanded ? 'Show Less' : 'Show More';
                });
            }
        }

        // ── Chapter search, filter & sort state ──
        let searchQuery = '';
        let filterType = 'all'; // 'all' | 'unread' | 'read'
        let sortDirection = 'desc'; // 'desc' | 'asc'
        try {
            sortDirection = localStorage.getItem('yume_manga_chapter_sort_dir') || 'desc';
        } catch (e) {}
        let currentPage = 1;
        const itemsPerPage = 50;

        // 6. Hook up controls
        const searchInput = document.getElementById('chapter-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value;
                currentPage = 1; // Reset to page 1 on search
                renderChapters();
            });
        }

        const filterPills = document.querySelectorAll('.chapter-filter-pill');
        filterPills.forEach(pill => {
            pill.addEventListener('click', () => {
                filterPills.forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                filterType = pill.dataset.filter;
                currentPage = 1; // Reset to page 1
                renderChapters();
            });
        });

        const sortBtn = document.getElementById('chapter-sort-btn');
        if (sortBtn) {
            // Apply initial UI text based on loaded direction
            if (sortDirection === 'asc') {
                sortBtn.classList.remove('desc');
                sortBtn.querySelector('span').textContent = 'Oldest First';
            } else {
                sortBtn.classList.add('desc');
                sortBtn.querySelector('span').textContent = 'Newest First';
            }

            sortBtn.addEventListener('click', () => {
                if (sortDirection === 'desc') {
                    sortDirection = 'asc';
                    sortBtn.classList.remove('desc');
                    sortBtn.querySelector('span').textContent = 'Oldest First';
                } else {
                    sortDirection = 'desc';
                    sortBtn.classList.add('desc');
                    sortBtn.querySelector('span').textContent = 'Newest First';
                }
                try {
                    localStorage.setItem('yume_manga_chapter_sort_dir', sortDirection);
                } catch (e) {}
                currentPage = 1; // Reset to page 1
                renderChapters();
            });
        }

        // ── Chapter render function ──
        function renderChapters() {
            const listContainer = document.getElementById('interactive-chapter-list');
            if (!listContainer) return;

            // Step A: Filter by search and read status
            let filtered = chapters.filter(ch => {
                const titleLower = ch.title.toLowerCase();
                const matchesSearch = titleLower.includes(searchQuery.toLowerCase()) || 
                                     String(ch.number).toLowerCase().includes(searchQuery.toLowerCase());
                
                const isRead = readChapters.includes(String(ch.id));
                if (filterType === 'read') return matchesSearch && isRead;
                if (filterType === 'unread') return matchesSearch && !isRead;
                return matchesSearch;
            });

            // Update badge count
            const countBadge = document.getElementById('chapter-badge-count');
            if (countBadge) {
                countBadge.textContent = `${filtered.length} chapters`;
            }

            // Step B: Sort chapters
            filtered.sort((a, b) => {
                const numA = parseFloat(a.number) || 0;
                const numB = parseFloat(b.number) || 0;
                return sortDirection === 'desc' ? numB - numA : numA - numB;
            });

            // Step C: Paginate
            const totalItems = filtered.length;
            const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
            if (currentPage > totalPages) {
                currentPage = totalPages;
            }

            const startIdx = (currentPage - 1) * itemsPerPage;
            const paginated = filtered.slice(startIdx, startIdx + itemsPerPage);

            if (paginated.length === 0) {
                listContainer.innerHTML = `
                    <div class="manga-empty" style="padding: 40px 20px; border-radius: var(--radius-md); background: var(--surface-2);">
                        <h3 style="font-size: 1.1rem; color: var(--text-secondary); margin-bottom: 4px;">No chapters found</h3>
                        <p style="font-size: 0.82rem;">Adjust your search or filter pills above.</p>
                    </div>
                `;
                const pagContainer = document.getElementById('chapter-pagination');
                if (pagContainer) pagContainer.style.display = 'none';
                return;
            }

            // Render paginated items
            listContainer.innerHTML = paginated.map(ch => {
                const isRead = readChapters.includes(String(ch.id));
                const isLastRead = lastRead && String(lastRead.id) === String(ch.id);

                let itemClasses = 'manga-chapter-item';
                if (isRead) itemClasses += ' read';
                if (isLastRead) itemClasses += ' last-read';

                let badgeHtml = '<span class="badge-read-status">Unread</span>';
                if (isLastRead) {
                    badgeHtml = '<span class="badge-read-status badge-last-read">Last Read</span>';
                } else if (isRead) {
                    badgeHtml = '<span class="badge-read-status">Read</span>';
                }

                return `
                    <a href="${ch.readUrl}" class="${itemClasses}" data-chapter-id="${ch.id}">
                        <span class="chapter-title">${ch.title}</span>
                        <div class="chapter-meta-right">
                            ${ch.updated ? `<span class="chapter-date">${ch.updated}</span>` : ''}
                            ${ch.pageCount ? `<span class="chapter-date">${ch.pageCount} pages</span>` : ''}
                            ${badgeHtml}
                        </div>
                    </a>
                `;
            }).join('');

            // Render pagination controls
            renderPagination(totalPages);
        }

        // ── Pagination rendering control ──
        function renderPagination(totalPages) {
            const paginationContainer = document.getElementById('chapter-pagination');
            if (!paginationContainer) return;

            if (totalPages <= 1) {
                paginationContainer.style.display = 'none';
                return;
            }

            paginationContainer.style.display = 'flex';
            paginationContainer.innerHTML = `
                <button class="chapter-pagination-btn" id="pagination-prev" ${currentPage === 1 ? 'disabled' : ''}>Prev</button>
                <span class="chapter-pagination-info">Page ${currentPage} of ${totalPages}</span>
                <button class="chapter-pagination-btn" id="pagination-next" ${currentPage === totalPages ? 'disabled' : ''}>Next</button>
            `;

            document.getElementById('pagination-prev').addEventListener('click', () => {
                if (currentPage > 1) {
                    currentPage--;
                    renderChapters();
                    document.getElementById('chapters').scrollIntoView({ behavior: 'smooth' });
                }
            });

            document.getElementById('pagination-next').addEventListener('click', () => {
                if (currentPage < totalPages) {
                    currentPage++;
                    renderChapters();
                    document.getElementById('chapters').scrollIntoView({ behavior: 'smooth' });
                }
            });
        }

        // Render initially
        renderChapters();
    }

    // ── Init ─────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
        initSourceTabs();
        initMangaSearch();
        initReader();
        initInteractiveDetailPage();
        initImageErrors();
        applyNsfwFilter();
    });

    // Expose NSFW toggle for settings page
    window.MangaSettings = {
        isNsfwHidden: isNsfwHidden,
        toggleNsfw: function (hide) {
            localStorage.setItem(NSFW_KEY, hide ? 'true' : 'false');
            applyNsfwFilter();
        }
    };
})();
