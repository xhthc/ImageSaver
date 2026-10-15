// content/content_reddit.js - Reddit DOM detection and post metadata extraction for MediaLatch
(() => {
  // DEBUG-MENU-01: the shared journal client (lib/debug_journal.js); a no-op when it is absent. Never an authority, never sees a token.
  const DBG = (globalThis.ImageSaverDebug && globalThis.ImageSaverDebug.client('content')) || { log() {}, cid() { return ''; }, enabled() { return false; } };
  DBG.log('reddit', 'init', 'info', undefined, () => ({ frame: window !== window.top ? 1 : 0 }));
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
        bindGestureAuthor(event);
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
      bindGestureAuthor(event);
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

  // PIXIV-SAVING-POLISH-01 / UNIVERSAL-SELECTION-SNAPSHOT-01 (author folders): the author of the post that owns the selected media, fixed when
  // the selection is admitted and never read from the page again. An inline save carries it in its proven descriptor (riAuthored). A context-menu
  // save is admitted by the background's injected verifier (verifyContextOwner), which calls admitContextAuthor in this same isolated world while
  // its proof holds; a later question names that admission's proof token. The owner rules are the inline control's (riOwnerOf/riIdOf/riEmbedOf):
  // comments, search cards, lightboxes, crossposts and nested posts give none; a link post qualifies only through its proven RedGIFs embed.
  const AUTHOR_POST_TYPES = new Set(['image', 'gallery', 'gif', 'video']);
  // { post, ownerId, author } of the post that owns `node` now, or null
  function postAuthorOf(node) {
    const o = node ? riOwnerOf(node) : null;
    const post = o && !o.isCrosspost && o.owner && o.owner.tagName === 'SHREDDIT-POST' && o.owner.isConnected !== false ? o.owner : null;
    if (!post) return null;
    const type = post.getAttribute('post-type');
    const embed = type === 'link' && (() => { const x = riEmbedOf(node); return x && x.owner === post; })();
    const id = (riIdOf(post) || {}).ownerId || '', author = post.getAttribute('author') || '';
    return id && (AUTHOR_POST_TYPES.has(type) || embed) && /^[A-Za-z0-9_-]{3,20}$/.test(author) ? { post, ownerId: id, author } : null;
  }
  // The owning post as the trusted right-click found it, bound to the pressed node the gesture capture keeps (composedPath()[0]).
  let gestureAuthor = null;
  function bindGestureAuthor(event) {
    gestureAuthor = null;
    try {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const pressed = path[0] || event.target;
      const a = event.isTrusted && pressed ? postAuthorOf(pressed) : null;
      if (a) gestureAuthor = { node: new WeakRef(pressed), post: new WeakRef(a.post), ownerId: a.ownerId, author: a.author };
    } catch (_) {}
  }
  // Admission of a context-menu save (called synchronously by the verifier while its proof holds): the selected media's post now must be the very
  // post the gesture found, with the same id and author; then that author is frozen under the admission's proof. A recycled post, moved media or
  // another gesture before admission gives none; later scrolling, removal or recycling cannot change the frozen answer. Bounded, one-shot.
  const admittedAuthors = new Map();
  function admitContextAuthor(proof, pressed, media) {
    if (typeof proof !== 'string' || !proof) return;
    const now = postAuthorOf(media || pressed), bound = gestureAuthor;
    const same = now && bound && bound.node.deref() === pressed && bound.post.deref() === now.post && bound.ownerId === now.ownerId && bound.author === now.author;
    admittedAuthors.set(proof, same ? { ownerId: now.ownerId, author: now.author } : null);
    while (admittedAuthors.size > 8) admittedAuthors.delete(admittedAuthors.keys().next().value);
  }
  globalThis.__imageSaverAdmitRedditAuthor = admitContextAuthor;
  function selectedPostAuthor(proof) {
    const a = admittedAuthors.get(proof) || null;
    admittedAuthors.delete(proof);
    return a;
  }
  // an inline descriptor carries its post's author, proven with the descriptor itself
  function riAuthored(described, snap) {
    if (described && described.ok && described.media) {
      const a = postAuthorOf(snap && snap.elRef ? snap.elRef.deref() : null);
      if (a && a.ownerId === described.media.ownerId) described.media.author = a.author;
    }
    return described;
  }

  // Runtime messaging interface for background script
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.action === 'GET_REDDIT_POST_AUTHOR') {
        sendResponse(selectedPostAuthor(typeof message.proof === 'string' ? message.proof : '') || {});
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
    });
  }

  // --- UX-11-RD: the owner rules the inline Save control (content/content_inline.js) and the context menu share ---
  // Which container owns a node, its post id and the RedGIFs embed of a link post. The control itself (candidates, placement, galleries, "Save all", tokens,
  // descriptors) lives in content_inline.js and reaches these through globalThis.__medialatchSite.reddit.
  const RI_POST = 'shreddit-post, [data-testid="search-post"], [data-testid="search-post-unit"], article, [role="article"]';
  const RI_CROSSPOST = '[data-testid="crosspost-post"], [slot="crosspost-post"], [data-testid="crosspost-root"], crosspost-container';

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

    // A /comments/<id>/ address: the first gives the id and the address, a later one only fills the address of that same id.
    const takePostHref = (href) => {
      const m = href.match(/\/comments\/([a-z0-9]{1,12})(?:\/|$)/i);
      if (!m) return false;
      const candId = m[1].toLowerCase();
      if (!rawId) { rawId = candId; postUrl = normalizeRedditPostUrl(href); return true; }
      if (candId === rawId && !postUrl) { postUrl = normalizeRedditPostUrl(href); return true; }
      return false;
    };

    // 2. permalink or content-href on owner
    for (const attr of ['permalink', 'content-href', 'data-permalink']) {
      const href = typeof owner.getAttribute === 'function' ? owner.getAttribute(attr) : null;
      if (href && typeof href === 'string' && takePostHref(href)) break;
    }

    // 3. Child anchor tags inside owner
    if ((!rawId || !postUrl) && typeof owner.querySelectorAll === 'function') {
      const anchors = Array.from(owner.querySelectorAll('a[href*="/comments/"]')).slice(0, 20);
      for (const a of anchors) {
        if (!isCrosspost && typeof a.closest === 'function' && a.closest(RI_CROSSPOST)) continue;
        const href = (typeof a.getAttribute === 'function' && a.getAttribute('href')) || a.href || '';
        if (takePostHref(href)) break;
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
    globalThis.__riOwnerOf = riOwnerOf;
    globalThis.__riEmbedOf = riEmbedOf;
    globalThis.__riIdOf = riIdOf;
    globalThis.__medialatchSite = Object.assign(globalThis.__medialatchSite || {}, {
      reddit: {
        post: RI_POST, ownerOf: riOwnerOf, idOf: riIdOf, authored: riAuthored, attr: riAttr, embed: { host: riEmbedHost, frame: riEmbedFrame, src: riEmbedSrc, of: riEmbedOf },
        isAnimationUrl: isRedditAnimationUrl, isNativeGifUrl: isRedditNativeGifUrl, isPreviewVideo, firstMainVideo, declaredStreamOf, playerCandidate: extractDirectCandidateFromPlayer, blobFallback: findRedditDirectMediaForBlob
      }
    });
  }
})();
