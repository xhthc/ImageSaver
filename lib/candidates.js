// Classic worker module; loaded by background.js where this code used to be (before lib/site_resolvers.js).
// Candidate addresses: normalization, thumbnail detection, scoring, the image probe and the generic CDN/CMS derivatives.
// ============================================================================
// 2. Candidate Normalization, Scoring & Verification
// ============================================================================

/**
 * Normalizes an image candidate URL:
 * - Resolves relative URLs against baseUrl
 * - Trims whitespace
 * - Strips unnecessary cache parameters
 */
function normalizeCandidateUrl(rawUrl, baseUrl, selectedPage = '') {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) {
    return null;
  }
  try {
    const absUrl = new URL(trimmed, baseUrl);
    return MediaLatchSources.allows(absUrl.href, selectedPage) ? absUrl.toString() : null;
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

// Recognized static image extensions across MediaLatch
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
async function probeCandidateImpl(candidate) {
  if (!candidate || !candidate.url || !MediaLatchSources.allows(candidate.url, candidate.selectedPage)) return false;
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
      redirect: 'error',
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
          redirect: 'error',
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
    } else {
      // no response at all: the 3.5 s probe deadline (AbortError) or a network failure; no HTTP status was observed
      candidate.networkError = err?.name === 'AbortError' ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR';
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

// ============================================================================/n// Candidate groups (resolution plans): the model every provider answers with, and the legacy single-candidate adapter/n// ============================================================================
/**
 * Infers transport type from URL ('protectedBlob', 'pixiv', or 'direct').
 */
function inferTransportForUrl(url) {
  if (!url || typeof url !== 'string') return 'direct';
  if (url.includes('pximg.net')) return 'pixiv';
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
  transport = 'direct', // 'direct' | 'protectedBlob' | 'pixiv'
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
