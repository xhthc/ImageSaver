// Classic worker module; loaded once by background.js in its original initialization order.
const MIME_EVIDENCE = Object.freeze({
  URL_HINT: 'url_hint',
  DOM_HINT: 'dom_hint',
  HTTP_RESPONSE: 'http_response',
  PROTECTED_FETCH: 'protected_fetch'
});

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
 * Checks if target URL belongs to protected booru/gallery hosts requiring
 * pre-fetching via offscreen document to avoid anti-hotlinking/credential issues.
 */
function isProtectedImageHost(url) {
  return getProtectedHostInfo(url) !== null;
}

/**
 * Sniffs canonical media MIME type from initial buffer bytes.
 * Detects JPEG, PNG, GIF, WebP, AVIF, MP4, and WebM using file signatures.
 * Strictly rejects HTML/XML/JSON/text or unrecognized binary payloads.
 *
 * @param {ArrayBuffer|Uint8Array|number[]} buffer
 * @returns {string|null} Canonical MIME type ('image/jpeg', 'image/png', 'image/gif',
 *                        'image/webp', 'image/avif', 'video/mp4', 'video/webm') or null if unrecognized/non-media.
 */
function sniffMediaMagicBytes(buffer) {
  if (!buffer) return null;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 4) return null;

  // 1. Text/HTML/JSON rejection (starts with '<', whitespace, or '{'/'[')
  const b0 = bytes[0];
  if (b0 === 0x3C || b0 === 0x20 || b0 === 0x09 || b0 === 0x0A || b0 === 0x0D || b0 === 0x7B || b0 === 0x5B) {
    return null;
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
    const size = ((bytes[off] << 24) >>> 0) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    const brandAt = (p) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const isAvifBrand = (b) => b === 'avif' || b === 'avis';
    const major = brandAt(off + 8);
    if (isAvifBrand(major)) return 'image/avif';
    if (major === 'mif1' || major === 'msf1') {
      // The compatible-brand list decides between AVIF and the generic MP4 default: until all of it is visible the box is undecided.
      if (size >= 16 && bytes.length < off + size) return null;
      const end = Math.min(bytes.length, size >= 16 ? off + size : off + 16);
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
 * Canonical MIME to extension map.
 * Known MIME wins: image/jpeg→.jpg, image/png→.png, image/gif→.gif, image/webp→.webp, image/avif→.avif
 */
const MIME_TO_CANONICAL_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-m4v': '.m4v'
};

const SAFE_MEDIA_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.svg',
  '.ico',
  '.mp4',
  '.webm',
  '.mov',
  '.m4v'
]);

const SAFE_URL_IMAGE_EXTS = SAFE_MEDIA_EXTENSIONS;

function getSafeUrlExtension(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  try {
    const parsed = new URL(urlStr, 'http://dummy.local');
    const pathname = parsed.pathname || '';
    const lastSlash = pathname.lastIndexOf('/');
    const lastSegment = lastSlash !== -1 ? pathname.substring(lastSlash + 1) : pathname;
    const dot = lastSegment.lastIndexOf('.');
    if (dot !== -1 && dot < lastSegment.length - 1) {
      const ext = '.' + lastSegment.substring(dot + 1).toLowerCase();
      if (SAFE_MEDIA_EXTENSIONS.has(ext)) {
        return ext === '.jpeg' ? '.jpg' : ext;
      }
    }
  } catch (e) {
    const clean = urlStr.split(/[?#]/)[0];
    const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    const lastSegment = lastSlash !== -1 ? clean.substring(lastSlash + 1) : clean;
    const dot = lastSegment.lastIndexOf('.');
    if (dot !== -1 && dot < lastSegment.length - 1) {
      const ext = '.' + lastSegment.substring(dot + 1).toLowerCase();
      if (SAFE_MEDIA_EXTENSIONS.has(ext)) {
        return ext === '.jpeg' ? '.jpg' : ext;
      }
    }
  }
  return '';
}

function getCanonicalExtension(mime, fallbackExt = '') {
  if (!mime || typeof mime !== 'string') return fallbackExt;
  const cleanMime = mime.split(';')[0].trim().toLowerCase();
  return MIME_TO_CANONICAL_EXT[cleanMime] || fallbackExt;
}

/**
 * Central filename extension policy:
 * - known MIME wins:
 *   image/jpeg→.jpg, image/png→.png, image/gif→.gif, image/webp→.webp, image/avif→.avif
 *   video/mp4→.mp4, video/webm→.webm;
 * - recognize safe pathname extensions for existing media:
 *   jpg/jpeg/png/gif/webp/avif/bmp/svg/ico/mp4/webm/mov/m4v;
 * - extract fallback extensions from URL.pathname via new URL(); never treat query-string or fragment as real;
 * - accept an explicit safe extension such as ".mp4";
 * - if MIME is unknown and no safe pathname/explicit extension exists, return an empty extension instead of defaulting to ".jpg".
 */
function resolveCanonicalExtension(contentType, urlOrFallback = '') {
  // 1. Known MIME wins
  if (contentType && typeof contentType === 'string') {
    const cleanMime = contentType.split(';')[0].trim().toLowerCase();
    if (MIME_TO_CANONICAL_EXT[cleanMime]) {
      return MIME_TO_CANONICAL_EXT[cleanMime];
    }
  }

  // 2. Explicit safe extension or safe pathname extension
  if (urlOrFallback && typeof urlOrFallback === 'string') {
    const trimmed = urlOrFallback.trim().toLowerCase();
    if (trimmed.startsWith('.') && SAFE_MEDIA_EXTENSIONS.has(trimmed)) {
      return trimmed === '.jpeg' ? '.jpg' : trimmed;
    }
    const safePathExt = getSafeUrlExtension(urlOrFallback);
    if (safePathExt) {
      return safePathExt;
    }
  }

  // 3. Unknown MIME and no safe pathname/explicit extension: return empty string
  return '';
}
