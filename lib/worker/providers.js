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

/**
 * Detailed network probe for video availability and authorization check.
 * Strictly separate from image probeCandidate() — never relaxes image verification rules.
 * Uses credentials: 'include' to share the browser profile's active session context.
 */
async function probeVideoUrlDetails(candidateUrl, selectedPage = '') {
  if (!candidateUrl || typeof candidateUrl !== 'string' || !MediaLatchSources.allows(candidateUrl, selectedPage)) {
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
      redirect: 'error',
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
        redirect: 'error',
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
          const byteCheck = await verifyMp4ContainerBytes(candidateUrl, selectedPage);
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
  if (!MediaLatchSources.allows(url)) return null;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  const limit = (text ? 8 : 2) * 1024 * 1024;
  let response, reader;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
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
async function verifyMp4ContainerBytes(videoUrl, selectedPage = '') {
  if (!videoUrl || typeof videoUrl !== 'string' || !MediaLatchSources.allows(videoUrl, selectedPage)) {
    return { ok: false, error: 'INVALID_URL' };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);
  let reader = null;
  try {
    const res = await fetch(videoUrl, {
      method: 'GET',
      redirect: 'error',
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
// One log line for a failed recovery: a known error code or a fixed placeholder, never page-supplied text.
function describeXRecoveryFailure(recovery) {
  const code = X_RECOVERY_ERRORS.includes(recovery?.error) ? recovery.error : 'UNKNOWN';
  const detail = X_RECOVERY_DETAILS.includes(recovery?.detail) ? recovery.detail : null;
  return 'reason=' + code + (detail ? ' detail=' + detail : '') + ' diag=' + JSON.stringify(sanitizeXRecoveryDiag(recovery?.diag));
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
            const probe = await probeVideoUrlDetails(candUrl, pageUrl);
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
      probeDetails = await probeVideoUrlDetails(videoUrl, pageUrl);
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

// The explicit save of a feed preview whose post declares several originals: every distinct video, image or GIF (by hash) is its own item. Items are verified
// one after the other (the shared probe with its per-kind MIME check, then the shared verify/download/feedback path of a single save), paced, at most
// POST_MEDIA_MAX of them; an item that fails or is refused is reported as its own failed operation and never touches the others. A probe HTTP429
// stops remaining batch discovery; already admitted transfers may continue. A repeated declaration is saved once (one entry per hash).
const POST_MEDIA_MAX = 100;
let PAWCHIVE_POST_MEDIA_PACE_MS = 1000;
const postMediaItemInfos = new WeakSet();

// MANAGER-BATCH-PROGRESS-02: the proven list of a multi-file artwork (savePixivPostMedia) or post (savePawchivePostMedia) is one worker batch: one
// slot per proven item, opened only here, after resolvePixivPostMedia / resolvePawchiveOriginalPlan and the admitting document proved the list.
// An item's slot is bound by its operation (fbBegin, info.batchSlot) before that operation can finish; the loops settle what never got a job and
// close the unstarted slots even when they end early. Batch data never reaches an admission, source or owner decision.
async function savePixivPostMedia(batch, info, tab) {
  const pending=new Set(), rejected=[], slots=[];
  let limited=false, group=null;
  try{
    group=await batchOpen('pixiv',batch.items.length);
    for(let i=0;i<batch.items.length;i++){
      if(pending.size>=2)await Promise.race(pending);
      const url=batch.items[i], slot=batchRef(group,i);
      if(await batchStopped(slot))break;     // "Cancel remaining" was accepted: no further page is requested (running ones finish cooperatively)
      if(i)await new Promise(resolve=>setTimeout(resolve,PAWCHIVE_POST_MEDIA_PACE_MS));
      slots.push(slot);
      if(limited){await pawchiveItemFailed(info,tab,url,{stage:'resolve',code:'RATE_LIMIT',status:429},slot);continue;}
      const postMediaPlan=adaptCandidateToGroup({url,source:'specialized_provider',score:100,tier:'original',provider:'pixiv',transport:'pixiv'});
      const item={menuItemId:'save-image-item',srcUrl:url,pageUrl:batch.postUrl,frameId:info.frameId,postMediaPlan,batchSlot:slot};
      postMediaItemInfos.add(item);
      const work=onContextMenuClicked(item,tab).then(()=>{if(postMediaPlan._rateLimited || postMediaPlan._verificationStatus===429 || postMediaPlan.error==='RATE_LIMIT')limited=true;},error=>{rejected.push(error);}).then(()=>batchSettle(slot)).finally(()=>pending.delete(work));
      pending.add(work);
    }
  }finally{
    await Promise.allSettled([...pending]);
    for(const slot of slots)await batchSettle(slot);
    await batchClose(group);
  }
  if(rejected.length)throw rejected[0];
}

async function pawchiveItemFailed(info, tab, url, failure, slot) {
  if (slot && await batchStopped(slot)) return;
  const op = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: url, site: fbSiteOf(info.pageUrl || tab?.url, url), cid: info.dbgCid, slot }, tab);
  await fbFail(op, failure);
  await fbBadgeReporter(op)(failure.code === 'RATE_LIMIT' ? 'RATE' : 'ERR', failure.code === 'RATE_LIMIT' ? '#f59e0b' : '#ef4444');
  await batchSettle(slot, 'failed');
}

async function savePawchivePostMedia(batch, info, tab) {
  if(batch.items.length>POST_MEDIA_MAX){await pawchiveItemFailed(info,tab,batch.postUrl,{stage:'resolve',code:'BATCH_LIMIT'});return;}
  const urls = batch.items;
  const pending = [], slots = [];
  const tally = { items: batch.items.length, verified: 0, refused: 0, rateLimited: 0, skipped: batch.items.length - urls.length };
  const partial = typeof batch.missingCode === 'string' && /^NOT_ARCHIVED(?:_P\d{1,3}_V\d{1,3})?$/.test(batch.missingCode);
  let limited = false, group = null, rejected;
  try {
    // two or more distinct declared originals are one group; the missing originals are never slots (only the diagnostic below, which keeps its own operation)
    if (urls.length >= 2) group = await batchOpen('pawchive', urls.length, partial);
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i], slot = batchRef(group, i);
      if (await batchStopped(slot)) break;     // "Cancel remaining" was accepted: no further probe or save; the NOT_ARCHIVED diagnostic below is still reported
      slots.push(slot);
      if (limited) {
        tally.rateLimited++;
        await pawchiveItemFailed(info, tab, url, { stage: 'resolve', code: 'RATE_LIMIT', status: 429 }, slot);
        continue;
      }
      if (i > 0 && PAWCHIVE_POST_MEDIA_PACE_MS > 0) await new Promise((r) => setTimeout(r, PAWCHIVE_POST_MEDIA_PACE_MS));
      const parsed = parsePawchiveMediaUrl(url, batch.postUrl);
      const out = parsed && parsed.kind === 'file' ? await probePawchiveOriginal(parsed, batch.postUrl, url) : { refused: true };
      const plan = out.plan || out.fail || null;
      if (!plan) {
        tally.refused++;
        await pawchiveItemFailed(info, tab, url, { stage: 'verify', code: 'NO_MEDIA' }, slot);
        continue;
      }
      if (out.fail && out.fail._rateLimited === true) { limited = true; tally.rateLimited++; } else if (out.plan) tally.verified++; else tally.refused++;
      const itemInfo = { menuItemId: 'save-image-item', srcUrl: url, pageUrl: info.pageUrl, frameId: info.frameId, postMediaPlan: plan, batchSlot: slot };
      postMediaItemInfos.add(itemInfo);
      pending.push(onContextMenuClicked(itemInfo, tab).then(() => null, error => error).then(async (error) => { await batchSettle(slot); return error; }));
    }
    // a partly imported post: the originals the site has not imported are one failed operation of their own
    if (partial) {
      tally.notArchived = batch.missingCode;
      await pawchiveItemFailed(info, tab, batch.postUrl, { stage: 'resolve', code: batch.missingCode });
    }
  } finally {
    rejected = (await Promise.all(pending)).find(Boolean);
    for (const slot of slots) await batchSettle(slot);
    await batchClose(group);
  }
  if (rejected) throw rejected;
  console.info('[MediaLatch] Pawchive post media:', tally);
  dbg('pawchive', 'batch', 'ok', undefined, { items: tally.items, verified: tally.verified, refused: tally.refused, rateLimited: tally.rateLimited, skipped: tally.skipped, partial: Boolean(tally.notArchived), error: dbgCode(tally.notArchived) }, { cid: info && info.dbgCid, tab: tab && tab.id });
}

/**
 * Universal candidate resolution pipeline returning a structured CandidateGroup (Resolution Plan).
 * Supports Candidate Groups with variant failover policies, provenance scoring, and deferred validation.
 */
async function resolveOriginalMediaPlanImpl(firstArg, secondArg, thirdArg, fourthArg, fifthArg) {
  let srcUrl, pageUrl, linkUrl, tabId, domMeta, frameId, allowPostMedia = false, pixivInline;

  if (typeof firstArg === 'object' && firstArg !== null) {
    frameId = firstArg.frameId;
    allowPostMedia = firstArg.allowPostMedia === true;
    pixivInline = firstArg.pixivInline;   // set only by the worker's trusted Pixiv inline route (PIXIV-INLINE-01), never from a page
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
  if (srcUrl && !normalizeCandidateUrl(srcUrl, baseUrl, pageUrl)) return null;
  if (linkUrl && !normalizeCandidateUrl(linkUrl, baseUrl, pageUrl)) {
    if (!srcUrl) return null;
    linkUrl = null; // An incidental non-media parent link must not invalidate the selected image.
  }
  // Base for relative URLs of the candidate being added; DOM-derived candidates use their own document's base.
  let candidateBase = baseUrl;
  const candidateGroupMap = new Map();

  function addGroup(group) {
    if (!group || !group.isCandidateGroup || !MediaLatchSources.allows(group.primaryUrl, pageUrl) ||
        group.variants?.some(v => !MediaLatchSources.allows(v.url, pageUrl))) return;
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
    const normalized = normalizeCandidateUrl(targetUrl, candidateBase, pageUrl);
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

  // PIXIV-INLINE-01: an explicit inline Save this / Save all is resolved by its own strict entry and by nothing else
  if (pixivInline) return resolvePixivInlineMedia({ srcUrl, pageUrl, linkUrl, inline: pixivInline });

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
    if (hasMediaAssociation(srcUrl, linkUrl) && Array.isArray(domData.pageMeta)) {
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
          res = await fetch(apiUrl, { redirect: 'error', signal: ctrl.signal });
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
          selectedPage: pageUrl,
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

