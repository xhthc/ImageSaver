// content_reddit.js - Reddit DOM detection and post metadata extraction for MediaLatch
(() => {
  const isI18n = globalThis.ImageSaverI18n;
  const isLabels = isI18n && typeof chrome !== 'undefined' ? isI18n.follow(chrome, typeof navigator !== 'undefined' ? navigator : null, () => {}) : null;
  const isLabel = (element, field, key, fallback, vars) => {
    if (isLabels) isLabels.label(element, field, key, vars, fallback);
    else if (field === 'textContent') element.textContent = fallback;
    else if (fallback === null) element.removeAttribute(field);
    else element.setAttribute(field, fallback);
  };
  let lastContextmenuTarget = null;
  let lastContextmenuPath = [];
  let lastContextmenuTime = 0;
  let lastContextmenuPoint = null; // { x, y } of the latest real gesture; null when unknown
  let lastDetectedMedia = null;

  /**
   * Deterministic validator for Reddit animated GIFs delivered as MP4.
   * Scoped strictly to Reddit preview/media domains with .gif and format=mp4.
   */
  function isRedditAnimationUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const parsed = new URL(urlStr, typeof window !== 'undefined' && window.location ? window.location.href : 'https://reddit.com/');
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      const isReddit = host === 'preview.redd.it' || host === 'external-preview.redd.it' ||
                       host === 'reddit.com' || host.endsWith('.reddit.com') || host.endsWith('.redd.it');
      if (!isReddit) return false;
      if (!pathname.includes('.gif')) return false;
      const format = (parsed.searchParams.get('format') || '').toLowerCase().trim();
      return format === 'mp4' || format === 'video/mp4';
    } catch (_) {
      return false;
    }
  }

  /**
   * Deterministic validator for Reddit native GIF images.
   * Matches .gif on Reddit image/preview domains without format=mp4.
   */
  function isRedditNativeGifUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const parsed = new URL(urlStr, typeof window !== 'undefined' && window.location ? window.location.href : 'https://reddit.com/');
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      const isReddit = host === 'i.redd.it' || host === 'preview.redd.it' || host === 'external-preview.redd.it' ||
                       host === 'reddit.com' || host.endsWith('.reddit.com') || host.endsWith('.redd.it');
      if (!isReddit) return false;
      if (!pathname.endsWith('.gif') && !pathname.includes('.gif')) return false;
      const format = (parsed.searchParams.get('format') || '').toLowerCase().trim();
      return format !== 'mp4' && format !== 'video/mp4';
    } catch (_) {
      return false;
    }
  }

  /**
   * A playlist is a manifest by its PATH (a path segment ending .mpd or .m3u8), never by a query value: a direct file such as
   * https://packaged-media.redd.it/<id>/pb/<file>.mp4?m=DASHPlaylist.mpd names the manifest only as a parameter and is still the direct file.
   * An address that cannot be parsed keeps the conservative whole-string test (refused when it mentions a manifest anywhere).
   */
  function manifestKindOfAddress(urlStr) {
    if (typeof urlStr !== 'string') return '';
    let path;
    try {
      path = new URL(urlStr, 'https://www.reddit.com/').pathname.toLowerCase();
    } catch (_) {
      const whole = urlStr.toLowerCase();
      return whole.includes('.mpd') ? 'dash' : (whole.includes('.m3u8') ? 'hls' : '');
    }
    if (/\.mpd(?:\/|$)/.test(path)) return 'dash';
    if (/\.m3u8(?:\/|$)/.test(path)) return 'hls';
    return '';
  }
  function isManifestAddress(urlStr) {
    return manifestKindOfAddress(urlStr) !== '';
  }

  // The stream a <shreddit-player> declares itself (its own stream-url or src attribute): the manifest kind and the address as declared. Only the
  // canonical Reddit HLS master (https://v.redd.it/<asset>/HLSPlaylist.m3u8) is a stream this extension can save; the background validates it again.
  const REDDIT_HLS_MASTER = /^https:\/\/v\.redd\.it\/[A-Za-z0-9_-]{1,64}\/HLSPlaylist\.m3u8(?:\?[^#]*)?$/;
  function declaredStreamOf(player) {
    if (!player || typeof player.getAttribute !== 'function') return null;
    for (const attr of ['stream-url', 'src']) {
      const url = String(player.getAttribute(attr) || '');
      const kind = url.length <= 2048 ? manifestKindOfAddress(url) : '';
      if (kind) return { kind, url, saveable: kind === 'hls' && REDDIT_HLS_MASTER.test(url) };
    }
    return null;
  }

  /**
   * A scrub-preview <video> (observed on a signed-out www.reddit.com post, 2026-10-07: a <video src=".../CMAF_96.mp4"> inside <shreddit-preview-video-lazy>
   * under <shreddit-progress-bar>) is a low-resolution thumbnail of the post's video, never the video: an address that merely ends in .mp4 does not
   * promote it. The player's main video is the first <video> of its root that is not such a preview, whatever the order of the controls.
   */
  const PREVIEW_VIDEO_HOSTS = 'shreddit-preview-video-lazy, shreddit-progress-bar';
  const PREVIEW_VIDEO_TAGS = ['SHREDDIT-PREVIEW-VIDEO-LAZY', 'SHREDDIT-PROGRESS-BAR'];
  // `path` (a composed path, innermost first) also names hosts above a shadow boundary that closest() does not cross
  function isPreviewVideo(video, path = null) {
    if (!video) return false;
    if (typeof video.closest === 'function' && video.closest(PREVIEW_VIDEO_HOSTS)) return true;
    const at = Array.isArray(path) ? path.indexOf(video) : -1;
    return at >= 0 && path.slice(at + 1).some((el) => el && PREVIEW_VIDEO_TAGS.includes(String(el.tagName).toUpperCase()));
  }
  function firstMainVideo(root) {
    const all = root && typeof root.querySelectorAll === 'function' ? Array.from(root.querySelectorAll('video') || []) : [];
    return all.find((v) => !isPreviewVideo(v)) || null;
  }

  /**
   * Inspects a DOM element or candidate URL to resolve media type and source details.
   * Preserves DOM video semantics for blob sources (type: 'video').
   */
  function resolveRedditMediaDescriptor(rawUrl, domElement = null, postUrl = null) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const url = rawUrl.trim();
    if (!url || url.startsWith('javascript:') || url.startsWith('data:')) return null;

    const domTag = domElement?.tagName ? domElement.tagName.toLowerCase() : '';
    const isVideoElement = domTag === 'video' || domTag === 'shreddit-player' ||
                           Boolean(domElement?.closest?.('video, shreddit-player'));

    let type = 'image';
    let sourceType = 'image';

    if (isRedditAnimationUrl(url)) {
      type = 'reddit_gif';
      sourceType = 'reddit_gif';
    } else if (url.includes('packaged-media.redd.it')) {
      type = 'video';
      sourceType = 'packaged_media';
    } else if (url.includes('v.redd.it') || /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(url)) {
      type = 'video';
      sourceType = 'video';
    } else if (/\.gif(\?.*)?$/i.test(url)) {
      type = 'gif';
      sourceType = 'native_gif';
    } else if (url.startsWith('blob:')) {
      if (isVideoElement) {
        type = 'video';
        sourceType = 'blob_video';
      } else {
        type = 'image';
        sourceType = 'image';
      }
    } else if (isVideoElement) {
      type = 'video';
      sourceType = 'video';
    }

    return {
      type,
      sourceType,
      url,
      postUrl: postUrl || null,
      elementTag: domTag || null
    };
  }

  /**
   * The direct MP4 that THIS player declares in its own `packaged-media-json` attribute (observed on www.reddit.com: the player's `src` is an
   * HLS playlist, its inner <video> has no source until it plays or holds a blob: MediaSource, and the only direct files are listed here as
   * `{ playbackMp4s: { permutations: [{ source: { url, dimensions, videoCodec } }] } }`). Strict and bounded: the attribute is capped,
   * only https packaged-media.redd.it / v.redd.it .mp4 addresses count (never a manifest, a page or a foreign host), every counted address
   * must carry one asset id (the player's own id when its src/stream-url/preview names one), only H264 is taken and the largest picture wins.
   * Nothing is requested and no address is guessed: an absent, malformed or ambiguous declaration is null.
   * The selection (an address or null) is a pure function of the attribute and of the ids it is bound to, memoised per player so that the
   * attribute is parsed once while it stays the same; the descriptor and the source proof of the click (riSrcOf) both read it.
   */
  const packagedPick = new WeakMap();
  function pickPackagedMp4(player) {
    const raw = player.getAttribute?.('packaged-media-json');
    if (!raw || typeof raw !== 'string' || raw.length > 65536) return null;
    const ids = ['stream-url', 'src', 'preview'].map((a) => String(player.getAttribute?.(a) || '')).join('\n');
    const memo = packagedPick.get(player);
    if (memo && memo.raw === raw && memo.ids === ids) return memo.url;
    const url = selectPackagedMp4(player, raw);
    packagedPick.set(player, { raw, ids, url });
    return url;
  }

  function selectPackagedMp4(player, raw) {
    let perms = null;
    try { perms = JSON.parse(raw)?.playbackMp4s?.permutations; } catch (_) { return null; }
    if (!Array.isArray(perms) || perms.length === 0 || perms.length > 32) return null;
    let own = null;
    for (const a of ['stream-url', 'src', 'preview']) {
      const m = String(player.getAttribute?.(a) || '').match(/^https:\/\/v\.redd\.it\/([a-zA-Z0-9_-]+)\//i);
      if (m) { own = m[1]; break; }
    }
    let best = null;
    let id = null;
    for (const p of perms) {
      const s = p && typeof p === 'object' ? p.source : null;
      const url = s && typeof s.url === 'string' && s.url.length <= 2048 ? s.url : '';
      const m = url.match(/^https:\/\/(?:packaged-media|v)\.redd\.it\/([a-zA-Z0-9_-]+)\/[^?#]*\.mp4(?:[?#]|$)/i);
      if (!m || s.videoCodec !== 'H264') continue;
      if (id !== null && m[1] !== id) return null;
      id = m[1];
      const w = s.dimensions && Number.isInteger(s.dimensions.width) ? s.dimensions.width : 0;
      const h = s.dimensions && Number.isInteger(s.dimensions.height) ? s.dimensions.height : 0;
      if (w < 1 || h < 1 || w > 16384 || h > 16384) continue;
      if (!best || w * h > best.area) best = { url, area: w * h };
    }
    if (!best || (own !== null && own !== id)) return null;
    return best.url;
  }

  function extractPackagedMp4FromPlayer(player, postUrl) {
    const url = pickPackagedMp4(player);
    return url ? resolveRedditMediaDescriptor(url, player, postUrl) : null;
  }

  // A confirmed Reddit animation that a player holds directly: a preview .gif with format=mp4 (the scoped classification of isRedditAnimationUrl)
  // on an anchored https preview/i.redd.it host, no credentials. It is the same address the image path converts; never a poster, never guessed.
  const PLAYER_ANIMATION_HOSTS = ['preview.redd.it', 'external-preview.redd.it', 'i.redd.it'];
  function isPlayerAnimationSource(u) {
    if (typeof u !== 'string' || u.length > 2048 || !isRedditAnimationUrl(u)) return false;
    try {
      const p = new URL(u);
      return p.protocol === 'https:' && PLAYER_ANIMATION_HOSTS.includes(p.hostname.toLowerCase()) && !p.username && !p.password;
    } catch (_) {
      return false;
    }
  }

  /**
   * Extracts direct non-blob MP4 candidates from Shreddit player attributes or open shadowRoot.
   */
  function extractDirectCandidateFromPlayer(player, postUrl) {
    if (!player || player.isConnected === false) return null;

    // 1. Direct src attribute on <shreddit-player>
    const pSrc = player.getAttribute?.('src') || player.src;
    if (pSrc && typeof pSrc === 'string' && !pSrc.startsWith('blob:')) {
      if (pSrc.includes('packaged-media.redd.it') || pSrc.includes('v.redd.it') || /\.(mp4|webm)(\?.*)?$/i.test(pSrc) || isPlayerAnimationSource(pSrc)) {
        if (!isManifestAddress(pSrc)) {
          return resolveRedditMediaDescriptor(pSrc, player, postUrl);
        }
      }
    }

    // 2. stream-url attribute
    const streamUrl = player.getAttribute?.('stream-url');
    if (streamUrl && typeof streamUrl === 'string' && !streamUrl.startsWith('blob:')) {
      if (streamUrl.includes('packaged-media.redd.it') || (streamUrl.includes('v.redd.it') && streamUrl.includes('.mp4')) || isPlayerAnimationSource(streamUrl)) {
        if (!isManifestAddress(streamUrl)) {
          return resolveRedditMediaDescriptor(streamUrl, player, postUrl);
        }
      }
    }

    // 3. Inspect open shadowRoot
    if (player.shadowRoot) {
      const shadowVideo = firstMainVideo(player.shadowRoot);
      if (shadowVideo && shadowVideo.isConnected !== false) {
        const sources = Array.from(shadowVideo.querySelectorAll?.('source') || []).slice(0, 8);
        for (const s of sources) {
          const sSrc = s.src || s.getAttribute?.('src');
          if (sSrc && typeof sSrc === 'string' && !sSrc.startsWith('blob:')) {
            if (sSrc.includes('packaged-media.redd.it') || sSrc.includes('v.redd.it') || /\.(mp4|webm)(\?.*)?$/i.test(sSrc) || isPlayerAnimationSource(sSrc)) {
              if (!isManifestAddress(sSrc)) {
                return resolveRedditMediaDescriptor(sSrc, shadowVideo, postUrl);
              }
            }
          }
        }
        const vSrc = shadowVideo.currentSrc || shadowVideo.src;
        if (vSrc && typeof vSrc === 'string' && !vSrc.startsWith('blob:')) {
          if (vSrc.includes('packaged-media.redd.it') || vSrc.includes('v.redd.it') || /\.(mp4|webm)(\?.*)?$/i.test(vSrc) || isPlayerAnimationSource(vSrc)) {
            if (!isManifestAddress(vSrc)) {
              return resolveRedditMediaDescriptor(vSrc, shadowVideo, postUrl);
            }
          }
        }
      }
    }

    // 4. What the player itself declares, when nothing is playing yet or the inner <video> is a blob: MediaSource
    return extractPackagedMp4FromPlayer(player, postUrl);
  }

  /**
   * Identifies all logical video players and standalone video elements in a post.
   * A <video> inside a <shreddit-player> (in light DOM or shadowRoot) belongs to that player.
   * Standalone <video> elements outside any <shreddit-player> are distinct logical items.
   */
  function getPostLogicalVideoItems(post) {
    if (!post || typeof post.querySelectorAll !== 'function') {
      return { players: [], standaloneVideos: [], totalCount: 0 };
    }
    const players = Array.from(post.querySelectorAll('shreddit-player') || []);
    const allVideos = Array.from(post.querySelectorAll('video') || []);
    const standaloneVideos = allVideos.filter(v => {
      if (typeof v.closest === 'function' && v.closest('shreddit-player')) {
        return false;
      }
      for (const p of players) {
        if (p === v) return false;
        if (typeof p.contains === 'function' && p.contains(v)) return false;
        if (p.shadowRoot && typeof p.shadowRoot.contains === 'function' && p.shadowRoot.contains(v)) return false;
      }
      if (v.parentElement && (v.parentElement.tagName || '').toLowerCase() === 'shreddit-player') {
        return false;
      }
      return true;
    });

    return {
      players,
      standaloneVideos,
      totalCount: players.length + standaloneVideos.length
    };
  }

  /**
   * Extracts direct non-blob MP4 candidates from post container attributes or child players.
   * Strictly verifies single-player ownership: if a post contains multiple players or videos,
   * post-level queries are ambiguous and return null to prevent cross-player media theft.
   */
  function extractDirectCandidateFromPost(post, postUrl, target = null) {
    if (!post || post.isConnected === false) return null;

    const { players, standaloneVideos, totalCount } = getPostLogicalVideoItems(post);
    if (totalCount !== 1) {
      // Multiple logical video items or 0: ambiguous ownership from post-level query
      return null;
    }

    if (players.length === 1 && players[0].isConnected !== false) {
      // If a target was provided and is a standalone video outside players[0], fail closed
      if (target) {
        const isTargetInPlayer = (typeof target.closest === 'function' && target.closest('shreddit-player') === players[0]) ||
                                 (typeof players[0].contains === 'function' && players[0].contains(target));
        if (!isTargetInPlayer && (target.tagName || '').toLowerCase() === 'video') {
          return null;
        }
      }
      const candidate = extractDirectCandidateFromPlayer(players[0], postUrl);
      if (candidate) return candidate;
    } else if (standaloneVideos.length === 1 && standaloneVideos[0].isConnected !== false) {
      const vid = standaloneVideos[0];
      const vSrc = vid.currentSrc || vid.src || vid.querySelector?.('source')?.src || vid.getAttribute?.('src');
      if (vSrc && typeof vSrc === 'string' && !vSrc.startsWith('blob:')) {
        if (vSrc.includes('packaged-media.redd.it') || vSrc.includes('v.redd.it') || /\.(mp4|webm)(\?.*)?$/i.test(vSrc)) {
          if (!isManifestAddress(vSrc)) {
            return resolveRedditMediaDescriptor(vSrc, vid, postUrl);
          }
        }
      }
    }

    const mp4Url = post.getAttribute?.('data-mp4-url') || post.getAttribute?.('mp4-url');
    if (mp4Url && typeof mp4Url === 'string' && !mp4Url.startsWith('blob:')) {
      if (mp4Url.includes('packaged-media.redd.it') || mp4Url.includes('v.redd.it') || /\.(mp4|webm)(\?.*)?$/i.test(mp4Url)) {
        if (!isManifestAddress(mp4Url)) {
          return resolveRedditMediaDescriptor(mp4Url, post, postUrl);
        }
      }
    }

    return null;
  }

  /**
   * Searches for a direct non-blob MP4 associated with a blob video target.
   * Strictly binds recovery to the clicked player and its current source.
   * Never falls back to sibling or adjacent players within the same post.
   */
  function findRedditDirectMediaForBlob(target, path = [], blobUrl = '') {
    if (target && target.isConnected === false) return null;
    const postUrl = extractRedditPostUrl({ target, composedPath: path });

    // 1. Identify specific clicked player
    let clickedPlayer = null;
    if (target && typeof target.closest === 'function') {
      clickedPlayer = target.closest('shreddit-player');
    }
    if (!clickedPlayer && Array.isArray(path)) {
      clickedPlayer = path.find(el => el && (el.tagName || '').toLowerCase() === 'shreddit-player') || null;
    }

    if (clickedPlayer && clickedPlayer.isConnected !== false) {
      // Bind recovery strictly to THIS clicked player
      const candidate = extractDirectCandidateFromPlayer(clickedPlayer, postUrl);
      if (candidate) return candidate;

      // Check enclosing post attributes ONLY if this is the sole logical video item in the post
      const owningPost = clickedPlayer.closest?.('shreddit-post') ||
        (Array.isArray(path) ? path.find(el => el && (el.tagName || '').toLowerCase() === 'shreddit-post') : null);
      if (owningPost && owningPost.isConnected !== false) {
        const { totalCount } = getPostLogicalVideoItems(owningPost);
        if (totalCount === 1) {
          const mp4Url = owningPost.getAttribute?.('data-mp4-url') || owningPost.getAttribute?.('mp4-url');
          if (mp4Url && typeof mp4Url === 'string' && !mp4Url.startsWith('blob:')) {
            if (mp4Url.includes('packaged-media.redd.it') || mp4Url.includes('v.redd.it') || /\.(mp4|webm)(\?.*)?$/i.test(mp4Url)) {
              if (!isManifestAddress(mp4Url)) {
                return resolveRedditMediaDescriptor(mp4Url, owningPost, postUrl);
              }
            }
          }
        }
      }

      // Clicked player has no direct candidate and post is ambiguous or has no direct candidate
      return null;
    }

    // 2. Target is not inside a shreddit-player: check if target is a standalone video
    let clickedVideo = null;
    if (target && (target.tagName || '').toLowerCase() === 'video') {
      clickedVideo = target;
    } else if (target && typeof target.closest === 'function') {
      clickedVideo = target.closest('video');
    }
    if (!clickedVideo && Array.isArray(path)) {
      clickedVideo = path.find(el => el && (el.tagName || '').toLowerCase() === 'video') || null;
    }
    // a scrub preview is not the post's video
    if (clickedVideo && isPreviewVideo(clickedVideo, path)) return null;

    if (clickedVideo && clickedVideo.isConnected !== false) {
      // Check if clicked native video itself has direct non-blob media (e.g. child source or direct src)
      const vSrc = clickedVideo.currentSrc || clickedVideo.src || clickedVideo.querySelector?.('source')?.src || clickedVideo.getAttribute?.('src');
      if (vSrc && typeof vSrc === 'string' && !vSrc.startsWith('blob:')) {
        if (vSrc.includes('packaged-media.redd.it') || vSrc.includes('v.redd.it') || /\.(mp4|webm)(\?.*)?$/i.test(vSrc)) {
          if (!isManifestAddress(vSrc)) {
            return resolveRedditMediaDescriptor(vSrc, clickedVideo, postUrl);
          }
        }
      }

      // Check enclosing post attributes ONLY if this standalone video is the sole video item in the post and NO shreddit-players exist
      const owningPost = clickedVideo.closest?.('shreddit-post') ||
        (Array.isArray(path) ? path.find(el => el && (el.tagName || '').toLowerCase() === 'shreddit-post') : null);
      if (owningPost && owningPost.isConnected !== false) {
        const { totalCount, players } = getPostLogicalVideoItems(owningPost);
        if (totalCount === 1 && players.length === 0) {
          const mp4Url = owningPost.getAttribute?.('data-mp4-url') || owningPost.getAttribute?.('mp4-url');
          if (mp4Url && typeof mp4Url === 'string' && !mp4Url.startsWith('blob:')) {
            if (mp4Url.includes('packaged-media.redd.it') || mp4Url.includes('v.redd.it') || /\.(mp4|webm)(\?.*)?$/i.test(mp4Url)) {
              if (!isManifestAddress(mp4Url)) {
                return resolveRedditMediaDescriptor(mp4Url, owningPost, postUrl);
              }
            }
          }
        }
      }

      // Standalone clicked video has no direct source and post has sibling players or no direct candidate: fail closed!
      return null;
    }

    // 3. Target is neither inside a shreddit-player nor a video: check if target is inside a single-player post
    const post = (target && typeof target.closest === 'function' ? target.closest('shreddit-post') : null) ||
      (Array.isArray(path) ? path.find(el => el && (el.tagName || '').toLowerCase() === 'shreddit-post') : null);
    if (post && post.isConnected !== false) {
      return extractDirectCandidateFromPost(post, postUrl, target);
    }

    return null;
  }

  /**
   * Finds the Reddit media element under the cursor by inspecting composedPath,
   * shadow roots, and enclosing post container. Strictly scoped to the selected
   * gallery slide or owning card to avoid selecting adjacent/sibling media.
   */
  function findRedditMediaFromTargetAndPath(target, path = [], point = null) {
    // If target itself is explicitly disconnected, fail closed immediately
    if (target && target.isConnected === false) {
      return null;
    }

    // Card-level fallbacks (below) may only hand out media the click actually lies on: a caption, a title or empty
    // card space does not make the whole card a target. Without a click point (direct unit calls) the box test is off.
    const holdsPoint = (el) => {
      if (!point) return true;
      const r = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      return Boolean(r) && point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
    };

    const elements = [];
    if (Array.isArray(path) && path.length > 0) {
      elements.push(...path);
    } else if (target) {
      elements.push(target);
    }

    const postUrl = extractRedditPostUrl({ target, composedPath: path });

    // 1. Direct inspection of elements in composedPath
    for (const el of elements) {
      if (!el || typeof el.getAttribute !== 'function' || el.isConnected === false) continue;
      const tag = (el.tagName || '').toLowerCase();

      // HTML5 video element
      if (tag === 'video' && !isPreviewVideo(el, elements)) {
        const videoSrc = el.currentSrc || el.src || el.querySelector?.('source')?.src || el.getAttribute('src');
        if (videoSrc) {
          if (videoSrc.startsWith('blob:')) {
            const direct = findRedditDirectMediaForBlob(el, elements, videoSrc);
            if (direct) return direct;
          }
          const desc = resolveRedditMediaDescriptor(videoSrc, el, postUrl);
          if (desc) return desc;
        }
      }

      // Shreddit player custom element (<shreddit-player>)
      if (tag === 'shreddit-player') {
        const directCandidate = extractDirectCandidateFromPlayer(el, postUrl);
        if (directCandidate) return directCandidate;

        const playerSrc = el.getAttribute('src') || el.src || el.getAttribute('preview');
        if (playerSrc && !playerSrc.startsWith('blob:')) {
          const desc = resolveRedditMediaDescriptor(playerSrc, el, postUrl);
          if (desc) return desc;
        }
        // Inspect shadowRoot if open
        if (el.shadowRoot) {
          const shadowVideo = firstMainVideo(el.shadowRoot);
          if (shadowVideo && shadowVideo.isConnected !== false) {
            const shadowSources = shadowVideo.querySelectorAll?.('source') || [];
            for (const s of shadowSources) {
              const sSrc = s.src || s.getAttribute?.('src');
              if (sSrc && typeof sSrc === 'string' && !sSrc.startsWith('blob:')) {
                if (sSrc.includes('packaged-media.redd.it') || sSrc.includes('v.redd.it') || /\.(mp4|webm)(\?.*)?$/i.test(sSrc)) {
                  if (!isManifestAddress(sSrc)) {
                    const desc = resolveRedditMediaDescriptor(sSrc, shadowVideo, postUrl);
                    if (desc) return desc;
                  }
                }
              }
            }
            const shadowSrc = shadowVideo.currentSrc || shadowVideo.src || shadowVideo.querySelector?.('source')?.src;
            if (shadowSrc) {
              if (shadowSrc.startsWith('blob:')) {
                const direct = findRedditDirectMediaForBlob(shadowVideo, elements, shadowSrc);
                if (direct) return direct;
              }
              const desc = resolveRedditMediaDescriptor(shadowSrc, shadowVideo, postUrl);
              if (desc) return desc;
            }
          }
        }
      }

      // Image element
      if (tag === 'img') {
        const imgSrc = el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('data-src');
        if (imgSrc) {
          const desc = resolveRedditMediaDescriptor(imgSrc, el, postUrl);
          if (desc) return desc;
        }
      }

      // Anchor element pointing directly to media
      if (tag === 'a') {
        const href = el.getAttribute('href') || el.href;
        if (href && (isRedditAnimationUrl(href) || /\.(gif|mp4|webm|jpg|jpeg|png|webp)(\?.*)?$/i.test(href) ||
                     href.includes('preview.redd.it') || href.includes('packaged-media.redd.it') || href.includes('v.redd.it'))) {
          const desc = resolveRedditMediaDescriptor(href, el, postUrl);
          if (desc) return desc;
        }
      }
    }

    // 2. Inspection of selected slide / gallery item container.
    // Differentiates specific proven slide containers from broad gallery/dialog hosts.
    const isProvenSlideContainer = (el) => {
      if (!el || typeof el.getAttribute !== 'function') return false;
      const tag = (el.tagName || '').toLowerCase();
      // Broad dialogs/lightboxes are NOT specific slide containers
      if (tag === 'shreddit-lightbox' || el.id === 'lightbox' || el.getAttribute?.('role') === 'dialog') {
        return false;
      }
      if (tag === 'gallery-carousel' || tag === 'ul') {
        return false;
      }
      const roleDesc = (el.getAttribute('aria-roledescription') || '').toLowerCase();
      const dataPart = (el.getAttribute('data-part') || '').toLowerCase();
      const testId = (el.getAttribute('data-testid') || '').toLowerCase();
      if (roleDesc === 'slide' || dataPart === 'slide' || testId.includes('carousel-item') || testId.includes('slide')) {
        return true;
      }
      if (tag === 'shreddit-aspect-ratio' || (tag === 'figure' && el.getAttribute('slot') === 'media')) {
        return true;
      }
      if (tag === 'li' && el.closest?.('gallery-carousel, [data-part="slides"], ul[data-testid*="carousel"], ul[data-testid*="slide"]')) {
        return true;
      }
      return false;
    };

    let slideContainer = null;
    if (target && typeof target.closest === 'function') {
      let cur = target;
      while (cur) {
        if (isProvenSlideContainer(cur)) {
          slideContainer = cur;
          break;
        }
        const curTag = (cur.tagName || '').toLowerCase();
        if (curTag === 'shreddit-post' || curTag === 'shreddit-lightbox' || cur.id === 'lightbox' || cur.getAttribute?.('role') === 'dialog') {
          break;
        }
        cur = cur.parentElement;
      }
    }

    if (slideContainer && slideContainer.isConnected !== false) {
      const slideVideo = firstMainVideo(slideContainer);
      if (slideVideo && slideVideo.isConnected !== false) {
        const vSrc = slideVideo.currentSrc || slideVideo.src || slideVideo.querySelector?.('source')?.src || slideVideo.getAttribute?.('src');
        if (vSrc) {
          if (vSrc.startsWith('blob:')) {
            const direct = findRedditDirectMediaForBlob(slideVideo, elements, vSrc);
            if (direct) return direct;
          }
          const desc = resolveRedditMediaDescriptor(vSrc, slideVideo, postUrl);
          if (desc) return desc;
        }
      }

      const slidePlayer = slideContainer.querySelector('shreddit-player');
      if (slidePlayer && slidePlayer.isConnected !== false) {
        const directCandidate = extractDirectCandidateFromPlayer(slidePlayer, postUrl);
        if (directCandidate) return directCandidate;
        const pSrc = slidePlayer.getAttribute?.('src') || slidePlayer.src;
        if (pSrc) {
          const desc = resolveRedditMediaDescriptor(pSrc, slidePlayer, postUrl);
          if (desc) return desc;
        }
      }

      const slideImg = slideContainer.querySelector('img');
      if (slideImg && slideImg.isConnected !== false) {
        const iSrc = slideImg.currentSrc || slideImg.src || slideImg.getAttribute?.('src') || slideImg.getAttribute?.('data-src');
        if (iSrc) {
          const desc = resolveRedditMediaDescriptor(iSrc, slideImg, postUrl);
          if (desc) return desc;
        }
      }
    }

    // Check if target is inside a broad gallery/lightbox host (dialog, lightbox, carousel)
    // but was NOT inside a specific slide container (e.g. click on overlay/backdrop)
    const broadGalleryHost = target && typeof target.closest === 'function' ? (
      target.closest('[role="dialog"], #lightbox, shreddit-lightbox, gallery-carousel')
    ) : null;

    if (broadGalleryHost && broadGalleryHost.isConnected !== false) {
      // Collect active slide markers restricted to actual slide containers in that gallery
      const activeMarkers = Array.from(broadGalleryHost.querySelectorAll?.(
        '[aria-hidden="false"][aria-roledescription="slide"], ' +
        '[aria-hidden="false"][data-part="slide"], ' +
        '[aria-hidden="false"], ' +
        'li.is-active, [data-active="true"], [aria-selected="true"]'
      ) || []);

      const activeSlideContainers = new Set();
      for (const m of activeMarkers) {
        if (!m || m.isConnected === false) continue;
        let slide = isProvenSlideContainer(m) ? m : null;
        if (!slide && typeof m.closest === 'function') {
          let cur = m;
          while (cur && cur !== broadGalleryHost) {
            if (isProvenSlideContainer(cur)) {
              slide = cur;
              break;
            }
            cur = cur.parentElement;
          }
        }
        if (slide) {
          if (broadGalleryHost === slide.parentElement || (typeof broadGalleryHost.contains === 'function' && broadGalleryHost.contains(slide))) {
            activeSlideContainers.add(slide);
          }
        }
      }

      if (activeSlideContainers.size > 1) {
        // Multiple conflicting active slides: ownership is ambiguous, fail closed!
        return null;
      }

      if (activeSlideContainers.size === 1) {
        const [singleActiveSlide] = Array.from(activeSlideContainers);
        const aVideo = firstMainVideo(singleActiveSlide);
        if (aVideo && aVideo.isConnected !== false) {
          const vSrc = aVideo.currentSrc || aVideo.src || aVideo.querySelector?.('source')?.src || aVideo.getAttribute?.('src');
          if (vSrc) {
            if (vSrc.startsWith('blob:')) {
              const direct = findRedditDirectMediaForBlob(aVideo, elements, vSrc);
              if (direct) return direct;
            }
            const desc = resolveRedditMediaDescriptor(vSrc, aVideo, postUrl);
            if (desc) return desc;
          }
        }
        const aPlayer = singleActiveSlide.querySelector('shreddit-player');
        if (aPlayer && aPlayer.isConnected !== false) {
          const direct = extractDirectCandidateFromPlayer(aPlayer, postUrl);
          if (direct) return direct;
        }
        const aImg = singleActiveSlide.querySelector('img');
        if (aImg && aImg.isConnected !== false) {
          const iSrc = aImg.currentSrc || aImg.src || aImg.getAttribute?.('src');
          if (iSrc) {
            const desc = resolveRedditMediaDescriptor(iSrc, aImg, postUrl);
            if (desc) return desc;
          }
        }
      }

      // Check if the broad host has only a single unambiguous media item
      const allMediaInHost = broadGalleryHost.querySelectorAll?.('img, video, shreddit-player') || [];
      if (allMediaInHost.length === 1 && allMediaInHost[0].isConnected !== false && holdsPoint(allMediaInHost[0])) {
        const single = allMediaInHost[0];
        const sSrc = single.currentSrc || single.src || single.getAttribute?.('src');
        if (sSrc) {
          const desc = resolveRedditMediaDescriptor(sSrc, single, postUrl);
          if (desc) return desc;
        }
      }

      // Multiple items or ambiguous overlay on broad host without proven single active slide: fail closed!
      return null;
    }

    // 3. Fallback: Search strictly within owning card container ONLY if card is NOT a multi-item carousel,
    // or if the visible active item can be confirmed. NEVER select first sibling if multiple slides exist.
    if (target && typeof target.closest === 'function') {
      try {
        const owningCard = target.closest('shreddit-post, shreddit-player, [slot="post-media-container"], figure, article');
        if (owningCard && owningCard.isConnected !== false) {
          // If owningCard contains multiple slides/items (carousel), DO NOT pick the first image/video blindly!
          const carouselContainer = owningCard.querySelector('gallery-carousel, [data-part="slides"], ul[data-testid="carousel-items"]');
          if (carouselContainer) {
            const activeSlide = carouselContainer.querySelector('[aria-hidden="false"], .is-active, [data-active="true"]');
            if (activeSlide) {
              const activeImg = activeSlide.querySelector('img');
              if (activeImg && activeImg.isConnected !== false && holdsPoint(activeImg)) {
                const aSrc = activeImg.currentSrc || activeImg.src || activeImg.getAttribute?.('src');
                if (aSrc) return resolveRedditMediaDescriptor(aSrc, activeImg, postUrl);
              }
              const activeVid = firstMainVideo(activeSlide);
              if (activeVid && activeVid.isConnected !== false && holdsPoint(activeVid)) {
                const vSrc = activeVid.currentSrc || activeVid.src;
                if (vSrc) return resolveRedditMediaDescriptor(vSrc, activeVid, postUrl);
              }
            }
            // Cannot reliably identify selected slide from card level -> fail closed, never return slides[0]!
            return null;
          }

          // If owningCard contains multiple logical video items, fail closed to avoid cross-player media theft!
          const { totalCount: logicalVideoCount } = getPostLogicalVideoItems(owningCard);
          if (logicalVideoCount > 1) {
            return null;
          }

          // Single-media card: check video or shreddit-player
          const video = firstMainVideo(owningCard);
          if (video && video.isConnected !== false && holdsPoint(video)) {
            const vSrc = video.currentSrc || video.src || video.querySelector?.('source')?.src;
            if (vSrc) {
              if (vSrc.startsWith('blob:')) {
                const direct = findRedditDirectMediaForBlob(video, elements, vSrc);
                if (direct) return direct;
              }
              const desc = resolveRedditMediaDescriptor(vSrc, video, postUrl);
              if (desc) return desc;
            }
          }

          const player = owningCard.querySelector('shreddit-player');
          if (player && player.isConnected !== false && holdsPoint(player)) {
            const directCandidate = extractDirectCandidateFromPlayer(player, postUrl);
            if (directCandidate) return directCandidate;
            const pSrc = player.getAttribute?.('src') || player.src;
            if (pSrc) {
              const desc = resolveRedditMediaDescriptor(pSrc, player, postUrl);
              if (desc) return desc;
            }
          }

          const img = owningCard.querySelector('img');
          if (img && img.isConnected !== false && holdsPoint(img)) {
            const iSrc = img.currentSrc || img.src || img.getAttribute?.('src');
            if (iSrc) {
              const desc = resolveRedditMediaDescriptor(iSrc, img, postUrl);
              if (desc) return desc;
            }
          }
        }
      } catch (_) {}
    }

    return null;
  }

  /**
   * Broadcasts detected media descriptor to background script to update context menu title proactively.
   */
  function notifyContextMenuDetected(target, path, at) {
    const media = findRedditMediaFromTargetAndPath(target, path, lastContextmenuPoint);
    lastDetectedMedia = media;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'REDDIT_MEDIA_CONTEXTMENU_DETECTED',
          media,
          timestamp: Date.now(),
          gestureAt: Number.isFinite(at) ? at : undefined
        }).catch(() => {});
      }
    } catch (_) {}
  }

  // Track the last contextmenu target and composedPath per frame with proactive messaging
  if (typeof window !== 'undefined' && window.addEventListener) {
    // Early trigger on right-button mousedown to update menu before it renders
    window.addEventListener('mousedown', (event) => {
      if (event && event.button === 2) {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        lastContextmenuTarget = event.target;
        lastContextmenuPath = path;
        lastContextmenuTime = Date.now();
        lastContextmenuPoint = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? { x: event.clientX, y: event.clientY } : null;
        notifyContextMenuDetected(event.target, path, event.timeStamp);
      }
    }, true);

    // Fallback trigger on contextmenu event
    window.addEventListener('contextmenu', (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      lastContextmenuTarget = event.target;
      lastContextmenuPath = path;
      lastContextmenuTime = Date.now();
      lastContextmenuPoint = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? { x: event.clientX, y: event.clientY } : null;
      notifyContextMenuDetected(event.target, path, event.timeStamp);
    }, true);
  }

  /**
   * Normalizes a relative or absolute Reddit post URL to a canonical HTTPS Reddit post permalink.
   */
  function normalizeRedditPostUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    try {
      const parsed = new URL(urlStr, 'https://www.reddit.com');
      const path = parsed.pathname;
      const match = path.match(/^(\/r\/[^/]+\/comments\/[a-zA-Z0-9]+(?:\/[^/]+)?)/i);
      if (match) {
        let canonicalPath = match[1];
        if (!canonicalPath.endsWith('/')) {
          canonicalPath += '/';
        }
        return `https://www.reddit.com${canonicalPath}`;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Extracts the canonical Reddit post URL from context menu event targets, DOM hierarchy, or page URL.
   */
  function extractRedditPostUrl(opts = {}) {
    let target = null;
    let path = [];
    let locationHref = '';

    if (opts && typeof opts === 'object') {
      target = opts.target || null;
      if (typeof opts.composedPath === 'function') {
        try { path = opts.composedPath() || []; } catch (_) { path = []; }
      } else if (Array.isArray(opts.composedPath)) {
        path = opts.composedPath;
      }
      locationHref = typeof opts.locationHref === 'string' ? opts.locationHref : '';
    }

    // 1. Inspect composedPath elements (Shreddit custom elements and post containers)
    if (Array.isArray(path) && path.length > 0) {
      for (const el of path) {
        if (!el || typeof el.getAttribute !== 'function') continue;
        // Shreddit post element: <shreddit-post permalink="..." content-href="...">
        const permalink = el.getAttribute('permalink') || el.getAttribute('content-href');
        if (permalink) {
          const normalized = normalizeRedditPostUrl(permalink);
          if (normalized) return normalized;
        }
        // Check anchor elements
        const href = el.getAttribute('href');
        if (href && href.includes('/comments/')) {
          const normalized = normalizeRedditPostUrl(href);
          if (normalized) return normalized;
        }
      }
    }

    // 2. Inspect target directly if composedPath didn't yield a post
    if (target && typeof target.closest === 'function') {
      try {
        const shredditPost = target.closest('shreddit-post');
        if (shredditPost) {
          const permalink = shredditPost.getAttribute('permalink') || shredditPost.getAttribute('content-href');
          if (permalink) {
            const normalized = normalizeRedditPostUrl(permalink);
            if (normalized) return normalized;
          }
        }
        const postAnchor = target.closest('a[href*="/comments/"]');
        if (postAnchor) {
          const href = postAnchor.getAttribute('href');
          if (href) {
            const normalized = normalizeRedditPostUrl(href);
            if (normalized) return normalized;
          }
        }
      } catch (_) {}
    }

    // 3. Fallback to locationHref if the page itself is a Reddit post
    if (!locationHref && typeof window !== 'undefined' && window.location) {
      locationHref = window.location.href;
    }
    if (locationHref) {
      const normalized = normalizeRedditPostUrl(locationHref);
      if (normalized) return normalized;
    }

    return null;
  }

  // Runtime messaging interface for background script
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.action === 'GET_REDDIT_POST_URL') {
        const postUrl = extractRedditPostUrl({
          target: lastContextmenuTarget,
          composedPath: () => lastContextmenuPath,
          locationHref: typeof window !== 'undefined' ? window.location.href : ''
        });
        sendResponse({ postUrl });
        return true;
      }
      if (message?.action === 'GET_REDDIT_MEDIA_AT_CURSOR') {
        const isFresh = (Date.now() - lastContextmenuTime) < 15000;
        let freshMedia = null;

        // Bounded freshness & target connection check:
        // If freshness expired, target is missing, or the originally clicked target was detached,
        // fail closed immediately ({ media: null }) to avoid returning stale or recycled media.
        if (isFresh && lastContextmenuTarget && lastContextmenuTarget.isConnected !== false) {
          const connectedPath = Array.isArray(lastContextmenuPath)
            ? lastContextmenuPath.filter(el => el && el.isConnected !== false)
            : [];
          freshMedia = findRedditMediaFromTargetAndPath(lastContextmenuTarget, connectedPath, lastContextmenuPoint);
        }

        if (freshMedia) {
          lastDetectedMedia = freshMedia;
          sendResponse({ media: freshMedia });
        } else {
          lastDetectedMedia = null;
          sendResponse({ media: null });
        }
        return true;
      }
      if (message?.action === 'RESOLVE_REDDIT_BLOB_MEDIA') {
        const clickedSrc = message.clickedSrc || '';
        const isFresh = (Date.now() - lastContextmenuTime) < 15000;
        let candidateDesc = null;
        let selectedPlayer = null;
        let connectedPath = [];

        const freshTarget = Boolean(isFresh && lastContextmenuTarget && lastContextmenuTarget.isConnected !== false);
        if (freshTarget) {
          connectedPath = Array.isArray(lastContextmenuPath)
            ? lastContextmenuPath.filter(el => el && el.isConnected !== false)
            : [];
          candidateDesc = findRedditDirectMediaForBlob(lastContextmenuTarget, connectedPath, clickedSrc);
          if (!candidateDesc) {
            const found = findRedditMediaFromTargetAndPath(lastContextmenuTarget, connectedPath, lastContextmenuPoint);
            // a manifest address is a stream, never a direct file: it falls through to the stream the selected player declares
            if (found && found.url && !found.url.startsWith('blob:') && !isManifestAddress(found.url)) {
              candidateDesc = found;
            }
          }
          // the player of the fresh, connected selection (a stale or detached selection owns nothing), never one reached through a seek preview
          const picked = lastContextmenuTarget.closest?.('shreddit-player') ||
            connectedPath.find((el) => el && String(el.tagName).toUpperCase() === 'SHREDDIT-PLAYER') || null;
          if (picked && picked.isConnected !== false && !isPreviewVideo(lastContextmenuTarget, connectedPath) &&
              !lastContextmenuTarget.closest?.(PREVIEW_VIDEO_HOSTS) &&
              !connectedPath.some((el) => el && PREVIEW_VIDEO_TAGS.includes(String(el.tagName).toUpperCase()))) selectedPlayer = picked;
        }

        if (candidateDesc && candidateDesc.url && !candidateDesc.url.startsWith('blob:')) {
          sendResponse({
            success: true,
            targetUrl: candidateDesc.url,
            media: candidateDesc,
            diagnostics: {
              targetTag: candidateDesc.elementTag || 'video',
              sourceType: candidateDesc.sourceType,
              hasAudio: typeof candidateDesc.hasAudio === 'boolean' ? candidateDesc.hasAudio : 'unknown'
            }
          });
        } else {
          const stream = declaredStreamOf(selectedPlayer);
          // Chrome's own address of the clicked video: a blob (the player's MediaSource) or the master itself. A master must be the very address this
          // player declares now (a neighbour's, a replaced player's or another query is not the selected one); the player's declared address is used.
          const sameAddress = (a, b) => { try { return new URL(a).href === new URL(b).href; } catch (_) { return false; } };
          const addressClicked = Boolean(clickedSrc) && !clickedSrc.startsWith('blob:');
          if (stream && stream.saveable && (!addressClicked || sameAddress(clickedSrc, stream.url))) {
            sendResponse({ success: true, hls: { url: stream.url }, diagnostics: { streamType: 'hls', targetFound: true } });
            return true;
          }
          const isDashAddress = (u) => manifestKindOfAddress(u) === 'dash';
          let isDash = Boolean(freshTarget && (
            isDashAddress(selectedPlayer?.getAttribute?.('stream-url')) ||
            isDashAddress(selectedPlayer?.getAttribute?.('src')) ||
            isDashAddress(lastContextmenuTarget?.getAttribute?.('src'))
          ));
          if (!isDash && freshTarget) {
            for (const el of connectedPath) {
              const streamUrl = el?.getAttribute?.('stream-url') || '';
              const src = el?.getAttribute?.('src') || '';
              if (isDashAddress(streamUrl) || isDashAddress(src)) {
                isDash = true;
                break;
              }
            }
          }
          sendResponse({
            success: false,
            error: 'UNRESOLVED_BLOB_MEDIA',
            reason: isDash ? 'UNSUPPORTED_DASH_STREAM' : (stream && !(stream.saveable && addressClicked) ? 'UNSUPPORTED_STREAM' : 'NO_DIRECT_MEDIA_FOUND'),
            diagnostics: {
              targetFound: Boolean(lastContextmenuTarget),
              isConnected: lastContextmenuTarget ? lastContextmenuTarget.isConnected !== false : false,
              streamType: isDash ? 'dash' : (stream ? stream.kind : 'blob')
            }
          });
        }
        return true;
      }
      if (message?.action === 'REDDIT_INLINE_OWNER' || message?.action === 'REDDIT_INLINE_BATCH' || message?.action === 'REDDIT_INLINE_OWNER_ITEM') {
        const action = message.action;
        if (sender && (sender.tab || (chrome.runtime?.id && sender.id !== chrome.runtime.id))) return;
        sendResponse(action === 'REDDIT_INLINE_OWNER' ? riAnswerOwner(message.token)
          : action === 'REDDIT_INLINE_BATCH' ? riBatchOpen(message.token)
            : riBatchItem(message.token, message.index));
        return true;
      }
    });
  }

  // --- UX-11-RD: inline Save control over Reddit post media ("Save this" always; "Save all (N)" only for a post with complete proven gallery) ---
  const RI_POST = 'shreddit-post, [data-testid="search-post"], [data-testid="search-post-unit"], article, [role="article"]';
  const RI_CROSSPOST = '[data-testid="crosspost-post"], [slot="crosspost-post"], [data-testid="crosspost-root"], crosspost-container';
  const RI = {
    HOVER_MS: 60,
    MAX_STACK: 24,
    MIN_W: 96,
    MIN_H: 64,
    TOKEN_TTL: 15000,
    CLICK_GAP: 1500,
    CHAIN: 14,
    INSET: 8,
    SIZE: 32,
    Z: 10,
    SLIDE_NODES: 12,
    SETTLE_MS: 100,
    SETTLE_MAX: 12,
    DEPTH: 40,
    BATCH_MIN: 2,
    BATCH_MAX: 20,
    BATCH_TTL: 180000,
    MULTI_W: 104,
    MULTI_H: 60,
    COMPACT_W: 80,
    COMPACT_H: 32,
    ENUM_NODES: 80,
    EVIDENCE_CONTAINERS: 8,
    EVIDENCE_PAGERS: 4,
    TOL: 2,
    CORNER: 3
  };

  const riState = {
    host: null,
    btn: null,
    btnAll: null,
    lbl: null,
    lblAll: null,
    count: 0,
    compact: false,
    snap: null,
    el: null,
    observer: null,
    timer: null,
    settleTimer: null,
    settleN: 0,
    rearmTimer: null,
    rearmN: 0,
    sig: '',
    href: '',
    x: 0,
    y: 0,
    busyKey: '',
    busyAt: 0,
    busyTimer: null,
    keyEl: null,
    dismissed: null
  };

  const riPending = new Map();
  const riBatches = new Map();

  function riImageKind(url) {
    if (!url || typeof url !== 'string') return null;
    try {
      const u = new URL(url, 'https://www.reddit.com');
      const path = u.pathname.toLowerCase();
      const host = u.hostname.toLowerCase();

      // Explicitly reject non-content images: avatars, community icons, emojis, badges, awards
      if (path.includes('/avatar/') || path.includes('/avatars/') || path.includes('/styles/profileicon') || path.includes('/profileicon')) return null;
      if (path.includes('/styles/communityicon') || path.includes('/communityicon')) return null;
      if (path.includes('/emojis/') || path.includes('/emoji/')) return null;
      if (path.includes('/badges/') || path.includes('/badge/')) return null;
      if (path.includes('/awards/') || path.includes('/award_images/')) return null;
      if (path.includes('/reactions/')) return null;

      const isReddIt = host === 'redd.it' || host.endsWith('.redd.it');
      const isRedditWrapper = (host === 'reddit.com' || host.endsWith('.reddit.com')) && path === '/media';
      if (isReddIt || isRedditWrapper) {
        if (isRedditAnimationUrl(url)) return 'gif-animation';
        if (isRedditNativeGifUrl(url)) return 'native-gif';
        return 'image';
      }
    } catch (_) {}
    return null;
  }

  function riOwnerOf(el) {
    if (!el || typeof el.closest !== 'function') return null;
    // Reject comments immediately: comment media is excluded from post-level inline saves
    if (el.closest('shreddit-comment, [data-testid="comment"], .comment')) return null;

    // Media-search card containers
    const searchCard = el.closest('[data-testid="search-post"], [data-testid="search-post-unit"]');
    if (searchCard) return { owner: searchCard, isCrosspost: false };

    // Standard Shreddit post
    const post = el.closest('shreddit-post');
    if (post) {
      // Check if nested inside another shreddit-post or crosspost container
      const isCrosspost = Boolean(
        (post.parentElement && post.parentElement.closest('shreddit-post')) ||
        post.closest(RI_CROSSPOST)
      );
      return { owner: post, isCrosspost };
    }

    // Lightbox / overlay
    const lightbox = el.closest('shreddit-media-lightbox, [data-testid="media-lightbox"]');
    if (lightbox) return { owner: lightbox, isCrosspost: false };

    // Fallback article element
    const article = el.closest('article, [role="article"]');
    if (article) return { owner: article, isCrosspost: false };

    return null;
  }

  function riIdOf(owner, isCrosspost = false) {
    if (!owner) return null;
    let rawId = null;
    let postUrl = null;

    // 1. Direct post id / fullname / name attributes
    for (const attr of ['id', 'name', 'post-id', 'data-fullname', 'data-post-id']) {
      const val = typeof owner.getAttribute === 'function' ? owner.getAttribute(attr) : null;
      if (val && typeof val === 'string') {
        const m = val.match(/^(?:t3_)?([a-z0-9]{1,12})$/i);
        if (m) {
          rawId = m[1].toLowerCase();
          break;
        }
      }
    }

    // 2. permalink or content-href on owner
    for (const attr of ['permalink', 'content-href', 'data-permalink']) {
      const href = typeof owner.getAttribute === 'function' ? owner.getAttribute(attr) : null;
      if (href && typeof href === 'string') {
        const m = href.match(/\/comments\/([a-z0-9]{1,12})(?:\/|$)/i);
        if (m) {
          const candId = m[1].toLowerCase();
          if (!rawId) {
            rawId = candId;
            postUrl = normalizeRedditPostUrl(href);
            break;
          } else if (candId === rawId && !postUrl) {
            postUrl = normalizeRedditPostUrl(href);
            break;
          }
        }
      }
    }

    // 3. Child anchor tags inside owner
    if ((!rawId || !postUrl) && typeof owner.querySelectorAll === 'function') {
      const anchors = Array.from(owner.querySelectorAll('a[href*="/comments/"]')).slice(0, 20);
      for (const a of anchors) {
        if (!isCrosspost && typeof a.closest === 'function' && a.closest(RI_CROSSPOST)) continue;
        const href = (typeof a.getAttribute === 'function' && a.getAttribute('href')) || a.href || '';
        const m = href.match(/\/comments\/([a-z0-9]{1,12})(?:\/|$)/i);
        if (m) {
          const candId = m[1].toLowerCase();
          if (!rawId) {
            rawId = candId;
            postUrl = normalizeRedditPostUrl(href);
            break;
          } else if (candId === rawId && !postUrl) {
            postUrl = normalizeRedditPostUrl(href);
            break;
          }
        }
      }
    }

    // 4. Page URL if on a post page
    if ((!rawId || !postUrl) && typeof location !== 'undefined' && location.pathname) {
      const m = location.pathname.match(/\/comments\/([a-z0-9]{1,12})(?:\/|$)/i);
      if (m) {
        const candId = m[1].toLowerCase();
        if (!rawId) {
          rawId = candId;
          postUrl = normalizeRedditPostUrl(location.href);
        } else if (candId === rawId && !postUrl) {
          postUrl = normalizeRedditPostUrl(location.href);
        }
      }
    }

    if (!rawId) return null;
    const ownerId = `t3_${rawId}`;
    return { ownerId, postUrl };
  }

  const riAttr = (el, k) => (el && typeof el.getAttribute === 'function' && el.getAttribute(k)) || '';
  // the source of an <img>: a slide that is not near the viewport yet keeps the same address in data-lazy-src until it is swapped into src
  const riImgSrc = (el) => el.currentSrc || el.src || riAttr(el, 'data-lazy-src');
  // The exact source of a media node, kept whole for source continuity at the item proof (never reduced to an identity): every address the
  // node or its player holds, so a changed query, resolution or token is a source change of that slot.
  // A player's source also holds the address the descriptor will pass on, from whichever source it selects (src/stream-url, the open shadow
  // <video> or its <source> nodes, else the file packaged-media-json selects): the proof covers what the descriptor uses, never the raw
  // attribute, so a reformatted declaration or a blob: MediaSource that selects the same address is no change and a different one is.
  const riPlayerOf = (el) => (el.tagName === 'SHREDDIT-PLAYER' ? el : (typeof el.closest === 'function' ? el.closest('shreddit-player') : null));
  // the one shadow <video> the descriptor reads (first <video> of the player's own open shadow root); a replaced node is a changed source
  const riShadowVideo = (el) => {
    if (el.tagName === 'SHREDDIT-EMBED') return riEmbedFrame(el);
    const p = riPlayerOf(el);
    const root = p && p.shadowRoot;
    return firstMainVideo(root);
  };
  const riSrcOf = (el) => {
    const embedHost = riEmbedHost(el);
    if (embedHost) {
      const o = riOwnerOf(embedHost);
      return ['embed', riEmbedSrc(embedHost), o && o.owner ? riAttr(o.owner, 'content-href') : ''].join('|');
    }
    if (el.tagName !== 'VIDEO' && el.tagName !== 'SHREDDIT-PLAYER') return riImgSrc(el);
    const inner = el.tagName === 'SHREDDIT-PLAYER' ? firstMainVideo(el) : null;
    const player = riPlayerOf(el);
    return [el.currentSrc || el.src || '', riAttr(el, 'src'), riAttr(el, 'stream-url'), inner ? (inner.currentSrc || inner.src || '') : '', riAttr(el, 'poster') || el.poster || '', player ? ((extractDirectCandidateFromPlayer(player, null) || {}).url || '') : ''].join('|');
  };

  // ---- RD-10: a RedGIFs embed in a link post ----
  // Observed on a Reddit link post (Gemini's RD-10 fixture, 2026-10-05; not re-observed here): <shreddit-post post-type="link" domain="redgifs.com"
  // content-href=".../watch/<id>"> holds <shreddit-embed providerName="RedGIFs" html="<iframe src=.../ifr/<id> ...>"> with a cross-origin iframe, and
  // no media node of its own. The embed is a candidate only when the post that owns it declares the very clip the iframe shows: the clip comes from
  // the iframe address (or, with no reachable iframe, the embed's own html), is compared with the post's content-href, and the background proves the
  // frame of that clip again at click time. The bound node is the embed (or a bare iframe); a changed address, declaration or iframe is a changed source.
  const RI_EMBED_IFR = /^https:\/\/(?:www\.)?redgifs\.com\/ifr\/([A-Za-z0-9_-]{3,64})\/?(?:[?#].*)?$/i;
  const RI_EMBED_WATCH = /^https:\/\/(?:www\.)?redgifs\.com\/watch\/([A-Za-z0-9_-]{3,64})\/?(?:[?#].*)?$/i;

  function riEmbedHost(node) {
    if (!node || (node.tagName !== 'IFRAME' && node.tagName !== 'SHREDDIT-EMBED')) return null;
    if (node.tagName === 'SHREDDIT-EMBED') return node;
    return (typeof node.closest === 'function' && node.closest('shreddit-embed')) || node;
  }

  // the one iframe the embed shows: itself (a bare iframe), a light-DOM child or a child of an open shadow root; null when none is reachable
  function riEmbedFrame(host) {
    if (!host) return null;
    if (host.tagName === 'IFRAME') return host;
    for (const root of [host, host.shadowRoot]) {
      const frame = root && typeof root.querySelector === 'function' ? root.querySelector('iframe') : null;
      if (frame) return frame;
    }
    return null;
  }

  function riEmbedSrc(host) {
    const frame = riEmbedFrame(host);
    if (frame) return String(frame.src || riAttr(frame, 'src') || '').slice(0, 2048);
    const html = riAttr(host, 'html');
    const m = html && html.length <= 4096 ? /<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']{1,2048})["']/i.exec(html) : null;
    return m ? m[1] : '';
  }

  // { host, owner, clip } when `node` is an embed of a clip that its own post declares; null otherwise. A comment, a crosspost, a search card or a
  // lightbox never lends an embed, and an owner without a matching declaration proves nothing.
  function riEmbedOf(node) {
    const host = riEmbedHost(node);
    if (!host) return null;
    const o = riOwnerOf(host);
    if (!o || !o.owner || o.isCrosspost || o.owner.tagName !== 'SHREDDIT-POST') return null;
    const shown = RI_EMBED_IFR.exec(riEmbedSrc(host));
    const declared = RI_EMBED_WATCH.exec(riAttr(o.owner, 'content-href'));
    if (!shown || !declared || shown[1].toLowerCase() !== declared[1].toLowerCase()) return null;
    return { host, owner: o.owner, clip: shown[1].toLowerCase() };
  }

  function riSnapshot(el, kind) {
    const o = riOwnerOf(el);
    if (!o || !o.owner) return null;
    if (typeof el.getBoundingClientRect !== 'function') return null;
    const idInfo = riIdOf(o.owner, o.isCrosspost);
    if (!idInfo || !idInfo.ownerId) return null;

    const chain = [];
    for (let p = el.parentElement; p && chain.length < RI.CHAIN; p = p.parentElement) {
      chain.push(new WeakRef(p));
      if (p === o.owner) break;
    }
    return {
      elRef: new WeakRef(el),
      ownerRef: new WeakRef(o.owner),
      isCrosspost: Boolean(o.isCrosspost),
      ownerId: idInfo.ownerId,
      postUrl: idInfo.postUrl,
      tag: el.tagName,
      kind,
      src: riSrcOf(el),
      shadow: (() => { const v = riShadowVideo(el); return v ? new WeakRef(v) : null; })(),
      chain,
      href: (typeof location !== 'undefined' && location.href) || ''
    };
  }

  function riHolds(s) {
    try {
      const el = s.elRef.deref();
      const owner = s.ownerRef.deref();
      if (!el || !owner || el.isConnected === false || owner.isConnected === false) return false;
      const o = riOwnerOf(el);
      if (!o || o.owner !== owner || Boolean(o.isCrosspost) !== s.isCrosspost) return false;
      if (el.tagName !== s.tag || riSrcOf(el) !== s.src) return false;
      if ((riShadowVideo(el) || null) !== (s.shadow ? (s.shadow.deref() || null) : null)) return false;
      const idInfo = riIdOf(owner, s.isCrosspost);
      if (!idInfo || idInfo.ownerId !== s.ownerId) return false;
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

  function riSame(a, b) {
    if (!a || !b) return false;
    return a.elRef?.deref() === b.elRef?.deref() &&
      a.ownerRef?.deref() === b.ownerRef?.deref() &&
      a.isCrosspost === b.isCrosspost &&
      a.ownerId === b.ownerId &&
      a.tag === b.tag &&
      a.src === b.src &&
      (a.shadow ? a.shadow.deref() : null) === (b.shadow ? b.shadow.deref() : null) &&
      a.kind === b.kind &&
      a.chain?.length === b.chain?.length &&
      a.chain.every((ref, i) => ref.deref() === b.chain[i].deref());
  }

  function riCandidate(stack) {
    const own = riState.host;
    for (const el of stack.slice(0, RI.MAX_STACK)) {
      if (!el || (own && (el === own || (typeof own.contains === 'function' && own.contains(el))))) continue;
      if (el.tagName === 'VIDEO') {
        if (isPreviewVideo(el)) continue; // the scrub preview of a player: the player below it is the candidate
        return { el, kind: 'video' };
      }
      if (el.tagName === 'SHREDDIT-PLAYER') return { el, kind: 'video' };
      if (el.tagName === 'IFRAME' || el.tagName === 'SHREDDIT-EMBED') {
        const embed = riEmbedOf(el);
        if (embed) return { el: embed.host, kind: 'video' };
        continue;
      }
      if (el.tagName === 'IMG') {
        const kind = riImageKind(riImgSrc(el));
        if (!kind) return null; // fails closed: topmost non-media image means no button behind it
        const player = stack.slice(0, RI.MAX_STACK).find((v) =>
          v && (v.tagName === 'VIDEO' || v.tagName === 'SHREDDIT-PLAYER') &&
          riOwnerOf(v)?.owner === riOwnerOf(el)?.owner
        );
        return player ? { el: player, kind: 'video' } : { el, kind: 'image' };
      }
    }
    return null;
  }

  const riClips = (cs) => ['overflow', 'overflowX', 'overflowY'].some((k) => cs[k] && cs[k] !== 'visible');

  function riLayout(el, owner, w, h) {
    try {
      if (!el || !owner || typeof el.getBoundingClientRect !== 'function' || typeof window.getComputedStyle !== 'function') return null;
      const r = el.getBoundingClientRect();
      let L = r.left, T = r.top, Rt = r.right, B = r.bottom;
      const clip = (b) => { L = Math.max(L, b.left); T = Math.max(T, b.top); Rt = Math.min(Rt, b.right); B = Math.min(B, b.bottom); };
      let container = null, containerAt = -1, clipAt = -1, reached = false;
      let depth = 0;
      for (let p = el.parentElement; p && depth < RI.DEPTH; p = p.parentElement, depth++) {
        const cs = window.getComputedStyle(p);
        if (!cs) return null;
        if (riClips(cs)) {
          clip(p.getBoundingClientRect());
          if (clipAt < 0) clipAt = depth;
        }
        if (containerAt < 0 && cs.position && cs.position !== 'static') {
          container = p;
          containerAt = depth;
        }
        if (p === owner) { reached = true; break; }
      }
      if (!reached || !container || (clipAt >= 0 && containerAt > clipAt)) return null;
      clip(owner.getBoundingClientRect());
      const vw = (typeof window.innerWidth === 'number' && window.innerWidth) || 0;
      const vh = (typeof window.innerHeight === 'number' && window.innerHeight) || 0;
      clip({ left: 0, top: 0, right: vw || Rt, bottom: vh || B });
      if (!(Rt - L >= Math.max(RI.MIN_W, w + 2 * RI.INSET)) || !(B - T >= Math.max(RI.MIN_H, h + 2 * RI.INSET))) return null;
      if (L - r.left > RI.TOL || T - r.top > RI.TOL || r.right - Rt > RI.TOL || r.bottom - B > RI.TOL) return null;
      if (riCovered(owner, { left: L, top: T, right: Rt, bottom: B })) return null;
      const cr = container.getBoundingClientRect();
      if (typeof container.offsetWidth === 'number' && container.offsetWidth > 0 && Math.abs(cr.width - container.offsetWidth) > 2) return null;
      const left = Math.round(Rt - RI.INSET - w - cr.left - (container.clientLeft || 0) + (container.scrollLeft || 0));
      const top = Math.round(T + RI.INSET - cr.top - (container.clientTop || 0) + (container.scrollTop || 0));
      return { vis: { left: L, top: T, right: Rt, bottom: B }, host: container, left, top, w, h, sig: [L, T, Rt, B, cr.left, cr.top, w, h].map(Math.round).join(',') };
    } catch (_) {
      return null;
    }
  }

  function riCovered(owner, vis) {
    if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return false;
    const host = riState.host;
    const d = RI.CORNER;
    for (const [x, y] of [[vis.left + d, vis.top + d], [vis.right - d, vis.top + d], [vis.left + d, vis.bottom - d], [vis.right - d, vis.bottom - d]]) {
      const t = document.elementFromPoint(x, y);
      if (!t || !(t === host || (typeof owner.contains === 'function' && owner.contains(t)))) return true;
    }
    return false;
  }

  const riPointIn = (b, x, y) => x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1;

  function riHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // The stable identity of an asset from its Reddit media address: the host family and the asset id, never the query, token, extension or
  // resolution (contract amendment 4: a source-only change of one slot is item-level, not structural). The host is anchored, so a foreign
  // address that merely contains a Reddit host name never gets a Reddit identity.
  function riAssetId(s) {
    if (!s || typeof s !== 'string') return null;
    // The whole first path segment of an anchored Reddit image host (up to / ? #): preview addresses carry an SEO slug that may be percent-encoded,
    // localised or punctuated, [slug]-v0-[media id].[ext]. The media id is what follows the LAST -v0- and must be a plain id of [A-Za-z0-9_-]; a segment
    // without -v0- must itself be a plain id. Anything else (an encoded segment with no recoverable id, an encoded id) is unidentifiable, never a
    // truncated slug. The address itself is never rewritten.
    let m = s.match(/^(?:https?:)?\/\/(?:i|preview|external-preview)\.redd\.it\/([^/?#]+)/i);
    if (m) {
      const base = m[1].replace(/\.[A-Za-z0-9]{1,5}$/, '');
      const at = base.lastIndexOf('-v0-');
      const id = at >= 0 && at + 4 < base.length ? base.slice(at + 4) : base;
      return /^[A-Za-z0-9_-]+$/.test(id) ? `img:${id}` : null;
    }
    m = s.match(/^(?:https?:)?\/\/v\.redd\.it\/([a-zA-Z0-9_-]+)/i);
    if (m) return `vid:${m[1]}`;
    m = s.match(/^(?:https?:)?\/\/packaged-media\.redd\.it\/([a-zA-Z0-9_-]+)/i);
    if (m) return `pm:${m[1]}`;
    return null;
  }

  function riSlotKey(el) {
    if (!el) return null;
    const player = el.tagName === 'SHREDDIT-PLAYER' ? el : el.closest?.('shreddit-player');
    if (player) {
      const raw = [player.getAttribute?.('stream-url'), player.getAttribute?.('src')];
      for (const s of raw) { const id = riAssetId(s); if (id) return id; }
      // an address that carries no recognised asset id keeps its exact string as the identity (never merged with another)
      const pSrc = raw.find(Boolean) || player.getAttribute?.('id') || '';
      if (pSrc) return `sp:${pSrc}`;
    }
    const srcs = el.tagName === 'VIDEO'
      ? [(el.getAttribute && el.getAttribute('poster')) || el.poster || '', el.currentSrc || el.src || '']
      : [riImgSrc(el)];
    for (const s of srcs) { const id = riAssetId(s); if (id) return id; }
    return null;
  }

  // ---- the native gallery (contract amendment 6) ----
  // Observed on www.reddit.com (post page and feed): <gallery-carousel> holds ONE <ul> of <li slot="page-1" ... slot="page-N"> (every slide is in
  // the DOM, laid out side by side; a slide that is not near the viewport keeps its source in data-lazy-src), and its open shadow roots hold a
  // pagination indicator whose `pages` attribute is the gallery's size. A slide holds one decorative backdrop <img alt=""> and the real media.
  const RI_PAGE = /^page-(\d{1,3})$/;
  const riIsSlide = (li) => Boolean(li) && li.tagName === 'LI' && RI_PAGE.test(riAttr(li, 'slot'));

  // The owner's native carousel: null when it has none (the generic evidence applies); { bad: true } when its structure is ambiguous (more than
  // one carousel, a carousel bound exceeded, no single <ul>); else { slides } with the <li> children in DOM order.
  function riSlideCarousel(owner) {
    const found = Array.from(owner.querySelectorAll('gallery-carousel'));
    if (found.length > RI.EVIDENCE_CONTAINERS) return { bad: true };
    const mine = found.filter((c) => { const o = riOwnerOf(c); return Boolean(o && o.owner === owner); });
    const lists = mine.map((c) => Array.from(c.children || []).filter((k) => k.tagName === 'UL'));
    const native = mine.filter((c, i) => lists[i].length === 1 && Array.from(lists[i][0].children || []).some(riIsSlide));
    if (native.length === 0) return null;
    if (mine.length !== 1 || native.length !== 1) return { bad: true };
    const ul = lists[0][0];
    return { slides: Array.from(ul.children || []) };
  }

  // One slide is one slot: the slot of its single real media. Decorative images (alt="" or aria-hidden), the poster and inner video of a
  // player and non-Reddit-media images are not media; one slide must not hold two different assets and must hold one.
  function riSlide(owner, li) {
    const none = { el: li, kind: 'image', key: null, slide: li };
    const nodes = Array.from(li.querySelectorAll('shreddit-player, video, img'));
    if (nodes.length > RI.SLIDE_NODES) return none;
    const media = [];
    for (const el of nodes) {
      const o = riOwnerOf(el);
      if (!o || o.owner !== owner) continue;
      if (el.tagName !== 'SHREDDIT-PLAYER' && typeof el.closest === 'function' && el.closest('shreddit-player')) continue;
      if (el.tagName === 'IMG') {
        if (el.getAttribute('alt') === '' || el.getAttribute('aria-hidden') === 'true') continue;
        if (!riImageKind(riImgSrc(el))) continue;
      }
      media.push(el);
    }
    if (media.length === 0) return none;
    const keys = media.map(riSlotKey);
    if (keys.some((k) => !k) || new Set(keys).size !== 1) return none;
    const sized = (m) => { const r = typeof m.getBoundingClientRect === 'function' ? m.getBoundingClientRect() : null; return Boolean(r) && r.width > 0 && r.height > 0; };
    const el = media.find((m) => m.tagName !== 'IMG') || media.find(sized) || media[0];
    return { el, kind: el.tagName === 'IMG' ? 'image' : 'video', key: keys[0], slide: li };
  }

  function riEnumerateSlides(owner, sc) {
    const out = [];
    let whole = !sc.bad && sc.slides.length >= RI.BATCH_MIN && sc.slides.length <= RI.BATCH_MAX;
    if (whole) sc.slides.forEach((li, i) => { const m = riIsSlide(li) ? RI_PAGE.exec(riAttr(li, 'slot')) : null; if (!m || Number(m[1]) !== i + 1) whole = false; });
    if (whole) for (const li of sc.slides) out.push(riSlide(owner, li));
    const proof = riGalleryProof(owner, out, !whole);
    out.items = out;
    out.isComplete = proof.isComplete;
    out.keys = out.map((i) => i.key);
    out.sig = riHash(out.keys.join('|'));
    return out;
  }

  function riEnumerate(owner) {
    if (!owner || typeof owner.querySelectorAll !== 'function') return [];
    const sc = riSlideCarousel(owner);
    if (sc) return riEnumerateSlides(owner, sc);
    const out = [];
    const seen = new Map();
    const all = Array.from(owner.querySelectorAll('shreddit-player, video, img'));
    // a list cut by the node bound can never be proven whole
    const truncated = all.length > RI.ENUM_NODES;
    for (const el of all.slice(0, RI.ENUM_NODES)) {
      const o = riOwnerOf(el);
      if (!o || o.owner !== owner || typeof el.getBoundingClientRect !== 'function') continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;

      let kind = 'video';
      if (el.tagName === 'IMG') {
        const ik = riImageKind(el.currentSrc || el.src);
        if (!ik) continue;
        kind = 'image';
      }
      const key = riSlotKey(el);
      if (key && seen.has(key)) {
        const at = seen.get(key);
        if (out[at].el.tagName === 'IMG' && (el.tagName === 'VIDEO' || el.tagName === 'SHREDDIT-PLAYER')) {
          out[at] = { el, kind: 'video', key };
        }
        continue;
      }
      if (key) seen.set(key, out.length);
      out.push({ el, kind, key });
    }
    const proof = riGalleryProof(owner, out, truncated);
    out.items = out;
    out.isComplete = proof.isComplete;
    out.keys = out.map((i) => i.key);
    // the structure of the list: ordered slot identities, never URLs (contract amendment 4)
    out.sig = riHash(out.keys.join('|'));
    return out;
  }

  // Positive same-owner completeness evidence (contract amendment 4): exactly one declared total, read from a gallery container or its
  // pager that belongs to this owner. No declared total, two different totals, or a total of a nested/crossposted owner is no evidence.
  function riDeclaredTotal(owner) {
    if (!owner || typeof owner.querySelectorAll !== 'function') return null;
    const totals = new Set();
    const mine = (n) => { const o = riOwnerOf(n); return Boolean(o && o.owner === owner); };
    const containers = Array.from(owner.querySelectorAll('gallery-carousel, [data-testid="carousel"], [total-items], [items-count], [data-total-items]'));
    const pagers = Array.from(owner.querySelectorAll('[data-testid="carousel-pager"]'));
    // evidence cut by its own bound can never be unambiguous (a discarded node might say another total): no proof
    if (containers.length > RI.EVIDENCE_CONTAINERS || pagers.length > RI.EVIDENCE_PAGERS) return null;
    for (const c of containers) {
      if (!mine(c)) continue;
      for (const attr of ['total-items', 'items-count', 'data-total-items']) {
        const v = typeof c.getAttribute === 'function' ? c.getAttribute(attr) : null;
        if (typeof v === 'string' && /^\d{1,3}$/.test(v.trim())) totals.add(parseInt(v, 10));
      }
    }
    // the native gallery states its size in the pagination indicator of its own open shadow roots (pages="N"; the aria-live text is localised, never read)
    for (const c of containers) {
      if (c.tagName !== 'GALLERY-CAROUSEL' || !mine(c)) continue;
      const outer = c.shadowRoot || null;
      const inner = outer && typeof outer.querySelector === 'function' ? (outer.querySelector('faceplate-carousel') || null) : null;
      const indicators = [];
      for (const root of [outer, inner && inner.shadowRoot]) if (root && typeof root.querySelectorAll === 'function') indicators.push(...Array.from(root.querySelectorAll('faceplate-pagination-indicator')));
      if (indicators.length > RI.EVIDENCE_PAGERS) return null;
      for (const ind of indicators) { const v = riAttr(ind, 'pages'); if (/^\d{1,3}$/.test(v.trim())) totals.add(parseInt(v, 10)); }
    }
    for (const p of pagers) {
      if (!mine(p)) continue;
      const text = String(p.textContent || (typeof p.getAttribute === 'function' ? p.getAttribute('aria-label') : '') || '').trim();
      const m = text.match(/^\d{1,3}\s*(?:\/|of)\s*(\d{1,3})$/i);
      if (m) totals.add(parseInt(m[1], 10));
    }
    return totals.size === 1 ? totals.values().next().value : null;
  }

  // The list is the whole gallery only when the declared total equals the enumerated distinct slots (2..20, every slot identifiable,
  // enumeration not cut). Anything else is Save this only; a count of rendered images is never evidence.
  function riGalleryProof(owner, items, truncated = false) {
    const n = items ? items.length : 0;
    const declared = riDeclaredTotal(owner);
    const isComplete = !truncated && declared !== null && declared === n && n >= RI.BATCH_MIN && n <= RI.BATCH_MAX && items.every((i) => i.key) &&
      new Set(items.map((i) => i.key)).size === n;
    return { isComplete, count: n, declared };
  }

  // The hovered node is one of the list's slots: the node itself or the player that holds it (a <video> inside its shreddit-player is one slot)
  const riHas = (items, el) => items.some((i) => i.el === el || (typeof i.el.contains === 'function' && i.el.contains(el)) ||
    (i.slide && typeof i.slide.contains === 'function' && i.slide.contains(el)));

  function riCountFor(owner, el) {
    const items = riEnumerate(owner);
    if (!items.isComplete || !riHas(items, el)) return 0;
    return items.length;
  }

  const riSize = () => (riState.count >= 2
    ? (riState.compact ? { w: RI.COMPACT_W, h: RI.COMPACT_H } : { w: RI.MULTI_W, h: RI.MULTI_H })
    : { w: RI.SIZE, h: RI.SIZE });

  function riPlan(el, snap) {
    const owner = snap.ownerRef.deref();
    const n = riCountFor(owner, el);
    if (n >= 2) {
      const wide = riLayout(el, owner, RI.MULTI_W, RI.MULTI_H);
      if (wide) return { n, compact: false, lay: wide };
      const compact = riLayout(el, owner, RI.COMPACT_W, RI.COMPACT_H);
      return compact ? { n, compact: true, lay: compact } : null;
    }
    const lay = riLayout(el, owner, RI.SIZE, RI.SIZE);
    return lay ? { n: 0, compact: false, lay } : null;
  }

  function riHeldPlan(el, owner) {
    const s = riSize();
    const lay = riLayout(el, owner, s.w, s.h);
    return lay ? { n: riState.count, lay } : null;
  }

  function riIcon() {
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

  function riButtonCss(btn, tier, isAll) {
    const s = btn.style;
    const width = tier === 'wide' ? RI.MULTI_W : (tier === 'compact' && isAll ? RI.COMPACT_W - RI.SIZE - 4 : RI.SIZE);
    const height = tier === 'wide' ? 28 : RI.SIZE;
    for (const [k, v] of [
      ['all', 'initial'],
      ['box-sizing', 'border-box'],
      ['display', 'flex'],
      ['align-items', 'center'],
      ['justify-content', 'center'],
      ['gap', tier === 'wide' ? '6px' : '2px'],
      ['width', `${width}px`],
      ['height', `${height}px`],
      ['border-radius', '9999px'],
      ['border', '1px solid rgba(255,255,255,0.55)'],
      ['background', 'rgba(15,20,25,0.78)'],
      ['color', '#fff'],
      ['cursor', 'pointer'],
      ['padding', tier === 'wide' ? '0 10px' : (tier === 'compact' && isAll ? '0 4px' : '0')],
      ['font', '600 12px/1 system-ui, -apple-system, Segoe UI, sans-serif'],
      ['white-space', 'nowrap']
    ]) s.setProperty(k, v);
  }

  function riMakeButton(onClick, which) {
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    const icon = riIcon();
    if (icon) btn.appendChild(icon);
    const lbl = document.createElement('span');
    btn.appendChild(lbl);
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'touchstart', 'touchend']) {
      btn.addEventListener(type, (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); });
    }
    btn.addEventListener('click', onClick, true);
    btn.addEventListener('keydown', (e) => riOnButtonKey(e, which), true);
    return { btn, lbl };
  }

  function riEnsureHost() {
    if (riState.host) return riState.host;
    const host = document.createElement('div');
    host.setAttribute('data-image-saver-inline', 'reddit');
    const hs = host.style;
    hs.setProperty('position', 'absolute');
    hs.setProperty('z-index', String(RI.Z));
    hs.setProperty('display', 'flex');
    hs.setProperty('flex-direction', 'column');
    hs.setProperty('align-items', 'flex-end');
    hs.setProperty('gap', '4px');
    hs.setProperty('width', `${RI.SIZE}px`);
    hs.setProperty('height', `${RI.SIZE}px`);
    hs.setProperty('margin', '0');
    hs.setProperty('padding', '0');
    const root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
    const one = riMakeButton(riOnClick, 'this');
    const all = riMakeButton(riOnClickAll, 'all');
    root.appendChild(one.btn);
    root.appendChild(all.btn);
    riState.host = host;
    riState.btn = one.btn;
    riState.lbl = one.lbl;
    riState.btnAll = all.btn;
    riState.lblAll = all.lbl;
    riRender(0, false);
    return host;
  }

  function riRender(n, compact = false) {
    const multi = n >= 2;
    riState.count = multi ? n : 0;
    riState.compact = multi && compact === true;
    const { btn, lbl, btnAll, lblAll } = riState;
    if (!btn || !btnAll) return;
    const tier = !multi ? 'single' : (compact ? 'compact' : 'wide');
    riButtonCss(btn, tier, false);
    riButtonCss(btnAll, tier, true);
    const hs = riState.host && riState.host.style;
    if (hs) {
      hs.setProperty('flex-direction', tier === 'compact' ? 'row' : 'column');
      hs.setProperty('align-items', tier === 'compact' ? 'center' : 'flex-end');
      hs.setProperty('justify-content', 'flex-end');
    }
    isLabel(btn, 'aria-label', 'inline.saveThisAria', 'MediaLatch: Save this media');
    isLabel(btn, 'title', 'inline.saveThisAria', 'MediaLatch: Save this media');
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

  function riApply(lay) {
    const host = riEnsureHost();
    if (host.parentNode !== lay.host) lay.host.appendChild(host);
    host.style.setProperty('width', `${lay.w}px`);
    host.style.setProperty('height', `${lay.h}px`);
    host.style.setProperty('left', `${lay.left}px`);
    host.style.setProperty('top', `${lay.top}px`);
  }

  function riHide() {
    if (riState.timer) { clearTimeout(riState.timer); riState.timer = null; }
    if (riState.settleTimer) { clearTimeout(riState.settleTimer); riState.settleTimer = null; }
    if (riState.rearmTimer) { clearTimeout(riState.rearmTimer); riState.rearmTimer = null; }
    if (riState.observer) { try { riState.observer.disconnect(); } catch (_) {} riState.observer = null; }
    riState.snap = null;
    riState.el = null;
    riState.keyEl = null;
    riState.sig = '';
    riState.settleN = 0;
    riState.rearmN = 0;
    if (riState.host && typeof riState.host.remove === 'function') riState.host.remove();
  }

  function riHideUntilVisible() {
    const n = riState.rearmN;
    riHide();
    riState.rearmN = n;
    if (n >= RI.SETTLE_MAX || riState.rearmTimer) return;
    riState.rearmN = n + 1;
    riState.rearmTimer = setTimeout(() => { riState.rearmTimer = null; riEvaluate(); }, RI.SETTLE_MS);
  }

  function riRecheck() {
    riState.settleTimer = null;
    const snap = riState.snap;
    if (!snap) return;
    const el = snap.elRef.deref();
    const owner = snap.ownerRef.deref();
    if (!(el && owner && riHolds(snap))) { riHide(); return; }
    const plan = riPlan(el, snap);
    if (!plan) { riHideUntilVisible(); return; }
    if (plan.n !== riState.count || plan.compact !== riState.compact) riRender(plan.n, plan.compact);
    riApply(plan.lay);
    if (plan.lay.sig !== riState.sig) {
      riState.sig = plan.lay.sig;
      if (riState.settleN < RI.SETTLE_MAX) { riState.settleN++; riState.settleTimer = setTimeout(riRecheck, RI.SETTLE_MS); }
    } else {
      riState.settleN = 0;
    }
  }

  function riShow(el, snap, plan) {
    riEnsureHost();
    riState.snap = snap;
    riState.el = el;
    riState.sig = plan.lay.sig;
    riState.settleN = 0;
    if (riState.settleTimer) { clearTimeout(riState.settleTimer); riState.settleTimer = null; }
    riRender(plan.n, plan.compact);
    riApply(plan.lay);
    if (riState.observer) { try { riState.observer.disconnect(); } catch (_) {} riState.observer = null; }
    if (typeof MutationObserver === 'function') {
      let pending = false;
      const host = riState.host;
      riState.observer = new MutationObserver((records) => {
        if (Array.isArray(records) && records.length && records.every((rec) => rec && rec.target === host)) return;
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; if (riState.snap) riRecheck(); }, RI.SETTLE_MS);
      });
      const owner = snap.ownerRef.deref();
      if (owner) {
        riState.observer.observe(owner, { childList: true, subtree: true });
        riState.observer.observe(el, { attributes: true, attributeFilter: ['src', 'poster', 'style', 'class'] });
        for (const ref of snap.chain) {
          const node = ref.deref();
          if (node) riState.observer.observe(node, { attributes: true, attributeFilter: ['style', 'class'] });
        }
      }
    }
  }

  function riEvaluate() {
    riState.timer = null;
    try {
      if (document.hidden) { riHide(); return; }
      const href = (typeof location !== 'undefined' && location.href) || '';
      if (href !== riState.href) { riState.href = href; riHide(); }
      if (typeof document.elementsFromPoint !== 'function') return;
      const cand = riCandidate(document.elementsFromPoint(riState.x, riState.y));
      if (!cand) { riHide(); return; }
      if (riState.dismissed && riState.dismissed === cand.el) return;
      const held = riState.snap && riState.snap.elRef.deref() === cand.el && riHolds(riState.snap) ? riState.snap : null;
      const snap = held || riSnapshot(cand.el, cand.kind);
      if (!snap) { riHide(); return; }
      const plan = held ? riHeldPlan(cand.el, snap.ownerRef.deref()) : riPlan(cand.el, snap);
      if (!plan) { riHideUntilVisible(); return; }
      if (!riPointIn(plan.lay.vis, riState.x, riState.y)) { riHide(); return; }
      riState.rearmN = 0;
      if (held) { riApply(plan.lay); riState.sig = plan.lay.sig; return; }
      riShow(cand.el, snap, plan);
    } catch (_) {
      riHide();
    }
  }

  function riOnMove(e) {
    if (!e || (e.pointerType && e.pointerType !== 'mouse')) return;
    riState.x = e.clientX;
    riState.y = e.clientY;
    riState.rearmN = 0;
    if (!riState.timer) riState.timer = setTimeout(riEvaluate, RI.HOVER_MS);
  }

  // A cross-origin iframe takes the pointer from this document: no pointermove arrives while it is over the frame, only the entry onto it.
  function riOnOver(e) {
    const t = e && e.target;
    if (t && (t.tagName === 'IFRAME' || t.tagName === 'SHREDDIT-EMBED')) riOnMove(e);
  }

  function riMediaWithin(node) {
    if (!node) return null;
    if (node.tagName === 'VIDEO' || node.tagName === 'SHREDDIT-PLAYER') return node;
    const embed = riEmbedOf(node);
    if (embed) return embed.host;
    if (node.tagName === 'IMG' && riImageKind(riImgSrc(node))) return node;
    if (typeof node.querySelectorAll !== 'function') return null;
    const list = Array.from(node.querySelectorAll('shreddit-player, video, img')).filter(
      (m) => m.tagName === 'VIDEO' || m.tagName === 'SHREDDIT-PLAYER' || riImageKind(riImgSrc(m))
    );
    return list.length === 1 ? list[0] : null;
  }

  function riOnFocusIn(e) {
    try {
      const t = e && e.target;
      if (!t || (riState.host && (t === riState.host || (typeof riState.host.contains === 'function' && riState.host.contains(t))))) return;
      if (typeof t.closest !== 'function' || !t.closest(RI_POST)) return;
      const el = riMediaWithin(t);
      if (!el) return;
      const kind = (el.tagName === 'VIDEO' || el.tagName === 'SHREDDIT-PLAYER' || riEmbedHost(el)) ? 'video' : riImageKind(riImgSrc(el));
      if (!kind || riState.dismissed === t) return;
      const snap = riSnapshot(el, kind);
      if (!snap) return;
      const plan = riPlan(el, snap);
      if (!plan) return;
      riShow(el, snap, plan);
      riState.keyEl = t;
    } catch (_) {}
  }

  function riOnFocusOut(e) {
    if (e && riState.dismissed === e.target) riState.dismissed = null;
  }

  function riOnDocKey(e) {
    if (!e || e.key !== 'Tab' || e.shiftKey || !riState.keyEl || !riState.btn || document.activeElement !== riState.keyEl) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof riState.btn.focus === 'function') riState.btn.focus();
  }

  function riOnButtonKey(e, which = 'this') {
    if (!e || (e.key !== 'Tab' && e.key !== 'Escape')) return;
    if (e.key === 'Tab' && riState.count >= 2) {
      if (which === 'this' && !e.shiftKey && riState.btnAll && typeof riState.btnAll.focus === 'function') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        riState.btnAll.focus();
        return;
      }
      if (which === 'all' && e.shiftKey && riState.btn && typeof riState.btn.focus === 'function') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        riState.btn.focus();
        return;
      }
    }
    const back = riState.keyEl;
    if (e.key === 'Tab' && typeof e.preventDefault === 'function') e.preventDefault();
    riState.dismissed = back || null;
    riHide();
    if (back && typeof back.focus === 'function') back.focus();
  }

  const riToken = () => {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  function riSend(message, token, pending) {
    try {
      const sent = chrome.runtime.sendMessage(message);
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch (_) {
      if (pending) pending.delete(token);
    }
    if (riState.btn) {
      riState.btn.setAttribute('aria-busy', 'true');
      if (riState.btnAll) riState.btnAll.setAttribute('aria-busy', 'true');
      if (riState.busyTimer) clearTimeout(riState.busyTimer);
      riState.busyTimer = setTimeout(() => {
        riState.busyTimer = null;
        if (riState.btn) riState.btn.removeAttribute('aria-busy');
        if (riState.btnAll) riState.btnAll.removeAttribute('aria-busy');
      }, RI.CLICK_GAP);
    }
  }

  function riOnClick(e) {
    if (e) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    if (!e || e.isTrusted !== true) return;
    const shown = riState.snap;
    const el = shown && shown.elRef.deref();
    const s = riSize();
    const fresh = el ? riSnapshot(el, shown.kind) : null;
    // A stale control is refused: nothing is sent. A cross-origin iframe (a RedGIFs embed) gives this document no pointer event to show a control
    // again, so the refusal re-evaluates from the last pointer place with the existing bounded re-arm; only a freshly proven candidate shows one.
    if (!fresh || !riSame(fresh, shown) || !riHolds(shown) || !riLayout(el, fresh.ownerRef.deref(), s.w, s.h)) { riHideUntilVisible(); return; }
    const key = `${fresh.ownerId}|${fresh.src}`;
    const now = Date.now();
    if (riState.busyKey === key && now - riState.busyAt < RI.CLICK_GAP) return;
    riState.busyKey = key;
    riState.busyAt = now;
    for (const [t, v] of riPending) if (now - v.at > RI.TOKEN_TTL) riPending.delete(t);
    while (riPending.size >= 8) riPending.delete(riPending.keys().next().value);
    const token = riToken();
    riPending.set(token, { snap: fresh, at: now, href: (typeof location !== 'undefined' && location.href) || '' });
    riSend({ action: 'REDDIT_INLINE_SAVE', token }, token, riPending);
  }

  function riOnClickAll(e) {
    if (e) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    if (!e || e.isTrusted !== true) return;
    const shown = riState.snap;
    const el = shown && shown.elRef.deref();
    const owner = shown && shown.ownerRef.deref();
    const s = riSize();
    const fresh = el ? riSnapshot(el, shown.kind) : null;
    if (!fresh || !owner || riState.count < RI.BATCH_MIN || !riSame(fresh, shown) || !riHolds(shown) || !riLayout(el, owner, s.w, s.h)) { riHide(); return; }
    const items = riEnumerate(owner);
    if (!items.isComplete || items.length !== riState.count || items.length > RI.BATCH_MAX || !riHas(items, el)) { riHide(); return; }
    const snaps = [];
    for (const it of items) {
      const snap = riSnapshot(it.el, it.kind);
      if (!snap || snap.ownerRef.deref() !== owner) { riHide(); return; }
      snaps.push(snap);
    }
    const sig = items.sig;
    const key = `all|${fresh.ownerId}|${sig}`;
    const now = Date.now();
    if (riState.busyKey === key && now - riState.busyAt < RI.CLICK_GAP) return;
    riState.busyKey = key;
    riState.busyAt = now;
    for (const [t, v] of riBatches) if (now - v.at > RI.BATCH_TTL) riBatches.delete(t);
    while (riBatches.size >= 4) riBatches.delete(riBatches.keys().next().value);
    const token = riToken();
    riBatches.set(token, {
      items: snaps.map((snap) => ({ snap, used: false })),
      href: (typeof location !== 'undefined' && location.href) || '',
      at: now,
      opened: false,
      sig,
      keys: items.keys.slice(),
      ownerId: fresh.ownerId,
      count: snaps.length
    });
    riSend({ action: 'REDDIT_INLINE_SAVE_ALL', token }, token, riBatches);
  }

  function riDescribe(snap, index = null, count = null) {
    if (!snap) return { ok: false, reason: 'NO_MEDIA' };
    const el = snap.elRef ? snap.elRef.deref() : null;
    const owner = snap.ownerRef ? snap.ownerRef.deref() : null;
    if (!el || !owner || el.isConnected === false || owner.isConnected === false) {
      return { ok: false, reason: 'STALE_OWNER' };
    }

    const idInfo = riIdOf(owner, snap.isCrosspost);
    if (!idInfo || !idInfo.ownerId) return { ok: false, reason: 'STALE_OWNER' };
    const ownerId = idInfo.ownerId;
    const postUrl = idInfo.postUrl || null;

    // a RedGIFs embed: the proven clip, as the canonical embed address; the background finds the frame of that clip and resolves it there
    if (riEmbedHost(el)) {
      const embed = riEmbedOf(el);
      if (!embed || embed.owner !== owner) return { ok: false, reason: 'STALE_OWNER' };
      const media = { kind: 'video', url: `https://www.redgifs.com/ifr/${embed.clip}`, ownerId, redgifsEmbed: true };
      if (postUrl) media.postUrl = postUrl;
      return { ok: true, media };
    }

    let url = '';
    let kind = snap.kind === 'video' ? 'video' : 'image';
    let blobPlayer = false;

    if (snap.kind === 'video' || el.tagName === 'VIDEO' || el.tagName === 'SHREDDIT-PLAYER' || el.closest?.('shreddit-player')) {
      kind = 'video';
      const player = el.tagName === 'SHREDDIT-PLAYER' ? el : el.closest?.('shreddit-player');
      if (player) {
        const candidate = extractDirectCandidateFromPlayer(player, postUrl);
        if (candidate && candidate.url && !candidate.url.startsWith('blob:')) {
          url = candidate.url;
          blobPlayer = true;
        } else {
          const fallback = findRedditDirectMediaForBlob(player, [player, owner], '');
          if (fallback && fallback.url && !fallback.url.startsWith('blob:')) {
            url = fallback.url;
            blobPlayer = true;
          } else {
            // No direct file anywhere: the stream the selected player itself declares (frozen here, never looked up again), or a positively
            // identified stream that cannot be saved. A blob with no declaration stays unresolved.
            const stream = declaredStreamOf(player);
            if (stream && stream.saveable && index === null) {
              const media = { kind: 'video', url: stream.url, ownerId, redditHls: true };
              if (postUrl) media.postUrl = postUrl;
              return { ok: true, media };
            }
            return { ok: false, reason: stream ? 'UNSUPPORTED_STREAM' : 'UNRESOLVED_BLOB' };
          }
        }
      } else if (el.tagName === 'VIDEO') {
        const vSrc = el.currentSrc || el.src || '';
        if (vSrc.startsWith('blob:')) {
          const direct = findRedditDirectMediaForBlob(el, [el, owner], vSrc);
          if (direct && direct.url && !direct.url.startsWith('blob:')) {
            url = direct.url;
            blobPlayer = true;
          } else {
            return { ok: false, reason: 'UNRESOLVED_BLOB' };
          }
        } else if (vSrc) {
          url = vSrc;
          blobPlayer = false;
        } else {
          return { ok: false, reason: 'NO_MEDIA' };
        }
      }
    } else {
      kind = 'image';
      url = riImgSrc(el);
      if (!url) return { ok: false, reason: 'NO_MEDIA' };
      const ik = riImageKind(url);
      if (!ik) return { ok: false, reason: 'NO_MEDIA' };
    }

    if (!url || typeof url !== 'string' || !url.startsWith('https://') || url.length > 2048) {
      return { ok: false, reason: 'NO_MEDIA' };
    }

    const media = {
      kind,
      url,
      ownerId
    };
    if (postUrl) {
      media.postUrl = postUrl;
    }
    if (blobPlayer) {
      media.blobPlayer = true;
    }
    if (index !== null && count !== null) {
      media.index = index;
      media.count = count;
    }

    return { ok: true, media };
  }

  function riAnswerOwner(token) {
    const entry = typeof token === 'string' ? riPending.get(token) : null;
    riPending.delete(token);
    if (!entry || Date.now() - entry.at > RI.TOKEN_TTL) return { ok: false, reason: 'NO_TOKEN' };
    const snap = entry.snap;
    if (!riHolds(snap)) return { ok: false, reason: 'STALE_OWNER' };
    const el = snap.elRef.deref();
    const owner = snap.ownerRef.deref();
    const href = (typeof location !== 'undefined' && location.href) || '';
    if (href !== entry.href) return { ok: false, reason: 'STALE_OWNER' };
    if (!riLayout(el, owner, RI.SIZE, RI.SIZE)) return { ok: false, reason: 'STALE_OWNER' };
    return riDescribe(snap);
  }

  function riOwnerHolds(snap, entry) {
    try {
      const owner = snap.ownerRef.deref();
      if (!owner || owner.isConnected === false) return false;
      const href = (typeof location !== 'undefined' && location.href) || '';
      if (href !== entry.href) return false;
      const idInfo = riIdOf(owner, snap.isCrosspost);
      if (!idInfo || idInfo.ownerId !== snap.ownerId) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  // The owner's list as it is now against the one the batch was started for (contract amendment 4): the owner connected, complete again
  // by positive evidence, the same count, the same order and the same slot identities. null means the structure changed.
  function riListHolds(entry) {
    const owner = entry.items[0].snap.ownerRef.deref();
    if (!owner || owner.isConnected === false) return null;
    const now = riEnumerate(owner);
    const same = now.isComplete && now.length === entry.count && now.every((it, i) => it.key === entry.keys[i]);
    return same ? now : null;
  }

  // Phase 1 of a batch: the page, the owner and the whole list (completeness, count, order, identities) are proven again and every item is
  // described; a changed structure or an owner mismatch ends the batch, an item that cannot be described fails alone later.
  function riBatchOpen(token) {
    const entry = typeof token === 'string' ? riBatches.get(token) : null;
    if (!entry || Date.now() - entry.at > RI.BATCH_TTL) { riBatches.delete(token); return { ok: false, reason: 'NO_TOKEN' }; }
    if (entry.opened) return { ok: false, reason: 'USED' };
    entry.opened = true;
    const refuse = (reason) => { riBatches.delete(token); return { ok: false, reason }; };
    // riOwnerHolds also compares the page URL and the owner's id
    if (!entry.items.every((it) => riOwnerHolds(it.snap, entry))) return refuse('STALE_OWNER');
    if (!riListHolds(entry)) return refuse('STALE_LIST');
    let described = 0;
    entry.items.forEach((it, i) => { if (riHolds(it.snap) && riDescribe(it.snap, i, entry.count).ok) described++; });
    if (!described) return refuse('NO_MEDIA');
    return { ok: true, count: entry.count, ownerId: entry.ownerId, sig: entry.sig };
  }

  function riBatchItem(token, index) {
    const entry = typeof token === 'string' ? riBatches.get(token) : null;
    if (!entry || Date.now() - entry.at > RI.BATCH_TTL) { riBatches.delete(token); return { ok: false, reason: 'NO_TOKEN' }; }
    const item = Number.isInteger(index) && index >= 0 && index < entry.items.length ? entry.items[index] : null;
    if (!item || !entry.opened) return { ok: false, reason: 'NO_TOKEN' };
    if (item.used) return { ok: false, reason: 'USED' };
    item.used = true;
    if (entry.items.every((it) => it.used)) riBatches.delete(token);
    const href = (typeof location !== 'undefined' && location.href) || '';
    if (href !== entry.href || !riOwnerHolds(item.snap, entry)) return { ok: false, reason: 'STALE_OWNER' };
    // right before the item runs the whole list is proven again: a changed structure ends the batch, only this slot's own change is item-level
    const now = riListHolds(entry);
    if (!now) return { ok: false, reason: 'STALE_LIST' };
    const el = item.snap.elRef.deref();
    if (!el || now[index].el !== el || !riHolds(item.snap)) return { ok: false, reason: 'STALE_ITEM' };
    const described = riDescribe(item.snap, index, entry.count);
    if (described.ok) described.media.sig = entry.sig;
    return described;
  }

  function riTeardown() {
    riHide();
    riPending.clear();
    riBatches.clear();
    if (riState.busyTimer) { clearTimeout(riState.busyTimer); riState.busyTimer = null; }
    if (riState.host && typeof riState.host.remove === 'function') riState.host.remove();
    riState.host = null;
    riState.btn = null;
    riState.btnAll = null;
    riState.lbl = null;
    riState.lblAll = null;
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    document.addEventListener('pointermove', riOnMove, { capture: true, passive: true });
    document.addEventListener('pointerover', riOnOver, { capture: true, passive: true });
    document.addEventListener('focusin', riOnFocusIn, true);
    document.addEventListener('focusout', riOnFocusOut, true);
    document.addEventListener('keydown', riOnDocKey, true);
    document.addEventListener('visibilitychange', riHide, true);
    for (const type of ['scroll', 'wheel', 'resize', 'popstate']) window.addEventListener(type, riHide, { capture: true, passive: true });
    window.addEventListener('blur', (e) => { if (e.target === window) riHide(); }, true);
    window.addEventListener('pagehide', riTeardown, true);
  }

  // Export functions to global scope for testing in test_suite.js
  if (typeof globalThis !== 'undefined') {
    globalThis.normalizeRedditPostUrl = normalizeRedditPostUrl;
    globalThis.extractRedditPostUrl = extractRedditPostUrl;
    globalThis.isRedditAnimationUrl = isRedditAnimationUrl;
    globalThis.isRedditNativeGifUrl = isRedditNativeGifUrl;
    globalThis.resolveRedditMediaDescriptor = resolveRedditMediaDescriptor;
    globalThis.findRedditMediaFromTargetAndPath = findRedditMediaFromTargetAndPath;
    globalThis.__findRedditMediaFromTargetAndPath = findRedditMediaFromTargetAndPath;
    globalThis.__resolveRedditMediaDescriptor = resolveRedditMediaDescriptor;
    globalThis.extractDirectCandidateFromPlayer = extractDirectCandidateFromPlayer;
    globalThis.extractDirectCandidateFromPost = extractDirectCandidateFromPost;
    globalThis.findRedditDirectMediaForBlob = findRedditDirectMediaForBlob;
    globalThis.getPostLogicalVideoItems = getPostLogicalVideoItems;
    globalThis.setLastRedditContextmenuTarget = (target, path = []) => {
      lastContextmenuTarget = target;
      lastContextmenuPath = Array.isArray(path) ? path : (target ? [target] : []);
      lastContextmenuTime = Date.now();
      lastContextmenuPoint = null;
      lastDetectedMedia = null;
    };
    globalThis.__riState = riState;
    globalThis.__riPending = riPending;
    globalThis.__riBatches = riBatches;
    globalThis.__riCandidate = riCandidate;
    globalThis.__riImageKind = riImageKind;
    globalThis.__riOwnerOf = riOwnerOf;
    globalThis.__riEmbedOf = riEmbedOf;
    globalThis.__riIdOf = riIdOf;
    globalThis.__riSlotKey = riSlotKey;
    globalThis.__riAssetId = riAssetId;
    globalThis.__riEnumerate = riEnumerate;
    globalThis.__riGalleryProof = riGalleryProof;
    globalThis.__riDeclaredTotal = riDeclaredTotal;
    globalThis.__riListHolds = riListHolds;
    globalThis.__riCountFor = riCountFor;
    globalThis.__riLayout = riLayout;
    globalThis.__riCovered = riCovered;
    globalThis.__riPlan = riPlan;
    globalThis.__riSnapshot = riSnapshot;
    globalThis.__riHolds = riHolds;
    globalThis.__riDescribe = riDescribe;
    globalThis.__riAnswerOwner = riAnswerOwner;
    globalThis.__riBatchOpen = riBatchOpen;
    globalThis.__riBatchItem = riBatchItem;
    globalThis.__riTeardown = riTeardown;
    globalThis.__riEvaluate = riEvaluate;
    globalThis.__riOnMove = riOnMove;
    globalThis.__riOnClick = riOnClick;
    globalThis.__riOnClickAll = riOnClickAll;
    globalThis.__riEnsureHost = riEnsureHost;
    globalThis.__riHide = riHide;
    globalThis.__RI = RI;
  }
})();
