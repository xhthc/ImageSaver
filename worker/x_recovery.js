// Classic worker module; loaded by background.js right before worker/providers.js.
// X selected-player recovery: the MAIN-world reader of the owning post's declared video variants and its worker-side caller.

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

  function isAttributionAnchor(a) {
    if (!a) return false;
    const href = a.href || (a.getAttribute && a.getAttribute('href')) || '';
    if (/\/status(?:es)?\/\d+\/video\//i.test(href)) return true;
    if (a.closest && a.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"], video')) return true;
    return false;
  }

  function findQuoteContainer(el, outerArt) {
    if (!el) return null;
    if (outerArt && typeof outerArt.contains === 'function' && !outerArt.contains(el)) return null;
    for (let p = el, depth = 0; p && p !== outerArt && depth < 40; p = p.parentElement, depth++) {
      const role = typeof p.getAttribute === 'function' ? p.getAttribute('role') : null;
      if (p.tagName === 'ARTICLE' || role === 'blockquote' || p.getAttribute?.('data-testid') === 'quoteTweet') return p;
      if (p.tagName === 'DIV' && typeof p.getAttribute === 'function' && p.getAttribute('role') === 'link') {
        if (/\/status(?:es)?\/\d+/.test(p.getAttribute('data-href') || '') || (typeof p.querySelector === 'function' && p.querySelector('[data-testid="User-Name"]'))) return p;
      }
    }
    return null;
  }

  function extractStatusIdsFromContainer(container, isQuote, hintId) {
    if (!container) return [];
    const ids = [];
    const selfHref = container.getAttribute && container.getAttribute('data-href');
    if (selfHref) {
      const sid = parseStatusIdFromUrl(selfHref);
      if (sid && !ids.includes(sid)) ids.push(sid);
    }
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
      if (findQuoteContainer(a, container)) continue;
      if (container.tagName === 'ARTICLE' && a.closest) {
        const aArt = a.closest('article');
        if (aArt && aArt !== container) continue;
      }
      if (isAttributionAnchor(a)) continue;
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
    const selfHref = container.getAttribute && container.getAttribute('data-href');
    if (selfHref) {
      const sid = parseStatusIdFromUrl(selfHref);
      if (sid) return sid;
    }
    let timeAnchors = [];
    if (container.querySelectorAll) {
      timeAnchors = Array.from(container.querySelectorAll('a:has(time), a[href*="/status/"], a'));
    }
    for (const a of timeAnchors) {
      if (findQuoteContainer(a, container)) continue;
      if (container.tagName === 'ARTICLE' && a.closest) {
        const aArt = a.closest('article');
        if (aArt && aArt !== container) continue;
      }
      if (isAttributionAnchor(a)) continue;
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

  // X-QUOTE-06: a quote card without its own permalink (the only status link in it is the video's attribution) carries its post on the
  // component fibers that render the card, not on the card's DOM node. The owner is the post of the nearest such fiber directly above the
  // card's own host fiber, and only when: the selected media id is one of that post's own media; every other post up to the outer article
  // is that same post or one that explicitly quotes it (or reposts a post that quotes it); and at least one does. Another owner on the way,
  // no quoting post, no media id or a media mismatch leaves the owner unknown (null). Bounded like the other fiber walks.
  // A wrapper is this card's own only when it is not a quote container itself and contains no other one (only this card, its ancestors
  // up to the wrapper and what the card itself contains).
  function holdsOtherCard(node, card, outerArt) {
    if (findQuoteContainer(node, outerArt) === node) return true;
    const cards = typeof node.querySelectorAll === 'function'
      ? Array.from(node.querySelectorAll('article, div[role="link"], [data-testid="quoteTweet"], [role="blockquote"]')) : [];
    if (cards.length > 64) return true; // too much to prove it holds nothing else: not this card's wrapper
    return cards.some((c) => c !== card && !(typeof c.contains === 'function' && c.contains(card)) && !(typeof card.contains === 'function' && card.contains(c)) &&
      findQuoteContainer(c, outerArt) === c);
  }

  function quoteOwnerFromCardFibers(card, outerArt, mediaId) {
    if (!card || !outerArt || !mediaId) return null;
    const quotedIdOf = (t) => getTweetId(t?.quoted_status) || getTweetId(t?.quoted_status_result?.result) ||
      getTweetId(t?.quoted_status_result?.result?.tweet) || getTweetId(t?.legacy?.quoted_status_result?.result);
    const host = getReactFiber(card);
    let owner = null;
    let quotedBy = false;
    let f = host ? host.return : null;
    for (let depth = 0; f && depth < 60; f = f.return, depth++) {
      diag.fibers++;
      const node = f.stateNode && typeof f.stateNode === 'object' && f.stateNode.nodeType === 1 ? f.stateNode : null;
      if (node) {
        // X-QUOTE-07: the quote's own post may render wrapper elements around the card (observed: one DIV at fiber depth 9 before the post
        // at 11/12). Before the owner is known, a DOM element passed on the way may only be such a wrapper: an ancestor of this card inside
        // the outer article that is not a card itself and holds no other card. A sibling, an outside element or another card's container ends it.
        if (!owner && !(node !== outerArt && typeof node.contains === 'function' && node.contains(card) && outerArt.contains(node) && !holdsOtherCard(node, card, outerArt))) return null;
        if (node === outerArt) return owner && quotedBy ? owner : null;
        if (node.tagName === 'ARTICLE' || node.tagName === 'BODY' || node.tagName === 'HTML') return null;
        continue;
      }
      const t = f.memoizedProps && f.memoizedProps.tweet;
      const tid = getTweetId(t);
      if (!tid) continue;
      if (!owner) {
        if (!extractMediaFromTweet(t).some((m) => m && String(m.id_str || m.id || '') === mediaId)) return null;
        owner = tid;
        continue;
      }
      if (tid === owner) continue;
      const inner = t.retweeted_status || t.retweeted_status_result?.result || t.legacy?.retweeted_status_result?.result;
      if (quotedIdOf(t) === owner || quotedIdOf(inner) === owner) { quotedBy = true; continue; }
      return null; // another post owns this part of the tree: ambiguous
    }
    return null; // The cap or an incomplete fiber chain leaves ancestors unverified.
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
      let outerArticle = null;
      if (el.closest) {
        outerArticle = el.closest('article[data-testid="tweet"], article[role="article"]') || el.closest('article');
        for (let up = outerArticle?.parentElement && outerArticle.parentElement.closest('article'); up; up = up.parentElement && up.parentElement.closest('article')) {
          outerArticle = up;
        }
      }
      if (isQuoteTweet) {
        candidateContainer = findQuoteContainer(el, outerArticle);
      } else {
        candidateContainer = outerArticle;
      }

      if (candidateContainer) {
        diag.point = 'article';
        if (isQuoteTweet) {
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
        const qContainers = [];
        const legacyQ = art.querySelector ? art.querySelector('[data-testid="quoteTweet"], [role="blockquote"]') : null;
        if (legacyQ) qContainers.push(legacyQ);
        if (art.querySelectorAll) {
          const nestedArts = Array.from(art.querySelectorAll('article')).filter(a => a !== art);
          for (const na of nestedArts) if (!qContainers.includes(na)) qContainers.push(na);
          const roleLinks = Array.from(art.querySelectorAll('div[role="link"]'));
          for (const rl of roleLinks) {
            if (findQuoteContainer(rl, art) === rl && !qContainers.includes(rl)) qContainers.push(rl);
          }
        }
        let matchedQuote = null;
        for (const qContainer of qContainers) {
          const qIds = extractStatusIdsFromContainer(qContainer, true, requestedTweetId);
          const qReactId = getTweetIdFromNode(qContainer, true);
          if (qIds.includes(requestedTweetId) || qReactId === requestedTweetId) {
            matchedQuote = qContainer;
            break;
          }
        }
        if (matchedQuote) {
          postContainer = matchedQuote;
          targetEl = matchedQuote;
          break;
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
      let matchedMedia = null;
      if (cleanPoster) {
        const videos = art.querySelectorAll ? Array.from(art.querySelectorAll('video')) : [];
        for (const videoEl of videos) {
          const vPoster = (videoEl.getAttribute('poster') || videoEl.poster || '').split('?')[0].toLowerCase();
          if (vPoster && (vPoster === cleanPoster || vPoster.includes(cleanPoster) || cleanPoster.includes(vPoster))) {
            matchedInArticle = true;
            matchedMedia = videoEl;
            break;
          }
        }
        if (!matchedInArticle) {
          const imgs = art.querySelectorAll ? Array.from(art.querySelectorAll('img')) : [];
          for (const img of imgs) {
            const iSrc = (img.currentSrc || img.src || '').split('?')[0].toLowerCase();
            if (iSrc && (iSrc === cleanPoster || iSrc.includes(cleanPoster) || cleanPoster.includes(iSrc))) {
              matchedInArticle = true;
              matchedMedia = img;
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
            matchedMedia = mEl;
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
          const qContainer = matchedMedia && findQuoteContainer(matchedMedia, art);
          if (!qContainer) continue;
          postContainer = qContainer;
          targetEl = matchedMedia;
        } else {
          if (matchedMedia && findQuoteContainer(matchedMedia, art)) continue;
          postContainer = art;
          targetEl = matchedMedia || art;
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
    targetTweetId = quoteStatusIds[0] || quoteReactId || null;
    if (!targetTweetId && requestedTweetId) {
      const outerArt = postContainer.closest ? (postContainer.closest('article[data-testid="tweet"], article[role="article"]') || postContainer.closest('article')) : null;
      const outerArtId = outerArt ? (getTweetIdFromNode(outerArt, false) || getAuthoritativeStatusId(outerArt, false, requestedTweetId)) : null;
      if (requestedTweetId !== outerArtId) {
        targetTweetId = requestedTweetId;
      }
    }
    if (!targetTweetId && !requestedTweetId) {
      const outerArt = postContainer.closest ? (postContainer.closest('article[data-testid="tweet"], article[role="article"]') || postContainer.closest('article')) : null;
      targetTweetId = quoteOwnerFromCardFibers(postContainer, outerArt, mediaIdHint ? String(mediaIdHint) : (posterUrl ? extractMediaIdFromUrl(posterUrl) : null));
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

  // BUGFIX-MULTISITE-01: found by status or poster because the point missed (a batch item outside the viewport or under the page's
  // own header), the container's own node carries no post data. Start from the selected item's own media element inside it: the
  // one showing the hinted media id, else (no id) the player at the descriptor's position. Never a nested card's media.
  if (targetEl === postContainer && typeof postContainer.querySelectorAll === 'function') {
    const ownedMedia = Array.from(postContainer.querySelectorAll('video, img')).filter(m => !findQuoteContainer(m, postContainer));
    let item = null;
    if (hintMediaId) {
      item = ownedMedia.find((m) =>
        extractMediaIdFromUrl((m.getAttribute && m.getAttribute('poster')) || m.poster || m.currentSrc || m.src || '') === hintMediaId) || null;
    } else if (typeof mediaIndex === 'number') {
      item = ownedMedia.filter(m => m.tagName === 'VIDEO')[mediaIndex] || null;
    }
    if (item) targetEl = item;
  }

  const domPoster = !posterUrl && postContainer.querySelector ? (postContainer.querySelector('video')?.getAttribute('poster') || postContainer.querySelector('video')?.poster) : null;
  const domMediaId = domPoster ? extractMediaIdFromUrl(domPoster) : null;
  if (domMediaId && !knownMediaIds.includes(domMediaId)) knownMediaIds.push(domMediaId);

  let outerArtBoundary = isQuoteTweet && postContainer.closest ? (postContainer.closest('article[data-testid="tweet"], article[role="article"]') || postContainer.closest('article')) : null;
  for (let up = outerArtBoundary?.parentElement?.closest?.('article'); up; up = up.parentElement?.closest?.('article')) outerArtBoundary = up;
  const walkBoundary = outerArtBoundary || postContainer;

  function getTargetTweet(tweet) {
    const owned = getOwnedTweet(tweet, targetTweetId);
    if (!isQuoteTweet || getTweetId(owned) === targetTweetId) return owned;
    return getOwnedTweet(tweet?.quoted_status || tweet?.quoted_status_result?.result?.legacy || tweet, targetTweetId);
  }

  // Pre-pass: scan from targetEl up to postContainer to record any verified tweet props
  let scanNode = targetEl;
  while (scanNode) {
    const p = getReactProps(scanNode);
    if (p) {
      const t = getTargetTweet(p.tweet);
      const tid = getTweetId(t) || getTweetId(p.tweet);
      if (!targetTweetId || !tid || tid === targetTweetId) {
        recordVerifiedTweet(t);
      }
    }
    const f = getReactFiber(scanNode);
    let sf = f;
    let sDepth = 0;
    while (sf && sDepth < 30) {
      // Bound fiber traversal to walkBoundary
      if (sf.stateNode && typeof sf.stateNode === 'object' && sf.stateNode.nodeType === 1) {
        const node = sf.stateNode;
        if (node.tagName === 'ARTICLE' && node !== walkBoundary && node !== postContainer) break;
        if (node.tagName === 'BODY' || node.tagName === 'HTML') break;
        if (walkBoundary.contains && !walkBoundary.contains(node) && node !== walkBoundary) break;
      }

      if (sf.memoizedProps) {
        const mp = sf.memoizedProps;
        const t = getTargetTweet(mp.tweet);
        const tid = getTweetId(t) || getTweetId(mp.tweet);
        if (targetTweetId && tid && tid !== targetTweetId) {
          break;
        }
        recordVerifiedTweet(t);
      }
      if (sf.stateNode === walkBoundary) break;
      sf = sf.return;
      sDepth++;
    }
    if (scanNode === walkBoundary) break;
    if (scanNode.tagName === 'ARTICLE' && scanNode !== walkBoundary && scanNode !== postContainer) break;
    if (scanNode.tagName === 'BODY' || scanNode.tagName === 'HTML') break;
    scanNode = scanNode.parentElement;
  }

  // 2. Search React fiber & props tree within the walkBoundary
  let curr = targetEl;
  let confirmedHls = false;
  let foundAnyVariants = false;
  let lastVariantError = 'UNSUPPORTED_VARIANTS';

  while (curr) {
    const props = getReactProps(curr);
    if (props) {
      const tweet = getTargetTweet(props.tweet);
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
      // Bound fiber traversal to walkBoundary
      if (f.stateNode && typeof f.stateNode === 'object' && f.stateNode.nodeType === 1) {
        const node = f.stateNode;
        if (node.tagName === 'ARTICLE' && node !== walkBoundary && node !== postContainer) { diag.edge++; break; }
        if (node.tagName === 'BODY' || node.tagName === 'HTML') { diag.edge++; break; }
        if (walkBoundary.contains && !walkBoundary.contains(node) && node !== walkBoundary) { diag.edge++; break; }
      }

      const fProps = f.memoizedProps;
      if (fProps) {
        const fTweet = getTargetTweet(fProps.tweet);
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

      if (f.stateNode === walkBoundary) break;
      f = f.return;
      depth++;
    }

    // Do NOT walk into another post or out of walkBoundary
    if (curr === walkBoundary) break;
    if (curr.tagName === 'ARTICLE' && curr !== walkBoundary && curr !== postContainer) break;
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

function sanitizeXRecoveryDiag(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [key, allowed] of Object.entries(X_RECOVERY_DIAG_ENUMS)) out[key] = allowed.includes(raw[key]) ? raw[key] : '?';
  for (const key of ['quote', 'req']) out[key] = raw[key] === 1 ? 1 : 0;
  for (const key of X_RECOVERY_DIAG_COUNTS) out[key] = Number.isInteger(raw[key]) ? Math.max(0, Math.min(999, raw[key])) : 0;
  return out;
}

/**
 * Recovers the highest-bitrate direct MP4 variant for an ordinary X video player exposing only blob: or manifest.
 * Prioritizes content-script extracted MP4, then executes self-contained inspection in MAIN world.
 * Always attempts MAIN-world lookup for unknown blob players; avoids premature HLS-only rejection.
 */
async function recoverXPostMp4VariantImpl(tabId, mediaDescriptor) {
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
        injectImmediately: true,
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
      console.warn('[MediaLatch] Ошибка выполнения скрипта восстановления MP4 в main world:', e?.message || e);
      return { ok: false, error: 'EXECUTE_SCRIPT_ERROR', detail: 'script-threw' };
    }
  }

  return { ok: false, error: 'NO_MP4_VARIANT_FOUND', detail: 'no-script-api' };
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
