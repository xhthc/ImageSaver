/**
 * content/content_instagram.js - Instagram DOM post-link copying and embed-friendly sharing.
 * Injects a lightweight copy button into Instagram posts/Reels action bars.
 * Strictly resolves canonical post / Reel URLs and copies using the user's selected host.
 */

(function () {
  // DEBUG-MENU-01: the shared journal client (lib/debug_journal.js); a no-op when it is absent. Outcomes only: never the copied link.
  const DBG = (globalThis.ImageSaverDebug && globalThis.ImageSaverDebug.client('content')) || { log() {} };
  DBG.log('instagram', 'init', 'info');
  'use strict';
  const isLabel = globalThis.MediaLatchCopyKit.labeler();

  const IG_BUTTON_STYLES = `
.image-saver-ig-copy-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  outline: none;
  border-radius: 50%;
  transition: background-color 0.2s, color 0.2s, transform 0.15s;
  box-sizing: border-box;
  color: inherit;
  z-index: 10;
  position: relative;
}

/* Vertical Reel action rail: centered with matching hit area and spacing directly above Like */
.image-saver-ig-copy-wrap.is-reel-rail {
  width: 44px;
  height: 44px;
  margin: 6px auto;
  align-self: center;
}

/* Horizontal standard post action row: placed immediately before Like */
.image-saver-ig-copy-wrap.is-standard-row {
  width: 40px;
  height: 40px;
  margin: 0 4px 0 0;
  padding: 8px;
}

.image-saver-ig-copy-wrap:hover {
  background-color: rgba(255, 255, 255, 0.15);
}
@media (prefers-color-scheme: light) {
  .image-saver-ig-copy-wrap:hover {
    background-color: rgba(0, 0, 0, 0.08);
  }
}
.image-saver-ig-copy-wrap:active {
  transform: scale(0.92);
}
.image-saver-ig-copy-wrap.is-success {
  color: #22c55e !important;
}
.image-saver-ig-copy-wrap.is-error {
  color: #ef4444 !important;
  animation: imageSaverIgShake 0.3s ease-in-out;
}
@keyframes imageSaverIgShake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-3px); }
  75% { transform: translateX(3px); }
}
.image-saver-ig-copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  pointer-events: none;
}
.image-saver-ig-icon {
  width: 22px;
  height: 22px;
  display: block;
  pointer-events: none;
  flex-shrink: 0;
}
`;

  const SVG_LINK_ICON = `<svg class="image-saver-ig-icon" viewBox="3 3 18 18" width="20" height="20" fill="currentColor">
    <path d="M15.89 5.64a5 5 0 0 0-7.07 0L6.33 8.13a1 1 0 0 0 1.41 1.41l2.49-2.49a3 3 0 0 1 4.24 4.24l-3.53 3.53a3 3 0 0 1-4.24 0 1 1 0 0 0-1.42 1.42 5 5 0 0 0 7.07 0l3.54-3.53a5 5 0 0 0 0-7.07zm-7.78 12.72a5 5 0 0 0 7.07 0l2.49-2.49a1 1 0 0 0-1.41-1.41l-2.49 2.49a3 3 0 0 1-4.24-4.24l3.53-3.53a3 3 0 0 1 4.24 0 1 1 0 0 0 1.42-1.42 5 5 0 0 0-7.07 0l-3.54 3.53a5 5 0 0 0 0 7.07z"/>
  </svg>`;

  const SVG_CHECK_ICON = `<svg class="image-saver-ig-icon" viewBox="2 2 20 20" width="20" height="20" fill="currentColor">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
  </svg>`;

  const ALLOWED_IG_SHARE_HOSTS = ['instagram.com', 'oginstagram.com', 'kirkstagram.com', 'kkclip.com'];
  const DEFAULT_IG_SHARE_HOST = 'oginstagram.com';
  const igShare = globalThis.MediaLatchCopyKit.shareHost('igShareHost', ALLOWED_IG_SHARE_HOSTS, DEFAULT_IG_SHARE_HOST);

  const RESERVED_IG_ROUTES = new Set([
    'audio', 'videos', 'tagged', 'explore', 'feed', 'reels', 'reel',
    'p', 'tv', 'stories', 'share', 'direct', 'channel', 'guide',
    'live', 'profile', 'accounts', 'developer', 'about', 'legal',
    'help', 'privacy', 'settings', 'all', 'embed', 'graphql'
  ]);

  function isValidInstagramShortcode(code) {
    if (!code || typeof code !== 'string') return false;
    const trimmed = code.trim();
    if (!/^[a-zA-Z0-9_-]{5,35}$/.test(trimmed)) return false;
    if (/^\d+$/.test(trimmed)) return false; // purely numeric IDs are media PKs or audio IDs
    if (RESERVED_IG_ROUTES.has(trimmed.toLowerCase())) return false;
    return true;
  }

  function parseShortcodeFromPath(pathOrUrl) {
    if (!pathOrUrl || typeof pathOrUrl !== 'string') return null;
    if (/\/reels?\/audio(?:\/|$|\?|#)/i.test(pathOrUrl)) return null;

    let path = pathOrUrl;
    try {
      if (/^https?:\/\//i.test(pathOrUrl)) {
        path = new URL(pathOrUrl).pathname;
      }
    } catch (_) {}

    const match = path.match(/\/(?:p|reel|reels)\/([a-zA-Z0-9_-]+)(?:\/|$|\?|#)/i);
    if (!match) return null;

    const candidate = match[1];
    if (!isValidInstagramShortcode(candidate)) return null;

    const isReel = /\/reels?(?:\/|$|\?|#)/i.test(match[0]);
    return { prefix: isReel ? 'reel' : 'p', shortcode: candidate };
  }

  /**
   * Constructs an embed-friendly or canonical share URL for an Instagram post or Reel.
   * Only allowed hosts: 'instagram.com', 'oginstagram.com', 'kirkstagram.com', 'kkclip.com'.
   * Input must be HTTPS instagram.com URL with valid /p/ or /reel/ shortcode.
   * Suffixes, query string, and hash are omitted. Rejects non-post routes such as /reel/audio/.
   */
  function formatInstagramShareUrl(rawUrl, targetHost = igShare.get()) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;

    const host = ALLOWED_IG_SHARE_HOSTS.includes(targetHost) ? targetHost : DEFAULT_IG_SHARE_HOST;

    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:') return null;

      const hostname = parsed.hostname.toLowerCase();
      if (hostname !== 'instagram.com' && hostname !== 'www.instagram.com') {
        return null;
      }

      if (/\/reels?\/audio(?:\/|$|\?|#)/i.test(parsed.pathname)) {
        return null;
      }

      const info = parseShortcodeFromPath(parsed.pathname);
      if (!info) return null;

      return `https://${host}/${info.prefix}/${info.shortcode}/`;
    } catch (_) {
      return null;
    }
  }

  function ensureIgButtonStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('image-saver-ig-styles')) return;
    try {
      const styleEl = document.createElement('style');
      styleEl.id = 'image-saver-ig-styles';
      styleEl.textContent = IG_BUTTON_STYLES;
      (document.head || document.documentElement || document.body)?.appendChild(styleEl);
    } catch (_) {}
  }

  function logRejection(reason, details = null) {
    DBG.log('instagram.copy', 'resolve', 'refused', String(reason).toUpperCase(), null, { lvl: 'debug' });
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      try {
        const payload = { reason, ...(details || {}) };
        console.warn(`[MediaLatch Instagram] URL resolution rejected: ${reason}`, payload);
      } catch (_) {}
    }
  }

  /**
   * Checks whether the element contains an actively playing or non-zero playback HTML5 video.
   * On Instagram Reels feeds, only the active Reel card in the viewport plays video.
   */
  function hasActivePlayingVideo(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return false;
    const videos = root.querySelectorAll('video');
    for (const v of videos) {
      if (v) {
        if (v.paused === false && !v.ended) {
          return true;
        }
        if (typeof v.currentTime === 'number' && v.currentTime > 0 && v.paused === false) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Checks whether an element is currently visible and positioned around the vertical center of the viewport.
   * In full-screen / snapping Reels feeds, the active Reel card spans the viewport center,
   * whereas scrolled past or preloaded neighboring cards lie strictly above or below the center.
   */
  function isActiveCardInViewport(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    try {
      const rect = el.getBoundingClientRect();
      if (!rect || rect.height <= 0 || rect.width <= 0) return false;
      const vHeight = (typeof window !== 'undefined' && typeof window.innerHeight === 'number' && window.innerHeight > 0)
        ? window.innerHeight
        : ((typeof document !== 'undefined' && document.documentElement?.clientHeight > 0) ? document.documentElement.clientHeight : 0);
      if (vHeight <= 0) return false;
      const vCenter = vHeight / 2;
      return rect.top <= vCenter && rect.bottom >= vCenter;
    } catch (_) {
      return false;
    }
  }

  function elementContains(parent, child) {
    if (!parent || !child) return false;
    if (typeof parent.contains === 'function') {
      try { return parent.contains(child); } catch (_) {}
    }
    let cur = child;
    while (cur) {
      if (cur === parent) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isLikeLabel(str) {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim().toLowerCase();
    if (!s || /^\d+$/.test(s)) return false; // ignore pure like count numbers

    // Ignore liker lists and view likes buttons
    if (/(?:liked by|view likes|see who liked|посмотреть.*нравится|отметки\s+[«"']?мне нравится)/i.test(s)) {
      return false;
    }

    // Russian: "Мне нравится", "Нравится", "Отметка «Мне нравится»", "Поставить отметку «Нравится»", "Лайк", "Не нравится"
    if (/(?:нравится|лайк)/i.test(s)) return true;

    // English: "Like", "Unlike", "Liked"
    if (/(?:^|\s|[«"'])(?:like|unlike|liked)(?:$|\s|[!.,»"'])/i.test(s)) return true;

    // French: "J'aime", "J’aime", "Je n'aime plus"
    if (/j['’]aime/i.test(s)) return true;

    // Spanish: "Me gusta", "Ya no me gusta"
    if (/me gusta/i.test(s)) return true;

    // German: "Gefällt mir", "Gefällt mir nicht mehr"
    if (/gefällt mir/i.test(s)) return true;

    // Portuguese: "Curtir", "Descurtir"
    if (/curtir/i.test(s)) return true;

    // Italian: "Mi piace", "Non mi piace più"
    if (/mi piace/i.test(s)) return true;

    // Turkish: "Beğen", "Beğenmekten Vazgeç"
    if (/beğen/i.test(s)) return true;

    // Japanese/Chinese/Korean
    if (/(?:좋아요|いいね|讚|赞)/i.test(s)) return true;

    return false;
  }

  function isLikeControl(el) {
    if (!el) return false;
    if (el.tagName === 'A' || (el.closest && el.closest('a'))) return false;

    // Check aria-label and title on element
    const aria = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
    if (isLikeLabel(aria)) return true;

    // Check child title or SVG
    if (el.querySelector) {
      const titleEl = el.querySelector('title');
      if (titleEl && isLikeLabel(titleEl.textContent)) return true;
      const svg = el.querySelector('svg');
      if (svg) {
        const svgAria = (svg.getAttribute && (svg.getAttribute('aria-label') || svg.getAttribute('title'))) || '';
        if (isLikeLabel(svgAria)) return true;
        const svgTitle = svg.querySelector && svg.querySelector('title');
        if (svgTitle && isLikeLabel(svgTitle.textContent)) return true;
      }
    }
    return false;
  }

  function isOtherRailActionControl(el) {
    if (!el) return false;
    if (el.tagName === 'A' || (el.closest && el.closest('a'))) return false;

    const getStr = (elem) => {
      if (!elem) return '';
      const a = (elem.getAttribute && (elem.getAttribute('aria-label') || elem.getAttribute('title'))) || '';
      const t = elem.querySelector && elem.querySelector('title') ? elem.querySelector('title').textContent : '';
      return `${a} ${t}`.trim().toLowerCase();
    };

    const s = getStr(el) + (el.querySelector ? ' ' + getStr(el.querySelector('svg')) : '');
    if (!s) return false;

    return /(?:comment|комментир|поделиться|share|repost|репост|remix|ремикс|bookmark|сохранить|save|guardar|enregistrer|speichern|salva|kaydet)/i.test(s);
  }

  /**
   * Determines whether an element is located inside sections that must never receive
   * the post copy button, such as the author profile header, comments list, or comment input form.
   */
  function isInsideExcludedPostSection(el) {
    if (!el || typeof el.closest !== 'function') return false;
    return Boolean(
      el.closest('header, [role="banner"], form, ul[class*="comment"], div[class*="comment-list"], div[class*="comments-list"]')
    );
  }

  function isActionRail(el) {
    if (!el) return false;
    if (el === document.body || el.tagName === 'HTML' || el.tagName === 'MAIN' || (el.getAttribute && (el.getAttribute('role') === 'main' || el.getAttribute('role') === 'feed'))) {
      return false;
    }
    if (el.tagName === 'ARTICLE' || (el.getAttribute && (el.getAttribute('role') === 'dialog' || el.getAttribute('data-reel') === 'true'))) {
      return false;
    }
    if (el.classList && el.classList.contains('image-saver-ig-copy-wrap')) return false;
    // An action rail never encloses a video
    if (el.querySelector && el.querySelector('video')) return false;

    // Never consider author profile header or comment sections an action rail
    if (el.tagName === 'HEADER' || isInsideExcludedPostSection(el)) {
      return false;
    }

    const cls = el.className || '';
    if (typeof cls === 'string' && /(?:slide|card|post|reel)/i.test(cls)) return false;

    if (typeof cls === 'string' && /(?:action[-_]?(?:bar|rail|container|row|list)|actions)/i.test(cls)) return true;
    if (el.getAttribute && (el.getAttribute('role') === 'group' || el.getAttribute('role') === 'toolbar')) return true;
    if (el.style && (el.style.flexDirection === 'column' || el.style.flexDirection === 'column-reverse')) {
      return true;
    }
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const cs = window.getComputedStyle(el);
        if (cs && (cs.flexDirection === 'column' || cs.flexDirection === 'column-reverse')) {
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  function childHasAction(child) {
    if (!child) return false;
    if (child.classList && child.classList.contains('image-saver-ig-copy-wrap')) return false;
    if (child.tagName === 'BUTTON' || (child.getAttribute && child.getAttribute('role') === 'button')) return true;
    if (child.querySelector && child.querySelector('button, div[role="button"], svg')) return true;
    return false;
  }

  /**
   * Counts distinct Like controls under a root element, treating nested button elements as a single control.
   */
  function countDistinctLikeControls(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    const candidates = Array.from(root.querySelectorAll('button, div[role="button"], span[role="button"]'));
    const distinctLikes = [];
    for (const b of candidates) {
      if (isInsideExcludedPostSection(b)) continue;
      if (isLikeControl(b)) {
        const isNested = distinctLikes.some(existing => elementContains(existing, b) || elementContains(b, existing));
        if (!isNested) {
          distinctLikes.push(b);
        }
      }
    }
    return distinctLikes.length;
  }

  /**
   * Determines whether an element encompasses multiple distinct Instagram posts or Reels.
   * Prevents multi-reel wrappers/feeds from being treated as a single post.
   */
  function containsMultiplePostsOrReels(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return false;

    // 1. Multiple copy buttons
    const wraps = el.querySelectorAll('.image-saver-ig-copy-wrap');
    if (wraps.length > 1) return true;

    // 2. Multiple distinct Like controls
    if (countDistinctLikeControls(el) > 1) return true;

    // 3. Multiple articles
    const articles = el.querySelectorAll('article');
    if (articles.length > 1) return true;

    // 4. Multiple distinct post/Reel permalink shortcodes
    const permalinks = el.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]');
    if (permalinks.length > 1) {
      const distinctCodes = new Set();
      for (const a of permalinks) {
        const href = (a.getAttribute && a.getAttribute('href')) || a.href || '';
        const info = parseShortcodeFromPath(href);
        if (info && info.shortcode) {
          distinctCodes.add(info.shortcode.toLowerCase());
          if (distinctCodes.size > 1) return true;
        }
      }
    }

    return false;
  }

  /**
   * Resolves the enclosing post, dialog, or Reel card element for a node.
   * Walks up parents stopping before main/body/html or containers that enclose multiple items/rails.
   */
  function findEnclosingPostOrReel(node) {
    if (!node) return null;

    if (node === document.body || node.tagName === 'HTML' || node.tagName === 'MAIN' || (node.getAttribute && node.getAttribute('role') === 'main')) {
      return null;
    }

    if (containsMultiplePostsOrReels(node)) {
      return null;
    }

    // Step up past wrap button, action rail, or interactive items to reach the enclosing card level
    let cur = node;
    while (cur && cur.parentElement && (
      cur.classList?.contains('image-saver-ig-copy-wrap') ||
      isActionRail(cur) ||
      /(?:action[-_]?(?:bar|rail|container|row|list)|actions)/i.test(cur.className || '') ||
      cur.tagName === 'BUTTON' ||
      cur.getAttribute?.('role') === 'button' ||
      cur.getAttribute?.('role') === 'group'
    )) {
      const parent = cur.parentElement;
      if (parent === document.body || parent.tagName === 'HTML' || parent.tagName === 'MAIN' || (parent.getAttribute && parent.getAttribute('role') === 'main') || containsMultiplePostsOrReels(parent)) {
        break;
      }
      cur = parent;
    }

    if (cur.closest) {
      const known = cur.closest('article, div[role="dialog"], div[data-pressable-container="true"], div[class*="Reel"], div[class*="reel"]');
      if (known && !/(?:action[-_]?(?:bar|rail|container|row|list)|actions)/i.test(known.className || '') && !isActionRail(known)) {
        // If known container encloses multiple reels or is main/body/html, do not select it
        if (!containsMultiplePostsOrReels(known) && known !== document.body && known.tagName !== 'HTML' && known.tagName !== 'MAIN' && (!known.getAttribute || known.getAttribute('role') !== 'main')) {
          return known;
        }
      }
    }

    let candidate = cur;
    while (cur && cur.parentElement) {
      const parent = cur.parentElement;
      if (parent === document.body || parent.tagName === 'HTML' || parent.tagName === 'MAIN' || (parent.getAttribute && parent.getAttribute('role') === 'main')) {
        break;
      }
      if (containsMultiplePostsOrReels(parent)) {
        // Stop before entering a container that encloses multiple items
        break;
      }
      if (parent.tagName === 'ARTICLE' || (parent.getAttribute && parent.getAttribute('role') === 'dialog')) {
        return parent;
      }
      candidate = parent;
      cur = parent;
    }

    if (candidate === document.body || candidate.tagName === 'HTML' || candidate.tagName === 'MAIN' || (candidate.getAttribute && candidate.getAttribute('role') === 'main') || containsMultiplePostsOrReels(candidate)) {
      return null;
    }

    if (isActionRail(candidate)) {
      return null;
    }

    return candidate;
  }

  /**
   * Proves whether a given container or item has explicit DOM evidence matching the given shortcode.
   * Checks direct anchor links, data attributes, id attributes, or inner elements.
   */
  function hasExplicitShortcodeEvidence(root, shortcode) {
    if (!root || !shortcode || typeof shortcode !== 'string') return false;
    const target = shortcode.toLowerCase();

    // Only a genuine post permalink proves ownership; audio navigation query
    // parameters can contain the shortcode of a different Reel.
    if (root.tagName === 'A' || root.href) {
      const href = (root.getAttribute && root.getAttribute('href')) || root.href || '';
      const info = parseShortcodeFromPath(href);
      if (info && info.shortcode.toLowerCase() === target) return true;
    }
    if (root.querySelectorAll) {
      const anchors = root.querySelectorAll('a');
      for (const a of anchors) {
        const href = (a.getAttribute && a.getAttribute('href')) || a.href || '';
        const info = parseShortcodeFromPath(href);
        if (info && info.shortcode.toLowerCase() === target) return true;
      }
    }

    // Reject substring matches against stale or unrelated IDs.
    const hasExactAttribute = (el) => ['data-shortcode', 'data-id', 'data-media-id', 'id'].some(name => {
      const value = (el.getAttribute && el.getAttribute(name)) || (name === 'id' && typeof el.id === 'string' ? el.id : '') || '';
      return value.toLowerCase() === target ||
        parseShortcodeFromPath(value)?.shortcode.toLowerCase() === target;
    });
    if (hasExactAttribute(root)) return true;
    if (root.querySelectorAll) {
      const nodes = root.querySelectorAll('[data-shortcode], [data-id], [data-media-id], [id]');
      for (const el of nodes) {
        if (hasExactAttribute(el)) return true;
      }
    }

    return false;
  }

  /**
   * Determines whether the given element is inside a multi-item feed or container,
   * or if the document contains multiple post/Reel items.
   * When true, page URL fallback must never be used without explicit per-item shortcode proof.
   */
  function isMultiItemEnvironment(container, item) {
    // 1. Check document-wide indicators of multiple items
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      const copyButtons = document.querySelectorAll('.image-saver-ig-copy-wrap');
      if (copyButtons.length > 1) return true;

      const articles = document.querySelectorAll('article');
      if (articles.length > 1) return true;

      // Check multiple Like controls in document
      if (countDistinctLikeControls(document) > 1) return true;

      // Check multiple post/Reel permalinks in document
      const docPermalinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]');
      if (docPermalinks.length > 1) {
        const docCodes = new Set();
        for (const a of docPermalinks) {
          const href = (a.getAttribute && a.getAttribute('href')) || a.href || '';
          const info = parseShortcodeFromPath(href);
          if (info && info.shortcode) {
            docCodes.add(info.shortcode.toLowerCase());
            if (docCodes.size > 1) return true;
          }
        }
      }
    }

    // 2. Check enclosing feed role or container
    const node = item || container;
    if (node) {
      if (node.closest) {
        if (node.closest('[role="feed"]') || node.closest('[data-feed]')) {
          return true;
        }
      }

      // 3. Check sibling items in the parent container
      let cur = node;
      while (cur && cur.parentElement && cur.parentElement !== document.body && cur.parentElement.tagName !== 'HTML') {
        const parent = cur.parentElement;
        const siblings = Array.from(parent.children).filter(c => c !== cur);
        const hasItemSibling = siblings.some(s => {
          if (s.tagName === 'ARTICLE') return true;
          if (s.querySelector && (
            s.querySelector('.image-saver-ig-copy-wrap') ||
            s.querySelector('a[href*="/p/"]') ||
            s.querySelector('a[href*="/reel/"]') ||
            s.querySelector('a[href*="/reels/"]')
          )) return true;
          if (findActionRailAndLikeItem(s)) return true;
          if (s.className && /(?:reel|slide|card|post)/i.test(s.className)) return true;
          return false;
        });

        if (hasItemSibling) {
          return true;
        }

        if (parent.tagName === 'MAIN' || (parent.getAttribute && parent.getAttribute('role') === 'main')) {
          break;
        }
        cur = parent;
      }
    }

    return false;
  }

  /**
   * Extracts canonical /p/{shortcode}/ or /reel/{shortcode}/ URL from an Instagram post or Reel container.
   * Strictly isolates per-item ownership. Never falls back to page URL on multi-post feeds
   * or when ownership cannot be proven. Rejects navigation routes such as /reel/audio/.
   */
  function extractInstagramUrl(container, currentWindowUrl = null) {
    if (!container) {
      logRejection('null_container', { container: null });
      return null;
    }

    if (container === document.body || container.tagName === 'HTML' || container.tagName === 'MAIN' || (container.getAttribute && container.getAttribute('role') === 'main')) {
      logRejection('root_container_rejected', { tag: container?.tagName });
      return null;
    }

    const getPermalink = (root) => {
      if (!root || typeof root.querySelectorAll !== 'function') return null;

      if (root === document.body || root.tagName === 'HTML' || root.tagName === 'MAIN' || (root.getAttribute && root.getAttribute('role') === 'main')) {
        return null;
      }

      // If root spans multiple distinct items/rails, fail closed: do not return an arbitrary first anchor
      if (containsMultiplePostsOrReels(root)) {
        return null;
      }

      // 1. Time element link
      const timeEl = root.querySelector ? root.querySelector('time') : null;
      if (timeEl) {
        const timeLink = timeEl.closest ? timeEl.closest('a') : timeEl.parentElement;
        if (timeLink) {
          const href = (timeLink.getAttribute && timeLink.getAttribute('href')) || timeLink.href || '';
          if (/\/reels?\/audio(?:\/|$|\?|#)/i.test(href)) {
            return null;
          }
          const info = parseShortcodeFromPath(href);
          if (info) {
            return `https://www.instagram.com/${info.prefix}/${info.shortcode}/`;
          }
        }
      }

      // 2. Scan anchors with /p/ or /reel/ or /reels/
      const anchors = Array.from(root.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]'));
      for (const a of anchors) {
        if (a.closest && a.closest('ul[class*="comments"], div[role="menu"]')) {
          continue;
        }
        const href = (a.getAttribute && a.getAttribute('href')) || a.href || '';
        if (/\/reels?\/audio(?:\/|$|\?|#)/i.test(href)) {
          continue;
        }
        const info = parseShortcodeFromPath(href);
        if (info) {
          return `https://www.instagram.com/${info.prefix}/${info.shortcode}/`;
        }
      }
      return null;
    };

    // 1. Check container and its enclosing post/Reel item
    const item = findEnclosingPostOrReel(container);
    const directUrl = getPermalink(container) || (item && item !== container ? getPermalink(item) : null);
    if (directUrl) return directUrl;

    // 2. Direct page URL fallback ONLY when ownership is proven or strictly unambiguous
    const pageUrl = currentWindowUrl || (typeof window !== 'undefined' ? window.location?.href : '');
    if (pageUrl) {
      try {
        const parsed = new URL(pageUrl);
        if (/\/reels?\/audio(?:\/|$|\?|#)/i.test(parsed.pathname)) {
          logRejection('audio_route_rejected', { path: parsed.pathname });
          return null;
        }

        const pageInfo = parseShortcodeFromPath(parsed.pathname);
        if (pageInfo) {
          // Ownership Proof 1: Does this container or item contain explicit shortcode evidence?
          if (hasExplicitShortcodeEvidence(container, pageInfo.shortcode) || (item && hasExplicitShortcodeEvidence(item, pageInfo.shortcode))) {
            return `https://www.instagram.com/${pageInfo.prefix}/${pageInfo.shortcode}/`;
          }

          // Ownership Proof 2: Modal dialog displaying a single post/reel
          const isDialog = Boolean(container.closest && container.closest('div[role="dialog"]'));
          if (isDialog) {
            const dialog = container.closest('div[role="dialog"]');
            const dialogWraps = dialog.querySelectorAll ? dialog.querySelectorAll('.image-saver-ig-copy-wrap') : [];
            if (dialogWraps.length <= 1) {
              return `https://www.instagram.com/${pageInfo.prefix}/${pageInfo.shortcode}/`;
            }
          }

          // Ownership Proof 3: Active playing Reel in a scrolling feed (or viewport-centered active card with video)
          const targetCard = item || container;
          const isPlaying = hasActivePlayingVideo(targetCard) || hasActivePlayingVideo(container);
          const isCentered = isActiveCardInViewport(targetCard) || isActiveCardInViewport(container);
          const hasVideo = Boolean((targetCard.querySelector && targetCard.querySelector('video')) || (container.querySelector && container.querySelector('video')));

          if (isPlaying || (isCentered && hasVideo)) {
            return `https://www.instagram.com/${pageInfo.prefix}/${pageInfo.shortcode}/`;
          }

          // A bare action rail without enclosing card or explicit shortcode/video/viewport proof must never fall back to page URL
          if (isActionRail(container) && !item && !hasVideo) {
            logRejection('bare_action_rail_no_card', { tag: container?.tagName });
            return null;
          }

          // In multi-item environments (feeds, lists, sibling cards), NEVER fall back to page URL without proof
          if (isMultiItemEnvironment(container, item)) {
            logRejection('multi_item_environment_unproven', {
              tag: targetCard?.tagName,
              isPlaying,
              isCentered,
              hasVideo,
              currentPath: parsed.pathname
            });
            return null; // Fail closed: clicked rail does not belong to the Reel identified by the current URL
          }

          // Ownership Proof 4: Standalone single item page (verified non-multi-item)
          return `https://www.instagram.com/${pageInfo.prefix}/${pageInfo.shortcode}/`;
        } else {
          logRejection('no_shortcode_in_page_url', { path: parsed.pathname });
        }
      } catch (err) {
        logRejection('page_url_parse_error', { error: String(err) });
      }
    } else {
      logRejection('no_page_url', {});
    }

    logRejection('ownership_unproven_fail_closed', {});
    return null; // Fail closed if ownership cannot be proven
  }

  /**
   * Identifies the Like / heart control and its owning action item within the given post/Reel.
   * Returns { actionRail, likeItem } or null if no proper action rail can be identified.
   */
  function findActionRailAndLikeItem(postEl) {
    if (!postEl || typeof postEl.querySelectorAll !== 'function') return null;

    // Search for Like / heart control button, role="button", or SVG inside postEl
    const candidates = Array.from(postEl.querySelectorAll('button, div[role="button"], span[role="button"], svg'));

    let likeBtn = null;
    for (const el of candidates) {
      if (isInsideExcludedPostSection(el)) continue;
      if (isLikeControl(el)) {
        likeBtn = (el.closest && el.closest('button, div[role="button"], span[role="button"]')) || el;
        break;
      }
    }

    let otherActionBtn = null;
    if (!likeBtn) {
      for (const el of candidates) {
        if (isInsideExcludedPostSection(el)) continue;
        if (isOtherRailActionControl(el)) {
          otherActionBtn = (el.closest && el.closest('button, div[role="button"], span[role="button"]')) || el;
          break;
        }
      }
    }

    const anchorBtn = likeBtn || otherActionBtn;
    if (!anchorBtn) return null;

    // Walk up to find the action rail container (multi-action container with >= 2 action children)
    let cur = anchorBtn;
    let actionRail = null;
    let likeItem = null;

    while (cur && cur !== postEl) {
      const parent = cur.parentElement;
      if (!parent || parent === postEl.parentElement) break;
      if (parent.tagName === 'HEADER' || isInsideExcludedPostSection(parent)) {
        cur = parent;
        continue;
      }

      const childrenWithActions = Array.from(parent.children).filter(c => childHasAction(c));

      const isExplicitRailTagOrClass = parent.tagName === 'SECTION' ||
        parent.getAttribute?.('role') === 'group' ||
        Boolean(parent.className && /(?:action[-_]?(?:bar|rail|container|row|list)|actions)/i.test(parent.className));

      if (childrenWithActions.length >= 2 || (isExplicitRailTagOrClass && childrenWithActions.length >= 1)) {
        actionRail = parent;
        break;
      }

      cur = parent;
    }

    if (!actionRail) {
      if (anchorBtn.parentElement && anchorBtn.parentElement !== postEl && !isInsideExcludedPostSection(anchorBtn.parentElement)) {
        actionRail = anchorBtn.parentElement;
      } else {
        return null;
      }
    }

    if (likeBtn && elementContains(actionRail, likeBtn)) {
      likeItem = Array.from(actionRail.children).find(c => c === likeBtn || elementContains(c, likeBtn));
    } else {
      likeItem = Array.from(actionRail.children).find(c => childHasAction(c));
    }

    if (!actionRail || !likeItem || likeItem.parentElement !== actionRail || isInsideExcludedPostSection(actionRail)) {
      return null;
    }

    return { actionRail, likeItem };
  }

  /**
   * Determines whether the given action rail is oriented vertically (Reels feed rail)
   * or horizontally (standard post action row and post/Reel detail dialogs).
   * Strictly inspects the action rail's own layout properties, computed styles, and geometry;
   * never infers layout from the page URL, post shortcode, or media type.
   */
  function isVerticalActionRail(actionRail) {
    if (!actionRail) return false;

    // 1. Resolve computed style when available (preferred for rendered layout)
    let computed = null;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        computed = window.getComputedStyle(actionRail);
      } catch (_) {}
    }

    const inlineDisplay = actionRail.style?.display ||
      (typeof actionRail.style?.getPropertyValue === 'function' ? actionRail.style.getPropertyValue('display') : '');
    const inlineFlexDir = actionRail.style?.flexDirection ||
      (typeof actionRail.style?.getPropertyValue === 'function' ? actionRail.style.getPropertyValue('flex-direction') : '');

    const computedDisplay = computed?.display ||
      (typeof computed?.getPropertyValue === 'function' ? computed.getPropertyValue('display') : '');
    const computedFlexDir = computed?.flexDirection ||
      (typeof computed?.getPropertyValue === 'function' ? computed.getPropertyValue('flex-direction') : '');

    // Determine effective display: resolved computed styles take precedence over inline declarations
    const effectiveDisplay = (computed && computedDisplay) ? computedDisplay : inlineDisplay;
    const isFlexContainer = effectiveDisplay === 'flex' || effectiveDisplay === 'inline-flex';

    if (computed) {
      // In rendered/DOM environments with getComputedStyle:
      // Trust flexDirection ONLY when effective display is flex or inline-flex.
      // (Non-flex block/grid/etc. elements have default computed flexDirection: 'row' in CSS,
      // and ineffective inline flexDirection declarations must NOT override rendered layout)
      if (isFlexContainer) {
        const flexDir = computedFlexDir || inlineFlexDir;
        if (flexDir === 'column' || flexDir === 'column-reverse') {
          return true;
        }
        if (flexDir === 'row' || flexDir === 'row-reverse') {
          return false;
        }
      }
      // For non-flex containers with computed styles, continue through orientation and geometry checks!
    } else {
      // In unmeasured/mock environments without getComputedStyle:
      // If inline display is explicitly non-flex (e.g. block, grid, inline, none), do not trust inline flexDirection
      const isExplicitlyNonFlex = inlineDisplay && !isFlexContainer;
      if (!isExplicitlyNonFlex && inlineFlexDir) {
        if (inlineFlexDir === 'column' || inlineFlexDir === 'column-reverse') {
          return true;
        }
        if (inlineFlexDir === 'row' || inlineFlexDir === 'row-reverse') {
          return false;
        }
      }
    }

    // 2. Explicit orientation attribute or rail-specific class
    const ariaOrient = actionRail.getAttribute?.('aria-orientation');
    if (ariaOrient === 'vertical') return true;
    if (ariaOrient === 'horizontal') return false;

    const classStr = typeof actionRail.className === 'string' ? actionRail.className : '';
    if (/\b(?:column|vertical)\b/i.test(classStr)) return true;
    if (/\b(?:row|horizontal)\b/i.test(classStr)) return false;

    // 3. Geometry and bounding rect checks in rendered environments
    try {
      if (typeof actionRail.getBoundingClientRect === 'function') {
        const railRect = actionRail.getBoundingClientRect();
        if (railRect && (railRect.width > 0 || railRect.height > 0)) {
          if (railRect.height >= railRect.width * 1.2) {
            return true;
          }
          if (railRect.width >= railRect.height * 1.2) {
            return false;
          }
        }
      }

      // Check relative positions of child action items
      const childItems = Array.from(actionRail.children || [])
        .filter(c => c && !c.classList?.contains?.('image-saver-ig-copy-wrap'));
      if (childItems.length >= 2 && typeof childItems[0].getBoundingClientRect === 'function' && typeof childItems[1].getBoundingClientRect === 'function') {
        const r0 = childItems[0].getBoundingClientRect();
        const r1 = childItems[1].getBoundingClientRect();
        if (r0 && r1 && (r0.width > 0 || r0.height > 0 || r0.top !== 0 || r0.left !== 0)) {
          const dy = Math.abs(r1.top - r0.top);
          const dx = Math.abs(r1.left - r0.left);
          if (dy >= dx * 1.2 && dy > 8) {
            return true;
          }
          if (dx >= dy * 1.2 && dx > 8) {
            return false;
          }
        }
      }
    } catch (_) {}

    // 4. Fallback for unmeasured test mock environments:
    // Only class names specifically representing vertical action rails (like ReelActionRail)
    if (/ReelActionRail/i.test(classStr)) {
      return true;
    }

    // Standard posts, detail dialogs, cards default to horizontal action rows
    return false;
  }

  /**
   * Refreshes the layout styling class of an existing connected copy button
   * when its enclosing action rail changes orientation (e.g. during responsive
   * window resizing, layout mode switching, or dynamic SPA re-rendering).
   * Keeps exactly one of 'is-reel-rail' or 'is-standard-row'.
   * Preserves the button node, event listeners, and DOM position intact.
   * Avoids unnecessary DOM writes if the class is already in the correct state.
   */
  function refreshInstagramButtonLayout(wrap, actionRail = null) {
    if (!wrap || wrap.isConnected === false) return false;
    const rail = actionRail || wrap.parentElement;
    if (!rail) return false;

    const isVert = isVerticalActionRail(rail);
    if (isVert) {
      if (wrap.classList?.contains?.('is-reel-rail') && !wrap.classList?.contains?.('is-standard-row')) {
        return false;
      }
      wrap.classList?.add?.('is-reel-rail');
      wrap.classList?.remove?.('is-standard-row');
      return true;
    } else {
      if (wrap.classList?.contains?.('is-standard-row') && !wrap.classList?.contains?.('is-reel-rail')) {
        return false;
      }
      wrap.classList?.add?.('is-standard-row');
      wrap.classList?.remove?.('is-reel-rail');
      return true;
    }
  }

  /**
   * Injects a separate visible post URL copy button into an Instagram post action rail.
   * Modeled on the X post-link copy button.
   * In Reels: places it directly ABOVE the Like/heart action, centered in the vertical rail.
   * In standard posts: places it immediately BEFORE Like in the horizontal row.
   * Does NOT replace, intercept, or modify any native action controls.
   * If the proper action rail cannot be identified, skips injection entirely.
   */
  function injectCopyButtonToInstagramPost(postEl) {
    if (!postEl || typeof postEl.querySelector !== 'function') return false;

    // Locate the proper action rail and Like action item
    const railInfo = findActionRailAndLikeItem(postEl);
    // User invariant: If the proper action rail cannot be identified, skip injection rather than append to an arbitrary section
    if (!railInfo) {
      return false;
    }

    const { actionRail, likeItem } = railInfo;

    // Duplicate check: verify if button is already connected inside this action rail
    const existingBtn = actionRail.querySelector('.image-saver-ig-copy-wrap');
    if (existingBtn && existingBtn.isConnected !== false) {
      refreshInstagramButtonLayout(existingBtn, actionRail);
      return false;
    }

    if (typeof document === 'undefined') return false;

    const wrap = document.createElement('div');
    wrap.className = 'image-saver-ig-copy-wrap';
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');
    isLabel(wrap, 'title', 'inline.copyPost', 'MediaLatch: Скопировать ссылку на пост');
    isLabel(wrap, 'aria-label', 'inline.copyPostAria', 'Copy post link');

    // Layout detection: vertical Reel rail vs standard horizontal row
    // Determined strictly by the action rail's real layout, never from the page route or media type
    if (isVerticalActionRail(actionRail)) {
      wrap.classList.add('is-reel-rail');
    } else {
      wrap.classList.add('is-standard-row');
    }

    const btn = document.createElement('div');
    btn.className = 'image-saver-ig-copy-btn';
    btn.innerHTML = SVG_LINK_ICON;
    wrap.appendChild(btn);

    wrap.addEventListener('click', async (e) => {
      if (e) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        else if (typeof e.stopPropagation === 'function') e.stopPropagation();
      }

      // Resolve current live rail and owning card dynamically at click time to handle recycled/reused rails
      const liveRail = wrap.parentElement || actionRail;
      let liveCard = findEnclosingPostOrReel(wrap) || (liveRail ? findEnclosingPostOrReel(liveRail) : null);
      if (!liveCard && liveRail) {
        let cur = liveRail.parentElement;
        while (cur && cur !== document.body && cur.tagName !== 'HTML' && cur.tagName !== 'MAIN' && (!cur.getAttribute || cur.getAttribute('role') !== 'main')) {
          if (containsMultiplePostsOrReels(cur)) break;
          if (cur.querySelector && cur.querySelector('video')) {
            liveCard = cur;
            break;
          }
          cur = cur.parentElement;
        }
      }
      if (!liveCard && postEl && postEl !== liveRail && !isActionRail(postEl) && !containsMultiplePostsOrReels(postEl)) {
        liveCard = postEl;
      }

      const rawUrl = (liveCard ? extractInstagramUrl(liveCard) : null) ||
                     (liveRail && liveRail !== liveCard ? extractInstagramUrl(liveRail) : null);
      const shareUrl = rawUrl ? formatInstagramShareUrl(rawUrl, igShare.get()) : null;

      // Temporary DOM-inspectable diagnostics for live debugging without leaking sensitive data
      wrap.setAttribute('data-diagnostic-click', String(Date.now()));
      wrap.setAttribute('data-diagnostic-has-card', String(Boolean(liveCard)));
      wrap.setAttribute('data-diagnostic-has-rail', String(Boolean(liveRail)));
      wrap.setAttribute('data-diagnostic-raw-url', rawUrl ? 'resolved' : 'null');
      wrap.setAttribute('data-diagnostic-share-url', shareUrl ? 'resolved' : 'null');

      if (!shareUrl) {
        wrap.setAttribute('data-diagnostic-fail-branch', 'no_share_url'); DBG.log('instagram.copy', 'link', 'failed', 'NO_SHARE_URL');
        wrap.setAttribute('data-diagnostic-clipboard', 'failure');
        wrap.setAttribute('data-diagnostic-method', 'none');
        wrap.classList.add('is-error');
        isLabel(wrap, 'title', 'inline.postUnknown', 'MediaLatch: Не удалось определить ссылку на пост');

        const rejectionInfo = {
          hasCard: Boolean(liveCard),
          cardTag: liveCard?.tagName?.toLowerCase() || null,
          hasRail: Boolean(liveRail),
          currentPath: (typeof window !== 'undefined' && window.location ? window.location.pathname : null),
          isPlaying: liveCard ? hasActivePlayingVideo(liveCard) : (liveRail ? hasActivePlayingVideo(liveRail) : false),
          isInViewport: liveCard ? isActiveCardInViewport(liveCard) : (liveRail ? isActiveCardInViewport(liveRail) : false),
          isMultiItem: liveCard ? isMultiItemEnvironment(liveCard, liveCard) : false
        };

        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          try {
            console.warn('[MediaLatch Instagram] Failed to resolve post/Reel share URL:', rejectionInfo);
          } catch (_) {}
        }

        setTimeout(() => {
          wrap.classList.remove('is-error');
          isLabel(wrap, 'title', 'inline.copyPost', 'MediaLatch: Скопировать ссылку на пост');
        }, 2000);
        return;
      }

      const { copied, method: usedMethod } = await globalThis.MediaLatchCopyKit.copyText(shareUrl);

      wrap.setAttribute('data-diagnostic-fail-branch', copied ? 'none' : 'clipboard_failed');
      wrap.setAttribute('data-diagnostic-clipboard', copied ? 'success' : 'failure');
      wrap.setAttribute('data-diagnostic-method', usedMethod);
      DBG.log('instagram.copy', 'link', copied ? 'ok' : 'failed', copied ? undefined : 'CLIPBOARD_FAILED', { method: usedMethod });
      try {
        console.debug('[MediaLatch Instagram]', { hasCard: Boolean(liveCard), hasRail: Boolean(liveRail), urlResolved: true, copied, method: usedMethod });
      } catch (_) {}

      if (copied) {
        wrap.classList.add('is-success');
        btn.innerHTML = SVG_CHECK_ICON;
        isLabel(wrap, 'title', 'inline.copied', '✓ Ссылка скопирована!');
        setTimeout(() => {
          wrap.classList.remove('is-success');
          btn.innerHTML = SVG_LINK_ICON;
          isLabel(wrap, 'title', 'inline.copyPost', 'MediaLatch: Скопировать ссылку на пост');
        }, 1800);
      } else {
        wrap.classList.add('is-error');
        setTimeout(() => wrap.classList.remove('is-error'), 1800);
      }
    }, { capture: true });

    // Shield pointerdown and mousedown from ancestor card gesture handlers
    const stopPointerGesture = (pe) => {
      if (pe && typeof pe.stopPropagation === 'function') pe.stopPropagation();
    };
    if (typeof wrap.addEventListener === 'function') {
      wrap.addEventListener('pointerdown', stopPointerGesture, { capture: true });
      wrap.addEventListener('mousedown', stopPointerGesture, { capture: true });
    }

    wrap.addEventListener('keydown', (e) => {
      if (e && (e.key === 'Enter' || e.key === ' ')) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        wrap.click();
      }
    });

    // Insert immediately BEFORE likeItem:
    // In vertical Reel rail: directly ABOVE Like/heart action
    // In horizontal standard row: immediately BEFORE Like
    if (typeof actionRail.insertBefore === 'function') {
      actionRail.insertBefore(wrap, likeItem);
    } else {
      actionRail.appendChild(wrap);
    }

    if (postEl.dataset) {
      postEl.dataset.imageSaverBtn = 'true';
    }
    if (typeof postEl.setAttribute === 'function') {
      postEl.setAttribute('data-image-saver-btn', 'true');
    }
    if (actionRail.dataset) {
      actionRail.dataset.imageSaverBtn = 'true';
    }
    if (typeof actionRail.setAttribute === 'function') {
      actionRail.setAttribute('data-image-saver-btn', 'true');
    }

    return true;
  }


  function scanAndInjectInstagramCopyButtons(root = (typeof document !== 'undefined' ? document : null)) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    ensureIgButtonStyles();

    // 0. Refresh layout classes of existing connected buttons in root (e.g. on responsive resize or SPA layout updates)
    try {
      if (root.classList?.contains?.('image-saver-ig-copy-wrap')) {
        refreshInstagramButtonLayout(root);
      }
      const existingButtons = root.querySelectorAll('.image-saver-ig-copy-wrap');
      for (const btnWrap of existingButtons) {
        if (btnWrap && btnWrap.isConnected !== false) {
          refreshInstagramButtonLayout(btnWrap);
        }
      }
    } catch (_) {}

    let count = 0;
    const processedRails = new Set();

    // 1. Scan standard post and dialog containers
    const containerSelectors = [
      'article',
      'div[role="dialog"]',
      'div[data-pressable-container="true"]'
    ];

    if (root.tagName === 'ARTICLE' || (root.getAttribute && root.getAttribute('role') === 'dialog')) {
      const railInfo = findActionRailAndLikeItem(root);
      if (railInfo && railInfo.actionRail && !processedRails.has(railInfo.actionRail)) {
        processedRails.add(railInfo.actionRail);
        if (injectCopyButtonToInstagramPost(root)) {
          count++;
        }
      }
    }

    const posts = root.querySelectorAll(containerSelectors.join(', '));
    posts.forEach(post => {
      const railInfo = findActionRailAndLikeItem(post);
      if (railInfo && railInfo.actionRail) {
        if (!processedRails.has(railInfo.actionRail)) {
          processedRails.add(railInfo.actionRail);
          if (injectCopyButtonToInstagramPost(post)) {
            count++;
          }
        }
      }
    });

    // 2. Scan directly for action rails across all Reels (signed-out, feed, full-screen)
    const actionElements = root.querySelectorAll('section, div[role="group"], div[class*="ActionBar"], button, div[role="button"]');
    for (const el of actionElements) {
      if (el.classList && el.classList.contains('image-saver-ig-copy-wrap')) continue;
      if (el.closest && el.closest('.image-saver-ig-copy-wrap')) continue;

      const railInfo = findActionRailAndLikeItem(el.parentElement?.parentElement || el.parentElement || el);
      if (railInfo && railInfo.actionRail) {
        if (!processedRails.has(railInfo.actionRail)) {
          processedRails.add(railInfo.actionRail);
          const container = findEnclosingPostOrReel(railInfo.actionRail);
          if (injectCopyButtonToInstagramPost(container || railInfo.actionRail)) {
            count++;
          }
        }
      }
    }

    // 3. Fallback: if root itself has an action rail not caught above
    if (processedRails.size === 0) {
      const selfRail = findActionRailAndLikeItem(root);
      if (selfRail && selfRail.actionRail && !processedRails.has(selfRail.actionRail)) {
        processedRails.add(selfRail.actionRail);
        const container = findEnclosingPostOrReel(selfRail.actionRail) || (root !== document.body && root.tagName !== 'HTML' && root.tagName !== 'MAIN' && (!root.getAttribute || root.getAttribute('role') !== 'main') ? root : selfRail.actionRail);
        if (injectCopyButtonToInstagramPost(container)) {
          count++;
        }
      }
    }

    return count;
  }

  const requestThrottledScan = globalThis.MediaLatchCopyKit.scheduler((root) => scanAndInjectInstagramCopyButtons(root));

  const initInstagramCopyButtonObserver = globalThis.MediaLatchCopyKit.observer({ prepare: ensureIgButtonStyles, scan: scanAndInjectInstagramCopyButtons, request: requestThrottledScan, ownClass: 'image-saver-ig-copy-wrap' });

  if (typeof window !== 'undefined') {
    // Intercept scroll events in capture phase so inner overflow containers (e.g. scrollable Reel feeds) trigger re-scans
    window.addEventListener('scroll', () => requestThrottledScan(), { capture: true, passive: true });
    window.addEventListener('resize', () => requestThrottledScan(), { passive: true });
  }
  globalThis.MediaLatchCopyKit.navigation(requestThrottledScan);

  if (typeof document !== 'undefined') document.addEventListener('scroll', () => requestThrottledScan(), { capture: true, passive: true });
  globalThis.MediaLatchCopyKit.whenReady(initInstagramCopyButtonObserver);

  // Export functions to global scope for unit testing in Node/vm if applicable
  if (typeof globalThis !== 'undefined') {
    globalThis.__formatInstagramShareUrl = formatInstagramShareUrl;
    globalThis.__extractInstagramUrl = extractInstagramUrl;
    globalThis.__injectCopyButtonToInstagramPost = injectCopyButtonToInstagramPost;
    globalThis.__scanAndInjectInstagramCopyButtons = scanAndInjectInstagramCopyButtons;
    globalThis.__initInstagramCopyButtonObserver = initInstagramCopyButtonObserver;
    globalThis.__ensureIgButtonStyles = ensureIgButtonStyles;
    globalThis.__findActionRailAndLikeItem = findActionRailAndLikeItem;
    globalThis.__findEnclosingPostOrReel = findEnclosingPostOrReel;
    globalThis.__containsMultiplePostsOrReels = containsMultiplePostsOrReels;
    globalThis.__countDistinctLikeControls = countDistinctLikeControls;
    globalThis.__requestThrottledScan = requestThrottledScan;
    globalThis.__isLikeLabel = isLikeLabel;
    globalThis.__isValidInstagramShortcode = isValidInstagramShortcode;
    globalThis.__parseShortcodeFromPath = parseShortcodeFromPath;
    globalThis.__hasExplicitShortcodeEvidence = hasExplicitShortcodeEvidence;
    globalThis.__isMultiItemEnvironment = isMultiItemEnvironment;
    globalThis.__hasActivePlayingVideo = hasActivePlayingVideo;
    globalThis.__isActiveCardInViewport = isActiveCardInViewport;
    globalThis.__isVerticalActionRail = isVerticalActionRail;
    globalThis.__refreshInstagramButtonLayout = refreshInstagramButtonLayout;
    globalThis.__isInsideExcludedPostSection = isInsideExcludedPostSection;
    globalThis.__setCachedIgShareHost = (h) => igShare.set(h);
    globalThis.__getCachedIgShareHost = () => igShare.get();
    globalThis.__ALLOWED_IG_SHARE_HOSTS = ALLOWED_IG_SHARE_HOSTS;
    globalThis.__DEFAULT_IG_SHARE_HOST = DEFAULT_IG_SHARE_HOST;
  }
})();
