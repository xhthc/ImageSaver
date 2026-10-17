/**
 * content/content_tiktok.js - TikTok DOM video-link copying and embed-friendly sharing.
 * Places Copy and Download below the selected video's native More button.
 * Strictly resolves canonical @user/video/id URLs and copies using the user's selected host.
 */

(function () {
  // DEBUG-MENU-01: the shared journal client (lib/debug_journal.js); a no-op when it is absent. Outcomes only: never the copied link.
  const DBG = (globalThis.ImageSaverDebug && globalThis.ImageSaverDebug.client('content')) || { log() {} };
  DBG.log('tiktok', 'init', 'info');
  'use strict';
  const isLabel = globalThis.MediaLatchCopyKit.labeler();

  const TT_BUTTON_STYLES = `
.image-saver-tt-copy-wrap, .image-saver-tt-save-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  cursor: pointer;
  user-select: none;
  outline: none;
  transition: background-color 0.2s, color 0.2s, transform 0.15s;
  box-sizing: border-box;
  margin: 0;
  pointer-events: auto;
  background-color: rgba(20, 20, 20, 0.72);
  color: #fff;
  z-index: 10;
  position: absolute;
}
.image-saver-tt-copy-wrap:hover, .image-saver-tt-save-wrap:hover {
  background-color: rgba(20, 20, 20, 0.88);
}
.image-saver-tt-copy-wrap:active, .image-saver-tt-save-wrap:active {
  transform: scale(0.92);
}
.image-saver-tt-copy-wrap.is-success {
  color: #22c55e !important;
}
.image-saver-tt-copy-wrap.is-error,
.image-saver-tt-copy-wrap.is-clipboard-error,
.image-saver-tt-save-wrap.is-error {
  color: #ef4444 !important;
  animation: imageSaverTtShake 0.3s ease-in-out;
}
.image-saver-tt-copy-wrap.is-unavailable {
  color: #f59e0b !important;
  animation: imageSaverTtPulse 0.3s ease-in-out;
}
@keyframes imageSaverTtShake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}
@keyframes imageSaverTtPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.18); }
}
.image-saver-tt-save-wrap[aria-disabled="true"] {
  opacity: 0.55;
  cursor: progress;
}
.image-saver-tt-copy-wrap:focus-visible, .image-saver-tt-save-wrap:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
.image-saver-tt-copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  pointer-events: none;
}
@media (hover: hover) {
  .image-saver-tt-hover-area:not(:hover):not(:has(:focus-visible)) .image-saver-tt-copy-wrap,
  .image-saver-tt-hover-area:not(:hover):not(:has(:focus-visible)) .image-saver-tt-save-wrap {
    opacity: 0;
    pointer-events: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .image-saver-tt-copy-wrap, .image-saver-tt-save-wrap { animation: none; transition: none; }
}
.image-saver-tt-icon {
  width: 20px;
  height: 20px;
  display: block;
  pointer-events: none;
  flex-shrink: 0;
}
`;

  const SVG_LINK_ICON = globalThis.MediaLatchCopyKit.copyIcon('image-saver-tt-icon');

  // the download glyph of the shared inline controls (content/content_inline.js)
  const SVG_SAVE_ICON = `<svg class="image-saver-tt-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>`;

  const SVG_CHECK_ICON = `<svg class="image-saver-tt-icon" viewBox="2 2 20 20" width="20" height="20" fill="currentColor">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
  </svg>`;

  const SVG_UNAVAILABLE_ICON = `<svg class="image-saver-tt-icon" viewBox="0 0 20 20" width="20" height="20" fill="currentColor">
    <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
  </svg>`;

  const SVG_ERROR_ICON = `<svg class="image-saver-tt-icon" viewBox="0 0 20 20" width="20" height="20" fill="currentColor">
    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
  </svg>`;

  const ALLOWED_TT_SHARE_HOSTS = ['tiktok.com', 'tnktok.com', 'd.tnktok.com'];
  const DEFAULT_TT_SHARE_HOST = 'tnktok.com';
  const ttShare = globalThis.MediaLatchCopyKit.shareHost('ttShareHost', ALLOWED_TT_SHARE_HOSTS, DEFAULT_TT_SHARE_HOST);

  /**
   * Constructs an embed-friendly or canonical share URL for a TikTok video.
   * Only allowed hosts: 'tiktok.com', 'tnktok.com', 'd.tnktok.com'.
   * Input must be HTTPS tiktok.com URL with valid /@user/video/id path.
   * Suffixes, query string, and hash are omitted.
   */
  function formatTikTokShareUrl(rawUrl, targetHost = ttShare.get()) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;

    const host = ALLOWED_TT_SHARE_HOSTS.includes(targetHost) ? targetHost : DEFAULT_TT_SHARE_HOST;

    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:') return null;

      const hostname = parsed.hostname.toLowerCase();
      if (hostname !== 'tiktok.com' && hostname !== 'www.tiktok.com' && hostname !== 'm.tiktok.com') {
        return null;
      }

      const match = parsed.pathname.match(/^\/@([a-zA-Z0-9_.-]+)\/video\/(\d+)(?:\/.*)?$/i);
      if (!match) return null;

      const username = match[1];
      const videoId = match[2];

      return `https://${host}/@${username}/video/${videoId}`;
    } catch (_) {
      return null;
    }
  }

  function ensureTtButtonStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('image-saver-tt-styles')) return;
    try {
      const styleEl = document.createElement('style');
      styleEl.id = 'image-saver-tt-styles';
      styleEl.textContent = TT_BUTTON_STYLES;
      (document.head || document.documentElement || document.body)?.appendChild(styleEl);
    } catch (_) {}
  }

  /**
   * Validates if a string is a legitimate TikTok Snowflake video ID.
   * TikTok video IDs are 64-bit integer strings, 15 to 22 digits (typically 18-20 digits).
   */
  function isValidTikTokVideoId(id) {
    if (!id || typeof id !== 'string') return false;
    const trimmed = id.trim();
    return /^\d{15,22}$/.test(trimmed);
  }

  /**
   * Validates if a string is a legitimate TikTok username.
   */
  function isValidTikTokUsername(name) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    return /^[a-zA-Z0-9_.-]{2,50}$/.test(trimmed) &&
           !['explore', 'live', 'following', 'foryou', 'friends', 'video', 'tag'].includes(trimmed.toLowerCase());
  }

  /**
   * Extracts author username from multiple redundant sources within the card container.
   */
  function extractAuthorFromCard(card) {
    if (!card || typeof card.querySelectorAll !== 'function') return null;

    // 1. Author avatar link
    const avatarLink = card.querySelector('a[data-e2e="video-author-avatar"], a[data-e2e="browse-user-avatar"]');
    if (avatarLink) {
      const href = (avatarLink.getAttribute && avatarLink.getAttribute('href')) || avatarLink.href || '';
      const m = href.match(/\/@([a-zA-Z0-9_.-]+)/i);
      if (m && isValidTikTokUsername(m[1])) return m[1];
    }

    // 2. Author uniqueid elements (text or href)
    const uniqueIdEls = Array.from(card.querySelectorAll('[data-e2e="video-author-uniqueid"], [data-e2e="browse-username"], a[data-e2e*="uniqueid"], span[data-e2e*="uniqueid"], h3[data-e2e*="uniqueid"], p[data-e2e*="uniqueid"]'));
    for (const el of uniqueIdEls) {
      const href = (el.getAttribute && el.getAttribute('href')) || el.href || '';
      const hrefMatch = href.match(/\/@([a-zA-Z0-9_.-]+)/i);
      if (hrefMatch && isValidTikTokUsername(hrefMatch[1])) return hrefMatch[1];

      const text = (el.textContent || '').trim();
      const textMatch = text.match(/^@?([a-zA-Z0-9_.-]+)$/);
      if (textMatch && isValidTikTokUsername(textMatch[1])) return textMatch[1];
    }

    // 3. Any anchor starting with /@ (skipping video links)
    const allUserAnchors = Array.from(card.querySelectorAll('a[href^="/@"], a[href*="/@"]'));
    for (const a of allUserAnchors) {
      const href = (a.getAttribute && a.getAttribute('href')) || a.href || '';
      if (href.includes('/video/')) continue;
      const m = href.match(/\/@([a-zA-Z0-9_.-]+)/i);
      if (m && isValidTikTokUsername(m[1])) return m[1];
    }

    // 4. React fiber/props if present
    try {
      const propsKey = Object.keys(card).find(k => k.startsWith('__reactProps') || k.startsWith('__reactFiber'));
      if (propsKey && card[propsKey]) {
        const item = card[propsKey].itemInfo || card[propsKey].memoizedProps?.itemInfo || card[propsKey].videoData;
        const u = item?.author?.uniqueId || item?.author?.id;
        if (u && isValidTikTokUsername(String(u))) return String(u);
      }
    } catch (_) {}

    return null;
  }

  /**
   * Extracts valid Snowflake video ID and provenance source from same-card elements.
   * Strictly validates numeric Snowflake format (/^\d{15,22}$/) to avoid bogus IDs.
   * Directly queries actual ID-bearing elements to prevent preceding icon elements without IDs
   * from masking later ID-bearing buttons.
   */
  function extractVideoIdDetailsFromCard(card) {
    if (!card || typeof card.querySelectorAll !== 'function') return { id: null, source: 'none' };

    // 1. Direct anchor containing /video/{id}
    const anchors = Array.from(card.querySelectorAll('a[href*="/video/"]'));
    for (const a of anchors) {
      const href = (a.getAttribute && a.getAttribute('href')) || a.href || '';
      const m = href.match(/\/video\/(\d{15,22})/i);
      if (m && isValidTikTokVideoId(m[1])) return { id: m[1], source: 'anchor' };
    }

    // 2. Direct search for elements with explicit ID-bearing attributes:
    // Querying actual ID-bearing attributes directly ensures that any preceding
    // icon or wrapper elements without an ID attribute never intercept the lookup.
    const idElements = Array.from(card.querySelectorAll(
      '[data-more-menu-item-id], [data-item-id], [data-video-id], [data-id], [data-more-menu-id]'
    ));
    for (const el of idElements) {
      const rawId = (el.getAttribute && (
        el.getAttribute('data-more-menu-item-id') ||
        el.getAttribute('data-item-id') ||
        el.getAttribute('data-video-id') ||
        el.getAttribute('data-id') ||
        el.getAttribute('data-more-menu-id')
      )) || el.dataset?.moreMenuItemId || el.dataset?.itemId || el.dataset?.videoId;

      if (rawId && isValidTikTokVideoId(String(rawId).trim())) {
        return { id: String(rawId).trim(), source: 'more-menu-attr' };
      }
    }

    // 3. Fallback: inspect more-menu icon elements and their nearest ID-bearing container/children
    const menuIcons = Array.from(card.querySelectorAll('[data-e2e="more-menu-icon"], button[class*="More"]'));
    for (const icon of menuIcons) {
      for (const attr of ['data-more-menu-item-id', 'data-item-id', 'data-video-id', 'data-id']) {
        const val = icon.getAttribute && icon.getAttribute(attr);
        if (val && isValidTikTokVideoId(String(val).trim())) return { id: String(val).trim(), source: 'more-menu-carrier' };
      }
      const carrier = (icon.closest && icon.closest('[data-more-menu-item-id], [data-item-id], [data-video-id], [data-id]')) ||
                      (icon.querySelector && icon.querySelector('[data-more-menu-item-id], [data-item-id], [data-video-id], [data-id]'));
      if (carrier) {
        const rawId = (carrier.getAttribute && (
          carrier.getAttribute('data-more-menu-item-id') ||
          carrier.getAttribute('data-item-id') ||
          carrier.getAttribute('data-video-id') ||
          carrier.getAttribute('data-id')
        )) || carrier.dataset?.moreMenuItemId || carrier.dataset?.itemId;
        if (rawId && isValidTikTokVideoId(String(rawId).trim())) {
          return { id: String(rawId).trim(), source: 'more-menu-carrier' };
        }
      }
    }

    // 4. Video player / XGPlayer element IDs
    const playerEls = Array.from(card.querySelectorAll('[id*="xgwrapper"], [id*="xgvideo"], video[id], div[id*="player"]'));
    for (const el of playerEls) {
      const idStr = el.id || (el.getAttribute && el.getAttribute('id')) || '';
      const m = idStr.match(/(?:xgwrapper|xgvideo|player|video)[-_]\d+[-_](\d{15,22})/i) ||
                idStr.match(/[-_](\d{15,22})(?:[-_]|$)/);
      if (m && isValidTikTokVideoId(m[1])) return { id: m[1], source: 'xgplayer' };
    }

    // 5. Video element attributes
    const videos = Array.from(card.querySelectorAll('video'));
    for (const v of videos) {
      const vid = (v.getAttribute && (v.getAttribute('data-id') || v.getAttribute('data-item-id'))) || v.dataset?.id;
      if (vid && isValidTikTokVideoId(String(vid).trim())) return { id: String(vid).trim(), source: 'video-elem' };
    }

    // 6. Input or share elements containing /video/{id}
    const inputs = Array.from(card.querySelectorAll('input[value*="/video/"], [data-share-url], [data-url]'));
    for (const inp of inputs) {
      const val = (inp.getAttribute && (inp.getAttribute('value') || inp.getAttribute('data-share-url') || inp.getAttribute('data-url'))) || inp.value || '';
      const m = val.match(/\/video\/(\d{15,22})/i);
      if (m && isValidTikTokVideoId(m[1])) return { id: m[1], source: 'input-share' };
    }

    // 7. React fiber/props if present
    try {
      const propsKey = Object.keys(card).find(k => k.startsWith('__reactProps') || k.startsWith('__reactFiber'));
      if (propsKey && card[propsKey]) {
        const item = card[propsKey].itemInfo || card[propsKey].memoizedProps?.itemInfo || card[propsKey].videoData;
        const vid = item?.id || item?.itemInfo?.id;
        if (vid && isValidTikTokVideoId(String(vid))) return { id: String(vid), source: 'react-props' };
      }
    } catch (_) {}

    return { id: null, source: 'none' };
  }

  function extractVideoIdFromCard(card) {
    return extractVideoIdDetailsFromCard(card).id;
  }

  /**
   * Copies text to the clipboard with modern navigator.clipboard and robust fallback.
   * Handles user activation and permission issues separately.
   */
  async function copyTextToClipboard(text) {
    if (!text || typeof text !== 'string') return false;

    // 1. Primary attempt: navigator.clipboard.writeText
    let primarySuccess = false;
    const nav = (typeof window !== 'undefined' && window.navigator) ? window.navigator : (typeof navigator !== 'undefined' ? navigator : null);
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      try {
        await nav.clipboard.writeText(text);
        primarySuccess = true;
      } catch (_) {
        primarySuccess = false;
      }
    }

    if (primarySuccess) return true;

    // 2. Fallback attempt: document.execCommand('copy') via textarea
    if (typeof document !== 'undefined') {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '-9999px';
        ta.style.width = '2em';
        ta.style.height = '2em';
        ta.style.padding = '0';
        ta.style.border = 'none';
        ta.style.outline = 'none';
        ta.style.boxShadow = 'none';
        ta.style.background = 'transparent';
        (document.body || document.documentElement).appendChild(ta);
        if (typeof ta.focus === 'function') ta.focus();
        if (typeof ta.select === 'function') ta.select();
        if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, text.length);
        const fallbackSuccess = document.execCommand('copy');
        (document.body || document.documentElement).removeChild(ta);
        if (fallbackSuccess) return true;
      } catch (_) {}
    }

    return false;
  }

  /**
   * Resolves the strict owning article or card element.
   * Strictly scopes to the owning recommend-list-item-container article,
   * never a broad main/section or neighboring card.
   */
  function resolveOwningTikTokCard(container) {
    if (!container || typeof container !== 'object') return null;

    // 1. If container itself is a card element
    if (typeof container.matches === 'function') {
      if (container.matches('article[data-e2e="recommend-list-item-container"], article[id^="one-column-item-"], article, [data-e2e="recommend-list-item-container"], [data-e2e="feed-item"], [data-e2e="user-post-item"], [data-e2e="browse-video"], [data-e2e="video-detail-container"]')) {
        return container;
      }
    }

    // 2. Look up for closest owning article or feed-item container
    if (typeof container.closest === 'function') {
      const article = container.closest('article[data-e2e="recommend-list-item-container"], article[id^="one-column-item-"], article');
      if (article) return article;

      const feedItem = container.closest('[data-e2e="recommend-list-item-container"], [data-e2e="feed-item"], [data-e2e="user-post-item"], [data-e2e="browse-video"], [data-e2e="video-detail-container"], div[class*="VideoDetailContainer"], div[class*="DivVideoDetailContainer"]');
      if (feedItem) return feedItem;
    }

    const tagName = (container.tagName || '').toLowerCase();
    if (tagName === 'article') return container;

    // Disallow broad page-level containers (main, body, html)
    if (tagName === 'main' || tagName === 'body' || tagName === 'html') {
      return null;
    }

    return container;
  }

  /**
   * Extracts canonical /@user/video/{videoId} URL from a TikTok video item container.
   * Strictly isolates per-item ownership. Never falls back to page URL on multi-video feeds.
   * Strictly scopes to owning card container; fails closed on broad containers.
   */
  function extractTikTokUrl(container, currentWindowUrl = null) {
    if (!container) return null;

    const card = resolveOwningTikTokCard(container);
    if (!card || typeof card.querySelectorAll !== 'function') return null;

    // Guard against broad containers spanning multiple cards: fail closed
    const nestedCards = card.querySelectorAll('article[data-e2e="recommend-list-item-container"], article[id^="one-column-item-"]');
    if (nestedCards.length > 1) {
      return null;
    }

    // 1. Primary: search for video link anchor containing both user and video ID
    const anchors = Array.from(card.querySelectorAll('a[href*="/video/"]'));
    for (const a of anchors) {
      const href = (a.getAttribute && a.getAttribute('href')) || a.href || '';
      const match = href.match(/\/@([a-zA-Z0-9_.-]+)\/video\/(\d{15,22})/i);
      if (match && isValidTikTokUsername(match[1]) && isValidTikTokVideoId(match[2])) {
        return `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
      }
    }

    // 2. Resolve author and videoId from same-card elements
    const author = extractAuthorFromCard(card);
    const videoId = extractVideoIdFromCard(card);

    if (author && videoId && isValidTikTokUsername(author) && isValidTikTokVideoId(videoId)) {
      return `https://www.tiktok.com/@${author}/video/${videoId}`;
    }

    // 3. Check for input or share elements containing canonical video link
    const inputs = Array.from(card.querySelectorAll('input[value*="/video/"], [data-share-url], [data-url]'));
    for (const inp of inputs) {
      const val = (inp.getAttribute && (inp.getAttribute('value') || inp.getAttribute('data-share-url') || inp.getAttribute('data-url'))) || inp.value || '';
      const match = val.match(/\/@([a-zA-Z0-9_.-]+)\/video\/(\d{15,22})/i);
      if (match && isValidTikTokUsername(match[1]) && isValidTikTokVideoId(match[2])) {
        return `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
      }
    }

    // 4. Standalone single-video page fallback (strictly disallowed if multiple feed items exist)
    const pageUrl = currentWindowUrl || (typeof window !== 'undefined' ? window.location?.href : '');
    if (pageUrl) {
      const pageMatch = pageUrl.match(/(?:tiktok\.com)\/@([a-zA-Z0-9_.-]+)\/video\/(\d{15,22})/i);
      if (pageMatch && isValidTikTokUsername(pageMatch[1]) && isValidTikTokVideoId(pageMatch[2])) {
        const docItems = typeof document !== 'undefined' && document.querySelectorAll
          ? document.querySelectorAll('article[data-e2e="recommend-list-item-container"], [data-e2e="recommend-list-item-container"], [data-e2e="feed-item"], article[id^="one-column-item-"]')
          : [];
        if (docItems.length <= 1) {
          return `https://www.tiktok.com/@${pageMatch[1]}/video/${pageMatch[2]}`;
        }
      }
    }

    return null;
  }

  // The native More button is inside the card's overlay (observed live). Share/menu/rail containers are never placement fallbacks.
  const CARD = 'article, [data-e2e="recommend-list-item-container"], [data-e2e="feed-item"], [data-e2e="user-post-item"], [data-e2e="browse-video"], [data-e2e="video-detail-container"]';
  const PORTAL = '[data-e2e="context-menu"], [data-e2e*="right-click-menu"], [role="menu"]';
  const inPortal = (el) => Boolean(el && typeof el.closest === 'function' && el.closest(PORTAL));
  function isOwnCard(card) {
    try {
      if (!card || typeof card.querySelectorAll !== 'function' || typeof card.matches !== 'function' || !card.matches(CARD) || inPortal(card)) return false;
      return card.querySelectorAll('article, [data-e2e="recommend-list-item-container"]').length === 0 && card.querySelectorAll('[id^="xgwrapper-"]').length <= 1;
    } catch (_) { return false; }
  }
  function anchorOf(card) {
    try {
      if (!isOwnCard(card)) return null;
      const candidates = Array.from(card.querySelectorAll('button[data-e2e="more-menu-icon"]')).filter(m => !inPortal(m));
      if (candidates.length !== 1) return null;
      const more = candidates[0], host = more.offsetParent;
      if (!more.isConnected || !host || !host.isConnected || !card.contains(host) || inPortal(host) || resolveOwningTikTokCard(more) !== card) return null;
      const left = more.offsetLeft + (more.offsetWidth - 40) / 2, top = more.offsetTop + more.offsetHeight + 6;
      if (![left, top].every(Number.isFinite) || more.offsetWidth <= 0 || more.offsetHeight <= 0) return null;
      return { more, host, left, top };
    } catch (_) { return null; }
  }
  function positionControls(card, anchor) {
    // The overlay may be a pointer-transparent sibling of the video; hover their nearest shared media container.
    const video = card.querySelector('video');
    let area = anchor.host;
    while (area && area !== card && !area.contains(video)) area = area.parentElement;
    if (area && area !== card && video) area.classList.add('image-saver-tt-hover-area');
    let row = 0;
    for (const cls of ['image-saver-tt-copy-wrap', 'image-saver-tt-save-wrap']) {
      const el = card.querySelector('.' + cls);
      if (!el || el.parentElement !== anchor.host) continue;
      el.style.position = 'absolute';
      el.style.left = anchor.left + 'px';
      el.style.top = (anchor.top + row++ * 46) + 'px';
    }
  }

  // Download (TikTok only): a trusted press freezes the card's ONE player (wrapper item id, stream address, page) when it is on screen and not
  // covered; only a one-shot token and the item id go to the worker, which asks this document to prove the frozen player again
  // (TIKTOK_INLINE_PROOF) and resolves that player's own item (worker/site_resolvers.js). No right-click capture is read or written.
  const saves = new Map();
  const ITEM = /^xgwrapper-\d+-(\d{5,30})$/;
  function freezePlayer(card, wrap) {
    try {
      const players = Array.from(card.querySelectorAll('[id^="xgwrapper-"] video'));
      if (players.length !== 1 || !wrap.isConnected || !card.contains(wrap)) return null;
      const v = players[0], wrapper = v.closest('[id^="xgwrapper-"]'), m = ITEM.exec(wrapper ? wrapper.id : ''), stream = String(v.currentSrc || '');
      if (!m || !stream.startsWith('blob:' + location.origin + '/')) return null;
      const r = v.getBoundingClientRect(), x0 = Math.max(r.left, 0), y0 = Math.max(r.top, 0), x1 = Math.min(r.right, window.innerWidth), y1 = Math.min(r.bottom, window.innerHeight);
      if (x1 <= x0 || y1 <= y0) return null;
      // the centre of its visible part must show this card on top: covered by a dialog, TikTok's menu or another layer is refused, and offscreen
      // (no visible part: that centre lies outside the viewport, where elementFromPoint answers null) as well
      const top = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
      if (!top || !card.contains(top)) return null;
      const cover = top.closest('dialog, [role="dialog"], [aria-modal="true"], [class*="Modal" i], tiktok-cookie-banner, ' + PORTAL);
      if (cover && !cover.contains(v)) return null;
      return { ref: new WeakRef(v), card: new WeakRef(card), item: m[1], stream, href: location.href, at: Date.now() };
    } catch (_) { return null; }
  }
  function saveState(wrap, failed = false) {
    wrap.classList.toggle('is-error', failed);
    wrap.querySelector('.image-saver-tt-copy-btn').innerHTML = failed ? SVG_ERROR_ICON : SVG_SAVE_ICON;
    const key = failed ? 'downloads.commandFailed' : 'inline.saveThisAria';
    const fallback = failed ? 'The action could not be completed.' : 'MediaLatch: Save this media';
    isLabel(wrap, 'title', key, fallback);
    isLabel(wrap, 'aria-label', key, fallback);
  }
  function requestSave(wrap) {
    if (wrap.getAttribute('aria-disabled') === 'true') return; // a second press of the same request
    saveState(wrap);
    const card = resolveOwningTikTokCard(wrap), anchor = anchorOf(card);
    const frozen = anchor && wrap.parentElement === anchor.host && freezePlayer(card, wrap);
    if (!frozen) {
      DBG.log('tiktok.save', 'press', 'refused', 'NO_PLAYER');
      saveState(wrap, true);
      return;
    }
    wrap.setAttribute('aria-disabled', 'true'); setTimeout(() => wrap.removeAttribute('aria-disabled'), 1500);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    saves.set(token, frozen); for (const k of saves.keys()) { if (saves.size <= 8) break; saves.delete(k); }
    DBG.log('tiktok.save', 'press', 'ok');
    try { const sent = chrome.runtime.sendMessage({ action: 'TIKTOK_INLINE_SAVE', token, item: frozen.item }); if (sent && typeof sent.catch === 'function') sent.catch(() => saveState(wrap, true)); } catch (_) { saveState(wrap, true); }
  }
  // Only the worker (no tab) may ask, once per token; a token this instance did not issue gets no answer here.
  try {
    chrome.runtime.onMessage.addListener((m, sender, respond) => {
      if (!m || m.action !== 'TIKTOK_INLINE_PROOF' || !sender || sender.tab || sender.id !== chrome.runtime.id || !saves.has(m.token)) return;
      const f = saves.get(m.token); saves.delete(m.token);
      const v = f.ref.deref(), c = f.card.deref(), wrapper = v && v.closest('[id^="xgwrapper-"]'), m2 = ITEM.exec(wrapper ? wrapper.id : '');
      const held = Boolean(Date.now() - f.at < 30000 && f.href === location.href && v && c && v.isConnected && c.contains(v) && m2 && m2[1] === f.item &&
        String(v.currentSrc || '') === f.stream && c.querySelectorAll('[id^="xgwrapper-"] video').length === 1);
      respond(held ? { ok: true, media: { item: f.item, stream: f.stream } } : { ok: false, reason: 'STALE_ITEM' });
      return true;
    });
  } catch (_) {}
  function makeSaveButton() {
    const wrap = document.createElement('div');
    wrap.className = 'image-saver-tt-save-wrap';
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');
    isLabel(wrap, 'title', 'inline.saveThisAria', 'MediaLatch: Save this media');
    isLabel(wrap, 'aria-label', 'inline.saveThisAria', 'MediaLatch: Save this media');
    const btn = document.createElement('div');
    btn.className = 'image-saver-tt-copy-btn';
    btn.innerHTML = SVG_SAVE_ICON;
    wrap.appendChild(btn);
    const press = (e) => {
      if (!e || !e.isTrusted || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault(); e.stopPropagation(); if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      requestSave(wrap);
    };
    wrap.addEventListener('click', press);
    wrap.addEventListener('keydown', press);
    return wrap;
  }
  // One Download beside the card's Copy in DOM order, only while the card holds exactly one player.
  function ensureSaveButton(card, rail, copyWrap) {
    try {
      const all = Array.from(card.querySelectorAll('.image-saver-tt-save-wrap'));
      if (card.querySelectorAll('[id^="xgwrapper-"] video').length !== 1) { all.forEach((w) => w.remove()); return; }
      let kept = null;
      for (const w of all) { if (!kept && w.parentElement === rail) kept = w; else w.remove(); }
      if (!kept) kept = makeSaveButton();
      if (kept.previousElementSibling !== copyWrap) rail.insertBefore(kept, copyWrap.nextSibling);
    } catch (_) {}
  }

  // One Copy and Download below this card's unique native More icon; preserve its handlers and the native action rail.
  function injectCopyButtonToTikTokVideo(container) {
    if (!container || typeof container.querySelector !== 'function') return false;
    // A missing, hidden or ambiguous native anchor gets no control.
    const videoContainer = resolveOwningTikTokCard(container);
    if (!isOwnCard(videoContainer)) return false;
    const anchor = anchorOf(videoContainer);
    if (!anchor) return false;
    const actionBar = anchor.host;

    // One Copy per card: retain only the one in the native More containing block.
    let existingBtn = null;
    for (const w of Array.from(videoContainer.querySelectorAll('.image-saver-tt-copy-wrap'))) {
      if (!existingBtn && w.parentElement === actionBar) existingBtn = w;
      else w.remove();
    }
    if (existingBtn) {
      ensureSaveButton(videoContainer, actionBar, existingBtn);
      positionControls(videoContainer, anchor);
      return false;
    }

    if (typeof document === 'undefined') return false;

    const wrap = document.createElement('div');
    wrap.className = 'image-saver-tt-copy-wrap';
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');
    isLabel(wrap, 'title', 'inline.copyVideo', 'MediaLatch: Скопировать ссылку на видео');
    isLabel(wrap, 'aria-label', 'inline.copyVideoAria', 'Copy video link');

    const btn = document.createElement('div');
    btn.className = 'image-saver-tt-copy-btn';
    btn.innerHTML = SVG_LINK_ICON;
    wrap.appendChild(btn);

    wrap.addEventListener('click', async (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      if (e && typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

      const owningCard = resolveOwningTikTokCard(wrap) ||
                         resolveOwningTikTokCard(videoContainer) ||
                         videoContainer;

      const author = extractAuthorFromCard(owningCard);
      const { id: videoId, source: idSource } = extractVideoIdDetailsFromCard(owningCard);

      // Record diagnostic attributes on wrap for inspection in DevTools Elements tab
      wrap.setAttribute('data-diagnostic-card-found', owningCard ? 'true' : 'false');
      wrap.setAttribute('data-diagnostic-author', author ? 'true' : 'false');
      wrap.setAttribute('data-diagnostic-video-id', videoId ? 'true' : 'false');
      wrap.setAttribute('data-diagnostic-id-source', idSource);

      const rawUrl = extractTikTokUrl(owningCard);
      const shareUrl = rawUrl ? formatTikTokShareUrl(rawUrl, ttShare.get()) : null;

      if (!shareUrl) {
        wrap.setAttribute('data-diagnostic-clipboard', 'skipped');
        wrap.setAttribute('data-diagnostic-result', 'unavailable'); DBG.log('tiktok.copy', 'link', 'failed', 'NO_SHARE_URL');
        wrap.classList.remove('is-success');
        wrap.classList.remove('is-clipboard-error');
        wrap.classList.remove('is-error');
        wrap.classList.add('is-unavailable');
        wrap.classList.add('is-error');
        btn.innerHTML = SVG_UNAVAILABLE_ICON;
        isLabel(wrap, 'title', 'inline.videoUnavailable', 'MediaLatch: Ссылка на видео недоступна');

        if (typeof console !== 'undefined' && typeof console.debug === 'function') {
          console.debug('[MediaLatch TikTok] Video URL unavailable on card:', {
            cardTag: owningCard?.tagName?.toLowerCase(),
            cardId: owningCard?.id || null,
            authorFound: Boolean(author),
            videoIdFound: Boolean(videoId),
            idSource
          });
        }

        setTimeout(() => {
          wrap.classList.remove('is-unavailable');
          wrap.classList.remove('is-error');
          btn.innerHTML = SVG_LINK_ICON;
          isLabel(wrap, 'title', 'inline.copyVideo', 'MediaLatch: Скопировать ссылку на видео');
        }, 2000);
        return;
      }

      const copied = await copyTextToClipboard(shareUrl);
      DBG.log('tiktok.copy', 'link', copied ? 'ok' : 'failed', copied ? undefined : 'CLIPBOARD_FAILED');
      wrap.setAttribute('data-diagnostic-clipboard', copied ? 'success' : 'failure');

      if (copied) {
        wrap.setAttribute('data-diagnostic-result', 'success');
        wrap.classList.remove('is-unavailable');
        wrap.classList.remove('is-clipboard-error');
        wrap.classList.remove('is-error');
        wrap.classList.add('is-success');
        btn.innerHTML = SVG_CHECK_ICON;
        isLabel(wrap, 'title', 'inline.copied', '✓ Ссылка скопирована!');

        if (typeof console !== 'undefined' && typeof console.debug === 'function') {
          console.debug('[MediaLatch TikTok] Link copied successfully:', {
            shareHost: ttShare.get(),
            idSource
          });
        }

        setTimeout(() => {
          wrap.classList.remove('is-success');
          btn.innerHTML = SVG_LINK_ICON;
          isLabel(wrap, 'title', 'inline.copyVideo', 'MediaLatch: Скопировать ссылку на видео');
        }, 1800);
      } else {
        wrap.setAttribute('data-diagnostic-result', 'clipboard_error');
        wrap.classList.remove('is-success');
        wrap.classList.remove('is-unavailable');
        wrap.classList.add('is-clipboard-error');
        wrap.classList.add('is-error');
        btn.innerHTML = SVG_ERROR_ICON;
        isLabel(wrap, 'title', 'inline.clipboardFailed', 'MediaLatch: Не удалось скопировать в буфер обмена');

        if (typeof console !== 'undefined' && typeof console.debug === 'function') {
          console.debug('[MediaLatch TikTok] Clipboard write failed for URL:', {
            shareHost: ttShare.get()
          });
        }

        setTimeout(() => {
          wrap.classList.remove('is-clipboard-error');
          wrap.classList.remove('is-error');
          btn.innerHTML = SVG_LINK_ICON;
          isLabel(wrap, 'title', 'inline.copyVideo', 'MediaLatch: Скопировать ссылку на видео');
        }, 2000);
      }
    });

    wrap.addEventListener('keydown', (e) => {
      if (e && (e.key === 'Enter' || e.key === ' ')) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        wrap.click();
      }
    });

    actionBar.appendChild(wrap);
    ensureSaveButton(videoContainer, actionBar, wrap);
    positionControls(videoContainer, anchor);

    return true;
  }


  function scanAndInjectTikTokCopyButtons(root = (typeof document !== 'undefined' ? document : null)) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    ensureTtButtonStyles();

    if (!placementActive) return 0;
    for (const area of root.querySelectorAll('.image-saver-tt-hover-area')) area.classList.remove('image-saver-tt-hover-area');
    let count = 0;
    for (const own of Array.from(root.querySelectorAll('.image-saver-tt-copy-wrap, .image-saver-tt-save-wrap'))) {
      const card = resolveOwningTikTokCard(own), anchor = anchorOf(card);
      if (inPortal(own) || !anchor || own.parentElement !== anchor.host) own.remove();
    }

    // 1. Scan recognized video card containers across home feed, browse/detail, and profile pages
    const containerSelectors = [
      'article[data-e2e="recommend-list-item-container"]',
      'article[id^="one-column-item-"]',
      'article',
      '[data-e2e="recommend-list-item-container"]',
      '[data-e2e="feed-item"]',
      '[data-e2e="user-post-item"]',
      '[data-e2e="browse-video"]',
      '[data-e2e="video-detail-container"]',
      '[data-e2e="video-detail"]',
      '[data-e2e="video-player-container"]',
      'div[class*="VideoDetailContainer"]',
      'div[class*="DivVideoDetailContainer"]',
      'div[class*="DivVideoContainer"]',
      'div[class*="DivVideoWrapper"]',
      'div[class*="VideoPlayerContainer"]'
    ];

    const items = root.querySelectorAll(containerSelectors.join(', '));
    items.forEach(item => {
      if (injectCopyButtonToTikTokVideo(item)) {
        count++;
      }
    });

    if (placementResize) {
      const wanted = new Set();
      for (const own of root.querySelectorAll('.image-saver-tt-copy-wrap')) {
        const anchor = anchorOf(resolveOwningTikTokCard(own));
        if (anchor) { wanted.add(anchor.more); wanted.add(anchor.host); }
      }
      for (const el of observedAnchors) if (!wanted.has(el)) placementResize.unobserve(el);
      for (const el of wanted) if (!observedAnchors.has(el)) placementResize.observe(el);
      observedAnchors = wanted;
    }

    return count;
  }

  const requestThrottledScan = globalThis.MediaLatchCopyKit.scheduler((root) => scanAndInjectTikTokCopyButtons(root && typeof root.querySelectorAll === 'function' ? root : document));

  let placementResize = null, placementObserver = null, observedAnchors = new Set(), placementActive = true;
  function initTikTokCopyButtonObserver() {
    if (typeof document === 'undefined') return null;
    // Reinjection releases the previous watchers; removing only native More must also remove our controls.
    globalThis.__mediaLatchTikTokPlacementCleanup?.();
    placementActive = true;
    if (typeof ResizeObserver !== 'undefined') placementResize = new ResizeObserver(() => requestThrottledScan());
    ensureTtButtonStyles();
    scanAndInjectTikTokCopyButtons(document);
    if (typeof MutationObserver !== 'undefined') {
      placementObserver = new MutationObserver(records => {
        if (records.some(r => r.addedNodes.length || r.removedNodes.length)) requestThrottledScan();
      });
      placementObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
    window.addEventListener('resize', requestThrottledScan);
    globalThis.__mediaLatchTikTokPlacementCleanup = () => {
      placementActive = false;
      placementObserver?.disconnect(); placementResize?.disconnect();
      observedAnchors.clear(); window.removeEventListener('resize', requestThrottledScan);
    };
    return placementObserver;
  }

  globalThis.MediaLatchCopyKit.navigation(requestThrottledScan);

  globalThis.MediaLatchCopyKit.whenReady(initTikTokCopyButtonObserver);

  // Export functions to global scope for unit testing in Node/vm if applicable
  if (typeof globalThis !== 'undefined') {
    globalThis.__formatTikTokShareUrl = formatTikTokShareUrl;
    globalThis.__extractTikTokUrl = extractTikTokUrl;
    globalThis.__injectCopyButtonToTikTokVideo = injectCopyButtonToTikTokVideo;
    globalThis.__scanAndInjectTikTokCopyButtons = scanAndInjectTikTokCopyButtons;
    globalThis.__initTikTokCopyButtonObserver = initTikTokCopyButtonObserver;
    globalThis.__ensureTtButtonStyles = ensureTtButtonStyles;
    globalThis.__setCachedTtShareHost = (h) => ttShare.set(h);
    globalThis.__getCachedTtShareHost = () => ttShare.get();
    globalThis.__isValidTikTokVideoId = isValidTikTokVideoId;
    globalThis.__isValidTikTokUsername = isValidTikTokUsername;
    globalThis.__copyTextToClipboard = copyTextToClipboard;
    globalThis.__resolveOwningTikTokCard = resolveOwningTikTokCard;
    globalThis.__extractVideoIdDetailsFromCard = extractVideoIdDetailsFromCard;
    globalThis.__ALLOWED_TT_SHARE_HOSTS = ALLOWED_TT_SHARE_HOSTS;
    globalThis.__DEFAULT_TT_SHARE_HOST = DEFAULT_TT_SHARE_HOST;
  }
})();
