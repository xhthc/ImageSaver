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

  let lastContextmenuTarget = null;
  let lastContextmenuPath = [];
  let lastContextmenuTime = 0;

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
   * Locates the specific clicked video in the owning frame.
   * Does NOT select the first video globally when multiple cards exist.
   */
  function findClickedVideo(clickedSrc) {
    const isRecent = (Date.now() - lastContextmenuTime) < 15000;

    // 1. Inspect elements from composedPath (handles overlay click-traps, custom player controls)
    if (isRecent && Array.isArray(lastContextmenuPath) && lastContextmenuPath.length > 0) {
      for (const el of lastContextmenuPath) {
        if (!el || typeof el !== 'object') continue;
        if (el.tagName === 'VIDEO') {
          return el;
        }
        if (el.matches && el.matches(PLAYER_CARD_SELECTOR) && el.querySelector) {
          const videoInCard = el.querySelector('video');
          if (videoInCard) return videoInCard;
        }
      }
    }

    // 2. From contextmenu target if available
    if (lastContextmenuTarget && isRecent) {
      if (lastContextmenuTarget.tagName === 'VIDEO') {
        return lastContextmenuTarget;
      }
      // Check real player/card ancestor (without stopping at generic div)
      const card = lastContextmenuTarget.closest ? lastContextmenuTarget.closest(PLAYER_CARD_SELECTOR) : null;
      if (card && card.querySelector) {
        const cardVideo = card.querySelector('video');
        if (cardVideo) return cardVideo;
      }

      // Check direct children or siblings
      if (lastContextmenuTarget.querySelector) {
        const childVideo = lastContextmenuTarget.querySelector('video');
        if (childVideo) return childVideo;
      }
      const parent = lastContextmenuTarget.parentElement;
      if (parent && parent.querySelector) {
        const siblingVideo = parent.querySelector('video');
        if (siblingVideo) return siblingVideo;
      }
    }

    // 3. Exact match by clickedSrc in document
    const videos = typeof document !== 'undefined' && document.querySelectorAll ? Array.from(document.querySelectorAll('video')) : [];
    if (clickedSrc) {
      for (const v of videos) {
        if (v.currentSrc === clickedSrc || v.src === clickedSrc) {
          return v;
        }
      }
    }

    // 4. Fallback: single video in frame
    if (videos.length === 1) {
      return videos[0];
    }

    // Multiple videos exist and none matched clicked target -> do NOT guess first video
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
    window.addEventListener('mousedown', (event) => {
      if (event && event.button === 2) {
        lastContextmenuTarget = event.target;
        lastContextmenuPath = typeof event.composedPath === 'function' ? event.composedPath() : [];
        lastContextmenuTime = Date.now();
        notifyRedGifsContextMenu(lastContextmenuTarget, lastContextmenuPath, event.timeStamp);
      }
    }, true);

    window.addEventListener('contextmenu', (event) => {
      lastContextmenuTarget = event.target;
      lastContextmenuPath = typeof event.composedPath === 'function' ? event.composedPath() : [];
      lastContextmenuTime = Date.now();
      notifyRedGifsContextMenu(lastContextmenuTarget, lastContextmenuPath, event.timeStamp);
    }, true);
  }

  /**
   * Helper to check if a URL matches a videoId case-insensitively.
   */
  function matchesVideoId(candidateUrl, videoId, isSingleVideo) {
    if (!candidateUrl) return false;
    if (videoId) {
      const urlLower = candidateUrl.toLowerCase();
      const idLower = videoId.toLowerCase();
      if (urlLower.includes(idLower)) return true;
      const extracted = extractRedGifsIdFromUrl(candidateUrl);
      if (extracted && extracted.toLowerCase() === idLower) return true;
      return false;
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

    const targetVideo = findClickedVideo(clickedSrc);

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

        // B. Regex fallback
        if (rawCandidates.length < MAX_COLLECTED_CANDIDATES) {
          const urlMatches = decoded.match(/https?:\/\/[a-zA-Z0-9_.-]*redgifs\.com\/[^"'\s<>\\]+\.(?:mp4|webm|mov|m4v)/gi) || [];
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
    if (!response || response.ok !== true) return { ok: false };
    const declared = Number(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : NaN);
    if (Number.isFinite(declared) && declared > PROVIDER_MAX_BYTES) return { ok: false };
    const text = await response.text();
    if (typeof text !== 'string' || text.length > PROVIDER_MAX_BYTES) return { ok: false };
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch (_) {
      return { ok: false };
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

  // The clip id to ask the provider about, or '' when the answer cannot change the choice: not a success, positive audio evidence already in the
  // page, a selected rendition that is not the muted one, no valid clip id, a frame that is not the provider's own origin.
  function providerClipToAsk(base) {
    if (!base || base.success !== true || !base.diagnostics) return '';
    const clipId = typeof base.diagnostics.videoId === 'string' ? base.diagnostics.videoId.replace(/-(?:mobile|silent|poster)$/i, '').toLowerCase() : '';
    const evidence = base.candidateAudio || {};
    if (Object.keys(evidence).some((u) => evidence[u] === 'present')) return '';
    if (!hasSilentMarker(base.targetUrl) || !PROVIDER_CLIP_ID.test(clipId) || !isProviderOwnOrigin() || typeof fetch !== 'function') return '';
    return clipId;
  }

  async function enrichWithProviderAudio(base, clipId, clickedSrc) {
    const evidence = base.candidateAudio || {};
    const hrefBefore = window.location.href;
    const docBefore = typeof document !== 'undefined' ? document : null;
    const videoBefore = findClickedVideo(clickedSrc);
    const srcBefore = videoBefore ? (videoBefore.src || '') : '';
    const currentSrcBefore = videoBefore ? (videoBefore.currentSrc || '') : '';

    const checkContinuity = () => {
      if (window.location.href !== hrefBefore) return false;
      if (typeof document !== 'undefined' && docBefore && document !== docBefore) return false;
      if (videoBefore) {
        if (findClickedVideo(clickedSrc) !== videoBefore) return false;
        if (typeof videoBefore.isConnected === 'boolean' && !videoBefore.isConnected) return false;
        if ((videoBefore.src || '') !== srcBefore) return false;
        if ((videoBefore.currentSrc || '') !== currentSrcBefore) return false;
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
    return clipId ? enrichWithProviderAudio(base, clipId, clickedSrc) : base;
  }

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
          const base = resolveFrameRedGifsMedia(message.clickedSrc, { frameId: message.frameId });
          const clipId = providerClipToAsk(base);
          // the answer is immediate unless the provider's audio declaration can change it (only then it is asynchronous)
          if (!clipId) sendResponse(base);
          else enrichWithProviderAudio(base, clipId, message.clickedSrc).then(sendResponse, failed);
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
    globalThis.setLastContextmenuTarget = (target, path = []) => {
      lastContextmenuTarget = target;
      lastContextmenuPath = Array.isArray(path) ? path : (target ? [target] : []);
      lastContextmenuTime = Date.now();
    };
  }
})();
