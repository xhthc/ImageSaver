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

      // Query authoritative JSON API with a bounded 3000ms timeout
      let timeoutId = null;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`https://www.zerochan.net/${postId}?json`, {
          credentials: 'include',
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
