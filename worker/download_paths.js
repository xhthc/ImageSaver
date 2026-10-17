// Classic worker module; loaded once by background.js in its original initialization order.
/**
 * Normalizes the configured root (nested levels allowed). Invalid/over-limit input resolves to the
 * default root; the popup rejects such input before saving (same rules, lib/folder_path.js).
 */
function sanitizeRootSubfolder(subfolder) {
  return FolderPath.resolveRoot(subfolder, (reason) => {
    console.warn('[MediaLatch] Корневая папка отклонена (' + reason + '), используется корень по умолчанию:', FolderPath.DEFAULT_ROOT);
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

// Folder id -> registrable domains (exact host or subdomain; never a suffix of an unrelated name), from the canonical site record (lib/sites.js).
// Includes the media CDNs of X and Pixiv so a direct CDN tab is canonicalized to x/pixiv.
const FOLDER_SITE_RULES = MediaLatchSites.SITES.filter((site) => site.domains).map((site) => [site.id, site.domains]);

const FOLDER_GROUP_PROVIDER_SITES = Object.freeze({
  twitter: 'x', x: 'x', reddit: 'reddit', pixiv: 'pixiv', zerochan: 'zerochan',
  'anime-pictures': 'anime-pictures', redgifs: 'redgifs', danbooru: 'danbooru', gelbooru: 'gelbooru',
  e621: 'e621', tenor: 'tenor', giphy: 'giphy', wikimedia: 'wikimedia'
});

// Search engines are country domains (google.com, google.co.uk, yandex.com.tr): explicit label boundaries and ccTLD shapes, never a substring of the host.
function isGoogleHost(host) { return /(^|\.)google\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/.test(String(host || '').toLowerCase()); }
function isYandexHost(host) { const h = String(host || '').toLowerCase(); return /(^|\.)yandex\.(com|com\.tr|[a-z]{2})$/.test(h) || isSameOrSubdomain(h, 'ya.ru'); }

/** Known site folder for a validated hostname, or '' when the host is not a mapped site. */
function getKnownFolderSite(host) {
  if (!host) return '';
  for (const [site, domains] of FOLDER_SITE_RULES) {
    if (domains.some((d) => isSameOrSubdomain(host, d))) return site;
  }
  if (isGoogleHost(host)) return 'google';
  if (isYandexHost(host)) return 'yandex';
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

function xAuthorFromPost(url){
  try{const u=new URL(url),m=/^\/([a-zA-Z0-9_]{1,15})\/status(?:es)?\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/.exec(u.pathname);return u.protocol==='https:' && /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname) && !u.username && !u.password && !u.port && m?m[1].toLowerCase():'';}catch(_){return '';}
}
async function selectedXAuthor(info,tab,src){
  try{const media=await chrome.tabs.sendMessage(tab.id,{action:'GET_X_MEDIA_AT_CURSOR'},{frameId:Number.isInteger(info.frameId)?info.frameId:0});return media?.type==='image' && (media.url===src || media.src===src)?xAuthorFromPost(media.authorPostUrl):'';}catch(_){return '';}
}

/**
 * PIXIV-SAVING-POLISH-01: the author folder of a Reddit or Pixiv save as { site, folder }, or null when the identity is not usable.
 * Reddit: the selected post's username (lowercase, like X). Pixiv: "<display name> (<user id>)"; a long name is shortened so the
 * stable id always survives, and an empty name leaves the id alone. One portable segment, limited like a site segment.
 */
// accounts proven by the selected page itself (generic, VK and RedGIFs inline proofs, or the context-menu capture of that page)
const PAGE_ACCOUNT_SITES = ['vk', 'redgifs', 'instagram', 'tiktok'];
function authorFolder(site, name, id) {
  if (site === 'reddit') {
    return typeof name === 'string' && /^[A-Za-z0-9_-]{3,20}$/.test(name) ? { site, folder: FolderPath.normalizeSegment(name.toLowerCase()) } : null;
  }
  if (PAGE_ACCOUNT_SITES.includes(site)) {
    const author=FeedbackLib.safeAuthor(site,{site,id,name});if(!author)return null;
    const tail=' ('+author.id+')';
    const display=site==='vk' && author.name ? FolderPath.normalizeSegment(author.name).slice(0,Math.max(0,FolderPath.LIMITS.siteLength-tail.length)).replace(/[\uD800-\uDBFF]$/,'').trim() : '';
    return {site,folder:FolderPath.normalizeSegment(display?display+tail:author.id)};
  }
  if (site === 'pixiv' && typeof id === 'string' && /^\d{1,12}$/.test(id)) {
    const tail = ` (${id})`;
    let display = FolderPath.normalizeSegment(typeof name === 'string' ? name : '');
    if (display.length > FolderPath.LIMITS.siteLength - tail.length) {
      display = FolderPath.normalizeSegment(display.substring(0, FolderPath.LIMITS.siteLength - tail.length).replace(/[\uD800-\uDBFF]$/, ''));
    }
    return { site, folder: display ? display + tail : id };
  }
  return null;
}

// The artwork a Pixiv URL names: /artworks/<id> pages, or a pximg file name "<id>_p<n>...". '' when it names none.
function pixivArtworkId(url) {
  try {
    const u = new URL(url), host = u.hostname.toLowerCase();
    if (host === 'www.pixiv.net' || host === 'pixiv.net') return (/^\/(?:[a-z]{2}\/)?artworks\/(\d{1,12})\/?$/.exec(u.pathname) || [])[1] || '';
    if (host === 'i.pximg.net') return (/\/(\d{1,12})_p\d+(?:_[a-z0-9]+)?\.[a-z]+$/i.exec(u.pathname) || [])[1] || '';
  } catch (_) {}
  return '';
}

// One bounded metadata request per artwork, shared by every file of its batch (the promise is kept briefly, at most 20 artworks).
const pixivAuthorRequests = new Map();
function pixivArtworkAuthor(id) {
  if (!pixivAuthorRequests.has(id)) {
    if (pixivAuthorRequests.size >= 20) pixivAuthorRequests.delete(pixivAuthorRequests.keys().next().value);
    pixivAuthorRequests.set(id, fetchResolverMetadata(`https://www.pixiv.net/ajax/illust/${id}`, { timeoutMs: 4000, credentials: 'include' }).then((data) => {
      const b = data && data.error === false ? data.body : null;
      // the answer must be about this very artwork and name a stable numeric user id
      return b && String(b.illustId ?? b.id) === id && /^\d{1,12}$/.test(String(b.userId)) ? {site: 'pixiv', id: String(b.userId), name: String(b.userName ?? '')} : null;
    }, () => null));
    setTimeout(() => pixivAuthorRequests.delete(id), 120000);
  }
  return pixivAuthorRequests.get(id);
}

// Keep account identity separate from portable folder names (for example, Reddit CON -> folder con_).
async function selectedRedditPostAuthor(info, tab) {
  let author = /^t3_[a-z0-9]{1,12}$/.test(info.redditInlineMedia?.ownerId || '') ? info.redditInlineMedia.author : '';
  if (!info.redditInlineMedia && info.authorProof && tab?.id) {
    const documentId = info.authorDocumentId ? {documentId: info.authorDocumentId} : {};
    try {
      const a = await chrome.tabs.sendMessage(tab.id, {action: 'GET_REDDIT_POST_AUTHOR', proof: info.authorProof}, {frameId: Number.isInteger(info.frameId) ? info.frameId : 0, ...documentId});
      if (a && /^t3_[a-z0-9]{1,12}$/.test(a.ownerId)) author = a.author;
    } catch (_) {}
  }
  return typeof author === 'string' && /^[A-Za-z0-9_-]{3,20}$/.test(author) ? author : '';
}

/**
 * The Reddit/Pixiv author folder of the selected media, or null (normal layout). Reddit: the author of the post that owns the selected
 * media, as proven by the page (content_reddit.js; an inline save names its proven post). Pixiv: the artwork named by the selected file,
 * agreeing with its link (feed) or page (opened post), and that artwork's user from bounded metadata. Never the page account.
 */
async function selectedAuthorFolder(settings, info, tab, src) {
  const pageUrl = info.pageUrl || tab?.url || '';
  if (settings.redditAuthorFolders === true && /^https:\/\/(?:[a-z0-9-]+\.)?reddit\.com\//i.test(pageUrl) && tab?.id) {
    const author = await selectedRedditPostAuthor(info, tab);
    return author ? authorFolder('reddit', author) : null;
  }
  if (settings.pixivAuthorFolders === true) {
    const id = pixivArtworkId(src);
    const linked = pixivArtworkId(info.linkUrl || '');
    if (id && (linked ? linked === id : pixivArtworkId(pageUrl) === id)) { const a = await pixivArtworkAuthor(id); return a ? authorFolder('pixiv', a.name, a.id) : null; }
  }
  return null;
}

// Independent of folder preferences: use only the owner already proved for this selected media.
async function selectedMediaAuthor(info, tab, src) {
  const page = info.pageUrl || tab?.url || '';
  const site=fbSiteOf(page,'');
  if (PAGE_ACCOUNT_SITES.includes(site)) {
    if(viaInline(info, 'generic', 'vk', 'redgifs', 'tiktok'))return FeedbackLib.safeAuthor(site,info.selectedAuthor);
    if(info.authorProof && tab?.id)try {
      const answer=await chrome.tabs.sendMessage(tab.id,{action:'SELECTED_POST_AUTHOR',proof:info.authorProof},{frameId:Number.isInteger(info.frameId)?info.frameId:0,...(info.authorDocumentId?{documentId:info.authorDocumentId}:{})});
      return FeedbackLib.safeAuthor(site,answer?.author);
    } catch (_) {}
    return null;
  }
  if (isXPageUrl(page)) {
    const id = await selectedXAuthor(info, tab, src);
    return id ? {site: 'x', id, name: id} : null;
  }
  if (/^https:\/\/(?:[a-z0-9-]+\.)?reddit\.com\//i.test(page)) {
    const author = await selectedRedditPostAuthor(info, tab);
    return author ? {site: 'reddit', id: author.toLowerCase(), name: author} : null;
  }
  const id = pixivArtworkId(src), linked = pixivArtworkId(info.linkUrl || '');
  if (id && (linked ? linked === id : pixivArtworkId(page) === id)) return pixivArtworkAuthor(id);
  return null;
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
  xAuthor = '',
  author: authorChoice = null,
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
  const owner = determineOwningWebsite({ pageUrl, resolvedUrl, group });
  // the X folder keeps its exact rule; a Reddit/Pixiv author folder applies only to a file owned by that same site
  const author = /^[a-zA-Z0-9_]{1,15}$/.test(xAuthor) && owner === 'x' ? FolderPath.normalizeSegment(xAuthor.toLowerCase())
    : (authorChoice && authorChoice.site !== 'x' && MediaLatchSites.AUTHOR_SERVICES.some(([id]) => id === authorChoice.site) && authorChoice.site === owner && typeof authorChoice.folder === 'string'
      ? FolderPath.normalizeSegment(authorChoice.folder).substring(0, FolderPath.LIMITS.siteLength) : '');

  if (folderOrganizationMode !== 'by_site_and_type') {
    return FolderPath.joinPath([cleanRoot,author], cleanFilename);
  }

  const site = FolderPath.normalizeSite(
    owningSite || determineOwningWebsite({ pageUrl, resolvedUrl, group }),
    'unknown-site'
  );
  const type = FOLDER_MEDIA_TYPES.has(mediaType)
    ? mediaType
    : determineFinalMediaType({ resolvedUrl, resolvedExtension, isConvertedGif, contentType, group });

  return FolderPath.joinPath([cleanRoot, site, author, type], cleanFilename);
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
    xAuthor:options.xAuthor,
    author: options.author,
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
    console.warn('[MediaLatch] Не удалось разобрать имя файла из URL:', err);
    return `image_${Date.now()}.jpg`;
  }
}
