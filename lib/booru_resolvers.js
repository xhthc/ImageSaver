// Classic worker module; loaded by background.js after lib/site_resolvers.js, in this code's original position.
// Booru engine families (Danbooru, Gelbooru, Moebooru, Philomena, e621, Shimmie, Szurubooru, Piwigo): ownership, page metadata and originals.
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
 * BOORU-ENGINE-01: the content hash a booru names its files by: 32 hex (MD5) or 40 hex (SHA-1 names, e.g. safebooru.org), taken
 * from the file name with its sample_/thumbnail_/sample- prefix removed. Null when the name carries no such hash.
 */
function extractBooruFileHash(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  let pathname = urlStr;
  try { pathname = new URL(urlStr).pathname; } catch (_) {}
  const name = pathname.split('/').pop() || '';
  const m = /^(?:sample[-_]|thumbnail[-_]|thumb[-_])?([a-f0-9]{40}|[a-f0-9]{32})\.[a-z0-9]+$/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}

/**
 * BOORU-ENGINE-01: the first post of an md5 metadata answer, only when it is that very file. Danbooru keeps the md5 on the post and
 * on media_asset, Moebooru on the post: at least one must be present, and every one present must equal the clicked md5.
 */
function booruPostForMd5(posts, md5) {
  const p = Array.isArray(posts) ? posts[0] : null;
  if (!p || !md5) return null;
  const hashes = [p.md5, p.media_asset?.md5].filter(Boolean).map(h => String(h).toLowerCase());
  return hashes.length && hashes.every(h => h === md5) ? p : null;
}

/** The content hash a booru URL names: its file-name hash (md5/sha1), else the first md5 in its path (Moebooru /image/<md5>/...). */
function booruUrlHash(urlStr) {
  let pathname = '';
  try { pathname = new URL(urlStr).pathname; } catch (_) { return null; }
  return extractBooruFileHash(urlStr) || extractMd5FromUrl(pathname);
}

// BOORU-ENGINE-01: the non-original renditions of the Danbooru/Gelbooru/Moebooru families (feed previews, samples, Danbooru size
// variants and Moebooru's /jpeg/ conversion). Selecting one of these on such a board means "the original of this file".
const BOORU_SELECTION_ENGINES = Object.freeze(['DanbooruEngine', 'GelbooruEngine', 'MoebooruEngine']);
function isBooruNonOriginalUrl(urlStr) {
  let pathname = '';
  try { pathname = new URL(urlStr).pathname; } catch (_) { return false; }
  return /\/(?:preview|thumbnails?|samples?|180x180|360x360|720x720)\/|\/jpeg\/[a-f0-9]{32}\//i.test(pathname);
}

/**
 * The admission rule of a booru selection (null when `selectedUrl` is not a non-original rendition on a Danbooru/Gelbooru/Moebooru
 * board): `admits(url)` refuses another non-original rendition (the selection itself included) and any URL naming another file
 * hash than the selection. Opaque URLs are not judged by a hash they do not name.
 */
function booruSelectionRule(selectedUrl, pageUrl) {
  if (!selectedUrl || !isBooruNonOriginalUrl(selectedUrl)) return null;
  let u;
  try { u = new URL(selectedUrl); } catch (_) { return null; }
  if (!BOORU_ENGINE_RESOLVERS.some(e => BOORU_SELECTION_ENGINES.includes(e.name) && e.match(u, pageUrl))) return null;
  const hash = booruUrlHash(selectedUrl);
  return {
    hash,
    admits(url) {
      if (!url || isBooruNonOriginalUrl(url)) return false;
      const named = booruUrlHash(url);
      return !hash || !named || named === hash;
    }
  };
}

/**
 * An http(s) URL whose host belongs to `isOwnHost` and that names no other file than `hash`; otherwise null. A URL naming no
 * hash at all (opaque) is kept as declared; no hash is guessed for it.
 */
function booruOwnUrl(urlStr, isOwnHost, hash) {
  try {
    const u = new URL(urlStr);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !isOwnHost(u.hostname.toLowerCase())) return null;
    const named = booruUrlHash(u.toString());
    return hash && named && named !== hash ? null : u.toString();
  } catch (_) {
    return null;
  }
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
 * Queries content/content_booru.js for ephemeral clicked element metadata.
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

// BOORU-ENGINE-01: Moebooru boards and their public metadata origins (Sakugabooru answers on www; the bare host redirects).
const MOEBOORU_API = Object.freeze({
  'konachan.com': 'https://konachan.com',
  'konachan.net': 'https://konachan.net',
  'yande.re': 'https://yande.re',
  'sakugabooru.com': 'https://www.sakugabooru.com'
});

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
          // Only a post that is this very file counts; large_file_url is the sample of a large image, never an original.
          const p = booruPostForMd5(await fetchResolverMetadata(apiUrl), md5);
          if (p) {
            apiKnownExt = (p.file_ext || p.media_asset?.file_ext || '').toLowerCase();
            const isVid = apiKnownExt === 'mp4' || apiKnownExt === 'webm';
            const declared = [p.file_url, p.media_asset?.variants?.find(v => v.type === 'original')?.url];
            for (const url of new Set(declared.map(u => booruOwnUrl(u, isDanbooruDomain, md5)).filter(Boolean))) {
              candidates.push(createCandidateDescriptor(url, {
                score: 90,
                tier: 'original',
                allowVideo: isVid
              }));
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

      // The clicked file's content hash (md5, or the 40-hex names of e.g. safebooru.org) binds what a post page declares
      const expectedMd5 = extractBooruFileHash(urlStr);

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
      // safebooru.org-style previews carry their post id as the bare query (thumbnail_<hash>.jpg?7228683): another post's page
      // must not supply the original of this preview.
      const previewPostId = /^\?\d+$/.test(urlObj.search) ? urlObj.search.slice(1) : null;
      const readPostId = (function() { try { return new URL(postUrlCandidate).searchParams.get('id'); } catch (_) { return null; } })();
      const samePost = !previewPostId || !readPostId || previewPostId === readPostId;

      if (postUrlCandidate && samePost) {
        try {
          const html = await fetchResolverMetadata(postUrlCandidate, { redirect: 'error', text: true });

          if (html) {

            // A. Video player element extraction (<video id="gelcomVideoPlayer"> or <source>)
            const videoMatch = html.match(/<video[^>]+id=["']gelcomVideoPlayer["'][^>]*\bsrc=["']([^"']+)["']/i) ||
                               html.match(/<video[^>]*\bsrc=["']([^"']+)["'][^>]*id=["']gelcomVideoPlayer["']/i) ||
                               html.match(/<video[^>]*id=["']gelcomVideoPlayer["'][^>]*>[\s\S]*?<source[^>]*\bsrc=["']([^"']+)["']/i);

            // B. Original image anchor
            const origMatch = html.match(/<a[^>]+href=["']([^"']+\/images\/[^"']+)["'][^>]*>\s*(?:Original\s+(?:image|video)|View\s+larger)\s*<\/a>/i);

            const rawFound = (videoMatch && (videoMatch[1] || videoMatch[2])) || (origMatch && origMatch[1]);
            if (rawFound) {
              try {
                // a protocol-relative "//images/..." path is site-relative; a declared absolute URL is kept exactly as written
                const parsedFound = new URL(rawFound.startsWith('//images/') ? rawFound.slice(1) : rawFound, postUrlCandidate);
                // Security check 1: verified Gelbooru domain & http(s)
                if (isGelbooruDomain(parsedFound.hostname) && (parsedFound.protocol === 'https:' || parsedFound.protocol === 'http:')) {
                  // Security check 2: media path must be under /images/
                  if (/\/images\//i.test(parsedFound.pathname)) {
                    // Security check 3: bind scraped media to the clicked file hash (md5/sha1) when both are known
                    const foundMd5 = extractBooruFileHash(parsedFound.toString());
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
      return Object.keys(MOEBOORU_API).some(r => isSameOrSubdomain(host, r));
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;
      const host = urlObj.hostname.toLowerCase();
      const root = Object.keys(MOEBOORU_API).find(r => isSameOrSubdomain(host, r));

      // 0. The board's own md5 lookup for any md5-named path: feed preview /data/preview/aa/bb/<md5>.jpg, post sample
      // /sample/<md5>/..., the JPEG version /jpeg/<md5>/... (Konachan's "larger version") or /image/<md5>/... The declared
      // file_url of that very md5 on the board's own hosts is the original (yande.re/Konachan PNG, Sakugabooru MP4).
      const md5 = extractMd5FromUrl(pathname);
      if (md5 && root) {
        const p = booruPostForMd5(await fetchResolverMetadata(`${MOEBOORU_API[root]}/post.json?tags=md5:${md5}`), md5);
        const fileUrl = p && booruOwnUrl(p.file_url, h => isSameOrSubdomain(h, root), md5);
        if (fileUrl) {
          const fileExt = String(p.file_ext || '').toLowerCase();
          candidates.push(createCandidateDescriptor(fileUrl, {
            score: 90,
            tier: 'original',
            allowVideo: fileExt === 'mp4' || fileExt === 'webm' || /\.(mp4|webm)$/i.test(new URL(fileUrl).pathname)
          }));
        }
      }

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

      // 2. Deterministic fallback for /data/preview/<md5>.jpg (the flat /data/<md5>.<ext> layout of Sakugabooru)
      if (pathname.includes('/preview/')) {
        if (md5) {
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
          const data = await fetchResolverMetadata(apiUrl);

          if (data) {
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
          const data = await fetchResolverMetadata(apiUrl);

          if (data) {
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
                console.warn('[MediaLatch] Отклонен недоверенный или несовпадающий URL медиа e621 API:', sanitizeUrlForLog(fileUrl));
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
