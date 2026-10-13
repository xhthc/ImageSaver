// Classic worker module; imported at the original initialization boundary.
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
 * Extracts RedGIFs video identifier from watch, ifr, media, or detail pathnames.
 */
function extractRedGifsIdFromUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const trimmed = urlStr.trim();
  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
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

/**
 * Validates direct RedGIFs video candidates.
 * Rejects blob:, data:, javascript:, non-HTTPS, lookalikes, and non-video media.
 */
function validateRedGifsCandidateUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    return { valid: false, error: 'INVALID_URL' };
  }
  const trimmed = urlStr.trim();
  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) {
    return { valid: false, error: 'DISALLOWED_SCHEME' };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    return { valid: false, error: 'MALFORMED_URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'NON_HTTPS' };
  }
  if (!isAllowedRedGifsHost(parsed.hostname)) {
    return { valid: false, error: 'DISALLOWED_HOSTNAME' };
  }
  const pathname = parsed.pathname.toLowerCase();
  const isVideoExt = /\.(mp4|webm|mov|m4v)$/i.test(pathname);
  const queryFormat = parsed.searchParams.get('format') || parsed.searchParams.get('type');
  const isVideoQuery = queryFormat && /^(mp4|webm|video\/)/i.test(queryFormat.trim());
  if (!isVideoExt && !isVideoQuery) {
    return { valid: false, error: 'UNRECOGNIZED_MEDIA_TYPE' };
  }
  return { valid: true, url: trimmed };
}

/**
 * RedGIFs names the muted rendition of a clip `<Id>-silent.<ext>`. A negative marker only: it never proves the clip has no sound,
 * and a name without it never proves that a file carries an audio track.
 */
function isRedGifsSilentVariantUrl(urlStr) {
  try {
    return /-silent\.(?:mp4|webm|mov|m4v)$/i.test(new URL(urlStr).pathname);
  } catch (_) {
    return false;
  }
}

function redGifsClipKey(urlStr) {
  const id = typeof extractRedGifsIdFromUrl === 'function' ? extractRedGifsIdFromUrl(urlStr) : null;
  return id ? id.toLowerCase() : null;
}

/**
 * Resolves frame-local media (such as RedGIFs embeds with page-owned blob URLs).
 * Uses info.frameId and communicates with the owning frame's content script.
 * Never fetches blob: URLs in the service worker.
 */
async function resolveFrameLocalMediaImpl(options = {}) {
  const {
    tabId = null,
    frameId = 0,
    clickedSrc = '',
    pageUrl = '',
    linkUrl = null,
    mediaType = 'video',
    documentId = '',
    requireGesture = false,
    gestureAt = null,
    inlineToken = ''
  } = options;

  if (!tabId) {
    return {
      success: false,
      error: 'UNRESOLVED_BLOB_MEDIA',
      diagnostics: { inspectedSources: ['No active tabId provided'] }
    };
  }

  const targetFrameId = typeof frameId === 'number' ? frameId : 0;
  // A caller that proved one document of the frame (an inline embed save) pins the request to it: a frame that navigated meanwhile does not answer.
  const sendOptions = { frameId: targetFrameId };
  if (typeof documentId === 'string' && documentId) sendOptions.documentId = documentId;
  let response = null;

  try {
    // 1. Try sending message to content script in the owning frame
    response = await chrome.tabs.sendMessage(
      tabId,
      { action: 'RESOLVE_FRAME_MEDIA', clickedSrc, pageUrl, linkUrl, mediaType, frameId: targetFrameId, ...(requireGesture ? { requireGesture: true, gestureAt } : {}), ...(inlineToken ? { inlineToken } : {}) },
      sendOptions
    );
  } catch (msgErr) {
    // 2. If content script is not yet active in this frame, inject content/content_redgifs.js and retry
    if (chrome.scripting?.executeScript) {
      try {
        await chrome.scripting.executeScript({
          target: sendOptions.documentId ? { tabId, documentIds: [sendOptions.documentId] } : { tabId, frameIds: [targetFrameId] },
          injectImmediately: true,
          files: ['lib/debug_journal.js', 'lib/i18n.js', 'content/content_redgifs.js'] // the journal client and the label catalogue first (DEBUG-MENU-01, UI-LOCALIZATION-01)
        });
        response = await chrome.tabs.sendMessage(
          tabId,
          { action: 'RESOLVE_FRAME_MEDIA', clickedSrc, pageUrl, linkUrl, mediaType, frameId: targetFrameId, ...(requireGesture ? { requireGesture: true, gestureAt } : {}), ...(inlineToken ? { inlineToken } : {}) },
          sendOptions
        );
      } catch (injectErr) {
        console.warn('[MediaLatch] Не удалось внедрить content/content_redgifs.js во фрейм ' + targetFrameId + ':', injectErr);
      }
    }
  }

  // RG-03: what the frame learned from the provider's own clip declaration (a fixed code only, never page, provider or session data)
  const providerNote = response && response.diagnostics ? response.diagnostics.providerAudio : null;
  if (typeof providerNote === 'string' && /^(?:present|[A-Z_]{3,24})$/.test(providerNote)) {
    console.log('[MediaLatch] RedGIFs provider audio:', providerNote);
  }

  if (response && response.success && response.targetUrl) {
    const validated = validateRedGifsCandidateUrl(response.targetUrl);
    if (validated.valid) {
      // Page-declared audio evidence, trusted only for a validated direct URL of the clip the frame itself resolved.
      const clipId = typeof response.diagnostics?.videoId === 'string' ? redGifsClipKey(`https://media.redgifs.com/${response.diagnostics.videoId}.mp4`) : null;
      const candidateAudio = {};
      if (clipId && response.candidateAudio && typeof response.candidateAudio === 'object') {
        for (const url of Object.keys(response.candidateAudio).slice(0, 20)) {
          const state = response.candidateAudio[url];
          if ((state === 'present' || state === 'absent') && validateRedGifsCandidateUrl(url).valid && redGifsClipKey(url) === clipId) {
            candidateAudio[url] = state;
          }
        }
      }
      const targetState = candidateAudio[validated.url] || 'unknown';
      // an inline Save must receive a file of the very clip the frame says it resolved
      if (inlineToken && !(clipId && redGifsClipKey(validated.url) === clipId)) {
        console.warn('[MediaLatch] Inline RedGIFs answer does not name its selected clip: refused');
        return { success: false, error: 'UNRESOLVED_BLOB_MEDIA', diagnostics: response.diagnostics || {} };
      }
      return {
        success: true,
        targetUrl: validated.url,
        clipId,
        candidateAudio,
        audio: targetState === 'present' && !isRedGifsSilentVariantUrl(validated.url) ? 'present' : targetState,
        // Same-clip direct renditions in the frame's own ranked order (the target first), for existing same-asset absence progression.
        sameClipUrls: clipId && Array.isArray(response.candidates)
          ? response.candidates.filter((u) => typeof u === 'string' && validateRedGifsCandidateUrl(u).valid && redGifsClipKey(u) === clipId).slice(0, 8)
          : [],
        diagnostics: response.diagnostics || {}
      };
    } else {
      console.warn('[MediaLatch] Кандидат RedGIFs отклонен валидатором:', validated.error, sanitizeUrlForLog(response.targetUrl));
      return {
        success: false,
        error: 'UNRESOLVED_BLOB_MEDIA',
        validationError: validated.error,
        diagnostics: response.diagnostics || {}
      };
    }
  }

  return {
    success: false,
    error: 'UNRESOLVED_BLOB_MEDIA',
    // no document answered at all (gone, replaced, or not able to run the script): not a refusal by the frame
    ...(response ? {} : { noAnswer: true }),
    diagnostics: response?.diagnostics || { inspectedSources: ['No response from frame ' + targetFrameId] }
  };
}

/**
 * Strict validator for candidate URLs recovered on Reddit.
 * Only permits valid HTTPS URLs on recognized Reddit CDN domains.
 * Rejects stream manifests (.mpd, .m3u8), non-HTTPS schemes, and non-Reddit hosts.
 */
function validateRedditCandidateUrl(candidateUrl) {
  if (!candidateUrl || typeof candidateUrl !== 'string') {
    return { valid: false, error: 'EMPTY_URL' };
  }
  const trimmed = candidateUrl.trim();
  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) {
    return { valid: false, error: 'DISALLOWED_SCHEME' };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    return { valid: false, error: 'INVALID_URL_STRUCTURE' };
  }
  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'NON_HTTPS_SCHEME' };
  }
  const hostname = parsed.hostname.toLowerCase();
  const isAllowedRedditHost = (
    hostname === 'v.redd.it' ||
    hostname === 'packaged-media.redd.it' ||
    hostname === 'i.redd.it' ||
    hostname === 'preview.redd.it' ||
    hostname === 'external-preview.redd.it' ||
    hostname === 'reddit.com' ||
    hostname.endsWith('.reddit.com') ||
    hostname.endsWith('.redd.it')
  );
  if (!isAllowedRedditHost) {
    return { valid: false, error: 'DISALLOWED_HOST' };
  }

  const pathname = parsed.pathname.toLowerCase();
  if (pathname.endsWith('.mpd') || pathname.endsWith('.m3u8')) {
    return { valid: false, error: 'STREAM_MANIFEST_NOT_DIRECT_MEDIA' };
  }

  return { valid: true, url: trimmed };
}

/**
 * Dedicated frame-local resolver for Reddit blob videos.
 * Communicates with content/content_reddit.js in the owning frame and validates candidates.
 */
async function resolveRedditFrameBlobMedia({ tabId, frameId, clickedSrc, pageUrl, linkUrl, mediaType }) {
  const targetFrameId = typeof frameId === 'number' ? frameId : 0;
  let response = null;

  try {
    // 1. Try sending message to content/content_reddit.js in the owning frame
    response = await chrome.tabs.sendMessage(
      tabId,
      { action: 'RESOLVE_REDDIT_BLOB_MEDIA', clickedSrc, pageUrl, linkUrl, mediaType, frameId: targetFrameId },
      { frameId: targetFrameId }
    );
  } catch (msgErr) {
    // 2. If content script is not yet active in this frame, inject content/content_reddit.js and retry
    if (chrome.scripting?.executeScript) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [targetFrameId] },
          injectImmediately: true,
          files: ['lib/debug_journal.js', 'lib/i18n.js', 'content/content_reddit.js'] // the journal client and the label catalogue first (DEBUG-MENU-01, UI-LOCALIZATION-01)
        });
        response = await chrome.tabs.sendMessage(
          tabId,
          { action: 'RESOLVE_REDDIT_BLOB_MEDIA', clickedSrc, pageUrl, linkUrl, mediaType, frameId: targetFrameId },
          { frameId: targetFrameId }
        );
      } catch (injectErr) {
        console.warn('[MediaLatch Reddit] Не удалось внедрить content/content_reddit.js во фрейм ' + targetFrameId + ':', injectErr);
      }
    }
  }

  // An HLS-only player of the selected post: the canonical master address the frame read from the selected player, validated again here
  if (response && response.success && response.hls && !response.targetUrl) {
    const master = redditHlsMasterUrl(response.hls.url);
    return master
      ? { success: true, redditHls: { url: master.url, assetId: master.assetId }, diagnostics: response.diagnostics || {} }
      : { success: false, error: 'UNRESOLVED_BLOB_MEDIA', reason: 'UNSUPPORTED_STREAM', diagnostics: response.diagnostics || {} };
  }

  if (response && response.success && response.targetUrl) {
    const validated = validateRedditCandidateUrl(response.targetUrl);
    if (validated.valid) {
      return {
        success: true,
        targetUrl: validated.url,
        media: response.media || null,
        diagnostics: response.diagnostics || {}
      };
    } else {
      console.warn('[MediaLatch Reddit] Кандидат Reddit отклонен валидатором:', validated.error, sanitizeUrlForLog(response.targetUrl));
      return {
        success: false,
        error: 'UNRESOLVED_BLOB_MEDIA',
        validationError: validated.error,
        diagnostics: response.diagnostics || {}
      };
    }
  }

  return {
    success: false,
    error: response?.error || 'UNRESOLVED_BLOB_MEDIA',
    reason: response?.reason || 'NO_DIRECT_MEDIA_FOUND',
    diagnostics: response?.diagnostics || { inspectedSources: ['No response from Reddit frame ' + targetFrameId] }
  };
}

let lastVideoProbeResult = null;

/**
 * Detailed network probe for video availability and authorization check.
 * Strictly separate from image probeCandidate() — never relaxes image verification rules.
 * Uses credentials: 'include' to share the browser profile's active session context.
 */
async function probeVideoUrlDetails(candidateUrl) {
  if (!candidateUrl || typeof candidateUrl !== 'string') {
    return { ok: false, status: 0, requiresAuth: false, error: 'INVALID_URL' };
  }
  if (candidateUrl.startsWith('blob:')) {
    return { ok: false, status: 0, requiresAuth: false, error: 'BLOB_URL_NOT_PROBEABLE' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    let res = await fetch(candidateUrl, {
      method: 'HEAD',
      credentials: 'include',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    // HEAD refused (405/403) or answered 503 by a CDN that still serves GET (as for images in probeCandidate): ask for 1 byte.
    if (res.status === 405 || res.status === 403 || res.status === 503) {
      const getController = new AbortController();
      const getTimeoutId = setTimeout(() => getController.abort(), 3500);
      res = await fetch(candidateUrl, {
        method: 'GET',
        headers: { 'Range': 'bytes=0-0' },
        credentials: 'include',
        signal: getController.signal
      });
      clearTimeout(getTimeoutId);
      await cancelResponseBody(res);
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        requiresAuth: true,
        error: res.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN'
      };
    }

    if (res.ok || res.status === 206) {
      const rawContentType = res.headers.get('content-type') || '';
      const contentType = rawContentType.toLowerCase().split(';')[0].trim();
      const isGenericBinary = contentType === 'application/octet-stream' || contentType === 'binary/octet-stream';

      // Explicitly reject HTML, JSON, DASH manifests, and HLS manifests
      const isHtml = contentType.startsWith('text/html') || contentType.startsWith('application/xhtml+xml');
      const isDash = contentType === 'application/dash+xml' || contentType === 'application/xml' || contentType === 'text/xml' || (typeof isDashManifestUrl === 'function' && isDashManifestUrl(candidateUrl));
      const isHls = contentType === 'application/vnd.apple.mpegurl' || contentType === 'application/x-mpegurl' || (typeof isHlsManifestUrl === 'function' && isHlsManifestUrl(candidateUrl));
      const isJson = contentType.startsWith('application/json');

      if (isHtml || isDash || isHls || isJson) {
        return {
          ok: false,
          status: res.status,
          requiresAuth: false,
          error: 'UNACCEPTABLE_CONTENT',
          contentType
        };
      }

      // Check if URL has an explicit direct video extension
      let hasVideoExt = false;
      try {
        const p = new URL(candidateUrl).pathname.toLowerCase();
        hasVideoExt = /\.(mp4|webm|ogv|mov|m4v)$/i.test(p);
      } catch (_) {}

      // Do not claim verified MP4 bytes from hostname alone on extensionless endpoints
      // when content-type is generic binary or missing.
      const isAcceptable =
        contentType.startsWith('video/') ||
        (hasVideoExt && isGenericBinary) ||
        (hasVideoExt && contentType === '');

      if (isAcceptable) {
        return {
          ok: true,
          status: res.status,
          contentType: contentType || (hasVideoExt && /\.webm/i.test(candidateUrl) ? 'video/webm' : 'video/mp4'),
          requiresAuth: false,
          mimeEvidence: MIME_EVIDENCE.HTTP_RESPONSE,
          verifiedUrl: candidateUrl
        };
      }

      // If generic binary or empty without a video extension (e.g. extensionless v.redd.it or a /stream/42 endpoint
      // behind a video element), verify actual MP4 container magic bytes instead of trusting the URL or host:
      if ((isGenericBinary || contentType === '') && !hasVideoExt) {
        try {
          const byteCheck = await verifyMp4ContainerBytes(candidateUrl);
          if (byteCheck && byteCheck.ok) {
            return {
              ok: true,
              status: res.status,
              contentType: 'video/mp4',
              requiresAuth: false,
              mimeEvidence: MIME_EVIDENCE.SNIFFED,
              verifiedUrl: candidateUrl
            };
          }
        } catch (_) {}
      }
    }

    let errorType = 'UNACCEPTABLE_CONTENT';
    if (res.status === 404) errorType = 'NOT_FOUND';
    else if (res.status === 410) errorType = 'GONE';
    else if (res.status === 429) errorType = 'RATE_LIMIT';

    return {
      ok: false,
      status: res.status,
      requiresAuth: false,
      error: errorType
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      requiresAuth: false,
      error: err?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
    };
  }
}

/**
 * Cancels any unconsumed response body stream to prevent socket leaks and memory waste.
 */
async function cancelResponseBody(res) {
  if (!res || !res.body) return;
  try {
    if (typeof res.body.cancel === 'function') {
      await res.body.cancel();
    } else if (typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      await reader.cancel();
    }
  } catch (_) {}
}

async function fetchResolverMetadata(url, { timeoutMs = 3500, text = false, ...init } = {}) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  const limit = (text ? 8 : 2) * 1024 * 1024;
  let response, reader;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok || Number(response.headers?.get('content-length')) > limit ||
        typeof response.body?.getReader !== 'function') return null;
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) return null;
      if (done) break;
      size += value.byteLength;
      if (size > limit) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder().decode(bytes);
    return text ? body : JSON.parse(body);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(deadline);
    controller.abort();
    if (reader) {
      try { await reader.cancel(); } catch (_) {}
    } else {
      await cancelResponseBody(response);
    }
  }
}

/**
 * Bounded verification of MP4 container magic bytes (ISO BMFF ftyp box header).
 * Inspects initial bytes via bounded Range request, reading only the bytes needed to validate MP4,
 * aborting and canceling safely with a single active deadline through fetch, byte collection, and cleanup.
 * Strictly avoids unbounded arrayBuffer() fallback.
 */
async function verifyMp4ContainerBytes(videoUrl) {
  if (!videoUrl || typeof videoUrl !== 'string') {
    return { ok: false, error: 'INVALID_URL' };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);
  let reader = null;
  try {
    const res = await fetch(videoUrl, {
      method: 'GET',
      headers: { 'Range': 'bytes=0-511' },
      credentials: 'include',
      signal: controller.signal
    });

    if (!res.ok && res.status !== 206) {
      await cancelResponseBody(res);
      return { ok: false, error: 'HTTP_' + res.status, status: res.status };
    }

    let bytes = null;
    if (res.body && typeof res.body.getReader === 'function') {
      reader = res.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      while (totalBytes < 512) {
        if (controller.signal.aborted) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        const readPromise = reader.read();
        const abortPromise = new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
        const chunkRes = await Promise.race([readPromise, abortPromise]);
        if (chunkRes.done) break;
        if (chunkRes.value && chunkRes.value.byteLength > 0) {
          chunks.push(chunkRes.value);
          totalBytes += chunkRes.value.byteLength;
          if (totalBytes >= 12) {
            let currentBytes;
            if (chunks.length === 1) {
              currentBytes = chunks[0];
            } else {
              currentBytes = new Uint8Array(totalBytes);
              let off = 0;
              for (const c of chunks) {
                currentBytes.set(c, off);
                off += c.byteLength;
              }
            }
            if (sniffMediaMagicBytes(currentBytes) === 'video/mp4') {
              bytes = currentBytes;
              break; // Read only the bytes needed to validate MP4!
            }
          }
        }
      }
      if (!bytes && totalBytes > 0) {
        if (chunks.length === 1) {
          bytes = chunks[0];
        } else {
          bytes = new Uint8Array(totalBytes);
          let off = 0;
          for (const c of chunks) {
            bytes.set(c, off);
            off += c.byteLength;
          }
        }
      }
    } else if (res.status === 206 && typeof res.arrayBuffer === 'function') {
      const contentLength = parseInt(res.headers?.get?.('content-length') || '0', 10);
      if (contentLength > 0 && contentLength <= 1024) {
        const buf = await res.arrayBuffer();
        bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 512));
      } else {
        await cancelResponseBody(res);
        return { ok: false, error: 'RANGE_PAYLOAD_TOO_LARGE' };
      }
    } else {
      // Server returned status 200 (ignored Range) without a readable stream:
      // Calling arrayBuffer() would download the entire file unbounded. Reject!
      await cancelResponseBody(res);
      return { ok: false, error: 'RANGE_IGNORED_WITHOUT_STREAM' };
    }

    if (!bytes || bytes.length < 8) {
      return { ok: false, error: 'INSUFFICIENT_BYTES' };
    }

    const sniffedMime = sniffMediaMagicBytes(bytes);
    if (sniffedMime !== 'video/mp4') {
      return { ok: false, error: 'INVALID_CONTAINER_BYTES', sniffedMime };
    }

    return { ok: true, sniffedMime };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' || controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timeoutId);
    if (reader) {
      try { await reader.cancel(); } catch (_) {}
    }
  }
}

/**
 * Helper: validates that an ordinary X video URL belongs to the intended Twitter/X video CDN (e.g. video.twimg.com).
 * Enforces HTTPS scheme and authorized host boundaries before performing network probe or download.
 */
function isValidXVideoCdnUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    const h = parsed.hostname.toLowerCase();
    return h === 'video.twimg.com' || h.endsWith('.twimg.com');
  } catch (_) {
    return false;
  }
}

/**
 * Self-contained extraction function executed in the page's MAIN execution world via chrome.scripting.executeScript.
 * Inspects React fiber and props directly attached to DOM elements on X.com without requiring external services or tokens.
 * Requires a demonstrable match to the target post and media item; avoids unsafe global DOM fallbacks.
 */
function extractXPostVideoInMainWorld(params) {
  const { tweetId, postUrl, posterUrl, mediaIdHint, mediaIndex, isQuoteTweet, x, y } = params || {};
  // Diagnostics for a failed recovery (X-06): enums and counters only, never an id, an address, a property value or page state.
  // The caller bounds and re-validates it (sanitizeXRecoveryDiag) because this runs next to page scripts.
  const diag = { how: 'none', point: 'none', quote: isQuoteTweet ? 1 : 0, req: 0, id: 'none', sel: 'none', media: 0, seen: 0, variants: 0, mp4: 0, hls: 0, fibers: 0, foreign: 0, edge: 0, unwrap: 0, rtMiss: 0 };
  const outcome = (() => {

  function isValidCdn(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const parsed = new URL(urlStr);
      if (parsed.protocol !== 'https:') return false;
      const h = parsed.hostname.toLowerCase();
      return h === 'video.twimg.com' || h.endsWith('.twimg.com');
    } catch (_) {
      return false;
    }
  }

  function getReactProps(el) {
    if (!el) return null;
    const key = Object.keys(el).find(k => k.startsWith('__reactProps$'));
    return key ? el[key] : null;
  }

  function getReactFiber(el) {
    if (!el) return null;
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    return key ? el[key] : null;
  }

  function extractMediaFromTweet(tweet) {
    if (!tweet || typeof tweet !== 'object') return [];
    if (Array.isArray(tweet.extended_entities?.media)) return tweet.extended_entities.media;
    if (Array.isArray(tweet.legacy?.extended_entities?.media)) return tweet.legacy.extended_entities.media;
    if (tweet.result) return extractMediaFromTweet(tweet.result);
    if (tweet.tweet) return extractMediaFromTweet(tweet.tweet);
    return [];
  }

  function selectMedia(mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0) return null;
    const videoItems = mediaList.filter(m => m && (m.video_info || m.type === 'video' || m.type === 'animated_gif'));
    if (videoItems.length === 0) { diag.sel = 'no-video'; return null; }

    // 1. If mediaIdHint is provided, require exact ID match; never fall through to default index on mismatch
    if (mediaIdHint) {
      const match = videoItems.find(item => String(item.id_str || item.id) === String(mediaIdHint));
      diag.sel = match && match.video_info ? 'hint' : 'hint-miss';
      return (match && match.video_info) ? match : null;
    }

    // 2. If posterUrl is provided, check for embedded ID or matching media URL
    if (posterUrl && typeof posterUrl === 'string') {
      const cleanPoster = posterUrl.split('?')[0].toLowerCase();
      const idMatch = cleanPoster.match(/\/(?:ext_tw_video_thumb|amplify_video_thumb|media)\/(\d+)/i);
      if (idMatch && idMatch[1]) {
        const targetId = idMatch[1];
        const matchById = videoItems.find(item => {
          const mid = String(item.id_str || item.id || '');
          return mid === targetId || mid === `media_${targetId}` || mid.endsWith(targetId);
        });
        if (matchById && matchById.video_info) { diag.sel = 'poster-id'; return matchById; }
      }

      const match = videoItems.find(item => {
        const u = (item.media_url_https || item.media_url || '').split('?')[0].toLowerCase();
        return u && (cleanPoster.includes(u) || u.includes(cleanPoster));
      });
      if (match && match.video_info) { diag.sel = 'poster-url'; return match; }

      // Poster was explicitly specified but failed to match any item
      if (videoItems.length > 1) {
        diag.sel = 'poster-ambiguous';
        return null; // Ambiguous in multi-video post
      }
    }

    // 3. Positional mediaIndex (only if valid and no contradicting ID/poster)
    if (typeof mediaIndex === 'number' && mediaIndex >= 0 && mediaIndex < videoItems.length) {
      diag.sel = videoItems[mediaIndex]?.video_info ? 'index' : 'index-miss';
      return videoItems[mediaIndex]?.video_info ? videoItems[mediaIndex] : null;
    }

    // 4. Single video item in post (unambiguous)
    if (videoItems.length === 1 && videoItems[0].video_info) {
      diag.sel = 'single';
      return videoItems[0];
    }

    return null;
  }

  function inspectVariants(videoInfo) {
    if (!videoInfo || !Array.isArray(videoInfo.variants) || videoInfo.variants.length === 0) {
      return { ok: false, isHlsOnly: false, error: 'NO_VARIANTS' };
    }

    const mp4Variants = videoInfo.variants.filter(v => {
      if (!v || !v.url || typeof v.url !== 'string') return false;
      const ct = (v.content_type || '').toLowerCase();
      const u = v.url.toLowerCase();
      if (u.includes('.m3u8') || ct.includes('mpegurl')) return false;
      return ct === 'video/mp4' || u.includes('.mp4');
    });

    diag.variants = videoInfo.variants.length;
    diag.mp4 = mp4Variants.length;
    if (mp4Variants.length > 0) {
      mp4Variants.sort((a, b) => {
        const rateA = typeof a.bitrate === 'number' ? a.bitrate : 0;
        const rateB = typeof b.bitrate === 'number' ? b.bitrate : 0;
        return rateB - rateA;
      });
      return { ok: true, bestMp4: mp4Variants[0] };
    }

    // Check if variants actually establish HLS-only
    const hasHls = videoInfo.variants.some(v => {
      if (!v || !v.url || typeof v.url !== 'string') return false;
      const ct = (v.content_type || '').toLowerCase();
      const u = v.url.toLowerCase();
      return u.includes('.m3u8') || ct.includes('mpegurl');
    });

    diag.hls = hasHls ? 1 : 0;
    if (hasHls) {
      return { ok: false, isHlsOnly: true, error: 'HLS_ONLY' };
    }

    return { ok: false, isHlsOnly: false, error: 'UNSUPPORTED_VARIANTS' };
  }

  function parseStatusIdFromUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    try {
      const u = new URL(urlStr, 'https://x.com');
      const m = u.pathname.match(/\/status(?:es)?\/(\d+)(?:\/|$)/i);
      return m ? m[1] : null;
    } catch (_) {
      const m = urlStr.match(/\/status(?:es)?\/(\d+)(?:\/|[?#]|$)/i);
      return m ? m[1] : null;
    }
  }

  function getTweetId(tweetObj) {
    if (!tweetObj || typeof tweetObj !== 'object') return null;
    const id = tweetObj.id_str || tweetObj.id || tweetObj.rest_id;
    return id ? String(id) : null;
  }

  // A feed repost may expose the reshare's props while its visible status/player belongs to the original.
  // Unwrap only the explicit retweet/result wrappers and require that original's exact established DOM owner ID.
  // Never follow quoted_status or treat matching URLs/ID-less metadata as permission to cross owners.
  function getOwnedTweet(tweet, expectedId) {
    if (!expectedId) return tweet;
    let current = tweet;
    let sawRetweet = false;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
      if (getTweetId(current) === expectedId) {
        if (current !== tweet) diag.unwrap++;
        return current;
      }
      const retweeted = current.retweeted_status || current.legacy?.retweeted_status ||
        current.retweeted_status_result?.result || current.legacy?.retweeted_status_result?.result;
      if (retweeted) sawRetweet = true;
      current = retweeted || (!getTweetId(current) ? (current.result || current.tweet) : null);
    }
    // Counts only (X-06 diagnostics): a retweet association existed but did not lead to the established owner.
    if (sawRetweet) diag.rtMiss++;
    return tweet; // Existing foreign-owner refusal remains authoritative when no exact original is found.
  }

  function isAttributionAnchor(a) {
    if (!a) return false;
    const href = a.href || (a.getAttribute && a.getAttribute('href')) || '';
    if (/\/status(?:es)?\/\d+\/video\//i.test(href)) return true;
    if (a.closest && a.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"], video')) return true;
    return false;
  }

  function findQuoteContainer(el, outerArt) {
    if (!el) return null;
    if (outerArt && typeof outerArt.contains === 'function' && !outerArt.contains(el)) return null;
    for (let p = el, depth = 0; p && p !== outerArt && depth < 40; p = p.parentElement, depth++) {
      const role = typeof p.getAttribute === 'function' ? p.getAttribute('role') : null;
      if (p.tagName === 'ARTICLE' || role === 'blockquote' || p.getAttribute?.('data-testid') === 'quoteTweet') return p;
      if (p.tagName === 'DIV' && typeof p.getAttribute === 'function' && p.getAttribute('role') === 'link') {
        if (/\/status(?:es)?\/\d+/.test(p.getAttribute('data-href') || '') || (typeof p.querySelector === 'function' && p.querySelector('[data-testid="User-Name"]'))) return p;
      }
    }
    return null;
  }

  function extractStatusIdsFromContainer(container, isQuote, hintId) {
    if (!container) return [];
    const ids = [];
    const selfHref = container.getAttribute && container.getAttribute('data-href');
    if (selfHref) {
      const sid = parseStatusIdFromUrl(selfHref);
      if (sid && !ids.includes(sid)) ids.push(sid);
    }
    let anchors = [];
    if (container.querySelectorAll) {
      if (hintId) {
        anchors = Array.from(container.querySelectorAll(`a[href*="/status/${hintId}"], a[href*="/status/"], a`));
      } else {
        anchors = Array.from(container.querySelectorAll('a[href*="/status/"], a'));
      }
    }
    if (anchors.length === 0 && container.querySelector) {
      if (hintId) {
        const single = container.querySelector(`a[href*="/status/${hintId}"], a[href*="/status/"], a`);
        if (single) anchors = [single];
      } else {
        const single = container.querySelector('a[href*="/status/"], a');
        if (single) anchors = [single];
      }
    }
    for (const a of anchors) {
      if (findQuoteContainer(a, container)) continue;
      if (container.tagName === 'ARTICLE' && a.closest) {
        const aArt = a.closest('article');
        if (aArt && aArt !== container) continue;
      }
      if (isAttributionAnchor(a)) continue;
      const rawHref = a.href || (a.getAttribute && a.getAttribute('href')) || '';
      const sid = parseStatusIdFromUrl(rawHref);
      if (sid && !ids.includes(sid)) {
        ids.push(sid);
      }
    }
    return ids;
  }

  function getAuthoritativeStatusId(container, isQuote, hintId) {
    if (!container) return null;
    const selfHref = container.getAttribute && container.getAttribute('data-href');
    if (selfHref) {
      const sid = parseStatusIdFromUrl(selfHref);
      if (sid) return sid;
    }
    let timeAnchors = [];
    if (container.querySelectorAll) {
      timeAnchors = Array.from(container.querySelectorAll('a:has(time), a[href*="/status/"], a'));
    }
    for (const a of timeAnchors) {
      if (findQuoteContainer(a, container)) continue;
      if (container.tagName === 'ARTICLE' && a.closest) {
        const aArt = a.closest('article');
        if (aArt && aArt !== container) continue;
      }
      if (isAttributionAnchor(a)) continue;
      const hasTime = a.querySelector ? Boolean(a.querySelector('time')) : (a.innerHTML ? a.innerHTML.includes('<time') : false);
      if (hasTime) {
        const sid = parseStatusIdFromUrl(a.href || (a.getAttribute && a.getAttribute('href')));
        if (sid) return sid;
      }
    }
    const allIds = extractStatusIdsFromContainer(container, isQuote, hintId);
    return allIds.length === 1 ? allIds[0] : null;
  }

  function getTweetIdFromNode(node, isQuote) {
    if (!node) return null;
    const p = getReactProps(node);
    if (p) {
      const t = isQuote ? (p.tweet?.quoted_status || p.tweet?.quoted_status_result?.result?.legacy || p.tweet) : p.tweet;
      const tid = getTweetId(t);
      if (tid) return tid;
    }
    const f = getReactFiber(node);
    if (f) {
      const mp = f.memoizedProps;
      if (mp) {
        const t = isQuote ? (mp.tweet?.quoted_status || mp.tweet?.quoted_status_result?.result?.legacy || mp.tweet) : mp.tweet;
        const tid = getTweetId(t);
        if (tid) return tid;
      }
    }
    return null;
  }

  function extractMediaIdFromUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    const clean = urlStr.split('?')[0];
    const m = clean.match(/\/(?:ext_tw_video_thumb|amplify_video_thumb|ext_tw_video|amplify_video|media)\/(\d+)/i);
    return m ? m[1] : null;
  }

  // X-QUOTE-06: a quote card without its own permalink (the only status link in it is the video's attribution) carries its post on the
  // component fibers that render the card, not on the card's DOM node. The owner is the post of the nearest such fiber directly above the
  // card's own host fiber, and only when: the selected media id is one of that post's own media; every other post up to the outer article
  // is that same post or one that explicitly quotes it (or reposts a post that quotes it); and at least one does. Another owner on the way,
  // no quoting post, no media id or a media mismatch leaves the owner unknown (null). Bounded like the other fiber walks.
  // A wrapper is this card's own only when it is not a quote container itself and contains no other one (only this card, its ancestors
  // up to the wrapper and what the card itself contains).
  function holdsOtherCard(node, card, outerArt) {
    if (findQuoteContainer(node, outerArt) === node) return true;
    const cards = typeof node.querySelectorAll === 'function'
      ? Array.from(node.querySelectorAll('article, div[role="link"], [data-testid="quoteTweet"], [role="blockquote"]')) : [];
    if (cards.length > 64) return true; // too much to prove it holds nothing else: not this card's wrapper
    return cards.some((c) => c !== card && !(typeof c.contains === 'function' && c.contains(card)) && !(typeof card.contains === 'function' && card.contains(c)) &&
      findQuoteContainer(c, outerArt) === c);
  }

  function quoteOwnerFromCardFibers(card, outerArt, mediaId) {
    if (!card || !outerArt || !mediaId) return null;
    const quotedIdOf = (t) => getTweetId(t?.quoted_status) || getTweetId(t?.quoted_status_result?.result) ||
      getTweetId(t?.quoted_status_result?.result?.tweet) || getTweetId(t?.legacy?.quoted_status_result?.result);
    const host = getReactFiber(card);
    let owner = null;
    let quotedBy = false;
    let f = host ? host.return : null;
    for (let depth = 0; f && depth < 60; f = f.return, depth++) {
      diag.fibers++;
      const node = f.stateNode && typeof f.stateNode === 'object' && f.stateNode.nodeType === 1 ? f.stateNode : null;
      if (node) {
        // X-QUOTE-07: the quote's own post may render wrapper elements around the card (observed: one DIV at fiber depth 9 before the post
        // at 11/12). Before the owner is known, a DOM element passed on the way may only be such a wrapper: an ancestor of this card inside
        // the outer article that is not a card itself and holds no other card. A sibling, an outside element or another card's container ends it.
        if (!owner && !(node !== outerArt && typeof node.contains === 'function' && node.contains(card) && outerArt.contains(node) && !holdsOtherCard(node, card, outerArt))) return null;
        if (node === outerArt) return owner && quotedBy ? owner : null;
        if (node.tagName === 'ARTICLE' || node.tagName === 'BODY' || node.tagName === 'HTML') return null;
        continue;
      }
      const t = f.memoizedProps && f.memoizedProps.tweet;
      const tid = getTweetId(t);
      if (!tid) continue;
      if (!owner) {
        if (!extractMediaFromTweet(t).some((m) => m && String(m.id_str || m.id || '') === mediaId)) return null;
        owner = tid;
        continue;
      }
      if (tid === owner) continue;
      const inner = t.retweeted_status || t.retweeted_status_result?.result || t.legacy?.retweeted_status_result?.result;
      if (quotedIdOf(t) === owner || quotedIdOf(inner) === owner) { quotedBy = true; continue; }
      return null; // another post owns this part of the tree: ambiguous
    }
    return null; // The cap or an incomplete fiber chain leaves ancestors unverified.
  }

  const knownMediaIds = [];
  const knownVariantUrls = [];

  function recordVerifiedTweet(t) {
    if (!t || typeof t !== 'object') return;
    const tid = getTweetId(t);
    if (targetTweetId && tid && tid !== targetTweetId) return;

    // Require exact target-tweet identity or independently verified media ownership before seeding evidence
    const isExactTargetTweet = Boolean(targetTweetId && tid === targetTweetId);
    const mList = extractMediaFromTweet(t);
    diag.media += mList.length;
    for (const m of mList) {
      if (!m || typeof m !== 'object') continue;
      const mid = String(m.id_str || m.id || '');

      let isVerified = isExactTargetTweet;
      if (!isVerified && targetTweetId) {
        let foundSid = null;
        if (m.expanded_url) foundSid = parseStatusIdFromUrl(m.expanded_url);
        if (!foundSid && m.url) foundSid = parseStatusIdFromUrl(m.url);
        if (foundSid && foundSid === targetTweetId) {
          isVerified = true;
        } else if (mid && knownMediaIds.includes(mid)) {
          isVerified = true;
        }
      }

      if (!isVerified) continue;

      if (m.id_str && !knownMediaIds.includes(String(m.id_str))) knownMediaIds.push(String(m.id_str));
      if (m.id && !knownMediaIds.includes(String(m.id))) knownMediaIds.push(String(m.id));
      if (m.video_info?.variants) {
        for (const v of m.video_info.variants) {
          if (v && v.url && typeof v.url === 'string') {
            if (!knownVariantUrls.includes(v.url)) knownVariantUrls.push(v.url);
            const vmid = extractMediaIdFromUrl(v.url);
            if (vmid && !knownMediaIds.includes(vmid)) knownMediaIds.push(vmid);
          }
        }
      }
    }
  }

  function isMediaOwnedByTweet(mediaItem, expectedId, contextTweetId) {
    diag.seen++;
    if (!mediaItem || typeof mediaItem !== 'object') return false;
    if (!expectedId) return false;

    let foundSid = null;
    if (mediaItem.expanded_url) {
      foundSid = parseStatusIdFromUrl(mediaItem.expanded_url);
    }
    if (!foundSid && mediaItem.url) {
      foundSid = parseStatusIdFromUrl(mediaItem.url);
    }

    if (foundSid) {
      return foundSid === expectedId;
    }

    if (contextTweetId && contextTweetId === expectedId) {
      return true;
    }

    const mid = String(mediaItem.id_str || mediaItem.id || '');
    if (mid && knownMediaIds.includes(mid)) {
      return true;
    }

    return false;
  }

  function isVideoInfoOwned(videoInfo, contextTweet) {
    if (!videoInfo || !Array.isArray(videoInfo.variants) || videoInfo.variants.length === 0) {
      return false;
    }
    const cTid = getTweetId(contextTweet);
    if (cTid && targetTweetId && cTid === targetTweetId) {
      return true;
    }
    for (const v of videoInfo.variants) {
      if (!v || !v.url || typeof v.url !== 'string') continue;
      if (knownVariantUrls.includes(v.url)) return true;
      const vmid = extractMediaIdFromUrl(v.url);
      if (vmid && knownMediaIds.includes(vmid)) return true;
    }
    return false;
  }

  const idFromPostUrl = parseStatusIdFromUrl(postUrl);
  const requestedTweetId = tweetId ? String(tweetId) : (idFromPostUrl ? String(idFromPostUrl) : null);
  diag.req = requestedTweetId ? 1 : 0;
  let targetEl = null;
  let postContainer = null;

  // 1. Locate starting element and target post container via coordinates
  if (typeof x === 'number' && typeof y === 'number' && typeof document.elementFromPoint === 'function') {
    const el = document.elementFromPoint(x, y);
    diag.point = el ? 'no-article' : 'no-element';
    if (el) {
      let candidateContainer = null;
      let outerArticle = null;
      if (el.closest) {
        outerArticle = el.closest('article[data-testid="tweet"], article[role="article"]') || el.closest('article');
        for (let up = outerArticle?.parentElement && outerArticle.parentElement.closest('article'); up; up = up.parentElement && up.parentElement.closest('article')) {
          outerArticle = up;
        }
      }
      if (isQuoteTweet) {
        candidateContainer = findQuoteContainer(el, outerArticle);
      } else {
        candidateContainer = outerArticle;
      }

      if (candidateContainer) {
        diag.point = 'article';
        if (isQuoteTweet) {
          const outerStatusIds = outerArticle ? extractStatusIdsFromContainer(outerArticle, false, requestedTweetId) : [];
          const outerReactId = outerArticle ? getTweetIdFromNode(outerArticle, false) : null;
          const quoteStatusIds = extractStatusIdsFromContainer(candidateContainer, true, requestedTweetId);
          const quoteReactId = getTweetIdFromNode(candidateContainer, true);

          if (requestedTweetId) {
            const matchesQuote = quoteStatusIds.includes(requestedTweetId) || quoteReactId === requestedTweetId;
            const matchesOuter = outerStatusIds.includes(requestedTweetId) || outerReactId === requestedTweetId;
            const hasOuterConflict = (outerReactId && outerReactId !== requestedTweetId) || (outerStatusIds.length > 0 && !outerStatusIds.includes(requestedTweetId));
            const hasQuoteConflict = (quoteReactId && quoteReactId !== requestedTweetId) || (quoteStatusIds.length > 0 && !quoteStatusIds.includes(requestedTweetId));

            if (!matchesQuote && !matchesOuter && (hasOuterConflict || hasQuoteConflict)) {
              // Clicked quote demonstrably belongs to a different post!
              diag.point = 'conflict';
              return { ok: false, error: 'TARGET_POST_NOT_FOUND' };
            }
          }
          postContainer = candidateContainer;
          targetEl = el;
        } else {
          const candidateStatusIds = extractStatusIdsFromContainer(candidateContainer, false, requestedTweetId);
          const candidateReactId = getTweetIdFromNode(candidateContainer, false) || getTweetIdFromNode(el, false);
          const candidateId = candidateReactId || getAuthoritativeStatusId(candidateContainer, false, requestedTweetId);

          if (requestedTweetId) {
            const hasExactMatch = candidateStatusIds.includes(requestedTweetId) || candidateReactId === requestedTweetId;
            const hasExplicitConflict = (candidateId && candidateId !== requestedTweetId) ||
              (candidateStatusIds.length > 0 && !candidateStatusIds.includes(requestedTweetId));

            if (hasExplicitConflict) {
              // Clicked element demonstrably belongs to another post! Fail closed.
              diag.point = 'conflict';
              return { ok: false, error: 'TARGET_POST_NOT_FOUND' };
            }
            if (hasExactMatch) {
              postContainer = candidateContainer;
              targetEl = el;
            }
          } else {
            postContainer = candidateContainer;
            targetEl = el;
          }
        }
      }
    }
  }

  if (postContainer) diag.how = 'point';
  // 2. If coordinates didn't resolve postContainer, locate by exact status ID match
  if (!postContainer && requestedTweetId) {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"], article[role="article"], article'));
    for (const art of articles) {
      if (isQuoteTweet) {
        const qContainers = [];
        const legacyQ = art.querySelector ? art.querySelector('[data-testid="quoteTweet"], [role="blockquote"]') : null;
        if (legacyQ) qContainers.push(legacyQ);
        if (art.querySelectorAll) {
          const nestedArts = Array.from(art.querySelectorAll('article')).filter(a => a !== art);
          for (const na of nestedArts) if (!qContainers.includes(na)) qContainers.push(na);
          const roleLinks = Array.from(art.querySelectorAll('div[role="link"]'));
          for (const rl of roleLinks) {
            if (findQuoteContainer(rl, art) === rl && !qContainers.includes(rl)) qContainers.push(rl);
          }
        }
        let matchedQuote = null;
        for (const qContainer of qContainers) {
          const qIds = extractStatusIdsFromContainer(qContainer, true, requestedTweetId);
          const qReactId = getTweetIdFromNode(qContainer, true);
          if (qIds.includes(requestedTweetId) || qReactId === requestedTweetId) {
            matchedQuote = qContainer;
            break;
          }
        }
        if (matchedQuote) {
          postContainer = matchedQuote;
          targetEl = matchedQuote;
          break;
        }
      } else {
        const artIds = extractStatusIdsFromContainer(art, false, requestedTweetId);
        const artReactId = getTweetIdFromNode(art, false);
        if (artIds.includes(requestedTweetId) || artReactId === requestedTweetId) {
          postContainer = art;
          targetEl = art;
          break;
        }
      }
    }
  }

  if (postContainer && diag.how === 'none') diag.how = 'status';
  // 2b. If coordinates and tweetId didn't resolve postContainer, locate by poster URL or media ID match
  if (!postContainer && (posterUrl || mediaIdHint)) {
    const cleanPoster = posterUrl ? posterUrl.split('?')[0].toLowerCase() : null;
    const targetMid = mediaIdHint ? String(mediaIdHint) : (cleanPoster ? extractMediaIdFromUrl(cleanPoster) : null);
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"], article[role="article"], article'));
    for (const art of articles) {
      let matchedInArticle = false;
      let matchedMedia = null;
      if (cleanPoster) {
        const videos = art.querySelectorAll ? Array.from(art.querySelectorAll('video')) : [];
        for (const videoEl of videos) {
          const vPoster = (videoEl.getAttribute('poster') || videoEl.poster || '').split('?')[0].toLowerCase();
          if (vPoster && (vPoster === cleanPoster || vPoster.includes(cleanPoster) || cleanPoster.includes(vPoster))) {
            matchedInArticle = true;
            matchedMedia = videoEl;
            break;
          }
        }
        if (!matchedInArticle) {
          const imgs = art.querySelectorAll ? Array.from(art.querySelectorAll('img')) : [];
          for (const img of imgs) {
            const iSrc = (img.currentSrc || img.src || '').split('?')[0].toLowerCase();
            if (iSrc && (iSrc === cleanPoster || iSrc.includes(cleanPoster) || cleanPoster.includes(iSrc))) {
              matchedInArticle = true;
              matchedMedia = img;
              break;
            }
          }
        }
      }
      if (!matchedInArticle && targetMid) {
        const mediaEls = art.querySelectorAll ? Array.from(art.querySelectorAll('video, img, [style*="background"]')) : [];
        for (const mEl of mediaEls) {
          const u = (mEl.getAttribute('poster') || mEl.poster || mEl.currentSrc || mEl.src || mEl.getAttribute('style') || '');
          if (u.includes(targetMid)) {
            matchedInArticle = true;
            matchedMedia = mEl;
            break;
          }
        }
      }
      if (!matchedInArticle && targetMid) {
        const p = getReactProps(art);
        const t = p?.tweet;
        const mList = extractMediaFromTweet(t);
        if (mList.some(m => String(m.id_str || m.id) === targetMid)) {
          matchedInArticle = true;
        }
      }
      if (matchedInArticle) {
        if (isQuoteTweet) {
          const qContainer = matchedMedia && findQuoteContainer(matchedMedia, art);
          if (!qContainer) continue;
          postContainer = qContainer;
          targetEl = matchedMedia;
        } else {
          if (matchedMedia && findQuoteContainer(matchedMedia, art)) continue;
          postContainer = art;
          targetEl = matchedMedia || art;
        }
        break;
      }
    }
  }

  if (postContainer && diag.how === 'none') diag.how = 'poster';
  // Strict check: if no post container found that demonstrably matches, FAIL
  // NEVER fall back to document.querySelector('video') or document.querySelector('article')!
  if (!postContainer) {
    return { ok: false, error: 'TARGET_POST_NOT_FOUND' };
  }

  if (!targetEl) targetEl = postContainer;

  // Determine authoritative targetTweetId for this postContainer
  let targetTweetId = null;
  if (isQuoteTweet) {
    const quoteReactId = getTweetIdFromNode(postContainer, true);
    const quoteStatusIds = extractStatusIdsFromContainer(postContainer, true, requestedTweetId);
    targetTweetId = quoteStatusIds[0] || quoteReactId || null;
    if (!targetTweetId && requestedTweetId) {
      const outerArt = postContainer.closest ? (postContainer.closest('article[data-testid="tweet"], article[role="article"]') || postContainer.closest('article')) : null;
      const outerArtId = outerArt ? (getTweetIdFromNode(outerArt, false) || getAuthoritativeStatusId(outerArt, false, requestedTweetId)) : null;
      if (requestedTweetId !== outerArtId) {
        targetTweetId = requestedTweetId;
      }
    }
    if (!targetTweetId && !requestedTweetId) {
      const outerArt = postContainer.closest ? (postContainer.closest('article[data-testid="tweet"], article[role="article"]') || postContainer.closest('article')) : null;
      targetTweetId = quoteOwnerFromCardFibers(postContainer, outerArt, mediaIdHint ? String(mediaIdHint) : (posterUrl ? extractMediaIdFromUrl(posterUrl) : null));
    }
  } else {
    targetTweetId = requestedTweetId ||
      getAuthoritativeStatusId(postContainer, false, requestedTweetId) ||
      getTweetIdFromNode(postContainer, false) ||
      null;
  }

  diag.id = requestedTweetId ? 'req' : (targetTweetId ? 'dom' : 'none');
  // Fail closed if identity is ambiguous for quote tweet
  if (isQuoteTweet && !targetTweetId) {
    return { ok: false, error: 'TARGET_POST_NOT_FOUND' };
  }

  // Pre-seed trustworthy media evidence from params and postContainer
  const hintMediaId = mediaIdHint ? String(mediaIdHint) : (posterUrl ? extractMediaIdFromUrl(posterUrl) : null);
  if (hintMediaId && !knownMediaIds.includes(hintMediaId)) knownMediaIds.push(hintMediaId);

  // BUGFIX-MULTISITE-01: found by status or poster because the point missed (a batch item outside the viewport or under the page's
  // own header), the container's own node carries no post data. Start from the selected item's own media element inside it: the
  // one showing the hinted media id, else (no id) the player at the descriptor's position. Never a nested card's media.
  if (targetEl === postContainer && typeof postContainer.querySelectorAll === 'function') {
    const ownedMedia = Array.from(postContainer.querySelectorAll('video, img')).filter(m => !findQuoteContainer(m, postContainer));
    let item = null;
    if (hintMediaId) {
      item = ownedMedia.find((m) =>
        extractMediaIdFromUrl((m.getAttribute && m.getAttribute('poster')) || m.poster || m.currentSrc || m.src || '') === hintMediaId) || null;
    } else if (typeof mediaIndex === 'number') {
      item = ownedMedia.filter(m => m.tagName === 'VIDEO')[mediaIndex] || null;
    }
    if (item) targetEl = item;
  }

  const domPoster = !posterUrl && postContainer.querySelector ? (postContainer.querySelector('video')?.getAttribute('poster') || postContainer.querySelector('video')?.poster) : null;
  const domMediaId = domPoster ? extractMediaIdFromUrl(domPoster) : null;
  if (domMediaId && !knownMediaIds.includes(domMediaId)) knownMediaIds.push(domMediaId);

  let outerArtBoundary = isQuoteTweet && postContainer.closest ? (postContainer.closest('article[data-testid="tweet"], article[role="article"]') || postContainer.closest('article')) : null;
  for (let up = outerArtBoundary?.parentElement?.closest?.('article'); up; up = up.parentElement?.closest?.('article')) outerArtBoundary = up;
  const walkBoundary = outerArtBoundary || postContainer;

  function getTargetTweet(tweet) {
    const owned = getOwnedTweet(tweet, targetTweetId);
    if (!isQuoteTweet || getTweetId(owned) === targetTweetId) return owned;
    return getOwnedTweet(tweet?.quoted_status || tweet?.quoted_status_result?.result?.legacy || tweet, targetTweetId);
  }

  // Pre-pass: scan from targetEl up to postContainer to record any verified tweet props
  let scanNode = targetEl;
  while (scanNode) {
    const p = getReactProps(scanNode);
    if (p) {
      const t = getTargetTweet(p.tweet);
      const tid = getTweetId(t) || getTweetId(p.tweet);
      if (!targetTweetId || !tid || tid === targetTweetId) {
        recordVerifiedTweet(t);
      }
    }
    const f = getReactFiber(scanNode);
    let sf = f;
    let sDepth = 0;
    while (sf && sDepth < 30) {
      // Bound fiber traversal to walkBoundary
      if (sf.stateNode && typeof sf.stateNode === 'object' && sf.stateNode.nodeType === 1) {
        const node = sf.stateNode;
        if (node.tagName === 'ARTICLE' && node !== walkBoundary && node !== postContainer) break;
        if (node.tagName === 'BODY' || node.tagName === 'HTML') break;
        if (walkBoundary.contains && !walkBoundary.contains(node) && node !== walkBoundary) break;
      }

      if (sf.memoizedProps) {
        const mp = sf.memoizedProps;
        const t = getTargetTweet(mp.tweet);
        const tid = getTweetId(t) || getTweetId(mp.tweet);
        if (targetTweetId && tid && tid !== targetTweetId) {
          break;
        }
        recordVerifiedTweet(t);
      }
      if (sf.stateNode === walkBoundary) break;
      sf = sf.return;
      sDepth++;
    }
    if (scanNode === walkBoundary) break;
    if (scanNode.tagName === 'ARTICLE' && scanNode !== walkBoundary && scanNode !== postContainer) break;
    if (scanNode.tagName === 'BODY' || scanNode.tagName === 'HTML') break;
    scanNode = scanNode.parentElement;
  }

  // 2. Search React fiber & props tree within the walkBoundary
  let curr = targetEl;
  let confirmedHls = false;
  let foundAnyVariants = false;
  let lastVariantError = 'UNSUPPORTED_VARIANTS';

  while (curr) {
    const props = getReactProps(curr);
    if (props) {
      const tweet = getTargetTweet(props.tweet);
      const tid = getTweetId(tweet) || getTweetId(props.tweet);

      if (targetTweetId && tid && tid !== targetTweetId) {
        // Belongs to another tweet; do not inspect
        diag.foreign++;
        break;
      }

      if (tweet && (!targetTweetId || !tid || tid === targetTweetId)) {
        recordVerifiedTweet(tweet);
        const mediaList = extractMediaFromTweet(tweet).filter(m => isMediaOwnedByTweet(m, targetTweetId, tid));
        if (mediaList.length > 0) {
          const matched = selectMedia(mediaList);
          if (matched?.video_info) {
            foundAnyVariants = true;
            const res = inspectVariants(matched.video_info);
            if (res.ok && res.bestMp4) {
              if (!isValidCdn(res.bestMp4.url)) return { ok: false, error: 'INVALID_CDN_HOST' };
              return { ok: true, mp4Url: res.bestMp4.url, bitrate: res.bestMp4.bitrate };
            }
            if (res.isHlsOnly) confirmedHls = true;
            if (res.error) lastVariantError = res.error;
          }
        }
      }

      if (props.media?.video_info) {
        if (isMediaOwnedByTweet(props.media, targetTweetId, tid)) {
          foundAnyVariants = true;
          const res = inspectVariants(props.media.video_info);
          if (res.ok && res.bestMp4) {
            if (!isValidCdn(res.bestMp4.url)) return { ok: false, error: 'INVALID_CDN_HOST' };
            return { ok: true, mp4Url: res.bestMp4.url, bitrate: res.bestMp4.bitrate };
          }
          if (res.isHlsOnly) confirmedHls = true;
          if (res.error) lastVariantError = res.error;
        }
      }

      if (props.videoInfo) {
        if (isVideoInfoOwned(props.videoInfo, tweet || props.tweet)) {
          foundAnyVariants = true;
          const res = inspectVariants(props.videoInfo);
          if (res.ok && res.bestMp4) {
            if (!isValidCdn(res.bestMp4.url)) return { ok: false, error: 'INVALID_CDN_HOST' };
            return { ok: true, mp4Url: res.bestMp4.url, bitrate: res.bestMp4.bitrate };
          }
          if (res.isHlsOnly) confirmedHls = true;
          if (res.error) lastVariantError = res.error;
        }
      }
    }

    const fiber = getReactFiber(curr);
    let f = fiber;
    let depth = 0;
    while (f && depth < 30) {
      diag.fibers++;
      // Bound fiber traversal to walkBoundary
      if (f.stateNode && typeof f.stateNode === 'object' && f.stateNode.nodeType === 1) {
        const node = f.stateNode;
        if (node.tagName === 'ARTICLE' && node !== walkBoundary && node !== postContainer) { diag.edge++; break; }
        if (node.tagName === 'BODY' || node.tagName === 'HTML') { diag.edge++; break; }
        if (walkBoundary.contains && !walkBoundary.contains(node) && node !== walkBoundary) { diag.edge++; break; }
      }

      const fProps = f.memoizedProps;
      if (fProps) {
        const fTweet = getTargetTweet(fProps.tweet);
        const fTid = getTweetId(fTweet) || getTweetId(fProps.tweet);

        // If fiber reaches props for another tweet, stop climbing!
        if (targetTweetId && fTid && fTid !== targetTweetId) {
          diag.foreign++;
          break;
        }

        if (fTweet && (!targetTweetId || !fTid || fTid === targetTweetId)) {
          recordVerifiedTweet(fTweet);
          const mediaList = extractMediaFromTweet(fTweet).filter(m => isMediaOwnedByTweet(m, targetTweetId, fTid));
          if (mediaList.length > 0) {
            const matched = selectMedia(mediaList);
            if (matched?.video_info) {
              foundAnyVariants = true;
              const res = inspectVariants(matched.video_info);
              if (res.ok && res.bestMp4) {
                if (!isValidCdn(res.bestMp4.url)) return { ok: false, error: 'INVALID_CDN_HOST' };
                return { ok: true, mp4Url: res.bestMp4.url, bitrate: res.bestMp4.bitrate };
              }
              if (res.isHlsOnly) confirmedHls = true;
              if (res.error) lastVariantError = res.error;
            }
          }
        }

        if (fProps.media?.video_info) {
          if (isMediaOwnedByTweet(fProps.media, targetTweetId, fTid)) {
            foundAnyVariants = true;
            const res = inspectVariants(fProps.media.video_info);
            if (res.ok && res.bestMp4) {
              if (!isValidCdn(res.bestMp4.url)) return { ok: false, error: 'INVALID_CDN_HOST' };
              return { ok: true, mp4Url: res.bestMp4.url, bitrate: res.bestMp4.bitrate };
            }
            if (res.isHlsOnly) confirmedHls = true;
            if (res.error) lastVariantError = res.error;
          }
        }

        if (fProps.videoInfo) {
          if (isVideoInfoOwned(fProps.videoInfo, fTweet || fProps.tweet)) {
            foundAnyVariants = true;
            const res = inspectVariants(fProps.videoInfo);
            if (res.ok && res.bestMp4) {
              if (!isValidCdn(res.bestMp4.url)) return { ok: false, error: 'INVALID_CDN_HOST' };
              return { ok: true, mp4Url: res.bestMp4.url, bitrate: res.bestMp4.bitrate };
            }
            if (res.isHlsOnly) confirmedHls = true;
            if (res.error) lastVariantError = res.error;
          }
        }
      }

      if (f.stateNode === walkBoundary) break;
      f = f.return;
      depth++;
    }

    // Do NOT walk into another post or out of walkBoundary
    if (curr === walkBoundary) break;
    if (curr.tagName === 'ARTICLE' && curr !== walkBoundary && curr !== postContainer) break;
    if (curr.tagName === 'BODY' || curr.tagName === 'HTML') break;
    curr = curr.parentElement;
  }

  if (confirmedHls) {
    return { ok: false, isHlsOnly: true, error: 'HLS_ONLY' };
  }
  if (foundAnyVariants) {
    return { ok: false, isHlsOnly: false, error: lastVariantError };
  }
  return { ok: false, error: 'METADATA_NOT_FOUND' };
  })();
  outcome.diag = diag;
  return outcome;
}

// X-06: why an owned-MP4 recovery failed, as a bounded, enum/count-only record. The MAIN-world function runs beside page scripts, so
// its answer is untrusted: only these keys, only these values, counters clamped. Nothing from the page (ids, addresses, props).
const X_RECOVERY_DIAG_ENUMS = {
  how: ['none', 'point', 'status', 'poster'],
  point: ['none', 'no-element', 'no-article', 'article', 'conflict'],
  id: ['none', 'req', 'dom'],
  sel: ['none', 'no-video', 'hint', 'hint-miss', 'poster-id', 'poster-url', 'poster-ambiguous', 'index', 'index-miss', 'single']
};
const X_RECOVERY_DIAG_COUNTS = ['media', 'seen', 'variants', 'mp4', 'hls', 'fibers', 'foreign', 'edge', 'unwrap', 'rtMiss'];
const X_RECOVERY_DETAILS = ['no-script-result', 'script-threw', 'no-script-api'];
const X_RECOVERY_ERRORS = ['NO_VARIANTS', 'HLS_ONLY', 'UNSUPPORTED_VARIANTS', 'TARGET_POST_NOT_FOUND', 'INVALID_CDN_HOST', 'METADATA_NOT_FOUND', 'INVALID_PARAMS', 'NO_MP4_VARIANT_FOUND', 'EXECUTE_SCRIPT_ERROR'];
function sanitizeXRecoveryDiag(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [key, allowed] of Object.entries(X_RECOVERY_DIAG_ENUMS)) out[key] = allowed.includes(raw[key]) ? raw[key] : '?';
  for (const key of ['quote', 'req']) out[key] = raw[key] === 1 ? 1 : 0;
  for (const key of X_RECOVERY_DIAG_COUNTS) out[key] = Number.isInteger(raw[key]) ? Math.max(0, Math.min(999, raw[key])) : 0;
  return out;
}
// One log line for a failed recovery: a known error code or a fixed placeholder, never page-supplied text.
function describeXRecoveryFailure(recovery) {
  const code = X_RECOVERY_ERRORS.includes(recovery?.error) ? recovery.error : 'UNKNOWN';
  const detail = X_RECOVERY_DETAILS.includes(recovery?.detail) ? recovery.detail : null;
  return 'reason=' + code + (detail ? ' detail=' + detail : '') + ' diag=' + JSON.stringify(sanitizeXRecoveryDiag(recovery?.diag));
}

/**
 * Recovers the highest-bitrate direct MP4 variant for an ordinary X video player exposing only blob: or manifest.
 * Prioritizes content-script extracted MP4, then executes self-contained inspection in MAIN world.
 * Always attempts MAIN-world lookup for unknown blob players; avoids premature HLS-only rejection.
 */
async function recoverXPostMp4VariantImpl(tabId, mediaDescriptor) {
  if (!mediaDescriptor) return { ok: false, error: 'INVALID_PARAMS' };

  if (mediaDescriptor.recoveredMp4Url) {
    if (isValidXVideoCdnUrl(mediaDescriptor.recoveredMp4Url)) {
      return { ok: true, mp4Url: mediaDescriptor.recoveredMp4Url, bitrate: mediaDescriptor.recoveredBitrate };
    }
    return { ok: false, error: 'INVALID_CDN_HOST' };
  }

  // Only bypass executeScript if confirmed HLS-only and NOT a blob player with unknown metadata
  if (mediaDescriptor.isHlsOnly && !mediaDescriptor.isBlobPlayer) {
    return { ok: false, isHlsOnly: true, error: 'HLS_ONLY' };
  }

  // Always attempt MAIN-world lookup for unknown blob players
  if (typeof chrome !== 'undefined' && chrome.scripting && typeof chrome.scripting.executeScript === 'function' && tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        injectImmediately: true,
        world: 'MAIN',
        func: extractXPostVideoInMainWorld,
        args: [{
          tweetId: mediaDescriptor.tweetId || null,
          postUrl: mediaDescriptor.postUrl || null,
          posterUrl: mediaDescriptor.poster || null,
          mediaIdHint: mediaDescriptor.mediaIdHint || null,
          mediaIndex: typeof mediaDescriptor.mediaIndex === 'number' ? mediaDescriptor.mediaIndex : null,
          isQuoteTweet: Boolean(mediaDescriptor.isQuoteTweet),
          x: mediaDescriptor.x,
          y: mediaDescriptor.y
        }]
      });
      const res = results?.[0]?.result;
      if (res && res.ok && res.mp4Url) {
        if (!isValidXVideoCdnUrl(res.mp4Url)) {
          return { ok: false, error: 'INVALID_CDN_HOST', diag: sanitizeXRecoveryDiag(res.diag) };
        }
        // only the verified fields: the rest of the page's answer is not passed on
        return { ok: true, mp4Url: res.mp4Url, bitrate: res.bitrate };
      }
      if (res && res.isHlsOnly) {
        return { ok: false, isHlsOnly: true, error: 'HLS_ONLY', diag: sanitizeXRecoveryDiag(res.diag) };
      }
      if (res && res.error) {
        return { ok: false, error: res.error, isHlsOnly: Boolean(res.isHlsOnly), diag: sanitizeXRecoveryDiag(res.diag) };
      }
      // The page returned nothing usable (no result, or a result without a reason): the caller reports the generic code.
      return { ok: false, error: 'NO_MP4_VARIANT_FOUND', detail: 'no-script-result' };
    } catch (e) {
      console.warn('[MediaLatch] Ошибка выполнения скрипта восстановления MP4 в main world:', e?.message || e);
      return { ok: false, error: 'EXECUTE_SCRIPT_ERROR', detail: 'script-threw' };
    }
  }

  return { ok: false, error: 'NO_MP4_VARIANT_FOUND', detail: 'no-script-api' };
}

/**
 * Lightweight, dedicated probe for video availability and format check.
 * Strictly separate from image probeCandidate() — never relaxes image verification rules.
 */
async function verifyVideoUrl(candidateUrl) {
  const details = await probeVideoUrlDetails(candidateUrl);
  lastVideoProbeResult = details;
  return details.ok;
}

function toTweetVideoUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const h = parsed.hostname.toLowerCase();
    const p = parsed.pathname.toLowerCase();
    if (h === 'video.twimg.com' && p.includes('/tweet_video/') && p.endsWith('.mp4')) {
      return parsed.toString();
    }
  } catch (e) {
    return null;
  }
  return null;
}

/**
 * Extracts a media descriptor from DOM elements array (e.g., from elementsFromPoint).
 */
function findMediaInElements(elements, pageUrl = '', linkUrl = null) {
  if (!elements || elements.length === 0) return null;

  let video = null;
  let sourceEl = null;

  for (const el of elements) {
    if (!el) continue;
    if (el.tagName === 'VIDEO') {
      video = el;
      break;
    }
    if (el.tagName === 'SOURCE' && (el.parentElement?.tagName === 'VIDEO' || el.closest?.('video'))) {
      sourceEl = el;
      video = el.parentElement?.tagName === 'VIDEO' ? el.parentElement : el.closest?.('video');
      break;
    }
    const insideVideo = el.querySelector ? el.querySelector('video') : null;
    if (insideVideo) {
      video = insideVideo;
      break;
    }
    const insideSource = el.querySelector ? el.querySelector('source') : null;
    if (insideSource && (insideSource.parentElement?.tagName === 'VIDEO' || insideSource.closest?.('video'))) {
      sourceEl = insideSource;
      video = insideSource.parentElement?.tagName === 'VIDEO' ? insideSource.parentElement : insideSource.closest?.('video');
      break;
    }
  }

  const posterUrl = video?.poster || (video?.getAttribute && video.getAttribute('poster')) || null;
  const linkEl = elements.find(el => el && (el.tagName === 'A' || el.closest?.('a')));
  const resolvedLinkUrl = linkUrl || linkEl?.href || linkEl?.closest?.('a')?.href || null;

  if (video || sourceEl) {
    const querySingleSource = video?.querySelector ? video.querySelector('source') : null;
    const allSources = video?.querySelectorAll ? Array.from(video.querySelectorAll('source')) : [];
    const sourceTags = [sourceEl, querySingleSource, ...allSources].filter(Boolean);
    const candidateUrls = [
      video?.currentSrc,
      video?.src,
      sourceEl?.currentSrc,
      sourceEl?.src,
      querySingleSource?.currentSrc,
      querySingleSource?.src,
      ...allSources.map(s => s.currentSrc || s.src)
    ].filter(Boolean);

    // Check for X tweet_video first (preserves proven X GIF flow)
    for (const rawUrl of candidateUrls) {
      const tweetVideoUrl = toTweetVideoUrl(rawUrl);
      if (tweetVideoUrl) {
        return createMediaDescriptor({
          type: 'x_tweet_video',
          src: tweetVideoUrl,
          currentSrc: rawUrl,
          poster: posterUrl,
          mime: 'video/mp4',
          pageUrl,
          linkUrl: resolvedLinkUrl,
          sourceType: 'x_tweet_video',
          animated: true
        });
      }
    }

    // If video exists but candidateUrls (currentSrc/src) is empty (e.g. lazy-loaded),
    // or if candidateUrls only contains blob: URLs, attempt recovery of tweet_video MP4 from poster URL (tweet_video_thumb).
    // The recovered tweet_video source takes precedence over any ephemeral blob: URL.
    if (posterUrl) {
      const recoveredTweetVideoUrl = resolveTweetVideoThumbUrl(posterUrl);
      if (recoveredTweetVideoUrl) {
        return createMediaDescriptor({
          type: 'x_tweet_video',
          src: recoveredTweetVideoUrl,
          currentSrc: recoveredTweetVideoUrl,
          poster: posterUrl,
          mime: 'video/mp4',
          pageUrl,
          linkUrl: resolvedLinkUrl,
          sourceType: 'x_tweet_video',
          animated: true
        });
      }
    }

    for (const rawUrl of candidateUrls) {
      if (typeof rawUrl === 'string' && rawUrl.trim() && !rawUrl.startsWith('data:image/')) {
        const matchingSource = sourceTags.find(s => (s.currentSrc === rawUrl || s.src === rawUrl));
        const declaredMime = matchingSource?.type || null;
        return createMediaDescriptor({
          type: 'video',
          src: rawUrl,
          currentSrc: video?.currentSrc || rawUrl,
          poster: posterUrl,
          mime: declaredMime || detectVideoMime(rawUrl),
          pageUrl,
          linkUrl: resolvedLinkUrl
        });
      }
    }
  }

  for (const el of elements) {
    if (!el) continue;
    if (el.tagName === 'IMG') {
      const imgUrl = el.currentSrc || el.src;
      if (imgUrl) {
        return createMediaDescriptor({
          type: 'image',
          src: imgUrl,
          currentSrc: imgUrl,
          poster: null,
          pageUrl,
          linkUrl: resolvedLinkUrl
        });
      }
    }
    const insideImg = el.querySelector ? el.querySelector('img') : null;
    if (insideImg) {
      const imgUrl = insideImg.currentSrc || insideImg.src;
      if (imgUrl) {
        return createMediaDescriptor({
          type: 'image',
          src: imgUrl,
          currentSrc: imgUrl,
          poster: null,
          pageUrl,
          linkUrl: resolvedLinkUrl
        });
      }
    }
  }

  if (video && posterUrl) {
    const recoveredTweetVideoUrl = resolveTweetVideoThumbUrl(posterUrl);
    if (recoveredTweetVideoUrl) {
      return createMediaDescriptor({
        type: 'x_tweet_video',
        src: recoveredTweetVideoUrl,
        currentSrc: recoveredTweetVideoUrl,
        poster: posterUrl,
        mime: 'video/mp4',
        pageUrl,
        linkUrl: resolvedLinkUrl,
        sourceType: 'x_tweet_video',
        animated: true
      });
    }
    return createMediaDescriptor({
      type: 'image',
      src: posterUrl,
      currentSrc: posterUrl,
      poster: posterUrl,
      mime: 'image/jpeg',
      pageUrl,
      linkUrl: resolvedLinkUrl
    });
  }

  return null;
}

/**
 * Resolves media target with winner logic:
 * If real video source is present and verified, video wins over poster.
 * If video source is invalid/unverified and poster exists, poster falls back to image resolver.
 * Standard images route to image resolver.
 */
async function resolveMediaTargetImpl(options = {}) {
  const {
    descriptor = null,
    srcUrl = '',
    url = '',
    pageUrl = '',
    linkUrl = null,
    tabId = null,
    domMeta = null,
    frameId = undefined
  } = options;
  const effectiveSrc = srcUrl || url || '';
  let mediaDesc = descriptor || options.mediaDesc;
  if (!mediaDesc) {
    const isTweetThumb = Boolean(resolveTweetVideoThumbUrl(effectiveSrc)) || Boolean(resolveTweetVideoThumbUrl(linkUrl));
    const isXPoster = isXVideoPosterUrl(effectiveSrc) || isXVideoPosterUrl(linkUrl);
    const isRedGifs = typeof extractRedGifsIdFromUrl === 'function' &&
                      Boolean(extractRedGifsIdFromUrl(effectiveSrc) || extractRedGifsIdFromUrl(linkUrl));
    const hostFromUrl = (u) => {
      try { return new URL(u).hostname; } catch(_) { return ''; }
    };
    const isBlobVideo = (effectiveSrc.startsWith('blob:') || (linkUrl && linkUrl.startsWith('blob:'))) &&
                        (options.type === 'video' || domMeta?.mediaType === 'video' || domMeta?.tag === 'video' || isRedditDomain(hostFromUrl(pageUrl)));
    const isVideo = isDirectVideoUrl(effectiveSrc) || isDirectVideoUrl(linkUrl) || isTweetThumb || isXPoster || isRedGifs || isBlobVideo;
    mediaDesc = createMediaDescriptor({
      type: isVideo ? 'video' : 'image',
      src: effectiveSrc || linkUrl || '',
      currentSrc: effectiveSrc || '',
      poster: isTweetThumb ? (resolveTweetVideoThumbUrl(effectiveSrc) ? effectiveSrc : linkUrl) : (isXPoster ? (isXVideoPosterUrl(effectiveSrc) ? effectiveSrc : linkUrl) : null),
      pageUrl,
      linkUrl
    });
  }

  // Promote tweet_video_thumb to candidate video if descriptor was initialized as image or video
  if (mediaDesc) {
    const descSrc = mediaDesc.src || mediaDesc.currentSrc;
    const tweetCandidate = resolveTweetVideoThumbUrl(descSrc);
    if (tweetCandidate) {
      if (!mediaDesc.poster) mediaDesc.poster = descSrc;
      mediaDesc.src = tweetCandidate;
      mediaDesc.currentSrc = tweetCandidate;
      mediaDesc.type = 'x_tweet_video';
    } else if (mediaDesc.poster) {
      const recoveredFromPoster = resolveTweetVideoThumbUrl(mediaDesc.poster);
      if (recoveredFromPoster && (mediaDesc.src?.startsWith('blob:') || mediaDesc.currentSrc?.startsWith('blob:') || !mediaDesc.src)) {
        mediaDesc.src = recoveredFromPoster;
        mediaDesc.currentSrc = recoveredFromPoster;
        mediaDesc.type = 'x_tweet_video';
      }
    }
  }

  // X Ordinary video poster resolution (amplify_video_thumb / ext_tw_video_thumb)
  const isXPosterTarget = isXVideoPosterUrl(mediaDesc?.src) ||
                          isXVideoPosterUrl(mediaDesc?.currentSrc) ||
                          isXVideoPosterUrl(mediaDesc?.poster) ||
                          Boolean(mediaDesc?.isXVideoPoster) ||
                          isXVideoPosterUrl(srcUrl) ||
                          isXVideoPosterUrl(linkUrl);

  if (isXPosterTarget) {
    mediaDesc.type = 'video';
    if (!mediaDesc.poster) {
      mediaDesc.poster = isXVideoPosterUrl(srcUrl) ? srcUrl : (isXVideoPosterUrl(linkUrl) ? linkUrl : (isXVideoPosterUrl(mediaDesc.src) ? mediaDesc.src : null));
    }
    if (!mediaDesc.mediaIdHint && mediaDesc.poster) {
      const m = mediaDesc.poster.match(/\/(?:ext_tw_video_thumb|amplify_video_thumb)\/(\d+)/i);
      if (m) mediaDesc.mediaIdHint = m[1];
    }
    if (!mediaDesc.tweetId) {
      const tMatch = (mediaDesc.pageUrl || pageUrl || '').match(/\/status\/(\d+)/);
      if (tMatch) mediaDesc.tweetId = tMatch[1];
    }

    if (tabId) {
      const recovery = await recoverXPostMp4Variant(tabId, mediaDesc);
      if (recovery.ok && recovery.mp4Url) {
        mediaDesc.src = recovery.mp4Url;
        mediaDesc.currentSrc = recovery.mp4Url;
        mediaDesc.recoveredMp4Url = recovery.mp4Url;
        mediaDesc.recoveredBitrate = recovery.bitrate;
        mediaDesc.isBlobPlayer = false;
      } else {
        const failErr = recovery.isHlsOnly ? 'HLS_ONLY' : (recovery.error || 'NO_MP4_VARIANT_FOUND');
        console.warn('[MediaLatch] Не удалось восстановить проверенный MP4 для постера X видео:', sanitizeUrlForLog(mediaDesc.poster || mediaDesc.src), describeXRecoveryFailure(recovery));
        await flashBadge('ERR', '#ef4444');
        return {
          targetUrl: null,
          type: 'video',
          error: failErr,
          status: 404,
          message: 'X video MP4 recovery failed',
          descriptor: mediaDesc
        };
      }
    } else {
      console.warn('[MediaLatch] Не удалось восстановить проверенный MP4 для постера X видео (отсутствует tabId):', sanitizeUrlForLog(mediaDesc.poster || mediaDesc.src));
      await flashBadge('ERR', '#ef4444');
      return {
        targetUrl: null,
        type: 'video',
        error: 'NO_TAB',
        status: 404,
        message: 'No tab available for X video recovery',
        descriptor: mediaDesc
      };
    }
  }

  // 1. Video candidate
  if (mediaDesc.type === 'video' || mediaDesc.type === 'x_tweet_video') {
    let videoUrl = mediaDesc.src || mediaDesc.currentSrc;

    // RedGIFs resolution:
    // 1. Preserve existing valid direct RedGIFs video URL on ANY allowed CDN subdomain (including thumbs*.redgifs.com and WebM).
    // Never replace it merely because its hostname lacks "media.redgifs.com".
    const isDirectRedGifs = typeof validateRedGifsCandidateUrl === 'function' &&
                            Boolean(validateRedGifsCandidateUrl(videoUrl).valid);

    // RG-03: a direct RedGIFs source that is the muted `-silent` rendition. Ask the owning frame for a same-clip rendition the page declares
    // as carrying audio and use it only when it is proven to be this clip and accessible; otherwise the selected source stays unchanged.
    // The silent URL is never rewritten, and the clip stays downloadable when no audio-bearing rendition is proven.
    if (isDirectRedGifs && options.tabId && isRedGifsSilentVariantUrl(videoUrl)) {
      const clickedKey = redGifsClipKey(videoUrl);
      try {
        const frameRes = await resolveFrameLocalMedia({
          tabId: options.tabId,
          frameId: typeof options.frameId === 'number' ? options.frameId : 0,
          clickedSrc: videoUrl,
          pageUrl: options.pageUrl || mediaDesc.pageUrl || pageUrl,
          linkUrl: options.linkUrl || mediaDesc.linkUrl || linkUrl,
          mediaType: 'video'
        });
        const isStaleContext = frameRes && frameRes.success === false && (
          frameRes.diagnostics?.providerAudio === 'FRAME_CHANGED' ||
          frameRes.diagnostics?.rejectionReasons?.includes('FRAME_CHANGED_DURING_LOOKUP') ||
          frameRes.error === 'FRAME_CHANGED'
        );
        if (isStaleContext) {
          console.warn('[MediaLatch] RedGIFs: frame changed during direct silent audio lookup; refusing stale direct context-menu save');
          await flashBadge('ERR', '#ef4444');
          return {
            targetUrl: null,
            type: 'video',
            error: 'UNRESOLVED_BLOB_MEDIA',
            reason: 'FRAME_CHANGED',
            status: null, // no HTTP answer was observed: the frame refused a changed selection
            descriptor: mediaDesc,
            diagnostics: frameRes?.diagnostics || { rejectionReasons: ['FRAME_CHANGED_DURING_LOOKUP'] }
          };
        }
        const proven = frameRes && frameRes.success === true && frameRes.audio === 'present' && clickedKey &&
          frameRes.clipId === clickedKey && redGifsClipKey(frameRes.targetUrl) === clickedKey &&
          !isRedGifsSilentVariantUrl(frameRes.targetUrl) && frameRes.targetUrl !== videoUrl;
        if (proven) {
          const audioCandidates = [
            frameRes.targetUrl,
            ...(Array.isArray(frameRes.sameClipUrls) ? frameRes.sameClipUrls : [])
          ].filter((u, idx, arr) => (
            typeof u === 'string' &&
            arr.indexOf(u) === idx &&
            !isRedGifsSilentVariantUrl(u) &&
            redGifsClipKey(u) === clickedKey &&
            (u === frameRes.targetUrl || frameRes.candidateAudio?.[u] === 'present')
          ));

          let chosenAudioUrl = null;
          let authoritativeError = null;

          for (const candUrl of audioCandidates) {
            const probe = await probeVideoUrlDetails(candUrl);
            if (probe && probe.ok) {
              chosenAudioUrl = candUrl;
              break;
            }
            if (probe && (probe.status === 401 || probe.status === 403 || probe.requiresAuth)) {
              authoritativeError = { status: probe.status || 403, error: 'AUTH_REQUIRED' };
              break;
            }
            const isAbsent = probe && (probe.status === 404 || probe.status === 410 || probe.error === 'NOT_FOUND' || probe.error === 'GONE');
            if (isAbsent) {
              continue;
            }
            authoritativeError = {
              status: probe?.status || 0,
              error: probe?.status === 429 ? 'RATE_LIMIT' : (probe?.error || 'NETWORK_FAILURE')
            };
            break;
          }

          if (authoritativeError) {
            console.warn('[MediaLatch] RedGIFs: authoritative media-asset failure on promoted audio rendition:', authoritativeError);
            if (authoritativeError.error === 'AUTH_REQUIRED') {
              await flashBadge('AUTH', '#f59e0b');
              return {
                targetUrl: null,
                type: 'video',
                error: 'AUTH_REQUIRED',
                status: authoritativeError.status,
                message: `Video requires authorization (HTTP ${authoritativeError.status})`,
                descriptor: mediaDesc
              };
            }
            await flashBadge('ERR', '#ef4444');
            return {
              targetUrl: null,
              type: 'video',
              error: authoritativeError.error,
              status: authoritativeError.status,
              descriptor: mediaDesc
            };
          }

          if (chosenAudioUrl) {
            console.log('[MediaLatch] RedGIFs: selected the same-clip rendition declared to carry audio over the -silent source:', sanitizeUrlForLog(chosenAudioUrl));
            videoUrl = chosenAudioUrl;
            mediaDesc.src = videoUrl;
            mediaDesc.currentSrc = videoUrl;
          }
        }
      } catch (_) {}
    }

    if (!isDirectRedGifs && !options.gesturePlayer && typeof extractRedGifsIdFromUrl === 'function') {
      const redGifsId = extractRedGifsIdFromUrl(videoUrl) ||
                        extractRedGifsIdFromUrl(mediaDesc.linkUrl) ||
                        extractRedGifsIdFromUrl(linkUrl) ||
                        extractRedGifsIdFromUrl(pageUrl);
      if (redGifsId) {
        // 2. If only a RedGIFs page URL is available, prefer a matching frame-resolved direct asset where possible.
        // An inline embed save (RD-10) was proven by the post and by one document of one frame: only that clip's own direct source from that
        // document is a result, and nothing is guessed from the clip id when the frame cannot answer.
        const embedProof = options.redGifsEmbed || null;
        let frameResolvedUrl = null;
        if (options.tabId) {
          let frame = { frameId: typeof options.frameId === 'number' ? options.frameId : 0, documentId: embedProof ? embedProof.documentId : '' };
          try {
            for (let attempt = 0; ; attempt++) {
              const frameRes = await resolveFrameLocalMedia({
                tabId: options.tabId,
                frameId: frame.frameId,
                documentId: frame.documentId,
                clickedSrc: videoUrl || mediaDesc.src || '',
                pageUrl: options.pageUrl || mediaDesc.pageUrl || pageUrl,
                linkUrl: options.linkUrl || mediaDesc.linkUrl || linkUrl,
                mediaType: 'video'
              });
              if (frameRes && frameRes.success && frameRes.targetUrl &&
                  (!embedProof || (frameRes.clipId === embedProof.clipKey && redGifsClipKey(frameRes.targetUrl) === embedProof.clipKey))) {
                frameResolvedUrl = frameRes.targetUrl;
                break;
              }
              // BUGFIX-MULTISITE-01: the embed's proven document can be replaced right after it was found (observed: "No document with id" on the first
              // inline click, the next click resolved). Only when NO document answered, within the same save, the frame is found again: exactly one direct
              // child of the top document showing the same proven clip, and that current document is asked. A frame's own refusal, another clip, several
              // or no frames end it; at most REDGIFS_EMBED_RETRIES more attempts.
              if (!embedProof || !frameRes || frameRes.noAnswer !== true || attempt >= REDGIFS_EMBED_RETRIES) break;
              await new Promise((r) => setTimeout(r, REDGIFS_EMBED_RETRY_MS * (attempt + 1)));
              frame = await redditInlineFindRedGifsFrame(options.tabId, { frameId: 0 }, embedProof.clipKey);
              if (!frame) break;
              console.info('[MediaLatch] Embedded RedGIFs frame did not answer; asking the current document of the same clip again');
            }
          } catch (_) {}
        }

        if (frameResolvedUrl) {
          videoUrl = frameResolvedUrl;
          mediaDesc.src = frameResolvedUrl;
          mediaDesc.currentSrc = frameResolvedUrl;
          mediaDesc.type = 'video';
        } else if (embedProof) {
          console.warn('[MediaLatch] Embedded RedGIFs clip not resolved in its frame (UNRESOLVED_BLOB_MEDIA); no ID-derived guess for an inline embed save');
          await flashBadge('ERR', '#ef4444');
          return {
            targetUrl: null,
            type: 'video',
            error: 'UNRESOLVED_BLOB_MEDIA',
            reason: 'NO_DIRECT_MEDIA_FOUND',
            status: 404,
            descriptor: mediaDesc,
            diagnostics: { frameId: typeof options.frameId === 'number' ? options.frameId : 0, rejectionReasons: ['NO_FRAME_RESOLVED_CLIP'] }
          };
        } else {
          // 3. Treat an ID-derived MP4 as an unverified candidate that must pass a bounded probe;
          // on failure, report an explicit error rather than silently saving a poster.
          const directCandidate = `https://media.redgifs.com/${redGifsId}.mp4`;
          videoUrl = directCandidate;
          mediaDesc.src = directCandidate;
          mediaDesc.currentSrc = directCandidate;
          mediaDesc.type = 'video';
          mediaDesc.verified = false;
          mediaDesc.isGuessedRedGifs = true;
        }
      }
    }

    // Blob fallback must never override recovered genuine source
    if (videoUrl && videoUrl.startsWith('blob:') && mediaDesc.poster) {
      const recoveredCandidate = resolveTweetVideoThumbUrl(mediaDesc.poster);
      if (recoveredCandidate) {
        videoUrl = recoveredCandidate;
        mediaDesc.src = recoveredCandidate;
        mediaDesc.currentSrc = recoveredCandidate;
        mediaDesc.type = 'x_tweet_video';
      }
    }

    // Chrome's own srcUrl of a Reddit HLS player can be the canonical master itself: the owning frame proves it is the selected player's own declaration,
    // exactly as for a blob (the address alone, from the menu, owns nothing). Outside Reddit pages nothing changes.
    const redditHlsSrc = Boolean(options.tabId && videoUrl && redditHlsMasterUrl(videoUrl) &&
      (isRedditDomain(getUrlHostname(options.pageUrl || mediaDesc.pageUrl || '')) || isRedditDomain(getUrlHostname(options.linkUrl || mediaDesc.linkUrl || ''))));

    // Never fetch a blob: URL from the service worker. Resolve in the owning frame (also a gesture-proven player that shows no address):
    if (options.gesturePlayer === true || redditHlsSrc || (videoUrl && videoUrl.startsWith('blob:'))) {
      const frameId = typeof options.frameId === 'number' ? options.frameId : 0;
      let frameRes = null;
      const hostFromUrl = (u) => {
        try { return new URL(u).hostname; } catch(_) { return ''; }
      };
      const isReddit = options.gesturePlayer !== true && (isRedditDomain(hostFromUrl(options.pageUrl || mediaDesc.pageUrl || '')) ||
                       isRedditDomain(hostFromUrl(options.linkUrl || mediaDesc.linkUrl || '')));

      if (options.tabId) {
        if (isReddit) {
          frameRes = await resolveRedditFrameBlobMedia({
            tabId: options.tabId,
            frameId,
            clickedSrc: videoUrl,
            pageUrl: options.pageUrl || mediaDesc.pageUrl,
            linkUrl: options.linkUrl || mediaDesc.linkUrl,
            mediaType: 'video'
          });
        } else {
          // A gesture-proven address-less player: the request is pinned to the document the capture was read in and to that document's own fresh
          // selection (a document the frame navigated to meanwhile answers nothing, and never substitutes its sole player)
          frameRes = await resolveFrameLocalMedia({
            tabId: options.tabId,
            frameId,
            clickedSrc: videoUrl,
            pageUrl: options.pageUrl || mediaDesc.pageUrl,
            linkUrl: options.linkUrl || mediaDesc.linkUrl,
            mediaType: 'video',
            ...(options.gesturePlayer === true ? { documentId: options.gestureDocumentId || '', requireGesture: !options.inlineToken, gestureAt: options.gestureAt, inlineToken: options.inlineToken || '' } : {})
          });
        }
      }
      if (frameRes && frameRes.success && frameRes.redditHls) {
        return { redditHls: frameRes.redditHls, type: 'video', descriptor: mediaDesc };
      }
      if (frameRes && frameRes.success && frameRes.targetUrl) {
        const detectedMime = detectVideoMime(frameRes.targetUrl) || 'video/mp4';
        const canonicalExt = resolveCanonicalExtension(detectedMime, frameRes.targetUrl);
        mediaDesc.src = frameRes.targetUrl;
        mediaDesc.currentSrc = frameRes.targetUrl;
        mediaDesc.contentType = detectedMime;
        mediaDesc.verified = false;
        mediaDesc.mimeEvidence = MIME_EVIDENCE.URL_HINT;
        // RG-03: when the frame proved the target carries audio, the same clip's other non-silent renditions follow it as variants, so the existing
        // absence policy (HTTP 404/410 only) can progress to them; any other failure stays a failure and never silently drops the audio.
        const audioFollowers = !isReddit && frameRes.audio === 'present' && Array.isArray(frameRes.sameClipUrls)
          ? frameRes.sameClipUrls.filter((u) => u !== frameRes.targetUrl && !isRedGifsSilentVariantUrl(u) && frameRes.candidateAudio?.[u] !== 'absent')
          : [];
        const mediaPlan = createCandidateGroup({
          id: `video_${encodeURIComponent(frameRes.targetUrl.slice(-40))}`,
          source: 'frame_resolver',
          provider: isReddit ? 'reddit' : 'redgifs',
          tier: 'legacy',
          score: 100,
          validationMode: 'probe',
          transport: 'direct',
          variants: [frameRes.targetUrl, ...audioFollowers].map((u) => ({
            url: u,
            expectedExtension: u === frameRes.targetUrl ? canonicalExt : resolveCanonicalExtension(detectVideoMime(u) || 'video/mp4', u),
            verified: false,
            mimeEvidence: MIME_EVIDENCE.URL_HINT
          })),
          metadata: {
            verified: false,
            mimeEvidence: MIME_EVIDENCE.URL_HINT,
            contentType: detectedMime,
            mediaType: 'video',
            resolvedUrl: frameRes.targetUrl
          }
        });
        return {
          targetUrl: frameRes.targetUrl,
          type: 'video',
          contentType: detectedMime,
          descriptor: mediaDesc,
          mediaPlan
        };
      }
      const diagObj = {
        frameId,
        safeFrameUrl: frameRes?.diagnostics?.safeFrameUrl || (options.pageUrl ? sanitizeUrlForLog(options.pageUrl) : null),
        targetFound: frameRes?.diagnostics?.targetFound ?? false,
        videoCount: frameRes?.diagnostics?.videoCount ?? 0,
        videoId: frameRes?.diagnostics?.videoId ?? null,
        videoIdSource: frameRes?.diagnostics?.videoIdSource ?? 'none',
        inspectedSources: frameRes?.diagnostics?.inspectedSources ?? [],
        candidateCount: frameRes?.diagnostics?.candidateCount ?? 0,
        validCandidateCount: frameRes?.diagnostics?.validCandidateCount ?? 0,
        rejectionReasons: frameRes?.diagnostics?.rejectionReasons ?? ['NO_VALID_CANDIDATE'],
        reason: frameRes?.reason || null,
        streamType: frameRes?.diagnostics?.streamType || null
      };
      console.warn(`[MediaLatch] Не удалось разрешить blob video URL (UNRESOLVED_BLOB_MEDIA): ${JSON.stringify(diagObj)}`);
      await flashBadge('ERR', '#ef4444');
      return {
        targetUrl: null,
        type: 'video',
        error: 'UNRESOLVED_BLOB_MEDIA',
        reason: frameRes?.reason || 'NO_DIRECT_MEDIA_FOUND',
        validationError: frameRes?.validationError || null,
        status: null, // no HTTP answer was observed: the frame resolved no direct address
        descriptor: mediaDesc,
        diagnostics: diagObj
      };
    }

    let probeDetails = null;
    if (videoUrl) {
      probeDetails = await probeVideoUrlDetails(videoUrl);
    } else {
      probeDetails = { ok: false, status: 0, requiresAuth: false, error: 'INVALID_URL' };
    }

    // A. Success: confirmed real video source (wins over poster)
    if (probeDetails.ok) {
      console.log('[MediaLatch] Подтверждён реальный видео-источник (wins over poster):', sanitizeUrlForLog(videoUrl));
      mediaDesc.contentType = probeDetails.contentType || 'video/mp4';
      mediaDesc.verified = true;
      mediaDesc.mimeEvidence = MIME_EVIDENCE.HTTP_RESPONSE;
      mediaDesc.verifiedUrl = videoUrl;
      const canonicalExt = resolveCanonicalExtension(mediaDesc.contentType, videoUrl);
      const classification = classifyMediaTarget({
        url: videoUrl,
        domType: mediaDesc.type,
        mediaType: mediaDesc.type,
        poster: mediaDesc.poster,
        mime: mediaDesc.contentType
      });
      const isXTweet = classification.sourceType === 'x_tweet_video';
      const isRedditGif = classification.sourceType === 'reddit_gif' || isRedditAnimationUrl(videoUrl);
      const isAnimation = isXTweet || isRedditGif;
      const mediaPlan = createCandidateGroup({
        id: `video_${encodeURIComponent(videoUrl.slice(-40))}`,
        source: 'video_resolver',
        provider: 'generic',
        tier: 'legacy',
        score: 100,
        validationMode: 'probe',
        transport: inferTransportForUrl(videoUrl),
        variants: [
          {
            url: videoUrl,
            expectedExtension: canonicalExt
          }
        ],
        metadata: {
          verified: true,
          mimeEvidence: MIME_EVIDENCE.HTTP_RESPONSE,
          verifiedUrl: videoUrl,
          contentType: mediaDesc.contentType,
          mediaType: isAnimation ? 'gif' : 'video',
          sourceType: classification.sourceType,
          ...(isAnimation ? { isAnimated: true } : {})
        }
      });
      return {
        targetUrl: videoUrl,
        type: 'video',
        classification,
        sourceType: classification.sourceType,
        animated: isAnimation,
        contentType: mediaDesc.contentType,
        descriptor: mediaDesc,
        mediaPlan
      };
    }

    // B. Authorization required (HTTP 401 / 403 Forbidden)
    if (probeDetails.requiresAuth || probeDetails.status === 401 || probeDetails.status === 403) {
      const isReddit = isRedditHostedMediaUrl(videoUrl);
      const failureMsg = isReddit
        ? 'Reddit video requires an active Reddit session'
        : `Video requires authorization (HTTP ${probeDetails.status})`;

      console.warn(`[MediaLatch] ${failureMsg}:`, sanitizeUrlForLog(videoUrl));
      await flashBadge('AUTH', '#f59e0b');

      // CRITICAL: Do NOT silently download poster when video authorization failed!
      return {
        targetUrl: null,
        type: 'video',
        error: 'AUTH_REQUIRED',
        status: probeDetails.status,
        message: failureMsg,
        descriptor: mediaDesc
      };
    }

    // C. Broken / missing stream (HTTP 404 Not Found / 410 Gone)
    // Poster fallback is strictly permitted ONLY when media resource is proven non-existent,
    // and strictly DISALLOWED for unverified guessed RedGIFs candidates or X posters.
    const isMissingStream = probeDetails.status === 404 || probeDetails.status === 410 ||
                            probeDetails.error === 'NOT_FOUND' || probeDetails.error === 'GONE';
    const isXPosterDesc = Boolean(isXPosterTarget) || isXVideoPosterUrl(mediaDesc.poster);
    const allowPosterFallback = isMissingStream && mediaDesc.poster && !isXPosterDesc && !mediaDesc.isGuessedRedGifs;
    if (allowPosterFallback) {
      console.log(`[MediaLatch] Видео-источник отсутствует (HTTP ${probeDetails.status}), fallback на poster:`, sanitizeUrlForLog(mediaDesc.poster));
      const targetImageUrl = await resolveOriginalImageUrl({
        srcUrl: mediaDesc.poster,
        pageUrl: mediaDesc.pageUrl || pageUrl,
        linkUrl: mediaDesc.linkUrl || linkUrl,
        tabId,
        frameId,
        domMeta
      });
      return {
        targetUrl: targetImageUrl || mediaDesc.poster,
        type: 'image',
        fallbackFromVideo: true,
        descriptor: mediaDesc
      };
    }

    // D. Rate limited (HTTP 429)
    if (probeDetails.status === 429 || probeDetails.error === 'RATE_LIMIT') {
      const failureMsg = 'Video rate limited (HTTP 429)';
      console.warn(`[MediaLatch] ${failureMsg}:`, sanitizeUrlForLog(videoUrl));
      await flashBadge('RATE', '#f59e0b');
      return {
        targetUrl: null,
        type: 'video',
        error: 'RATE_LIMIT',
        status: 429,
        message: failureMsg,
        descriptor: mediaDesc
      };
    }

    // E. Everything else: TIMEOUT, NETWORK_ERROR, UNACCEPTABLE_CONTENT, 5xx server errors, etc.
    // Conservative failure: NEVER mask temporary failure or wrong MIME with a poster download.
    let failMsg = 'Video unavailable';
    let failError = 'VIDEO_PROBE_FAILED';

    if (probeDetails.error === 'TIMEOUT') {
      failMsg = 'Video probe timed out';
      failError = 'TIMEOUT';
    } else if (probeDetails.error === 'NETWORK_ERROR') {
      failMsg = 'Video network error';
      failError = 'NETWORK_ERROR';
    } else if (probeDetails.error === 'UNACCEPTABLE_CONTENT') {
      failMsg = 'Video returned unsupported content';
      failError = 'UNACCEPTABLE_CONTENT';
    } else if (isMissingStream) {
      failMsg = `Video not found (HTTP ${probeDetails.status})`;
      failError = probeDetails.error || 'NOT_FOUND';
    } else {
      failMsg = `Video unavailable (status ${probeDetails.status || 0})`;
      failError = 'VIDEO_UNAVAILABLE';
    }

    console.warn(`[MediaLatch] ${failMsg}:`, sanitizeUrlForLog(videoUrl));
    await flashBadge('ERR', '#ef4444');

    return {
      targetUrl: null,
      type: 'video',
      error: failError,
      status: probeDetails.status,
      message: failMsg,
      descriptor: mediaDesc
    };
  }

  // 2. Image candidate
  const mediaPlan = await resolveOriginalMediaPlan({
    srcUrl: mediaDesc.src || srcUrl,
    pageUrl: mediaDesc.pageUrl || pageUrl,
    linkUrl: mediaDesc.linkUrl || linkUrl,
    tabId,
    frameId,
    domMeta
  });
  const targetImageUrl = mediaPlan?.primaryUrl;

  return {
    targetUrl: targetImageUrl || mediaDesc.src || srcUrl,
    type: 'image',
    descriptor: mediaDesc,
    mediaPlan
  };
}

// Sankaku cards expose only signed previews. Read the selected post's own #highres in its authenticated document; never derive a signed original URL.
async function readSankakuOriginal(srcUrl, pageUrl, linkUrl) {
  let route = 'post_dom';
  const refuse = error => ({ error, route });
  const parseMedia = (raw) => {
    try {
      if (typeof raw !== 'string' || raw.length > 4096) return null;
      const u = new URL(raw, location.href);
      if (u.protocol !== 'https:' || !/^[sv]\.sankakucomplex\.com$/.test(u.hostname) || u.username || u.password || u.port || u.hash) return null;
      const m = /^\/data\/(preview\/|sample\/)?([a-f0-9]{2})\/([a-f0-9]{2})\/(sample-)?([a-f0-9]{32})\.(jpe?g|png|gif|webp|avif|mp4|webm)$/.exec(u.pathname);
      if (!m || m[5].slice(0, 4) !== m[2] + m[3]) return null;
      return { url: u.href, hash: m[5], preview: Boolean(m[1] || m[4]), video: /^(mp4|webm)$/.test(m[6]) };
    } catch (_) { return null; }
  };
  const parsePost = (raw) => {
    try {
      if (typeof raw !== 'string' || !raw || raw.length > 4096) return null;
      const u = new URL(raw, location.href);
      if (u.protocol !== 'https:' || u.origin !== location.origin || u.hostname !== 'chan.sankakucomplex.com' || u.username || u.password || u.port) return null;
      const m = /^\/(?:[a-z]{2}\/)?posts\/([A-Za-z0-9]{1,32})\/?$/.exec(u.pathname);
      return m ? { id: m[1], url: u.href } : null;
    } catch (_) { return null; }
  };
  const clicked = parseMedia(srcUrl);
  if (!clicked?.preview || location.href !== pageUrl) return refuse('TARGET_CHANGED');
  const images = Array.from(document.querySelectorAll('img')).filter(el => (el.currentSrc || el.src) === clicked.url);
  if (images.length !== 1) return refuse('AMBIGUOUS_TARGET');
  const selected = images[0];
  const ownPost = () => parsePost(selected.closest('a[href]')?.href) || (selected.closest('#post-content') ? parsePost(location.href) : null);
  const post = ownPost();
  const linkedPost = linkUrl ? parsePost(linkUrl) : null;
  if (!post || (linkedPost && linkedPost.id !== post.id)) return refuse('POST_MISMATCH');
  const documentUrl = location.href;
  // the selection is fixed here (this exact preview's post id and file hash); the declaration below must name that post and hash, so the preview
  // may scroll away, unload or be recycled meanwhile without changing what is saved. Only a navigation away (the existing policy) stops it.
  const unchanged = () => location.href === documentUrl;
  let doc = document;
  if (parsePost(location.href)?.id !== post.id) {
    route = 'post_html';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let response, reader;
    try {
      response = await fetch(post.url, { credentials: 'same-origin', redirect: 'manual', headers: { Accept: 'text/html' }, signal: controller.signal });
      if (response.type === 'opaqueredirect' || response.redirected || (response.status >= 300 && response.status < 400)) return refuse('AUTH_REQUIRED');
      if (!response.ok) return { status: response.status, route };
      if (parsePost(response.url)?.id !== post.id || !/^text\/html\b/i.test(response.headers.get('content-type') || '') || !response.body?.getReader) return refuse('INVALID_POST_RESPONSE');
      if (Number(response.headers.get('content-length')) > 1024 * 1024) return refuse('BODY_TOO_LARGE');
      reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 1024 * 1024) return refuse('BODY_TOO_LARGE');
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'text/html');
    } catch (_) { return refuse(controller.signal.aborted ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR'); }
    finally {
      clearTimeout(timeout);
      controller.abort();
      try { if (reader) await reader.cancel(); else if (response?.body) await response.body.cancel(); } catch (_) {}
    }
  }
  if (!unchanged()) return refuse('TARGET_CHANGED');
  const identities = Array.from(doc.querySelectorAll('#page-title a[href]')).map(a => parsePost(a.getAttribute('href'))).filter(Boolean);
  const originals = Array.from(doc.querySelectorAll('#post-view #highres[itemprop="contentUrl"]'));
  if (identities.length !== 1 || identities[0].id !== post.id || originals.length !== 1) return refuse('ORIGINAL_NOT_DECLARED');
  const original = parseMedia(originals[0].getAttribute('href'));
  return original && !original.preview && original.hash === clicked.hash ? { ...original, route } : refuse('ORIGINAL_MISMATCH');
}

async function resolveSankakuOriginalPlan({ srcUrl, pageUrl, linkUrl, tabId, frameId }) {
  let source;
  try { source = new URL(srcUrl, pageUrl); } catch (_) { return undefined; }
  if (!/^[sv]\.sankakucomplex\.com$/.test(source.hostname) || !/^\/data\/(?:preview\/|sample\/|[a-f0-9]{2}\/[a-f0-9]{2}\/sample-)/.test(source.pathname)) return undefined;
  const failure = (status, error) => adaptCandidateToGroup({ url: srcUrl, source: 'specialized_provider', provider: 'sankaku', tier: 'original', score: 96,
    _verificationStatus: status, _rateLimited: status === 429, error: error || (status === 429 ? 'RATE_LIMIT' : status === 401 || status === 403 ? 'AUTH_REQUIRED' : status === 404 || status === 410 ? 'NOT_FOUND' : '') });
  if (!tabId) return null;
  const started = Date.now();
  let original;
  try {
    const results = await chrome.scripting.executeScript({
      target: Number.isInteger(frameId) && frameId >= 0 ? { tabId, frameIds: [frameId] } : { tabId },
      injectImmediately: true, func: readSankakuOriginal, args: [srcUrl, pageUrl, linkUrl]
    });
    original = results?.[0]?.result;
  } catch (_) { original = { error: 'INJECT_FAILED' }; }
  dbg('sankaku', 'original', original?.url ? 'ok' : 'failed', original?.error || (original?.status ? 'HTTP_ERROR' : original?.url ? undefined : 'NO_DECLARATION'),
    { route: original?.route, ms: Date.now() - started, http: original?.status }, { tab: tabId, frame: frameId });
  if (['AUTH_REQUIRED', 'NETWORK_TIMEOUT', 'NETWORK_ERROR'].includes(original?.error)) return failure(0, original.error);
  if ([401, 403, 404, 410, 429].includes(original?.status)) return failure(original.status);
  if (!original?.url) return null;
  const probe = { url: original.url, source: 'specialized_provider', finalScore: 96, allowVideo: original.video, isBooruCandidate: original.video };
  if (!await probeCandidate(probe)) return [401, 403, 404, 410, 429].includes(probe.status) ? failure(probe.status) : null;
  if (!(original.video ? /^video\/(mp4|webm)$/.test(probe.contentType) : probe.contentType?.startsWith('image/'))) return null;
  return adaptCandidateToGroup({ ...probe, provider: 'sankaku', tier: 'original' });
}

// ---- SITE-PAWCHIVE-01: originals from Pawchive previews ----------------------------------------------------------------------------------------------
// A creator-feed card shows img.pawchive.pw/thumbnail/data/aa/bb/<sha256>.<ext>; the post page (https://pawchive.pw/<service>/user/<id>/post/<id>) declares
// the originals on file.pawchive.pw (or a data node nN.pawchive.pw)/data/aa/bb/<sha256>.<ext>?f=<name>: a video in .post__videos and .post__attachments, the cover in a.fileThumb. The
// video and its cover have different hashes, so no address can be derived from the thumbnail. Rules: a card's post link selects ALL the post's distinct declared
// originals, videos, images and GIFs incl. the cover (by hash; each is its own item, see savePawchivePostMedia); a link to an original, or a thumbnail inside a post page, selects exactly that image; ambiguity,
// a mismatch, foreign metadata or an unusable original is a refusal, never the thumbnail, never a guessed path.
const PAWCHIVE_HTML_MAX_BYTES = 1024 * 1024;
const PAWCHIVE_HTML_TIMEOUT_MS = 8000;
const PAWCHIVE_VIDEO_EXTS = new Set(['mp4', 'webm', 'm4v', 'mov', 'mkv', 'avi']);
const PAWCHIVE_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif']);

// kind 'thumb' (img.pawchive.pw/thumbnail/data/...) or 'file' (file.pawchive.pw/data/... or a numbered data node such as n2.pawchive.pw/data/..., which
// post pages declare for attachments and covers): exact host, https, no credentials or port, aa/bb = the hash start
function parsePawchiveMediaUrl(raw, base) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048 || /\s/.test(raw)) return null;
  let u;
  try { u = new URL(raw, base); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null;
  const host = u.hostname.toLowerCase();
  const m = u.pathname.match(/^\/(thumbnail\/)?data\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\.([A-Za-z0-9]{1,5})$/);
  if (!m || (m[1] ? host !== 'img.pawchive.pw' : !/^(?:file|n\d{1,2})\.pawchive\.pw$/.test(host))) return null;
  if (m[4].slice(0, 2) !== m[2] || m[4].slice(2, 4) !== m[3]) return null;
  return { kind: m[1] ? 'thumb' : 'file', hash: m[4], ext: m[5].toLowerCase(), url: raw };
}

function parsePawchivePostUrl(raw, base) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw, base); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'pawchive.pw' || u.username || u.password || u.port) return null;
  const m = u.pathname.match(/^\/([a-z0-9_-]{1,32})\/user\/([A-Za-z0-9_-]{1,64})\/post\/([A-Za-z0-9_-]{1,64})\/?$/);
  return m ? { service: m[1], user: m[2], id: m[3], url: `https://pawchive.pw/${m[1]}/user/${m[2]}/post/${m[3]}` } : null;
}

const decodePawchiveAttr = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (all, e) => {
  const k = e.toLowerCase();
  if (k === 'amp') return '&';
  if (k === 'quot') return '"';
  if (k === 'apos') return "'";
  if (k === 'lt') return '<';
  if (k === 'gt') return '>';
  const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
});
const pawchiveAttr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodePawchiveAttr(m[2] !== undefined ? m[2] : m[3]) : null;
};

// One bounded GET of the post page: no cookies, no redirect, HTML only, at most PAWCHIVE_HTML_MAX_BYTES within PAWCHIVE_HTML_TIMEOUT_MS.
// Resolves { html } or { status } (an HTTP answer that is not 2xx) or { refused: true }. Every exit (answer, refusal, error, timeout) ends the transfer:
// an unread or partly read body is cancelled and the request is aborted, so a refused page is never left streaming.
async function fetchPawchivePostHtml(postUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAWCHIVE_HTML_TIMEOUT_MS);
  let res = null;
  try {
    res = await fetch(postUrl, { method: 'GET', credentials: 'omit', redirect: 'manual', headers: { Accept: 'text/html' }, signal: controller.signal });
    if (!res || res.type === 'opaqueredirect' || res.redirected || (res.status >= 300 && res.status < 400)) return { refused: true };
    if (!res.ok) {
      let retryAfter = null;
      try { retryAfter = res.headers.get('retry-after'); } catch (_) {}
      return { status: res.status, retryAfter };
    }
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(res.headers.get('content-type') || '')) return { refused: true };
    const declared = parseInt(res.headers.get('content-length') || '', 10);
    if (declared > PAWCHIVE_HTML_MAX_BYTES) return { refused: true };
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > PAWCHIVE_HTML_MAX_BYTES) { try { await reader.cancel(); } catch (_) {} return { refused: true }; }
        chunks.push(value);
      }
      const all = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.byteLength; }
      return { html: new TextDecoder('utf-8').decode(all) };
    }
    const text = await res.text();
    return text.length > PAWCHIVE_HTML_MAX_BYTES ? { refused: true } : { html: text };
  } catch (_) {
    return { refused: true };
  } finally {
    clearTimeout(timer);
    try { if (res && res.body && !res.body.locked && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (_) {}
    controller.abort();
  }
}

// What the post page declares about itself and its media. Anything that does not fit the layout makes the whole page unusable (refused), so that a
// foreign or malformed declaration can never leave a different, unrelated original as the "only" candidate.
// -> { videos: [url], images: [{ url, hash, thumbHash }] } (deduplicated by exact address) or null
function parsePawchivePostHtml(html, post) {
  const meta = (name) => { const m = new RegExp(`<meta\\b[^>]*\\sname\\s*=\\s*"${name}"[^>]*>`, 'i').exec(html); return m ? pawchiveAttr(m[0], 'content') : null; };
  if (meta('service') !== post.service || meta('user') !== post.user || meta('id') !== post.id) return null;
  const canonical = /<link\b[^>]*\srel\s*=\s*"canonical"[^>]*>/i.exec(html);
  if (canonical) {
    const c = parsePawchivePostUrl(pawchiveAttr(canonical[0], 'href') || '', post.url);
    if (!c || c.url !== post.url) return null;
  }
  const region = (marker, close) => {
    const at = html.search(new RegExp(`class\\s*=\\s*"[^"]*\\b${marker}\\b`, 'i'));
    if (at < 0) return '';
    const end = html.indexOf(close, at);
    return html.slice(at, end < 0 ? html.length : end);
  };
  const videos = [];
  const images = [];
  let unusable = false;
  // true when the address is accepted as a video of the page
  const declare = (raw, role) => {
    const p = parsePawchiveMediaUrl(raw, post.url);
    let ext = '';
    try { ext = ((new URL(raw, post.url).pathname.match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || '').toLowerCase(); } catch (_) {}
    const mediaLike = role !== 'attachment' || PAWCHIVE_VIDEO_EXTS.has(ext) || PAWCHIVE_IMAGE_EXTS.has(ext);
    if (!p || p.kind !== 'file') { if (mediaLike) unusable = true; return false; }
    if (PAWCHIVE_VIDEO_EXTS.has(p.ext)) { if (!videos.includes(p.url)) videos.push(p.url); return true; }
    // a video element or source never declares an image: that contradiction makes the page unusable instead of an image-only post
    if (role === 'video') { unusable = true; return false; }
    if (PAWCHIVE_IMAGE_EXTS.has(p.ext)) { if (!images.some((i) => i.url === p.url)) images.push({ url: p.url, hash: p.hash, thumbHash: null }); }
    else if (role !== 'attachment') unusable = true;
    return false;
  };
  // Every <video> must declare a usable video of its own (src on it or on one of its <source> children, of a video type): a player left unresolved makes
  // the page unusable, whatever other players declare. Several sources of one player may repeat a video; a <source> outside a <video> is a player by itself.
  let player = null;
  const players = [];
  for (const tag of region('post__videos', '</ul>').match(/<\/?(?:source|video)\b[^>]*>/gi) || []) {
    if (tag[1] === '/') { player = null; continue; }
    const isVideo = /^<video\b/i.test(tag);
    if (isVideo || !player) { player = { resolved: false }; players.push(player); }
    const type = pawchiveAttr(tag, 'type');
    if (type && !/^video\//i.test(type.trim())) unusable = true;
    const src = pawchiveAttr(tag, 'src');
    if (src && declare(src, 'video')) player.resolved = true;
  }
  if (players.some((pl) => !pl.resolved)) unusable = true;
  for (const tag of region('post__attachments', '</ul>').match(/<a\b[^>]*>/gi) || []) {
    const href = pawchiveAttr(tag, 'href');
    if (href) declare(href, 'attachment');
  }
  const files = region('post__files', '</section>');
  const anchors = files.match(/<a\b[^>]*\sclass\s*=\s*"[^"]*\bfileThumb\b[^"]*"[^>]*>(?:(?!<\/a>)[\s\S])*/gi) || [];
  for (const block of anchors) {
    const href = pawchiveAttr(/^<a\b[^>]*>/i.exec(block)[0], 'href');
    if (!href) continue;
    declare(href, 'file');
    const img = /<img\b[^>]*>/i.exec(block);
    const th = img ? parsePawchiveMediaUrl(pawchiveAttr(img[0], 'data-src') || pawchiveAttr(img[0], 'src') || '', post.url) : null;
    const entry = images.find((i) => i.url === href);
    if (entry && th && th.kind === 'thumb') entry.thumbHash = th.hash;
  }
  // BUGFIX-MULTISITE-01: the previews the page shows (a not-imported post shows only these, with no original link), and the site's own
  // not-imported state. That state is read only from the site's generated markup before the creator's content (the header badge, missing
  // attachments, the missing-files line), never from post text; the counts are kept only when the line has exactly the site's wording.
  const previews = [];
  for (const img of files.match(/<img\b[^>]*>/gi) || []) {
    const th = parsePawchiveMediaUrl(pawchiveAttr(img, 'data-src') || pawchiveAttr(img, 'src') || '', post.url);
    if (th && th.kind === 'thumb' && !previews.includes(th.hash)) previews.push(th.hash);
  }
  const contentAt = html.search(/class\s*=\s*"[^"]*\bpost__content\b/i);
  const head = contentAt < 0 ? html : html.slice(0, contentAt);
  const stats = /<p\b[^>]*\sclass\s*=\s*"[^"]*\bpost__missing-stats\b[^"]*"[^>]*>([^<]*)<\/p>/i.exec(head);
  let missing = null;
  if (stats || /class\s*=\s*"[^"]*\b(?:state-badge--preview|post__attachment-link--missing)\b/i.test(head)) {
    missing = { photos: null, videos: null };
    const line = stats ? /^Missing (.+?),? as this post has not yet been imported\.$/.exec(stats[1].replace(/\s+/g, ' ').trim()) : null;
    if (line) {
      const n = { photos: 0, videos: 0 };
      const ok = line[1].split(', ').every((part) => {
        const m = /^(\d{1,3}) (full-res photos?|videos?)$/.exec(part);
        if (m) n[m[2].startsWith('v') ? 'videos' : 'photos'] += Number(m[1]);
        return Boolean(m);
      });
      if (ok) missing = n;
    }
  }
  return unusable ? null : { videos, images, previews, missing };
}

// The failure code of a post whose originals the site has not imported: the counts the page states, else none (feedback.js reads them back).
function pawchiveMissingCode(missing) {
  return 'NOT_ARCHIVED' + (missing && Number.isInteger(missing.photos) && Number.isInteger(missing.videos) ? `_P${missing.photos}_V${missing.videos}` : '');
}

// Verifies the exact declared original with the shared probe: a real response of the expected kind, or a failure that is reported as it is.
// -> { plan } for a verified group, { fail: plan } for a refusal that carries a status, or { refused: true }
async function probePawchiveOriginal(parsed, postUrl, srcUrl) {
  const isVideo = PAWCHIVE_VIDEO_EXTS.has(parsed.ext);
  const probe = { url: parsed.url, source: 'specialized_provider', finalScore: 96, baseScore: 96, rawWidth: 0, rawHeight: 0, allowVideo: isVideo, isBooruCandidate: isVideo, verified: false, contentLength: 0, contentType: '', status: 0 };
  const ok = await probeCandidate(probe);
  if (!ok) {
    const status = probe.status;
    if (status === 429 || status === 401 || status === 403 || status === 404 || status === 410) {
      return { fail: adaptCandidateToGroup({
        url: srcUrl, source: 'initial_src', tier: 'preview', score: 0, _rateLimited: status === 429, _verificationStatus: status,
        error: status === 429 ? 'RATE_LIMIT' : (status === 404 || status === 410 ? 'NOT_FOUND' : 'AUTH_REQUIRED')
      }) };
    }
    return { refused: true };
  }
  const mime = String(probe.contentType || '').split(';')[0].trim().toLowerCase();
  if (!(isVideo ? mime.startsWith('video/') : mime.startsWith('image/'))) return { refused: true };
  const group = createCandidateGroup({
    id: `pawchive_original_${parsed.hash}`,
    source: 'specialized_provider',
    provider: 'pawchive',
    tier: 'original',
    score: 96,
    validationMode: 'probe',
    transport: 'direct',
    variants: [{ url: parsed.url, expectedExtension: `.${parsed.ext}`, verified: true, verifiedUrl: parsed.url, mimeEvidence: MIME_EVIDENCE.HTTP_RESPONSE, contentType: mime, contentLength: probe.contentLength }],
    metadata: { verified: true, verifiedUrl: parsed.url, mimeEvidence: MIME_EVIDENCE.HTTP_RESPONSE, contentType: mime, contentLength: probe.contentLength, mediaType: isVideo ? 'video' : 'image', hash: parsed.hash, postUrl: postUrl || '' }
  });
  group.verified = true;
  if (isVideo) group.allowVideo = true;
  return { plan: group };
}

/**
 * Which declared original a selected thumbnail of a post stands for (used by the save resolver).
 * -> { chosen: parsed original } or { why: refusal reason }
 */
function selectPawchivePostOriginal(clicked, post, isFeedCard, declared) {
  // the selected preview must be one of this post's own images (its cover)
  const mine = declared.images.filter((i) => i.hash === clicked.hash || i.thumbHash === clicked.hash);
  // a preview the page shows without its original, on a page the site marks as not imported: nothing of it can be fetched
  const previewOnly = mine.length === 0 && Boolean(declared.missing) && (declared.previews || []).includes(clicked.hash);
  if (mine.length === 0 && !previewOnly) return { why: 'preview is not of this post' };
  if (previewOnly && !isFeedCard) return { unavailable: true };
  let chosen = null;
  if (isFeedCard) {
    // a feed card: every distinct original the post declares (videos, then images and GIFs incl. the cover; one per hash). Thumbnails and posters are
    // never declarations (parsePawchivePostHtml accepts only originals), so they are never items.
    const items = [];
    for (const raw of [...declared.videos, ...declared.images.map((i) => i.url)]) {
      const v = parsePawchiveMediaUrl(raw, post.url);
      if (!v) return { why: 'unusable original' };
      if (!items.some((x) => x.hash === v.hash)) items.push(v);
    }
    // several originals: the resolver saves each one separately (resolvePawchiveOriginalPlan)
    if (items.length > 1) return { chosen: items[0], items, partial: Boolean(declared.missing) };
    // a not-imported post: none of its originals exists, or only this one (the rest is reported as unavailable)
    if (declared.missing) return items.length ? { chosen: items[0], items, partial: true } : { unavailable: true };
    chosen = items[0] || null;
  } else if (mine.length === 1) {
    // a thumbnail inside the post page itself: that image
    chosen = parsePawchiveMediaUrl(mine[0].url, post.url);
  }
  return chosen ? { chosen } : { why: 'ambiguous' };
}

/**
 * The Pawchive resolver of resolveOriginalMediaPlan. Handles exactly the selections whose clicked address is a Pawchive thumbnail or original:
 * returns undefined when the selection is not one (the generic pipeline continues), otherwise a verified original plan, an error plan (HTTP 401/403/404/429
 * of the post page or the original) or null (refused: ambiguous, mismatched, foreign, malformed, unusable). It never returns the clicked thumbnail.
 */
async function resolvePawchiveOriginalPlan({ srcUrl, pageUrl, linkUrl, allowPostMedia = false }) {
  const clicked = parsePawchiveMediaUrl(srcUrl, pageUrl || undefined);
  if (!clicked) return undefined;
  const refuse = (why) => { console.warn('[MediaLatch] Pawchive: сохранение оригинала отклонено (' + why + '):', sanitizeUrlForLog(srcUrl)); return null; };

  // the selection is itself an original: exactly that address
  if (clicked.kind === 'file') {
    const out = await probePawchiveOriginal(clicked, '', srcUrl);
    return out.plan || out.fail || refuse('original');
  }

  // a link to an original of the same hash selects that original; a link to another asset is a mismatched selection
  const linkedFile = linkUrl ? parsePawchiveMediaUrl(linkUrl, pageUrl || undefined) : null;
  if (linkedFile) {
    if (linkedFile.kind !== 'file' || linkedFile.hash !== clicked.hash) return refuse('link of another asset');
    const out = await probePawchiveOriginal(linkedFile, '', srcUrl);
    return out.plan || out.fail || refuse('original');
  }

  // otherwise the post decides: the card's own post link (a feed preview), or the post page the thumbnail is shown in (an image inside the post)
  const linkedPost = linkUrl ? parsePawchivePostUrl(linkUrl, pageUrl || undefined) : null;
  const pagePost = pageUrl ? parsePawchivePostUrl(pageUrl) : null;
  const post = linkedPost || pagePost;
  if (!post) return refuse('no post');
  const fetched = await fetchPawchivePostHtml(post.url);
  if (fetched.status !== undefined) {
    const status = fetched.status;
    if (status === 429 || status === 401 || status === 403 || status === 404 || status === 410) {
      return adaptCandidateToGroup({ url: srcUrl, source: 'initial_src', tier: 'preview', score: 0, _rateLimited: status === 429, _verificationStatus: status, error: status === 429 ? 'RATE_LIMIT' : (status === 404 || status === 410 ? 'NOT_FOUND' : 'AUTH_REQUIRED') });
    }
    return refuse('post page HTTP ' + status);
  }
  if (!fetched.html) return refuse('post page');
  const declared = parsePawchivePostHtml(fetched.html, post);
  if (!declared) return refuse('post identity or declarations');
  const picked = selectPawchivePostOriginal(clicked, post, Boolean(linkedPost), declared);
  if (picked.unavailable) {
    // the site states it has not imported this post's originals: a failure of its own, never the preview, a filename or a guessed address
    console.warn('[MediaLatch] Pawchive: оригинал не импортирован сайтом (' + pawchiveMissingCode(declared.missing) + '):', sanitizeUrlForLog(srcUrl));
    const plan = adaptCandidateToGroup({ url: srcUrl, source: 'initial_src', tier: 'preview', score: 0, error: 'NOT_ARCHIVED' });
    if (plan) plan.failureCode = pawchiveMissingCode(declared.missing);
    return plan;
  }
  if (!picked.chosen) return refuse(picked.why);
  if (picked.items && (picked.items.length > 1 || (picked.partial && allowPostMedia))) {
    // an explicit save of a feed preview of a post with several originals saves them all, each as its own item (savePawchivePostMedia); a caller that
    // cannot do that gets the refusal, never one arbitrary original. A partly imported post also reports its missing originals there.
    if (!allowPostMedia) return refuse('several originals');
    return { pawchivePostMedia: { postUrl: post.url, items: picked.items.map((v) => v.url), ...(picked.partial ? { missingCode: pawchiveMissingCode(declared.missing) } : {}) } };
  }
  const out = await probePawchiveOriginal(picked.chosen, post.url, srcUrl);
  return out.plan || out.fail || refuse('original');
}

// The explicit save of a feed preview whose post declares several originals: every distinct video, image or GIF (by hash) is its own item. Items are verified
// one after the other (the shared probe with its per-kind MIME check, then the shared verify/download/feedback path of a single save), paced, at most
// POST_MEDIA_MAX of them; an item that fails or is refused is reported as its own failed operation and never touches the others. A probe HTTP429
// stops remaining batch discovery; already admitted transfers may continue. A repeated declaration is saved once (one entry per hash).
const POST_MEDIA_MAX = 100;
let PAWCHIVE_POST_MEDIA_PACE_MS = 1000;
const postMediaItemInfos = new WeakSet();

async function savePixivPostMedia(batch, info, tab) {
  const pending=new Set(), rejected=[];
  let limited=false;
  for(let i=0;i<batch.items.length;i++){
    if(pending.size>=2)await Promise.race(pending);
    if(i)await new Promise(resolve=>setTimeout(resolve,PAWCHIVE_POST_MEDIA_PACE_MS));
    const url=batch.items[i];
    if(limited){await pawchiveItemFailed(info,tab,url,{stage:'resolve',code:'RATE_LIMIT',status:429});continue;}
    const postMediaPlan=adaptCandidateToGroup({url,source:'specialized_provider',score:100,tier:'original',provider:'pixiv',transport:'pixiv'});
    const item={menuItemId:'save-image-item',srcUrl:url,pageUrl:batch.postUrl,frameId:info.frameId,postMediaPlan};
    postMediaItemInfos.add(item);
    const work=onContextMenuClicked(item,tab).then(()=>{if(postMediaPlan._rateLimited || postMediaPlan._verificationStatus===429 || postMediaPlan.error==='RATE_LIMIT')limited=true;},error=>{rejected.push(error);}).finally(()=>pending.delete(work));
    pending.add(work);
  }
  await Promise.all(pending);
  if(rejected.length)throw rejected[0];
}

async function pawchiveItemFailed(info, tab, url, failure) {
  const op = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: url, site: fbSiteOf(info.pageUrl || tab?.url, url), cid: info.dbgCid }, tab);
  await fbFail(op, failure);
  await fbBadgeReporter(op)(failure.code === 'RATE_LIMIT' ? 'RATE' : 'ERR', failure.code === 'RATE_LIMIT' ? '#f59e0b' : '#ef4444');
}

async function savePawchivePostMedia(batch, info, tab) {
  if(batch.items.length>POST_MEDIA_MAX){await pawchiveItemFailed(info,tab,batch.postUrl,{stage:'resolve',code:'BATCH_LIMIT'});return;}
  const urls = batch.items;
  const pending = [];
  const tally = { items: batch.items.length, verified: 0, refused: 0, rateLimited: 0, skipped: batch.items.length - urls.length };
  let limited = false;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (limited) {
      tally.rateLimited++;
      await pawchiveItemFailed(info, tab, url, { stage: 'resolve', code: 'RATE_LIMIT', status: 429 });
      continue;
    }
    if (i > 0 && PAWCHIVE_POST_MEDIA_PACE_MS > 0) await new Promise((r) => setTimeout(r, PAWCHIVE_POST_MEDIA_PACE_MS));
    const parsed = parsePawchiveMediaUrl(url, batch.postUrl);
    const out = parsed && parsed.kind === 'file' ? await probePawchiveOriginal(parsed, batch.postUrl, url) : { refused: true };
    const plan = out.plan || out.fail || null;
    if (!plan) {
      tally.refused++;
      await pawchiveItemFailed(info, tab, url, { stage: 'verify', code: 'NO_MEDIA' });
      continue;
    }
    if (out.fail && out.fail._rateLimited === true) { limited = true; tally.rateLimited++; } else if (out.plan) tally.verified++; else tally.refused++;
    const itemInfo = { menuItemId: 'save-image-item', srcUrl: url, pageUrl: info.pageUrl, frameId: info.frameId, postMediaPlan: plan };
    postMediaItemInfos.add(itemInfo);
    pending.push(onContextMenuClicked(itemInfo, tab).then(() => null, error => error));
  }
  // a partly imported post: the originals the site has not imported are one failed operation of their own
  if (typeof batch.missingCode === 'string' && /^NOT_ARCHIVED(?:_P\d{1,3}_V\d{1,3})?$/.test(batch.missingCode)) {
    tally.notArchived = batch.missingCode;
    await pawchiveItemFailed(info, tab, batch.postUrl, { stage: 'resolve', code: batch.missingCode });
  }
  const rejected = (await Promise.all(pending)).find(Boolean);
  if (rejected) throw rejected;
  console.info('[MediaLatch] Pawchive post media:', tally);
  dbg('pawchive', 'batch', 'ok', undefined, { items: tally.items, verified: tally.verified, refused: tally.refused, rateLimited: tally.rateLimited, skipped: tally.skipped, partial: Boolean(tally.notArchived), error: dbgCode(tally.notArchived) }, { cid: info && info.dbgCid, tab: tab && tab.id });
}

/**
 * Universal candidate resolution pipeline returning a structured CandidateGroup (Resolution Plan).
 * Supports Candidate Groups with variant failover policies, provenance scoring, and deferred validation.
 */
async function resolveOriginalMediaPlanImpl(firstArg, secondArg, thirdArg, fourthArg, fifthArg) {
  let srcUrl, pageUrl, linkUrl, tabId, domMeta, frameId, allowPostMedia = false;

  if (typeof firstArg === 'object' && firstArg !== null) {
    frameId = firstArg.frameId;
    allowPostMedia = firstArg.allowPostMedia === true;
    srcUrl = firstArg.srcUrl;
    pageUrl = firstArg.pageUrl;
    linkUrl = firstArg.linkUrl;
    tabId = firstArg.tabId;
    domMeta = firstArg.domMeta || firstArg.domMetadata;
  } else {
    srcUrl = firstArg;
    pageUrl = secondArg;
    linkUrl = thirdArg;
    tabId = fourthArg;
    domMeta = fifthArg;
  }

  const baseUrl = pageUrl || srcUrl || 'https://localhost/';
  // Base for relative URLs of the candidate being added; DOM-derived candidates use their own document's base.
  let candidateBase = baseUrl;
  const candidateGroupMap = new Map();

  function addGroup(group) {
    if (!group || !group.isCandidateGroup) return;
    if (candidateGroupMap.has(group.id)) {
      const existing = candidateGroupMap.get(group.id);
      if (group.score > existing.score) {
        existing.score = group.score;
        existing.finalScore = group.score;
        existing.source = group.source;
      }
    } else {
      candidateGroupMap.set(group.id, group);
    }
  }

  function addCandidate(rawUrl, source, rawWidth = 0, rawHeight = 0) {
    if (!rawUrl) return;
    let targetUrl = rawUrl;
    let explicitScore = null;
    let explicitTier = null;
    let allowVideo = false;
    let isBooruCandidate = false;

    if (typeof rawUrl === 'object' && rawUrl !== null) {
      targetUrl = rawUrl.url || '';
      explicitScore = typeof rawUrl.score === 'number' ? rawUrl.score : null;
      explicitTier = rawUrl.tier || null;
      allowVideo = Boolean(rawUrl.allowVideo);
      isBooruCandidate = Boolean(rawUrl.isBooruCandidate || rawUrl.isBooru);
    }

    if (!targetUrl || typeof targetUrl !== 'string') return;
    if (targetUrl.startsWith('blob:') || targetUrl.startsWith('data:') || targetUrl.startsWith('javascript:')) return;
    const normalized = normalizeCandidateUrl(targetUrl, candidateBase);
    if (!normalized) return;
    if (normalized.startsWith('blob:') || normalized.startsWith('data:') || normalized.startsWith('javascript:')) return;

    // Strict Anime-Pictures original CDN check:
    // If URL matches oimages.anime-pictures.net /<dir>/<md5>.<ext>, merge into single logical group
    const animeInfo = (source === 'specialized_provider' || source === 'initial_src' || source === 'search_result_decoded' || source === 'dom_link')
      ? parseAnimePicturesCdnUrl(normalized)
      : null;

    if (animeInfo) {
      const groupId = `anime_pictures_original_${animeInfo.md5}`;
      if (!candidateGroupMap.has(groupId)) {
        const origGroup = createAnimePicturesOriginalGroup(animeInfo.dir, animeInfo.md5);
        if (origGroup) {
          origGroup.source = source;
          candidateGroupMap.set(groupId, origGroup);
        }
      }
      return;
    }

    // Strict Zerochan original CDN check:
    // If URL matches static.zerochan.net /<name>.full.<id>.<ext>, merge into single logical group
    const zerochanInfo = (source === 'specialized_provider' || source === 'initial_src' || source === 'search_result_decoded' || source === 'dom_link' || source === 'dom_data_original')
      ? parseZerochanMediaUrl(normalized)
      : null;

    if (zerochanInfo && zerochanInfo.isFull) {
      const groupId = `zerochan_original_${zerochanInfo.id}`;
      if (!candidateGroupMap.has(groupId)) {
        const origGroup = createZerochanOriginalGroup(zerochanInfo.id, zerochanInfo.name, normalized);
        if (origGroup) {
          origGroup.source = source;
          candidateGroupMap.set(groupId, origGroup);
        }
      }
      return;
    }

    const baseScore = explicitScore !== null ? explicitScore : scoreCandidateUrl(normalized, source, rawWidth, rawHeight);
    const groupId = `candidate_${normalized}`;

    if (candidateGroupMap.has(groupId)) {
      const existing = candidateGroupMap.get(groupId);
      if (baseScore > existing.score) {
        existing.source = source;
        existing.score = baseScore;
        existing.finalScore = baseScore;
        if (explicitTier) existing.tier = explicitTier;
        if (allowVideo) existing.allowVideo = true;
        if (isBooruCandidate) existing.isBooruCandidate = true;
        if (rawWidth) existing.metadata.rawWidth = rawWidth;
        if (rawHeight) existing.metadata.rawHeight = rawHeight;
      }
    } else {
      const group = adaptCandidateToGroup({
        id: groupId,
        url: normalized,
        source,
        score: baseScore,
        tier: explicitTier || 'legacy',
        rawWidth,
        rawHeight,
        allowVideo,
        isBooruCandidate
      });
      if (group) {
        if (explicitTier) group.tier = explicitTier;
        group.allowVideo = allowVideo;
        group.isBooruCandidate = isBooruCandidate;
        candidateGroupMap.set(groupId, group);
      }
    }
  }

  console.log('[MediaLatch] Старт универсального конвейера поиска медиаплана:', {
    srcUrl: sanitizeUrlForLog(srcUrl),
    pageUrl: sanitizeUrlForLog(pageUrl),
    linkUrl: sanitizeUrlForLog(linkUrl),
    tabId
  });

  // Dedicated X video poster handling (amplify_video_thumb / ext_tw_video_thumb)
  if (isXVideoPosterUrl(srcUrl)) {
    let posterRecovery = null;
    if (tabId) {
      const mediaIdMatch = srcUrl.match(/\/(?:ext_tw_video_thumb|amplify_video_thumb)\/(\d+)/i);
      const mediaIdHint = mediaIdMatch ? mediaIdMatch[1] : null;
      const tweetIdMatch = (pageUrl || '').match(/\/status\/(\d+)/);
      const tweetId = tweetIdMatch ? tweetIdMatch[1] : null;
      const recovery = await recoverXPostMp4Variant(tabId, {
        poster: srcUrl,
        mediaIdHint,
        tweetId,
        postUrl: pageUrl,
        isBlobPlayer: true
      });
      posterRecovery = recovery;
      if (recovery.ok && recovery.mp4Url) {
        const probe = await probeVideoUrlDetails(recovery.mp4Url);
        if (probe.ok) {
          return createCandidateGroup({
            id: `x_video_${encodeURIComponent(recovery.mp4Url.slice(-40))}`,
            source: 'specialized_provider',
            provider: 'twitter',
            tier: 'original',
            score: 100,
            validationMode: 'probe',
            transport: 'direct',
            variants: [{
              url: recovery.mp4Url,
              expectedExtension: 'mp4',
              verified: true,
              mimeEvidence: MIME_EVIDENCE.HTTP_RESPONSE
            }],
            metadata: {
              verified: true,
              mimeEvidence: MIME_EVIDENCE.HTTP_RESPONSE,
              verifiedUrl: recovery.mp4Url,
              contentType: 'video/mp4',
              mediaType: 'video',
              sourceType: 'video'
            }
          });
        }
      }
    }
    console.warn('[MediaLatch] Не удалось восстановить проверенный MP4 для постера X видео:', sanitizeUrlForLog(srcUrl), posterRecovery && !posterRecovery.ok ? describeXRecoveryFailure(posterRecovery) : 'reason=PROBE_FAILED');
    await flashBadge('ERR', '#ef4444');
    return null;
  }

  // SITE-PAWCHIVE-01: a Pawchive thumbnail or original is resolved by the post that declares it (no speculative probes, no thumbnail fallback)
  const pawchivePlan = await resolvePawchiveOriginalPlan({ srcUrl, pageUrl, linkUrl, allowPostMedia });
  if (pawchivePlan !== undefined) return pawchivePlan;
  if(allowPostMedia){
    const pixivPostPlan=await resolvePixivPostMedia({srcUrl,pageUrl,linkUrl});
    if(pixivPostPlan!==undefined)return pixivPostPlan;
  }

  const sankakuPlan = await resolveSankakuOriginalPlan({ srcUrl, pageUrl, linkUrl, tabId, frameId });
  if (sankakuPlan !== undefined) return sankakuPlan;
  const zerochanPagePlan=await resolveZerochanPageOriginal({srcUrl,pageUrl,linkUrl,tabId,frameId});
  if(zerochanPagePlan!==undefined)return zerochanPagePlan;

  // 1. Initial source URL
  if (srcUrl) {
    addCandidate(srcUrl, 'initial_src');
  }

  // 2. Direct linkUrl (DOM <a> link)
  if (linkUrl && linkUrl !== srcUrl) {
    try {
      const parsedLink = new URL(linkUrl, baseUrl);
      const pathname = parsedLink.pathname.toLowerCase();
      const hasImageExt = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(pathname);
      const isDirectMediaLink = /\/(images?|original|data|_images|content|img\/view|uploads?|media|photos?|assets|pictures?)\//i.test(pathname) ||
        pathname.includes('file_only') ||
        parsedLink.hostname.includes('paheal-cdn.net');
      const isWiki = pathname.includes('/wiki/') || pathname.includes('/w/index.php') || /[:/](file|image|файл):/i.test(pathname);
      const isHtmlPagePattern = /\/(post|posts|comment|comments|user|users|tag|tags|upload|thread|threads|forum|article|blog|artworks?|illust)\//i.test(pathname) && !hasImageExt;
      const isSearchPage = pathname.includes('/search') || pathname.includes('/imgres') || (parsedLink.hostname.includes('yandex.') && pathname.includes('/images/search'));

      if (!isWiki && !isHtmlPagePattern && !isSearchPage && (hasImageExt || isDirectMediaLink)) {
        // the link as it is: its query (an id, a signature) belongs to the selected asset, and a queryless twin is another address
        addCandidate(linkUrl, 'dom_link');
      }
    } catch (e) {}
  }

  // 2.1 KNOWN_SITE_RESOLVERS (extracts candidate groups or primary candidate associated with clicked result/link)
  const parsedSrcUrl = (function() {
    try { return srcUrl ? new URL(srcUrl, baseUrl) : null; } catch (e) { return null; }
  })();
  const parsedLinkUrl = (function() {
    try { return linkUrl ? new URL(linkUrl, baseUrl) : null; } catch (e) { return null; }
  })();
  const resolverTargetUrl = parsedSrcUrl || parsedLinkUrl;

  if (resolverTargetUrl) {
    for (const site of KNOWN_SITE_RESOLVERS) {
      if (site.match(resolverTargetUrl, pageUrl, linkUrl)) {
        try {
          if (typeof site.resolveGroups === 'function') {
            const groups = await site.resolveGroups(resolverTargetUrl, pageUrl, linkUrl);
            if (Array.isArray(groups)) {
              for (const g of groups) {
                addGroup(g);
              }
            }
          } else {
            const cands = await site.resolve(resolverTargetUrl, pageUrl, linkUrl);
            if (Array.isArray(cands)) {
              const src = (site.name === 'GoogleImagesEngine' || site.name === 'YandexImagesEngine') ? 'search_result_decoded' : 'specialized_provider';
              for (const c of cands) {
                addCandidate(c, src);
              }
            }
          }
        } catch (e) {}
      }
    }
  }

  // 3. DOM Metadata Candidate Discovery
  let domData = domMeta || null;
  if (!domData && tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        // The selected image lives in the clicked frame; without a valid frameId keep the top-frame default.
        target: Number.isInteger(frameId) && frameId >= 0 ? { tabId, frameIds: [frameId] } : { tabId },
        injectImmediately: true,
        func: extractDomImageMetadata,
        args: [srcUrl]
      });
      if (results && results[0] && results[0].result) {
        domData = results[0].result;
      }
    } catch (e) {}
  }

  if (domData) {
    // DOM-derived relative URLs belong to the document that produced them (its frame URL or <base href>).
    // Only an http(s) base is accepted; anything else keeps the page URL base.
    try {
      const domBase = new URL(String(domData.baseUrl || ''));
      if (domBase.protocol === 'http:' || domBase.protocol === 'https:') candidateBase = domBase.href;
    } catch (e) {}

    // 3.1 Search result decoded URLs (Google, Yandex, Anime-Pictures) - fallbacks if not already present
    if (Array.isArray(domData.searchResultUrls)) {
      for (const u of domData.searchResultUrls) {
        addCandidate(u, 'search_result_decoded');
      }
    }

    // 3.2 data-* attributes (data-original, data-full, data-highres)
    if (Array.isArray(domData.dataAttrs)) {
      for (const u of domData.dataAttrs) {
        addCandidate(u, 'dom_data_original');
      }
    }

    // 3.3 Parent <a>
    if (domData.anchorHref && domData.anchorHref !== srcUrl) {
      addCandidate(domData.anchorHref, 'dom_link');
    }

    // 3.4 srcset candidates (ordered descending by resolution descriptor)
    if (Array.isArray(domData.srcsetList)) {
      for (const rawSrcset of domData.srcsetList) {
        const parsed = parseSrcset(rawSrcset, candidateBase);
        for (let i = 0; i < parsed.length; i++) {
          const widthEstimate = i === 0 ? 2000 : (i === parsed.length - 1 ? 300 : 1000);
          addCandidate(parsed[i], 'dom_srcset', widthEstimate);
        }
      }
    }

    // 3.5 CSS background-image
    if (Array.isArray(domData.bgImages)) {
      const isYandex = (function() {
        const check = (u) => {
          if (!u) return false;
          try {
            const parsed = new URL(u, baseUrl);
            return parsed.hostname.toLowerCase().includes('yandex.') || parsed.hostname.toLowerCase().includes('ya.ru') || parsed.searchParams.has('img_url');
          } catch (e) {
            return /[?&]img_url=/i.test(u);
          }
        };
        return check(pageUrl) || check(linkUrl) || check(srcUrl);
      })();

      const hasClickedYandexCandidate = isYandex && Array.from(candidateGroupMap.values()).some(c => c.source === 'search_result_decoded');
      if (!isYandex || !hasClickedYandexCandidate) {
        for (const bg of domData.bgImages) {
          if (srcUrl && bg !== srcUrl) continue;
          addCandidate(bg, 'css_background');
        }
      }
    }

    // 3.6 Page metadata (og:image, twitter:image) - low priority per specification 3
    if (hasImageAssociation(srcUrl, linkUrl) && Array.isArray(domData.pageMeta)) {
      for (const pm of domData.pageMeta) {
        const metaUrl = typeof pm === 'string' ? pm : (pm?.content || pm?.url || '');
        if (metaUrl) {
          if (isXVideoPosterUrl(srcUrl) || /\/default\/v\d+\/og\/image\.png/i.test(metaUrl)) {
            continue;
          }
          addCandidate(metaUrl, 'page_meta');
          const tenorInfo = extractTenorMedia(metaUrl);
          if (tenorInfo) {
            const fullGif = `https://media.tenor.com/${tenorInfo.id}AAAAC/${tenorInfo.slug}.gif`;
            if (await verifyImageUrl(fullGif)) {
              addCandidate(fullGif, 'specialized_provider');
            }
          }
          const giphyId = extractGiphyId(metaUrl);
          if (giphyId) {
            const fullGif = `https://media.giphy.com/media/${giphyId}/giphy.gif`;
            if (await verifyImageUrl(fullGif)) {
              addCandidate(fullGif, 'specialized_provider');
            }
          }
        }
      }
    }
  }

  candidateBase = baseUrl;

  // 4. Specialized Candidate Providers & Booru Engines
  const targetBooruUrl = parsedSrcUrl || parsedLinkUrl;
  // BOORU-ENGINE-01: a selected Danbooru/Gelbooru/Moebooru preview, sample or JPEG conversion asks for the original of that file:
  // other renditions, the selection itself and files naming another hash are not admitted, and nothing else replaces a refusal.
  const booruSelection = targetBooruUrl ? booruSelectionRule(targetBooruUrl.toString(), pageUrl) : null;
  if (targetBooruUrl) {
    for (const engine of BOORU_ENGINE_RESOLVERS) {
      if (engine.match(targetBooruUrl, pageUrl)) {
        try {
          const cands = await engine.resolve(targetBooruUrl, pageUrl, linkUrl);
          if (Array.isArray(cands)) {
            for (const c of cands) {
              addCandidate(c, 'specialized_provider');
            }
          }
        } catch (e) {}
      }
    }
  }

  if (parsedSrcUrl) {
    // 4.3 Universal CDN / Heuristic transformations
    const cdnCandidates = getGenericCdnCandidates(parsedSrcUrl);
    if (Array.isArray(cdnCandidates)) {
      for (const c of cdnCandidates) {
        addCandidate(c, 'cdn_transform');
      }
    }

    // 4.4 Public MD5 API lookup
    const md5Match = srcUrl.match(/\b([a-f0-9]{32})\b/i);
    const srcHost = parsedSrcUrl.hostname.toLowerCase();
    const isDonmaiCdn = isDanbooruDomain(srcHost);
    // BOORU-ENGINE-01: a booru rendition was already looked up by its engine with file binding; this unbound lookup would accept
    // whatever post the answer names.
    if (md5Match && candidateGroupMap.size <= 3 && !isDonmaiCdn && !booruSelection) {
      const md5 = md5Match[1].toLowerCase();
      const origin = parsedSrcUrl.origin;
      const apiEndpoints = [
        `${origin}/post.json?tags=md5:${md5}`,
        `${origin}/posts.json?tags=md5:${md5}`,
        `${origin}/index.php?page=dapi&s=post&q=index&json=1&tags=md5:${md5}`
      ];
      for (const apiUrl of apiEndpoints) {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 3000);
        let res = null, reader = null;
        try {
          res = await fetch(apiUrl, { signal: ctrl.signal });
          // Arbitrary-origin metadata must stay bounded through the response body, not only headers.
          const maxBytes = 1024 * 1024;
          if (res.ok && Number(res.headers.get('content-length')) <= maxBytes && res.body?.getReader) {
            reader = res.body.getReader();
            const chunks = [];
            let total = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > maxBytes) throw new Error('Metadata size limit exceeded');
              chunks.push(value);
            }
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            const data = JSON.parse(new TextDecoder().decode(bytes));
            const posts = Array.isArray(data) ? data : (data.posts || data.post);
            if (Array.isArray(posts) && posts[0]) {
              const fileUrl = posts[0].file_url || posts[0].file?.url || posts[0].original_url;
              if (fileUrl) addCandidate(fileUrl, 'specialized_provider');
            }
          }
        } catch (e) {
        } finally {
          clearTimeout(tid);
          ctrl.abort();
          if (reader) { try { await reader.cancel(); } catch (_) {} }
          else await cancelResponseBody(res);
        }
      }
    }
  }

  // Also apply CDN transformations to top candidate URLs
  for (const c of Array.from(candidateGroupMap.values())) {
    if (c.source === 'css_background' || c.source === 'dom_data_original') {
      try {
        const cParsed = new URL(c.primaryUrl);
        const transforms = getGenericCdnCandidates(cParsed);
        for (const t of transforms) {
          addCandidate(t, c.source);
        }
      } catch (e) {}
    }
  }

  // 5. Verification & Final Ranking of Groups
  const tierWeight = { original: 30, legacy: 20, fallback: 10, preview: 0 };
  const groups = Array.from(candidateGroupMap.values()).filter(g => !booruSelection || booruSelection.admits(g.primaryUrl)).sort((a, b) => {
    const twA = tierWeight[a.tier] !== undefined ? tierWeight[a.tier] : 20;
    const twB = tierWeight[b.tier] !== undefined ? tierWeight[b.tier] : 20;
    if (twA !== twB) return twB - twA;
    return b.finalScore - a.finalScore;
  });

  const MAX_VERIFICATION_BONUS = 20;
  const verifiedGroups = [];
  const failedAuthoritativeOriginals = [];
  let bestVerifiedScore = -Infinity;
  let lastFailureStatus = null;

  for (const grp of groups) {
    if (grp.validationMode === 'deferred') {
      grp.deferredProtectedValidation = true;
      grp.verified = false;
      verifiedGroups.push(grp);
      if (grp.finalScore > bestVerifiedScore) bestVerifiedScore = grp.finalScore;
      console.log(`[MediaLatch] Группа принята с отложенной валидацией (${grp.provider}, tier: ${grp.tier}, score: ${grp.finalScore}):`, sanitizeGroupIdForLog(grp.id));
    } else {
      if (bestVerifiedScore !== -Infinity && (grp.finalScore + MAX_VERIFICATION_BONUS) <= bestVerifiedScore) {
        const grpTw = tierWeight[grp.tier] !== undefined ? tierWeight[grp.tier] : 20;
        const bestTw = tierWeight[verifiedGroups[0]?.tier] !== undefined ? tierWeight[verifiedGroups[0]?.tier] : 20;
        if (grpTw <= bestTw) {
          break;
        }
      }
      let isOk = false;
      let probeTarget = null;
      const advanceOnCodes = new Set(grp.variantPolicy?.advanceOn || [404, 410]);
      const variantsToProbe = (Array.isArray(grp.variants) && grp.variants.length > 0)
        ? grp.variants
        : [{ url: grp.primaryUrl }];

      for (let vIdx = 0; vIdx < variantsToProbe.length; vIdx++) {
        const variantUrl = variantsToProbe[vIdx].url || grp.primaryUrl;
        probeTarget = {
          url: variantUrl,
          source: grp.source,
          finalScore: grp.finalScore,
          baseScore: grp.score,
          rawWidth: grp.metadata.rawWidth || 0,
          rawHeight: grp.metadata.rawHeight || 0,
          allowVideo: Boolean(grp.allowVideo && grp.isBooruCandidate),
          isBooruCandidate: Boolean(grp.isBooruCandidate),
          verified: false,
          contentLength: 0,
          contentType: '',
          status: 0
        };

        isOk = await probeCandidate(probeTarget);
        if (isOk) {
          if (vIdx > 0 && Array.isArray(grp.variants)) {
            const matchedVariant = grp.variants[vIdx];
            grp.variants.splice(vIdx, 1);
            grp.variants.unshift(matchedVariant);
          }
          break;
        }

        const failStatus = probeTarget.status;
        if (!advanceOnCodes.has(failStatus)) {
          break;
        }
      }

      // PIXIV-SAVING-POLISH-01: a declared Pixiv original whose probe got no answer at all (its deadline on a busy link) stays the
      // candidate, unverified: the manager's staging checks its bytes against the expected image type. Falling back here would save the
      // selected preview instead. An answered failure (any status) is still a refusal below.
      if (!isOk && grp.transport === 'pixiv' && grp.tier === 'original' && probeTarget && !probeTarget.status && probeTarget.networkError) {
        grp.verified = false;
        verifiedGroups.push(grp);
        if (grp.finalScore > bestVerifiedScore) bestVerifiedScore = grp.finalScore;
        continue;
      }
      if (!isOk) {
        console.warn(`[MediaLatch] Группа не подтверждена (${grp.provider}, HTTP: ${(probeTarget && probeTarget.status) || 'не наблюдался'}):`, sanitizeUrlForLog((probeTarget && probeTarget.url) || grp.primaryUrl));
        if (probeTarget && (probeTarget.status === 429 || probeTarget.status === 403 || probeTarget.status === 401)) {
          lastFailureStatus = probeTarget.status;
        }
        const isVideoCandidate = Boolean(grp.allowVideo) || /\.(mp4|webm)($|\?)/i.test(grp.primaryUrl || '');
        if (grp.tier === 'original' && (isVideoCandidate || (probeTarget && (probeTarget.status === 429 || probeTarget.status === 403 || probeTarget.status === 401)))) {
          failedAuthoritativeOriginals.push({
            group: grp,
            status: (probeTarget && probeTarget.status) || 404,
            statusObserved: Boolean(probeTarget && probeTarget.status), // false: 404 is a pipeline default, not an observation
            target: grp.primaryUrl
          });
        }
      }

      if (isOk && probeTarget) {
        grp.verified = true;
        grp.finalScore = probeTarget.finalScore;
        grp.metadata.contentType = probeTarget.contentType;
        grp.metadata.contentLength = probeTarget.contentLength;
        grp.metadata.verifiedUrl = probeTarget.url;
        if (Array.isArray(grp.variants) && grp.variants[0]) {
          grp.variants[0].contentType = probeTarget.contentType;
          grp.variants[0].contentLength = probeTarget.contentLength;
          grp.variants[0].verifiedUrl = probeTarget.url;
          if (grp.variants[0].expectedExtension) {
            grp.metadata.expectedExtension = grp.variants[0].expectedExtension;
          }
        }
        verifiedGroups.push(grp);
        if (grp.finalScore > bestVerifiedScore) bestVerifiedScore = grp.finalScore;
        console.log(`[MediaLatch] Группа подтверждена (${grp.provider}, score: ${grp.finalScore}):`, sanitizeGroupIdForLog(grp.id));
      }
    }
  }

  function isForbiddenCandidateDowngrade(winnerGroup, failedOriginalsList, clickedSrc) {
    if (!winnerGroup) return null;
    if (!Array.isArray(failedOriginalsList) || failedOriginalsList.length === 0) return null;

    const winnerUrl = winnerGroup.primaryUrl || '';
    const winnerMd5 = extractMd5FromUrl(winnerUrl);
    const isWinnerThumbnailOrPreview =
      winnerGroup.tier === 'preview' ||
      winnerGroup.tier === 'fallback' ||
      winnerGroup.source === 'initial_src' ||
      Boolean(winnerGroup.isThumbnail) ||
      /\/+(180x180|preview|thumbnails?|samples?|thumb)\/+/i.test(winnerUrl);

    // Determine the winner's actual media kind from verified response MIME first, then its URL extension;
    // a shared allowVideo hint must not turn a verified JPEG into a video.
    const winnerMime = (winnerGroup.metadata?.contentType || winnerGroup.variants?.[0]?.contentType || '').split(';')[0].trim().toLowerCase();
    let isWinnerVideo = false;
    let isWinnerImage = false;
    if (winnerMime.startsWith('video/')) {
      isWinnerVideo = true;
    } else if (winnerMime.startsWith('image/')) {
      isWinnerImage = true;
    } else if (/\.(mp4|webm)($|\?)/i.test(winnerUrl)) {
      isWinnerVideo = true;
    } else if (/\.(jpe?g|png|gif|webp|avif|bmp|svg)($|\?)/i.test(winnerUrl)) {
      isWinnerImage = true;
    } else if (Boolean(winnerGroup.allowVideo)) {
      isWinnerVideo = true;
    } else {
      isWinnerImage = true;
    }

    for (const failed of failedOriginalsList) {
      const origGrp = failed.group;
      const origUrl = origGrp.primaryUrl || '';
      const origMd5 = extractMd5FromUrl(origUrl);
      const origMime = (origGrp.metadata?.contentType || origGrp.variants?.[0]?.contentType || '').split(';')[0].trim().toLowerCase();
      let isOrigVideo = false;
      if (origMime.startsWith('video/')) {
        isOrigVideo = true;
      } else if (origMime.startsWith('image/')) {
        isOrigVideo = false;
      } else if (/\.(mp4|webm)($|\?)/i.test(origUrl)) {
        isOrigVideo = true;
      } else if (Boolean(origGrp.allowVideo)) {
        isOrigVideo = true;
      }

      // Same asset association:
      const hasMatchingMd5 = Boolean(origMd5 && winnerMd5 && origMd5.toLowerCase() === winnerMd5.toLowerCase());
      const isClickedThumbnailOfOriginal = Boolean(
        (origGrp.source === 'specialized_provider' || origGrp.isBooruCandidate) &&
        (winnerGroup.source === 'initial_src' || winnerUrl === clickedSrc)
      );

      const isSameAsset = hasMatchingMd5 || isClickedThumbnailOfOriginal;
      if (!isSameAsset) continue;

      // Rule 1: Video-to-image/poster downgrade on authoritative failure is strictly forbidden,
      // regardless of tier (even if winnerGroup.tier === 'original')
      if (isOrigVideo && isWinnerImage) {
        return failed;
      }

      // Rule 2: Thumbnail or preview downgrade on authoritative failure is strictly forbidden
      if (isWinnerThumbnailOrPreview) {
        return failed;
      }

      // Rule 3: Lower-tier speculative candidate (e.g. tier: 'legacy', score: 80) for the SAME asset
      // cannot replace an authoritative original (tier: 'original', score: 90) on 401/403/429
      if (origGrp.tier === 'original' && winnerGroup.tier !== 'original') {
        if (failed.status === 401 || failed.status === 403 || failed.status === 429) {
          return failed;
        }
      }
    }
    return null;
  }

  if (verifiedGroups.length > 0) {
    verifiedGroups.sort((a, b) => {
      const twA = tierWeight[a.tier] !== undefined ? tierWeight[a.tier] : 20;
      const twB = tierWeight[b.tier] !== undefined ? tierWeight[b.tier] : 20;
      if (twA !== twB) return twB - twA;
      return b.finalScore - a.finalScore;
    });
    const winner = verifiedGroups[0];

    // If an authoritative/original candidate failed with 429, 403 or 401, do not mask with lower-provenance/thumbnail/poster!
    const forbiddenDowngrade = isForbiddenCandidateDowngrade(winner, failedAuthoritativeOriginals, srcUrl);
    if (forbiddenDowngrade) {
      const failStatus = forbiddenDowngrade.status;
      console.warn(`[MediaLatch] Отмена медиаплана: оригинальный кандидат вернул ошибку (HTTP ${failStatus}), отсекаем fallback/превью/постер`);
      return adaptCandidateToGroup({
        url: srcUrl,
        source: 'initial_src',
        tier: 'preview',
        score: 0,
        _rateLimited: failStatus === 429,
        _verificationStatus: failStatus,
        error: failStatus === 429 ? 'RATE_LIMIT' : 'AUTH_REQUIRED'
      });
    }

    console.log(`[MediaLatch] Выбран лучший медиаплан (${winner.provider}, tier: ${winner.tier}, score: ${winner.finalScore}):`, sanitizeGroupIdForLog(winner.id));
    return winner;
  }

  // If a candidate explicitly failed with 429 or 403/401, do not mask with thumbnail!
  if (lastFailureStatus === 429 || lastFailureStatus === 403 || lastFailureStatus === 401) {
    console.warn('[MediaLatch] Отмена медиаплана: ошибка авторизации или лимита запросов (HTTP ' + lastFailureStatus + ')');
    return adaptCandidateToGroup({
      url: srcUrl,
      source: 'initial_src',
      tier: 'preview',
      score: 0,
      _rateLimited: lastFailureStatus === 429,
      _verificationStatus: lastFailureStatus,
      error: lastFailureStatus === 429 ? 'RATE_LIMIT' : 'AUTH_REQUIRED'
    });
  }

  // If an authoritative original video candidate failed, strictly forbid downgrading to preview thumbnail / poster
  const failedOrigVideo = failedAuthoritativeOriginals.find(f => {
    const origGrp = f.group;
    const origUrl = origGrp?.primaryUrl || '';
    return Boolean(origGrp?.allowVideo) || /\.(mp4|webm)($|\?)/i.test(origUrl);
  });
  if (failedOrigVideo) {
    const failStatus = failedOrigVideo.status;
    console.warn(`[MediaLatch] Отмена медиаплана: оригинальное видео вернуло ошибку (HTTP ${failStatus}), отсекаем fallback на превью`);
    return adaptCandidateToGroup({
      url: srcUrl,
      source: 'initial_src',
      tier: 'preview',
      score: 0,
      _verificationStatus: failStatus,
      _verificationStatusObserved: failedOrigVideo.statusObserved,
      error: failStatus === 429 ? 'RATE_LIMIT' : (failStatus === 401 || failStatus === 403 ? 'AUTH_REQUIRED' : 'NOT_FOUND')
    });
  }

  // BOORU-ENGINE-01: no admitted original for a booru rendition is a refusal, not a save of the rendition (no status was observed
  // here; an observed 401/403/429 is reported above).
  if (booruSelection) {
    console.warn('[MediaLatch] Отмена медиаплана: оригинал выбранного booru-превью не подтверждён');
    return adaptCandidateToGroup({
      url: srcUrl || targetBooruUrl.toString(),
      source: 'initial_src',
      tier: 'preview',
      score: 0,
      error: 'NOT_FOUND'
    });
  }

  // 6. Level 7: Fallback to initial srcUrl
  if (srcUrl && !srcUrl.startsWith('blob:') && !srcUrl.startsWith('data:') && !srcUrl.startsWith('javascript:')) {
    console.log('[MediaLatch] [Уровень 7: Fallback] Проверенный оригинал не найден, возврат исходного srcUrl:', srcUrl);
    return adaptCandidateToGroup({
      url: srcUrl,
      source: 'initial_src',
      tier: 'preview',
      score: 0
    });
  }
  return null;
}

/**
 * Backwards-compatible public wrapper: returns primary original media URL string.
 */
async function resolveOriginalImageUrl(firstArg, secondArg, thirdArg, fourthArg, fifthArg) {
  const plan = await resolveOriginalMediaPlan(firstArg, secondArg, thirdArg, fourthArg, fifthArg);
  return plan?.primaryUrl || '';
}

