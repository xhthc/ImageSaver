// content_redgifs.js - Frame-local DOM & network media detection for RedGIFs embeds
(() => {
  const GUARD_KEY = '__imageSaverRedGifsInitialized';
  const targetScope = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
  if (targetScope && targetScope[GUARD_KEY]) {
    return;
  }
  if (targetScope) {
    targetScope[GUARD_KEY] = true;
  }

  const isI18n = globalThis.ImageSaverI18n;
  const isLabels = isI18n && typeof chrome !== 'undefined' ? isI18n.follow(chrome, typeof navigator !== 'undefined' ? navigator : null, () => {}) : null;
  const isLabel = (element, field, key, fallback, vars) => {
    if (isLabels) isLabels.label(element, field, key, vars, fallback);
    else if (field === 'textContent') element.textContent = fallback;
    else if (fallback === null) element.removeAttribute(field);
    else element.setAttribute(field, fallback);
  };

  let lastContextmenuTarget = null;
  let lastContextmenuPath = [];
  let lastContextmenuTime = 0;
  // What the gesture could have selected, with the source evidence each player showed at that moment (see snapshotGestureVideos)
  let lastContextmenuEvidence = null;

  // Track the last contextmenu target and composedPath per frame

  // Serialized data scanning and resource bounds
  const MAX_SCRIPTS_TO_INSPECT = 25;
  const MAX_SCRIPT_TEXT_SIZE = 500 * 1024; // 500 KB per script
  const MAX_TOTAL_SCRIPT_TEXT_SIZE = 2 * 1024 * 1024; // 2 MB total across scripts
  const MAX_JSON_TRAVERSAL_NODES = 5000;
  const MAX_JSON_DEPTH = 8;
  const MAX_COLLECTED_CANDIDATES = 20;

  /**
   * Allowed RedGIFs hostname validator.
   * Matches redgifs.com and *.redgifs.com. Strictly rejects lookalikes.
   */
  function isAllowedRedGifsHost(hostname) {
    if (!hostname || typeof hostname !== 'string') return false;
    const lower = hostname.toLowerCase();
    return lower === 'redgifs.com' || lower.endsWith('.redgifs.com');
  }

  /**
   * Strict validator for RedGIFs URLs (HTTPS or blob with HTTPS origin).
   * Rejects non-HTTPS schemes, lookalikes, and malformed URLs.
   */
  function isRedGifsUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const parsed = new URL(urlStr);
      if (parsed.protocol === 'https:') {
        return isAllowedRedGifsHost(parsed.hostname);
      }
      if (parsed.protocol === 'blob:' && parsed.origin && parsed.origin !== 'null') {
        const originParsed = new URL(parsed.origin);
        return originParsed.protocol === 'https:' && isAllowedRedGifsHost(originParsed.hostname);
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  /**
   * Sanitizes URLs for safe diagnostic reporting without exposing signatures/tokens.
   */
  function sanitizeUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return '';
    try {
      const parsed = new URL(urlStr);
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (/token|auth|key|sig|secret|signature/i.test(key)) {
          parsed.searchParams.set(key, '[REDACTED]');
        }
      }
      return parsed.toString();
    } catch (_) {
      return urlStr.replace(/([?&](?:token|auth|key|sig|signature)=)[^&]*/gi, '$1[REDACTED]');
    }
  }

  /**
   * Safely decodes JSON-escaped slashes and unicode characters.
   */
  function safeDecodeJsonEscapes(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/\\\//g, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u002f/gi, '/');
  }

  /**
   * Strict validator for direct RedGIFs video URLs.
   * Rejects blob:, data:, javascript:, non-HTTPS, lookalikes, and malformed URLs.
   */
  function isValidDirectVideoUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    const trimmed = urlStr.trim();
    if (trimmed.startsWith('blob:') || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) {
      return false;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:') return false;
      if (!isAllowedRedGifsHost(parsed.hostname)) return false;
      const pathname = parsed.pathname.toLowerCase();
      const hasVideoExt = /\.(mp4|webm|mov|m4v)$/i.test(pathname);
      const queryFormat = parsed.searchParams.get('format') || parsed.searchParams.get('type');
      const hasVideoQuery = queryFormat && /^(mp4|webm|video\/)/i.test(queryFormat.trim());
      return Boolean(hasVideoExt || hasVideoQuery);
    } catch (_) {
      return false;
    }
  }

  /**
   * Extracts RedGIFs video identifier from watch, ifr, media, or detail pathnames.
   */
  function extractRedGifsIdFromUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    const trimmed = urlStr.trim();
    if (trimmed.startsWith('blob:') || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) {
      return null;
    }
    try {
      const parsed = new URL(trimmed, (typeof window !== 'undefined' && window.location?.href) || 'https://www.redgifs.com/');
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      if (!isAllowedRedGifsHost(parsed.hostname)) return null;

      const pathname = parsed.pathname;
      const routeMatch = pathname.match(/\/(?:watch|ifr|detail|gifs)\/([a-zA-Z0-9_-]+)/i);
      if (routeMatch) {
        return routeMatch[1].replace(/-(?:mobile|silent|poster)$/i, '');
      }
      const fileMatch = pathname.match(/\/([a-zA-Z0-9_-]+)\.(?:mp4|webm|mov|m4v|jpg|jpeg|png|webp|gif)/i);
      if (fileMatch) {
        return fileMatch[1].replace(/-(?:mobile|silent|poster)$/i, '');
      }
      const slugMatch = pathname.match(/^\/([a-zA-Z0-9_-]{3,})$/);
      if (slugMatch && !/^(?:watch|ifr|detail|about|terms|privacy|contact|api)$/i.test(slugMatch[1])) {
        return slugMatch[1];
      }
    } catch (_) {}
    return null;
  }

  // Real player and card container boundaries (excluding generic nearest-div)
  const PLAYER_CARD_SELECTOR = [
    '[data-card]',
    '[data-card-id]',
    '[data-id]',
    '[data-gif-id]',
    '[data-post-id]',
    '[data-item-id]',
    '.card',
    '.player',
    '.Player',
    '.video-player',
    '.redgifs-player',
    '.gif-player',
    'article',
    'section',
    'figure',
    '.media-container',
    '.feed-card',
    '[role="article"]',
    'shreddit-player',
    'shreddit-aspect-ratio',
    'shreddit-media-lightbox'
  ].join(', ');

  /**
   * Checks if an element is currently connected to the active document.
   */
  function isConnectedNode(node) {
    if (!node || typeof node !== 'object') return false;
    if (typeof node.isConnected === 'boolean') return node.isConnected;
    if (typeof document !== 'undefined' && typeof document.contains === 'function') {
      try {
        return document.contains(node);
      } catch (_) {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if a video element or one of its child sources matches the target URL.
   */
  function videoMatchesSrc(video, targetSrc) {
    if (!video || !targetSrc || typeof targetSrc !== 'string') return false;
    const clean = targetSrc.trim();
    if (!clean) return false;
    if (video.currentSrc === clean || video.src === clean) return true;
    if (video.querySelectorAll) {
      try {
        const sources = Array.from(video.querySelectorAll('source'));
        for (let i = 0; i < sources.length; i++) {
          const s = sources[i];
          const sSrc = s.src || (s.getAttribute && s.getAttribute('src'));
          if (sSrc === clean) return true;
        }
      } catch (_) {}
    }
    return false;
  }

  const MAX_GESTURE_VIDEOS = 50;

  /**
   * The clip a provider player proves for itself: the poster image(s) of the `.Player` that owns exactly this video, named by a provider media
   * file (https, a RedGIFs host, an image extension). Identity only: a poster is never a downloadable video and never builds an address.
   * Only on the provider's own origin, never from a feed or a neighbor; posters naming different clips are a conflict, not a proof.
   */
  function posterClipOf(video) {
    const none = { id: '', conflict: false };
    if (!video || typeof video.closest !== 'function' || !isProviderOwnOrigin()) return none;
    try {
      const owner = video.closest('.Player');
      if (!owner || !isConnectedNode(owner) || typeof owner.querySelectorAll !== 'function') return none;
      const players = Array.from(owner.querySelectorAll('video')).filter(isConnectedNode);
      if (players.length !== 1 || players[0] !== video) return none;
      const ids = new Set();
      for (const img of Array.from(owner.querySelectorAll('img'))) {
        const cls = String((img.getAttribute && img.getAttribute('class')) || '');
        if (!/(?:^|\s)Player-Poster(?:\s|$)/.test(cls)) continue;
        const src = String(img.currentSrc || img.src || (img.getAttribute && img.getAttribute('src')) || '');
        let isImage = false;
        try { isImage = /\.(?:jpe?g|png|webp)$/i.test(new URL(src).pathname); } catch (_) {}
        const id = isImage ? (extractRedGifsIdFromUrl(src) || '').toLowerCase() : '';
        if (id) ids.add(id);
      }
      return ids.size === 1 ? { id: Array.from(ids)[0], conflict: false } : { id: '', conflict: ids.size > 1 };
    } catch (_) {
      return none;
    }
  }

  const posterKeyOf = (video) => {
    const p = posterClipOf(video);
    return p.conflict ? '!' : p.id;
  };

  /**
   * What identifies a player's selection: its document, every source address it shows (its own src/currentSrc and the child sources) and the
   * clip its own poster names, so a recycled player that keeps its node but changes clip is not the selection.
   */
  function sourceEvidenceOf(video) {
    const sources = [];
    try {
      if (video && video.querySelectorAll) {
        for (const s of Array.from(video.querySelectorAll('source'))) {
          sources.push(String(s.src || (s.getAttribute && s.getAttribute('src')) || ''));
        }
      }
    } catch (_) {}
    return { ownerDocument: (video && video.ownerDocument) || null, src: String((video && video.src) || ''), currentSrc: String((video && video.currentSrc) || ''), sources, poster: posterKeyOf(video) };
  }

  function sameSourceEvidence(a, b) {
    return a.ownerDocument === b.ownerDocument && a.src === b.src && a.currentSrc === b.currentSrc && a.poster === b.poster && a.sources.length === b.sources.length && a.sources.every((u, i) => u === b.sources[i]);
  }

  /**
   * Records, at the gesture, every connected player the routes of findClickedVideo can select (the target, players in the composed path,
   * players of the card containers in the path, of the target's closest card and of its parent) with the sources each one shows then.
   * A player outside this set (added or recycled later) or one whose sources changed afterwards is not the player the user selected.
   */
  function snapshotGestureVideos(target, path) {
    const videos = new Map();
    const add = (v) => {
      if (v && typeof v === 'object' && v.tagName === 'VIDEO' && videos.size < MAX_GESTURE_VIDEOS && isConnectedNode(v)) videos.set(v, sourceEvidenceOf(v));
    };
    const addWithin = (container) => {
      if (!container || !container.querySelectorAll || !isConnectedNode(container)) return;
      try { for (const v of Array.from(container.querySelectorAll('video'))) add(v); } catch (_) {}
    };
    try {
      add(target);
      for (const el of Array.isArray(path) ? path : []) {
        add(el);
        if (el && typeof el.matches === 'function' && el.matches(PLAYER_CARD_SELECTOR)) addWithin(el);
      }
      if (target && typeof target === 'object') {
        addWithin(typeof target.closest === 'function' ? target.closest(PLAYER_CARD_SELECTOR) : null);
        addWithin(target.parentElement);
      }
    } catch (_) {}
    return { videos };
  }

  function captureGesture(target, path) {
    lastContextmenuTarget = target;
    lastContextmenuPath = Array.isArray(path) ? path : (target ? [target] : []);
    lastContextmenuTime = Date.now();
    lastContextmenuEvidence = snapshotGestureVideos(lastContextmenuTarget, lastContextmenuPath);
  }

  /**
   * The selected player is still the one the gesture saw: the same node of the same document with the same source evidence.
   */
  function selectionProofHolds(video) {
    const ev = lastContextmenuEvidence;
    if (!ev || !ev.videos.has(video)) return false;
    return sameSourceEvidence(ev.videos.get(video), sourceEvidenceOf(video));
  }

  function connectedDocumentVideos() {
    return typeof document !== 'undefined' && document.querySelectorAll ? Array.from(document.querySelectorAll('video')).filter(isConnectedNode) : [];
  }

  /**
   * A RedGIFs clip address that is not the player's own source (the embed page, the media file of the clip) proves the request only when it
   * names this frame's own clip (its location, else its canonical metadata) and the player does not show another clip: either its own direct
   * address is that clip, or it shows none and it is the only player of the frame. Anything else is another clip's request.
   */
  function frameClipProof(video, clickedSrc) {
    if (typeof clickedSrc !== 'string' || !isRedGifsUrl(clickedSrc)) return false;
    const idOf = (u) => (extractRedGifsIdFromUrl(u) || '').toLowerCase();
    const clickedId = idOf(clickedSrc);
    if (!clickedId) return false;
    let frameOk = typeof window !== 'undefined' && window.location && isRedGifsUrl(window.location.href) && idOf(window.location.href) === clickedId;
    if (!frameOk && typeof document !== 'undefined' && document.querySelector) {
      const meta = document.querySelector('meta[property="og:video"], meta[name="twitter:url"], link[rel="canonical"]');
      const metaUrl = meta?.getAttribute('content') || meta?.getAttribute('href');
      frameOk = Boolean(metaUrl) && idOf(metaUrl) === clickedId;
    }
    if (!frameOk) return false;
    const evidence = sourceEvidenceOf(video);
    const ownIds = [evidence.currentSrc, evidence.src, ...evidence.sources].filter(Boolean).map(idOf).filter(Boolean);
    if (ownIds.some((id) => id !== clickedId)) return false;
    if (ownIds.length > 0) return true;
    const videos = connectedDocumentVideos();
    return videos.length === 1 && videos[0] === video;
  }

  /**
   * Whether the address the menu reported can belong to this player: its own source; an opaque stream URL of a player that shows no direct
   * address (a stream is the runtime buffer of the selected player; a player that shows a direct address names another asset than a stream
   * it does not hold, and the unchanged-since-gesture proof is applied separately); or the frame clip identity above.
   */
  function admitsClickedSrc(video, clickedSrc) {
    if (!clickedSrc) return true;
    if (videoMatchesSrc(video, clickedSrc)) return true;
    if (typeof clickedSrc === 'string' && clickedSrc.startsWith('blob:')) {
      const e = sourceEvidenceOf(video);
      return ![e.src, e.currentSrc, ...e.sources].some((u) => u && !u.startsWith('blob:'));
    }
    return frameClipProof(video, clickedSrc);
  }

  /**
   * Locates a matching video in a container element without guessing among multiple candidates.
   */
  function findMatchingVideoInContainer(container, clickedSrc) {
    if (!container || !container.querySelectorAll || !isConnectedNode(container)) return null;
    let videos = [];
    try {
      videos = Array.from(container.querySelectorAll('video')).filter(isConnectedNode);
    } catch (_) {
      return null;
    }
    if (videos.length === 0) return null;

    if (clickedSrc) {
      const matching = videos.filter(v => videoMatchesSrc(v, clickedSrc));
      if (matching.length === 1) return matching[0];
      if (matching.length > 1) return null;

      // No player shows the address: the container's only player may still be the one it names (an opaque stream URL for a player that
      // shows no direct address, or the frame's clip identity); an address that conflicts with the player(s) is refused
      if (videos.length === 1 && admitsClickedSrc(videos[0], clickedSrc)) return videos[0];
      return null;
    }

    if (videos.length === 1) {
      return videos[0];
    }
    return null;
  }

  /**
   * Gesture selection: the player the recent contextmenu gesture points at (direct target, composed path, owning card, parent), refused
   * when the address the menu reported conflicts with it. The caller applies the unchanged-since-gesture proof.
   */
  function selectVideoOfGesture(clickedSrc) {
    // Revalidate gesture target connectivity
    if (lastContextmenuTarget && !isConnectedNode(lastContextmenuTarget)) {
      return null;
    }

    // 1. Direct VIDEO target
    if (lastContextmenuTarget && lastContextmenuTarget.tagName === 'VIDEO') {
      return admitsClickedSrc(lastContextmenuTarget, clickedSrc) ? lastContextmenuTarget : null;
    }

    // 2. Composed path inspection (innermost to outermost)
    if (Array.isArray(lastContextmenuPath) && lastContextmenuPath.length > 0) {
      for (const el of lastContextmenuPath) {
        if (!el || typeof el !== 'object' || !isConnectedNode(el)) continue;

        if (el.tagName === 'VIDEO') {
          return admitsClickedSrc(el, clickedSrc) ? el : null;
        }

        if (el.matches && el.matches(PLAYER_CARD_SELECTOR)) {
          const match = findMatchingVideoInContainer(el, clickedSrc);
          if (match) return match;
          const cardVideos = Array.from(el.querySelectorAll ? el.querySelectorAll('video') : []).filter(isConnectedNode);
          if (cardVideos.length > 0) {
            return null;
          }
        }
      }
    }

    // 3. Fallback from contextmenu target container
    if (lastContextmenuTarget) {
      const card = lastContextmenuTarget.closest ? lastContextmenuTarget.closest(PLAYER_CARD_SELECTOR) : null;
      if (card && isConnectedNode(card)) {
        const match = findMatchingVideoInContainer(card, clickedSrc);
        if (match) return match;
        const cardVideos = Array.from(card.querySelectorAll ? card.querySelectorAll('video') : []).filter(isConnectedNode);
        if (cardVideos.length > 0) return null;
      }

      const parent = lastContextmenuTarget.parentElement;
      if (parent && isConnectedNode(parent)) {
        const match = findMatchingVideoInContainer(parent, clickedSrc);
        if (match) return match;
      }
    }

    // Recent gesture existed but yielded no valid connected video
    return null;
  }

  /**
   * Locates the specific clicked video in the owning frame.
   * Does NOT select the first video globally when multiple cards exist.
   * Strictly enforces connectivity, container bounds and the selected-target proof: with a recent gesture the player must be the one the
   * gesture saw, with the sources it showed then, whatever the reported address is (a blob: address does not bypass this).
   * requireGesture (the background admitted an address-less player of ONE document by its capture): this document's own fresh trusted
   * selection (within the 30 s the admission allows) is the only proof; a document without one (a fresh document of the frame) never
   * substitutes its sole player.
   */
  // The selection the background admitted is the capture of generic content_context_target.js (same isolated world, same frame), identified by its
  // timestamp: a later gesture of this document replaces that record, so an operation admitted for an earlier selection is never redirected to the later one.
  function admittedCaptureHolds(gestureAt) {
    const cap = typeof globalThis !== 'undefined' ? globalThis.__imageSaverContextTarget : null;
    return Number.isFinite(gestureAt) && Boolean(cap) && cap.at === gestureAt;
  }

  function findClickedVideo(clickedSrc, requireGesture = false) {
    const isRecent = (Date.now() - lastContextmenuTime) < (requireGesture ? 30000 : 15000);

    if (isRecent && (lastContextmenuTarget || (Array.isArray(lastContextmenuPath) && lastContextmenuPath.length > 0))) {
      const video = selectVideoOfGesture(clickedSrc);
      return video && selectionProofHolds(video) ? video : null;
    }

    if (requireGesture) return null;

    // No recent gesture: document search for the exact source, or the frame's single player named by its clip identity.
    // Nothing was recorded to prove an opaque stream URL against, so a blob: address must be the player's own source.
    const videos = connectedDocumentVideos();

    if (clickedSrc) {
      const matching = videos.filter(v => videoMatchesSrc(v, clickedSrc));
      if (matching.length === 1) return matching[0];
      if (matching.length > 1) return null;

      if (videos.length === 1 && !(typeof clickedSrc === 'string' && clickedSrc.startsWith('blob:')) && frameClipProof(videos[0], clickedSrc)) {
        return videos[0];
      }
      return null;
    }

    if (videos.length === 1) {
      return videos[0];
    }

    return null;
  }

  /**
   * Positively identifies if the clicked target/path or owning card is a RedGIFs media target.
   * On RedGIFs embeds/pages, verifies video media in frame.
   * On external hosts (e.g. Reddit), verifies RedGIFs iframe, video, anchor, or player card.
   * Strictly rejects Reddit images, Reddit GIFs, ordinary videos (v.redd.it), and unrelated elements.
   */
  function identifyRedGifsMedia(target, path = []) {
    const isRedGifsHost = typeof window !== 'undefined' && window.location && isAllowedRedGifsHost(window.location.hostname);
    if (isRedGifsHost) {
      const video = findClickedVideo();
      const videoUrl = video?.currentSrc || video?.src;
      return {
        type: 'video',
        sourceType: 'redgifs',
        url: (videoUrl && !videoUrl.startsWith('blob:')) ? videoUrl : (typeof window !== 'undefined' ? window.location.href : '')
      };
    }

    if (!target && (!path || !path.length)) return null;

    const elements = [target, ...(Array.isArray(path) ? path : [])].filter(Boolean);

    // 1. Direct inspection of elements in target / composedPath
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue;
      const tag = (el.tagName || '').toLowerCase();

      if (tag === 'iframe') {
        const src = el.src || (el.getAttribute && el.getAttribute('src'));
        if (src && isRedGifsUrl(src)) {
          return { type: 'video', sourceType: 'redgifs', url: src };
        }
      }

      if (tag === 'video') {
        const vSrc = el.currentSrc || el.src || (el.querySelector && el.querySelector('source')?.src) || (el.getAttribute && el.getAttribute('src'));
        if (vSrc && isRedGifsUrl(vSrc)) {
          return { type: 'video', sourceType: 'redgifs', url: vSrc };
        }
      }

      if (tag === 'a') {
        const href = el.href || (el.getAttribute && el.getAttribute('href'));
        if (href && isRedGifsUrl(href) && extractRedGifsIdFromUrl(href)) {
          return { type: 'video', sourceType: 'redgifs', url: href };
        }
      }
    }

    // 2. Inspection within owning card container
    if (target && typeof target.closest === 'function') {
      try {
        const card = target.closest(PLAYER_CARD_SELECTOR);
        if (card) {
          // Does card contain an iframe to RedGIFs?
          if (card.querySelector) {
            const iframe = card.querySelector('iframe[src*="redgifs.com"]');
            const iSrc = iframe?.src || iframe?.getAttribute?.('src');
            if (iSrc && isRedGifsUrl(iSrc)) {
              return { type: 'video', sourceType: 'redgifs', url: iSrc };
            }

            // Does card contain a video with RedGIFs URL?
            const video = card.querySelector('video');
            const vSrc = video?.currentSrc || video?.src || video?.querySelector?.('source')?.src;
            if (vSrc && isRedGifsUrl(vSrc)) {
              return { type: 'video', sourceType: 'redgifs', url: vSrc };
            }

            // Does card contain an anchor to RedGIFs?
            const link = card.querySelector('a[href*="redgifs.com"]');
            const lHref = link?.href || link?.getAttribute?.('href');
            if (lHref && isRedGifsUrl(lHref) && extractRedGifsIdFromUrl(lHref)) {
              return { type: 'video', sourceType: 'redgifs', url: lHref };
            }
          }

          // Does card have RedGIFs specific player attributes/classes?
          if (card.classList && (card.classList.contains('redgifs-player') || Array.from(card.classList).some(c => c.includes('redgifs')))) {
            const slug = card.getAttribute?.('data-slug') || card.getAttribute?.('data-id') || card.getAttribute?.('data-card-id');
            if (slug && !slug.startsWith('blob:')) {
              return { type: 'video', sourceType: 'redgifs', url: `https://www.redgifs.com/watch/${slug}` };
            }
          }
        }
      } catch (_) {}
    }

    return null;
  }

  /**
   * Dispatches proactive menu update ONLY when a RedGIFs media target is positively identified.
   */
  function notifyRedGifsContextMenu(target, path, at) {
    try {
      const media = identifyRedGifsMedia(target, path);
      if (!media) return;
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'REDGIFS_MEDIA_CONTEXTMENU_DETECTED',
          media,
          timestamp: Date.now(),
          gestureAt: Number.isFinite(at) ? at : undefined
        }).catch(() => {});
      }
    } catch (_) {}
  }

  // Attach context menu listeners with positive RedGIFs identification
  if (typeof window !== 'undefined' && window.addEventListener) {
    // Only a genuine user gesture selects: a page-dispatched event must neither replace the recorded proof nor notify the background
    window.addEventListener('mousedown', (event) => {
      if (event && event.isTrusted === true && event.button === 2) {
        captureGesture(event.target, typeof event.composedPath === 'function' ? event.composedPath() : []);
        notifyRedGifsContextMenu(lastContextmenuTarget, lastContextmenuPath, event.timeStamp);
      }
    }, true);

    window.addEventListener('contextmenu', (event) => {
      if (!event || event.isTrusted !== true) return;
      captureGesture(event.target, typeof event.composedPath === 'function' ? event.composedPath() : []);
      notifyRedGifsContextMenu(lastContextmenuTarget, lastContextmenuPath, event.timeStamp);
    }, true);
  }

  /**
   * Helper to check if a URL is a file of the clip `videoId`, case-insensitively. The clip is the media file's own identity (its name without
   * the -mobile/-silent/-poster rendition suffix, see extractRedGifsIdFromUrl): an id that is only a substring of another id, or appears in
   * a directory, the host or the query, names no clip.
   */
  function matchesVideoId(candidateUrl, videoId, isSingleVideo) {
    if (!candidateUrl) return false;
    if (videoId) {
      const extracted = extractRedGifsIdFromUrl(candidateUrl);
      return Boolean(extracted) && extracted.toLowerCase() === String(videoId).replace(/-(?:mobile|silent|poster)$/i, '').toLowerCase();
    }
    return Boolean(isSingleVideo);
  }

  /**
   * Safe frame URL (stripped of sensitive query parameters).
   */
  function getSafeFrameUrl() {
    if (typeof window === 'undefined' || !window.location) return '';
    try {
      const loc = window.location;
      return `${loc.protocol}//${loc.host}${loc.pathname}`;
    } catch (_) {
      return '';
    }
  }

  /**
   * RedGIFs names the muted rendition of a clip `<Id>-silent.<ext>`. This is a negative marker only: it never proves that the
   * clip has no sound, and a name without it never proves that a file has an audio track.
   */
  function hasSilentMarker(urlStr) {
    try {
      return /-silent\.(?:mp4|webm|mov|m4v)$/i.test(new URL(urlStr).pathname);
    } catch (_) {
      return false;
    }
  }

  /**
   * Positive audio evidence the page itself declares for one clip: an object `{ id, hasAudio, urls: { hd, sd, silent, ... } }`.
   * `hasAudio: true` makes every non-silent rendition of that clip positive; the `silent` rendition and any `-silent` name are never.
   * Returns Map<url, 'present'|'absent'>; objects of another clip id are ignored.
   */
  function audioStatesOfClipObject(obj, videoId) {
    const states = new Map();
    if (!obj || typeof obj.urls !== 'object' || obj.urls === null || Array.isArray(obj.urls)) return states;
    if (videoId && typeof obj.id === 'string' && obj.id.toLowerCase() !== videoId.toLowerCase()) return states;
    for (const key of Object.keys(obj.urls)) {
      const value = obj.urls[key];
      if (typeof value !== 'string' || !isValidDirectVideoUrl(value)) continue;
      if (key.toLowerCase() === 'silent' || hasSilentMarker(value)) states.set(value, 'absent');
      else if (obj.hasAudio === true) states.set(value, 'present');
      else if (obj.hasAudio === false) states.set(value, 'absent');
    }
    return states;
  }

  /**
   * Recursively traverses JSON objects to extract candidate video URLs.
   * Enforces maximum depth and traversal node count to avoid blocking.
   */
  function findUrlsInJsonObject(obj, callback, depth = 0, state = { nodeCount: 0 }) {
    if (!obj || depth > MAX_JSON_DEPTH) return;
    state.nodeCount++;
    if (state.nodeCount > MAX_JSON_TRAVERSAL_NODES) return;

    if (typeof obj === 'string') {
      if (obj.includes('.mp4') || obj.includes('.webm') || obj.includes('.mov') || obj.includes('.m4v')) {
        try {
          const parsed = new URL(obj);
          if (parsed.protocol === 'https:' && isAllowedRedGifsHost(parsed.hostname)) {
            callback(obj);
          }
        } catch (_) {}
      }
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (state.nodeCount > MAX_JSON_TRAVERSAL_NODES) break;
        findUrlsInJsonObject(item, callback, depth + 1, state);
      }
      return;
    }
    if (typeof obj === 'object') {
      if (typeof state.onClip === 'function') state.onClip(obj);
      for (const key of Object.keys(obj)) {
        if (state.nodeCount > MAX_JSON_TRAVERSAL_NODES) break;
        findUrlsInJsonObject(obj[key], callback, depth + 1, state);
      }
    }
  }

  /**
   * Ranks candidates: a rendition with positive audio evidence first (audio = Map/object url -> 'present'), then non-mobile HD MP4,
   * mobile MP4 and WebM. Without evidence the order is unchanged from before; ties keep discovery order.
   */
  function rankCandidates(candidates, audio) {
    const present = (url) => {
      const state = audio instanceof Map ? audio.get(url) : (audio && Object.prototype.hasOwnProperty.call(audio, url) ? audio[url] : undefined);
      return state === 'present' && !hasSilentMarker(url);
    };
    return [...candidates].sort((a, b) => {
      const aPresent = present(a);
      const bPresent = present(b);
      if (aPresent !== bPresent) return aPresent ? -1 : 1;

      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      const aMobile = aLower.includes('-mobile') || aLower.includes('_mobile');
      const bMobile = bLower.includes('-mobile') || bLower.includes('_mobile');
      const aMp4 = aLower.includes('.mp4');
      const bMp4 = bLower.includes('.mp4');
      const aWebm = aLower.includes('.webm');
      const bWebm = bLower.includes('.webm');

      // Rank 1: Non-mobile MP4 (HD)
      const aRank1 = aMp4 && !aMobile;
      const bRank1 = bMp4 && !bMobile;
      if (aRank1 !== bRank1) return aRank1 ? -1 : 1;

      // Rank 2: Mobile MP4
      const aRank2 = aMp4 && aMobile;
      const bRank2 = bMp4 && bMobile;
      if (aRank2 !== bRank2) return aRank2 ? -1 : 1;

      // Rank 3: WebM
      if (aWebm !== bWebm) return aWebm ? -1 : 1;

      return 0;
    });
  }

  /**
   * Frame-local media resolution for RedGIFs videos.
   */
  function resolveFrameRedGifsMedia(clickedSrc = '', options = {}) {
    const inspectedCategories = [];
    const inspectedDetails = [];
    const rejectionReasons = [];
    const allVideos = (typeof document !== 'undefined' && document.querySelectorAll) ? Array.from(document.querySelectorAll('video')) : [];
    const isSingleVideo = allVideos.length === 1;

    const requireGesture = options.requireGesture === true;
    // an operation bound to an admitted selection (requireGesture) answers only while that selection is still the document's latest one
    // an inline Save names its player itself (the live, one-shot target of this document); the menu's gesture proof is never used for it
    const targetVideo = options.explicit
      ? (inlineHolds(options.explicit) ? options.explicit.video : null)
      : (!requireGesture || admittedCaptureHolds(options.gestureAt) ? findClickedVideo(clickedSrc, requireGesture) : null);

    if (!targetVideo) {
      inspectedCategories.push('video_discovery');
      rejectionReasons.push('NO_MATCHING_VIDEO_TARGET');
      return {
        success: false,
        error: 'UNRESOLVED_BLOB_MEDIA',
        targetUrl: null,
        diagnostics: {
          frameId: options.frameId ?? null,
          safeFrameUrl: getSafeFrameUrl(),
          targetFound: false,
          videoCount: allVideos.length,
          videoId: null,
          videoIdSource: 'none',
          inspectedSources: inspectedCategories,
          candidateCount: 0,
          validCandidateCount: 0,
          rejectionReasons
        }
      };
    }

    inspectedCategories.push('video_discovery');
    const card = (targetVideo.closest && targetVideo.closest(PLAYER_CARD_SELECTOR)) || targetVideo.parentElement;

    // Discover videoId and videoIdSource
    let videoId = null;
    let videoIdSource = 'none';

    // A. Card / video data attributes
    const idAttrs = ['data-id', 'data-card-id', 'data-gif-id', 'data-video-id', 'data-slug'];
    for (const attr of idAttrs) {
      const vVal = targetVideo.getAttribute ? targetVideo.getAttribute(attr) : null;
      const cVal = card && card.getAttribute ? card.getAttribute(attr) : null;
      const val = vVal || cVal;
      if (val && !val.startsWith('blob:')) {
        videoId = val;
        videoIdSource = 'card_attribute';
        break;
      }
    }

    // B. Video src / currentSrc
    if (!videoId) {
      const extractedFromSrc = extractRedGifsIdFromUrl(targetVideo.currentSrc) || extractRedGifsIdFromUrl(targetVideo.src);
      if (extractedFromSrc) {
        videoId = extractedFromSrc;
        videoIdSource = 'video_src';
      }
    }

    // C. Nearby links or iframes in the same card
    if (!videoId && card && card.querySelectorAll) {
      const nearbyLinks = Array.from(card.querySelectorAll('a[href*="redgifs.com"], iframe[src*="redgifs.com"]'));
      for (const link of nearbyLinks) {
        const href = link.href || (link.getAttribute && link.getAttribute('href')) || link.src || (link.getAttribute && link.getAttribute('src'));
        if (href) {
          const extracted = extractRedGifsIdFromUrl(href);
          if (extracted) {
            videoId = extracted;
            videoIdSource = 'nearby_link';
            break;
          }
        }
      }
    }

    // C2. The selected player's own poster: a clip the player proves for itself outranks the frame (a feed names no clip) and may not contradict one
    const poster = posterClipOf(targetVideo);
    const clipOf = (id) => String(id).replace(/-(?:mobile|silent|poster)$/i, '').toLowerCase();
    if (poster.conflict || (poster.id && videoId && clipOf(videoId) !== poster.id)) {
      return {
        success: false,
        error: 'UNRESOLVED_BLOB_MEDIA',
        targetUrl: null,
        diagnostics: {
          frameId: options.frameId ?? null,
          safeFrameUrl: getSafeFrameUrl(),
          targetFound: true,
          videoCount: allVideos.length,
          videoId: null,
          videoIdSource: 'none',
          inspectedSources: Array.from(new Set(inspectedCategories)),
          candidateCount: 0,
          validCandidateCount: 0,
          rejectionReasons: ['CONFLICTING_CLIP_ID']
        }
      };
    }
    if (!videoId && poster.id) {
      videoId = poster.id;
      videoIdSource = 'player_poster';
    }

    // D. Frame location (e.g. /ifr/<id> or /watch/<id>)
    if (!videoId && typeof window !== 'undefined' && window.location?.href && isRedGifsUrl(window.location.href)) {
      const frameIdFromLoc = extractRedGifsIdFromUrl(window.location.href);
      if (frameIdFromLoc) {
        videoId = frameIdFromLoc;
        videoIdSource = 'frame_url';
      }
    }

    // E. Document metadata (og:url, canonical)
    if (!videoId && typeof document !== 'undefined' && document.querySelector) {
      const metaUrlEl = document.querySelector('meta[property="og:url"], meta[name="twitter:url"], link[rel="canonical"]');
      const metaUrl = metaUrlEl?.getAttribute('content') || metaUrlEl?.getAttribute('href');
      if (metaUrl) {
        const extractedMeta = extractRedGifsIdFromUrl(metaUrl);
        if (extractedMeta) {
          videoId = extractedMeta;
          videoIdSource = 'document_metadata';
        }
      }
    }

    const rawCandidates = [];
    const audioStates = new Map();

    // 1. Inspect video element (currentSrc, src)
    inspectedCategories.push('video_element');
    const curSrc = targetVideo.currentSrc;
    if (curSrc) {
      if (isValidDirectVideoUrl(curSrc)) rawCandidates.push(curSrc);
      else if (curSrc.startsWith('blob:')) inspectedDetails.push('video.currentSrc: blob');
    }
    const rawSrc = targetVideo.src;
    if (rawSrc && rawSrc !== curSrc) {
      if (isValidDirectVideoUrl(rawSrc)) rawCandidates.push(rawSrc);
      else if (rawSrc.startsWith('blob:')) inspectedDetails.push('video.src: blob');
    }

    // 2. Inspect child sources
    inspectedCategories.push('child_sources');
    const childSources = targetVideo.querySelectorAll ? Array.from(targetVideo.querySelectorAll('source')) : [];
    for (const s of childSources) {
      const sUrl = s.src || (s.getAttribute && s.getAttribute('src'));
      if (sUrl && isValidDirectVideoUrl(sUrl)) {
        rawCandidates.push(sUrl);
      }
    }

    // 3. Inspect data attributes on video and card
    inspectedCategories.push('card_attributes');
    const dataAttrs = ['data-src', 'data-url', 'data-video-url', 'data-mp4', 'data-webm', 'data-fallback', 'data-hd', 'data-sd', 'data-mobile'];
    for (const attr of dataAttrs) {
      const vVal = targetVideo.getAttribute ? targetVideo.getAttribute(attr) : null;
      const cVal = card && card.getAttribute ? card.getAttribute(attr) : null;
      const val = vVal || cVal;
      if (val && isValidDirectVideoUrl(val)) {
        rawCandidates.push(val);
      }
    }

    // 4. Inspect document metadata (og:video, og:video:url, twitter:player:stream)
    inspectedCategories.push('document_metadata');
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      const metaEls = Array.from(document.querySelectorAll('meta[property], meta[name]'));
      for (const m of metaEls) {
        const prop = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
        if (prop === 'og:video' || prop === 'og:video:url' || prop === 'og:video:secure_url' || prop === 'twitter:player:stream') {
          const content = m.getAttribute('content');
          if (content && isValidDirectVideoUrl(content)) {
            if (matchesVideoId(content, videoId, isSingleVideo)) {
              rawCandidates.push(content);
            } else {
              rejectionReasons.push('METADATA_UNMATCHED_CARD_ID');
            }
          }
        }
      }
    }

    // 5. Inspect serialized JSON/JSON-LD/Next-style script tags with strict bounds
    inspectedCategories.push('serialized_json');
    let inspectedScriptCount = 0;
    let totalScriptTextSize = 0;
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        if (rawCandidates.length >= MAX_COLLECTED_CANDIDATES) break;
        if (inspectedScriptCount >= MAX_SCRIPTS_TO_INSPECT) break;

        const text = script.textContent || '';
        if (!text) continue;

        // Marker check BEFORE parsing any script, including JSON scripts:
        // Must contain 'redgifs.com' or videoId
        const hasMarker = text.includes('redgifs.com') || (videoId && text.toLowerCase().includes(videoId.toLowerCase()));
        if (!hasMarker) continue;

        // Size limits: skip oversized scripts safely without blocking
        const textSize = text.length;
        if (textSize > MAX_SCRIPT_TEXT_SIZE) {
          continue;
        }
        if (totalScriptTextSize + textSize > MAX_TOTAL_SCRIPT_TEXT_SIZE) {
          break;
        }

        inspectedScriptCount++;
        totalScriptTextSize += textSize;

        const type = (script.getAttribute('type') || '').toLowerCase();
        const sId = script.getAttribute('id') || '';
        const isJsonScript = type === 'application/json' || type === 'application/ld+json' || sId === '__NEXT_DATA__';

        const decoded = safeDecodeJsonEscapes(text);

        // A. JSON structured parse
        if (isJsonScript) {
          try {
            const parsedJson = JSON.parse(decoded);
            const state = {
              nodeCount: 0,
              onClip: (clip) => {
                for (const [url, audio] of audioStatesOfClipObject(clip, videoId)) audioStates.set(url, audio);
              }
            };
            findUrlsInJsonObject(parsedJson, (url) => {
              if (rawCandidates.length >= MAX_COLLECTED_CANDIDATES) return;
              if (isValidDirectVideoUrl(url)) {
                if (matchesVideoId(url, videoId, isSingleVideo)) {
                  rawCandidates.push(url);
                } else {
                  rejectionReasons.push('JSON_UNMATCHED_CARD_ID');
                }
              }
            }, 0, state);
          } catch (_) {}
        }

        // B. Regex fallback: the complete address up to its delimiter, query included (it may carry the request's authorization); the
        // extension and the host are validated on the parsed address, never by where the match happens to end
        if (rawCandidates.length < MAX_COLLECTED_CANDIDATES) {
          // a quoted address is exactly what the quotes hold; only an unquoted address loses the punctuation of its surrounding syntax
          const urlMatches = Array.from(decoded.matchAll(/(["'`])(https?:\/\/[a-zA-Z0-9_.-]*redgifs\.com\/[^\s<>\\]*?)\1|(https?:\/\/[a-zA-Z0-9_.-]*redgifs\.com\/[^"'`\s<>\\]+)/gi),
            (m) => (m[2] !== undefined ? m[2] : m[3].replace(/[)\]};,]+$/, '')));
          for (const rawMatch of urlMatches) {
            if (rawCandidates.length >= MAX_COLLECTED_CANDIDATES) break;
            if (isValidDirectVideoUrl(rawMatch)) {
              if (matchesVideoId(rawMatch, videoId, isSingleVideo)) {
                rawCandidates.push(rawMatch);
              }
            }
          }
        }
      }
    }

    // 6. Inspect frame-local performance resource entries
    inspectedCategories.push('performance_entries');
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
      const entries = performance.getEntriesByType('resource') || [];
      for (const entry of entries) {
        if (rawCandidates.length >= MAX_COLLECTED_CANDIDATES) break;
        const name = entry?.name;
        if (isValidDirectVideoUrl(name)) {
          if (matchesVideoId(name, videoId, isSingleVideo)) {
            rawCandidates.push(name);
          } else {
            rejectionReasons.push('PERF_UNMATCHED_CARD_ID');
          }
        }
      }
    }

    // Deduplicate and rank candidates with hard limit enforcement
    const cappedRawCandidates = rawCandidates.slice(0, MAX_COLLECTED_CANDIDATES);
    const uniqueCandidates = Array.from(new Set(cappedRawCandidates));
    // Audio evidence counts only for a rendition of this very clip: the clip id must be known and equal the candidate's own id.
    // The decoded-audio counter of the owned element proves audio for its current source only.
    const ownClipId = videoId ? videoId.replace(/-(?:mobile|silent|poster)$/i, '').toLowerCase() : null;
    const candidateAudio = {};
    for (const url of uniqueCandidates) {
      if (!ownClipId || (extractRedGifsIdFromUrl(url) || '').toLowerCase() !== ownClipId) continue;
      let state = audioStates.get(url);
      if (url === targetVideo.currentSrc && !hasSilentMarker(url) && Number(targetVideo.webkitAudioDecodedByteCount) > 0) state = 'present';
      if (state === 'present' || state === 'absent') candidateAudio[url] = state;
    }
    const rankedCandidates = rankCandidates(uniqueCandidates, candidateAudio).slice(0, MAX_COLLECTED_CANDIDATES);

    if (rankedCandidates.length === 0) {
      if (rejectionReasons.length === 0) {
        rejectionReasons.push('NO_DIRECT_MEDIA_FOUND');
      }
      return {
        success: false,
        error: 'UNRESOLVED_BLOB_MEDIA',
        targetUrl: null,
        diagnostics: {
          frameId: options.frameId ?? null,
          safeFrameUrl: getSafeFrameUrl(),
          targetFound: true,
          videoCount: allVideos.length,
          videoId: videoId || null,
          videoIdSource: videoIdSource || 'none',
          inspectedSources: Array.from(new Set(inspectedCategories)),
          candidateCount: cappedRawCandidates.length,
          validCandidateCount: 0,
          rejectionReasons: Array.from(new Set(rejectionReasons)).slice(0, 10)
        }
      };
    }

    const bestCandidate = rankedCandidates[0];

    return {
      success: true,
      targetUrl: bestCandidate,
      candidates: rankedCandidates,
      // Page-declared audio evidence per candidate of this clip ('present' | 'absent'); a missing entry means unknown.
      candidateAudio,
      diagnostics: {
        frameId: options.frameId ?? null,
        safeFrameUrl: getSafeFrameUrl(),
        targetFound: true,
        videoCount: allVideos.length,
        videoId: videoId || null,
        videoIdSource: videoIdSource || 'none',
        inspectedSources: Array.from(new Set(inspectedCategories)),
        candidateCount: cappedRawCandidates.length,
        validCandidateCount: rankedCandidates.length,
        rejectionReasons: []
      }
    };
  }

  // ---- RG-03: the provider's own declaration of the clip's audio, recovered only during an admitted save ----
  // The page DOM of the embed declares only the muted rendition (og:video, JSON-LD) while its player gets the clip object { id, hasAudio, urls }
  // from the provider's API with a guest session (observed 2026-10-06: v2/auth/temporary, then v2/gifs/<id> with that session as Bearer). The API
  // answers only the provider's own origin, so the frame itself asks, exactly as its player does, and only when a save was admitted (the background
  // sends RESOLVE_FRAME_MEDIA; hover never does) and only when the answer can change the choice: the selected rendition is the muted one and the
  // page proves no audio for this clip. Only a same-clip, validated, positively audio-bearing rendition is used; the guest session stays in this
  // function and is never logged, stored or returned; at most two bounded requests; a failure keeps the declared source (the existing rule).
  const PROVIDER_API = 'https://api.redgifs.com/';
  const PROVIDER_TOTAL_MS = 8000;
  const PROVIDER_MAX_BYTES = 256 * 1024;
  const PROVIDER_CLIP_ID = /^[a-z0-9_-]{3,64}$/;
  const PROVIDER_TOKEN = /^[A-Za-z0-9._~+/=-]{8,4096}$/;

  function isProviderOwnOrigin() {
    try {
      const loc = window.location;
      return loc.protocol === 'https:' && (loc.hostname || loc.host) === 'www.redgifs.com';
    } catch (_) {
      return false;
    }
  }

  async function providerGet(path, token, signal) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(PROVIDER_API + path, { method: 'GET', headers, credentials: 'omit', cache: 'no-store', signal });
    if (!response) return { ok: false };
    const declared = Number(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : NaN);
    if (response.ok !== true || declared > PROVIDER_MAX_BYTES || !response.body?.getReader) {
      try { await response.body?.cancel(); } catch (_) {}
      return { ok: false };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        if (signal?.aborted) return { ok: false };
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PROVIDER_MAX_BYTES) return { ok: false };
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { ok: true, json: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch (_) {
      return { ok: false };
    } finally {
      try { await reader.cancel(); } catch (_) {}
    }
  }

  // { ok: true, gif } for the exact clip, else { ok: false, reason } with a fixed code (never page, provider or session data)
  async function lookupProviderClip(clipId, checkContinuity) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), PROVIDER_TOTAL_MS) : null;
    try {
      const session = await providerGet('v2/auth/temporary', '', controller && controller.signal);
      const token = session.ok && session.json && typeof session.json.token === 'string' && PROVIDER_TOKEN.test(session.json.token) ? session.json.token : '';
      if (!token) return { ok: false, reason: 'AUTH_FAILED' };
      // Revalidate context continuity before issuing the second API request
      if (typeof checkContinuity === 'function' && !checkContinuity()) {
        return { ok: false, reason: 'FRAME_CHANGED' };
      }
      const clip = await providerGet('v2/gifs/' + encodeURIComponent(clipId), token, controller && controller.signal);
      if (!clip.ok) return { ok: false, reason: 'METADATA_FAILED' };
      const gif = clip.json && typeof clip.json === 'object' ? clip.json.gif : null;
      if (!gif || typeof gif !== 'object' || typeof gif.id !== 'string' || gif.id.toLowerCase() !== clipId) return { ok: false, reason: 'NOT_THE_CLIP' };
      return { ok: true, gif };
    } catch (e) {
      return { ok: false, reason: e && e.name === 'AbortError' ? 'TIMEOUT' : 'REQUEST_FAILED' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function withProviderDiagnostic(result, code) {
    return { ...result, diagnostics: { ...result.diagnostics, providerAudio: code } };
  }

  // The clip id to ask the provider about, or '' when the answer cannot change the choice: not a success (unless the selected player proved its clip), positive audio evidence already in the
  // page, a selected rendition that is not the muted one, no valid clip id, a frame that is not the provider's own origin.
  function providerClipToAsk(base) {
    if (!base || !base.diagnostics) return '';
    const clipId = typeof base.diagnostics.videoId === 'string' ? base.diagnostics.videoId.replace(/-(?:mobile|silent|poster)$/i, '').toLowerCase() : '';
    if (base.success !== true) {
      // no direct address in the page: only a selected player that proved its clip by its own poster may ask for the clip's declared renditions
      const proven = base.diagnostics.targetFound === true && base.diagnostics.videoIdSource === 'player_poster';
      return proven && PROVIDER_CLIP_ID.test(clipId) && isProviderOwnOrigin() && typeof fetch === 'function' ? clipId : '';
    }
    const evidence = base.candidateAudio || {};
    if (Object.keys(evidence).some((u) => evidence[u] === 'present')) return '';
    if (!hasSilentMarker(base.targetUrl) || !PROVIDER_CLIP_ID.test(clipId) || !isProviderOwnOrigin() || typeof fetch !== 'function') return '';
    return clipId;
  }

  // The page declared no direct address: the provider's own declaration for this very clip supplies it. Only validated direct video addresses whose
  // file names the selected clip are used (a poster or thumbnail is never one, nothing is constructed); a declared muted rendition is kept, and a
  // rendition with positive audio evidence is preferred. A clip with no such rendition stays unresolved, and so does a clip the provider declares
  // with sound when no validated same-clip rendition carries it: a muted file is never saved in its place.
  function recoverDeclaredRenditions(base, gif, clipId) {
    const urls = [];
    const declared = gif && gif.urls && typeof gif.urls === 'object' && !Array.isArray(gif.urls) ? gif.urls : {};
    for (const value of Object.values(declared)) {
      if (urls.length >= MAX_COLLECTED_CANDIDATES) break;
      if (typeof value === 'string' && isValidDirectVideoUrl(value) && (extractRedGifsIdFromUrl(value) || '').toLowerCase() === clipId && !urls.includes(value)) urls.push(value);
    }
    if (urls.length === 0) return withProviderDiagnostic(base, gif.hasAudio === true ? 'AUDIO_NO_VALID_RENDITION' : 'NO_DIRECT_DECLARED');
    const candidateAudio = {};
    for (const [url, state] of audioStatesOfClipObject(gif, clipId)) if (urls.includes(url)) candidateAudio[url] = state;
    const present = urls.some((u) => candidateAudio[u] === 'present');
    if (gif.hasAudio === true && !present) return withProviderDiagnostic(base, 'AUDIO_NO_VALID_RENDITION');
    // without audio evidence the established resolution-first order holds; a muted rendition only breaks a tie within its rank
    const ranked = rankCandidates(urls.slice().sort((a, b) => Number(hasSilentMarker(a)) - Number(hasSilentMarker(b))), candidateAudio);
    return {
      success: true,
      targetUrl: ranked[0],
      candidates: ranked,
      candidateAudio,
      diagnostics: {
        ...base.diagnostics,
        providerAudio: present ? 'present' : (gif.hasAudio === false ? 'AUDIO_FALSE' : 'NO_AUDIO_DECLARED'),
        candidateCount: urls.length,
        validCandidateCount: ranked.length,
        rejectionReasons: []
      }
    };
  }

  async function enrichWithProviderAudio(base, clipId, clickedSrc, requireGesture = false, gestureAt = null, explicit = null) {
    const evidence = base.candidateAudio || {};
    const hrefBefore = window.location.href;
    const docBefore = typeof document !== 'undefined' ? document : null;
    const selectedNow = () => (explicit ? (inlineHolds(explicit) ? explicit.video : null) : findClickedVideo(clickedSrc, requireGesture));
    const videoBefore = selectedNow();
    const srcBefore = videoBefore ? (videoBefore.src || '') : '';
    const currentSrcBefore = videoBefore ? (videoBefore.currentSrc || '') : '';
    const posterBefore = videoBefore ? posterKeyOf(videoBefore) : '';

    const checkContinuity = () => {
      if (explicit && !inlineHolds(explicit)) return false;
      if (requireGesture && !admittedCaptureHolds(gestureAt)) return false;
      if (window.location.href !== hrefBefore) return false;
      if (typeof document !== 'undefined' && docBefore && document !== docBefore) return false;
      if (videoBefore) {
        if (selectedNow() !== videoBefore) return false;
        if (typeof videoBefore.isConnected === 'boolean' && !videoBefore.isConnected) return false;
        if ((videoBefore.src || '') !== srcBefore) return false;
        if ((videoBefore.currentSrc || '') !== currentSrcBefore) return false;
        if (posterKeyOf(videoBefore) !== posterBefore) return false;
      }
      return true;
    };

    const found = await lookupProviderClip(clipId, checkContinuity);
    // the document, node, and source the answer was computed for must still be the ones asked about
    if (!checkContinuity() || found.reason === 'FRAME_CHANGED') {
      return {
        success: false,
        error: 'UNRESOLVED_BLOB_MEDIA',
        targetUrl: null,
        diagnostics: { ...base.diagnostics, providerAudio: 'FRAME_CHANGED', rejectionReasons: ['FRAME_CHANGED_DURING_LOOKUP'] }
      };
    }
    if (!found.ok) return withProviderDiagnostic(base, found.reason);

    if (base.success !== true) return recoverDeclaredRenditions(base, found.gif, clipId);

    // only renditions of this very clip: a validated direct video address of the provider whose own clip id is the selected clip's
    const states = new Map();
    for (const [url, state] of audioStatesOfClipObject(found.gif, clipId)) {
      if ((extractRedGifsIdFromUrl(url) || '').toLowerCase() === clipId) states.set(url, state);
    }
    const bearing = Array.from(states.keys()).filter((u) => states.get(u) === 'present' && !hasSilentMarker(u));
    if (bearing.length === 0) return withProviderDiagnostic(base, found.gif.hasAudio === false ? 'AUDIO_FALSE' : 'NO_AUDIO_DECLARED');

    const candidateAudio = { ...evidence };
    for (const [url, state] of states) candidateAudio[url] = state;
    const unique = Array.from(new Set([...(Array.isArray(base.candidates) ? base.candidates : []), ...bearing]));
    const ranked = rankCandidates(unique, candidateAudio).slice(0, MAX_COLLECTED_CANDIDATES);
    return {
      ...base,
      targetUrl: ranked[0],
      candidates: ranked,
      candidateAudio,
      diagnostics: { ...base.diagnostics, providerAudio: 'present', validCandidateCount: ranked.length }
    };
  }

  /**
   * resolveFrameRedGifsMedia plus the provider's audio declaration for the same clip (see above). The synchronous resolver is unchanged.
   */
  async function resolveFrameRedGifsMediaWithProvider(clickedSrc = '', options = {}) {
    const base = resolveFrameRedGifsMedia(clickedSrc, options);
    const clipId = providerClipToAsk(base);
    return clipId ? enrichWithProviderAudio(base, clipId, clickedSrc, options.requireGesture === true, options.gestureAt, options.explicit || null) : base;
  }

  // ---- Inline Save control on own-site players (REDGIFS-INLINE-01) ----
  // Every eligible `.Player` (it owns exactly one video) gets its own real <button> as its last child, so keyboard users reach it in the native tab
  // order (after the player's own focusable children) without hovering first. The button is hidden (transparent, no pointer events, but focusable) until
  // the pointer rests on its player or it takes the focus; it never covers anything while hidden. Only the top document of the provider's own site is
  // eligible (no Reddit document, no embedded /ifr/ player). Mounting, hovering and focusing do no provider or background work. A trusted activation
  // stores a one-shot target for the live player (node, source and poster evidence, document location) and sends only its token and the player's own
  // key; the worker then asks this same document to resolve THAT player (RESOLVE_FRAME_MEDIA with inlineToken), so the context-menu capture is neither
  // read nor written and the player must survive every asynchronous step unchanged.
  const INLINE = { Z: 2147483000, HOVER_MS: 60, POLL_MS: 250, SCAN_MS: 100, TOKEN_TTL: 30000, MAX_PENDING: 8, MAX_ITEMS: 100, CLICK_GAP: 1500, SIZE: 32, INSET: 8 };
  const INLINE_TOKEN = /^[a-f0-9]{32}$/;
  const inl = { items: new Map(), active: null, timer: null, scanTimer: null, poll: null, observer: null, x: 0, y: 0, moved: false, watch: false, frame: null, pending: new Map() };

  function inlineAllowed() {
    try {
      return isProviderOwnOrigin() && window.top === window && !/^\/ifr\//i.test(window.location.pathname);
    } catch (_) {
      return false;
    }
  }

  // The eligible player at a node: the `.Player` that owns exactly one connected video
  function inlinePlayerOf(node) {
    try {
      const owner = node && typeof node.closest === 'function' ? node.closest('.Player') : null;
      if (!owner || !isConnectedNode(owner)) return null;
      const videos = Array.from(owner.querySelectorAll('video')).filter(isConnectedNode);
      return videos.length === 1 ? { owner, video: videos[0] } : null;
    } catch (_) {
      return null;
    }
  }

  // The eligible player under a point. Whatever lies above it must belong to its own card (.GifPreview or .TapTracker, else the Player itself; a
  // generic parent proves nothing): an unrelated dialog, menu or navigation layer over the player owns the point, and the hidden player behind it
  // is never selected. `occluded` tells such a player apart from an empty point
  function inlinePlayerAt(x, y) {
    const stack = Array.from(document.elementsFromPoint(x, y)).slice(0, 24);
    for (let i = 0; i < stack.length; i++) {
      const player = inlinePlayerOf(stack[i]);
      if (!player) continue;
      const card = player.owner.closest('.GifPreview') || player.owner.closest('.TapTracker') || player.owner;
      const owned = stack.slice(0, i).every((el) => typeof card.contains === 'function' && card.contains(el));
      return { player: owned ? player : null, occluded: !owned };
    }
    return { player: null, occluded: false };
  }

  // The live player is still the one a control was shown for or a token was issued for: same nodes, same document location, same source and poster evidence
  function inlineHolds(t) {
    const p = t && t.video ? inlinePlayerOf(t.video) : null;
    return Boolean(p && p.owner === t.owner && p.video === t.video && inlineAllowed() && window.location.href === t.href && t.evidence && sameSourceEvidence(t.evidence, sourceEvidenceOf(t.video)));
  }

  // One-shot: a token resolves one request, once, while its player still holds
  function takeInlineTarget(token) {
    const t = typeof token === 'string' && INLINE_TOKEN.test(token) ? inl.pending.get(token) : null;
    if (!t) return null;
    inl.pending.delete(token);
    return Date.now() - t.at <= INLINE.TOKEN_TTL && inlineHolds(t) ? t : null;
  }

  const inlineRandom = (bytes) => {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') return '';
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  };

  // The refresh interval lives only while a control is visible or a player waits behind a layer
  function inlineSettle() {
    if (inl.active || inl.watch) return;
    if (inl.poll) { clearInterval(inl.poll); inl.poll = null; }
    if (inl.frame) { (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)(inl.frame); inl.frame = null; }
  }

  // Hidden = transparent and not hit-testable, still focusable
  function inlineConceal(item) {
    item.shown = null;
    item.host.style.setProperty('opacity', '0');
    item.host.style.setProperty('pointer-events', 'none');
    if (inl.active === item) inl.active = null;
    inlineSettle();
  }

  function inlineDrop(item) {
    inlineConceal(item);
    if (typeof item.host.remove === 'function') item.host.remove();
    inl.items.delete(item.owner);
  }

  // Upper-right corner of the visible part of the player (8 px inset, 32 px button), kept inside the player and the viewport while it scrolls or
  // resizes; false when the player is not visibly laid out or its visible part is smaller than the button
  function inlinePlace(item) {
    const r = typeof item.owner.getBoundingClientRect === 'function' ? item.owner.getBoundingClientRect() : null;
    if (!r || !(r.width >= 80 && r.height >= 60) || r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
    const L = Math.max(r.left, 0);
    const T = Math.max(r.top, 0);
    const R = Math.min(r.right, window.innerWidth);
    const B = Math.min(r.bottom, window.innerHeight);
    if (R - L < INLINE.SIZE || B - T < INLINE.SIZE) return false; // the visible part of the player cannot contain the button
    // Local anchoring: the host is absolutely positioned inside the player, so a scroll the compositor performs carries the control with its player
    // instead of leaving it behind at the old viewport place. The wanted viewport place is converted by measurement, not by assuming which ancestor
    // is the containing block, and the result is proven: a control that does not lie inside the visible part of its player is not shown
    const host = item.host;
    host.style.setProperty('left', '0px');
    host.style.setProperty('top', '0px');
    const origin = host.getBoundingClientRect();
    host.style.setProperty('left', `${Math.max(R - INLINE.SIZE - INLINE.INSET, L) - origin.left}px`);
    host.style.setProperty('top', `${Math.max(Math.min(T + INLINE.INSET, B - INLINE.SIZE - INLINE.INSET), T) - origin.top}px`);
    const m = host.getBoundingClientRect();
    return !(m.width > 0 && (m.left < L - 2 || m.top < T - 2 || m.right > R + 2 || m.bottom > B + 2));
  }

  // The one bounded refresh (every 250 ms, only while a control is visible or a player waits behind a layer): a changed or moved player is dropped,
  // and the pointer's place is judged again, so a layer that appears, goes or changes visibility under a stationary pointer is noticed. The control
  // the keyboard is on is never taken away by the pointer
  function inlineFollow() {
    const item = inl.active;
    if (item && (document.hidden || !item.shown || !inlineHolds(item.shown) || !inlinePlace(item))) inlineConceal(item);
  }

  function inlineTick() {
    inlineFollow();
    inlineEvaluate();
  }

  // A scroll or resize places the visible control again, at most once per frame, and only while one is visible or a player waits behind a layer
  function inlineOnViewport() {
    if ((!inl.active && !inl.watch) || inl.frame) return;
    const run = () => { inl.frame = null; inlineFollow(); };
    inl.frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
  }

  // Show the control of one player (hover or focus); at most one control is visible
  function inlineReveal(item) {
    const player = inlinePlayerOf(item.owner);
    if (!player) { inlineDrop(item); return; }
    if (inl.active && inl.active !== item) inlineConceal(inl.active);
    // A selection generation is the player with the source and poster it shows now. A changed one (the same node recycled to another clip) is a
    // request of its own: fresh throttle and duplicate key. The same one, however often the control is hidden and shown, keeps both
    const evidence = sourceEvidenceOf(player.video);
    if (!(item.gen && item.gen.video === player.video && sameSourceEvidence(item.gen.evidence, evidence))) {
      item.gen = { video: player.video, evidence };
      item.id = inlineRandom(8);
      item.busyAt = 0;
    }
    if (!(item.shown && item.shown.video === player.video && inlineHolds(item.shown))) {
      item.shown = { video: player.video, owner: item.owner, evidence, href: window.location.href };
    }
    if (!inlinePlace(item)) { inlineConceal(item); return; }
    inl.active = item;
    item.host.style.setProperty('opacity', '1');
    item.host.style.setProperty('pointer-events', 'auto');
    if (!inl.poll) inl.poll = setInterval(inlineTick, INLINE.POLL_MS);
  }

  // Decorative (aria-hidden): the button's own label names it
  function inlineIcon() {
    try {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '18');
      svg.setAttribute('height', '18');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', 'M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      return svg;
    } catch (_) {
      return null;
    }
  }

  function inlineMount(owner) {
    let item = inl.items.get(owner);
    if (item) return item;
    if (inl.items.size >= INLINE.MAX_ITEMS || !inlineRandom(1)) return null;
    const host = document.createElement('div');
    host.setAttribute('data-image-saver-inline', 'redgifs');
    for (const [k, v] of [['position', 'absolute'], ['z-index', String(INLINE.Z)], ['margin', '0'], ['padding', '0'], ['opacity', '0'], ['pointer-events', 'none']]) host.style.setProperty(k, v);
    const root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    isLabel(btn, 'aria-label', 'inline.saveClipAria', 'Image Saver: Save this clip');
    isLabel(btn, 'title', 'inline.saveClipAria', 'Image Saver: Save this clip');
    // the download icon and the single-button look of the X and Reddit inline controls (same path, colors and border), as a 32 px round button
    const icon = inlineIcon();
    if (icon) btn.appendChild(icon);
    else isLabel(btn, 'textContent', 'inline.save', 'Save');
    for (const [k, v] of [['all', 'initial'], ['box-sizing', 'border-box'], ['display', 'flex'], ['align-items', 'center'], ['justify-content', 'center'],
      ['width', `${INLINE.SIZE}px`], ['height', `${INLINE.SIZE}px`], ['border-radius', '9999px'], ['border', '1px solid rgba(255,255,255,0.55)'],
      ['background', 'rgba(15,20,25,0.78)'], ['color', '#fff'], ['cursor', 'pointer'], ['padding', '0'],
      ['font', '600 12px/1 system-ui, -apple-system, Segoe UI, sans-serif']]) btn.style.setProperty(k, v);
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'touchstart', 'touchend']) {
      btn.addEventListener(type, (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); });
    }
    item = { owner, host, btn, id: inlineRandom(8), shown: null, focused: false, busyAt: 0, busyTimer: null };
    btn.addEventListener('click', (e) => inlineOnClick(item, e), true);
    btn.addEventListener('keydown', (e) => inlineOnButtonKey(item, e), true);
    // visible focus (the reset above removes the browser's ring), and the control follows the focus
    btn.addEventListener('focus', () => {
      item.focused = true;
      btn.style.setProperty('outline', '2px solid #fff');
      btn.style.setProperty('outline-offset', '2px');
      inlineReveal(item);
    });
    btn.addEventListener('blur', () => {
      item.focused = false;
      btn.style.setProperty('outline', 'none');
      if (!inl.timer) inl.timer = setTimeout(inlineHoverTimer, INLINE.HOVER_MS);
    });
    root.appendChild(btn);
    owner.appendChild(host);
    inl.items.set(owner, item);
    return item;
  }

  // Every eligible player has its control; a recycled, removed or no longer eligible player loses it
  function inlineScan() {
    inl.scanTimer = null;
    try {
      if (!inlineAllowed()) return;
      for (const [owner, item] of Array.from(inl.items)) if (!isConnectedNode(owner) || !inlinePlayerOf(owner)) inlineDrop(item);
      for (const owner of Array.from(document.querySelectorAll('.Player')).slice(0, INLINE.MAX_ITEMS)) if (inlinePlayerOf(owner)) inlineMount(owner);
      // a page change under a resting pointer (a layer opening or closing, a recycled player) is judged against the pointer's last place
      if (inl.moved && (!inl.active || !inl.active.focused)) inlineEvaluate();
    } catch (_) {}
  }

  const inlineScheduleScan = () => { if (!inl.scanTimer) inl.scanTimer = setTimeout(inlineScan, INLINE.SCAN_MS); };

  function inlineEvaluate() {
    try {
      if (document.hidden || !inlineAllowed() || typeof document.elementsFromPoint !== 'function') {
        inl.watch = false;
        if (inl.active && !inl.active.focused) inlineConceal(inl.active);
        return;
      }
      const at = inlinePlayerAt(inl.x, inl.y);
      const item = at.player ? inlineMount(at.player.owner) : null;
      inl.watch = at.occluded; // a player behind a layer is watched until the layer goes
      if (inl.active && inl.active.focused && inl.active !== item) return; // the control the keyboard is on stays
      if (item) inlineReveal(item);
      else if (inl.active && !inl.active.focused) inlineConceal(inl.active);
      if (inl.watch && !inl.poll) inl.poll = setInterval(inlineTick, INLINE.POLL_MS);
    } catch (_) {
      inl.watch = false;
      if (inl.active && !inl.active.focused) inlineConceal(inl.active);
    } finally {
      inlineSettle(); // every exit: early returns and exceptions included
    }
  }

  function inlineHoverTimer() {
    inl.timer = null;
    inlineEvaluate();
  }

  function inlineOnMove(e) {
    if (!e || (e.pointerType && e.pointerType !== 'mouse') || !inlineAllowed()) return;
    inl.x = e.clientX;
    inl.y = e.clientY;
    inl.moved = true;
    if (!inl.timer) inl.timer = setTimeout(inlineHoverTimer, INLINE.HOVER_MS);
  }

  // Escape hides the control and leaves it: the focus is released in place, so the next Tab continues from there
  function inlineOnButtonKey(item, e) {
    if (!e || e.key !== 'Escape') return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    inlineConceal(item);
    if (typeof item.btn.blur === 'function') item.btn.blur();
  }

  function inlineOnClick(item, e) {
    if (e) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    // only a genuine mouse or keyboard activation of the control; a click the page dispatches sends nothing
    if (!e || e.isTrusted !== true) return;
    const s = item.shown;
    if (!s || !inlineHolds(s)) { inlineConceal(item); return; }
    // a repeated activation of the SAME player inside the gap is one request; another player is a request of its own
    const now = Date.now();
    if (now - item.busyAt < INLINE.CLICK_GAP) return;
    const token = inlineRandom(16);
    if (!token) return;
    item.busyAt = now;
    for (const [k, v] of inl.pending) if (now - v.at > INLINE.TOKEN_TTL) inl.pending.delete(k);
    while (inl.pending.size >= INLINE.MAX_PENDING) inl.pending.delete(inl.pending.keys().next().value);
    inl.pending.set(token, { video: s.video, owner: s.owner, evidence: s.evidence, href: s.href, at: now });
    try {
      const sent = chrome.runtime.sendMessage({ action: 'REDGIFS_INLINE_SAVE', token, player: item.id });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch (_) {
      inl.pending.delete(token);
    }
    item.btn.setAttribute('aria-busy', 'true');
    if (item.busyTimer) clearTimeout(item.busyTimer);
    item.busyTimer = setTimeout(() => { item.busyTimer = null; item.btn.removeAttribute('aria-busy'); }, INLINE.CLICK_GAP);
  }

  // Own site, top document only: nothing at all is registered on a Reddit document or an embedded player
  try {
    if (inlineAllowed() && typeof window.addEventListener === 'function') {
      window.addEventListener('pointermove', inlineOnMove, { capture: true, passive: true });
      window.addEventListener('scroll', inlineOnViewport, { capture: true, passive: true }); // capture: a scroller inside the page counts too
      window.addEventListener('resize', inlineOnViewport, { passive: true });
      if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
        inl.observer = new MutationObserver(inlineScheduleScan);
        inl.observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      inlineScheduleScan();
    }
  } catch (_) {}

  // Register frame-local message listener
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.action === 'RESOLVE_FRAME_MEDIA') {
        const failed = (e) => sendResponse({
          success: false,
          error: 'UNRESOLVED_BLOB_MEDIA',
          targetUrl: null,
          diagnostics: {
            frameId: message.frameId ?? null,
            safeFrameUrl: getSafeFrameUrl(),
            targetFound: false,
            videoCount: 0,
            videoId: null,
            videoIdSource: 'none',
            inspectedSources: ['Exception: ' + (e && e.message)],
            candidateCount: 0,
            validCandidateCount: 0,
            rejectionReasons: ['EXCEPTION_IN_FRAME']
          }
        });
        try {
          const requireGesture = message.requireGesture === true;
          let explicit = null;
          if (message.inlineToken !== undefined) {
            // an inline Save: only this extension's worker can resolve a token, and a refused token falls back to nothing (never to a gesture)
            const fromWorker = !sender || (!sender.tab && (!chrome.runtime.id || sender.id === chrome.runtime.id));
            explicit = fromWorker ? takeInlineTarget(message.inlineToken) : null;
            if (!explicit) { failed({ message: 'INLINE_TARGET_REFUSED' }); return true; }
          }
          const base = resolveFrameRedGifsMedia(message.clickedSrc, { frameId: message.frameId, requireGesture, gestureAt: message.gestureAt, explicit });
          const clipId = providerClipToAsk(base);
          // the answer is immediate unless the provider's audio declaration can change it (only then it is asynchronous)
          if (!clipId) sendResponse(base);
          else enrichWithProviderAudio(base, clipId, message.clickedSrc, requireGesture, message.gestureAt, explicit).then(sendResponse, failed);
        } catch (e) {
          failed(e);
        }
        return true;
      }
    });
  }

  // Exports for sandbox testing
  if (typeof globalThis !== 'undefined') {
    globalThis.identifyRedGifsMedia = identifyRedGifsMedia;
    globalThis.notifyRedGifsContextMenu = notifyRedGifsContextMenu;
    globalThis.resolveFrameRedGifsMedia = resolveFrameRedGifsMedia;
    globalThis.resolveFrameRedGifsMediaWithProvider = resolveFrameRedGifsMediaWithProvider;
    globalThis.findClickedVideo = findClickedVideo;
    globalThis.isAllowedRedGifsHost = isAllowedRedGifsHost;
    globalThis.isRedGifsUrl = isRedGifsUrl;
    globalThis.isValidDirectVideoUrl = isValidDirectVideoUrl;
    globalThis.extractRedGifsIdFromUrl = extractRedGifsIdFromUrl;
    globalThis.safeDecodeJsonEscapes = safeDecodeJsonEscapes;
    globalThis.rankCandidates = rankCandidates;
    globalThis.hasSilentMarker = hasSilentMarker;
    globalThis.MAX_SCRIPTS_TO_INSPECT = MAX_SCRIPTS_TO_INSPECT;
    globalThis.MAX_SCRIPT_TEXT_SIZE = MAX_SCRIPT_TEXT_SIZE;
    globalThis.MAX_TOTAL_SCRIPT_TEXT_SIZE = MAX_TOTAL_SCRIPT_TEXT_SIZE;
    globalThis.MAX_JSON_TRAVERSAL_NODES = MAX_JSON_TRAVERSAL_NODES;
    globalThis.MAX_JSON_DEPTH = MAX_JSON_DEPTH;
    globalThis.MAX_COLLECTED_CANDIDATES = MAX_COLLECTED_CANDIDATES;
    globalThis.setLastContextmenuTarget = (target, path = []) => captureGesture(target, path);
    globalThis.redgifsInlineState = inl;
  }
})();
