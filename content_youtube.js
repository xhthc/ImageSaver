/**
 * content_youtube.js - YouTube Shorts link copying with embed-friendly preview options.
 * Injects an unobtrusive copy button into the active YouTube Short's action controls.
 * Strictly resolves canonical Shorts video IDs and constructs target share links locally.
 */

(function () {
  'use strict';

  const YT_BUTTON_STYLES = `
.image-saver-yt-copy-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  cursor: pointer;
  user-select: none;
  outline: none;
  background-color: rgba(255, 255, 255, 0.1);
  color: #fff;
  transition: background-color 0.2s, color 0.2s, transform 0.15s;
  box-sizing: border-box;
  margin: 8px auto;
  position: relative;
  z-index: 10;
  flex-shrink: 0;
}
.image-saver-yt-copy-wrap:hover {
  background-color: rgba(255, 255, 255, 0.2);
}
.image-saver-yt-copy-wrap:focus-visible {
  outline: 2px solid #3ea6ff;
  outline-offset: 2px;
}
.image-saver-yt-copy-wrap:active {
  transform: scale(0.92);
}
@media (prefers-color-scheme: light) {
  html:not([dark]) .image-saver-yt-copy-wrap {
    background-color: rgba(0, 0, 0, 0.05);
    color: #0f0f0f;
  }
  html:not([dark]) .image-saver-yt-copy-wrap:hover {
    background-color: rgba(0, 0, 0, 0.1);
  }
}
.image-saver-yt-copy-wrap.is-success {
  color: #2ba640 !important;
  background-color: rgba(43, 166, 64, 0.18) !important;
}
.image-saver-yt-copy-wrap.is-error {
  color: #ff4e45 !important;
  background-color: rgba(255, 78, 69, 0.18) !important;
  animation: imageSaverYtShake 0.3s ease-in-out;
}
@keyframes imageSaverYtShake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}
.image-saver-yt-copy-wrap svg {
  width: 24px;
  height: 24px;
  fill: currentColor;
  pointer-events: none;
}
`;

  const SVG_LINK_ICON = `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>`;
  const SVG_CHECK_ICON = `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>`;

  const ALLOWED_YT_SHARE_HOSTS = ['youtube.com', 'yfxtube.com', 'koutube.com'];
  const DEFAULT_YT_SHARE_HOST = 'youtube.com';

  const APPROVED_YT_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be'
  ]);

  let cachedYtShareHost = DEFAULT_YT_SHARE_HOST;

  // Initialize cached host from chrome.storage.local
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    try {
      chrome.storage.local.get({ youtubeShareHost: DEFAULT_YT_SHARE_HOST }, (items) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        if (items && ALLOWED_YT_SHARE_HOSTS.includes(items.youtubeShareHost)) {
          cachedYtShareHost = items.youtubeShareHost;
        }
      });
    } catch (_) {}

    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes && changes.youtubeShareHost) {
          const nextHost = changes.youtubeShareHost.newValue;
          if (ALLOWED_YT_SHARE_HOSTS.includes(nextHost)) {
            cachedYtShareHost = nextHost;
          } else {
            cachedYtShareHost = DEFAULT_YT_SHARE_HOST;
          }
        }
      });
    } catch (_) {}
  }

  /**
   * Validates YouTube video ID syntax: exactly 11 characters from [a-zA-Z0-9_-].
   */
  function isValidYouTubeVideoId(id) {
    if (!id || typeof id !== 'string') return false;
    const trimmed = id.trim();
    return /^[a-zA-Z0-9_-]{11}$/.test(trimmed);
  }

  /**
   * Parses a YouTube Shorts URL and extracts the validated 11-char video ID.
   * Only accepts approved YouTube hosts and strict /shorts/{id} paths.
   * Rejects lookalike hosts, ordinary watch URLs, and invalid IDs.
   */
  function parseYouTubeShortsUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    try {
      const parsed = new URL(urlStr, 'https://www.youtube.com');
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

      const hostname = parsed.hostname.toLowerCase();
      if (!APPROVED_YT_HOSTS.has(hostname)) return null;

      const match = parsed.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})(?:\/|$|\?|#)/i);
      if (match && isValidYouTubeVideoId(match[1])) {
        return match[1];
      }
    } catch (_) {}
    return null;
  }

  /**
   * Constructs a canonical or embed-friendly share URL for a YouTube Short.
   * Only allowed hosts: 'youtube.com', 'yfxtube.com', 'koutube.com'.
   * Query strings and tracking parameters are omitted.
   */
  function formatYouTubeShareUrl(videoId, targetHost = cachedYtShareHost) {
    if (!isValidYouTubeVideoId(videoId)) return null;
    const host = ALLOWED_YT_SHARE_HOSTS.includes(targetHost) ? targetHost : DEFAULT_YT_SHARE_HOST;
    return `https://${host}/shorts/${videoId}`;
  }

  /**
   * Injects CSS styles once into document head or body.
   */
  function ensureYtButtonStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('image-saver-yt-styles')) return;
    try {
      const styleEl = document.createElement('style');
      styleEl.id = 'image-saver-yt-styles';
      styleEl.textContent = YT_BUTTON_STYLES;
      (document.head || document.documentElement || document.body)?.appendChild(styleEl);
    } catch (_) {}
  }

  /**
   * Checks whether an element or renderer is currently the active Short in view.
   */
  function isActiveShortRenderer(container) {
    if (!container) return false;
    if (container.getAttribute && container.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    if (typeof container.hasAttribute === 'function' && (container.hasAttribute('is-active') || container.hasAttribute('active'))) {
      return true;
    }
    if (container.getAttribute && container.getAttribute('aria-hidden') === 'false') {
      return true;
    }
    const cls = container.className || '';
    if (typeof cls === 'string' && /(?:^|\s)(?:active|is-active)(?:\s|$)/.test(cls)) {
      return true;
    }
    if (container.id === 'shorts-container' || (container.tagName && /^(ytd-shorts|ytd-reel-player-overlay-renderer)$/i.test(container.tagName))) {
      return true;
    }
    // Single reel on page is unconditionally active
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      const allReels = document.querySelectorAll('ytd-reel-video-renderer');
      if (allReels.length === 1 && allReels[0] === container) {
        return true;
      }
    }
    // Check if contains an actively playing HTML5 video
    if (container.querySelectorAll) {
      const videos = container.querySelectorAll('video');
      for (const v of videos) {
        if (v && v.paused === false && !v.ended) return true;
        if (v && typeof v.currentTime === 'number' && v.currentTime > 0 && v.paused === false) return true;
      }
    }
    return false;
  }

  /**
   * Extracts the owning Short's video ID from a Short container element.
   * Inspects inner anchors and attributes first.
   * For active Short containers, reconciles DOM evidence with active page URL:
   * if DOM ID and active page URL conflict, returns null (fail closed).
   * For inactive neighboring containers, never borrows or compares with page URL.
   * If ambiguous or conflicting IDs are found inside DOM, returns null (fail closed).
   */
  function extractShortVideoId(container, pageUrl = (typeof window !== 'undefined' ? window.location?.href : null)) {
    if (!container) return null;

    const foundIds = new Set();

    // 1. Search inside container for explicit shorts links
    if (typeof container.querySelectorAll === 'function') {
      const links = container.querySelectorAll('a[href*="/shorts/"]');
      for (const a of links) {
        const href = a.getAttribute ? (a.getAttribute('href') || a.href) : a.href;
        const parsedId = parseYouTubeShortsUrl(href);
        if (parsedId) {
          foundIds.add(parsedId);
        }
      }

      // Check data attributes
      const idAttrs = ['data-video-id', 'data-context-item-id', 'video-id'];
      for (const attr of idAttrs) {
        if (typeof container.getAttribute === 'function') {
          const val = container.getAttribute(attr);
          if (isValidYouTubeVideoId(val)) foundIds.add(val);
        }
        const elsWithAttr = container.querySelectorAll(`[${attr}]`);
        for (const el of elsWithAttr) {
          const val = el.getAttribute ? el.getAttribute(attr) : null;
          if (isValidYouTubeVideoId(val)) foundIds.add(val);
        }
      }
    }

    // If multiple distinct IDs found inside the same container, ownership is ambiguous
    if (foundIds.size > 1) {
      return null;
    }

    const domId = foundIds.size === 1 ? Array.from(foundIds)[0] : null;

    // Check active status of container
    const isActive = isActiveShortRenderer(container);

    if (isActive) {
      const pageId = pageUrl ? parseYouTubeShortsUrl(pageUrl) : null;
      if (pageId) {
        if (domId) {
          // Both active page URL and DOM link present: fail closed if they conflict (SPA transition race)
          if (domId !== pageId) {
            return null;
          }
          return domId;
        }
        // Active container with no inner DOM link yet: use active page ID
        return pageId;
      }
      return domId;
    }

    // Inactive container: NEVER borrow pageUrl or compare against active page URL.
    return domId;
  }

  /**
   * Locates the action buttons rail/cluster within a YouTube Short container.
   */
  function findShortActionsContainer(renderer) {
    if (!renderer || typeof renderer.querySelector !== 'function') return null;

    // 1. Modern Lit / Web Component view-model action bar (YouTube 2024-2026)
    const actionBar = renderer.querySelector('reel-action-bar-view-model, .reel-action-bar-view-model');
    if (actionBar) return actionBar;

    // 2. Standard / historical desktop Shorts action rail
    const actions = renderer.querySelector('#actions, ytd-reel-player-overlay-renderer #actions');
    if (actions) return actions;

    // 3. Fallback: container of like button or like view-model
    const likeBtn = renderer.querySelector('like-button-view-model, #like-button, ytd-like-button-renderer, button[aria-label*="like" i], button[aria-label*="нравится" i]');
    if (likeBtn) {
      const container = (typeof likeBtn.closest === 'function' ? likeBtn.closest('reel-action-bar-view-model, #actions') : null) || likeBtn.parentElement;
      if (container) return container;
    }

    // 4. Fallback: container of share button or share view-model
    const shareBtn = renderer.querySelector('share-button-view-model, #share-button, ytd-share-target-renderer, button[aria-label*="share" i], button[aria-label*="поделиться" i]');
    if (shareBtn) {
      const container = (typeof shareBtn.closest === 'function' ? shareBtn.closest('reel-action-bar-view-model, #actions') : null) || shareBtn.parentElement;
      if (container) return container;
    }

    return null;
  }

  /**
   * Injects a separate visible Short URL copy button into a YouTube Short renderer.
   * Does NOT replace, intercept, or modify any native action controls.
   * Binds click handler dynamically to re-resolve ownership at click time.
   */
  function injectCopyButtonToYouTubeShort(renderer) {
    if (!renderer || typeof renderer.querySelector !== 'function') return false;

    const actionContainer = findShortActionsContainer(renderer);
    if (!actionContainer) return false;

    // Duplicate check
    const existing = actionContainer.querySelector('.image-saver-yt-copy-wrap');
    if (existing && existing.isConnected !== false) {
      return false;
    }

    if (typeof document === 'undefined') return false;

    ensureYtButtonStyles();

    const wrap = document.createElement('div');
    wrap.className = 'image-saver-yt-copy-wrap';
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('title', 'Image Saver: Скопировать ссылку на Short');
    wrap.setAttribute('aria-label', 'Copy Short link');

    const btn = document.createElement('div');
    btn.className = 'image-saver-yt-copy-btn';
    btn.innerHTML = SVG_LINK_ICON;
    wrap.appendChild(btn);

    // Dynamic click handler: re-resolves container and video ID at click time
    wrap.addEventListener('click', async (e) => {
      if (e) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        else if (typeof e.stopPropagation === 'function') e.stopPropagation();
      }

      // Reject detached button
      if (wrap.isConnected === false) {
        wrap.setAttribute('data-diagnostic-fail-branch', 'detached_button');
        wrap.setAttribute('data-diagnostic-clipboard', 'failure');
        wrap.classList.add('is-error');
        return;
      }

      // Re-resolve enclosing renderer dynamically (handles recycled, reparented, and standalone nodes)
      let liveRenderer = null;
      if (typeof wrap.closest === 'function') {
        liveRenderer = wrap.closest('ytd-reel-video-renderer') ||
                       wrap.closest('ytd-shorts, #shorts-container, ytd-reel-player-overlay-renderer, reel-action-bar-view-model');
      }

      if (!liveRenderer && renderer && renderer.isConnected !== false) {
        if (typeof renderer.contains === 'function' && renderer.contains(wrap)) {
          liveRenderer = renderer;
        }
      }

      if (!liveRenderer || liveRenderer.isConnected === false) {
        wrap.setAttribute('data-diagnostic-fail-branch', 'no_owner');
        wrap.setAttribute('data-diagnostic-clipboard', 'failure');
        wrap.classList.add('is-error');
        return;
      }

      const pageHref = (typeof window !== 'undefined' && window.location) ? window.location.href : null;
      const videoId = extractShortVideoId(liveRenderer, pageHref);
      const shareUrl = videoId ? formatYouTubeShareUrl(videoId, cachedYtShareHost) : null;

      wrap.setAttribute('data-diagnostic-click', String(Date.now()));
      wrap.setAttribute('data-diagnostic-video-id', videoId || 'null');
      wrap.setAttribute('data-diagnostic-share-url', shareUrl ? 'resolved' : 'null');

      if (!shareUrl) {
        wrap.setAttribute('data-diagnostic-fail-branch', 'no_share_url');
        wrap.setAttribute('data-diagnostic-clipboard', 'failure');
        wrap.classList.add('is-error');
        wrap.setAttribute('title', 'Image Saver: Не удалось определить ссылку на Short');

        setTimeout(() => {
          wrap.classList.remove('is-error');
          wrap.setAttribute('title', 'Image Saver: Скопировать ссылку на Short');
        }, 2000);
        return;
      }

      let copied = false;
      let usedMethod = 'none';
      const nav = (typeof window !== 'undefined' && window.navigator) ? window.navigator : (typeof navigator !== 'undefined' ? navigator : null);

      try {
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          await nav.clipboard.writeText(shareUrl);
          copied = true;
          usedMethod = 'writeText';
        }
      } catch (_) {}

      if (!copied && typeof document !== 'undefined') {
        try {
          const ta = document.createElement('textarea');
          ta.value = shareUrl;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          ta.style.pointerEvents = 'none';

          const copyShield = (ce) => {
            if (ce && ce.clipboardData && typeof ce.clipboardData.setData === 'function') {
              ce.clipboardData.setData('text/plain', shareUrl);
              if (typeof ce.preventDefault === 'function') ce.preventDefault();
            }
            if (ce && typeof ce.stopImmediatePropagation === 'function') {
              ce.stopImmediatePropagation();
            } else if (ce && typeof ce.stopPropagation === 'function') {
              ce.stopPropagation();
            }
          };

          if (typeof ta.addEventListener === 'function') {
            ta.addEventListener('copy', copyShield, { capture: true });
          }

          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          copied = document.execCommand('copy');

          if (typeof ta.removeEventListener === 'function') {
            ta.removeEventListener('copy', copyShield, { capture: true });
          }
          document.body.removeChild(ta);
          if (copied) {
            usedMethod = 'execCommand_shielded';
          }
        } catch (_) {}
      }

      wrap.setAttribute('data-diagnostic-fail-branch', copied ? 'none' : 'clipboard_failed');
      wrap.setAttribute('data-diagnostic-clipboard', copied ? 'success' : 'failure');
      wrap.setAttribute('data-diagnostic-method', usedMethod);

      if (copied) {
        wrap.classList.add('is-success');
        btn.innerHTML = SVG_CHECK_ICON;
        wrap.setAttribute('title', '✓ Ссылка скопирована!');
        setTimeout(() => {
          wrap.classList.remove('is-success');
          btn.innerHTML = SVG_LINK_ICON;
          wrap.setAttribute('title', 'Image Saver: Скопировать ссылку на Short');
        }, 1800);
      } else {
        wrap.classList.add('is-error');
        setTimeout(() => wrap.classList.remove('is-error'), 1800);
      }
    }, { capture: true });

    // Shield pointerdown and mousedown from parent gestures (swipe, reel drag)
    const stopPointerGesture = (pe) => {
      if (pe && typeof pe.stopPropagation === 'function') pe.stopPropagation();
    };
    if (typeof wrap.addEventListener === 'function') {
      wrap.addEventListener('pointerdown', stopPointerGesture, { capture: true });
      wrap.addEventListener('mousedown', stopPointerGesture, { capture: true });
    }

    // Keyboard activation
    wrap.addEventListener('keydown', (e) => {
      if (e && (e.key === 'Enter' || e.key === ' ')) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        wrap.click();
      }
    });

    // Placement: right after share button or like button, or append to actionContainer
    let referenceChild = null;
    const shareBtn = actionContainer.querySelector('share-button-view-model, #share-button, ytd-share-target-renderer, [aria-label*="share" i], [aria-label*="поделиться" i], [title*="share" i], [title*="поделиться" i]');
    if (shareBtn) {
      let targetChild = shareBtn;
      while (targetChild && targetChild.parentElement !== actionContainer) {
        targetChild = targetChild.parentElement;
      }
      if (targetChild && targetChild.parentElement === actionContainer) {
        referenceChild = targetChild.nextSibling || null;
      }
    }

    if (referenceChild && typeof actionContainer.insertBefore === 'function') {
      actionContainer.insertBefore(wrap, referenceChild);
    } else {
      actionContainer.appendChild(wrap);
    }

    if (renderer.dataset) {
      renderer.dataset.imageSaverYtBtn = 'true';
    }
    if (typeof renderer.setAttribute === 'function') {
      renderer.setAttribute('data-image-saver-yt-btn', 'true');
    }

    return true;
  }

  let isScanPending = false;
  let pendingScanRoot = null;

  function scanAndInjectYouTubeCopyButtons(root = undefined) {
    const targetRoot = root || (typeof document !== 'undefined' ? document : null);
    if (!targetRoot || typeof targetRoot.querySelectorAll !== 'function') return 0;
    ensureYtButtonStyles();

    let count = 0;

    // Check if targetRoot itself is a reel renderer
    if (typeof targetRoot.matches === 'function' && targetRoot.matches('ytd-reel-video-renderer')) {
      if (injectCopyButtonToYouTubeShort(targetRoot)) {
        count++;
      }
    }

    // Find all reel renderers in descendants
    const renderers = targetRoot.querySelectorAll('ytd-reel-video-renderer');
    for (const r of renderers) {
      if (injectCopyButtonToYouTubeShort(r)) {
        count++;
      }
    }

    // Also support standalone / player containers that do not enclose or belong to a reel renderer
    const standaloneRoots = [];
    if (typeof targetRoot.matches === 'function' && targetRoot.matches('ytd-shorts, #shorts-container, ytd-reel-player-overlay-renderer, reel-action-bar-view-model')) {
      standaloneRoots.push(targetRoot);
    }
    const playerContainers = targetRoot.querySelectorAll('ytd-shorts, #shorts-container, ytd-reel-player-overlay-renderer, reel-action-bar-view-model');
    for (const pc of playerContainers) {
      standaloneRoots.push(pc);
    }

    for (const pc of standaloneRoots) {
      if (typeof pc.closest === 'function' && pc.closest('ytd-reel-video-renderer')) {
        continue;
      }
      if (typeof pc.querySelector === 'function' && pc.querySelector('ytd-reel-video-renderer')) {
        continue;
      }
      if (injectCopyButtonToYouTubeShort(pc)) {
        count++;
      }
    }

    return count;
  }

  function requestThrottledScan(targetRoot = null) {
    if (isScanPending) {
      if (!targetRoot || pendingScanRoot !== targetRoot) {
        pendingScanRoot = null;
      }
      return;
    }
    isScanPending = true;
    pendingScanRoot = targetRoot || null;

    const executeScan = () => {
      isScanPending = false;
      const rootToScan = pendingScanRoot || (typeof document !== 'undefined' ? document : null);
      pendingScanRoot = null;
      scanAndInjectYouTubeCopyButtons(rootToScan);
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(executeScan);
    } else {
      setTimeout(executeScan, 50);
    }
  }

  let ytCopyObserver = null;

  function initYouTubeCopyButtonObserver() {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return null;

    ensureYtButtonStyles();
    scanAndInjectYouTubeCopyButtons();

    if (ytCopyObserver) {
      try { ytCopyObserver.disconnect(); } catch (_) {}
    }

    ytCopyObserver = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
        if (m.removedNodes && m.removedNodes.length > 0) {
          for (const n of m.removedNodes) {
            if (n.classList && (n.classList.contains('image-saver-yt-copy-wrap') || (n.querySelector && n.querySelector('.image-saver-yt-copy-wrap')))) {
              shouldScan = true;
              break;
            }
          }
          if (shouldScan) break;
        }
      }
      if (shouldScan) {
        requestThrottledScan();
      }
    });

    const target = document.body || document.documentElement;
    if (target) {
      ytCopyObserver.observe(target, { childList: true, subtree: true });
    }

    return ytCopyObserver;
  }

  // Register window and document listeners for SPA navigation and feed scroll
  if (typeof window !== 'undefined') {
    window.addEventListener('scroll', () => requestThrottledScan(), { capture: true, passive: true });
    window.addEventListener('resize', () => requestThrottledScan(), { passive: true });
    window.addEventListener('popstate', () => requestThrottledScan());
    window.addEventListener('yt-navigate-finish', () => requestThrottledScan());
    window.addEventListener('yt-page-data-updated', () => requestThrottledScan());

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
    document.addEventListener('scroll', () => requestThrottledScan(), { capture: true, passive: true });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        initYouTubeCopyButtonObserver();
      }, { once: true });
    } else {
      initYouTubeCopyButtonObserver();
    }
  }

  // Export functions to globalThis for unit tests in Node/vm
  if (typeof globalThis !== 'undefined') {
    globalThis.__isValidYouTubeVideoId = isValidYouTubeVideoId;
    globalThis.__parseYouTubeShortsUrl = parseYouTubeShortsUrl;
    globalThis.__formatYouTubeShareUrl = formatYouTubeShareUrl;
    globalThis.__extractShortVideoId = extractShortVideoId;
    globalThis.__findShortActionsContainer = findShortActionsContainer;
    globalThis.__injectCopyButtonToYouTubeShort = injectCopyButtonToYouTubeShort;
    globalThis.__scanAndInjectYouTubeCopyButtons = scanAndInjectYouTubeCopyButtons;
    globalThis.__initYouTubeCopyButtonObserver = initYouTubeCopyButtonObserver;
    globalThis.__ensureYtButtonStyles = ensureYtButtonStyles;
    globalThis.__requestThrottledScan = requestThrottledScan;
    globalThis.__setCachedYtShareHost = (h) => { cachedYtShareHost = h; };
    globalThis.__getCachedYtShareHost = () => cachedYtShareHost;
    globalThis.__ALLOWED_YT_SHARE_HOSTS = ALLOWED_YT_SHARE_HOSTS;
    globalThis.__DEFAULT_YT_SHARE_HOST = DEFAULT_YT_SHARE_HOST;
    globalThis.__APPROVED_YT_HOSTS = APPROVED_YT_HOSTS;
  }
})();
