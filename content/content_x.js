// content/content_x.js - Lightweight content script scoped strictly to X/Twitter
(() => {
  // DEBUG-MENU-01: the shared journal client (lib/debug_journal.js); a no-op when it is absent. Never an authority, never sees a token.
  const DBG = (globalThis.ImageSaverDebug && globalThis.ImageSaverDebug.client('content')) || { log() {}, cid() { return ''; }, enabled() { return false; } };
  DBG.log('x', 'init', 'info');
  const isLabel = globalThis.MediaLatchCopyKit.labeler();
  let lastContextmenuX = 0;
  let lastContextmenuY = 0;
  let savedMediaDescriptor = null;
  // The DOM element behind the descriptor findMediaInElements returned last (set where it decides, read by
  // findXMediaAtPoint): URL and type alone never prove it is still the selected node.
  let lastChosenEl = null;
  let lastFoundEl = null; // the element of the descriptor findXMediaAtPoint returned last
  // True once a real gesture (press or contextmenu) was handled: its outcome, media or none, is then the only answer
  // the page gives for that point; later DOM changes never create or replace a selection.
  let gestureKnown = false;
  let isShiftRightClickOnMedia = false;

  /**
   * Universal Media Descriptor factory
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
    isHlsOnly = false,
    isBlobPlayer = false,
    recoveredMp4Url = null,
    recoveredBitrate = null,
    postUrl = null,
    tweetId = null,
    mediaIdHint = null,
    mediaIndex = null,
    isQuoteTweet = false
  } = {}) {
    const normalizedSrc = (src || currentSrc || '').trim();
    const normalizedCurrent = (currentSrc || src || '').trim();
    const selectedOwner=xiOwnerOf(lastChosenEl),ownerId=selectedOwner && xiIdOf(selectedOwner.owner,Boolean(selectedOwner.quote));
    const ownerLink=ownerId?extractTweetUrl(selectedOwner.owner,'https://x.com/'):null;
    const authorPostUrl=ownerLink?.match(/\/status\/(\d+)/)?.[1]===ownerId?ownerLink:null;
    let normalizedType = type;
    if (!normalizedType) {
      if (/\.(mp4|webm|ogv|mov|m4v)(\?.*)?$/i.test(normalizedSrc) || (mime && mime.startsWith('video/'))) {
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
      isHlsOnly: Boolean(isHlsOnly),
      isBlobPlayer: Boolean(isBlobPlayer),
      recoveredMp4Url: recoveredMp4Url || null,
      recoveredBitrate: typeof recoveredBitrate === 'number' ? recoveredBitrate : null,
      postUrl: postUrl ? postUrl.trim() : null,
      authorPostUrl,
      tweetId: tweetId ? String(tweetId).trim() : null,
      mediaIdHint: mediaIdHint ? String(mediaIdHint).trim() : null,
      mediaIndex: typeof mediaIndex === 'number' ? mediaIndex : null,
      isQuoteTweet: Boolean(isQuoteTweet)
    };
  }

  /**
   * Infers video MIME from URL or format parameters
   */
  function detectVideoMime(url) {
    if (!url || typeof url !== 'string') return null;
    const lower = url.toLowerCase();
    if (lower.includes('.mp4') || lower.includes('format=mp4') || lower.includes('ext=mp4') || lower.includes('mime=video/mp4')) return 'video/mp4';
    if (lower.includes('.webm') || lower.includes('format=webm') || lower.includes('ext=webm') || lower.includes('mime=video/webm')) return 'video/webm';
    if (lower.includes('.ogv') || lower.includes('.ogg') || lower.includes('format=ogv')) return 'video/ogg';
    if (lower.includes('.mov')) return 'video/quicktime';
    return 'video/mp4';
  }

  /**
   * Helper: validates and extracts X tweet_video URL from video.twimg.com/tweet_video/*.mp4
   */
  function toTweetVideoUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    try {
      const base = (typeof window !== 'undefined' && window.location?.href) || 'https://x.com/';
      const parsed = new URL(urlStr, base);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      if (host === 'video.twimg.com' && pathname.includes('/tweet_video/') && pathname.endsWith('.mp4')) {
        return parsed.href;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Helper: resolves candidate X tweet_video URL from video poster URL (tweet_video_thumb).
   * Input: https://pbs.twimg.com/tweet_video_thumb/<id>.jpg
   * Output: https://video.twimg.com/tweet_video/<id>.mp4
   */
  function toTweetVideoUrlFromPoster(posterUrl) {
    if (!posterUrl || typeof posterUrl !== 'string') return null;
    try {
      const base = (typeof window !== 'undefined' && window.location?.href) || 'https://x.com/';
      const parsed = new URL(posterUrl, base);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const host = parsed.hostname.toLowerCase();
      if (host !== 'twimg.com' && !host.endsWith('.twimg.com')) return null;
      let pathname = parsed.pathname;
      if (/:([a-z0-9_]+)$/i.test(pathname)) {
        pathname = pathname.replace(/:([a-z0-9_]+)$/i, '');
      }
      const match = pathname.match(/\/tweet_video_thumb\/([a-zA-Z0-9_-]+)/i);
      if (match && match[1]) {
        return `https://video.twimg.com/tweet_video/${match[1]}.mp4`;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Helper: identifies whether a URL represents an X / Twitter ordinary video poster (amplify_video_thumb or ext_tw_video_thumb).
   */
  function isXVideoPosterUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const base = (typeof window !== 'undefined' && window.location?.href) || 'https://x.com/';
      const parsed = new URL(urlStr, base);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      const host = parsed.hostname.toLowerCase();
      if (host !== 'twimg.com' && !host.endsWith('.twimg.com')) return false;
      return /\/(?:amplify_video_thumb|ext_tw_video_thumb)\//i.test(parsed.pathname);
    } catch (_) {
      return false;
    }
  }

  /**
   * Helper: identifies whether a URL is an HLS .m3u8 playlist/manifest rather than a direct container.
   */
  function isHlsManifestUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const base = (typeof window !== 'undefined' && window.location?.href) || 'https://x.com/';
      const parsed = new URL(urlStr, base);
      const pathname = parsed.pathname.toLowerCase();
      return pathname.endsWith('.m3u8') || pathname.includes('/manifest.m3u8') || parsed.searchParams.get('format') === 'm3u8';
    } catch (_) {
      return urlStr.toLowerCase().includes('.m3u8');
    }
  }

  /**
   * Helper: extracts media items array from a raw tweet data object.
   * Supports standard REST v1.1, GraphQL legacy, cards, and nested quoted statuses.
   */
  function extractMediaItemsFromTweet(tweet) {
    if (!tweet || typeof tweet !== 'object') return [];
    if (Array.isArray(tweet.extended_entities?.media)) return tweet.extended_entities.media;
    if (Array.isArray(tweet.legacy?.extended_entities?.media)) return tweet.legacy.extended_entities.media;
    if (tweet.result) return extractMediaItemsFromTweet(tweet.result);
    if (tweet.tweet) return extractMediaItemsFromTweet(tweet.tweet);
    return [];
  }

  /**
   * Helper: selects the specific media item from an array of tweet media matching the clicked player.
   * Uses mediaIdHint, posterUrl, or mediaIndex to avoid selecting an adjacent/wrong video.
   */
  /**
   * Helper: selects the specific media item from an array of tweet media matching the clicked player.
   * Uses mediaIdHint, posterUrl, or mediaIndex to avoid selecting an adjacent/wrong video.
   * Does NOT fall back to mediaIndex 0 after an ID/poster mismatch.
   */
  function selectMatchingMediaItem(mediaList, { posterUrl, mediaIndex, mediaIdHint } = {}) {
    if (!Array.isArray(mediaList) || mediaList.length === 0) return null;
    const videoItems = mediaList.filter(m => m && (m.video_info || m.type === 'video' || m.type === 'animated_gif'));
    if (videoItems.length === 0) return null;

    // 1. If mediaIdHint is provided, require exact ID match; never fall through to default index on mismatch
    if (mediaIdHint) {
      const match = videoItems.find(item => String(item.id_str || item.id) === String(mediaIdHint));
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
        if (matchById && matchById.video_info) return matchById;
      }

      const match = videoItems.find(item => {
        const u = (item.media_url_https || item.media_url || '').split('?')[0].toLowerCase();
        return u && (cleanPoster.includes(u) || u.includes(cleanPoster));
      });
      if (match && match.video_info) return match;

      // Poster was explicitly specified but failed to match any item
      if (videoItems.length > 1) {
        return null; // Ambiguous in multi-video post
      }
    }

    // 3. Positional mediaIndex (only if valid and no contradicting ID/poster)
    if (typeof mediaIndex === 'number' && mediaIndex >= 0 && mediaIndex < videoItems.length) {
      return videoItems[mediaIndex]?.video_info ? videoItems[mediaIndex] : null;
    }

    // 4. Single video item in post (unambiguous)
    if (videoItems.length === 1 && videoItems[0].video_info) {
      return videoItems[0];
    }

    return null;
  }

  /**
   * Helper: inspects video_info.variants.
   * Distinguishes 'MP4 found', 'confirmed HLS-only', and 'empty/unsupported'.
   */
  function inspectVideoVariants(videoInfo) {
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

    if (hasHls) {
      return { ok: false, isHlsOnly: true, error: 'HLS_ONLY' };
    }

    return { ok: false, isHlsOnly: false, error: 'UNSUPPORTED_VARIANTS' };
  }


  /**
   * Helper: walks React fiber / props hierarchy starting from a video or post element.
   * Extracts post media metadata and determines best MP4 variant.
   */
  // The post that owns a pressed node: its quote card when the node is inside one (never the outer post), else its article; with
  // that post's address and id. The page address stands in only for an outer post.
  function xPostOf(node, pageUrl) {
    const o = node ? xiOwnerOf(node) : null;
    const quoteContainer = o?.quote || (node?.closest ? node.closest(XI_QUOTE) : null);
    const isQuoteTweet = Boolean(quoteContainer);
    const postContainer = quoteContainer || o?.article ||
      (node && node.closest ? (node.closest('article[data-testid="tweet"], article[role="article"]') || node.closest('article')) : null) ||
      node?.parentElement;
    const postUrl = extractTweetUrl(postContainer, isQuoteTweet ? null : pageUrl) || (isQuoteTweet ? null : pageUrl);
    const tweetIdMatch = postUrl ? postUrl.match(/\/status(?:es)?\/(\d+)/) : null;
    const tweetId = tweetIdMatch ? tweetIdMatch[1] : (isQuoteTweet ? xiIdOf(postContainer, true) : null);
    return { isQuoteTweet, postContainer, postUrl, tweetId };
  }

  // The best MP4 the owning post declares for this player, or a confirmed HLS-only player; neither means "unknown" (not HLS).
  function xDeclaredMp4(videoEl, postContainer, hints) {
    const metaRes = extractPostMetadataFromDom(videoEl, postContainer, hints);
    if (metaRes?.ok && metaRes.bestMp4) return { recoveredMp4Url: metaRes.bestMp4.url, recoveredBitrate: metaRes.bestMp4.bitrate, isConfirmedHls: false };
    return { recoveredMp4Url: null, recoveredBitrate: null, isConfirmedHls: Boolean(metaRes?.isHlsOnly) };
  }

  function extractPostMetadataFromDom(videoEl, postContainer, { posterUrl, mediaIndex, mediaIdHint, isQuoteTweet } = {}) {
    if (!videoEl && !postContainer) return null;

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

    const ownerId = isQuoteTweet ? xiIdOf(postContainer, true) : null;
    function selectContextTweet(tweet) {
      const id = tweet && (tweet.id_str || tweet.id || tweet.rest_id);
      const selected = isQuoteTweet && (!ownerId || String(id) !== ownerId)
        ? (tweet?.quoted_status || tweet?.quoted_status_result?.result?.legacy || tweet) : tweet;
      const selectedId = selected && (selected.id_str || selected.id || selected.rest_id);
      return ownerId && selectedId && String(selectedId) !== ownerId ? null : selected;
    }

    let curr = videoEl || postContainer;
    let confirmedHls = false;
    let foundAnyVariants = false;

    while (curr) {
      // Check props directly
      const props = getReactProps(curr);
      if (props) {
        if (props.videoInfo) {
          foundAnyVariants = true;
          const res = inspectVideoVariants(props.videoInfo);
          if (res.ok && res.bestMp4) return res;
          if (res.isHlsOnly) confirmedHls = true;
        }
        if (props.media?.video_info) {
          foundAnyVariants = true;
          const res = inspectVideoVariants(props.media.video_info);
          if (res.ok && res.bestMp4) return res;
          if (res.isHlsOnly) confirmedHls = true;
        }
        const tweet = selectContextTweet(props.tweet);
        if (tweet) {
          const mediaList = extractMediaItemsFromTweet(tweet);
          if (mediaList.length > 0) {
            const matched = selectMatchingMediaItem(mediaList, { posterUrl, mediaIndex, mediaIdHint });
            if (matched?.video_info) {
              foundAnyVariants = true;
              const res = inspectVideoVariants(matched.video_info);
              if (res.ok && res.bestMp4) return res;
              if (res.isHlsOnly) confirmedHls = true;
            }
          }
        }
      }

      // Check fiber
      const fiber = getReactFiber(curr);
      let f = fiber;
      let depth = 0;
      while (f && depth < 30) {
        const fProps = f.memoizedProps;
        if (fProps) {
          if (fProps.videoInfo) {
            foundAnyVariants = true;
            const res = inspectVideoVariants(fProps.videoInfo);
            if (res.ok && res.bestMp4) return res;
            if (res.isHlsOnly) confirmedHls = true;
          }
          if (fProps.media?.video_info) {
            foundAnyVariants = true;
            const res = inspectVideoVariants(fProps.media.video_info);
            if (res.ok && res.bestMp4) return res;
            if (res.isHlsOnly) confirmedHls = true;
          }
          const tweet = selectContextTweet(fProps.tweet);
          if (tweet) {
            const mediaList = extractMediaItemsFromTweet(tweet);
            if (mediaList.length > 0) {
              const matched = selectMatchingMediaItem(mediaList, { posterUrl, mediaIndex, mediaIdHint });
              if (matched?.video_info) {
                foundAnyVariants = true;
                const res = inspectVideoVariants(matched.video_info);
                if (res.ok && res.bestMp4) return res;
                if (res.isHlsOnly) confirmedHls = true;
              }
            }
          }
        }
        f = f.return;
        depth++;
      }
      if (curr === postContainer) break;
      if (curr.tagName === 'ARTICLE' && curr !== postContainer) break;
      if (curr.tagName === 'BODY' || curr.tagName === 'HTML') break;
      curr = curr.parentElement;
    }

    if (confirmedHls) {
      return { ok: false, isHlsOnly: true, error: 'HLS_ONLY' };
    }
    if (foundAnyVariants) {
      return { ok: false, isHlsOnly: false, error: 'UNSUPPORTED_VARIANTS' };
    }
    return null;
  }

  const XI_POST = 'article[data-testid="tweet"], article[role="article"]';
  const XI_QUOTE = '[data-testid="quoteTweet"], [role="blockquote"]';

  function isAttributionAnchor(a) {
    if (!a) return false;
    const href = String((a.getAttribute && a.getAttribute('href')) || a.href || '');
    if (/\/status(?:es)?\/\d+\/video\//i.test(href)) return true;
    if (typeof a.closest === 'function' && a.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"], video')) return true;
    return false;
  }

  // The nested post, reply or quote card around `el` inside the top-level post `top`, if X shows one as a separate container:
  // a nested <article> (the nearest article is not the top one), the legacy quote test ids, or a div[role=link] card that carries
  // its own status link or author header. Gallery tiles are <a> elements and never match.
  function xiCardOf(el, top) {
    if (!el) return null;
    if (!top && typeof el.closest === 'function') {
      let up = el.closest('article');
      for (let p = up?.parentElement && up.parentElement.closest('article'); p; p = p.parentElement && p.parentElement.closest('article')) up = p;
      top = up;
    }
    if (top && typeof top.contains === 'function' && !top.contains(el)) return null;
    for (let p = el, d = 0; p && p !== top && d < 40; p = p.parentElement, d++) {
      const role = typeof p.getAttribute === 'function' ? p.getAttribute('role') : null;
      if (p.tagName === 'ARTICLE' || role === 'blockquote' || p.getAttribute?.('data-testid') === 'quoteTweet') return p;
      if (p.tagName !== 'DIV' || typeof p.getAttribute !== 'function' || p.getAttribute('role') !== 'link') continue;
      if (/\/status(?:es)?\/\d+/.test(p.getAttribute('data-href') || '') || (typeof p.querySelector === 'function' && p.querySelector('[data-testid="User-Name"]'))) return p;
    }
    return null;
  }

  // article = the top-level post; quote = a nested card inside it (or null); owner = the card when there is one, else the post.
  function xiOwnerOf(el) {
    if (!el || typeof el.closest !== 'function') return null;
    let top = el.closest('article');
    if (!top) return null;
    // the outermost article is the post: a nested article is a card inside it, even when only the outer one carries the post test id
    for (let up = top.parentElement && top.parentElement.closest('article'); up; up = up.parentElement && up.parentElement.closest('article')) top = up;
    const quote = xiCardOf(el, top);
    if (quote && !(typeof top.contains === 'function' && top.contains(quote))) return null;
    return { article: top, quote: quote || null, owner: quote || top };
  }

  /**
   * Searches element stack for media (VIDEO, SOURCE, IMG, poster).
   * First searches for a VIDEO element (X animated GIF / tweet video or standard HTML5 video).
   * Uses video.currentSrc -> video.src -> source.src in priority order.
   * Poster is used strictly as fallback metadata, never as primary video source.
   * Falls back to IMG element if no video source is present.
   */
  function findMediaInElements(elements, point = null) {
    if (!elements || elements.length === 0) return null;

    // With a click point, media reached only through a stack element's descendants (a blank layer, an ancestor)
    // belongs to this click only when its own box holds the point; otherwise a neighbour would be chosen.
    // Without a point (direct unit calls) the first descendant is used as before.
    const rectHolds = (node) => {
      const r = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
      return Boolean(r) && point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
    };
    const ownedWithin = (el, tag) => {
      let all = el.querySelectorAll ? Array.from(el.querySelectorAll(tag)) : [];
      if (!all.length && el.querySelector) {
        const one = el.querySelector(tag);
        if (one) all = [one];
      }
      return point ? all.filter(rectHolds) : all.slice(0, 1);
    };

    // 1. First find a VIDEO element or SOURCE element inside video
    let video = null;
    let sourceEl = null;

    for (const el of elements) {
      if (!el || el === document.body || el === document.documentElement) continue;

      // The topmost media is the pressed one: a plain photo above a video in the stack is not taken over by that
      // video (a video poster over its own video keeps the video, below).
      if (el.tagName === 'IMG') {
        const topUrl = el.currentSrc || el.src;
        if (topUrl && !toTweetVideoUrlFromPoster(topUrl) && !isXVideoPosterUrl(topUrl)) break;
      }

      if (el.tagName === 'VIDEO') {
        video = el;
        break;
      }
      if (el.tagName === 'SOURCE') {
        sourceEl = el;
        const parentVid = el.closest ? el.closest('video') : (el.parentElement?.tagName === 'VIDEO' ? el.parentElement : null);
        if (parentVid) {
          video = parentVid;
          break;
        }
      }
      const insideVideos = el.querySelector ? ownedWithin(el, 'video') : [];
      if (insideVideos.length === 1) {
        video = insideVideos[0];
        break;
      }
      if (insideVideos.length > 1) continue; // two videos under the point in one layer: no owner can be proven
      const insideSource = el.querySelector ? el.querySelector('source') : null;
      if (insideSource) {
        const parentVid = insideSource.closest ? insideSource.closest('video') : (insideSource.parentElement?.tagName === 'VIDEO' ? insideSource.parentElement : null);
        if (point && !(parentVid && rectHolds(parentVid))) continue;
        sourceEl = insideSource;
        if (parentVid) {
          video = parentVid;
          break;
        }
      }
    }

    const posterUrl = video?.poster || (video?.getAttribute && video.getAttribute('poster')) || null;
    const linkEl = elements.find(el => el && (el.tagName === 'A' || el.closest?.('a')));
    const linkUrl = linkEl?.href || linkEl?.closest?.('a')?.href || null;
    const pageUrl = (typeof window !== 'undefined' && window.location?.href) || '';

    if (video || sourceEl) {
      lastChosenEl = video || sourceEl;
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
            linkUrl,
            sourceType: 'x_tweet_video',
            animated: true
          });
        }
      }

      // If video exists but candidateUrls (currentSrc/src) is empty (e.g. lazy-loaded),
      // or if candidateUrls only contains blob: URLs, attempt recovery of tweet_video MP4 from poster URL (tweet_video_thumb).
      // The recovered tweet_video source takes precedence over any ephemeral blob: URL.
      if (posterUrl) {
        const recoveredTweetVideoUrl = toTweetVideoUrlFromPoster(posterUrl);
        if (recoveredTweetVideoUrl) {
          return createMediaDescriptor({
            type: 'x_tweet_video',
            src: recoveredTweetVideoUrl,
            currentSrc: recoveredTweetVideoUrl,
            poster: posterUrl,
            mime: 'video/mp4',
            pageUrl,
            linkUrl,
            sourceType: 'x_tweet_video',
            animated: true
          });
        }
      }

      // Check for standard HTML5 video (MP4, WebM, etc.)
      // Prioritize accessible direct HTTPS/HTTP sources over ephemeral blob: URLs and HLS manifests
      const directCandidates = [];
      const blobCandidates = [];
      for (const rawUrl of candidateUrls) {
        if (typeof rawUrl === 'string' && rawUrl.trim() && !rawUrl.startsWith('data:image/')) {
          if (rawUrl.startsWith('blob:') || isHlsManifestUrl(rawUrl)) {
            blobCandidates.push(rawUrl);
          } else if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
            directCandidates.push(rawUrl);
          }
        }
      }

      // 1. Direct accessible video source wins
      for (const directUrl of directCandidates) {
        const matchingSource = sourceTags.find(s => (s.currentSrc === directUrl || s.src === directUrl));
        const declaredMime = matchingSource?.type || null;
        return createMediaDescriptor({
          type: 'video',
          src: directUrl,
          currentSrc: video?.currentSrc || directUrl,
          poster: posterUrl, // metadata only, not video source
          mime: declaredMime || detectVideoMime(directUrl),
          pageUrl,
          linkUrl,
          sourceType: 'video',
          animated: false
        });
      }

      // 2. Blob-only / HLS-only stream without direct source -> Post-Linked MP4 Recovery. An unplayed X player (CLAUDE-RESUME-04: no source at all before
      // the first playback, only X's own video poster) is the same selected player of the same post: it gets the same ownership metadata and the same
      // recovery from the post's own declared variants; it is never "HLS only" for lack of an address and the poster is never its media.
      const unplayedXPlayer = Boolean(video) && candidateUrls.length === 0 && isXVideoPosterUrl(posterUrl);
      if (blobCandidates.length > 0 || unplayedXPlayer) {
        const { isQuoteTweet, postContainer, postUrl, tweetId } = xPostOf(video, pageUrl);

        const videosInContainer = postContainer && postContainer.querySelectorAll
          ? Array.from(postContainer.querySelectorAll('video')).filter(v => !xiCardOf(v, postContainer))
          : (video ? [video] : []);
        let mediaIndex = null;
        if (video && videosInContainer.length > 0) {
          const idx = videosInContainer.indexOf(video);
          if (idx >= 0) mediaIndex = idx;
        } else if (videosInContainer.length === 1) {
          mediaIndex = 0;
        }

        const mediaIdMatch = posterUrl ? posterUrl.match(/\/(?:ext_tw_video_thumb|amplify_video_thumb|media)\/(\d+)/i) : null;
        const mediaIdHint = mediaIdMatch ? mediaIdMatch[1] : null;

        const { recoveredMp4Url, recoveredBitrate, isConfirmedHls } = xDeclaredMp4(video, postContainer, { posterUrl, mediaIndex, mediaIdHint, isQuoteTweet });

        const isBlob = unplayedXPlayer || Boolean(blobCandidates[0]?.startsWith('blob:'));
        // Represent "unknown", "confirmed HLS-only", and "MP4 found" separately:
        // Do NOT set isHlsOnly to true simply because isolated world has no metadata.
        const isHls = Boolean(isConfirmedHls);

        return createMediaDescriptor({
          type: 'video',
          src: recoveredMp4Url || blobCandidates[0] || '',
          currentSrc: video?.currentSrc || blobCandidates[0] || '',
          poster: posterUrl,
          mime: 'video/mp4',
          pageUrl,
          linkUrl,
          x: typeof lastContextmenuX === 'number' ? lastContextmenuX : null,
          y: typeof lastContextmenuY === 'number' ? lastContextmenuY : null,
          sourceType: 'video',
          animated: false,
          isHlsOnly: isHls,
          isBlobPlayer: isBlob,
          recoveredMp4Url,
          recoveredBitrate,
          postUrl,
          tweetId,
          mediaIdHint,
          mediaIndex,
          isQuoteTweet
        });
      }

      // 3. Source-less video: an unavailable video descriptor (NEVER fall back to downloading the poster image!). A tweet_video poster
      // already returned its recovered MP4 above.

      return createMediaDescriptor({
        type: 'video',
        src: '',
        currentSrc: '',
        poster: posterUrl,
        mime: 'video/mp4',
        pageUrl,
        linkUrl,
        sourceType: 'video',
        animated: false,
        isHlsOnly: true
      });
    }

    // 2. Search for IMG element ONLY if no video or source element was present. A pressed IMG and the single IMG owned by a pressed
    // wrapper give the same descriptor: an image, or the tweet_video / ordinary X video that its poster address names.
    const imageDescriptor = (img, imgUrl) => {
      lastChosenEl = img;
      const tweetVideoUrl = toTweetVideoUrlFromPoster(imgUrl);
      if (tweetVideoUrl) {
        return createMediaDescriptor({
          type: 'x_tweet_video',
          src: tweetVideoUrl,
          currentSrc: tweetVideoUrl,
          poster: imgUrl,
          mime: 'video/mp4',
          pageUrl,
          linkUrl,
          sourceType: 'x_tweet_video',
          animated: true
        });
      }
      if (isXVideoPosterUrl(imgUrl)) {
        const { isQuoteTweet, postContainer, postUrl, tweetId } = xPostOf(img, pageUrl);

        const mediaIdMatch = imgUrl.match(/\/(?:ext_tw_video_thumb|amplify_video_thumb)\/(\d+)/i);
        const mediaIdHint = mediaIdMatch ? mediaIdMatch[1] : null;

        const { recoveredMp4Url, recoveredBitrate, isConfirmedHls } = xDeclaredMp4(null, postContainer, { posterUrl: imgUrl, mediaIdHint, isQuoteTweet });

        return createMediaDescriptor({
          type: 'video',
          src: recoveredMp4Url || '',
          currentSrc: recoveredMp4Url || '',
          poster: imgUrl,
          mime: 'video/mp4',
          pageUrl,
          linkUrl,
          x: typeof lastContextmenuX === 'number' ? lastContextmenuX : null,
          y: typeof lastContextmenuY === 'number' ? lastContextmenuY : null,
          sourceType: 'video',
          animated: false,
          isHlsOnly: isConfirmedHls,
          isBlobPlayer: true,
          recoveredMp4Url,
          recoveredBitrate,
          postUrl,
          tweetId,
          mediaIdHint,
          isQuoteTweet
        });
      }

      return createMediaDescriptor({
        type: 'image',
        src: imgUrl,
        currentSrc: imgUrl,
        poster: null,
        pageUrl,
        linkUrl
      });
    };
    for (const el of elements) {
      if (!el || el === document.body || el === document.documentElement) continue;

      if (el.tagName === 'IMG') {
        const imgUrl = el.currentSrc || el.src;
        if (imgUrl) return imageDescriptor(el, imgUrl);
      }
      const insideImgs = el.querySelector ? ownedWithin(el, 'img') : [];
      const insideImg = insideImgs.length === 1 ? insideImgs[0] : null;
      if (insideImg) {
        const imgUrl = insideImg.currentSrc || insideImg.src;
        if (imgUrl) return imageDescriptor(insideImg, imgUrl);
      }
    }

    return null;
  }

  /**
   * Discovers media element under the given client coordinates (penetrating transparent button overlays).
   */
  function findXMediaAtPoint(x, y) {
    if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') return null;
    const elements = document.elementsFromPoint(x, y);
    lastChosenEl = null;
    const media = findMediaInElements(elements, { x, y });
    if (media) {
      media.x = x;
      media.y = y;
    }
    lastFoundEl = media ? lastChosenEl : null;
    return media;
  }

  /**
   * Pre-detection on pointerdown / mousedown:
   * Only activates for right-click (button === 2) + shiftKey.
   * If media is found, stores descriptor and prevents text selection drag without canceling contextmenu.
   */
  function handlePointerOrMouseDown(e) {
    // A new right-button press starts a new gesture: nothing saved for an earlier click may carry over.
    if (e && e.button === 2) savedMediaDescriptor = null;
    if (!e || e.button !== 2 || !e.shiftKey) {
      isShiftRightClickOnMedia = false;
      return;
    }

    const x = e.clientX;
    const y = e.clientY;
    lastContextmenuX = x;
    lastContextmenuY = y;
    gestureKnown = true;

    const media = findXMediaAtPoint(x, y);
    if (media) {
      savedMediaDescriptor = {
        descriptor: media,
        selection: !media.url && lastFoundEl ? xiSnapshot(lastFoundEl, media.type, true) : null,
        owner: lastFoundEl ? new WeakRef(lastFoundEl) : null,
        x,
        y,
        timestamp: Date.now(),
        fromMouseDown: true
      };
      isShiftRightClickOnMedia = true;

      // Shift+RMB is the explicit request for the browser menu. Keep the native menu (no preventDefault),
      // but do not let X open its own media menu underneath it and replace the selected target.
      if (typeof e.stopPropagation === 'function') e.stopPropagation();

      try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({
            action: 'X_MEDIA_CONTEXTMENU_DETECTED',
            media,
            gestureAt: Number.isFinite(e.timeStamp) ? e.timeStamp : undefined
          });
        }
      } catch (_) {}

      // Prevent default text selection start / drag selection for mousedown
      if (e.type === 'mousedown') {
        if (typeof e.preventDefault === 'function') {
          e.preventDefault();
        }
        try {
          const sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null;
          if (sel && typeof sel.removeAllRanges === 'function' && !sel.isCollapsed) {
            sel.removeAllRanges();
          }
        } catch (_) {}
      }
    } else {
      isShiftRightClickOnMedia = false;
      savedMediaDescriptor = null;
    }
  }

  /**
   * Contextmenu event handler:
   * Uses saved descriptor if fresh, or falls back to querying at contextmenu coordinates.
   * NEVER calls preventDefault(): native Chrome context menu must open.
   */
  function handleContextMenu(e) {
    if (!e) return;
    lastContextmenuX = e.clientX;
    lastContextmenuY = e.clientY;
    gestureKnown = true;
    isShiftRightClickOnMedia = false;

    // Reuse only what this gesture's own press found (same point, one contextmenu per press); every
    // other contextmenu (a blank click, the keyboard menu key) is evaluated afresh at its own point.
    const isFresh = savedMediaDescriptor &&
      savedMediaDescriptor.fromMouseDown &&
      (Date.now() - savedMediaDescriptor.timestamp < 3000) &&
      Math.abs(savedMediaDescriptor.x - e.clientX) <= 4 &&
      Math.abs(savedMediaDescriptor.y - e.clientY) <= 4;

    if (isFresh) {
      savedMediaDescriptor.fromMouseDown = false;
    } else {
      const fallbackMedia = findXMediaAtPoint(e.clientX, e.clientY);
      if (fallbackMedia) {
        savedMediaDescriptor = {
          descriptor: fallbackMedia,
          selection: !fallbackMedia.url && lastFoundEl ? xiSnapshot(lastFoundEl, fallbackMedia.type, true) : null,
          owner: lastFoundEl ? new WeakRef(lastFoundEl) : null,
          x: e.clientX,
          y: e.clientY,
          timestamp: Date.now()
        };
      } else {
        savedMediaDescriptor = null;
      }
    }

    // Preserve Chrome's native context menu while suppressing the site's parallel menu for a confirmed media gesture.
    if (e.shiftKey && savedMediaDescriptor?.descriptor && typeof e.stopPropagation === 'function') {
      e.stopPropagation();
    }

    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'X_MEDIA_CONTEXTMENU_DETECTED',
          media: savedMediaDescriptor?.descriptor || null,
          gestureAt: Number.isFinite(e.timeStamp) ? e.timeStamp : undefined
        });
      }
    } catch (_) {}
  }

  /**
   * Prevent text selection start while isShiftRightClickOnMedia is true
   */
  function handleSelectStart(e) {
    if (isShiftRightClickOnMedia && e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
  }

  function handleMouseUp() {
    isShiftRightClickOnMedia = false;
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pointerdown', handlePointerOrMouseDown, true);
    window.addEventListener('mousedown', handlePointerOrMouseDown, true);
    window.addEventListener('selectstart', handleSelectStart, true);
    window.addEventListener('contextmenu', handleContextMenu, true);
    window.addEventListener('mouseup', handleMouseUp, true);
  }

  // Listen for messages from background service worker when context menu item is clicked
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.action === 'GET_X_MEDIA_AT_CURSOR') {
        let result = null;
        const isGestureMatch = savedMediaDescriptor &&
          (Date.now() - savedMediaDescriptor.timestamp < 300000) &&
          Math.abs(savedMediaDescriptor.x - lastContextmenuX) <= 4 &&
          Math.abs(savedMediaDescriptor.y - lastContextmenuY) <= 4;
        const current = findXMediaAtPoint(lastContextmenuX, lastContextmenuY);

        if (isGestureMatch) {
          // The media the gesture selected is returned only while that same media is still what sits at the point:
          // a removed, re-sourced or replaced player is never swapped for whatever is there now.
          const saved = savedMediaDescriptor.descriptor;
          const owner = savedMediaDescriptor.owner ? savedMediaDescriptor.owner.deref() : null;
          // The node the gesture chose must be the very node that is still there: connected and identical to the one
          // found at the point now, with the same media. A replacement with the same URL and type is another owner.
          result = owner && owner.isConnected !== false && owner === lastFoundEl &&
            current && saved && current.url === saved.url && current.type === saved.type &&
            // Empty URLs identify no media: re-prove the gesture-time poster, post and owner chain.
            (saved.url || (savedMediaDescriptor.selection && xiHolds(savedMediaDescriptor.selection))) ? saved : null;
        } else if (!gestureKnown) {
          result = current;
        }
        DBG.log('x.menu', 'descriptor', result ? 'ok' : 'refused', result ? undefined : (isGestureMatch ? 'STALE_SELECTION' : (gestureKnown ? 'GESTURE_MISMATCH' : 'NO_MEDIA')), () => (result ? {
          type: result.type, host: result.url, blob: result.isBlobPlayer === true, isQuote: result.isQuoteTweet === true, postId: result.tweetId || undefined, mediaId: result.mediaIdHint || undefined
        } : null));
        sendResponse(result);
        return true;
      }
    });
  }

  // --- X.com Post URL Copy Button Feature ---

  const X_BUTTON_STYLES = `
.image-saver-x-copy-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  width: 34px;
  height: 34px;
  min-width: 34px;
  min-height: 34px;
  max-width: 34px;
  max-height: 34px;
  flex-shrink: 0;
  cursor: pointer;
  user-select: none;
  color: rgb(113, 118, 123);
  transition: color 0.2s ease;
  outline: none;
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  box-sizing: border-box;
  line-height: 0;
  vertical-align: middle;
}
.image-saver-x-copy-wrap:hover {
  color: #8b5cf6 !important;
}
.image-saver-x-copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  min-width: 34px;
  min-height: 34px;
  border-radius: 9999px;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  line-height: 0;
  transition: background-color 0.2s ease;
}
.image-saver-x-copy-wrap:hover .image-saver-x-copy-btn {
  background-color: rgba(139, 92, 246, 0.12);
}
.image-saver-x-copy-wrap.is-success {
  color: #00ba7c !important;
}
.image-saver-x-copy-wrap.is-success .image-saver-x-copy-btn {
  background-color: rgba(0, 186, 124, 0.15) !important;
}
.image-saver-x-copy-wrap.is-error {
  color: #ef4444 !important;
}
.image-saver-x-copy-wrap.is-error .image-saver-x-copy-btn {
  background-color: rgba(239, 68, 68, 0.15) !important;
}
.image-saver-x-icon {
  width: 20px;
  height: 20px;
  display: block;
  pointer-events: none;
  flex-shrink: 0;
}
`;

  const SVG_LINK_ICON = `<svg class="image-saver-x-icon" viewBox="3 3 18 18" width="20" height="20" fill="currentColor">
    <path d="M15.89 5.64a5 5 0 0 0-7.07 0L6.33 8.13a1 1 0 0 0 1.41 1.41l2.49-2.49a3 3 0 0 1 4.24 4.24l-3.53 3.53a3 3 0 0 1-4.24 0 1 1 0 0 0-1.42 1.42 5 5 0 0 0 7.07 0l3.54-3.53a5 5 0 0 0 0-7.07zm-7.78 12.72a5 5 0 0 0 7.07 0l2.49-2.49a1 1 0 0 0-1.41-1.41l-2.49 2.49a3 3 0 0 1-4.24-4.24l3.53-3.53a3 3 0 0 1 4.24 0 1 1 0 0 0 1.42-1.42 5 5 0 0 0-7.07 0l-3.54 3.53a5 5 0 0 0 0 7.07z"/>
  </svg>`;

  const SVG_CHECK_ICON = `<svg class="image-saver-x-icon" viewBox="2 2 20 20" width="20" height="20" fill="currentColor">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
  </svg>`;

  const ALLOWED_X_SHARE_HOSTS = ['x.com', 'fixupx.com', 'cunnyx.com'];
  const DEFAULT_X_SHARE_HOST = 'fixupx.com';
  const xShare = globalThis.MediaLatchCopyKit.shareHost('xShareHost', ALLOWED_X_SHARE_HOSTS, DEFAULT_X_SHARE_HOST);

  /**
   * Constructs an embed-friendly or canonical share URL for an X/Twitter post.
   * Only allowed hosts: 'x.com', 'fixupx.com', 'cunnyx.com'.
   * Input must be HTTPS x.com or twitter.com post URL with numeric status ID.
   * Suffixes (/photo/*, /video/*), query, and hash are omitted.
   */
  function formatXShareUrl(rawUrl, targetHost = xShare.get()) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;

    const host = ALLOWED_X_SHARE_HOSTS.includes(targetHost) ? targetHost : DEFAULT_X_SHARE_HOST;

    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:') return null;

      const hostname = parsed.hostname.toLowerCase();
      if (hostname !== 'x.com' && hostname !== 'www.x.com' &&
          hostname !== 'twitter.com' && hostname !== 'www.twitter.com') {
        return null;
      }

      const match = parsed.pathname.match(/^\/([a-zA-Z0-9_]+)\/status\/(\d+)(?:\/.*)?$/i);
      if (!match) return null;

      const username = match[1];
      const statusId = match[2];
      return `https://${host}/${username}/status/${statusId}`;
    } catch (_) {
      return null;
    }
  }

  function ensureXButtonStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('image-saver-x-styles')) return;
    try {
      const styleEl = document.createElement('style');
      styleEl.id = 'image-saver-x-styles';
      styleEl.textContent = X_BUTTON_STYLES;
      (document.head || document.documentElement || document.body)?.appendChild(styleEl);
    } catch (_) {}
  }

  /**
   * Extracts canonical /status/{tweet_id} URL from a tweet article container.
   */
  function extractTweetUrl(article, currentWindowUrl = null) {
    if (!article) return null;

    const selfHref = String((typeof article.getAttribute === 'function' && article.getAttribute('data-href')) || '');
    const selfMatch = selfHref.match(/\/([a-zA-Z0-9_]+)\/status(?:es)?\/(\d+)/);
    if (selfMatch) {
      return `https://x.com/${selfMatch[1]}/status/${selfMatch[2]}`;
    }

    // 1. Primary: permalink anchor wrapping the tweet's <time> element
    if (typeof article.querySelectorAll === 'function') {
      const times = Array.from(article.querySelectorAll('time'));
      for (const timeEl of times) {
        const timeLink = timeEl.closest ? timeEl.closest('a') : timeEl.parentElement;
        if (!timeLink) continue;
        if (xiCardOf(timeLink, article)) continue;
        const nestedArt = timeLink.closest ? timeLink.closest('article') : null;
        if (nestedArt && nestedArt !== article && article.tagName === 'ARTICLE') continue;
        if (isAttributionAnchor(timeLink)) continue;
        const href = (timeLink.getAttribute && timeLink.getAttribute('href')) || timeLink.href || '';
        const match = href.match(/\/([a-zA-Z0-9_]+)\/status(?:es)?\/(\d+)/);
        if (match) {
          return `https://x.com/${match[1]}/status/${match[2]}`;
        }
      }

      // 2. Scan all status links, excluding nested quote-tweet containers and attribution links
      const allStatusLinks = Array.from(article.querySelectorAll('a[href*="/status/"]'));
      for (const a of allStatusLinks) {
        if (xiCardOf(a, article)) continue;
        const nestedArt = a.closest ? a.closest('article') : null;
        if (nestedArt && nestedArt !== article && article.tagName === 'ARTICLE') continue;
        if (isAttributionAnchor(a)) continue;
        const href = (a.getAttribute && a.getAttribute('href')) || a.href || '';
        const match = href.match(/\/([a-zA-Z0-9_]+)\/status(?:es)?\/(\d+)/);
        if (match) {
          return `https://x.com/${match[1]}/status/${match[2]}`;
        }
      }
    }

    // 3. Fallback: if the user is on the tweet's direct permalink page (ONLY for top-level post, never quote card)
    const isCard = Boolean(xiOwnerOf(article)?.quote) || (typeof article.getAttribute === 'function' &&
      (article.getAttribute('role') === 'link' || article.getAttribute('data-testid') === 'quoteTweet' || article.getAttribute('role') === 'blockquote'));
    if (!isCard) {
      const pageUrl = currentWindowUrl || (typeof window !== 'undefined' ? window.location?.href : '');
      if (pageUrl) {
        const pageMatch = pageUrl.match(/(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)\/status\/(\d+)/);
        if (pageMatch) {
          return `https://x.com/${pageMatch[1]}/status/${pageMatch[2]}`;
        }
      }
    }

    return null;
  }

  /**
   * Injects the post URL copy button into the tweet action bar (div[role="group"]).
   * Prevents duplicate injection via data attribute and DOM check.
   */
  function injectCopyButtonToActionBar(actionBar, article) {
    if (!actionBar || typeof actionBar.querySelector !== 'function') return false;

    // Duplicate check
    const hasAttr = (actionBar.dataset && actionBar.dataset.imageSaverBtn === 'true') ||
                    (actionBar.getAttribute && actionBar.getAttribute('data-image-saver-btn') === 'true');
    const hasExisting = Boolean(actionBar.querySelector('.image-saver-x-copy-wrap'));
    if (hasAttr || hasExisting) {
      return false;
    }

    if (actionBar.dataset) {
      actionBar.dataset.imageSaverBtn = 'true';
    }
    if (typeof actionBar.setAttribute === 'function') {
      actionBar.setAttribute('data-image-saver-btn', 'true');
    }

    if (typeof document === 'undefined') return false;

    const wrap = document.createElement('div');
    wrap.className = 'image-saver-x-copy-wrap';
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');
    isLabel(wrap, 'title', 'inline.copyPost', 'MediaLatch: Скопировать ссылку на пост');
    isLabel(wrap, 'aria-label', 'inline.copyPostAria', 'Copy post link');

    const btn = document.createElement('div');
    btn.className = 'image-saver-x-copy-btn';
    btn.innerHTML = SVG_LINK_ICON;
    wrap.appendChild(btn);

    wrap.addEventListener('click', async (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();

      const tweetUrl = extractTweetUrl(article);
      const shareUrl = tweetUrl ? formatXShareUrl(tweetUrl, xShare.get()) : null;
      if (!shareUrl) {
        DBG.log('x.copy', 'link', 'failed', 'NO_POST_LINK');
        wrap.classList.add('is-error');
        isLabel(wrap, 'title', 'inline.postUnknown', 'MediaLatch: Не удалось определить ссылку на пост');
        setTimeout(() => {
          wrap.classList.remove('is-error');
          isLabel(wrap, 'title', 'inline.copyPost', 'MediaLatch: Скопировать ссылку на пост');
        }, 2000);
        return;
      }

      let copied = false;
      const nav = (typeof window !== 'undefined' && window.navigator) ? window.navigator : (typeof navigator !== 'undefined' ? navigator : null);
      try {
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          await nav.clipboard.writeText(shareUrl);
          copied = true;
        }
      } catch (_) {}

      if (!copied && typeof document !== 'undefined') {
        try {
          const ta = document.createElement('textarea');
          ta.value = shareUrl;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          ta.style.pointerEvents = 'none';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          copied = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (_) {}
      }

      DBG.log('x.copy', 'link', copied ? 'ok' : 'failed', copied ? undefined : 'CLIPBOARD_FAILED');
      if (copied) {
        wrap.classList.add('is-success');
        btn.innerHTML = SVG_CHECK_ICON;
        isLabel(wrap, 'title', 'inline.copied', '✓ Ссылка скопирована!');
        setTimeout(() => {
          wrap.classList.remove('is-success');
          btn.innerHTML = SVG_LINK_ICON;
          isLabel(wrap, 'title', 'inline.copyPost', 'MediaLatch: Скопировать ссылку на пост');
        }, 1800);
      } else {
        wrap.classList.add('is-error');
        setTimeout(() => wrap.classList.remove('is-error'), 1800);
      }
    });

    wrap.addEventListener('keydown', (e) => {
      if (e && (e.key === 'Enter' || e.key === ' ')) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        wrap.click();
      }
    });

    actionBar.appendChild(wrap);
    return true;
  }


  function scanAndInjectXCopyButtons(root = (typeof document !== 'undefined' ? document : null)) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    ensureXButtonStyles();

    const articles = root.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    let count = 0;
    articles.forEach(article => {
      const actionBar = article.querySelector ? article.querySelector('div[role="group"]') : null;
      if (actionBar && injectCopyButtonToActionBar(actionBar, article)) {
        count++;
      }
    });
    return count;
  }

  const requestThrottledScan = globalThis.MediaLatchCopyKit.scheduler((root) => scanAndInjectXCopyButtons(root));

  const initXCopyButtonObserver = globalThis.MediaLatchCopyKit.observer({ prepare: ensureXButtonStyles, scan: scanAndInjectXCopyButtons, request: requestThrottledScan });

  globalThis.MediaLatchCopyKit.whenReady(initXCopyButtonObserver);

  // --- UX-10: the post-owner proof the inline Save control (content/content_inline.js) and the context menu share ---
  // A snapshot proves again that the same media element, in the same post container, still shows the same source in the same place of the tree.
  // The control itself (placement, "Save all", tokens, descriptors) lives in content_inline.js and reaches these through globalThis.__medialatchSite.x.
  const XI_PROMOTED = ['ad', 'promoted', 'реклама'];
  const XI_CHAIN = 14;
  const xiPromotedCache = new WeakMap();

  function xiImageKind(url) {
    if (!url || typeof url !== 'string') return null;
    if (toTweetVideoUrlFromPoster(url)) return 'gif-poster';
    if (isXVideoPosterUrl(url)) return 'video-poster';
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && u.hostname.toLowerCase() === 'pbs.twimg.com' && u.pathname.startsWith('/media/')) return 'photo';
    } catch (_) {}
    return null; // avatars, emoji, link cards, banners and everything else are not post media
  }

  // The status id this container itself shows: its own permalink (time link first), never an anchor of a nested quote or article.
  function xiIdOf(owner, isQuote) {
    if (!owner) return null;
    const selfHref = String((typeof owner.getAttribute === 'function' && owner.getAttribute('data-href')) || '');
    const mSelf = selfHref.match(/\/status(?:es)?\/(\d+)/);
    if (mSelf) return mSelf[1];

    if (typeof owner.querySelectorAll !== 'function') return null;
    const anchors = Array.from(owner.querySelectorAll('a[href*="/status/"]')).slice(0, 40);
    let fallback = null;
    for (const a of anchors) {
      if (typeof a.closest !== 'function') continue;
      // a link of a nested card belongs to that card; inside a card, a link of anything nested deeper is not its own
      if (xiCardOf(a, owner)) continue;
      const nested = a.closest('article');
      if (nested && nested !== owner && owner.tagName === 'ARTICLE') continue;
      if (isAttributionAnchor(a)) continue;
      const m = String((a.getAttribute && a.getAttribute('href')) || a.href || '').match(/\/status(?:es)?\/(\d+)/);
      if (!m) continue;
      if (typeof a.querySelector === 'function' && a.querySelector('time')) return m[1];
      if (!fallback) fallback = m[1];
    }
    return fallback;
  }

  // Best effort: a promoted post carries a visible "Ad" label near its header. Unknown layouts are not claimed to be covered.
  function xiPromoted(article) {
    // cached per container and permalink: a recycled container showing another post is looked at again
    const id = xiIdOf(article, false);
    const cached = xiPromotedCache.get(article);
    if (cached && cached.id === id) return cached.found;
    let found = false;
    try {
      const spans = typeof article.querySelectorAll === 'function' ? Array.from(article.querySelectorAll('span')).slice(0, 80) : [];
      found = spans.some((s) => XI_PROMOTED.includes(String(s.textContent || '').trim().toLowerCase()));
    } catch (_) {}
    xiPromotedCache.set(article, { id, found });
    return found;
  }

  const xiSrcOf = (el) => (el.tagName === 'VIDEO'
    ? `${el.currentSrc || el.src || ''}|${(el.getAttribute && el.getAttribute('poster')) || el.poster || ''}`
    : (el.currentSrc || el.src || ''));

  function xiSnapshot(el, kind, allowPromoted = false) {
    const o = xiOwnerOf(el);
    if (!o || (!allowPromoted && xiPromoted(o.article))) return null;
    if (typeof el.getBoundingClientRect !== 'function') return null;
    const chain = [];
    for (let p = el.parentElement; p && chain.length < XI_CHAIN; p = p.parentElement) {
      chain.push(new WeakRef(p));
      if (p === o.owner) break;
    }
    return {
      elRef: new WeakRef(el), ownerRef: new WeakRef(o.owner), articleRef: new WeakRef(o.article), isQuote: Boolean(o.quote),
      id: xiIdOf(o.owner, Boolean(o.quote)), tag: el.tagName, kind, src: xiSrcOf(el), chain, allowPromoted
    };
  }

  // Is this still the same element, in the same post container, showing the same source, in the same place of the tree?
  function xiHolds(s) {
    try {
      const el = s.elRef.deref();
      const owner = s.ownerRef.deref();
      const article = s.articleRef.deref();
      if (!el || !owner || !article || el.isConnected === false || owner.isConnected === false || article.isConnected === false) return false;
      const o = xiOwnerOf(el);
      if (!o || o.owner !== owner || o.article !== article || Boolean(o.quote) !== s.isQuote || (!s.allowPromoted && xiPromoted(article))) return false;
      if (el.tagName !== s.tag || xiSrcOf(el) !== s.src || xiIdOf(owner, s.isQuote) !== s.id) return false;
      let p = el.parentElement;
      for (const ref of s.chain) {
        if (!p || ref.deref() !== p) return false;
        p = p.parentElement;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // Export functions to global scope for unit testing in Node/vm if applicable
  if (typeof globalThis !== 'undefined') {
    globalThis.__findXMediaAtPoint = findXMediaAtPoint;
    globalThis.__findMediaInElements = findMediaInElements;
    globalThis.__createMediaDescriptor = createMediaDescriptor;
    globalThis.__detectVideoMime = detectVideoMime;
    globalThis.__getLastContextmenuCoords = () => ({ x: lastContextmenuX, y: lastContextmenuY });
    globalThis.__setLastContextmenuCoords = (x, y) => { lastContextmenuX = x; lastContextmenuY = y; };
    globalThis.__getSavedMediaDescriptor = () => savedMediaDescriptor;
    globalThis.__clearSavedMediaDescriptor = () => { savedMediaDescriptor = null; gestureKnown = false; isShiftRightClickOnMedia = false; };
    globalThis.__extractTweetUrl = extractTweetUrl;
    globalThis.__formatXShareUrl = formatXShareUrl;
    globalThis.__setCachedXShareHost = (h) => xShare.set(h);
    globalThis.__getCachedXShareHost = () => xShare.get();
    globalThis.__ALLOWED_X_SHARE_HOSTS = ALLOWED_X_SHARE_HOSTS;
    globalThis.__DEFAULT_X_SHARE_HOST = DEFAULT_X_SHARE_HOST;
    globalThis.__injectCopyButtonToActionBar = injectCopyButtonToActionBar;
    globalThis.__scanAndInjectXCopyButtons = scanAndInjectXCopyButtons;
    globalThis.__initXCopyButtonObserver = initXCopyButtonObserver;
    globalThis.__ensureXButtonStyles = ensureXButtonStyles;
    globalThis.__extractMediaItemsFromTweet = extractMediaItemsFromTweet;
    globalThis.__selectMatchingMediaItem = selectMatchingMediaItem;
    globalThis.__inspectVideoVariants = inspectVideoVariants;
    globalThis.__extractPostMetadataFromDom = extractPostMetadataFromDom;
    globalThis.__isXVideoPosterUrl = isXVideoPosterUrl;
    globalThis.__xiCardOf = xiCardOf;
    globalThis.__xiOwnerOf = xiOwnerOf;
    globalThis.__xiIdOf = xiIdOf;
    globalThis.__medialatchSite = Object.assign(globalThis.__medialatchSite || {}, {
      x: { post: XI_POST, ownerOf: xiOwnerOf, idOf: xiIdOf, snapshot: xiSnapshot, holds: xiHolds, promoted: xiPromoted, imageKind: xiImageKind, findMedia: findMediaInElements }
    });
  }
})();

