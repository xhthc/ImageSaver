// tools/diagnostics/reddit-inline-diagnostic.js
// Manual read-only diagnostic capture tool for Reddit feed inline controls.
// Paste into Reddit DevTools console after selecting a target element ($0),
// or import in Node.js test harness.
//
// Strictly read-only: does not modify DOM, does not inject extension code,
// does not issue network requests, and does not access cookies/credentials.
// Note: Extension isolated-world state (__riState, background document pinning)
// cannot be inspected from page console context.

(() => {
  'use strict';

  const MAX_SESSION_MS = 30000;      // 30 seconds max observation
  const MAX_LOG_RECORDS = 50;        // Bounded event log size
  const MAX_DOM_DEPTH = 20;          // Bounded ancestor search depth
  const MAX_TRAVERSAL_NODES = 60;    // Bounded selected-owner descendant scan
  const MAX_OBSERVED_ROOTS = 5;      // Max open shadow roots observed

  // Reference thresholds aligned with the RI constants of the Reddit handler in content/content_inline.js
  const RI_CONSTANTS = {
    SIZE: 32,      // Control button size
    CORNER: 3,    // Corner hit-test inset
    MIN_W: 96,    // Minimum media width
    MIN_H: 64,    // Minimum media height
    INSET: 8      // Control mount margin
  };

  /**
   * Strips search query and hash fragment from a URL, preserving only origin and pathname.
   * For relative URLs, strips query and hash directly without prepending foreign origin.
   */
  function redactUrl(urlStr, base = 'https://www.reddit.com') {
    if (!urlStr || typeof urlStr !== 'string') return '';
    const bounded = urlStr.slice(0, 500);
    if (/^https?:\/\//i.test(bounded)) {
      try {
        const u = new URL(bounded);
        return `${u.origin}${u.pathname}`;
      } catch (_) {
        return bounded.split('?')[0].split('#')[0];
      }
    }
    if (bounded.startsWith('/')) {
      try {
        const u = new URL(bounded, base);
        return `${u.origin}${u.pathname}`;
      } catch (_) {
        return bounded.split('?')[0].split('#')[0];
      }
    }
    return bounded.split('?')[0].split('#')[0];
  }

  /**
   * Compact element tag, id, and class descriptor for event logging.
   */
  function tagAndClass(el) {
    if (!el || typeof el !== 'object') return '';
    const tag = (el.tagName || '').toUpperCase();
    const id = typeof el.id === 'string' && el.id.trim() ? `#${el.id.trim().slice(0, 30)}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).map((c) => c.slice(0, 30)).join('.')
      : '';
    return `${tag}${id}${cls}`.slice(0, 80);
  }

  /**
   * Safely reads an element attribute.
   */
  function getAttr(el, name) {
    if (!el || typeof el.getAttribute !== 'function') return null;
    try {
      return el.getAttribute(name);
    } catch (_) {
      return null;
    }
  }

  /**
   * Parses and validates RedGIFs URLs against anchored host and path shapes.
   * Strictly rejects foreign hosts (e.g. evil.example/path/https://redgifs.com/...)
   * Preserves declaration type ('watch' vs 'ifr').
   */
  function parseRedGifsUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    const bounded = urlStr.slice(0, 500);
    let pathname = null;
    let isRedGifsHost = false;

    if (/^https?:\/\//i.test(bounded)) {
      try {
        const u = new URL(bounded);
        const host = u.hostname.toLowerCase();
        if (host === 'redgifs.com' || host.endsWith('.redgifs.com')) {
          isRedGifsHost = true;
          pathname = u.pathname;
        } else {
          return null; // Foreign host rejected
        }
      } catch (_) {
        return null;
      }
    } else if (bounded.startsWith('/')) {
      pathname = bounded.split('?')[0].split('#')[0];
      isRedGifsHost = true;
    } else {
      return null;
    }

    if (!pathname || !isRedGifsHost) return null;
    const m = pathname.match(/^\/(watch|ifr)\/([A-Za-z0-9_-]{3,64})(?:\/|$)/i);
    if (!m) return null;

    return {
      type: m[1].toLowerCase(), // 'watch' or 'ifr'
      clipId: m[2].toLowerCase()
    };
  }

  /**
   * Extracts normalized RedGIFs clip ID from URL strings.
   */
  function extractRedGifsClipId(urlStr) {
    const parsed = parseRedGifsUrl(urlStr);
    return parsed ? parsed.clipId : null;
  }

  /**
   * Extracts iframe src from shreddit-embed[html] attribute without echoing raw HTML.
   */
  function extractIframeSrcFromHtmlAttr(htmlStr) {
    if (!htmlStr || typeof htmlStr !== 'string') return null;
    const bounded = htmlStr.slice(0, 4096);
    let m = bounded.match(/<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']{1,2048})["']/i);
    if (m) return m[1];
    m = bounded.match(/(?:<|&lt;)iframe\b[^>]*?\bsrc\s*=\s*(?:["']|&quot;|&#34;)([^"'\s&]{1,2048})(?:["']|&quot;|&#34;)/i);
    if (m) return m[1];
    return null;
  }

  /**
   * Checks if an element is currently connected to an owner element,
   * crossing open shadow boundaries if needed.
   */
  function isConnectedToOwner(el, owner) {
    if (!el || !owner || typeof el !== 'object') return false;
    if (el === owner) return true;
    let cur = el;
    let depth = 0;
    while (cur && depth < MAX_DOM_DEPTH) {
      if (cur === owner) return true;
      const root = typeof cur.getRootNode === 'function' ? cur.getRootNode() : null;
      if (root && root.host) {
        cur = root.host;
      } else {
        cur = cur.parentElement;
      }
      depth++;
    }
    return false;
  }

  /**
   * Locates the nearest ancestor <shreddit-post>, crossing open shadow boundaries if needed.
   * Returns selection refusal if inside comment, missing, or without shreddit-post owner.
   * Strictly avoids scanning feed for replacement owners.
   */
  function resolveNearestOwner(target) {
    if (!target || typeof target !== 'object') {
      return { ok: false, error: 'NO_SELECTION', message: 'No target element provided or selection is null.' };
    }

    if (typeof target.closest === 'function') {
      const inComment = target.closest('shreddit-comment, [data-testid="comment"], .comment');
      if (inComment) {
        return {
          ok: false,
          error: 'REJECTED_COMMENT_OWNER',
          message: 'Selected element is inside a comment; comment media is excluded from post-level inline controls.'
        };
      }
    }

    let cur = target;
    let post = null;
    let depth = 0;

    while (cur && depth < MAX_DOM_DEPTH) {
      if (typeof cur.closest === 'function') {
        const p = cur.closest('shreddit-post');
        if (p) {
          post = p;
          break;
        }
      }
      const root = typeof cur.getRootNode === 'function' ? cur.getRootNode() : null;
      if (root && root.host) {
        cur = root.host;
      } else {
        cur = cur.parentElement;
      }
      depth++;
    }

    if (!post) {
      return {
        ok: false,
        error: 'NO_SHREDDIT_POST_OWNER',
        message: 'Selected element has no ancestor <shreddit-post>. Feed search is strictly forbidden.'
      };
    }

    const isCrosspost = Boolean(
      (post.parentElement && typeof post.parentElement.closest === 'function' && post.parentElement.closest('shreddit-post')) ||
      (typeof post.closest === 'function' && post.closest('[data-testid="crosspost"], shreddit-crosspost'))
    );

    return { ok: true, post, isCrosspost, target };
  }

  /**
   * Normalizes shreddit-post identity attributes.
   */
  function inspectPostIdentity(post, isCrosspost) {
    let rawId = null;
    let postUrl = null;

    for (const attr of ['id', 'name', 'post-id', 'data-fullname', 'data-post-id']) {
      const val = getAttr(post, attr);
      if (val && typeof val === 'string') {
        const m = val.match(/^(?:t3_)?([a-z0-9]{1,12})$/i);
        if (m) {
          rawId = m[1].toLowerCase();
          break;
        }
      }
    }

    for (const attr of ['permalink', 'content-href', 'data-permalink']) {
      const href = getAttr(post, attr);
      if (href && typeof href === 'string') {
        const m = href.match(/\/comments\/([a-z0-9]{1,12})(?:\/|$)/i);
        if (m) {
          if (!rawId) rawId = m[1].toLowerCase();
          postUrl = redactUrl(href);
          break;
        }
      }
    }

    const contentHref = getAttr(post, 'content-href');
    const contentHrefRedacted = contentHref ? redactUrl(contentHref) : null;

    return {
      id: rawId ? `t3_${rawId}` : null,
      rawId,
      postType: getAttr(post, 'post-type') || null,
      domain: getAttr(post, 'domain') || null,
      isCrosspost,
      contentHrefRedacted,
      postUrlRedacted: postUrl
    };
  }

  /**
   * Bounded traversal of selected owner's DOM tree.
   * Stops immediately at nested posts, comments, or crosspost containers.
   * Collects candidate embeds, iframes, and reachable open shadow roots.
   */
  function findCandidatesInOwner(ownerPost, maxNodes = MAX_TRAVERSAL_NODES) {
    const embeds = [];
    const iframes = [];
    const openShadowRoots = [];
    let nodesVisited = 0;
    let budgetExhausted = false;

    function walk(node) {
      if (nodesVisited >= maxNodes) {
        budgetExhausted = true;
        return;
      }
      if (!node || node.nodeType !== 1) return;
      nodesVisited++;

      if (node !== ownerPost) {
        const tag = (node.tagName || '').toUpperCase();
        // Boundary stop: nested owner or comment container
        if (tag === 'SHREDDIT-POST' || tag === 'SHREDDIT-COMMENT' || tag === 'SHREDDIT-CROSSPOST') {
          return;
        }
        if (typeof node.getAttribute === 'function') {
          const testid = node.getAttribute('data-testid');
          if (testid === 'comment' || testid === 'crosspost') return;
        }
        if (typeof node.className === 'string' && node.className.includes('comment')) {
          return;
        }

        if (tag === 'SHREDDIT-EMBED') embeds.push(node);
        if (tag === 'IFRAME') iframes.push(node);

        // Collect reachable open shadow root
        if (node.shadowRoot && openShadowRoots.length < MAX_OBSERVED_ROOTS) {
          try {
            if (node.shadowRoot.mode === 'open' || !node.shadowRoot.mode) {
              openShadowRoots.push(node.shadowRoot);
            }
          } catch (_) {}
        }
      }

      const children = node.children;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          if (nodesVisited >= maxNodes) {
            budgetExhausted = true;
            break;
          }
          walk(children[i]);
        }
      }
    }

    walk(ownerPost);
    return { embeds, iframes, openShadowRoots, nodesVisited, budgetExhausted };
  }

  /**
   * Inspects RedGIFs embed, reachable iframe, open shadow roots, and clip ID declarations.
   * Restricted strictly to selected owner post; prevents borrowing foreign nested owners.
   */
  function inspectEmbedAndClip(target, post) {
    const candidates = findCandidatesInOwner(post);
    let embedHost = null;
    let isAmbiguous = false;
    let ambiguityReason = null;

    const targetConnected = isConnectedToOwner(target, post);
    const targetIsEmbed = Boolean(target && (target.tagName || '').toUpperCase() === 'SHREDDIT-EMBED');
    const targetUnderEmbed = Boolean(target && typeof target.closest === 'function' && target.closest('shreddit-embed'));
    const targetIsIframe = Boolean(target && (target.tagName || '').toUpperCase() === 'IFRAME');
    const targetWasEmbedMedia = targetIsEmbed || targetUnderEmbed || targetIsIframe;

    // 1. Resolve embed host
    if (targetConnected && targetIsEmbed && candidates.embeds.includes(target)) {
      embedHost = target;
    } else if (targetConnected && targetUnderEmbed) {
      const parentEmbed = target.closest('shreddit-embed');
      if (candidates.embeds.includes(parentEmbed)) {
        embedHost = parentEmbed;
      }
    }

    if (!embedHost) {
      if (candidates.budgetExhausted) {
        // An incomplete scan cannot establish absence or uniqueness
        if (candidates.embeds.length === 1) {
          isAmbiguous = true;
          ambiguityReason = 'INCOMPLETE_SCAN_BUDGET_EXHAUSTED';
        } else if (candidates.embeds.length > 1) {
          isAmbiguous = true;
          ambiguityReason = 'MULTIPLE_EMBEDS_IN_OWNER';
        }
      } else {
        if (candidates.embeds.length === 1) {
          embedHost = candidates.embeds[0];
        } else if (candidates.embeds.length > 1) {
          isAmbiguous = true;
          ambiguityReason = 'MULTIPLE_EMBEDS_IN_OWNER';
        }
      }
    }

    const providerName = embedHost ? getAttr(embedHost, 'providername') : null;
    const rawHtmlAttr = embedHost ? getAttr(embedHost, 'html') : null;
    const hasHtmlAttr = Boolean(rawHtmlAttr);
    const htmlIframeSrcRaw = extractIframeSrcFromHtmlAttr(rawHtmlAttr);
    const htmlIframeSrcRedacted = htmlIframeSrcRaw ? redactUrl(htmlIframeSrcRaw) : null;
    const parsedHtmlClip = parseRedGifsUrl(htmlIframeSrcRaw);
    const clipFromHtmlAttr = parsedHtmlClip ? parsedHtmlClip.clipId : null;

    let traversalBudgetExhausted = candidates.budgetExhausted;

    // 2. Resolve iframe
    let iframeEl = null;
    let reachability = 'none_reachable';

    if (targetConnected && targetIsIframe) {
      const root = typeof target.getRootNode === 'function' ? target.getRootNode() : null;
      const isUnderHost = embedHost && root && root.host === embedHost;
      if (candidates.iframes.includes(target) || isUnderHost) {
        iframeEl = target;
        reachability = isUnderHost ? 'open_shadow' : 'bare_iframe';
      }
    }

    if (!iframeEl && embedHost) {
      // Light DOM children of embedHost (HTMLCollection: bounded indexed iteration capped at MAX_TRAVERSAL_NODES)
      const lightFrames = [];
      const hostChildren = embedHost.children;
      let lightScanExhausted = false;
      if (hostChildren) {
        const limit = Math.min(hostChildren.length, MAX_TRAVERSAL_NODES);
        if (hostChildren.length > MAX_TRAVERSAL_NODES) {
          lightScanExhausted = true;
          traversalBudgetExhausted = true;
        }
        for (let i = 0; i < limit; i++) {
          const c = hostChildren[i];
          if (c && (c.tagName || '').toUpperCase() === 'IFRAME') {
            lightFrames.push(c);
          }
        }
      }
      if (lightScanExhausted) {
        if (lightFrames.length === 0) {
          reachability = 'inconclusive_budget_exhausted';
        } else if (lightFrames.length === 1) {
          isAmbiguous = true;
          ambiguityReason = 'INCOMPLETE_SCAN_BUDGET_EXHAUSTED';
        } else {
          isAmbiguous = true;
          ambiguityReason = 'MULTIPLE_IFRAMES_IN_EMBED';
        }
      } else {
        if (lightFrames.length === 1) {
          iframeEl = lightFrames[0];
          reachability = 'light_dom';
        } else if (lightFrames.length > 1) {
          isAmbiguous = true;
          ambiguityReason = 'MULTIPLE_IFRAMES_IN_EMBED';
        }
      }

      // Open shadow root of embedHost
      if (!iframeEl && embedHost.shadowRoot && !isAmbiguous) {
        try {
          const shadowChildren = embedHost.shadowRoot.children;
          const shadowFrames = [];
          let shadowScanExhausted = false;
          if (shadowChildren) {
            const limit = Math.min(shadowChildren.length, MAX_TRAVERSAL_NODES);
            if (shadowChildren.length > MAX_TRAVERSAL_NODES) {
              shadowScanExhausted = true;
              traversalBudgetExhausted = true;
            }
            for (let i = 0; i < limit; i++) {
              const c = shadowChildren[i];
              if (c && (c.tagName || '').toUpperCase() === 'IFRAME') {
                shadowFrames.push(c);
              }
            }
          }
          if (shadowScanExhausted) {
            if (shadowFrames.length === 0) {
              reachability = 'inconclusive_budget_exhausted';
            } else if (shadowFrames.length === 1) {
              isAmbiguous = true;
              ambiguityReason = 'INCOMPLETE_SCAN_BUDGET_EXHAUSTED';
            } else {
              isAmbiguous = true;
              ambiguityReason = 'MULTIPLE_IFRAMES_IN_SHADOW';
            }
          } else {
            if (shadowFrames.length === 1) {
              iframeEl = shadowFrames[0];
              reachability = 'open_shadow';
            } else if (shadowFrames.length > 1) {
              isAmbiguous = true;
              ambiguityReason = 'MULTIPLE_IFRAMES_IN_SHADOW';
            }
          }
        } catch (_) {
          reachability = 'closed_shadow_inaccessible';
        }
      }
    }

    if (!iframeEl && !embedHost && !isAmbiguous) {
      if (traversalBudgetExhausted) {
        reachability = 'inconclusive_budget_exhausted';
      } else if (candidates.iframes.length === 1) {
        iframeEl = candidates.iframes[0];
        reachability = 'light_dom';
      } else if (candidates.iframes.length > 1) {
        isAmbiguous = true;
        ambiguityReason = 'MULTIPLE_IFRAMES_IN_OWNER';
      }
    }

    let iframeSrcRaw = null;
    let iframeSrcRedacted = null;
    let clipFromIframeSrc = null;
    let parsedIframeClip = null;
    let childDocumentAccess = 'inaccessible_or_absent';

    if (iframeEl) {
      iframeSrcRaw = iframeEl.src || getAttr(iframeEl, 'src') || '';
      iframeSrcRedacted = redactUrl(iframeSrcRaw);
      parsedIframeClip = parseRedGifsUrl(iframeSrcRaw);
      clipFromIframeSrc = parsedIframeClip ? parsedIframeClip.clipId : null;

      try {
        const doc = iframeEl.contentDocument || (iframeEl.contentWindow && iframeEl.contentWindow.document);
        childDocumentAccess = doc ? 'same_origin_accessible' : 'cross_origin_inaccessible';
      } catch (_) {
        childDocumentAccess = 'cross_origin_inaccessible';
      }
    }

    // Clip from post content-href
    const postContentHref = getAttr(post, 'content-href');
    const parsedPostClip = parseRedGifsUrl(postContentHref);
    const clipFromContentHref = parsedPostClip ? parsedPostClip.clipId : null;

    // Agreement evaluation across non-null declared clips
    const declaredClips = [
      { source: 'content-href', id: clipFromContentHref, type: parsedPostClip ? parsedPostClip.type : null },
      { source: 'iframe-src', id: clipFromIframeSrc, type: parsedIframeClip ? parsedIframeClip.type : null },
      { source: 'html-attr', id: clipFromHtmlAttr, type: parsedHtmlClip ? parsedHtmlClip.type : null }
    ].filter((c) => c.id !== null);

    let clipIdsAgree = null;
    let effectiveClipId = null;

    if (declaredClips.length > 0) {
      const distinct = new Set(declaredClips.map((c) => c.id));
      clipIdsAgree = distinct.size === 1;
      if (clipIdsAgree) {
        effectiveClipId = declaredClips[0].id;
      }
    }

    if (embedHost && embedHost.shadowRoot && !candidates.openShadowRoots.includes(embedHost.shadowRoot)) {
      candidates.openShadowRoots.push(embedHost.shadowRoot);
    }
    if (iframeEl && typeof iframeEl.getRootNode === 'function') {
      const r = iframeEl.getRootNode();
      if (r && (r.nodeType === 11 || r instanceof (typeof ShadowRoot !== 'undefined' ? ShadowRoot : Object)) && !candidates.openShadowRoots.includes(r)) {
        candidates.openShadowRoots.push(r);
      }
    }

    const targetDetached = !targetConnected;
    const embedReplaced = Boolean(targetWasEmbedMedia && targetDetached && embedHost);
    const embedRemoved = Boolean(targetWasEmbedMedia && targetDetached && !embedHost);

    return {
      embed: {
        hasEmbedHost: Boolean(embedHost),
        embedTag: embedHost ? embedHost.tagName : null,
        providerName,
        hasHtmlAttr,
        htmlIframeSrcRedacted,
        reachability,
        hasReachableIframe: Boolean(iframeEl),
        iframeSrcRedacted,
        childDocumentAccess,
        isAmbiguous,
        ambiguityReason,
        targetConnected,
        targetDetached,
        embedReplaced,
        embedRemoved,
        traversalBudgetExhausted,
        scanIncomplete: traversalBudgetExhausted,
        absenceInconclusive: Boolean(traversalBudgetExhausted && (!embedHost || !iframeEl)),
        uniquenessInconclusive: Boolean(traversalBudgetExhausted && ((candidates.embeds.length > 0 && target !== embedHost) || isAmbiguous))
      },
      clipIdentity: {
        fromContentHref: clipFromContentHref,
        fromIframeSrc: clipFromIframeSrc,
        fromHtmlAttr: clipFromHtmlAttr,
        clipIdsAgree,
        effectiveClipId
      },
      iframeEl,
      embedHost,
      openShadowRoots: candidates.openShadowRoots,
      traversalBudgetExhausted
    };
  }

  /**
   * Bounded rectangle serialization.
   */
  function serializeRect(r) {
    if (!r || typeof r !== 'object') {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    return {
      left: Math.round(r.left || 0),
      top: Math.round(r.top || 0),
      right: Math.round(r.right || 0),
      bottom: Math.round(r.bottom || 0),
      width: Math.round(r.width || 0),
      height: Math.round(r.height || 0)
    };
  }

  /**
   * Inspects viewport, container/media geometry, clipping ancestors, and corner coverage.
   * Utilizes production RI reference constants (SIZE=32, CORNER=3, MIN_W=96, MIN_H=64).
   */
  function inspectGeometryAndLayout(target, candidateEl, post, win, doc) {
    const viewport = {
      innerWidth: win && typeof win.innerWidth === 'number' ? win.innerWidth : 0,
      innerHeight: win && typeof win.innerHeight === 'number' ? win.innerHeight : 0,
      scrollX: win && typeof win.scrollX === 'number' ? win.scrollX : 0,
      scrollY: win && typeof win.scrollY === 'number' ? win.scrollY : 0
    };

    const targetRect = target && typeof target.getBoundingClientRect === 'function'
      ? serializeRect(target.getBoundingClientRect())
      : null;
    const mediaRect = candidateEl && typeof candidateEl.getBoundingClientRect === 'function'
      ? serializeRect(candidateEl.getBoundingClientRect())
      : targetRect;
    const postRect = post && typeof post.getBoundingClientRect === 'function'
      ? serializeRect(post.getBoundingClientRect())
      : null;

    const clippingAncestors = [];
    let positionContainer = null;
    let cur = candidateEl ? candidateEl.parentElement : (target ? target.parentElement : null);
    let depth = 0;
    const getCS = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle.bind(win) : null;

    while (cur && depth < MAX_DOM_DEPTH) {
      let cs = null;
      if (getCS) {
        try { cs = getCS(cur); } catch (_) {}
      }
      if (cs) {
        const isClipping = ['overflow', 'overflowX', 'overflowY'].some((k) => cs[k] && cs[k] !== 'visible');
        if (isClipping) {
          clippingAncestors.push({
            depth,
            tagName: cur.tagName || '',
            className: typeof cur.className === 'string' ? cur.className.slice(0, 60) : '',
            overflow: cs.overflow || '',
            overflowX: cs.overflowX || '',
            overflowY: cs.overflowY || '',
            rect: typeof cur.getBoundingClientRect === 'function' ? serializeRect(cur.getBoundingClientRect()) : null
          });
        }
        if (!positionContainer && cs.position && cs.position !== 'static') {
          positionContainer = {
            depth,
            tagName: cur.tagName || '',
            className: typeof cur.className === 'string' ? cur.className.slice(0, 60) : '',
            position: cs.position,
            rect: typeof cur.getBoundingClientRect === 'function' ? serializeRect(cur.getBoundingClientRect()) : null
          };
        }
      }
      if (cur === post) break;
      cur = cur.parentElement;
      depth++;
    }

    // Visible intersection
    let L = mediaRect ? mediaRect.left : 0;
    let T = mediaRect ? mediaRect.top : 0;
    let R = mediaRect ? mediaRect.right : 0;
    let B = mediaRect ? mediaRect.bottom : 0;

    for (const anc of clippingAncestors) {
      if (anc.rect) {
        L = Math.max(L, anc.rect.left);
        T = Math.max(T, anc.rect.top);
        R = Math.min(R, anc.rect.right);
        B = Math.min(B, anc.rect.bottom);
      }
    }

    if (postRect) {
      L = Math.max(L, postRect.left);
      T = Math.max(T, postRect.top);
      R = Math.min(R, postRect.right);
      B = Math.min(B, postRect.bottom);
    }

    if (viewport.innerWidth > 0 && viewport.innerHeight > 0) {
      L = Math.max(L, 0);
      T = Math.max(T, 0);
      R = Math.min(R, viewport.innerWidth);
      B = Math.min(B, viewport.innerHeight);
    }

    const visWidth = Math.max(0, R - L);
    const visHeight = Math.max(0, B - T);
    const visibleRect = { left: L, top: T, right: R, bottom: B, width: visWidth, height: visHeight };

    // Corner hit-testing via elementFromPoint using RI_CONSTANTS.CORNER
    const cornerHitTests = {};
    const coveredCorners = [];

    const corners = [
      { name: 'topLeft', x: L + RI_CONSTANTS.CORNER, y: T + RI_CONSTANTS.CORNER },
      { name: 'topRight', x: R - RI_CONSTANTS.CORNER, y: T + RI_CONSTANTS.CORNER },
      { name: 'bottomLeft', x: L + RI_CONSTANTS.CORNER, y: B - RI_CONSTANTS.CORNER },
      { name: 'bottomRight', x: R - RI_CONSTANTS.CORNER, y: B - RI_CONSTANTS.CORNER }
    ];

    for (const c of corners) {
      if (doc && typeof doc.elementFromPoint === 'function' && visWidth >= RI_CONSTANTS.SIZE && visHeight >= RI_CONSTANTS.SIZE) {
        try {
          const hitEl = doc.elementFromPoint(c.x, c.y);
          const isWithinOwner = Boolean(hitEl && (hitEl === post || (typeof post.contains === 'function' && post.contains(hitEl))));
          cornerHitTests[c.name] = {
            x: c.x,
            y: c.y,
            hitTarget: hitEl ? tagAndClass(hitEl) : null,
            isWithinOwner
          };
          if (!isWithinOwner) {
            coveredCorners.push(c.name);
          }
        } catch (_) {
          cornerHitTests[c.name] = { x: c.x, y: c.y, hitTarget: null, isWithinOwner: false, error: 'exception' };
          coveredCorners.push(c.name);
        }
      } else {
        cornerHitTests[c.name] = { x: c.x, y: c.y, hitTarget: null, isWithinOwner: null, note: 'skipped_or_unavailable' };
      }
    }

    const isWhollyOffscreen = visWidth === 0 || visHeight === 0;
    const isPartiallyOffscreen = Boolean(mediaRect && (visWidth < mediaRect.width || visHeight < mediaRect.height));
    const dimensionsSufficient = visWidth >= RI_CONSTANTS.MIN_W && visHeight >= RI_CONSTANTS.MIN_H;

    return {
      viewport,
      referenceConstants: RI_CONSTANTS,
      diagnosticNote: 'Geometry evaluated using production RI thresholds; does not inspect isolated-world extension state.',
      rects: {
        selectedElement: targetRect,
        mediaCandidate: mediaRect,
        postOwner: postRect
      },
      positionContainer,
      clippingAncestors,
      visibleRect,
      cornerHitTests,
      observations: {
        isWhollyOffscreen,
        isPartiallyOffscreen,
        hasClippingAncestor: clippingAncestors.length > 0,
        hasPositionedContainer: Boolean(positionContainer),
        dimensionsSufficient,
        coveredCorners
      }
    };
  }

  /**
   * Creates and starts a bounded 30-second observation session.
   * Tracks open shadow roots, replacement frames, and DOM mutations within selected owner.
   */
  function startObservationSession(target, ownerRes, initialEmbedRes, initialLayoutRes, options = {}) {
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const maxDurationMs = Math.min(options.maxDurationMs || MAX_SESSION_MS, MAX_SESSION_MS);
    const maxEvents = Math.min(options.maxEvents || MAX_LOG_RECORDS, MAX_LOG_RECORDS);

    const post = ownerRes.post;
    const startTime = Date.now();

    const initialPostIdentity = inspectPostIdentity(ownerRes.post, ownerRes.isCrosspost);

    const events = [];
    let isEventsTruncated = false;
    let stopped = false;
    let stopReason = null;
    let timerId = null;
    let hasLoggedFinalReport = false;

    const activeObservers = [];
    const observedRoots = new Set();
    const iframeLoadCleanups = [];

    function pushEvent(evt) {
      if (stopped) return;
      if (events.length >= maxEvents) {
        isEventsTruncated = true;
        return;
      }
      events.push(evt);
    }

    function onPointerOver(e) {
      if (!e || !e.target) return;
      try {
        if (post.contains && post.contains(e.target)) {
          pushEvent({
            t: Date.now() - startTime,
            type: 'pointerenter',
            target: tagAndClass(e.target),
            point: e.clientX !== undefined && e.clientY !== undefined ? { x: Math.round(e.clientX), y: Math.round(e.clientY) } : null
          });
        }
      } catch (_) {}
    }

    function onPointerOut(e) {
      if (!e || !e.target) return;
      try {
        if (post.contains && post.contains(e.target)) {
          const rel = e.relatedTarget;
          if (!rel || (post.contains && !post.contains(rel))) {
            pushEvent({
              t: Date.now() - startTime,
              type: 'pointerleave',
              target: tagAndClass(e.target)
            });
          }
        }
      } catch (_) {}
    }

    function onFocusIn(e) {
      pushEvent({ t: Date.now() - startTime, type: 'focusin', target: tagAndClass(e ? e.target : null) });
    }

    function onFocusOut(e) {
      pushEvent({ t: Date.now() - startTime, type: 'focusout', target: tagAndClass(e ? e.target : null) });
    }

    let hasMissedMutationEvidence = false;

    function attachIframeLoad(el) {
      if (!el || typeof el.addEventListener !== 'function') return false;
      if (iframeLoadCleanups.length >= MAX_OBSERVED_ROOTS) {
        hasMissedMutationEvidence = true;
        return false;
      }
      let frame = null;
      if ((el.tagName || '').toUpperCase() === 'IFRAME') {
        frame = el;
      } else if (typeof el.querySelector === 'function') {
        try { frame = el.querySelector('iframe'); } catch (_) {}
      }
      if (frame && typeof frame.addEventListener === 'function') {
        const handler = () => {
          pushEvent({
            t: Date.now() - startTime,
            type: 'iframe_load',
            target: tagAndClass(frame),
            srcRedacted: redactUrl(frame.src || getAttr(frame, 'src'))
          });
        };
        try {
          frame.addEventListener('load', handler, { once: true });
          iframeLoadCleanups.push(() => {
            try { frame.removeEventListener('load', handler); } catch (_) {}
          });
          return true;
        } catch (_) {}
      }
      return false;
    }

    function handleMutations(mutations) {
      if (stopped || events.length >= maxEvents) {
        isEventsTruncated = true;
        return;
      }
      for (let i = 0; i < mutations.length; i++) {
        if (events.length >= maxEvents) {
          isEventsTruncated = true;
          break;
        }
        const m = mutations[i];
        if (m.type === 'childList') {
          const added = [];
          const removed = [];
          const nodeLimit = MAX_OBSERVED_ROOTS;
          let addedCapped = false;
          let listenersCapped = false;

          const addedNodes = m.addedNodes;
          const addedCount = addedNodes ? (addedNodes.length || 0) : 0;
          if (addedNodes) {
            const processLimit = Math.min(addedCount, nodeLimit);
            if (addedCount > nodeLimit) {
              addedCapped = true;
              hasMissedMutationEvidence = true;
            }
            for (let j = 0; j < processLimit; j++) {
              const n = addedNodes[j];
              if (n && n.nodeType === 1) {
                added.push(tagAndClass(n));
                if (n.shadowRoot && (n.shadowRoot.mode === 'open' || !n.shadowRoot.mode)) {
                  observeRootNode(n.shadowRoot);
                }
                const attached = attachIframeLoad(n);
                if (!attached && iframeLoadCleanups.length >= MAX_OBSERVED_ROOTS) {
                  listenersCapped = true;
                  hasMissedMutationEvidence = true;
                }
              }
            }
          }

          const removedNodes = m.removedNodes;
          const removedCount = removedNodes ? (removedNodes.length || 0) : 0;
          if (removedNodes) {
            const removeLimit = Math.min(removedCount, nodeLimit);
            for (let j = 0; j < removeLimit; j++) {
              const n = removedNodes[j];
              if (n && n.nodeType === 1) removed.push(tagAndClass(n));
            }
          }

          if (added.length || removed.length || addedCapped) {
            pushEvent({
              t: Date.now() - startTime,
              type: 'dom_mutation',
              kind: 'childList',
              target: tagAndClass(m.target),
              added,
              removed,
              addedCount,
              removedCount,
              capped: addedCapped || (removedCount > nodeLimit),
              missedEvidence: addedCapped || listenersCapped
            });
          }
        } else if (m.type === 'attributes') {
          const newVal = getAttr(m.target, m.attributeName);
          const isUrlAttr = m.attributeName === 'content-href' || m.attributeName === 'src';
          pushEvent({
            t: Date.now() - startTime,
            type: 'dom_mutation',
            kind: 'attribute',
            target: tagAndClass(m.target),
            attr: m.attributeName,
            valueRedacted: isUrlAttr ? redactUrl(newVal) : (newVal ? '[present]' : '[null]')
          });
        }
      }
    }

    const MutationObsClass = (win && win.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);

    function observeRootNode(node) {
      if (!node || observedRoots.has(node) || observedRoots.size >= MAX_OBSERVED_ROOTS) return;
      if (!MutationObsClass) return;
      observedRoots.add(node);
      try {
        const obs = new MutationObsClass(handleMutations);
        obs.observe(node, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src', 'currentSrc', 'stream-url', 'html', 'content-href']
        });
        activeObservers.push(obs);
      } catch (_) {}
    }

    // Attach listeners
    if (doc && typeof doc.addEventListener === 'function') {
      try {
        doc.addEventListener('pointerover', onPointerOver, { capture: true, passive: true });
        doc.addEventListener('pointerout', onPointerOut, { capture: true, passive: true });
      } catch (_) {}
    }

    if (post && typeof post.addEventListener === 'function') {
      try {
        post.addEventListener('focusin', onFocusIn, true);
        post.addEventListener('focusout', onFocusOut, true);
      } catch (_) {}
    }

    // Observe post and initial shadow roots
    observeRootNode(post);
    if (initialEmbedRes.openShadowRoots) {
      for (const sr of initialEmbedRes.openShadowRoots) {
        observeRootNode(sr);
      }
    }

    if (initialEmbedRes.iframeEl) {
      attachIframeLoad(initialEmbedRes.iframeEl);
    }

    const setTimer = (win && typeof win.setTimeout === 'function') ? win.setTimeout.bind(win) : setTimeout;
    const clearTimer = (win && typeof win.clearTimeout === 'function') ? win.clearTimeout.bind(win) : clearTimeout;

    function cleanupListeners() {
      if (doc && typeof doc.removeEventListener === 'function') {
        try {
          doc.removeEventListener('pointerover', onPointerOver, { capture: true, passive: true });
          doc.removeEventListener('pointerout', onPointerOut, { capture: true, passive: true });
        } catch (_) {}
      }
      if (post && typeof post.removeEventListener === 'function') {
        try {
          post.removeEventListener('focusin', onFocusIn, true);
          post.removeEventListener('focusout', onFocusOut, true);
        } catch (_) {}
      }
      for (const obs of activeObservers) {
        try { obs.disconnect(); } catch (_) {}
      }
      activeObservers.length = 0;
      observedRoots.clear();

      for (const cleanup of iframeLoadCleanups) {
        try { cleanup(); } catch (_) {}
      }
      iframeLoadCleanups.length = 0;

      if (timerId) {
        clearTimer(timerId);
        timerId = null;
      }
    }

    function takeCoherentSnapshot() {
      const curPost = inspectPostIdentity(post, ownerRes.isCrosspost);
      const curEmbedRes = inspectEmbedAndClip(target, post);
      const curCandidate = curEmbedRes.embedHost || curEmbedRes.iframeEl || (isConnectedToOwner(target, post) ? target : null);
      const curLayout = inspectGeometryAndLayout(target, curCandidate, post, win, doc);

      return {
        post: curPost,
        embed: curEmbedRes.embed,
        clipIdentity: curEmbedRes.clipIdentity,
        layout: curLayout,
        traversalBudgetExhausted: curEmbedRes.traversalBudgetExhausted
      };
    }

    function buildFinalReport() {
      const finalSnapshot = takeCoherentSnapshot();
      const initialSnapshot = {
        post: initialPostIdentity,
        embed: initialEmbedRes.embed,
        clipIdentity: initialEmbedRes.clipIdentity,
        layout: initialLayoutRes,
        traversalBudgetExhausted: initialEmbedRes.traversalBudgetExhausted
      };

      const postHrefChanged = initialSnapshot.post.contentHrefRedacted !== finalSnapshot.post.contentHrefRedacted;
      const iframeSrcChanged = initialSnapshot.embed.iframeSrcRedacted !== finalSnapshot.embed.iframeSrcRedacted;
      const clipIdChanged = initialSnapshot.clipIdentity.effectiveClipId !== finalSnapshot.clipIdentity.effectiveClipId;
      const stateMutated = postHrefChanged || iframeSrcChanged || clipIdChanged ||
        Boolean(finalSnapshot.embed.embedReplaced) || Boolean(finalSnapshot.embed.embedRemoved);

      return {
        ok: true,
        tool: 'reddit-inline-diagnostic',
        timestamp: new Date(startTime).toISOString(),
        isolatedWorldNotice: 'Extension internal state (__riState, background document pinning) is in isolated world and not accessible from page console. This capture reports observable DOM/CSS/events only.',
        post: finalSnapshot.post,
        selectedElement: {
          tagName: target.tagName || null,
          descriptor: tagAndClass(target),
          isConnected: isConnectedToOwner(target, post)
        },
        embed: finalSnapshot.embed,
        clipIdentity: finalSnapshot.clipIdentity,
        layout: finalSnapshot.layout,
        initial: initialSnapshot,
        final: finalSnapshot,
        traversalBudgetExhausted: finalSnapshot.embed.traversalBudgetExhausted,
        stateChange: {
          stateMutated,
          postHrefChanged,
          iframeSrcChanged,
          clipIdChanged,
          embedReplaced: Boolean(finalSnapshot.embed.embedReplaced),
          embedRemoved: Boolean(finalSnapshot.embed.embedRemoved),
          targetDetached: Boolean(finalSnapshot.embed.targetDetached)
        },
        observation: {
          status: stopped ? 'completed' : 'running',
          stopReason: stopReason || (stopped ? 'MANUAL_STOP' : null),
          durationMs: Date.now() - startTime,
          maxDurationMs,
          events,
          isEventsTruncated,
          traversalBudgetExhausted: finalSnapshot.embed.traversalBudgetExhausted,
          missedEvidence: Boolean(isEventsTruncated || hasMissedMutationEvidence)
        }
      };
    }

    function emitReportLog(report) {
      if (hasLoggedFinalReport) return;
      hasLoggedFinalReport = true;
      const logFn = (win && win.console && typeof win.console.log === 'function')
        ? win.console.log.bind(win.console)
        : (typeof console !== 'undefined' ? console.log : null);
      if (options.autoLog !== false && logFn) {
        logFn('[Reddit Inline Diagnostic] Completed Report:');
        logFn(JSON.stringify(report, null, 2));
      }
    }

    function stop(reason = 'MANUAL_STOP') {
      if (stopped) return buildFinalReport();
      stopped = true;
      stopReason = reason;
      cleanupListeners();
      const report = buildFinalReport();
      emitReportLog(report);
      if (typeof options.onStop === 'function') {
        try { options.onStop(report); } catch (_) {}
      }
      return report;
    }

    timerId = setTimer(() => {
      stop('TIMEOUT_30S');
    }, maxDurationMs);

    return {
      getReport: buildFinalReport,
      stop,
      isStopped: () => stopped
    };
  }

  /**
   * Top-level entry point to run diagnostic capture on an element.
   */
  function runRedditInlineDiagnostic(targetElement, options = {}) {
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    const doc = options.document || (typeof document !== 'undefined' ? document : null);

    const ownerRes = resolveNearestOwner(targetElement);
    if (!ownerRes.ok) {
      return {
        ok: false,
        error: ownerRes.error,
        message: ownerRes.message,
        isolatedWorldNotice: 'Extension internal state (__riState) is in isolated world and not accessible from page console.',
        stop: () => ({ ok: false, error: ownerRes.error, message: ownerRes.message }),
        getReport: () => ({ ok: false, error: ownerRes.error, message: ownerRes.message }),
        isStopped: () => true
      };
    }

    const initialEmbedRes = inspectEmbedAndClip(targetElement, ownerRes.post);
    const initialCandidateEl = initialEmbedRes.embedHost || initialEmbedRes.iframeEl || targetElement;
    const initialLayoutRes = inspectGeometryAndLayout(targetElement, initialCandidateEl, ownerRes.post, win, doc);

    const session = startObservationSession(targetElement, ownerRes, initialEmbedRes, initialLayoutRes, options);

    if (options.autoLog !== false && typeof console !== 'undefined' && console.log) {
      const postId = ownerRes.post.id || getAttr(ownerRes.post, 'id') || 'unknown';
      console.log(`[Reddit Inline Diagnostic] Started 30s observation on post ${postId} ($0=${tagAndClass(targetElement)})`);
      console.log(`[Reddit Inline Diagnostic] Clip: ${initialEmbedRes.clipIdentity.effectiveClipId || 'unresolved'} | Agree: ${initialEmbedRes.clipIdentity.clipIdsAgree} | Iframe: ${initialEmbedRes.embed.reachability}`);
      console.log(`[Reddit Inline Diagnostic] Run window.__redditInlineDiagnostic.stop() to finish early and dump full report.`);
    }

    return session;
  }

  let activeSession = null;

  const controller = {
    start: (targetElement, options = {}) => {
      if (activeSession && !activeSession.isStopped()) {
        activeSession.stop('NEW_SESSION_STARTED');
      }
      activeSession = runRedditInlineDiagnostic(targetElement, options);
      return activeSession;
    },
    stop: () => {
      if (!activeSession) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[Reddit Inline Diagnostic] No active observation session running.');
        }
        return null;
      }
      return activeSession.stop('MANUAL_STOP');
    },
    getReport: () => (activeSession ? activeSession.getReport() : null),
    redactUrl,
    parseRedGifsUrl,
    extractRedGifsClipId,
    extractIframeSrcFromHtmlAttr,
    resolveNearestOwner,
    isConnectedToOwner,
    inspectPostIdentity,
    inspectEmbedAndClip,
    inspectGeometryAndLayout
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      runRedditInlineDiagnostic,
      controller,
      redactUrl,
      parseRedGifsUrl,
      extractRedGifsClipId,
      extractIframeSrcFromHtmlAttr,
      resolveNearestOwner,
      isConnectedToOwner,
      inspectPostIdentity,
      inspectEmbedAndClip,
      inspectGeometryAndLayout,
      tagAndClass,
      RI_CONSTANTS
    };
  }

  if (typeof window !== 'undefined') {
    window.__redditInlineDiagnostic = controller;

    if (typeof module === 'undefined') {
      let consoleTarget = null;
      try {
        if (typeof $0 !== 'undefined' && $0) consoleTarget = $0;
      } catch (_) {}
      if (!consoleTarget && window.$0) consoleTarget = window.$0;

      if (consoleTarget) {
        controller.start(consoleTarget);
      } else if (typeof console !== 'undefined' && console.log) {
        console.log('[Reddit Inline Diagnostic] Loaded. Select a failing post or media element in Elements panel ($0), then run: __redditInlineDiagnostic.start($0)');
      }
    }
  }
})();
