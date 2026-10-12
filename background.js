// ba kground.js - Service Worker for MediaLatch extension (v2.0.0)
// Universal modular architecture for downloading maximum resolution images across the web

// Shared download-folder rules (also used by popup/popup.js so preview == runtime).
if (typeof importScripts === 'function') importScripts('lib/folder_path.js');
const FolderPath = globalThis.ImageSaverFolderPath;
// English / Russian interface text (UI-LOCALIZATION-01): notifications follow the saved language preference.
if (typeof importScripts === 'function') importScripts('lib/i18n.js');
if (typeof importScripts === 'function') importScripts('lib/feedback.js');
if (typeof importScripts === 'function') importScripts('lib/feedback_tracker.js');
if (typeof importScripts === 'function') importScripts('lib/feedback_history.js');
if (typeof importScripts === 'function') importScripts('lib/statistics.js');
if (typeof importScripts === 'function') importScripts('lib/download_manager.js');
if (typeof importScripts === 'function') importScripts('lib/export_directory.js');
if (typeof importScripts === 'function') importScripts('lib/debug_journal.js');
const FeedbackLib = globalThis.ImageSaverFeedback;
const directoryStore=typeof indexedDB!=='undefined' && globalThis.MediaLatchDirectory?MediaLatchDirectory.database(indexedDB):null;
const isFileExport=id=>globalThis.MediaLatchDirectory?.isExportId(id)===true;

// ============================================================================
// 0. DEBUG-MENU-01: the opt-in debug journal (lib/debug_journal.js)
// ============================================================================
// The worker is the journal's only writer. Its own events (dbg) and the events of content scripts, frames and extension pages
// (DEBUG_EVENT, context derived from the sender) are recorded only while `debugEnabled === true`; until the preference is read at a
// cold start at most DEBUG_EARLY_MAX events wait and are kept only if recording is on. The journal lives in IndexedDB (a large value in
// chrome.storage would be broadcast to every content script's storage.onChanged); only the preference is in chrome.storage.local.
// Nothing here can alter or block a save: every call is guarded and fire-and-forget.
var debugJournal = null;
var debugState = 'unknown'; // 'unknown' | 'on' | 'off'
var debugEarly = [];
const DEBUG_EARLY_MAX = 200;
const DEBUG_INGEST_PER_SEC = 200;
var debugBucket = { at: 0, n: 0, over: 0, reportedAt: 0 };

function debugIdbStorage() {
  if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.open !== 'function') return null;
  let opening = null;
  const open = () => opening || (opening = new Promise((resolve, reject) => {
    const req = indexedDB.open('medialatch-debug', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  }));
  const run = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('IDB'));
  }));
  return { get: (key) => run('readonly', (s) => s.get(key)), set: (key, value) => run('readwrite', (s) => s.put(value, key)) };
}

function dbgInit() {
  const D = globalThis.ImageSaverDebug;
  if (!D || typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const storage = debugIdbStorage() || {
    get: async (key) => ((await chrome.storage.local.get(key)) || {})[key],
    set: (key, value) => chrome.storage.local.set({ [key]: value })
  };
  const journal = D.createJournal({ storage });
  const flush = journal.flush;
  // a page showing the journal is told after every successful write (extension pages only; content scripts never receive it)
  debugJournal = Object.assign({}, journal, {
    flush: () => flush().then((ok) => { if (ok) dbgNotifyPages(); return ok; })
  });
  const append = journal.append;
  debugJournal.append = (ev, ctx) => { const ok = append(ev, ctx); if (ok) dbgScheduleNotify(); return ok; };
  let touched = false;
  const apply = (on) => {
    debugState = on ? 'on' : 'off';
    const queued = debugEarly;
    debugEarly = [];
    if (on) for (const [ev, ctx] of queued) debugJournal.append(ev, ctx);
  };
  try {
    chrome.storage.onChanged?.addListener?.((changes, area) => {
      if (area === 'local' && changes && changes[D.ENABLED_KEY]) { touched = true; apply(changes[D.ENABLED_KEY].newValue === true); }
    });
    Promise.resolve(chrome.storage.local.get(D.ENABLED_KEY)).then((r) => { if (!touched) apply(Boolean(r) && r[D.ENABLED_KEY] === true); }, () => { if (!touched) apply(false); });
  } catch (_) {
    if (!touched) debugState = 'off';
  }
}

var debugNotifyTimer = null;
function dbgScheduleNotify() {
  if (debugNotifyTimer !== null) return;
  // the journal writes its batch after a short delay; the page is told once that write is done
  debugNotifyTimer = setTimeout(() => { debugNotifyTimer = null; if (debugJournal) void debugJournal.flush(); }, 450);
}
function dbgNotifyPages() {
  try {
    const p = chrome.runtime.sendMessage({ action: 'DEBUG_CHANGED' });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* no page is open */ }
}

function dbgPut(ev, ctx) {
  if (debugState === 'off' || !debugJournal) return;
  if (debugState === 'unknown') { if (debugEarly.length < DEBUG_EARLY_MAX) debugEarly.push([ev, ctx]); return; }
  debugJournal.append(ev, ctx);
}

/** A worker event: dbg(comp, act, out, why?, details? (object or lazy function), extra? { cid, op, lvl, tab, frame }). Never throws. */
function dbg(comp, act, out, why, details, extra) {
  if (debugState === 'off' || !debugJournal) return;
  try {
    const x = extra || {};
    dbgPut({
      t: Date.now(), lvl: x.lvl || (out === 'failed' ? 'warn' : 'info'), comp, act, out, why: why || undefined, cid: x.cid, op: x.op,
      d: typeof details === 'function' ? details() : details
    }, { src: 'worker', tab: x.tab, frame: x.frame });
  } catch (_) { /* a debug failure never reaches the caller */ }
}

/** A correlation id carried by a producer's message (only for the journal; never an authority for anything). */
function dbgCidOf(message) {
  return message && typeof message.dbg === 'string' && /^[a-f0-9]{8,16}$/.test(message.dbg) ? message.dbg : undefined;
}
function dbgNewCid() {
  try { return globalThis.ImageSaverDebug ? Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('') : undefined; } catch (_) { return undefined; }
}

/** DEBUG_EVENT from the extension's own content scripts and pages; the context comes from the sender, never from the event. */
function dbgIngest(raw, sender) {
  if (debugState === 'off' || !debugJournal || !sender || sender.id !== chrome.runtime.id) return;
  const base = chrome.runtime.getURL('');
  const url = typeof sender.url === 'string' ? sender.url : '';
  let ctx = null;
  if (url.startsWith(base)) {
    const path = url.slice(base.length).split(/[?#]/)[0];
    const src = path === 'popup/popup.html' ? 'settings' : path === 'popup/quick.html' ? 'popup' : path === 'offscreen.html' ? 'offscreen' : '';
    if (src) ctx = { src };
  } else if (sender.tab && Number.isInteger(sender.tab.id)) {
    ctx = {
      src: Number.isInteger(sender.frameId) && sender.frameId > 0 ? 'frame' : 'content',
      tab: sender.tab.id,
      frame: Number.isInteger(sender.frameId) ? sender.frameId : undefined,
      doc: typeof sender.documentId === 'string' ? sender.documentId.slice(0, 8) : undefined,
      page: url
    };
  }
  if (!ctx) return;
  const now = Date.now();
  if (now - debugBucket.at >= 1000) { debugBucket.at = now; debugBucket.n = 0; }
  if (++debugBucket.n > DEBUG_INGEST_PER_SEC) {
    debugBucket.over++;
    if (now - debugBucket.reportedAt >= 5000) {
      debugBucket.reportedAt = now;
      dbg('debug', 'ingest', 'skipped', 'RATE_LIMIT', { count: debugBucket.over });
      debugBucket.over = 0;
    }
    return;
  }
  dbgPut(raw, ctx);
}

/** A reason code for the journal, or undefined (free text never becomes a reason). */
function dbgCode(x) {
  return typeof x === 'string' && /^[A-Z][A-Z0-9_]{1,47}$/.test(x) ? x : (FeedbackLib?.normalizeCode?.(x) || undefined);
}

// ---- journal views of the shared resolution boundaries (the implementations below are unchanged; every caller passes here) ----
async function probeCandidate(candidate) {
  const ok = await probeCandidateImpl(candidate);
  dbg('probe', 'check', ok ? 'ok' : 'failed', ok ? undefined : (candidate && candidate.status === 429 ? 'RATE_LIMIT' : 'PROBE_FAILED'), () => ({
    host: candidate && candidate.url, http: candidate && candidate.status, mime: candidate && candidate.contentType,
    bytes: candidate && candidate.contentLength, source: candidate && candidate.source, tier: candidate && candidate.tier
  }));
  return ok;
}
async function resolveOriginalMediaPlan(...args) {
  let plan = await resolveOriginalMediaPlanImpl(...args);
  const selected = parseZerochanMediaUrl(typeof args[0] === 'object' && args[0] ? args[0].srcUrl : args[0]);
  const original = parseZerochanMediaUrl(plan?.primaryUrl);
  // A missing site session must not turn a Zerochan preview into a successful original save.
  if (selected?.isThumbnail && !plan?.error && (!original?.isFull || original.id !== selected.id)) plan = null;
  dbg('plan', 'select', plan && !plan.error ? 'ok' : 'failed', plan ? dbgCode(plan.error) : 'NO_PLAN', () => (plan ? {
    provider: plan.provider, tier: plan.tier, transport: plan.transport, host: plan.primaryUrl, score: plan.score, http: plan._verificationStatus,
    items: plan.pawchivePostMedia && Array.isArray(plan.pawchivePostMedia.items) ? plan.pawchivePostMedia.items.length : undefined,
    mime: plan.metadata && plan.metadata.contentType, error: dbgCode(plan.failureCode)
  } : null));
  return plan;
}
async function resolveMediaTarget(options = {}) {
  const r = await resolveMediaTargetImpl(options);
  dbg('target', 'resolve', r && r.targetUrl ? 'ok' : 'failed', r ? dbgCode(r.error) : 'NO_TARGET', () => (r ? {
    type: r.type, host: r.targetUrl, reason: dbgCode(r.reason), http: r.status, hls: Boolean(r.redditHls), gesture: Boolean(options.gesturePlayer)
  } : null), { tab: options.tabId, frame: options.frameId });
  return r;
}
async function resolveFrameLocalMedia(options = {}) {
  const r = await resolveFrameLocalMediaImpl(options);
  dbg('frame', 'resolve', r && r.success ? 'ok' : 'failed', r && r.success ? undefined : (r && r.noAnswer ? 'NO_FRAME_ANSWER' : dbgCode(r && r.error)), () => ({
    frame: options.frameId, host: r && r.targetUrl, audio: Boolean(r && r.audio === 'present'), clipId: r && typeof r.clipId === 'string' ? r.clipId : undefined,
    inline: Boolean(options.inlineToken), gesture: Boolean(options.requireGesture)
  }), { tab: options.tabId, frame: options.frameId });
  return r;
}
async function recoverXPostMp4Variant(tabId, mediaDescriptor) {
  const r = await recoverXPostMp4VariantImpl(tabId, mediaDescriptor);
  dbg('x', 'recover', r && r.ok ? 'ok' : 'failed', r && r.ok ? undefined : dbgCode(r && r.error), () => {
    const d = (r && r.diag) || {};
    return {
      how: d.how, point: d.point, id: d.id, sel: d.sel, quote: d.quote, req: d.req, media: d.media, seen: d.seen, variants: d.variants, mp4: d.mp4,
      hls: d.hls === 1, fibers: d.fibers, foreign: d.foreign, edge: d.edge, detail: dbgCode(r && r.detail) ? r.detail : undefined, host: r && r.mp4Url,
      postId: mediaDescriptor && mediaDescriptor.tweetId, mediaId: mediaDescriptor && mediaDescriptor.mediaIdHint, isQuote: Boolean(mediaDescriptor && mediaDescriptor.isQuoteTweet)
    };
  }, { tab: tabId });
  return r;
}
async function verifyFinalMediaMime(targetUrl, mediaPlan, isVideoContext) {
  const mime = await verifyFinalMediaMimeImpl(targetUrl, mediaPlan, isVideoContext);
  dbg('mime', 'final', mime ? 'ok' : 'failed', mime ? undefined : 'MIME_NOT_VERIFIED', () => ({ host: targetUrl, mime: typeof mime === 'string' ? mime : undefined, transport: mediaPlan && mediaPlan.transport, kind: isVideoContext ? 'video' : 'image' }));
  return mime;
}
async function executeMediaPlan(plan, settings = {}, rawImageUrl = '', options = {}) {
  dbg('plan', 'execute', 'start', undefined, () => ({ provider: plan && plan.provider, tier: plan && plan.tier, transport: plan && plan.transport, host: plan && plan.primaryUrl, count: plan && Array.isArray(plan.variants) ? plan.variants.length : undefined }), { op: options && options.feedbackOp });
  const r = await executeMediaPlanImpl(plan, settings, rawImageUrl, options);
  dbg('plan', 'execute', r && r.success ? 'ok' : (r && r.cancelled ? 'skipped' : 'failed'), r && r.success ? undefined : (r && r.cancelled ? 'CANCELLED' : dbgCode(r && r.error)), () => (r ? {
    http: r.status, mime: r.normalizedMime, bytes: r.size, downloadId: r.downloadId, fallback: r.isFallback === true, transport: r.transport
  } : null), { op: options && options.feedbackOp });
  return r;
}
/** A request to the offscreen document, recorded as its start and result (codes and numbers only; never an address, payload or Blob). */
async function offscreenRequest(msg) {
  const action = msg && msg.action;
  const t0 = Date.now();
  dbg('offscreen', 'request', 'start', undefined, () => ({ action, job: msg.jobId, host: msg.url }));
  try {
    const res = await chrome.runtime.sendMessage(msg);
    const refused = !res || res.success === false;
    dbg('offscreen', 'request', refused ? 'failed' : 'ok', refused ? (!res ? 'NO_ANSWER' : (dbgCode(res.error) || 'OFFSCREEN_FAILED')) : undefined, () => ({
      action, job: msg.jobId, ms: Date.now() - t0, http: res && res.status, mime: res && (res.contentType || res.mime), bytes: res && res.size, frames: res && res.frames
    }));
    return res;
  } catch (e) {
    dbg('offscreen', 'request', 'failed', 'MESSAGE_FAILED', () => ({ action, job: msg.jobId, ms: Date.now() - t0 }));
    throw e;
  }
}

/** Only the extension's full settings page may read or clear the journal. */
function dbgPageSender(sender) {
  return Boolean(sender) && sender.id === chrome.runtime.id && typeof sender.url === 'string' &&
    sender.url.split(/[?#]/)[0] === chrome.runtime.getURL('popup/popup.html');
}

dbgInit();
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message && message.action;
    if (action === 'DEBUG_EVENT') { dbgIngest(message.ev, sender); return false; }
    if (action !== 'DEBUG_LIST' && action !== 'DEBUG_CLEAR') return false;
    if (!dbgPageSender(sender) || !debugJournal) {
      sendResponse({ success: false, error: 'FORBIDDEN' });
      return false;
    }
    (async () => {
      try {
        if (action === 'DEBUG_CLEAR') await debugJournal.clear();
        const listed = await debugJournal.list();
        sendResponse({ success: true, recording: debugState === 'on', ...listed });
      } catch (_) {
        sendResponse({ success: false, error: action === 'DEBUG_CLEAR' ? 'DEBUG_CLEAR_FAILED' : 'DEBUG_UNAVAILABLE' });
      }
    })();
    return true;
  });
}

// ============================================================================
// 1. Initialization: Context menu and declarativeNetRequest for Pixiv
// ============================================================================

let isDnrSetupInProgress = false;

const pixivRule = {
  id: 1001,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'referer', operation: 'set', value: 'https://www.pixiv.net/' }
    ]
  },
  condition: {
    urlFilter: '||pximg.net',
    resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'image', 'media', 'other']
  }
};

const animePicturesRule = {
  id: 1002,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'referer', operation: 'set', value: 'https://anime-pictures.net/' },
      { header: 'cookie', operation: 'set', value: 'kira=1' }
    ]
  },
  condition: {
    urlFilter: '||oimages.anime-pictures.net',
    resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'image', 'media', 'other']
  }
};

const gelbooruRule = {
  id: 1003,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'referer', operation: 'set', value: 'https://gelbooru.com/' }
    ]
  },
  condition: {
    urlFilter: '||gelbooru.com',
    resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'image', 'media', 'other']
  }
};

const MANAGED_DNR_RULES = Object.freeze([pixivRule, animePicturesRule, gelbooruRule]);
const MANAGED_DNR_RULE_IDS = Object.freeze(MANAGED_DNR_RULES.map((rule) => rule.id));

if (typeof importScripts === 'function') importScripts('lib/media_format.js');

if (typeof importScripts === 'function') importScripts('lib/download_paths.js');

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
 * Infers transport type from URL ('protectedBlob', 'pixivDataUrl', or 'direct').
 */
function inferTransportForUrl(url) {
  if (!url || typeof url !== 'string') return 'direct';
  if (url.includes('pximg.net')) return 'pixivDataUrl';
  if (isProtectedImageHost(url)) return 'protectedBlob';
  return 'direct';
}

/**
 * Factory for structured Candidate Group / Resolution Plan.
 */
function createCandidateGroup({
  id = null,
  source = 'unknown',
  provider = 'generic',
  tier = 'original', // 'original' | 'preview' | 'fallback'
  score = 0,
  validationMode = 'probe', // 'probe' | 'deferred'
  transport = 'direct', // 'direct' | 'protectedBlob' | 'pixivDataUrl'
  variants = [],
  variantPolicy = null,
  metadata = {}
} = {}) {
  const normalizedVariants = (Array.isArray(variants) ? variants : [])
    .map(v => {
      if (typeof v === 'string') {
        const dot = v.lastIndexOf('.');
        const ext = dot !== -1 ? v.substring(dot).split(/[?#]/)[0].toLowerCase() : '';
        return { url: v, expectedExtension: ext };
      }
      return v;
    })
    .filter(v => v && typeof v.url === 'string' && v.url.trim());

  const defaultPolicy = {
    advanceOn: [404, 410],
    retryOn: [429],
    maxRetriesPerVariant: 1,
    stopOn: ['AUTH', 'REDIRECT', 'NON_IMAGE', 'EMPTY_BODY', 'NETWORK_ERROR', 'RATE_LIMIT']
  };

  return {
    isCandidateGroup: true,
    id: id || `${provider}_${source}_${Math.random().toString(36).substring(2, 9)}`,
    source,
    provider,
    tier,
    score,
    finalScore: score,
    validationMode,
    transport,
    variants: normalizedVariants,
    variantPolicy: variantPolicy ? { ...defaultPolicy, ...variantPolicy } : defaultPolicy,
    metadata: { ...metadata },
    get primaryUrl() {
      return this.variants[0]?.url || '';
    }
  };
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

/**
 * Compatibility adapter: converts a single legacy candidate into a Candidate Group with 1 variant.
 */
function adaptCandidateToGroup(candidate) {
  if (!candidate) return null;
  if (candidate.isCandidateGroup) {
    if (!candidate.variants || candidate.variants.length === 0 || !candidate.primaryUrl) {
      return null;
    }
    return candidate;
  }
  const url = typeof candidate === 'string' ? candidate : (candidate.url || '');
  if (!url || typeof url !== 'string' || !url.trim()) {
    return null;
  }
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:')) {
    return null;
  }
  const animeInfo = (candidate.source === 'specialized_provider' || candidate.source === 'initial_src') ? parseAnimePicturesCdnUrl(url) : null;
  if (animeInfo) {
    return createAnimePicturesOriginalGroup(animeInfo.dir, animeInfo.md5);
  }

  const isDeferred = candidate.validationMode
    ? candidate.validationMode === 'deferred'
    : Boolean(candidate.deferredProtectedValidation || isTrustedDeferredProtectedCandidate(candidate));
  const validationMode = candidate.validationMode || (isDeferred ? 'deferred' : 'probe');
  const transport = candidate.transport || inferTransportForUrl(url, candidate);

  // Adapted legacy candidates must use one neutral/legacy tier ('legacy') so their previous finalScore ordering remains unchanged.
  // Honor explicit candidate.tier when provided.
  const tier = candidate.tier || 'legacy';
  const score = typeof candidate.finalScore === 'number'
    ? candidate.finalScore
    : (typeof candidate.score === 'number'
      ? candidate.score
      : (typeof candidate.baseScore === 'number' ? candidate.baseScore : 20));

  let candidateContentType = candidate.contentType || candidate.metadata?.contentType || '';
  if (!candidateContentType && typeof url === 'string') {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const isTrustedFormatHost = host === 'preview.redd.it' || host === 'packaged-media.redd.it' || host.endsWith('.redd.it') || candidate.provider === 'reddit';
      const isVideoContext = candidate.mediaType === 'video' || candidate.type === 'video' || candidate.metadata?.mediaType === 'video';
      if (isTrustedFormatHost || isVideoContext) {
        const qf = parsed.searchParams.get('format') || parsed.searchParams.get('ext');
        if (qf && /^(mp4|video\/mp4)$/i.test(qf.trim())) {
          candidateContentType = 'video/mp4';
        } else if (qf && /^(webm|video\/webm)$/i.test(qf.trim())) {
          candidateContentType = 'video/webm';
        }
      }
    } catch (_) {}
  }

  let expectedExtension = candidate.expectedExtension || '';
  if (candidateContentType) {
    expectedExtension = resolveCanonicalExtension(candidateContentType, expectedExtension || url);
  } else if (!expectedExtension) {
    expectedExtension = getSafeUrlExtension(url);
  }

  const resGroup = createCandidateGroup({
    id: candidate.id,
    source: candidate.source || 'unknown',
    provider: candidate.provider || 'generic',
    tier,
    score,
    validationMode,
    transport,
    variants: [
      {
        url,
        expectedExtension,
        verified: candidate.verified || false,
        verifiedUrl: candidate.verified ? candidate.url : null,
        mimeEvidence: candidate.mimeEvidence || (candidate.verified ? MIME_EVIDENCE.HTTP_RESPONSE : MIME_EVIDENCE.URL_HINT)
      }
    ],
    metadata: {
      rawWidth: candidate.rawWidth || 0,
      rawHeight: candidate.rawHeight || 0,
      verified: candidate.verified || false,
      verifiedUrl: candidate.verified ? candidate.url : null,
      mimeEvidence: candidate.mimeEvidence || (candidate.verified ? MIME_EVIDENCE.HTTP_RESPONSE : MIME_EVIDENCE.URL_HINT),
      contentType: candidateContentType || '',
      contentLength: candidate.contentLength || 0,
      deferredProtectedValidation: isDeferred
    }
  });

  if (resGroup) {
    if (candidate.allowVideo) resGroup.allowVideo = true;
    if (candidate.isBooruCandidate) resGroup.isBooruCandidate = true;
    if (candidate._rateLimited) resGroup._rateLimited = true;
    if (candidate._verificationStatus) resGroup._verificationStatus = candidate._verificationStatus;
    if (candidate._verificationStatusObserved === false) resGroup._verificationStatusObserved = false;
    if (candidate.error) resGroup.error = candidate.error;
    if (candidate.verifiedBlob) resGroup.verifiedBlob = candidate.verifiedBlob;
  }
  return resGroup;
}

/**
 * Checks if candidate qualifies for trusted deferred protected validation
 * (specialized Anime-Pictures original candidate on oimages.anime-pictures.net).
 * Bypasses network probe to avoid burning CDN rate limits; validation is deferred to fetchProtectedBlob().
 */
function isTrustedDeferredProtectedCandidate(candidate) {
  if (!candidate) return false;
  if (candidate.isCandidateGroup) {
    return candidate.provider === 'anime-pictures' &&
           candidate.tier === 'original' &&
           candidate.validationMode === 'deferred';
  }
  if (!candidate.url) return false;
  if (candidate.source !== 'specialized_provider') return false;
  return parseAnimePicturesCdnUrl(candidate.url) !== null;
}


/**
 * Configure declarativeNetRequest dynamic rules for Referer header injection
 * Required for services like Pixiv (i.pximg.net) that return 403 Forbidden without a referer.
 */
async function setupDeclarativeNetRequestRules() {
  if (isDnrSetupInProgress) {
    return;
  }
  isDnrSetupInProgress = true;

  try {
    const updatePayload = {
      removeRuleIds: [...MANAGED_DNR_RULE_IDS],
      addRules: [...MANAGED_DNR_RULES]
    };

    await new Promise((resolve, reject) => {
      let settled = false;
      let ret;
      try {
        ret = chrome.declarativeNetRequest.updateDynamicRules(updatePayload, () => {
          if (settled) return;
          settled = true;
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) {
            console.error('[MediaLatch] updateDynamicRules error:', lastErr.message);
            reject(new Error(`updateDynamicRules failed: ${lastErr.message}`));
          } else {
            resolve();
          }
        });
      } catch (syncErr) {
        if (!settled) {
          settled = true;
          console.error('[MediaLatch] updateDynamicRules sync error:', syncErr);
          reject(syncErr);
        }
        return;
      }
      if (ret && typeof ret.then === 'function') {
        ret.then(
          () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          (promiseErr) => {
            if (!settled) {
              settled = true;
              console.error('[MediaLatch] updateDynamicRules promise reject:', promiseErr);
              reject(promiseErr);
            }
          }
        );
      }
    });
  } catch (err) {
    console.error('[MediaLatch] Ошибка в setupDeclarativeNetRequestRules():', err?.message || err);
  } finally {
    isDnrSetupInProgress = false;
  }
}

// Ensure declarativeNetRequest rules initialization on service worker launch/activation
setupDeclarativeNetRequestRules();

const CSS_MEDIA_MENU_ID = 'save-css-media-item';
// The one title of the command, at registration and always: the type of the original is decided by the save, after the click.
const STABLE_MENU_TITLE = 'MediaLatch: Save media';

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    // Chrome groups multiple extension entries into a submenu. Register one action for every target context;
    // provider routing remains internal and admission still proves the selected owner before saving.
    chrome.contextMenus.create({
      id: 'save-image-item',
      title: STABLE_MENU_TITLE,
      contexts: ['image', 'link', 'video', 'page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*']
    });
    contextTargetVisible = true;
    menuClick = null;
    console.log('[MediaLatch] Пункты контекстного меню успешно зарегистрированы');
  });
}

function isXPageUrl(url) {
  return /^https:\/\/(?:x|twitter)\.com\//i.test(String(url || ''));
}

// Selected-target hint. Chrome has no event before the native menu opens (no onShown, no refresh), so the page's
// gesture sends one small message (content/content_context_target.js) and the one shared entry is shown or hidden from it: outside
// selected media it is absent from the menu (never a disabled item). That is only a best-effort hint: the menu may already
// be open on the previous state, so the save click never trusts it and re-proves the target (resolveContextMediaTarget)
// before any resolver or network request runs.
const CONTEXT_STATE_ITEMS = ['save-image-item'];
// null = unknown (the service worker has just started; an item hidden by an earlier worker is not known to be visible):
// the first answer always updates the item.
let contextTargetVisible = null;
// The latest gesture of a document: { tabId, frameId, documentId, startAt, ended }. A right-press ('down') or the keyboard menu key
// ('key') starts a new one; its contextmenu event ('menu') belongs to it. It only orders delayed hints against each other.
let menuClick = null;
// Identity of one gesture inside a document: the timeStamp of the trusted DOM event that started it. Every content script of the
// frame (the generic capture and the provider scripts) sees the same event, so they report the same value without sharing
// state; successive gestures differ. Page clock, so it is only compared within one tab/frame/document.
function gestureStamp(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}
function clickIsIn(c, tabId, frameId, documentId) {
  return c.tabId === tabId && c.frameId === frameId && (c.documentId === undefined || documentId === undefined || c.documentId === documentId);
}
// The window that has the browser focus, undefined until windows.onFocusChanged or windows.getLastFocused says. tab.active
// is per window and does not mean this window owns the shared menu, so a rest hint is accepted only from the focused window.
const WINDOW_ID_NONE = typeof chrome !== 'undefined' && chrome.windows && typeof chrome.windows.WINDOW_ID_NONE === 'number' ? chrome.windows.WINDOW_ID_NONE : -1;
let focusedWindowId;
// Events that may change the menu are stamped when they arrive; the newest one whose result is on the menu wins. An answer that
// waited for the focused window (worker start) or a lifecycle event that did is dropped when a newer one was applied meanwhile.
let hintClock = 0;
let hintAppliedAt = 0;
function applyHint(stamp, change) {
  if (hintAppliedAt > stamp) return false;
  hintAppliedAt = stamp;
  change();
  return true;
}

// Calls back at once when the focused window is known, otherwise after windows.getLastFocused (a newer onFocusChanged wins; an
// API failure leaves it unknown, which callers treat as "may apply").
function withFocusedWindow(callback) {
  if (focusedWindowId !== undefined || typeof chrome.windows?.getLastFocused !== 'function') { callback(); return; }
  new Promise((resolve) => resolve(chrome.windows.getLastFocused())).then((win) => {
    if (focusedWindowId === undefined) focusedWindowId = win && win.focused ? win.id : WINDOW_ID_NONE;
  }, () => {}).then(callback);
}

// A tab was activated or navigated in window `windowId`. Only the focused window owns the shared menu; another window's tab
// event must not reset it. (Caches of a navigated tab are cleared by the caller whatever the window.)
function onSharedMenuTabEvent(windowId, change, changesState = true) {
  const stamp = ++hintClock;
  withFocusedWindow(() => {
    if (focusedWindowId !== undefined && Number.isInteger(windowId) && windowId !== focusedWindowId) return;
    if (changesState) applyHint(stamp, change); else change();
  });
}

function setContextTargetVisible(visible) {
  if (contextTargetVisible === visible) return;
  contextTargetVisible = visible;
  for (const id of CONTEXT_STATE_ITEMS) {
    try {
      // enabled: true is sent as well, so an item left disabled by an older version never stays greyed out.
      chrome.contextMenus?.update?.(id, { visible, enabled: true }, () => { void chrome.runtime?.lastError; });
    } catch (_) {}
  }
}

// Whatever a previous gesture said does not carry over to another tab, window or document: visible again.
function resetContextTargetHint() {
  setContextTargetVisible(true);
  menuClick = null;
}

function menuEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!['img', 'video', 'player', 'css'].includes(raw.kind)) return null;
  const url = raw.url;
  if (url !== null && url !== undefined && (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url))) return null;
  return { kind: raw.kind, url: url || null };
}

// Only a proven image on its profile photo link/opened view qualifies; profile-post authors are still previews.
function isXAvatarPreviewHint(pageUrl, evidence, link) {
  try {
    const page = new URL(pageUrl);
    const profileRoute = /^\/([a-z0-9_]+)(?:\/(?:photo|with_replies|media|likes|highlights|articles))?\/?$/i.exec(page.pathname);
    const isProfile = profileRoute && !/^(?:home|explore|search|notifications|messages|settings|i|compose|login|logout|signup|account|tos|privacy|about)$/i.test(profileRoute[1]);
    if (!isXPageUrl(page.href)) return false;
    if (evidence?.kind === 'video' || evidence?.kind === 'player') return false;
    if (evidence?.url) {
      const asset = new URL(evidence.url);
      if (asset.hostname !== 'pbs.twimg.com' || !asset.pathname.startsWith('/profile_images/')) return false;
      if (evidence.kind !== 'img' || !isProfile) return true;
      if (/\/photo\/?$/i.test(page.pathname)) return false;
      if (!link) return true;
      try {
        const photo = new URL(link);
        return !isXPageUrl(photo.href) || photo.pathname.toLowerCase().replace(/\/$/, '') !== '/' + profileRoute[1].toLowerCase() + '/photo';
      } catch (_) { return true; }
    }
    // An unresolved layer over a profile navigation link is the failing preview case; never infer an image from that link.
    const profile = new URL(link);
    return isXPageUrl(profile.href) && /^\/[a-z0-9_]+(?:\/photo)?\/?$/i.test(profile.pathname);
  } catch (_) { return false; }
}

// The page remembers the last answer it sent (content/content_context_target.js) and sends only a change. After a reset it no longer
// matches the menu, so the shown tab is told to forget it and answer again once for the resting pointer. One small message
// per focus or tab change, never per pointer event; a tab without the script just has no receiver.
function notifyContextHintReset(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    const sent = chrome.tabs?.sendMessage?.(tabId, { action: 'CONTEXT_HINT_RESET' });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch (_) {}
}

function isContentScriptSender(sender) {
  return Boolean(sender) && typeof sender.id === 'string' && sender.id === chrome.runtime?.id &&
    Number.isInteger(sender.tab?.id) && Number.isInteger(sender.frameId) &&
    /^https?:\/\//i.test(typeof sender.url === 'string' ? sender.url : '');
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.action !== 'CONTEXT_TARGET_STATE') return;
    if (!isContentScriptSender(sender) || sender.tab.active !== true) return;
    if (typeof message.selectable !== 'boolean') return;
    // 'gesture' (a real right-press / contextmenu / keyboard menu key) or 'pointer' (the pointer rests): both are hints.
    if (message.source !== undefined && message.source !== 'gesture' && message.source !== 'pointer') return;
    if (message.phase !== undefined && !['down', 'menu', 'key', 'rest'].includes(message.phase)) return;
    const link = message.linkHref;
    if (link !== null && link !== undefined && (typeof link !== 'string' || link.length > 2048)) return;
    // A direct media link is a target of its own; a plain navigation link or empty space is not.
    const evidence = menuEvidence(message.media);
    const selectable = !isXAvatarPreviewHint(sender.url, evidence, link) &&
      (message.selectable || hasMediaAssociation('', link || ''));
    const gestureAt = gestureStamp(message.gestureAt);
    // A real gesture always carries the stamp of its trusted event (0 is a valid stamp). One without a valid stamp cannot be
    // ordered against the click already on the menu, so it must not start a click, reset the current one, change the visibility
    // or open the click to descriptors of an earlier gesture: it is refused like any other malformed message. A resting
    // pointer ('pointer') has no gesture and no stamp.
    if (message.source === 'gesture' && gestureAt === null) { dbg('target', 'gesture', 'refused', 'NO_GESTURE_STAMP', null, { tab: sender.tab.id, frame: sender.frameId }); return; }
    if (message.source === 'gesture') {
      dbg('target', 'gesture', 'info', undefined, () => ({ phase: message.phase, ok: selectable, kind: evidence && evidence.kind, host: evidence && evidence.url, linkHost: link || undefined }), { tab: sender.tab.id, frame: sender.frameId });
    }
    const stamp = ++hintClock;
    const apply = () => {
      // A resting pointer is a hint for the window that owns the menu now: not for a window that lost focus (its message may
      // have been sent earlier) nor while no window has focus. A real gesture is authoritative.
      if (message.source === 'pointer' && focusedWindowId !== undefined && sender.tab.windowId !== focusedWindowId) return;
      applyHint(stamp, () => {
        const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
        const cur = menuClick;
        // A gesture message older than the click already on the menu is a delayed answer of an earlier gesture of this
        // document: it does not change the visibility.
        if (message.source === 'gesture' && cur && cur.startAt !== null && cur.startAt !== undefined && gestureAt !== null &&
          clickIsIn(cur, sender.tab.id, frameId, sender.documentId) && gestureAt < cur.startAt) return;
        setContextTargetVisible(selectable);
        // A new click resets the gesture; a resting pointer ends the previous one.
        if (message.source === 'gesture') {
          const sameClick = message.phase === 'menu' && cur && !cur.ended && clickIsIn(cur, sender.tab.id, frameId, sender.documentId);
          if (!sameClick) menuClick = { tabId: sender.tab.id, frameId, documentId: sender.documentId, startAt: gestureAt };
        } else {
          menuClick = { ended: true, tabId: sender.tab.id, frameId, documentId: sender.documentId, startAt: menuClick && menuClick.startAt !== undefined && clickIsIn(menuClick, sender.tab.id, frameId, sender.documentId) ? menuClick.startAt : null };
        }
      });
    };
    // A rest hint in a worker that has just started waits for the focused window; a gesture does not wait.
    if (message.source === 'pointer') withFocusedWindow(apply); else apply();
  });
}

/**
 * Sanitizes URLs for secure debug logging by redacting sensitive query parameters.
 * Redacts tokens, access keys, signatures, auth hashes, and similar credentials.
 * Recursively supports nested objects and strings.
 * Does NOT alter the underlying URL used by the download/network pipeline.
 */
function sanitizeUrlForLog(input) {
  if (!input) return input;
  if (typeof input === 'object') {
    if (Array.isArray(input)) {
      return input.map(sanitizeUrlForLog);
    }
    const cleanObj = {};
    for (const [k, v] of Object.entries(input)) {
      cleanObj[k] = sanitizeUrlForLog(v);
    }
    return cleanObj;
  }
  if (typeof input !== 'string') return input;

  const SENSITIVE_KEY_RE = /^(?:token|access_token|auth|key|signature|sig|secret|api_key|apikey|s|a|jsc_token|session|bearer)$/i;

  try {
    const parsed = new URL(input);
    let modified = false;
    for (const [key, value] of parsed.searchParams.entries()) {
      // names of signature-bearing parameters beyond the short list: AWS/Google (X-Amz-Credential, X-Goog-Credential), CloudFront (Policy, Key-Pair-Id), Akamai (hdnts, hdnea)
      if (SENSITIVE_KEY_RE.test(key) || /token|secret|auth|signature|credential|policy|key-pair-id|hdnts|hdnea/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
        modified = true;
      }
    }
    return modified ? parsed.toString() : input;
  } catch (_) {
    // If not a full valid URL, fallback to regex replacement
    return input.replace(/([?&](?:token|access_token|auth|key|signature|sig|secret|api_key|apikey|s|a|jsc_token|session|bearer|[^?&=]*(?:credential|policy|key-pair-id|hdnts|hdnea)[^?&=]*)=)[^&]*/gi, '$1[REDACTED]');
  }
}

/**
 * Diagnostic form of a candidate-group id. The id itself is an identity and stays exact: it embeds the complete normalized URL
 * (`candidate_<url>`) or the last 40 characters of one (`video_<encoded tail>`, `x_video_...`), signed query included. A log line shows only
 * the origin and path with a redaction marker for the query, or only the kind of a truncated tail with a marker; everything else is unchanged.
 */
function sanitizeGroupIdForLog(id) {
  if (typeof id !== 'string') return id;
  const url = /^(.*?_)(https?:\/\/.+)$/i.exec(id);
  if (url) {
    try {
      const u = new URL(url[2]);
      return `${url[1]}${u.origin}${u.pathname}${u.search || u.hash ? '?[REDACTED]' : ''}`;
    } catch (_) {
      return `${url[1]}[REDACTED]`;
    }
  }
  // `video_` / `x_video_` carry the last 40 characters of an address, cut at an arbitrary point: they may be (part of) a signature without any
  // delimiter, or start inside one secret and reach a later delimiter. A safe part cannot be established, so the kind is shown without the tail.
  const tail = /^((?:x_)?video_)(.+)$/.exec(id);
  if (tail) return `${tail[1]}[REDACTED]`;
  return id;
}

/**
 * Classifies a media target into standard media representation.
 * Strict discriminator for X tweet_video (MP4 container representing animated GIF):
 * - video.twimg.com/tweet_video/*.mp4 -> { type: 'gif', sourceType: 'x_tweet_video', mime: 'video/mp4', animated: true }
 * - normal MP4 -> { type: 'video', sourceType: 'video', mime: 'video/mp4', animated: false }
 * - normal WebM -> { type: 'video', sourceType: 'video', mime: 'video/webm', animated: false }
 * - normal GIF -> { type: 'gif', sourceType: 'gif', mime: 'image/gif', animated: true }
 * - normal image -> { type: 'image', sourceType: 'image', mime: '...', animated: false }
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
      const parsed = new URL(u, 'https://x.com/');
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
      const parsed = new URL(u, 'https://x.com/');
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      return (host === 'twimg.com' || host.endsWith('.twimg.com')) && pathname.includes('/tweet_video_thumb/');
    } catch (_) {
      return false;
    }
  };

  // Check if target represents an X tweet_video
  // Recovers genuine tweet_video source when blob fallback or thumb poster is present
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

  // Reddit animated GIF served as MP4: preview.redd.it/...gif?format=mp4
  const isRedditGif = (
    domType === 'reddit_gif' ||
    mediaType === 'reddit_gif' ||
    target?.sourceType === 'reddit_gif' ||
    isRedditAnimationUrl(url || src || currentSrc)
  );

  if (isRedditGif) {
    return {
      type: 'gif',
      sourceType: 'reddit_gif',
      mime: 'video/mp4',
      animated: true
    };
  }

  // DASH manifest target
  const isDashTarget = (
    (mime && mime.toLowerCase().includes('dash+xml')) ||
    (typeof isDashManifestUrl === 'function' && isDashManifestUrl(url || src || currentSrc))
  );
  if (isDashTarget) {
    return {
      type: 'dash_manifest',
      sourceType: 'dash',
      mime: 'application/dash+xml',
      animated: false
    };
  }

  // HTML target
  const isHtmlTarget = (mime && (mime.toLowerCase().startsWith('text/html') || mime.toLowerCase().startsWith('application/xhtml+xml')));
  if (isHtmlTarget) {
    return {
      type: 'html',
      sourceType: 'page',
      mime: 'text/html',
      animated: false
    };
  }

  // Reddit video hosts (v.redd.it, packaged-media.redd.it)
  const redditVideoHostType = (() => {
    try {
      const u = url || src || currentSrc;
      if (!u) return null;
      const parsed = new URL(u, 'https://reddit.com/');
      const host = parsed.hostname.toLowerCase();
      if (host === 'v.redd.it' || host === 'packaged-media.redd.it') {
        const pathname = parsed.pathname.toLowerCase();
        const isDash = pathname.endsWith('.mpd') || (parsed.searchParams.get('format') || '').toLowerCase() === 'mpd';
        const isHls = pathname.endsWith('.m3u8') || (parsed.searchParams.get('format') || '').toLowerCase() === 'm3u8';
        const isHtml = pathname.endsWith('.html') || pathname.includes('/comments/');
        if (isDash || isHls || isHtml) {
          return null; // Reject HTML and DASH manifests as MP4
        }
        return host === 'v.redd.it' ? 'video' : 'packaged_media';
      }
      return null;
    } catch (_) {
      return null;
    }
  })();

  if (redditVideoHostType) {
    const cleanMime = (mime && mime.toLowerCase().startsWith('video/'))
      ? mime.toLowerCase().split(';')[0].trim()
      : (/\.webm/i.test(url || src || currentSrc || '') ? 'video/webm' : 'video/mp4');
    return {
      type: 'video',
      sourceType: redditVideoHostType,
      mime: cleanMime,
      animated: false
    };
  }

  // RedGIFs video media routes and files
  const isRedGifsTarget = (() => {
    try {
      const u = url || src || currentSrc;
      if (!u) return false;
      const parsed = new URL(u, 'https://redgifs.com/');
      const host = parsed.hostname.toLowerCase();
      if (typeof isAllowedRedGifsHost === 'function' && isAllowedRedGifsHost(host)) {
        const pathname = parsed.pathname.toLowerCase();
        const isRoute = /\/(?:watch|ifr|detail|gifs)\/([a-zA-Z0-9_-]+)/i.test(pathname);
        const isVideoFile = /\.(mp4|webm|mov|m4v)$/i.test(pathname);
        return isRoute || isVideoFile;
      }
      return false;
    } catch (_) {
      return false;
    }
  })();

  if (isRedGifsTarget) {
    const cleanMime = (mime && mime.toLowerCase().startsWith('video/'))
      ? mime.toLowerCase().split(';')[0].trim()
      : (/\.webm/i.test(url || src || currentSrc || '') ? 'video/webm' : 'video/mp4');
    return {
      type: 'video',
      sourceType: 'redgifs',
      mime: cleanMime,
      animated: false
    };
  }

  // Other animated GIF (standard image/gif or .gif extension)
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

  // Normal video (MP4, WebM, etc.)
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

  // Standard Image
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

const lastDetectedXMediaByTab = new Map();

const lastDetectedRedditMediaByTab = new Map();

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    // Provider hints from a background tab must not fill the caches of the active tab.
    if (sender?.tab?.active === false) return;
    if (message?.action === 'X_MEDIA_CONTEXTMENU_DETECTED' || message?.action === 'REDDIT_MEDIA_CONTEXTMENU_DETECTED') {
      dbg(message.action === 'X_MEDIA_CONTEXTMENU_DETECTED' ? 'x.menu' : 'reddit.menu', 'detected', 'info', undefined, () => ({
        type: message.media && message.media.type, host: message.media && (message.media.url || message.media.src), blob: Boolean(message.media && message.media.isBlobPlayer)
      }), { tab: sender && sender.tab && sender.tab.id, frame: sender && sender.frameId });
    }
    if (message?.action === 'X_MEDIA_CONTEXTMENU_DETECTED' && sender?.tab?.id) {
      lastDetectedXMediaByTab.set(sender.tab.id, {
        media: message.media,
        timestamp: Date.now()
      });
    } else if (message?.action === 'REDDIT_MEDIA_CONTEXTMENU_DETECTED' && sender?.tab?.id) {
      const tabId = sender.tab.id;
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
      const msgTime = Number(message.timestamp) || Date.now();
      const existing = lastDetectedRedditMediaByTab.get(tabId);
      if (existing && existing.timestamp && existing.timestamp > msgTime) {
        // Drop out-of-order stale message
        return;
      }
      lastDetectedRedditMediaByTab.set(tabId, {
        media: message.media,
        timestamp: msgTime,
        frameId,
        documentUrl: sender.url || ''
      });
    } else if (message?.action === 'REDGIFS_MEDIA_CONTEXTMENU_DETECTED' && sender?.tab?.id) {
      // Must be a positively identified RedGIFs media target
      if (message.media?.sourceType !== 'redgifs') {
        return;
      }
      const tabId = sender.tab.id;
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
      const msgTime = Number(message.timestamp) || Date.now();
      const existing = lastDetectedRedditMediaByTab.get(tabId);
      if (existing && existing.timestamp && existing.timestamp > msgTime) {
        // Drop out-of-order stale message
        return;
      }
      lastDetectedRedditMediaByTab.set(tabId, {
        media: message.media,
        timestamp: msgTime,
        frameId,
        documentUrl: sender.url || ''
      });
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.windows?.onFocusChanged?.addListener) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    focusedWindowId = windowId;
    applyHint(++hintClock, resetContextTargetHint);
    if (windowId !== WINDOW_ID_NONE && typeof chrome.tabs?.query === 'function') {
      try {
        Promise.resolve(chrome.tabs.query({ active: true, windowId })).then((tabs) => {
          for (const t of Array.isArray(tabs) ? tabs : []) notifyContextHintReset(t && t.id);
        }, () => {});
      } catch (_) {}
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated?.addListener) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    onSharedMenuTabEvent(activeInfo && activeInfo.windowId, () => {
      resetContextTargetHint();
      notifyContextHintReset(activeInfo && activeInfo.tabId);
    });
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated?.addListener) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading' || changeInfo.url) {
      lastDetectedRedditMediaByTab.delete(tabId);
      lastDetectedXMediaByTab.delete(tabId);
      // The shared menu is touched only by a tab of the focused window; its availability only by the shown tab.
      if (tab?.active) onSharedMenuTabEvent(tab.windowId, resetContextTargetHint);
    }
  });
}

// The manifest's content scripts reach only documents that load after the extension: a tab that stays open across an install, an update or a reload
// has no capture, so no hint is ever sent for it (the menu stays "Unknown Format", no lookup starts) until it is reloaded. Put the capture script
// into the open http(s) tabs once. It is idempotent in a document that already has it (`__imageSaverContextTarget` guard) and a tab that refuses
// injection (a restricted page, a closed or discarded tab) is skipped. Other providers' scripts are not touched.
async function injectContextTargetIntoOpenTabs() {
  if (!chrome.tabs?.query || !chrome.scripting?.executeScript) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }); } catch (_) { return; }
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab || !Number.isInteger(tab.id) || tab.discarded) continue;
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, injectImmediately: true, files: ['lib/debug_journal.js', 'content/content_context_target.js', 'content/content_notifications.js'] }); dbg('lifecycle', 'reinject', 'ok', undefined, { target: 'context_target' }, { tab: tab.id }); } catch (_) { dbg('lifecycle', 'reinject', 'failed', 'INJECT_FAILED', { target: 'context_target' }, { tab: tab.id }); }
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  dbg('lifecycle', 'installed', 'info', undefined, { reason: details && details.reason });
  setupDeclarativeNetRequestRules();
  setupContextMenus();
  if (details?.reason === 'install' || details?.reason === 'update') injectContextTargetIntoOpenTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  dbg('lifecycle', 'startup', 'info');
  setupDeclarativeNetRequestRules();
  setupContextMenus();
  reconcileActiveOffscreenDownloads();
});

// ============================================================================
// ============================================================================
// 2. Candidate Normalization, Scoring & Verification
// ============================================================================

/**
 * Normalizes an image candidate URL:
 * - Resolves relative URLs against baseUrl
 * - Trims whitespace
 * - Strips unnecessary cache parameters
 */
function normalizeCandidateUrl(rawUrl, baseUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) {
    return null;
  }
  try {
    const absUrl = new URL(trimmed, baseUrl);
    return absUrl.toString();
  } catch (e) {
    return null;
  }
}

/**
 * Determines whether a URL has obvious thumbnail/preview indicators.
 * NOTE: As per guidelines, file extensions like .avif or .webp are NEVER penalized.
 * Only path/query/filename tokens indicating thumbnails/resizes are penalized.
 */
function isThumbnailUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();

    // Known thumbnail hostnames / subpaths
    if (host.includes('gstatic.com') && pathname.includes('/images') && search.includes('q=tbn:')) {
      return true;
    }
    if (host.includes('avatars.mds.yandex.net') && pathname.includes('/get-images-thumbs/')) {
      return true;
    }
    if (host.includes('preview.redd.it') || host.includes('external-preview.redd.it')) {
      return true;
    }

    // Path segments indicating thumbnail/preview
    const thumbPathPattern = /\/(?:thumbs?|thumbnails?|previews?|samples?|small|mini|avatars?|custom-thumb|\d+x\d+)\//i;
    if (thumbPathPattern.test(pathname)) {
      return true;
    }

    // File name prefixes/suffixes indicating thumbnail/compressed preview
    // e.g. sample_123.jpg, thumb_123.jpg, 1500x3187-..._cp.avif, ..._sp.png
    if (/(?:^|\/|[_-])(?:thumb|thumbnail|sample|small|mini)[_-]/i.test(pathname)) {
      return true;
    }
    if (/(?:_cp|_sp|_thumb|_preview)\.[a-z0-9]+$/i.test(pathname)) {
      return true;
    }

    // Dimension resize suffix in filename (e.g. photo-150x150.jpg, -300x200.png, -1024x768.jpg)
    if (/-\d{2,4}x\d{2,4}\.[a-z0-9]+$/i.test(pathname)) {
      return true;
    }

    // Dimension prefix (e.g. Anime-Pictures 1500x3187-hash) — scoped to anime-pictures.net CDN only
    if (host.includes('anime-pictures.net') && /\/\d{2,4}x\d{2,4}-[a-f0-9]{20,}/i.test(pathname)) {
      return true;
    }

    // Zerochan previews/thumbnails (e.g. .240.4728645.avif, .600.4728645.jpg, .1024.4728645.webp, /240/45/22/4728645.avif)
    // Scoped strictly to zerochan.net hosts; genuine original .full. (including .full.*.avif) is NOT a thumbnail
    if (host.includes('zerochan.net')) {
      if (/\.(?:75|240|600|1024)\.\d+\.[a-z0-9]+$/i.test(pathname)) {
        return true;
      }
      if (/\/(?:75|240|600|1024)\/\d+/i.test(pathname)) {
        return true;
      }
    }

    // GIPHY preview suffixes
    if ((host.includes('giphy.com') || host === 'i.giphy.com') && (/\/(?:200|200w|100|100w|giphy_s)\.[a-z0-9]+$/i.test(pathname) || /_s\.[a-z0-9]+$/i.test(pathname))) {
      return true;
    }

    // e-shuushuu preview/medium images (not fullsize)
    if (host.includes('e-shuushuu.net') && pathname.includes('/medium/')) {
      return true;
    }

    // Pixiv preview/master variants on pximg.net (img-master, custom-thumb)
    if ((host === 'i.pximg.net' || host.includes('pximg.net') || host.includes('pixiv.net')) && (pathname.includes('/img-master/') || pathname.includes('/custom-thumb/'))) {
      return true;
    }

    // Twitter/X: non-original size variants on pbs.twimg.com and *.twimg.com
    if (host === 'twimg.com' || host.endsWith('.twimg.com')) {
      const nameParam = parsed.searchParams.get('name');
      if (nameParam) {
        const lowerName = nameParam.toLowerCase();
        if (lowerName !== 'orig' && lowerName !== '4096x4096') {
          return true;
        }
      }
      const colonMatch = pathname.match(/:([a-z0-9_]+)$/i);
      if (colonMatch) {
        const lowerColon = colonMatch[1].toLowerCase();
        if (lowerColon !== 'orig' && lowerColon !== '4096x4096') {
          return true;
        }
      }
      if (pathname.includes('/profile_images/') && /_(normal|mini|bigger|200x200)\.(jpe?g|png|webp)$/i.test(pathname)) {
        return true;
      }
      if (pathname.includes('/profile_banners/') && /\/(web|mobile|600x200|300x100|web_retina)$/i.test(pathname)) {
        return true;
      }
    }

    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Checks if a URL represents a recognized original/full-size media path
 */
function isOriginalPath(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const p = parsed.pathname.toLowerCase();
    if (parsed.hostname.toLowerCase() === 'i.redd.it') return true;
    if (p.includes('/original/') || p.includes('/img-original/') || p.includes('/full/') || p.includes('/_images/') || p.includes('/pictures/get_image/') || (parsed.hostname.includes('tenor.com') && p.includes('aaaac')) || (parsed.hostname.includes('giphy.com') && p.endsWith('/giphy.gif')) || (parsed.hostname.includes('yande.re') && p.includes('/image/')) || (parsed.hostname.includes('gelbooru.com') && p.includes('/images/')) || (parsed.hostname.includes('e-shuushuu.net') && p.includes('/fullsize/')) || (parsed.hostname.includes('zerochan.net') && p.includes('.full.'))) {
      return !isThumbnailUrl(url);
    }
  } catch (e) {}
  return false;
}

/**
 * Computes deterministic base score for a candidate based on source provenance and URL characteristics.
 *
 * Source weights:
 * - dom_data_original: 95 (explicit data-original, data-full, data-super-full-img)
 * - search_result_decoded: 90 (decoded Google imgurl, Yandex img_href, Anime-Pictures original artwork)
 * - specialized_provider: 85 (Pixiv Ajax/orig, Reddit clean i.redd.it, Twitter :orig, Wikimedia full, Boorus)
 * - dom_link: 75 (parent/card <a> pointing directly to an image file)
 * - dom_srcset: 70 (highest resolution candidate from srcset)
 * - css_background: 65 (CSS background-image extracted from clicked element/ancestor)
 * - cdn_transform: 50 (clean query stripped, -1024x768 stripped, /sample/ -> /images/)
 * - page_meta: 25 (OpenGraph og:image, Twitter Cards, link image_src — low priority social preview)
 * - initial_src: 15 (original clicked img.src / currentSrc)
 *
 * Penalties:
 * - Thumbnail/preview markers: -40
 * - Low-resolution descriptor (< 400w): -20
 */
function scoreCandidateUrl(url, source, rawWidth = 0, rawHeight = 0) {
  const sourceScores = {
    dom_data_original: 95,
    search_result_decoded: 90,
    specialized_provider: 85,
    dom_link: 75,
    dom_srcset: 70,
    css_background: 65,
    cdn_transform: 50,
    page_meta: 25,
    initial_src: 15
  };

  let score = sourceScores[source] || 20;

  // If the initial_src is already a clean original path
  if (source === 'initial_src' && isOriginalPath(url)) {
    score = 60;
  }

  // Penalty for thumbnail/preview indicators in URL
  if (isThumbnailUrl(url)) {
    score -= 40;
  }

  // Width descriptor adjustments (for srcset)
  if (rawWidth >= 2000) {
    score += 10;
  } else if (rawWidth > 0 && rawWidth < 400) {
    score -= 20;
  }

  return score;
}

// Recognized static image extensions across MediaLatch
const IMAGE_EXTENSIONS_REGEX = /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)$/i;

const EXPLICIT_NON_IMAGE_MIMES = new Set([
  'text/html',
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript'
]);

/**
 * Checks if the URL pathname ends with a recognized image extension.
 * Strips query string and fragment before evaluation.
 */
function hasImageExtensionInPath(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr, 'https://dummy.local');
    return IMAGE_EXTENSIONS_REGEX.test(parsed.pathname);
  } catch (_) {
    return false;
  }
}

/**
 * Checks if normalized MIME type is explicitly non-image content.
 */
function isExplicitNonImageMime(mime) {
  if (!mime || typeof mime !== 'string') return false;
  if (EXPLICIT_NON_IMAGE_MIMES.has(mime)) return true;
  if (mime.startsWith('text/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
    return true;
  }
  return false;
}

/**
 * Probes candidate network availability (HEAD / Range GET) and extracts metadata.
 * Adjusts candidate finalScore according to verified content characteristics.
 * (User Requirement 1: Dimensions/size are taken into account while provenance remains primary).
 */
async function probeCandidateImpl(candidate) {
  if (!candidate || !candidate.url) return false;
  if (typeof candidate.status !== 'number') {
    candidate.status = 0;
  }

  // Trusted specialized Anime-Pictures original candidate:
  // Bypass network preflight (HEAD / Range GET) to avoid burning CDN rate limits.
  // Final validation (HTTP status, Content-Type image/*, non-empty body, allowlist)
  // is strictly deferred to fetchProtectedBlob() in the offscreen pipeline.
  if (isTrustedDeferredProtectedCandidate(candidate)) {
    candidate.deferredProtectedValidation = true;
    candidate.verified = false;
    candidate.finalScore = Math.max(candidate.finalScore, 95);
    return true;
  }

  let timeoutId = null;
  let getTimeoutId = null;

  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 3500);

    // DNR rules (1001, 1002, 1003) manage Referer/Cookie at network layer;
    // do not manually set Referer in JavaScript here.
    const probeHeaders = {};

    // First try a lightweight HEAD request without downloading the file body
    let res = await fetch(candidate.url, {
      method: 'HEAD',
      headers: probeHeaders,
      signal: controller.signal
    });
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // Some CDNs block HEAD (405 Method Not Allowed or 403 Forbidden) — request 1 byte via GET.
    // Zerochan's CDNs (s3./static.zerochan.net) answer HEAD with 503 text/html (592 bytes) while GET and
    // Range GET return the image (observed in Chrome, 2026-10-02): a 503 to HEAD is therefore not evidence about
    // the file. Only the bounded 1-byte GET below decides; its own status and Content-Type are authoritative.
    if (res.status === 405 || res.status === 403 || res.status === 503) {
      if (res.status !== 503 && isProtectedImageHost(candidate.url)) {
        // Protected booru host (e.g. Gelbooru) blocks hotlinked preflight HEAD/Range from SW context.
        // Retain protected offscreen flow: defer validation to FETCH_GELBOORU_BLOB in offscreen document.
        candidate.deferredProtectedValidation = true;
        candidate.verified = false;
        candidate.finalScore = Math.max(candidate.finalScore, 90);
        return true;
      }
      const getController = new AbortController();
      getTimeoutId = setTimeout(() => getController.abort(), 3500);
      try {
        res = await fetch(candidate.url, {
          method: 'GET',
          headers: { ...probeHeaders, 'Range': 'bytes=0-0' },
          signal: getController.signal
        });
      } finally {
        // Only the status and headers of this 1-byte probe are used. A server that ignores Range (HTTP 200) would
        // otherwise keep streaming the whole file after verification: end the probe request here, on every path
        // (success, rejection, error). The real download is a separate chrome.downloads request and is unaffected.
        getController.abort();
        if (getTimeoutId) {
          clearTimeout(getTimeoutId);
          getTimeoutId = null;
        }
      }
    }

    if (res && typeof res.status === 'number') {
      candidate.status = res.status;
      if (res.status === 429) candidate.rateLimited = true;
      if (res.status === 403 || res.status === 401) candidate.authRequired = true;
    }

    if (res.ok) {
      const rawContentType = res.headers.get('content-type') || '';
      const normalizedMime = rawContentType.split(';')[0].trim().toLowerCase();
      const cl = res.headers.get('content-length');
      let contentLength = cl ? (parseInt(cl, 10) || 0) : 0;
      if (res.status === 206) {
        // A 1-byte Range response reports Content-Length: 1; the real size is the Content-Range total.
        const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
        contentLength = total ? (parseInt(total[1], 10) || 0) : 0;
      }

      const isAmbiguousMime =
        normalizedMime === 'application/octet-stream' ||
        normalizedMime === 'binary/octet-stream' ||
        normalizedMime === '';

      // Conservative MIME + URL validation policy:
      // 1. Explicit non-image MIME types (text/*, video/*, audio/*, json, xml, js) are rejected for images.
      // 2. Explicit image/* MIME types are accepted.
      // 3. Ambiguous MIME (octet-stream or empty) is accepted ONLY if URL pathname has a supported image extension.
      // 4. Empty Content-Type strictly requires positive Content-Length.
      // 5. Trusted Booru video candidates: accept ONLY verified video/mp4 and video/webm MIME types.
      //    Never accept ambiguous MIME (octet-stream/empty) based only on URL extension.
      let isAcceptable = false;
      if (!isExplicitNonImageMime(normalizedMime)) {
        if (normalizedMime.startsWith('image/')) {
          isAcceptable = true;
        } else if (isAmbiguousMime && hasImageExtensionInPath(candidate.url)) {
          if (normalizedMime === '') {
            isAcceptable = contentLength > 0;
          } else {
            isAcceptable = (cl === null || contentLength > 0);
          }
        }
      } else if (candidate.allowVideo && candidate.isBooruCandidate && (normalizedMime === 'video/mp4' || normalizedMime === 'video/webm')) {
        isAcceptable = true;
      }

      if (isAcceptable) {
        candidate.verified = true;
        candidate.contentType = normalizedMime;
        candidate.contentLength = contentLength;
        candidate.mimeEvidence = MIME_EVIDENCE.HTTP_RESPONSE;
        candidate.verifiedUrl = candidate.url;

        // Post-verification size & dimension adjustments:
        // Size bonus (provenance remains primary: spread is +5 to +10 vs provenance spread of 50+)
        if (candidate.contentLength > 500 * 1024) {
          candidate.finalScore += 10;
        } else if (candidate.contentLength > 100 * 1024) {
          candidate.finalScore += 5;
        }

        // Known pixel dimensions bonus from metadata
        if (candidate.rawWidth >= 2000 || candidate.rawHeight >= 2000) {
          candidate.finalScore += 10;
        } else if (candidate.rawWidth >= 1000 || candidate.rawHeight >= 1000) {
          candidate.finalScore += 5;
        }

        // Penalty if verified size is confirmed tiny and candidate has thumbnail characteristics
        if (candidate.contentLength > 0 && candidate.contentLength < 25 * 1024 && isThumbnailUrl(candidate.url)) {
          candidate.finalScore -= 20;
        }

        return true;
      }
    }
  } catch (err) {
    if (err?.status) {
      candidate.status = err.status;
      if (err.status === 429) candidate.rateLimited = true;
      if (err.status === 403 || err.status === 401) candidate.authRequired = true;
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (getTimeoutId) {
      clearTimeout(getTimeoutId);
      getTimeoutId = null;
    }
  }

  candidate.verified = false;
  return false;
}

/**
 * Backwards-compatible network image availability verification.
 * Returns true if candidate exists (200 OK) and is an image.
 */
async function verifyImageUrl(candidateUrl) {
  const dummyCandidate = { url: candidateUrl, baseScore: 0, finalScore: 0 };
  return await probeCandidate(dummyCandidate);
}

// ============================================================================
// 3. LEVEL 1: Universal DOM / Link Resolution
// ============================================================================
/**
 * On many websites, the image is wrapped in a link to the full-size version:
 * <a href="ORIGINAL_IMAGE"><img src="PREVIEW_IMAGE"></a>
 * If linkUrl is available on right-click, verify whether it points to the original image.
 * Works universally across web pages.
 */
async function resolveFromLinkUrl(linkUrl, srcUrl) {
  if (!linkUrl || linkUrl === srcUrl) return null;

  try {
    const parsedLink = new URL(linkUrl);
    const pathname = parsedLink.pathname.toLowerCase();

    // Check if the link contains an image extension
    const hasImageExt = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(pathname);

    // Check for typical media file directories in the path
    const isDirectMediaLink = /\/(images?|original|data|_images|content|img\/view|uploads?|media|photos?|assets|pictures?)\//i.test(pathname) ||
      pathname.includes('file_only') ||
      parsedLink.hostname.includes('paheal-cdn.net');

    // Exclude MediaWiki page links (/wiki/File:...) and navigation pages without direct media files
    if (pathname.includes('/wiki/') || pathname.includes('/w/index.php') || /[:/](file|image|файл):/i.test(pathname)) {
      return null;
    }

    const isHtmlPagePattern = /\/(post|posts|comment|comments|user|users|tag|tags|upload|thread|threads|forum|article|blog|artworks?|illust)\//i.test(pathname) && !hasImageExt;
    if (isHtmlPagePattern && !isDirectMediaLink) {
      return null;
    }

    if (hasImageExt || isDirectMediaLink) {
      // Option 1: Cleaned of cache query parameters (?cache)
      const cleaned = new URL(linkUrl);
      cleaned.search = '';
      const cleanUrl = cleaned.toString();

      if (await verifyImageUrl(cleanUrl)) {
        console.log('[MediaLatch] [Уровень 1: Link] Подтверждён URL из ссылки <a> (очищенный):', cleanUrl);
        return cleanUrl;
      }

      // Option 2: Original linkUrl (if query parameters were required for CDN authentication)
      if (linkUrl !== cleanUrl && await verifyImageUrl(linkUrl)) {
        console.log('[MediaLatch] [Уровень 1: Link] Подтверждён исходный URL из ссылки <a>:', linkUrl);
        return linkUrl;
      }
    }
  } catch (e) {
    console.warn('[MediaLatch] Ошибка проверки linkUrl:', e);
  }

  return null;
}

if (typeof importScripts === 'function') importScripts('lib/site_resolvers.js');

// ============================================================================
// 5. LEVEL 3: Booru Engine Type Resolvers (Engine Resolvers)
// ============================================================================

/**
 * Helper to construct rich candidate descriptors for resolvers.
 * Provides backward-compatible string-like methods (.includes, .startsWith, .endsWith, .toString)
 * so existing tests inspecting candidates as strings continue to pass unchanged.
 */
function createCandidateDescriptor(url, opts = {}) {
  const isBooru = opts.isBooruCandidate !== undefined ? opts.isBooruCandidate : true;
  return {
    url,
    score: typeof opts.score === 'number' ? opts.score : 85,
    tier: opts.tier || 'legacy',
    allowVideo: Boolean(opts.allowVideo),
    isBooruCandidate: Boolean(isBooru),
    toString() { return this.url; },
    includes(sub, pos) { return this.url.includes(sub, pos); },
    startsWith(sub, pos) { return this.url.startsWith(sub, pos); },
    endsWith(sub, pos) { return this.url.endsWith(sub, pos); }
  };
}

/**
 * Pure root domain matcher: checks if hostname equals root or ends with .root
 */
function isSameOrSubdomain(hostname, rootDomain) {
  if (!hostname || typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase();
  const root = rootDomain.toLowerCase();
  return h === root || h.endsWith('.' + root);
}

/**
 * Strict Danbooru domain validator.
 */
function isDanbooruDomain(hostname) {
  return isSameOrSubdomain(hostname, 'donmai.us');
}

const DANBOORU_DOM_ALLOWED_EXTS = Object.freeze(new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'webm', 'mp4']));

/**
 * Extracts normalized hostname from a URL string safely.
 */
function getUrlHostname(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * Extracts a 32-character hexadecimal MD5 hash from a URL string if present.
 */
function extractMd5FromUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const match = urlStr.match(/\b([a-f0-9]{32})\b/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Validates DOM metadata collected from a Danbooru-family page.
 * Enforces:
 * 1. Protocol: http or https only.
 * 2. Hostname: *.donmai.us or donmai.us (e.g. cdn.donmai.us).
 * 3. Extension: whitelisted image/video extensions only.
 * 4. MD5 consistency: if clicked URL contains an MD5 hash, meta.md5 must match it.
 */
function isValidDanbooruMetadata(meta, clickedUrl) {
  if (!meta || typeof meta !== 'object') return false;
  const originalUrl = meta.originalUrl;
  if (!originalUrl || typeof originalUrl !== 'string') return false;

  let parsed;
  try {
    parsed = new URL(originalUrl);
  } catch (_) {
    return false;
  }

  // 1. Protocol validation: http/https only
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // 2. Domain validation: *.donmai.us
  const host = parsed.hostname.toLowerCase();
  if (!isDanbooruDomain(host)) {
    return false;
  }

  // 3. Extension validation
  let ext = (meta.fileExt || '').toLowerCase().trim();
  if (!ext) {
    const dotIdx = parsed.pathname.lastIndexOf('.');
    if (dotIdx !== -1) {
      ext = parsed.pathname.substring(dotIdx + 1).toLowerCase();
    }
  }
  if (!DANBOORU_DOM_ALLOWED_EXTS.has(ext)) {
    return false;
  }

  // 4. Positive asset identity correlation: require positive evidence linking meta to clickedUrl
  if (clickedUrl) {
    const clickedMd5 = extractMd5FromUrl(clickedUrl);
    const origMd5 = extractMd5FromUrl(parsed.pathname);
    const metaMd5 = meta.md5 ? String(meta.md5).toLowerCase().trim() : null;

    if (clickedMd5) {
      // Conflicting evidence check: neither meta.md5 nor originalUrl may conflict with clickedMd5
      if (metaMd5 && metaMd5 !== clickedMd5) {
        return false;
      }
      if (origMd5 && origMd5 !== clickedMd5) {
        return false;
      }
      // Positive evidence check: at least one source (meta.md5 or originalUrl) must match clickedMd5
      const hasPositiveMd5 = (metaMd5 === clickedMd5) || (origMd5 === clickedMd5);
      if (!hasPositiveMd5) {
        return false;
      }
    } else {
      // Clicked URL did not contain an MD5; check post ID if available
      const postMatch = clickedUrl.match(/\/posts\/(\d+)/i);
      if (postMatch && postMatch[1]) {
        const clickedPostId = postMatch[1];
        if (!meta.postId || String(meta.postId) !== clickedPostId) {
          return false;
        }
      } else {
        // Neither MD5 nor post ID available from clickedUrl: cannot establish positive identity correlation
        return false;
      }
    }

    // Additional post ID check if both present
    if (meta.postId) {
      const postMatch = clickedUrl.match(/\/posts\/(\d+)/i);
      if (postMatch && postMatch[1] && String(meta.postId) !== postMatch[1]) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Queries content/content_booru.js for ephemeral clicked element metadata.
 */
async function queryBooruDomMetadata(tabId, clickedUrl) {
  if (!tabId || typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return null;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 500);

    const onResult = (res) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (chrome.runtime?.lastError || !res || !res.success || !res.metadata) {
        resolve(null);
      } else {
        resolve(res.metadata);
      }
    };

    try {
      const p = chrome.tabs.sendMessage(tabId, { action: 'GET_BOORU_DOM_METADATA', clickedUrl }, onResult);
      if (p && typeof p.then === 'function') {
        p.then(onResult).catch(() => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(null);
          }
        });
      }
    } catch (_) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }
  });
}

/**
 * Strict Gelbooru domain validator covering all 12 existing supported booru boards.
 */
const GELBOORU_ROOT_DOMAINS = [
  'gelbooru.com',
  'rule34.xxx',
  'safebooru.org',
  'realbooru.com',
  'xbooru.com',
  'hypnohub.net',
  'tbib.org',
  'curveybooru.com',
  'inkbooru.com',
  'mspabooru.com',
  'scatbooru.com',
  'yakui.ru'
];

function isGelbooruDomain(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase();
  return GELBOORU_ROOT_DOMAINS.some(root => isSameOrSubdomain(h, root));
}

/**
 * Strict e621 domain validator.
 */
function isE621Domain(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  return isSameOrSubdomain(hostname, 'e621.net') ||
         isSameOrSubdomain(hostname, 'e926.net') ||
         isSameOrSubdomain(hostname, 'e6ai.net');
}

/**
 * Validates asset URLs returned by e621 API queries.
 * Enforces:
 * 1. Protocol: http or https only.
 * 2. Hostname: e621.net, e926.net, e6ai.net or legitimate subdomains (e.g. static1.e621.net).
 * 3. MD5 consistency: if URL pathname contains an MD5 hash, it must match the expected MD5.
 */
function isValidE621AssetUrl(fileUrl, expectedMd5) {
  if (!fileUrl || typeof fileUrl !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(fileUrl);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (!isE621Domain(parsed.hostname)) return false;

  if (expectedMd5) {
    const urlMd5 = extractMd5FromUrl(parsed.pathname);
    if (urlMd5 && urlMd5.toLowerCase() !== expectedMd5.toLowerCase()) {
      return false;
    }
  }
  return true;
}

/**
 * Helper function to generate candidate URLs with different file extensions
 * Prevents blind extension replacement and verifies actual formats on the server.
 */
function generateExtensionCandidates(urlObj, basePath, currentExt, options = {}) {
  const includeVideo = Boolean(options && options.includeVideo);
  let extensions;
  const ext = (currentExt || '').toLowerCase();

  if (ext === '.mp4' || ext === '.webm') {
    extensions = [ext, ext === '.mp4' ? '.webm' : '.mp4', '.jpeg', '.jpg', '.png'];
  } else if (ext === '.jpg' || ext === '.jpeg') {
    extensions = ['.jpeg', '.jpg', '.png', '.gif', '.webp'];
    if (includeVideo) extensions.push('.mp4', '.webm');
  } else if (ext === '.png') {
    extensions = ['.png', '.jpeg', '.jpg', '.gif', '.webp'];
    if (includeVideo) extensions.push('.mp4', '.webm');
  } else {
    extensions = [ext, '.jpeg', '.jpg', '.png', '.gif', '.webp'];
    if (includeVideo) extensions.push('.mp4', '.webm');
  }

  extensions = Array.from(new Set(extensions.filter(Boolean)));

  const results = [];
  for (const itemExt of extensions) {
    const cand = new URL(urlObj.toString());
    cand.pathname = `${basePath}${itemExt}`;
    cand.search = ''; // Strip cache query parameters
    results.push(cand.toString());
  }
  return results;
}

const BOORU_ENGINE_RESOLVERS = [
  // --------------------------------------------------------------------------
  // 5.1 Danbooru & Danbooru-based (Danbooru, Safebooru.donmai.us, BleachBooru, Booruvar, etc.)
  // --------------------------------------------------------------------------
  {
    name: 'DanbooruEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      return isDanbooruDomain(host);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;

      // If URL already points to /original/
      if (pathname.includes('/original/') && !pathname.includes('sample-') && !pathname.includes('sample_')) {
        const isVid = pathname.endsWith('.mp4') || pathname.endsWith('.webm');
        candidates.push(createCandidateDescriptor(urlObj.toString(), {
          score: 90,
          tier: 'original',
          allowVideo: isVid
        }));
      }

      // 1. MD5 lookup via official Danbooru API
      const md5Match = urlObj.toString().match(/\b([a-f0-9]{32})\b/i);
      let apiKnownExt = null;
      if (md5Match) {
        const md5 = md5Match[1].toLowerCase();
        try {
          let apiDomain = 'https://danbooru.donmai.us';
          if (pageUrl) {
            try {
              const parsedPage = new URL(pageUrl);
              if (parsedPage.hostname.toLowerCase() === 'safebooru.donmai.us') {
                apiDomain = 'https://safebooru.donmai.us';
              }
            } catch (_) {}
          }
          const apiUrl = `${apiDomain}/posts.json?tags=md5:${md5}`;
          const posts = await fetchResolverMetadata(apiUrl);

          if (posts) {
            if (Array.isArray(posts) && posts[0]) {
              const p = posts[0];
              apiKnownExt = (p.file_ext || '').toLowerCase();
              const isVid = apiKnownExt === 'mp4' || apiKnownExt === 'webm';

              if (p.file_url) {
                candidates.push(createCandidateDescriptor(p.file_url, {
                  score: 90,
                  tier: 'original',
                  allowVideo: isVid
                }));
              }
              const origVariant = p.media_asset?.variants?.find(v => v.type === 'original');
              if (origVariant?.url) {
                candidates.push(createCandidateDescriptor(origVariant.url, {
                  score: 90,
                  tier: 'original',
                  allowVideo: isVid
                }));
              }
              if (p.large_file_url) {
                candidates.push(createCandidateDescriptor(p.large_file_url, {
                  score: 85,
                  tier: 'original',
                  allowVideo: isVid
                }));
              }
            }
          }
        } catch (e) {}
      }

      // 2. Deterministic Danbooru CDN path transformation:
      // /data/sample/sample-[md5].jpg -> /data/original/[md5].[ext]
      if (pathname.includes('/sample') || pathname.includes('/preview') || pathname.includes('/180x180') || pathname.includes('/360x360')) {
        let origPath = pathname.replace(/\/(sample|\d+x\d+|preview)\//g, '/original/');
        origPath = origPath.replace(/sample[-_]/g, '');

        const dotIdx = origPath.lastIndexOf('.');
        const basePath = dotIdx !== -1 ? origPath.substring(0, dotIdx) : origPath;
        const ext = dotIdx !== -1 ? origPath.substring(dotIdx) : '.jpg';

        const extCands = generateExtensionCandidates(urlObj, basePath, ext, { includeVideo: true });
        for (const c of extCands) {
          const isVid = c.endsWith('.mp4') || c.endsWith('.webm');
          candidates.push(createCandidateDescriptor(c, {
            score: 80,
            tier: 'legacy',
            allowVideo: isVid
          }));
        }
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.2 Gelbooru & Gelbooru-based (Gelbooru, Rule34, Safebooru.org, Realbooru, Xbooru, HypnoHub, CurveyBooru, TBIB, etc.)
  // --------------------------------------------------------------------------
  {
    name: 'GelbooruEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      return isGelbooruDomain(host);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;
      const urlStr = urlObj.toString();

      // Extract expected MD5 from clicked preview if present
      const clickedMd5Match = urlStr.match(/\b([a-f0-9]{32})\b/i);
      const expectedMd5 = clickedMd5Match ? clickedMd5Match[1].toLowerCase() : null;

      // 1. Post view link resolution (index.php?page=post&s=view&id=... or /post&s=view&id=...)
      // Strict pre-fetch validation: candidate must be on a verified Gelbooru domain with http(s)
      const postCandidates = [linkUrl, urlStr, pageUrl].filter(u => {
        if (!u || typeof u !== 'string') return false;
        try {
          const parsed = new URL(u);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
          if (!isGelbooruDomain(parsed.hostname)) return false;
          return (/(?:page=post|post)&s=view&id=\d+/i.test(parsed.search) || /[?&]id=\d+/i.test(parsed.search));
        } catch (_) {
          return false;
        }
      });

      const postUrlCandidate = postCandidates[0] || null;

      if (postUrlCandidate) {
        try {
          const html = await fetchResolverMetadata(postUrlCandidate, { redirect: 'error', text: true });

          if (html) {

            // A. Video player element extraction (<video id="gelcomVideoPlayer"> or <source>)
            const videoMatch = html.match(/<video[^>]+id=["']gelcomVideoPlayer["'][^>]*\bsrc=["']([^"']+)["']/i) ||
                               html.match(/<video[^>]*\bsrc=["']([^"']+)["'][^>]*id=["']gelcomVideoPlayer["']/i) ||
                               html.match(/<video[^>]*id=["']gelcomVideoPlayer["'][^>]*>[\s\S]*?<source[^>]*\bsrc=["']([^"']+)["']/i);

            // B. Original image anchor
            const origMatch = html.match(/<a[^>]+href=["']([^"']+\/images\/[^"']+)["'][^>]*>(?:Original\s+(?:image|video)|View\s+larger)<\/a>/i) ||
                              html.match(/<li[^>]*><a[^>]+href=["']([^"']+\/images\/[^"']+)["'][^>]*>Original image<\/a>/i);

            const rawFound = (videoMatch && (videoMatch[1] || videoMatch[2])) || (origMatch && origMatch[1]);
            if (rawFound) {
              try {
                const parsedFound = new URL(rawFound.replace('//images/', '/images/'), postUrlCandidate);
                // Security check 1: verified Gelbooru domain & http(s)
                if (isGelbooruDomain(parsedFound.hostname) && (parsedFound.protocol === 'https:' || parsedFound.protocol === 'http:')) {
                  // Security check 2: media path must be under /images/
                  if (/\/images\//i.test(parsedFound.pathname)) {
                    // Security check 3: bind scraped media to clicked post MD5 if known
                    const foundMd5Match = parsedFound.pathname.match(/\b([a-f0-9]{32})\b/i);
                    const foundMd5 = foundMd5Match ? foundMd5Match[1].toLowerCase() : null;
                    if (!expectedMd5 || !foundMd5 || expectedMd5 === foundMd5) {
                      const isVid = parsedFound.pathname.endsWith('.mp4') || parsedFound.pathname.endsWith('.webm');
                      candidates.push(createCandidateDescriptor(parsedFound.toString(), {
                        score: 90,
                        tier: 'original',
                        allowVideo: isVid
                      }));
                    }
                  }
                }
              } catch (_) {}
            }
          }
        } catch (e) {}
      }

      // 2. Deterministic path transformation:
      // /samples/<dir>/sample_<filename>.jpg?<cache> -> /images/<dir>/<filename>.<original_extension>
      // /thumbnails/<dir>/thumbnail_<filename>.jpg -> /images/<dir>/<filename>.<original_extension>
      if (/\/+(samples?|thumbnails?)\/+/i.test(pathname)) {
        const imagesPath = pathname.replace(/\/+(samples?|thumbnails?)\/+/i, '/images/').replace(/\/\/+/g, '/');

        const lastSlash = imagesPath.lastIndexOf('/');
        const dir = imagesPath.substring(0, lastSlash + 1);
        let filename = imagesPath.substring(lastSlash + 1);

        // Remove sample_ and thumbnail_ prefixes
        filename = filename.replace(/^(sample[-_]|thumbnail[-_]|thumb[-_])/i, '');

        const dotIndex = filename.lastIndexOf('.');
        const baseName = dotIndex !== -1 ? filename.substring(0, dotIndex) : filename;
        const currentExt = dotIndex !== -1 ? filename.substring(dotIndex).toLowerCase() : '.jpg';

        // 2a. Speculative video-cdn candidates if on img*.gelbooru.com (MP4 and WebM)
        if (urlObj.hostname.startsWith('img') && urlObj.hostname.endsWith('.gelbooru.com')) {
          const videoCand = new URL(urlObj.toString());
          videoCand.hostname = urlObj.hostname.replace(/^img/, 'video-cdn');
          videoCand.pathname = `${dir}${baseName}.mp4`;
          videoCand.search = '';
          candidates.push(createCandidateDescriptor(videoCand.toString(), {
            score: 80,
            tier: 'legacy',
            allowVideo: true
          }));

          const webmCand = new URL(urlObj.toString());
          webmCand.hostname = urlObj.hostname.replace(/^img/, 'video-cdn');
          webmCand.pathname = `${dir}${baseName}.webm`;
          webmCand.search = '';
          candidates.push(createCandidateDescriptor(webmCand.toString(), {
            score: 80,
            tier: 'legacy',
            allowVideo: true
          }));
        }

        // 2b. Standard extension candidates on current host
        const extCands = generateExtensionCandidates(urlObj, `${dir}${baseName}`, currentExt, { includeVideo: true });
        for (const c of extCands) {
          const isVid = c.endsWith('.mp4') || c.endsWith('.webm');
          candidates.push(createCandidateDescriptor(c, {
            score: 80,
            tier: 'legacy',
            allowVideo: isVid
          }));
        }
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.3 Moebooru (Konachan, Konachan Safe, Yande.re, Sakugabooru, Genboard)
  // --------------------------------------------------------------------------
  {
    name: 'MoebooruEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      const moebooruRoots = ['konachan.com', 'konachan.net', 'yande.re', 'sakugabooru.com'];
      return moebooruRoots.some(r => isSameOrSubdomain(host, r));
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;
      const host = urlObj.hostname.toLowerCase();
      const pageHost = pageUrl ? (function() { try { return new URL(pageUrl).hostname.toLowerCase(); } catch (e) { return ''; } })() : '';

      // 1. Sample transformation: /sample/<hash>/<title> sample <tags>.jpg -> /image/<hash>/<title> <tags>.<ext>
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

        const extCands = generateExtensionCandidates(urlObj, basePath, ext, { includeVideo: true });
        for (const c of extCands) {
          const isVid = c.endsWith('.mp4') || c.endsWith('.webm');
          candidates.push(createCandidateDescriptor(c, {
            score: 80,
            tier: 'legacy',
            allowVideo: isVid
          }));
        }
      }

      // 2. Thumbnail from /data/preview/<hash>.jpg via Moebooru API and deterministic fallback
      if (pathname.includes('/preview/')) {
        const md5Match = pathname.match(/([a-f0-9]{32})/i);
        if (md5Match) {
          const md5 = md5Match[1].toLowerCase();
          try {
            let apiDomain = urlObj.origin;
            if (host.endsWith('konachan.com') || pageHost.endsWith('konachan.com')) {
              apiDomain = 'https://konachan.com';
            } else if (host.endsWith('konachan.net') || pageHost.endsWith('konachan.net')) {
              apiDomain = 'https://konachan.net';
            } else if (host.endsWith('sakugabooru.com') || pageHost.endsWith('sakugabooru.com')) {
              apiDomain = 'https://sakugabooru.com';
            } else if (host === 'yande.re' || host.endsWith('.yande.re') || pageHost === 'yande.re' || pageHost.endsWith('.yande.re')) {
              apiDomain = 'https://yande.re';
            }
            const apiUrl = `${apiDomain}/post.json?tags=md5:${md5}`;
            const posts = await fetchResolverMetadata(apiUrl);

            if (posts) {
              if (Array.isArray(posts) && posts[0]?.file_url) {
                const fileUrl = posts[0].file_url;
                const fileExt = (posts[0].file_ext || '').toLowerCase();
                const isVid = fileExt === 'mp4' || fileExt === 'webm' ||
                              fileUrl.endsWith('.mp4') || fileUrl.endsWith('.webm') ||
                              /\.(mp4|webm)($|\?)/i.test(fileUrl);
                candidates.unshift(createCandidateDescriptor(fileUrl, {
                  score: 90,
                  tier: 'original',
                  allowVideo: isVid
                }));
              }
            }
          } catch (e) {}

          // Deterministic fallback candidates for Moebooru preview
          const extCands = generateExtensionCandidates(urlObj, `/data/${md5}`, '.mp4', { includeVideo: true });
          for (const c of extCands) {
            const isVid = c.endsWith('.mp4') || c.endsWith('.webm');
            candidates.push(createCandidateDescriptor(c, {
              score: 80,
              tier: 'legacy',
              allowVideo: isVid
            }));
          }
        }
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.4 Philomena (Derpibooru, Furbooru, Manebooru, Ponerpics, Ponybooru, Twibooru)
  // --------------------------------------------------------------------------
  {
    name: 'PhilomenaEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      const pageHost = pageUrl ? (function() { try { return new URL(pageUrl).hostname.toLowerCase(); } catch (e) { return ''; } })() : '';
      const philomenaPattern = /derpibooru|furbooru|manebooru|ponerpics|ponybooru|twibooru|derpicdn/i;
      return philomenaPattern.test(host) || philomenaPattern.test(pageHost);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const urlStr = urlObj.toString();

      const cdnMatch = urlStr.match(/\/img\/(?:view\/)?(\d{4}\/\d{1,2}\/\d{1,2})\/(\d+)/i);
      const postMatch = urlStr.match(/\b(\d{6,8})\b/) || (pageUrl && pageUrl.match(/\b(\d{6,8})\b/));
      const imageId = postMatch ? postMatch[1] : null;

      if (cdnMatch) {
        const datePath = cdnMatch[1];
        const id = cdnMatch[2];
        const basePath = `/img/view/${datePath}/${id}`;

        const candJpg = new URL(urlObj.toString());
        candJpg.pathname = `${basePath}.jpg`;
        candJpg.search = '';
        candidates.push(candJpg.toString());

        const candPng = new URL(urlObj.toString());
        candPng.pathname = `${basePath}.png`;
        candPng.search = '';
        candidates.push(candPng.toString());

        const candWebp = new URL(urlObj.toString());
        candWebp.pathname = `${basePath}.webp`;
        candWebp.search = '';
        candidates.push(candWebp.toString());
      }

      if (imageId) {
        try {
          const apiHost = urlObj.hostname.includes('derpicdn.net') ? 'https://derpibooru.org' : urlObj.origin;
          const apiUrl = `${apiHost}/api/v1/json/images/${imageId}`;
          const data = await fetchResolverMetadata(apiUrl);

          if (data) {
            if (data.image?.representations?.full) {
              candidates.unshift(data.image.representations.full);
            } else if (data.image?.view_url) {
              candidates.push(data.image.view_url);
            }
          }
        } catch (e) {}
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.5 e621 / e926 / e6AI
  // --------------------------------------------------------------------------
  {
    name: 'E621Engine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      return isE621Domain(host);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;

      // 1. Direct original media URL recognition
      const origMatch = pathname.match(/\/data\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{32})\.(webm|mp4|png|jpe?g|gif)/i);
      if (origMatch && !pathname.includes('/sample/') && !pathname.includes('/preview/')) {
        const ext = origMatch[4].toLowerCase();
        const isVid = ext === 'webm' || ext === 'mp4';
        candidates.push(createCandidateDescriptor(urlObj.toString(), {
          score: 90,
          tier: 'original',
          allowVideo: isVid
        }));
      }

      // 2. Sample/preview recovery with API resolution and deterministic CDN candidates
      const e6Match = pathname.match(/\/data\/(?:sample|preview)\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{32})/i);
      if (e6Match) {
        const p1 = e6Match[1];
        const p2 = e6Match[2];
        const md5 = e6Match[3].toLowerCase();

        // 2a. Official e621 / e926 API lookup
        try {
          let apiDomain = 'https://e621.net';
          if (pageUrl) {
            try {
              const pHost = new URL(pageUrl).hostname.toLowerCase();
              if (isSameOrSubdomain(pHost, 'e926.net')) apiDomain = 'https://e926.net';
              else if (isSameOrSubdomain(pHost, 'e6ai.net')) apiDomain = 'https://e6ai.net';
            } catch (_) {}
          }
          const apiUrl = `${apiDomain}/posts.json?tags=md5:${md5}`;
          const data = await fetchResolverMetadata(apiUrl);

          if (data) {
            const posts = Array.isArray(data) ? data : (data.posts || data.post);
            if (Array.isArray(posts) && posts[0]) {
              const p = posts[0];
              const fileObj = p.file || {};
              const fileUrl = fileObj.url || p.file_url;
              const respMd5 = (fileObj.md5 || p.md5 || '').toLowerCase();
              let urlMd5 = '';
              try {
                if (fileUrl) {
                  urlMd5 = (extractMd5FromUrl(new URL(fileUrl).pathname) || '').toLowerCase();
                }
              } catch (_) {}

              // Positive identity evidence: at least one MD5 source must equal the requested md5
              const hasPositiveEvidence = (respMd5 === md5) || (urlMd5 === md5);
              // Conflicting evidence: neither source may conflict with requested md5
              const hasConflict = (respMd5 && respMd5 !== md5) || (urlMd5 && urlMd5 !== md5);

              // Post ID correlation if on a post page: require returned post ID to be present AND equal to page ID
              let postIdMismatch = false;
              if (pageUrl) {
                const pagePostMatch = pageUrl.match(/\/posts\/(\d+)/i);
                if (pagePostMatch && pagePostMatch[1]) {
                  const expectedPostId = pagePostMatch[1];
                  const returnedId = (p.id !== undefined && p.id !== null) ? String(p.id) : '';
                  if (!returnedId || returnedId !== expectedPostId) {
                    postIdMismatch = true;
                  }
                }
              }

              if (fileUrl && hasPositiveEvidence && !hasConflict && !postIdMismatch && isValidE621AssetUrl(fileUrl, md5)) {
                const fileExt = (fileObj.ext || p.file_ext || '').toLowerCase();
                const isVid = fileExt === 'webm' || fileExt === 'mp4' ||
                              (/\.(webm|mp4)($|\?)/i.test(fileUrl));

                // Preserve fileUrl byte-for-byte including signed query parameters
                candidates.unshift(createCandidateDescriptor(fileUrl, {
                  score: 90,
                  tier: 'original',
                  allowVideo: isVid
                }));
              } else if (fileUrl) {
                console.warn('[MediaLatch] Отклонен недоверенный или несовпадающий URL медиа e621 API:', sanitizeUrlForLog(fileUrl));
              }
            }
          }
        } catch (_) {}

        // 2b. Deterministic CDN candidates (fallback / offline)
        const basePath = `/data/${p1}/${p2}/${md5}`;
        const extCands = generateExtensionCandidates(urlObj, basePath, '.png', { includeVideo: true });
        for (const c of extCands) {
          const isVid = c.endsWith('.mp4') || c.endsWith('.webm');
          candidates.push(createCandidateDescriptor(c, {
            score: 80,
            tier: 'legacy',
            allowVideo: isVid
          }));
        }
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.6 Shimmie & Shimmie 2 (Rule34 Paheal, Cavepaintings, Fanservice, etc.)
  // --------------------------------------------------------------------------
  {
    name: 'ShimmieEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      const pageHost = pageUrl ? (function() { try { return new URL(pageUrl).hostname.toLowerCase(); } catch (e) { return ''; } })() : '';
      const shimmiePattern = /paheal|shimmie|gikopoi|gyate|leftybooru|vinebooru|soybooru|ongezellig/i;
      return shimmiePattern.test(host) || shimmiePattern.test(pageHost) || /_thumbs\/|r34t\./i.test(urlObj.toString());
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const urlStr = urlObj.toString();
      const pathname = urlObj.pathname;

      if (urlObj.hostname.includes('r34t.paheal.net') || urlObj.hostname.includes('paheal')) {
        const pahealOrig = new URL(urlStr);
        pahealOrig.hostname = 'r34i.paheal-cdn.net';
        candidates.push(pahealOrig.toString());
      }

      if (pathname.includes('/_thumbs/') || pathname.includes('/thumbs/')) {
        const origPath = pathname.replace(/\/_thumbs\//, '/_images/').replace(/\/thumbs\//, '/images/');
        const dir = origPath.substring(0, origPath.lastIndexOf('/') + 1);

        const candJpg = new URL(urlObj.toString());
        candJpg.pathname = origPath;
        candidates.push(candJpg.toString());

        const hashMatch = pathname.match(/([a-f0-9]{32})/i);
        if (hashMatch) {
          candidates.push(...generateExtensionCandidates(urlObj, `${dir}${hashMatch[1]}`, '.jpg'));
        }
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.7 Szurubooru (Szurubooru, EquiBooru, Snootbooru)
  // --------------------------------------------------------------------------
  {
    name: 'SzurubooruEngine',
    match: (urlObj, pageUrl) => {
      const host = urlObj.hostname.toLowerCase();
      const pageHost = pageUrl ? (function() { try { return new URL(pageUrl).hostname.toLowerCase(); } catch (e) { return ''; } })() : '';
      return /szuru|equibooru|snootbooru/i.test(host) || /szuru|equibooru|snootbooru/i.test(pageHost) || /\/generated\/(thumbnail|preview)\//i.test(urlObj.pathname);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;

      const szuruMatch = pathname.match(/\/generated\/(?:thumbnail|preview)\/([a-f0-9]+)/i);
      if (szuruMatch) {
        const hash = szuruMatch[1];
        candidates.push(...generateExtensionCandidates(urlObj, `/generated/content/${hash}`, '.png'));
        candidates.push(...generateExtensionCandidates(urlObj, `/content/${hash}`, '.png'));
      }

      return candidates;
    }
  },

  // --------------------------------------------------------------------------
  // 5.8 Piwigo
  // --------------------------------------------------------------------------
  {
    name: 'PiwigoEngine',
    match: (urlObj, pageUrl) => {
      return /_data\/i\/upload/i.test(urlObj.pathname) || /piwigo/i.test(urlObj.hostname);
    },
    resolve: async (urlObj, pageUrl, linkUrl) => {
      const candidates = [];
      const pathname = urlObj.pathname;

      if (pathname.includes('/_data/i/upload/')) {
        let clean = pathname.replace('/_data/i/upload/', '/upload/');
        clean = clean.replace(/-(th|me|la|sq|xl|xx|2x)\.([a-z0-9]+)$/i, '.$2');

        const cand = new URL(urlObj.toString());
        cand.pathname = clean;
        cand.search = '';
        candidates.push(cand.toString());
      }

      return candidates;
    }
  }
];

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
 * its claim is stale and is 'refused'. Local DOM reads only: no network, no messages.
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


// ============================================================================
// 7. LEVEL 5: Universal CDN and Heuristic Transformations
// ============================================================================
/**
 * Generates candidate original URLs for popular CDNs, CMSs, and Boorus:
 * - WordPress contract only (/wp-content/uploads/, Photon i0-i2.wp.com): drop the named size keys (?w=, ?h=, ?resize=, ?crop=, ?fit=, ?quality=)
 * - Strip CMS/WordPress resize suffixes (-1024x768.jpg -> .jpg)
 * - Universal replacement of typical preview folders (/sample/, /thumb/, /small/, /medium/)
 *
 * Identity: the query of the selected address (an id, a repeated key, a signature, a cache token) is part of what was selected, and a queryless
 * address that answers with plausible media is another asset: MIME or size does not prove equivalence. No derivative therefore drops the query;
 * only the named size pairs of the documented WordPress contract are removed, textually, so every other byte of the query stays as it was.
 */
function getGenericCdnCandidates(urlObj) {
  const candidates = [];
  const pathname = urlObj.pathname;
  const urlStr = urlObj.toString();
  const keepSearch = urlObj.search;
  const withSearch = (href, search) => { const c = new URL(href); c.search = search; return c.toString(); };

  const resizeParams = [
    'width', 'w', 'max_width', 'maxwidth',
    'height', 'h', 'max_height', 'maxheight',
    'resize', 'crop', 'fit', 'size', 'scale', 'quality', 'q'
  ];
  const isWordPressContract = /\/wp-content\/uploads\//i.test(pathname) || /^i[0-2]\.wp\.com$/i.test(urlObj.hostname);
  // the same query without the named size pairs; every other pair keeps its raw bytes and order
  let sizeFreeSearch = keepSearch;
  if (isWordPressContract && keepSearch.length > 1) {
    const kept = keepSearch.slice(1).split('&').filter((pair) => {
      let key = pair.split('=')[0].replace(/\+/g, ' ');
      try { key = decodeURIComponent(key); } catch (_) {}
      return !resizeParams.includes(key);
    });
    sizeFreeSearch = kept.length ? `?${kept.join('&')}` : '';
  }
  const searches = sizeFreeSearch !== keepSearch ? [sizeFreeSearch, keepSearch] : [keepSearch];

  if (sizeFreeSearch !== keepSearch) candidates.push(withSearch(urlStr, sizeFreeSearch));

  // 2. Strip CMS / WordPress resize suffixes from filename path:
  // photo-1024x768.jpg -> photo.jpg
  // banner-300x200.png -> banner.png
  if (/-\d+x\d+\.([a-z0-9]+)$/i.test(pathname)) {
    const unscaledPath = pathname.replace(/-\d+x\d+\.([a-z0-9]+)$/i, '.$1');
    for (const search of searches) {
      const cand = new URL(urlStr);
      cand.pathname = unscaledPath;
      candidates.push(withSearch(cand.toString(), search));
    }
  }

  // 3. Typical preview path structures for web directories and Boorus:
  const pathPatterns = [
    { pattern: /\/+samples?\//gi, replacements: ['/images/', '/image/', '/original/', '/full/'] },
    { pattern: /\/+(previews?)\//gi, replacements: ['/original/', '/images/', '/image/', '/full/'] },
    { pattern: /\/+(thumbs?|thumbnails?)\//gi, replacements: ['/images/', '/image/', '/original/', '/full/'] },
    { pattern: /\/+small\//gi, replacements: ['/original/', '/large/', '/full/'] },
    { pattern: /\/+medium\//gi, replacements: ['/original/', '/large/', '/full/'] }
  ];

  for (const item of pathPatterns) {
    if (item.pattern.test(pathname)) {
      for (const rep of item.replacements) {
        let newPath = pathname.replace(item.pattern, rep);

        const lastSlash = newPath.lastIndexOf('/');
        const dir = newPath.substring(0, lastSlash + 1);
        let file = newPath.substring(lastSlash + 1);

        file = file.replace(/^(sample[-_]|thumb(nail)?[-_]|small[-_]|medium[-_])/i, '');
        file = file.replace(/([ _-]sample[ _-]|%20sample%20)/gi, ' ');

        const dotIdx = file.lastIndexOf('.');
        const baseName = dotIdx !== -1 ? file.substring(0, dotIdx) : file;
        const ext = dotIdx !== -1 ? file.substring(dotIdx).toLowerCase() : '.jpg';

        // generateExtensionCandidates serves provider resolvers too and drops the query; a generic derivative keeps the selected one
        candidates.push(...generateExtensionCandidates(urlObj, `${dir}${baseName}`, ext).map((c) => withSearch(c, keepSearch)));
      }
    }
  }

  return candidates;
}

// ============================================================================
// 8. MAIN ORIGINAL IMAGE RESOLUTION PIPELINE
// ============================================================================
/**
 * Executes strictly ordered resolution of highest-quality original image:
 * 1. direct link (DOM <a> linkUrl)
 * 2. known site resolver (X/Twitter, Pixiv, Reddit)
 * 3. known engine resolver (Danbooru, Gelbooru, Moebooru, Philomena, e621, Shimmie, Szurubooru, Piwigo)
 * 4. DOM metadata / srcset / data-* / page metadata
 * 5. generic CDN / preview transforms (?w=, -1024x768, /sample/, /thumb/)
 * 6. public metadata / API resolver (MD5)
 * 7. reliable fallback to initial srcUrl
 */
// ============================================================================
// 8. MAIN UNIVERSAL CANDIDATE DISCOVERY, SCORING & RESOLUTION PIPELINE
// ============================================================================
/**
 * Executes universal image resolution:
 * 1. Universal candidate discovery (scoped DOM metadata, links, attributes, background-image)
 * 2. Specialized candidate providers (Twitter, Pixiv, Reddit, Wikimedia, Boorus, Google, Yandex, Anime-Pictures)
 * 3. Universal CDN & CMS heuristics (query stripping, -1024x768 unscaling, preview/sample path transforms)
 * 4. Deterministic candidate scoring based on provenance, resolution, and thumbnail penalties
 * 5. Candidate verification (200 OK + Content-Type) & post-verification dimension/size refinement
 * 6. Best verified candidate selection
 * 7. Reliable fallback to initial srcUrl
 */
// ============================================================================
// 7b. UNIVERSAL MEDIA DESCRIPTOR & VIDEO RESOLUTION
// ============================================================================

/**
 * Universal Media Descriptor factory for clicked media (image, gif, video, x_tweet_video)
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
  isHlsOnly = false
} = {}) {
  const normalizedSrc = (src || currentSrc || '').trim();
  const normalizedCurrent = (currentSrc || src || '').trim();
  let normalizedType = type;
  if (!normalizedType) {
    if (isDirectVideoUrl(normalizedSrc) || (mime && mime.startsWith('video/'))) {
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
    isHlsOnly: Boolean(isHlsOnly)
  };
}

/**
 * Infers video MIME from URL or format parameters
 */
function detectVideoMime(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith('.webm')) return 'video/webm';
    if (pathname.endsWith('.mp4')) return 'video/mp4';
    if (pathname.endsWith('.mov')) return 'video/quicktime';
    if (pathname.endsWith('.m4v')) return 'video/x-m4v';
    if (pathname.endsWith('.ogv') || pathname.endsWith('.ogg')) return 'video/ogg';

    const qf = (parsed.searchParams.get('format') || parsed.searchParams.get('ext') || parsed.searchParams.get('mime') || '').toLowerCase();
    if (qf.includes('webm')) return 'video/webm';
    if (qf.includes('mp4')) return 'video/mp4';
    if (qf.includes('mov') || qf.includes('quicktime')) return 'video/quicktime';
    if (qf.includes('m4v')) return 'video/x-m4v';
    if (qf.includes('ogv') || qf.includes('ogg')) return 'video/ogg';
  } catch (_) {
    const lower = url.toLowerCase();
    if (lower.includes('.webm') || lower.includes('format=webm') || lower.includes('ext=webm') || lower.includes('mime=video/webm')) return 'video/webm';
    if (lower.includes('.mp4') || lower.includes('format=mp4') || lower.includes('ext=mp4') || lower.includes('mime=video/mp4')) return 'video/mp4';
    if (lower.includes('.ogv') || lower.includes('.ogg') || lower.includes('format=ogv')) return 'video/ogg';
    if (lower.includes('.mov')) return 'video/quicktime';
    if (lower.includes('.m4v')) return 'video/x-m4v';
  }
  return 'video/mp4';
}

/**
 * Checks if a given URL is a direct video link or format
 */
function isDirectVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    // Reject DASH/HLS manifests and HTML pages upfront
    if (pathname.endsWith('.mpd') || pathname.endsWith('.m3u8') || pathname.endsWith('.html') || pathname.includes('/comments/')) {
      return false;
    }

    // Reddit video hosts (extensionless endpoints)
    if (host === 'v.redd.it' || host === 'packaged-media.redd.it') {
      return true;
    }

    if (/\.(mp4|webm|ogv|mov|m4v)$/i.test(pathname)) {
      return true;
    }
    const queryFormat = parsed.searchParams.get('format') ||
                        parsed.searchParams.get('fm') ||
                        parsed.searchParams.get('ext') ||
                        parsed.searchParams.get('type') ||
                        parsed.searchParams.get('mime');
    if (queryFormat && /^(mp4|webm|ogv|mov|m4v|video\/)/i.test(queryFormat.trim())) {
      return true;
    }
  } catch (_) {
    if (/\.(mp4|webm|ogv|mov|m4v)(\?.*)?$/i.test(url)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a given URL is an HLS playlist/manifest (.m3u8) rather than a direct container
 */
function isHlsManifestUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    return pathname.endsWith('.m3u8') || pathname.includes('/manifest.m3u8') || parsed.searchParams.get('format') === 'm3u8';
  } catch (_) {
    return url.toLowerCase().includes('.m3u8');
  }
}

/**
 * Checks if a given URL is a DASH playlist/manifest (.mpd) rather than a direct container
 */
function isDashManifestUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    return pathname.endsWith('.mpd') || pathname.includes('/dashplaylist.mpd') || parsed.searchParams.get('format') === 'mpd';
  } catch (_) {
    return url.toLowerCase().includes('.mpd');
  }
}

/**
 * Strict validator for allowed RedGIFs media/CDN hostnames.
 * Requires redgifs.com or *.redgifs.com. Strictly rejects lookalikes.
 */
if (typeof importScripts === 'function') importScripts('lib/worker_providers.js');

// ============================================================================
// 9. Helper functions: filename, badge, and download tracking state
// ============================================================================

const trackedDownloadIds = new Set();
const inFlightRequests = new Set();
const activeProtectedBlobsByDownloadId = new Map();
const activeGelbooruBlobsByDownloadId = activeProtectedBlobsByDownloadId;
const earlyTerminalDownloadStates = new Map();
let activeResolvingCount = 0;

// The persisted id list is one document updated by read-modify-write. Concurrent saves (Save all runs two at once) each read the same
// list and the last write won, dropping the other ids: the DL badge, which counts the persisted list, then under-reported running
// downloads or kept finished ones. Every write of the list, including startup rehydration, runs through one promise chain. The in-memory
// set is the live state and changes synchronously; storage only mirrors it. A reader therefore waits for the writes queued before it and
// then reads the set: it never merges a storage snapshot taken before an in-flight write, which would bring a finished id back.
// A queued update must not await a reader (it would wait for itself).
let trackedIdsChain = Promise.resolve();
function updateTrackedIdsList(update) {
  const step = async () => {
    await hydrateTrackedDownloadIds();
    return update();
  };
  const run = trackedIdsChain.then(step, step);
  trackedIdsChain = run.then(() => undefined, () => undefined);
  return run;
}

// Rehydrate tracked download IDs from session storage on service worker activation. A failed read is not evidence that nothing is
// running: every queued operation retries it (one read each) until one succeeds. Until then only ids known to this worker are tracked.
// Ids removed meanwhile stay removed (also in storage, so a later restart cannot resurrect them); ids added meanwhile are kept and persisted.
let trackedIdsHydrated = false;
const trackedIdsRemovedBeforeHydration = new Set();
async function hydrateTrackedDownloadIds() {
  if (trackedIdsHydrated) return;
  const storageApi = chrome.storage?.session || chrome.storage?.local;
  if (!storageApi?.get) {
    trackedIdsHydrated = true;
    return;
  }
  try {
    const data = await storageApi.get({ trackedDownloadIds: [] });
    const list = Array.isArray(data.trackedDownloadIds) ? data.trackedDownloadIds : [];
    const merged = list.filter(id => !trackedIdsRemovedBeforeHydration.has(id));
    for (const id of trackedDownloadIds) {
      if (!merged.includes(id)) merged.push(id);
    }
    for (const id of merged) trackedDownloadIds.add(id);
    trackedIdsHydrated = true;
    trackedIdsRemovedBeforeHydration.clear();
    if (storageApi.set && (merged.length !== list.length || merged.some((id, i) => id !== list[i]))) {
      await storageApi.set({ trackedDownloadIds: merged });
    }
  } catch (e) {}
}
updateTrackedIdsList(() => {});

async function addTrackedDownloadId(id) {
  if(isFileExport(id))return;
  if (id === undefined || id === null) return;
  trackedDownloadIds.add(id);
  trackedIdsRemovedBeforeHydration.delete(id);
  await updateTrackedIdsList(async () => {
    trackedDownloadIds.add(id);
    try {
      const storageApi = chrome.storage?.session || chrome.storage?.local;
      if (storageApi?.get && storageApi?.set) {
        const data = await storageApi.get({ trackedDownloadIds: [] });
        const list = Array.isArray(data.trackedDownloadIds) ? data.trackedDownloadIds : [];
        if (!list.includes(id)) {
          list.push(id);
          await storageApi.set({ trackedDownloadIds: list });
        }
      }
    } catch (e) {
      console.warn('[MediaLatch] Не удалось сохранить trackedDownloadIds:', e);
    }
  });
}

async function removeTrackedDownloadId(id) {
  if (id === undefined || id === null) return;
  trackedDownloadIds.delete(id);
  if (!trackedIdsHydrated) trackedIdsRemovedBeforeHydration.add(id);
  await updateTrackedIdsList(async () => {
    trackedDownloadIds.delete(id);
    try {
      const storageApi = chrome.storage?.session || chrome.storage?.local;
      if (storageApi?.get && storageApi?.set) {
        const data = await storageApi.get({ trackedDownloadIds: [] });
        const list = Array.isArray(data.trackedDownloadIds) ? data.trackedDownloadIds : [];
        const updated = list.filter(item => item !== id);
        await storageApi.set({ trackedDownloadIds: updated });
      }
    } catch (e) {
      console.warn('[MediaLatch] Не удалось обновить trackedDownloadIds:', e);
    }
  });
}

async function isTrackedDownloadId(id) {
  if (id === undefined || id === null) return false;
  return updateTrackedIdsList(() => trackedDownloadIds.has(id));
}

async function getTrackedDownloadCount() {
  return updateTrackedIdsList(() => trackedDownloadIds.size);
}

if (typeof importScripts === 'function') importScripts('lib/toolbar_badge.js');
const toolbarBadge = globalThis.MediaLatchToolbarBadge.create({
  action: chrome.action,
  readBusy: () => ({resolving: activeResolvingCount, downloads: trackedDownloadIds.size,
    pending: typeof downloadManager !== 'undefined' && downloadManager ? downloadManager.activityCount() || (downloadManagerRecovering ? 1 : 0) : 0}),
  readState: async () => ({
    resolving: activeResolvingCount,
    downloads: await getTrackedDownloadCount(),
    pending: typeof downloadManager !== 'undefined' && downloadManager ? downloadManager.activityCount() || (downloadManagerRecovering ? 1 : 0) : 0,
    failures: await getUnseenFailureCount()
  }),
  log: () => console.warn('[MediaLatch] Toolbar badge update failed')
});
async function setBadge(text, backgroundColor) { return toolbarBadge.set(text, backgroundColor); }
async function flashBadge(text, backgroundColor, durationMs = 2500) { return toolbarBadge.flash(text, backgroundColor, durationMs); }
async function restoreOrClearBadge(immediate = false) { return toolbarBadge.refresh(immediate); }

async function clearBadge() {
  await restoreOrClearBadge();
}

/**
 * Determines whether a context-menu click target has an actual media (image or video) association.
 * If rawImageUrl is absent, linkUrl must point to a direct media file or recognized media endpoint.
 */
function hasMediaAssociation(srcUrl, linkUrl) {
  if (srcUrl && typeof srcUrl === 'string' && srcUrl.trim()) {
    return true; // Clicked directly on media
  }
  if (!linkUrl || typeof linkUrl !== 'string' || !linkUrl.trim()) {
    return false; // Neither media nor link
  }
  try {
    const parsed = new URL(linkUrl);
    const pathname = parsed.pathname.toLowerCase();

    // 1. Direct image or video extension in link pathname
    if (/\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|mp4|webm|ogv|mov|m4v)$/i.test(pathname)) {
      return true;
    }

    // 2. Format / media MIME indicator in query params
    const queryFormat = parsed.searchParams.get('format') ||
                        parsed.searchParams.get('fm') ||
                        parsed.searchParams.get('ext') ||
                        parsed.searchParams.get('type') ||
                        parsed.searchParams.get('mime');
    if (queryFormat && /^(jpe?g|png|webp|gif|svg|avif|bmp|ico|pjpg|mp4|webm|ogv|mov|m4v|image\/|video\/)/i.test(queryFormat.trim())) {
      return true;
    }

    // 2b. Reddit video hosts (v.redd.it, packaged-media.redd.it) and media wrappers
    const host = parsed.hostname.toLowerCase();
    if (host === 'v.redd.it' || host === 'packaged-media.redd.it') {
      return true;
    }
    if (typeof isRedditDomain === 'function' && isRedditDomain(host) && pathname === '/media' && parsed.searchParams.has('url')) {
      return true;
    }

    // 2c. RedGIFs media routes
    if (typeof isAllowedRedGifsHost === 'function' && isAllowedRedGifsHost(host)) {
      if (/\/(?:watch|ifr|detail|gifs)\/([a-zA-Z0-9_-]+)/i.test(pathname)) {
        return true;
      }
    }

    // 3. Known direct media path segments (paheal, Paheal cdn, img/view, Paheal file_only, videos, etc.)
    const isDirectMediaLink = /\/(images?|original|data|_images|content|img\/view|uploads?|media|photos?|assets|pictures?|pictures\/get_image|videos?)\//i.test(pathname) ||
                              pathname.includes('file_only') ||
                              parsed.hostname.includes('paheal-cdn.net') ||
                              parsed.searchParams.has('imgurl') ||
                              parsed.searchParams.has('videourl');

    const isHtmlPage = /\.(html?|xhtml|php|asp|aspx)$/i.test(pathname) ||
                       /\/(post|posts|comment|comments|user|users|tag|tags|upload|thread|threads|forum|article|blog|artworks?|illust|about|contact|help|wiki)\//i.test(pathname);

    if (isDirectMediaLink && !isHtmlPage) {
      return true;
    }
  } catch (e) {}

  return false;
}

function hasImageAssociation(srcUrl, linkUrl) {
  return hasMediaAssociation(srcUrl, linkUrl);
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

// ============================================================================
// 9.0. Download feedback (UX-02 / UX-04): operation tracker, notifications, details messages
// ============================================================================
// Logic lives in lib/feedback.js (pure) and lib/feedback_tracker.js (injected Chrome APIs).
// Every hook below is best-effort: a feedback, storage or notification failure must never
// abort, duplicate or change a download.

var feedbackTracker = null;
const FEEDBACK_DETAILS_PAGE = 'popup/popup.html'; // full extension page (UX-05); #history opens the history section

function feedbackStorageArea() {
  return chrome.storage?.session || chrome.storage?.local || null;
}

async function feedbackNotifyRecord(record) {
  return feedbackNotifier(record);
}

var feedbackNotifier = (typeof globalThis.ImageSaverFeedbackTracker?.createNotifier === 'function')
  ? globalThis.ImageSaverFeedbackTracker.createNotifier({
      deliver: async (record, options) => {
        const target = record.noticeTarget;
        if (!target || !chrome.tabs?.get || !chrome.tabs?.sendMessage) return false;
        const tab = await chrome.tabs.get(target.tabId);
        if (new URL(tab.url).origin !== target.origin || tab.discarded) return false;
        let theme = 'violet';
        try { const prefs = await chrome.storage.local.get({ uiTheme: 'violet' }); if (['violet', 'blue', 'dark', 'light'].includes(prefs.uiTheme)) theme = prefs.uiTheme; } catch (_) {}
        const reply = await chrome.tabs.sendMessage(target.tabId, { action: 'MEDIALATCH_NOTICE', notice: { ...options, id: record.id, origin: target.origin, theme } }, { frameId: 0 });
        return reply?.success === true;
      },
      getPrefs: () => chrome.storage.local.get({ notifySuccess: true }),
      // the saved interface language; an invalid or unreadable value leaves the notifier on the browser-language rule
      getLang: async () => (await chrome.storage.local.get({ uiLanguage: null }))?.uiLanguage,
      log: (...args) => console.warn('[MediaLatch] feedback:', ...args)
    })
  : async () => false;

// UX-03: bounded local history (chrome.storage.local, 50 entries / 30 days), recorded from terminal operations only.
var feedbackHistory = (typeof globalThis.ImageSaverFeedbackHistory?.createHistory === 'function' && typeof chrome !== 'undefined' && chrome.storage?.local)
  ? globalThis.ImageSaverFeedbackHistory.createHistory({
      storage: {
        get: async (key) => (await chrome.storage.local.get(key))?.[key] ?? null,
        set: (key, value) => chrome.storage.local.set({ [key]: value })
      },
      isEnabled: async () => (await chrome.storage.local.get({ [globalThis.ImageSaverFeedbackHistory.ENABLED_KEY]: false }))[globalThis.ImageSaverFeedbackHistory.ENABLED_KEY],
      log: (...args) => console.warn('[MediaLatch] history:', ...args)
    })
  : null;
// Persistent retention cleanup at service-worker start (also runs on every list/record); best effort.
// The old bounded history remains readable for migration; never prune it before importing.
var statistics = globalThis.MediaLatchStatistics && typeof indexedDB !== 'undefined'
  ? globalThis.MediaLatchStatistics.createStatistics({
      indexedDB,
      legacy: async () => (await chrome.storage.local.get('imageSaverHistoryV1')).imageSaverHistoryV1,
      isEnabled: async () => (await chrome.storage.local.get('historyEnabled')).historyEnabled === true,
      changed: () => { try { chrome.runtime.sendMessage({ action: 'STATISTICS_CHANGED' }).catch(() => {}); } catch (_) {} },
    }) : null;

if (typeof globalThis.ImageSaverFeedbackTracker?.createTracker === 'function') {
  feedbackTracker =globalThis.ImageSaverFeedbackTracker.createTracker({
    storage: {
      get: async (key) => {
        const area = feedbackStorageArea();
        if (!area) return null;
        const data = await area.get(key);
        return data ? data[key] : null;
      },
      set: async (key, value) => {
        const area = feedbackStorageArea();
        if (!area) throw Error('FEEDBACK_STORAGE_UNAVAILABLE');
        await area.set({ [key]: value });
      }
    },
    genId: () => `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    getDownloadItem: async (id) => {
      // Only extension-owned download IDs are ever looked up (never a query over user history).
      if (!chrome.downloads?.search) return undefined;
      const items = await chrome.downloads.search({ id });
      return Array.isArray(items) && items.length ? items[0] : null;
    },
    getFileExportItem:async op=>{if(!directoryStore)return null;const r=await directoryStore.byOp(op);if(!r)return null;return {...await searchDirectoryExport(r.id,r.exportUrl),output:{mime:r.mime,evidence:'verified_mime',type:r.mime?.startsWith('video/')?'video':r.mime==='image/gif'?'gif':'pic',sizeBytes:r.size,sizeKind:'measured'}};},
    peekEarlyTerminal: (id) => earlyTerminalDownloadStates.get(id),
    notify: (record, ...rest) => { dbg('notify', 'show', 'info', undefined, () => ({ state: record && record.state }), { op: record && record.id }); return feedbackNotifyRecord(record, ...rest); },
    onFinished: (record) => (statistics ? statistics.record(record) : false),
    onChange: () => { if (!toolbarBadge.flashing) restoreOrClearBadge(); try{chrome.runtime.sendMessage({action:'DOWNLOADS_CHANGED'}).catch(()=>{});}catch(_){} },
    log: (...args) => console.warn('[MediaLatch] feedback:', ...args)
  });
}

/** Unseen failed/interrupted operations, read from the same session storage the tracker persists to. */
async function getUnseenFailureCount() {
  try {
    const area = feedbackStorageArea();
    const key = globalThis.ImageSaverFeedbackTracker?.STORAGE_KEY;
    if (!area || !key) return 0;
    const stored = (await area.get(key))?.[key];
    const ops = Array.isArray(stored?.ops) ? stored.ops : [];
    return ops.map(FeedbackLib.sanitizeRecord).filter((r) => r && !r.seen && (r.state === 'failed' || r.state === 'interrupted')).length;
  } catch (_) {
    return 0;
  }
}

// DEBUG-MENU-01: every operation boundary is also a journal event (operation id, the click/attempt id when the caller has one).
async function fbBegin(info, tab) {
  let op = null;
  let noticeTarget;
  try { if (Number.isSafeInteger(tab?.id) && tab.id >= 0) noticeTarget = { tabId: tab.id, origin: new URL(tab.url).origin }; } catch (_) {}
  try { op = feedbackTracker ? await feedbackTracker.begin({ ...info, noticeTarget }) : null; } catch (_) { op = null; }
  dbg('op', 'begin', op ? 'start' : 'failed', op ? undefined : 'NO_RECORD', () => ({ site: info && info.site, pageHost: info && info.pageUrl, srcHost: info && info.sourceUrl }), { op: op || undefined, cid: info && info.cid });
  return op;
}
async function fbSetPost(op, url) {
  if (!op || !feedbackTracker) return;
  dbg('op', 'post', 'info', undefined, { linked: Boolean(url) }, { op });
  try { await feedbackTracker.setPost(op, url); } catch (_) {}
}
async function fbStage(op, state, patch) {
  if (!op || !feedbackTracker) return;
  dbg('op', 'stage', 'info', undefined, () => ({ state, type: patch && patch.expectedType, conversion: patch && patch.conversion, srcHost: patch && patch.sourceUrl }), { op });
  try { await feedbackTracker.stage(op, state, patch); } catch (_) {}
}
async function fbFail(op, info) {
  if (!op || !feedbackTracker) return;
  dbg('op', 'fail', 'failed', dbgCode(info && info.code), () => ({ stage: info && info.stage, http: info && info.status, error: dbgCode(info && info.downloadError) }), { op });
  try { await feedbackTracker.fail(op, info); } catch (_) {}
}
async function fbCancel(op) {
  if (!op || !feedbackTracker) return;
  dbg('op', 'cancel', 'info', 'USER_CANCELED', null, { op });
  try { await feedbackTracker.cancel(op); } catch (_) {}
}
async function fbDiscard(op) {
  if (!op || !feedbackTracker) return;
  dbg('op', 'discard', 'skipped', 'DUPLICATE_OR_HANDED_OFF', null, { op });
  try { await feedbackTracker.discard(op); } catch (_) {}
}
async function fbAttach(op, downloadId, patch) {
  if(isFileExport(downloadId))return;
  if (!op || !feedbackTracker) return;
  const staged=downloadManager?.output(downloadId);
  if(staged)patch={...patch,output:{...patch?.output,...staged}};
  dbg('download', 'start', 'start', undefined, () => ({ downloadId, mime: patch && patch.output && patch.output.mime, type: patch && patch.output && patch.output.type }), { op });
  try { await feedbackTracker.attachDownload(op, downloadId, patch); } catch (_) {}
}
async function fbDownloadTerminal(downloadId, state, errorCode) {
  if (!feedbackTracker) return;
  dbg('download', state === 'complete' ? 'complete' : (state === 'cancelled' ? 'cancel' : 'interrupt'), state === 'complete' ? 'ok' : 'failed', dbgCode(errorCode), { downloadId, state });
  try { await feedbackTracker.downloadTerminal(downloadId, state, errorCode); } catch (_) {}
}

let downloadManagerBusy = false;
let downloadManagerRecovering = Boolean(globalThis.MediaLatchDownloads && typeof indexedDB !== 'undefined');
const downloadManager = globalThis.MediaLatchDownloads && typeof indexedDB !== 'undefined'
  ? MediaLatchDownloads.createManager({
    store:MediaLatchDownloads.database(indexedDB), id:()=>crypto.randomUUID(), sleep:ms=>new Promise(r=>setTimeout(r,ms)),
    activity:on=>{downloadManagerBusy=on;void restoreOrClearBadge();if(!on)void closeOffscreenDocument().catch(()=>{});},
    changed:()=>{void restoreOrClearBadge();try{chrome.runtime.sendMessage({action:'DOWNLOADS_CHANGED'}).catch(()=>{});}catch(_){}},
    stage:async (job,signal)=>{
      await ensureOffscreenDocument();
      if(signal.aborted)throw Error('CANCELLED');
      const attempt=crypto.randomUUID();
      const abort=()=>{void offscreenRequest({action:'STAGING_ABORT',id:job.id,attempt}).catch(()=>{});};
      signal.addEventListener('abort',abort,{once:true});
      try{
        if(signal.aborted)throw Error('CANCELLED');
        const res=await offscreenRequest({action:'STAGING_PREPARE',job:{...job,attempt}});
        if(!res?.success)throw Object.assign(Error(res?.error || 'STAGING_FAILED'),{retryAt:res?.retryAt});return res;
      }finally{signal.removeEventListener('abort',abort);}
    },
    stop:async id=>{await ensureOffscreenDocument();await offscreenRequest({action:'STAGING_ABORT',id});},
    verify:async j=>{
      const owner=acquireOffscreenTask();
      try{await ensureOffscreenDocument();const res=await offscreenRequest({action:'STAGING_VERIFY',id:j.id,size:j.total,mime:j.mime});return res?.success && res.valid===true;}
      finally{await releaseOffscreenTask(owner);}
    },
    fileUrl:async (id,mime)=>{
      await ensureOffscreenDocument();const res=await offscreenRequest({action:'STAGING_URL',id,mime});
      if(!res?.success)throw Error(res?.error || 'STAGING_FAILED');return res.url;
    },
    remove:async id=>{
      const owner=acquireOffscreenTask();
      try{await ensureOffscreenDocument();const res=await offscreenRequest({action:'STAGING_REMOVE',id});
        if(!res?.success)throw Error(res?.error || 'STAGING_FAILED');}
      finally{await releaseOffscreenTask(owner);}
    },
    abort:async id=>{await offscreenRequest({action:'STAGING_ABORT',id});},
    export:async(url,filename,j)=>{if(!j.directoryId)return chrome.downloads.download({url,filename,saveAs:false});await ensureOffscreenDocument();const r=await offscreenRequest({action:'STAGING_DIRECTORY_EXPORT',job:j,url});if(!r?.success)throw Error(r?.error || 'DIRECTORY_WRITE_FAILED');return r.id;},
    search:async(id,url)=>{
      if(isFileExport(id) || (directoryStore && await directoryStore.byUrl(url)))return searchDirectoryExport(id,url);
      const items=await chrome.downloads.search(Number.isInteger(id)?{id}:{url});
      return items.find(x=>x.byExtensionId===chrome.runtime.id && (Number.isInteger(id) || x.url===url)) || null;
    },
    cancelExport:id=>isFileExport(id)?offscreenRequest({action:'STAGING_ABORT',id:id.slice(5)}):chrome.downloads.cancel(id),
    forget:j=>directoryStore?.forget('file:'+j.id),
    newAttempt:async j=>{
      const old=await feedbackTracker?.get(j.op).catch(()=>null);
      const m = j.mime || j.expectedMime || '';
      return fbBegin({sourceUrl:j.source,expectedType:m.startsWith('video/')?'video':m==='image/gif'?'gif':'image'},old?.noticeTarget?{id:old.noticeTarget.tabId,url:old.noticeTarget.origin}:undefined);
    },
    recoverAttempt:async j=>{
      const old=await feedbackTracker?.get(j.op);
      const m = j.mime || j.expectedMime || '';
      return old && (!FeedbackLib.isTerminal(old.state) || old.state==='complete')?j.op:fbBegin({sourceUrl:j.source,expectedType:m.startsWith('video/')?'video':m==='image/gif'?'gif':'image'},old?.noticeTarget?{id:old.noticeTarget.tabId,url:old.noticeTarget.origin}:undefined);
    },
    attach:async(j,id)=>isFileExport(id)?fbStage(j.op,'saving',{output:{mime:j.mime,evidence:'verified_mime',type:j.mime?.startsWith('video/')?'video':j.mime==='image/gif'?'gif':'pic',sizeBytes:j.total,sizeKind:'measured'}}):fbAttach(j.op,id,{filename:j.filename,output:{mime:j.mime,evidence:'verified_mime',type:j.mime?.startsWith('video/')?'video':j.mime==='image/gif'?'gif':'pic',sizeBytes:j.total,sizeKind:'measured'}}),
    complete:async(j,item)=>isFileExport(j.downloadId)?feedbackTracker?.completeFile(j.op,item,{mime:j.mime,evidence:'verified_mime',type:j.mime?.startsWith('video/')?'video':j.mime==='image/gif'?'gif':'pic',sizeBytes:j.total,sizeKind:'measured'}):fbDownloadTerminal(j.downloadId,'complete'),
    failed:async j=>j.state==='cancelled'?fbCancel(j.op):fbFail(j.op,{stage:j.prepared?'save':'download',code:j.error}),
    error:()=>dbg('manager','queue','failed','STORAGE_FAILED')
  }) : null;
downloadManager?.ready.then(()=>{downloadManagerRecovering=false;void restoreOrClearBadge();void closeOffscreenDocument().catch(()=>{});},()=>dbg('manager','load','failed','STORAGE_FAILED'));

async function searchDirectoryExport(id,url){
  const owner=acquireOffscreenTask();try{await ensureOffscreenDocument();const r=await offscreenRequest({action:'STAGING_DIRECTORY_SEARCH',id,url});if(!r?.success)throw Error(r?.error || 'DIRECTORY_WRITE_FAILED');return r.item;}finally{await releaseOffscreenTask(owner);}
}
async function managedDownload(options, feedbackOp=null, mime='') {
  // Offline legacy harnesses omit IndexedDB; the installed extension always uses the durable queue.
  const {saveDirectoryId=''}=await chrome.storage.local.get({saveDirectoryId:''});
  if(!downloadManager){if(saveDirectoryId)throw Error('DIRECTORY_ACCESS_REQUIRED');return chrome.downloads.download(options);}
  return downloadManager.enqueue(options,{op:feedbackOp,mime,directoryId:saveDirectoryId});
}
async function downloadManagerSnapshot() {
  const snapshot=await downloadManager.list();
  const owned=new Set(snapshot.jobs.map(j=>j.op));
  const preparations=(await feedbackTracker.list()).filter(r=>!owned.has(r.id) && ['resolving','converting','failed','interrupted'].includes(r.state));
  for(const r of preparations)snapshot.jobs.push({id:r.id,op:r.id,managed:false,filename:r.filename || '',state:r.state==='interrupted'?'failed':r.state,received:0,total:null,speed:0,error:r.failure?.code || '',createdAt:r.createdAt});
  snapshot.jobs.sort((a,b)=>b.createdAt-a.createdAt);return snapshot;
}
if(chrome.runtime?.onMessage?.addListener) chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  if(m?.action==='STAGING_PROGRESS') {
    if(sender?.id!==chrome.runtime.id || sender?.url!==chrome.runtime.getURL('offscreen.html'))return false;
    downloadManager?.progress(m.id,m.progress).then(()=>respond({success:true}),()=>respond({success:false}));return true;
  }
  if(m?.action!=='DOWNLOADS_LIST' && m?.action!=='DOWNLOADS_COMMAND')return false;
  if(sender?.id!==chrome.runtime.id || !['popup/popup.html','popup/quick.html'].some(p=>sender.url?.split(/[?#]/)[0]===chrome.runtime.getURL(p)) || !downloadManager){respond({success:false,error:'FORBIDDEN'});return false;}
  (async()=>{
    if(m.action==='DOWNLOADS_COMMAND') {
      if(m.command==='remove') {
        const job=(await downloadManager.list()).jobs.find(j=>j.id===m.id);
        if(!job) {
          const record=await feedbackTracker.get(m.id);
          if(!record || !FeedbackLib.isTerminal(record.state))throw Error('INVALID_STATE');
          await feedbackTracker.clearFinished(m.id);
          return {success:true,...await downloadManagerSnapshot()};
        }
        if(!['complete','failed','cancelled'].includes(job.state))throw Error('INVALID_STATE');
        // Clear the fallback durably first; a crash must leave the queue card, never resurrect a removed one.
        if(job.op)await feedbackTracker.clearFinished(job.op);
      }
      await downloadManager.command(m.command,m.id);
    }
    return {success:true,...await downloadManagerSnapshot()};
  })().then(respond,e=>respond({success:false,error:dbgCode(e.message)||'DOWNLOADS_UNAVAILABLE'}));return true;
});

/** First candidate that is an allowed numeric status actually observed by the pipeline, else null. */
function fbStatusIn(candidates, allowed) {
  for (const c of candidates) {
    if (Number.isInteger(c) && allowed.includes(c)) return c;
  }
  return null;
}

function fbSiteOf(pageUrl, sourceUrl) {
  try {
    return determineOwningWebsite({ pageUrl: pageUrl || '', resolvedUrl: sourceUrl || '' });
  } catch (_) {
    return '';
  }
}

/**
 * Handler-scoped replacement for flashBadge: forwards to the real badge and records the failure
 * of this operation (AUTH/RATE/ERR). 'OK' is never success: only a completed download is.
 */
function fbBadgeReporter(op) {
  return async (text, color, durationMs) => {
    if (op && (text === 'ERR' || text === 'AUTH' || text === 'RATE')) {
      await fbFail(op, { code: text === 'AUTH' ? 'AUTH_REQUIRED' : (text === 'RATE' ? 'RATE_LIMIT' : '') });
    }
    return flashBadge(text, color, durationMs);
  };
}

/** Settles an operation from the structured result of executeMediaPlan (no status is invented). */
async function fbSettleFromResult(op, result) {
  if (!op || !result) return;
  if (result.cancelled) {
    await fbCancel(op);
  } else if (result.success === false) {
    const code = result.error;
    await fbFail(op, {
      stage: code === 'INVALID_PLAN' || code === 'HTML_PAGE' || code === 'UNRESOLVED_BLOB_MEDIA' ? 'resolve' : 'verify',
      code,
      status: (code === 'AUTH_REQUIRED' || code === 'RATE_LIMIT') ? fbStatusIn([result.status], [401, 403, 429]) : null
    });
  }
}

/** Evidence about the file actually being saved. A filename extension alone is only ever a hint. */
function buildFeedbackOutput({ finalPath, structuredResult, group, isFallback = false }) {
  const ext = FeedbackLib.extensionOf(finalPath);
  const mime = String(structuredResult?.normalizedMime || '').split(';')[0].trim().toLowerCase();
  const mimeType = getMediaTypeFromMime(mime);
  const evidence = group?.metadata?.mimeEvidence;
  const verified = !isFallback && Boolean(mime) && (
    group?.transport === 'protectedBlob' ||
    group?.transport === 'pixivDataUrl' ||
    evidence === MIME_EVIDENCE.HTTP_RESPONSE ||
    evidence === MIME_EVIDENCE.PROTECTED_FETCH
  );
  const out = { type: 'unknown', ext, evidence: 'unknown', mime: '' };
  if (verified && ['gif', 'video', 'pic'].includes(mimeType)) {
    out.type = mimeType;
    out.evidence = 'verified_mime';
    out.mime = mime;
  } else if (!verified || mimeType === '') {
    const hinted = determineFinalMediaType({ resolvedExtension: ext });
    if (hinted !== 'unknown-type') {
      out.type = hinted;
      out.evidence = 'filename_hint';
    }
  }
  if (!isFallback) {
    const measured = structuredResult?.blobUrl && Number(structuredResult.size) > 0;
    const header = Number(group?.metadata?.contentLength) > 0;
    if (measured) { out.sizeBytes = Number(structuredResult.size); out.sizeKind = 'measured'; }
    else if (header) { out.sizeBytes = Number(group.metadata.contentLength); out.sizeKind = 'estimated'; }
    if (Number(group?.metadata?.durationSec) > 0) out.durationSec = Number(group.metadata.durationSec);
    if (group?.metadata?.reason) out.reason = group.metadata.reason;
    if (Number(group?.metadata?.thresholdSec) > 0) out.thresholdSec = Number(group.metadata.thresholdSec);
  }
  return out;
}

// Messages from extension pages only (popup/details): list, mark seen, clear finished.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message?.action;
    if (action === 'STATISTICS_LIST' || action === 'STATISTICS_CLEAR') {
      const base = chrome.runtime.getURL('');
      if (!statistics || sender?.id !== chrome.runtime.id || typeof sender?.url !== 'string' || !sender.url.startsWith(base)) {
        sendResponse({ success: false, error: 'FORBIDDEN' }); return false;
      }
      (async () => {
        try { sendResponse({ success: true, ...(action === 'STATISTICS_CLEAR' ? await statistics.clear() : await statistics.list()) }); }
        catch (_) { sendResponse({ success: false, error: 'STATISTICS_UNAVAILABLE' }); }
      })();
      return true;
    }
    const isHistory = action === 'HISTORY_LIST' || action === 'HISTORY_CLEAR';
    if (action !== 'FEEDBACK_LIST' && action !== 'FEEDBACK_MARK_SEEN' && action !== 'FEEDBACK_CLEAR' && !isHistory) return false;
    const base = chrome.runtime.getURL('');
    if (isHistory) {
      if (!feedbackHistory || sender?.id !== chrome.runtime.id || typeof sender?.url !== 'string' || !sender.url.startsWith(base)) {
        sendResponse({ success: false, error: 'FORBIDDEN' });
        return false;
      }
      (async () => {
        try {
          if (action === 'HISTORY_CLEAR') await feedbackHistory.clear();
          const listed = await feedbackHistory.list();
          sendResponse({ success: true, records: listed.entries, pruneFailed: listed.pruneFailed });
        } catch (_) {
          sendResponse({ success: false, error: 'HISTORY_UNAVAILABLE' });
        }
      })();
      return true;
    }
    if (!feedbackTracker || sender?.id !== chrome.runtime.id || typeof sender?.url !== 'string' || !sender.url.startsWith(base)) {
      sendResponse({ success: false, error: 'FORBIDDEN' });
      return false;
    }
    (async () => {
      try {
        if (action === 'FEEDBACK_MARK_SEEN') {
          const rawIds = message?.ids;
          if (Array.isArray(rawIds) && rawIds.length > 0) {
            const maxOps = FeedbackLib?.LIMITS?.maxOps || 50;
            const validIds = [];
            for (const id of rawIds) {
              if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
                validIds.push(id);
                if (validIds.length >= maxOps) break;
              }
            }
            if (validIds.length > 0) {
              await feedbackTracker.markSeen(validIds);
            }
          }
        } else if (action === 'FEEDBACK_CLEAR') await feedbackTracker.clearFinished();
        sendResponse({ success: true, records: await feedbackTracker.list() });
      } catch (_) {
        sendResponse({ success: false, error: 'FEEDBACK_UNAVAILABLE' });
      }
    })();
    return true;
  });
}

// Only the owning top-frame content script can open a notice's stored operation.
if (chrome.runtime?.onMessage?.addListener) chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.action !== 'MEDIALATCH_NOTICE_OPEN') return false;
  (async () => {
    if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id) || typeof message.id !== 'string' || !/^[a-z0-9-]{6,48}$/.test(message.id)) return { success: false };
    const rec = await feedbackTracker?.get(message.id);
    if (!rec?.noticeTarget || !FeedbackLib.isTerminal(rec.state) || rec.noticeTarget.tabId !== sender.tab.id || new URL(sender.url).origin !== rec.noticeTarget.origin) return { success: false };
    await chrome.tabs.create({ url: chrome.runtime.getURL(`${FEEDBACK_DETAILS_PAGE}?op=${encodeURIComponent(rec.id)}#downloads`) });
    dbg('notify', 'click', 'ok', undefined, null, { op: rec.id });
    return { success: true };
  })().then(respond, () => respond({ success: false }));
  return true;
});

// ============================================================================
// 9.1. Download Lifecycle Tracker: state monitoring via onChanged
// ============================================================================

const activeDownloadsMetadata = new Map();

// Native recovery of an interrupted transfer: ONE chrome.downloads.resume on the SAME download id (never a new download, another URL, other headers
// or a whole-file fetch). Only for a download this worker has fully registered (tracked id, metadata and feedback attached) that the shared executor
// started as a direct http(s) transfer, and only while the current DownloadItem says: ours, same source, interrupted with NETWORK_FAILED, resumable.
// The decision runs before any terminal feedback or cleanup, so a resumed download stays tracked and "saving" until its own real end. It is a bounded
// recovery of an unknown cause, not a claim that the network failure is fixed. Not covered: an interruption that arrives before registration
// (early state), and a first failure after a worker restart (the metadata is memory-only); both keep their existing handling.
// An entry exists from the synchronous reservation until the download's real terminal event: it is the single attempt of that id and orders every
// later terminal event of the id behind the decision. It is never evicted while the id is alive.
const nativeResumeDecisions = new Map();
const nativeResumeKey = (id) => `native_resume_${id}`;

function isNativeResumeCandidate(id, errorCode) {
  if (errorCode !== 'NETWORK_FAILED' || nativeResumeDecisions.has(id)) return false;
  if (!trackedDownloadIds.has(id) || earlyTerminalDownloadStates.has(id) || activeProtectedBlobsByDownloadId.has(id)) return false;
  const meta = activeDownloadsMetadata.get(id);
  const transport = meta?.plan?.transport;
  return Boolean(meta?.plan) && transport !== 'protectedBlob' && transport !== 'pixivDataUrl' && /^https?:\/\//i.test(meta.url || '');
}

// The current DownloadItem of an id, or null when it cannot be read.
async function readDownloadItem(id) {
  try {
    const items = await chrome.downloads.search({ id });
    return Array.isArray(items) && items.length ? items[0] : null;
  } catch (_) {
    return null;
  }
}

function isSameDownloadSource(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch (_) {
    return false;
  }
}

function isResumableOwnedItem(item, meta) {
  const ownId = chrome.runtime?.id;
  return Boolean(item) && item.state === 'interrupted' && item.error === 'NETWORK_FAILED' && item.canResume === true &&
    Boolean(ownId) && item.byExtensionId === ownId && isSameDownloadSource(item.url, meta?.url);
}

// A feedback record that attach or reconcile already finalised must not be revived by a resume: its later completion would be ignored.
async function isFeedbackRecordSaving(id) {
  if (!feedbackTracker) return true;
  const record = (await feedbackTracker.list()).find((r) => r.downloadId === id);
  return !record || record.state === 'saving';
}

// A refusal that follows an awaited step (tracker read, marker storage, resume): the download may have completed, been cancelled or been continued
// meanwhile, and its own event waits behind this decision. The current item decides, never the error the decision started with; an unreadable item keeps it.
async function refuseNativeResume(id, errorCode) {
  const now = await readDownloadItem(id);
  if (!now) return { error: errorCode };
  return now.state === 'interrupted' ? { error: now.error || errorCode } : { stale: true };
}

// Resolves { resumed } (resume accepted), { stale } (the item moved on: in progress or complete) or { error } (finalise as interrupted with this code).
async function decideNativeResume(id, errorCode) {
  try {
    const meta = activeDownloadsMetadata.get(id);
    const item = await readDownloadItem(id);
    if (!item) return { error: errorCode };
    if (item.state !== 'interrupted') return { stale: true };
    const finalError = item.error || errorCode;
    if (!isResumableOwnedItem(item, meta)) return { error: finalError };
    if (!(await isFeedbackRecordSaving(id))) return refuseNativeResume(id, finalError);
    // the one-attempt marker is persisted BEFORE the resume; storage that cannot hold it means no automatic attempt
    const store = chrome.storage?.session;
    if (!store?.get || !store?.set) return refuseNativeResume(id, finalError);
    const key = nativeResumeKey(id);
    if ((await store.get(key))?.[key]) return refuseNativeResume(id, finalError);
    await store.set({ [key]: Date.now() });
    const fresh = await readDownloadItem(id);
    if (!fresh) return { error: finalError };
    if (fresh.state !== 'interrupted') return { stale: true };
    if (!isResumableOwnedItem(fresh, meta)) return { error: fresh.error || finalError };
    try {
      await chrome.downloads.resume(id);
    } catch (err) {
      console.warn(`[MediaLatch] Загрузка ${id}: resume отклонён:`, err?.message || err);
      dbg('download', 'resume', 'failed', 'RESUME_REFUSED', { downloadId: id });
      return refuseNativeResume(id, finalError);
    }
    dbg('download', 'resume', 'start', 'NETWORK_FAILED', { downloadId: id });
    console.log(`[MediaLatch] Загрузка ${id} прервана (NETWORK_FAILED): запрошено одно возобновление`);
    return { resumed: true };
  } catch (_) {
    return refuseNativeResume(id, errorCode);
  }
}

// Orders a terminal event behind the id's decision and returns { skip: true } (the event must not finalise anything) or { error } (the code to finalise with).
async function settleNativeResume(id, state, errorCode) {
  const entry = nativeResumeDecisions.get(id);
  if (!entry) {
    if (state !== 'interrupted' || !isNativeResumeCandidate(id, errorCode)) return { error: errorCode };
    const decision = decideNativeResume(id, errorCode);
    nativeResumeDecisions.set(id, decision.then(() => {}));
    const verdict = await decision;
    return verdict.resumed || verdict.stale ? { skip: true } : { error: verdict.error };
  }
  await entry;
  if (state !== 'interrupted') return { error: errorCode };
  // a later interrupted event of an id with a decision is stale unless the current item is still interrupted (then its error wins)
  const item = await readDownloadItem(id);
  if (!item) return { error: errorCode };
  return item.state === 'interrupted' ? { error: item.error || errorCode } : { skip: true };
}

async function releaseNativeResume(id) {
  if (!nativeResumeDecisions.delete(id)) return;
  try { await chrome.storage?.session?.remove?.(nativeResumeKey(id)); } catch (_) {}
}

// Subscribe to chrome.downloads.onChanged to track state transitions
if (typeof chrome !== 'undefined' && chrome.downloads?.onChanged?.addListener) {
  chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta || !delta.id) return;

    const terminalState = delta.state?.current;
    const isTerminal = terminalState === 'complete' || terminalState === 'interrupted';
    let errorCode = delta.error?.current || delta.error || '';
    if (isTerminal) {
      const settled = await settleNativeResume(delta.id, terminalState, errorCode);
      if (settled.skip) return;
      errorCode = settled.error;
      await fbDownloadTerminal(delta.id, terminalState, errorCode);
    }

    const sessionKey = `active_dl_blob_${delta.id}`;
    let hasInSession = false;
    if (chrome.storage?.session) {
      try {
        const sessionData = await chrome.storage.session.get(sessionKey);
        hasInSession = Boolean(sessionData && sessionData[sessionKey]);
      } catch (_) {}
    }

    const isTracked = (await isTrackedDownloadId(delta.id)) || activeProtectedBlobsByDownloadId.has(delta.id) || hasInSession;

    if (isTracked) {
      earlyTerminalDownloadStates.delete(delta.id);
      if (delta.state && delta.state.current === 'complete') {
        await untrackDownloadProtectedBlob(delta.id);
        await removeTrackedDownloadId(delta.id);
        activeDownloadsMetadata.delete(delta.id);
        console.log(`[MediaLatch] Загрузка ${delta.id} успешно завершена`);
        await flashBadge('OK', '#22c55e');
        if (offscreenState.activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
          await closeOffscreenDocument().catch(() => {});
        }
      } else if (delta.state && delta.state.current === 'interrupted') {
        await untrackDownloadProtectedBlob(delta.id);
        await removeTrackedDownloadId(delta.id);
        const meta = activeDownloadsMetadata.get(delta.id);
        activeDownloadsMetadata.delete(delta.id);
        if (errorCode === 'USER_CANCELED') {
          console.log(`[MediaLatch] Загрузка ${delta.id} отменена пользователем (USER_CANCELED)`);
          await restoreOrClearBadge(true);
        } else if (errorCode === 'SERVER_FORBIDDEN' || errorCode === 'SERVER_UNAUTHORIZED') {
          if (isRedditHostedMediaUrl(meta?.url)) {
            console.warn(`[MediaLatch] Reddit video requires an active Reddit session (${errorCode}):`, sanitizeUrlForLog(meta.url));
            await flashBadge('AUTH', '#f59e0b');
          } else {
            console.error(`[MediaLatch] Загрузка ${delta.id} прервана (${errorCode}):`, sanitizeUrlForLog(meta?.url || ''));
            await flashBadge('ERR', '#ef4444');
          }
        } else {
          console.error(`[MediaLatch] Загрузка ${delta.id} прервана с ошибкой:`, errorCode || 'interrupted');
          await flashBadge('ERR', '#ef4444');
        }
        if (offscreenState.activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
          await closeOffscreenDocument().catch(() => {});
        }
      }
    } else if (isTerminal) {
      // Early terminal event arriving before registration
      earlyTerminalDownloadStates.set(delta.id, {
        state: delta.state.current,
        errorCode: errorCode || null,
        timestamp: Date.now()
      });
      if (earlyTerminalDownloadStates.size > 200) {
        const oldestKey = earlyTerminalDownloadStates.keys().next().value;
        earlyTerminalDownloadStates.delete(oldestKey);
      }
    }
    // the download's real end: the id's single attempt is over (a skipped stale event returned above and keeps it)
    if (isTerminal) await releaseNativeResume(delta.id);
  });
}

// ============================================================================
// 9.2. Pixiv-Specific Download Path (download mechanism modeled after Pixiv Toolkit)
// ============================================================================

/**
 * Downloads image from i.pximg.net via fetch() in extension context with Referer injection (DNR),
 * reads response into a binary buffer, and converts it into a local Data URL.
 * This resolves the HTTP 403 (SERVER_FORBIDDEN) issue in chrome.downloads.download,
 * as the download manager saves pre-fetched data locally without a secondary external network request.
 */
if (typeof importScripts === 'function') importScripts('lib/worker_pipeline.js');

// ============================================================================
// 9.3. Offscreen Document Manager (for Protected Media Blobs)
// ============================================================================

if (typeof importScripts === 'function') importScripts('lib/worker_offscreen.js');
const offscreenController = globalThis.MediaLatchOffscreen.create({
  chrome, offscreenRequest: (...args) => offscreenRequest(...args), isFileExport, activeProtectedBlobsByDownloadId, earlyTerminalDownloadStates,
  addTrackedDownloadId: (...args) => addTrackedDownloadId(...args),
  isManagerBusy: () => Boolean(downloadManagerBusy || downloadManagerRecovering)
});
const offscreenState = offscreenController.state;
function ensureOffscreenDocument(...args) { return offscreenController.ensureOffscreenDocument(...args); }
function acquireOffscreenTask(...args) { return offscreenController.acquireOffscreenTask(...args); }
function transferOffscreenTask(...args) { return offscreenController.transferOffscreenTask(...args); }
function hasActiveProtectedDownloads(...args) { return offscreenController.hasActiveProtectedDownloads(...args); }
function closeOffscreenDocument(...args) { return offscreenController.closeOffscreenDocument(...args); }
function releaseOffscreenTask(...args) { return offscreenController.releaseOffscreenTask(...args); }
function trackDownloadProtectedBlob(...args) { return offscreenController.trackDownloadProtectedBlob(...args); }
function untrackDownloadProtectedBlob(...args) { return offscreenController.untrackDownloadProtectedBlob(...args); }
function lookupOwnedDownload(...args) { return offscreenController.lookupOwnedDownload(...args); }
function reconcileActiveOffscreenDownloads(...args) { return offscreenController.reconcileActiveOffscreenDownloads(...args); }

if (typeof importScripts === 'function') importScripts('lib/worker_animation.js');

reconcileActiveOffscreenDownloads();



/**
 * Verifies final media MIME before chooser eligibility.
 * Does not trust URL pathname extension or query hints.
 * For direct video/image, probes via network.
 * For protected transport, uses protected fetch/probe when eligible and reuses Blob.
 * Returns verified MIME string or null if verification is unavailable.
 */
async function verifyFinalMediaMimeImpl(targetUrl, mediaPlan, isVideoContext) {
  if (!targetUrl || typeof targetUrl !== 'string') return null;

  const hostInfo = getProtectedHostInfo(targetUrl);
  const isProtected = mediaPlan?.transport === 'protected' || mediaPlan?.transport === 'protectedBlob' || Boolean(hostInfo);

  // 1. If candidate was already verified during candidate probing for this exact URL with HTTP evidence:
  // For protected hosts, candidate is only truly verified if verifiedBlob is already present!
  const meta = mediaPlan?.metadata;
  const isEvidenceHttp = meta?.mimeEvidence === MIME_EVIDENCE.HTTP_RESPONSE ||
                         meta?.mimeEvidence === MIME_EVIDENCE.PROTECTED_FETCH;
  const isUrlMatch = !meta?.verifiedUrl || meta?.verifiedUrl === targetUrl;
  const isCandidateVerified = Boolean(meta?.verified && isEvidenceHttp && isUrlMatch);

  const planMime = (meta?.contentType || mediaPlan?.variants?.[0]?.contentType || '').split(';')[0].trim().toLowerCase();
  if (isCandidateVerified && planMime && (planMime.startsWith('video/') || planMime.startsWith('image/'))) {
    if (!isProtected || mediaPlan?.verifiedBlob?.blobUrl) {
      return planMime;
    }
  }

  // 2. If protected transport (Anime-Pictures, Gelbooru, etc.), use protected fetch:
  if (isProtected) {
    const variantPolicy = mediaPlan?.variantPolicy || {};
    const advanceOnCodes = new Set(variantPolicy.advanceOn || [404, 410]);
    const variants = (mediaPlan?.isCandidateGroup && Array.isArray(mediaPlan.variants) && mediaPlan.variants.length > 0)
      ? mediaPlan.variants
      : [{ url: targetUrl }];

    let startIndex = variants.findIndex(v => v.url === targetUrl);
    if (startIndex === -1) startIndex = 0;

    for (let i = startIndex; i < variants.length; i++) {
      const currentVariant = variants[i];
      const currentUrl = currentVariant.url;
      const currentHostInfo = getProtectedHostInfo(currentUrl);

      const probeTaskKey = acquireOffscreenTask('mime_probe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      let transferredTask = false;
      let probeRes = null;
      try {
        const tOffscreenDocStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        await ensureOffscreenDocument();
        const tOffscreenDocReady = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        console.log(`[Chooser Profiler] 3a. offscreen document ready (duration: ${(tOffscreenDocReady - tOffscreenDocStart).toFixed(1)}ms)`);
        const action = currentHostInfo?.type === 'gelbooru' ? 'FETCH_GELBOORU_BLOB' : 'FETCH_PROTECTED_BLOB';
        console.log(`[Chooser Profiler] 3b. offscreen probe task dispatched (${action}) for variant [${i + 1}/${variants.length}]: ${sanitizeUrlForLog(currentUrl)}`);
        const tProbeStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        try {
          probeRes = await offscreenRequest({
            action,
            url: currentUrl
          });
        } catch (sendErr) {
          const errStr = (sendErr?.message || String(sendErr)).toLowerCase();
          const isConnLoss = errStr.includes('message channel closed') ||
                             errStr.includes('message port closed') ||
                             errStr.includes('could not establish connection') ||
                             errStr.includes('receiving end does not exist');
          if (isConnLoss) {
            console.warn('[MediaLatch] Message channel closed during protected probe, retrying once:', sendErr.message);
            await ensureOffscreenDocument();
            probeRes = await offscreenRequest({
              action,
              url: currentUrl
            });
          } else {
            throw sendErr;
          }
        }
        const tProbeEnd = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        console.log(`[Chooser Profiler] 3c. offscreen probe task completed (duration: ${(tProbeEnd - tProbeStart).toFixed(1)}ms, status: ${probeRes?.success ? 'success' : 'failed'}, size: ${probeRes?.size || 0} bytes)`);

        if (probeRes && probeRes.success && probeRes.blobUrl) {
          const verifiedContentType = (probeRes.contentType || '').split(';')[0].trim().toLowerCase();
          if (verifiedContentType && (verifiedContentType.startsWith('image/') || verifiedContentType.startsWith('video/'))) {
            if (mediaPlan?.metadata) {
              mediaPlan.metadata.contentType = verifiedContentType;
              mediaPlan.metadata.verified = true;
              mediaPlan.metadata.mimeEvidence = MIME_EVIDENCE.PROTECTED_FETCH;
              mediaPlan.metadata.verifiedUrl = currentUrl;
              if (probeRes.isAnimated !== undefined) {
                mediaPlan.metadata.isAnimated = probeRes.isAnimated;
              }
            }
            if (probeRes.isAnimated !== undefined && mediaPlan?.metadata) {
              mediaPlan.metadata.isAnimated = probeRes.isAnimated;
            }
            // Retain verified Blob URL for reuse in download execution, avoiding duplicate full download!
            mediaPlan.verifiedBlob = {
              blobUrl: probeRes.blobUrl,
              contentType: verifiedContentType,
              probeTaskKey: probeTaskKey,
              size: probeRes.size || 0,
              url: currentUrl
            };
            transferredTask = true;
            return verifiedContentType;
          }
          console.warn('[MediaLatch] Protected probe returned invalid/non-media MIME:', verifiedContentType);
          return null;
        }

        const status = resolveCandidateHttpStatus(probeRes?.status, probeRes?.error);
        const errMsg = probeRes?.error || (status ? `HTTP ${status}` : 'Protected probe failed');

        if (status === 429) {
          console.warn('[MediaLatch] HTTP 429 received during protected probe:', sanitizeUrlForLog(currentUrl));
          if (mediaPlan) {
            mediaPlan._rateLimited = true;
            mediaPlan._verificationStatus = 429;
            mediaPlan.error = 'RATE_LIMIT';
          }
          await flashBadge('RATE', '#f59e0b');
          return null;
        }

        if (status === 403 || status === 401) {
          console.warn('[MediaLatch] HTTP 403/401 received during protected probe:', sanitizeUrlForLog(currentUrl));
          if (mediaPlan) {
            mediaPlan._verificationStatus = status;
            mediaPlan.error = 'AUTH_REQUIRED';
          }
          await flashBadge('AUTH', '#f59e0b');
          return null;
        }

        if (advanceOnCodes.has(status)) {
          console.warn(`[MediaLatch] Вариант вернул HTTP ${status}, переход к следующему варианту:`, sanitizeUrlForLog(currentUrl));
          continue;
        }

        console.warn(`[MediaLatch] Защищенный зонд завершился с непереходной ошибкой (status: ${status}):`, errMsg);
        return null;
      } catch (e) {
        console.warn('[MediaLatch] Protected probe failed for MIME verification:', e);
        const status = resolveCandidateHttpStatus(e?.status, e?.message);
        if (status === 429) {
          if (mediaPlan) {
            mediaPlan._rateLimited = true;
            mediaPlan._verificationStatus = 429;
            mediaPlan.error = 'RATE_LIMIT';
          }
          await flashBadge('RATE', '#f59e0b');
          return null;
        } else if (status === 403 || status === 401) {
          if (mediaPlan) {
            mediaPlan._verificationStatus = status;
            mediaPlan.error = 'AUTH_REQUIRED';
          }
          await flashBadge('AUTH', '#f59e0b');
          return null;
        } else if (advanceOnCodes.has(status)) {
          console.warn(`[MediaLatch] Исключение зонда с переходящим статусом HTTP ${status}, переход к следующему варианту:`, sanitizeUrlForLog(currentUrl));
          continue;
        }
        return null;
      } finally {
        if (!transferredTask) {
          await releaseOffscreenTask(probeTaskKey, probeRes?.blobUrl).catch(() => {});
        }
      }
    }
    return null;
  }

  // 3. For direct/unprotected video URLs (including Reddit, RedGIFs frame-resolved, direct CDN):
  if (isVideoContext || isDirectVideoUrl(targetUrl)) {
    const variantPolicy = mediaPlan?.variantPolicy || {};
    const advanceOnCodes = new Set(variantPolicy.advanceOn || [404, 410]);
    const variants = (mediaPlan?.isCandidateGroup && Array.isArray(mediaPlan.variants) && mediaPlan.variants.length > 0)
      ? mediaPlan.variants
      : [{ url: targetUrl }];
    let startIndex = variants.findIndex(v => v.url === targetUrl);
    if (startIndex === -1) startIndex = 0;

    for (let i = startIndex; i < variants.length; i++) {
      const currentUrl = variants[i].url;
      const probe = await probeVideoUrlDetails(currentUrl);
      if (probe && (probe.status === 429 || probe.error === 'RATE_LIMIT')) {
        console.warn('[MediaLatch] HTTP 429 received during video probe:', sanitizeUrlForLog(currentUrl));
        if (mediaPlan) {
          mediaPlan._rateLimited = true;
          mediaPlan._verificationStatus = 429;
        }
        await flashBadge('RATE', '#f59e0b');
        return null;
      }
      if (probe && (probe.status === 401 || probe.status === 403 || probe.requiresAuth)) {
        console.warn(`[MediaLatch] HTTP ${probe.status} received during video probe:`, sanitizeUrlForLog(currentUrl));
        if (mediaPlan) {
          mediaPlan._verificationStatus = probe.status;
          mediaPlan.error = 'AUTH_REQUIRED';
        }
        await flashBadge('AUTH', '#f59e0b');
        return null;
      }
      if (probe && probe.ok && probe.contentType) {
        const verifiedType = probe.contentType.split(';')[0].trim().toLowerCase();
        if (verifiedType.startsWith('video/')) {
          if (mediaPlan?.metadata) {
            mediaPlan.metadata.contentType = verifiedType;
            mediaPlan.metadata.verified = true;
            mediaPlan.metadata.mimeEvidence = MIME_EVIDENCE.HTTP_RESPONSE;
            mediaPlan.metadata.verifiedUrl = currentUrl;
          }
          // The verified member becomes the plan's first variant (as resolveOriginalMediaPlan does for a probed group): primaryUrl is a getter over
          // variants[0], and the direct executor starts there, so the URL that downloads is the URL whose MIME was just recorded. Members only, none added.
          if (i > 0 && mediaPlan?.isCandidateGroup && mediaPlan.variants === variants) {
            variants.unshift(variants.splice(i, 1)[0]);
          }
          return verifiedType;
        }
      }
      const status = probe?.status || (probe?.error === 'NOT_FOUND' ? 404 : (probe?.error === 'GONE' ? 410 : 0));
      if (advanceOnCodes.has(status)) {
        console.warn(`[MediaLatch] Direct video variant returned HTTP ${status}, advancing to next variant:`, sanitizeUrlForLog(currentUrl));
        continue;
      }
      if (mediaPlan) {
        mediaPlan._verificationStatus = status || 500;
        mediaPlan._verificationStatusObserved = Boolean(status);
        mediaPlan._probeFailed = true;
      }
      return null;
    }
    return null;
  }

  // 4. Direct image probe:
  const probeTarget = {
    url: targetUrl,
    source: 'final_verification',
    finalScore: 0,
    baseScore: 0,
    verified: false,
    contentLength: 0,
    contentType: ''
  };
  const isOk = await probeCandidate(probeTarget);
  if (probeTarget.status === 429) {
    console.warn('[MediaLatch] HTTP 429 received during image probe:', sanitizeUrlForLog(targetUrl));
    if (mediaPlan) {
      mediaPlan._rateLimited = true;
      mediaPlan._verificationStatus = 429;
      mediaPlan.error = 'RATE_LIMIT';
    }
    await flashBadge('RATE', '#f59e0b');
    return null;
  }
  if (probeTarget.status === 403 || probeTarget.status === 401) {
    console.warn(`[MediaLatch] HTTP ${probeTarget.status} received during image probe:`, sanitizeUrlForLog(targetUrl));
    if (mediaPlan) {
      mediaPlan._verificationStatus = probeTarget.status;
      mediaPlan.error = 'AUTH_REQUIRED';
    }
    await flashBadge('AUTH', '#f59e0b');
    return null;
  }
  if (isOk && probeTarget.contentType) {
    const verifiedType = probeTarget.contentType.split(';')[0].trim().toLowerCase();
    if (verifiedType.startsWith('image/')) {
      if (mediaPlan?.metadata) {
        mediaPlan.metadata.contentType = verifiedType;
        mediaPlan.metadata.verified = true;
        mediaPlan.metadata.mimeEvidence = MIME_EVIDENCE.HTTP_RESPONSE;
        mediaPlan.metadata.verifiedUrl = targetUrl;
      }
      return verifiedType;
    }
  }

  if (!isOk) {
    console.warn(`[MediaLatch] Финальная проверка изображения не подтвердила тип (HTTP: ${probeTarget.status || 'не наблюдался'}):`, sanitizeUrlForLog(targetUrl));
    if (mediaPlan) {
      mediaPlan._verificationStatus = probeTarget.status || 500;
      mediaPlan._verificationStatusObserved = Boolean(probeTarget.status);
      mediaPlan._probeFailed = true;
    }
  }

  return null;
}

async function onContextMenuClicked(info, tab) {
  // DEBUG-MENU-01: one attempt id per save (an inline save brings the id of its click); journal only, never an authority
  if (!info.dbgCid) info.dbgCid = dbgNewCid();
  dbg('menu', 'click', 'start', undefined, () => ({
    menu: info.menuItemId, hasSrc: Boolean(info.srcUrl), hasLink: Boolean(info.linkUrl), srcHost: info.srcUrl, linkHost: info.linkUrl,
    pageHost: info.pageUrl || (tab && tab.url), frame: info.frameId, kind: info.mediaType,
    inline: xInlineInfos.has(info) || redditInlineInfos.has(info) || redgifsInlineInfos.has(info), batch: postMediaItemInfos.has(info)
  }), { cid: info.dbgCid, tab: tab && tab.id });
  // A page/overlay click on X uses its existing selected-player path. Native sources and direct media links
  // retain the generic entry path (including X images); old IDs remain accepted for in-flight menu callbacks.
  if (info.menuItemId === 'save-image-item' && !info.srcUrl && !info.linkUrl &&
      isXPageUrl(info.frameUrl || info.pageUrl || tab?.url)) {
    info = { ...info, menuItemId: 'save-x-media-item' };
  }
  if (info.menuItemId === 'save-image-item' || info.menuItemId === CSS_MEDIA_MENU_ID) {
    const tProfilerStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
    console.log('[Chooser Profiler] 1. context menu received (t=0.0ms)');
    let rawImageUrl = (info.srcUrl || '').trim();
    const rawLinkUrl = (info.linkUrl || '').trim();
    console.log('[MediaLatch] Клик по контекстному меню для медиа:', sanitizeUrlForLog(rawImageUrl || rawLinkUrl));

    // Admission of the selected owner, the one gate of every save path: a source or media link from Chrome never
    // bypasses it, and no provider recovery, probe or download runs before it passes.
    const claimsMediaLink = !rawImageUrl && hasMediaAssociation('', rawLinkUrl);
    // An inline Reddit click (UX-11-RD) was proven by the document right before this call; a gesture capture, possibly of another tile, must not decide it.
    const owner = redditInlineInfos.has(info) || redgifsInlineInfos.has(info) || postMediaItemInfos.has(info) ? 'proven' : await resolveContextOwner(tab?.id, info.frameId, { src: rawImageUrl, link: claimsMediaLink ? rawLinkUrl : '' });
    dbg('menu', 'owner', owner === 'refused' || owner === 'preview' ? 'refused' : 'ok', owner === 'preview' ? 'SEEK_PREVIEW' : (owner === 'refused' ? 'STALE_OWNER' : undefined), { owner }, { cid: info.dbgCid, tab: tab && tab.id });
    if (owner === 'refused' || owner === 'preview') {
      console.warn(owner === 'preview'
        ? '[MediaLatch] The selected video is a seek preview, not the media of the post: save refused without requests'
        : '[MediaLatch] Владелец выбранной цели удалён, заменён или изменён после жеста — сохранение отклонено без запросов');
      const staleOp = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: '', site: fbSiteOf(info.pageUrl || tab?.url, ''), cid: info.dbgCid }, tab);
      await fbFail(staleOp, { stage: 'resolve', code: 'NO_MEDIA' });
      await fbBadgeReporter(staleOp)('ERR', '#ef4444');
      return;
    }

    // Fast resolution: If rawImageUrl is empty or is a blob URL and click occurred on Reddit, recover from fresh target or frame-matching cache
    const isRedditPage = (info.pageUrl && isRedditDomain((() => { try { return new URL(info.pageUrl).hostname; } catch(_) { return ''; } })())) ||
                         (tab?.url && isRedditDomain((() => { try { return new URL(tab.url).hostname; } catch(_) { return ''; } })()));

    if (info.menuItemId === 'save-image-item' && isRedditPage && (!rawImageUrl || rawImageUrl.startsWith('blob:')) && tab?.id) {
      const clickFrameId = typeof info.frameId === 'number' ? info.frameId : 0;
      let queryAttempted = false;
      let freshMedia = null;
      try {
        const resp = await chrome.tabs.sendMessage(
          tab.id,
          { action: 'GET_REDDIT_MEDIA_AT_CURSOR' },
          { frameId: clickFrameId }
        );
        queryAttempted = true;
        if (resp && typeof resp === 'object') {
          freshMedia = resp.media || null;
        }
      } catch (_) {
        queryAttempted = false;
      }

      if (queryAttempted) {
        if (freshMedia?.url) {
          rawImageUrl = freshMedia.url;
          lastDetectedRedditMediaByTab.set(tab.id, {
            media: freshMedia,
            timestamp: Date.now(),
            frameId: clickFrameId,
            documentUrl: info.pageUrl || ''
          });
        } else {
          // Content script explicitly found no media (or target disconnected/expired)
          lastDetectedRedditMediaByTab.delete(tab.id);
        }
      } else {
        // Content script unreachable: check bounded frame-matching cache as fallback
        const cached = lastDetectedRedditMediaByTab.get(tab.id);
        const isFresh = cached && cached.timestamp && (Date.now() - cached.timestamp < 10000);
        const isFrameMatch = cached && cached.frameId === clickFrameId;
        const isDocMatch = !cached?.documentUrl || !info.pageUrl || cached.documentUrl === info.pageUrl;
        if (isFresh && isFrameMatch && isDocMatch && cached.media?.url) {
          rawImageUrl = cached.media.url;
        }
      }
    }

    // 0. No <img>/<video> source and no media link: the click may be on a CSS background or under a simple overlay.
    // The page context (and a non-media link) carry no source, so the gesture's own element decides: one proven
    // http(s) asset or nothing (content/content_context_target.js / readContextMediaTarget). X player/CSS routing stays
    // provider-owned; a proven IMG under a profile/navigation link uses this same native-image path as other sites.
    // The proven kind travels with the URL: a page click has no info.mediaType, so a native <video> under an overlay
    // (possibly an extensionless URL) must enter the video path explicitly. Nothing else about validation changes.
    let gestureKind = '';
    // A URL-less player (blob/MSE) that the gesture proved is admitted only in a frame of RedGIFs itself, where the frame-local resolver
    // (content/content_redgifs.js, with its own gesture proof) answers; no address of the page or of a neighbor is used as the selection.
    let gesturePlayer = false;
    let gestureDocumentId = '';
    let gestureAt = null;
    // An own-site inline Save (REDGIFS-INLINE-01): the sending document proves the player itself, bound by a one-shot token and its document id
    const inlineRedGifs = redgifsInlineInfos.has(info) ? info.redgifsInline : null;
    let inlineToken = '';
    if (inlineRedGifs) {
      gesturePlayer = true;
      gestureDocumentId = inlineRedGifs.documentId;
      inlineToken = inlineRedGifs.token;
    } else if (!rawImageUrl && !hasMediaAssociation('', rawLinkUrl)) {
      const gestureMedia = await resolveContextMediaTarget(tab?.id, info.frameId);
      dbg('menu', 'gesture', gestureMedia ? 'ok' : 'skipped', gestureMedia ? undefined : 'NO_GESTURE_MEDIA', () => (gestureMedia ? { kind: gestureMedia.kind, host: gestureMedia.url } : null), { cid: info.dbgCid, tab: tab && tab.id });
      if (gestureMedia && gestureMedia.kind === 'player') {
        const frameIsRedGifs = isRedGifsUrl(info.frameUrl) || (!info.frameUrl && !info.frameId && isRedGifsUrl(info.pageUrl || tab?.url));
        if (frameIsRedGifs && tab?.id) {
          gesturePlayer = true;
          gestureDocumentId = gestureMedia.documentId || '';
          gestureAt = gestureMedia.gestureAt;
          console.log('[MediaLatch] Плеер RedGIFs без адреса выбран по жесту (разрешение в кадре)');
        }
      } else if (gestureMedia && (!isXPageUrl(info.pageUrl || tab?.url) || gestureMedia.kind === 'img')) {
        rawImageUrl = gestureMedia.url;
        gestureKind = gestureMedia.kind === 'video' ? 'video' : '';
        console.log('[MediaLatch] Медиа выбрано по жесту (CSS-фон/overlay):', sanitizeUrlForLog(rawImageUrl));
      }
    }

    // 1. Prevent non-media text/navigation links from falling through to page-level OpenGraph metadata.
    if (!gesturePlayer && !hasMediaAssociation(rawImageUrl, rawLinkUrl)) {
      console.log('[MediaLatch] Клик контекстного меню вызван без ассоциации с медиа — отмена разрешения');
      // No proven selected target (blank area, text, caption, a plain navigation link, a container): nothing is
      // resolved, probed or saved, before any provider or generic resolver runs. A click on the page entry or on a
      // link (the only way the image entry is reached without media) is refused visibly, not silently.
      if (info.menuItemId === CSS_MEDIA_MENU_ID || info.menuItemId === 'save-image-item' || rawLinkUrl) {
        dbg('menu', 'click', 'refused', 'NO_MEDIA_ASSOCIATION', null, { cid: info.dbgCid, tab: tab && tab.id });
        const noMediaOp = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: '', site: fbSiteOf(info.pageUrl || tab?.url, ''), cid: info.dbgCid }, tab);
        await fbFail(noMediaOp, { stage: 'resolve', code: 'NO_MEDIA' });
        await fbBadgeReporter(noMediaOp)('ERR', '#ef4444');
      }
      return;
    }

    // 2. Prevent duplicate in-flight resolution/download pipelines for the same normalized source media
    // an inline Save is keyed by the document and the very player it came from: another player's save is a request of its own, a repeat of the same player is a duplicate
    const dedupeKey = rawImageUrl || rawLinkUrl || (inlineRedGifs
      ? `gesture-player:${tab.id}:${info.frameId ?? 0}:${inlineRedGifs.documentId}:${inlineRedGifs.player}`
      : `gesture-player:${tab.id}:${info.frameId ?? 0}`);
    if (inFlightRequests.has(dedupeKey)) {
      console.warn('[MediaLatch] Запрос на сохранение данного медиа уже выполняется, игнорируем дубликат:', dedupeKey);
      dbg('menu', 'click', 'skipped', 'DUPLICATE_IN_FLIGHT', null, { cid: info.dbgCid, tab: tab && tab.id });
      return;
    }
    inFlightRequests.add(dedupeKey);
    activeResolvingCount++;

    const op = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: rawImageUrl || rawLinkUrl, site: fbSiteOf(info.pageUrl || tab?.url, rawImageUrl || rawLinkUrl), cid: info.dbgCid }, tab);
    const flashBadge = fbBadgeReporter(op);

    // Declared before the try so the catch block below can read it (it was try-scoped, which made the
    // catch itself throw a ReferenceError and skip the failure badge/feedback).
    let mediaPlan = null;
    try {
      await setBadge('...', '#9333ea');

      const settings = await chrome.storage.local.get({
        subfolder: 'SavedImages',
        folderOrganizationMode: 'single',
        xAuthorFolders: false
      });

      if(settings.xAuthorFolders===true && isXPageUrl(info.pageUrl || tab?.url))settings.xAuthor=await selectedXAuthor(info,tab,rawImageUrl);

      // An HLS-only post video proven by the selected Reddit player's document (inline): its frozen master address goes straight to the assembly
      if (redditInlineInfos.has(info) && info.redditInlineMedia && info.redditInlineMedia.redditHls === true) {
        await executeRedditHlsDownload(info.redditInlineMedia.url, settings, { pageUrl: info.pageUrl || tab?.url || '', feedbackOp: op });
        return;
      }

      const isBlob = rawImageUrl.startsWith('blob:');
      const isRedGifs = isRedGifsUrl(info.frameUrl) ||
                        isRedGifsUrl(info.pageUrl) ||
                        isRedGifsUrl(rawImageUrl) ||
                        isRedGifsUrl(rawLinkUrl);
      const isTweetThumb = Boolean(resolveTweetVideoThumbUrl(rawImageUrl)) || Boolean(resolveTweetVideoThumbUrl(rawLinkUrl));
      const isXPoster = isXVideoPosterUrl(rawImageUrl) || isXVideoPosterUrl(rawLinkUrl);
      let isVideo = info.mediaType === 'video' || gestureKind === 'video' || gesturePlayer || isDirectVideoUrl(rawImageUrl) || isDirectVideoUrl(rawLinkUrl) || isBlob || isRedGifs || isTweetThumb || isXPoster;
      let targetMediaUrl = null;
      let mediaResolution = null;
      await fbStage(op, 'resolving', { expectedType: isVideo ? 'video' : 'image' });

      // Fast path: Check for Danbooru DOM metadata before running full resolver search
      const isDanbooruHost = Boolean(
        tab?.id && (
          isDanbooruDomain(getUrlHostname(info.pageUrl)) ||
          isDanbooruDomain(getUrlHostname(rawImageUrl)) ||
          isDanbooruDomain(getUrlHostname(rawLinkUrl))
        )
      );

      let booruDomMeta = null;
      if (isDanbooruHost) {
        try {
          const clickedTarget = rawImageUrl || rawLinkUrl;
          const domRes = await queryBooruDomMetadata(tab.id, clickedTarget);
          if (isValidDanbooruMetadata(domRes, clickedTarget)) {
            booruDomMeta = domRes;
            console.log('[MediaLatch] Получены валидные DOM метаданные Danbooru (Fast Path):', sanitizeUrlForLog(booruDomMeta.originalUrl));
          }
        } catch (_) {}
      }

      if (booruDomMeta) {
        const ext = booruDomMeta.fileExt.toLowerCase();
        const extToMime = {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          webp: 'image/webp',
          gif: 'image/gif',
          webm: 'video/webm',
          mp4: 'video/mp4'
        };
        const mime = extToMime[ext] || 'image/jpeg';
        const isFastVideo = booruDomMeta.isVideo || ext === 'webm' || ext === 'mp4';
        const isFastAnimated = booruDomMeta.isAnimated || ext === 'gif' || isFastVideo;

        mediaPlan = adaptCandidateToGroup({
          url: booruDomMeta.originalUrl,
          source: 'booru_dom_metadata',
          score: 95,
          tier: 'original',
          allowVideo: isFastVideo,
          isBooruCandidate: true,
          provider: 'DanbooruEngine',
          metadata: {
            contentType: mime,
            fileExt: ext,
            isAnimated: isFastAnimated,
            isVideo: isFastVideo,
            md5: booruDomMeta.md5,
            postId: booruDomMeta.postId,
            mimeEvidence: MIME_EVIDENCE.URL_HINT
          }
        });
        if (mediaPlan) {
          mediaPlan._domFastPath = true;
          mediaPlan.verified = false;
          mediaPlan.primaryUrl = booruDomMeta.originalUrl;
          targetMediaUrl = booruDomMeta.originalUrl;
          if (isFastVideo) isVideo = true;
        }
      }

      // The batch owner proved the post; only its internally admitted declared originals get this path.
      if (postMediaItemInfos.has(info) && info.postMediaPlan) {
        mediaPlan = info.postMediaPlan;
        targetMediaUrl = mediaPlan.primaryUrl;
      }

      // Fallback: If DOM metadata is absent or invalid, execute standard resolver search
      if (!targetMediaUrl || !mediaPlan) {
        if (isVideo) {
          mediaResolution = await resolveMediaTarget({
            descriptor: createMediaDescriptor({
              type: 'video',
              src: rawImageUrl || rawLinkUrl,
              currentSrc: rawImageUrl || '',
              pageUrl: info.pageUrl,
              linkUrl: rawLinkUrl,
              poster: isXPoster ? (isXVideoPosterUrl(rawImageUrl) ? rawImageUrl : rawLinkUrl) : null,
              isBlobPlayer: isXPoster ? true : false,
              isXVideoPoster: isXPoster
            }),
            srcUrl: rawImageUrl,
            pageUrl: info.pageUrl,
            linkUrl: rawLinkUrl,
            tabId: tab?.id,
            frameId: info.frameId,
            gesturePlayer,
            gestureDocumentId,
            gestureAt,
            inlineToken,
            redGifsEmbed: redditInlineInfos.has(info) && info.redditInlineRedGifs ? info.redditInlineRedGifs : undefined
          });
          if (mediaResolution?.redditHls) {
            // the same assembly from the context menu: the selected player's declared master, read by its own frame and validated again
            await executeRedditHlsDownload(mediaResolution.redditHls.url, settings, { pageUrl: info.pageUrl || tab?.url || '', feedbackOp: op });
            return;
          }
          targetMediaUrl = mediaResolution?.targetUrl;
          mediaPlan = mediaResolution?.mediaPlan;
        } else {
          mediaPlan = await resolveOriginalMediaPlan({
            srcUrl: rawImageUrl || '',
            pageUrl: info.pageUrl,
            linkUrl: rawLinkUrl,
            tabId: tab?.id,
            frameId: info.frameId,
            allowPostMedia: true
          });
          targetMediaUrl = mediaPlan?.primaryUrl;
        }
      }

      if(mediaPlan?.pixivPostMedia){
        const current=await resolveContextOwner(tab?.id,info.frameId,{src:rawImageUrl,link:''});
        if(current!=='proven'){await fbFail(op,{stage:'resolve',code:'NO_MEDIA'});await flashBadge('ERR','#ef4444');return;}
        await fbDiscard(op);
        await savePixivPostMedia(mediaPlan.pixivPostMedia,info,tab);
        return;
      }
      if(['POST_MEDIA_MISMATCH','POST_MEDIA_UNAVAILABLE','BATCH_LIMIT'].includes(mediaPlan?.error)){
        await fbFail(op,{stage:'resolve',code:mediaPlan.error});await flashBadge('ERR','#ef4444');return;
      }
      if (mediaPlan?.pawchivePostMedia) {
        // the user chose to save a feed preview of a post with several originals: every distinct declared original is a separate item with its own operation
        await fbDiscard(op);
        await savePawchivePostMedia(mediaPlan.pawchivePostMedia, info, tab);
        return;
      }

      if (mediaPlan?.error === 'NOT_ARCHIVED') {
        // BUGFIX-MULTISITE-01: the site states this post's originals are not imported: its own failure (with the stated counts), not an unresolved click
        await fbFail(op, { stage: 'resolve', code: /^NOT_ARCHIVED(?:_P\d{1,3}_V\d{1,3})?$/.test(mediaPlan.failureCode || '') ? mediaPlan.failureCode : 'NOT_ARCHIVED' });
        await flashBadge('ERR', '#ef4444');
        return;
      }

      if (['sankaku','zerochan'].includes(mediaPlan?.provider) && ['NETWORK_TIMEOUT', 'NETWORK_ERROR'].includes(mediaPlan.error)) {
        await fbFail(op, { stage: 'resolve', code: mediaPlan.error, status: mediaPlan._verificationStatus });
        await flashBadge('ERR', '#ef4444');
        return;
      }

      const tProfilerPlan = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
      console.log(`[Chooser Profiler] 2. media plan selected (+${(tProfilerPlan - tProfilerStart).toFixed(1)}ms, duration: ${(tProfilerPlan - tProfilerStart).toFixed(1)}ms, target: ${sanitizeUrlForLog(targetMediaUrl)})`);

      if (!targetMediaUrl || !mediaPlan || mediaPlan?._rateLimited || mediaPlan?._verificationStatus === 429 || mediaPlan?.error === 'RATE_LIMIT' || mediaPlan?._verificationStatus === 403 || mediaPlan?._verificationStatus === 401 || mediaPlan?.error === 'AUTH_REQUIRED' || mediaPlan?.error === 'NOT_FOUND') {
        if (mediaPlan?._rateLimited || mediaPlan?._verificationStatus === 429 || mediaPlan?.error === 'RATE_LIMIT' || mediaResolution?.error === 'RATE_LIMIT' || mediaResolution?.status === 429) {
          console.warn('[MediaLatch] Отмена скачивания из-за HTTP 429 (RATE_LIMIT):', sanitizeUrlForLog(rawImageUrl || rawLinkUrl));
          await fbFail(op, { stage: 'resolve', code: 'RATE_LIMIT', status: fbStatusIn([mediaPlan?._verificationStatus, mediaResolution?.status], [429]) });
          await flashBadge('RATE', '#f59e0b');
          return;
        }
        if (mediaPlan?._verificationStatus === 403 || mediaPlan?._verificationStatus === 401 || mediaPlan?.error === 'AUTH_REQUIRED' || mediaResolution?.error === 'AUTH_REQUIRED') {
          console.warn('[MediaLatch] Отмена скачивания: ' + (mediaPlan?.message || mediaResolution?.message || 'требуется активная сессия'));
          await fbFail(op, { stage: 'resolve', code: 'AUTH_REQUIRED', status: fbStatusIn([mediaPlan?._verificationStatus, mediaResolution?.status], [401, 403]) });
          await flashBadge('AUTH', '#f59e0b');
          return;
        }
        if (mediaResolution?.error === 'UNRESOLVED_BLOB_MEDIA') {
          console.warn('[MediaLatch] Отмена скачивания: не удалось разрешить blob URL (UNRESOLVED_BLOB_MEDIA)');
          // a positively identified stream that cannot be saved is an unsupported source, not an unresolved element
          const unsupportedStream = mediaResolution.reason === 'UNSUPPORTED_DASH_STREAM' || mediaResolution.reason === 'UNSUPPORTED_STREAM';
          await fbFail(op, { stage: 'resolve', code: unsupportedStream ? 'UNSUPPORTED_SOURCE' : 'UNRESOLVED_BLOB_MEDIA' });
          await flashBadge('ERR', '#ef4444');
          return;
        }
        if (!targetMediaUrl || !mediaPlan || mediaPlan?.error === 'NOT_FOUND') {
          console.warn('[MediaLatch] Не удалось определить медиа для сохранения');
          const notFound = mediaPlan?.error === 'NOT_FOUND';
          await fbFail(op, {
            stage: 'resolve',
            code: notFound ? 'NOT_FOUND' : 'NO_MEDIA',
            // Keep an observed status; a status the pipeline defaulted (marked unobserved) is not evidence.
            status: notFound && mediaPlan._verificationStatusObserved !== false ? mediaPlan._verificationStatus : null
          });
          await flashBadge('ERR', '#ef4444');
          return;
        }
      }

      const isProtected = Boolean(getProtectedHostInfo(targetMediaUrl) || mediaPlan?.transport === 'protectedBlob' || mediaPlan?.transport === 'protected');

      // Verify the final media MIME via actual network probe/protected fetch
      const tProfilerMimeStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
      console.log(`[Chooser Profiler] 3. MIME check started (+${(tProfilerMimeStart - tProfilerStart).toFixed(1)}ms, target: ${sanitizeUrlForLog(targetMediaUrl)})`);
      const verifiedMime = await verifyFinalMediaMime(targetMediaUrl, mediaPlan, isVideo);
      const tProfilerMimeEnd = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
      console.log(`[Chooser Profiler] 4. MIME check completed (+${(tProfilerMimeEnd - tProfilerStart).toFixed(1)}ms, duration: ${(tProfilerMimeEnd - tProfilerMimeStart).toFixed(1)}ms, verifiedMime: ${verifiedMime})`);

      if (mediaPlan?.verifiedBlob?.url && mediaPlan.verifiedBlob.url !== targetMediaUrl) {
        targetMediaUrl = mediaPlan.verifiedBlob.url;
      } else if (mediaPlan?.metadata?.verifiedUrl && mediaPlan.metadata.verifiedUrl !== targetMediaUrl) {
        targetMediaUrl = mediaPlan.metadata.verifiedUrl;
      }

      if (mediaPlan?._rateLimited || mediaPlan?._verificationStatus === 429 || mediaPlan?.error === 'RATE_LIMIT') {
        console.warn('[MediaLatch] Остановка конвейера сохранения из-за HTTP 429 (RATE_LIMIT):', sanitizeUrlForLog(targetMediaUrl));
        await fbFail(op, { stage: 'verify', code: 'RATE_LIMIT', status: fbStatusIn([mediaPlan?._verificationStatus], [429]) });
        await flashBadge('RATE', '#f59e0b');
        return;
      }

      if (mediaPlan?._verificationStatus === 403 || mediaPlan?._verificationStatus === 401 || mediaPlan?.error === 'AUTH_REQUIRED') {
        console.warn('[MediaLatch] Отмена скачивания: требуется авторизация (HTTP 403/401):', sanitizeUrlForLog(targetMediaUrl));
        await fbFail(op, { stage: 'verify', code: 'AUTH_REQUIRED', status: fbStatusIn([mediaPlan?._verificationStatus], [401, 403]) });
        await flashBadge('AUTH', '#f59e0b');
        return;
      }

      if (!verifiedMime && (isVideo || isProtected || mediaPlan?._domFastPath || mediaPlan?._probeFailed)) {
        console.warn('[MediaLatch] Финальная верификация MIME завершилась неудачей, скачивание отклонено:', sanitizeUrlForLog(targetMediaUrl));
        await fbFail(op, { stage: 'verify', code: 'MIME_NOT_VERIFIED' });
        if (mediaPlan?.verifiedBlob?.probeTaskKey) {
          await releaseOffscreenTask(mediaPlan.verifiedBlob.probeTaskKey, mediaPlan.verifiedBlob.blobUrl).catch(() => {});
          delete mediaPlan.verifiedBlob;
        }
        await flashBadge('ERR', '#ef4444');
        return;
      }

      const isXTweetVideo = Boolean(isTweetThumb) ||
                            Boolean(resolveTweetVideoThumbUrl(targetMediaUrl)) ||
                            Boolean(resolveTweetVideoThumbUrl(rawImageUrl)) ||
                            Boolean(targetMediaUrl && toTweetVideoUrl(targetMediaUrl)) ||
                            mediaResolution?.descriptor?.type === 'x_tweet_video' ||
                            mediaResolution?.classification?.sourceType === 'x_tweet_video';

      if (isXTweetVideo && targetMediaUrl) {
        await executeXTweetVideoGifDownload(targetMediaUrl, settings, { pageUrl: info.pageUrl || tab?.url || '', feedbackOp: op });
        return;
      }

      const isRedditGif = isRedditAnimationUrl(targetMediaUrl) ||
                          isRedditAnimationUrl(rawImageUrl) ||
                          mediaResolution?.classification?.sourceType === 'reddit_gif' ||
                          mediaPlan?.metadata?.sourceType === 'reddit_gif';

      if (isRedditGif && targetMediaUrl) {
        await executeRedditGifDownload(targetMediaUrl, settings, { pageUrl: info.pageUrl || tab?.url || '', feedbackOp: op });
        return;
      }

      await executeMediaDownload({
        targetImageUrl: targetMediaUrl,
        rawImageUrl: rawImageUrl || targetMediaUrl,
        settings,
        mediaPlan,
        pageUrl: info.pageUrl || tab?.url || '',
        feedbackOp: op
      });
    } catch (downloadError) {
      if (mediaPlan?.verifiedBlob?.probeTaskKey) {
        await releaseOffscreenTask(mediaPlan.verifiedBlob.probeTaskKey, mediaPlan.verifiedBlob.blobUrl).catch(() => {});
        delete mediaPlan.verifiedBlob;
      }
      console.error('[MediaLatch] Критическая ошибка при сохранении:', downloadError);
      await fbFail(op, { code: downloadError?.message });
      await flashBadge('ERR', '#ef4444');
    } finally {
      activeResolvingCount--;
      inFlightRequests.delete(dedupeKey);
      if (!toolbarBadge.flashing) {
        await restoreOrClearBadge();
      }
    }
  } else if (info.menuItemId === 'save-x-media-item') {
    if (!tab?.id) {
      console.warn('[MediaLatch] Клик по X media меню без активного tab.id');
      return;
    }

    const op = await fbBegin({ pageUrl: tab.url || info.pageUrl || '', sourceUrl: '', site: fbSiteOf(tab.url || info.pageUrl, ''), cid: info.dbgCid }, tab);
    const flashBadge = fbBadgeReporter(op);

    try {
      let mediaResult = null;
      if (xInlineInfos.has(info)) {
        // The inline button's descriptor: built by this document's content script after it proved the owner again for this
        // very click (see handleXInlineSave); no context-menu cursor state is read. Everything below is the shared X pipeline.
        mediaResult = info.xInlineMedia;
      } else try {
        mediaResult = await chrome.tabs.sendMessage(tab.id, { action: 'GET_X_MEDIA_AT_CURSOR' });
      } catch (msgErr) {
        try {
          if (chrome.scripting?.executeScript) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              injectImmediately: true,
              files: ['lib/debug_journal.js', 'lib/i18n.js', 'content/content_x.js'] // the journal client and the label catalogue first (DEBUG-MENU-01, UI-LOCALIZATION-01)
            });
            mediaResult = await chrome.tabs.sendMessage(tab.id, { action: 'GET_X_MEDIA_AT_CURSOR' });
          }
        } catch (injectErr) {
          console.warn('[MediaLatch] Не удалось связаться с content/content_x.js:', injectErr);
        }
      }

      const rawMediaUrl = mediaResult?.url || mediaResult?.src;
      // CLAUDE-RESUME-04: an unplayed X player has no address yet. When the content script proved it as a post's own player (X's own video poster and
      // the owning post), the existing recovery below reads the post's declared MP4; the poster is never the media and nothing is guessed.
      const unplayedOwnedXPlayer = Boolean(mediaResult) && !rawMediaUrl && mediaResult.type === 'video' && mediaResult.isBlobPlayer === true &&
        mediaResult.isHlsOnly !== true && isXVideoPosterUrl(mediaResult.poster) && Boolean(mediaResult.tweetId || mediaResult.postUrl);
      dbg('x', 'descriptor', mediaResult && (rawMediaUrl || unplayedOwnedXPlayer) ? 'ok' : 'refused', mediaResult && (rawMediaUrl || unplayedOwnedXPlayer) ? undefined : (mediaResult ? 'NO_ADDRESS' : 'NO_DESCRIPTOR'), () => (mediaResult ? {
        type: mediaResult.type, host: rawMediaUrl, blob: mediaResult.isBlobPlayer === true, hls: mediaResult.isHlsOnly === true, isQuote: mediaResult.isQuoteTweet === true,
        postId: mediaResult.tweetId || undefined, mediaId: mediaResult.mediaIdHint || undefined, index: mediaResult.mediaIndex, inline: xInlineInfos.has(info)
      } : null), { cid: info.dbgCid, op, tab: tab.id });
      if (!mediaResult || (!rawMediaUrl && !unplayedOwnedXPlayer)) {
        console.warn('[MediaLatch] Медиа под курсором на странице X не найдено');
        await fbFail(op, { stage: 'resolve', code: 'NO_MEDIA' });
        await flashBadge('ERR', '#ef4444');
        return;
      }
      if (!mediaResult.url) {
        mediaResult.url = rawMediaUrl;
      }

      const settings = await chrome.storage.local.get({
        subfolder: 'SavedImages',
        folderOrganizationMode: 'single',
        xAuthorFolders: false
      });

      await fbSetPost(op, mediaResult.postUrl);
      if(settings.xAuthorFolders===true)settings.xAuthor=xAuthorFromPost(mediaResult.authorPostUrl);
      await fbStage(op, 'resolving', {
        sourceUrl: mediaResult.url,
        expectedType: mediaResult.type === 'x_tweet_video' ? 'gif' : (mediaResult.type === 'video' ? 'video' : 'image'),
        conversion: mediaResult.type === 'x_tweet_video' ? 'x_tweet_video_gif' : undefined
      });

      const classification = classifyMediaTarget({
        url: mediaResult.url,
        domType: mediaResult.type,
        poster: mediaResult.poster,
        mime: mediaResult.mime
      });

      if (mediaResult.type === 'x_tweet_video' || classification?.sourceType === 'x_tweet_video') {
        let isValidTweetVideo = false;
        try {
          const parsed = new URL(mediaResult.url);
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            const h = parsed.hostname.toLowerCase();
            const p = parsed.pathname.toLowerCase();
            if (h === 'video.twimg.com' && p.includes('/tweet_video/') && p.endsWith('.mp4')) {
              isValidTweetVideo = true;
            }
          }
        } catch (e) {}

        if (!isValidTweetVideo) {
          console.warn('[MediaLatch] Отклонен неподходящий URL X tweet_video:', sanitizeUrlForLog(mediaResult.url));
          await fbFail(op, { stage: 'verify', code: 'INVALID_MEDIA' });
          await flashBadge('ERR', '#ef4444');
          return;
        }

        const dedupeKey = mediaResult.url;
        if (inFlightRequests.has(dedupeKey)) {
          console.warn('[MediaLatch] Загрузка этого X медиа уже выполняется:', sanitizeUrlForLog(dedupeKey));
          await fbDiscard(op);
          return;
        }
        inFlightRequests.add(dedupeKey);
        activeResolvingCount++;

        try {
          await executeXTweetVideoGifDownload(mediaResult.url, settings, { pageUrl: tab.url || info.pageUrl || '', feedbackOp: op });
        } catch (err) {
          console.error('[MediaLatch] Ошибка конвертации и скачивания X tweet video:', err);
          await flashBadge('ERR', '#ef4444');
        } finally {
          activeResolvingCount--;
          inFlightRequests.delete(dedupeKey);
          if (!toolbarBadge.flashing) {
            await restoreOrClearBadge();
          }
        }
      } else if (mediaResult.type === 'video') {
        let rawVideoUrl = mediaResult.src || mediaResult.url;
        const isBlobOrManifest = !rawVideoUrl || rawVideoUrl.startsWith('blob:') || mediaResult.isBlobPlayer || isHlsManifestUrl(rawVideoUrl);

        if (mediaResult.recoveredMp4Url) {
          rawVideoUrl = mediaResult.recoveredMp4Url;
        } else if (mediaResult.isHlsOnly && !isBlobOrManifest) {
          console.warn('[MediaLatch] Видео в посте X доступно только в виде HLS-потока (m3u8) без прямого MP4 варианта:', sanitizeUrlForLog(mediaResult.postUrl || rawVideoUrl));
          await fbFail(op, { stage: 'resolve', code: 'HLS_ONLY' });
          await flashBadge('ERR', '#ef4444');
          return;
        } else if (isBlobOrManifest) {
          // Player exposed only blob: or a manifest: recover direct MP4 variant from first-party post metadata
          const recovery = await recoverXPostMp4Variant(tab.id, mediaResult);
          if (recovery.ok && recovery.mp4Url) {
            rawVideoUrl = recovery.mp4Url;
          } else if (recovery.isHlsOnly) {
            console.warn('[MediaLatch] Видео в посте X доступно только в виде HLS-потока (m3u8) без прямого MP4 варианта:', sanitizeUrlForLog(mediaResult.postUrl || rawVideoUrl));
          await fbFail(op, { stage: 'resolve', code: 'HLS_ONLY' });
            await flashBadge('ERR', '#ef4444');
            return;
          } else {
            console.warn('[MediaLatch] Не удалось восстановить прямой MP4 из метаданных поста X для blob-плеера:', sanitizeUrlForLog(mediaResult.postUrl || rawVideoUrl), describeXRecoveryFailure(recovery));
            await fbFail(op, { stage: 'resolve', code: 'NO_MEDIA' });
            await flashBadge('ERR', '#ef4444');
            return;
          }
        }

        if (!isValidXVideoCdnUrl(rawVideoUrl)) {
          console.warn('[MediaLatch] Невалидный CDN хост для видео X:', sanitizeUrlForLog(rawVideoUrl));
          await flashBadge('ERR', '#ef4444');
          return;
        }

        let parsedUrl;
        try {
          parsedUrl = new URL(rawVideoUrl);
        } catch (_) {
          console.warn('[MediaLatch] Некорректный URL видео с X:', sanitizeUrlForLog(rawVideoUrl));
          await flashBadge('ERR', '#ef4444');
          return;
        }
        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
          console.warn('[MediaLatch] Неподдерживаемый протокол видео с X:', sanitizeUrlForLog(rawVideoUrl));
          await flashBadge('ERR', '#ef4444');
          return;
        }

        const dedupeKey = rawVideoUrl;
        if (inFlightRequests.has(dedupeKey)) {
          console.warn('[MediaLatch] Загрузка этого видео уже выполняется:', sanitizeUrlForLog(dedupeKey));
          await fbDiscard(op);
          return;
        }
        inFlightRequests.add(dedupeKey);
        activeResolvingCount++;

        try {
          await setBadge('...', '#9333ea');
          const probe = await probeVideoUrlDetails(rawVideoUrl);
          if (probe && (probe.status === 401 || probe.status === 403 || probe.requiresAuth)) {
            console.warn('[MediaLatch] Ошибка авторизации видео с X (HTTP 401/403):', sanitizeUrlForLog(rawVideoUrl));
            await fbFail(op, { stage: 'verify', code: 'AUTH_REQUIRED', status: fbStatusIn([probe?.status], [401, 403]) });
            await flashBadge('AUTH', '#f59e0b');
            return;
          }
          if (probe && (probe.status === 429 || probe.error === 'RATE_LIMIT')) {
            console.warn('[MediaLatch] Превышен лимит запросов для видео с X (HTTP 429):', sanitizeUrlForLog(rawVideoUrl));
            await fbFail(op, { stage: 'verify', code: 'RATE_LIMIT', status: fbStatusIn([probe?.status], [429]) });
            await flashBadge('RATE', '#f59e0b');
            return;
          }
          if (!probe || !probe.ok) {
            console.warn('[MediaLatch] Ошибка проверки доступности видео с X:', probe?.error || probe?.status);
            await fbFail(op, { stage: 'verify', code: probe?.error, status: Number.isInteger(probe?.status) ? probe.status : null });
            await flashBadge('ERR', '#ef4444');
            return;
          }

          const verifiedType = (probe.contentType || '').split(';')[0].trim().toLowerCase();
          const isAcceptableMp4Mime = (
            verifiedType === 'video/mp4' ||
            ((verifiedType === 'application/octet-stream' || verifiedType === 'binary/octet-stream' || verifiedType === '') &&
             isDirectVideoUrl(rawVideoUrl) && !rawVideoUrl.toLowerCase().includes('.webm') && !rawVideoUrl.toLowerCase().includes('.mov'))
          );
          if (verifiedType === 'video/webm' || verifiedType === 'video/quicktime' || verifiedType.includes('webm') || verifiedType.includes('quicktime') || !isAcceptableMp4Mime) {
            console.warn('[MediaLatch] Отклонен неподходящий Content-Type для X MP4:', verifiedType);
            await fbFail(op, { stage: 'verify', code: 'INVALID_MEDIA' });
            await flashBadge('ERR', '#ef4444');
            return;
          }

          // Bounded MP4 container byte verification
          const containerCheck = await verifyMp4ContainerBytes(rawVideoUrl);
          if (!containerCheck.ok) {
            console.warn('[MediaLatch] Отклонен невалидный MP4 контейнер для видео с X:', containerCheck.error, containerCheck.sniffedMime || '');
            await fbFail(op, { stage: 'verify', code: 'INVALID_CONTAINER' });
            await flashBadge('ERR', '#ef4444');
            return;
          }

          const mediaPlan = adaptCandidateToGroup({
            url: rawVideoUrl,
            source: 'x_video',
            tier: 'original',
            score: 90,
            contentType: 'video/mp4',
            mediaType: 'video',
            verified: true
          });

          await executeMediaDownload({
            targetImageUrl: rawVideoUrl,
            rawImageUrl: rawVideoUrl,
            settings,
            mediaPlan,
            pageUrl: tab.url || info.pageUrl || '',
            feedbackOp: op
          });
        } catch (err) {
          console.error('[MediaLatch] Ошибка скачивания видео с X:', err);
          await flashBadge('ERR', '#ef4444');
        } finally {
          activeResolvingCount--;
          inFlightRequests.delete(dedupeKey);
          if (!toolbarBadge.flashing) {
            await restoreOrClearBadge();
          }
        }
      } else if (mediaResult.type === 'image') {
        const rawImageUrl = mediaResult.url;
        const dedupeKey = rawImageUrl;
        if (inFlightRequests.has(dedupeKey)) {
          console.warn('[MediaLatch] Загрузка этого изображения уже выполняется:', sanitizeUrlForLog(dedupeKey));
          await fbDiscard(op);
          return;
        }
        inFlightRequests.add(dedupeKey);
        activeResolvingCount++;

        try {
          await setBadge('...', '#9333ea');
          const mediaPlan = await resolveOriginalMediaPlan({
            srcUrl: rawImageUrl,
            pageUrl: tab.url || info.pageUrl,
            tabId: tab.id
          });
          const targetImageUrl = mediaPlan?.primaryUrl;

          if (!targetImageUrl && !mediaPlan) {
            console.warn('[MediaLatch] Не удалось определить изображение для сохранения с X:', sanitizeUrlForLog(rawImageUrl));
            await flashBadge('ERR', '#ef4444');
            return;
          }

          await executeMediaDownload({
            targetImageUrl,
            rawImageUrl,
            settings,
            mediaPlan,
            pageUrl: tab.url || info.pageUrl || '',
            feedbackOp: op
          });
        } catch (err) {
          console.error('[MediaLatch] Ошибка скачивания изображения с X:', err);
          await flashBadge('ERR', '#ef4444');
        } finally {
          activeResolvingCount--;
          inFlightRequests.delete(dedupeKey);
          if (!toolbarBadge.flashing) {
            await restoreOrClearBadge();
          }
        }
      } else {
        console.warn('[MediaLatch] Неподдерживаемый тип медиа с X:', mediaResult.type);
        await fbFail(op, { stage: 'resolve', code: 'UNSUPPORTED_MEDIA' });
        await flashBadge('ERR', '#ef4444');
      }
    } catch (outerErr) {
      console.error('[MediaLatch] Общая ошибка при обработке X media:', outerErr);
      await flashBadge('ERR', '#ef4444');
    }
  }
}
chrome.contextMenus.onClicked.addListener(onContextMenuClicked);

// UX-10: the inline Save control over X media ("Save this", and "Save all" for a post with several media). The content script sends only a one-shot token. This handler validates the sender
// (the extension's own content script, an X page, the active tab, a frame), asks the same frame and document to prove the owner
// again and to build the descriptor with the context-menu builder, re-validates what comes back, and then runs the existing
// save-x-media-item pipeline above, so both entries share resolution, verification, GIF semantics, folders, the download
// lifecycle and feedback. A removed, replaced, re-sourced, moved or recycled owner is refused before any provider request.
const xInlineInfos = new WeakSet();
const xInlineBusy = new Set();
const X_INLINE_TOKEN = /^[a-f0-9]{32}$/;
// Save all: at most this many items per post and this many items in flight at once.
const X_INLINE_BATCH_MAX = POST_MEDIA_MAX;
const X_INLINE_BATCH_CONCURRENCY = 2;

function sanitizeXInlineMedia(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = (v, max = 2048) => (typeof v === 'string' && v.length <= max ? v : '');
  const twimg = (u) => {
    try { const p = new URL(u); return p.protocol === 'https:' && (p.hostname === 'twimg.com' || p.hostname.endsWith('.twimg.com')); } catch (_) { return false; }
  };
  const digits = (v) => (typeof v === 'string' && /^\d{1,25}$/.test(v) ? v : null);
  const type = raw.type;
  if (type !== 'image' && type !== 'video' && type !== 'x_tweet_video') return null;
  const url = text(raw.url);
  const src = text(raw.src) || url;
  if ((type === 'image' || type === 'x_tweet_video') && !twimg(url)) return null;
  if (type === 'video' && url && !url.startsWith('blob:') && !twimg(url)) return null;
  const poster = text(raw.poster);
  if (poster && !twimg(poster)) return null;
  const recovered = text(raw.recoveredMp4Url);
  if (recovered && !isValidXVideoCdnUrl(recovered)) return null;
  const postUrl = text(raw.postUrl);
  if (postUrl && !isXPageUrl(postUrl)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6 ? v : null);
  return {
    type, src, url, currentSrc: text(raw.currentSrc) || src, poster: poster || null, mime: text(raw.mime, 100) || null,
    pageUrl: text(raw.pageUrl), linkUrl: text(raw.linkUrl) || null, x: num(raw.x), y: num(raw.y),
    sourceType: ['image', 'video', 'x_tweet_video'].includes(raw.sourceType) ? raw.sourceType : type,
    animated: raw.animated === true, isHlsOnly: raw.isHlsOnly === true, isBlobPlayer: raw.isBlobPlayer === true,
    recoveredMp4Url: recovered || null, recoveredBitrate: num(raw.recoveredBitrate), postUrl: postUrl || null,
    authorPostUrl:xAuthorFromPost(raw.authorPostUrl)?text(raw.authorPostUrl):null,
    tweetId: digits(raw.tweetId), mediaIdHint: digits(raw.mediaIdHint),
    mediaIndex: Number.isInteger(raw.mediaIndex) && raw.mediaIndex >= 0 && raw.mediaIndex < 100 ? raw.mediaIndex : null,
    isQuoteTweet: raw.isQuoteTweet === true
  };
}

// The extension's own content script, an X page, the active tab, a well-formed one-shot token. Nothing else in the message is read.
function xInlineSenderOk(message, sender) {
  return isContentScriptSender(sender) && isXPageUrl(sender.url) && sender.tab.active === true &&
    typeof message.token === 'string' && X_INLINE_TOKEN.test(message.token);
}

// Only the sending frame and the sending document can answer.
async function xInlineAsk(tab, sender, payload) {
  try {
    const options = { frameId: sender.frameId };
    if (typeof sender.documentId === 'string' && sender.documentId) options.documentId = sender.documentId;
    return await chrome.tabs.sendMessage(tab.id, payload, options);
  } catch (_) {
    return null;
  }
}

// A refused owner is visible: a failed operation and an ERR badge, never silence and never a request.
async function xInlineRefuse(sender, cid) {
  const op = await fbBegin({ pageUrl: sender.url || '', sourceUrl: '', site: fbSiteOf(sender.url, ''), cid }, sender.tab);
  await fbFail(op, { stage: 'resolve', code: 'NO_MEDIA' });
  await fbBadgeReporter(op)('ERR', '#ef4444');
}

// One proven descriptor through the shared save-x-media-item pipeline, unless the same item is already running.
async function xInlineRun(tab, sender, media, cid) {
  const key = `${tab.id}:${sender.frameId}:${media.recoveredMp4Url || media.url || media.poster || ''}|${media.tweetId || ''}`;
  if (xInlineBusy.has(key)) { dbg('x.inline', 'run', 'skipped', 'BUSY', null, { cid, tab: tab.id, frame: sender.frameId }); return false; }
  xInlineBusy.add(key);
  try {
    dbg('x.inline', 'run', 'start', undefined, () => ({ type: media.type, blob: media.isBlobPlayer, hls: media.isHlsOnly, isQuote: media.isQuoteTweet, postId: media.tweetId || undefined, mediaId: media.mediaIdHint || undefined, index: media.mediaIndex }), { cid, tab: tab.id, frame: sender.frameId });
    const info = { menuItemId: 'save-x-media-item', pageUrl: sender.url, frameId: sender.frameId, xInlineMedia: media, dbgCid: cid };
    xInlineInfos.add(info);
    await onContextMenuClicked(info, tab);
    return true;
  } finally {
    xInlineBusy.delete(key);
  }
}

async function handleXInlineSave(message, sender) {
  const cid = dbgCidOf(message);
  if (!xInlineSenderOk(message, sender)) { dbg('x.inline', 'save', 'refused', 'SENDER_REJECTED', null, { cid, tab: sender && sender.tab && sender.tab.id }); return; }
  dbg('x.inline', 'save', 'start', undefined, null, { cid, tab: sender.tab.id, frame: sender.frameId });
  const answer = await xInlineAsk(sender.tab, sender, { action: 'X_INLINE_OWNER', token: message.token });
  const media = answer && answer.ok === true ? sanitizeXInlineMedia(answer.media) : null;
  dbg('x.inline', 'owner', media ? 'ok' : 'refused', media ? undefined : (answer && answer.ok === false ? (dbgCode(answer.reason) || 'REFUSED') : (answer ? 'INVALID_DESCRIPTOR' : 'NO_ANSWER')), null, { cid, tab: sender.tab.id, frame: sender.frameId });
  if (!media) {
    console.warn('[MediaLatch] Inline X Save refused: the owner was not proven again');
    await xInlineRefuse(sender, cid);
    return;
  }
  await xInlineRun(sender.tab, sender, media, cid);
}

// "Save all (N)": the document proves the whole list first (count, owner, every item), then each item is proven AGAIN right before
// it is saved, so a post that is removed, recycled or navigated away during the batch never redirects work to another post.
// Items run through the same pipeline as a single save with bounded concurrency; one failed or refused item never touches the
// others, and every refused item is reported as a failed operation.
async function handleXInlineSaveAll(message, sender) {
  const cid = dbgCidOf(message);
  if (!xInlineSenderOk(message, sender)) { dbg('x.inline', 'batch', 'refused', 'SENDER_REJECTED', null, { cid, tab: sender && sender.tab && sender.tab.id }); return; }
  const tab = sender.tab;
  const open = await xInlineAsk(tab, sender, { action: 'X_INLINE_BATCH', token: message.token });
  const count = open && open.ok === true && Number.isInteger(open.count) ? open.count : 0;
  dbg('x.inline', 'batch', count >= 2 && count <= X_INLINE_BATCH_MAX ? 'start' : 'refused', count >= 2 && count <= X_INLINE_BATCH_MAX ? undefined : (open && open.ok === false ? (dbgCode(open.reason) || 'REFUSED') : (open ? 'INVALID_DESCRIPTOR' : 'NO_ANSWER')), { count, postId: open && open.ownerId }, { cid, tab: tab.id, frame: sender.frameId });
  if (count < 2 || count > X_INLINE_BATCH_MAX) {
    console.warn('[MediaLatch] Inline X Save all refused: the list of media was not proven');
    await xInlineRefuse(sender, cid);
    return;
  }
  const ownerId = typeof open.ownerId === 'string' && /^\d{1,25}$/.test(open.ownerId) ? open.ownerId : '';
  const sig = typeof open.sig === 'string' && /^[a-f0-9]{8}$/.test(open.sig) ? open.sig : '';
  const batchKey = `${tab.id}:${sender.frameId}:all:${ownerId}:${sig}`;
  if (xInlineBusy.has(batchKey)) { dbg('x.inline', 'batch', 'skipped', 'BUSY', null, { cid, tab: tab.id }); return; }
  xInlineBusy.add(batchKey);
  const tally = { started: 0, refused: 0, duplicate: 0 };
  let next = 0;
  let lost = false;
  const worker = async () => {
    while (!lost) {
      const index = next++;
      if (index >= count) return;
      const answer = await xInlineAsk(tab, sender, { action: 'X_INLINE_OWNER_ITEM', token: message.token, index });
      const media = answer && answer.ok === true ? sanitizeXInlineMedia(answer.media) : null;
      if (!media) {
        tally.refused++;
        // an item that changed on its own is skipped; an owner that is gone, replaced, navigated or unknown ends the batch
        if (!answer || answer.ok !== false || answer.reason !== 'STALE_ITEM') lost = true;
        dbg('x.inline', 'item', 'refused', (answer && answer.ok === false ? (dbgCode(answer.reason) || 'REFUSED') : (answer ? 'INVALID_DESCRIPTOR' : 'NO_ANSWER')), { index, batch: !lost }, { cid, tab: tab.id });
        await xInlineRefuse(sender, cid);
        continue;
      }
      if (await xInlineRun(tab, sender, media, cid)) tally.started++;
      else tally.duplicate++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(X_INLINE_BATCH_CONCURRENCY, count) }, worker));
    for (let i = Math.min(next, count); i < count; i++) {
      tally.refused++;
      await xInlineRefuse(sender, cid);
    }
    console.info('[MediaLatch] Inline X Save all:', { items: count, ...tally });
    dbg('x.inline', 'batch', 'ok', undefined, { items: count, started: tally.started, refused: tally.refused, duplicate: tally.duplicate }, { cid, tab: tab.id });
  } finally {
    xInlineBusy.delete(batchKey);
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message) return;
    if (message.action === 'X_INLINE_SAVE') {
      handleXInlineSave(message, sender).catch((e) => console.warn('[MediaLatch] Inline X Save failed:', e?.message || e));
    } else if (message.action === 'X_INLINE_SAVE_ALL') {
      handleXInlineSaveAll(message, sender).catch((e) => console.warn('[MediaLatch] Inline X Save all failed:', e?.message || e));
    }
  });
}

// UX-11-RD: the inline Save control over Reddit media ("Save this", and "Save all (N)" for a proven complete gallery). Same shape as the
// X entry above, own message set (REDDIT_INLINE_*), own validation: the content script sends only a one-shot token; this handler
// validates the sender (the extension's own content script, a Reddit page, the active tab, a frame), asks the same frame and document
// to prove the owner again, re-validates the descriptor that comes back, and runs the existing save-image-item pipeline of
// onContextMenuClicked, so resolution, verification, native GIF, confirmed Reddit animation conversion, RedGIFs-as-video, folders,
// Folder routing, the download lifecycle and feedback are shared with the menu. The only thing the inline entry skips is the gesture-captured
// owner gate and the cursor query: the fresh proof replaces them, and a stale context-menu capture must never decide an inline click.
// Contract: docs/changes/2026-10-04-ux11-rd-backend.md.
const redditInlineInfos = new WeakSet();
const redgifsInlineInfos = new WeakSet();
const REDGIFS_INLINE_MAX_ACTIVE = 4;
// An inline embed save whose proven frame document no longer answers looks the frame up again at most this many times, after a short pause each
const REDGIFS_EMBED_RETRIES = 2;
let REDGIFS_EMBED_RETRY_MS = 250;
let redgifsInlineActive = 0;
const redditInlineBusy = new Set();
const REDDIT_INLINE_TOKEN = /^[a-f0-9]{32}$/;
const REDDIT_INLINE_OWNER_ID = /^t3_[a-z0-9]{1,12}$/;
// Save all: a complete owned gallery is 2..100 items; two items are in flight at once.
const REDDIT_INLINE_BATCH_MIN = 2;
const REDDIT_INLINE_BATCH_MAX = POST_MEDIA_MAX;
const REDDIT_INLINE_BATCH_CONCURRENCY = 2;

function isRedditPageUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === 'https:' && isRedditDomain(p.hostname);
  } catch (_) {
    return false;
  }
}

// The embed document address of a RedGIFs clip: https, the RedGIFs host itself (or www), exactly /ifr/<id>. Returns the lowercase clip id, else ''.
// `loose` ignores a query or fragment (the address of a live frame); the address a document hands over carries neither.
function redGifsEmbedClipOf(url, { loose = false } = {}) {
  try {
    const p = new URL(url);
    if (p.protocol !== 'https:' || p.username || p.password || p.port) return '';
    const host = p.hostname.toLowerCase();
    if (host !== 'redgifs.com' && host !== 'www.redgifs.com') return '';
    if (!loose && (p.search || p.hash)) return '';
    const m = p.pathname.match(/^\/ifr\/([A-Za-z0-9_-]{3,64})\/?$/);
    return m ? m[1].toLowerCase() : '';
  } catch (_) {
    return '';
  }
}

// The one frame of the tab that shows this clip's embed document and is a direct child of the proven (top) document: the post's embed is
// cross-origin, so the document cannot name its frame. The extension asks every frame only for its address and whether it sits directly
// under the top document. Exactly one match, with its document id, else null (none, ambiguous, nested deeper, a navigation in between).
async function redditInlineFindRedGifsFrame(tabId, sender, clip) {
  if (!clip || sender.frameId !== 0 || !chrome.scripting?.executeScript) return null;
  let results = null;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      // Only addresses are read; an unrelated loading feed frame must not delay this probe.
      injectImmediately: true,
      func: () => ({ href: location.href, child: window !== window.top && window.parent === window.top })
    });
  } catch (_) {
    return null;
  }
  const hits = (Array.isArray(results) ? results : []).filter((r) => r && Number.isInteger(r.frameId) && r.frameId > 0 &&
    r.result && r.result.child === true && typeof r.result.href === 'string' && redGifsEmbedClipOf(r.result.href, { loose: true }) === clip);
  if (hits.length !== 1) return null;
  const documentId = typeof hits[0].documentId === 'string' ? hits[0].documentId : '';
  return { frameId: hits[0].frameId, documentId };
}

// A direct media address on a Reddit media host, or a direct RedGIFs asset for a video. Never blob:, data:, a manifest or a page.
function redditInlineUrlOk(url, kind) {
  const v = validateRedditCandidateUrl(url);
  if (v.valid) {
    try {
      const p = new URL(url);
      const host = p.hostname.toLowerCase();
      if (host === 'redd.it' || host.endsWith('.redd.it')) return true;
      // the reddit.com media wrapper, only when the address it wraps is itself a Reddit media host
      if (p.pathname === '/media' && p.searchParams.has('url')) {
        const inner = new URL(p.searchParams.get('url'));
        return inner.protocol === 'https:' && (inner.hostname === 'redd.it' || inner.hostname.endsWith('.redd.it'));
      }
    } catch (_) {}
    return false;
  }
  return kind === 'video' && Boolean(validateRedGifsCandidateUrl(url).valid);
}

// What the document proved, reduced to the fields the pipeline may use. `expect` (batch items) binds the item to the batch the
// document opened: same owner, same count, the same structure signature, the asked index. Anything else in the answer is ignored.
function sanitizeRedditInlineMedia(raw, expect) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind;
  if (kind !== 'image' && kind !== 'video') return null;
  const url = typeof raw.url === 'string' && raw.url.length <= 2048 ? raw.url : '';
  // a RedGIFs embed (RD-10): the document proved the clip its post declares; the address is only the strict embed address of that clip
  // (never part of a batch) and the frame is found and proven again by the background
  const embedClip = raw.redgifsEmbed === true && kind === 'video' && !expect ? redGifsEmbedClipOf(url) : '';
  // an HLS-only post video (REDDIT-HLS-01): only the canonical master address of a video, only for a single save; manifests stay forbidden to the direct-file check
  const redditHls = raw.redditHls === true && kind === 'video' && !expect;
  if (!url || (raw.redgifsEmbed === true ? !embedClip : (redditHls ? !redditHlsMasterUrl(url) : !redditInlineUrlOk(url, kind)))) return null;
  const ownerId = typeof raw.ownerId === 'string' && REDDIT_INLINE_OWNER_ID.test(raw.ownerId) ? raw.ownerId : '';
  if (!ownerId) return null;
  let postUrl = null;
  if (raw.postUrl !== undefined && raw.postUrl !== null && raw.postUrl !== '') {
    const permalink = typeof raw.postUrl === 'string' && raw.postUrl.length <= 2048 && isRedditPageUrl(raw.postUrl) ? raw.postUrl : '';
    const m = permalink ? new URL(permalink).pathname.match(/\/comments\/([a-z0-9]{1,12})(?:\/|$)/i) : null;
    if (!m || `t3_${m[1].toLowerCase()}` !== ownerId) return null;
    postUrl = permalink;
  }
  let index = null;
  let count = null;
  let sig = null;
  if (expect) {
    index = Number.isInteger(raw.index) ? raw.index : -1;
    count = Number.isInteger(raw.count) ? raw.count : -1;
    sig = typeof raw.sig === 'string' && /^[a-f0-9]{8}$/.test(raw.sig) ? raw.sig : '';
    if (ownerId !== expect.ownerId || count !== expect.count || index !== expect.index || sig !== expect.sig) return null;
  }
  return { kind, url, ownerId, postUrl, blobPlayer: raw.blobPlayer === true, index, count, sig, redgifsEmbedClip: embedClip, redditHls };
}

// Why a proof was refused, for the log only: one of a fixed set of codes, never page data. The generic "owner not proven" wording hid whether the
// document refused (and why) or answered a descriptor the background rejected.
const REDDIT_INLINE_REASONS = new Set(['NO_TOKEN', 'USED', 'STALE_OWNER', 'STALE_LIST', 'STALE_ITEM', 'UNRESOLVED_BLOB', 'UNSUPPORTED_STREAM', 'NO_MEDIA']);
// The failure code a refused answer is recorded with: a positively identified stream that cannot be saved is an unsupported source, an ordinary blob stays unresolved
const redditInlineRefusalCode = (answer) => (answer && answer.ok === false
  ? (answer.reason === 'UNRESOLVED_BLOB' ? 'UNRESOLVED_BLOB_MEDIA' : (answer.reason === 'UNSUPPORTED_STREAM' ? 'UNSUPPORTED_SOURCE' : 'NO_MEDIA'))
  : 'NO_MEDIA');
function redditInlineWhy(answer) {
  if (!answer || typeof answer !== 'object') return 'NO_ANSWER';
  if (answer.ok === true) return 'INVALID_DESCRIPTOR';
  return REDDIT_INLINE_REASONS.has(answer.reason) ? answer.reason : 'REFUSED';
}

// The extension's own content script, a Reddit page, the active tab, a well-formed one-shot token. Nothing else in the message is read.
function redditInlineSenderOk(message, sender) {
  return isContentScriptSender(sender) && isRedditPageUrl(sender.url) && sender.tab.active === true &&
    typeof message.token === 'string' && REDDIT_INLINE_TOKEN.test(message.token);
}

// A refused owner or item is visible: a failed operation and an ERR badge, never silence and never a request.
async function redditInlineRefuse(sender, code = 'NO_MEDIA', cid) {
  const op = await fbBegin({ pageUrl: sender.url || '', sourceUrl: '', site: fbSiteOf(sender.url, ''), cid }, sender.tab);
  await fbFail(op, { stage: 'resolve', code });
  await fbBadgeReporter(op)('ERR', '#ef4444');
}

// One proven descriptor through the shared save-image-item pipeline, unless the same asset is already running.
async function redditInlineRun(tab, sender, media, cid) {
  const embed = media.redgifsEmbedClip || '';
  const key = `${tab.id}:${sender.frameId}:${embed ? `${media.ownerId}:` : ''}${media.url}`;
  if (redditInlineBusy.has(key)) { dbg('reddit.inline', 'run', 'skipped', 'BUSY', null, { cid, tab: tab.id }); return false; }
  redditInlineBusy.add(key);
  try {
    dbg('reddit.inline', 'run', 'start', undefined, () => ({ kind: media.kind, host: media.url, ownerId: media.ownerId, clipId: embed || undefined, hls: media.redditHls, blob: media.blobPlayer, index: media.index }), { cid, tab: tab.id, frame: sender.frameId });
    // `kind` is only the menu's mediaType hint: the shared pipeline recognises an animation (.gif with format=mp4), a direct video and a native .gif from the address itself
    const info = { menuItemId: 'save-image-item', srcUrl: media.url, pageUrl: sender.url, frameId: sender.frameId, mediaType: media.kind, redditInlineMedia: media, dbgCid: cid };
    if (embed) {
      // RD-10: the click runs in the frame of the proven clip, pinned to the document found now, through the same resolver as the context menu
      const frame = await redditInlineFindRedGifsFrame(tab.id, sender, embed);
      dbg('reddit.inline', 'frame', frame ? 'ok' : 'refused', frame ? undefined : 'NO_SINGLE_EMBED_FRAME', () => ({ clipId: embed, frame: frame ? frame.frameId : undefined }), { cid, tab: tab.id });
      if (!frame) {
        console.warn('[MediaLatch] Inline Reddit Save refused: no single frame shows the embedded RedGIFs clip');
        await redditInlineRefuse(sender, 'UNRESOLVED_BLOB_MEDIA', cid);
        return false;
      }
      info.frameId = frame.frameId;
      info.redditInlineRedGifs = { clipKey: embed, documentId: frame.documentId };
    }
    redditInlineInfos.add(info);
    await onContextMenuClicked(info, tab);
    return true;
  } finally {
    redditInlineBusy.delete(key);
  }
}

async function handleRedditInlineSave(message, sender) {
  const cid = dbgCidOf(message);
  if (!redditInlineSenderOk(message, sender)) { dbg('reddit.inline', 'save', 'refused', 'SENDER_REJECTED', null, { cid, tab: sender && sender.tab && sender.tab.id }); return; }
  dbg('reddit.inline', 'save', 'start', undefined, null, { cid, tab: sender.tab.id, frame: sender.frameId });
  const answer = await xInlineAsk(sender.tab, sender, { action: 'REDDIT_INLINE_OWNER', token: message.token });
  const media = answer && answer.ok === true ? sanitizeRedditInlineMedia(answer.media, null) : null;
  dbg('reddit.inline', 'owner', media ? 'ok' : 'refused', media ? undefined : dbgCode(redditInlineWhy(answer)), null, { cid, tab: sender.tab.id, frame: sender.frameId });
  if (!media) {
    console.warn('[MediaLatch] Inline Reddit Save refused:', redditInlineWhy(answer));
    await redditInlineRefuse(sender, redditInlineRefusalCode(answer), cid);
    return;
  }
  await redditInlineRun(sender.tab, sender, media, cid);
}

// "Save all (N)": the document proves the whole list first (count, owner, every item), then each item is proven AGAIN right before it
// runs, bound to the batch (same owner, same count, the same structure signature, the asked index). A post that is removed, recycled or navigated away during the
// batch never redirects work to another post. At most two items run at once; a failed or refused item never touches the others;
// every refused or unprocessed item is a failed operation, so nothing is silently dropped. A repeated asset is saved once.
async function handleRedditInlineSaveAll(message, sender) {
  const cid = dbgCidOf(message);
  if (!redditInlineSenderOk(message, sender)) { dbg('reddit.inline', 'batch', 'refused', 'SENDER_REJECTED', null, { cid, tab: sender && sender.tab && sender.tab.id }); return; }
  const tab = sender.tab;
  const open = await xInlineAsk(tab, sender, { action: 'REDDIT_INLINE_BATCH', token: message.token });
  const count = open && open.ok === true && Number.isInteger(open.count) ? open.count : 0;
  const ownerId = open && typeof open.ownerId === 'string' && REDDIT_INLINE_OWNER_ID.test(open.ownerId) ? open.ownerId : '';
  const sig = open && typeof open.sig === 'string' && /^[a-f0-9]{8}$/.test(open.sig) ? open.sig : '';
  const batchOk = !(count < REDDIT_INLINE_BATCH_MIN || count > REDDIT_INLINE_BATCH_MAX || !ownerId || !sig);
  dbg('reddit.inline', 'batch', batchOk ? 'start' : 'refused', batchOk ? undefined : dbgCode(redditInlineWhy(open)), { count, ownerId: ownerId || undefined }, { cid, tab: tab.id, frame: sender.frameId });
  if (count < REDDIT_INLINE_BATCH_MIN || count > REDDIT_INLINE_BATCH_MAX || !ownerId || !sig) {
    console.warn('[MediaLatch] Inline Reddit Save all refused:', redditInlineWhy(open));
    await redditInlineRefuse(sender, undefined, cid);
    return;
  }
  const batchKey = `${tab.id}:${sender.frameId}:all:${ownerId}:${sig}`;
  if (redditInlineBusy.has(batchKey)) { dbg('reddit.inline', 'batch', 'skipped', 'BUSY', null, { cid, tab: tab.id }); return; }
  redditInlineBusy.add(batchKey);
  const tally = { started: 0, refused: 0, duplicate: 0 };
  const seen = new Set();
  let next = 0;
  let lost = false;
  const worker = async () => {
    while (!lost) {
      const index = next++;
      if (index >= count) return;
      const answer = await xInlineAsk(tab, sender, { action: 'REDDIT_INLINE_OWNER_ITEM', token: message.token, index });
      const media = answer && answer.ok === true ? sanitizeRedditInlineMedia(answer.media, { ownerId, count, index, sig }) : null;
      if (!media) {
        tally.refused++;
        // an item that changed or cannot be resolved on its own is skipped; an owner that is gone, replaced, navigated or unknown
        // (or an answer that does not match the batch) ends the batch
        const itemLevel = answer && answer.ok === false && (answer.reason === 'STALE_ITEM' || answer.reason === 'UNRESOLVED_BLOB' || answer.reason === 'UNSUPPORTED_STREAM');
        if (!itemLevel) lost = true;
        console.warn('[MediaLatch] Inline Reddit Save all item refused:', index, redditInlineWhy(answer));
        dbg('reddit.inline', 'item', 'refused', dbgCode(redditInlineWhy(answer)), { index, batch: !lost }, { cid, tab: tab.id });
        await redditInlineRefuse(sender, redditInlineRefusalCode(answer), cid);
        continue;
      }
      if (seen.has(media.url)) { tally.duplicate++; dbg('reddit.inline', 'item', 'skipped', 'DUPLICATE_ASSET', { index }, { cid, tab: tab.id }); continue; }
      seen.add(media.url);
      if (await redditInlineRun(tab, sender, media, cid)) tally.started++;
      else tally.duplicate++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(REDDIT_INLINE_BATCH_CONCURRENCY, count) }, worker));
    for (let i = Math.min(next, count); i < count; i++) {
      tally.refused++;
      await redditInlineRefuse(sender, undefined, cid);
    }
    console.info('[MediaLatch] Inline Reddit Save all:', { items: count, ...tally });
    dbg('reddit.inline', 'batch', 'ok', undefined, { items: count, started: tally.started, refused: tally.refused, duplicate: tally.duplicate }, { cid, tab: tab.id });
  } finally {
    redditInlineBusy.delete(batchKey);
  }
}

// REDGIFS-INLINE-01: the inline Save control of the provider's own site. The content script sends only a one-shot token. The sender must be the
// extension's own content script in the TOP document of www.redgifs.com (never an embed or another site), the active tab, with a document id; the
// token travels back to that frame and document (RESOLVE_FRAME_MEDIA), which resolves the exact player it issued it for, so the context-menu capture
// is never read. The rest is the shared menu pipeline (resolution, verification, folders, download, feedback).
function redgifsInlineSenderOk(message, sender) {
  if (!isContentScriptSender(sender) || sender.tab.active !== true || sender.frameId !== 0) return false;
  if (typeof sender.documentId !== 'string' || !sender.documentId) return false;
  if (typeof message.token !== 'string' || !/^[a-f0-9]{32}$/.test(message.token)) return false;
  if (typeof message.player !== 'string' || !/^[a-f0-9]{16}$/.test(message.player)) return false;
  try {
    const u = new URL(sender.url);
    return u.protocol === 'https:' && u.hostname === 'www.redgifs.com' && !/^\/ifr\//i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

async function handleRedgifsInlineSave(message, sender) {
  const cid = dbgCidOf(message);
  if (!redgifsInlineSenderOk(message, sender)) { dbg('redgifs.inline', 'save', 'refused', 'SENDER_REJECTED', null, { cid, tab: sender && sender.tab && sender.tab.id }); return; }
  dbg('redgifs.inline', 'save', 'start', undefined, null, { cid, tab: sender.tab.id, frame: sender.frameId });
  // concurrent duplicates of one player: the shared pipeline's in-flight key (document and player key, see onContextMenuClicked) suppresses a second save
  const info = {
    menuItemId: 'save-image-item',
    pageUrl: sender.url,
    frameUrl: sender.url,
    frameId: sender.frameId,
    mediaType: 'video',
    redgifsInline: { token: message.token, documentId: sender.documentId, player: message.player },
    dbgCid: cid
  };
  // at most a few saves resolve at once; one more is a visible failure, never a silent drop
  if (redgifsInlineActive >= REDGIFS_INLINE_MAX_ACTIVE) {
    dbg('redgifs.inline', 'save', 'refused', 'RATE_LIMIT', { n: redgifsInlineActive }, { cid, tab: sender.tab.id });
    const op = await fbBegin({ pageUrl: sender.url || '', sourceUrl: '', site: fbSiteOf(sender.url, ''), cid }, sender.tab);
    await fbFail(op, { stage: 'resolve', code: 'RATE_LIMIT' });
    await fbBadgeReporter(op)('ERR', '#ef4444');
    return;
  }
  redgifsInlineActive++;
  try {
    redgifsInlineInfos.add(info);
    await onContextMenuClicked(info, sender.tab);
  } finally {
    redgifsInlineActive--;
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message) return;
    if (message.action === 'REDGIFS_INLINE_SAVE') {
      handleRedgifsInlineSave(message, sender).catch((e) => console.warn('[MediaLatch] Inline RedGIFs Save failed:', e?.message || e));
    } else if (message.action === 'REDDIT_INLINE_SAVE') {
      handleRedditInlineSave(message, sender).catch((e) => console.warn('[MediaLatch] Inline Reddit Save failed:', e?.message || e));
    } else if (message.action === 'REDDIT_INLINE_SAVE_ALL') {
      handleRedditInlineSaveAll(message, sender).catch((e) => console.warn('[MediaLatch] Inline Reddit Save all failed:', e?.message || e));
    }
  });
}

// Exports for tests
if (typeof globalThis !== 'undefined') {
  globalThis.verifyFinalMediaMime = verifyFinalMediaMime;
  globalThis.activeProtectedBlobsByDownloadId = activeProtectedBlobsByDownloadId;
  globalThis.earlyTerminalDownloadStates = earlyTerminalDownloadStates;
  globalThis.MIME_EVIDENCE = MIME_EVIDENCE;
  globalThis.acquireOffscreenTask = acquireOffscreenTask;
  globalThis.transferOffscreenTask = transferOffscreenTask;
  globalThis.releaseOffscreenTask = releaseOffscreenTask;
  globalThis.trackDownloadProtectedBlob = trackDownloadProtectedBlob;
  globalThis.untrackDownloadProtectedBlob = untrackDownloadProtectedBlob;
  globalThis.reconcileActiveOffscreenDownloads = reconcileActiveOffscreenDownloads;
  globalThis.hasActiveProtectedDownloads = hasActiveProtectedDownloads;
  globalThis.activeOffscreenOwners = offscreenState.activeOffscreenOwners;
  globalThis.executeMediaPlan = executeMediaPlan;
  globalThis.executeMediaDownload = executeMediaDownload;
  globalThis.sniffMediaMagicBytes = sniffMediaMagicBytes;
  globalThis.isAnimatedGif = isAnimatedGif;
  globalThis.resolveTweetVideoThumbUrl = resolveTweetVideoThumbUrl;
  globalThis.isXVideoPosterUrl = isXVideoPosterUrl;
  globalThis.resolveTweetVideoFromThumb = resolveTweetVideoFromThumb;
  globalThis.resolveTwitterVideoThumb = resolveTwitterVideoThumb;
  globalThis.resolveTwitterVideoThumbUrl = resolveTwitterVideoThumbUrl;
  globalThis.classifyMediaTarget = classifyMediaTarget;
  globalThis.isDanbooruDomain = isDanbooruDomain;
  globalThis.isValidDanbooruMetadata = isValidDanbooruMetadata;
  globalThis.extractMd5FromUrl = extractMd5FromUrl;
  globalThis.queryBooruDomMetadata = queryBooruDomMetadata;
  globalThis.getUrlHostname = getUrlHostname;
  globalThis.DANBOORU_DOM_ALLOWED_EXTS = DANBOORU_DOM_ALLOWED_EXTS;
  globalThis.isGelbooruDomain = isGelbooruDomain;
  globalThis.isE621Domain = isE621Domain;
  globalThis.isValidE621AssetUrl = isValidE621AssetUrl;
  globalThis.isSameOrSubdomain = isSameOrSubdomain;
  globalThis.buildFinalFilename = buildFinalFilename;
  globalThis.sanitizeUrlForLog = sanitizeUrlForLog;
  globalThis.verifyMp4ContainerBytes = verifyMp4ContainerBytes;
  globalThis.getCanonicalExtension = getCanonicalExtension;
  globalThis.resolveCanonicalExtension = resolveCanonicalExtension;
  globalThis.convertXTweetVideoToGifBlob = convertXTweetVideoToGifBlob;
  globalThis.executeXTweetVideoGifDownload = executeXTweetVideoGifDownload;
  globalThis.isRedditAnimationUrl = isRedditAnimationUrl;
  globalThis.convertRedditVideoToGifBlob = convertRedditVideoToGifBlob;
  globalThis.executeRedditGifDownload = executeRedditGifDownload;
  globalThis.lastDetectedRedditMediaByTab = lastDetectedRedditMediaByTab;
  globalThis.extractRedGifsIdFromUrl = extractRedGifsIdFromUrl;
  globalThis.isDirectVideoUrl = isDirectVideoUrl;
  globalThis.isDashManifestUrl = isDashManifestUrl;
  globalThis.validateRedditCandidateUrl = validateRedditCandidateUrl;
  globalThis.resolveRedditFrameBlobMedia = resolveRedditFrameBlobMedia;
  globalThis.mapMimeToPreferredExtension = (mime) => getCanonicalExtension(mime);
  globalThis.parseZerochanMediaUrl = parseZerochanMediaUrl;
  globalThis.createZerochanOriginalGroup = createZerochanOriginalGroup;
  globalThis.probeCandidate = probeCandidate;
  globalThis.sanitizePathSegment = sanitizePathSegment;
  globalThis.sanitizeRootSubfolder = sanitizeRootSubfolder;
  globalThis.determineOwningWebsite = determineOwningWebsite;
  globalThis.determineFinalMediaType = determineFinalMediaType;
  globalThis.resolveDownloadPath = resolveDownloadPath;
  globalThis.getFolderContextHost = getFolderContextHost;
  globalThis.getConfiguredRoot = getConfiguredRoot;
}
