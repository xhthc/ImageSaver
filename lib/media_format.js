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

/**
 * Classifies a media target into standard media representation.
 * Strict discriminator for X tweet_video (MP4 container representing animated GIF):
 * - video.twimg.com/tweet_video/*.mp4 -> { type: 'gif', sourceType: 'x_tweet_video', mime: 'video/mp4', animated: true }
 * - normal MP4 -> { type: 'video', sourceType: 'video', mime: 'video/mp4', animated: false }
 * - normal WebM -> { type: 'video', sourceType: 'video', mime: 'video/webm', animated: false }
 * - normal GIF -> { type: 'gif', sourceType: 'gif', mime: 'image/gif', animated: true }
 * - normal image -> { type: 'image', sourceType: 'image', mime: '...', animated: false }
 */
function classifyMediaTarget(target) {
  if (!target) return null;

  let url = '';
  let mediaType = null;
  let domType = null;
  let mime = null;
  let poster = null;
  let currentSrc = null;
  let src = null;

  if (typeof target === 'string') {
    url = target.trim();
  } else if (typeof target === 'object') {
    url = (target.url || target.src || target.currentSrc || '').trim();
    src = (target.src || '').trim();
    currentSrc = (target.currentSrc || '').trim();
    poster = (target.poster || '').trim();
    mediaType = target.mediaType || target.type || null;
    domType = target.domType || target.type || null;
    mime = target.mime || target.contentType || null;
  }

  const isTweetVidUrl = (u) => {
    if (!u || typeof u !== 'string') return false;
    try {
      const parsed = new URL(u, 'https://x.com/');
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      return host === 'video.twimg.com' && pathname.includes('/tweet_video/') && pathname.endsWith('.mp4');
    } catch (_) {
      return false;
    }
  };

  const isTweetThumbUrl = (u) => {
    if (!u || typeof u !== 'string') return false;
    try {
      const parsed = new URL(u, 'https://x.com/');
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      return (host === 'twimg.com' || host.endsWith('.twimg.com')) && pathname.includes('/tweet_video_thumb/');
    } catch (_) {
      return false;
    }
  };

  // Check if target represents an X tweet_video
  // Recovers genuine tweet_video source when blob fallback or thumb poster is present
  const isXTweetVideo = isTweetVidUrl(url) ||
                        isTweetVidUrl(src) ||
                        isTweetVidUrl(currentSrc) ||
                        isTweetThumbUrl(poster) ||
                        isTweetThumbUrl(url) ||
                        domType === 'x_tweet_video' ||
                        mediaType === 'x_tweet_video' ||
                        target?.sourceType === 'x_tweet_video';

  if (isXTweetVideo) {
    return {
      type: 'gif',
      sourceType: 'x_tweet_video',
      mime: 'video/mp4',
      animated: true
    };
  }

  // Check if target represents an X ordinary video poster (amplify_video_thumb / ext_tw_video_thumb)
  const isXPoster = isXVideoPosterUrl(url) ||
                    isXVideoPosterUrl(src) ||
                    isXVideoPosterUrl(currentSrc) ||
                    isXVideoPosterUrl(poster);

  if (isXPoster) {
    return {
      type: 'video',
      sourceType: 'video',
      mime: 'video/mp4',
      animated: false
    };
  }

  // Reddit animated GIF served as MP4: preview.redd.it/...gif?format=mp4
  const isRedditGif = (
    domType === 'reddit_gif' ||
    mediaType === 'reddit_gif' ||
    target?.sourceType === 'reddit_gif' ||
    isRedditAnimationUrl(url || src || currentSrc)
  );

  if (isRedditGif) {
    return {
      type: 'gif',
      sourceType: 'reddit_gif',
      mime: 'video/mp4',
      animated: true
    };
  }

  // DASH manifest target
  const isDashTarget = (
    (mime && mime.toLowerCase().includes('dash+xml')) ||
    (typeof isDashManifestUrl === 'function' && isDashManifestUrl(url || src || currentSrc))
  );
  if (isDashTarget) {
    return {
      type: 'dash_manifest',
      sourceType: 'dash',
      mime: 'application/dash+xml',
      animated: false
    };
  }

  // HTML target
  const isHtmlTarget = (mime && (mime.toLowerCase().startsWith('text/html') || mime.toLowerCase().startsWith('application/xhtml+xml')));
  if (isHtmlTarget) {
    return {
      type: 'html',
      sourceType: 'page',
      mime: 'text/html',
      animated: false
    };
  }

  // Reddit video hosts (v.redd.it, packaged-media.redd.it)
  const redditVideoHostType = (() => {
    try {
      const u = url || src || currentSrc;
      if (!u) return null;
      const parsed = new URL(u, 'https://reddit.com/');
      const host = parsed.hostname.toLowerCase();
      if (host === 'v.redd.it' || host === 'packaged-media.redd.it') {
        const pathname = parsed.pathname.toLowerCase();
        const isDash = pathname.endsWith('.mpd') || (parsed.searchParams.get('format') || '').toLowerCase() === 'mpd';
        const isHls = pathname.endsWith('.m3u8') || (parsed.searchParams.get('format') || '').toLowerCase() === 'm3u8';
        const isHtml = pathname.endsWith('.html') || pathname.includes('/comments/');
        if (isDash || isHls || isHtml) {
          return null; // Reject HTML and DASH manifests as MP4
        }
        return host === 'v.redd.it' ? 'video' : 'packaged_media';
      }
      return null;
    } catch (_) {
      return null;
    }
  })();

  if (redditVideoHostType) {
    const cleanMime = (mime && mime.toLowerCase().startsWith('video/'))
      ? mime.toLowerCase().split(';')[0].trim()
      : (/\.webm/i.test(url || src || currentSrc || '') ? 'video/webm' : 'video/mp4');
    return {
      type: 'video',
      sourceType: redditVideoHostType,
      mime: cleanMime,
      animated: false
    };
  }

  // RedGIFs video media routes and files
  const isRedGifsTarget = (() => {
    try {
      const u = url || src || currentSrc;
      if (!u) return false;
      const parsed = new URL(u, 'https://redgifs.com/');
      const host = parsed.hostname.toLowerCase();
      if (typeof isAllowedRedGifsHost === 'function' && isAllowedRedGifsHost(host)) {
        const pathname = parsed.pathname.toLowerCase();
        const isRoute = /\/(?:watch|ifr|detail|gifs)\/([a-zA-Z0-9_-]+)/i.test(pathname);
        const isVideoFile = /\.(mp4|webm|mov|m4v)$/i.test(pathname);
        return isRoute || isVideoFile;
      }
      return false;
    } catch (_) {
      return false;
    }
  })();

  if (isRedGifsTarget) {
    const cleanMime = (mime && mime.toLowerCase().startsWith('video/'))
      ? mime.toLowerCase().split(';')[0].trim()
      : (/\.webm/i.test(url || src || currentSrc || '') ? 'video/webm' : 'video/mp4');
    return {
      type: 'video',
      sourceType: 'redgifs',
      mime: cleanMime,
      animated: false
    };
  }

  // Other animated GIF (standard image/gif or .gif extension)
  const isGifMime = mime && mime.toLowerCase().includes('image/gif');
  const isGifUrl = /\.(gif)(\?.*)?$/i.test(url);
  if (isGifMime || isGifUrl || domType === 'gif' || mediaType === 'gif') {
    return {
      type: 'gif',
      sourceType: 'gif',
      mime: 'image/gif',
      animated: true
    };
  }

  // Normal video (MP4, WebM, etc.)
  const isVideoExt = /\.(mp4|webm|ogv|mov|m4v)(\?.*)?$/i.test(url);
  const isVideoMime = mime && mime.toLowerCase().startsWith('video/');
  if (isVideoExt || isVideoMime || domType === 'video' || mediaType === 'video') {
    const cleanMime = mime && mime.toLowerCase().startsWith('video/')
      ? mime.toLowerCase().split(';')[0].trim()
      : (/\.webm/i.test(url) ? 'video/webm' : 'video/mp4');
    return {
      type: 'video',
      sourceType: 'video',
      mime: cleanMime,
      animated: false
    };
  }

  // Standard Image
  const cleanImageMime = mime && mime.toLowerCase().startsWith('image/')
    ? mime.toLowerCase().split(';')[0].trim()
    : (/\.png/i.test(url) ? 'image/png' : (/\.webp/i.test(url) ? 'image/webp' : 'image/jpeg'));

  return {
    type: 'image',
    sourceType: 'image',
    mime: cleanImageMime,
    animated: false
  };
}

// ============================================================================
// 7b. UNIVERSAL MEDIA DESCRIPTOR & VIDEO RESOLUTION
// ============================================================================

/**
 * Universal Media Descriptor factory for clicked media (image, gif, video, x_tweet_video)
 */
function createMediaDescriptor({
  type = null,
  src = '',
  currentSrc = null,
  poster = null,
  mime = null,
  pageUrl = '',
  linkUrl = null,
  x = null,
  y = null,
  sourceType = null,
  animated = null,
  isHlsOnly = false
} = {}) {
  const normalizedSrc = (src || currentSrc || '').trim();
  const normalizedCurrent = (currentSrc || src || '').trim();
  let normalizedType = type;
  if (!normalizedType) {
    if (isDirectVideoUrl(normalizedSrc) || (mime && mime.startsWith('video/'))) {
      normalizedType = 'video';
    } else {
      normalizedType = 'image';
    }
  }
  const isTweetVid = normalizedType === 'x_tweet_video' ||
    (normalizedSrc.includes('video.twimg.com') && normalizedSrc.includes('/tweet_video/')) ||
    (poster && poster.includes('/tweet_video_thumb/'));

  return {
    type: normalizedType,
    src: normalizedSrc,
    url: normalizedSrc, // backward compatibility with existing X flow
    currentSrc: normalizedCurrent,
    poster: poster ? poster.trim() : null,
    mime: mime ? mime.trim().toLowerCase() : (isTweetVid ? 'video/mp4' : null),
    pageUrl: pageUrl ? pageUrl.trim() : '',
    linkUrl: linkUrl ? linkUrl.trim() : null,
    x: typeof x === 'number' ? x : null,
    y: typeof y === 'number' ? y : null,
    sourceType: sourceType || (isTweetVid ? 'x_tweet_video' : normalizedType),
    animated: typeof animated === 'boolean' ? animated : (isTweetVid ? true : false),
    isHlsOnly: Boolean(isHlsOnly)
  };
}

/**
 * Infers video MIME from URL or format parameters
 */
function detectVideoMime(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith('.webm')) return 'video/webm';
    if (pathname.endsWith('.mp4')) return 'video/mp4';
    if (pathname.endsWith('.mov')) return 'video/quicktime';
    if (pathname.endsWith('.m4v')) return 'video/x-m4v';
    if (pathname.endsWith('.ogv') || pathname.endsWith('.ogg')) return 'video/ogg';

    const qf = (parsed.searchParams.get('format') || parsed.searchParams.get('ext') || parsed.searchParams.get('mime') || '').toLowerCase();
    if (qf.includes('webm')) return 'video/webm';
    if (qf.includes('mp4')) return 'video/mp4';
    if (qf.includes('mov') || qf.includes('quicktime')) return 'video/quicktime';
    if (qf.includes('m4v')) return 'video/x-m4v';
    if (qf.includes('ogv') || qf.includes('ogg')) return 'video/ogg';
  } catch (_) {
    const lower = url.toLowerCase();
    if (lower.includes('.webm') || lower.includes('format=webm') || lower.includes('ext=webm') || lower.includes('mime=video/webm')) return 'video/webm';
    if (lower.includes('.mp4') || lower.includes('format=mp4') || lower.includes('ext=mp4') || lower.includes('mime=video/mp4')) return 'video/mp4';
    if (lower.includes('.ogv') || lower.includes('.ogg') || lower.includes('format=ogv')) return 'video/ogg';
    if (lower.includes('.mov')) return 'video/quicktime';
    if (lower.includes('.m4v')) return 'video/x-m4v';
  }
  return 'video/mp4';
}

/**
 * Checks if a given URL is a direct video link or format
 */
function isDirectVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    // Reject DASH/HLS manifests and HTML pages upfront
    if (pathname.endsWith('.mpd') || pathname.endsWith('.m3u8') || pathname.endsWith('.html') || pathname.includes('/comments/')) {
      return false;
    }

    // Reddit video hosts (extensionless endpoints)
    if (host === 'v.redd.it' || host === 'packaged-media.redd.it') {
      return true;
    }

    if (/\.(mp4|webm|ogv|mov|m4v)$/i.test(pathname)) {
      return true;
    }
    const queryFormat = parsed.searchParams.get('format') ||
                        parsed.searchParams.get('fm') ||
                        parsed.searchParams.get('ext') ||
                        parsed.searchParams.get('type') ||
                        parsed.searchParams.get('mime');
    if (queryFormat && /^(mp4|webm|ogv|mov|m4v|video\/)/i.test(queryFormat.trim())) {
      return true;
    }
  } catch (_) {
    if (/\.(mp4|webm|ogv|mov|m4v)(\?.*)?$/i.test(url)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a given URL is an HLS playlist/manifest (.m3u8) rather than a direct container
 */
function isHlsManifestUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    return pathname.endsWith('.m3u8') || pathname.includes('/manifest.m3u8') || parsed.searchParams.get('format') === 'm3u8';
  } catch (_) {
    return url.toLowerCase().includes('.m3u8');
  }
}

/**
 * Checks if a given URL is a DASH playlist/manifest (.mpd) rather than a direct container
 */
function isDashManifestUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    return pathname.endsWith('.mpd') || pathname.includes('/dashplaylist.mpd') || parsed.searchParams.get('format') === 'mpd';
  } catch (_) {
    return url.toLowerCase().includes('.mpd');
  }
}
