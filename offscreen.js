// offscreen.js - Manages protected media fetches, Blob URLs, and media sniffing in offscreen document

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (chrome.runtime?.id && sender?.id && sender.id !== chrome.runtime.id) {
      sendResponse({ success: false, error: 'UNAUTHORIZED_SENDER' });
      return false;
    }

    if (message.action === 'FETCH_GELBOORU_BLOB' || message.action === 'FETCH_PROTECTED_BLOB') {
      if (typeof message.url !== 'string' || !message.url.trim()) {
        sendResponse({ success: false, error: 'INVALID_URL: message.url must be a non-empty string' });
        return false;
      }

      // Allowlist IPC payloads: AbortSignal is strictly local-only and MUST NOT be forwarded from IPC.
      // Only validated maxBodyBytes is accepted from message or message.options.
      const fetchOptions = {};
      if (message.maxBodyBytes !== undefined) {
        fetchOptions.maxBodyBytes = message.maxBodyBytes;
      } else if (message.options && typeof message.options === 'object' && message.options.maxBodyBytes !== undefined) {
        fetchOptions.maxBodyBytes = message.options.maxBodyBytes;
      }

      fetchProtectedBlob(message.url, fetchOptions)
        .then(result => sendResponse(result))
        .catch(err => {
          console.error('[Offscreen] Protected fetch failed:', err);
          sendResponse({ success: false, error: err.message || String(err) });
        });
      return true;
    }

    if (message.action === 'REVOKE_BLOB_URL') {
      if (message.blobUrl && typeof message.blobUrl === 'string') {
        try {
          URL.revokeObjectURL(message.blobUrl);
        } catch (e) {}
      }
      sendResponse({ success: true });
      return true;
    }

  if (message.action === 'CONVERT_X_TWEET_VIDEO_TO_GIF' || message.action === 'CONVERT_REDDIT_VIDEO_TO_GIF') {
    const isReddit = message.action === 'CONVERT_REDDIT_VIDEO_TO_GIF';
    const converter = isReddit ? convertRedditVideoToGif : convertXTweetVideoToGif;
    converter(message.url, {
      jobId: message.jobId,
      maxDuration: message.maxDuration,
      maxFrames: message.maxFrames,
      maxDimension: message.maxDimension,
      maxSizeBytes: message.maxSizeBytes,
      frames: message.frames,
      duration: message.duration,
      width: message.width,
      height: message.height
    })
      .then(result => {
        if (result && result.exceedsDuration) {
          sendResponse({
            success: true,
            exceedsDuration: true,
            action: 'SAVE_DIRECT_MP4',
            duration: result.duration,
            threshold: result.threshold
          });
          return;
        }
        // Send strictly lightweight metadata and Blob URL across IPC.
        // Never serialize raw byte buffers across Chrome runtime messaging (64MiB limit).
        const payload = {
          success: true,
          blobUrl: result.blobUrl,
          contentType: result.contentType || 'image/gif',
          size: result.size || 0,
          frames: result.frames || 0,
          duration: result.duration || 0
        };
        sendResponse(payload);
      })
      .catch(err => {
        console.error(`[Offscreen] ${isReddit ? 'Reddit' : 'X'} GIF conversion failed:`, err);
        sendResponse({ success: false, error: err.message || String(err) });
      });
    return true;
  }

  return false;
});
}

const HEADER_TIMEOUT_MS = typeof __HEADER_TIMEOUT_MS !== 'undefined' ? __HEADER_TIMEOUT_MS : 30000;
const INACTIVITY_TIMEOUT_MS = typeof __INACTIVITY_TIMEOUT_MS !== 'undefined' ? __INACTIVITY_TIMEOUT_MS : 60000;
const TOTAL_BODY_TIMEOUT_MS = typeof __TOTAL_BODY_TIMEOUT_MS !== 'undefined' ? __TOTAL_BODY_TIMEOUT_MS : 600000;
const DEFAULT_MAX_PROTECTED_BODY_BYTES = typeof __DEFAULT_MAX_PROTECTED_BODY_BYTES !== 'undefined' ? __DEFAULT_MAX_PROTECTED_BODY_BYTES : (50 * 1024 * 1024);
const MAX_ALLOWED_PROTECTED_BODY_BYTES = typeof __MAX_ALLOWED_PROTECTED_BODY_BYTES !== 'undefined' ? __MAX_ALLOWED_PROTECTED_BODY_BYTES : (50 * 1024 * 1024);

function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('Aborted'));
  }
  if (typeof __mockSleep === 'function') {
    return __mockSleep(ms);
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    let onAbort = null;
    onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason || new Error('Aborted'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
  });
}

/**
 * Detects whether buffer contains a valid SVG document (XML root <svg>).
 * Rejects HTML, XML errors (e.g. <Error>, <errors>), Cloudflare challenges, and arbitrary XML.
 *
 * @param {ArrayBuffer|Uint8Array|number[]} buffer
 * @returns {boolean} true if payload represents a valid SVG image.
 */
function isSvgPayload(buffer) {
  if (!buffer) return false;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 4) return false;

  let offset = 0;
  // Skip UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    offset = 3;
  }

  // Convert initial chunk (up to 4096 bytes) to string for XML header inspection
  const maxInspect = Math.min(bytes.length, offset + 4096);
  let text = '';
  for (let i = offset; i < maxInspect; i++) {
    text += String.fromCharCode(bytes[i]);
  }

  // Reject an HTML doctype; the root check below rejects HTML roots. Nested XHTML
  // inside SVG foreignObject is valid SVG and must not reject the whole image.
  if (/<!doctype\s+html/i.test(text)) {
    return false;
  }

  // Quick negative: XML error documents (<Error>, <errors>, <accessdenied>, challenge)
  if (/<(?:error|errors|accessdenied)\b/i.test(text) || /cf-challenge/i.test(text) || /challenge-platform/i.test(text)) {
    return false;
  }

  // Parse XML header: skip whitespace, comments (<!-- ... -->), processing instructions (<? ... ?>), and DOCTYPE
  let pos = 0;
  while (pos < text.length) {
    while (pos < text.length && /\s/.test(text[pos])) {
      pos++;
    }
    if (pos >= text.length) break;

    // Comment: <!-- ... -->
    if (text.startsWith('<!--', pos)) {
      const endComment = text.indexOf('-->', pos + 4);
      if (endComment === -1) return false;
      pos = endComment + 3;
      continue;
    }

    // Processing instruction: <? ... ?>
    if (text.startsWith('<?', pos)) {
      const endPi = text.indexOf('?>', pos + 2);
      if (endPi === -1) return false;
      pos = endPi + 2;
      continue;
    }

    // DOCTYPE declaration: <!DOCTYPE ... >
    if (text.startsWith('<!DOCTYPE', pos) || text.startsWith('<!doctype', pos)) {
      let inQuote = false;
      let quoteChar = '';
      let endDoc = -1;
      for (let j = pos + 9; j < text.length; j++) {
        const c = text[j];
        if (inQuote) {
          if (c === quoteChar) inQuote = false;
        } else if (c === '"' || c === "'") {
          inQuote = true;
          quoteChar = c;
        } else if (c === '>') {
          endDoc = j;
          break;
        }
      }
      if (endDoc === -1) return false;
      pos = endDoc + 1;
      continue;
    }

    // Must be at root element tag: '<'
    if (text[pos] === '<') {
      const remaining = text.slice(pos);
      const svgTagMatch = remaining.match(/^<(?:\w+:)?svg[\s/>]/i);
      if (svgTagMatch) {
        return true;
      }
    }
    break;
  }

  return false;
}

/**
 * Detects whether buffer declares a structurally corrupt or truncated media container header.
 * Distinguishes invalid complete bodies from incomplete bounded prefixes of valid files.
 *
 * @param {ArrayBuffer|Uint8Array|number[]} buffer - Initial slice of the payload.
 * @param {number} [totalSize] - Known total size of the complete body (at fetch boundary).
 * @returns {boolean} true if container structure is definitively malformed or truncated.
 */
function isMalformedMediaContainer(buffer, totalSize) {
  if (!buffer) return false;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 8) return false;

  let offset = 0;
  while (offset + 8 <= bytes.length && offset <= 64) {
    const boxSize = ((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const isFtyp = bytes[offset + 4] === 0x66 && bytes[offset + 5] === 0x74 && bytes[offset + 6] === 0x79 && bytes[offset + 7] === 0x70;
    if (isFtyp) {
      // ISO BMFF ftyp box must be at least 16 bytes (size: 4, type: 4, major_brand: 4, minor_version: 4)
      if (boxSize < 16) {
        return true;
      }
      // If totalSize of complete body is known at fetch boundary:
      if (typeof totalSize === 'number' && totalSize > 0) {
        if (totalSize < offset + boxSize) {
          return true; // Truncated complete file (cannot fit the declared ftyp box)
        }
      }
      return false;
    }

    // Check for pre-ftyp padding boxes ('wide', 'free', 'skip')
    const brand = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (brand === 'wide' || brand === 'free' || brand === 'skip') {
      if (boxSize < 8 || boxSize > 64) return true;
      offset += boxSize;
    } else {
      break;
    }
  }

  return false;
}

/**
 * Detects whether buffer contains HTML/XML, JSON, or plain text error payloads
 * masquerading as media.
 *
 * @param {ArrayBuffer|Uint8Array|number[]} buffer
 * @returns {boolean} true if payload is detected as HTML/JSON/error text.
 */
function isNonMediaOrErrorPayload(buffer) {
  if (!buffer) return false;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length === 0) return false;

  // 1. Check for leading UTF-8 BOM or whitespace
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    offset = 3;
  }
  while (offset < bytes.length && (bytes[offset] === 0x20 || bytes[offset] === 0x09 || bytes[offset] === 0x0A || bytes[offset] === 0x0D)) {
    offset++;
  }
  if (offset >= bytes.length) return true; // Whitespace-only bytes are not a media container.

  const b0 = bytes[offset];

  // 2. HTML / XML: starts with '<'
  if (b0 === 0x3C) {
    if (isSvgPayload(bytes.subarray(offset))) {
      return false; // Valid SVG is supported media, not an error payload
    }
    return true;
  }

  // 3. JSON: starts with '{' or '['
  if (b0 === 0x7B || b0 === 0x5B) {
    return true;
  }

  // 4. ASCII error signatures (e.g. "404 Not Found", "403 Forbidden", "Error", "Access Denied")
  const sliceStr = String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 64, bytes.length))).toLowerCase();
  if (/^(?:4\d\d|5\d\d)\b/.test(sliceStr)) {
    return true;
  }
  if (/^(?:error|access denied|forbidden|unauthorized|not found|bad request|challenge|blocked)\b/.test(sliceStr)) {
    return true;
  }

  return false;
}

/**
 * Validates and identifies supported protected media hosts.
 */
function getProtectedHostInfo(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'oimages.anime-pictures.net') {
      return { type: 'anime-pictures', hostname };
    }
    if (hostname === 'gelbooru.com' || hostname.endsWith('.gelbooru.com')) {
      return { type: 'gelbooru', hostname };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Parses Retry-After header value in seconds or HTTP-date.
 * Bounds result between 0 and maxDelayMs (default 5000ms).
 */
function parseRetryAfterMs(headerValue, defaultDelayMs = 1000, maxDelayMs = 5000) {
  if (!headerValue || typeof headerValue !== 'string') {
    return defaultDelayMs;
  }
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Math.min(Math.max(seconds * 1000, 0), maxDelayMs);
  }
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.min(Math.max(diff, 0), maxDelayMs);
  }
  return defaultDelayMs;
}

/**
 * Sniffs canonical media MIME type from initial buffer bytes.
 * Detects JPEG, PNG, GIF, WebP, AVIF, MP4, and WebM using file signatures.
 * Strictly rejects HTML/XML/JSON/text or unrecognized binary payloads.
 *
 * @param {ArrayBuffer|Uint8Array|number[]} buffer
 * @returns {string|null} Canonical MIME type or null if unrecognized/non-media.
 */
function sniffMediaMagicBytes(buffer) {
  if (!buffer) return null;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 4) return null;

  // 1. Text/HTML/JSON rejection (starts with '<', whitespace, or '{'/'[', or UTF-8 BOM followed by text)
  let checkOffset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    checkOffset = 3;
  }
  const textStart = checkOffset;
  while (checkOffset < bytes.length && (bytes[checkOffset] === 0x20 || bytes[checkOffset] === 0x09 || bytes[checkOffset] === 0x0A || bytes[checkOffset] === 0x0D)) {
    checkOffset++;
  }
  if (checkOffset < bytes.length) {
    const b0 = bytes[checkOffset];
    if (b0 === 0x3C) {
      if (isSvgPayload(bytes.subarray(checkOffset))) {
        return 'image/svg+xml';
      }
      return null;
    }
    if (b0 === 0x7B || b0 === 0x5B) {
      return null;
    }
  }
  if (checkOffset > textStart) return null; // Whitespace-led non-SVG text is never binary media

  // 2. JPEG: SOI marker 0xFF 0xD8 0xFF
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }

  // 3. PNG: 8-byte signature 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return 'image/png';
  }

  // 4. GIF: GIF87a or GIF89a
  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }

  // 5. WebP: RIFF....WEBP
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }

  // 6. WebM: Matroska EBML header 0x1A 0x45 0xDF 0xA3
  if (bytes.length >= 4 &&
      bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
    return 'video/webm';
  }

  // 7. ISO BMFF ftyp box header: an AVIF still image (brand avif/avis) is an image, every other brand is the
  // existing MP4 behaviour. Without the brand check a real AVIF would be labelled video/mp4.
  const isoKind = (off) => {
    if (off + 12 > bytes.length) return null;
    const size = ((bytes[off] << 24) >>> 0) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    if (size < 16) return null; // An ftyp box requires at least 16 bytes (size + type + major_brand + minor_version)
    const brandAt = (p) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const isAvifBrand = (b) => b === 'avif' || b === 'avis';
    const major = brandAt(off + 8);
    if (isAvifBrand(major)) return 'image/avif';
    if (major === 'mif1' || major === 'msf1') {
      // The compatible-brand list decides between AVIF and the generic MP4 default: until all of it is visible the box is undecided.
      if (bytes.length < off + size) return null;
      const end = Math.min(bytes.length, off + size);
      for (let p = off + 16; p + 4 <= end; p += 4) if (isAvifBrand(brandAt(p))) return 'image/avif';
    }
    return 'video/mp4';
  };
  if (bytes.length >= 12) {
    // Standard ftyp box at offset 4
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return isoKind(0);
    }
    // Check standard pre-ftyp padding boxes ('wide', 'free', 'skip') within initial 64 bytes
    let offset = 0;
    while (offset + 8 <= bytes.length && offset <= 64) {
      const boxSize = ((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (bytes[offset + 4] === 0x66 && bytes[offset + 5] === 0x74 && bytes[offset + 6] === 0x79 && bytes[offset + 7] === 0x70) {
        return isoKind(offset);
      }
      if (boxSize < 8 || boxSize > 64) break;
      offset += boxSize;
    }
  }

  return null;
}

/**
 * Detects whether a GIF buffer contains multiple animation frames.
 * Inspects Logical Screen Descriptor, skips global color tables and extension sub-blocks,
 * and counts Image Descriptor blocks (0x2C).
 *
 * @param {ArrayBuffer|Uint8Array|number[]} buffer
 * @returns {boolean} true if multi-frame animated GIF; false if single-frame static or non-GIF.
 */
function isAnimatedGif(buffer) {
  if (!buffer) return false;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 13) return false;

  // 1. Signature check: GIF87a or GIF89a
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x38) {
    return false;
  }
  if ((bytes[4] !== 0x37 && bytes[4] !== 0x39) || bytes[5] !== 0x61) {
    return false;
  }

  // 2. Logical Screen Descriptor
  const packed = bytes[10];
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = hasGct ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  let offset = 13 + gctSize;

  let imageDescCount = 0;
  const len = bytes.length;

  while (offset < len) {
    const blockType = bytes[offset];

    if (blockType === 0x3B) {
      // Trailer / End of GIF
      break;
    }

    if (blockType === 0x21) {
      // Extension block: [0x21][label][sub-blocks...]
      offset += 2; // skip 0x21 and label
      while (offset < len) {
        const subBlockLen = bytes[offset++];
        if (subBlockLen === 0 || offset >= len) break; // block terminator
        offset += subBlockLen;
      }
    } else if (blockType === 0x2C) {
      // Image Descriptor (frame)
      imageDescCount++;
      if (imageDescCount >= 2) {
        return true; // Confirmed animated!
      }
      if (offset + 10 > len) break;
      const imgPacked = bytes[offset + 9];
      const hasLct = (imgPacked & 0x80) !== 0;
      const lctSize = hasLct ? 3 * (1 << ((imgPacked & 0x07) + 1)) : 0;
      offset += 10 + lctSize;

      if (offset >= len) break;
      offset++; // skip LZW minimum code size byte

      // Skip image data sub-blocks
      while (offset < len) {
        const subBlockLen = bytes[offset++];
        if (subBlockLen === 0 || offset >= len) break;
        offset += subBlockLen;
      }
    } else {
      // Unrecognized block or corruption, advance 1 byte
      offset++;
    }
  }

  return imageDescCount >= 2;
}

/**
 * Closes and cancels a discarded response body to terminate streaming connections promptly.
 *
 * @param {Response} res
 */
async function closeResponseBody(res) {
  if (!res) return;
  try {
    if (res.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
    } else if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      await reader.cancel();
    }
  } catch (_) {}
}

async function fetchProtectedBlob(url, options = {}) {
  // 1. Validate maxBodyBytes policy before allocating timers or transport
  let maxBodyBytes = DEFAULT_MAX_PROTECTED_BODY_BYTES;
  if (options && options.maxBodyBytes !== undefined) {
    const requested = options.maxBodyBytes;
    if (
      typeof requested !== 'number' ||
      !Number.isFinite(requested) ||
      !Number.isInteger(requested) ||
      requested <= 0 ||
      requested > MAX_ALLOWED_PROTECTED_BODY_BYTES
    ) {
      return {
        success: false,
        error: `INVALID_BODY_BUDGET: maxBodyBytes must be a positive finite integer <= ${MAX_ALLOWED_PROTECTED_BODY_BYTES}`
      };
    }
    maxBodyBytes = requested;
  }

  // 2. Validate options.signal if provided (local in-process callers only)
  if (options && options.signal !== undefined && options.signal !== null) {
    if (typeof options.signal !== 'object' || typeof options.signal.addEventListener !== 'function') {
      return {
        success: false,
        error: 'INVALID_SIGNAL: options.signal must be an AbortSignal instance'
      };
    }
  }

  const hostInfo = getProtectedHostInfo(url);
  if (!hostInfo) {
    console.error('[Offscreen] Rejected unsupported protected host:', sanitizeUrlForLog(url));
    return {
      success: false,
      error: 'UNSUPPORTED_PROTECTED_HOST'
    };
  }

  const buildFetchOpts = (signal) => {
    const fetchOpts = {
      method: 'GET',
      headers: {},
      signal,
      redirect: 'error'
    };
    if (hostInfo.type === 'anime-pictures') {
      fetchOpts.credentials = 'include';
    }
    return fetchOpts;
  };

  const MAX_ATTEMPTS = 2; // Initial attempt + at most 1 retry for HTTP 429
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const controller = new AbortController();
    let timeoutId = null;
    let onExternalAbort = null;

    try {
      timeoutId = setTimeout(() => controller.abort(new Error('Protected fetch timed out')), HEADER_TIMEOUT_MS);

      if (options?.signal) {
        if (options.signal.aborted) {
          controller.abort(options.signal.reason || new Error('Aborted'));
        } else {
          onExternalAbort = () => controller.abort(options.signal.reason || new Error('Aborted'));
          options.signal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }

      if (controller.signal.aborted) {
        throw (controller.signal.reason || new Error('Aborted'));
      }
      const fetchOpts = buildFetchOpts(controller.signal);
      const response = await fetch(url, fetchOpts);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      // Handle HTTP 429 Rate Limiting
      if (response.status === 429) {
        await closeResponseBody(response);
        if (attempt < MAX_ATTEMPTS) {
          const retryAfterHeader = response.headers?.get ? response.headers.get('retry-after') : null;
          const retryDelayMs = parseRetryAfterMs(retryAfterHeader);
          console.warn(`[Offscreen] HTTP 429 received for ${hostInfo.hostname}. Retrying once after ${retryDelayMs}ms...`);
          await sleep(retryDelayMs, controller.signal);
          continue;
        } else {
          const err = new Error('Protected fetch failed with HTTP 429 Too Many Requests');
          err.status = 429;
          throw err;
        }
      }

      if (!response.ok) {
        await closeResponseBody(response);
        const err = new Error(`Protected fetch failed with HTTP ${response.status} ${response.statusText || ''}`.trim());
        err.status = response.status;
        throw err;
      }

      const rawContentType = response.headers?.get ? (response.headers.get('content-type') || '') : '';
      const contentType = rawContentType.split(';')[0].trim().toLowerCase();
      const isMedia = contentType.startsWith('image/') || contentType.startsWith('video/');
      if (!isMedia) {
        await closeResponseBody(response);
        const err = new Error(`Rejected non-image Content-Type (invalid MIME): ${contentType || 'empty'}`);
        err.status = response.status;
        throw err;
      }

      // Check declared Content-Length header against maxBodyBytes (fast pre-buffer rejection)
      const rawContentLength = response.headers?.get ? response.headers.get('content-length') : null;
      if (rawContentLength !== null && rawContentLength !== undefined && rawContentLength !== '') {
        const declaredLength = parseInt(rawContentLength, 10);
        if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
          await closeResponseBody(response);
          const err = new Error(`Protected body size exceeds budget: declared ${declaredLength} bytes exceeds limit of ${maxBodyBytes} bytes`);
          err.status = response.status;
          throw err;
        }
      }

      // Body transfer: stream the response body using ReadableStreamDefaultReader to measure
      // network progress on a chunk-by-chunk basis. This distinguishes ongoing slow transfers
      // from truly stalled connections.
      // - Inactivity timeout (INACTIVITY_TIMEOUT_MS = 60s): aborts if no chunk arrives for 60s.
      // - Total hard ceiling (TOTAL_BODY_TIMEOUT_MS = 600s): caps maximum operation budget to 10m.
      // - Finite byte ceiling (maxBodyBytes, default 50MiB): enforces hard ceiling BEFORE retaining
      //   excessive chunks or creating Blob URLs. Content-Length is treated as untrusted.
      // - Controlled memory: accumulated Uint8Array chunks are assembled into a Blob, and the
      //   chunks array references are cleared immediately.
      // - Explicitly bounded stream requirement: a ReadableStream reader is strictly required to enforce
      //   incremental pre-buffer byte budgets. Responses without a usable stream reader are refused immediately.
      let blob;

      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks = [];
        let totalBytes = 0;
        let stallTimeoutId = null;
        let totalTimeoutId = null;
        let isComplete = false;

        const resetStallTimer = () => {
          if (stallTimeoutId) clearTimeout(stallTimeoutId);
          stallTimeoutId = setTimeout(() => {
            controller.abort(new Error(`Transfer stalled: no data received for ${INACTIVITY_TIMEOUT_MS / 1000}s`));
          }, INACTIVITY_TIMEOUT_MS);
        };

        const readWithAbort = () => {
          return new Promise((resolve, reject) => {
            if (controller.signal.aborted) {
              reject(controller.signal.reason || new Error('Aborted'));
              return;
            }
            const onAbort = () => {
              reject(controller.signal.reason || new Error('Aborted'));
            };
            controller.signal.addEventListener('abort', onAbort, { once: true });
            reader.read().then(
              (res) => {
                controller.signal.removeEventListener('abort', onAbort);
                resolve(res);
              },
              (err) => {
                controller.signal.removeEventListener('abort', onAbort);
                reject(err);
              }
            );
          });
        };

        try {
          totalTimeoutId = setTimeout(() => {
            controller.abort(new Error(`Body transfer exceeded total budget of ${TOTAL_BODY_TIMEOUT_MS / 1000}s`));
          }, TOTAL_BODY_TIMEOUT_MS);

          resetStallTimer();

          while (true) {
            const { done, value } = await readWithAbort();
            if (done) {
              isComplete = true;
              break;
            }
            if (value && value.byteLength > 0) {
              if (totalBytes + value.byteLength > maxBodyBytes) {
                // Reject BEFORE retaining the excessive chunk
                controller.abort(new Error(`Protected body size exceeds budget: stream exceeded limit of ${maxBodyBytes} bytes`));
                try {
                  await reader.cancel().catch(() => {});
                } catch (_) {}
                chunks.length = 0;
                const err = new Error(`Protected body size exceeds budget: stream exceeded limit of ${maxBodyBytes} bytes`);
                err.status = response.status;
                throw err;
              }
              chunks.push(value);
              totalBytes += value.byteLength;
              resetStallTimer();
            }
          }

          blob = new Blob(chunks, { type: contentType });
          chunks.length = 0;
        } finally {
          if (stallTimeoutId) clearTimeout(stallTimeoutId);
          if (totalTimeoutId) clearTimeout(totalTimeoutId);
          if (!isComplete) {
            chunks.length = 0;
            try {
              await reader.cancel().catch(() => {});
            } catch (_) {}
          }
        }
      } else {
        // Explicitly bounded policy for responses without a usable readable stream:
        // A ReadableStream reader is strictly required to enforce incremental pre-buffer byte budgets
        // across both default and overridden requests. Unstreamable bodies cannot be bounded before
        // buffering and are refused immediately without invoking response.blob().
        await closeResponseBody(response);
        const err = new Error('ReadableStream reader is required for bounded protected transfer');
        err.status = response.status;
        throw err;
      }

      if (!blob || blob.size <= 0) {
        const err = new Error('Received empty blob body (size 0)');
        err.status = response.status;
        throw err;
      }

      if (blob.size < 4) {
        const err = new Error(`Received truncated media body (${blob.size} bytes, minimum 4 bytes required)`);
        err.status = response.status;
        throw err;
      }

      let effectiveContentType = contentType;

      try {
        if (typeof blob.slice === 'function') {
          let sliceBuf = await blob.slice(0, 64).arrayBuffer();
          // Text prefix: skip UTF-8 BOM and leading whitespace; extend the bounded sniff when the XML root may start there
          // (or when the whole prefix is BOM/whitespace). Binary payloads keep the 64-byte contract.
          const prefix = new Uint8Array(sliceBuf);
          let textAt = (prefix[0] === 0xEF && prefix[1] === 0xBB && prefix[2] === 0xBF) ? 3 : 0;
          while (textAt < prefix.length && (prefix[textAt] === 0x20 || prefix[textAt] === 0x09 || prefix[textAt] === 0x0A || prefix[textAt] === 0x0D)) textAt++;
          if (blob.size > 64 && (textAt >= prefix.length || prefix[textAt] === 0x3C)) {
            const extendedBuf = await blob.slice(0, Math.min(blob.size, 1024)).arrayBuffer();
            if (isSvgPayload(extendedBuf)) {
              sliceBuf = extendedBuf;
            } else if (textAt >= prefix.length) {
              const err = new Error('Rejected non-media payload (unverified whitespace-led body)');
              err.status = response.status;
              throw err;
            }
          }
          if (isMalformedMediaContainer(sliceBuf, blob.size)) {
            const err = new Error('Received malformed media container (invalid or truncated ftyp header)');
            err.status = response.status;
            throw err;
          }
          const sniffed = sniffMediaMagicBytes(sliceBuf);
          if (sniffed) {
            effectiveContentType = sniffed;
          } else if (isNonMediaOrErrorPayload(sliceBuf)) {
            const err = new Error('Rejected non-media payload (HTML/JSON/error response masquerading as media)');
            err.status = response.status;
            throw err;
          }
        }
      } catch (e) {
        if (e.message && (e.message.startsWith('Rejected non-media payload') || e.message.startsWith('Received malformed media container'))) {
          throw e;
        }
      }

      const blobUrl = URL.createObjectURL(blob);

      console.log(`[Offscreen] Protected Blob URL created: ${blob.size} bytes (${effectiveContentType})`);

      return {
        success: true,
        blobUrl,
        contentType: effectiveContentType,
        size: blob.size,
        status: response.status
      };
    } catch (err) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      try { controller.abort(err); } catch (_) {}
      console.error('[Offscreen] Error fetching protected image:', err);
      return {
        success: false,
        error: err.message || String(err),
        status: err.status || 0
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (onExternalAbort && options?.signal) {
        try { options.signal.removeEventListener('abort', onExternalAbort); } catch (_) {}
      }
    }
  }

  return {
    success: false,
    error: 'Protected fetch failed after retries',
    status: 429
  };
}

// Backwards-compatible alias for existing callers
async function fetchGelbooruBlob(url, options = {}) {
  return fetchProtectedBlob(url, options);
}

/**
 * Sanitizes URLs for safe diagnostic logging by redacting sensitive parameters.
 * Diagnostic boundary for offscreen fetches: sanitizeUrlForLog(mediaUrl) and sanitizeUrlForLog(url).
 */
function sanitizeUrlForLog(input) {
  if (!input) return input;
  if (typeof input === 'object') {
    if (Array.isArray(input)) {
      return input.map(sanitizeUrlForLog);
    }
    const cleanObj = {};
    for (const [k, v] of Object.entries(input)) {
      cleanObj[k] = sanitizeUrlForLog(v);
    }
    return cleanObj;
  }
  if (typeof input !== 'string') return input;

  const SENSITIVE_KEY_RE = /^(?:token|access_token|auth|key|signature|sig|secret|api_key|apikey|s|jsc_token|session|bearer)$/i;

  try {
    const parsed = new URL(input);
    let modified = false;
    for (const [key, value] of parsed.searchParams.entries()) {
      if (SENSITIVE_KEY_RE.test(key) || /token|secret|auth|signature/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
        modified = true;
      }
    }
    return modified ? parsed.toString() : input;
  } catch (_) {
    return input.replace(/([?&](?:token|access_token|auth|key|signature|sig|secret|api_key|apikey|s|jsc_token)=)[^&]*/gi, '$1[REDACTED]');
  }
}

const GIF_CONVERSION_LIMITS = {
  maxDurationSec: 30.0,
  maxFrames: 150,
  maxDimension: 640,
  maxSizeBytes: 15 * 1024 * 1024, // 15 MB
  totalTimeoutMs: 45000 // 45 seconds total operation budget
};

function getGifencModule() {
  if (typeof gifenc !== 'undefined') return gifenc;
  if (typeof globalThis !== 'undefined' && globalThis.gifenc) return globalThis.gifenc;
  if (typeof require === 'function') {
    try {
      return require('./lib/gifenc.js');
    } catch (_) {}
  }
  return null;
}

/**
 * Calculates discrete centisecond frame delays for animated GIF using
 * cumulative error diffusion to preserve source-based playback duration without drift.
 */
function calculateGifFrameDelays(durationSec, totalFrames) {
  if (!durationSec || durationSec <= 0 || !totalFrames || totalFrames <= 0) {
    return [];
  }
  const actualDeltaMs = (durationSec / totalFrames) * 1000;
  let accumulatedErrorMs = 0;
  const delaysMs = [];

  for (let i = 0; i < totalFrames; i++) {
    const idealMs = actualDeltaMs + accumulatedErrorMs;
    let delayCs = Math.round(idealMs / 10);
    if (delayCs < 2) delayCs = 2; // Clamp minimum delay to 2cs (20ms) to avoid browser 0-delay 100ms penalty
    const actualDelayMs = delayCs * 10;
    accumulatedErrorMs = idealMs - actualDelayMs;
    delaysMs.push(actualDelayMs);
  }

  return delaysMs;
}

/**
 * Core MP4 video animation to genuine looping GIF converter using bundled gifenc.
 * Shared between X tweet_video and Reddit MP4 animations.
 * Enforces operational limits without silent truncation and ensures full cleanup.
 */
async function convertMp4VideoToGif(mediaUrl, options = {}, providerName = 'x') {
  const gifencMod = getGifencModule();
  if (!gifencMod) {
    throw new Error('GIF encoder library (gifenc) is not available');
  }

  const maxDurationSec = Math.min(GIF_CONVERSION_LIMITS.maxDurationSec, options.maxDuration || GIF_CONVERSION_LIMITS.maxDurationSec);
  const maxFrames = Math.min(GIF_CONVERSION_LIMITS.maxFrames, options.maxFrames || GIF_CONVERSION_LIMITS.maxFrames);
  const maxDimension = Math.min(GIF_CONVERSION_LIMITS.maxDimension, options.maxDimension || GIF_CONVERSION_LIMITS.maxDimension);
  const maxSizeBytes = Math.min(GIF_CONVERSION_LIMITS.maxSizeBytes, options.maxSizeBytes || GIF_CONVERSION_LIMITS.maxSizeBytes);
  const totalTimeoutMs = Math.min(GIF_CONVERSION_LIMITS.totalTimeoutMs, options.totalTimeoutMs || GIF_CONVERSION_LIMITS.totalTimeoutMs);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error('TIMEOUT: GIF conversion exceeded operational budget'));
  }, totalTimeoutMs);

  let onExternalAbort = null;
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason || new Error('Aborted'));
    } else {
      onExternalAbort = () => {
        controller.abort(options.signal.reason || new Error('Aborted'));
      };
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  let videoBlobUrl = null;
  let video = null;
  let canvas = null;

  try {
    // 1. Direct synthetic frames support (for unit tests / mock environment)
    if (Array.isArray(options.frames) && options.frames.length > 0) {
      const frameList = options.frames;
      const totalFrames = frameList.length;
      if (totalFrames > maxFrames) {
        throw new Error(`FRAME_COUNT_EXCEEDED: Total frames (${totalFrames}) exceeds limit of ${maxFrames}`);
      }
      const duration = options.duration || (totalFrames * 0.067);
      if (duration > maxDurationSec) {
        throw new Error(`DURATION_EXCEEDED: Video duration (${duration.toFixed(2)}s) exceeds limit of ${maxDurationSec}s`);
      }
      const delays = calculateGifFrameDelays(duration, totalFrames);
      const encoder = gifencMod.GIFEncoder();
      const firstW = options.width || 10;
      const firstH = options.height || 10;

      for (let i = 0; i < totalFrames; i++) {
        if (controller.signal.aborted) throw new Error('CONVERSION_CANCELLED');
        const f = frameList[i];
        const rgba = f.rgba || f.data || f;
        const w = f.width || firstW;
        const h = f.height || firstH;
        const pal = gifencMod.quantize(rgba, 256);
        const idx = gifencMod.applyPalette(rgba, pal);
        encoder.writeFrame(idx, w, h, {
          palette: pal,
          delay: delays[i] || 67,
          repeat: i === 0 ? 0 : undefined
        });
      }
      encoder.finish();
      const bytes = encoder.bytes();
      if (bytes.length > maxSizeBytes) {
        throw new Error(`SIZE_EXCEEDED: Encoded GIF size (${bytes.length} bytes) exceeds limit of ${maxSizeBytes} bytes`);
      }
      if (sniffMediaMagicBytes(bytes) !== 'image/gif') {
        throw new Error('CORRUPTED_OUTPUT: Encoded output does not match GIF magic bytes');
      }
      if (!isAnimatedGif(bytes)) {
        throw new Error('INVALID_ANIMATION: Encoded output does not contain multiple GIF frames');
      }
      const blob = new Blob([bytes], { type: 'image/gif' });
      const blobUrl = URL.createObjectURL(blob);
      return {
        success: true,
        blobUrl,
        contentType: 'image/gif',
        size: blob.size,
        frames: totalFrames,
        duration
      };
    }

    // 2. Fetch video media
    console.log(`[Offscreen] Fetching ${providerName === 'reddit' ? 'Reddit animation' : 'tweet_video'} for GIF conversion:`, sanitizeUrlForLog(mediaUrl));
    const resp = await fetch(mediaUrl, { signal: controller.signal });
    if (!resp.ok) {
      const err = new Error(`Failed to fetch video: HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    const blob = await resp.blob();
    if (!blob || blob.size <= 0) {
      throw new Error('Received empty video body (size 0)');
    }

    if (typeof blob.slice === 'function') {
      const sliceBuf = await blob.slice(0, 64).arrayBuffer();
      const sniffed = sniffMediaMagicBytes(sliceBuf);
      if (sniffed !== 'video/mp4') {
        throw new Error(`Invalid MP4 container bytes for ${providerName === 'reddit' ? 'Reddit animation' : 'tweet_video'}: ${sniffed || 'unknown'}`);
      }
    }

    videoBlobUrl = URL.createObjectURL(blob);

    if (typeof document === 'undefined' || !document.createElement) {
      throw new Error('DOM document is not available for video decoding');
    }

    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = videoBlobUrl;

    // Wait for video metadata and initial frame data
    await new Promise((resolve, reject) => {
      let settled = false;
      const onReady = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
      const onError = () => { if (!settled) { settled = true; cleanup(); reject(new Error('Video element failed to load source')); } };
      const onAbort = () => { if (!settled) { settled = true; cleanup(); reject(controller.signal.reason || new Error('CONVERSION_CANCELLED')); } };
      const metaTimer = setTimeout(() => {
        if (!settled) { settled = true; cleanup(); reject(new Error('Video metadata loading timed out')); }
      }, 10000);
      function cleanup() {
        clearTimeout(metaTimer);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('error', onError);
        controller.signal.removeEventListener('abort', onAbort);
      }
      if (video.readyState >= 2) {
        onReady();
        return;
      }
      video.addEventListener('loadeddata', onReady, { once: true });
      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('error', onError, { once: true });
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });

    if (controller.signal.aborted) {
      throw new Error('CONVERSION_CANCELLED');
    }

    const origDuration = video.duration;
    if (!origDuration || !isFinite(origDuration) || origDuration <= 0) {
      throw new Error('Invalid video duration: ' + origDuration);
    }
    // The shared policy threshold is fixed: only a measured duration strictly above it authorizes the direct MP4. A stricter caller budget
    // (options.maxDuration below the threshold) is a resource limit and fails the conversion instead.
    if (origDuration > GIF_CONVERSION_LIMITS.maxDurationSec) {
      return {
        success: true,
        exceedsDuration: true,
        action: 'SAVE_DIRECT_MP4',
        duration: origDuration,
        threshold: GIF_CONVERSION_LIMITS.maxDurationSec
      };
    }
    if (origDuration > maxDurationSec) {
      throw new Error(`DURATION_EXCEEDED: Video duration (${origDuration.toFixed(2)}s) exceeds limit of ${maxDurationSec}s`);
    }

    const origWidth = video.videoWidth || 320;
    const origHeight = video.videoHeight || 240;
    let targetWidth = origWidth;
    let targetHeight = origHeight;
    if (targetWidth > maxDimension || targetHeight > maxDimension) {
      const scale = Math.min(maxDimension / targetWidth, maxDimension / targetHeight);
      targetWidth = Math.round(targetWidth * scale);
      targetHeight = Math.round(targetHeight * scale);
    }
    targetWidth = Math.max(2, targetWidth & ~1);
    targetHeight = Math.max(2, targetHeight & ~1);

    let targetFps = 15;
    if (origDuration > 15.0) {
      targetFps = Math.max(1, Math.min(10, Math.floor(maxFrames / origDuration)));
    } else if (origDuration > 8.0) {
      targetFps = 10;
    } else if (origDuration > 3.0) {
      targetFps = 12;
    }

    const totalFrames = Math.min(maxFrames, Math.max(2, Math.ceil(origDuration * targetFps)));
    if (totalFrames > maxFrames) {
      throw new Error(`FRAME_COUNT_EXCEEDED: Total frames (${totalFrames}) exceeds limit of ${maxFrames}`);
    }

    const delays = calculateGifFrameDelays(origDuration, totalFrames);
    const frameIntervalSec = origDuration / totalFrames;

    console.log('[Offscreen] Starting GIF conversion:', {
      origDimensions: `${origWidth}x${origHeight}`,
      targetDimensions: `${targetWidth}x${targetHeight}`,
      duration: origDuration,
      targetFps,
      totalFrames
    });

    canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Failed to obtain 2D canvas context');
    }

    const encoder = gifencMod.GIFEncoder();

    for (let i = 0; i < totalFrames; i++) {
      if (controller.signal.aborted) {
        throw (controller.signal.reason || new Error('CONVERSION_CANCELLED'));
      }
      const targetTime = Math.min(origDuration - 0.001, i * frameIntervalSec);

      // Handle initial frame without waiting for seek event if video is already at target time
      if (i > 0 || Math.abs(video.currentTime - targetTime) >= 0.001) {
        await new Promise((resolve, reject) => {
          let seekSettled = false;
          const onSeeked = () => {
            if (!seekSettled) {
              seekSettled = true;
              cleanup();
              resolve();
            }
          };
          const onError = () => {
            if (!seekSettled) {
              seekSettled = true;
              cleanup();
              reject(new Error(`SEEK_FAILED: Video seek error at frame ${i} (${targetTime.toFixed(3)}s)`));
            }
          };
          const onAbort = () => {
            if (!seekSettled) {
              seekSettled = true;
              cleanup();
              reject(controller.signal.reason || new Error('CONVERSION_CANCELLED'));
            }
          };
          const seekTimer = setTimeout(() => {
            if (!seekSettled) {
              seekSettled = true;
              cleanup();
              reject(new Error(`SEEK_TIMEOUT: Video seek timed out at frame ${i} (${targetTime.toFixed(3)}s)`));
            }
          }, 3000);

          function cleanup() {
            clearTimeout(seekTimer);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
            controller.signal.removeEventListener('abort', onAbort);
          }

          video.addEventListener('seeked', onSeeked, { once: true });
          video.addEventListener('error', onError, { once: true });
          controller.signal.addEventListener('abort', onAbort, { once: true });
          video.currentTime = targetTime;
        });
      }

      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
      const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
      const rgba = imgData.data;

      const palette = gifencMod.quantize(rgba, 256);
      const index = gifencMod.applyPalette(rgba, palette);

      encoder.writeFrame(index, targetWidth, targetHeight, {
        palette,
        delay: delays[i] || 67,
        repeat: i === 0 ? 0 : undefined
      });
    }

    encoder.finish();
    const gifBytes = encoder.bytes();

    if (gifBytes.length > maxSizeBytes) {
      throw new Error(`SIZE_EXCEEDED: Encoded GIF size (${gifBytes.length} bytes) exceeds limit of ${maxSizeBytes} bytes`);
    }

    if (sniffMediaMagicBytes(gifBytes) !== 'image/gif') {
      throw new Error('CORRUPTED_OUTPUT: Encoded output does not match GIF magic bytes');
    }
    if (!isAnimatedGif(gifBytes)) {
      throw new Error('INVALID_ANIMATION: Encoded output does not contain multiple GIF frames');
    }

    const gifBlob = new Blob([gifBytes], { type: 'image/gif' });
    const blobUrl = URL.createObjectURL(gifBlob);

    console.log(`[Offscreen] GIF conversion completed: ${gifBlob.size} bytes (${totalFrames} frames, duration ${origDuration.toFixed(2)}s)`);

    return {
      success: true,
      blobUrl,
      contentType: 'image/gif',
      size: gifBlob.size,
      frames: totalFrames,
      duration: origDuration
    };
  } finally {
    clearTimeout(timeoutId);
    if (onExternalAbort && options?.signal) {
      try { options.signal.removeEventListener('abort', onExternalAbort); } catch (_) {}
    }
    if (videoBlobUrl) {
      try { URL.revokeObjectURL(videoBlobUrl); } catch (_) {}
    }
    if (typeof video !== 'undefined' && video) {
      try {
        video.src = '';
        video.load();
      } catch (_) {}
    }
    if (typeof canvas !== 'undefined' && canvas) {
      try {
        canvas.width = 0;
        canvas.height = 0;
      } catch (_) {}
    }
  }
}

/**
 * Converts a confirmed X tweet_video MP4 animation into genuine looping GIF bytes.
 */
async function convertXTweetVideoToGif(mediaUrl, options = {}) {
  return convertMp4VideoToGif(mediaUrl, options, 'x');
}

/**
 * Converts a confirmed Reddit MP4 animation into genuine looping GIF bytes.
 */
async function convertRedditVideoToGif(mediaUrl, options = {}) {
  return convertMp4VideoToGif(mediaUrl, options, 'reddit');
}

// Exports for tests / modules
if (typeof globalThis !== 'undefined') {
  globalThis.fetchProtectedBlob = fetchProtectedBlob;
  globalThis.fetchGelbooruBlob = fetchGelbooruBlob;
  globalThis.sniffMediaMagicBytes = sniffMediaMagicBytes;
  globalThis.isNonMediaOrErrorPayload = isNonMediaOrErrorPayload;
  globalThis.isSvgPayload = isSvgPayload;
  globalThis.isMalformedMediaContainer = isMalformedMediaContainer;
  globalThis.closeResponseBody = closeResponseBody;
  globalThis.isAnimatedGif = isAnimatedGif;
  globalThis.sanitizeUrlForLog = sanitizeUrlForLog;
  globalThis.getProtectedHostInfo = getProtectedHostInfo;
  globalThis.parseRetryAfterMs = parseRetryAfterMs;
  globalThis.HEADER_TIMEOUT_MS = HEADER_TIMEOUT_MS;
  globalThis.INACTIVITY_TIMEOUT_MS = INACTIVITY_TIMEOUT_MS;
  globalThis.TOTAL_BODY_TIMEOUT_MS = TOTAL_BODY_TIMEOUT_MS;
  globalThis.DEFAULT_MAX_PROTECTED_BODY_BYTES = DEFAULT_MAX_PROTECTED_BODY_BYTES;
  globalThis.MAX_ALLOWED_PROTECTED_BODY_BYTES = MAX_ALLOWED_PROTECTED_BODY_BYTES;
  globalThis.convertMp4VideoToGif = convertMp4VideoToGif;
  globalThis.convertXTweetVideoToGif = convertXTweetVideoToGif;
  globalThis.convertRedditVideoToGif = convertRedditVideoToGif;
  globalThis.calculateGifFrameDelays = calculateGifFrameDelays;
  globalThis.GIF_CONVERSION_LIMITS = GIF_CONVERSION_LIMITS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fetchProtectedBlob,
    fetchGelbooruBlob,
    sniffMediaMagicBytes,
    isNonMediaOrErrorPayload,
    isSvgPayload,
    isMalformedMediaContainer,
    closeResponseBody,
    isAnimatedGif,
    sanitizeUrlForLog,
    getProtectedHostInfo,
    parseRetryAfterMs,
    HEADER_TIMEOUT_MS,
    INACTIVITY_TIMEOUT_MS,
    TOTAL_BODY_TIMEOUT_MS,
    DEFAULT_MAX_PROTECTED_BODY_BYTES,
    MAX_ALLOWED_PROTECTED_BODY_BYTES,
    convertMp4VideoToGif,
    convertXTweetVideoToGif,
    convertRedditVideoToGif,
    calculateGifFrameDelays,
    GIF_CONVERSION_LIMITS
  };
}
