// content_x.js - Lightweight content script scoped strictly to X/Twitter
(() => {
  const isI18n = globalThis.ImageSaverI18n;
  const isLabels = isI18n && typeof chrome !== 'undefined' ? isI18n.follow(chrome, typeof navigator !== 'undefined' ? navigator : null, () => {}) : null;
  const isLabel = (element, field, key, fallback, vars) => {
    if (isLabels) isLabels.label(element, field, key, vars, fallback);
    else if (field === 'textContent') element.textContent = fallback;
    else if (fallback === null) element.removeAttribute(field);
    else element.setAttribute(field, fallback);
  };
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
   * Backward-compatible helper: returns best MP4 variant or null.
   */
  function selectBestMp4Variant(videoInfo) {
    const res = inspectVideoVariants(videoInfo);
    return res?.ok ? res.bestMp4 : null;
  }

  /**
   * Helper: walks React fiber / props hierarchy starting from a video or post element.
   * Extracts post media metadata and determines best MP4 variant.
   */
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
        let tweet = isQuoteTweet
          ? (props.tweet?.quoted_status || props.tweet?.quoted_status_result?.result?.legacy || props.tweet)
          : props.tweet;
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
          let tweet = isQuoteTweet
            ? (fProps.tweet?.quoted_status || fProps.tweet?.quoted_status_result?.result?.legacy || fProps.tweet)
            : fProps.tweet;
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

  /**
   * Universal media classifier for X/Twitter context.
   * If source matches video.twimg.com/tweet_video/*.mp4:
   * classifies as { type: "gif", sourceType: "x_tweet_video", mime: "video/mp4", animated: true }.
   * Normal MP4 remains video: { type: "video", sourceType: "video", mime: "video/mp4", animated: false }.
   * Recovers genuine tweet_video source when blob fallback is present.
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
        const base = (typeof window !== 'undefined' && window.location?.href) || 'https://x.com/';
        const parsed = new URL(u, base);
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
        const base = (typeof window !== 'undefined' && window.location?.href) || 'https://x.com/';
        const parsed = new URL(u, base);
        const host = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();
        return (host === 'twimg.com' || host.endsWith('.twimg.com')) && pathname.includes('/tweet_video_thumb/');
      } catch (_) {
        return false;
      }
    };

    // If source or poster matches X tweet_video, or type indicates x_tweet_video:
    // Blob fallback must not override recovered tweet_video source
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

      // 2. Blob-only / HLS-only stream without direct source -> Post-Linked MP4 Recovery
      if (blobCandidates.length > 0) {
        const quoteContainer = video ? (video.closest ? video.closest('[data-testid="quoteTweet"], [role="blockquote"]') : null) : null;
        const isQuoteTweet = Boolean(quoteContainer);
        const postContainer = quoteContainer ||
          (video && video.closest ? (video.closest('article[data-testid="tweet"], article[role="article"]') || video.closest('article')) : null) ||
          video?.parentElement;

        const postUrl = extractTweetUrl(postContainer, pageUrl) || pageUrl;
        const tweetIdMatch = postUrl ? postUrl.match(/\/status\/(\d+)/) : null;
        const tweetId = tweetIdMatch ? tweetIdMatch[1] : null;

        const videosInContainer = postContainer && postContainer.querySelectorAll ? Array.from(postContainer.querySelectorAll('video')) : (video ? [video] : []);
        let mediaIndex = null;
        if (video && videosInContainer.length > 0) {
          const idx = videosInContainer.indexOf(video);
          if (idx >= 0) mediaIndex = idx;
        } else if (videosInContainer.length === 1) {
          mediaIndex = 0;
        }

        const mediaIdMatch = posterUrl ? posterUrl.match(/\/(?:ext_tw_video_thumb|amplify_video_thumb|media)\/(\d+)/i) : null;
        const mediaIdHint = mediaIdMatch ? mediaIdMatch[1] : null;

        let recoveredMp4Url = null;
        let recoveredBitrate = null;
        let isConfirmedHls = false;

        const metaRes = extractPostMetadataFromDom(video, postContainer, { posterUrl, mediaIndex, mediaIdHint, isQuoteTweet });
        if (metaRes?.ok && metaRes.bestMp4) {
          recoveredMp4Url = metaRes.bestMp4.url;
          recoveredBitrate = metaRes.bestMp4.bitrate;
          isConfirmedHls = false;
        } else if (metaRes?.isHlsOnly) {
          isConfirmedHls = true;
        }

        const isBlob = Boolean(blobCandidates[0]?.startsWith('blob:'));
        // Represent "unknown", "confirmed HLS-only", and "MP4 found" separately:
        // Do NOT set isHlsOnly to true simply because isolated world has no metadata.
        const isHls = Boolean(isConfirmedHls);

        return createMediaDescriptor({
          type: 'video',
          src: recoveredMp4Url || blobCandidates[0],
          currentSrc: video?.currentSrc || blobCandidates[0],
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

      // 3. Source-less video fallback: check poster for tweet_video recovery,
      // or return unavailable video descriptor (NEVER fall back to downloading poster image!)
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

    // 2. Search for IMG element ONLY if no video or source element was present
    for (const el of elements) {
      if (!el || el === document.body || el === document.documentElement) continue;

      if (el.tagName === 'IMG') {
        const imgUrl = el.currentSrc || el.src;
        if (imgUrl) {
          lastChosenEl = el;
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
            const quoteContainer = el.closest ? el.closest('[data-testid="quoteTweet"], [role="blockquote"]') : null;
            const isQuoteTweet = Boolean(quoteContainer);
            const postContainer = quoteContainer ||
              (el.closest ? (el.closest('article[data-testid="tweet"], article[role="article"]') || el.closest('article')) : null) ||
              el.parentElement;

            const postUrl = extractTweetUrl(postContainer, pageUrl) || pageUrl;
            const tweetIdMatch = postUrl ? postUrl.match(/\/status\/(\d+)/) : null;
            const tweetId = tweetIdMatch ? tweetIdMatch[1] : null;

            const mediaIdMatch = imgUrl.match(/\/(?:ext_tw_video_thumb|amplify_video_thumb)\/(\d+)/i);
            const mediaIdHint = mediaIdMatch ? mediaIdMatch[1] : null;

            let recoveredMp4Url = null;
            let recoveredBitrate = null;
            let isConfirmedHls = false;

            const metaRes = extractPostMetadataFromDom(null, postContainer, { posterUrl: imgUrl, mediaIdHint, isQuoteTweet });
            if (metaRes?.ok && metaRes.bestMp4) {
              recoveredMp4Url = metaRes.bestMp4.url;
              recoveredBitrate = metaRes.bestMp4.bitrate;
              isConfirmedHls = false;
            } else if (metaRes?.isHlsOnly) {
              isConfirmedHls = true;
            }

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
        }
      }
      const insideImgs = el.querySelector ? ownedWithin(el, 'img') : [];
      const insideImg = insideImgs.length === 1 ? insideImgs[0] : null;
      if (insideImg) {
        const imgUrl = insideImg.currentSrc || insideImg.src;
        if (imgUrl) {
          lastChosenEl = insideImg;
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
            const quoteContainer = insideImg.closest ? insideImg.closest('[data-testid="quoteTweet"], [role="blockquote"]') : null;
            const isQuoteTweet = Boolean(quoteContainer);
            const postContainer = quoteContainer ||
              (insideImg.closest ? (insideImg.closest('article[data-testid="tweet"], article[role="article"]') || insideImg.closest('article')) : null) ||
              insideImg.parentElement;

            const postUrl = extractTweetUrl(postContainer, pageUrl) || pageUrl;
            const tweetIdMatch = postUrl ? postUrl.match(/\/status\/(\d+)/) : null;
            const tweetId = tweetIdMatch ? tweetIdMatch[1] : null;

            const mediaIdMatch = imgUrl.match(/\/(?:ext_tw_video_thumb|amplify_video_thumb)\/(\d+)/i);
            const mediaIdHint = mediaIdMatch ? mediaIdMatch[1] : null;

            let recoveredMp4Url = null;
            let recoveredBitrate = null;
            let isConfirmedHls = false;

            const metaRes = extractPostMetadataFromDom(null, postContainer, { posterUrl: imgUrl, mediaIdHint, isQuoteTweet });
            if (metaRes?.ok && metaRes.bestMp4) {
              recoveredMp4Url = metaRes.bestMp4.url;
              recoveredBitrate = metaRes.bestMp4.bitrate;
              isConfirmedHls = false;
            } else if (metaRes?.isHlsOnly) {
              isConfirmedHls = true;
            }

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
        }
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
            current && saved && current.url === saved.url && current.type === saved.type ? saved : null;
        } else if (!gestureKnown) {
          result = current;
        }
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
  const DEFAULT_X_SHARE_HOST = 'x.com';
  let cachedXShareHost = DEFAULT_X_SHARE_HOST;

  // Initialize and synchronize cachedXShareHost from storage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    try {
      chrome.storage.local.get({ xShareHost: DEFAULT_X_SHARE_HOST }, (res) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        if (res && ALLOWED_X_SHARE_HOSTS.includes(res.xShareHost)) {
          cachedXShareHost = res.xShareHost;
        } else {
          cachedXShareHost = DEFAULT_X_SHARE_HOST;
        }
      });
    } catch (_) {}
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes && changes.xShareHost) {
          const nextHost = changes.xShareHost.newValue;
          if (ALLOWED_X_SHARE_HOSTS.includes(nextHost)) {
            cachedXShareHost = nextHost;
          }
        }
      });
    } catch (_) {}
  }

  /**
   * Constructs an embed-friendly or canonical share URL for an X/Twitter post.
   * Only allowed hosts: 'x.com', 'fixupx.com', 'cunnyx.com'.
   * Input must be HTTPS x.com or twitter.com post URL with numeric status ID.
   * Suffixes (/photo/*, /video/*), query, and hash are omitted.
   */
  function formatXShareUrl(rawUrl, targetHost = cachedXShareHost) {
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

    // 1. Primary: permalink anchor wrapping the tweet's <time> element
    if (typeof article.querySelector === 'function') {
      const timeEl = article.querySelector('time');
      const timeLink = timeEl ? (timeEl.closest ? timeEl.closest('a') : timeEl.parentElement) : null;
      if (timeLink) {
        const href = (timeLink.getAttribute && timeLink.getAttribute('href')) || timeLink.href || '';
        const match = href.match(/\/([a-zA-Z0-9_]+)\/status\/(\d+)/);
        if (match) {
          return `https://x.com/${match[1]}/status/${match[2]}`;
        }
      }

      // 2. Scan all status links, excluding nested quote-tweet containers
      const allStatusLinks = article.querySelectorAll ? Array.from(article.querySelectorAll('a[href*="/status/"]')) : [];
      for (const a of allStatusLinks) {
        if (a.closest && a.closest('[data-testid="quoteTweet"], [role="blockquote"]')) {
          continue;
        }
        const href = (a.getAttribute && a.getAttribute('href')) || a.href || '';
        const match = href.match(/\/([a-zA-Z0-9_]+)\/status\/(\d+)/);
        if (match) {
          return `https://x.com/${match[1]}/status/${match[2]}`;
        }
      }
    }

    // 3. Fallback: if the user is on the tweet's direct permalink page
    const pageUrl = currentWindowUrl || (typeof window !== 'undefined' ? window.location?.href : '');
    if (pageUrl) {
      const pageMatch = pageUrl.match(/(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)\/status\/(\d+)/);
      if (pageMatch) {
        return `https://x.com/${pageMatch[1]}/status/${pageMatch[2]}`;
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
      const shareUrl = tweetUrl ? formatXShareUrl(tweetUrl, cachedXShareHost) : null;
      if (!shareUrl) {
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

  let isScanPending = false;

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

  function requestThrottledScan() {
    if (isScanPending) return;
    isScanPending = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        isScanPending = false;
        scanAndInjectXCopyButtons();
      });
    } else {
      setTimeout(() => {
        isScanPending = false;
        scanAndInjectXCopyButtons();
      }, 50);
    }
  }

  let xCopyObserver = null;

  function initXCopyButtonObserver() {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return null;

    ensureXButtonStyles();
    scanAndInjectXCopyButtons();

    if (xCopyObserver) {
      try { xCopyObserver.disconnect(); } catch (_) {}
    }

    xCopyObserver = new MutationObserver((mutations) => {
      let hasAdded = false;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length > 0) {
          hasAdded = true;
          break;
        }
      }
      if (hasAdded) {
        requestThrottledScan();
      }
    });

    const target = document.body || document.documentElement;
    if (target) {
      xCopyObserver.observe(target, { childList: true, subtree: true });
    }

    return xCopyObserver;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        initXCopyButtonObserver();
      }, { once: true });
    } else {
      initXCopyButtonObserver();
    }
  }

  // --- UX-10: inline Save control over X post media ("Save this" always; "Save all (N)" only for a post with several owned media) ---
  // One control (a closed shadow root in one host element) attached INSIDE the selected media's own tile: a local absolute child
  // of the nearest positioned ancestor that is not above the nearest clipping ancestor, so the browser clips it with the tile and
  // moves it with the slide. Its place comes from the visible part of the media (clipped by every clipping ancestor, the owning
  // post and the viewport), never from a raw image or carousel-track rectangle. When no such container can be proven it is hidden.
  // Hover does O(1) work and no network request. A click captures a fresh owner snapshot of that very element and sends only a
  // random token; background.js validates the sender and asks THIS document (same frame and document id) to prove the snapshot
  // again and to build the descriptor with the same builder the context menu uses, then runs the same X pipeline. No URL from
  // this message is ever trusted, no cursor state of the context menu is reused and no contextmenu event is simulated.
  const XI_POST = 'article[data-testid="tweet"], article[role="article"]';
  const XI_QUOTE = '[data-testid="quoteTweet"], [role="blockquote"]';
  const XI_PROMOTED = ['ad', 'promoted', 'реклама'];
  const XI = { HOVER_MS: 60, MAX_STACK: 24, MIN_W: 96, MIN_H: 64, TOKEN_TTL: 15000, CLICK_GAP: 1500, CHAIN: 14, INSET: 8, SIZE: 32, Z: 1, SETTLE_MS: 100, SETTLE_MAX: 12, DEPTH: 40, BATCH_MAX: 12, BATCH_TTL: 180000, MULTI_W: 104, MULTI_H: 60, COMPACT_W: 80, COMPACT_H: 32, ENUM_NODES: 80, TOL: 2, CORNER: 3 };
  const xiState = { host: null, btn: null, btnAll: null, lbl: null, lblAll: null, count: 0, compact: false, snap: null, el: null, observer: null, timer: null, settleTimer: null, settleN: 0, rearmTimer: null, rearmN: 0, sig: '', href: '', x: 0, y: 0, busyKey: '', busyAt: 0, busyTimer: null, keyEl: null, dismissed: null };
  const xiPending = new Map();
  const xiPromotedCache = new WeakMap();
  const xiBatches = new Map();

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

  // The nested post, reply or quote card around `el` inside the top-level post `top`, if X shows one as a separate container:
  // a nested <article> (the nearest article is not the top one), the legacy quote test ids, or a div[role=link] card that carries
  // its own status link or author header. Gallery tiles are <a> elements and never match.
  function xiCardOf(el, top) {
    const near = el.closest('article');
    if (near && near !== top) return near;
    const q = el.closest(XI_QUOTE);
    if (q && q !== top) return q;
    for (let p = el.parentElement, d = 0; p && p !== top && d < XI.DEPTH; p = p.parentElement, d++) {
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

  // The status id this container itself shows: its own permalink (time link first), never an anchor of a nested quote or article.
  function xiIdOf(owner, isQuote) {
    if (!owner || typeof owner.querySelectorAll !== 'function') return null;
    const anchors = Array.from(owner.querySelectorAll('a[href*="/status/"]')).slice(0, 40);
    let fallback = null;
    for (const a of anchors) {
      if (typeof a.closest !== 'function') continue;
      // a link of a nested card belongs to that card; inside a card, a link of anything nested deeper is not its own
      if (!isQuote && xiCardOf(a, owner)) continue;
      const nested = a.closest('article');
      if (nested && nested !== owner && owner.tagName === 'ARTICLE') continue;
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

  function xiSnapshot(el, kind) {
    const o = xiOwnerOf(el);
    if (!o || xiPromoted(o.article)) return null;
    if (typeof el.getBoundingClientRect !== 'function') return null;
    const chain = [];
    for (let p = el.parentElement; p && chain.length < XI.CHAIN; p = p.parentElement) {
      chain.push(new WeakRef(p));
      if (p === o.owner) break;
    }
    return {
      elRef: new WeakRef(el), ownerRef: new WeakRef(o.owner), articleRef: new WeakRef(o.article), isQuote: Boolean(o.quote),
      id: xiIdOf(o.owner, Boolean(o.quote)), tag: el.tagName, kind, src: xiSrcOf(el), chain
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
      if (!o || o.owner !== owner || o.article !== article || Boolean(o.quote) !== s.isQuote || xiPromoted(article)) return false;
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

  function xiSame(a, b) {
    return a.elRef.deref() === b.elRef.deref() && a.ownerRef.deref() === b.ownerRef.deref() && a.articleRef.deref() === b.articleRef.deref() &&
      a.isQuote === b.isQuote && a.id === b.id && a.tag === b.tag && a.src === b.src && a.kind === b.kind &&
      a.chain.length === b.chain.length && a.chain.every((ref, i) => ref.deref() === b.chain[i].deref());
  }

  function xiCandidate(stack) {
    const own = xiState.host;
    for (const el of stack.slice(0, XI.MAX_STACK)) {
      if (!el || (own && (el === own || (typeof own.contains === 'function' && own.contains(el))))) continue;
      if (el.tagName === 'VIDEO') return { el, kind: 'video' };
      if (el.tagName === 'IMG') {
        const kind = xiImageKind(el.currentSrc || el.src);
        if (!kind) return null; // the topmost image is an avatar, emoji or card: no button for the media behind it
        if (kind === 'photo') return { el, kind };
        // a poster over its own player: the player is the selected media
        const player = stack.slice(0, XI.MAX_STACK).find((v) => v && v.tagName === 'VIDEO' && xiOwnerOf(v) && xiOwnerOf(v).owner === (xiOwnerOf(el) || {}).owner);
        return player ? { el: player, kind: 'video' } : { el, kind };
      }
    }
    return null;
  }

  // ---- placement: the visible part of the selected media and a container that clips and moves the control with it ----
  const xiClips = (cs) => ['overflow', 'overflowX', 'overflowY'].some((k) => cs[k] && cs[k] !== 'visible');

  // { vis, host, left, top, sig } or null when no safe place can be proven. `w`/`h` are the control's size.
  function xiLayout(el, owner, w, h, compact = false) {
    try {
      if (!el || !owner || typeof el.getBoundingClientRect !== 'function' || typeof window.getComputedStyle !== 'function') return null;
      const r = el.getBoundingClientRect();
      let L = r.left, T = r.top, Rt = r.right, B = r.bottom;
      const clip = (b) => { L = Math.max(L, b.left); T = Math.max(T, b.top); Rt = Math.min(Rt, b.right); B = Math.min(B, b.bottom); };
      let container = null, containerAt = -1, clipAt = -1, reached = false;
      let depth = 0;
      for (let p = el.parentElement; p && depth < XI.DEPTH; p = p.parentElement, depth++) {
        const cs = window.getComputedStyle(p);
        if (!cs) return null;
        if (p !== owner && xiClips(cs)) {
          clip(p.getBoundingClientRect());
          if (clipAt < 0) clipAt = depth;
        }
        if (containerAt < 0 && cs.position && cs.position !== 'static') { container = p; containerAt = depth; }
        if (p === owner) { reached = true; break; }
      }
      // A control inside a positioned ancestor is clipped by that ancestor and everything above it; a clipping ancestor below
      // the container would not clip it, so the nearest clipping ancestor must be the container itself or above it.
      if (!reached || !container || (clipAt >= 0 && containerAt > clipAt)) return null;
      const carouselLeft = L, carouselRight = Rt;
      clip(owner.getBoundingClientRect());
      const vw = (typeof window.innerWidth === 'number' && window.innerWidth) || 0;
      const vh = (typeof window.innerHeight === 'number' && window.innerHeight) || 0;
      clip({ left: 0, top: 0, right: vw || Rt, bottom: vh || B });
      if (!(Rt - L >= Math.max(XI.MIN_W, w + 2 * XI.INSET)) || !(B - T >= Math.max(XI.MIN_H, h + 2 * XI.INSET))) return null;
      // A carousel may expose only part of neighbouring media: keep the icon pair inside that visible part.
      // Vertical clipping and clipping by the post or viewport still hide the control; only ancestor-clipped supported media qualifies.
      if (T - r.top > XI.TOL || r.bottom - B > XI.TOL) return null;
      if ((L - r.left > XI.TOL || r.right - Rt > XI.TOL) &&
          (!compact || !(el.tagName === 'VIDEO' || (el.tagName === 'IMG' && xiImageKind(el.currentSrc || el.src))) || clipAt < 0 ||
           L - carouselLeft > XI.TOL || carouselRight - Rt > XI.TOL)) return null;
      // ...and nothing outside the post (the sticky header, the sidebar, a dialog) may cover a corner of it.
      if (xiCovered(owner, { left: L, top: T, right: Rt, bottom: B })) return null;
      const cr = container.getBoundingClientRect();
      // a scaled or rotated container: local pixels no longer equal viewport pixels
      if (typeof container.offsetWidth === 'number' && container.offsetWidth > 0 && Math.abs(cr.width - container.offsetWidth) > 2) return null;
      const left = Math.round(Rt - XI.INSET - w - cr.left - (container.clientLeft || 0) + (container.scrollLeft || 0));
      const top = Math.round(T + XI.INSET - cr.top - (container.clientTop || 0) + (container.scrollTop || 0));
      return { vis: { left: L, top: T, right: Rt, bottom: B }, host: container, left, top, w, h, sig: [L, T, Rt, B, cr.left, cr.top, w, h].map(Math.round).join(',') };
    } catch (_) {
      return null;
    }
  }

  // The four corners of the visible media must hit something inside the post (the media itself, an overlay of the tile or our own
  // control); the page's own interface drawn over the media is not part of the post.
  function xiCovered(owner, vis) {
    if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return false;
    const host = xiState.host;
    const d = XI.CORNER;
    for (const [x, y] of [[vis.left + d, vis.top + d], [vis.right - d, vis.top + d], [vis.left + d, vis.bottom - d], [vis.right - d, vis.bottom - d]]) {
      const t = document.elementFromPoint(x, y);
      if (!t || !(t === host || (typeof owner.contains === 'function' && owner.contains(t)))) return true;
    }
    return false;
  }

  const xiPointIn = (b, x, y) => x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1;

  // ---- the media a post owns (for the explicit "Save all"): its own photos, videos and GIFs, nothing nested or around it ----
  function xiHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  // The identity of a media slot from X's own thumbnail/media paths, used only to count a player and its poster once.
  function xiSlotKey(el) {
    const srcs = el.tagName === 'VIDEO'
      ? [(el.getAttribute && el.getAttribute('poster')) || el.poster || '', el.currentSrc || el.src || '']
      : [el.currentSrc || el.src || ''];
    for (const s of srcs) {
      let m;
      if (/^https:\/\/pbs\.twimg\.com\//.test(s) && (m = /\/media\/([^/?#.]+)/.exec(s))) return `p:${m[1]}`;
      if ((m = /\/tweet_video(?:_thumb)?\/([^/?#.]+)/.exec(s))) return `g:${m[1]}`;
      if ((m = /\/(?:ext_tw_video|amplify_video)(?:_thumb)?\/(\d+)/.exec(s))) return `v:${m[1]}`;
    }
    return null;
  }

  // [{ el, kind }] in document order: only elements whose own container is this owner (media of a nested quote or article, avatars,
  // emoji, link cards, hidden or zero-size elements and a poster that belongs to a player in the same slot are not counted).
  function xiEnumerate(owner) {
    if (!owner || typeof owner.querySelectorAll !== 'function') return [];
    const out = [];
    const seen = new Map();
    for (const el of Array.from(owner.querySelectorAll('video, img')).slice(0, XI.ENUM_NODES)) {
      const o = xiOwnerOf(el);
      if (!o || o.owner !== owner || typeof el.getBoundingClientRect !== 'function') continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      let kind = 'video';
      if (el.tagName !== 'VIDEO') {
        kind = xiImageKind(el.currentSrc || el.src);
        if (!kind) continue;
        if (kind !== 'photo') {
          const slot = el.parentElement && el.parentElement.parentElement;
          if (slot && slot !== owner && typeof slot.querySelector === 'function' && slot.querySelector('video')) continue;
        }
      }
      const key = xiSlotKey(el);
      if (key && seen.has(key)) {
        const at = seen.get(key);
        if (out[at].el.tagName !== 'VIDEO' && el.tagName === 'VIDEO') out[at] = { el, kind };
        continue;
      }
      if (key) seen.set(key, out.length);
      out.push({ el, kind });
    }
    return out;
  }

  // N when the hovered media belongs to a post with several owned media (2..BATCH_MAX), otherwise 0 (a one-item post: no "all").
  function xiCountFor(owner, el) {
    const items = xiEnumerate(owner);
    return items.length >= 2 && items.length <= XI.BATCH_MAX && items.some((i) => i.el === el) ? items.length : 0;
  }

  const xiSize = () => (xiState.count >= 2
    ? (xiState.compact ? { w: XI.COMPACT_W, h: XI.COMPACT_H } : { w: XI.MULTI_W, h: XI.MULTI_H })
    : { w: XI.SIZE, h: XI.SIZE });

  // The control this media gets and the place for it. A post with several owned media always keeps both explicit actions: the
  // labelled pair when the tile can hold it, else two icon-only buttons (the count on the second) that fit any tile the single
  // button would fit; if not even that fits, nothing is shown (never a single action that hides Save all). One media: one button.
  function xiPlan(el, snap) {
    const owner = snap.ownerRef.deref();
    const n = xiCountFor(owner, el);
    if (n >= 2) {
      const wide = xiLayout(el, owner, XI.MULTI_W, XI.MULTI_H);
      if (wide) return { n, compact: false, lay: wide };
      const compact = xiLayout(el, owner, XI.COMPACT_W, XI.COMPACT_H, true);
      return compact ? { n, compact: true, lay: compact } : null;
    }
    const lay = xiLayout(el, owner, XI.SIZE, XI.SIZE);
    return lay ? { n: 0, compact: false, lay } : null;
  }

  function xiHeldPlan(el, owner) {
    const s = xiSize();
    const lay = xiLayout(el, owner, s.w, s.h, xiState.compact);
    return lay ? { n: xiState.count, lay } : null;
  }

  // ---- the control: one host, a closed shadow root, a real button for "Save this" and one for "Save all (N)" ----
  function xiIcon() {
    try {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '18');
      svg.setAttribute('height', '18');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', 'M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      return svg;
    } catch (_) {
      return null;
    }
  }

  // tier: 'single' (one round button), 'wide' (two labelled buttons), 'compact' (round "Save this" and a short "Save all" with the count)
  function xiButtonCss(btn, tier, isAll) {
    const s = btn.style;
    const width = tier === 'wide' ? XI.MULTI_W : (tier === 'compact' && isAll ? XI.COMPACT_W - XI.SIZE - 4 : XI.SIZE);
    const height = tier === 'wide' ? 28 : XI.SIZE;
    for (const [k, v] of [['all', 'initial'], ['box-sizing', 'border-box'], ['display', 'flex'], ['align-items', 'center'], ['justify-content', 'center'], ['gap', tier === 'wide' ? '6px' : '2px'], ['width', `${width}px`], ['height', `${height}px`], ['border-radius', '9999px'], ['border', '1px solid rgba(255,255,255,0.55)'], ['background', 'rgba(15,20,25,0.78)'], ['color', '#fff'], ['cursor', 'pointer'], ['padding', tier === 'wide' ? '0 10px' : (tier === 'compact' && isAll ? '0 4px' : '0')], ['font', '600 12px/1 system-ui, -apple-system, Segoe UI, sans-serif'], ['white-space', 'nowrap']]) s.setProperty(k, v);
  }

  function xiMakeButton(onClick, which) {
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    const icon = xiIcon();
    if (icon) btn.appendChild(icon);
    const lbl = document.createElement('span');
    btn.appendChild(lbl);
    // The control lives inside the post's tile: none of the press events of it may reach the tile's own handlers.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'touchstart', 'touchend']) {
      btn.addEventListener(type, (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); });
    }
    btn.addEventListener('click', onClick, true);
    btn.addEventListener('keydown', (e) => xiOnButtonKey(e, which), true);
    return { btn, lbl };
  }

  function xiEnsureHost() {
    if (xiState.host) return xiState.host;
    const host = document.createElement('div');
    host.setAttribute('data-image-saver-inline', 'x');
    const hs = host.style;
    hs.setProperty('position', 'absolute');
    hs.setProperty('z-index', String(XI.Z)); // local and conservative: native controls of the player stay above or beside it
    hs.setProperty('display', 'flex');
    hs.setProperty('flex-direction', 'column');
    hs.setProperty('align-items', 'flex-end');
    hs.setProperty('gap', '4px');
    hs.setProperty('width', `${XI.SIZE}px`);
    hs.setProperty('height', `${XI.SIZE}px`);
    hs.setProperty('margin', '0');
    hs.setProperty('padding', '0');
    const root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
    const one = xiMakeButton(xiOnClick, 'this');
    const all = xiMakeButton(xiOnClickAll, 'all');
    root.appendChild(one.btn);
    root.appendChild(all.btn);
    xiState.host = host;
    xiState.btn = one.btn;
    xiState.lbl = one.lbl;
    xiState.btnAll = all.btn;
    xiState.lblAll = all.lbl;
    xiRender(0, false);
    return host;
  }

  // n >= 2: "Save this" and "Save all (n)"; otherwise only the compact single action.
  function xiRender(n, compact = false) {
    const multi = n >= 2;
    xiState.count = multi ? n : 0;
    xiState.compact = multi && compact === true;
    const { btn, lbl, btnAll, lblAll } = xiState;
    if (!btn || !btnAll) return;
    const tier = !multi ? 'single' : (compact ? 'compact' : 'wide');
    xiButtonCss(btn, tier, false);
    xiButtonCss(btnAll, tier, true);
    const hs = xiState.host && xiState.host.style;
    if (hs) {
      hs.setProperty('flex-direction', tier === 'compact' ? 'row' : 'column');
      hs.setProperty('align-items', tier === 'compact' ? 'center' : 'flex-end');
      hs.setProperty('justify-content', 'flex-end');
    }
    isLabel(btn, 'aria-label', 'inline.saveThisAria', 'MediaLatch: Save this media');
    isLabel(btn, 'title', 'inline.saveThisAria', 'MediaLatch: Save this media');
    // wide: the words; compact: icons only, the count on "Save all"; the accessible names are the full words in every tier
    isLabel(lbl, 'textContent', tier === 'wide' ? 'inline.saveThis' : null, tier === 'wide' ? 'Save this' : '');
    lbl.style.setProperty('display', tier === 'wide' ? 'inline' : 'none');
    isLabel(lblAll, 'textContent', tier === 'wide' ? 'inline.saveAll' : null, tier === 'wide' ? `Save all (${n})` : (tier === 'compact' ? String(n) : ''), { n });
    lblAll.style.setProperty('display', multi ? 'inline' : 'none');
    if (multi) {
      btnAll.removeAttribute('hidden');
      isLabel(btnAll, 'aria-label', 'inline.saveAllAria', `MediaLatch: Save all ${n} media in this post`, { n });
      isLabel(btnAll, 'title', 'inline.saveAllAria', `MediaLatch: Save all ${n} media in this post`, { n });
    } else {
      btnAll.setAttribute('hidden', '');
      isLabel(btnAll, 'aria-label', null, null);
      isLabel(btnAll, 'title', null, null);
      btnAll.style.setProperty('display', 'none');
    }
  }

  // Attach the control to the proven container at the proven local position (the same node is moved, never duplicated).
  function xiApply(lay) {
    const host = xiEnsureHost();
    if (host.parentNode !== lay.host) lay.host.appendChild(host);
    host.style.setProperty('width', `${lay.w}px`);
    host.style.setProperty('height', `${lay.h}px`);
    host.style.setProperty('left', `${lay.left}px`);
    host.style.setProperty('top', `${lay.top}px`);
  }

  function xiHide() {
    if (xiState.timer) { clearTimeout(xiState.timer); xiState.timer = null; }
    if (xiState.settleTimer) { clearTimeout(xiState.settleTimer); xiState.settleTimer = null; }
    if (xiState.rearmTimer) { clearTimeout(xiState.rearmTimer); xiState.rearmTimer = null; }
    if (xiState.observer) { try { xiState.observer.disconnect(); } catch (_) {} xiState.observer = null; }
    xiState.snap = null;
    xiState.el = null;
    xiState.keyEl = null;
    xiState.sig = '';
    xiState.settleN = 0;
    xiState.rearmN = 0;
    if (xiState.host && typeof xiState.host.remove === 'function') xiState.host.remove();
  }

  // The media is still the owner's own but has no safe visible place (a hidden slide, a half-scrolled tile): hide the whole control
  // now and look again a few times (bounded) from the pointer's place, so it returns by itself once the tile has settled.
  function xiHideUntilVisible() {
    const n = xiState.rearmN;
    xiHide();
    xiState.rearmN = n;
    if (n >= XI.SETTLE_MAX || xiState.rearmTimer) return;
    xiState.rearmN = n + 1;
    xiState.rearmTimer = setTimeout(() => { xiState.rearmTimer = null; xiEvaluate(); }, XI.SETTLE_MS);
  }

  // Re-prove the shown control: same owner, still a safe visible place, the right actions; follow a moving slide for a bounded time.
  function xiRecheck() {
    xiState.settleTimer = null;
    const snap = xiState.snap;
    if (!snap) return;
    const el = snap.elRef.deref();
    const owner = snap.ownerRef.deref();
    if (!(el && owner && xiHolds(snap))) { xiHide(); return; }
    const plan = xiPlan(el, snap);
    if (!plan) { xiHideUntilVisible(); return; }
    if (plan.n !== xiState.count || plan.compact !== xiState.compact) xiRender(plan.n, plan.compact);
    xiApply(plan.lay);
    if (plan.lay.sig !== xiState.sig) {
      xiState.sig = plan.lay.sig;
      if (xiState.settleN < XI.SETTLE_MAX) { xiState.settleN++; xiState.settleTimer = setTimeout(xiRecheck, XI.SETTLE_MS); }
    } else {
      xiState.settleN = 0;
    }
  }

  function xiShow(el, snap, plan) {
    xiEnsureHost();
    xiState.snap = snap;
    xiState.el = el;
    xiState.sig = plan.lay.sig;
    xiState.settleN = 0;
    if (xiState.settleTimer) { clearTimeout(xiState.settleTimer); xiState.settleTimer = null; }
    xiRender(plan.n, plan.compact);
    xiApply(plan.lay);
    if (xiState.observer) { try { xiState.observer.disconnect(); } catch (_) {} xiState.observer = null; }
    if (typeof MutationObserver === 'function') {
      // Scoped to the owning post: structure changes anywhere inside it, and attribute changes only on the media itself and on its
      // ancestors up to the post (a carousel track or a tile that translates, a source or poster that changes). One pending check.
      let pending = false;
      const host = xiState.host;
      xiState.observer = new MutationObserver((records) => {
        if (Array.isArray(records) && records.length && records.every((rec) => rec && rec.target === host)) return;
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; if (xiState.snap) xiRecheck(); }, XI.SETTLE_MS);
      });
      const owner = snap.ownerRef.deref();
      if (owner) {
        xiState.observer.observe(owner, { childList: true, subtree: true });
        xiState.observer.observe(el, { attributes: true, attributeFilter: ['src', 'poster', 'style', 'class'] });
        for (const ref of snap.chain) {
          const node = ref.deref();
          if (node) xiState.observer.observe(node, { attributes: true, attributeFilter: ['style', 'class'] });
        }
      }
    }
  }

  function xiEvaluate() {
    xiState.timer = null;
    try {
      if (document.hidden) { xiHide(); return; }
      const href = (typeof location !== 'undefined' && location.href) || '';
      if (href !== xiState.href) { xiState.href = href; xiHide(); }
      if (typeof document.elementsFromPoint !== 'function') return;
      const cand = xiCandidate(document.elementsFromPoint(xiState.x, xiState.y));
      if (!cand) { xiHide(); return; }
      if (xiState.dismissed && xiState.dismissed === cand.el) return;
      const held = xiState.snap && xiState.snap.elRef.deref() === cand.el && xiHolds(xiState.snap) ? xiState.snap : null;
      const snap = held || xiSnapshot(cand.el, cand.kind);
      if (!snap) { xiHide(); return; }
      const plan = held ? xiHeldPlan(cand.el, snap.ownerRef.deref()) : xiPlan(cand.el, snap);
      if (!plan) { xiHideUntilVisible(); return; }
      // The pointer must be on the VISIBLE part of this media (a clipped remainder of a raw rectangle is not the media).
      if (!xiPointIn(plan.lay.vis, xiState.x, xiState.y)) { xiHide(); return; }
      xiState.rearmN = 0;
      if (held) { xiApply(plan.lay); xiState.sig = plan.lay.sig; return; }
      xiShow(cand.el, snap, plan);
    } catch (_) {
      xiHide();
    }
  }

  function xiOnMove(e) {
    if (!e || (e.pointerType && e.pointerType !== 'mouse')) return;
    xiState.x = e.clientX;
    xiState.y = e.clientY;
    xiState.rearmN = 0;
    if (!xiState.timer) xiState.timer = setTimeout(xiEvaluate, XI.HOVER_MS);
  }

  // Keyboard: focusing an owned media (or its focusable wrapper) shows the control; Tab then moves to "Save this" and on to
  // "Save all", and Tab or Escape leaves it.
  function xiMediaWithin(node) {
    if (!node) return null;
    if (node.tagName === 'VIDEO' || node.tagName === 'IMG') return node;
    if (typeof node.querySelectorAll !== 'function') return null;
    const list = Array.from(node.querySelectorAll('video, img')).filter((m) => m.tagName === 'VIDEO' || xiImageKind(m.currentSrc || m.src));
    return list.length === 1 ? list[0] : null;
  }

  function xiOnFocusIn(e) {
    try {
      const t = e && e.target;
      if (!t || (xiState.host && (t === xiState.host || (typeof xiState.host.contains === 'function' && xiState.host.contains(t))))) return;
      // a focus anywhere outside a post costs one closest() call, never a subtree query
      if (typeof t.closest !== 'function' || !(t.closest(XI_POST) || t.closest('article'))) return;
      const el = xiMediaWithin(t);
      if (!el) return;
      const kind = el.tagName === 'VIDEO' ? 'video' : xiImageKind(el.currentSrc || el.src);
      if (!kind || xiState.dismissed === t) return;
      const snap = xiSnapshot(el, kind);
      if (!snap) return;
      const plan = xiPlan(el, snap);
      if (!plan) return;
      xiShow(el, snap, plan);
      xiState.keyEl = t;
    } catch (_) {}
  }

  function xiOnFocusOut(e) {
    if (e && xiState.dismissed === e.target) xiState.dismissed = null;
  }

  function xiOnDocKey(e) {
    if (!e || e.key !== 'Tab' || e.shiftKey || !xiState.keyEl || !xiState.btn || document.activeElement !== xiState.keyEl) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof xiState.btn.focus === 'function') xiState.btn.focus();
  }

  // Tab order inside the control: media, "Save this", "Save all"; Shift+Tab goes back; Tab past the last action or Escape dismisses.
  function xiOnButtonKey(e, which = 'this') {
    if (!e || (e.key !== 'Tab' && e.key !== 'Escape')) return;
    if (e.key === 'Tab' && xiState.count >= 2) {
      if (which === 'this' && !e.shiftKey && xiState.btnAll && typeof xiState.btnAll.focus === 'function') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        xiState.btnAll.focus();
        return;
      }
      if (which === 'all' && e.shiftKey && xiState.btn && typeof xiState.btn.focus === 'function') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        xiState.btn.focus();
        return;
      }
    }
    const back = xiState.keyEl;
    if (e.key === 'Tab' && typeof e.preventDefault === 'function') e.preventDefault();
    xiState.dismissed = back || null;
    xiHide();
    if (back && typeof back.focus === 'function') back.focus();
  }

  const xiToken = () => {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  function xiSend(message, token, pending) {
    try {
      const sent = chrome.runtime.sendMessage(message);
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch (_) {
      if (pending) pending.delete(token);
    }
    if (xiState.btn) {
      xiState.btn.setAttribute('aria-busy', 'true');
      if (xiState.btnAll) xiState.btnAll.setAttribute('aria-busy', 'true');
      if (xiState.busyTimer) clearTimeout(xiState.busyTimer);
      xiState.busyTimer = setTimeout(() => {
        xiState.busyTimer = null;
        if (xiState.btn) xiState.btn.removeAttribute('aria-busy');
        if (xiState.btnAll) xiState.btnAll.removeAttribute('aria-busy');
      }, XI.CLICK_GAP);
    }
  }

  // "Save this": the hovered item only.
  function xiOnClick(e) {
    if (e) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    if (!e || e.isTrusted !== true) return;
    const shown = xiState.snap;
    const el = shown && shown.elRef.deref();
    const s = xiSize();
    // A fresh snapshot of the very element the button belongs to, equal to what the hover showed, still in a provable place.
    const fresh = el ? xiSnapshot(el, shown.kind) : null;
    if (!fresh || !xiSame(fresh, shown) || !xiHolds(shown) || !xiLayout(el, fresh.ownerRef.deref(), s.w, s.h, xiState.compact)) { xiHide(); return; }
    const key = `${fresh.id}|${fresh.src}`;
    const now = Date.now();
    if (xiState.busyKey === key && now - xiState.busyAt < XI.CLICK_GAP) return;
    xiState.busyKey = key;
    xiState.busyAt = now;
    for (const [t, v] of xiPending) if (now - v.at > XI.TOKEN_TTL) xiPending.delete(t);
    while (xiPending.size >= 8) xiPending.delete(xiPending.keys().next().value);
    const token = xiToken();
    xiPending.set(token, { snap: fresh, at: now });
    xiSend({ action: 'X_INLINE_SAVE', token }, token, xiPending);
  }

  // "Save all (N)": only on this explicit click. A fresh enumeration must equal what the control showed; every item gets its own
  // fresh snapshot; the background then asks for each item's proof again just before that item is saved.
  function xiOnClickAll(e) {
    if (e) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    if (!e || e.isTrusted !== true) return;
    const shown = xiState.snap;
    const el = shown && shown.elRef.deref();
    const owner = shown && shown.ownerRef.deref();
    const s = xiSize();
    const fresh = el ? xiSnapshot(el, shown.kind) : null;
    if (!fresh || !owner || xiState.count < 2 || !xiSame(fresh, shown) || !xiHolds(shown) || !xiLayout(el, owner, s.w, s.h, xiState.compact)) { xiHide(); return; }
    const items = xiEnumerate(owner);
    if (items.length !== xiState.count || items.length > XI.BATCH_MAX || !items.some((i) => i.el === el)) { xiHide(); return; }
    const snaps = [];
    for (const it of items) {
      const snap = xiSnapshot(it.el, it.kind);
      if (!snap || snap.ownerRef.deref() !== owner) { xiHide(); return; }
      snaps.push(snap);
    }
    const sig = xiHash(snaps.map((x) => `${x.kind}:${x.src}`).join('|'));
    const key = `all|${fresh.id}|${sig}`;
    const now = Date.now();
    if (xiState.busyKey === key && now - xiState.busyAt < XI.CLICK_GAP) return;
    xiState.busyKey = key;
    xiState.busyAt = now;
    for (const [t, v] of xiBatches) if (now - v.at > XI.BATCH_TTL) xiBatches.delete(t);
    while (xiBatches.size >= 4) xiBatches.delete(xiBatches.keys().next().value);
    const token = xiToken();
    xiBatches.set(token, { items: snaps.map((snap) => ({ snap, used: false })), href: (typeof location !== 'undefined' && location.href) || '', at: now, opened: false, sig, id: fresh.id });
    xiSend({ action: 'X_INLINE_SAVE_ALL', token }, token, xiBatches);
  }

  // One item's descriptor, built with the context-menu builder for the element the snapshot proves.
  function xiDescribe(snap) {
    const el = snap.elRef.deref();
    const media = el ? findMediaInElements([el], null) : null;
    if (!media) return { ok: false, reason: 'NO_MEDIA' };
    const expected = snap.kind === 'photo' ? ['image'] : snap.kind === 'gif-poster' ? ['x_tweet_video'] : snap.kind === 'video-poster' ? ['video'] : ['video', 'x_tweet_video'];
    if (!expected.includes(media.type)) return { ok: false, reason: 'KIND_MISMATCH' };
    if (typeof media.x === 'number') {
      // a player's recovery looks the post up by point: this element's own centre, never the context-menu cursor
      const r = el.getBoundingClientRect();
      media.x = Math.round(r.left + r.width / 2);
      media.y = Math.round(r.top + r.height / 2);
    }
    return { ok: true, media };
  }

  // The background asks this document to prove the snapshot a second time and to build the descriptor with the context-menu builder.
  function xiAnswerOwner(token) {
    const entry = typeof token === 'string' ? xiPending.get(token) : null;
    xiPending.delete(token);
    if (!entry || Date.now() - entry.at > XI.TOKEN_TTL) return { ok: false, reason: 'NO_TOKEN' };
    if (!xiHolds(entry.snap)) return { ok: false, reason: 'STALE_OWNER' };
    return xiDescribe(entry.snap);
  }

  // The post itself (not the item) still is the one the batch was started for: connected, same permalink, not promoted, same page.
  function xiOwnerHolds(snap, entry) {
    try {
      const owner = snap.ownerRef.deref();
      const article = snap.articleRef.deref();
      return Boolean(owner && article && owner.isConnected !== false && article.isConnected !== false &&
        ((typeof location !== 'undefined' && location.href) || '') === entry.href && xiIdOf(owner, snap.isQuote) === snap.id && !xiPromoted(article));
    } catch (_) {
      return false;
    }
  }

  // Phase 1 of a batch: every item and the owner's list of media are proven again before any privileged work starts.
  function xiBatchOpen(token) {
    const entry = typeof token === 'string' ? xiBatches.get(token) : null;
    if (!entry || Date.now() - entry.at > XI.BATCH_TTL) { xiBatches.delete(token); return { ok: false, reason: 'NO_TOKEN' }; }
    if (entry.opened) return { ok: false, reason: 'USED' };
    entry.opened = true;
    if (!entry.items.every((it) => xiOwnerHolds(it.snap, entry))) return { ok: false, reason: 'STALE_OWNER' };
    if (!entry.items.every((it) => xiHolds(it.snap))) return { ok: false, reason: 'STALE_ITEM' };
    const owner = entry.items[0].snap.ownerRef.deref();
    const now = xiEnumerate(owner);
    if (now.length !== entry.items.length || !now.every((it, i) => it.el === entry.items[i].snap.elRef.deref())) return { ok: false, reason: 'STALE_ITEM' };
    return { ok: true, count: entry.items.length, ownerId: entry.id, sig: entry.sig };
  }

  // Phase 2: the proof of ONE item, asked for right before that item is saved; one shot per item.
  function xiBatchItem(token, index) {
    const entry = typeof token === 'string' ? xiBatches.get(token) : null;
    if (!entry || Date.now() - entry.at > XI.BATCH_TTL) { xiBatches.delete(token); return { ok: false, reason: 'NO_TOKEN' }; }
    const item = Number.isInteger(index) && index >= 0 && index < entry.items.length ? entry.items[index] : null;
    if (!item || !entry.opened) return { ok: false, reason: 'NO_TOKEN' };
    if (item.used) return { ok: false, reason: 'USED' };
    item.used = true;
    if (entry.items.every((it) => it.used)) xiBatches.delete(token);
    if (!xiOwnerHolds(item.snap, entry)) return { ok: false, reason: 'STALE_OWNER' };
    if (!xiHolds(item.snap)) return { ok: false, reason: 'STALE_ITEM' };
    return xiDescribe(item.snap);
  }

  function xiTeardown() {
    xiHide();
    xiPending.clear();
    xiBatches.clear();
    if (xiState.busyTimer) { clearTimeout(xiState.busyTimer); xiState.busyTimer = null; }
    if (xiState.host && typeof xiState.host.remove === 'function') xiState.host.remove();
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    document.addEventListener('pointermove', xiOnMove, { capture: true, passive: true });
    document.addEventListener('focusin', xiOnFocusIn, true);
    document.addEventListener('focusout', xiOnFocusOut, true);
    document.addEventListener('keydown', xiOnDocKey, true);
    document.addEventListener('visibilitychange', xiHide, true);
    for (const type of ['scroll', 'wheel', 'resize', 'popstate']) window.addEventListener(type, xiHide, { capture: true, passive: true });
    // a window blur only (a capturing listener would also see every element's blur, e.g. the button taking focus)
    window.addEventListener('blur', (e) => { if (e.target === window) xiHide(); }, true);
    window.addEventListener('pagehide', xiTeardown, true);
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const action = message && message.action;
      if (action !== 'X_INLINE_OWNER' && action !== 'X_INLINE_BATCH' && action !== 'X_INLINE_OWNER_ITEM') return;
      // only the extension's own background (not a page, not a content script of another tab) may ask
      if (!sender || sender.tab || sender.id !== chrome.runtime.id) return;
      sendResponse(action === 'X_INLINE_OWNER' ? xiAnswerOwner(message.token)
        : action === 'X_INLINE_BATCH' ? xiBatchOpen(message.token)
          : xiBatchItem(message.token, message.index));
    });
  }

  // Export functions to global scope for unit testing in Node/vm if applicable
  if (typeof globalThis !== 'undefined') {
    globalThis.__findXMediaAtPoint = findXMediaAtPoint;
    globalThis.__findMediaInElements = findMediaInElements;
    globalThis.__createMediaDescriptor = createMediaDescriptor;
    globalThis.__detectVideoMime = detectVideoMime;
    globalThis.__classifyMediaTarget = classifyMediaTarget;
    globalThis.__getLastContextmenuCoords = () => ({ x: lastContextmenuX, y: lastContextmenuY });
    globalThis.__setLastContextmenuCoords = (x, y) => { lastContextmenuX = x; lastContextmenuY = y; };
    globalThis.__getSavedMediaDescriptor = () => savedMediaDescriptor;
    globalThis.__clearSavedMediaDescriptor = () => { savedMediaDescriptor = null; gestureKnown = false; isShiftRightClickOnMedia = false; };
    globalThis.__extractTweetUrl = extractTweetUrl;
    globalThis.__formatXShareUrl = formatXShareUrl;
    globalThis.__setCachedXShareHost = (h) => { cachedXShareHost = h; };
    globalThis.__getCachedXShareHost = () => cachedXShareHost;
    globalThis.__ALLOWED_X_SHARE_HOSTS = ALLOWED_X_SHARE_HOSTS;
    globalThis.__DEFAULT_X_SHARE_HOST = DEFAULT_X_SHARE_HOST;
    globalThis.__injectCopyButtonToActionBar = injectCopyButtonToActionBar;
    globalThis.__scanAndInjectXCopyButtons = scanAndInjectXCopyButtons;
    globalThis.__initXCopyButtonObserver = initXCopyButtonObserver;
    globalThis.__ensureXButtonStyles = ensureXButtonStyles;
    globalThis.__extractMediaItemsFromTweet = extractMediaItemsFromTweet;
    globalThis.__selectMatchingMediaItem = selectMatchingMediaItem;
    globalThis.__selectBestMp4Variant = selectBestMp4Variant;
    globalThis.__inspectVideoVariants = inspectVideoVariants;
    globalThis.__extractPostMetadataFromDom = extractPostMetadataFromDom;
    globalThis.__isXVideoPosterUrl = isXVideoPosterUrl;
  }
})();

