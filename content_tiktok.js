/**
 * content_tiktok.js - TikTok DOM video-link copying and embed-friendly sharing.
 * Injects a lightweight copy button into TikTok video action bars.
 * Strictly resolves canonical @user/video/id URLs and copies using the user's selected host.
 */

(function () {
  // DEBUG-MENU-01: the shared journal client (lib/debug_journal.js); a no-op when it is absent. Outcomes only: never the copied link.
  const DBG = (globalThis.ImageSaverDebug && globalThis.ImageSaverDebug.client('content')) || { log() {} };
  DBG.log('tiktok', 'init', 'info');
  'use strict';
  const isI18n = globalThis.ImageSaverI18n;
  const isLabels = isI18n && typeof chrome !== 'undefined' ? isI18n.follow(chrome, typeof navigator !== 'undefined' ? navigator : null, () => {}) : null;
  const isLabel = (element, field, key, fallback, vars) => {
    if (isLabels) isLabels.label(element, field, key, vars, fallback);
    else if (field === 'textContent') element.textContent = fallback;
    else if (fallback === null) element.removeAttribute(field);
    else element.setAttribute(field, fallback);
  };

  const TT_BUTTON_STYLES = `
.image-saver-tt-copy-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  cursor: pointer;
  user-select: none;
  outline: none;
  background-color: rgba(255, 255, 255, 0.08);
  transition: background-color 0.2s, color 0.2s, transform 0.15s;
  box-sizing: border-box;
  margin: 6px auto;
  color: inherit;
  z-index: 10;
  position: relative;
}
.image-saver-tt-copy-wrap:hover {
  background-color: rgba(255, 255, 255, 0.18);
}
@media (prefers-color-scheme: light) {
  .image-saver-tt-copy-wrap {
    background-color: rgba(0, 0, 0, 0.05);
  }
  .image-saver-tt-copy-wrap:hover {
    background-color: rgba(0, 0, 0, 0.1);
  }
}
.image-saver-tt-copy-wrap:active {
  transform: scale(0.92);
}
.image-saver-tt-copy-wrap.is-success {
  color: #22c55e !important;
}
.image-saver-tt-copy-wrap.is-error,
.image-saver-tt-copy-wrap.is-clipboard-error {
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
.image-saver-tt-copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  pointer-events: none;
}
.image-saver-tt-icon {
  width: 20px;
  height: 20px;
  display: block;
  pointer-events: none;
  flex-shrink: 0;
}
`;

  const SVG_LINK_ICON = `<svg class="image-saver-tt-icon" viewBox="3 3 18 18" width="20" height="20" fill="currentColor">
    <path d="M15.89 5.64a5 5 0 0 0-7.07 0L6.33 8.13a1 1 0 0 0 1.41 1.41l2.49-2.49a3 3 0 0 1 4.24 4.24l-3.53 3.53a3 3 0 0 1-4.24 0 1 1 0 0 0-1.42 1.42 5 5 0 0 0 7.07 0l3.54-3.53a5 5 0 0 0 0-7.07zm-7.78 12.72a5 5 0 0 0 7.07 0l2.49-2.49a1 1 0 0 0-1.41-1.41l-2.49 2.49a3 3 0 0 1-4.24-4.24l3.53-3.53a3 3 0 0 1 4.24 0 1 1 0 0 0 1.42-1.42 5 5 0 0 0-7.07 0l-3.54 3.53a5 5 0 0 0 0 7.07z"/>
  </svg>`;

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
  const DEFAULT_TT_SHARE_HOST = 'tiktok.com';
  let cachedTtShareHost = DEFAULT_TT_SHARE_HOST;

  // Initialize and synchronize cachedTtShareHost from storage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    try {
      chrome.storage.local.get({ ttShareHost: DEFAULT_TT_SHARE_HOST }, (res) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        if (res && ALLOWED_TT_SHARE_HOSTS.includes(res.ttShareHost)) {
          cachedTtShareHost = res.ttShareHost;
        } else {
          cachedTtShareHost = DEFAULT_TT_SHARE_HOST;
        }
      });
    } catch (_) {}
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes && changes.ttShareHost) {
          const nextHost = changes.ttShareHost.newValue;
          if (ALLOWED_TT_SHARE_HOSTS.includes(nextHost)) {
            cachedTtShareHost = nextHost;
          }
        }
      });
    } catch (_) {}
  }

  /**
   * Constructs an embed-friendly or canonical share URL for a TikTok video.
   * Only allowed hosts: 'tiktok.com', 'tnktok.com', 'd.tnktok.com'.
   * Input must be HTTPS tiktok.com URL with valid /@user/video/id path.
   * Suffixes, query string, and hash are omitted.
   */
  function formatTikTokShareUrl(rawUrl, targetHost = cachedTtShareHost) {
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

  /**
   * Injects a separate visible video URL copy button into a TikTok video action bar.
   * Modeled on the X post-link copy button. Does NOT replace, intercept, or repurpose
   * TikTok's native Share button.
   * Places the button immediately BEFORE the author-avatar action item in the section action rail.
   * Prevents duplicate injection via DOM check, and allows re-injection if the action bar was replaced.
   */
  function injectCopyButtonToTikTokVideo(videoContainer, knownShareBtn = null) {
    if (!videoContainer || typeof videoContainer.querySelector !== 'function') return false;

    // Locate action bar / action rail container
    let actionBar = videoContainer.querySelector('section[class*="SectionActionBarContainer"], section[class*="ActionBar"], section');
    if (!actionBar) {
      actionBar = videoContainer.querySelector('[data-e2e="browse-action-item"]')?.parentElement ||
                  videoContainer.querySelector('[data-e2e="feed-action-item"]')?.parentElement ||
                  videoContainer.querySelector('[data-e2e*="action-item"]')?.parentElement ||
                  videoContainer.querySelector('div[class*="ActionItemContainer"]') ||
                  videoContainer.querySelector('div[class*="ActionBar"]') ||
                  videoContainer.querySelector('div[class*="DivContentContainer"]') ||
                  videoContainer.querySelector('div[class*="RightContainer"]');
    }

    // If no separate rail found, fallback to container itself
    if (!actionBar) {
      actionBar = videoContainer;
    }

    // Duplicate check: verify if button is already connected inside this action bar or container
    const existingBtn = actionBar.querySelector('.image-saver-tt-copy-wrap') ||
                        videoContainer.querySelector('.image-saver-tt-copy-wrap');
    if (existingBtn && existingBtn.isConnected !== false) {
      return false;
    }

    // Locate author avatar action item to insert immediately BEFORE it
    let insertBeforeTarget = null;
    const avatarCandidates = Array.from(actionBar.querySelectorAll('a[data-e2e="video-author-avatar"], div[class*="AvatarActionItem"], div[class*="DivAvatar"], a[href^="/@"]'));
    const avatarLink = avatarCandidates.find(el => {
      const href = (el.getAttribute && el.getAttribute('href')) || el.href || '';
      return !href.includes('/video/');
    });
    if (avatarLink) {
      let cur = avatarLink;
      while (cur && cur.parentElement && cur.parentElement !== actionBar) {
        cur = cur.parentElement;
      }
      if (cur && (cur.parentElement === actionBar || cur.parentNode === actionBar)) {
        insertBeforeTarget = cur;
      }
    }

    // If no avatar item found in actionBar, check for native Share control or fallback to firstChild / nextSibling
    if (!insertBeforeTarget) {
      const shareBtn = (knownShareBtn && (knownShareBtn.parentElement === actionBar || knownShareBtn.parentNode === actionBar) ? knownShareBtn : null) ||
                       actionBar.querySelector('[data-e2e="share-icon"], [data-e2e="browse-share"], [data-e2e="feed-share"], [data-e2e*="share"], [aria-label*="Share" i], [aria-label*="Поделиться" i]') ||
                       videoContainer.querySelector('[data-e2e="share-icon"], [data-e2e="browse-share"], [data-e2e="feed-share"], [data-e2e*="share"], [aria-label*="Share" i], [aria-label*="Поделиться" i]');
      if (shareBtn) {
        let cur = shareBtn.closest ? (shareBtn.closest('[data-e2e="browse-action-item"], [data-e2e="feed-action-item"]') || shareBtn) : shareBtn;
        while (cur && cur.parentElement && cur.parentElement !== actionBar) {
          cur = cur.parentElement;
        }
        if (cur && (cur.parentElement === actionBar || cur.parentNode === actionBar)) {
          if (cur.nextSibling) {
            insertBeforeTarget = cur.nextSibling;
          }
        }
      }
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
      const shareUrl = rawUrl ? formatTikTokShareUrl(rawUrl, cachedTtShareHost) : null;

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
            shareHost: cachedTtShareHost,
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
            shareHost: cachedTtShareHost
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

    // Insert immediately BEFORE author avatar item if present, otherwise append to action rail
    if (insertBeforeTarget && typeof actionBar.insertBefore === 'function') {
      actionBar.insertBefore(wrap, insertBeforeTarget);
    } else {
      actionBar.appendChild(wrap);
    }

    if (videoContainer.dataset) {
      videoContainer.dataset.imageSaverBtn = 'true';
    }
    if (typeof videoContainer.setAttribute === 'function') {
      videoContainer.setAttribute('data-image-saver-btn', 'true');
    }
    if (actionBar.dataset) {
      actionBar.dataset.imageSaverBtn = 'true';
    }
    if (typeof actionBar.setAttribute === 'function') {
      actionBar.setAttribute('data-image-saver-btn', 'true');
    }

    return true;
  }

  let isScanPending = false;

  function scanAndInjectTikTokCopyButtons(root = (typeof document !== 'undefined' ? document : null)) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    ensureTtButtonStyles();

    let count = 0;
    const processedContainers = new Set();

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
      processedContainers.add(item);
      if (injectCopyButtonToTikTokVideo(item)) {
        count++;
      }
    });

    // 2. Scan by SectionActionBarContainer in case article attributes differ
    const actionBars = root.querySelectorAll('section[class*="SectionActionBarContainer"], section[class*="ActionBar"]');
    actionBars.forEach(bar => {
      const container = bar.closest ? (bar.closest('article, [data-e2e*="container"], [data-e2e*="item"]') || bar.parentElement) : bar.parentElement;
      if (container && !processedContainers.has(container)) {
        processedContainers.add(container);
        if (injectCopyButtonToTikTokVideo(container)) {
          count++;
        }
      }
    });

    // 3. Scan by native Share controls ([data-e2e="share-icon"], etc.) for other layouts
    const shareElements = root.querySelectorAll('[data-e2e="browse-share"], [data-e2e="feed-share"], [data-e2e="share-icon"], [data-e2e="video-share"], [data-e2e*="share"], [aria-label*="Share" i], [aria-label*="Поделиться" i]');
    shareElements.forEach(shareEl => {
      const container = shareEl.closest ? (shareEl.closest('article, [data-e2e="feed-item"], [data-e2e="browse-video"], [data-e2e="video-detail-container"], div[class*="Container"], main, section') || shareEl.parentElement) : shareEl.parentElement;
      if (container && !processedContainers.has(container)) {
        processedContainers.add(container);
        if (injectCopyButtonToTikTokVideo(container, shareEl)) {
          count++;
        }
      }
    });

    return count;
  }

  function requestThrottledScan() {
    if (isScanPending) return;
    isScanPending = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        isScanPending = false;
        scanAndInjectTikTokCopyButtons();
      });
    } else {
      setTimeout(() => {
        isScanPending = false;
        scanAndInjectTikTokCopyButtons();
      }, 50);
    }
  }

  let ttCopyObserver = null;

  function initTikTokCopyButtonObserver() {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return null;

    ensureTtButtonStyles();
    scanAndInjectTikTokCopyButtons();

    if (ttCopyObserver) {
      try { ttCopyObserver.disconnect(); } catch (_) {}
    }

    ttCopyObserver = new MutationObserver((mutations) => {
      let hasAdded = false;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length > 0) {
          hasAdded = true;
          break;
        }
      }
      if (hasAdded) {
        requestThrottledScan();
      }
    });

    const target = document.body || document.documentElement;
    if (target) {
      ttCopyObserver.observe(target, { childList: true, subtree: true });
    }

    return ttCopyObserver;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', () => requestThrottledScan());
    if (typeof history !== 'undefined') {
      if (typeof history.pushState === 'function') {
        const origPush = history.pushState;
        history.pushState = function (...args) {
          const res = origPush.apply(this, args);
          requestThrottledScan();
          return res;
        };
      }
      if (typeof history.replaceState === 'function') {
        const origReplace = history.replaceState;
        history.replaceState = function (...args) {
          const res = origReplace.apply(this, args);
          requestThrottledScan();
          return res;
        };
      }
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        initTikTokCopyButtonObserver();
      }, { once: true });
    } else {
      initTikTokCopyButtonObserver();
    }
  }

  // Export functions to global scope for unit testing in Node/vm if applicable
  if (typeof globalThis !== 'undefined') {
    globalThis.__formatTikTokShareUrl = formatTikTokShareUrl;
    globalThis.__extractTikTokUrl = extractTikTokUrl;
    globalThis.__injectCopyButtonToTikTokVideo = injectCopyButtonToTikTokVideo;
    globalThis.__scanAndInjectTikTokCopyButtons = scanAndInjectTikTokCopyButtons;
    globalThis.__initTikTokCopyButtonObserver = initTikTokCopyButtonObserver;
    globalThis.__ensureTtButtonStyles = ensureTtButtonStyles;
    globalThis.__setCachedTtShareHost = (h) => { cachedTtShareHost = h; };
    globalThis.__getCachedTtShareHost = () => cachedTtShareHost;
    globalThis.__isValidTikTokVideoId = isValidTikTokVideoId;
    globalThis.__isValidTikTokUsername = isValidTikTokUsername;
    globalThis.__copyTextToClipboard = copyTextToClipboard;
    globalThis.__resolveOwningTikTokCard = resolveOwningTikTokCard;
    globalThis.__extractVideoIdDetailsFromCard = extractVideoIdDetailsFromCard;
    globalThis.__ALLOWED_TT_SHARE_HOSTS = ALLOWED_TT_SHARE_HOSTS;
    globalThis.__DEFAULT_TT_SHARE_HOST = DEFAULT_TT_SHARE_HOST;
  }
})();
