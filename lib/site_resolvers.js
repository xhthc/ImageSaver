// Classic worker module; loaded once by background.js in its original initialization order.
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
    console.warn('[MediaLatch] Ошибка при парсинге URL X.com:', err);
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
 * Resolve original image for Pixiv (www.pixiv.net, i.pximg.net)
 */
async function resolvePixivPostMedia({ srcUrl, pageUrl, linkUrl }) {
  let src, page, link;
  try { src=new URL(srcUrl); page=new URL(pageUrl); link=new URL(linkUrl); } catch (_) { return undefined; }
  const pixiv = u => u.protocol==='https:' && (u.hostname==='pixiv.net' || u.hostname.endsWith('.pixiv.net')) && !u.username && !u.password && !u.port;
  if(src.protocol!=='https:' || src.hostname!=='i.pximg.net' || src.username || src.password || src.port || !pixiv(page) || !pixiv(link))return undefined;
  const selected=src.pathname.match(/\/(\d+)_p\d+_(?:master|square|custom)\d+\.[a-z0-9]+$/i);
  const linked=link.pathname.match(/^\/(?:[a-z]{2}\/)?artworks\/(\d+)\/?$/);
  if(!selected || !linked)return undefined;
  if(selected[1]!==linked[1])return {error:'POST_MEDIA_MISMATCH'};
  const opened=page.pathname.match(/^\/(?:[a-z]{2}\/)?artworks\/(\d+)\/?$/);
  if(opened?.[1]===selected[1])return undefined;
  const id=selected[1];
  const data=await fetchResolverMetadata(`https://www.pixiv.net/ajax/illust/${id}/pages`,{timeoutMs:4000,credentials:'include'});
  if(data?.error || !Array.isArray(data?.body) || !data.body.length)return {error:'POST_MEDIA_UNAVAILABLE'};
  if(data.body.length>POST_MEDIA_MAX)return {error:'BATCH_LIMIT'};
  const items=[];
  for(let i=0;i<data.body.length;i++){
    const raw=data.body[i]?.urls?.original;
    if(typeof raw!=='string' || raw!==raw.trim())return {error:'POST_MEDIA_MISMATCH'};
    let u;try{u=new URL(raw);}catch(_){return {error:'POST_MEDIA_MISMATCH'};}
    if(u.protocol!=='https:' || u.hostname!=='i.pximg.net' || u.username || u.password || u.port ||
       !u.pathname.includes('/img-original/') || !new RegExp(`/`+id+`_p`+i+`\\.(?:png|jpe?g|gif|webp|avif)$`,'i').test(u.pathname))return {error:'POST_MEDIA_MISMATCH'};
    items.push(raw);
  }
  if(items.length===1)return adaptCandidateToGroup({url:items[0],source:'specialized_provider',score:100,tier:'original',provider:'pixiv',transport:'pixiv'});
  return {pixivPostMedia:{postUrl:`https://www.pixiv.net/artworks/${id}`,items}};
}

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
      const data = await fetchResolverMetadata(apiUrl, { timeoutMs: 4000, credentials: 'include' });

      if (data) {
        if (data && !data.error) {
          if (Array.isArray(data.body) && data.body.length > 0) {
            const pageData = data.body[pageIndex] || data.body[0];
            if (pageData?.urls?.original) {
              // PIXIV-SAVING-POLISH-01: the declared original of this very illustration is the original tier (exact URL); an
              // unrecognized answer keeps its former plain, lower rank. A probe deadline then cannot demote it below the preview.
              const declared = pageData.urls.original;
              let own = false;
              try { const u = new URL(declared); own = u.protocol === 'https:' && u.hostname === 'i.pximg.net' && !u.username && !u.password && !u.port && u.pathname.includes('/img-original/') && new RegExp(`/${illustId}_p\\d+\\.(?:png|jpe?g|gif)$`, 'i').test(u.pathname); } catch (_) {}
              candidates.unshift(own ? createCandidateDescriptor(declared, { score: 100, tier: 'original', isBooruCandidate: false }) : declared);
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

async function readZerochanOriginal(srcUrl, linkUrl, pageUrl) {
  if(location.href!==pageUrl || !/^https:\/\/(?:www\.)?zerochan\.net\//.test(location.href))return {error:'NO_MEDIA'};
  const images=Array.from(document.images).filter(img=>(img.currentSrc || img.src)===srcUrl);
  if(images.length!==1)return {error:'NO_MEDIA'};
  const image=images[0],documentUrl=location.href,owner=image.closest('a[href]');
  let post;try{post=new URL(owner?.href);}catch(_){return {error:'NO_MEDIA'};}
  const id=/^\/(\d+)\/?$/.exec(post.pathname)?.[1];
  if(!id || post.origin!==location.origin || (linkUrl && new URL(linkUrl,location.href).href!==post.href))return {error:'NO_MEDIA'};
  // the selection is fixed here (this exact image's own post id); every answer below is bound to that id, so the image may scroll away, unload or be
  // recycled meanwhile without changing what is saved. Only a navigation away (the existing policy) stops it.
  const unchanged=()=>location.href===documentUrl;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);let response,reader,route='page_json';
  try{
    response=await fetch(new URL('/'+id+'?json',location.origin).href,{credentials:'same-origin',redirect:'error',signal:controller.signal});
    if(response.status===503){
      await response.body?.cancel();if(!unchanged())return {error:'NO_MEDIA',route};
      route='post_html';response=await fetch(new URL('/'+id,location.origin).href,{credentials:'same-origin',redirect:'error',headers:{Accept:'text/html'},signal:controller.signal});
    }
    if(!response.ok)return {status:response.status,route};
    if(!(route==='post_html'?/^text\/html\b/i:/^application\/json\b/i).test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length'))>2*1024*1024 || !response.body?.getReader)return {error:'NO_MEDIA',route};
    reader=response.body.getReader();const chunks=[];let size=0;
    for(;;){const {done,value}=await reader.read();if(controller.signal.aborted || !unchanged())return {error:'NO_MEDIA'};if(done)break;size+=value.length;if(size>2*1024*1024)return {error:'NO_MEDIA'};chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const text=new TextDecoder().decode(bytes);
    let full;
    if(route==='post_html'){
      const doc=new DOMParser().parseFromString(text,'text/html'),canonical=doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),links=doc.querySelectorAll('#large a.preview[href]');
      const canonicalUrl=new URL(canonical || '',location.origin);
      if(canonicalUrl.origin!==post.origin || canonicalUrl.pathname!==post.pathname || links.length!==1)return {error:'NO_MEDIA',route};
      full=links[0].getAttribute('href');
    }else{const data=JSON.parse(text);if(String(data.id)!==id)return {error:'NO_MEDIA',route};full=data.full;}
    return unchanged()?{url:full,id,status:200,route}:{error:'NO_MEDIA',route};
  }catch(_){return {error:controller.signal.aborted?'NETWORK_TIMEOUT':'NETWORK_ERROR',route};}
  finally{clearTimeout(timer);controller.abort();try{if(reader)await reader.cancel();else await response?.body?.cancel();}catch(_){}}
}

async function resolveZerochanPageOriginal({srcUrl,pageUrl,linkUrl,tabId,frameId}) {
  const selected=parseZerochanMediaUrl(srcUrl);
  if(!selected?.isThumbnail || !tabId || !/^https:\/\/(?:www\.)?zerochan\.net\//.test(pageUrl || ''))return undefined;
  if(parseZerochanMediaUrl(pageUrl)?.id===selected.id)return undefined;
  // admission before any request: the gesture must own this exact preview now, and the reader (which fixes the post id at its start) runs in that
  // same document. After that the preview may scroll away or be recycled; the answer stays bound to the admitted id and document URL.
  // A frame that cannot be scripted at all (no document answered) has no page route, as before: the id-bound extension route decides.
  const admitted={src:srcUrl,link:''},owner=await resolveContextOwner(tabId,frameId,admitted);
  if(owner!=='proven')return owner==='unproven' && !admitted.documentId?undefined:{provider:'zerochan',error:'NO_MEDIA'};
  // Once admitted, the read is pinned to the admitting document; a lost document (rejected injection) or a missing answer is a refusal, never the extension route.
  let result;
  try{
    const injected=(await chrome.scripting.executeScript({target:admitted.documentId?{tabId,documentIds:[admitted.documentId]}:{tabId,frameIds:[Number.isInteger(frameId)?frameId:0]},injectImmediately:true,func:readZerochanOriginal,args:[srcUrl,linkUrl,pageUrl]}))?.[0];
    if(admitted.documentId && injected?.documentId!==admitted.documentId)return {provider:'zerochan',error:'NO_MEDIA'};
    result=injected?.result;
  }catch(_){}
  if(!result || typeof result!=='object')return {provider:'zerochan',error:'NO_MEDIA'};
  dbg('zerochan','original',result.url?'ok':'failed',result.error,()=>({http:result.status,host:result.url,route:result.route || 'page_json'}),{tab:tabId,frame:frameId});
  const original=parseZerochanMediaUrl(result.url);
  let url;try{url=new URL(result.url);}catch(_){}
  if(result.status===429 || result.status===401 || result.status===403)return adaptCandidateToGroup({url:srcUrl,score:0,tier:'preview',provider:'zerochan',error:result.status===429?'RATE_LIMIT':'AUTH_REQUIRED',_verificationStatus:result.status,_rateLimited:result.status===429});
  if(result.status>=500)return adaptCandidateToGroup({url:srcUrl,score:0,tier:'preview',provider:'zerochan',error:'NETWORK_ERROR',_verificationStatus:result.status});
  if(!original?.isFull || original.id!==selected.id || String(result.id)!==selected.id || url?.protocol!=='https:' || url.username || url.password || url.port)return {provider:'zerochan',error:result.error || 'NO_MEDIA'};
  const group=createZerochanOriginalGroup(selected.id,null,result.url);
  const candidate={url:result.url,source:'specialized_provider',finalScore:95,baseScore:95};
  if(!await probeCandidate(candidate))return adaptCandidateToGroup({url:result.url,score:0,tier:'original',provider:'zerochan',error:candidate.status===429?'RATE_LIMIT':candidate.status===401 || candidate.status===403?'AUTH_REQUIRED':candidate.status?'NOT_FOUND':'NETWORK_ERROR',_rateLimited:candidate.status===429,_verificationStatus:candidate.status || 0,_verificationStatusObserved:Boolean(candidate.status)});
  group.verified=true;Object.assign(group.metadata,{verified:true,verifiedUrl:result.url,contentType:candidate.contentType,contentLength:candidate.contentLength,mimeEvidence:MIME_EVIDENCE.HTTP_RESPONSE});return group;
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
      const posts = await fetchResolverMetadata(apiUrl);

      if (posts) {
        if (Array.isArray(posts) && posts[0]) {
          const p = posts[0];
          // BOORU-ENGINE-01: the answer must be the clicked file (its md5) or, without one, the linked post; an answer about
          // another post (a related thumbnail on this post's page) is refused. jpeg_url is the JPEG version of a PNG original,
          // not the original, so only file_url is offered.
          if (md5 ? String(p.md5 || '').toLowerCase() !== md5 : String(p.id) !== postId) continue;
          let ownFile = false;
          try { ownFile = /^(?:.+\.)?yande\.re$/i.test(new URL(p.file_url).hostname); } catch (_) {}
          if (ownFile && !candidates.includes(p.file_url)) {
            if (await verifyImageUrl(p.file_url)) {
              candidates.push(p.file_url);
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
      const data = await fetchResolverMetadata(apiUrl);

      if (data) {
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

      // Full deadline, 2 MiB byte ceiling and cancellation through JSON parsing.
      const data = await fetchResolverMetadata(`https://www.zerochan.net/${postId}?json`, {
        timeoutMs: 3000, credentials: 'include', redirect: 'error'
      });
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

// ============================================================================/n// Anime-Pictures and Zerochan: original addresses and their candidate groups/n// ============================================================================
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

// ============================================================================/n// Sankaku and Pawchive: originals read from the selected post (Sankaku in the page session, Pawchive from the post markup)/n// ============================================================================
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
