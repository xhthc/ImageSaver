// Pure helpers the service worker and the offscreen document must agree on (UA-04): log redaction, the protected-host allowlist and the magic-byte signature check.
// A classic script: importScripts in the worker, <script> in offscreen.html, require() in Node tests. The declarations become globals of the context that loads it.
(function(root) {
  /**
   * Sanitizes URLs for secure debug logging by redacting sensitive query parameters.
   * Redacts tokens, access keys, signatures, auth hashes, and similar credentials.
   * Recursively supports nested objects and strings.
   * Does NOT alter the underlying URL used by the download/network pipeline.
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

    const SENSITIVE_KEY_RE = /^(?:token|access_token|auth|key|signature|sig|secret|api_key|apikey|s|a|jsc_token|session|bearer)$/i;

    try {
      const parsed = new URL(input);
      let modified = false;
      for (const [key] of parsed.searchParams.entries()) {
        // names of signature-bearing parameters beyond the short list: AWS/Google (X-Amz-Credential, X-Goog-Credential), CloudFront (Policy, Key-Pair-Id), Akamai (hdnts, hdnea)
        if (SENSITIVE_KEY_RE.test(key) || /token|secret|auth|signature|credential|policy|key-pair-id|hdnts|hdnea/i.test(key)) {
          parsed.searchParams.set(key, '[REDACTED]');
          modified = true;
        }
      }
      return modified ? parsed.toString() : input;
    } catch (_) {
      // If not a full valid URL, fallback to regex replacement
      return input.replace(/([?&](?:token|access_token|auth|key|signature|sig|secret|api_key|apikey|s|a|jsc_token|session|bearer|[^?&=]*(?:credential|policy|key-pair-id|hdnts|hdnea)[^?&=]*)=)[^&]*/gi, '$1[REDACTED]');
    }
  }

  /**
   * Strict allowlist validation for protected booru/gallery hosts.
   * Returns host descriptor if allowed, null otherwise.
   * Allowed:
   *  - hostname === 'oimages.anime-pictures.net'
   *  - hostname === 'gelbooru.com'
   *  - hostname ends with '.gelbooru.com'
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
   * Sniffs canonical media MIME type from initial buffer bytes.
   * Detects JPEG, PNG, GIF, WebP, AVIF, MP4, and WebM using file signatures.
   * Strictly rejects HTML/XML/JSON/text or unrecognized binary payloads.
   *
   * Two policies share one signature table. Without `svg` (the worker): any payload that starts like text is refused and an ISO BMFF box is judged by the bytes that are visible.
   * With `svg`, the offscreen document's predicate for an SVG payload (bytes it is about to stage or convert): a UTF-8 byte-order mark is skipped, an SVG is reported as
   * image/svg+xml, whitespace-led text is refused and an ftyp box must be complete (at least 16 bytes) before it is judged.
   *
   * @param {ArrayBuffer|Uint8Array|number[]} buffer
   * @param {(bytes: Uint8Array) => boolean} [svg]
   * @returns {string|null} Canonical MIME type ('image/jpeg', 'image/png', 'image/gif',
   *                        'image/webp', 'image/avif', 'video/mp4', 'video/webm'; 'image/svg+xml' under the strict policy) or null if unrecognized/non-media.
   */
  function sniffMagicBytes(buffer, svg) {
    if (!buffer) return null;
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length < 4) return null;
    const strict = typeof svg === 'function';

    // 1. Text/HTML/JSON rejection (starts with '<', whitespace, or '{'/'[', and under the strict policy a UTF-8 BOM followed by text)
    if (!strict) {
      const b0 = bytes[0];
      if (b0 === 0x3C || b0 === 0x20 || b0 === 0x09 || b0 === 0x0A || b0 === 0x0D || b0 === 0x7B || b0 === 0x5B) {
        return null;
      }
    } else {
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
          return svg(bytes.subarray(checkOffset)) ? 'image/svg+xml' : null;
        }
        if (b0 === 0x7B || b0 === 0x5B) {
          return null;
        }
      }
      if (checkOffset > textStart) return null; // Whitespace-led non-SVG text is never binary media
    }

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
      if (strict && off + 12 > bytes.length) return null;
      const size = ((bytes[off] << 24) >>> 0) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
      if (strict && size < 16) return null; // An ftyp box requires at least 16 bytes (size + type + major_brand + minor_version)
      const brandAt = (p) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      const isAvifBrand = (b) => b === 'avif' || b === 'avis';
      const major = brandAt(off + 8);
      if (isAvifBrand(major)) return 'image/avif';
      if (major === 'mif1' || major === 'msf1') {
        // The compatible-brand list decides between AVIF and the generic MP4 default: until all of it is visible the box is undecided.
        const sized = strict || size >= 16;
        if (sized && bytes.length < off + size) return null;
        const end = Math.min(bytes.length, sized ? off + size : off + 16);
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

  const api = { sanitizeUrlForLog, getProtectedHostInfo, sniffMagicBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : self);
