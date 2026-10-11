// content_booru.js - Lightweight DOM metadata collector for Danbooru family
(() => {
  // DEBUG-MENU-01: the shared journal client (lib/debug_journal.js); a no-op when it is absent. Outcomes only: never the copied link.
  const DBG = (globalThis.ImageSaverDebug && globalThis.ImageSaverDebug.client('content')) || { log() {} };
  DBG.log('booru', 'init', 'info');
  const DANBOORU_SUPPORTED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'webm', 'mp4']);
  const CONTEXT_TTL_MS = 5000;

  let lastBooruMetadata = null;
  let lastBooruTimestamp = 0;
  let lastBooruTargetUrl = '';

  /**
   * Helper: extracts 32-character hexadecimal MD5 from a URL string.
   */
  function extractMd5FromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const m = url.match(/[a-f0-9]{32}/i);
    return m ? m[0].toLowerCase() : null;
  }

  /**
   * Helper: validates whether an extension is supported.
   */
  function isWhitelistedBooruExt(ext) {
    if (!ext || typeof ext !== 'string') return false;
    return DANBOORU_SUPPORTED_EXTS.has(ext.trim().toLowerCase());
  }

  /**
   * Extracts metadata from a Danbooru post container (article.post-preview or section#image-container).
   */
  function extractDanbooruDomMetadata(target, locationHref) {
    if (!target) return null;

    const el = target.nodeType === 1 ? target : target.parentElement;
    if (!el || typeof el.closest !== 'function') return null;

    const container = el.closest('article.post-preview, section#image-container');
    if (!container || typeof container.getAttribute !== 'function') return null;

    let fileUrl = (container.getAttribute('data-file-url') || '').trim();
    if (!fileUrl) return null;

    // Resolve relative URL against page origin/href if necessary
    const baseHref = locationHref || (typeof window !== 'undefined' && window.location ? window.location.href : 'https://danbooru.donmai.us/');
    let resolvedUrl = fileUrl;
    try {
      resolvedUrl = new URL(fileUrl, baseHref).href;
    } catch (_) {
      return null;
    }

    let fileExt = (container.getAttribute('data-file-ext') || '').trim().toLowerCase();
    if (!fileExt && resolvedUrl) {
      try {
        const p = new URL(resolvedUrl).pathname;
        const dot = p.lastIndexOf('.');
        if (dot !== -1) {
          fileExt = p.substring(dot + 1).toLowerCase();
        }
      } catch (_) {}
    }

    if (!isWhitelistedBooruExt(fileExt)) {
      return null;
    }

    const flags = (container.getAttribute('data-flags') || '').toLowerCase();
    const isVideo = fileExt === 'webm' || fileExt === 'mp4';
    const isAnimated = isVideo || fileExt === 'gif' || flags.includes('animated');
    const md5 = (container.getAttribute('data-md5') || '').trim().toLowerCase() || null;
    const postId = (container.getAttribute('data-id') || '').trim() || null;

    return {
      engine: 'danbooru',
      originalUrl: resolvedUrl,
      fileExt,
      isAnimated: Boolean(isAnimated),
      isVideo: Boolean(isVideo),
      md5,
      postId
    };
  }

  /**
   * Tells the background what the selected item's original is (its own post container says so, whatever the preview looks
   * like), so the menu label of this click can be truthful. The background accepts it only for the asset of the current click.
   */
  function notifyMenuKind(meta, targetUrl, at) {
    if (!meta) return;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: 'BOORU_MEDIA_CONTEXTMENU_DETECTED', fileExt: meta.fileExt, targetUrl, gestureAt: Number.isFinite(at) ? at : undefined }).catch(() => {});
      }
    } catch (_) {}
  }

  function rememberTarget(event) {
    const target = event.target;
    const meta = extractDanbooruDomMetadata(target, window.location?.href);
    if (meta) {
      lastBooruMetadata = meta;
      lastBooruTimestamp = Date.now();
      lastBooruTargetUrl = (target && (target.currentSrc || target.src || (target.tagName === 'A' ? target.href : '') || (target.querySelector && (target.querySelector('img, video')?.src || target.querySelector('img, video')?.currentSrc)))) || '';
      notifyMenuKind(meta, lastBooruTargetUrl, event.timeStamp);
      if (event.type === 'contextmenu') DBG.log('booru.menu', 'detected', 'info', undefined, () => ({ host: lastBooruTargetUrl, kind: meta && meta.fileExt ? String(meta.fileExt) : undefined }));
    } else {
      lastBooruMetadata = null;
      lastBooruTimestamp = 0;
      lastBooruTargetUrl = '';
    }
  }

  // Listen for contextmenu events in capture phase to capture element before bubbling stops; the right-press does the same a
  // moment earlier, so the label is ready before the native menu is built.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('mousedown', (event) => { if (event && event.button === 2) rememberTarget(event); }, true);
    window.addEventListener('contextmenu', rememberTarget, true);
  }

  // Runtime message listener for background script query
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.action === 'GET_BOORU_DOM_METADATA') {
        const now = Date.now();
        if (!lastBooruMetadata || (now - lastBooruTimestamp > CONTEXT_TTL_MS)) {
          sendResponse({ success: false, reason: 'EXPIRED_OR_UNAVAILABLE' });
          return false;
        }
        if (message.clickedUrl && lastBooruTargetUrl) {
          const reqUrl = String(message.clickedUrl).trim();
          const storedUrl = String(lastBooruTargetUrl).trim();
          if (reqUrl !== storedUrl) {
            const reqMd5 = extractMd5FromUrl(reqUrl);
            const storedMd5 = extractMd5FromUrl(storedUrl);
            if (!reqMd5 || !storedMd5 || reqMd5 !== storedMd5) {
              sendResponse({ success: false, reason: 'TARGET_MISMATCH' });
              return false;
            }
          }
        }
        sendResponse({ success: true, metadata: lastBooruMetadata });
        return false;
      }
    });
  }

  // Export functions to global scope for testing
  if (typeof globalThis !== 'undefined') {
    globalThis.extractDanbooruDomMetadata = extractDanbooruDomMetadata;
    globalThis.isWhitelistedBooruExt = isWhitelistedBooruExt;
    globalThis.extractBooruMd5FromUrl = extractMd5FromUrl;
  }
})();
