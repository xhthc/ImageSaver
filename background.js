// ba kground.js - Service Worker for Image Saver extension (v2.0.0)
// Universal modular architecture for downloading maximum resolution images across the web

// Shared download-folder rules (also used by popup/popup.js so preview == runtime).
if (typeof importScripts === 'function') importScripts('lib/folder_path.js');
const FolderPath = globalThis.ImageSaverFolderPath;
if (typeof importScripts === 'function') importScripts('lib/feedback.js');
if (typeof importScripts === 'function') importScripts('lib/feedback_tracker.js');
if (typeof importScripts === 'function') importScripts('lib/feedback_history.js');
const FeedbackLib = globalThis.ImageSaverFeedback;

// ============================================================================
// 1. Initialization: Context menu and declarativeNetRequest for Pixiv
// ============================================================================

let isDnrSetupInProgress = false;

const pixivRule = {
  id: 1001,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'referer', operation: 'set', value: 'https://www.pixiv.net/' }
    ]
  },
  condition: {
    urlFilter: '||pximg.net',
    resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'image', 'media', 'other']
  }
};

const animePicturesRule = {
  id: 1002,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'referer', operation: 'set', value: 'https://anime-pictures.net/' },
      { header: 'cookie', operation: 'set', value: 'kira=1' }
    ]
  },
  condition: {
    urlFilter: '||oimages.anime-pictures.net',
    resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'image', 'media', 'other']
  }
};

const gelbooruRule = {
  id: 1003,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'referer', operation: 'set', value: 'https://gelbooru.com/' }
    ]
  },
  condition: {
    urlFilter: '||gelbooru.com',
    resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'image', 'media', 'other']
  }
};

const MANAGED_DNR_RULES = Object.freeze([pixivRule, animePicturesRule, gelbooruRule]);
const MANAGED_DNR_RULE_IDS = Object.freeze(MANAGED_DNR_RULES.map((rule) => rule.id));

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

/**
 * Sanitizes one derived path segment (owning site or media type). Rules live in lib/folder_path.js.
 */
function sanitizePathSegment(segment, fallback = 'unknown') {
  return FolderPath.normalizeSite(segment, fallback);
}

/**
 * Normalizes the configured root (nested levels allowed). Invalid/over-limit input resolves to the
 * default root; the popup rejects such input before saving (same rules, lib/folder_path.js).
 */
function sanitizeRootSubfolder(subfolder) {
  return FolderPath.resolveRoot(subfolder, (reason) => {
    console.warn('[Image Saver] Корневая папка отклонена (' + reason + '), используется корень по умолчанию:', FolderPath.DEFAULT_ROOT);
  });
}

/**
 * Folder-routing URL context: HTTP(S) only, lowercase hostname without a trailing dot.
 * Scoped to folder routing; provider resolvers keep their own validation.
 */
function getFolderContextHost(url) {
  if (typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch (_) {
    return '';
  }
}

// Folder id -> registrable domains (exact host or subdomain; never a suffix of an unrelated name).
// Includes the media CDNs of X and Pixiv so a direct CDN tab is canonicalized to x/pixiv.
const FOLDER_SITE_RULES = [
  ['x', ['x.com', 'twitter.com', 'twimg.com']],
  ['reddit', ['reddit.com', 'redd.it']],
  ['pixiv', ['pixiv.net', 'pximg.net']],
  ['zerochan', ['zerochan.net']],
  ['anime-pictures', ['anime-pictures.net']],
  ['redgifs', ['redgifs.com']],
  ['danbooru', ['donmai.us']],
  ['rule34', ['rule34.xxx']],
  ['safebooru', ['safebooru.org']],
  ['gelbooru', ['gelbooru.com']],
  ['realbooru', ['realbooru.com']],
  ['xbooru', ['xbooru.com']],
  ['hypnohub', ['hypnohub.net']],
  ['tbib', ['tbib.org']],
  ['curveybooru', ['curveybooru.com']],
  ['inkbooru', ['inkbooru.com']],
  ['mspabooru', ['mspabooru.com']],
  ['scatbooru', ['scatbooru.com']],
  ['yakui', ['yakui.ru']],
  ['e621', ['e621.net', 'e926.net', 'e6ai.net']],
  ['yande.re', ['yande.re']],
  ['konachan', ['konachan.com', 'konachan.net']],
  ['e-shuushuu', ['e-shuushuu.net']],
  ['sankaku', ['sankakucomplex.com']],
  ['tenor', ['tenor.com']],
  ['giphy', ['giphy.com']],
  ['wikimedia', ['wikimedia.org', 'wikipedia.org']]
];

const FOLDER_GROUP_PROVIDER_SITES = Object.freeze({
  twitter: 'x', x: 'x', reddit: 'reddit', pixiv: 'pixiv', zerochan: 'zerochan',
  'anime-pictures': 'anime-pictures', redgifs: 'redgifs', danbooru: 'danbooru', gelbooru: 'gelbooru',
  e621: 'e621', tenor: 'tenor', giphy: 'giphy', wikimedia: 'wikimedia'
});

/** Known site folder for a validated hostname, or '' when the host is not a mapped site. */
function getKnownFolderSite(host) {
  if (!host) return '';
  for (const [site, domains] of FOLDER_SITE_RULES) {
    if (domains.some((d) => isSameOrSubdomain(host, d))) return site;
  }
  // Search engines: explicit label boundaries and ccTLD shapes, never substring matches.
  if (/(^|\.)google\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/.test(host)) return 'google';
  if (/(^|\.)yandex\.(com|com\.tr|[a-z]{2})$/.test(host) || isSameOrSubdomain(host, 'ya.ru')) return 'yandex';
  return '';
}

/**
 * Determines the canonical owning website identifier for folder organization.
 * Priority: validated HTTP(S) owning page (so media embedded on example.com stays in example.com,
 * Reddit-embedded RedGIFs -> reddit, a direct pbs.twimg.com / i.pximg.net tab -> x / pixiv),
 * then the candidate group's provider, then the direct media host.
 */
function determineOwningWebsite({ pageUrl = '', resolvedUrl = '', group = null } = {}) {
  const pageHost = getFolderContextHost(pageUrl);
  if (pageHost) {
    return getKnownFolderSite(pageHost) || FolderPath.normalizeSite(pageHost.replace(/^www\./, ''));
  }

  const providerSite = FOLDER_GROUP_PROVIDER_SITES[String(group?.provider || '').toLowerCase()];
  if (providerSite) return providerSite;

  const mediaHost = getFolderContextHost(resolvedUrl);
  if (mediaHost) {
    return getKnownFolderSite(mediaHost) || FolderPath.normalizeSite(mediaHost.replace(/^www\./, ''));
  }

  return 'unknown-site';
}

/** Type implied by a MIME: 'gif' | 'video' | 'pic'; 'unknown-type' for explicit non-media; '' for no evidence. */
function getMediaTypeFromMime(contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') return '';
  if (mime === 'image/gif') return 'gif';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'pic';
  return 'unknown-type'; // text/html, application/json, ... never a media folder
}

/**
 * Determines the final media type category ('pic', 'video', 'gif', or 'unknown-type').
 * Precedence (strongest first):
 *   1. confirmed converted-GIF output;
 *   2. verified output MIME (a non-media MIME such as text/html is decisive: unknown-type);
 *   3. canonical/explicit extension of the file actually saved (weak filename hint);
 *   4. candidate-group metadata (only when the caller passes the group that is being saved);
 *   5. URL path extension (weakest hint).
 */
function determineFinalMediaType({
  resolvedUrl = '',
  resolvedExtension = '',
  isConvertedGif = false,
  contentType = '',
  group = null
} = {}) {
  if (isConvertedGif) return 'gif';

  const mimeType = getMediaTypeFromMime(contentType);
  if (mimeType) return mimeType;

  const cleanExt = (resolvedExtension || '').replace(/^\./, '').toLowerCase().trim();
  if (cleanExt === 'gif') return 'gif';
  if (['mp4', 'webm', 'mov'].includes(cleanExt)) return 'video';
  if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'svg', 'ico'].includes(cleanExt)) return 'pic';

  if (group?.metadata) {
    const metaMimeType = getMediaTypeFromMime(group.metadata.contentType);
    if (metaMimeType) return metaMimeType;

    const metaType = group.metadata.mediaType || group.metadata.sourceType;
    if (metaType === 'gif') return 'gif';
    if (metaType === 'video' || metaType === 'tweet_video') return 'video';
    if (metaType === 'image') return 'pic';
  }

  if (resolvedUrl && typeof resolvedUrl === 'string') {
    try {
      const pathname = new URL(resolvedUrl).pathname.toLowerCase();
      if (/\.gif$/.test(pathname)) return 'gif';
      if (/\.(mp4|webm|mov)$/.test(pathname)) return 'video';
      if (/\.(jpe?g|png|webp|avif|bmp|svg)$/.test(pathname)) return 'pic';
    } catch (_) {}
  }

  return 'unknown-type';
}

/** Configured root from settings: a stored string (even '') is kept; missing -> default root. */
function getConfiguredRoot(settings) {
  return typeof settings?.subfolder === 'string' ? settings.subfolder : FolderPath.DEFAULT_ROOT;
}

const FOLDER_MEDIA_TYPES = new Set(['pic', 'video', 'gif', 'unknown-type']);

/**
 * Resolves the full relative download path for chrome.downloads.download.
 * Supports:
 * - 'single': <root>/<filename> (or <filename> if root is empty); default for missing/invalid mode
 * - 'by_site_and_type': <root>/<owning-site>/<pic|video|gif>/<filename>
 *   (or <owning-site>/<pic|video|gif>/<filename> if root is empty)
 * Only the returned string is computed here; Chromium creates directories when it saves the file.
 */
function resolveDownloadPath({
  filename,
  subfolder = FolderPath.DEFAULT_ROOT,
  folderOrganizationMode = 'single',
  owningSite = null,
  mediaType = null,
  resolvedUrl = '',
  resolvedExtension = '',
  pageUrl = '',
  isConvertedGif = false,
  contentType = '',
  group = null
} = {}) {
  const cleanRoot = sanitizeRootSubfolder(subfolder);
  const cleanFilename = (filename || 'download').replace(/^[/\\]+/, '');

  if (folderOrganizationMode !== 'by_site_and_type') {
    return FolderPath.joinPath([cleanRoot], cleanFilename);
  }

  const site = FolderPath.normalizeSite(
    owningSite || determineOwningWebsite({ pageUrl, resolvedUrl, group }),
    'unknown-site'
  );
  const type = FOLDER_MEDIA_TYPES.has(mediaType)
    ? mediaType
    : determineFinalMediaType({ resolvedUrl, resolvedExtension, isConvertedGif, contentType, group });

  return FolderPath.joinPath([cleanRoot, site, type], cleanFilename);
}

/**
 * Builds final filename using resolved URL and canonical MIME extension.
 * Preserves the existing sanitized basename when no canonical extension is available.
 * Supports universal download folder organization (FOLDER-01): the verified output MIME
 * (structuredResult.normalizedMime) is the routing evidence for the file actually saved.
 */
function buildFinalFilename(resolvedUrl, resolvedExtension, subfolder = '', options = {}) {
  const baseFilename = getFilenameFromUrl(resolvedUrl);
  const dot = baseFilename.lastIndexOf('.');
  const sanitizedBasename = dot !== -1 ? baseFilename.substring(0, dot) : baseFilename;

  let finalFilename = '';
  if (resolvedExtension) {
    const ext = resolvedExtension.startsWith('.') ? resolvedExtension : `.${resolvedExtension}`;
    finalFilename = `${sanitizedBasename}${ext}`;
  } else {
    finalFilename = sanitizedBasename;
  }

  return resolveDownloadPath({
    filename: finalFilename,
    subfolder,
    folderOrganizationMode: options.folderOrganizationMode,
    owningSite: options.owningSite,
    mediaType: options.mediaType,
    resolvedUrl,
    resolvedExtension,
    pageUrl: options.pageUrl,
    isConvertedGif: options.isConvertedGif,
    contentType: options.contentType || options.structuredResult?.normalizedMime,
    group: options.group
  });
}

/**
 * Strict validator and parser for Anime-Pictures CDN original artwork URLs.
 * Checks protocol (http/https), strict hostname (oimages.anime-pictures.net),
 * directory (3 hex chars), MD5 (32 hex chars), and allowlist extension (.jpg, .png, .jpeg).
 */
function parseAnimePicturesCdnUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.hostname.toLowerCase() !== 'oimages.anime-pictures.net') {
      return null;
    }
    // Pathname must strictly match /<dir>/<32-hex-md5>.<ext>
    const match = parsed.pathname.match(/^\/([a-f0-9]{3})\/([a-f0-9]{32})\.(jpe?g|png)$/i);
    if (!match) {
      return null;
    }
    const dir = match[1].toLowerCase();
    const md5 = match[2].toLowerCase();
    const rawExt = match[3].toLowerCase();
    const ext = rawExt === 'jpeg' ? '.jpeg' : (rawExt === 'jpg' ? '.jpg' : '.png');
    return {
      hostname: parsed.hostname.toLowerCase(),
      dir,
      md5,
      ext
    };
  } catch (_) {
    return null;
  }
}

/**
 * Strict validator and parser for Zerochan CDN, preview, and post URLs.
 * Extracts post ID, tag/character name, tier ('full', '1024', '600', '240', etc.), and extension.
 */
function parseZerochanMediaUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'zerochan.net' && !host.endsWith('.zerochan.net')) return null;
    const pathname = parsed.pathname;

    // Pattern 1: Static / CDN named image (e.g. /Sandrone.full.4728645.png or /Kirisame.Marisa.full.4728126.jpg)
    const namedMatch = pathname.match(/^\/(?:.*\/)?(.*?)\.(full|\d+)\.(\d+)\.([a-z0-9]+)$/i);
    if (namedMatch) {
      let cleanName = '';
      try {
        cleanName = decodeURIComponent(namedMatch[1]);
      } catch (_) {
        cleanName = namedMatch[1];
      }
      const tier = namedMatch[2].toLowerCase();
      const id = namedMatch[3];
      const ext = '.' + namedMatch[4].toLowerCase();
      return {
        hostname: host,
        name: cleanName,
        tier,
        id,
        ext,
        isFull: tier === 'full',
        isThumbnail: tier !== 'full'
      };
    }

    // Pattern 2: Numbered CDN path (e.g. /240/45/22/4728645.avif or /75/44/05/4727794.jpg)
    const numMatch = pathname.match(/^\/(\d+)\/(?:\d+\/)+(\d+)\.([a-z0-9]+)$/i);
    if (numMatch) {
      const tier = numMatch[1];
      const id = numMatch[2];
      const ext = '.' + numMatch[3].toLowerCase();
      return {
        hostname: host,
        name: null,
        tier,
        id,
        ext,
        isFull: false,
        isThumbnail: true
      };
    }

    // Pattern 3: Zerochan post page URL (e.g. /4728645 or /4728645#full)
    const postMatch = pathname.match(/^\/(\d+)(?:\/|\.|$|\?)/);
    if (postMatch) {
      return {
        hostname: host,
        name: null,
        tier: 'post',
        id: postMatch[1],
        ext: '',
        isFull: false,
        isThumbnail: false
      };
    }

    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Infers transport type from URL ('protectedBlob', 'pixivDataUrl', or 'direct').
 */
function inferTransportForUrl(url) {
  if (!url || typeof url !== 'string') return 'direct';
  if (url.includes('pximg.net')) return 'pixivDataUrl';
  if (isProtectedImageHost(url)) return 'protectedBlob';
  return 'direct';
}

/**
 * Factory for structured Candidate Group / Resolution Plan.
 */
function createCandidateGroup({
  id = null,
  source = 'unknown',
  provider = 'generic',
  tier = 'original', // 'original' | 'preview' | 'fallback'
  score = 0,
  validationMode = 'probe', // 'probe' | 'deferred'
  transport = 'direct', // 'direct' | 'protectedBlob' | 'pixivDataUrl'
  variants = [],
  variantPolicy = null,
  metadata = {}
} = {}) {
  const normalizedVariants = (Array.isArray(variants) ? variants : [])
    .map(v => {
      if (typeof v === 'string') {
        const dot = v.lastIndexOf('.');
        const ext = dot !== -1 ? v.substring(dot).split(/[?#]/)[0].toLowerCase() : '';
        return { url: v, expectedExtension: ext };
      }
      return v;
    })
    .filter(v => v && typeof v.url === 'string' && v.url.trim());

  const defaultPolicy = {
    advanceOn: [404, 410],
    retryOn: [429],
    maxRetriesPerVariant: 1,
    stopOn: ['AUTH', 'REDIRECT', 'NON_IMAGE', 'EMPTY_BODY', 'NETWORK_ERROR', 'RATE_LIMIT']
  };

  return {
    isCandidateGroup: true,
    id: id || `${provider}_${source}_${Math.random().toString(36).substring(2, 9)}`,
    source,
    provider,
    tier,
    score,
    finalScore: score,
    validationMode,
    transport,
    variants: normalizedVariants,
    variantPolicy: variantPolicy ? { ...defaultPolicy, ...variantPolicy } : defaultPolicy,
    metadata: { ...metadata },
    get primaryUrl() {
      return this.variants[0]?.url || '';
    }
  };
}

/**
 * Creates a single logical Candidate Group for Anime-Pictures original artwork
 * with 3 candidate variants (.jpg, .png, .jpeg).
 */
function createAnimePicturesOriginalGroup(dir, md5) {
  if (!dir || !md5) return null;
  const cleanDir = dir.toLowerCase();
  const cleanMd5 = md5.toLowerCase();
  if (!/^[a-f0-9]{3}$/.test(cleanDir) || !/^[a-f0-9]{32}$/.test(cleanMd5)) {
    return null;
  }

  const origin = 'https://oimages.anime-pictures.net';
  const allowlistExts = ['.jpg', '.png', '.jpeg'];
  const variants = allowlistExts.map(ext => ({
    url: `${origin}/${cleanDir}/${cleanMd5}${ext}`,
    expectedExtension: ext
  }));

  // Strict check: all variants have identical hostname, directory, and md5
  for (const v of variants) {
    const parsed = parseAnimePicturesCdnUrl(v.url);
    if (!parsed || parsed.hostname !== 'oimages.anime-pictures.net' || parsed.dir !== cleanDir || parsed.md5 !== cleanMd5) {
      return null;
    }
  }

  return createCandidateGroup({
    id: `anime_pictures_original_${cleanMd5}`,
    source: 'specialized_provider',
    provider: 'anime-pictures',
    tier: 'original',
    score: 95,
    validationMode: 'deferred',
    transport: 'protectedBlob',
    variants,
    variantPolicy: {
      advanceOn: [404, 410],
      retryOn: [429],
      maxRetriesPerVariant: 1,
      stopOn: ['AUTH', 'REDIRECT', 'NON_IMAGE', 'EMPTY_BODY', 'NETWORK_ERROR', 'RATE_LIMIT']
    },
    metadata: {
      dir: cleanDir,
      md5: cleanMd5
    }
  });
}

/**
 * Creates a single logical Candidate Group for Zerochan original artwork.
 * Prioritizes authoritative full URL (from JSON API or DOM) and provides deterministic
 * candidate variants (.png, .jpg, .jpeg, .webp, .avif) on static.zerochan.net with 404 advance policy.
 */
function createZerochanOriginalGroup(id, name, authoritativeFullUrl, metadata = {}) {
  if (!id) return null;
  const cleanId = String(id).trim();
  if (!/^\d+$/.test(cleanId)) return null;

  const origin = 'https://static.zerochan.net';
  const variants = [];
  const addedUrls = new Set();

  function addVariant(u, ext) {
    if (!u || addedUrls.has(u)) return;
    addedUrls.add(u);
    const dot = u.lastIndexOf('.');
    const cleanExt = ext || (dot !== -1 ? u.substring(dot).split(/[?#]/)[0].toLowerCase() : '');
    variants.push({ url: u, expectedExtension: cleanExt });
  }

  // 1. Authoritative full URL (e.g. from JSON API or DOM)
  if (authoritativeFullUrl && typeof authoritativeFullUrl === 'string') {
    const parsed = parseZerochanMediaUrl(authoritativeFullUrl);
    // Strict post ID ownership check: must match cleanId
    if (parsed && parsed.id === cleanId) {
      addVariant(authoritativeFullUrl, parsed.ext);
    }
  }

  // 2. Deterministic candidate variants when name is known
  if (name && typeof name === 'string' && name.trim()) {
    let encodedName = name.trim();
    try {
      encodedName = encodeURI(encodedName).replace(/#/g, '%23').replace(/\?/g, '%3F');
    } catch (_) {}
    const exts = ['.png', '.jpg', '.jpeg', '.webp', '.avif'];
    for (const ext of exts) {
      addVariant(`${origin}/${encodedName}.full.${cleanId}${ext}`, ext);
    }
  }

  if (variants.length === 0) return null;

  return createCandidateGroup({
    id: `zerochan_original_${cleanId}`,
    source: 'specialized_provider',
    provider: 'zerochan',
    tier: 'original',
    score: 95,
    validationMode: 'probe',
    transport: 'direct',
    variants,
    variantPolicy: {
      advanceOn: [404, 410],
      retryOn: [429],
      maxRetriesPerVariant: 1,
      stopOn: ['AUTH', 'REDIRECT', 'NON_IMAGE', 'EMPTY_BODY', 'NETWORK_ERROR', 'RATE_LIMIT']
    },
    metadata: {
      id: cleanId,
      name: name || '',
      ...metadata
    }
  });
}

/**
 * Compatibility adapter: converts a single legacy candidate into a Candidate Group with 1 variant.
 */
function adaptCandidateToGroup(candidate) {
  if (!candidate) return null;
  if (candidate.isCandidateGroup) {
    if (!candidate.variants || candidate.variants.length === 0 || !candidate.primaryUrl) {
      return null;
    }
    return candidate;
  }
  const url = typeof candidate === 'string' ? candidate : (candidate.url || '');
  if (!url || typeof url !== 'string' || !url.trim()) {
    return null;
  }
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:')) {
    return null;
  }
  const animeInfo = (candidate.source === 'specialized_provider' || candidate.source === 'initial_src') ? parseAnimePicturesCdnUrl(url) : null;
  if (animeInfo) {
    return createAnimePicturesOriginalGroup(animeInfo.dir, animeInfo.md5);
  }

  const isDeferred = candidate.validationMode
    ? candidate.validationMode === 'deferred'
    : Boolean(candidate.deferredProtectedValidation || isTrustedDeferredProtectedCandidate(candidate));
  const validationMode = candidate.validationMode || (isDeferred ? 'deferred' : 'probe');
  const transport = candidate.transport || inferTransportForUrl(url, candidate);

  // Adapted legacy candidates must use one neutral/legacy tier ('legacy') so their previous finalScore ordering remains unchanged.
  // Honor explicit candidate.tier when provided.
  const tier = candidate.tier || 'legacy';
  const score = typeof candidate.finalScore === 'number'
    ? candidate.finalScore
    : (typeof candidate.score === 'number'
      ? candidate.score
      : (typeof candidate.baseScore === 'number' ? candidate.baseScore : 20));

  let candidateContentType = candidate.contentType || candidate.metadata?.contentType || '';
  if (!candidateContentType && typeof url === 'string') {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const isTrustedFormatHost = host === 'preview.redd.it' || host === 'packaged-media.redd.it' || host.endsWith('.redd.it') || candidate.provider === 'reddit';
      const isVideoContext = candidate.mediaType === 'video' || candidate.type === 'video' || candidate.metadata?.mediaType === 'video';
      if (isTrustedFormatHost || isVideoContext) {
        const qf = parsed.searchParams.get('format') || parsed.searchParams.get('ext');
        if (qf && /^(mp4|video\/mp4)$/i.test(qf.trim())) {
          candidateContentType = 'video/mp4';
        } else if (qf && /^(webm|video\/webm)$/i.test(qf.trim())) {
          candidateContentType = 'video/webm';
        }
      }
    } catch (_) {}
  }

  let expectedExtension = candidate.expectedExtension || '';
  if (candidateContentType) {
    expectedExtension = resolveCanonicalExtension(candidateContentType, expectedExtension || url);
  } else if (!expectedExtension) {
    expectedExtension = getSafeUrlExtension(url);
  }

  const resGroup = createCandidateGroup({
    id: candidate.id,
    source: candidate.source || 'unknown',
    provider: candidate.provider || 'generic',
    tier,
    score,
    validationMode,
    transport,
    variants: [
      {
        url,
        expectedExtension,
        verified: candidate.verified || false,
        verifiedUrl: candidate.verified ? candidate.url : null,
        mimeEvidence: candidate.mimeEvidence || (candidate.verified ? MIME_EVIDENCE.HTTP_RESPONSE : MIME_EVIDENCE.URL_HINT)
      }
    ],
    metadata: {
      rawWidth: candidate.rawWidth || 0,
      rawHeight: candidate.rawHeight || 0,
      verified: candidate.verified || false,
      verifiedUrl: candidate.verified ? candidate.url : null,
      mimeEvidence: candidate.mimeEvidence || (candidate.verified ? MIME_EVIDENCE.HTTP_RESPONSE : MIME_EVIDENCE.URL_HINT),
      contentType: candidateContentType || '',
      contentLength: candidate.contentLength || 0,
      deferredProtectedValidation: isDeferred
    }
  });

  if (resGroup) {
    if (candidate.allowVideo) resGroup.allowVideo = true;
    if (candidate.isBooruCandidate) resGroup.isBooruCandidate = true;
    if (candidate._rateLimited) resGroup._rateLimited = true;
    if (candidate._verificationStatus) resGroup._verificationStatus = candidate._verificationStatus;
    if (candidate._verificationStatusObserved === false) resGroup._verificationStatusObserved = false;
    if (candidate.error) resGroup.error = candidate.error;
    if (candidate.verifiedBlob) resGroup.verifiedBlob = candidate.verifiedBlob;
  }
  return resGroup;
}

/**
 * Checks if candidate qualifies for trusted deferred protected validation
 * (specialized Anime-Pictures original candidate on oimages.anime-pictures.net).
 * Bypasses network probe to avoid burning CDN rate limits; validation is deferred to fetchProtectedBlob().
 */
function isTrustedDeferredProtectedCandidate(candidate) {
  if (!candidate) return false;
  if (candidate.isCandidateGroup) {
    return candidate.provider === 'anime-pictures' &&
           candidate.tier === 'original' &&
           candidate.validationMode === 'deferred';
  }
  if (!candidate.url) return false;
  if (candidate.source !== 'specialized_provider') return false;
  return parseAnimePicturesCdnUrl(candidate.url) !== null;
}


/**
 * Configure declarativeNetRequest dynamic rules for Referer header injection
 * Required for services like Pixiv (i.pximg.net) that return 403 Forbidden without a referer.
 */
async function setupDeclarativeNetRequestRules() {
  if (isDnrSetupInProgress) {
    return;
  }
  isDnrSetupInProgress = true;

  try {
    const updatePayload = {
      removeRuleIds: [...MANAGED_DNR_RULE_IDS],
      addRules: [...MANAGED_DNR_RULES]
    };

    await new Promise((resolve, reject) => {
      let settled = false;
      let ret;
      try {
        ret = chrome.declarativeNetRequest.updateDynamicRules(updatePayload, () => {
          if (settled) return;
          settled = true;
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) {
            console.error('[Image Saver] updateDynamicRules error:', lastErr.message);
            reject(new Error(`updateDynamicRules failed: ${lastErr.message}`));
          } else {
            resolve();
          }
        });
      } catch (syncErr) {
        if (!settled) {
          settled = true;
          console.error('[Image Saver] updateDynamicRules sync error:', syncErr);
          reject(syncErr);
        }
        return;
      }
      if (ret && typeof ret.then === 'function') {
        ret.then(
          () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          (promiseErr) => {
            if (!settled) {
              settled = true;
              console.error('[Image Saver] updateDynamicRules promise reject:', promiseErr);
              reject(promiseErr);
            }
          }
        );
      }
    });
  } catch (err) {
    console.error('[Image Saver] Ошибка в setupDeclarativeNetRequestRules():', err?.message || err);
  } finally {
    isDnrSetupInProgress = false;
  }
}

// Ensure declarativeNetRequest rules initialization on service worker launch/activation
setupDeclarativeNetRequestRules();

const CSS_MEDIA_MENU_ID = 'save-css-media-item';

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    // Chrome groups multiple extension entries into a submenu. Register one action for every target context;
    // provider routing remains internal and admission still proves the selected owner before saving.
    chrome.contextMenus.create({
      id: 'save-image-item',
      title: 'Image Saver: Save media under cursor',
      contexts: ['image', 'link', 'video', 'page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*']
    });
    contextTargetVisible = true;
    menuTitleNow = 'Image Saver: Save media under cursor';
    menuClick = null;
    console.log('[Image Saver] Пункты контекстного меню успешно зарегистрированы');
  });
}

function isXPageUrl(url) {
  return /^https:\/\/(?:x|twitter)\.com\//i.test(String(url || ''));
}

// Selected-target hint. Chrome has no event before the native menu opens (no onShown, no refresh), so the page's
// gesture sends one small message (content_context_target.js) and the one shared entry is shown or hidden from it: outside
// selected media it is absent from the menu (never a disabled item). That is only a best-effort hint: the menu may already
// be open on the previous state, so the save click never trusts it and re-proves the target (resolveContextMediaTarget)
// before any resolver or network request runs.
const CONTEXT_STATE_ITEMS = ['save-image-item'];
// null = unknown (the service worker has just started; an item hidden by an earlier worker is not known to be visible):
// the first answer always updates the item.
let contextTargetVisible = null;
const NEUTRAL_MENU_TITLE = 'Image Saver: Save media under cursor';
let menuTitleNow = null;
// The click the label belongs to: { tabId, frameId, documentId, url, titleBy, startAt }. A right-press ('down') or the keyboard menu key
// ('key') starts a new one; its contextmenu event ('menu') belongs to it. A provider (X, Reddit, RedGIFs, Danbooru) label is
// applied only for the frame of the current click and stays until the next click, a resting pointer, or a tab/window change.
let menuClick = null;
// Identity of one gesture inside a document: the timeStamp of the trusted DOM event that started it. Every content script of the
// frame (the generic capture and the provider scripts) sees the same event, so they report the same value without sharing
// state; successive gestures differ. Page clock, so it is only compared within one tab/frame/document.
function gestureStamp(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}
function clickIsIn(c, tabId, frameId, documentId) {
  return c.tabId === tabId && c.frameId === frameId && (c.documentId === undefined || documentId === undefined || c.documentId === documentId);
}
// The window that has the browser focus, undefined until windows.onFocusChanged or windows.getLastFocused says. tab.active
// is per window and does not mean this window owns the shared menu, so a rest hint is accepted only from the focused window.
const WINDOW_ID_NONE = typeof chrome !== 'undefined' && chrome.windows && typeof chrome.windows.WINDOW_ID_NONE === 'number' ? chrome.windows.WINDOW_ID_NONE : -1;
let focusedWindowId;
// Events that may change the menu are stamped when they arrive; the newest one whose result is on the menu wins. An answer that
// waited for the focused window (worker start) or a lifecycle event that did is dropped when a newer one was applied meanwhile.
let hintClock = 0;
let hintAppliedAt = 0;
function applyHint(stamp, change) {
  if (hintAppliedAt > stamp) return false;
  hintAppliedAt = stamp;
  change();
  return true;
}

// Calls back at once when the focused window is known, otherwise after windows.getLastFocused (a newer onFocusChanged wins; an
// API failure leaves it unknown, which callers treat as "may apply").
function withFocusedWindow(callback) {
  if (focusedWindowId !== undefined || typeof chrome.windows?.getLastFocused !== 'function') { callback(); return; }
  new Promise((resolve) => resolve(chrome.windows.getLastFocused())).then((win) => {
    if (focusedWindowId === undefined) focusedWindowId = win && win.focused ? win.id : WINDOW_ID_NONE;
  }, () => {}).then(callback);
}

// A tab was activated or navigated in window `windowId`. Only the focused window owns the shared menu; another window's tab
// event must not reset it. (Caches of a navigated tab are cleared by the caller whatever the window.)
function onSharedMenuTabEvent(windowId, change, changesState = true) {
  const stamp = ++hintClock;
  withFocusedWindow(() => {
    if (focusedWindowId !== undefined && Number.isInteger(windowId) && windowId !== focusedWindowId) return;
    if (changesState) applyHint(stamp, change); else change();
  });
}

function setContextTargetVisible(visible) {
  if (contextTargetVisible === visible) return;
  contextTargetVisible = visible;
  for (const id of CONTEXT_STATE_ITEMS) {
    try {
      // enabled: true is sent as well, so an item left disabled by an older version never stays greyed out.
      chrome.contextMenus?.update?.(id, { visible, enabled: true }, () => { void chrome.runtime?.lastError; });
    } catch (_) {}
  }
}

// The label of the shared entry. Unchanged labels are not sent again unless forced (a reset).
function applyMenuTitle(title, force = false) {
  if (!force && menuTitleNow === title) return;
  menuTitleNow = title;
  try {
    chrome.contextMenus?.update?.('save-image-item', { title }, () => {
      void chrome.runtime?.lastError;
      chrome.contextMenus?.refresh?.();
    });
  } catch (_) {}
}

// Whatever a previous gesture said does not carry over to another tab, window or document: visible again, label neutral.
function resetContextTargetHint() {
  setContextTargetVisible(true);
  menuClick = null;
  applyMenuTitle(NEUTRAL_MENU_TITLE, true);
}

// A selected preview whose original may be of another type (a GIF or a video behind a JPG thumbnail) is labelled neutrally:
// the same preview path patterns the Danbooru and Gelbooru resolvers use mark it as a preview of an unknown original.
function isBooruPreviewOfUnknownOriginal(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (isDanbooruDomain(host)) return /\/(sample|preview|\d+x\d+)\//.test(path) && !/\/original\//.test(path);
    if (isGelbooruDomain(host)) return /\/+(samples?|thumbnails?)\/+/.test(path);
  } catch (_) {}
  return false;
}

// The label from what the selected element itself is (see evidenceOf in content_context_target.js). Unknown is neutral:
// never a neighbour, a page-wide tag, looping or silence.
function genericMenuTitle(evidence, linkHref) {
  const fromUrl = (url, domType) => { const format = detectMediaFormat({ url, domType }); return format ? getMediaMenuTitle(format, 'default') : NEUTRAL_MENU_TITLE; };
  if (evidence) {
    if (evidence.kind === 'video' || evidence.kind === 'player') return evidence.url ? fromUrl(evidence.url, 'video') : getMediaMenuTitle('video');
    if (evidence.kind === 'img') {
      if (!evidence.url || isBooruPreviewOfUnknownOriginal(evidence.url)) return NEUTRAL_MENU_TITLE;
      return fromUrl(evidence.url, 'image');
    }
    return NEUTRAL_MENU_TITLE; // a layer or a CSS background: the type of its asset is not known here
  }
  if (typeof linkHref === 'string' && linkHref && hasMediaAssociation('', linkHref)) return fromUrl(linkHref, null);
  return NEUTRAL_MENU_TITLE;
}

function menuEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!['img', 'video', 'player', 'css'].includes(raw.kind)) return null;
  const url = raw.url;
  if (url !== null && url !== undefined && (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url))) return null;
  return { kind: raw.kind, url: url || null };
}

// Only a proven image on its profile photo link/opened view qualifies; profile-post authors are still previews.
function isXAvatarPreviewHint(pageUrl, evidence, link) {
  try {
    const page = new URL(pageUrl);
    const profileRoute = /^\/([a-z0-9_]+)(?:\/(?:photo|with_replies|media|likes|highlights|articles))?\/?$/i.exec(page.pathname);
    const isProfile = profileRoute && !/^(?:home|explore|search|notifications|messages|settings|i|compose|login|logout|signup|account|tos|privacy|about)$/i.test(profileRoute[1]);
    if (!isXPageUrl(page.href)) return false;
    if (evidence?.kind === 'video' || evidence?.kind === 'player') return false;
    if (evidence?.url) {
      const asset = new URL(evidence.url);
      if (asset.hostname !== 'pbs.twimg.com' || !asset.pathname.startsWith('/profile_images/')) return false;
      if (evidence.kind !== 'img' || !isProfile) return true;
      if (/\/photo\/?$/i.test(page.pathname)) return false;
      if (!link) return true;
      try {
        const photo = new URL(link);
        return !isXPageUrl(photo.href) || photo.pathname.toLowerCase().replace(/\/$/, '') !== '/' + profileRoute[1].toLowerCase() + '/photo';
      } catch (_) { return true; }
    }
    // An unresolved layer over a profile navigation link is the failing preview case; never infer an image from that link.
    const profile = new URL(link);
    return isXPageUrl(profile.href) && /^\/[a-z0-9_]+(?:\/photo)?\/?$/i.test(profile.pathname);
  } catch (_) { return false; }
}

// A provider's label belongs to the current click only: same tab, same frame (and document when both known) and the same
// gesture. The provider reports the timeStamp of the event it answers; a descriptor of an earlier gesture of this document
// (delayed delivery) is older than the current click's start and is foreign, while the current gesture's own descriptor, whatever
// preview, overlay or player it resolved to, is not older. With no click known yet (a page whose generic script has not spoken)
// the provider's own timing guards remain the only protection.
function providerOwnsClick(sender, gestureAt) {
  const c = menuClick;
  if (!c) return true;
  if (c.ended) return false; // the click is over (the pointer rests elsewhere): a late label of it is foreign
  if (!clickIsIn(c, sender?.tab?.id, Number.isInteger(sender?.frameId) ? sender.frameId : 0, sender?.documentId)) return false;
  if (c.startAt !== null && c.startAt !== undefined) {
    const at = gestureStamp(gestureAt);
    if (at === null || at < c.startAt) return false;
  }
  return true;
}

function applyProviderTitle(sender, title, gestureAt) {
  if (!providerOwnsClick(sender, gestureAt)) return false;
  if (menuClick) menuClick.titleBy = 'provider';
  applyMenuTitle(title);
  return true;
}

// The page remembers the last answer it sent (content_context_target.js) and sends only a change. After a reset it no longer
// matches the menu, so the shown tab is told to forget it and answer again once for the resting pointer. One small message
// per focus or tab change, never per pointer event; a tab without the script just has no receiver.
function notifyContextHintReset(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    const sent = chrome.tabs?.sendMessage?.(tabId, { action: 'CONTEXT_HINT_RESET' });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch (_) {}
}

function isContentScriptSender(sender) {
  return Boolean(sender) && typeof sender.id === 'string' && sender.id === chrome.runtime?.id &&
    Number.isInteger(sender.tab?.id) && Number.isInteger(sender.frameId) &&
    /^https?:\/\//i.test(typeof sender.url === 'string' ? sender.url : '');
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.action !== 'CONTEXT_TARGET_STATE') return;
    if (!isContentScriptSender(sender) || sender.tab.active !== true) return;
    if (typeof message.selectable !== 'boolean') return;
    // 'gesture' (a real right-press / contextmenu / keyboard menu key) or 'pointer' (the pointer rests): both are hints.
    if (message.source !== undefined && message.source !== 'gesture' && message.source !== 'pointer') return;
    if (message.phase !== undefined && !['down', 'menu', 'key', 'rest'].includes(message.phase)) return;
    const link = message.linkHref;
    if (link !== null && link !== undefined && (typeof link !== 'string' || link.length > 2048)) return;
    // A direct media link is a target of its own; a plain navigation link or empty space is not.
    const evidence = menuEvidence(message.media);
    const selectable = !isXAvatarPreviewHint(sender.url, evidence, link) &&
      (message.selectable || hasMediaAssociation('', link || ''));
    const gestureAt = gestureStamp(message.gestureAt);
    // A real gesture always carries the stamp of its trusted event (0 is a valid stamp). One without a valid stamp cannot be
    // ordered against the click already on the menu, so it must not start a click, reset the current one, change the visibility
    // or open the click to descriptors of an earlier gesture: it is refused like any other malformed message. A resting
    // pointer ('pointer') has no gesture and no stamp.
    if (message.source === 'gesture' && gestureAt === null) return;
    const stamp = ++hintClock;
    const apply = () => {
      // A resting pointer is a hint for the window that owns the menu now: not for a window that lost focus (its message may
      // have been sent earlier) nor while no window has focus. A real gesture is authoritative.
      if (message.source === 'pointer' && focusedWindowId !== undefined && sender.tab.windowId !== focusedWindowId) return;
      applyHint(stamp, () => {
        const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
        const cur = menuClick;
        // A gesture message older than the click already on the menu is a delayed answer of an earlier gesture of this
        // document: it changes neither the visibility nor the label.
        if (message.source === 'gesture' && cur && cur.startAt !== null && cur.startAt !== undefined && gestureAt !== null &&
          clickIsIn(cur, sender.tab.id, frameId, sender.documentId) && gestureAt < cur.startAt) return;
        setContextTargetVisible(selectable);
        // The label follows the selected target of this message, never an earlier click's: a new click resets it, a provider
        // label of the same click is kept, a resting pointer prepares the label of what is under it.
        if (message.source === 'gesture') {
          const sameClick = message.phase === 'menu' && cur && !cur.ended && clickIsIn(cur, sender.tab.id, frameId, sender.documentId);
          if (!sameClick) menuClick = { tabId: sender.tab.id, frameId, documentId: sender.documentId, url: evidence && evidence.url || '', titleBy: 'generic', startAt: gestureAt };
          else if (!menuClick.url && evidence && evidence.url) menuClick.url = evidence.url;
          if (menuClick.titleBy !== 'provider') applyMenuTitle(selectable ? genericMenuTitle(evidence, link) : NEUTRAL_MENU_TITLE);
        } else {
          // A resting pointer prepares the label of what is under it and ends the previous click.
          menuClick = { ended: true, tabId: sender.tab.id, frameId, documentId: sender.documentId, startAt: menuClick && menuClick.startAt !== undefined && clickIsIn(menuClick, sender.tab.id, frameId, sender.documentId) ? menuClick.startAt : null };
          applyMenuTitle(selectable ? genericMenuTitle(evidence, link) : NEUTRAL_MENU_TITLE);
        }
      });
    };
    // A rest hint in a worker that has just started waits for the focused window; a gesture does not wait.
    if (message.source === 'pointer') withFocusedWindow(apply); else apply();
  });
}

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

  const SENSITIVE_KEY_RE = /^(?:token|access_token|auth|key|signature|sig|secret|api_key|apikey|s|jsc_token|session|bearer)$/i;

  try {
    const parsed = new URL(input);
    let modified = false;
    for (const [key, value] of parsed.searchParams.entries()) {
      // names of signature-bearing parameters beyond the short list: AWS/Google (X-Amz-Credential, X-Goog-Credential), CloudFront (Policy, Key-Pair-Id), Akamai (hdnts, hdnea)
      if (SENSITIVE_KEY_RE.test(key) || /token|secret|auth|signature|credential|policy|key-pair-id|hdnts|hdnea/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
        modified = true;
      }
    }
    return modified ? parsed.toString() : input;
  } catch (_) {
    // If not a full valid URL, fallback to regex replacement
    return input.replace(/([?&](?:token|access_token|auth|key|signature|sig|secret|api_key|apikey|s|jsc_token)=)[^&]*/gi, '$1[REDACTED]');
  }
}

/**
 * Diagnostic form of a candidate-group id. The id itself is an identity and stays exact: it embeds the complete normalized URL
 * (`candidate_<url>`) or the last 40 characters of one (`video_<encoded tail>`, `x_video_...`), signed query included. A log line shows only
 * the origin and path with a redaction marker for the query, or only the kind of a truncated tail with a marker; everything else is unchanged.
 */
function sanitizeGroupIdForLog(id) {
  if (typeof id !== 'string') return id;
  const url = /^(.*?_)(https?:\/\/.+)$/i.exec(id);
  if (url) {
    try {
      const u = new URL(url[2]);
      return `${url[1]}${u.origin}${u.pathname}${u.search || u.hash ? '?[REDACTED]' : ''}`;
    } catch (_) {
      return `${url[1]}[REDACTED]`;
    }
  }
  // `video_` / `x_video_` carry the last 40 characters of an address, cut at an arbitrary point: they may be (part of) a signature without any
  // delimiter, or start inside one secret and reach a later delimiter. A safe part cannot be established, so the kind is shown without the tail.
  const tail = /^((?:x_)?video_)(.+)$/.exec(id);
  if (tail) return `${tail[1]}[REDACTED]`;
  return id;
}

/**
 * Detects specific media format or category from URL, mediaType, or DOM element type.
 * Deterministic and completely offline — performs zero network requests.
 *
 * Supported formats:
 * - 'gif': GIF animated images (including Tenor and X tweet_video)
 * - 'png': PNG images
 * - 'jpg': JPEG / JPG images
 * - 'webp': WebP images
 * - 'avif': AVIF images
 * - 'svg': SVG vector images
 * - 'video': MP4, WebM, and HTML5 video elements
 * - 'image': Generic image fallback
 * - null: Unknown or non-media
 */
function detectMediaFormat({ url, mediaType, domType } = {}) {
  const urlStr = typeof url === 'string' ? url.trim() : (url ? url.toString() : '');

  // 1. Explicit domain/caller hint for animation
  if (domType === 'reddit_gif' || mediaType === 'reddit_gif') {
    return 'reddit_gif';
  }
  if (domType === 'x_tweet_video') {
    return 'gif';
  }

  // 2. Strong validated URL animation evidence takes precedence over generic HTML video element hints
  if (urlStr) {
    try {
      const parsed = new URL(urlStr, 'https://localhost/');
      const pathname = parsed.pathname.toLowerCase();
      const host = parsed.hostname.toLowerCase();

      // Twitter / X tweet video is an animated GIF
      if ((host === 'video.twimg.com' && pathname.includes('/tweet_video/')) ||
          ((host === 'twimg.com' || host.endsWith('.twimg.com')) && pathname.includes('/tweet_video_thumb/'))) {
        return 'gif';
      }

      // Reddit animated GIF served as MP4: preview.redd.it/...gif?format=mp4
      if (typeof isRedditAnimationUrl === 'function' && isRedditAnimationUrl(urlStr)) {
        return 'reddit_gif';
      }
      if (typeof isRedditDomain === 'function' && isRedditDomain(host) && pathname.includes('.gif') &&
          (parsed.searchParams.get('format') === 'mp4' || parsed.searchParams.get('format') === 'video/mp4')) {
        return 'reddit_gif';
      }

      // Twitter / X regular video
      if (host === 'video.twimg.com' && (pathname.includes('/ext_tw_video/') || pathname.includes('/amplify_video/'))) {
        return 'video';
      }

      // Packaged-media Reddit video (packaged-media.redd.it)
      if (host === 'packaged-media.redd.it') {
        if (!pathname.endsWith('.mpd') && !pathname.endsWith('.m3u8') && !pathname.endsWith('.html') && !pathname.includes('/comments/')) {
          return 'packaged_media';
        }
      }

      // Reddit v.redd.it video
      if (host === 'v.redd.it') {
        if (!pathname.endsWith('.mpd') && !pathname.endsWith('.m3u8') && !pathname.endsWith('.html') && !pathname.includes('/comments/')) {
          return 'video';
        }
      }

      // RedGIFs video routes
      if (typeof isAllowedRedGifsHost === 'function' && isAllowedRedGifsHost(host)) {
        if (/\/(?:watch|ifr|detail|gifs)\/([a-zA-Z0-9_-]+)/i.test(pathname)) {
          return 'video';
        }
      }

      // Tenor media domains and URLs
      if (host === 'media.tenor.com' || host === 'c.tenor.com' || /^media\d*\.tenor\.com$/.test(host) || (host.includes('tenor.com') && pathname.includes('/view/'))) {
        return 'gif';
      }

      // Check query parameter format/ext (common on Twitter/X, e.g. ?format=jpg, or CDNs ?ext=png)
      const queryFormat = parsed.searchParams.get('format') || parsed.searchParams.get('ext') || parsed.searchParams.get('f') || parsed.searchParams.get('mime');
      if (queryFormat) {
        const qf = queryFormat.toLowerCase().trim();
        if (qf === 'gif' || qf === 'image/gif') return 'gif';
        if (qf === 'png' || qf === 'image/png') return 'png';
        if (qf === 'jpg' || qf === 'jpeg' || qf === 'jfif' || qf === 'image/jpeg') return 'jpg';
        if (qf === 'webp' || qf === 'image/webp') return 'webp';
        if (qf === 'avif' || qf === 'image/avif') return 'avif';
        if (qf === 'svg' || qf === 'svg+xml' || qf === 'image/svg+xml') return 'svg';
        if (qf === 'mp4' || qf === 'video/mp4') return 'video';
        if (qf === 'webm' || qf === 'video/webm') return 'video';
      }

      // Check extension in pathname
      const extMatch = pathname.match(/\.([a-z0-9]+)$/i);
      if (extMatch) {
        const ext = extMatch[1].toLowerCase();
        if (ext === 'gif') return 'gif';
        if (ext === 'png') return 'png';
        if (ext === 'jpg' || ext === 'jpeg' || ext === 'jpe' || ext === 'jfif') return 'jpg';
        if (ext === 'webp') return 'webp';
        if (ext === 'avif') return 'avif';
        if (ext === 'svg') return 'svg';
        if (ext === 'mp4' || ext === 'm4v' || ext === 'mov' || ext === 'webm' || ext === 'ogv') return 'video';
      }
    } catch (_) {}
  }

  // 3. Fall back to DOM / context mediaType
  if (domType === 'video') {
    return 'video';
  }
  if (domType === 'image' || mediaType === 'image') {
    return 'image';
  }
  if (mediaType === 'video') {
    return 'video';
  }

  return null;
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

/**
 * Maps detected media format to human-readable menu title string.
 */
function getMediaMenuTitle(format, context = 'default') {
  let fmt = format;
  let sourceType = null;
  if (typeof format === 'object' && format !== null) {
    fmt = format.type || format.format;
    sourceType = format.sourceType;
  }

  // Reddit animated GIF delivered as MP4 (preview.redd.it/*.gif?format=mp4)
  if (sourceType === 'reddit_gif' || fmt === 'reddit_gif' || context === 'reddit_gif') {
    return 'Image Saver: Save GIF animation';
  }

  // Confirmed native GIF animation (explicit native_gif format, sourceType, or context)
  if (sourceType === 'native_gif' || fmt === 'native_gif' || context === 'native_gif' || context === 'reddit_native_gif') {
    return 'Image Saver: Save GIF animation';
  }

  // Packaged-media Reddit video (packaged-media.redd.it/*.mp4)
  if (sourceType === 'packaged_media' || fmt === 'packaged_media' || fmt === 'packaged-media' || context === 'packaged_media' || context === 'packaged-media') {
    return 'Image Saver: Save video';
  }

  // A GIF file selected by its own address (format known, animation not confirmed by a provider): labelled as the format.
  if (fmt === 'gif' && context === 'default' && !sourceType) {
    return 'Image Saver: Save GIF';
  }

  // Twitter / X tweet video animation
  if (sourceType === 'x_tweet_video' || fmt === 'x_tweet_video' || (fmt === 'gif' && (context === 'x' || context === 'tweet_video'))) {
    return 'Image Saver: Save GIF animation';
  }
  if (fmt === 'video' || fmt === 'mp4' || fmt === 'webm') {
    return 'Image Saver: Save video';
  }
  if (fmt === 'image' || fmt === 'gif' || fmt === 'png' || fmt === 'jpg' || fmt === 'jpeg' || fmt === 'webp' || fmt === 'avif' || fmt === 'svg') {
    return 'Image Saver: Save image';
  }
  if (context === 'x' || context === 'page') {
    return 'Image Saver: Save media under cursor';
  }
  return 'Image Saver: Save image';
}

const lastDetectedXMediaByTab = new Map();
const X_NEUTRAL_MENU_TITLE = 'Image Saver: Save media under cursor';

// The X entry is labelled from the media that belongs to the current click only; no owned target keeps it neutral.
function getXMediaMenuTitle(media, info = {}) {
  if (!media) return X_NEUTRAL_MENU_TITLE;
  const format = detectMediaFormat({
    url: media.url || info.srcUrl,
    mediaType: info.mediaType,
    domType: media.type
  });
  return getMediaMenuTitle(format, 'x');
}
const lastDetectedRedditMediaByTab = new Map();

/**
 * Dynamically updates context menu titles according to media under cursor.
 */
async function updateContextMenuTitles(info, tab) {
  if (!info) return;

  const targetUrl = info.srcUrl || info.linkUrl || '';
  // X's own hosts only: a path that merely contains /tweet_video/ on any other site is an ordinary video.
  const isTweetVid = Boolean(resolveTweetVideoThumbUrl(targetUrl)) || Boolean(toTweetVideoUrl(targetUrl));

  // 1. Update save-image-item if present in menuIds or on image/link/video context
  const hasImageItem = !info.menuIds || info.menuIds.includes('save-image-item');
  if (hasImageItem && (info.srcUrl || info.mediaType === 'image' || info.mediaType === 'video')) {
    const isRedditGif = typeof isRedditAnimationUrl === 'function' ? isRedditAnimationUrl(targetUrl) : (
      typeof isRedditDomain === 'function' &&
      isRedditDomain((() => { try { return new URL(targetUrl).hostname; } catch(_) { return ''; } })()) &&
      targetUrl.includes('.gif') && (targetUrl.includes('format=mp4') || targetUrl.includes('format=video/mp4'))
    );
    const isPackagedMedia = targetUrl.includes('packaged-media.redd.it');
    const isRedditNativeGif = (
      typeof isRedditDomain === 'function' &&
      isRedditDomain((() => { try { return new URL(targetUrl).hostname; } catch(_) { return ''; } })()) &&
      /\.gif(\?.*)?$/i.test(targetUrl) &&
      !isRedditGif
    );

    let context = 'default';
    if (isTweetVid) context = 'tweet_video';
    else if (isRedditGif) context = 'reddit_gif';
    else if (isRedditNativeGif) context = 'native_gif';
    else if (isPackagedMedia) context = 'packaged_media';

    const format = detectMediaFormat({
      url: targetUrl,
      mediaType: info.mediaType
    });
    const imageTitle = getMediaMenuTitle(isRedditNativeGif ? 'native_gif' : format, context);
    try {
      chrome.contextMenus?.update?.('save-image-item', { title: imageTitle }, () => {
        chrome.contextMenus?.refresh?.();
      });
    } catch (_) {}
  }

  // 2. Label the shared entry from the current X page/overlay target.
  const isXPage = (info.pageUrl && (info.pageUrl.includes('x.com') || info.pageUrl.includes('twitter.com'))) ||
                  (!info.pageUrl && tab?.url && (tab.url.includes('x.com') || tab.url.includes('twitter.com')));
  const hasXItem = !info.menuIds || info.menuIds.includes('save-image-item');

  if (hasXItem && isXPage && !info.srcUrl && !info.linkUrl) {
    // Ask the page for the current click's media. The per-tab cache of an earlier click is never used here:
    // a blank click right after a video click would otherwise be labelled (and saved) as that video.
    let media = null;
    if (tab?.id) {
      try {
        media = await chrome.tabs.sendMessage(tab.id, { action: 'GET_X_MEDIA_AT_CURSOR' });
      } catch (_) {}
    }

    const xTitle = getXMediaMenuTitle(media, info);
    try {
      chrome.contextMenus?.update?.('save-image-item', { title: xTitle }, () => {
        chrome.contextMenus?.refresh?.();
      });
    } catch (_) {}
  }
}

if (typeof chrome !== 'undefined' && chrome.contextMenus?.onShown?.addListener) {
  chrome.contextMenus.onShown.addListener(async (info, tab) => {
    try {
      await updateContextMenuTitles(info, tab);
    } catch (e) {
      console.warn('[Image Saver] Ошибка при динамическом обновлении меню:', e);
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    // Provider hints from a background tab must not relabel the shared action in the active tab.
    if (sender?.tab?.active === false) return;
    if (message?.action === 'X_MEDIA_CONTEXTMENU_DETECTED' && sender?.tab?.id) {
      lastDetectedXMediaByTab.set(sender.tab.id, {
        media: message.media,
        timestamp: Date.now()
      });
      applyProviderTitle(sender, getXMediaMenuTitle(message.media), message.gestureAt);
    } else if (message?.action === 'REDDIT_MEDIA_CONTEXTMENU_DETECTED' && sender?.tab?.id) {
      const tabId = sender.tab.id;
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
      const msgTime = Number(message.timestamp) || Date.now();
      const existing = lastDetectedRedditMediaByTab.get(tabId);
      if (existing && existing.timestamp && existing.timestamp > msgTime) {
        // Drop out-of-order stale message
        return;
      }
      lastDetectedRedditMediaByTab.set(tabId, {
        media: message.media,
        timestamp: msgTime,
        frameId,
        documentUrl: sender.url || ''
      });

      const media = message.media;
      let format = 'image';
      let context = 'default';
      if (media?.sourceType === 'reddit_gif' || media?.type === 'reddit_gif' || (media?.url && isRedditAnimationUrl(media.url))) {
        format = 'reddit_gif';
        context = 'reddit_gif';
      } else if (media?.sourceType === 'packaged_media') {
        format = 'packaged_media';
        context = 'packaged_media';
      } else if (media?.sourceType === 'native_gif' || media?.type === 'native_gif') {
        format = 'native_gif';
        context = 'native_gif';
      } else if (media?.type === 'video') {
        format = 'video';
        context = 'default';
      } else if (media?.url) {
        format = detectMediaFormat({ url: media.url, domType: media.type, mediaType: media.type });
        if (format === 'reddit_gif') context = 'reddit_gif';
        else if (format === 'packaged_media') context = 'packaged_media';
        else if (format === 'gif' || media?.sourceType === 'native_gif' || (typeof isRedditDomain === 'function' && isRedditDomain((() => { try { return new URL(media.url).hostname; } catch(_) { return ''; } })()) && /\.gif(\?.*)?$/i.test(media.url))) {
          format = 'native_gif';
          context = 'native_gif';
        }
      }

      applyProviderTitle(sender, getMediaMenuTitle(format, context), message.gestureAt);
    } else if (message?.action === 'REDGIFS_MEDIA_CONTEXTMENU_DETECTED' && sender?.tab?.id) {
      // Must be a positively identified RedGIFs media target
      if (message.media?.sourceType !== 'redgifs') {
        return;
      }
      const tabId = sender.tab.id;
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
      const msgTime = Number(message.timestamp) || Date.now();
      const existing = lastDetectedRedditMediaByTab.get(tabId);
      if (existing && existing.timestamp && existing.timestamp > msgTime) {
        // Drop out-of-order stale message
        return;
      }
      lastDetectedRedditMediaByTab.set(tabId, {
        media: message.media,
        timestamp: msgTime,
        frameId,
        documentUrl: sender.url || ''
      });
      applyProviderTitle(sender, getMediaMenuTitle('video', 'default'), message.gestureAt);
    } else if (message?.action === 'BOORU_MEDIA_CONTEXTMENU_DETECTED' && sender?.tab?.id) {
      // The selected Danbooru item's own metadata (data-file-ext of its post container) says what its original is, whatever
      // the preview looks like. It must belong to the asset of the current click: same frame, same md5 or address.
      const ext = String(message.fileExt || '').toLowerCase();
      if (!DANBOORU_DOM_ALLOWED_EXTS.has(ext) || !menuClick || !providerOwnsClick(sender, message.gestureAt) || !menuClick.url) return;
      const md5Of = (u) => { const m = typeof u === 'string' ? u.match(/[a-f0-9]{32}/i) : null; return m ? m[0].toLowerCase() : null; };
      const target = typeof message.targetUrl === 'string' ? message.targetUrl : '';
      const sameAsset = target === menuClick.url || (md5Of(target) !== null && md5Of(target) === md5Of(menuClick.url));
      if (!sameAsset) return;
      applyProviderTitle(sender, ext === 'webm' || ext === 'mp4' ? getMediaMenuTitle('video') : getMediaMenuTitle(ext === 'gif' ? 'gif' : 'image'), message.gestureAt);
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.windows?.onFocusChanged?.addListener) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    focusedWindowId = windowId;
    applyHint(++hintClock, resetContextTargetHint);
    if (windowId !== WINDOW_ID_NONE && typeof chrome.tabs?.query === 'function') {
      try {
        Promise.resolve(chrome.tabs.query({ active: true, windowId })).then((tabs) => {
          for (const t of Array.isArray(tabs) ? tabs : []) notifyContextHintReset(t && t.id);
        }, () => {});
      } catch (_) {}
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated?.addListener) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    onSharedMenuTabEvent(activeInfo && activeInfo.windowId, () => {
      resetContextTargetHint();
      notifyContextHintReset(activeInfo && activeInfo.tabId);
    });
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated?.addListener) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading' || changeInfo.url) {
      lastDetectedRedditMediaByTab.delete(tabId);
      lastDetectedXMediaByTab.delete(tabId);
      // The shared menu is touched only by a tab of the focused window; its availability only by the shown tab.
      const resetTitle = () => applyMenuTitle(NEUTRAL_MENU_TITLE, true);
      onSharedMenuTabEvent(tab?.windowId, tab?.active ? resetContextTargetHint : resetTitle, Boolean(tab?.active));
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupDeclarativeNetRequestRules();
  setupContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  setupDeclarativeNetRequestRules();
  setupContextMenus();
  reconcileActiveOffscreenDownloads();
});

// ============================================================================
// ============================================================================
// 2. Candidate Normalization, Scoring & Verification
// ============================================================================

/**
 * Normalizes an image candidate URL:
 * - Resolves relative URLs against baseUrl
 * - Trims whitespace
 * - Strips unnecessary cache parameters
 */
function normalizeCandidateUrl(rawUrl, baseUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) {
    return null;
  }
  try {
    const absUrl = new URL(trimmed, baseUrl);
    return absUrl.toString();
  } catch (e) {
    return null;
  }
}

/**
 * Determines whether a URL has obvious thumbnail/preview indicators.
 * NOTE: As per guidelines, file extensions like .avif or .webp are NEVER penalized.
 * Only path/query/filename tokens indicating thumbnails/resizes are penalized.
 */
function isThumbnailUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();

    // Known thumbnail hostnames / subpaths
    if (host.includes('gstatic.com') && pathname.includes('/images') && search.includes('q=tbn:')) {
      return true;
    }
    if (host.includes('avatars.mds.yandex.net') && pathname.includes('/get-images-thumbs/')) {
      return true;
    }
    if (host.includes('preview.redd.it') || host.includes('external-preview.redd.it')) {
      return true;
    }

    // Path segments indicating thumbnail/preview
    const thumbPathPattern = /\/(?:thumbs?|thumbnails?|previews?|samples?|small|mini|avatars?|custom-thumb|\d+x\d+)\//i;
    if (thumbPathPattern.test(pathname)) {
      return true;
    }

    // File name prefixes/suffixes indicating thumbnail/compressed preview
    // e.g. sample_123.jpg, thumb_123.jpg, 1500x3187-..._cp.avif, ..._sp.png
    if (/(?:^|\/|[_-])(?:thumb|thumbnail|sample|small|mini)[_-]/i.test(pathname)) {
      return true;
    }
    if (/(?:_cp|_sp|_thumb|_preview)\.[a-z0-9]+$/i.test(pathname)) {
      return true;
    }

    // Dimension resize suffix in filename (e.g. photo-150x150.jpg, -300x200.png, -1024x768.jpg)
    if (/-\d{2,4}x\d{2,4}\.[a-z0-9]+$/i.test(pathname)) {
      return true;
    }

    // Dimension prefix (e.g. Anime-Pictures 1500x3187-hash) — scoped to anime-pictures.net CDN only
    if (host.includes('anime-pictures.net') && /\/\d{2,4}x\d{2,4}-[a-f0-9]{20,}/i.test(pathname)) {
      return true;
    }

    // Zerochan previews/thumbnails (e.g. .240.4728645.avif, .600.4728645.jpg, .1024.4728645.webp, /240/45/22/4728645.avif)
    // Scoped strictly to zerochan.net hosts; genuine original .full. (including .full.*.avif) is NOT a thumbnail
    if (host.includes('zerochan.net')) {
      if (/\.(?:75|240|600|1024)\.\d+\.[a-z0-9]+$/i.test(pathname)) {
        return true;
      }
      if (/\/(?:75|240|600|1024)\/\d+/i.test(pathname)) {
        return true;
      }
    }

    // GIPHY preview suffixes
    if ((host.includes('giphy.com') || host === 'i.giphy.com') && (/\/(?:200|200w|100|100w|giphy_s)\.[a-z0-9]+$/i.test(pathname) || /_s\.[a-z0-9]+$/i.test(pathname))) {
      return true;
    }

    // e-shuushuu preview/medium images (not fullsize)
    if (host.includes('e-shuushuu.net') && pathname.includes('/medium/')) {
      return true;
    }

    // Pixiv preview/master variants on pximg.net (img-master, custom-thumb)
    if ((host === 'i.pximg.net' || host.includes('pximg.net') || host.includes('pixiv.net')) && (pathname.includes('/img-master/') || pathname.includes('/custom-thumb/'))) {
      return true;
    }

    // Twitter/X: non-original size variants on pbs.twimg.com and *.twimg.com
    if (host === 'twimg.com' || host.endsWith('.twimg.com')) {
      const nameParam = parsed.searchParams.get('name');
      if (nameParam) {
        const lowerName = nameParam.toLowerCase();
        if (lowerName !== 'orig' && lowerName !== '4096x4096') {
          return true;
        }
      }
      const colonMatch = pathname.match(/:([a-z0-9_]+)$/i);
      if (colonMatch) {
        const lowerColon = colonMatch[1].toLowerCase();
        if (lowerColon !== 'orig' && lowerColon !== '4096x4096') {
          return true;
        }
      }
      if (pathname.includes('/profile_images/') && /_(normal|mini|bigger|200x200)\.(jpe?g|png|webp)$/i.test(pathname)) {
        return true;
      }
      if (pathname.includes('/profile_banners/') && /\/(web|mobile|600x200|300x100|web_retina)$/i.test(pathname)) {
        return true;
      }
    }

    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Checks if a URL represents a recognized original/full-size media path
 */
function isOriginalPath(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const p = parsed.pathname.toLowerCase();
    if (parsed.hostname.toLowerCase() === 'i.redd.it') return true;
    if (p.includes('/original/') || p.includes('/img-original/') || p.includes('/full/') || p.includes('/_images/') || p.includes('/pictures/get_image/') || (parsed.hostname.includes('tenor.com') && p.includes('aaaac')) || (parsed.hostname.includes('giphy.com') && p.endsWith('/giphy.gif')) || (parsed.hostname.includes('yande.re') && p.includes('/image/')) || (parsed.hostname.includes('gelbooru.com') && p.includes('/images/')) || (parsed.hostname.includes('e-shuushuu.net') && p.includes('/fullsize/')) || (parsed.hostname.includes('zerochan.net') && p.includes('.full.'))) {
      return !isThumbnailUrl(url);
    }
  } catch (e) {}
  return false;
}

/**
 * Computes deterministic base score for a candidate based on source provenance and URL characteristics.
 *
 * Source weights:
 * - dom_data_original: 95 (explicit data-original, data-full, data-super-full-img)
 * - search_result_decoded: 90 (decoded Google imgurl, Yandex img_href, Anime-Pictures original artwork)
 * - specialized_provider: 85 (Pixiv Ajax/orig, Reddit clean i.redd.it, Twitter :orig, Wikimedia full, Boorus)
 * - dom_link: 75 (parent/card <a> pointing directly to an image file)
 * - dom_srcset: 70 (highest resolution candidate from srcset)
 * - css_background: 65 (CSS background-image extracted from clicked element/ancestor)
 * - cdn_transform: 50 (clean query stripped, -1024x768 stripped, /sample/ -> /images/)
 * - page_meta: 25 (OpenGraph og:image, Twitter Cards, link image_src — low priority social preview)
 * - initial_src: 15 (original clicked img.src / currentSrc)
 *
 * Penalties:
 * - Thumbnail/preview markers: -40
 * - Low-resolution descriptor (< 400w): -20
 */
function scoreCandidateUrl(url, source, rawWidth = 0, rawHeight = 0) {
  const sourceScores = {
    dom_data_original: 95,
    search_result_decoded: 90,
    specialized_provider: 85,
    dom_link: 75,
    dom_srcset: 70,
    css_background: 65,
    cdn_transform: 50,
    page_meta: 25,
    initial_src: 15
  };

  let score = sourceScores[source] || 20;

  // If the initial_src is already a clean original path
  if (source === 'initial_src' && isOriginalPath(url)) {
    score = 60;
  }

  // Penalty for thumbnail/preview indicators in URL
  if (isThumbnailUrl(url)) {
    score -= 40;
  }

  // Width descriptor adjustments (for srcset)
  if (rawWidth >= 2000) {
    score += 10;
  } else if (rawWidth > 0 && rawWidth < 400) {
    score -= 20;
  }

  return score;
}

// Recognized static image extensions across Image Saver
const IMAGE_EXTENSIONS_REGEX = /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)$/i;

const EXPLICIT_NON_IMAGE_MIMES = new Set([
  'text/html',
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript'
]);

/**
 * Checks if the URL pathname ends with a recognized image extension.
 * Strips query string and fragment before evaluation.
 */
function hasImageExtensionInPath(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr, 'https://dummy.local');
    return IMAGE_EXTENSIONS_REGEX.test(parsed.pathname);
  } catch (_) {
    return false;
  }
}

/**
 * Checks if normalized MIME type is explicitly non-image content.
 */
function isExplicitNonImageMime(mime) {
  if (!mime || typeof mime !== 'string') return false;
  if (EXPLICIT_NON_IMAGE_MIMES.has(mime)) return true;
  if (mime.startsWith('text/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
    return true;
  }
  return false;
}

/**
 * Probes candidate network availability (HEAD / Range GET) and extracts metadata.
 * Adjusts candidate finalScore according to verified content characteristics.
 * (User Requirement 1: Dimensions/size are taken into account while provenance remains primary).
 */
async function probeCandidate(candidate) {
  if (!candidate || !candidate.url) return false;
  if (typeof candidate.status !== 'number') {
    candidate.status = 0;
  }

  // Trusted specialized Anime-Pictures original candidate:
  // Bypass network preflight (HEAD / Range GET) to avoid burning CDN rate limits.
  // Final validation (HTTP status, Content-Type image/*, non-empty body, allowlist)
  // is strictly deferred to fetchProtectedBlob() in the offscreen pipeline.
  if (isTrustedDeferredProtectedCandidate(candidate)) {
    candidate.deferredProtectedValidation = true;
    candidate.verified = false;
    candidate.finalScore = Math.max(candidate.finalScore, 95);
    return true;
  }

  let timeoutId = null;
  let getTimeoutId = null;

  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 3500);

    // DNR rules (1001, 1002, 1003) manage Referer/Cookie at network layer;
    // do not manually set Referer in JavaScript here.
    const probeHeaders = {};

    // First try a lightweight HEAD request without downloading the file body
    let res = await fetch(candidate.url, {
      method: 'HEAD',
      headers: probeHeaders,
      signal: controller.signal
    });
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // Some CDNs block HEAD (405 Method Not Allowed or 403 Forbidden) — request 1 byte via GET.
    // Zerochan's CDNs (s3./static.zerochan.net) answer HEAD with 503 text/html (592 bytes) while GET and
    // Range GET return the image (observed in Chrome, 2026-10-02): a 503 to HEAD is therefore not evidence about
    // the file. Only the bounded 1-byte GET below decides; its own status and Content-Type are authoritative.
    if (res.status === 405 || res.status === 403 || res.status === 503) {
      if (res.status !== 503 && isProtectedImageHost(candidate.url)) {
        // Protected booru host (e.g. Gelbooru) blocks hotlinked preflight HEAD/Range from SW context.
        // Retain protected offscreen flow: defer validation to FETCH_GELBOORU_BLOB in offscreen document.
        candidate.deferredProtectedValidation = true;
        candidate.verified = false;
        candidate.finalScore = Math.max(candidate.finalScore, 90);
        return true;
      }
      const getController = new AbortController();
      getTimeoutId = setTimeout(() => getController.abort(), 3500);
      try {
        res = await fetch(candidate.url, {
          method: 'GET',
          headers: { ...probeHeaders, 'Range': 'bytes=0-0' },
          signal: getController.signal
        });
      } finally {
        // Only the status and headers of this 1-byte probe are used. A server that ignores Range (HTTP 200) would
        // otherwise keep streaming the whole file after verification: end the probe request here, on every path
        // (success, rejection, error). The real download is a separate chrome.downloads request and is unaffected.
        getController.abort();
        if (getTimeoutId) {
          clearTimeout(getTimeoutId);
          getTimeoutId = null;
        }
      }
    }

    if (res && typeof res.status === 'number') {
      candidate.status = res.status;
      if (res.status === 429) candidate.rateLimited = true;
      if (res.status === 403 || res.status === 401) candidate.authRequired = true;
    }

    if (res.ok) {
      const rawContentType = res.headers.get('content-type') || '';
      const normalizedMime = rawContentType.split(';')[0].trim().toLowerCase();
      const cl = res.headers.get('content-length');
      let contentLength = cl ? (parseInt(cl, 10) || 0) : 0;
      if (res.status === 206) {
        // A 1-byte Range response reports Content-Length: 1; the real size is the Content-Range total.
        const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
        contentLength = total ? (parseInt(total[1], 10) || 0) : 0;
      }

      const isAmbiguousMime =
        normalizedMime === 'application/octet-stream' ||
        normalizedMime === 'binary/octet-stream' ||
        normalizedMime === '';

      // Conservative MIME + URL validation policy:
      // 1. Explicit non-image MIME types (text/*, video/*, audio/*, json, xml, js) are rejected for images.
      // 2. Explicit image/* MIME types are accepted.
      // 3. Ambiguous MIME (octet-stream or empty) is accepted ONLY if URL pathname has a supported image extension.
      // 4. Empty Content-Type strictly requires positive Content-Length.
      // 5. Trusted Booru video candidates: accept ONLY verified video/mp4 and video/webm MIME types.
      //    Never accept ambiguous MIME (octet-stream/empty) based only on URL extension.
      let isAcceptable = false;
      if (!isExplicitNonImageMime(normalizedMime)) {
        if (normalizedMime.startsWith('image/')) {
          isAcceptable = true;
        } else if (isAmbiguousMime && hasImageExtensionInPath(candidate.url)) {
          if (normalizedMime === '') {
            isAcceptable = contentLength > 0;
          } else {
            isAcceptable = (cl === null || contentLength > 0);
          }
        }
      } else if (candidate.allowVideo && candidate.isBooruCandidate && (normalizedMime === 'video/mp4' || normalizedMime === 'video/webm')) {
        isAcceptable = true;
      }

      if (isAcceptable) {
        candidate.verified = true;
        candidate.contentType = normalizedMime;
        candidate.contentLength = contentLength;
        candidate.mimeEvidence = MIME_EVIDENCE.HTTP_RESPONSE;
        candidate.verifiedUrl = candidate.url;

        // Post-verification size & dimension adjustments:
        // Size bonus (provenance remains primary: spread is +5 to +10 vs provenance spread of 50+)
        if (candidate.contentLength > 500 * 1024) {
          candidate.finalScore += 10;
        } else if (candidate.contentLength > 100 * 1024) {
          candidate.finalScore += 5;
        }

        // Known pixel dimensions bonus from metadata
        if (candidate.rawWidth >= 2000 || candidate.rawHeight >= 2000) {
          candidate.finalScore += 10;
        } else if (candidate.rawWidth >= 1000 || candidate.rawHeight >= 1000) {
          candidate.finalScore += 5;
        }

        // Penalty if verified size is confirmed tiny and candidate has thumbnail characteristics
        if (candidate.contentLength > 0 && candidate.contentLength < 25 * 1024 && isThumbnailUrl(candidate.url)) {
          candidate.finalScore -= 20;
        }

        return true;
      }
    }
  } catch (err) {
    if (err?.status) {
      candidate.status = err.status;
      if (err.status === 429) candidate.rateLimited = true;
      if (err.status === 403 || err.status === 401) candidate.authRequired = true;
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (getTimeoutId) {
      clearTimeout(getTimeoutId);
      getTimeoutId = null;
    }
  }

  candidate.verified = false;
  return false;
}

/**
 * Backwards-compatible network image availability verification.
 * Returns true if candidate exists (200 OK) and is an image.
 */
async function verifyImageUrl(candidateUrl) {
  const dummyCandidate = { url: candidateUrl, baseScore: 0, finalScore: 0 };
  return await probeCandidate(dummyCandidate);
}

// ============================================================================
// 3. LEVEL 1: Universal DOM / Link Resolution
// ============================================================================
/**
 * On many websites, the image is wrapped in a link to the full-size version:
 * <a href="ORIGINAL_IMAGE"><img src="PREVIEW_IMAGE"></a>
 * If linkUrl is available on right-click, verify whether it points to the original image.
 * Works universally across web pages.
 */
async function resolveFromLinkUrl(linkUrl, srcUrl) {
  if (!linkUrl || linkUrl === srcUrl) return null;

  try {
    const parsedLink = new URL(linkUrl);
    const pathname = parsedLink.pathname.toLowerCase();

    // Check if the link contains an image extension
    const hasImageExt = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(pathname);

    // Check for typical media file directories in the path
    const isDirectMediaLink = /\/(images?|original|data|_images|content|img\/view|uploads?|media|photos?|assets|pictures?)\//i.test(pathname) ||
      pathname.includes('file_only') ||
      parsedLink.hostname.includes('paheal-cdn.net');

    // Exclude MediaWiki page links (/wiki/File:...) and navigation pages without direct media files
    if (pathname.includes('/wiki/') || pathname.includes('/w/index.php') || /[:/](file|image|файл):/i.test(pathname)) {
      return null;
    }

    const isHtmlPagePattern = /\/(post|posts|comment|comments|user|users|tag|tags|upload|thread|threads|forum|article|blog|artworks?|illust)\//i.test(pathname) && !hasImageExt;
    if (isHtmlPagePattern && !isDirectMediaLink) {
      return null;
    }

    if (hasImageExt || isDirectMediaLink) {
      // Option 1: Cleaned of cache query parameters (?cache)
      const cleaned = new URL(linkUrl);
      cleaned.search = '';
      const cleanUrl = cleaned.toString();

      if (await verifyImageUrl(cleanUrl)) {
        console.log('[Image Saver] [Уровень 1: Link] Подтверждён URL из ссылки <a> (очищенный):', cleanUrl);
        return cleanUrl;
      }

      // Option 2: Original linkUrl (if query parameters were required for CDN authentication)
      if (linkUrl !== cleanUrl && await verifyImageUrl(linkUrl)) {
        console.log('[Image Saver] [Уровень 1: Link] Подтверждён исходный URL из ссылки <a>:', linkUrl);
        return linkUrl;
      }
    }
  } catch (e) {
    console.warn('[Image Saver] Ошибка проверки linkUrl:', e);
  }

  return null;
}

// ============================================================================
// 4. LEVEL 2: Dedicated Sites (X.com, Pixiv, Reddit)
// ============================================================================

/**
 * Resolve original image for X.com (Twitter).
 * On Twitter media CDN (pbs.twimg.com and *.twimg.com), transforms resized/thumbnail
 * parameters to original quality (?name=orig, _400x400, 1500x500) while preserving
 * the original format and file extension.
 * Never outputs legacy colon syntax (:orig) in the URL pathname.
 *
 * @param {string} url
 * @returns {string|null} Resolved original URL or null if not an X image or malformed.
 */
function resolveTwitterOriginalUrl(url) {
  try {
    if (!url || typeof url !== 'string') return null;
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'twimg.com' && !host.endsWith('.twimg.com')) {
      return null;
    }

    // 1. Resized media containers: Tweet media, Cards, Amplify, Community banners, Semantic core images
    const RESIZABLE_PATH_REGEX = /\/(media|card_img|amplify_img|community_banner_img|semantic_core_img)\//i;
    if (RESIZABLE_PATH_REGEX.test(parsed.pathname)) {
      // Strip legacy colon syntax from pathname (e.g. .jpg:small or .jpg:orig -> .jpg)
      if (/:([a-z0-9_]+)$/i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/:([a-z0-9_]+)$/i, '');
      }
      parsed.searchParams.set('name', 'orig');
      return parsed.toString();
    }

    // 2. User profile avatars (profile_images): replace _normal, _mini, _bigger, _200x200 with _400x400
    if (parsed.pathname.includes('/profile_images/')) {
      if (/_(normal|mini|bigger|200x200)\.(jpe?g|png|webp)$/i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/_(normal|mini|bigger|200x200)\.(jpe?g|png|webp)$/i, '_400x400.$2');
        return parsed.toString();
      }
      if (/_400x400\.(jpe?g|png|webp)$/i.test(parsed.pathname)) {
        return parsed.toString();
      }
    }

    // 3. Profile header banners: replace with 1500x500
    if (parsed.pathname.includes('/profile_banners/')) {
      if (/\/(web|mobile|600x200|300x100|web_retina)$/i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/\/(web|mobile|600x200|300x100|web_retina)$/i, '/1500x500');
        return parsed.toString();
      }
      if (/\/1500x500$/i.test(parsed.pathname)) {
        return parsed.toString();
      }
    }

    return null;
  } catch (err) {
    console.warn('[Image Saver] Ошибка при парсинге URL X.com:', err);
    return null;
  }
}

/**
 * Resolves candidate MP4 video URL from an X / Twitter tweet_video_thumb poster URL.
 * Deterministic and offline transform — performs zero network requests.
 *
 * Input: https://pbs.twimg.com/tweet_video_thumb/GZabc123.jpg
 * Output: https://video.twimg.com/tweet_video/GZabc123.mp4
 *
 * Strictly validates hostname (twimg.com, *.twimg.com) and rejects lookalike domains.
 */
function resolveTweetVideoThumbUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'twimg.com' && !host.endsWith('.twimg.com')) {
      return null;
    }
    let pathname = parsed.pathname;
    if (/:([a-z0-9_]+)$/i.test(pathname)) {
      pathname = pathname.replace(/:([a-z0-9_]+)$/i, '');
    }
    const match = pathname.match(/\/tweet_video_thumb\/([a-zA-Z0-9_-]+)/i);
    if (match && match[1]) {
      return `https://video.twimg.com/tweet_video/${match[1]}.mp4`;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Checks if a URL represents an X / Twitter ordinary video poster (amplify_video_thumb or ext_tw_video_thumb).
 * Distinct from tweet_video_thumb (which resolves deterministically to a tweet_video MP4).
 * Strictly validates hostname (twimg.com, *.twimg.com).
 */
function isXVideoPosterUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== 'twimg.com' && !host.endsWith('.twimg.com')) return false;
    return /\/(?:amplify_video_thumb|ext_tw_video_thumb)\//i.test(parsed.pathname);
  } catch (_) {
    return false;
  }
}

/**
 * Resolves an X tweet_video candidate from a poster/thumb URL and probes reachability.
 * If candidate MP4 is reachable (HTTP 200/206), promotes MP4 as primary media source.
 * If unavailable, falls back to the poster image.
 */
async function resolveTweetVideoFromThumb(thumbUrl) {
  const candidateUrl = resolveTweetVideoThumbUrl(thumbUrl);
  if (!candidateUrl) {
    return {
      targetUrl: thumbUrl,
      candidateUrl: null,
      type: 'image',
      mime: 'image/jpeg',
      verified: false,
      poster: thumbUrl,
      fallbackToPoster: true
    };
  }

  const probe = await probeVideoUrlDetails(candidateUrl);
  if (probe.ok) {
    return {
      targetUrl: candidateUrl,
      candidateUrl,
      type: 'x_tweet_video',
      mime: probe.contentType || 'video/mp4',
      verified: true,
      poster: thumbUrl,
      fallbackToPoster: false
    };
  }

  return {
    targetUrl: thumbUrl,
    candidateUrl,
    type: 'image',
    mime: 'image/jpeg',
    verified: false,
    poster: thumbUrl,
    fallbackToPoster: true,
    error: probe.error || 'UNAVAILABLE'
  };
}

const resolveTwitterVideoThumb = resolveTweetVideoFromThumb;
const resolveTwitterVideoThumbUrl = resolveTweetVideoThumbUrl;

/**
 * Resolve original image for Pixiv (www.pixiv.net, i.pximg.net)
 */
async function resolvePixivUrl(urlObj, pageUrl, linkUrl) {
  const candidates = [];
  const pathname = urlObj.pathname;
  const host = urlObj.hostname.toLowerCase();

  const isPixivCdn = host.includes('pximg.net');
  const isPixivPage = host.includes('pixiv.net') || (pageUrl && pageUrl.includes('pixiv.net')) || (linkUrl && linkUrl.includes('pixiv.net'));
  if (!isPixivCdn && !isPixivPage) return [];

  // Search for illustration ID and page number:
  // 1) In CDN filename: /12345678_p0_master1200.jpg or /12345678_p0.jpg
  let illustId = null;
  let pageIndex = 0;

  const cdnMatch = pathname.match(/(\d+)_p(\d+)/);
  if (cdnMatch) {
    illustId = cdnMatch[1];
    pageIndex = parseInt(cdnMatch[2], 10);
  }

  // 2) If ID is not found in CDN path, look in linkUrl (e.g. click/hover on thumbnail), pageUrl, or the URL itself:
  // Supports /artworks/{id}, /illust/{id}, illust_id={id}
  if (!illustId) {
    const artworkRegex = /(?:artworks|illust(?:_id)?)[/=](\d+)/i;
    const linkMatch = linkUrl ? linkUrl.match(artworkRegex) : null;
    const pageMatch = pageUrl ? pageUrl.match(artworkRegex) : null;
    const pathMatch = pathname.match(artworkRegex);
    const idMatch = linkMatch || pageMatch || pathMatch;
    if (idMatch) {
      illustId = idMatch[1];
    }
  }

  // 1. Deterministic path transformation for i.pximg.net CDN:
  // /c/600x1200_90/img-master/img/.../12345678_p0_master1200.jpg -> /img-original/img/.../12345678_p0.jpg
  // /c/250x250_80_a2/custom-thumb/img/.../12345678_p0_square1200.jpg -> /img-original/img/.../12345678_p0.jpg
  if (isPixivCdn && (pathname.includes('/img-master/') || pathname.includes('/custom-thumb/'))) {
    let cleanPath = pathname
      .replace(/\/c\/[^/]+\/(?:img-master|custom-thumb)\//, '/img-original/')
      .replace(/\/img-master\//, '/img-original/')
      .replace(/_(master|square|custom)\d+/g, '');

    const dotIdx = cleanPath.lastIndexOf('.');
    const basePath = dotIdx !== -1 ? cleanPath.substring(0, dotIdx) : cleanPath;
    const currentExt = dotIdx !== -1 ? cleanPath.substring(dotIdx).toLowerCase() : '.jpg';

    // Original may be jpg, png, or gif
    candidates.push(...generateExtensionCandidates(urlObj, basePath, currentExt));
  }

  // 2. Query public Pixiv Ajax API (returns exact links to original pages)
  if (illustId) {
    try {
      const apiUrl = `https://www.pixiv.net/ajax/illust/${illustId}/pages`;
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(apiUrl, {
        signal: ctrl.signal,
        credentials: 'include'
      });
      clearTimeout(tid);

      if (res.ok) {
        const data = await res.json();
        if (data && !data.error) {
          if (Array.isArray(data.body) && data.body.length > 0) {
            const pageData = data.body[pageIndex] || data.body[0];
            if (pageData?.urls?.original) {
              candidates.unshift(pageData.urls.original);
            }
          } else if (data.body?.urls?.original) {
            candidates.unshift(data.body.urls.original);
          }
        }
      }
    } catch (e) {}
  }

  return candidates;
}

/**
 * Strict Reddit domain validator.
 * Accepts reddit.com, redd.it, and all their legitimate subdomains.
 * Strictly rejects foreign domains and lookalikes (e.g., fake-reddit.com, reddit.com.attacker.com).
 */
function isRedditDomain(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase();
  return h === 'reddit.com' || h.endsWith('.reddit.com') ||
         h === 'redd.it' || h.endsWith('.redd.it');
}

/**
 * Is this media address itself served by Reddit? The refusal explanation about a Reddit session belongs to Reddit-hosted media only:
 * the page that embeds the media (a RedGIFs player on reddit.com) and substrings of a foreign address do not make it Reddit's.
 */
function isRedditHostedMediaUrl(url) {
  try {
    return isRedditDomain(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

/**
 * Deterministic validator for Reddit animated GIFs delivered as MP4.
 * Scoped strictly to Reddit preview/media domains with .gif and format=mp4.
 */
function isRedditAnimationUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url, 'https://reddit.com/');
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (!isRedditDomain(host)) return false;
    if (!pathname.includes('.gif')) return false;
    const format = (parsed.searchParams.get('format') || '').toLowerCase().trim();
    return format === 'mp4' || format === 'video/mp4';
  } catch (_) {
    return false;
  }
}

/**
 * Resolve original image for Reddit
 * - preview.redd.it/<id>.<ext>?... -> i.redd.it/<id>.<ext> (with extension variations .jpg, .jpeg, .png, .webp, .gif)
 * - external-preview.redd.it/... -> i.redd.it/...
 * - i.redd.it/...(?width=...) -> i.redd.it/... (without compression parameters)
 * - packaged-media.redd.it/... -> without compression parameters
 * - reddit.com/media?url=... -> unpack nested URL
 */
function resolveRedditUrl(urlObj, pageUrl) {
  const candidates = [];
  try {
    const parsed = typeof urlObj === 'string' ? new URL(urlObj) : urlObj;
    const host = parsed.hostname.toLowerCase();

    // If URL is in the format reddit.com/media?url=...
    if (parsed.pathname === '/media' && parsed.searchParams.has('url')) {
      const nestedUrl = parsed.searchParams.get('url');
      try {
        const parsedNested = new URL(nestedUrl);
        if (parsedNested.protocol === 'https:' || parsedNested.protocol === 'http:') {
          return resolveRedditUrl(parsedNested, pageUrl);
        }
      } catch (e) {}
      return [];
    }

    if (host === 'preview.redd.it' || host === 'external-preview.redd.it') {
      const pathname = parsed.pathname;
      const lastSlash = pathname.lastIndexOf('/');
      const filename = lastSlash !== -1 ? pathname.substring(lastSlash + 1) : pathname;
      const dotIdx = filename.lastIndexOf('.');
      const rawId = dotIdx !== -1 ? filename.substring(0, dotIdx) : filename;
      const pathExt = dotIdx !== -1 ? filename.substring(dotIdx).toLowerCase() : '';

      // Extract clean media ID from SEO slug format [slug]-v0-[media_id] or [slug]-[media_id]
      const vMatch = rawId.match(/-v\d+-([a-zA-Z0-9]+)$/i) || rawId.match(/-([a-zA-Z0-9]{8,36})$/i);
      const cleanId = vMatch ? vMatch[1] : rawId;

      // Check ?format= parameter (pjpg -> .jpg, png -> .png, etc.)
      const formatParam = parsed.searchParams.get('format');
      let primaryExt = pathExt;
      if (formatParam) {
        const fmt = formatParam.toLowerCase();
        if (fmt === 'pjpg' || fmt === 'jpg') primaryExt = '.jpg';
        else if (fmt === 'png') primaryExt = '.png';
        else primaryExt = `.${fmt}`;
      }

      // Build prioritized list of extensions to verify on i.redd.it
      const prioritizedExts = [];
      if (primaryExt) prioritizedExts.push(primaryExt);
      if (primaryExt === '.jpg') prioritizedExts.push('.jpeg');
      if (primaryExt === '.jpeg') prioritizedExts.push('.jpg');
      for (const e of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
        if (!prioritizedExts.includes(e)) prioritizedExts.push(e);
      }

      // 1. Priority candidates with clean media ID
      for (const ext of prioritizedExts) {
        candidates.push(`https://i.redd.it/${cleanId}${ext}`);
      }

      // 2. Fallback candidates with rawId (if name contained hyphens but was not an SEO slug)
      if (cleanId !== rawId) {
        for (const ext of prioritizedExts) {
          candidates.push(`https://i.redd.it/${rawId}${ext}`);
        }
      }
    } else if (host === 'i.redd.it') {
      const orig = new URL(parsed.toString());
      orig.search = '';
      candidates.push(orig.toString());
    } else if (host === 'packaged-media.redd.it') {
      // Packaged-media uses cryptographic signatures (?m=...&s=...&e=...).
      // Preserving search parameters is required to prevent HTTP 403 Forbidden.
      candidates.push(parsed.toString());
    }
  } catch (e) {}
  return candidates;
}

/**
 * Resolve original file for Wikimedia projects (Wikimedia Commons, Wikipedia, etc.)
 * - .../thumb/e/ec/File.jpg/500px-File.jpg -> .../e/ec/File.jpg
 * - .../thumb/1/1b/File.svg/20px-File.svg.png -> .../1/1b/File.svg
 * - upload.wikimedia.org/... -> original without parameters
 */
function resolveWikimediaUrl(urlObj) {
  const candidates = [];
  try {
    const host = urlObj.hostname.toLowerCase();
    const pathname = urlObj.pathname;

    const thumbMatch = pathname.match(/^(\/.*)\/thumb\/(.*)\/[^/]+$/);
    if (thumbMatch) {
      const prefix = thumbMatch[1];
      const origRelPath = thumbMatch[2];
      const orig = new URL(urlObj.toString());
      orig.hostname = 'upload.wikimedia.org';
      orig.pathname = `${prefix}/${origRelPath}`;
      orig.search = '';
      candidates.push(orig.toString());
    } else if (host === 'upload.wikimedia.org') {
      const orig = new URL(urlObj.toString());
      orig.search = '';
      candidates.push(orig.toString());
    }
  } catch (e) {}
  return candidates;
}

/**
 * Recursively decodes a percent-encoded URL string (handles single and multi-level percent-encoding)
 */
function decodeUrlRecursively(str) {
  if (!str || typeof str !== 'string') return str;
  let curr = str.trim();
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(curr);
      if (next === curr) break;
      curr = next;
    } catch (e) {
      break;
    }
  }
  return curr;
}

/**
 * Extracts and decodes the image URL from a Yandex Images linkUrl query parameter 'img_url'
 */
function extractYandexImgUrl(linkUrl, baseUrl) {
  if (!linkUrl || typeof linkUrl !== 'string') return null;
  let raw = null;
  try {
    const u = new URL(linkUrl, baseUrl || 'https://yandex.ru');
    raw = u.searchParams.get('img_url');
  } catch (e) {}

  if (!raw) {
    const m = linkUrl.match(/[?&]img_url=([^&]+)/i);
    if (m) {
      raw = m[1];
    }
  }

  if (!raw) return null;
  return decodeUrlRecursively(raw);
}

/**
 * Helper to extract Tenor 11-char media ID and slug from any Tenor media URL.
 * Handles:
 * - media.tenor.com/<ID><SUFFIX>/<slug>.<ext>
 * - media1.tenor.com/m/<ID><SUFFIX>/<slug>.<ext>
 * - c.tenor.com/<ID><SUFFIX>/<slug>.<ext>
 */
function extractTenorMedia(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    const isTenorCdn = host === 'media.tenor.com' || host === 'c.tenor.com' || /^media\d*\.tenor\.com$/.test(host);
    if (!isTenorCdn) return null;
    const match = parsed.pathname.match(/(?:\/m)?\/([A-Za-z0-9_-]{11})[A-Za-z0-9_]*\/([^/]+)\.[a-z0-9]+$/i);
    if (match) {
      return { id: match[1], slug: match[2] };
    }
  } catch (e) {}
  return null;
}

/**
 * Resolve full original GIF for Tenor:
 * Transforms thumbnail/preview suffixes (AAAAM, AAAAd, AAAA1, etc.) to AAAAC (original full GIF).
 */
async function resolveTenorUrl(urlObj, pageUrl, linkUrl) {
  const candidates = [];
  const tenorInfo = extractTenorMedia(urlObj ? urlObj.toString() : null) ||
                    extractTenorMedia(linkUrl) ||
                    extractTenorMedia(pageUrl);

  if (tenorInfo) {
    const originalGif = `https://media.tenor.com/${tenorInfo.id}AAAAC/${tenorInfo.slug}.gif`;
    const mirrorGif = `https://c.tenor.com/${tenorInfo.id}AAAAC/${tenorInfo.slug}.gif`;
    const largeGif = `https://media.tenor.com/${tenorInfo.id}AAAAd/${tenorInfo.slug}.gif`;

    // Verify original candidate via verifyImageUrl()
    if (await verifyImageUrl(originalGif)) {
      candidates.push(originalGif);
    } else if (await verifyImageUrl(mirrorGif)) {
      candidates.push(mirrorGif);
    } else if (await verifyImageUrl(largeGif)) {
      candidates.push(largeGif);
    }
  }

  return candidates;
}

/**
 * Helper to extract GIPHY media ID from CDN URLs, page URLs, or short links.
 * Handles:
 * - media.giphy.com/media/<ID>/...
 * - media1..media4.giphy.com/media/v1.Y2lkPT.../<ID>/...
 * - i.giphy.com/<ID>.gif or i.giphy.com/media/<ID>/giphy.gif
 * - giphy.com/gifs/<slug>-<ID> or giphy.com/gifs/<ID>
 * - giphy.com/clips/<slug>-<ID> or giphy.com/clips/<ID>
 */
function extractGiphyId(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    const p = parsed.pathname;

    const isGiphyHost = host === 'giphy.com' || host === 'i.giphy.com' || host === 'media.giphy.com' || /^media\d*\.giphy\.com$/.test(host);
    if (!isGiphyHost) return null;

    // 1. media CDN URLs: .../<ID>/filename.ext
    const mediaMatch = p.match(/(?:\/media)?(?:\/v\d+\.[^/]+)?\/([a-zA-Z0-9]+)\/[^/]+\.[a-z0-9]+$/i);
    if (mediaMatch) return mediaMatch[1];

    // 2. i.giphy.com/<ID>.gif or /<ID>.webp
    const iMatch = p.match(/^\/([a-zA-Z0-9]+)\.[a-z0-9]+$/i);
    if (iMatch) return iMatch[1];

    // 3. giphy.com/gifs/<slug>-<ID> or /clips/<slug>-<ID> or /gifs/<ID> or /clips/<ID>
    const pageMatch = p.match(/\/(?:gifs?|clips)\/(?:.*-)?([a-zA-Z0-9]+)\/?$/i);
    if (pageMatch) return pageMatch[1];
  } catch (e) {}
  return null;
}

/**
 * Resolve full original GIF for GIPHY:
 * Generates:
 * 1. https://media.giphy.com/media/<ID>/giphy.gif
 * 2. fallback: https://i.giphy.com/<ID>.gif
 * Verifies each candidate via verifyImageUrl()
 */
async function resolveGiphyUrl(urlObj, pageUrl, linkUrl) {
  const candidates = [];
  const giphyId = extractGiphyId(urlObj ? urlObj.toString() : null) ||
                  extractGiphyId(linkUrl) ||
                  extractGiphyId(pageUrl);

  if (giphyId) {
    const originalGif = `https://media.giphy.com/media/${giphyId}/giphy.gif`;
    const fallbackGif = `https://i.giphy.com/${giphyId}.gif`;

    if (await verifyImageUrl(originalGif)) {
      candidates.push(originalGif);
    } else if (await verifyImageUrl(fallbackGif)) {
      candidates.push(fallbackGif);
    }
  }

  return candidates;
}

/**
 * Resolve full original image for Yande.re:
 * 1. Extracts MD5 from preview/sample path or URL.
 * 2. Extracts Post ID from linkUrl, pageUrl, or path.
 * 3. Queries official Yande.re API (https://yande.re/post.json?tags=id:<id> or tags=md5:<md5>)
 *    to retrieve authoritative file_url (and jpeg_url).
 * 4. Sample path transformation (/sample/ -> /image/ with stripped 'sample' token).
 * 5. Deterministic direct CDN candidates: https://files.yande.re/image/<md5>.<ext>
 * Verifies candidates via verifyImageUrl().
 */
async function resolveYandereUrl(urlObj, pageUrl, linkUrl) {
  const candidates = [];
  if (!urlObj) return candidates;

  const urlStr = urlObj.toString();
  const pathname = urlObj.pathname;

  // 1. Extract MD5 hash (32 hex characters)
  let md5 = null;
  const md5Match = pathname.match(/([a-f0-9]{32})/i) || urlStr.match(/([a-f0-9]{32})/i);
  if (md5Match) {
    md5 = md5Match[1].toLowerCase();
  }

  // 2. Extract Post ID from linkUrl, pageUrl, or pathname
  let postId = null;
  const postMatch =
    (linkUrl && linkUrl.match(/(?:post\/show\/|posts\/|\/p)(\d+)/i)) ||
    (pageUrl && pageUrl.match(/(?:post\/show\/|posts\/|\/p)(\d+)/i)) ||
    pathname.match(/(?:post\/show\/|posts\/|\/p)(\d+)/i) ||
    pathname.match(/yande\.re(?:%20|[ _-])(\d+)/i);
  if (postMatch) {
    postId = postMatch[1];
  }

  // 3. Query official Yande.re API endpoint (on main web domain, NOT assets CDN)
  const apiQueries = [];
  if (postId) {
    apiQueries.push(`https://yande.re/post.json?tags=id:${postId}`);
  }
  if (md5) {
    apiQueries.push(`https://yande.re/post.json?tags=md5:${md5}`);
  }

  for (const apiUrl of apiQueries) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3500);
      const res = await fetch(apiUrl, { signal: ctrl.signal });
      clearTimeout(tid);

      if (res.ok) {
        const posts = await res.json();
        if (Array.isArray(posts) && posts[0]) {
          const p = posts[0];
          if (p.file_url && !candidates.includes(p.file_url)) {
            if (await verifyImageUrl(p.file_url)) {
              candidates.push(p.file_url);
            }
          }
          if (p.jpeg_url && p.jpeg_url !== p.file_url && !candidates.includes(p.jpeg_url)) {
            if (await verifyImageUrl(p.jpeg_url)) {
              candidates.push(p.jpeg_url);
            }
          }
          if (candidates.length > 0) {
            break;
          }
        }
      }
    } catch (_) {}
  }

  // 4. Sample path transformation: /sample/<md5>/yande.re%20<id>%20sample%20<tags>.jpg -> /image/...
  if (pathname.includes('/sample/')) {
    let origPath = pathname.replace('/sample/', '/image/');
    origPath = origPath
      .replace(/%20sample%20/gi, '%20')
      .replace(/[ _-]sample[ _-]/gi, ' ')
      .replace(/%20sample/gi, '')
      .replace(/sample%20/gi, '')
      .replace(/\s+/g, ' ');

    const dotIdx = origPath.lastIndexOf('.');
    const basePath = dotIdx !== -1 ? origPath.substring(0, dotIdx) : origPath;
    const ext = dotIdx !== -1 ? origPath.substring(dotIdx) : '.jpg';

    const origin = 'https://files.yande.re';
    const sampleOrigCandidates = [
      `${origin}${basePath}${ext}`,
      `${origin}${basePath}.png`,
      `${origin}${basePath}.jpg`,
      `${origin}${basePath}.jpeg`
    ];

    for (const cand of sampleOrigCandidates) {
      if (!candidates.includes(cand) && await verifyImageUrl(cand)) {
        candidates.push(cand);
      }
    }
  }

  // 5. Deterministic direct CDN candidates: https://files.yande.re/image/<md5>.<ext>
  if (md5) {
    const directCandidates = [
      `https://files.yande.re/image/${md5}.png`,
      `https://files.yande.re/image/${md5}.jpg`,
      `https://files.yande.re/image/${md5}.jpeg`
    ];
    for (const cand of directCandidates) {
      if (!candidates.includes(cand) && await verifyImageUrl(cand)) {
        candidates.push(cand);
      }
    }
  }

  return candidates;
}

/**
 * Resolve full original image for e-shuushuu.net:
 * 1. If already a /fullsize/ path on cdn.e-shuushuu.net, verify and return.
 * 2. Extract Image ID:
 *    - from linkUrl (e.g. /images/1119530)
 *    - from pageUrl (e.g. /images/1119530)
 *    - from urlObj pathname (e.g. /thumbs/2026-09-23-1119530.webp or /images/1119530)
 * 3. Query official e-shuushuu API: https://e-shuushuu.net/api/v1/images/<id>
 *    Returns JSON with `url` (e.g. https://cdn.e-shuushuu.net/fullsize/2026-09-23-1119530.jpg).
 * 4. Deterministic path transformation for CDN previews:
 *    /thumbs/YYYY-MM-DD-<id>.webp or /medium/YYYY-MM-DD-<id>.jpg
 *    -> /fullsize/YYYY-MM-DD-<id>.<ext> (.jpg, .png, .jpeg, .webp)
 * 5. Verify candidates via verifyImageUrl().
 */
async function resolveEshuushuuUrl(urlObj, pageUrl, linkUrl) {
  const candidates = [];
  if (!urlObj) return candidates;

  const urlStr = urlObj.toString();
  const pathname = urlObj.pathname;

  // 1. If URL is already a fullsize original
  if (pathname.includes('/fullsize/') && !pathname.includes('/thumbs/')) {
    if (await verifyImageUrl(urlStr)) {
      candidates.push(urlStr);
    }
  }

  // 2. Extract Image ID (digits)
  let imageId = null;
  const idMatch =
    (linkUrl && linkUrl.match(/\/images\/(\d+)/i)) ||
    (pageUrl && pageUrl.match(/\/images\/(\d+)/i)) ||
    pathname.match(/\/images\/(\d+)/i) ||
    pathname.match(/\/(?:thumbs|medium|fullsize)\/\d{4}-\d{2}-\d{2}-(\d+)/i) ||
    pathname.match(/-(\d{5,8})\.[a-z0-9]+$/i);

  if (idMatch) {
    imageId = idMatch[1];
  }

  // 3. Query official e-shuushuu JSON API endpoint
  if (imageId) {
    try {
      const apiUrl = `https://e-shuushuu.net/api/v1/images/${imageId}`;
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3500);
      const res = await fetch(apiUrl, { signal: ctrl.signal });
      clearTimeout(tid);

      if (res.ok) {
        const data = await res.json();
        if (data && data.url) {
          if (!candidates.includes(data.url) && await verifyImageUrl(data.url)) {
            candidates.push(data.url);
          }
        }
        if (data && data.medium_url && candidates.length === 0) {
          if (!candidates.includes(data.medium_url) && await verifyImageUrl(data.medium_url)) {
            candidates.push(data.medium_url);
          }
        }
      }
    } catch (_) {}
  }

  // 4. Deterministic path transformation for CDN previews:
  if (pathname.includes('/thumbs/') || pathname.includes('/medium/')) {
    const fullsizeBasePath = pathname
      .replace(/\/(thumbs|medium)\//i, '/fullsize/')
      .replace(/\.[a-z0-9]+$/i, '');

    const origin = 'https://cdn.e-shuushuu.net';
    const extensions = ['.jpg', '.png', '.jpeg', '.webp'];

    for (const ext of extensions) {
      const cand = `${origin}${fullsizeBasePath}${ext}`;
      if (!candidates.includes(cand) && await verifyImageUrl(cand)) {
        candidates.push(cand);
      }
    }
  }

  return candidates;
}

const KNOWN_SITE_RESOLVERS = [
  {
    name: 'TwitterEngine',
    match: (urlObj) => {
      const host = urlObj.hostname.toLowerCase();
      return host === 'twimg.com' || host.endsWith('.twimg.com');
    },
    resolve: (urlObj) => {
      const orig = resolveTwitterOriginalUrl(urlObj.toString());
      return orig ? [orig] : [];
    }
  },
  {
    name: 'PixivEngine',
    match: (urlObj, pageUrl, linkUrl) => {
      const host = urlObj.hostname.toLowerCase();
      const isPixivCdn = host.includes('pximg.net');
      const isPixivPage = host.includes('pixiv.net') || (pageUrl && pageUrl.includes('pixiv.net'));
      const isPixivLink = Boolean(linkUrl && (linkUrl.includes('pixiv.net') || linkUrl.includes('pximg.net')));
      return isPixivCdn || isPixivPage || isPixivLink;
    },
    resolve: (urlObj, pageUrl, linkUrl) => resolvePixivUrl(urlObj, pageUrl, linkUrl)
  },
  {
    name: 'RedditEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      const pageHost = pageUrl ? (function() { try { return new URL(pageUrl).hostname.toLowerCase(); } catch (e) { return ''; } })() : '';
      return isRedditDomain(host) || isRedditDomain(pageHost);
    },
    resolve: (urlObj, pageUrl) => resolveRedditUrl(urlObj, pageUrl)
  },
  {
    name: 'WikimediaEngine',
    match: (urlObj) => {
      const host = urlObj.hostname.toLowerCase();
      const isWikiHost = (h) => h.endsWith('wikimedia.org') || h.endsWith('wikipedia.org') || h.endsWith('wiktionary.org') || h.endsWith('wikibooks.org') || h.endsWith('wikidata.org') || h.endsWith('wikinews.org') || h.endsWith('wikiquote.org') || h.endsWith('wikisource.org') || h.endsWith('wikiversity.org') || h.endsWith('wikivoyage.org');
      return isWikiHost(host);
    },
    resolve: (urlObj) => resolveWikimediaUrl(urlObj)
  },
  {
    name: 'GoogleImagesEngine',
    match: (urlObj, pageUrl, linkUrl) => {
      // Only activate on Google Images search pages (tbm=isch or udm=2).
      // Must not fire on google.com Maps, Fonts, Analytics, or other Google products.
      const isGstaticThumb = urlObj.hostname.toLowerCase().includes('gstatic.com') &&
        urlObj.pathname.toLowerCase().includes('/images') &&
        urlObj.search.toLowerCase().includes('q=tbn:');
      if (isGstaticThumb) {
        // Verify the page URL is a Google Images search result page
        if (!pageUrl) return false;
        try {
          const p = new URL(pageUrl);
          const h = p.hostname.toLowerCase();
          if (!h.includes('google.')) return false;
          const tbm = p.searchParams.get('tbm');
          const udm = p.searchParams.get('udm');
          return tbm === 'isch' || udm === '2';
        } catch (e) { return false; }
      }
      // Also activate when the clicked URL itself has imgurl (e.g. /imgres?imgurl=...)
      if (urlObj.searchParams.has('imgurl')) {
        return urlObj.hostname.toLowerCase().includes('google.');
      }
      return false;
    },
    resolve: (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const rawImgUrl = urlObj.searchParams.get('imgurl') ||
        (linkUrl ? (function() { try { return new URL(linkUrl).searchParams.get('imgurl'); } catch (e) { return null; } })() : null);
      if (rawImgUrl) {
        try { candidates.push(decodeURIComponent(rawImgUrl)); } catch (e) { candidates.push(rawImgUrl); }
      }
      return candidates;
    }
  },
  {
    name: 'YandexImagesEngine',
    match: (urlObj, pageUrl, linkUrl) => {
      const host = urlObj ? urlObj.hostname.toLowerCase() : '';
      const pageHost = pageUrl ? (function() { try { return new URL(pageUrl).hostname.toLowerCase(); } catch (e) { return ''; } })() : '';
      const linkHost = linkUrl ? (function() { try { return new URL(linkUrl, pageUrl || 'https://yandex.ru').hostname.toLowerCase(); } catch (e) { return ''; } })() : '';
      const hasImgUrl = linkUrl ? /[?&]img_url=/i.test(linkUrl) : false;
      return host.includes('yandex.') || host.includes('ya.ru') ||
             pageHost.includes('yandex.') || pageHost.includes('ya.ru') ||
             linkHost.includes('yandex.') || linkHost.includes('ya.ru') ||
             hasImgUrl;
    },
    resolve: (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const decodedFromLink = extractYandexImgUrl(linkUrl, pageUrl);
      if (decodedFromLink) {
        candidates.push(decodedFromLink);
      }
      const rawFromObj = urlObj && urlObj.searchParams && urlObj.searchParams.get('img_url');
      if (rawFromObj) {
        const decodedFromObj = decodeUrlRecursively(rawFromObj);
        if (decodedFromObj && !candidates.includes(decodedFromObj)) {
          candidates.push(decodedFromObj);
        }
      }
      return candidates;
    }
  },
  {
    name: 'AnimePicturesEngine',
    match: (urlObj, pageUrl, linkUrl) => {
      // Require the clicked image URL or the link URL to originate from the
      // anime-pictures.net CDN or site domain. pageUrl alone is not sufficient
      // to activate this resolver — that would break relationship scoping by
      // treating any foreign image on an anime-pictures.net page as a candidate.
      const host = urlObj.hostname.toLowerCase();
      if (host.includes('anime-pictures.net')) return true;
      if (linkUrl) {
        try {
          if (new URL(linkUrl).hostname.toLowerCase().includes('anime-pictures.net')) return true;
        } catch (e) {}
      }
      return false;
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;

      // 1. Direct CDN preview path normalization:
      // e.g. /previews/4a6/1500x3187-4a6c8e310086cfd74653603d76e4c7ba_cp.avif
      // or /4a6/1500x3187-4a6c8e310086cfd74653603d76e4c7ba_cp.avif
      const md5Match = pathname.match(/([a-f0-9]{32})/i);
      if (md5Match) {
        const md5 = md5Match[1].toLowerCase();
        const dirMatch = pathname.match(/\/([a-f0-9]{3})\//i);
        const dir = dirMatch ? dirMatch[1].toLowerCase() : md5.substring(0, 3);
        const origin = 'https://oimages.anime-pictures.net';

        // Original artwork uploads on Anime-Pictures CDN are .jpg (.jpeg) or .png
        for (const ext of ['.jpg', '.png', '.jpeg']) {
          candidates.push(`${origin}/${dir}/${md5}${ext}`);
        }
      }

      // 2. Post ID link or pageUrl resolution (canonical direct download endpoint):
      const postMatch = (linkUrl && linkUrl.match(/(?:posts|view_post)(?:\/|[?&](?:show|post_id)=)(\d+)/i)) ||
                        (pageUrl && pageUrl.match(/(?:posts|view_post)(?:\/|[?&](?:show|post_id)=)(\d+)/i)) ||
                        pathname.match(/(?:posts|view_post)(?:\/|[?&](?:show|post_id)=)(\d+)/i);
      if (postMatch) {
        const postId = postMatch[1];
        candidates.push(`https://anime-pictures.net/pictures/get_image/${postId}`);
      }

      // Edge case: if pathname has no 32-char MD5 hash (e.g. non-hash _sp.avif) and no postId
      // is present in linkUrl or pageUrl, safe deterministic resolution to original artwork is impossible.
      // We deliberately do NOT perform speculative CDN transforms or resurrect dead images.anime-pictures.net;
      // the pipeline safely falls back to initial_src without error.
      return candidates;
    },
    resolveGroups: async (urlObj, pageUrl, linkUrl) => {
      const groups = [];
      const pathname = urlObj.pathname;

      const hasDirectGetImageLink = Boolean(linkUrl && linkUrl.includes('/pictures/get_image/'));

      // 1. Original Candidate Group with 3 variants (.jpg, .png, .jpeg)
      const md5Match = pathname.match(/([a-f0-9]{32})/i);
      if (md5Match) {
        const md5 = md5Match[1].toLowerCase();
        const dirMatch = pathname.match(/\/([a-f0-9]{3})\//i);
        const dir = dirMatch ? dirMatch[1].toLowerCase() : md5.substring(0, 3);
        const origGroup = createAnimePicturesOriginalGroup(dir, md5);
        if (origGroup) {
          groups.push(origGroup);
        }
      }

      // 2. Separate Fallback Group for post ID canonical download endpoint
      const postMatch = (linkUrl && linkUrl.match(/(?:posts|view_post)(?:\/|[?&](?:show|post_id)=)(\d+)/i)) ||
                        (pageUrl && pageUrl.match(/(?:posts|view_post)(?:\/|[?&](?:show|post_id)=)(\d+)/i)) ||
                        pathname.match(/(?:posts|view_post)(?:\/|[?&](?:show|post_id)=)(\d+)/i);
      if (postMatch) {
        const postId = postMatch[1];
        groups.push(createCandidateGroup({
          id: `anime_pictures_get_image_${postId}`,
          source: 'specialized_provider',
          provider: 'anime-pictures',
          tier: hasDirectGetImageLink ? 'original' : 'fallback',
          score: hasDirectGetImageLink ? 96 : 60,
          validationMode: 'probe',
          transport: 'direct',
          variants: [{ url: `https://anime-pictures.net/pictures/get_image/${postId}`, expectedExtension: '' }]
        }));
      }

      return groups;
    }
  },
  {
    name: 'ZerochanEngine',
    match: (urlObj, pageUrl, linkUrl) => {
      const isZerochanHost = (h) => h === 'zerochan.net' || h.endsWith('.zerochan.net');
      const host = urlObj ? urlObj.hostname.toLowerCase() : '';
      if (isZerochanHost(host)) return true;
      if (linkUrl) {
        try {
          if (isZerochanHost(new URL(linkUrl, pageUrl || 'https://www.zerochan.net').hostname.toLowerCase())) return true;
        } catch (_) {}
      }
      return false;
    },
    resolve: async function(urlObj, pageUrl, linkUrl) {
      const groups = await this.resolveGroups(urlObj, pageUrl, linkUrl);
      return Array.isArray(groups) ? groups.flatMap(g => g.variants.map(v => v.url)) : [];
    },
    resolveGroups: async (urlObj, pageUrl, linkUrl) => {
      const targetUrl = urlObj ? urlObj.toString() : '';
      const parsedTarget = parseZerochanMediaUrl(targetUrl);
      const parsedLink = linkUrl ? parseZerochanMediaUrl(linkUrl) : null;

      let postId = (parsedTarget && parsedTarget.id) || (parsedLink && parsedLink.id) || null;
      let name = (parsedTarget && parsedTarget.name) || (parsedLink && parsedLink.name) || null;

      // If postId is still not found, inspect pageUrl if it's a dedicated post page (e.g. zerochan.net/4728645)
      if (!postId && pageUrl) {
        try {
          const parsedPage = parseZerochanMediaUrl(pageUrl);
          if (parsedPage && parsedPage.id) {
            postId = parsedPage.id;
            if (!name && parsedPage.name) name = parsedPage.name;
          }
        } catch (_) {}
      }

      if (!postId) return [];

      let authoritativeFullUrl = (parsedTarget && parsedTarget.isFull) ? targetUrl : null;
      const apiMetadata = {};

      // Query authoritative JSON API with a bounded 3000ms timeout
      let timeoutId = null;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`https://www.zerochan.net/${postId}?json`, {
          signal: controller.signal
        });
        if (res.ok) {
          const data = await res.json();
          // Authoritative post ID ownership verification
          if (data && String(data.id) === String(postId)) {
            if (data.full && typeof data.full === 'string' && data.full.includes('.full.')) {
              authoritativeFullUrl = data.full;
              const parsedFull = parseZerochanMediaUrl(data.full);
              if (parsedFull && parsedFull.name) {
                name = parsedFull.name;
              }
            }
            if (typeof data.width === 'number') apiMetadata.rawWidth = data.width;
            if (typeof data.height === 'number') apiMetadata.rawHeight = data.height;
            if (typeof data.size === 'number') apiMetadata.fileSize = data.size;
            if (data.hash) apiMetadata.md5 = data.hash;
          }
        }
      } catch (_) {
        // Bounded timeout or network error: fall back to deterministic candidate variants
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      }

      const group = createZerochanOriginalGroup(postId, name, authoritativeFullUrl, apiMetadata);
      return group ? [group] : [];
    }
  },
  {
    name: 'TenorImagesEngine',
    match: (urlObj, pageUrl, linkUrl) => {
      const host = urlObj ? urlObj.hostname.toLowerCase() : '';
      // 1. Tenor CDN domains: media.tenor.com, media1.tenor.com, c.tenor.com, etc.
      if (host === 'media.tenor.com' || host === 'c.tenor.com' || /^media\d*\.tenor\.com$/.test(host)) {
        return true;
      }
      // 2. Direct Tenor view page URL as resolver target
      if (host === 'tenor.com' && urlObj.pathname.includes('/view/')) {
        return true;
      }
      // 3. Foreign CDN URLs must NOT match, even if on tenor.com or inside a link to tenor.com
      return false;
    },
    resolve: (urlObj, pageUrl, linkUrl) => resolveTenorUrl(urlObj, pageUrl, linkUrl)
  },
  {
    name: 'GiphyImagesEngine',
    match: (urlObj, pageUrl, linkUrl) => {
      const host = urlObj ? urlObj.hostname.toLowerCase() : '';
      // 1. GIPHY CDN domains: media.giphy.com, media0..4.giphy.com, i.giphy.com
      if (host === 'media.giphy.com' || host === 'i.giphy.com' || /^media\d*\.giphy\.com$/.test(host)) {
        return true;
      }
      // 2. Direct GIPHY view page URL or clip page URL as resolver target
      if (host === 'giphy.com' && (urlObj.pathname.includes('/gifs/') || urlObj.pathname.includes('/clips/') || urlObj.pathname.includes('/gif/'))) {
        return true;
      }
      // 3. Foreign CDN URLs must NOT match, even if on giphy.com or inside a link to giphy.com
      return false;
    },
    resolve: (urlObj, pageUrl, linkUrl) => resolveGiphyUrl(urlObj, pageUrl, linkUrl)
  },
  {
    name: 'YandereImagesEngine',
    match: (urlObj, pageUrl, linkUrl) => {
      const host = urlObj ? urlObj.hostname.toLowerCase() : '';
      const isYandereHost = (h) => h === 'yande.re' || h.endsWith('.yande.re');

      // 1. Target URL itself must belong to Yande.re domain ecosystem
      if (isYandereHost(host)) {
        return true;
      }
      // 2. Foreign CDN URLs must NOT match, even on yande.re
      return false;
    },
    resolve: (urlObj, pageUrl, linkUrl) => resolveYandereUrl(urlObj, pageUrl, linkUrl)
  },
  {
    name: 'EShuushuuImagesEngine',
    match: (urlObj, pageUrl, linkUrl) => {
      const host = urlObj ? urlObj.hostname.toLowerCase() : '';
      const isEshuuHost = (h) => h === 'e-shuushuu.net' || h.endsWith('.e-shuushuu.net');

      // 1. Target URL itself must belong to e-shuushuu domain ecosystem
      if (isEshuuHost(host)) {
        return true;
      }
      // 2. Foreign CDN URLs must NOT match, even on e-shuushuu.net
      return false;
    },
    resolve: (urlObj, pageUrl, linkUrl) => resolveEshuushuuUrl(urlObj, pageUrl, linkUrl)
  }
];

// ============================================================================
// 5. LEVEL 3: Booru Engine Type Resolvers (Engine Resolvers)
// ============================================================================

/**
 * Helper to construct rich candidate descriptors for resolvers.
 * Provides backward-compatible string-like methods (.includes, .startsWith, .endsWith, .toString)
 * so existing tests inspecting candidates as strings continue to pass unchanged.
 */
function createCandidateDescriptor(url, opts = {}) {
  const isBooru = opts.isBooruCandidate !== undefined ? opts.isBooruCandidate : true;
  return {
    url,
    score: typeof opts.score === 'number' ? opts.score : 85,
    tier: opts.tier || 'legacy',
    allowVideo: Boolean(opts.allowVideo),
    isBooruCandidate: Boolean(isBooru),
    toString() { return this.url; },
    includes(sub, pos) { return this.url.includes(sub, pos); },
    startsWith(sub, pos) { return this.url.startsWith(sub, pos); },
    endsWith(sub, pos) { return this.url.endsWith(sub, pos); }
  };
}

/**
 * Pure root domain matcher: checks if hostname equals root or ends with .root
 */
function isSameOrSubdomain(hostname, rootDomain) {
  if (!hostname || typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase();
  const root = rootDomain.toLowerCase();
  return h === root || h.endsWith('.' + root);
}

/**
 * Strict Danbooru domain validator.
 */
function isDanbooruDomain(hostname) {
  return isSameOrSubdomain(hostname, 'donmai.us');
}

const DANBOORU_DOM_ALLOWED_EXTS = Object.freeze(new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'webm', 'mp4']));

/**
 * Extracts normalized hostname from a URL string safely.
 */
function getUrlHostname(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * Extracts a 32-character hexadecimal MD5 hash from a URL string if present.
 */
function extractMd5FromUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const match = urlStr.match(/\b([a-f0-9]{32})\b/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Validates DOM metadata collected from a Danbooru-family page.
 * Enforces:
 * 1. Protocol: http or https only.
 * 2. Hostname: *.donmai.us or donmai.us (e.g. cdn.donmai.us).
 * 3. Extension: whitelisted image/video extensions only.
 * 4. MD5 consistency: if clicked URL contains an MD5 hash, meta.md5 must match it.
 */
function isValidDanbooruMetadata(meta, clickedUrl) {
  if (!meta || typeof meta !== 'object') return false;
  const originalUrl = meta.originalUrl;
  if (!originalUrl || typeof originalUrl !== 'string') return false;

  let parsed;
  try {
    parsed = new URL(originalUrl);
  } catch (_) {
    return false;
  }

  // 1. Protocol validation: http/https only
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // 2. Domain validation: *.donmai.us
  const host = parsed.hostname.toLowerCase();
  if (!isDanbooruDomain(host)) {
    return false;
  }

  // 3. Extension validation
  let ext = (meta.fileExt || '').toLowerCase().trim();
  if (!ext) {
    const dotIdx = parsed.pathname.lastIndexOf('.');
    if (dotIdx !== -1) {
      ext = parsed.pathname.substring(dotIdx + 1).toLowerCase();
    }
  }
  if (!DANBOORU_DOM_ALLOWED_EXTS.has(ext)) {
    return false;
  }

  // 4. Positive asset identity correlation: require positive evidence linking meta to clickedUrl
  if (clickedUrl) {
    const clickedMd5 = extractMd5FromUrl(clickedUrl);
    const origMd5 = extractMd5FromUrl(parsed.pathname);
    const metaMd5 = meta.md5 ? String(meta.md5).toLowerCase().trim() : null;

    if (clickedMd5) {
      // Conflicting evidence check: neither meta.md5 nor originalUrl may conflict with clickedMd5
      if (metaMd5 && metaMd5 !== clickedMd5) {
        return false;
      }
      if (origMd5 && origMd5 !== clickedMd5) {
        return false;
      }
      // Positive evidence check: at least one source (meta.md5 or originalUrl) must match clickedMd5
      const hasPositiveMd5 = (metaMd5 === clickedMd5) || (origMd5 === clickedMd5);
      if (!hasPositiveMd5) {
        return false;
      }
    } else {
      // Clicked URL did not contain an MD5; check post ID if available
      const postMatch = clickedUrl.match(/\/posts\/(\d+)/i);
      if (postMatch && postMatch[1]) {
        const clickedPostId = postMatch[1];
        if (!meta.postId || String(meta.postId) !== clickedPostId) {
          return false;
        }
      } else {
        // Neither MD5 nor post ID available from clickedUrl: cannot establish positive identity correlation
        return false;
      }
    }

    // Additional post ID check if both present
    if (meta.postId) {
      const postMatch = clickedUrl.match(/\/posts\/(\d+)/i);
      if (postMatch && postMatch[1] && String(meta.postId) !== postMatch[1]) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Queries content_booru.js for ephemeral clicked element metadata.
 */
async function queryBooruDomMetadata(tabId, clickedUrl) {
  if (!tabId || typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return null;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 500);

    const onResult = (res) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (chrome.runtime?.lastError || !res || !res.success || !res.metadata) {
        resolve(null);
      } else {
        resolve(res.metadata);
      }
    };

    try {
      const p = chrome.tabs.sendMessage(tabId, { action: 'GET_BOORU_DOM_METADATA', clickedUrl }, onResult);
      if (p && typeof p.then === 'function') {
        p.then(onResult).catch(() => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(null);
          }
        });
      }
    } catch (_) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }
  });
}

/**
 * Strict Gelbooru domain validator covering all 12 existing supported booru boards.
 */
const GELBOORU_ROOT_DOMAINS = [
  'gelbooru.com',
  'rule34.xxx',
  'safebooru.org',
  'realbooru.com',
  'xbooru.com',
  'hypnohub.net',
  'tbib.org',
  'curveybooru.com',
  'inkbooru.com',
  'mspabooru.com',
  'scatbooru.com',
  'yakui.ru'
];

function isGelbooruDomain(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase();
  return GELBOORU_ROOT_DOMAINS.some(root => isSameOrSubdomain(h, root));
}

/**
 * Strict e621 domain validator.
 */
function isE621Domain(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  return isSameOrSubdomain(hostname, 'e621.net') ||
         isSameOrSubdomain(hostname, 'e926.net') ||
         isSameOrSubdomain(hostname, 'e6ai.net');
}

/**
 * Validates asset URLs returned by e621 API queries.
 * Enforces:
 * 1. Protocol: http or https only.
 * 2. Hostname: e621.net, e926.net, e6ai.net or legitimate subdomains (e.g. static1.e621.net).
 * 3. MD5 consistency: if URL pathname contains an MD5 hash, it must match the expected MD5.
 */
function isValidE621AssetUrl(fileUrl, expectedMd5) {
  if (!fileUrl || typeof fileUrl !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(fileUrl);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (!isE621Domain(parsed.hostname)) return false;

  if (expectedMd5) {
    const urlMd5 = extractMd5FromUrl(parsed.pathname);
    if (urlMd5 && urlMd5.toLowerCase() !== expectedMd5.toLowerCase()) {
      return false;
    }
  }
  return true;
}

/**
 * Helper function to generate candidate URLs with different file extensions
 * Prevents blind extension replacement and verifies actual formats on the server.
 */
function generateExtensionCandidates(urlObj, basePath, currentExt, options = {}) {
  const includeVideo = Boolean(options && options.includeVideo);
  let extensions;
  const ext = (currentExt || '').toLowerCase();

  if (ext === '.mp4' || ext === '.webm') {
    extensions = [ext, ext === '.mp4' ? '.webm' : '.mp4', '.jpeg', '.jpg', '.png'];
  } else if (ext === '.jpg' || ext === '.jpeg') {
    extensions = ['.jpeg', '.jpg', '.png', '.gif', '.webp'];
    if (includeVideo) extensions.push('.mp4', '.webm');
  } else if (ext === '.png') {
    extensions = ['.png', '.jpeg', '.jpg', '.gif', '.webp'];
    if (includeVideo) extensions.push('.mp4', '.webm');
  } else {
    extensions = [ext, '.jpeg', '.jpg', '.png', '.gif', '.webp'];
    if (includeVideo) extensions.push('.mp4', '.webm');
  }

  extensions = Array.from(new Set(extensions.filter(Boolean)));

  const results = [];
  for (const itemExt of extensions) {
    const cand = new URL(urlObj.toString());
    cand.pathname = `${basePath}${itemExt}`;
    cand.search = ''; // Strip cache query parameters
    results.push(cand.toString());
  }
  return results;
}

const BOORU_ENGINE_RESOLVERS = [
  // --------------------------------------------------------------------------
  // 5.1 Danbooru & Danbooru-based (Danbooru, Safebooru.donmai.us, BleachBooru, Booruvar, etc.)
  // --------------------------------------------------------------------------
  {
    name: 'DanbooruEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      return isDanbooruDomain(host);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;

      // If URL already points to /original/
      if (pathname.includes('/original/') && !pathname.includes('sample-') && !pathname.includes('sample_')) {
        const isVid = pathname.endsWith('.mp4') || pathname.endsWith('.webm');
        candidates.push(createCandidateDescriptor(urlObj.toString(), {
          score: 90,
          tier: 'original',
          allowVideo: isVid
        }));
      }

      // 1. MD5 lookup via official Danbooru API
      const md5Match = urlObj.toString().match(/\b([a-f0-9]{32})\b/i);
      let apiKnownExt = null;
      if (md5Match) {
        const md5 = md5Match[1].toLowerCase();
        try {
          let apiDomain = 'https://danbooru.donmai.us';
          if (pageUrl) {
            try {
              const parsedPage = new URL(pageUrl);
              if (parsedPage.hostname.toLowerCase() === 'safebooru.donmai.us') {
                apiDomain = 'https://safebooru.donmai.us';
              }
            } catch (_) {}
          }
          const apiUrl = `${apiDomain}/posts.json?tags=md5:${md5}`;
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 3500);
          const res = await fetch(apiUrl, { signal: ctrl.signal });
          clearTimeout(tid);

          if (res.ok) {
            const posts = await res.json();
            if (Array.isArray(posts) && posts[0]) {
              const p = posts[0];
              apiKnownExt = (p.file_ext || '').toLowerCase();
              const isVid = apiKnownExt === 'mp4' || apiKnownExt === 'webm';

              if (p.file_url) {
                candidates.push(createCandidateDescriptor(p.file_url, {
                  score: 90,
                  tier: 'original',
                  allowVideo: isVid
                }));
              }
              const origVariant = p.media_asset?.variants?.find(v => v.type === 'original');
              if (origVariant?.url) {
                candidates.push(createCandidateDescriptor(origVariant.url, {
                  score: 90,
                  tier: 'original',
                  allowVideo: isVid
                }));
              }
              if (p.large_file_url) {
                candidates.push(createCandidateDescriptor(p.large_file_url, {
                  score: 85,
                  tier: 'original',
                  allowVideo: isVid
                }));
              }
            }
          }
        } catch (e) {}
      }

      // 2. Deterministic Danbooru CDN path transformation:
      // /data/sample/sample-[md5].jpg -> /data/original/[md5].[ext]
      if (pathname.includes('/sample') || pathname.includes('/preview') || pathname.includes('/180x180') || pathname.includes('/360x360')) {
        let origPath = pathname.replace(/\/(sample|\d+x\d+|preview)\//g, '/original/');
        origPath = origPath.replace(/sample[-_]/g, '');

        const dotIdx = origPath.lastIndexOf('.');
        const basePath = dotIdx !== -1 ? origPath.substring(0, dotIdx) : origPath;
        const ext = dotIdx !== -1 ? origPath.substring(dotIdx) : '.jpg';

        const extCands = generateExtensionCandidates(urlObj, basePath, ext, { includeVideo: true });
        for (const c of extCands) {
          const isVid = c.endsWith('.mp4') || c.endsWith('.webm');
          candidates.push(createCandidateDescriptor(c, {
            score: 80,
            tier: 'legacy',
            allowVideo: isVid
          }));
        }
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.2 Gelbooru & Gelbooru-based (Gelbooru, Rule34, Safebooru.org, Realbooru, Xbooru, HypnoHub, CurveyBooru, TBIB, etc.)
  // --------------------------------------------------------------------------
  {
    name: 'GelbooruEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      return isGelbooruDomain(host);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;
      const urlStr = urlObj.toString();

      // Extract expected MD5 from clicked preview if present
      const clickedMd5Match = urlStr.match(/\b([a-f0-9]{32})\b/i);
      const expectedMd5 = clickedMd5Match ? clickedMd5Match[1].toLowerCase() : null;

      // 1. Post view link resolution (index.php?page=post&s=view&id=... or /post&s=view&id=...)
      // Strict pre-fetch validation: candidate must be on a verified Gelbooru domain with http(s)
      const postCandidates = [linkUrl, urlStr, pageUrl].filter(u => {
        if (!u || typeof u !== 'string') return false;
        try {
          const parsed = new URL(u);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
          if (!isGelbooruDomain(parsed.hostname)) return false;
          return (/(?:page=post|post)&s=view&id=\d+/i.test(parsed.search) || /[?&]id=\d+/i.test(parsed.search));
        } catch (_) {
          return false;
        }
      });

      const postUrlCandidate = postCandidates[0] || null;

      if (postUrlCandidate) {
        try {
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 3500);
          // Reject redirects outside trusted host by using redirect: 'error'
          const res = await fetch(postUrlCandidate, { signal: ctrl.signal, redirect: 'error' });
          clearTimeout(tid);
          if (res.ok) {
            const html = await res.text();

            // A. Video player element extraction (<video id="gelcomVideoPlayer"> or <source>)
            const videoMatch = html.match(/<video[^>]+id=["']gelcomVideoPlayer["'][^>]*\bsrc=["']([^"']+)["']/i) ||
                               html.match(/<video[^>]*\bsrc=["']([^"']+)["'][^>]*id=["']gelcomVideoPlayer["']/i) ||
                               html.match(/<video[^>]*id=["']gelcomVideoPlayer["'][^>]*>[\s\S]*?<source[^>]*\bsrc=["']([^"']+)["']/i);

            // B. Original image anchor
            const origMatch = html.match(/<a[^>]+href=["']([^"']+\/images\/[^"']+)["'][^>]*>(?:Original\s+(?:image|video)|View\s+larger)<\/a>/i) ||
                              html.match(/<li[^>]*><a[^>]+href=["']([^"']+\/images\/[^"']+)["'][^>]*>Original image<\/a>/i);

            const rawFound = (videoMatch && (videoMatch[1] || videoMatch[2])) || (origMatch && origMatch[1]);
            if (rawFound) {
              try {
                const parsedFound = new URL(rawFound.replace('//images/', '/images/'), postUrlCandidate);
                // Security check 1: verified Gelbooru domain & http(s)
                if (isGelbooruDomain(parsedFound.hostname) && (parsedFound.protocol === 'https:' || parsedFound.protocol === 'http:')) {
                  // Security check 2: media path must be under /images/
                  if (/\/images\//i.test(parsedFound.pathname)) {
                    // Security check 3: bind scraped media to clicked post MD5 if known
                    const foundMd5Match = parsedFound.pathname.match(/\b([a-f0-9]{32})\b/i);
                    const foundMd5 = foundMd5Match ? foundMd5Match[1].toLowerCase() : null;
                    if (!expectedMd5 || !foundMd5 || expectedMd5 === foundMd5) {
                      const isVid = parsedFound.pathname.endsWith('.mp4') || parsedFound.pathname.endsWith('.webm');
                      candidates.push(createCandidateDescriptor(parsedFound.toString(), {
                        score: 90,
                        tier: 'original',
                        allowVideo: isVid
                      }));
                    }
                  }
                }
              } catch (_) {}
            }
          }
        } catch (e) {}
      }

      // 2. Deterministic path transformation:
      // /samples/<dir>/sample_<filename>.jpg?<cache> -> /images/<dir>/<filename>.<original_extension>
      // /thumbnails/<dir>/thumbnail_<filename>.jpg -> /images/<dir>/<filename>.<original_extension>
      if (/\/+(samples?|thumbnails?)\/+/i.test(pathname)) {
        const imagesPath = pathname.replace(/\/+(samples?|thumbnails?)\/+/i, '/images/').replace(/\/\/+/g, '/');

        const lastSlash = imagesPath.lastIndexOf('/');
        const dir = imagesPath.substring(0, lastSlash + 1);
        let filename = imagesPath.substring(lastSlash + 1);

        // Remove sample_ and thumbnail_ prefixes
        filename = filename.replace(/^(sample[-_]|thumbnail[-_]|thumb[-_])/i, '');

        const dotIndex = filename.lastIndexOf('.');
        const baseName = dotIndex !== -1 ? filename.substring(0, dotIndex) : filename;
        const currentExt = dotIndex !== -1 ? filename.substring(dotIndex).toLowerCase() : '.jpg';

        // 2a. Speculative video-cdn candidates if on img*.gelbooru.com (MP4 and WebM)
        if (urlObj.hostname.startsWith('img') && urlObj.hostname.endsWith('.gelbooru.com')) {
          const videoCand = new URL(urlObj.toString());
          videoCand.hostname = urlObj.hostname.replace(/^img/, 'video-cdn');
          videoCand.pathname = `${dir}${baseName}.mp4`;
          videoCand.search = '';
          candidates.push(createCandidateDescriptor(videoCand.toString(), {
            score: 80,
            tier: 'legacy',
            allowVideo: true
          }));

          const webmCand = new URL(urlObj.toString());
          webmCand.hostname = urlObj.hostname.replace(/^img/, 'video-cdn');
          webmCand.pathname = `${dir}${baseName}.webm`;
          webmCand.search = '';
          candidates.push(createCandidateDescriptor(webmCand.toString(), {
            score: 80,
            tier: 'legacy',
            allowVideo: true
          }));
        }

        // 2b. Standard extension candidates on current host
        const extCands = generateExtensionCandidates(urlObj, `${dir}${baseName}`, currentExt, { includeVideo: true });
        for (const c of extCands) {
          const isVid = c.endsWith('.mp4') || c.endsWith('.webm');
          candidates.push(createCandidateDescriptor(c, {
            score: 80,
            tier: 'legacy',
            allowVideo: isVid
          }));
        }
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.3 Moebooru (Konachan, Konachan Safe, Yande.re, Sakugabooru, Genboard)
  // --------------------------------------------------------------------------
  {
    name: 'MoebooruEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      const moebooruRoots = ['konachan.com', 'konachan.net', 'yande.re', 'sakugabooru.com'];
      return moebooruRoots.some(r => isSameOrSubdomain(host, r));
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;
      const host = urlObj.hostname.toLowerCase();
      const pageHost = pageUrl ? (function() { try { return new URL(pageUrl).hostname.toLowerCase(); } catch (e) { return ''; } })() : '';

      // 1. Sample transformation: /sample/<hash>/<title> sample <tags>.jpg -> /image/<hash>/<title> <tags>.<ext>
      if (pathname.includes('/sample/')) {
        let origPath = pathname.replace('/sample/', '/image/');
        origPath = origPath
          .replace(/%20sample%20/gi, '%20')
          .replace(/[ _-]sample[ _-]/gi, ' ')
          .replace(/%20sample/gi, '')
          .replace(/sample%20/gi, '')
          .replace(/\s+/g, ' ');

        const dotIdx = origPath.lastIndexOf('.');
        const basePath = dotIdx !== -1 ? origPath.substring(0, dotIdx) : origPath;
        const ext = dotIdx !== -1 ? origPath.substring(dotIdx) : '.jpg';

        const extCands = generateExtensionCandidates(urlObj, basePath, ext, { includeVideo: true });
        for (const c of extCands) {
          const isVid = c.endsWith('.mp4') || c.endsWith('.webm');
          candidates.push(createCandidateDescriptor(c, {
            score: 80,
            tier: 'legacy',
            allowVideo: isVid
          }));
        }
      }

      // 2. Thumbnail from /data/preview/<hash>.jpg via Moebooru API and deterministic fallback
      if (pathname.includes('/preview/')) {
        const md5Match = pathname.match(/([a-f0-9]{32})/i);
        if (md5Match) {
          const md5 = md5Match[1].toLowerCase();
          try {
            let apiDomain = urlObj.origin;
            if (host.endsWith('konachan.com') || pageHost.endsWith('konachan.com')) {
              apiDomain = 'https://konachan.com';
            } else if (host.endsWith('konachan.net') || pageHost.endsWith('konachan.net')) {
              apiDomain = 'https://konachan.net';
            } else if (host.endsWith('sakugabooru.com') || pageHost.endsWith('sakugabooru.com')) {
              apiDomain = 'https://sakugabooru.com';
            } else if (host === 'yande.re' || host.endsWith('.yande.re') || pageHost === 'yande.re' || pageHost.endsWith('.yande.re')) {
              apiDomain = 'https://yande.re';
            }
            const apiUrl = `${apiDomain}/post.json?tags=md5:${md5}`;
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 3500);
            const res = await fetch(apiUrl, { signal: ctrl.signal });
            clearTimeout(tid);

            if (res.ok) {
              const posts = await res.json();
              if (Array.isArray(posts) && posts[0]?.file_url) {
                const fileUrl = posts[0].file_url;
                const fileExt = (posts[0].file_ext || '').toLowerCase();
                const isVid = fileExt === 'mp4' || fileExt === 'webm' ||
                              fileUrl.endsWith('.mp4') || fileUrl.endsWith('.webm') ||
                              /\.(mp4|webm)($|\?)/i.test(fileUrl);
                candidates.unshift(createCandidateDescriptor(fileUrl, {
                  score: 90,
                  tier: 'original',
                  allowVideo: isVid
                }));
              }
            }
          } catch (e) {}

          // Deterministic fallback candidates for Moebooru preview
          const extCands = generateExtensionCandidates(urlObj, `/data/${md5}`, '.mp4', { includeVideo: true });
          for (const c of extCands) {
            const isVid = c.endsWith('.mp4') || c.endsWith('.webm');
            candidates.push(createCandidateDescriptor(c, {
              score: 80,
              tier: 'legacy',
              allowVideo: isVid
            }));
          }
        }
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.4 Philomena (Derpibooru, Furbooru, Manebooru, Ponerpics, Ponybooru, Twibooru)
  // --------------------------------------------------------------------------
  {
    name: 'PhilomenaEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      const pageHost = pageUrl ? (function() { try { return new URL(pageUrl).hostname.toLowerCase(); } catch (e) { return ''; } })() : '';
      const philomenaPattern = /derpibooru|furbooru|manebooru|ponerpics|ponybooru|twibooru|derpicdn/i;
      return philomenaPattern.test(host) || philomenaPattern.test(pageHost);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const urlStr = urlObj.toString();

      const cdnMatch = urlStr.match(/\/img\/(?:view\/)?(\d{4}\/\d{1,2}\/\d{1,2})\/(\d+)/i);
      const postMatch = urlStr.match(/\b(\d{6,8})\b/) || (pageUrl && pageUrl.match(/\b(\d{6,8})\b/));
      const imageId = postMatch ? postMatch[1] : null;

      if (cdnMatch) {
        const datePath = cdnMatch[1];
        const id = cdnMatch[2];
        const basePath = `/img/view/${datePath}/${id}`;

        const candJpg = new URL(urlObj.toString());
        candJpg.pathname = `${basePath}.jpg`;
        candJpg.search = '';
        candidates.push(candJpg.toString());

        const candPng = new URL(urlObj.toString());
        candPng.pathname = `${basePath}.png`;
        candPng.search = '';
        candidates.push(candPng.toString());

        const candWebp = new URL(urlObj.toString());
        candWebp.pathname = `${basePath}.webp`;
        candWebp.search = '';
        candidates.push(candWebp.toString());
      }

      if (imageId) {
        try {
          const apiHost = urlObj.hostname.includes('derpicdn.net') ? 'https://derpibooru.org' : urlObj.origin;
          const apiUrl = `${apiHost}/api/v1/json/images/${imageId}`;
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 3500);
          const res = await fetch(apiUrl, { signal: ctrl.signal });
          clearTimeout(tid);

          if (res.ok) {
            const data = await res.json();
            if (data.image?.representations?.full) {
              candidates.unshift(data.image.representations.full);
            } else if (data.image?.view_url) {
              candidates.push(data.image.view_url);
            }
          }
        } catch (e) {}
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.5 e621 / e926 / e6AI
  // --------------------------------------------------------------------------
  {
    name: 'E621Engine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      return isE621Domain(host);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;

      // 1. Direct original media URL recognition
      const origMatch = pathname.match(/\/data\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{32})\.(webm|mp4|png|jpe?g|gif)/i);
      if (origMatch && !pathname.includes('/sample/') && !pathname.includes('/preview/')) {
        const ext = origMatch[4].toLowerCase();
        const isVid = ext === 'webm' || ext === 'mp4';
        candidates.push(createCandidateDescriptor(urlObj.toString(), {
          score: 90,
          tier: 'original',
          allowVideo: isVid
        }));
      }

      // 2. Sample/preview recovery with API resolution and deterministic CDN candidates
      const e6Match = pathname.match(/\/data\/(?:sample|preview)\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{32})/i);
      if (e6Match) {
        const p1 = e6Match[1];
        const p2 = e6Match[2];
        const md5 = e6Match[3].toLowerCase();

        // 2a. Official e621 / e926 API lookup
        try {
          let apiDomain = 'https://e621.net';
          if (pageUrl) {
            try {
              const pHost = new URL(pageUrl).hostname.toLowerCase();
              if (isSameOrSubdomain(pHost, 'e926.net')) apiDomain = 'https://e926.net';
              else if (isSameOrSubdomain(pHost, 'e6ai.net')) apiDomain = 'https://e6ai.net';
            } catch (_) {}
          }
          const apiUrl = `${apiDomain}/posts.json?tags=md5:${md5}`;
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 3500);
          const res = await fetch(apiUrl, { signal: ctrl.signal });
          clearTimeout(tid);

          if (res.ok) {
            const data = await res.json();
            const posts = Array.isArray(data) ? data : (data.posts || data.post);
            if (Array.isArray(posts) && posts[0]) {
              const p = posts[0];
              const fileObj = p.file || {};
              const fileUrl = fileObj.url || p.file_url;
              const respMd5 = (fileObj.md5 || p.md5 || '').toLowerCase();
              let urlMd5 = '';
              try {
                if (fileUrl) {
                  urlMd5 = (extractMd5FromUrl(new URL(fileUrl).pathname) || '').toLowerCase();
                }
              } catch (_) {}

              // Positive identity evidence: at least one MD5 source must equal the requested md5
              const hasPositiveEvidence = (respMd5 === md5) || (urlMd5 === md5);
              // Conflicting evidence: neither source may conflict with requested md5
              const hasConflict = (respMd5 && respMd5 !== md5) || (urlMd5 && urlMd5 !== md5);

              // Post ID correlation if on a post page: require returned post ID to be present AND equal to page ID
              let postIdMismatch = false;
              if (pageUrl) {
                const pagePostMatch = pageUrl.match(/\/posts\/(\d+)/i);
                if (pagePostMatch && pagePostMatch[1]) {
                  const expectedPostId = pagePostMatch[1];
                  const returnedId = (p.id !== undefined && p.id !== null) ? String(p.id) : '';
                  if (!returnedId || returnedId !== expectedPostId) {
                    postIdMismatch = true;
                  }
                }
              }

              if (fileUrl && hasPositiveEvidence && !hasConflict && !postIdMismatch && isValidE621AssetUrl(fileUrl, md5)) {
                const fileExt = (fileObj.ext || p.file_ext || '').toLowerCase();
                const isVid = fileExt === 'webm' || fileExt === 'mp4' ||
                              (/\.(webm|mp4)($|\?)/i.test(fileUrl));

                // Preserve fileUrl byte-for-byte including signed query parameters
                candidates.unshift(createCandidateDescriptor(fileUrl, {
                  score: 90,
                  tier: 'original',
                  allowVideo: isVid
                }));
              } else if (fileUrl) {
                console.warn('[Image Saver] Отклонен недоверенный или несовпадающий URL медиа e621 API:', sanitizeUrlForLog(fileUrl));
              }
            }
          }
        } catch (_) {}

        // 2b. Deterministic CDN candidates (fallback / offline)
        const basePath = `/data/${p1}/${p2}/${md5}`;
        const extCands = generateExtensionCandidates(urlObj, basePath, '.png', { includeVideo: true });
        for (const c of extCands) {
          const isVid = c.endsWith('.mp4') || c.endsWith('.webm');
          candidates.push(createCandidateDescriptor(c, {
            score: 80,
            tier: 'legacy',
            allowVideo: isVid
          }));
        }
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.6 Shimmie & Shimmie 2 (Rule34 Paheal, Cavepaintings, Fanservice, etc.)
  // --------------------------------------------------------------------------
  {
    name: 'ShimmieEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      const pageHost = pageUrl ? (function() { try { return new URL(pageUrl).hostname.toLowerCase(); } catch (e) { return ''; } })() : '';
      const shimmiePattern = /paheal|shimmie|gikopoi|gyate|leftybooru|vinebooru|soybooru|ongezellig/i;
      return shimmiePattern.test(host) || shimmiePattern.test(pageHost) || /_thumbs\/|r34t\./i.test(urlObj.toString());
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const urlStr = urlObj.toString();
      const pathname = urlObj.pathname;

      if (urlObj.hostname.includes('r34t.paheal.net') || urlObj.hostname.includes('paheal')) {
        const pahealOrig = new URL(urlStr);
        pahealOrig.hostname = 'r34i.paheal-cdn.net';
        candidates.push(pahealOrig.toString());
      }

      if (pathname.includes('/_thumbs/') || pathname.includes('/thumbs/')) {
        const origPath = pathname.replace(/\/_thumbs\//, '/_images/').replace(/\/thumbs\//, '/images/');
        const dir = origPath.substring(0, origPath.lastIndexOf('/') + 1);

        const candJpg = new URL(urlObj.toString());
        candJpg.pathname = origPath;
        candidates.push(candJpg.toString());

        const hashMatch = pathname.match(/([a-f0-9]{32})/i);
        if (hashMatch) {
          candidates.push(...generateExtensionCandidates(urlObj, `${dir}${hashMatch[1]}`, '.jpg'));
        }
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.7 Szurubooru (Szurubooru, EquiBooru, Snootbooru)
  // --------------------------------------------------------------------------
  {
    name: 'SzurubooruEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      const pageHost = pageUrl ? (function() { try { return new URL(pageUrl).hostname.toLowerCase(); } catch (e) { return ''; } })() : '';
      return /szuru|equibooru|snootbooru/i.test(host) || /szuru|equibooru|snootbooru/i.test(pageHost) || /\/generated\/(thumbnail|preview)\//i.test(urlObj.pathname);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;

      const szuruMatch = pathname.match(/\/generated\/(?:thumbnail|preview)\/([a-f0-9]+)/i);
      if (szuruMatch) {
        const hash = szuruMatch[1];
        candidates.push(...generateExtensionCandidates(urlObj, `/generated/content/${hash}`, '.png'));
        candidates.push(...generateExtensionCandidates(urlObj, `/content/${hash}`, '.png'));
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.8 Piwigo
  // --------------------------------------------------------------------------
  {
    name: 'PiwigoEngine',
    match: (urlObj, pageUrl) => {
      return /_data\/i\/upload/i.test(urlObj.pathname) || /piwigo/i.test(urlObj.hostname);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;

      if (pathname.includes('/_data/i/upload/')) {
        let clean = pathname.replace('/_data/i/upload/', '/upload/');
        clean = clean.replace(/-(th|me|la|sq|xl|xx|2x)\.([a-z0-9]+)$/i, '.$2');

        const cand = new URL(urlObj.toString());
        cand.pathname = clean;
        cand.search = '';
        candidates.push(cand.toString());
      }

      return candidates;
    }
  }
];

// ============================================================================
// 6. LEVEL 4: DOM Metadata (srcset, data-*, og:image, JSON-LD)
// ============================================================================

/**
 * srcset parser: extracts URLs and size/density descriptors,
 * returning candidates sorted strictly in descending order of resolution.
 */
function parseSrcset(srcsetString, baseUrl) {
  if (!srcsetString || typeof srcsetString !== 'string') return [];

  const candidates = [];
  const entries = srcsetString.split(/,\s+/);

  for (const entry of entries) {
    const parts = entry.trim().split(/\s+/);
    if (!parts[0]) continue;
    const rawUrl = parts[0];
    const descriptor = parts[1] || '';

    let score = 1;
    if (/^\d+w$/i.test(descriptor)) {
      score = parseInt(descriptor, 10);
    } else if (/^\d+(\.\d+)?x$/i.test(descriptor)) {
      score = parseFloat(descriptor) * 1000;
    }

    try {
      const absUrl = new URL(rawUrl, baseUrl).toString();
      candidates.push({ url: absUrl, score });
    } catch (e) {}
  }

  // Sort in descending order of resolution
  candidates.sort((a, b) => b.score - a.score);
  return candidates.map(c => c.url);
}

/**
 * Function injected into the clicked frame (isolated world): the one media asset of the latest right-click gesture
 * when it was on a CSS background or under a simple overlay. content_context_target.js records it at the gesture
 * and `check()` re-proves the whole ownership now (same target, same media element, same asset, bounded hit test).
 * Local DOM reads only: no network, no messages. Returns null when anything is stale, changed or unclear.
 */
function readContextMediaTarget() {
  try {
    const cap = globalThis.__imageSaverContextTarget;
    const age = cap ? Date.now() - cap.at : Infinity;
    const media = cap && cap.media;
    if (!(age >= 0 && age < 30000) || !media || typeof media.check !== 'function' || !media.check()) return null;
    // A blob/MSE or not-yet-loaded player proven by check() is the selected player without an address: the caller decides whether a provider
    // frame may resolve it (resolveContextMediaTarget keeps the address-less answer apart from the http(s) ones)
    if (media.kind === 'player' && !media.url) return { url: '', kind: 'player', gestureAt: cap.at };
    const url = new URL(media.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { url: url.href, kind: String(media.kind || '') };
  } catch (e) {
    return null;
  }
}

/**
 * Function injected into the clicked frame (isolated world): is the owner of the latest right-click gesture still the
 * one the native menu claimed? A source or link URL handed over by Chrome is only a claim made at the gesture: the
 * node that gesture pressed must still be that same node (connected, same ancestors and owner attributes), still show
 * the claimed source, and for a media link still sit inside an anchor with that address. A removed, re-sourced,
 * reused or replaced node is 'refused'. A scrub-preview <video> (the thumbnail player inside <shreddit-preview-video-lazy> or
 * <shreddit-progress-bar>, found by its DOM role through shadow boundaries, never by its address) is never the selected media, pressed
 * itself or selected as the media under a pressed layer: 'preview', whatever source Chrome claims. 'unproven' = the capture script is not running in this frame (not injected), so
 * nothing contradicts the claim. A script that runs here but recorded no gesture in this document (null: the document was
 * navigated or reloaded after the right-click, or the gesture was not a real one) is not the document the menu was built for:
 * its claim is stale and is 'refused'. Local DOM reads only: no network, no messages.
 */
function verifyContextOwner(claim) {
  try {
    const cap = globalThis.__imageSaverContextTarget;
    if (cap === undefined) return 'unproven';
    if (!cap) return 'refused';
    const el = cap.ref && typeof cap.ref.deref === 'function' ? cap.ref.deref() : null;
    if (!el || el.isConnected === false || typeof cap.unchanged !== 'function' || !cap.unchanged(el)) return 'refused';
    const inPreviewHost = (node) => {
      for (let i = 0; node && i < 32; i++) {
        const tag = String(node.tagName || '').toUpperCase();
        if (tag === 'SHREDDIT-PREVIEW-VIDEO-LAZY' || tag === 'SHREDDIT-PROGRESS-BAR') return true;
        const root = !node.parentElement && typeof node.getRootNode === 'function' ? node.getRootNode() : null;
        node = node.parentElement || (root && root.host) || (node.host && typeof node.host === 'object' ? node.host : null);
      }
      return false;
    };
    if (el.tagName === 'VIDEO' && inPreviewHost(el)) return 'preview';
    // A pressed layer (overlay, CSS card) is only the gesture's pointer to the media it selected: the pressed node can
    // survive while the media under it is removed, replaced or re-sourced. The capture's own proof of that media
    // (same media node, same asset, still under the point) must still hold, or the layer selects nothing now.
    if (cap.media && (typeof cap.media.check !== 'function' || !cap.media.check())) return 'refused';
    const mediaEl = cap.media && cap.media.ref && typeof cap.media.ref.deref === 'function' ? cap.media.ref.deref() : null;
    if (mediaEl && mediaEl.tagName === 'VIDEO' && inPreviewHost(mediaEl)) return 'preview';
    const src = claim && typeof claim.src === 'string' ? claim.src : '';
    if (src && (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) {
      if (![el.currentSrc, el.src].includes(src)) return 'refused';
    }
    const link = claim && typeof claim.link === 'string' ? claim.link : '';
    if (link) {
      const a = typeof el.closest === 'function' ? el.closest('a') : null;
      if (!a || typeof a.href !== 'string' || new URL(a.href).href !== new URL(link).href) return 'refused';
    }
    return 'proven';
  } catch (e) {
    return 'refused';
  }
}

async function resolveContextOwner(tabId, frameId, claim) {
  if (!tabId) return 'unproven';
  try {
    const results = await chrome.scripting.executeScript({
      target: Number.isInteger(frameId) && frameId >= 0 ? { tabId, frameIds: [frameId] } : { tabId },
      func: verifyContextOwner,
      args: [claim]
    });
    const res = results && results[0] && results[0].result;
    return res === 'refused' || res === 'proven' || res === 'preview' ? res : 'unproven';
  } catch (e) {
    return 'unproven';
  }
}

async function resolveContextMediaTarget(tabId, frameId) {
  if (!tabId) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: Number.isInteger(frameId) && frameId >= 0 ? { tabId, frameIds: [frameId] } : { tabId },
      func: readContextMediaTarget
    });
    const res = results && results[0] && results[0].result;
    if (res && typeof res.url === 'string' && /^https?:\/\//i.test(res.url)) return res;
    // the document the capture was read in: the frame request for this player is pinned to it
    // and the gesture it proved (the capture's timestamp): the frame request is bound to that very selection
    if (res && res.kind === 'player' && res.url === '') return { url: '', kind: 'player', gestureAt: Number.isFinite(res.gestureAt) ? res.gestureAt : null, documentId: typeof results[0].documentId === 'string' ? results[0].documentId : '' };
  } catch (e) {}
  return null;
}

/**
 * Function injected into tab context to extract DOM metadata of clicked image
 */
function extractDomImageMetadata(clickedSrc) {
  try {
    const decodeUrlRecursively = (str) => {
      if (!str || typeof str !== 'string') return str;
      let curr = str.trim();
      for (let i = 0; i < 3; i++) {
        try {
          const next = decodeURIComponent(curr);
          if (next === curr) break;
          curr = next;
        } catch (e) {
          break;
        }
      }
      return curr;
    };

    const images = Array.from(document.querySelectorAll('img, picture, [srcset], a[href]'));
    let targetImg = null;
    let ambiguousTarget = false;

    const dataAttrNames = [
      'data-original', 'data-src', 'data-full', 'data-full-image',
      'data-original-src', 'data-image', 'data-zoom-src', 'data-highres',
      'data-large', 'data-raw', 'data-super-full-img', 'data-orig-file'
    ];

    // Helper to extract URLs from CSS background-image / background property
    const extractCssUrls = (cssValue) => {
      if (!cssValue || typeof cssValue !== 'string' || cssValue === 'none') return [];
      const urls = [];
      const regex = /url\(\s*(?:['"]([^'"]+)['"]|([^'")\s]+))\s*\)/gi;
      let match;
      while ((match = regex.exec(cssValue)) !== null) {
        const rawUrl = match[1] || match[2];
        if (rawUrl) {
          const trimmed = rawUrl.trim();
          if (trimmed && !trimmed.startsWith('data:') && !trimmed.startsWith('blob:')) {
            urls.push(trimmed);
          }
        }
      }
      return urls;
    };

    // Background images of an element and its nearest ancestors (inline and computed style).
    const collectBackgrounds = (startEl) => {
      const bgImages = [];
      let curr = startEl;
      let depth = 0;
      while (curr && curr.nodeType === 1 && depth < 8) {
        // 1. Inline style
        if (curr.style) {
          if (curr.style.backgroundImage) {
            bgImages.push(...extractCssUrls(curr.style.backgroundImage));
          }
          if (curr.style.background) {
            bgImages.push(...extractCssUrls(curr.style.background));
          }
        }

        // 2. Computed style
        try {
          if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
            const computed = window.getComputedStyle(curr);
            if (computed && computed.backgroundImage && computed.backgroundImage !== 'none') {
              bgImages.push(...extractCssUrls(computed.backgroundImage));
            }
          }
        } catch (csErr) {}

        curr = curr.parentElement;
        depth++;
      }
      return bgImages;
    };

    // Metadata that belongs to one image element: own srcset/data attributes, <picture> sources, parent link, scoped card.
    const collectOwnerEvidence = (targetImg, result) => {
      // 1. srcset on <img>
      const imgSrcset = targetImg.getAttribute('srcset');
      if (imgSrcset) result.srcsetList.push(imgSrcset);

      // 2. srcset on <picture> <source>
      const picture = (typeof targetImg.closest === 'function') ? targetImg.closest('picture') : null;
      if (picture && picture.tagName === 'PICTURE' && typeof picture.querySelectorAll === 'function') {
        const sources = picture.querySelectorAll('source[srcset]');
        for (const s of sources) {
          const srcVal = s.getAttribute('srcset');
          if (srcVal) result.srcsetList.push(srcVal);
        }
      }

      // 3. data-* attributes for original images
      for (const attr of dataAttrNames) {
        const val = targetImg.getAttribute(attr);
        if (val && typeof val === 'string' && val.trim()) {
          result.dataAttrs.push(val.trim());
        }
      }

      // 4. Parent <a> link
      const parentA = targetImg.closest('a');
      if (parentA && parentA.href) {
        result.anchorHref = parentA.href;
      }

      // 4.1. Reddit custom element <shreddit-post content-href="...">
      const shredditPost = targetImg.closest('shreddit-post, [content-href]');
      const contentHref = shredditPost?.getAttribute('content-href');
      if (contentHref && typeof contentHref === 'string' && contentHref.trim()) {
        result.dataAttrs.unshift(contentHref.trim());
      }

      // 4.2. Scoped card / container inspection for search engines & gallery feeds
      let scopedCard = null;
      try {
        scopedCard = (typeof targetImg.closest === 'function') ? targetImg.closest(
          '.serp-item, .isv-r, [data-ved], [data-tbnid], .posts_block, .post_block, ' +
          '.numeric_grid_item, .img_block_big, .thumb, .post-preview, article, figure, ' +
          '[data-card], li, div[class*="item"], div[class*="card"]'
        ) : null;
      } catch (e) {}
      if (!scopedCard) scopedCard = targetImg.parentElement;

      if (scopedCard) {
        // Google Images imgurl extraction from card links
        try {
          const googleLink = scopedCard.querySelector ? scopedCard.querySelector('a[href*="imgurl="]') : null;
          if (googleLink && googleLink.href) {
            const rawImgUrl = (function() {
              try { return new URL(googleLink.href, window.location.href).searchParams.get('imgurl'); } catch (e) { return null; }
            })() || (googleLink.href.match(/[?&]imgurl=([^&]+)/) ? googleLink.href.match(/[?&]imgurl=([^&]+)/)[1] : null);
            if (rawImgUrl) result.searchResultUrls.push(decodeURIComponent(rawImgUrl));
          }
        } catch (e) {}

        // Google Images data-ou, data-orig-url attributes
        try {
          const dataOu = (targetImg && targetImg.getAttribute && targetImg.getAttribute('data-ou')) ||
                         (scopedCard.getAttribute && scopedCard.getAttribute('data-ou')) ||
                         (targetImg && targetImg.getAttribute && targetImg.getAttribute('data-orig-url')) ||
                         (scopedCard.getAttribute && scopedCard.getAttribute('data-orig-url'));
          if (dataOu && typeof dataOu === 'string' && dataOu.trim()) result.searchResultUrls.push(dataOu.trim());
        } catch (e) {}

        // Yandex Images data-bem extraction from card
        try {
          const bemEl = (scopedCard.hasAttribute && scopedCard.hasAttribute('data-bem')) ? scopedCard : (scopedCard.querySelector ? scopedCard.querySelector('[data-bem]') : null);
          if (bemEl && bemEl.getAttribute) {
            const rawBem = bemEl.getAttribute('data-bem');
            if (rawBem) {
              const bemData = JSON.parse(rawBem);
              const serpItem = bemData['serp-item'] || bemData;
              if (serpItem && serpItem.img_href) {
                result.searchResultUrls.push(serpItem.img_href);
              }
              if (serpItem && Array.isArray(serpItem.preview)) {
                for (const prev of serpItem.preview) {
                  if (prev && prev.url) {
                    result.searchResultUrls.push(prev.url);
                  }
                }
              }
            }
          }
        } catch (e) {}

        // Yandex Images img_url extraction from card links
        try {
          const yandexLink = scopedCard.querySelector ? scopedCard.querySelector('a.serp-item__link, a[href*="img_url="]') : null;
          if (yandexLink && yandexLink.href) {
            const rawImgUrl = (function() {
              try { return new URL(yandexLink.href, window.location.href).searchParams.get('img_url'); } catch (e) { return null; }
            })() || (yandexLink.href.match(/[?&]img_url=([^&]+)/) ? yandexLink.href.match(/[?&]img_url=([^&]+)/)[1] : null);
            if (rawImgUrl) {
              const decoded = decodeUrlRecursively(rawImgUrl);
              if (decoded) result.searchResultUrls.push(decoded);
            }
          }
        } catch (e) {}

        // Anime-Pictures links within card
        try {
          const animeLink = scopedCard.querySelector ? scopedCard.querySelector('a[href*="/posts/"], a[href*="/pictures/view_post/"], a[href*="/pictures/get_image/"], #download_link') : null;
          if (animeLink && animeLink.href) {
            if (animeLink.href.includes('/pictures/get_image/')) {
              result.searchResultUrls.push(animeLink.href);
            } else {
              result.dataAttrs.push(animeLink.href);
            }
          }
        } catch (e) {}

        // Zerochan links within card or post page
        try {
          const zerochanFullLink = scopedCard.querySelector ? scopedCard.querySelector('a[href*="static.zerochan.net"][href*=".full."], #large a.preview[href], a[href*=".full."]') : null;
          if (zerochanFullLink && zerochanFullLink.href) {
            result.dataAttrs.push(zerochanFullLink.href);
          }
          const zerochanPostLink = scopedCard.querySelector ? scopedCard.querySelector('a.thumb[href], a[href*="zerochan.net/"]') : null;
          if (zerochanPostLink && zerochanPostLink.href) {
            result.dataAttrs.push(zerochanPostLink.href);
          }
        } catch (e) {}
      }
    };

    // Several images can share one URL (repeated previews). Only the <img> itself being :hover proves the click owner
    // (a hovered shared container matches every image); otherwise identical evidence may merge, else refuse to choose.
    const pickOwned = (matches) => {
      if (matches.length <= 1) return matches[0] || null;
      const hovered = matches.filter((el) => { try { return el.matches(':hover'); } catch (e) { return false; } });
      if (hovered.length === 1) return hovered[0];
      // Evidence is everything the extraction below would take from the element (own attributes, <picture> sources,
      // parent link, scoped card, CSS backgrounds), so identical evidence cannot admit another owner's metadata.
      const evidence = (el) => {
        try {
          const out = { srcsetList: [], dataAttrs: [], anchorHref: null, searchResultUrls: [] };
          collectOwnerEvidence(el, out);
          return JSON.stringify([out, collectBackgrounds(el)]);
        } catch (e) {
          return 'unreadable:' + Math.random();
        }
      };
      const first = evidence(matches[0]);
      if (matches.every((el) => evidence(el) === first)) return matches[0];
      ambiguousTarget = true;
      return null;
    };

    // 0. Proven owner: the element of the latest real context-menu gesture in this frame, kept by
    // content_context_target.js (:hover is already gone when the native menu item is clicked). It counts only while
    // fresh, still connected, an <img> and still showing the clicked source; anything else falls through to the
    // heuristics below, which never choose between differing candidates. The owner must also be the same one the
    // gesture identified (`unchanged`): a site may reuse the node for another card before the menu item is chosen.
    // When the gesture was on this very source and that owner can no longer be proven (changed, removed, collected,
    // re-sourced), nothing else may stand in for it: no heuristic and no page metadata, only the selected URL.
    if (clickedSrc) {
      try {
        const cap = globalThis.__imageSaverContextTarget;
        const age = cap ? Date.now() - cap.at : Infinity;
        if (age >= 0 && age < 30000) {
          const el = cap.ref && typeof cap.ref.deref === 'function' ? cap.ref.deref() : null;
          const media = cap.media;
          if (el && el.tagName === 'IMG' && el.isConnected !== false &&
              (el.currentSrc === clickedSrc || el.src === clickedSrc) &&
              typeof cap.unchanged === 'function' && cap.unchanged(el)) {
            targetImg = el;
          } else if (Array.isArray(cap.srcs) && cap.srcs.includes(clickedSrc)) {
            ambiguousTarget = true;
          } else if (media && media.url === clickedSrc) {
            // The gesture was on a CSS background or a simple overlay whose one asset is the clicked source (read by
            // readContextMediaTarget). It stands only while the whole gesture-time ownership re-proves; an <img>
            // under an overlay then brings its own evidence, a background/video brings none, and nothing else
            // (heuristics, hovered element, page metadata) may stand in for it.
            const owner = typeof media.check === 'function' && media.check() && media.ref && media.ref.deref ? media.ref.deref() : null;
            if (owner && owner.tagName === 'IMG') targetImg = owner;
            else ambiguousTarget = true;
          }
        }
      } catch (e) {}
    }

    // 1. Exact match by src or currentSrc
    if (!targetImg && !ambiguousTarget && clickedSrc) {
      const exact = images.filter((el) => el.tagName === 'IMG' && (el.currentSrc === clickedSrc || el.src === clickedSrc));
      targetImg = pickOwned(exact);
    }

    // 1.1 Yandex Images: Match by 'id' query parameter if exact src match failed
    if (!targetImg && !ambiguousTarget && clickedSrc) {
      try {
        const clickedUrl = new URL(clickedSrc);
        const yandexImgId = clickedUrl.searchParams.get('id');
        if (yandexImgId && (clickedUrl.hostname.includes('avatars.mds.yandex.net') || clickedUrl.hostname.includes('yandex.'))) {
          // Provider-specific identity (accepted Yandex path): first image carrying the id, unchanged.
          targetImg = images.find((el) => el.tagName === 'IMG' && (el.currentSrc || el.src || '').includes(yandexImgId)) || null;
        }
      } catch (e) {}
    }

    // 2. Filename match if absolute URL did not match (excluding generic thumbnail tokens)
    if (!targetImg && !ambiguousTarget && clickedSrc) {
      const clickedPath = (function() {
        try { return new URL(clickedSrc).pathname; } catch (e) { return clickedSrc; }
      })();
      const lastSlash = clickedPath.lastIndexOf('/');
      const filename = lastSlash !== -1 ? clickedPath.substring(lastSlash + 1) : clickedPath;

      const genericTokens = ['preview', 'thumb', 'thumbnail', 'sample', 'orig', 'original', 'default', 'image', 'photo', 'view', 'blank', 'loading', 'i'];
      const isGeneric = genericTokens.includes(filename.toLowerCase());

      if (filename && filename.length > 3 && !isGeneric) {
        targetImg = pickOwned(images.filter((el) => el.tagName === 'IMG' && el.src && el.src.includes(filename)));
      }
    }

    // 3. Find element under cursor for CSS background-image detection. With a fresh gesture record the gesture itself
    // (step 0) is the only owner: :hover and the document-wide scan below are the fallback only when no gesture
    // was captured at all, so a neighbour's background never stands in for a target the gesture did not prove.
    let gestureCaptured = false;
    try {
      const cap = globalThis.__imageSaverContextTarget;
      const age = cap ? Date.now() - cap.at : Infinity;
      if (age >= 0 && age < 30000) {
        gestureCaptured = true;
      }
    } catch (e) {}
    let targetElement = targetImg;
    if (!targetElement && !ambiguousTarget) {
      if (!gestureCaptured) {
        try {
          const hovered = Array.from(document.querySelectorAll(':hover'));
          if (hovered.length > 0) {
            targetElement = hovered[hovered.length - 1];
          }
        } catch (e) {}
      }
    }

    const bgImages = targetElement ? collectBackgrounds(targetElement) : [];

    // Fallback: If no target element from :hover, inspect elements with inline background style
    // Only perform document-wide scan when not clicking an image element and not on a multi-card search gallery
    const hasMultipleCards = (function() {
      try {
        return typeof document.querySelectorAll === 'function' &&
          document.querySelectorAll('.serp-item, .isv-r, [data-ved], [data-tbnid], .posts_block').length > 0;
      } catch (e) {
        return false;
      }
    })();
    if (bgImages.length === 0 && !clickedSrc && !hasMultipleCards && !gestureCaptured) {
      try {
        const styledElements = Array.from(document.querySelectorAll('[style*="background"], [style*="url"]'));
        for (const el of styledElements) {
          if (el.style) {
            if (el.style.backgroundImage) bgImages.push(...extractCssUrls(el.style.backgroundImage));
            if (el.style.background) bgImages.push(...extractCssUrls(el.style.background));
          }
        }
      } catch (e) {}
    }

    const result = {
      srcsetList: [],
      dataAttrs: [],
      anchorHref: null,
      searchResultUrls: [],
      pageMeta: [],
      bgImages: Array.from(new Set(bgImages)),
      // The owning document's base (frame URL or <base href>): relative values above resolve against it, not the top page.
      baseUrl: (typeof document.baseURI === 'string') ? document.baseURI : ''
    };

    if (targetImg) collectOwnerEvidence(targetImg, result);

    // 5. Page metadata (OpenGraph, Twitter Cards, link image_src)
    // Relationship scoping: skip page metadata if multiple distinct result cards exist on the page
    const isMultiCardPage = (function() {
      try {
        return typeof document.querySelectorAll === 'function' &&
          document.querySelectorAll('.serp-item, .isv-r, .posts_block, .numeric_grid_item, ul#thumbs2 > li, ul.medium-mode > li, li[data-id]').length > 1;
      } catch (e) {
        return false;
      }
    })();

    // Page-wide metadata describes the page's main image, so it may stand for the clicked one only when no other
    // comparable image is shown (equal cards of a gallery must not be replaced by one og:image). An unlocated
    // target keeps the earlier behavior; an ambiguous one never borrows page metadata.
    const pageMetaMayApply = (function() {
      if (ambiguousTarget) return false;
      try {
        if (!targetImg || typeof targetImg.getBoundingClientRect !== 'function') return true;
        const area = (el) => { const r = el.getBoundingClientRect(); return Math.max(0, r.width) * Math.max(0, r.height); };
        const own = area(targetImg);
        for (const el of images) {
          if (el === targetImg || el.tagName !== 'IMG') continue;
          const a = area(el);
          if (a >= 5000 && a >= own * 0.75) return false;
        }
      } catch (e) {}
      return true;
    })();

    if (!isMultiCardPage && pageMetaMayApply) {
      const isLogoOrIcon = (url) => {
        if (!url || typeof url !== 'string') return true;
        return /favicon|logo|brand|icon|avatar|redditstatic|\/default\/v\d+\/og\/image\.png/i.test(url);
      };

      const ogImg = typeof document.querySelector === 'function' ? document.querySelector('meta[property="og:image"]')?.content : null;
      if (ogImg && !isLogoOrIcon(ogImg)) result.pageMeta.push(ogImg);

      const twImg = typeof document.querySelector === 'function' ? document.querySelector('meta[name="twitter:image"], meta[name="twitter:image:src"]')?.content : null;
      if (twImg && !isLogoOrIcon(twImg)) result.pageMeta.push(twImg);

      const linkImg = typeof document.querySelector === 'function' ? document.querySelector('link[rel="image_src"]')?.href : null;
      if (linkImg && !isLogoOrIcon(linkImg)) result.pageMeta.push(linkImg);

      // 6. JSON-LD parsing
      const jsonLdScripts = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('script[type="application/ld+json"]') : [];
      for (const s of jsonLdScripts) {
        try {
          const parsed = JSON.parse(s.textContent);
          const collectImages = (obj) => {
            if (!obj) return;
            if (typeof obj === 'string' && /\.(jpe?g|png|webp|gif)$/i.test(obj)) {
              if (!isLogoOrIcon(obj)) result.pageMeta.push(obj);
            } else if (Array.isArray(obj)) {
              obj.forEach(collectImages);
            } else if (typeof obj === 'object') {
              if (obj.image) collectImages(obj.image);
              if (obj.thumbnailUrl) collectImages(obj.thumbnailUrl);
              if (obj.contentUrl) collectImages(obj.contentUrl);
            }
          };
          collectImages(parsed);
        } catch (e) {}
      }
    }

    return result;
  } catch (err) {
    return null;
  }
}


// ============================================================================
// 7. LEVEL 5: Universal CDN and Heuristic Transformations
// ============================================================================
/**
 * Generates candidate original URLs for popular CDNs, CMSs, and Boorus:
 * - WordPress contract only (/wp-content/uploads/, Photon i0-i2.wp.com): drop the named size keys (?w=, ?h=, ?resize=, ?crop=, ?fit=, ?quality=)
 * - Strip CMS/WordPress resize suffixes (-1024x768.jpg -> .jpg)
 * - Universal replacement of typical preview folders (/sample/, /thumb/, /small/, /medium/)
 *
 * Identity: the query of the selected address (an id, a repeated key, a signature, a cache token) is part of what was selected, and a queryless
 * address that answers with plausible media is another asset: MIME or size does not prove equivalence. No derivative therefore drops the query;
 * only the named size pairs of the documented WordPress contract are removed, textually, so every other byte of the query stays as it was.
 */
function getGenericCdnCandidates(urlObj) {
  const candidates = [];
  const pathname = urlObj.pathname;
  const urlStr = urlObj.toString();
  const keepSearch = urlObj.search;
  const withSearch = (href, search) => { const c = new URL(href); c.search = search; return c.toString(); };

  const resizeParams = [
    'width', 'w', 'max_width', 'maxwidth',
    'height', 'h', 'max_height', 'maxheight',
    'resize', 'crop', 'fit', 'size', 'scale', 'quality', 'q'
  ];
  const isWordPressContract = /\/wp-content\/uploads\//i.test(pathname) || /^i[0-2]\.wp\.com$/i.test(urlObj.hostname);
  // the same query without the named size pairs; every other pair keeps its raw bytes and order
  let sizeFreeSearch = keepSearch;
  if (isWordPressContract && keepSearch.length > 1) {
    const kept = keepSearch.slice(1).split('&').filter((pair) => {
      let key = pair.split('=')[0].replace(/\+/g, ' ');
      try { key = decodeURIComponent(key); } catch (_) {}
      return !resizeParams.includes(key);
    });
    sizeFreeSearch = kept.length ? `?${kept.join('&')}` : '';
  }
  const searches = sizeFreeSearch !== keepSearch ? [sizeFreeSearch, keepSearch] : [keepSearch];

  if (sizeFreeSearch !== keepSearch) candidates.push(withSearch(urlStr, sizeFreeSearch));

  // 2. Strip CMS / WordPress resize suffixes from filename path:
  // photo-1024x768.jpg -> photo.jpg
  // banner-300x200.png -> banner.png
  if (/-\d+x\d+\.([a-z0-9]+)$/i.test(pathname)) {
    const unscaledPath = pathname.replace(/-\d+x\d+\.([a-z0-9]+)$/i, '.$1');
    for (const search of searches) {
      const cand = new URL(urlStr);
      cand.pathname = unscaledPath;
      candidates.push(withSearch(cand.toString(), search));
    }
  }

  // 3. Typical preview path structures for web directories and Boorus:
  const pathPatterns = [
    { pattern: /\/+samples?\//gi, replacements: ['/images/', '/image/', '/original/', '/full/'] },
    { pattern: /\/+(previews?)\//gi, replacements: ['/original/', '/images/', '/image/', '/full/'] },
    { pattern: /\/+(thumbs?|thumbnails?)\//gi, replacements: ['/images/', '/image/', '/original/', '/full/'] },
    { pattern: /\/+small\//gi, replacements: ['/original/', '/large/', '/full/'] },
    { pattern: /\/+medium\//gi, replacements: ['/original/', '/large/', '/full/'] }
  ];

  for (const item of pathPatterns) {
    if (item.pattern.test(pathname)) {
      for (const rep of item.replacements) {
        let newPath = pathname.replace(item.pattern, rep);

        const lastSlash = newPath.lastIndexOf('/');
        const dir = newPath.substring(0, lastSlash + 1);
        let file = newPath.substring(lastSlash + 1);

        file = file.replace(/^(sample[-_]|thumb(nail)?[-_]|small[-_]|medium[-_])/i, '');
        file = file.replace(/([ _-]sample[ _-]|%20sample%20)/gi, ' ');

        const dotIdx = file.lastIndexOf('.');
        const baseName = dotIdx !== -1 ? file.substring(0, dotIdx) : file;
        const ext = dotIdx !== -1 ? file.substring(dotIdx).toLowerCase() : '.jpg';

        // generateExtensionCandidates serves provider resolvers too and drops the query; a generic derivative keeps the selected one
        candidates.push(...generateExtensionCandidates(urlObj, `${dir}${baseName}`, ext).map((c) => withSearch(c, keepSearch)));
      }
    }
  }

  return candidates;
}

// ============================================================================
// 8. MAIN ORIGINAL IMAGE RESOLUTION PIPELINE
// ============================================================================
/**
 * Executes strictly ordered resolution of highest-quality original image:
 * 1. direct link (DOM <a> linkUrl)
 * 2. known site resolver (X/Twitter, Pixiv, Reddit)
 * 3. known engine resolver (Danbooru, Gelbooru, Moebooru, Philomena, e621, Shimmie, Szurubooru, Piwigo)
 * 4. DOM metadata / srcset / data-* / page metadata
 * 5. generic CDN / preview transforms (?w=, -1024x768, /sample/, /thumb/)
 * 6. public metadata / API resolver (MD5)
 * 7. reliable fallback to initial srcUrl
 */
// ============================================================================
// 8. MAIN UNIVERSAL CANDIDATE DISCOVERY, SCORING & RESOLUTION PIPELINE
// ============================================================================
/**
 * Executes universal image resolution:
 * 1. Universal candidate discovery (scoped DOM metadata, links, attributes, background-image)
 * 2. Specialized candidate providers (Twitter, Pixiv, Reddit, Wikimedia, Boorus, Google, Yandex, Anime-Pictures)
 * 3. Universal CDN & CMS heuristics (query stripping, -1024x768 unscaling, preview/sample path transforms)
 * 4. Deterministic candidate scoring based on provenance, resolution, and thumbnail penalties
 * 5. Candidate verification (200 OK + Content-Type) & post-verification dimension/size refinement
 * 6. Best verified candidate selection
 * 7. Reliable fallback to initial srcUrl
 */
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

/**
 * Strict validator for allowed RedGIFs media/CDN hostnames.
 * Requires redgifs.com or *.redgifs.com. Strictly rejects lookalikes.
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
async function resolveFrameLocalMedia(options = {}) {
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
    // 2. If content script is not yet active in this frame, inject content_redgifs.js and retry
    if (chrome.scripting?.executeScript) {
      try {
        await chrome.scripting.executeScript({
          target: sendOptions.documentId ? { tabId, documentIds: [sendOptions.documentId] } : { tabId, frameIds: [targetFrameId] },
          files: ['content_redgifs.js']
        });
        response = await chrome.tabs.sendMessage(
          tabId,
          { action: 'RESOLVE_FRAME_MEDIA', clickedSrc, pageUrl, linkUrl, mediaType, frameId: targetFrameId, ...(requireGesture ? { requireGesture: true, gestureAt } : {}), ...(inlineToken ? { inlineToken } : {}) },
          sendOptions
        );
      } catch (injectErr) {
        console.warn('[Image Saver] Не удалось внедрить content_redgifs.js во фрейм ' + targetFrameId + ':', injectErr);
      }
    }
  }

  // RG-03: what the frame learned from the provider's own clip declaration (a fixed code only, never page, provider or session data)
  const providerNote = response && response.diagnostics ? response.diagnostics.providerAudio : null;
  if (typeof providerNote === 'string' && /^(?:present|[A-Z_]{3,24})$/.test(providerNote)) {
    console.log('[Image Saver] RedGIFs provider audio:', providerNote);
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
        console.warn('[Image Saver] Inline RedGIFs answer does not name its selected clip: refused');
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
      console.warn('[Image Saver] Кандидат RedGIFs отклонен валидатором:', validated.error, sanitizeUrlForLog(response.targetUrl));
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
 * Communicates with content_reddit.js in the owning frame and validates candidates.
 */
async function resolveRedditFrameBlobMedia({ tabId, frameId, clickedSrc, pageUrl, linkUrl, mediaType }) {
  const targetFrameId = typeof frameId === 'number' ? frameId : 0;
  let response = null;

  try {
    // 1. Try sending message to content_reddit.js in the owning frame
    response = await chrome.tabs.sendMessage(
      tabId,
      { action: 'RESOLVE_REDDIT_BLOB_MEDIA', clickedSrc, pageUrl, linkUrl, mediaType, frameId: targetFrameId },
      { frameId: targetFrameId }
    );
  } catch (msgErr) {
    // 2. If content script is not yet active in this frame, inject content_reddit.js and retry
    if (chrome.scripting?.executeScript) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [targetFrameId] },
          files: ['content_reddit.js']
        });
        response = await chrome.tabs.sendMessage(
          tabId,
          { action: 'RESOLVE_REDDIT_BLOB_MEDIA', clickedSrc, pageUrl, linkUrl, mediaType, frameId: targetFrameId },
          { frameId: targetFrameId }
        );
      } catch (injectErr) {
        console.warn('[Image Saver Reddit] Не удалось внедрить content_reddit.js во фрейм ' + targetFrameId + ':', injectErr);
      }
    }
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
      console.warn('[Image Saver Reddit] Кандидат Reddit отклонен валидатором:', validated.error, sanitizeUrlForLog(response.targetUrl));
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

  function extractStatusIdsFromContainer(container, isQuote, hintId) {
    if (!container) return [];
    const ids = [];
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
      if (!isQuote) {
        if (a.closest && a.closest('[data-testid="quoteTweet"], [role="blockquote"]')) {
          continue;
        }
      }
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
    let timeAnchors = [];
    if (container.querySelectorAll) {
      timeAnchors = Array.from(container.querySelectorAll('a:has(time), a[href*="/status/"], a'));
    }
    for (const a of timeAnchors) {
      if (!isQuote && a.closest && a.closest('[data-testid="quoteTweet"], [role="blockquote"]')) {
        continue;
      }
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
      if (isQuoteTweet) {
        candidateContainer = el.closest ? el.closest('[data-testid="quoteTweet"], [role="blockquote"]') : null;
      } else {
        candidateContainer = el.closest ? (el.closest('article[data-testid="tweet"], article[role="article"]') || el.closest('article')) : null;
      }

      if (candidateContainer) {
        diag.point = 'article';
        if (isQuoteTweet) {
          const outerArticle = candidateContainer.closest ? (candidateContainer.closest('article[data-testid="tweet"], article[role="article"]') || candidateContainer.closest('article')) : null;
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
        const qContainer = art.querySelector ? art.querySelector('[data-testid="quoteTweet"], [role="blockquote"]') : null;
        if (qContainer) {
          const qIds = extractStatusIdsFromContainer(qContainer, true, requestedTweetId);
          const qReactId = getTweetIdFromNode(qContainer, true);
          const artIds = extractStatusIdsFromContainer(art, false, requestedTweetId);
          const artReactId = getTweetIdFromNode(art, false);
          if (qIds.includes(requestedTweetId) || qReactId === requestedTweetId || artIds.includes(requestedTweetId) || artReactId === requestedTweetId) {
            postContainer = qContainer;
            targetEl = qContainer;
            break;
          }
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
      if (cleanPoster) {
        const videoEl = art.querySelector ? art.querySelector('video') : null;
        const vPoster = videoEl ? (videoEl.getAttribute('poster') || videoEl.poster || '').split('?')[0].toLowerCase() : null;
        if (vPoster && (vPoster === cleanPoster || vPoster.includes(cleanPoster) || cleanPoster.includes(vPoster))) {
          matchedInArticle = true;
        }
        if (!matchedInArticle) {
          const imgs = art.querySelectorAll ? Array.from(art.querySelectorAll('img')) : [];
          for (const img of imgs) {
            const iSrc = (img.currentSrc || img.src || '').split('?')[0].toLowerCase();
            if (iSrc && (iSrc === cleanPoster || iSrc.includes(cleanPoster) || cleanPoster.includes(iSrc))) {
              matchedInArticle = true;
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
          const qContainer = art.querySelector ? art.querySelector('[data-testid="quoteTweet"], [role="blockquote"]') : null;
          postContainer = qContainer || art;
          targetEl = postContainer;
        } else {
          postContainer = art;
          targetEl = art;
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
    targetTweetId = quoteReactId || quoteStatusIds[0] || null;
    if (!targetTweetId && requestedTweetId) {
      const outerArt = postContainer.closest ? (postContainer.closest('article[data-testid="tweet"], article[role="article"]') || postContainer.closest('article')) : null;
      const outerArtId = outerArt ? (getTweetIdFromNode(outerArt, false) || getAuthoritativeStatusId(outerArt, false, requestedTweetId)) : null;
      if (requestedTweetId !== outerArtId) {
        targetTweetId = requestedTweetId;
      }
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

  const domPoster = !posterUrl && postContainer.querySelector ? (postContainer.querySelector('video')?.getAttribute('poster') || postContainer.querySelector('video')?.poster) : null;
  const domMediaId = domPoster ? extractMediaIdFromUrl(domPoster) : null;
  if (domMediaId && !knownMediaIds.includes(domMediaId)) knownMediaIds.push(domMediaId);

  // Pre-pass: scan from targetEl up to postContainer to record any verified tweet props
  let scanNode = targetEl;
  while (scanNode) {
    const p = getReactProps(scanNode);
    if (p) {
      const t = getOwnedTweet(isQuoteTweet ? (p.tweet?.quoted_status || p.tweet?.quoted_status_result?.result?.legacy || p.tweet) : p.tweet, targetTweetId);
      const tid = getTweetId(t) || getTweetId(p.tweet);
      if (!targetTweetId || !tid || tid === targetTweetId) {
        recordVerifiedTweet(t);
      }
    }
    const f = getReactFiber(scanNode);
    let sf = f;
    let sDepth = 0;
    while (sf && sDepth < 30) {
      // Bound fiber traversal to postContainer
      if (sf.stateNode && typeof sf.stateNode === 'object' && sf.stateNode.nodeType === 1) {
        const node = sf.stateNode;
        if (node.tagName === 'ARTICLE' && node !== postContainer) break;
        if (node.tagName === 'BODY' || node.tagName === 'HTML') break;
        if (postContainer.contains && !postContainer.contains(node) && node !== postContainer) break;
      }

      if (sf.memoizedProps) {
        const mp = sf.memoizedProps;
        const t = getOwnedTweet(isQuoteTweet ? (mp.tweet?.quoted_status || mp.tweet?.quoted_status_result?.result?.legacy || mp.tweet) : mp.tweet, targetTweetId);
        const tid = getTweetId(t) || getTweetId(mp.tweet);
        if (targetTweetId && tid && tid !== targetTweetId) {
          break;
        }
        recordVerifiedTweet(t);
      }
      if (sf.stateNode === postContainer) break;
      sf = sf.return;
      sDepth++;
    }
    if (scanNode === postContainer) break;
    if (scanNode.tagName === 'ARTICLE' && scanNode !== postContainer) break;
    if (scanNode.tagName === 'BODY' || scanNode.tagName === 'HTML') break;
    scanNode = scanNode.parentElement;
  }

  // 2. Search React fiber & props tree within the postContainer boundary
  let curr = targetEl;
  let confirmedHls = false;
  let foundAnyVariants = false;
  let lastVariantError = 'UNSUPPORTED_VARIANTS';

  while (curr) {
    const props = getReactProps(curr);
    if (props) {
      let tweet = getOwnedTweet(isQuoteTweet
        ? (props.tweet?.quoted_status || props.tweet?.quoted_status_result?.result?.legacy || props.tweet)
        : props.tweet, targetTweetId);
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
      // Bound fiber traversal to postContainer
      if (f.stateNode && typeof f.stateNode === 'object' && f.stateNode.nodeType === 1) {
        const node = f.stateNode;
        if (node.tagName === 'ARTICLE' && node !== postContainer) { diag.edge++; break; }
        if (node.tagName === 'BODY' || node.tagName === 'HTML') { diag.edge++; break; }
        if (postContainer.contains && !postContainer.contains(node) && node !== postContainer) { diag.edge++; break; }
      }

      const fProps = f.memoizedProps;
      if (fProps) {
        let fTweet = getOwnedTweet(isQuoteTweet
          ? (fProps.tweet?.quoted_status || fProps.tweet?.quoted_status_result?.result?.legacy || fProps.tweet)
          : fProps.tweet, targetTweetId);
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

      if (f.stateNode === postContainer) break;
      f = f.return;
      depth++;
    }

    // Do NOT walk into another post or out of postContainer
    if (curr === postContainer) break;
    if (curr.tagName === 'ARTICLE' && curr !== postContainer) break;
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
async function recoverXPostMp4Variant(tabId, mediaDescriptor) {
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
      console.warn('[Image Saver] Ошибка выполнения скрипта восстановления MP4 в main world:', e?.message || e);
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
async function resolveMediaTarget(options = {}) {
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
        console.warn('[Image Saver] Не удалось восстановить проверенный MP4 для постера X видео:', sanitizeUrlForLog(mediaDesc.poster || mediaDesc.src), describeXRecoveryFailure(recovery));
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
      console.warn('[Image Saver] Не удалось восстановить проверенный MP4 для постера X видео (отсутствует tabId):', sanitizeUrlForLog(mediaDesc.poster || mediaDesc.src));
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
          console.warn('[Image Saver] RedGIFs: frame changed during direct silent audio lookup; refusing stale direct context-menu save');
          await flashBadge('ERR', '#ef4444');
          return {
            targetUrl: null,
            type: 'video',
            error: 'UNRESOLVED_BLOB_MEDIA',
            reason: 'FRAME_CHANGED',
            status: 404,
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
            console.warn('[Image Saver] RedGIFs: authoritative media-asset failure on promoted audio rendition:', authoritativeError);
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
            console.log('[Image Saver] RedGIFs: selected the same-clip rendition declared to carry audio over the -silent source:', sanitizeUrlForLog(chosenAudioUrl));
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
          const frameId = typeof options.frameId === 'number' ? options.frameId : 0;
          try {
            const frameRes = await resolveFrameLocalMedia({
              tabId: options.tabId,
              frameId,
              documentId: embedProof ? embedProof.documentId : '',
              clickedSrc: videoUrl || mediaDesc.src || '',
              pageUrl: options.pageUrl || mediaDesc.pageUrl || pageUrl,
              linkUrl: options.linkUrl || mediaDesc.linkUrl || linkUrl,
              mediaType: 'video'
            });
            if (frameRes && frameRes.success && frameRes.targetUrl &&
                (!embedProof || (frameRes.clipId === embedProof.clipKey && redGifsClipKey(frameRes.targetUrl) === embedProof.clipKey))) {
              frameResolvedUrl = frameRes.targetUrl;
            }
          } catch (_) {}
        }

        if (frameResolvedUrl) {
          videoUrl = frameResolvedUrl;
          mediaDesc.src = frameResolvedUrl;
          mediaDesc.currentSrc = frameResolvedUrl;
          mediaDesc.type = 'video';
        } else if (embedProof) {
          console.warn('[Image Saver] Embedded RedGIFs clip not resolved in its frame (UNRESOLVED_BLOB_MEDIA); no ID-derived guess for an inline embed save');
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

    // Never fetch a blob: URL from the service worker. Resolve in the owning frame (also a gesture-proven player that shows no address):
    if (options.gesturePlayer === true || (videoUrl && videoUrl.startsWith('blob:'))) {
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
      console.warn(`[Image Saver] Не удалось разрешить blob video URL (UNRESOLVED_BLOB_MEDIA): ${JSON.stringify(diagObj)}`);
      await flashBadge('ERR', '#ef4444');
      return {
        targetUrl: null,
        type: 'video',
        error: 'UNRESOLVED_BLOB_MEDIA',
        reason: frameRes?.reason || 'NO_DIRECT_MEDIA_FOUND',
        validationError: frameRes?.validationError || null,
        status: 404,
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
      console.log('[Image Saver] Подтверждён реальный видео-источник (wins over poster):', sanitizeUrlForLog(videoUrl));
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

      console.warn(`[Image Saver] ${failureMsg}:`, sanitizeUrlForLog(videoUrl));
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
      console.log(`[Image Saver] Видео-источник отсутствует (HTTP ${probeDetails.status}), fallback на poster:`, sanitizeUrlForLog(mediaDesc.poster));
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
      console.warn(`[Image Saver] ${failureMsg}:`, sanitizeUrlForLog(videoUrl));
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

    console.warn(`[Image Saver] ${failMsg}:`, sanitizeUrlForLog(videoUrl));
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

/**
 * Universal candidate resolution pipeline returning a structured CandidateGroup (Resolution Plan).
 * Supports Candidate Groups with variant failover policies, provenance scoring, and deferred validation.
 */
async function resolveOriginalMediaPlan(firstArg, secondArg, thirdArg, fourthArg, fifthArg) {
  let srcUrl, pageUrl, linkUrl, tabId, domMeta, frameId;

  if (typeof firstArg === 'object' && firstArg !== null) {
    frameId = firstArg.frameId;
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

  console.log('[Image Saver] Старт универсального конвейера поиска медиаплана:', {
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
    console.warn('[Image Saver] Не удалось восстановить проверенный MP4 для постера X видео:', sanitizeUrlForLog(srcUrl), posterRecovery && !posterRecovery.ok ? describeXRecoveryFailure(posterRecovery) : 'reason=PROBE_FAILED');
    await flashBadge('ERR', '#ef4444');
    return null;
  }

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
    if (md5Match && candidateGroupMap.size <= 3 && !isDonmaiCdn) {
      const md5 = md5Match[1].toLowerCase();
      const origin = parsedSrcUrl.origin;
      const apiEndpoints = [
        `${origin}/post.json?tags=md5:${md5}`,
        `${origin}/posts.json?tags=md5:${md5}`,
        `${origin}/index.php?page=dapi&s=post&q=index&json=1&tags=md5:${md5}`
      ];
      for (const apiUrl of apiEndpoints) {
        try {
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 3000);
          const res = await fetch(apiUrl, { signal: ctrl.signal });
          clearTimeout(tid);
          if (res.ok) {
            const data = await res.json();
            const posts = Array.isArray(data) ? data : (data.posts || data.post);
            if (Array.isArray(posts) && posts[0]) {
              const fileUrl = posts[0].file_url || posts[0].file?.url || posts[0].original_url;
              if (fileUrl) addCandidate(fileUrl, 'specialized_provider');
            }
          }
        } catch (e) {}
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
  const groups = Array.from(candidateGroupMap.values()).sort((a, b) => {
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
      console.log(`[Image Saver] Группа принята с отложенной валидацией (${grp.provider}, tier: ${grp.tier}, score: ${grp.finalScore}):`, sanitizeGroupIdForLog(grp.id));
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

      if (!isOk) {
        console.warn(`[Image Saver] Группа не подтверждена (${grp.provider}, HTTP: ${(probeTarget && probeTarget.status) || 'не наблюдался'}):`, sanitizeUrlForLog((probeTarget && probeTarget.url) || grp.primaryUrl));
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
        console.log(`[Image Saver] Группа подтверждена (${grp.provider}, score: ${grp.finalScore}):`, sanitizeGroupIdForLog(grp.id));
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
      console.warn(`[Image Saver] Отмена медиаплана: оригинальный кандидат вернул ошибку (HTTP ${failStatus}), отсекаем fallback/превью/постер`);
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

    console.log(`[Image Saver] Выбран лучший медиаплан (${winner.provider}, tier: ${winner.tier}, score: ${winner.finalScore}):`, sanitizeGroupIdForLog(winner.id));
    return winner;
  }

  // If a candidate explicitly failed with 429 or 403/401, do not mask with thumbnail!
  if (lastFailureStatus === 429 || lastFailureStatus === 403 || lastFailureStatus === 401) {
    console.warn('[Image Saver] Отмена медиаплана: ошибка авторизации или лимита запросов (HTTP ' + lastFailureStatus + ')');
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
    console.warn(`[Image Saver] Отмена медиаплана: оригинальное видео вернуло ошибку (HTTP ${failStatus}), отсекаем fallback на превью`);
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

  // 6. Level 7: Fallback to initial srcUrl
  if (srcUrl && !srcUrl.startsWith('blob:') && !srcUrl.startsWith('data:') && !srcUrl.startsWith('javascript:')) {
    console.log('[Image Saver] [Уровень 7: Fallback] Проверенный оригинал не найден, возврат исходного srcUrl:', srcUrl);
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

// ============================================================================
// 9. Helper functions: filename, badge, and download tracking state
// ============================================================================

const trackedDownloadIds = new Set();
const inFlightRequests = new Set();
const activeProtectedBlobsByDownloadId = new Map();
const activeGelbooruBlobsByDownloadId = activeProtectedBlobsByDownloadId;
const earlyTerminalDownloadStates = new Map();
let activeResolvingCount = 0;
let flashBadgeTimeout = null;

// The persisted id list is one document updated by read-modify-write. Concurrent saves (Save all runs two at once) each read the same
// list and the last write won, dropping the other ids: the DL badge, which counts the persisted list, then under-reported running
// downloads or kept finished ones. Every write of the list, including startup rehydration, runs through one promise chain. The in-memory
// set is the live state and changes synchronously; storage only mirrors it. A reader therefore waits for the writes queued before it and
// then reads the set: it never merges a storage snapshot taken before an in-flight write, which would bring a finished id back.
// A queued update must not await a reader (it would wait for itself).
let trackedIdsChain = Promise.resolve();
function updateTrackedIdsList(update) {
  const step = async () => {
    await hydrateTrackedDownloadIds();
    return update();
  };
  const run = trackedIdsChain.then(step, step);
  trackedIdsChain = run.then(() => undefined, () => undefined);
  return run;
}

// Rehydrate tracked download IDs from session storage on service worker activation. A failed read is not evidence that nothing is
// running: every queued operation retries it (one read each) until one succeeds. Until then only ids known to this worker are tracked.
// Ids removed meanwhile stay removed (also in storage, so a later restart cannot resurrect them); ids added meanwhile are kept and persisted.
let trackedIdsHydrated = false;
const trackedIdsRemovedBeforeHydration = new Set();
async function hydrateTrackedDownloadIds() {
  if (trackedIdsHydrated) return;
  const storageApi = chrome.storage?.session || chrome.storage?.local;
  if (!storageApi?.get) {
    trackedIdsHydrated = true;
    return;
  }
  try {
    const data = await storageApi.get({ trackedDownloadIds: [] });
    const list = Array.isArray(data.trackedDownloadIds) ? data.trackedDownloadIds : [];
    const merged = list.filter(id => !trackedIdsRemovedBeforeHydration.has(id));
    for (const id of trackedDownloadIds) {
      if (!merged.includes(id)) merged.push(id);
    }
    for (const id of merged) trackedDownloadIds.add(id);
    trackedIdsHydrated = true;
    trackedIdsRemovedBeforeHydration.clear();
    if (storageApi.set && (merged.length !== list.length || merged.some((id, i) => id !== list[i]))) {
      await storageApi.set({ trackedDownloadIds: merged });
    }
  } catch (e) {}
}
updateTrackedIdsList(() => {});

async function addTrackedDownloadId(id) {
  if (id === undefined || id === null) return;
  trackedDownloadIds.add(id);
  trackedIdsRemovedBeforeHydration.delete(id);
  await updateTrackedIdsList(async () => {
    trackedDownloadIds.add(id);
    try {
      const storageApi = chrome.storage?.session || chrome.storage?.local;
      if (storageApi?.get && storageApi?.set) {
        const data = await storageApi.get({ trackedDownloadIds: [] });
        const list = Array.isArray(data.trackedDownloadIds) ? data.trackedDownloadIds : [];
        if (!list.includes(id)) {
          list.push(id);
          await storageApi.set({ trackedDownloadIds: list });
        }
      }
    } catch (e) {
      console.warn('[Image Saver] Не удалось сохранить trackedDownloadIds:', e);
    }
  });
}

async function removeTrackedDownloadId(id) {
  if (id === undefined || id === null) return;
  trackedDownloadIds.delete(id);
  if (!trackedIdsHydrated) trackedIdsRemovedBeforeHydration.add(id);
  await updateTrackedIdsList(async () => {
    trackedDownloadIds.delete(id);
    try {
      const storageApi = chrome.storage?.session || chrome.storage?.local;
      if (storageApi?.get && storageApi?.set) {
        const data = await storageApi.get({ trackedDownloadIds: [] });
        const list = Array.isArray(data.trackedDownloadIds) ? data.trackedDownloadIds : [];
        const updated = list.filter(item => item !== id);
        await storageApi.set({ trackedDownloadIds: updated });
      }
    } catch (e) {
      console.warn('[Image Saver] Не удалось обновить trackedDownloadIds:', e);
    }
  });
}

async function isTrackedDownloadId(id) {
  if (id === undefined || id === null) return false;
  return updateTrackedIdsList(() => trackedDownloadIds.has(id));
}

async function getTrackedDownloadCount() {
  return updateTrackedIdsList(() => trackedDownloadIds.size);
}

async function setBadge(text, backgroundColor) {
  if (typeof chrome === 'undefined' || !chrome.action?.setBadgeText) return;
  try {
    if (flashBadgeTimeout) {
      clearTimeout(flashBadgeTimeout);
      flashBadgeTimeout = null;
    }
    await chrome.action.setBadgeText({ text });
    if (backgroundColor && chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ color: backgroundColor });
    }
  } catch (err) {
    console.warn('[Image Saver] Не удалось установить бейдж:', err);
  }
}

async function flashBadge(text, backgroundColor, durationMs = 2500) {
  if (typeof chrome === 'undefined' || !chrome.action?.setBadgeText) return;
  try {
    if (flashBadgeTimeout) {
      clearTimeout(flashBadgeTimeout);
      flashBadgeTimeout = null;
    }
    await chrome.action.setBadgeText({ text });
    if (backgroundColor && chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ color: backgroundColor });
    }

    flashBadgeTimeout = setTimeout(async () => {
      flashBadgeTimeout = null;
      await restoreOrClearBadge();
    }, durationMs);
  } catch (err) {
    console.warn('[Image Saver] Не удалось обновить бейдж:', err);
  }
}

async function restoreOrClearBadge() {
  if (typeof chrome === 'undefined' || !chrome.action?.setBadgeText) return;
  try {
    if (flashBadgeTimeout) {
      clearTimeout(flashBadgeTimeout);
      flashBadgeTimeout = null;
    }
    const trackedCount = await getTrackedDownloadCount();
    if (flashBadgeTimeout) return;
    if (activeResolvingCount > 0) {
      await chrome.action.setBadgeText({ text: '...' });
      if (chrome.action.setBadgeBackgroundColor) {
        await chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
      }
    } else if (trackedCount > 0) {
      await chrome.action.setBadgeText({ text: 'DL' });
      if (chrome.action.setBadgeBackgroundColor) {
        await chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
      }
    } else if ((await getUnseenFailureCount()) > 0) {
      // A failure the user has not looked at yet stays discoverable even without notifications.
      await chrome.action.setBadgeText({ text: '!' });
      if (chrome.action.setBadgeBackgroundColor) {
        await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      }
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {}
}

async function clearBadge() {
  await restoreOrClearBadge();
}

/**
 * Determines whether a context-menu click target has an actual media (image or video) association.
 * If rawImageUrl is absent, linkUrl must point to a direct media file or recognized media endpoint.
 */
function hasMediaAssociation(srcUrl, linkUrl) {
  if (srcUrl && typeof srcUrl === 'string' && srcUrl.trim()) {
    return true; // Clicked directly on media
  }
  if (!linkUrl || typeof linkUrl !== 'string' || !linkUrl.trim()) {
    return false; // Neither media nor link
  }
  try {
    const parsed = new URL(linkUrl);
    const pathname = parsed.pathname.toLowerCase();

    // 1. Direct image or video extension in link pathname
    if (/\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|mp4|webm|ogv|mov|m4v)$/i.test(pathname)) {
      return true;
    }

    // 2. Format / media MIME indicator in query params
    const queryFormat = parsed.searchParams.get('format') ||
                        parsed.searchParams.get('fm') ||
                        parsed.searchParams.get('ext') ||
                        parsed.searchParams.get('type') ||
                        parsed.searchParams.get('mime');
    if (queryFormat && /^(jpe?g|png|webp|gif|svg|avif|bmp|ico|pjpg|mp4|webm|ogv|mov|m4v|image\/|video\/)/i.test(queryFormat.trim())) {
      return true;
    }

    // 2b. Reddit video hosts (v.redd.it, packaged-media.redd.it) and media wrappers
    const host = parsed.hostname.toLowerCase();
    if (host === 'v.redd.it' || host === 'packaged-media.redd.it') {
      return true;
    }
    if (typeof isRedditDomain === 'function' && isRedditDomain(host) && pathname === '/media' && parsed.searchParams.has('url')) {
      return true;
    }

    // 2c. RedGIFs media routes
    if (typeof isAllowedRedGifsHost === 'function' && isAllowedRedGifsHost(host)) {
      if (/\/(?:watch|ifr|detail|gifs)\/([a-zA-Z0-9_-]+)/i.test(pathname)) {
        return true;
      }
    }

    // 3. Known direct media path segments (paheal, Paheal cdn, img/view, Paheal file_only, videos, etc.)
    const isDirectMediaLink = /\/(images?|original|data|_images|content|img\/view|uploads?|media|photos?|assets|pictures?|pictures\/get_image|videos?)\//i.test(pathname) ||
                              pathname.includes('file_only') ||
                              parsed.hostname.includes('paheal-cdn.net') ||
                              parsed.searchParams.has('imgurl') ||
                              parsed.searchParams.has('videourl');

    const isHtmlPage = /\.(html?|xhtml|php|asp|aspx)$/i.test(pathname) ||
                       /\/(post|posts|comment|comments|user|users|tag|tags|upload|thread|threads|forum|article|blog|artworks?|illust|about|contact|help|wiki)\//i.test(pathname);

    if (isDirectMediaLink && !isHtmlPage) {
      return true;
    }
  } catch (e) {}

  return false;
}

function hasImageAssociation(srcUrl, linkUrl) {
  return hasMediaAssociation(srcUrl, linkUrl);
}

function getFilenameFromUrl(url) {
  try {
    if (!url || typeof url !== 'string') {
      return `image_${Date.now()}.jpg`;
    }

    if (url.startsWith('data:')) {
      const mimeMatch = url.match(/^data:(image|video)\/([a-zA-Z0-9+]+);/);
      let ext = mimeMatch ? mimeMatch[2].toLowerCase() : 'png';
      if (ext === 'jpeg') ext = 'jpg';
      const prefix = mimeMatch && mimeMatch[1] === 'video' ? 'video_' : 'image_';
      return `${prefix}${Date.now()}.${ext}`;
    }

    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname || '';
    const lastSlash = pathname.lastIndexOf('/');
    let rawSegment = lastSlash !== -1 ? pathname.substring(lastSlash + 1) : pathname;
    try {
      rawSegment = decodeURIComponent(rawSegment);
    } catch (_) {}

    // Separate base name and extension from URL pathname
    const extMatch = rawSegment.match(/\.([a-zA-Z0-9]+)$/);
    let base = '';
    let ext = '';

    if (extMatch) {
      ext = extMatch[1].toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
      base = rawSegment.substring(0, extMatch.index);
    } else {
      base = rawSegment;
      // Detect extension from query params (e.g. format=webp, fm=png, ext=jpg, mime=image/jpeg)
      const queryFormat = parsedUrl.searchParams.get('format') ||
                          parsedUrl.searchParams.get('fm') ||
                          parsedUrl.searchParams.get('ext') ||
                          parsedUrl.searchParams.get('type') ||
                          parsedUrl.searchParams.get('mime');
      if (queryFormat) {
        const cleanFmt = queryFormat.toLowerCase().replace(/^(image|video)\//, '').trim();
        if (/^(jpe?g|png|webp|gif|svg|avif|bmp|ico|pjpg|mp4|webm|ogv|mov|m4v)$/i.test(cleanFmt)) {
          ext = (cleanFmt === 'jpeg' || cleanFmt === 'pjpg') ? 'jpg' : cleanFmt;
        }
      }
      if (!ext) {
        ext = 'jpg';
      }
    }

    // 3. Sanitize Windows-invalid characters (< > : " / \ | ? * and control characters, DEL and C1 included); format characters and
    // noncharacters, which chrome.downloads refuses anywhere in a name (lib/folder_path.js INVISIBLE), are removed
    base = base.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').replace(FolderPath.INVISIBLE, '');

    // 4. No spaces, dots or '~' at either end (Windows filesystem restriction; chrome.downloads refuses such a name)
    base = base.replace(/^[\s.~]+|[\s.~]+$/g, '');

    // 5. Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, CLOCK$), also when followed by further dots (NUL.tar.gz is
    // NUL): the part before the first dot decides, as in lib/folder_path.js
    const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)$/i;
    if (WINDOWS_RESERVED.test(base.split('.')[0].trim())) {
      base = `_${base}`;
    }

    const isVideoExt = ['mp4', 'webm', 'ogv', 'mov', 'm4v'].includes(ext);

    // 6. Preserve useful resource IDs vs. generic timestamp
    if (!base) {
      base = isVideoExt ? `video_${Date.now()}` : `image_${Date.now()}`;
    }

    // 7. Enforce safe filename length (limit base name to 120 chars to prevent NTFS/MAX_PATH issues)
    const MAX_BASE_LENGTH = 120;
    if (base.length > MAX_BASE_LENGTH) {
      base = base.substring(0, MAX_BASE_LENGTH);
      // Strip any trailing lone high surrogate to preserve Unicode integrity
      base = base.replace(/[\uD800-\uDBFF]$/, '');
      base = base.replace(/[\s.~]+$/, '');
      if (!base) {
        base = isVideoExt ? `video_${Date.now()}` : `image_${Date.now()}`;
      }
    }

    // 8. On Windows a name that could be an 8.3 short name must not contain '~'
    if (FolderPath.isTildeShortName(`${base}.${ext}`)) base = base.replace(/~/g, '_');

    return `${base}.${ext}`;
  } catch (err) {
    console.warn('[Image Saver] Не удалось разобрать имя файла из URL:', err);
    return `image_${Date.now()}.jpg`;
  }
}

// ============================================================================
// 9.0. Download feedback (UX-02 / UX-04): operation tracker, notifications, details messages
// ============================================================================
// Logic lives in lib/feedback.js (pure) and lib/feedback_tracker.js (injected Chrome APIs).
// Every hook below is best-effort: a feedback, storage or notification failure must never
// abort, duplicate or change a download.

var feedbackTracker = null;
const FEEDBACK_DETAILS_PAGE = 'popup/popup.html'; // full extension page (UX-05); #history opens the history section

function feedbackStorageArea() {
  return chrome.storage?.session || chrome.storage?.local || null;
}

async function feedbackNotifyRecord(record) {
  return feedbackNotifier(record);
}

var feedbackNotifier = (typeof globalThis.ImageSaverFeedbackTracker?.createNotifier === 'function')
  ? globalThis.ImageSaverFeedbackTracker.createNotifier({
      notifications: typeof chrome !== 'undefined' ? chrome.notifications : null,
      iconUrl: 'icons/notification.png',
      autoClearMs: 8000,
      getPrefs: () => chrome.storage.local.get({ notifySuccess: true }),
      log: (...args) => console.warn('[Image Saver] feedback:', ...args)
    })
  : async () => false;

// UX-03: bounded local history (chrome.storage.local, 50 entries / 30 days), recorded from terminal operations only.
var feedbackHistory = (typeof globalThis.ImageSaverFeedbackHistory?.createHistory === 'function' && typeof chrome !== 'undefined' && chrome.storage?.local)
  ? globalThis.ImageSaverFeedbackHistory.createHistory({
      storage: {
        get: async (key) => (await chrome.storage.local.get(key))?.[key] ?? null,
        set: (key, value) => chrome.storage.local.set({ [key]: value })
      },
      isEnabled: async () => (await chrome.storage.local.get({ [globalThis.ImageSaverFeedbackHistory.ENABLED_KEY]: false }))[globalThis.ImageSaverFeedbackHistory.ENABLED_KEY],
      log: (...args) => console.warn('[Image Saver] history:', ...args)
    })
  : null;
// Persistent retention cleanup at service-worker start (also runs on every list/record); best effort.
if (feedbackHistory) feedbackHistory.prune().catch(() => {});

if (typeof globalThis.ImageSaverFeedbackTracker?.createTracker === 'function') {
  feedbackTracker =globalThis.ImageSaverFeedbackTracker.createTracker({
    storage: {
      get: async (key) => {
        const area = feedbackStorageArea();
        if (!area) return null;
        const data = await area.get(key);
        return data ? data[key] : null;
      },
      set: async (key, value) => {
        const area = feedbackStorageArea();
        if (area) await area.set({ [key]: value });
      }
    },
    genId: () => `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    getDownloadItem: async (id) => {
      // Only extension-owned download IDs are ever looked up (never a query over user history).
      if (!chrome.downloads?.search) return undefined;
      const items = await chrome.downloads.search({ id });
      return Array.isArray(items) && items.length ? items[0] : null;
    },
    peekEarlyTerminal: (id) => earlyTerminalDownloadStates.get(id),
    notify: feedbackNotifyRecord,
    onFinished: (record) => (feedbackHistory ? feedbackHistory.record(record) : false),
    onChange: () => { if (!flashBadgeTimeout) restoreOrClearBadge(); },
    log: (...args) => console.warn('[Image Saver] feedback:', ...args)
  });
}

/** Unseen failed/interrupted operations, read from the same session storage the tracker persists to. */
async function getUnseenFailureCount() {
  try {
    const area = feedbackStorageArea();
    const key = globalThis.ImageSaverFeedbackTracker?.STORAGE_KEY;
    if (!area || !key) return 0;
    const stored = (await area.get(key))?.[key];
    const ops = Array.isArray(stored?.ops) ? stored.ops : [];
    return ops.map(FeedbackLib.sanitizeRecord).filter((r) => r && !r.seen && (r.state === 'failed' || r.state === 'interrupted')).length;
  } catch (_) {
    return 0;
  }
}

async function fbBegin(info) {
  try { return feedbackTracker ? await feedbackTracker.begin(info) : null; } catch (_) { return null; }
}
async function fbSetPost(op, url) {
  if (!op || !feedbackTracker) return;
  try { await feedbackTracker.setPost(op, url); } catch (_) {}
}
async function fbStage(op, state, patch) {
  if (!op || !feedbackTracker) return;
  try { await feedbackTracker.stage(op, state, patch); } catch (_) {}
}
async function fbFail(op, info) {
  if (!op || !feedbackTracker) return;
  try { await feedbackTracker.fail(op, info); } catch (_) {}
}
async function fbCancel(op) {
  if (!op || !feedbackTracker) return;
  try { await feedbackTracker.cancel(op); } catch (_) {}
}
async function fbDiscard(op) {
  if (!op || !feedbackTracker) return;
  try { await feedbackTracker.discard(op); } catch (_) {}
}
async function fbAttach(op, downloadId, patch) {
  if (!op || !feedbackTracker) return;
  try { await feedbackTracker.attachDownload(op, downloadId, patch); } catch (_) {}
}
async function fbDownloadTerminal(downloadId, state, errorCode) {
  if (!feedbackTracker) return;
  try { await feedbackTracker.downloadTerminal(downloadId, state, errorCode); } catch (_) {}
}

/** First candidate that is an allowed numeric status actually observed by the pipeline, else null. */
function fbStatusIn(candidates, allowed) {
  for (const c of candidates) {
    if (Number.isInteger(c) && allowed.includes(c)) return c;
  }
  return null;
}

function fbSiteOf(pageUrl, sourceUrl) {
  try {
    return determineOwningWebsite({ pageUrl: pageUrl || '', resolvedUrl: sourceUrl || '' });
  } catch (_) {
    return '';
  }
}

/**
 * Handler-scoped replacement for flashBadge: forwards to the real badge and records the failure
 * of this operation (AUTH/RATE/ERR). 'OK' is never success: only a completed download is.
 */
function fbBadgeReporter(op) {
  return async (text, color, durationMs) => {
    if (op && (text === 'ERR' || text === 'AUTH' || text === 'RATE')) {
      await fbFail(op, { code: text === 'AUTH' ? 'AUTH_REQUIRED' : (text === 'RATE' ? 'RATE_LIMIT' : '') });
    }
    return flashBadge(text, color, durationMs);
  };
}

/** Settles an operation from the structured result of executeMediaPlan (no status is invented). */
async function fbSettleFromResult(op, result) {
  if (!op || !result) return;
  if (result.cancelled) {
    await fbCancel(op);
  } else if (result.success === false) {
    const code = result.error;
    await fbFail(op, {
      stage: code === 'INVALID_PLAN' || code === 'HTML_PAGE' || code === 'UNRESOLVED_BLOB_MEDIA' ? 'resolve' : 'verify',
      code,
      status: (code === 'AUTH_REQUIRED' || code === 'RATE_LIMIT') ? fbStatusIn([result.status], [401, 403, 429]) : null
    });
  }
}

/** Evidence about the file actually being saved. A filename extension alone is only ever a hint. */
function buildFeedbackOutput({ finalPath, structuredResult, group, isFallback = false }) {
  const ext = FeedbackLib.extensionOf(finalPath);
  const mime = String(structuredResult?.normalizedMime || '').split(';')[0].trim().toLowerCase();
  const mimeType = getMediaTypeFromMime(mime);
  const evidence = group?.metadata?.mimeEvidence;
  const verified = !isFallback && Boolean(mime) && (
    group?.transport === 'protectedBlob' ||
    group?.transport === 'pixivDataUrl' ||
    evidence === MIME_EVIDENCE.HTTP_RESPONSE ||
    evidence === MIME_EVIDENCE.PROTECTED_FETCH
  );
  const out = { type: 'unknown', ext, evidence: 'unknown', mime: '' };
  if (verified && ['gif', 'video', 'pic'].includes(mimeType)) {
    out.type = mimeType;
    out.evidence = 'verified_mime';
    out.mime = mime;
  } else if (!verified || mimeType === '') {
    const hinted = determineFinalMediaType({ resolvedExtension: ext });
    if (hinted !== 'unknown-type') {
      out.type = hinted;
      out.evidence = 'filename_hint';
    }
  }
  if (!isFallback) {
    const measured = structuredResult?.blobUrl && Number(structuredResult.size) > 0;
    const header = Number(group?.metadata?.contentLength) > 0;
    if (measured) { out.sizeBytes = Number(structuredResult.size); out.sizeKind = 'measured'; }
    else if (header) { out.sizeBytes = Number(group.metadata.contentLength); out.sizeKind = 'estimated'; }
    if (Number(group?.metadata?.durationSec) > 0) out.durationSec = Number(group.metadata.durationSec);
    if (group?.metadata?.reason) out.reason = group.metadata.reason;
    if (Number(group?.metadata?.thresholdSec) > 0) out.thresholdSec = Number(group.metadata.thresholdSec);
  }
  return out;
}

// Messages from extension pages only (popup/details): list, mark seen, clear finished.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message?.action;
    const isHistory = action === 'HISTORY_LIST' || action === 'HISTORY_CLEAR';
    if (action !== 'FEEDBACK_LIST' && action !== 'FEEDBACK_MARK_SEEN' && action !== 'FEEDBACK_CLEAR' && !isHistory) return false;
    const base = chrome.runtime.getURL('');
    if (isHistory) {
      if (!feedbackHistory || sender?.id !== chrome.runtime.id || typeof sender?.url !== 'string' || !sender.url.startsWith(base)) {
        sendResponse({ success: false, error: 'FORBIDDEN' });
        return false;
      }
      (async () => {
        try {
          if (action === 'HISTORY_CLEAR') await feedbackHistory.clear();
          const listed = await feedbackHistory.list();
          sendResponse({ success: true, records: listed.entries, pruneFailed: listed.pruneFailed });
        } catch (_) {
          sendResponse({ success: false, error: 'HISTORY_UNAVAILABLE' });
        }
      })();
      return true;
    }
    if (!feedbackTracker || sender?.id !== chrome.runtime.id || typeof sender?.url !== 'string' || !sender.url.startsWith(base)) {
      sendResponse({ success: false, error: 'FORBIDDEN' });
      return false;
    }
    (async () => {
      try {
        if (action === 'FEEDBACK_MARK_SEEN') {
          const rawIds = message?.ids;
          if (Array.isArray(rawIds) && rawIds.length > 0) {
            const maxOps = FeedbackLib?.LIMITS?.maxOps || 50;
            const validIds = [];
            for (const id of rawIds) {
              if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
                validIds.push(id);
                if (validIds.length >= maxOps) break;
              }
            }
            if (validIds.length > 0) {
              await feedbackTracker.markSeen(validIds);
            }
          }
        } else if (action === 'FEEDBACK_CLEAR') await feedbackTracker.clearFinished();
        sendResponse({ success: true, records: await feedbackTracker.list() });
      } catch (_) {
        sendResponse({ success: false, error: 'FEEDBACK_UNAVAILABLE' });
      }
    })();
    return true;
  });
}

// Notification click is an explicit user action: failures open the details page, successes reveal the file.
if (typeof chrome !== 'undefined' && chrome.notifications?.onClicked?.addListener) {
  chrome.notifications.onClicked.addListener(async (notificationId) => {
    try {
      const prefix = globalThis.ImageSaverFeedbackTracker.NOTIFY_PREFIX;
      if (typeof notificationId !== 'string' || !notificationId.startsWith(prefix) || !feedbackTracker) return;
      const id = notificationId.slice(prefix.length);
      const rec = await feedbackTracker.get(id);
      if (!rec) return;
      if (rec.state === 'complete' && Number.isInteger(rec.downloadId) && chrome.downloads?.show) {
        chrome.downloads.show(rec.downloadId);
      } else if (chrome.tabs?.create) {
        await chrome.tabs.create({ url: chrome.runtime.getURL(`${FEEDBACK_DETAILS_PAGE}?op=${encodeURIComponent(id)}#history`) });
      }
      chrome.notifications.clear?.(notificationId);
    } catch (_) {}
  });
}

// ============================================================================
// 9.1. Download Lifecycle Tracker: state monitoring via onChanged
// ============================================================================

const activeDownloadsMetadata = new Map();

// Subscribe to chrome.downloads.onChanged to track state transitions
if (typeof chrome !== 'undefined' && chrome.downloads?.onChanged?.addListener) {
  chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta || !delta.id) return;

    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
      await fbDownloadTerminal(delta.id, delta.state.current, delta.error?.current || delta.error || '');
    }

    const sessionKey = `active_dl_blob_${delta.id}`;
    let hasInSession = false;
    if (chrome.storage?.session) {
      try {
        const sessionData = await chrome.storage.session.get(sessionKey);
        hasInSession = Boolean(sessionData && sessionData[sessionKey]);
      } catch (_) {}
    }

    const isTerminal = delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted');
    const isTracked = (await isTrackedDownloadId(delta.id)) || activeProtectedBlobsByDownloadId.has(delta.id) || hasInSession;

    if (isTracked) {
      earlyTerminalDownloadStates.delete(delta.id);
      if (delta.state && delta.state.current === 'complete') {
        await untrackDownloadProtectedBlob(delta.id);
        await removeTrackedDownloadId(delta.id);
        activeDownloadsMetadata.delete(delta.id);
        console.log(`[Image Saver] Загрузка ${delta.id} успешно завершена`);
        await flashBadge('OK', '#22c55e');
        if (activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
          await closeOffscreenDocument().catch(() => {});
        }
      } else if (delta.state && delta.state.current === 'interrupted') {
        await untrackDownloadProtectedBlob(delta.id);
        await removeTrackedDownloadId(delta.id);
        const meta = activeDownloadsMetadata.get(delta.id);
        activeDownloadsMetadata.delete(delta.id);
        const errorCode = delta.error?.current || delta.error;
        if (errorCode === 'USER_CANCELED') {
          console.log(`[Image Saver] Загрузка ${delta.id} отменена пользователем (USER_CANCELED)`);
          await restoreOrClearBadge();
        } else if (errorCode === 'SERVER_FORBIDDEN' || errorCode === 'SERVER_UNAUTHORIZED') {
          if (isRedditHostedMediaUrl(meta?.url)) {
            console.warn(`[Image Saver] Reddit video requires an active Reddit session (${errorCode}):`, sanitizeUrlForLog(meta.url));
            await flashBadge('AUTH', '#f59e0b');
          } else {
            console.error(`[Image Saver] Загрузка ${delta.id} прервана (${errorCode}):`, sanitizeUrlForLog(meta?.url || ''));
            await flashBadge('ERR', '#ef4444');
          }
        } else {
          console.error(`[Image Saver] Загрузка ${delta.id} прервана с ошибкой:`, errorCode || 'interrupted');
          await flashBadge('ERR', '#ef4444');
        }
        if (activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
          await closeOffscreenDocument().catch(() => {});
        }
      }
    } else if (isTerminal) {
      // Early terminal event arriving before registration
      earlyTerminalDownloadStates.set(delta.id, {
        state: delta.state.current,
        errorCode: delta.error?.current || delta.error || null,
        timestamp: Date.now()
      });
      if (earlyTerminalDownloadStates.size > 200) {
        const oldestKey = earlyTerminalDownloadStates.keys().next().value;
        earlyTerminalDownloadStates.delete(oldestKey);
      }
    }
  });
}

// ============================================================================
// 9.2. Pixiv-Specific Download Path (download mechanism modeled after Pixiv Toolkit)
// ============================================================================

/**
 * Downloads image from i.pximg.net via fetch() in extension context with Referer injection (DNR),
 * reads response into a binary buffer, and converts it into a local Data URL.
 * This resolves the HTTP 403 (SERVER_FORBIDDEN) issue in chrome.downloads.download,
 * as the download manager saves pre-fetched data locally without a secondary external network request.
 */
async function fetchPixivImageAsDataUrl(targetImageUrl) {
  console.log('[Image Saver] [Pixiv Download Path] Загрузка изображения через fetch:', targetImageUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  let response;
  try {
    response = await fetch(targetImageUrl, {
      method: 'GET',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Pixiv fetch failed with HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const arrayBuffer = await response.arrayBuffer();

  // Convert ArrayBuffer to Base64 Data URL in 32KB chunks to prevent call stack overflow
  const bytes = new Uint8Array(arrayBuffer);
  let base64 = '';
  if (typeof btoa === 'function') {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    base64 = btoa(binary);
  } else if (typeof Buffer !== 'undefined') {
    base64 = Buffer.from(bytes).toString('base64');
  }

  console.log(`[Image Saver] [Pixiv Download Path] Изображение успешно получено в память (${bytes.length} байт, ${contentType})`);
  return `data:${contentType};base64,${base64}`;
}

// ============================================================================
// 10. Context menu click handling & media download execution
// ============================================================================

/**
 * Resolves canonical numeric HTTP status code with strict structured precedence.
 * Only falls back to narrow textual status parsing when structured status is absent/0.
 * Rejects incidental numbers in diagnostic text (e.g. durations, IDs, reference numbers).
 */
function resolveCandidateHttpStatus(rawStatus, errorText) {
  if (typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus > 0) {
    return rawStatus;
  }
  if (typeof errorText === 'string' && errorText) {
    const match = errorText.match(/\b(?:HTTP(?:\s+status|\s+error)?|status(?:\s*code)?)\s*[:=]?\s*(\d{3})\b/i);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (parsed >= 100 && parsed <= 599) {
        return parsed;
      }
    }
  }
  return 0;
}

/**
 * Checks whether two candidate URLs positively reference the same underlying media resource.
 * Matches identical URLs or identical origin and pathname.
 */
function isSameMediaCandidateUrl(urlA, urlB) {
  if (!urlA || !urlB || typeof urlA !== 'string' || typeof urlB !== 'string') return false;
  if (urlA === urlB) return true;
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    if (a.origin === b.origin && a.pathname.toLowerCase() === b.pathname.toLowerCase()) {
      return true;
    }
  } catch (e) {}
  return false;
}

if (typeof globalThis !== 'undefined') {
  globalThis.resolveCandidateHttpStatus = resolveCandidateHttpStatus;
  globalThis.isSameMediaCandidateUrl = isSameMediaCandidateUrl;
}

/**
 * A download can reach a terminal state before the handler that started it has registered it: chrome.downloads.onChanged then only
 * recorded the state in earlyTerminalDownloadStates. Every save path calls this right after it registered the download, so such a
 * download is settled exactly as its event would have settled a registered one (untracked, badge, Blob owner released) instead of
 * staying tracked and shown as running, because no later event will ever arrive for it.
 */
async function settleEarlyTerminalDownload(downloadId) {
  const earlyTerminal = earlyTerminalDownloadStates.get(downloadId);
  if (!earlyTerminal) return false;
  earlyTerminalDownloadStates.delete(downloadId);
  await untrackDownloadProtectedBlob(downloadId);
  await removeTrackedDownloadId(downloadId);
  activeDownloadsMetadata.delete(downloadId);
  if (earlyTerminal.state === 'complete') {
    console.log(`[Image Saver] Загрузка ${downloadId} успешно завершена (early)`);
    await flashBadge('OK', '#22c55e');
  } else if (earlyTerminal.errorCode === 'USER_CANCELED') {
    await restoreOrClearBadge();
  } else {
    await flashBadge('ERR', '#ef4444');
  }
  if (activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
    await closeOffscreenDocument().catch(() => {});
  }
  return true;
}

/**
 * Generic executor for candidate group resolution plans.
 * Iterates through variants according to group's variantPolicy.
 * Employs structured validation result and canonical MIME filename generation.
 */
async function executeMediaPlan(plan, settings = {}, rawImageUrl = '', options = {}) {
  const group = plan?.isCandidateGroup ? plan : adaptCandidateToGroup(plan);
  if (!group || !Array.isArray(group.variants) || group.variants.length === 0) {
    console.warn('[Image Saver] executeMediaPlan: Недопустимый план или отсутствуют варианты:', plan);
    await flashBadge('ERR', '#ef4444');
    return { success: false, error: 'INVALID_PLAN', status: 400 };
  }

  const primaryUrl = group.primaryUrl;
  if (!rawImageUrl) {
    rawImageUrl = primaryUrl;
  }

  // Guard: Never download a web page as an image/media file (e.g. artwork page)
  const isHtmlPage = (function(url) {
    if (!url) return true;
    try {
      const u = new URL(url);
      const p = u.pathname.toLowerCase();
      const h = u.hostname.toLowerCase();
      if (h.includes('pixiv.net') && (p.includes('/artworks/') || p.includes('/illust'))) return true;
      if (/\.(html?|xhtml|php|asp|aspx)$/i.test(p) && !p.includes('image') && !p.includes('download')) return true;
    } catch (e) {}
    return false;
  })(primaryUrl);

  if (isHtmlPage) {
    console.warn('[Image Saver] Отмена: целевой URL является веб-страницей (HTML), а не файлом медиа:', primaryUrl);
    await flashBadge('ERR', '#ef4444');
    return { success: false, error: 'HTML_PAGE', status: 400 };
  }

  const variantPolicy = group.variantPolicy || {};
  const advanceOnCodes = new Set(variantPolicy.advanceOn || [404, 410]);

  let structuredResult = null;
  let protectedBlobUrl = null;
  let protectedOwnerKey = null;

  // Positive association validation for reused protected Blob:
  let validReusedBlob = null;
  if (group.transport === 'protectedBlob') {
    const candidateReusedBlob = options?.verifiedBlob || group.verifiedBlob || plan?.verifiedBlob;
    if (candidateReusedBlob && candidateReusedBlob.blobUrl) {
      const blobUrlIdentity = typeof candidateReusedBlob.url === 'string' ? candidateReusedBlob.url.trim() : '';
      const matchingVariantIndex = blobUrlIdentity
        ? group.variants.findIndex(v => isSameMediaCandidateUrl(v.url, blobUrlIdentity))
        : -1;

      if (matchingVariantIndex !== -1) {
        validReusedBlob = candidateReusedBlob;
        validReusedBlob._matchingIndex = matchingVariantIndex;
      } else {
        // Missing or mismatching identity: strictly reject foreign or unassociated Blob and clean up its resources safely.
        console.warn('[Image Saver] Отклонение verifiedBlob из-за отсутствия положительной связи с вариантами плана:', sanitizeUrlForLog(blobUrlIdentity || '(empty)'));
        if (candidateReusedBlob.probeTaskKey || candidateReusedBlob.blobUrl) {
          await releaseOffscreenTask(candidateReusedBlob.probeTaskKey, candidateReusedBlob.blobUrl).catch(() => {});
          delete candidateReusedBlob.probeTaskKey;
          delete candidateReusedBlob.blobUrl;
        }
      }
    }
  }

  for (let i = 0; i < group.variants.length; i++) {
    const variant = group.variants[i];
    const targetUrl = variant.url;
    console.log(`[Image Saver] Выполнение варианта [${i + 1}/${group.variants.length}] (${group.transport}):`, sanitizeUrlForLog(targetUrl));

    if (group.transport === 'protectedBlob') {
      if (validReusedBlob) {
        if (i !== validReusedBlob._matchingIndex) {
          continue; // Skip earlier variants to reach the positively associated variant
        }

        const normalizedMime = (validReusedBlob.contentType || group.metadata?.contentType || '').split(';')[0].trim().toLowerCase();
        const resolvedExtension = resolveCanonicalExtension(normalizedMime, variant.expectedExtension || targetUrl);

        structuredResult = {
          success: true,
          blobUrl: validReusedBlob.blobUrl,
          resolvedUrl: targetUrl,
          normalizedMime,
          resolvedExtension,
          size: validReusedBlob.size || 0,
          status: 200
        };
        protectedBlobUrl = validReusedBlob.blobUrl;
        protectedOwnerKey = validReusedBlob.probeTaskKey;
        activeOffscreenOwners.set(protectedOwnerKey, protectedBlobUrl);
        delete validReusedBlob.probeTaskKey;
        delete validReusedBlob.blobUrl;
        break; // Reused verified blob without duplicate fetch!
      }

      const variantKey = acquireOffscreenTask(`variant_${i}_${targetUrl}`);
      try {
        await ensureOffscreenDocument();
        const hostInfo = getProtectedHostInfo(targetUrl);
        const isGelbooru = hostInfo?.type === 'gelbooru';
        const action = isGelbooru ? 'FETCH_GELBOORU_BLOB' : 'FETCH_PROTECTED_BLOB';

        const fetchResult = await chrome.runtime.sendMessage({
          action,
          url: targetUrl
        });

        if (fetchResult && fetchResult.success && fetchResult.blobUrl) {
          const rawContentType = fetchResult.contentType || '';
          const normalizedMime = rawContentType.split(';')[0].trim().toLowerCase();
          const resolvedExtension = resolveCanonicalExtension(normalizedMime, variant.expectedExtension || targetUrl);

          structuredResult = {
            success: true,
            blobUrl: fetchResult.blobUrl,
            resolvedUrl: targetUrl,
            normalizedMime,
            resolvedExtension,
            size: fetchResult.size || 0,
            status: fetchResult.status || 200
          };
          protectedBlobUrl = fetchResult.blobUrl;
          protectedOwnerKey = variantKey;
          activeOffscreenOwners.set(variantKey, protectedBlobUrl);
          break; // First successful variant!
        }

        // Failed variant attempt
        await releaseOffscreenTask(variantKey);
        const status = resolveCandidateHttpStatus(fetchResult?.status, fetchResult?.error);
        const errMsg = fetchResult?.error || (status ? `HTTP ${status}` : 'Protected fetch failed');

        // Check if advanceable (404, 410)
        if (advanceOnCodes.has(status)) {
          console.warn(`[Image Saver] Вариант вернул HTTP ${status}, переход к следующему варианту:`, sanitizeUrlForLog(targetUrl));
          continue;
        }

        // Non-advanceable error! Stop entire operation!
        console.error(`[Image Saver] Критическая ошибка варианта (status: ${status}):`, errMsg);

        if (status === 401 || status === 403) {
          await flashBadge('AUTH', '#f59e0b');
          return { success: false, error: 'AUTH_REQUIRED', status: status || 403 };
        } else if (status === 429) {
          await flashBadge('RATE', '#f59e0b');
          return { success: false, error: 'RATE_LIMIT', status: 429 };
        } else {
          await flashBadge('ERR', '#ef4444');
          return { success: false, error: errMsg, status: status || 500 };
        }
      } catch (err) {
        await releaseOffscreenTask(variantKey);
        console.error('[Image Saver] Исключение при выполнении варианта:', err);
        const status = resolveCandidateHttpStatus(err?.status, err?.message);
        const errMsg = err?.message || 'VARIANT_ERROR';
        if (advanceOnCodes.has(status)) {
          console.warn(`[Image Saver] Исключение варианта с переходящим статусом HTTP ${status}, переход к следующему варианту:`, sanitizeUrlForLog(targetUrl));
          continue;
        }
        if (status === 401 || status === 403) {
          await flashBadge('AUTH', '#f59e0b');
          return { success: false, error: 'AUTH_REQUIRED', status: status || 403 };
        } else if (status === 429) {
          await flashBadge('RATE', '#f59e0b');
          return { success: false, error: 'RATE_LIMIT', status: 429 };
        } else {
          await flashBadge('ERR', '#ef4444');
          return { success: false, error: errMsg, status: status || 500 };
        }
      }
    } else if (group.transport === 'pixivDataUrl') {
      try {
        const dataUrl = await fetchPixivImageAsDataUrl(targetUrl);
        const mimeMatch = dataUrl.match(/^data:([^;]+);/);
        const normalizedMime = mimeMatch ? mimeMatch[1].toLowerCase() : 'image/jpeg';
        const resolvedExtension = resolveCanonicalExtension(normalizedMime, variant.expectedExtension || targetUrl);

        structuredResult = {
          success: true,
          blobUrl: null,
          dataUrl,
          resolvedUrl: targetUrl,
          normalizedMime,
          resolvedExtension,
          size: 0,
          status: 200
        };
        break;
      } catch (pixivErr) {
        console.error('[Image Saver] Ошибка Pixiv fetch:', pixivErr);
        await flashBadge('ERR', '#ef4444');
        return { success: false, error: pixivErr.message, status: pixivErr.status || 500 };
      }
    } else {
      // Direct transport: central canonical filename policy
      const normalizedMime = (group.metadata?.contentType || '').split(';')[0].trim().toLowerCase();
      let resolvedExtension = resolveCanonicalExtension(normalizedMime, variant.expectedExtension || targetUrl);
      if (normalizedMime.startsWith('video/') && resolvedExtension === '.gif') {
        resolvedExtension = resolveCanonicalExtension(normalizedMime, targetUrl) || '.mp4';
      }

      structuredResult = {
        success: true,
        blobUrl: null,
        resolvedUrl: targetUrl,
        normalizedMime,
        resolvedExtension,
        size: group.metadata?.contentLength || 0,
        status: 200
      };
      break;
    }
  }

  // If no variant succeeded:
  if (!structuredResult || !structuredResult.success) {
    if (activeOffscreenTasks === 0) {
      await closeOffscreenDocument().catch(() => {});
    }
    console.warn('[Image Saver] Все варианты логической группы отклонены (404/410 NOT_FOUND):', sanitizeGroupIdForLog(group.id));
    await flashBadge('ERR', '#ef4444');
    return {
      success: false,
      error: 'NOT_FOUND',
      status: 404
    };
  }

  // Canonical filename built using actual resolved variant and MIME
  const subfolder = getConfiguredRoot(settings);
  const finalPath = buildFinalFilename(
    structuredResult.resolvedUrl,
    structuredResult.resolvedExtension,
    subfolder,
    {
      folderOrganizationMode: settings.folderOrganizationMode,
      pageUrl: options?.pageUrl || group?.pageUrl || '',
      group,
      structuredResult
    }
  );

  const downloadSourceUrl = structuredResult.blobUrl || structuredResult.dataUrl || structuredResult.resolvedUrl;

  console.log('[Image Saver] Запуск основного скачивания целевого медиа:', sanitizeUrlForLog({
    url: structuredResult.resolvedUrl,
    downloadSourceUrl: structuredResult.blobUrl ? '(blob URL)' : structuredResult.resolvedUrl,
    filename: finalPath,
    saveAs: false
  }));

  let downloadStarted = false;
  let downloadId = null;
  try {
    const downloadOptions = {
      url: downloadSourceUrl,
      filename: finalPath,
      saveAs: false
    };
    delete downloadOptions.headers;

    if (typeof options?.checkCancelled === 'function' && (await options.checkCancelled())) {
      throw new Error('JOB_CANCELLED_OR_EXPIRED');
    }

    downloadId = await new Promise((resolve, reject) => {
      let settled = false;
      let ret;
      try {
        ret = chrome.downloads.download(downloadOptions, (id) => {
          if (settled) return;
          settled = true;
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) {
            console.error('[Image Saver] Ошибка chrome.downloads.download:', lastErr.message);
            reject(new Error(lastErr.message));
          } else if (id === undefined) {
            console.error('[Image Saver] chrome.downloads.download вернул undefined');
            reject(new Error('chrome.downloads.download returned undefined downloadId'));
          } else {
            resolve(id);
          }
        });
      } catch (syncErr) {
        if (!settled) {
          settled = true;
          console.error('[Image Saver] Исключение при chrome.downloads.download:', syncErr);
          reject(syncErr);
        }
        return;
      }
      if (ret && typeof ret.then === 'function') {
        ret.then(
          (id) => { if (!settled) { settled = true; resolve(id); } },
          (promiseErr) => {
            if (!settled) {
              settled = true;
              console.error('[Image Saver] Ошибка chrome.downloads.download (Promise):', promiseErr);
              reject(promiseErr);
            }
          }
        );
      }
    });

    downloadStarted = true;
    activeDownloadsMetadata.set(downloadId, {
      url: structuredResult.resolvedUrl,
      rawUrl: rawImageUrl || structuredResult.resolvedUrl,
      plan: group
    });
    await fbAttach(options?.feedbackOp, downloadId, { filename: finalPath, output: buildFeedbackOutput({ finalPath, structuredResult, group }) });

    if (protectedBlobUrl) {
      const newOwnerKey = `protected_${downloadId}`;
      if (protectedOwnerKey && protectedOwnerKey !== newOwnerKey) {
        transferOffscreenTask(protectedOwnerKey, newOwnerKey, protectedBlobUrl);
      }
      await trackDownloadProtectedBlob(downloadId, protectedBlobUrl, newOwnerKey);
    }

    await addTrackedDownloadId(downloadId);
    await setBadge('DL', '#3b82f6');

    await settleEarlyTerminalDownload(downloadId);

    return {
      ...structuredResult,
      downloadId,
      filename: finalPath
    };
  } catch (primaryDownloadError) {
    if (protectedBlobUrl && !downloadStarted) {
      await releaseOffscreenTask(protectedOwnerKey || (downloadId ? `protected_${downloadId}` : null), protectedBlobUrl);
    }

    if (primaryDownloadError?.message?.includes('User cancelled') || primaryDownloadError?.message?.includes('user cancelled')) {
      console.log('[Image Saver] Пользователь отменил выбор файла в системном диалоге сохранения');
      return { success: false, cancelled: true };
    }

    const isVideo = Boolean(
      (structuredResult?.normalizedMime && structuredResult.normalizedMime.startsWith('video/')) ||
      /\.(mp4|webm)($|\?)/i.test(structuredResult?.resolvedUrl || '') ||
      Boolean(group?.allowVideo) ||
      Boolean(plan?.allowVideo) ||
      Boolean(group?.metadata?.isVideo)
    );

    const isRawThumbnail = Boolean(
      isThumbnailUrl(rawImageUrl) ||
      /\/+(180x180|preview|thumbnails?|samples?|thumb)\/+/i.test(rawImageUrl)
    );

    const isAuthoritativeOriginal = Boolean(
      group?.tier === 'original' ||
      group?.isBooruCandidate ||
      group?.source === 'specialized_provider' ||
      group?.verified
    );

    const disallowEmergencyFallback = Boolean(
      options?.disallowFallback ||
      protectedBlobUrl ||
      isVideo ||
      (isAuthoritativeOriginal && isRawThumbnail) ||
      (group?.tier === 'original' && group?.source !== 'initial_src')
    );

    if (disallowEmergencyFallback) {
      console.warn('[Image Saver] Сбой загрузки оригинального медиа, аварийный fallback запрещен:', primaryDownloadError);
      throw primaryDownloadError;
    }

    // Emergency fallback for direct URLs
    if (structuredResult.resolvedUrl !== rawImageUrl) {
      const fallbackFilename = getFilenameFromUrl(rawImageUrl);
      // Route by the fallback file itself (its name hint); the abandoned primary group's metadata
      // (e.g. image/gif) does not describe it, so no group is passed.
      const fallbackPath = resolveDownloadPath({
        filename: fallbackFilename,
        subfolder,
        folderOrganizationMode: settings.folderOrganizationMode,
        pageUrl: options?.pageUrl || group?.pageUrl || '',
        resolvedUrl: rawImageUrl,
        resolvedExtension: (fallbackFilename.match(/\.[^./]+$/) || [''])[0]
      });
      let fallbackSourceUrl = rawImageUrl;
      if (rawImageUrl.includes('pximg.net')) {
        try {
          fallbackSourceUrl = await fetchPixivImageAsDataUrl(rawImageUrl);
        } catch (_) {}
      }
      const fallbackOptions = {
        url: fallbackSourceUrl,
        filename: fallbackPath,
        saveAs: false
      };
      delete fallbackOptions.headers;

      const fallbackDownloadId = await new Promise((resolve, reject) => {
        let settled = false;
        let ret;
        try {
          ret = chrome.downloads.download(fallbackOptions, (id) => {
            if (settled) return;
            settled = true;
            const lastErr = chrome.runtime?.lastError;
            if (lastErr) reject(new Error(lastErr.message));
            else if (id === undefined) reject(new Error('fallback download returned undefined'));
            else resolve(id);
          });
        } catch (syncErr) {
          if (!settled) { settled = true; reject(syncErr); }
          return;
        }
        if (ret && typeof ret.then === 'function') {
          ret.then(
            (id) => { if (!settled) { settled = true; resolve(id); } },
            (err) => { if (!settled) { settled = true; reject(err); } }
          );
        }
      });

      activeDownloadsMetadata.set(fallbackDownloadId, { url: fallbackSourceUrl, rawUrl: rawImageUrl });
      // The abandoned primary failure is recoverable: the operation continues with the fallback download.
      await fbAttach(options?.feedbackOp, fallbackDownloadId, {
        fallback: true,
        filename: fallbackPath,
        output: buildFeedbackOutput({ finalPath: fallbackPath, structuredResult: null, group: null, isFallback: true })
      });
      await addTrackedDownloadId(fallbackDownloadId);
      await setBadge('DL', '#3b82f6');
      await settleEarlyTerminalDownload(fallbackDownloadId);
      return {
        success: true,
        downloadId: fallbackDownloadId,
        filename: fallbackPath,
        resolvedUrl: fallbackSourceUrl
      };
    } else {
      throw primaryDownloadError;
    }
  }
}

/**
 * Executes the download of resolved media (image or direct tweet-video MP4).
 * Backwards-compatible facade adapting single URL or candidate into a media plan.
 */
async function executeMediaDownload({ targetImageUrl, rawImageUrl, settings = {}, mediaPlan = null, disallowFallback = false, checkCancelled = null, pageUrl = '', feedbackOp = null }) {
  if (targetImageUrl && targetImageUrl.startsWith('blob:')) {
    console.warn('[Image Saver] Попытка скачать blob URL напрямую отклонена (UNRESOLVED_BLOB_MEDIA):', sanitizeUrlForLog(targetImageUrl));
    await fbFail(feedbackOp, { stage: 'resolve', code: 'UNRESOLVED_BLOB_MEDIA' });
    await flashBadge('ERR', '#ef4444');
    return {
      success: false,
      error: 'UNRESOLVED_BLOB_MEDIA',
      status: 404
    };
  }
  let plan = mediaPlan;
  if (!plan && targetImageUrl) {
    const animeInfo = parseAnimePicturesCdnUrl(targetImageUrl);
    if (animeInfo) {
      plan = createAnimePicturesOriginalGroup(animeInfo.dir, animeInfo.md5);
    } else {
      plan = adaptCandidateToGroup({ url: targetImageUrl, source: 'unknown' });
    }
  }
  let result;
  try {
    result = await executeMediaPlan(plan, settings, rawImageUrl || targetImageUrl, { disallowFallback, checkCancelled, pageUrl: pageUrl || mediaPlan?.pageUrl, feedbackOp });
  } catch (err) {
    await fbFail(feedbackOp, { stage: 'save', code: err?.message });
    throw err;
  }
  await fbSettleFromResult(feedbackOp, result);
  return result;
}

// ============================================================================
// 9.3. Offscreen Document Manager (for Protected Media Blobs)
// ============================================================================

let activeOffscreenTasks = 0;
let offscreenRecoveryPromise = null;   // the one running recovery of persisted live downloads (see reconcileActiveOffscreenDownloads)
let offscreenCloseDeferred = false;     // a close requested while recovery was pending or ownership was unknown
let offscreenOwnershipKnown = false;    // the persisted live records were read and their owners restored (or none exist); until then an empty owner set proves nothing
let offscreenCreationPromise = null;
let offscreenClosingPromise = null;
const activeOffscreenOwners = new Map(); // ownerKey -> blobUrl
const releasedOffscreenKeys = new Set();
const activeRevokedBlobs = new Set();

/**
 * Ensures that an offscreen document exists with reasons ['BLOBS'].
 * Uses single-flight shared creation promise so concurrent callers create at most one document.
 */
async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error('chrome.offscreen API is not available in this environment');
  }
  if (offscreenClosingPromise) {
    await offscreenClosingPromise.catch(() => {});
  }
  if (chrome.runtime?.getContexts) {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existing && existing.length > 0) {
      return;
    }
  }
  if (offscreenCreationPromise) {
    return offscreenCreationPromise;
  }
  offscreenCreationPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Fetch and manage protected media BLOBS in offscreen document'
      });
    } catch (err) {
      if (!err?.message?.includes('Only a single offscreen document may be created')) {
        throw err;
      }
    } finally {
      offscreenCreationPromise = null;
    }
  })();
  return offscreenCreationPromise;
}

/**
 * Tracks an active offscreen task with an owner key and optional associated blobUrl.
 * Increments activeOffscreenTasks and records ownership.
 */
function acquireOffscreenTask(ownerKey = null, blobUrl = null) {
  const key = ownerKey || (blobUrl ? `blob_${blobUrl}` : `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  if (releasedOffscreenKeys.has(key)) {
    releasedOffscreenKeys.delete(key);
  }
  activeOffscreenOwners.set(key, blobUrl || null);
  activeOffscreenTasks = activeOffscreenOwners.size;
  return key;
}

/**
 * Transfers offscreen task ownership directly from oldOwnerKey to newOwnerKey
 * without revoking the underlying Blob URL or changing active task count.
 */
function transferOffscreenTask(oldOwnerKey, newOwnerKey, blobUrl) {
  if (oldOwnerKey && activeOffscreenOwners.has(oldOwnerKey)) {
    activeOffscreenOwners.delete(oldOwnerKey);
    releasedOffscreenKeys.add(oldOwnerKey);
  }
  if (newOwnerKey) {
    if (releasedOffscreenKeys.has(newOwnerKey)) {
      releasedOffscreenKeys.delete(newOwnerKey);
    }
    activeOffscreenOwners.set(newOwnerKey, blobUrl || null);
  }
  activeOffscreenTasks = activeOffscreenOwners.size;
}

/**
 * Checks whether any protected Blob downloads are currently active in memory or session storage.
 */
function hasActiveProtectedDownloads() {
  return activeProtectedBlobsByDownloadId.size > 0;
}
// The shared animation policy (X tweet_video, Reddit GIF-as-MP4): a measured duration up to and including this many seconds becomes a
// genuine GIF; strictly above it the verified source MP4 is saved. Fixed: a caller option cannot move it.
const ANIMATION_GIF_MAX_SECONDS = 30;

// The offscreen converter's explicit decision to save the source MP4. Valid only as the full decision (action SAVE_DIRECT_MP4, a finite
// measured duration strictly above the fixed threshold, the fixed threshold) and never together with a GIF Blob; anything else that claims
// it is a protocol violation and throws, so no download is started. Returns null when the reply is an ordinary conversion result.
function parseAnimationDurationDecision(res) {
  if (!res || res.exceedsDuration === undefined || res.exceedsDuration === false) return null;
  const duration = res.duration;
  if (res.exceedsDuration !== true || res.action !== 'SAVE_DIRECT_MP4' || res.blobUrl || res.bytes !== undefined ||
      typeof duration !== 'number' || !Number.isFinite(duration) || duration <= ANIMATION_GIF_MAX_SECONDS || duration > 36000 ||
      res.threshold !== ANIMATION_GIF_MAX_SECONDS) {
    throw new Error('INVALID_DURATION_DECISION');
  }
  return { duration, threshold: ANIMATION_GIF_MAX_SECONDS };
}

/**
 * Converts a confirmed X tweet_video MP4 animation into genuine looping GIF bytes
 * via offscreen document and returns the Blob URL and task key.
 */
async function convertXTweetVideoToGifBlob(videoUrl, options = {}) {
  const taskKey = acquireOffscreenTask('x_gif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  try {
    await ensureOffscreenDocument();
    const res = await chrome.runtime.sendMessage({
      action: 'CONVERT_X_TWEET_VIDEO_TO_GIF',
      url: videoUrl,
      jobId: taskKey,
      ...options
    });
    if (!res || !res.success) {
      throw new Error(res?.error || 'CONVERSION_FAILED');
    }
    const decision = parseAnimationDurationDecision(res);
    if (decision) {
      await releaseOffscreenTask(taskKey).catch(() => {});
      return { success: true, exceedsDuration: true, duration: decision.duration, threshold: decision.threshold };
    }
    if (!res.blobUrl) {
      throw new Error(res?.error || 'CONVERSION_FAILED');
    }
    if (res.bytes !== undefined) {
      throw new Error('OVERSIZED_RESPONSE: Conversion response must not include raw byte buffer across messaging');
    }
    return {
      success: true,
      blobUrl: res.blobUrl,
      taskKey,
      size: res.size || 0,
      frames: res.frames || 0,
      duration: res.duration || 0
    };
  } catch (err) {
    await releaseOffscreenTask(taskKey).catch(() => {});
    throw err;
  }
}

/**
 * Executes one-click genuine GIF conversion and download for an X tweet_video.
 * Enforces atomic task transfer, download tracking, and fail-safe badge handling.
 */
async function executeXTweetVideoGifDownload(videoUrl, settings = {}, options = {}) {
  let convResult = null;
  const feedbackOp = options?.feedbackOp || null;
  try {
    await setBadge('...', '#3b82f6');
    // pageUrl is folder-routing context only; it must not travel to the offscreen document.
    const { pageUrl, feedbackOp: _feedbackOp, ...conversionOptions } = options || {};
    await fbStage(feedbackOp, 'converting', { conversion: 'x_tweet_video_gif', expectedType: 'gif', sourceUrl: videoUrl, site: fbSiteOf(pageUrl, videoUrl) });
    convResult = await convertXTweetVideoToGifBlob(videoUrl, conversionOptions);
    if (convResult?.exceedsDuration) {
      const duration = convResult.duration;
      const threshold = convResult.threshold || 30.0;
      await fbStage(feedbackOp, 'saving', {
        conversion: 'none',
        reason: 'animation_duration_limit',
        durationSec: duration,
        thresholdSec: threshold,
        output: {
          type: 'video',
          ext: '.mp4',
          evidence: 'verified_mime',
          mime: 'video/mp4',
          durationSec: duration,
          reason: 'animation_duration_limit',
          thresholdSec: threshold
        }
      });
      const mediaPlan = adaptCandidateToGroup({
        url: videoUrl,
        source: 'x_video',
        tier: 'original',
        score: 90,
        contentType: 'video/mp4',
        mediaType: 'video',
        verified: true,
        metadata: {
          durationSec: duration,
          thresholdSec: threshold,
          reason: 'animation_duration_limit'
        }
      });
      return await executeMediaDownload({
        targetImageUrl: videoUrl,
        rawImageUrl: videoUrl,
        settings,
        mediaPlan,
        pageUrl: pageUrl || '',
        feedbackOp
      });
    }
    // Measured by the encoder: output size and frame count. Output dimensions are not reported by the converter.
    await fbStage(feedbackOp, 'saving', { output: { type: 'gif', ext: '.gif', evidence: 'converted_output', mime: 'image/gif', sizeBytes: convResult.size > 0 ? convResult.size : null, sizeKind: 'measured', frames: convResult.frames > 0 ? convResult.frames : null, durationSec: convResult.duration > 0 ? convResult.duration : null } });
    const baseName = getFilenameFromUrl(videoUrl) || 'tweet_video.mp4';
    const filenameNoExt = baseName.replace(/\.[^/.]+$/, '');
    // Owner = validated captured page; otherwise the provider via its confirmed media host (x).
    const filename = resolveDownloadPath({
      filename: `${filenameNoExt}.gif`,
      subfolder: getConfiguredRoot(settings),
      folderOrganizationMode: settings?.folderOrganizationMode,
      isConvertedGif: true,
      pageUrl,
      resolvedUrl: videoUrl
    });

    let downloadId = null;
    try {
      downloadId = await chrome.downloads.download({
        url: convResult.blobUrl,
        filename,
        saveAs: false
      });
    } catch (dlErr) {
      console.error('[Image Saver] Ошибка вызова chrome.downloads.download для сконвертированного GIF:', dlErr);
      await fbFail(feedbackOp, { stage: 'save', code: dlErr?.message });
      await releaseOffscreenTask(convResult.taskKey, convResult.blobUrl).catch(() => {});
      await flashBadge('ERR', '#ef4444');
      return { success: false, error: dlErr?.message || String(dlErr) };
    }

    await fbAttach(feedbackOp, downloadId, { filename });
    await addTrackedDownloadId(downloadId);
    await setBadge('DL', '#3b82f6');
    transferOffscreenTask(convResult.taskKey, 'protected_' + downloadId, convResult.blobUrl);
    await trackDownloadProtectedBlob(downloadId, convResult.blobUrl, 'protected_' + downloadId);
    await settleEarlyTerminalDownload(downloadId);
    return { success: true, downloadId };
  } catch (err) {
    console.error('[Image Saver] Не удалось сконвертировать и скачать X tweet_video в GIF:', err);
    await fbFail(feedbackOp, { stage: convResult ? 'save' : 'convert', code: err?.message });
    await flashBadge('ERR', '#ef4444');
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Converts a confirmed Reddit MP4 animation into genuine looping GIF bytes
 * via offscreen document and returns the Blob URL and task key.
 */
async function convertRedditVideoToGifBlob(videoUrl, options = {}) {
  const taskKey = acquireOffscreenTask('reddit_gif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  try {
    await ensureOffscreenDocument();
    const res = await chrome.runtime.sendMessage({
      action: 'CONVERT_REDDIT_VIDEO_TO_GIF',
      url: videoUrl,
      jobId: taskKey,
      ...options
    });
    if (!res || !res.success) {
      throw new Error(res?.error || 'CONVERSION_FAILED');
    }
    const decision = parseAnimationDurationDecision(res);
    if (decision) {
      await releaseOffscreenTask(taskKey).catch(() => {});
      return { success: true, exceedsDuration: true, duration: decision.duration, threshold: decision.threshold };
    }
    if (!res.blobUrl) {
      throw new Error(res?.error || 'CONVERSION_FAILED');
    }
    if (res.bytes !== undefined) {
      throw new Error('OVERSIZED_RESPONSE: Conversion response must not include raw byte buffer across messaging');
    }
    return {
      success: true,
      blobUrl: res.blobUrl,
      taskKey,
      size: res.size || 0,
      frames: res.frames || 0,
      duration: res.duration || 0
    };
  } catch (err) {
    await releaseOffscreenTask(taskKey).catch(() => {});
    throw err;
  }
}

/**
 * Executes one-click genuine GIF conversion and download for a confirmed Reddit animation.
 * Enforces atomic task transfer, download tracking, and fail-safe badge handling.
 */
async function executeRedditGifDownload(videoUrl, settings = {}, options = {}) {
  let convResult = null;
  const feedbackOp = options?.feedbackOp || null;
  try {
    await setBadge('...', '#3b82f6');
    // pageUrl is folder-routing context only; it must not travel to the offscreen document.
    const { pageUrl, feedbackOp: _feedbackOp, ...conversionOptions } = options || {};
    await fbStage(feedbackOp, 'converting', { conversion: 'reddit_animation_gif', expectedType: 'gif', sourceUrl: videoUrl, site: fbSiteOf(pageUrl, videoUrl) });
    convResult = await convertRedditVideoToGifBlob(videoUrl, conversionOptions);
    if (convResult?.exceedsDuration) {
      const duration = convResult.duration;
      const threshold = convResult.threshold || 30.0;
      await fbStage(feedbackOp, 'saving', {
        conversion: 'none',
        reason: 'animation_duration_limit',
        durationSec: duration,
        thresholdSec: threshold,
        output: {
          type: 'video',
          ext: '.mp4',
          evidence: 'verified_mime',
          mime: 'video/mp4',
          durationSec: duration,
          reason: 'animation_duration_limit',
          thresholdSec: threshold
        }
      });
      const mediaPlan = adaptCandidateToGroup({
        url: videoUrl,
        source: 'reddit_video',
        tier: 'original',
        score: 90,
        contentType: 'video/mp4',
        mediaType: 'video',
        verified: true,
        metadata: {
          durationSec: duration,
          thresholdSec: threshold,
          reason: 'animation_duration_limit'
        }
      });
      return await executeMediaDownload({
        targetImageUrl: videoUrl,
        rawImageUrl: videoUrl,
        settings,
        mediaPlan,
        pageUrl: pageUrl || '',
        feedbackOp
      });
    }
    // Measured by the encoder: output size and frame count. Output dimensions are not reported by the converter.
    await fbStage(feedbackOp, 'saving', { output: { type: 'gif', ext: '.gif', evidence: 'converted_output', mime: 'image/gif', sizeBytes: convResult.size > 0 ? convResult.size : null, sizeKind: 'measured', frames: convResult.frames > 0 ? convResult.frames : null, durationSec: convResult.duration > 0 ? convResult.duration : null } });
    const baseName = getFilenameFromUrl(videoUrl) || 'reddit_animation.mp4';
    const filenameNoExt = baseName.replace(/\.[^/.]+$/, '');
    // Owner = validated captured page; otherwise the provider via its confirmed media host (reddit).
    const filename = resolveDownloadPath({
      filename: `${filenameNoExt}.gif`,
      subfolder: getConfiguredRoot(settings),
      folderOrganizationMode: settings?.folderOrganizationMode,
      isConvertedGif: true,
      pageUrl,
      resolvedUrl: videoUrl
    });

    let downloadId = null;
    try {
      downloadId = await chrome.downloads.download({
        url: convResult.blobUrl,
        filename,
        saveAs: false
      });
    } catch (dlErr) {
      console.error('[Image Saver] Ошибка вызова chrome.downloads.download для сконвертированного Reddit GIF:', dlErr);
      await fbFail(feedbackOp, { stage: 'save', code: dlErr?.message });
      await releaseOffscreenTask(convResult.taskKey, convResult.blobUrl).catch(() => {});
      await flashBadge('ERR', '#ef4444');
      return { success: false, error: dlErr?.message || String(dlErr) };
    }

    await fbAttach(feedbackOp, downloadId, { filename });
    await addTrackedDownloadId(downloadId);
    await setBadge('DL', '#3b82f6');
    transferOffscreenTask(convResult.taskKey, 'protected_' + downloadId, convResult.blobUrl);
    await trackDownloadProtectedBlob(downloadId, convResult.blobUrl, 'protected_' + downloadId);
    await settleEarlyTerminalDownload(downloadId);
    return { success: true, downloadId };
  } catch (err) {
    console.error('[Image Saver] Не удалось сконвертировать и скачать Reddit анимацию в GIF:', err);
    await fbFail(feedbackOp, { stage: convResult ? 'save' : 'convert', code: err?.message });
    await flashBadge('ERR', '#ef4444');
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Closes the offscreen document when no tasks or active protected downloads remain.
 */
async function closeOffscreenDocument() {
  if (activeOffscreenTasks > 0 || hasActiveProtectedDownloads()) return;
  // Persisted live downloads are not recovered yet (recovery pending, or its initial storage read failed): the owners are not restored, so an
  // empty owner set proves nothing and nothing may be closed. The request is remembered and runs once ownership is known. A request while the
  // ownership is unknown and no recovery runs makes one fresh attempt to learn it (no timer, no loop: only a request starts it).
  if (!offscreenOwnershipKnown) {
    offscreenCloseDeferred = true;
    if (!offscreenRecoveryPromise) reconcileActiveOffscreenDownloads().catch(() => {});
    return;
  }
  if (offscreenRecoveryPromise) { offscreenCloseDeferred = true; return; }
  if (!chrome.offscreen?.closeDocument) return;
  if (offscreenClosingPromise) return offscreenClosingPromise;

  offscreenClosingPromise = (async () => {
    try {
      if (chrome.runtime?.getContexts) {
        const existing = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        if (existing.length === 0) return;
      }
      if (activeOffscreenTasks > 0 || hasActiveProtectedDownloads()) return;
      await chrome.offscreen.closeDocument();
    } catch (err) {
      console.warn('[Image Saver] Не удалось закрыть offscreen document:', err);
    } finally {
      offscreenClosingPromise = null;
    }
  })();
  return offscreenClosingPromise;
}

/**
 * Truly single-release offscreen task and Blob cleanup.
 * Idempotent: duplicate calls for the same owner key or blobUrl NEVER decrement
 * another task or close another job's offscreen document.
 */
async function releaseOffscreenTask(ownerOrBlob = null, blobToRevoke = null) {
  let targetBlob = blobToRevoke;
  let targetKey = null;

  if (ownerOrBlob) {
    if (activeOffscreenOwners.has(ownerOrBlob)) {
      targetKey = ownerOrBlob;
      targetBlob = activeOffscreenOwners.get(ownerOrBlob) || blobToRevoke;
    } else {
      for (const [k, v] of activeOffscreenOwners.entries()) {
        if (v === ownerOrBlob) {
          targetKey = k;
          targetBlob = ownerOrBlob;
          break;
        }
      }
      if (!targetKey && (typeof ownerOrBlob === 'string' && ownerOrBlob.startsWith('blob:'))) {
        targetBlob = ownerOrBlob;
      }
    }
  }

  // Idempotency & validity check: if this key was already released, or was never an active task/blob, immediate NO-OP
  const isKeyReleased = targetKey && releasedOffscreenKeys.has(targetKey);
  const isBlobRevoked = targetBlob && activeRevokedBlobs.has(targetBlob);
  const isUnacquiredKey = ownerOrBlob && !targetKey && !targetBlob;

  if (isKeyReleased || isBlobRevoked || isUnacquiredKey) {
    return;
  }

  if (targetKey) {
    activeOffscreenOwners.delete(targetKey);
    releasedOffscreenKeys.add(targetKey);
  }

  if (targetBlob && !activeRevokedBlobs.has(targetBlob)) {
    activeRevokedBlobs.add(targetBlob);
    try {
      await chrome.runtime.sendMessage({ action: 'REVOKE_BLOB_URL', blobUrl: targetBlob });
    } catch (_) {}
    setTimeout(() => activeRevokedBlobs.delete(targetBlob), 60000);
  }

  // Strictly synchronize activeOffscreenTasks with remaining active owners
  activeOffscreenTasks = activeOffscreenOwners.size;

  if (activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
    await closeOffscreenDocument().catch(() => {});
  }
}

/**
 * Persists download-to-Blob mapping in chrome.storage.session and acquires offscreen task.
 * Safe against early terminal events arriving before, during, or after registration.
 */
async function trackDownloadProtectedBlob(downloadId, blobUrl, ownerKey = null) {
  if (!downloadId) return;
  const owner = ownerKey || `protected_${downloadId}`;
  const key = `active_dl_blob_${downloadId}`;

  // 1. Early terminal state arrived before registration: immediately clean up and exit
  const earlyTerminal = earlyTerminalDownloadStates.get(downloadId);
  if (earlyTerminal) {
    activeProtectedBlobsByDownloadId.delete(downloadId);
    await releaseOffscreenTask(owner, blobUrl);
    if (chrome.storage?.session) {
      await chrome.storage.session.remove(key).catch(() => {});
    }
    if (activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
      await closeOffscreenDocument().catch(() => {});
    }
    return;
  }

  activeProtectedBlobsByDownloadId.set(downloadId, blobUrl);
  acquireOffscreenTask(owner, blobUrl);

  if (chrome.storage?.session) {
    try {
      await chrome.storage.session.set({
        [key]: {
          downloadId,
          blobUrl,
          ownerKey: owner,
          timestamp: Date.now()
        }
      });
    } catch (_) {}
  }

  // 2. Reconciliation check: did a terminal state arrive while awaiting session storage?
  if (earlyTerminalDownloadStates.has(downloadId) || !activeProtectedBlobsByDownloadId.has(downloadId)) {
    activeProtectedBlobsByDownloadId.delete(downloadId);
    if (chrome.storage?.session) {
      await chrome.storage.session.remove(key).catch(() => {});
    }
    await releaseOffscreenTask(owner, blobUrl);
    if (activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
      await closeOffscreenDocument().catch(() => {});
    }
  }
}

/**
 * Removes download-to-Blob mapping from memory and chrome.storage.session, releasing offscreen task.
 * Idempotent and safe across multiple invocations.
 */
async function untrackDownloadProtectedBlob(downloadId) {
  if (!downloadId) return;
  const key = `active_dl_blob_${downloadId}`;
  const hasInMemory = activeProtectedBlobsByDownloadId.has(downloadId);
  let blobUrl = activeProtectedBlobsByDownloadId.get(downloadId) || null;
  let ownerKey = hasInMemory ? `protected_${downloadId}` : null;
  activeProtectedBlobsByDownloadId.delete(downloadId);

  let hasInSession = false;
  if (chrome.storage?.session) {
    try {
      const data = await chrome.storage.session.get(key);
      if (data && data[key]) {
        hasInSession = true;
        if (!blobUrl) blobUrl = data[key].blobUrl;
        if (data[key].ownerKey) ownerKey = data[key].ownerKey;
      }
      await chrome.storage.session.remove(key);
    } catch (_) {}
  }

  if (!ownerKey && activeOffscreenOwners.has(`protected_${downloadId}`)) {
    ownerKey = `protected_${downloadId}`;
  }

  // Only release offscreen task if this downloadId was actually tracked as a protected blob
  if (hasInMemory || hasInSession || blobUrl || ownerKey) {
    await releaseOffscreenTask(ownerKey || `protected_${downloadId}`, blobUrl);
  }
}

/**
 * The state of ONE owned download, asked by its own id: { known: true, item } (item null = Chrome has no such download any more) or
 * { known: false } when the answer is unavailable (no API, lastError, a failed or throwing call). Never a global query.
 */
function lookupOwnedDownload(downloadId) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || typeof chrome.downloads?.search !== 'function') { resolve({ known: false }); return; }
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const take = (results) => {
      if (!Array.isArray(results)) { done({ known: false }); return; }
      done({ known: true, item: results.find((d) => d && d.id === downloadId) || null });
    };
    try {
      const returned = chrome.downloads.search({ id: downloadId }, (results) => {
        if (chrome.runtime?.lastError) done({ known: false });
        else take(results);
      });
      if (returned && typeof returned.then === 'function') returned.then(take, () => done({ known: false }));
    } catch (_) {
      done({ known: false });
    }
  });
}

/**
 * Reconciles active offscreen downloads from chrome.storage.session across service worker restarts.
 * One recovery at a time (repeated calls share it). Order: every stored record is looked up by its own download id first; the records of live
 * downloads and of unknown ones (lookup unavailable: no revoke, no close, no guess) get their ownership back BEFORE any destructive cleanup;
 * only then are terminal and confirmed-absent records cleaned (Blob revoked, task released, document closed when nothing is owned).
 */
function reconcileActiveOffscreenDownloads() {
  if (offscreenRecoveryPromise) return offscreenRecoveryPromise;
  const run = (async () => {
    // nothing is persisted without session storage: nothing to learn
    if (!chrome.storage?.session) { offscreenOwnershipKnown = true; return; }
    try {
      const all = await chrome.storage.session.get(null);
      const entries = [];
      for (const [k, v] of Object.entries(all || {})) {
        if (k.startsWith('active_dl_blob_') && v && v.downloadId) {
          entries.push(v);
        }
      }
      if (entries.length === 0) { offscreenOwnershipKnown = true; return; }

      const looked = [];
      for (const entry of entries) looked.push({ entry, found: await lookupOwnedDownload(entry.downloadId) });

      const cleanup = [];
      for (const { entry, found } of looked) {
        const live = found.known && found.item && found.item.state === 'in_progress';
        if (found.known && !live) { cleanup.push(entry); continue; }
        // a terminal event handled while the lookup was pending already removed the stored record: it must not be owned again
        const key = `active_dl_blob_${entry.downloadId}`;
        let stillStored = true;
        try { stillStored = Boolean((await chrome.storage.session.get(key))?.[key]); } catch (_) {}
        if (!stillStored) continue;
        activeProtectedBlobsByDownloadId.set(entry.downloadId, entry.blobUrl);
        acquireOffscreenTask(entry.ownerKey || `protected_${entry.downloadId}`, entry.blobUrl);
        if (live) await addTrackedDownloadId(entry.downloadId);
      }
      for (const entry of cleanup) await untrackDownloadProtectedBlob(entry.downloadId);
      offscreenOwnershipKnown = true;
    } catch (err) {
      console.warn('[Image Saver] Ошибка сверки active offscreen downloads при запуске:', err);
    }
  })();
  offscreenRecoveryPromise = run.finally(async () => {
    offscreenRecoveryPromise = null;
    // a failed recovery leaves the ownership unknown: the remembered close stays pending instead of running
    if (offscreenCloseDeferred && offscreenOwnershipKnown) {
      offscreenCloseDeferred = false;
      await closeOffscreenDocument().catch(() => {});
    }
  });
  return offscreenRecoveryPromise;
}

reconcileActiveOffscreenDownloads();



/**
 * Verifies final media MIME before chooser eligibility.
 * Does not trust URL pathname extension or query hints.
 * For direct video/image, probes via network.
 * For protected transport, uses protected fetch/probe when eligible and reuses Blob.
 * Returns verified MIME string or null if verification is unavailable.
 */
async function verifyFinalMediaMime(targetUrl, mediaPlan, isVideoContext) {
  if (!targetUrl || typeof targetUrl !== 'string') return null;

  const hostInfo = getProtectedHostInfo(targetUrl);
  const isProtected = mediaPlan?.transport === 'protected' || mediaPlan?.transport === 'protectedBlob' || Boolean(hostInfo);

  // 1. If candidate was already verified during candidate probing for this exact URL with HTTP evidence:
  // For protected hosts, candidate is only truly verified if verifiedBlob is already present!
  const meta = mediaPlan?.metadata;
  const isEvidenceHttp = meta?.mimeEvidence === MIME_EVIDENCE.HTTP_RESPONSE ||
                         meta?.mimeEvidence === MIME_EVIDENCE.PROTECTED_FETCH;
  const isUrlMatch = !meta?.verifiedUrl || meta?.verifiedUrl === targetUrl;
  const isCandidateVerified = Boolean(meta?.verified && isEvidenceHttp && isUrlMatch);

  const planMime = (meta?.contentType || mediaPlan?.variants?.[0]?.contentType || '').split(';')[0].trim().toLowerCase();
  if (isCandidateVerified && planMime && (planMime.startsWith('video/') || planMime.startsWith('image/'))) {
    if (!isProtected || mediaPlan?.verifiedBlob?.blobUrl) {
      return planMime;
    }
  }

  // 2. If protected transport (Anime-Pictures, Gelbooru, etc.), use protected fetch:
  if (isProtected) {
    const variantPolicy = mediaPlan?.variantPolicy || {};
    const advanceOnCodes = new Set(variantPolicy.advanceOn || [404, 410]);
    const variants = (mediaPlan?.isCandidateGroup && Array.isArray(mediaPlan.variants) && mediaPlan.variants.length > 0)
      ? mediaPlan.variants
      : [{ url: targetUrl }];

    let startIndex = variants.findIndex(v => v.url === targetUrl);
    if (startIndex === -1) startIndex = 0;

    for (let i = startIndex; i < variants.length; i++) {
      const currentVariant = variants[i];
      const currentUrl = currentVariant.url;
      const currentHostInfo = getProtectedHostInfo(currentUrl);

      const probeTaskKey = acquireOffscreenTask('mime_probe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      let transferredTask = false;
      let probeRes = null;
      try {
        const tOffscreenDocStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        await ensureOffscreenDocument();
        const tOffscreenDocReady = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        console.log(`[Chooser Profiler] 3a. offscreen document ready (duration: ${(tOffscreenDocReady - tOffscreenDocStart).toFixed(1)}ms)`);
        const action = currentHostInfo?.type === 'gelbooru' ? 'FETCH_GELBOORU_BLOB' : 'FETCH_PROTECTED_BLOB';
        console.log(`[Chooser Profiler] 3b. offscreen probe task dispatched (${action}) for variant [${i + 1}/${variants.length}]: ${sanitizeUrlForLog(currentUrl)}`);
        const tProbeStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        try {
          probeRes = await chrome.runtime.sendMessage({
            action,
            url: currentUrl
          });
        } catch (sendErr) {
          const errStr = (sendErr?.message || String(sendErr)).toLowerCase();
          const isConnLoss = errStr.includes('message channel closed') ||
                             errStr.includes('message port closed') ||
                             errStr.includes('could not establish connection') ||
                             errStr.includes('receiving end does not exist');
          if (isConnLoss) {
            console.warn('[Image Saver] Message channel closed during protected probe, retrying once:', sendErr.message);
            await ensureOffscreenDocument();
            probeRes = await chrome.runtime.sendMessage({
              action,
              url: currentUrl
            });
          } else {
            throw sendErr;
          }
        }
        const tProbeEnd = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        console.log(`[Chooser Profiler] 3c. offscreen probe task completed (duration: ${(tProbeEnd - tProbeStart).toFixed(1)}ms, status: ${probeRes?.success ? 'success' : 'failed'}, size: ${probeRes?.size || 0} bytes)`);

        if (probeRes && probeRes.success && probeRes.blobUrl) {
          const verifiedContentType = (probeRes.contentType || '').split(';')[0].trim().toLowerCase();
          if (verifiedContentType && (verifiedContentType.startsWith('image/') || verifiedContentType.startsWith('video/'))) {
            if (mediaPlan?.metadata) {
              mediaPlan.metadata.contentType = verifiedContentType;
              mediaPlan.metadata.verified = true;
              mediaPlan.metadata.mimeEvidence = MIME_EVIDENCE.PROTECTED_FETCH;
              mediaPlan.metadata.verifiedUrl = currentUrl;
              if (probeRes.isAnimated !== undefined) {
                mediaPlan.metadata.isAnimated = probeRes.isAnimated;
              }
            }
            if (probeRes.isAnimated !== undefined && mediaPlan?.metadata) {
              mediaPlan.metadata.isAnimated = probeRes.isAnimated;
            }
            // Retain verified Blob URL for reuse in download execution, avoiding duplicate full download!
            mediaPlan.verifiedBlob = {
              blobUrl: probeRes.blobUrl,
              contentType: verifiedContentType,
              probeTaskKey: probeTaskKey,
              size: probeRes.size || 0,
              url: currentUrl
            };
            transferredTask = true;
            return verifiedContentType;
          }
          console.warn('[Image Saver] Protected probe returned invalid/non-media MIME:', verifiedContentType);
          return null;
        }

        const status = resolveCandidateHttpStatus(probeRes?.status, probeRes?.error);
        const errMsg = probeRes?.error || (status ? `HTTP ${status}` : 'Protected probe failed');

        if (status === 429) {
          console.warn('[Image Saver] HTTP 429 received during protected probe:', sanitizeUrlForLog(currentUrl));
          if (mediaPlan) {
            mediaPlan._rateLimited = true;
            mediaPlan._verificationStatus = 429;
            mediaPlan.error = 'RATE_LIMIT';
          }
          await flashBadge('RATE', '#f59e0b');
          return null;
        }

        if (status === 403 || status === 401) {
          console.warn('[Image Saver] HTTP 403/401 received during protected probe:', sanitizeUrlForLog(currentUrl));
          if (mediaPlan) {
            mediaPlan._verificationStatus = status;
            mediaPlan.error = 'AUTH_REQUIRED';
          }
          await flashBadge('AUTH', '#f59e0b');
          return null;
        }

        if (advanceOnCodes.has(status)) {
          console.warn(`[Image Saver] Вариант вернул HTTP ${status}, переход к следующему варианту:`, sanitizeUrlForLog(currentUrl));
          continue;
        }

        console.warn(`[Image Saver] Защищенный зонд завершился с непереходной ошибкой (status: ${status}):`, errMsg);
        return null;
      } catch (e) {
        console.warn('[Image Saver] Protected probe failed for MIME verification:', e);
        const status = resolveCandidateHttpStatus(e?.status, e?.message);
        if (status === 429) {
          if (mediaPlan) {
            mediaPlan._rateLimited = true;
            mediaPlan._verificationStatus = 429;
            mediaPlan.error = 'RATE_LIMIT';
          }
          await flashBadge('RATE', '#f59e0b');
          return null;
        } else if (status === 403 || status === 401) {
          if (mediaPlan) {
            mediaPlan._verificationStatus = status;
            mediaPlan.error = 'AUTH_REQUIRED';
          }
          await flashBadge('AUTH', '#f59e0b');
          return null;
        } else if (advanceOnCodes.has(status)) {
          console.warn(`[Image Saver] Исключение зонда с переходящим статусом HTTP ${status}, переход к следующему варианту:`, sanitizeUrlForLog(currentUrl));
          continue;
        }
        return null;
      } finally {
        if (!transferredTask) {
          await releaseOffscreenTask(probeTaskKey, probeRes?.blobUrl).catch(() => {});
        }
      }
    }
    return null;
  }

  // 3. For direct/unprotected video URLs (including Reddit, RedGIFs frame-resolved, direct CDN):
  if (isVideoContext || isDirectVideoUrl(targetUrl)) {
    const variantPolicy = mediaPlan?.variantPolicy || {};
    const advanceOnCodes = new Set(variantPolicy.advanceOn || [404, 410]);
    const variants = (mediaPlan?.isCandidateGroup && Array.isArray(mediaPlan.variants) && mediaPlan.variants.length > 0)
      ? mediaPlan.variants
      : [{ url: targetUrl }];
    let startIndex = variants.findIndex(v => v.url === targetUrl);
    if (startIndex === -1) startIndex = 0;

    for (let i = startIndex; i < variants.length; i++) {
      const currentUrl = variants[i].url;
      const probe = await probeVideoUrlDetails(currentUrl);
      if (probe && (probe.status === 429 || probe.error === 'RATE_LIMIT')) {
        console.warn('[Image Saver] HTTP 429 received during video probe:', sanitizeUrlForLog(currentUrl));
        if (mediaPlan) {
          mediaPlan._rateLimited = true;
          mediaPlan._verificationStatus = 429;
        }
        await flashBadge('RATE', '#f59e0b');
        return null;
      }
      if (probe && (probe.status === 401 || probe.status === 403 || probe.requiresAuth)) {
        console.warn(`[Image Saver] HTTP ${probe.status} received during video probe:`, sanitizeUrlForLog(currentUrl));
        if (mediaPlan) {
          mediaPlan._verificationStatus = probe.status;
          mediaPlan.error = 'AUTH_REQUIRED';
        }
        await flashBadge('AUTH', '#f59e0b');
        return null;
      }
      if (probe && probe.ok && probe.contentType) {
        const verifiedType = probe.contentType.split(';')[0].trim().toLowerCase();
        if (verifiedType.startsWith('video/')) {
          if (mediaPlan?.metadata) {
            mediaPlan.metadata.contentType = verifiedType;
            mediaPlan.metadata.verified = true;
            mediaPlan.metadata.mimeEvidence = MIME_EVIDENCE.HTTP_RESPONSE;
            mediaPlan.metadata.verifiedUrl = currentUrl;
          }
          // The verified member becomes the plan's first variant (as resolveOriginalMediaPlan does for a probed group): primaryUrl is a getter over
          // variants[0], and the direct executor starts there, so the URL that downloads is the URL whose MIME was just recorded. Members only, none added.
          if (i > 0 && mediaPlan?.isCandidateGroup && mediaPlan.variants === variants) {
            variants.unshift(variants.splice(i, 1)[0]);
          }
          return verifiedType;
        }
      }
      const status = probe?.status || (probe?.error === 'NOT_FOUND' ? 404 : (probe?.error === 'GONE' ? 410 : 0));
      if (advanceOnCodes.has(status)) {
        console.warn(`[Image Saver] Direct video variant returned HTTP ${status}, advancing to next variant:`, sanitizeUrlForLog(currentUrl));
        continue;
      }
      if (mediaPlan) {
        mediaPlan._verificationStatus = status || 500;
        mediaPlan._verificationStatusObserved = Boolean(status);
        mediaPlan._probeFailed = true;
      }
      return null;
    }
    return null;
  }

  // 4. Direct image probe:
  const probeTarget = {
    url: targetUrl,
    source: 'final_verification',
    finalScore: 0,
    baseScore: 0,
    verified: false,
    contentLength: 0,
    contentType: ''
  };
  const isOk = await probeCandidate(probeTarget);
  if (probeTarget.status === 429) {
    console.warn('[Image Saver] HTTP 429 received during image probe:', sanitizeUrlForLog(targetUrl));
    if (mediaPlan) {
      mediaPlan._rateLimited = true;
      mediaPlan._verificationStatus = 429;
      mediaPlan.error = 'RATE_LIMIT';
    }
    await flashBadge('RATE', '#f59e0b');
    return null;
  }
  if (probeTarget.status === 403 || probeTarget.status === 401) {
    console.warn(`[Image Saver] HTTP ${probeTarget.status} received during image probe:`, sanitizeUrlForLog(targetUrl));
    if (mediaPlan) {
      mediaPlan._verificationStatus = probeTarget.status;
      mediaPlan.error = 'AUTH_REQUIRED';
    }
    await flashBadge('AUTH', '#f59e0b');
    return null;
  }
  if (isOk && probeTarget.contentType) {
    const verifiedType = probeTarget.contentType.split(';')[0].trim().toLowerCase();
    if (verifiedType.startsWith('image/')) {
      if (mediaPlan?.metadata) {
        mediaPlan.metadata.contentType = verifiedType;
        mediaPlan.metadata.verified = true;
        mediaPlan.metadata.mimeEvidence = MIME_EVIDENCE.HTTP_RESPONSE;
        mediaPlan.metadata.verifiedUrl = targetUrl;
      }
      return verifiedType;
    }
  }

  if (!isOk) {
    console.warn(`[Image Saver] Финальная проверка изображения не подтвердила тип (HTTP: ${probeTarget.status || 'не наблюдался'}):`, sanitizeUrlForLog(targetUrl));
    if (mediaPlan) {
      mediaPlan._verificationStatus = probeTarget.status || 500;
      mediaPlan._verificationStatusObserved = Boolean(probeTarget.status);
      mediaPlan._probeFailed = true;
    }
  }

  return null;
}

async function onContextMenuClicked(info, tab) {
  // A page/overlay click on X uses its existing selected-player path. Native sources and direct media links
  // retain the generic entry path (including X images); old IDs remain accepted for in-flight menu callbacks.
  if (info.menuItemId === 'save-image-item' && !info.srcUrl && !info.linkUrl &&
      isXPageUrl(info.frameUrl || info.pageUrl || tab?.url)) {
    info = { ...info, menuItemId: 'save-x-media-item' };
  }
  if (info.menuItemId === 'save-image-item' || info.menuItemId === CSS_MEDIA_MENU_ID) {
    const tProfilerStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
    console.log('[Chooser Profiler] 1. context menu received (t=0.0ms)');
    let rawImageUrl = (info.srcUrl || '').trim();
    const rawLinkUrl = (info.linkUrl || '').trim();
    console.log('[Image Saver] Клик по контекстному меню для медиа:', sanitizeUrlForLog(rawImageUrl || rawLinkUrl));

    // Admission of the selected owner, the one gate of every save path: a source or media link from Chrome never
    // bypasses it, and no provider recovery, probe or download runs before it passes.
    const claimsMediaLink = !rawImageUrl && hasMediaAssociation('', rawLinkUrl);
    // An inline Reddit click (UX-11-RD) was proven by the document right before this call; a gesture capture, possibly of another tile, must not decide it.
    const owner = redditInlineInfos.has(info) || redgifsInlineInfos.has(info) ? 'proven' : await resolveContextOwner(tab?.id, info.frameId, { src: rawImageUrl, link: claimsMediaLink ? rawLinkUrl : '' });
    if (owner === 'refused' || owner === 'preview') {
      console.warn(owner === 'preview'
        ? '[Image Saver] The selected video is a seek preview, not the media of the post: save refused without requests'
        : '[Image Saver] Владелец выбранной цели удалён, заменён или изменён после жеста — сохранение отклонено без запросов');
      const staleOp = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: '', site: fbSiteOf(info.pageUrl || tab?.url, '') });
      await fbFail(staleOp, { stage: 'resolve', code: 'NO_MEDIA' });
      await fbBadgeReporter(staleOp)('ERR', '#ef4444');
      return;
    }

    // Fast resolution: If rawImageUrl is empty or is a blob URL and click occurred on Reddit, recover from fresh target or frame-matching cache
    const isRedditPage = (info.pageUrl && isRedditDomain((() => { try { return new URL(info.pageUrl).hostname; } catch(_) { return ''; } })())) ||
                         (tab?.url && isRedditDomain((() => { try { return new URL(tab.url).hostname; } catch(_) { return ''; } })()));

    if (info.menuItemId === 'save-image-item' && isRedditPage && (!rawImageUrl || rawImageUrl.startsWith('blob:')) && tab?.id) {
      const clickFrameId = typeof info.frameId === 'number' ? info.frameId : 0;
      let queryAttempted = false;
      let freshMedia = null;
      try {
        const resp = await chrome.tabs.sendMessage(
          tab.id,
          { action: 'GET_REDDIT_MEDIA_AT_CURSOR' },
          { frameId: clickFrameId }
        );
        queryAttempted = true;
        if (resp && typeof resp === 'object') {
          freshMedia = resp.media || null;
        }
      } catch (_) {
        queryAttempted = false;
      }

      if (queryAttempted) {
        if (freshMedia?.url) {
          rawImageUrl = freshMedia.url;
          lastDetectedRedditMediaByTab.set(tab.id, {
            media: freshMedia,
            timestamp: Date.now(),
            frameId: clickFrameId,
            documentUrl: info.pageUrl || ''
          });
        } else {
          // Content script explicitly found no media (or target disconnected/expired)
          lastDetectedRedditMediaByTab.delete(tab.id);
        }
      } else {
        // Content script unreachable: check bounded frame-matching cache as fallback
        const cached = lastDetectedRedditMediaByTab.get(tab.id);
        const isFresh = cached && cached.timestamp && (Date.now() - cached.timestamp < 10000);
        const isFrameMatch = cached && cached.frameId === clickFrameId;
        const isDocMatch = !cached?.documentUrl || !info.pageUrl || cached.documentUrl === info.pageUrl;
        if (isFresh && isFrameMatch && isDocMatch && cached.media?.url) {
          rawImageUrl = cached.media.url;
        }
      }
    }

    // 0. No <img>/<video> source and no media link: the click may be on a CSS background or under a simple overlay.
    // The page context (and a non-media link) carry no source, so the gesture's own element decides: one proven
    // http(s) asset or nothing (content_context_target.js / readContextMediaTarget). X player/CSS routing stays
    // provider-owned; a proven IMG under a profile/navigation link uses this same native-image path as other sites.
    // The proven kind travels with the URL: a page click has no info.mediaType, so a native <video> under an overlay
    // (possibly an extensionless URL) must enter the video path explicitly. Nothing else about validation changes.
    let gestureKind = '';
    // A URL-less player (blob/MSE) that the gesture proved is admitted only in a frame of RedGIFs itself, where the frame-local resolver
    // (content_redgifs.js, with its own gesture proof) answers; no address of the page or of a neighbor is used as the selection.
    let gesturePlayer = false;
    let gestureDocumentId = '';
    let gestureAt = null;
    // An own-site inline Save (REDGIFS-INLINE-01): the sending document proves the player itself, bound by a one-shot token and its document id
    const inlineRedGifs = redgifsInlineInfos.has(info) ? info.redgifsInline : null;
    let inlineToken = '';
    if (inlineRedGifs) {
      gesturePlayer = true;
      gestureDocumentId = inlineRedGifs.documentId;
      inlineToken = inlineRedGifs.token;
    } else if (!rawImageUrl && !hasMediaAssociation('', rawLinkUrl)) {
      const gestureMedia = await resolveContextMediaTarget(tab?.id, info.frameId);
      if (gestureMedia && gestureMedia.kind === 'player') {
        const frameIsRedGifs = isRedGifsUrl(info.frameUrl) || (!info.frameUrl && !info.frameId && isRedGifsUrl(info.pageUrl || tab?.url));
        if (frameIsRedGifs && tab?.id) {
          gesturePlayer = true;
          gestureDocumentId = gestureMedia.documentId || '';
          gestureAt = gestureMedia.gestureAt;
          console.log('[Image Saver] Плеер RedGIFs без адреса выбран по жесту (разрешение в кадре)');
        }
      } else if (gestureMedia && (!isXPageUrl(info.pageUrl || tab?.url) || gestureMedia.kind === 'img')) {
        rawImageUrl = gestureMedia.url;
        gestureKind = gestureMedia.kind === 'video' ? 'video' : '';
        console.log('[Image Saver] Медиа выбрано по жесту (CSS-фон/overlay):', sanitizeUrlForLog(rawImageUrl));
      }
    }

    // 1. Prevent non-media text/navigation links from falling through to page-level OpenGraph metadata.
    if (!gesturePlayer && !hasMediaAssociation(rawImageUrl, rawLinkUrl)) {
      console.log('[Image Saver] Клик контекстного меню вызван без ассоциации с медиа — отмена разрешения');
      // No proven selected target (blank area, text, caption, a plain navigation link, a container): nothing is
      // resolved, probed or saved, before any provider or generic resolver runs. A click on the page entry or on a
      // link (the only way the image entry is reached without media) is refused visibly, not silently.
      if (info.menuItemId === CSS_MEDIA_MENU_ID || info.menuItemId === 'save-image-item' || rawLinkUrl) {
        const noMediaOp = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: '', site: fbSiteOf(info.pageUrl || tab?.url, '') });
        await fbFail(noMediaOp, { stage: 'resolve', code: 'NO_MEDIA' });
        await fbBadgeReporter(noMediaOp)('ERR', '#ef4444');
      }
      return;
    }

    // 2. Prevent duplicate in-flight resolution/download pipelines for the same normalized source media
    // an inline Save is keyed by the document and the very player it came from: another player's save is a request of its own, a repeat of the same player is a duplicate
    const dedupeKey = rawImageUrl || rawLinkUrl || (inlineRedGifs
      ? `gesture-player:${tab.id}:${info.frameId ?? 0}:${inlineRedGifs.documentId}:${inlineRedGifs.player}`
      : `gesture-player:${tab.id}:${info.frameId ?? 0}`);
    if (inFlightRequests.has(dedupeKey)) {
      console.warn('[Image Saver] Запрос на сохранение данного медиа уже выполняется, игнорируем дубликат:', dedupeKey);
      return;
    }
    inFlightRequests.add(dedupeKey);
    activeResolvingCount++;

    const op = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: rawImageUrl || rawLinkUrl, site: fbSiteOf(info.pageUrl || tab?.url, rawImageUrl || rawLinkUrl) });
    const flashBadge = fbBadgeReporter(op);

    // Declared before the try so the catch block below can read it (it was try-scoped, which made the
    // catch itself throw a ReferenceError and skip the failure badge/feedback).
    let mediaPlan = null;
    try {
      await setBadge('...', '#3b82f6');

      const settings = await chrome.storage.local.get({
        subfolder: 'SavedImages',
        folderOrganizationMode: 'single'
      });

      const isBlob = rawImageUrl.startsWith('blob:');
      const isRedGifs = isRedGifsUrl(info.frameUrl) ||
                        isRedGifsUrl(info.pageUrl) ||
                        isRedGifsUrl(rawImageUrl) ||
                        isRedGifsUrl(rawLinkUrl);
      const isTweetThumb = Boolean(resolveTweetVideoThumbUrl(rawImageUrl)) || Boolean(resolveTweetVideoThumbUrl(rawLinkUrl));
      const isXPoster = isXVideoPosterUrl(rawImageUrl) || isXVideoPosterUrl(rawLinkUrl);
      let isVideo = info.mediaType === 'video' || gestureKind === 'video' || gesturePlayer || isDirectVideoUrl(rawImageUrl) || isDirectVideoUrl(rawLinkUrl) || isBlob || isRedGifs || isTweetThumb || isXPoster;
      let targetMediaUrl = null;
      let mediaResolution = null;
      await fbStage(op, 'resolving', { expectedType: isVideo ? 'video' : 'image' });

      // Fast path: Check for Danbooru DOM metadata before running full resolver search
      const isDanbooruHost = Boolean(
        tab?.id && (
          isDanbooruDomain(getUrlHostname(info.pageUrl)) ||
          isDanbooruDomain(getUrlHostname(rawImageUrl)) ||
          isDanbooruDomain(getUrlHostname(rawLinkUrl))
        )
      );

      let booruDomMeta = null;
      if (isDanbooruHost) {
        try {
          const clickedTarget = rawImageUrl || rawLinkUrl;
          const domRes = await queryBooruDomMetadata(tab.id, clickedTarget);
          if (isValidDanbooruMetadata(domRes, clickedTarget)) {
            booruDomMeta = domRes;
            console.log('[Image Saver] Получены валидные DOM метаданные Danbooru (Fast Path):', sanitizeUrlForLog(booruDomMeta.originalUrl));
          }
        } catch (_) {}
      }

      if (booruDomMeta) {
        const ext = booruDomMeta.fileExt.toLowerCase();
        const extToMime = {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          webp: 'image/webp',
          gif: 'image/gif',
          webm: 'video/webm',
          mp4: 'video/mp4'
        };
        const mime = extToMime[ext] || 'image/jpeg';
        const isFastVideo = booruDomMeta.isVideo || ext === 'webm' || ext === 'mp4';
        const isFastAnimated = booruDomMeta.isAnimated || ext === 'gif' || isFastVideo;

        mediaPlan = adaptCandidateToGroup({
          url: booruDomMeta.originalUrl,
          source: 'booru_dom_metadata',
          score: 95,
          tier: 'original',
          allowVideo: isFastVideo,
          isBooruCandidate: true,
          provider: 'DanbooruEngine',
          metadata: {
            contentType: mime,
            fileExt: ext,
            isAnimated: isFastAnimated,
            isVideo: isFastVideo,
            md5: booruDomMeta.md5,
            postId: booruDomMeta.postId,
            mimeEvidence: MIME_EVIDENCE.URL_HINT
          }
        });
        if (mediaPlan) {
          mediaPlan._domFastPath = true;
          mediaPlan.verified = false;
          mediaPlan.primaryUrl = booruDomMeta.originalUrl;
          targetMediaUrl = booruDomMeta.originalUrl;
          if (isFastVideo) isVideo = true;
        }
      }

      // Fallback: If DOM metadata is absent or invalid, execute standard resolver search
      if (!targetMediaUrl || !mediaPlan) {
        if (isVideo) {
          mediaResolution = await resolveMediaTarget({
            descriptor: createMediaDescriptor({
              type: 'video',
              src: rawImageUrl || rawLinkUrl,
              currentSrc: rawImageUrl || '',
              pageUrl: info.pageUrl,
              linkUrl: rawLinkUrl,
              poster: isXPoster ? (isXVideoPosterUrl(rawImageUrl) ? rawImageUrl : rawLinkUrl) : null,
              isBlobPlayer: isXPoster ? true : false,
              isXVideoPoster: isXPoster
            }),
            srcUrl: rawImageUrl,
            pageUrl: info.pageUrl,
            linkUrl: rawLinkUrl,
            tabId: tab?.id,
            frameId: info.frameId,
            gesturePlayer,
            gestureDocumentId,
            gestureAt,
            inlineToken,
            redGifsEmbed: redditInlineInfos.has(info) && info.redditInlineRedGifs ? info.redditInlineRedGifs : undefined
          });
          targetMediaUrl = mediaResolution?.targetUrl;
          mediaPlan = mediaResolution?.mediaPlan;
        } else {
          mediaPlan = await resolveOriginalMediaPlan({
            srcUrl: rawImageUrl || '',
            pageUrl: info.pageUrl,
            linkUrl: rawLinkUrl,
            tabId: tab?.id,
            frameId: info.frameId
          });
          targetMediaUrl = mediaPlan?.primaryUrl;
        }
      }

      const tProfilerPlan = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
      console.log(`[Chooser Profiler] 2. media plan selected (+${(tProfilerPlan - tProfilerStart).toFixed(1)}ms, duration: ${(tProfilerPlan - tProfilerStart).toFixed(1)}ms, target: ${sanitizeUrlForLog(targetMediaUrl)})`);

      if (!targetMediaUrl || !mediaPlan || mediaPlan?._rateLimited || mediaPlan?._verificationStatus === 429 || mediaPlan?.error === 'RATE_LIMIT' || mediaPlan?._verificationStatus === 403 || mediaPlan?._verificationStatus === 401 || mediaPlan?.error === 'AUTH_REQUIRED' || mediaPlan?.error === 'NOT_FOUND') {
        if (mediaPlan?._rateLimited || mediaPlan?._verificationStatus === 429 || mediaPlan?.error === 'RATE_LIMIT' || mediaResolution?.error === 'RATE_LIMIT' || mediaResolution?.status === 429) {
          console.warn('[Image Saver] Отмена скачивания из-за HTTP 429 (RATE_LIMIT):', sanitizeUrlForLog(rawImageUrl || rawLinkUrl));
          await fbFail(op, { stage: 'resolve', code: 'RATE_LIMIT', status: fbStatusIn([mediaPlan?._verificationStatus, mediaResolution?.status], [429]) });
          await flashBadge('RATE', '#f59e0b');
          return;
        }
        if (mediaPlan?._verificationStatus === 403 || mediaPlan?._verificationStatus === 401 || mediaPlan?.error === 'AUTH_REQUIRED' || mediaResolution?.error === 'AUTH_REQUIRED') {
          console.warn('[Image Saver] Отмена скачивания: ' + (mediaPlan?.message || mediaResolution?.message || 'требуется активная сессия'));
          await fbFail(op, { stage: 'resolve', code: 'AUTH_REQUIRED', status: fbStatusIn([mediaPlan?._verificationStatus, mediaResolution?.status], [401, 403]) });
          await flashBadge('AUTH', '#f59e0b');
          return;
        }
        if (mediaResolution?.error === 'UNRESOLVED_BLOB_MEDIA') {
          console.warn('[Image Saver] Отмена скачивания: не удалось разрешить blob URL (UNRESOLVED_BLOB_MEDIA)');
          await fbFail(op, { stage: 'resolve', code: 'UNRESOLVED_BLOB_MEDIA' });
          await flashBadge('ERR', '#ef4444');
          return;
        }
        if (!targetMediaUrl || !mediaPlan || mediaPlan?.error === 'NOT_FOUND') {
          console.warn('[Image Saver] Не удалось определить медиа для сохранения');
          const notFound = mediaPlan?.error === 'NOT_FOUND';
          await fbFail(op, {
            stage: 'resolve',
            code: notFound ? 'NOT_FOUND' : 'NO_MEDIA',
            // Keep an observed status; a status the pipeline defaulted (marked unobserved) is not evidence.
            status: notFound && mediaPlan._verificationStatusObserved !== false ? mediaPlan._verificationStatus : null
          });
          await flashBadge('ERR', '#ef4444');
          return;
        }
      }

      const isProtected = Boolean(getProtectedHostInfo(targetMediaUrl) || mediaPlan?.transport === 'protectedBlob' || mediaPlan?.transport === 'protected');

      // Verify the final media MIME via actual network probe/protected fetch
      const tProfilerMimeStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
      console.log(`[Chooser Profiler] 3. MIME check started (+${(tProfilerMimeStart - tProfilerStart).toFixed(1)}ms, target: ${sanitizeUrlForLog(targetMediaUrl)})`);
      const verifiedMime = await verifyFinalMediaMime(targetMediaUrl, mediaPlan, isVideo);
      const tProfilerMimeEnd = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
      console.log(`[Chooser Profiler] 4. MIME check completed (+${(tProfilerMimeEnd - tProfilerStart).toFixed(1)}ms, duration: ${(tProfilerMimeEnd - tProfilerMimeStart).toFixed(1)}ms, verifiedMime: ${verifiedMime})`);

      if (mediaPlan?.verifiedBlob?.url && mediaPlan.verifiedBlob.url !== targetMediaUrl) {
        targetMediaUrl = mediaPlan.verifiedBlob.url;
      } else if (mediaPlan?.metadata?.verifiedUrl && mediaPlan.metadata.verifiedUrl !== targetMediaUrl) {
        targetMediaUrl = mediaPlan.metadata.verifiedUrl;
      }

      if (mediaPlan?._rateLimited || mediaPlan?._verificationStatus === 429 || mediaPlan?.error === 'RATE_LIMIT') {
        console.warn('[Image Saver] Остановка конвейера сохранения из-за HTTP 429 (RATE_LIMIT):', sanitizeUrlForLog(targetMediaUrl));
        await fbFail(op, { stage: 'verify', code: 'RATE_LIMIT', status: fbStatusIn([mediaPlan?._verificationStatus], [429]) });
        await flashBadge('RATE', '#f59e0b');
        return;
      }

      if (mediaPlan?._verificationStatus === 403 || mediaPlan?._verificationStatus === 401 || mediaPlan?.error === 'AUTH_REQUIRED') {
        console.warn('[Image Saver] Отмена скачивания: требуется авторизация (HTTP 403/401):', sanitizeUrlForLog(targetMediaUrl));
        await fbFail(op, { stage: 'verify', code: 'AUTH_REQUIRED', status: fbStatusIn([mediaPlan?._verificationStatus], [401, 403]) });
        await flashBadge('AUTH', '#f59e0b');
        return;
      }

      if (!verifiedMime && (isVideo || isProtected || mediaPlan?._domFastPath || mediaPlan?._probeFailed)) {
        console.warn('[Image Saver] Финальная верификация MIME завершилась неудачей, скачивание отклонено:', sanitizeUrlForLog(targetMediaUrl));
        await fbFail(op, { stage: 'verify', code: 'MIME_NOT_VERIFIED' });
        if (mediaPlan?.verifiedBlob?.probeTaskKey) {
          await releaseOffscreenTask(mediaPlan.verifiedBlob.probeTaskKey, mediaPlan.verifiedBlob.blobUrl).catch(() => {});
          delete mediaPlan.verifiedBlob;
        }
        await flashBadge('ERR', '#ef4444');
        return;
      }

      const isXTweetVideo = Boolean(isTweetThumb) ||
                            Boolean(resolveTweetVideoThumbUrl(targetMediaUrl)) ||
                            Boolean(resolveTweetVideoThumbUrl(rawImageUrl)) ||
                            Boolean(targetMediaUrl && toTweetVideoUrl(targetMediaUrl)) ||
                            mediaResolution?.descriptor?.type === 'x_tweet_video' ||
                            mediaResolution?.classification?.sourceType === 'x_tweet_video';

      if (isXTweetVideo && targetMediaUrl) {
        await executeXTweetVideoGifDownload(targetMediaUrl, settings, { pageUrl: info.pageUrl || tab?.url || '', feedbackOp: op });
        return;
      }

      const isRedditGif = isRedditAnimationUrl(targetMediaUrl) ||
                          isRedditAnimationUrl(rawImageUrl) ||
                          mediaResolution?.classification?.sourceType === 'reddit_gif' ||
                          mediaPlan?.metadata?.sourceType === 'reddit_gif';

      if (isRedditGif && targetMediaUrl) {
        await executeRedditGifDownload(targetMediaUrl, settings, { pageUrl: info.pageUrl || tab?.url || '', feedbackOp: op });
        return;
      }

      await executeMediaDownload({
        targetImageUrl: targetMediaUrl,
        rawImageUrl: rawImageUrl || targetMediaUrl,
        settings,
        mediaPlan,
        pageUrl: info.pageUrl || tab?.url || '',
        feedbackOp: op
      });
    } catch (downloadError) {
      if (mediaPlan?.verifiedBlob?.probeTaskKey) {
        await releaseOffscreenTask(mediaPlan.verifiedBlob.probeTaskKey, mediaPlan.verifiedBlob.blobUrl).catch(() => {});
        delete mediaPlan.verifiedBlob;
      }
      console.error('[Image Saver] Критическая ошибка при сохранении:', downloadError);
      await fbFail(op, { code: downloadError?.message });
      await flashBadge('ERR', '#ef4444');
    } finally {
      activeResolvingCount--;
      inFlightRequests.delete(dedupeKey);
      if (!flashBadgeTimeout) {
        await restoreOrClearBadge();
      }
    }
  } else if (info.menuItemId === 'save-x-media-item') {
    if (!tab?.id) {
      console.warn('[Image Saver] Клик по X media меню без активного tab.id');
      return;
    }

    const op = await fbBegin({ pageUrl: tab.url || info.pageUrl || '', sourceUrl: '', site: fbSiteOf(tab.url || info.pageUrl, '') });
    const flashBadge = fbBadgeReporter(op);

    try {
      let mediaResult = null;
      if (xInlineInfos.has(info)) {
        // The inline button's descriptor: built by this document's content script after it proved the owner again for this
        // very click (see handleXInlineSave); no context-menu cursor state is read. Everything below is the shared X pipeline.
        mediaResult = info.xInlineMedia;
      } else try {
        mediaResult = await chrome.tabs.sendMessage(tab.id, { action: 'GET_X_MEDIA_AT_CURSOR' });
      } catch (msgErr) {
        try {
          if (chrome.scripting?.executeScript) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content_x.js']
            });
            mediaResult = await chrome.tabs.sendMessage(tab.id, { action: 'GET_X_MEDIA_AT_CURSOR' });
          }
        } catch (injectErr) {
          console.warn('[Image Saver] Не удалось связаться с content_x.js:', injectErr);
        }
      }

      const rawMediaUrl = mediaResult?.url || mediaResult?.src;
      if (!mediaResult || !rawMediaUrl) {
        console.warn('[Image Saver] Медиа под курсором на странице X не найдено');
        await fbFail(op, { stage: 'resolve', code: 'NO_MEDIA' });
        await flashBadge('ERR', '#ef4444');
        return;
      }
      if (!mediaResult.url) {
        mediaResult.url = rawMediaUrl;
      }

      const settings = await chrome.storage.local.get({
        subfolder: 'SavedImages',
        folderOrganizationMode: 'single'
      });

      await fbSetPost(op, mediaResult.postUrl);
      await fbStage(op, 'resolving', {
        sourceUrl: mediaResult.url,
        expectedType: mediaResult.type === 'x_tweet_video' ? 'gif' : (mediaResult.type === 'video' ? 'video' : 'image'),
        conversion: mediaResult.type === 'x_tweet_video' ? 'x_tweet_video_gif' : undefined
      });

      const classification = classifyMediaTarget({
        url: mediaResult.url,
        domType: mediaResult.type,
        poster: mediaResult.poster,
        mime: mediaResult.mime
      });

      if (mediaResult.type === 'x_tweet_video' || classification?.sourceType === 'x_tweet_video') {
        let isValidTweetVideo = false;
        try {
          const parsed = new URL(mediaResult.url);
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            const h = parsed.hostname.toLowerCase();
            const p = parsed.pathname.toLowerCase();
            if (h === 'video.twimg.com' && p.includes('/tweet_video/') && p.endsWith('.mp4')) {
              isValidTweetVideo = true;
            }
          }
        } catch (e) {}

        if (!isValidTweetVideo) {
          console.warn('[Image Saver] Отклонен неподходящий URL X tweet_video:', sanitizeUrlForLog(mediaResult.url));
          await fbFail(op, { stage: 'verify', code: 'INVALID_MEDIA' });
          await flashBadge('ERR', '#ef4444');
          return;
        }

        const dedupeKey = mediaResult.url;
        if (inFlightRequests.has(dedupeKey)) {
          console.warn('[Image Saver] Загрузка этого X медиа уже выполняется:', sanitizeUrlForLog(dedupeKey));
          await fbDiscard(op);
          return;
        }
        inFlightRequests.add(dedupeKey);
        activeResolvingCount++;

        try {
          await executeXTweetVideoGifDownload(mediaResult.url, settings, { pageUrl: tab.url || info.pageUrl || '', feedbackOp: op });
        } catch (err) {
          console.error('[Image Saver] Ошибка конвертации и скачивания X tweet video:', err);
          await flashBadge('ERR', '#ef4444');
        } finally {
          activeResolvingCount--;
          inFlightRequests.delete(dedupeKey);
          if (!flashBadgeTimeout) {
            await restoreOrClearBadge();
          }
        }
      } else if (mediaResult.type === 'video') {
        let rawVideoUrl = mediaResult.src || mediaResult.url;
        const isBlobOrManifest = !rawVideoUrl || rawVideoUrl.startsWith('blob:') || mediaResult.isBlobPlayer || isHlsManifestUrl(rawVideoUrl);

        if (mediaResult.recoveredMp4Url) {
          rawVideoUrl = mediaResult.recoveredMp4Url;
        } else if (mediaResult.isHlsOnly && !isBlobOrManifest) {
          console.warn('[Image Saver] Видео в посте X доступно только в виде HLS-потока (m3u8) без прямого MP4 варианта:', sanitizeUrlForLog(mediaResult.postUrl || rawVideoUrl));
          await fbFail(op, { stage: 'resolve', code: 'HLS_ONLY' });
          await flashBadge('ERR', '#ef4444');
          return;
        } else if (isBlobOrManifest) {
          // Player exposed only blob: or a manifest: recover direct MP4 variant from first-party post metadata
          const recovery = await recoverXPostMp4Variant(tab.id, mediaResult);
          if (recovery.ok && recovery.mp4Url) {
            rawVideoUrl = recovery.mp4Url;
          } else if (recovery.isHlsOnly) {
            console.warn('[Image Saver] Видео в посте X доступно только в виде HLS-потока (m3u8) без прямого MP4 варианта:', sanitizeUrlForLog(mediaResult.postUrl || rawVideoUrl));
          await fbFail(op, { stage: 'resolve', code: 'HLS_ONLY' });
            await flashBadge('ERR', '#ef4444');
            return;
          } else {
            console.warn('[Image Saver] Не удалось восстановить прямой MP4 из метаданных поста X для blob-плеера:', sanitizeUrlForLog(mediaResult.postUrl || rawVideoUrl), describeXRecoveryFailure(recovery));
            await fbFail(op, { stage: 'resolve', code: 'NO_MEDIA' });
            await flashBadge('ERR', '#ef4444');
            return;
          }
        }

        if (!isValidXVideoCdnUrl(rawVideoUrl)) {
          console.warn('[Image Saver] Невалидный CDN хост для видео X:', sanitizeUrlForLog(rawVideoUrl));
          await flashBadge('ERR', '#ef4444');
          return;
        }

        let parsedUrl;
        try {
          parsedUrl = new URL(rawVideoUrl);
        } catch (_) {
          console.warn('[Image Saver] Некорректный URL видео с X:', sanitizeUrlForLog(rawVideoUrl));
          await flashBadge('ERR', '#ef4444');
          return;
        }
        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
          console.warn('[Image Saver] Неподдерживаемый протокол видео с X:', sanitizeUrlForLog(rawVideoUrl));
          await flashBadge('ERR', '#ef4444');
          return;
        }

        const dedupeKey = rawVideoUrl;
        if (inFlightRequests.has(dedupeKey)) {
          console.warn('[Image Saver] Загрузка этого видео уже выполняется:', sanitizeUrlForLog(dedupeKey));
          await fbDiscard(op);
          return;
        }
        inFlightRequests.add(dedupeKey);
        activeResolvingCount++;

        try {
          await setBadge('...', '#3b82f6');
          const probe = await probeVideoUrlDetails(rawVideoUrl);
          if (probe && (probe.status === 401 || probe.status === 403 || probe.requiresAuth)) {
            console.warn('[Image Saver] Ошибка авторизации видео с X (HTTP 401/403):', sanitizeUrlForLog(rawVideoUrl));
            await fbFail(op, { stage: 'verify', code: 'AUTH_REQUIRED', status: fbStatusIn([probe?.status], [401, 403]) });
            await flashBadge('AUTH', '#f59e0b');
            return;
          }
          if (probe && (probe.status === 429 || probe.error === 'RATE_LIMIT')) {
            console.warn('[Image Saver] Превышен лимит запросов для видео с X (HTTP 429):', sanitizeUrlForLog(rawVideoUrl));
            await fbFail(op, { stage: 'verify', code: 'RATE_LIMIT', status: fbStatusIn([probe?.status], [429]) });
            await flashBadge('RATE', '#f59e0b');
            return;
          }
          if (!probe || !probe.ok) {
            console.warn('[Image Saver] Ошибка проверки доступности видео с X:', probe?.error || probe?.status);
            await fbFail(op, { stage: 'verify', code: probe?.error, status: Number.isInteger(probe?.status) ? probe.status : null });
            await flashBadge('ERR', '#ef4444');
            return;
          }

          const verifiedType = (probe.contentType || '').split(';')[0].trim().toLowerCase();
          const isAcceptableMp4Mime = (
            verifiedType === 'video/mp4' ||
            ((verifiedType === 'application/octet-stream' || verifiedType === 'binary/octet-stream' || verifiedType === '') &&
             isDirectVideoUrl(rawVideoUrl) && !rawVideoUrl.toLowerCase().includes('.webm') && !rawVideoUrl.toLowerCase().includes('.mov'))
          );
          if (verifiedType === 'video/webm' || verifiedType === 'video/quicktime' || verifiedType.includes('webm') || verifiedType.includes('quicktime') || !isAcceptableMp4Mime) {
            console.warn('[Image Saver] Отклонен неподходящий Content-Type для X MP4:', verifiedType);
            await fbFail(op, { stage: 'verify', code: 'INVALID_MEDIA' });
            await flashBadge('ERR', '#ef4444');
            return;
          }

          // Bounded MP4 container byte verification
          const containerCheck = await verifyMp4ContainerBytes(rawVideoUrl);
          if (!containerCheck.ok) {
            console.warn('[Image Saver] Отклонен невалидный MP4 контейнер для видео с X:', containerCheck.error, containerCheck.sniffedMime || '');
            await fbFail(op, { stage: 'verify', code: 'INVALID_CONTAINER' });
            await flashBadge('ERR', '#ef4444');
            return;
          }

          const mediaPlan = adaptCandidateToGroup({
            url: rawVideoUrl,
            source: 'x_video',
            tier: 'original',
            score: 90,
            contentType: 'video/mp4',
            mediaType: 'video',
            verified: true
          });

          await executeMediaDownload({
            targetImageUrl: rawVideoUrl,
            rawImageUrl: rawVideoUrl,
            settings,
            mediaPlan,
            pageUrl: tab.url || info.pageUrl || '',
            feedbackOp: op
          });
        } catch (err) {
          console.error('[Image Saver] Ошибка скачивания видео с X:', err);
          await flashBadge('ERR', '#ef4444');
        } finally {
          activeResolvingCount--;
          inFlightRequests.delete(dedupeKey);
          if (!flashBadgeTimeout) {
            await restoreOrClearBadge();
          }
        }
      } else if (mediaResult.type === 'image') {
        const rawImageUrl = mediaResult.url;
        const dedupeKey = rawImageUrl;
        if (inFlightRequests.has(dedupeKey)) {
          console.warn('[Image Saver] Загрузка этого изображения уже выполняется:', sanitizeUrlForLog(dedupeKey));
          await fbDiscard(op);
          return;
        }
        inFlightRequests.add(dedupeKey);
        activeResolvingCount++;

        try {
          await setBadge('...', '#3b82f6');
          const mediaPlan = await resolveOriginalMediaPlan({
            srcUrl: rawImageUrl,
            pageUrl: tab.url || info.pageUrl,
            tabId: tab.id
          });
          const targetImageUrl = mediaPlan?.primaryUrl;

          if (!targetImageUrl && !mediaPlan) {
            console.warn('[Image Saver] Не удалось определить изображение для сохранения с X:', sanitizeUrlForLog(rawImageUrl));
            await flashBadge('ERR', '#ef4444');
            return;
          }

          await executeMediaDownload({
            targetImageUrl,
            rawImageUrl,
            settings,
            mediaPlan,
            pageUrl: tab.url || info.pageUrl || '',
            feedbackOp: op
          });
        } catch (err) {
          console.error('[Image Saver] Ошибка скачивания изображения с X:', err);
          await flashBadge('ERR', '#ef4444');
        } finally {
          activeResolvingCount--;
          inFlightRequests.delete(dedupeKey);
          if (!flashBadgeTimeout) {
            await restoreOrClearBadge();
          }
        }
      } else {
        console.warn('[Image Saver] Неподдерживаемый тип медиа с X:', mediaResult.type);
        await fbFail(op, { stage: 'resolve', code: 'UNSUPPORTED_MEDIA' });
        await flashBadge('ERR', '#ef4444');
      }
    } catch (outerErr) {
      console.error('[Image Saver] Общая ошибка при обработке X media:', outerErr);
      await flashBadge('ERR', '#ef4444');
    }
  }
}
chrome.contextMenus.onClicked.addListener(onContextMenuClicked);

// UX-10: the inline Save control over X media ("Save this", and "Save all" for a post with several media). The content script sends only a one-shot token. This handler validates the sender
// (the extension's own content script, an X page, the active tab, a frame), asks the same frame and document to prove the owner
// again and to build the descriptor with the context-menu builder, re-validates what comes back, and then runs the existing
// save-x-media-item pipeline above, so both entries share resolution, verification, GIF semantics, folders, the download
// lifecycle and feedback. A removed, replaced, re-sourced, moved or recycled owner is refused before any provider request.
const xInlineInfos = new WeakSet();
const xInlineBusy = new Set();
const X_INLINE_TOKEN = /^[a-f0-9]{32}$/;
// Save all: at most this many items per post and this many items in flight at once.
const X_INLINE_BATCH_MAX = 12;
const X_INLINE_BATCH_CONCURRENCY = 2;

function sanitizeXInlineMedia(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = (v, max = 2048) => (typeof v === 'string' && v.length <= max ? v : '');
  const twimg = (u) => {
    try { const p = new URL(u); return p.protocol === 'https:' && (p.hostname === 'twimg.com' || p.hostname.endsWith('.twimg.com')); } catch (_) { return false; }
  };
  const digits = (v) => (typeof v === 'string' && /^\d{1,25}$/.test(v) ? v : null);
  const type = raw.type;
  if (type !== 'image' && type !== 'video' && type !== 'x_tweet_video') return null;
  const url = text(raw.url);
  const src = text(raw.src) || url;
  if ((type === 'image' || type === 'x_tweet_video') && !twimg(url)) return null;
  if (type === 'video' && url && !url.startsWith('blob:') && !twimg(url)) return null;
  const poster = text(raw.poster);
  if (poster && !twimg(poster)) return null;
  const recovered = text(raw.recoveredMp4Url);
  if (recovered && !isValidXVideoCdnUrl(recovered)) return null;
  const postUrl = text(raw.postUrl);
  if (postUrl && !isXPageUrl(postUrl)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6 ? v : null);
  return {
    type, src, url, currentSrc: text(raw.currentSrc) || src, poster: poster || null, mime: text(raw.mime, 100) || null,
    pageUrl: text(raw.pageUrl), linkUrl: text(raw.linkUrl) || null, x: num(raw.x), y: num(raw.y),
    sourceType: ['image', 'video', 'x_tweet_video'].includes(raw.sourceType) ? raw.sourceType : type,
    animated: raw.animated === true, isHlsOnly: raw.isHlsOnly === true, isBlobPlayer: raw.isBlobPlayer === true,
    recoveredMp4Url: recovered || null, recoveredBitrate: num(raw.recoveredBitrate), postUrl: postUrl || null,
    tweetId: digits(raw.tweetId), mediaIdHint: digits(raw.mediaIdHint),
    mediaIndex: Number.isInteger(raw.mediaIndex) && raw.mediaIndex >= 0 && raw.mediaIndex < 100 ? raw.mediaIndex : null,
    isQuoteTweet: raw.isQuoteTweet === true
  };
}

// The extension's own content script, an X page, the active tab, a well-formed one-shot token. Nothing else in the message is read.
function xInlineSenderOk(message, sender) {
  return isContentScriptSender(sender) && isXPageUrl(sender.url) && sender.tab.active === true &&
    typeof message.token === 'string' && X_INLINE_TOKEN.test(message.token);
}

// Only the sending frame and the sending document can answer.
async function xInlineAsk(tab, sender, payload) {
  try {
    const options = { frameId: sender.frameId };
    if (typeof sender.documentId === 'string' && sender.documentId) options.documentId = sender.documentId;
    return await chrome.tabs.sendMessage(tab.id, payload, options);
  } catch (_) {
    return null;
  }
}

// A refused owner is visible: a failed operation and an ERR badge, never silence and never a request.
async function xInlineRefuse(sender) {
  const op = await fbBegin({ pageUrl: sender.url || '', sourceUrl: '', site: fbSiteOf(sender.url, '') });
  await fbFail(op, { stage: 'resolve', code: 'NO_MEDIA' });
  await fbBadgeReporter(op)('ERR', '#ef4444');
}

// One proven descriptor through the shared save-x-media-item pipeline, unless the same item is already running.
async function xInlineRun(tab, sender, media) {
  const key = `${tab.id}:${sender.frameId}:${media.recoveredMp4Url || media.url || media.poster || ''}|${media.tweetId || ''}`;
  if (xInlineBusy.has(key)) return false;
  xInlineBusy.add(key);
  try {
    const info = { menuItemId: 'save-x-media-item', pageUrl: sender.url, frameId: sender.frameId, xInlineMedia: media };
    xInlineInfos.add(info);
    await onContextMenuClicked(info, tab);
    return true;
  } finally {
    xInlineBusy.delete(key);
  }
}

async function handleXInlineSave(message, sender) {
  if (!xInlineSenderOk(message, sender)) return;
  const answer = await xInlineAsk(sender.tab, sender, { action: 'X_INLINE_OWNER', token: message.token });
  const media = answer && answer.ok === true ? sanitizeXInlineMedia(answer.media) : null;
  if (!media) {
    console.warn('[Image Saver] Inline X Save refused: the owner was not proven again');
    await xInlineRefuse(sender);
    return;
  }
  await xInlineRun(sender.tab, sender, media);
}

// "Save all (N)": the document proves the whole list first (count, owner, every item), then each item is proven AGAIN right before
// it is saved, so a post that is removed, recycled or navigated away during the batch never redirects work to another post.
// Items run through the same pipeline as a single save with bounded concurrency; one failed or refused item never touches the
// others, and every refused item is reported as a failed operation.
async function handleXInlineSaveAll(message, sender) {
  if (!xInlineSenderOk(message, sender)) return;
  const tab = sender.tab;
  const open = await xInlineAsk(tab, sender, { action: 'X_INLINE_BATCH', token: message.token });
  const count = open && open.ok === true && Number.isInteger(open.count) ? open.count : 0;
  if (count < 2 || count > X_INLINE_BATCH_MAX) {
    console.warn('[Image Saver] Inline X Save all refused: the list of media was not proven');
    await xInlineRefuse(sender);
    return;
  }
  const ownerId = typeof open.ownerId === 'string' && /^\d{1,25}$/.test(open.ownerId) ? open.ownerId : '';
  const sig = typeof open.sig === 'string' && /^[a-f0-9]{8}$/.test(open.sig) ? open.sig : '';
  const batchKey = `${tab.id}:${sender.frameId}:all:${ownerId}:${sig}`;
  if (xInlineBusy.has(batchKey)) return;
  xInlineBusy.add(batchKey);
  const tally = { started: 0, refused: 0, duplicate: 0 };
  let next = 0;
  let lost = false;
  const worker = async () => {
    while (!lost) {
      const index = next++;
      if (index >= count) return;
      const answer = await xInlineAsk(tab, sender, { action: 'X_INLINE_OWNER_ITEM', token: message.token, index });
      const media = answer && answer.ok === true ? sanitizeXInlineMedia(answer.media) : null;
      if (!media) {
        tally.refused++;
        // an item that changed on its own is skipped; an owner that is gone, replaced, navigated or unknown ends the batch
        if (!answer || answer.ok !== false || answer.reason !== 'STALE_ITEM') lost = true;
        await xInlineRefuse(sender);
        continue;
      }
      if (await xInlineRun(tab, sender, media)) tally.started++;
      else tally.duplicate++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(X_INLINE_BATCH_CONCURRENCY, count) }, worker));
    for (let i = Math.min(next, count); i < count; i++) {
      tally.refused++;
      await xInlineRefuse(sender);
    }
    console.info('[Image Saver] Inline X Save all:', { items: count, ...tally });
  } finally {
    xInlineBusy.delete(batchKey);
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message) return;
    if (message.action === 'X_INLINE_SAVE') {
      handleXInlineSave(message, sender).catch((e) => console.warn('[Image Saver] Inline X Save failed:', e?.message || e));
    } else if (message.action === 'X_INLINE_SAVE_ALL') {
      handleXInlineSaveAll(message, sender).catch((e) => console.warn('[Image Saver] Inline X Save all failed:', e?.message || e));
    }
  });
}

// UX-11-RD: the inline Save control over Reddit media ("Save this", and "Save all (N)" for a proven complete gallery). Same shape as the
// X entry above, own message set (REDDIT_INLINE_*), own validation: the content script sends only a one-shot token; this handler
// validates the sender (the extension's own content script, a Reddit page, the active tab, a frame), asks the same frame and document
// to prove the owner again, re-validates the descriptor that comes back, and runs the existing save-image-item pipeline of
// onContextMenuClicked, so resolution, verification, native GIF, confirmed Reddit animation conversion, RedGIFs-as-video, folders,
// Folder routing, the download lifecycle and feedback are shared with the menu. The only thing the inline entry skips is the gesture-captured
// owner gate and the cursor query: the fresh proof replaces them, and a stale context-menu capture must never decide an inline click.
// Contract: docs/changes/2026-10-04-ux11-rd-backend.md.
const redditInlineInfos = new WeakSet();
const redgifsInlineInfos = new WeakSet();
const REDGIFS_INLINE_MAX_ACTIVE = 4;
let redgifsInlineActive = 0;
const redditInlineBusy = new Set();
const REDDIT_INLINE_TOKEN = /^[a-f0-9]{32}$/;
const REDDIT_INLINE_OWNER_ID = /^t3_[a-z0-9]{1,12}$/;
// Save all: a complete gallery is 2..20 items (Reddit's own gallery limit); two items are in flight at once.
const REDDIT_INLINE_BATCH_MIN = 2;
const REDDIT_INLINE_BATCH_MAX = 20;
const REDDIT_INLINE_BATCH_CONCURRENCY = 2;

function isRedditPageUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === 'https:' && isRedditDomain(p.hostname);
  } catch (_) {
    return false;
  }
}

// The embed document address of a RedGIFs clip: https, the RedGIFs host itself (or www), exactly /ifr/<id>. Returns the lowercase clip id, else ''.
// `loose` ignores a query or fragment (the address of a live frame); the address a document hands over carries neither.
function redGifsEmbedClipOf(url, { loose = false } = {}) {
  try {
    const p = new URL(url);
    if (p.protocol !== 'https:' || p.username || p.password || p.port) return '';
    const host = p.hostname.toLowerCase();
    if (host !== 'redgifs.com' && host !== 'www.redgifs.com') return '';
    if (!loose && (p.search || p.hash)) return '';
    const m = p.pathname.match(/^\/ifr\/([A-Za-z0-9_-]{3,64})\/?$/);
    return m ? m[1].toLowerCase() : '';
  } catch (_) {
    return '';
  }
}

// The one frame of the tab that shows this clip's embed document and is a direct child of the proven (top) document: the post's embed is
// cross-origin, so the document cannot name its frame. The extension asks every frame only for its address and whether it sits directly
// under the top document. Exactly one match, with its document id, else null (none, ambiguous, nested deeper, a navigation in between).
async function redditInlineFindRedGifsFrame(tabId, sender, clip) {
  if (!clip || sender.frameId !== 0 || !chrome.scripting?.executeScript) return null;
  let results = null;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ href: location.href, child: window !== window.top && window.parent === window.top })
    });
  } catch (_) {
    return null;
  }
  const hits = (Array.isArray(results) ? results : []).filter((r) => r && Number.isInteger(r.frameId) && r.frameId > 0 &&
    r.result && r.result.child === true && typeof r.result.href === 'string' && redGifsEmbedClipOf(r.result.href, { loose: true }) === clip);
  if (hits.length !== 1) return null;
  const documentId = typeof hits[0].documentId === 'string' ? hits[0].documentId : '';
  return { frameId: hits[0].frameId, documentId };
}

// A direct media address on a Reddit media host, or a direct RedGIFs asset for a video. Never blob:, data:, a manifest or a page.
function redditInlineUrlOk(url, kind) {
  const v = validateRedditCandidateUrl(url);
  if (v.valid) {
    try {
      const p = new URL(url);
      const host = p.hostname.toLowerCase();
      if (host === 'redd.it' || host.endsWith('.redd.it')) return true;
      // the reddit.com media wrapper, only when the address it wraps is itself a Reddit media host
      if (p.pathname === '/media' && p.searchParams.has('url')) {
        const inner = new URL(p.searchParams.get('url'));
        return inner.protocol === 'https:' && (inner.hostname === 'redd.it' || inner.hostname.endsWith('.redd.it'));
      }
    } catch (_) {}
    return false;
  }
  return kind === 'video' && Boolean(validateRedGifsCandidateUrl(url).valid);
}

// What the document proved, reduced to the fields the pipeline may use. `expect` (batch items) binds the item to the batch the
// document opened: same owner, same count, the same structure signature, the asked index. Anything else in the answer is ignored.
function sanitizeRedditInlineMedia(raw, expect) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind;
  if (kind !== 'image' && kind !== 'video') return null;
  const url = typeof raw.url === 'string' && raw.url.length <= 2048 ? raw.url : '';
  // a RedGIFs embed (RD-10): the document proved the clip its post declares; the address is only the strict embed address of that clip
  // (never part of a batch) and the frame is found and proven again by the background
  const embedClip = raw.redgifsEmbed === true && kind === 'video' && !expect ? redGifsEmbedClipOf(url) : '';
  if (!url || (raw.redgifsEmbed === true ? !embedClip : !redditInlineUrlOk(url, kind))) return null;
  const ownerId = typeof raw.ownerId === 'string' && REDDIT_INLINE_OWNER_ID.test(raw.ownerId) ? raw.ownerId : '';
  if (!ownerId) return null;
  let postUrl = null;
  if (raw.postUrl !== undefined && raw.postUrl !== null && raw.postUrl !== '') {
    const permalink = typeof raw.postUrl === 'string' && raw.postUrl.length <= 2048 && isRedditPageUrl(raw.postUrl) ? raw.postUrl : '';
    const m = permalink ? new URL(permalink).pathname.match(/\/comments\/([a-z0-9]{1,12})(?:\/|$)/i) : null;
    if (!m || `t3_${m[1].toLowerCase()}` !== ownerId) return null;
    postUrl = permalink;
  }
  let index = null;
  let count = null;
  let sig = null;
  if (expect) {
    index = Number.isInteger(raw.index) ? raw.index : -1;
    count = Number.isInteger(raw.count) ? raw.count : -1;
    sig = typeof raw.sig === 'string' && /^[a-f0-9]{8}$/.test(raw.sig) ? raw.sig : '';
    if (ownerId !== expect.ownerId || count !== expect.count || index !== expect.index || sig !== expect.sig) return null;
  }
  return { kind, url, ownerId, postUrl, blobPlayer: raw.blobPlayer === true, index, count, sig, redgifsEmbedClip: embedClip };
}

// Why a proof was refused, for the log only: one of a fixed set of codes, never page data. The generic "owner not proven" wording hid whether the
// document refused (and why) or answered a descriptor the background rejected.
const REDDIT_INLINE_REASONS = new Set(['NO_TOKEN', 'USED', 'STALE_OWNER', 'STALE_LIST', 'STALE_ITEM', 'UNRESOLVED_BLOB', 'NO_MEDIA']);
function redditInlineWhy(answer) {
  if (!answer || typeof answer !== 'object') return 'NO_ANSWER';
  if (answer.ok === true) return 'INVALID_DESCRIPTOR';
  return REDDIT_INLINE_REASONS.has(answer.reason) ? answer.reason : 'REFUSED';
}

// The extension's own content script, a Reddit page, the active tab, a well-formed one-shot token. Nothing else in the message is read.
function redditInlineSenderOk(message, sender) {
  return isContentScriptSender(sender) && isRedditPageUrl(sender.url) && sender.tab.active === true &&
    typeof message.token === 'string' && REDDIT_INLINE_TOKEN.test(message.token);
}

// A refused owner or item is visible: a failed operation and an ERR badge, never silence and never a request.
async function redditInlineRefuse(sender, code = 'NO_MEDIA') {
  const op = await fbBegin({ pageUrl: sender.url || '', sourceUrl: '', site: fbSiteOf(sender.url, '') });
  await fbFail(op, { stage: 'resolve', code });
  await fbBadgeReporter(op)('ERR', '#ef4444');
}

// One proven descriptor through the shared save-image-item pipeline, unless the same asset is already running.
async function redditInlineRun(tab, sender, media) {
  const embed = media.redgifsEmbedClip || '';
  const key = `${tab.id}:${sender.frameId}:${embed ? `${media.ownerId}:` : ''}${media.url}`;
  if (redditInlineBusy.has(key)) return false;
  redditInlineBusy.add(key);
  try {
    // `kind` is only the menu's mediaType hint: the shared pipeline recognises an animation (.gif with format=mp4), a direct video and a native .gif from the address itself
    const info = { menuItemId: 'save-image-item', srcUrl: media.url, pageUrl: sender.url, frameId: sender.frameId, mediaType: media.kind, redditInlineMedia: media };
    if (embed) {
      // RD-10: the click runs in the frame of the proven clip, pinned to the document found now, through the same resolver as the context menu
      const frame = await redditInlineFindRedGifsFrame(tab.id, sender, embed);
      if (!frame) {
        console.warn('[Image Saver] Inline Reddit Save refused: no single frame shows the embedded RedGIFs clip');
        await redditInlineRefuse(sender, 'UNRESOLVED_BLOB_MEDIA');
        return false;
      }
      info.frameId = frame.frameId;
      info.redditInlineRedGifs = { clipKey: embed, documentId: frame.documentId };
    }
    redditInlineInfos.add(info);
    await onContextMenuClicked(info, tab);
    return true;
  } finally {
    redditInlineBusy.delete(key);
  }
}

async function handleRedditInlineSave(message, sender) {
  if (!redditInlineSenderOk(message, sender)) return;
  const answer = await xInlineAsk(sender.tab, sender, { action: 'REDDIT_INLINE_OWNER', token: message.token });
  const media = answer && answer.ok === true ? sanitizeRedditInlineMedia(answer.media, null) : null;
  if (!media) {
    console.warn('[Image Saver] Inline Reddit Save refused:', redditInlineWhy(answer));
    await redditInlineRefuse(sender, answer && answer.ok === false && answer.reason === 'UNRESOLVED_BLOB' ? 'UNRESOLVED_BLOB_MEDIA' : 'NO_MEDIA');
    return;
  }
  await redditInlineRun(sender.tab, sender, media);
}

// "Save all (N)": the document proves the whole list first (count, owner, every item), then each item is proven AGAIN right before it
// runs, bound to the batch (same owner, same count, the same structure signature, the asked index). A post that is removed, recycled or navigated away during the
// batch never redirects work to another post. At most two items run at once; a failed or refused item never touches the others;
// every refused or unprocessed item is a failed operation, so nothing is silently dropped. A repeated asset is saved once.
async function handleRedditInlineSaveAll(message, sender) {
  if (!redditInlineSenderOk(message, sender)) return;
  const tab = sender.tab;
  const open = await xInlineAsk(tab, sender, { action: 'REDDIT_INLINE_BATCH', token: message.token });
  const count = open && open.ok === true && Number.isInteger(open.count) ? open.count : 0;
  const ownerId = open && typeof open.ownerId === 'string' && REDDIT_INLINE_OWNER_ID.test(open.ownerId) ? open.ownerId : '';
  const sig = open && typeof open.sig === 'string' && /^[a-f0-9]{8}$/.test(open.sig) ? open.sig : '';
  if (count < REDDIT_INLINE_BATCH_MIN || count > REDDIT_INLINE_BATCH_MAX || !ownerId || !sig) {
    console.warn('[Image Saver] Inline Reddit Save all refused:', redditInlineWhy(open));
    await redditInlineRefuse(sender);
    return;
  }
  const batchKey = `${tab.id}:${sender.frameId}:all:${ownerId}:${sig}`;
  if (redditInlineBusy.has(batchKey)) return;
  redditInlineBusy.add(batchKey);
  const tally = { started: 0, refused: 0, duplicate: 0 };
  const seen = new Set();
  let next = 0;
  let lost = false;
  const worker = async () => {
    while (!lost) {
      const index = next++;
      if (index >= count) return;
      const answer = await xInlineAsk(tab, sender, { action: 'REDDIT_INLINE_OWNER_ITEM', token: message.token, index });
      const media = answer && answer.ok === true ? sanitizeRedditInlineMedia(answer.media, { ownerId, count, index, sig }) : null;
      if (!media) {
        tally.refused++;
        // an item that changed or cannot be resolved on its own is skipped; an owner that is gone, replaced, navigated or unknown
        // (or an answer that does not match the batch) ends the batch
        const itemLevel = answer && answer.ok === false && (answer.reason === 'STALE_ITEM' || answer.reason === 'UNRESOLVED_BLOB');
        if (!itemLevel) lost = true;
        console.warn('[Image Saver] Inline Reddit Save all item refused:', index, redditInlineWhy(answer));
        await redditInlineRefuse(sender, answer && answer.reason === 'UNRESOLVED_BLOB' ? 'UNRESOLVED_BLOB_MEDIA' : 'NO_MEDIA');
        continue;
      }
      if (seen.has(media.url)) { tally.duplicate++; continue; }
      seen.add(media.url);
      if (await redditInlineRun(tab, sender, media)) tally.started++;
      else tally.duplicate++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(REDDIT_INLINE_BATCH_CONCURRENCY, count) }, worker));
    for (let i = Math.min(next, count); i < count; i++) {
      tally.refused++;
      await redditInlineRefuse(sender);
    }
    console.info('[Image Saver] Inline Reddit Save all:', { items: count, ...tally });
  } finally {
    redditInlineBusy.delete(batchKey);
  }
}

// REDGIFS-INLINE-01: the inline Save control of the provider's own site. The content script sends only a one-shot token. The sender must be the
// extension's own content script in the TOP document of www.redgifs.com (never an embed or another site), the active tab, with a document id; the
// token travels back to that frame and document (RESOLVE_FRAME_MEDIA), which resolves the exact player it issued it for, so the context-menu capture
// is never read. The rest is the shared menu pipeline (resolution, verification, folders, download, feedback).
function redgifsInlineSenderOk(message, sender) {
  if (!isContentScriptSender(sender) || sender.tab.active !== true || sender.frameId !== 0) return false;
  if (typeof sender.documentId !== 'string' || !sender.documentId) return false;
  if (typeof message.token !== 'string' || !/^[a-f0-9]{32}$/.test(message.token)) return false;
  if (typeof message.player !== 'string' || !/^[a-f0-9]{16}$/.test(message.player)) return false;
  try {
    const u = new URL(sender.url);
    return u.protocol === 'https:' && u.hostname === 'www.redgifs.com' && !/^\/ifr\//i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

async function handleRedgifsInlineSave(message, sender) {
  if (!redgifsInlineSenderOk(message, sender)) return;
  // concurrent duplicates of one player: the shared pipeline's in-flight key (document and player key, see onContextMenuClicked) suppresses a second save
  const info = {
    menuItemId: 'save-image-item',
    pageUrl: sender.url,
    frameUrl: sender.url,
    frameId: sender.frameId,
    mediaType: 'video',
    redgifsInline: { token: message.token, documentId: sender.documentId, player: message.player }
  };
  // at most a few saves resolve at once; one more is a visible failure, never a silent drop
  if (redgifsInlineActive >= REDGIFS_INLINE_MAX_ACTIVE) {
    const op = await fbBegin({ pageUrl: sender.url || '', sourceUrl: '', site: fbSiteOf(sender.url, '') });
    await fbFail(op, { stage: 'resolve', code: 'RATE_LIMIT' });
    await fbBadgeReporter(op)('ERR', '#ef4444');
    return;
  }
  redgifsInlineActive++;
  try {
    redgifsInlineInfos.add(info);
    await onContextMenuClicked(info, sender.tab);
  } finally {
    redgifsInlineActive--;
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message) return;
    if (message.action === 'REDGIFS_INLINE_SAVE') {
      handleRedgifsInlineSave(message, sender).catch((e) => console.warn('[Image Saver] Inline RedGIFs Save failed:', e?.message || e));
    } else if (message.action === 'REDDIT_INLINE_SAVE') {
      handleRedditInlineSave(message, sender).catch((e) => console.warn('[Image Saver] Inline Reddit Save failed:', e?.message || e));
    } else if (message.action === 'REDDIT_INLINE_SAVE_ALL') {
      handleRedditInlineSaveAll(message, sender).catch((e) => console.warn('[Image Saver] Inline Reddit Save all failed:', e?.message || e));
    }
  });
}

// Exports for tests
if (typeof globalThis !== 'undefined') {
  globalThis.verifyFinalMediaMime = verifyFinalMediaMime;
  globalThis.activeProtectedBlobsByDownloadId = activeProtectedBlobsByDownloadId;
  globalThis.earlyTerminalDownloadStates = earlyTerminalDownloadStates;
  globalThis.MIME_EVIDENCE = MIME_EVIDENCE;
  globalThis.acquireOffscreenTask = acquireOffscreenTask;
  globalThis.transferOffscreenTask = transferOffscreenTask;
  globalThis.releaseOffscreenTask = releaseOffscreenTask;
  globalThis.trackDownloadProtectedBlob = trackDownloadProtectedBlob;
  globalThis.untrackDownloadProtectedBlob = untrackDownloadProtectedBlob;
  globalThis.reconcileActiveOffscreenDownloads = reconcileActiveOffscreenDownloads;
  globalThis.hasActiveProtectedDownloads = hasActiveProtectedDownloads;
  globalThis.activeOffscreenOwners = activeOffscreenOwners;
  globalThis.releasedOffscreenKeys = releasedOffscreenKeys;
  globalThis.executeMediaPlan = executeMediaPlan;
  globalThis.executeMediaDownload = executeMediaDownload;
  globalThis.sniffMediaMagicBytes = sniffMediaMagicBytes;
  globalThis.isAnimatedGif = isAnimatedGif;
  globalThis.resolveTweetVideoThumbUrl = resolveTweetVideoThumbUrl;
  globalThis.isXVideoPosterUrl = isXVideoPosterUrl;
  globalThis.resolveTweetVideoFromThumb = resolveTweetVideoFromThumb;
  globalThis.resolveTwitterVideoThumb = resolveTwitterVideoThumb;
  globalThis.resolveTwitterVideoThumbUrl = resolveTwitterVideoThumbUrl;
  globalThis.classifyMediaTarget = classifyMediaTarget;
  globalThis.getMediaMenuTitle = getMediaMenuTitle;
  globalThis.isDanbooruDomain = isDanbooruDomain;
  globalThis.isValidDanbooruMetadata = isValidDanbooruMetadata;
  globalThis.extractMd5FromUrl = extractMd5FromUrl;
  globalThis.queryBooruDomMetadata = queryBooruDomMetadata;
  globalThis.getUrlHostname = getUrlHostname;
  globalThis.DANBOORU_DOM_ALLOWED_EXTS = DANBOORU_DOM_ALLOWED_EXTS;
  globalThis.isGelbooruDomain = isGelbooruDomain;
  globalThis.isE621Domain = isE621Domain;
  globalThis.isValidE621AssetUrl = isValidE621AssetUrl;
  globalThis.isSameOrSubdomain = isSameOrSubdomain;
  globalThis.buildFinalFilename = buildFinalFilename;
  globalThis.sanitizeUrlForLog = sanitizeUrlForLog;
  globalThis.verifyMp4ContainerBytes = verifyMp4ContainerBytes;
  globalThis.getCanonicalExtension = getCanonicalExtension;
  globalThis.resolveCanonicalExtension = resolveCanonicalExtension;
  globalThis.convertXTweetVideoToGifBlob = convertXTweetVideoToGifBlob;
  globalThis.executeXTweetVideoGifDownload = executeXTweetVideoGifDownload;
  globalThis.isRedditAnimationUrl = isRedditAnimationUrl;
  globalThis.convertRedditVideoToGifBlob = convertRedditVideoToGifBlob;
  globalThis.executeRedditGifDownload = executeRedditGifDownload;
  globalThis.lastDetectedRedditMediaByTab = lastDetectedRedditMediaByTab;
  globalThis.extractRedGifsIdFromUrl = extractRedGifsIdFromUrl;
  globalThis.isDirectVideoUrl = isDirectVideoUrl;
  globalThis.isDashManifestUrl = isDashManifestUrl;
  globalThis.validateRedditCandidateUrl = validateRedditCandidateUrl;
  globalThis.resolveRedditFrameBlobMedia = resolveRedditFrameBlobMedia;
  globalThis.mapMimeToPreferredExtension = (mime) => getCanonicalExtension(mime);
  globalThis.parseZerochanMediaUrl = parseZerochanMediaUrl;
  globalThis.createZerochanOriginalGroup = createZerochanOriginalGroup;
  globalThis.probeCandidate = probeCandidate;
  globalThis.sanitizePathSegment = sanitizePathSegment;
  globalThis.sanitizeRootSubfolder = sanitizeRootSubfolder;
  globalThis.determineOwningWebsite = determineOwningWebsite;
  globalThis.determineFinalMediaType = determineFinalMediaType;
  globalThis.resolveDownloadPath = resolveDownloadPath;
  globalThis.getFolderContextHost = getFolderContextHost;
  globalThis.getConfiguredRoot = getConfiguredRoot;
}

