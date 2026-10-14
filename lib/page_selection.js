// Classic worker module; loaded by background.js after lib/booru_resolvers.js, in this code's original position.
// Functions injected into the clicked frame (owner admission, context target, DOM image metadata) and their worker-side callers.
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
 * when it was on a CSS background or under a simple overlay. content/content_context_target.js records it at the gesture
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
 * its claim is stale and is 'refused'. Local DOM reads only: no network, no messages. A proven claim's proof token is handed to
 * the admission hook below: a later author question (content_reddit.js) answers only what was frozen for this very admission.
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
    // the admission point: a provider script of this same isolated world may freeze what it proves about the selection now (content_reddit.js:
    // the owning post's author under this proof), so later scrolling or recycling of the page cannot change it
    if (claim && typeof claim.proof === 'string' && claim.proof && typeof globalThis.__imageSaverAdmitRedditAuthor === 'function') {
      globalThis.__imageSaverAdmitRedditAuthor(claim.proof, el, mediaEl);
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
      injectImmediately: true,
      func: verifyContextOwner,
      args: [claim]
    });
    const res = results && results[0] && results[0].result;
    // the document that admitted the claim: a later question about this selection (selectedAuthorFolder) is pinned to it
    if (claim && results && results[0] && typeof results[0].documentId === 'string') claim.documentId = results[0].documentId;
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
      injectImmediately: true,
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
    // content/content_context_target.js (:hover is already gone when the native menu item is clicked). It counts only while
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

    // An image's surrounding decoration is not evidence of its original asset.
    const bgImages = targetElement && !targetImg ? collectBackgrounds(targetElement) : [];

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
