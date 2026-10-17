// background.js - Service Worker for MediaLatch extension (v2.0.0)
// Universal modular architecture for downloading maximum resolution images across the web

// Worker modules, in dependency order. Each is a classic script whose declarations join this worker's global scope; no module reads a
// binding of this file while it loads, so they all load here, before any of the code below runs.
if (typeof importScripts === 'function') {
  importScripts('lib/folder_path.js');       // download-folder rules shared with the settings page
  importScripts('lib/sites.js');             // the supported sites: persistent ids, folder domains, the Booru view group
  importScripts('lib/i18n.js');              // English / Russian interface text (notifications follow the saved language)
  importScripts('lib/feedback.js');          // operation records, summaries and reports (pure)
  importScripts('worker/feedback_tracker.js');  // the operation tracker and notifier
  importScripts('worker/statistics.js');        // all-time statistics
  importScripts('worker/download_manager.js');  // the durable queued acquisition manager
  importScripts('lib/export_directory.js');  // the chosen-folder export store
  importScripts('lib/debug_journal.js');     // the opt-in debug journal
  importScripts('worker/media_format.js');      // MIME, signatures, extensions and media classification
  importScripts('worker/download_paths.js');    // file names, folder layout and authors
  importScripts('lib/media_sources.js');    // shared privileged URL admission
  importScripts('lib/media_guard.js');      // log redaction, the protected-host allowlist and the signature check, shared with the offscreen document
  importScripts('worker/candidates.js');        // candidate addresses, groups, scoring and the image probe
  importScripts('worker/site_resolvers.js');    // site resolvers (X, Pixiv, Reddit, Zerochan, Sankaku, Pawchive, ...)
  importScripts('worker/booru_resolvers.js');   // booru engine families
  importScripts('worker/page_selection.js');    // functions injected into the clicked frame: owner admission, context target, DOM metadata
  importScripts('worker/x_recovery.js');        // X selected-player recovery from the owning post
  importScripts('worker/providers.js');  // selected-media resolution and the original-media plan
  importScripts('worker/toolbar_badge.js');     // the serialized toolbar badge and theme icon
  importScripts('worker/pipeline.js');   // plan execution, verification and export
  importScripts('worker/offscreen.js');  // the offscreen document lifetime
  importScripts('worker/animation.js');  // GIF conversion policy and Reddit HLS assembly
}
const FolderPath = globalThis.ImageSaverFolderPath;
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
async function verifyFinalMediaMime(targetUrl, mediaPlan, isVideoContext, selectedPage = '') {
  const mime = await verifyFinalMediaMimeImpl(targetUrl, mediaPlan, isVideoContext, selectedPage);
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
// 1. Initialization: declarativeNetRequest rules, the context menu and its selected-target hint, lifecycle
// ============================================================================

let isDnrSetupInProgress = false;

// Referer/Cookie headers that four CDNs require. Only requests this extension makes are changed (the offscreen document's and the worker's
// own acquisition fetches; the extension origin is the initiator, its id the initiator domain): normal browsing, other extensions and
// lookalike hosts keep their own headers. requestDomains match the domain and its subdomains, never a longer foreign name.
const MANAGED_DNR_RULES = Object.freeze([
  [1001, ['pximg.net'], [['referer', 'https://www.pixiv.net/']]],
  [1002, ['oimages.anime-pictures.net'], [['referer', 'https://anime-pictures.net/'], ['cookie', 'kira=1']]],
  [1003, ['gelbooru.com'], [['referer', 'https://gelbooru.com/']]],
  // TikTok video CDN (TT-IG-VIDEO-01): answers 403 without this Referer (the browser's own cookies are sent by the credentialed fetch)
  [1004, ['tiktok.com'], [['referer', 'https://www.tiktok.com/']]]
].map(([id, requestDomains, headers]) => Object.freeze({
  id,
  priority: 1,
  action: { type: 'modifyHeaders', requestHeaders: headers.map(([header, value]) => ({ header, operation: 'set', value })) },
  condition: { requestDomains, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] }
})));
const MANAGED_DNR_RULE_IDS = Object.freeze(MANAGED_DNR_RULES.map((rule) => rule.id));

// The managed rules replace whatever an earlier version registered under the same ids (dynamic rules persist across updates).
// updateDynamicRules returns a promise in Manifest V3 (Chrome 91+); a refusal is logged and the next worker start tries again.
async function setupDeclarativeNetRequestRules() {
  if (isDnrSetupInProgress) return;
  isDnrSetupInProgress = true;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [...MANAGED_DNR_RULE_IDS], addRules: [...MANAGED_DNR_RULES] });
  } catch (err) {
    console.error('[MediaLatch] updateDynamicRules failed:', err?.message || err);
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

// The one origin of the Pixiv inline content script (manifest.json): https://www.pixiv.net, no credentials, no port.
function isPixivPageUrl(url) {
  try { const u = new URL(String(url || '')); return u.protocol === 'https:' && u.hostname === 'www.pixiv.net' && !u.username && !u.password && !u.port; } catch (_) { return false; }
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

// The common admission of an inline message: this extension's content script in the active tab, on the route's own page, with a well-formed
// one-shot token (nothing else in the message is read here). top: only the top frame. doc: a document id, so the proof is asked of exactly
// that document. Each route states its own options; the page checks stay per site.
function inlineSenderOk(message, sender, isPage, { top = false, doc = false } = {}) {
  return isContentScriptSender(sender) && sender.tab.active === true && isPage(sender.url) &&
    (!top || sender.frameId === 0) && (!doc || (typeof sender.documentId === 'string' && Boolean(sender.documentId))) &&
    typeof message?.token === 'string' && INLINE_TOKEN.test(message.token);
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
    } else if ((message?.action === 'REDDIT_MEDIA_CONTEXTMENU_DETECTED' || message?.action === 'REDGIFS_MEDIA_CONTEXTMENU_DETECTED') && sender?.tab?.id) {
      // A RedGIFs report must be a positively identified RedGIFs media target
      if (message.action === 'REDGIFS_MEDIA_CONTEXTMENU_DETECTED' && message.media?.sourceType !== 'redgifs') {
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
  if (details?.reason === 'install') openFirstRunGuide();
});

// FIRST-RUN-SETUP-01: only a fresh install opens the full page with the quick-start guide (?welcome=1 is read by
// ui/src/core/onboarding.js). Updates, startups and worker restarts never do; a failed tab open never blocks the extension.
function openFirstRunGuide() {
  const failed = () => dbg('lifecycle', 'guide', 'failed');
  try {
    const opened = chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?welcome=1') });
    if (opened && typeof opened.catch === 'function') opened.catch(failed);
  } catch (_) {
    failed();
  }
}

chrome.runtime.onStartup.addListener(() => {
  dbg('lifecycle', 'startup', 'info');
  setupDeclarativeNetRequestRules();
  setupContextMenus();
  reconcileActiveOffscreenDownloads();
});

// ============================================================================
// 2. Download tracking state and the toolbar badge
// ============================================================================

const trackedDownloadIds = new Set();
const inFlightRequests = new Set();
const activeProtectedBlobsByDownloadId = new Map();
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

void globalThis.MediaLatchToolbarBadge.installThemeIcon({
  action:chrome.action,storage:chrome.storage,
  log:()=>console.warn('[MediaLatch] Toolbar icon update failed')
});
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
                              isSameOrSubdomain(parsed.hostname, 'paheal-cdn.net') ||
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

// ============================================================================
// 3. Download feedback (UX-02 / UX-04): operation tracker, notifications, details messages
// ============================================================================
// Logic lives in lib/feedback.js (pure) and worker/feedback_tracker.js (injected Chrome APIs).
// Every hook below is best-effort: a feedback, storage or notification failure must never
// abort, duplicate or change a download.

var feedbackTracker = null;
const FEEDBACK_DETAILS_PAGE = 'popup/popup.html'; // full extension page (UX-05); #history opens the history section

function feedbackStorageArea() {
  return chrome.storage?.session || chrome.storage?.local || null;
}

async function feedbackNotifyRecord(record) {
  // an operation of a post batch is announced by its batch's one card, never by a card of its own (MANAGER-BATCH-NOTICES-01)
  if (await batchMemberOp(record && record.id)) {
    // Manager settlement can precede the feedback terminal event. Retry delivery when that record becomes available.
    const id = downloadManager.batchOf(record.id);
    if (id) batchNoticeChanged({id});
    return false;
  }
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

// All-time statistics are the only sink of finished operations. The pre-statistics history (imageSaverHistoryV1) is read once, as the
// seed of the counters (worker/statistics.js sanitizes each entry); it is never written or pruned here.
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
  // a post batch item names its slot (info.slot, set only by the Save all handlers); the binding is stored before the queue sees the job
  if (op && info && info.slot) await batchBind(info.slot, op);
  return op;
}
async function fbSetAuthor(op, author) {
  if (!op || !author) return;
  await fbStage(op, 'resolving', {author});
  try { await downloadManager?.setAuthor(op, author); } catch (_) {}
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
    batchChanged:summary=>batchNoticeChanged(summary),
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
      // Keep the previous terminal target before replacing this slot's operation, including after a worker restart.
      if(j.batch && old?.noticeTarget && FeedbackLib.isTerminal(old.state) && !batchNoticeDelivered.has(j.batch.id))batchNoticeRemember(j.batch.id,{record:old});
      const m = j.mime || j.expectedMime || '';
      return fbBegin({sourceUrl:j.source,site:fbAttemptSite(j,old),author:j.author || old?.author,expectedType:m.startsWith('video/')?'video':m==='image/gif'?'gif':'image'},old?.noticeTarget?{id:old.noticeTarget.tabId,url:old.noticeTarget.origin}:undefined);
    },
    recoverAttempt:async j=>{
      const old=await feedbackTracker?.get(j.op);
      const m = j.mime || j.expectedMime || '';
      return old && (!FeedbackLib.isTerminal(old.state) || old.state==='complete')?j.op:fbBegin({sourceUrl:j.source,site:fbAttemptSite(j,old),author:j.author || old?.author,expectedType:m.startsWith('video/')?'video':m==='image/gif'?'gif':'image'},old?.noticeTarget?{id:old.noticeTarget.tabId,url:old.noticeTarget.origin}:undefined);
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
async function managedDownload(options, feedbackOp=null, mime='', maxBytes=0, selectedPage='') {
  if (!options.url.startsWith('blob:') && !options.url.startsWith('data:') && !MediaLatchSources.allows(options.url, selectedPage)) throw Error('INVALID_SOURCE');
  // Offline legacy harnesses omit IndexedDB; the installed extension always uses the durable queue.
  const {saveDirectoryId=''}=await chrome.storage.local.get({saveDirectoryId:''});
  if(!downloadManager){if(saveDirectoryId)throw Error('DIRECTORY_ACCESS_REQUIRED');return chrome.downloads.download(options);}
  // Only the admitting origin is needed by delayed staging; do not persist its full page URL.
  let selectedOrigin='';try{selectedOrigin=new URL(selectedPage).origin;}catch(_){}
  const record=feedbackOp ? await feedbackTracker?.get(feedbackOp).catch(()=>null) : null;
  return downloadManager.enqueue(options,{op:feedbackOp,createdAt:record?.createdAt,mime,maxBytes,site:record?.site || fbSiteOf(selectedOrigin,''),author:record?.author,selectedPage:selectedOrigin,directoryId:saveDirectoryId});
}
// Post batches (MANAGER-BATCH-PROGRESS-01; model in worker/download_manager.js). Best effort: a batch that cannot be recorded never stops,
// delays or changes a save, and batch data never reaches a fetch decision.
async function batchOpen(site, count, partial = false) {
  try { const id = downloadManager ? await downloadManager.openBatch(site, count, partial) : null; return id ? { id } : null; } catch (_) { return null; }
}
const batchRef = (batch, i) => (batch ? { id: batch.id, i } : undefined);
// A refused binding write keeps its association in memory (the manager does it inside bindSlot; keepSlot repeats it if the call failed for another reason).
async function batchBind(ref, op) {
  try { await downloadManager?.bindSlot(ref, op); } catch (_) { try { await downloadManager.keepSlot(ref, op); } catch (_) {} }
}
// After a slot's item ended: a slot with a job is decided by the job (saved only when the browser or the chosen folder confirmed the
// file). Otherwise its operation tells: failed/interrupted -> failed, cancelled -> cancelled; no operation, or one that was discarded as
// a duplicate request (no record left), is `none` (skipped for an item, failed for a refusal). An operation still in progress stays open
// until its job or a restart settles it.
async function batchSettle(ref, none = 'skipped') {
  if (!ref || !downloadManager) return;
  try {
    const slot = downloadManager.slotInfo(ref);
    if (!slot || slot.job || !['pending', 'active'].includes(slot.state)) return;
    const rec = slot.op ? await feedbackTracker?.get(slot.op) : null;
    const state = !slot.op || !rec ? none : rec.state === 'complete' ? 'saved' : rec.state === 'cancelled' ? 'cancelled' : rec.state === 'failed' || rec.state === 'interrupted' ? 'failed' : null;
    if (state) await downloadManager.settleSlot(ref, state);
  } catch (_) {}
}
async function batchClose(batch) {
  try { if (batch) await downloadManager?.closeBatch(batch.id); } catch (_) {}
}
// MANAGER-BATCH-CANCEL-01: has "Cancel remaining" been accepted (committed) for the batch of this slot? It only ever STOPS work: the answer is never a reason
// to fetch, save or bind anything. The command itself is not wrapped here: a refused write reaches the manager page as an error.
async function batchStopped(ref) {
  try { return Boolean(ref && downloadManager && await downloadManager.stopped(ref)); } catch (_) { return false; }
}
// Page notice of a post batch (MANAGER-BATCH-NOTICES-01): ONE card per batch, whose text is the manager's canonical slot counts. The manager
// calls batchNoticeChanged after every saved change of a batch's counts (a confirmed save, a failure, a cancellation, a skipped duplicate, a
// restart reconciliation), so the notice follows the same state as the popup, never a timer, a page URL or a count of its own. Delivery
// reuses the one-card transport and its checks (the original tab and origin of a record of the batch); nothing is read from the page.
async function batchMemberOp(op) {
  try {
    if (!downloadManager || typeof op !== 'string') return false;
    await downloadManager.ready;
    return Boolean(downloadManager.isBatchOp?.(op));
  } catch (_) { return false; }
}
// One delivery at a time per batch: a newer count is read when the running one ends, so a card never goes back to an older count.
const batchNoticeRuns = new Map();
// Last delivered count/target also lets retry progress retire an error when no slot currently has a terminal operation.
const batchNoticeDelivered = new Map();
function batchNoticeRemember(id, value) {
  batchNoticeDelivered.set(id, value);
  if (batchNoticeDelivered.size > 100) batchNoticeDelivered.delete(batchNoticeDelivered.keys().next().value);
}
function batchNoticeChanged(summary) {
  if (!summary || typeof summary.id !== 'string') return;
  const run = batchNoticeRuns.get(summary.id);
  if (run) { run.again = true; return; }
  const state = { again: false };
  batchNoticeRuns.set(summary.id, state);
  (async () => {
    try { do { state.again = false; await batchNoticeDeliver(summary.id); } while (state.again); }
    catch (_) { /* a notice is best effort: the manager and the badge keep the result */ }
    finally { batchNoticeRuns.delete(summary.id); }
  })();
}
async function batchNoticeDeliver(id) {
  const batch = await downloadManager?.batchSummary(id);
  if (!batch || !feedbackTracker || typeof feedbackNotifier.batch !== 'function') return;
  const previous = batchNoticeDelivered.get(id);
  const key = [batch.saved, batch.failed, batch.cancelled, batch.skipped, batch.remaining, FeedbackLib.authorLabel(batch.site, batch.author)].join('/');
  if (previous?.key === key) return;
  const ops = new Set(batch.ops);
  // The newest finished member supplies the original tab/origin; a retry can retain the last delivered target.
  const record = (await feedbackTracker.list()).filter((r) => ops.has(r.id) && FeedbackLib.isTerminal(r.state) && r.noticeTarget).sort((a, b) => b.updatedAt - a.updatedAt)[0] || previous?.record;
  if (record && await feedbackNotifier.batch(batch, record)) {
    batchNoticeRemember(id, {key, record});
  }
}
// "Show in folder" of a Downloads card: the page names only its job; the browser's file is the numeric DownloadItem that THIS manager recorded for
// that job when the browser confirmed it (job.downloadId). chrome.downloads.show(id) needs only the existing "downloads" permission; it reveals
// that exact file (a renamed "photo (1).jpg" included) and returns nothing, so success here means "asked", not "a window opened".
// MediaLatch's own guards: a complete job, a native browser download (a chosen-folder export has a receipt, not a DownloadItem: no reveal),
// an item this extension created, still complete and not known to be removed (exists is refreshed by search() and can be stale).
async function revealManagedDownload(jobId) {
  const job = typeof jobId === 'string' ? (await downloadManager.list()).jobs.find((j) => j.id === jobId) : null;
  const id = job && job.state === 'complete' && Number.isSafeInteger(job.downloadId) && job.downloadId >= 0 ? job.downloadId : null;
  const item = id === null ? null : (await chrome.downloads.search({ id })).find((x) => x.id === id && x.byExtensionId === chrome.runtime.id);
  const why = !job ? 'JOB_NOT_FOUND' : job.state !== 'complete' ? 'JOB_NOT_COMPLETE' : id === null ? 'NOT_A_BROWSER_DOWNLOAD'
    : !item ? 'DOWNLOAD_NOT_IN_HISTORY' : item.state !== 'complete' ? 'DOWNLOAD_NOT_COMPLETE' : item.exists === false ? 'FILE_REMOVED' : '';
  dbg('manager', 'reveal', why ? 'refused' : 'ok', why || undefined, null);
  if (why) throw Error(why);
  chrome.downloads.show(item.id);
}

async function downloadManagerSnapshot() {
  const snapshot=await downloadManager.list();
  const owned=new Set(snapshot.jobs.map(j=>j.op));
  const records=await feedbackTracker.list();
  for(const j of snapshot.jobs){const r=records.find(r=>r.id===j.op);if(r && !j.site)j.site=r.site || '';}
  const preparations=records.filter(r=>!owned.has(r.id) && ['resolving','converting','failed','interrupted'].includes(r.state));
  for(const r of preparations){const batch=downloadManager.batchPosition?.(r.id);snapshot.jobs.push({id:r.id,op:r.id,managed:false,filename:r.filename || '',state:r.state==='interrupted'?'failed':r.state,received:0,total:null,speed:0,error:r.failure?.code || '',createdAt:r.createdAt,site:r.site || '',...(r.author ? {author:r.author} : {}),...(batch || {})});}
  if(downloadManager.pruneBatches)snapshot.batches=await downloadManager.pruneBatches(new Set(preparations.map(r=>r.id)));
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
      if(m.command==='showInFolder') { await revealManagedDownload(m.id); return {success:true}; }
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

// Retain the previous record owner, then the durable job owner, then its admitting origin; converted blobs have no origin.
// Never the media host, so statistics do not learn a site from a CDN.
function fbAttemptSite(job, old) {
  const site = old?.site && old.site !== 'unknown-site' ? old.site : job.site;
  return site && site !== 'unknown-site' ? site : (job.selectedPage ? fbSiteOf(job.selectedPage, '') : '');
}

/**
 * Handler-scoped replacement for flashBadge: forwards to the real badge and records the failure
 * of this operation (AUTH/RATE/ERR). 'OK' is never success: only a completed download is.
 */
function fbBadgeReporter(op) {
  return async (text, color, durationMs) => {
    if (op && (text === 'ERR' || text === 'AUTH' || text === 'RATE')) {
      await fbFail(op, { code: text === 'AUTH' ? 'AUTH_REQUIRED' : (text === 'RATE' ? 'RATE_LIMIT' : '') });
      // an operation the user cancelled (a late preparation of a cancelled batch) is not an error to flash
      if (text === 'ERR' && (await feedbackTracker?.get(op).catch(() => null))?.state === 'cancelled') return;
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
    group?.transport === 'pixiv' ||
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
    if (action !== 'FEEDBACK_LIST' && action !== 'FEEDBACK_MARK_SEEN' && action !== 'FEEDBACK_CLEAR') return false;
    const base = chrome.runtime.getURL('');
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
// 4. Download lifecycle: state monitoring via onChanged
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
  return Boolean(meta?.plan) && transport !== 'protectedBlob' && transport !== 'pixiv' && /^https?:\/\//i.test(meta.url || '');
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
// 5. Offscreen document (protected media, conversions, staging)
// ============================================================================

const offscreenController = globalThis.MediaLatchOffscreen.create({
  chrome, offscreenRequest: (...args) => offscreenRequest(...args), isFileExport, activeProtectedBlobsByDownloadId, earlyTerminalDownloadStates,
  addTrackedDownloadId: (...args) => addTrackedDownloadId(...args),
  isManagerBusy: () => Boolean(downloadManagerBusy || downloadManagerRecovering)
});
const offscreenState = offscreenController.state;
// The other worker modules (classic scripts sharing this global scope) call the offscreen lifetime by these global names.
for (const name of ['ensureOffscreenDocument', 'acquireOffscreenTask', 'transferOffscreenTask', 'hasActiveProtectedDownloads', 'closeOffscreenDocument', 'releaseOffscreenTask',
  'trackDownloadProtectedBlob', 'untrackDownloadProtectedBlob', 'lookupOwnedDownload', 'reconcileActiveOffscreenDownloads']) globalThis[name] = offscreenController[name];

reconcileActiveOffscreenDownloads();

// ============================================================================
// 6. Saves: the context-menu command (the one admission gate) and the inline Save controls (X, Reddit, RedGIFs)
// ============================================================================

let contextOwnerProofs = 0;
// Every inline click enters this one admission path with its info object tagged by the worker route that admitted it (set only by that route's
// own handler; a page message cannot set it). The routes whose own document proved the selected media right before the call skip the
// gesture-captured owner gate; X keeps its selected-player path.
const inlineRoutes = new WeakMap();
const viaInline = (info, ...routes) => routes.includes(inlineRoutes.get(info));
const OWN_PROOF_ROUTES = ['reddit', 'redgifs', 'pixiv', 'vk', 'tiktok'];
async function onContextMenuClicked(info, tab) {
  // DEBUG-MENU-01: one attempt id per save (an inline save brings the id of its click); journal only, never an authority
  if (!info.dbgCid) info.dbgCid = dbgNewCid();
  // an item of a batch whose cancellation was accepted never starts: no operation, no request (its slot was settled by the cancellation)
  if (info.batchSlot && await batchStopped(info.batchSlot)) { dbg('menu', 'click', 'skipped', 'BATCH_CANCELLED', null, { cid: info.dbgCid, tab: tab && tab.id }); return; }
  dbg('menu', 'click', 'start', undefined, () => ({
    menu: info.menuItemId, hasSrc: Boolean(info.srcUrl), hasLink: Boolean(info.linkUrl), srcHost: info.srcUrl, linkHost: info.linkUrl,
    pageHost: info.pageUrl || (tab && tab.url), frame: info.frameId, kind: info.mediaType,
    inline: inlineRoutes.has(info), batch: postMediaItemInfos.has(info)
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
    // the admitted gesture carries a proof token: the selected post's author is later read for this gesture only (selectedAuthorFolder)
    const ownerProof = `${Date.now()}-${++contextOwnerProofs}`;
    const ownerClaim = { src: rawImageUrl, link: claimsMediaLink ? rawLinkUrl : '', proof: ownerProof };
    // An inline Pixiv click (PIXIV-INLINE-01) was proven by its own document right before this call, bound to that document id.
    // An inline VK click (VK-INLINE-01) was proven by its own document right before this call (the one-shot token, the same frame and document).
    const owner = viaInline(info, ...OWN_PROOF_ROUTES) || postMediaItemInfos.has(info) ? 'proven' : await resolveContextOwner(tab?.id, info.frameId, ownerClaim);
    if (viaInline(info, 'pixiv')) ownerClaim.documentId = info.pixivInline.documentId;
    if (viaInline(info, 'tiktok')) ownerClaim.documentId = info.tiktokInline.documentId;
    if (owner === 'proven' && !viaInline(info, 'reddit')) Object.assign(info, { authorProof: ownerProof, authorDocumentId: ownerClaim.documentId || '' });
    dbg('menu', 'owner', owner === 'refused' || owner === 'preview' ? 'refused' : 'ok', owner === 'preview' ? 'SEEK_PREVIEW' : (owner === 'refused' ? 'STALE_OWNER' : undefined), { owner }, { cid: info.dbgCid, tab: tab && tab.id });
    if (owner === 'refused' || owner === 'preview') {
      console.warn(owner === 'preview'
        ? '[MediaLatch] The selected video is a seek preview, not the media of the post: save refused without requests'
        : '[MediaLatch] Владелец выбранной цели удалён, заменён или изменён после жеста — сохранение отклонено без запросов');
      const staleOp = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: '', site: fbSiteOf(info.pageUrl || tab?.url, ''), cid: info.dbgCid, slot: info.batchSlot }, tab);
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
    const inlineRedGifs = viaInline(info, 'redgifs') ? info.redgifsInline : null;
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
        // TikTok / Instagram (TT-IG-VIDEO-01): the top document of the site itself answers for its own player (worker/site_resolvers.js)
        const frameIsSocial = Boolean(socialVideoSiteOf(info.frameUrl) || (!info.frameUrl && !info.frameId && socialVideoSiteOf(info.pageUrl || tab?.url)));
        if ((frameIsRedGifs || frameIsSocial) && tab?.id) {
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
        const noMediaOp = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: '', site: fbSiteOf(info.pageUrl || tab?.url, ''), cid: info.dbgCid, slot: info.batchSlot }, tab);
        await fbFail(noMediaOp, { stage: 'resolve', code: 'NO_MEDIA' });
        await fbBadgeReporter(noMediaOp)('ERR', '#ef4444');
      }
      return;
    }

    // 2. Prevent duplicate in-flight resolution/download pipelines for the same normalized source media
    // an inline Save is keyed by the document and the very player it came from: another player's save is a request of its own, a repeat of the same player is a duplicate
    // a Pixiv inline Save this and Save all of the same artwork are requests of their own (a repeat of the same one is the duplicate)
    const dedupeKey = viaInline(info, 'pixiv') ? `pixiv-inline:${info.pixivInline.mode}:${tab.id}:${rawImageUrl}` : rawImageUrl || rawLinkUrl || (inlineRedGifs
      ? `gesture-player:${tab.id}:${info.frameId ?? 0}:${inlineRedGifs.documentId}:${inlineRedGifs.player}`
      : `gesture-player:${tab.id}:${info.frameId ?? 0}`);
    if (inFlightRequests.has(dedupeKey)) {
      console.warn('[MediaLatch] Запрос на сохранение данного медиа уже выполняется, игнорируем дубликат:', sanitizeUrlForLog(dedupeKey));
      dbg('menu', 'click', 'skipped', 'DUPLICATE_IN_FLIGHT', null, { cid: info.dbgCid, tab: tab && tab.id });
      return;
    }
    inFlightRequests.add(dedupeKey);
    activeResolvingCount++;

    const op = await fbBegin({ pageUrl: info.pageUrl || tab?.url || '', sourceUrl: rawImageUrl || rawLinkUrl, site: fbSiteOf(info.pageUrl || tab?.url, rawImageUrl || rawLinkUrl), cid: info.dbgCid, slot: info.batchSlot }, tab);
    const flashBadge = fbBadgeReporter(op);

    // Declared before the try so the catch block below can read it (it was try-scoped, which made the
    // catch itself throw a ReferenceError and skip the failure badge/feedback).
    let mediaPlan = null;
    let pixivPageClaim = '';
    try {
      await setBadge('...', '#9333ea');

      const settings = await chrome.storage.local.get({
        subfolder: 'SavedImages',
        folderOrganizationMode: 'single',
        ...Object.fromEntries(MediaLatchSites.AUTHOR_SERVICES.map(([id]) => [id + 'AuthorFolders', false]))
      });

      const author = await selectedMediaAuthor(info,tab,rawImageUrl);
      await fbSetAuthor(op, author);
      if (author?.site === 'x' && settings.xAuthorFolders === true) settings.xAuthor = author.id;
      if (author && author.site !== 'x' && settings[author.site+'AuthorFolders'] === true) settings.author = authorFolder(author.site, author.name, author.id);

      // An HLS-only post video proven by the selected Reddit player's document (inline): its frozen master address goes straight to the assembly
      if (viaInline(info, 'reddit') && info.redditInlineMedia && info.redditInlineMedia.redditHls === true) {
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
            pageUrl: info.frameUrl || info.pageUrl || tab?.url,
            linkUrl: rawLinkUrl,
            tabId: tab?.id,
            frameId: info.frameId,
            domMeta: viaInline(info, 'vk') ? {} : undefined,
            gesturePlayer,
            gestureDocumentId,
            gestureAt,
            ownerDocumentId: ownerClaim.documentId || '',
            socialInline: viaInline(info, 'tiktok') ? info.tiktokInline : undefined,
            inlineToken,
            redGifsEmbed: viaInline(info, 'reddit') && info.redditInlineRedGifs ? info.redditInlineRedGifs : undefined
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
            pageUrl: info.frameUrl || info.pageUrl || tab?.url,
            linkUrl: rawLinkUrl,
            tabId: tab?.id,
            frameId: info.frameId,
            allowPostMedia: true,
            // VK admission froze this selected source; later URL-based DOM lookup could select a recycled node.
            domMeta: viaInline(info, 'vk') ? {} : undefined,
            // the explicit inline scope of a proven Pixiv control; only this trusted route sets it
            pixivInline: viaInline(info, 'pixiv') ? { mode: info.pixivInline.mode, count: info.pixivInline.count } : undefined
          });
          targetMediaUrl = mediaPlan?.primaryUrl;
        }
      }

      // the inline mode decides the shape of the answer: Save this is one exact page, Save all the whole declared list; the other shape is a mismatch, never the other scope
      if(viaInline(info, 'pixiv') && !mediaPlan?.error && (info.pixivInline.mode==='all')!==Boolean(mediaPlan?.pixivPostMedia))mediaPlan={error:'POST_MEDIA_MISMATCH'};
      if(mediaPlan?.pixivPostMedia){
        // admitted at entry for this exact preview; resolvePixivPostMedia bound the artwork id to that proven source and validated the complete list.
        // The preview may scroll away or be recycled during /pages: only a replaced (documentId) or navigated admitting document cancels the batch.
        let current='';
        if(owner==='proven' && ownerClaim.documentId)try{current=(await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[ownerClaim.documentId]},injectImmediately:true,func:()=>location.href}))?.[0]?.result;}catch(_){}
        if(!current || current!==(info.frameUrl || info.pageUrl)){await fbFail(op,{stage:'resolve',code:'NO_MEDIA'});await flashBadge('ERR','#ef4444');return;}
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

      // PIXIV-INLINE-01: a single Pixiv page claims its exact original while it runs, in the set that the items of a batch key their address by. An overlapping Save this / Save all of
      // the same page is therefore saved once: the batch skips that page as a duplicate (its slot is settled skipped, never saved), the other pages are untouched, and the claim is
      // released below, so a later explicit save of the page works.
      if (mediaPlan?.transport === 'pixiv' && !postMediaItemInfos.has(info) && targetMediaUrl !== dedupeKey) {
        if (inFlightRequests.has(targetMediaUrl)) {
          dbg('menu', 'click', 'skipped', 'DUPLICATE_IN_FLIGHT', null, { cid: info.dbgCid, tab: tab && tab.id });
          await fbDiscard(op);
          return;
        }
        inFlightRequests.add(targetMediaUrl);
        pixivPageClaim = targetMediaUrl;
      }

      const isProtected = Boolean(getProtectedHostInfo(targetMediaUrl) || mediaPlan?.transport === 'protectedBlob' || mediaPlan?.transport === 'protected');

      // Verify the final media MIME via actual network probe/protected fetch
      const tProfilerMimeStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
      console.log(`[Chooser Profiler] 3. MIME check started (+${(tProfilerMimeStart - tProfilerStart).toFixed(1)}ms, target: ${sanitizeUrlForLog(targetMediaUrl)})`);
      const verifiedMime = await verifyFinalMediaMime(targetMediaUrl, mediaPlan, isVideo, info.frameUrl || info.pageUrl || tab?.url);
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
        // PIXIV-SAVING-POLISH-01: a Pixiv probe that got no answer (deadline/network) is a network failure, not invalid content
        await fbFail(op, { stage: 'verify', code: (mediaPlan?.transport === 'pixiv' && mediaPlan._probeNetworkError) || 'MIME_NOT_VERIFIED' });
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
        pageUrl: info.frameUrl || info.pageUrl || tab?.url || '',
        feedbackOp: op
      });
    } catch (downloadError) {
      if (mediaPlan?.verifiedBlob?.probeTaskKey) {
        await releaseOffscreenTask(mediaPlan.verifiedBlob.probeTaskKey, mediaPlan.verifiedBlob.blobUrl).catch(() => {});
        delete mediaPlan.verifiedBlob;
      }
      console.error('[MediaLatch] Критическая ошибка при сохранении:', downloadError);
      await fbFail(op, { code: downloadError?.message });
      if (downloadError?.message !== 'CANCELLED') await flashBadge('ERR', '#ef4444');
    } finally {
      activeResolvingCount--;
      inFlightRequests.delete(dedupeKey);
      if (pixivPageClaim) inFlightRequests.delete(pixivPageClaim);
      if (!toolbarBadge.flashing) {
        await restoreOrClearBadge();
      }
    }
  } else if (info.menuItemId === 'save-x-media-item') {
    if (!tab?.id) {
      console.warn('[MediaLatch] Клик по X media меню без активного tab.id');
      return;
    }

    const op = await fbBegin({ pageUrl: tab.url || info.pageUrl || '', sourceUrl: '', site: fbSiteOf(tab.url || info.pageUrl, ''), cid: info.dbgCid, slot: info.batchSlot }, tab);
    const flashBadge = fbBadgeReporter(op);

    try {
      let mediaResult = null;
      if (viaInline(info, 'x')) {
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
              files: ['lib/debug_journal.js', 'lib/i18n.js', 'content/content_copy_kit.js', 'content/content_x.js', 'content/content_inline.js'] // the journal client and the label catalogue first (DEBUG-MENU-01, UI-LOCALIZATION-01); the inline control after the site script it uses
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
        postId: mediaResult.tweetId || undefined, mediaId: mediaResult.mediaIdHint || undefined, index: mediaResult.mediaIndex, inline: viaInline(info, 'x')
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
      const authorId = xAuthorFromPost(mediaResult.authorPostUrl);
      await fbSetAuthor(op, authorId ? {site:'x',id:authorId,name:authorId} : null);
      if(settings.xAuthorFolders===true)settings.xAuthor=authorId;
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

// ---- inline saves (X, Reddit, Pixiv, VK; content/content_inline.js): what every route shares ----
// The content script sends only a one-shot token. A route validates the sender, asks the same frame and document to prove the owner again, re-validates what comes back and runs the
// existing onContextMenuClicked pipeline, so resolution, verification, folders, the download lifecycle and feedback are the menu's. The site rules (sender, sanitizing, the pipeline
// entry, how a batch is admitted) stay in each route below; the ask, the refusal, the reasons of an answer, one "Save this" and the "Save all" loop are common.
const INLINE_TOKEN = /^[a-f0-9]{32}$/;
const INLINE_BATCH_MIN = 2;
const INLINE_BATCH_MAX = POST_MEDIA_MAX; // Save all: at most this many items per post
const INLINE_BATCH_CONCURRENCY = 2; // and this many items in flight at once

// Only the sending frame and the sending document can answer.
async function inlineAsk(tab, sender, payload) {
  try {
    const options = { frameId: sender.frameId };
    if (typeof sender.documentId === 'string' && sender.documentId) options.documentId = sender.documentId;
    return await chrome.tabs.sendMessage(tab.id, payload, options);
  } catch (_) {
    return null;
  }
}

// A refused owner or item is visible: a failed operation and an ERR badge, never silence and never a request.
async function inlineRefuse(sender, cid, slot, code = 'NO_MEDIA') {
  if (slot && await batchStopped(slot)) return;
  const op = await fbBegin({ pageUrl: sender.url || '', sourceUrl: '', site: fbSiteOf(sender.url, ''), cid, slot }, sender.tab);
  await fbFail(op, { stage: 'resolve', code });
  await fbBadgeReporter(op)('ERR', '#ef4444');
  await batchSettle(slot, 'failed');
}

// Why a proof was refused, for the log only: one of a fixed set of codes, never page data (`known` limits the reasons a document may name).
function inlineWhy(answer, known) {
  if (!answer || typeof answer !== 'object') return 'NO_ANSWER';
  if (answer.ok !== false) return 'INVALID_DESCRIPTOR';
  return known ? (known.has(answer.reason) ? answer.reason : 'REFUSED') : (dbgCode(answer.reason) || 'REFUSED');
}

// One "Save this": the sender, the owner's proof, the sanitized descriptor, then the route's own entry into the pipeline. r: scope/phase (journal), senderOk, ask (the proof question),
// sanitize, why, warn (the console arguments of a refusal), run(tab, sender, media, cid), and optionally ownerDetail(media) and refusalCode(answer).
async function runInlineSingle(r, message, sender) {
  const cid = dbgCidOf(message);
  if (!r.senderOk(message, sender)) { dbg(r.scope, r.phase, 'refused', 'SENDER_REJECTED', null, { cid, tab: sender && sender.tab && sender.tab.id }); return; }
  const tab = sender.tab;
  dbg(r.scope, r.phase, 'start', undefined, null, { cid, tab: tab.id, frame: sender.frameId });
  const answer = await inlineAsk(tab, sender, r.ask);
  const media = answer && answer.ok === true ? r.sanitize(answer.media) : null;
  dbg(r.scope, 'owner', media ? 'ok' : 'refused', media ? undefined : dbgCode(r.why(answer)), media && r.ownerDetail ? r.ownerDetail(media) : null, { cid, tab: tab.id, frame: sender.frameId });
  if (!media) {
    console.warn(...r.warn(answer));
    await inlineRefuse(sender, cid, undefined, r.refusalCode ? r.refusalCode(answer) : undefined);
    return;
  }
  await r.run(tab, sender, media, cid);
}

// "Save all (N)": the document proved the whole list first (the route's admission); each item is then proven AGAIN right before it runs, so a post that is removed, recycled or navigated
// away during the batch never redirects work to another post. Items run through the same pipeline as a single save with bounded concurrency; one failed or refused item never touches
// the others, and every refused or unprocessed item is a failed operation, so nothing is silently dropped. b: scope, label, site (progress record), tab, sender, cid, count, key (one
// running batch per list), busy, item(index) (the item's proof question), sanitize(raw, index), itemReasons (refusals that skip only that item; any other ends the batch), why,
// run(tab, sender, media, cid, slot) and optionally code(answer) and dedupe(media) (a repeated asset is saved once).
async function runInlineBatch(b) {
  const { tab, sender, cid, count } = b;
  if (b.busy.has(b.key)) { dbg(b.scope, 'batch', 'skipped', 'BUSY', null, { cid, tab: tab.id }); return; }
  b.busy.add(b.key);
  const tally = { started: 0, refused: 0, duplicate: 0 };
  const seen = new Set();
  let batch = null; // the progress record of this list (one slot per proven item); null when it cannot be recorded
  let next = 0;
  let lost = false;
  const worker = async () => {
    while (!lost) {
      const index = next++;
      if (index >= count) return;
      const slot = batchRef(batch, index);
      if (await batchStopped(slot)) return;
      const answer = await inlineAsk(tab, sender, b.item(index));
      const media = answer && answer.ok === true ? b.sanitize(answer.media, index) : null;
      if (!media) {
        tally.refused++;
        // an item that changed or cannot be resolved on its own is skipped; an owner that is gone, replaced, navigated or unknown (or an answer that does not match the batch) ends the batch
        if (!(answer && answer.ok === false && b.itemReasons.has(answer.reason))) lost = true;
        console.warn(`[MediaLatch] Inline ${b.label} Save all item refused:`, index, b.why(answer));
        dbg(b.scope, 'item', 'refused', dbgCode(b.why(answer)), { index, batch: !lost }, { cid, tab: tab.id });
        await inlineRefuse(sender, cid, slot, b.code ? b.code(answer) : undefined);
        continue;
      }
      const dup = b.dedupe ? b.dedupe(media) : '';
      if (dup && seen.has(dup)) { tally.duplicate++; dbg(b.scope, 'item', 'skipped', 'DUPLICATE_ASSET', { index }, { cid, tab: tab.id }); await batchSettle(slot); continue; }
      if (dup) seen.add(dup);
      if (await b.run(tab, sender, media, cid, slot)) tally.started++;
      else tally.duplicate++;
      await batchSettle(slot);
    }
  };
  try {
    batch = await batchOpen(b.site, count);
    await Promise.all(Array.from({ length: Math.min(INLINE_BATCH_CONCURRENCY, count) }, worker));
    for (let i = Math.min(next, count); i < count; i++) {
      tally.refused++;
      await inlineRefuse(sender, cid, batchRef(batch, i), b.code ? b.code(null) : undefined);
    }
    console.info(`[MediaLatch] Inline ${b.label} Save all:`, { items: count, ...tally });
    dbg(b.scope, 'batch', 'ok', undefined, { items: count, started: tally.started, refused: tally.refused, duplicate: tally.duplicate }, { cid, tab: tab.id });
  } finally {
    await batchClose(batch);
    b.busy.delete(b.key);
  }
}

// UX-10: the inline Save control over X media ("Save this", and "Save all" for a post with several media). The content script sends only a one-shot token. This handler validates the sender
// (the extension's own content script, an X page, the active tab, a frame), asks the same frame and document to prove the owner
// again and to build the descriptor with the context-menu builder, re-validates what comes back, and then runs the existing
// save-x-media-item pipeline above, so both entries share resolution, verification, GIF semantics, folders, the download
// lifecycle and feedback. A removed, replaced, re-sourced, moved or recycled owner is refused before any provider request.
const xInlineBusy = new Set();

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
const xInlineSenderOk = (message, sender) => inlineSenderOk(message, sender, isXPageUrl);

// One proven descriptor through the shared save-x-media-item pipeline, unless the same item is already running.
async function xInlineRun(tab, sender, media, cid, slot) {
  const key = `${tab.id}:${sender.frameId}:${media.recoveredMp4Url || media.url || media.poster || ''}|${media.tweetId || ''}`;
  if (xInlineBusy.has(key)) { dbg('x.inline', 'run', 'skipped', 'BUSY', null, { cid, tab: tab.id, frame: sender.frameId }); return false; }
  xInlineBusy.add(key);
  try {
    dbg('x.inline', 'run', 'start', undefined, () => ({ type: media.type, blob: media.isBlobPlayer, hls: media.isHlsOnly, isQuote: media.isQuoteTweet, postId: media.tweetId || undefined, mediaId: media.mediaIdHint || undefined, index: media.mediaIndex }), { cid, tab: tab.id, frame: sender.frameId });
    const info = { menuItemId: 'save-x-media-item', pageUrl: sender.url, frameId: sender.frameId, xInlineMedia: media, dbgCid: cid, batchSlot: slot };
    inlineRoutes.set(info, 'x');
    await onContextMenuClicked(info, tab);
    return true;
  } finally {
    xInlineBusy.delete(key);
  }
}

function handleXInlineSave(message, sender) {
  return runInlineSingle({ scope: 'x.inline', phase: 'save', senderOk: xInlineSenderOk, ask: { action: 'X_INLINE_OWNER', token: message.token }, sanitize: sanitizeXInlineMedia, why: inlineWhy,
    warn: () => ['[MediaLatch] Inline X Save refused: the owner was not proven again'], run: xInlineRun }, message, sender);
}

// "Save all (N)": the document proves the whole list first (count, owner, every item), then each item is proven AGAIN right before
// it is saved, so a post that is removed, recycled or navigated away during the batch never redirects work to another post.
// Items run through the same pipeline as a single save with bounded concurrency; one failed or refused item never touches the
// others, and every refused item is reported as a failed operation.
async function handleXInlineSaveAll(message, sender) {
  const cid = dbgCidOf(message);
  if (!xInlineSenderOk(message, sender)) { dbg('x.inline', 'batch', 'refused', 'SENDER_REJECTED', null, { cid, tab: sender && sender.tab && sender.tab.id }); return; }
  const tab = sender.tab;
  const open = await inlineAsk(tab, sender, { action: 'X_INLINE_BATCH', token: message.token });
  const count = open && open.ok === true && Number.isInteger(open.count) ? open.count : 0;
  const listed = count >= INLINE_BATCH_MIN && count <= INLINE_BATCH_MAX;
  dbg('x.inline', 'batch', listed ? 'start' : 'refused', listed ? undefined : dbgCode(inlineWhy(open)), { count, postId: open && open.ownerId }, { cid, tab: tab.id, frame: sender.frameId });
  if (!listed) {
    console.warn('[MediaLatch] Inline X Save all refused: the list of media was not proven');
    await inlineRefuse(sender, cid);
    return;
  }
  const ownerId = typeof open.ownerId === 'string' && /^\d{1,25}$/.test(open.ownerId) ? open.ownerId : '';
  const sig = typeof open.sig === 'string' && /^[a-f0-9]{8}$/.test(open.sig) ? open.sig : '';
  await runInlineBatch({ scope: 'x.inline', label: 'X', site: 'x', tab, sender, cid, count, key: `${tab.id}:${sender.frameId}:all:${ownerId}:${sig}`, busy: xInlineBusy,
    item: (index) => ({ action: 'X_INLINE_OWNER_ITEM', token: message.token, index }), sanitize: sanitizeXInlineMedia, itemReasons: new Set(['STALE_ITEM']), why: inlineWhy, run: xInlineRun });
}

// PIXIV-INLINE-01: the inline Save controls over Pixiv artwork images, on feed/search/profile previews and on the opened artwork: "Save this" (exactly the selected page, a
// proven page index included) and, for an artwork whose page count the card or page shows, "Save all (N)" (the artwork's declared pages). Same shape as the X entry above, own
// message set (PIXIV_INLINE_*): the content script sends only a one-shot token. This handler validates the sender (the extension's own content script in the top frame of a
// www.pixiv.net page, the active tab), asks the same frame and document to prove the selected image again (its asset, its own card link or the opened page, and the action the
// token was minted for), re-validates every field that comes back, and runs the existing save-image-item pipeline with an explicit inline mode: the resolver (the artwork's declared
// list, exact signed URLs), batches, folders, pacing, notices, statistics and cancellation are the context menu's. The inline entry skips only the gesture-captured owner gate:
// the fresh proof replaces it, and a stale context-menu capture never decides an inline click.
const pixivInlineBusy = new Set();

const pixivInlineSenderOk = (message, sender) => inlineSenderOk(message, sender, isPixivPageUrl, { top: true });

// Only the fields this route needs, the asset checked again here; anything else in the answer is ignored.
function sanitizePixivInline(raw, mode) {
  if (!raw || typeof raw !== 'object' || raw.mode !== mode) return null;
  const text = (v) => (typeof v === 'string' && v.length <= 2048 ? v : '');
  let src;
  try { src = new URL(text(raw.src)); } catch (_) { return null; }
  if (src.protocol !== 'https:' || src.hostname !== 'i.pximg.net' || src.username || src.password || src.port) return null;
  const asset = src.pathname.match(/\/(\d{1,12})_p(\d{1,3})_(?:master|square|custom)\d+\.[a-z0-9]+$/i);
  if (!asset) return null;
  // the card link and the shown page count are decided by the resolver, which compares them with the artwork's own declared list before anything is requested
  return { mode, src: text(raw.src), link: text(raw.link), id: asset[1], index: Number(asset[2]), count: mode === 'all' ? raw.count : 0 };
}

async function pixivInlineRun(tab, sender, media, cid, mode) {
  const key = `${tab.id}:${sender.frameId}:${mode}:${media.id}:${mode === 'one' ? media.index : 'all'}`;
  if (pixivInlineBusy.has(key)) { dbg('pixiv.inline', mode, 'skipped', 'BUSY', null, { cid, tab: tab.id }); return; }
  pixivInlineBusy.add(key);
  try {
    const info = { menuItemId: 'save-image-item', srcUrl: media.src, linkUrl: media.link, pageUrl: sender.url, frameId: sender.frameId, mediaType: 'image', dbgCid: cid,
      pixivInline: { mode, count: media.count, documentId: typeof sender.documentId === 'string' ? sender.documentId : '' } };
    inlineRoutes.set(info, 'pixiv');
    await onContextMenuClicked(info, tab);
  } finally {
    pixivInlineBusy.delete(key);
  }
}

function handlePixivInlineSave(message, sender, mode) {
  return runInlineSingle({ scope: 'pixiv.inline', phase: mode, senderOk: pixivInlineSenderOk, ask: { action: 'PIXIV_INLINE_OWNER', token: message.token, mode }, sanitize: (raw) => sanitizePixivInline(raw, mode), why: inlineWhy,
    ownerDetail: (media) => ({ count: media.count || undefined }), warn: () => ['[MediaLatch] Inline Pixiv Save refused: the selected image was not proven again'],
    run: (tab, sn, media, cid) => pixivInlineRun(tab, sn, media, cid, mode) }, message, sender);
}

// VK-INLINE-01: the inline Save controls over VK photos, videos and clips ("Save this", and "Save all (N)" for a proven attachment list of a post). Same shape as the X and Reddit entries,
// own message set (VK_INLINE_*): the content script sends only a one-shot token. This handler validates the sender (the extension's own content script in the TOP frame of a vk.ru or
// vk.com page, the active tab), asks the same frame and document to prove the selection again, re-validates what comes back (an exact https address on the host family of its kind, the
// batch binding of an item) and runs the existing save-image-item pipeline of onContextMenuClicked, so resolution, verification, folders, batches, the download lifecycle and feedback are
// the context menu's. The inline entry skips only the gesture-captured owner gate: the fresh proof replaces it. The address travels exactly as the page declared it (query and signature
// included); nothing here rewrites it, and a page cannot make this route fetch a host outside the VK families.
const vkInlineBusy = new Set();
const VK_PHOTO_HOST = /(?:^|\.)(?:vkuserphoto\.ru|userapi\.com)$/;
const VK_VIDEO_HOST = /(?:^|\.)(?:vkvideo\.ru|userapi\.com|vkuser\.net|okcdn\.ru|mycdn\.me|cdn-vk\.ru|vk\.com|vk\.ru)$/; // the media hosts the page's own CSP names; a direct file only
const VK_VIDEO_FILE = /\.(?:mp4|webm|ogv|mov|m4v)$/i;
const VK_ATTACHMENT_ID = /^(?:photo|video|clip)-?\d{1,12}_\d{1,12}$/;
const VK_OWNER_ID = /^-?\d{1,12}_\d{1,12}$/;
const VK_INLINE_REASONS = new Set(['NO_TOKEN', 'USED', 'STALE_OWNER', 'STALE_ITEM', 'UNSUPPORTED_SOURCE']);

function isVkPageUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === 'https:' && !p.username && !p.password && !p.port && (p.hostname === 'vk.ru' || p.hostname === 'vk.com');
  } catch (_) {
    return false;
  }
}

const vkInlineSenderOk = (message, sender) => inlineSenderOk(message, sender, isVkPageUrl, { top: true, doc: true });

// What the document proved, reduced to the fields this route needs. `expect` (batch items) binds the item to the batch the document opened: same post, same count, the same structure
// signature, the asked index. Anything else in the answer is ignored.
function sanitizeVkInline(raw, expect) {
  if (!raw || typeof raw !== 'object' || !['photo', 'video', 'video-page'].includes(raw.kind)) return null;
  const url = typeof raw.url === 'string' && raw.url.length <= 4096 ? raw.url : '';
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const id = typeof raw.id === 'string' && VK_ATTACHMENT_ID.test(raw.id) ? raw.id : '';
  if (raw.kind === 'video-page') {
    if (!isVkPageUrl(url) || !id.startsWith('video') || u.pathname.replace(/\/$/, '') !== '/' + id) return null;
  } else if (raw.kind === 'photo' ? !VK_PHOTO_HOST.test(host) : !(VK_VIDEO_HOST.test(host) && VK_VIDEO_FILE.test(u.pathname))) return null;
  if (expect) {
    const ownerId = typeof raw.ownerId === 'string' && VK_OWNER_ID.test(raw.ownerId) ? raw.ownerId : '';
    const index = Number.isInteger(raw.index) ? raw.index : -1, count = Number.isInteger(raw.count) ? raw.count : -1, sig = typeof raw.sig === 'string' && /^[a-f0-9]{8}$/.test(raw.sig) ? raw.sig : '';
    if (!id || !ownerId || ownerId !== expect.ownerId || count !== expect.count || index !== expect.index || sig !== expect.sig) return null;
  }
  return { kind: raw.kind, url, id, author:FeedbackLib.safeAuthor('vk',raw.author) };
}

// The failure code a refused answer is recorded with: an attachment whose source the page does not declare as a direct file is an unsupported source, anything else no media
const vkInlineRefusalCode = (answer) => (answer && answer.ok === false && answer.reason === 'UNSUPPORTED_SOURCE' ? 'UNSUPPORTED_SOURCE' : 'NO_MEDIA');
const vkInlineWhy = (answer) => inlineWhy(answer, VK_INLINE_REASONS);

// A linked video poster proves an ID, not file bytes; the selected player's own progressive declaration must match that ID.
async function resolveVkInlineVideo(media) {
  const [oid, vid] = media.id.slice('video'.length).split('_');
  const endpoint = new URL('/al_video.php?act=show', media.url).href;
  const data = await fetchResolverMetadata(endpoint, {
    timeoutMs: 8000, method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams({ act: 'show', al: '1', autoplay: '0', video: `${oid}_${vid}` }).toString(),
  });
  if (!data) return { error: 'NETWORK_ERROR' };
  const view = data.payload?.[0] === 0 ? data.payload?.[1]?.[4] : null;
  const params = view?.player?.params;
  if (!Array.isArray(params) || !params.length) return { error: 'UNSUPPORTED_SOURCE' };
  if (params.length > 8 || String(view.mvData?.oid) !== oid || String(view.mvData?.vid) !== vid) return { error: 'NO_MEDIA' };
  const matching = params.filter(p => p && String(p.oid) === oid && String(p.vid) === vid);
  if (matching.length !== 1) return { error: 'NO_MEDIA' };
  const p = matching[0];
  if (view.mvData.is_live || p.is_live || p.live || p.drm || p.is_drm || p.drm_enabled) return { error: 'UNSUPPORTED_SOURCE' };
  const files = Object.entries(p).filter(([key, url]) => /^url(?:144|240|360|480|720|1080|1440|2160|4320)$/.test(key) && typeof url === 'string' && url.length > 0)
    .sort((a, b) => Number(b[0].slice(3)) - Number(a[0].slice(3)));
  const url = files[0]?.[1];
  try {
    const u = new URL(url);
    if (url.length > 4096 || u.protocol !== 'https:' || u.username || u.password || u.port || !VK_VIDEO_HOST.test(u.hostname) || /\.(?:m3u8|mpd)\/?$/i.test(u.pathname)) return { error: 'UNSUPPORTED_SOURCE' };
  } catch (_) { return { error: 'UNSUPPORTED_SOURCE' }; }
  return { url };
}

// One proven item through the shared save-image-item pipeline (a photo as an image, a direct file as a video), unless the same address is already running (a repeated or overlapping
// Save this / Save all saves it once; the batch slot of the repeat is settled as skipped).
async function vkInlineRun(tab, sender, media, cid, slot) {
  const key = `${tab.id}:${sender.frameId}:${media.url}`;
  if (vkInlineBusy.has(key)) { dbg('vk.inline', 'run', 'skipped', 'BUSY', null, { cid, tab: tab.id, frame: sender.frameId }); return false; }
  vkInlineBusy.add(key);
  let resolvedKey = null;
  try {
    if (slot && await batchStopped(slot)) return true;
    if (media.kind === 'video-page') {
      const source = await resolveVkInlineVideo(media);
      if (slot && await batchStopped(slot)) return true;
      if (!source.url) { await inlineRefuse(sender, cid, slot, source.error); return true; }
      const probe = await verifyMp4ContainerBytes(source.url, sender.url);
      if (slot && await batchStopped(slot)) return true;
      if (!probe.ok) {
        const code = probe.error === 'TIMEOUT' ? 'NETWORK_TIMEOUT' : (probe.error === 'NETWORK_ERROR' || probe.status ? 'NETWORK_ERROR' : 'INVALID_MEDIA');
        await inlineRefuse(sender, cid, slot, code); return true;
      }
      resolvedKey = `${tab.id}:${sender.frameId}:${source.url}`;
      if (vkInlineBusy.has(resolvedKey)) { resolvedKey = null; return false; }
      vkInlineBusy.add(resolvedKey);
      media = { ...media, kind: 'video', url: source.url };
    }
    dbg('vk.inline', 'run', 'start', undefined, () => ({ kind: media.kind, host: media.url }), { cid, tab: tab.id, frame: sender.frameId });
    const info = { menuItemId: 'save-image-item', srcUrl: media.url, pageUrl: sender.url, frameId: sender.frameId, mediaType: media.kind === 'video' ? 'video' : 'image', dbgCid: cid, batchSlot: slot, selectedAuthor:media.author };
    inlineRoutes.set(info, 'vk');
    await onContextMenuClicked(info, tab);
    return true;
  } finally {
    vkInlineBusy.delete(key);
    if (resolvedKey) vkInlineBusy.delete(resolvedKey);
  }
}

function handleVkInlineSave(message, sender) {
  return runInlineSingle({ scope: 'vk.inline', phase: 'save', senderOk: vkInlineSenderOk, ask: { action: 'VK_INLINE_OWNER', token: message.token }, sanitize: (raw) => sanitizeVkInline(raw, null), why: vkInlineWhy,
    ownerDetail: (media) => ({ kind: media.kind }), warn: () => ['[MediaLatch] Inline VK Save refused: the selected media was not proven again'], refusalCode: vkInlineRefusalCode,
    run: (tab, sn, media, cid) => vkInlineRun(tab, sn, media, cid) }, message, sender);
}

// "Save all (N)": the document proves the whole list first (count, post, every item), then each item is proven AGAIN right before it runs; an attachment without a declared direct file is a
// failed item of that list, never omitted and never saved as its poster.
async function handleVkInlineSaveAll(message, sender) {
  const cid = dbgCidOf(message);
  if (!vkInlineSenderOk(message, sender)) { dbg('vk.inline', 'batch', 'refused', 'SENDER_REJECTED', null, { cid, tab: sender && sender.tab && sender.tab.id }); return; }
  const tab = sender.tab;
  const open = await inlineAsk(tab, sender, { action: 'VK_INLINE_BATCH', token: message.token });
  const count = open && open.ok === true && Number.isInteger(open.count) ? open.count : 0;
  const ownerId = open && typeof open.ownerId === 'string' && VK_OWNER_ID.test(open.ownerId) ? open.ownerId : '';
  const sig = open && typeof open.sig === 'string' && /^[a-f0-9]{8}$/.test(open.sig) ? open.sig : '';
  const listed = count >= INLINE_BATCH_MIN && count <= INLINE_BATCH_MAX && Boolean(ownerId) && Boolean(sig);
  dbg('vk.inline', 'batch', listed ? 'start' : 'refused', listed ? undefined : dbgCode(vkInlineWhy(open)), { count }, { cid, tab: tab.id, frame: sender.frameId });
  if (!listed) {
    console.warn('[MediaLatch] Inline VK Save all refused: the list of media was not proven');
    await inlineRefuse(sender, cid);
    return;
  }
  await runInlineBatch({ scope: 'vk.inline', label: 'VK', site: 'vk', tab, sender, cid, count, key: `${tab.id}:${sender.frameId}:all:${ownerId}:${sig}`, busy: vkInlineBusy,
    item: (index) => ({ action: 'VK_INLINE_OWNER_ITEM', token: message.token, index }), sanitize: (raw, index) => sanitizeVkInline(raw, { ownerId, count, sig, index }), itemReasons: new Set(['STALE_ITEM', 'UNSUPPORTED_SOURCE']),
    why: vkInlineWhy, code: vkInlineRefusalCode, dedupe: (media) => media.url, run: vkInlineRun });
}

// UX-11-RD: the inline Save control over Reddit media ("Save this", and "Save all (N)" for a proven complete gallery). Same shape as the
// X entry above, own message set (REDDIT_INLINE_*), own validation: the content script sends only a one-shot token; this handler
// validates the sender (the extension's own content script, a Reddit page, the active tab, a frame), asks the same frame and document
// to prove the owner again, re-validates the descriptor that comes back, and runs the existing save-image-item pipeline of
// onContextMenuClicked, so resolution, verification, native GIF, confirmed Reddit animation conversion, RedGIFs-as-video, folders,
// Folder routing, the download lifecycle and feedback are shared with the menu. The only thing the inline entry skips is the gesture-captured
// owner gate and the cursor query: the fresh proof replaces them, and a stale context-menu capture must never decide an inline click.
// Contract: docs/changes/2026-10-04-ux11-rd-backend.md.
const REDGIFS_INLINE_MAX_ACTIVE = 4;
// An inline embed save whose proven frame document no longer answers looks the frame up again at most this many times, after a short pause each
const REDGIFS_EMBED_RETRIES = 2;
let REDGIFS_EMBED_RETRY_MS = 250;
let redgifsInlineActive = 0;
const redditInlineBusy = new Set();
const REDDIT_INLINE_OWNER_ID = /^t3_[a-z0-9]{1,12}$/;

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
  // the post's author, proven by the document with this descriptor (author folders); a username or nothing
  const author = typeof raw.author === 'string' && /^[A-Za-z0-9_-]{3,20}$/.test(raw.author) ? raw.author : '';
  return { kind, url, ownerId, postUrl, blobPlayer: raw.blobPlayer === true, index, count, sig, redgifsEmbedClip: embedClip, redditHls, author };
}

// Why a proof was refused, for the log only: one of a fixed set of codes, never page data. The generic "owner not proven" wording hid whether the
// document refused (and why) or answered a descriptor the background rejected.
const REDDIT_INLINE_REASONS = new Set(['NO_TOKEN', 'USED', 'STALE_OWNER', 'STALE_LIST', 'STALE_ITEM', 'UNRESOLVED_BLOB', 'UNSUPPORTED_STREAM', 'NO_MEDIA']);
// The failure code a refused answer is recorded with: a positively identified stream that cannot be saved is an unsupported source, an ordinary blob stays unresolved
const redditInlineRefusalCode = (answer) => (answer && answer.ok === false
  ? (answer.reason === 'UNRESOLVED_BLOB' ? 'UNRESOLVED_BLOB_MEDIA' : (answer.reason === 'UNSUPPORTED_STREAM' ? 'UNSUPPORTED_SOURCE' : 'NO_MEDIA'))
  : 'NO_MEDIA');
function redditInlineWhy(answer) {
  return inlineWhy(answer, REDDIT_INLINE_REASONS);
}

// The extension's own content script, a Reddit page, the active tab, a well-formed one-shot token. Nothing else in the message is read.
const redditInlineSenderOk = (message, sender) => inlineSenderOk(message, sender, isRedditPageUrl);

// One proven descriptor through the shared save-image-item pipeline, unless the same asset is already running.
async function redditInlineRun(tab, sender, media, cid, slot) {
  const embed = media.redgifsEmbedClip || '';
  const key = `${tab.id}:${sender.frameId}:${embed ? `${media.ownerId}:` : ''}${media.url}`;
  if (redditInlineBusy.has(key)) { dbg('reddit.inline', 'run', 'skipped', 'BUSY', null, { cid, tab: tab.id }); return false; }
  redditInlineBusy.add(key);
  try {
    dbg('reddit.inline', 'run', 'start', undefined, () => ({ kind: media.kind, host: media.url, ownerId: media.ownerId, clipId: embed || undefined, hls: media.redditHls, blob: media.blobPlayer, index: media.index }), { cid, tab: tab.id, frame: sender.frameId });
    // `kind` is only the menu's mediaType hint: the shared pipeline recognises an animation (.gif with format=mp4), a direct video and a native .gif from the address itself
    const info = { menuItemId: 'save-image-item', srcUrl: media.url, pageUrl: sender.url, frameId: sender.frameId, mediaType: media.kind, redditInlineMedia: media, dbgCid: cid, batchSlot: slot };
    if (embed) {
      // RD-10: the click runs in the frame of the proven clip, pinned to the document found now, through the same resolver as the context menu
      const frame = await redditInlineFindRedGifsFrame(tab.id, sender, embed);
      dbg('reddit.inline', 'frame', frame ? 'ok' : 'refused', frame ? undefined : 'NO_SINGLE_EMBED_FRAME', () => ({ clipId: embed, frame: frame ? frame.frameId : undefined }), { cid, tab: tab.id });
      if (!frame) {
        console.warn('[MediaLatch] Inline Reddit Save refused: no single frame shows the embedded RedGIFs clip');
        await inlineRefuse(sender, cid, slot, 'UNRESOLVED_BLOB_MEDIA');
        return false;
      }
      info.frameId = frame.frameId;
      info.redditInlineRedGifs = { clipKey: embed, documentId: frame.documentId };
    }
    inlineRoutes.set(info, 'reddit');
    await onContextMenuClicked(info, tab);
    return true;
  } finally {
    redditInlineBusy.delete(key);
  }
}

function handleRedditInlineSave(message, sender) {
  return runInlineSingle({ scope: 'reddit.inline', phase: 'save', senderOk: redditInlineSenderOk, ask: { action: 'REDDIT_INLINE_OWNER', token: message.token }, sanitize: (raw) => sanitizeRedditInlineMedia(raw, null),
    why: redditInlineWhy, refusalCode: redditInlineRefusalCode, warn: (answer) => ['[MediaLatch] Inline Reddit Save refused:', redditInlineWhy(answer)], run: redditInlineRun }, message, sender);
}

// "Save all (N)": the document proves the whole list first (count, owner, every item), then each item is proven AGAIN right before it
// runs, bound to the batch (same owner, same count, the same structure signature, the asked index). A post that is removed, recycled or navigated away during the
// batch never redirects work to another post. At most two items run at once; a failed or refused item never touches the others;
// every refused or unprocessed item is a failed operation, so nothing is silently dropped. A repeated asset is saved once.
async function handleRedditInlineSaveAll(message, sender) {
  const cid = dbgCidOf(message);
  if (!redditInlineSenderOk(message, sender)) { dbg('reddit.inline', 'batch', 'refused', 'SENDER_REJECTED', null, { cid, tab: sender && sender.tab && sender.tab.id }); return; }
  const tab = sender.tab;
  const open = await inlineAsk(tab, sender, { action: 'REDDIT_INLINE_BATCH', token: message.token });
  const count = open && open.ok === true && Number.isInteger(open.count) ? open.count : 0;
  const ownerId = open && typeof open.ownerId === 'string' && REDDIT_INLINE_OWNER_ID.test(open.ownerId) ? open.ownerId : '';
  const sig = open && typeof open.sig === 'string' && /^[a-f0-9]{8}$/.test(open.sig) ? open.sig : '';
  const batchOk = !(count < INLINE_BATCH_MIN || count > INLINE_BATCH_MAX || !ownerId || !sig);
  dbg('reddit.inline', 'batch', batchOk ? 'start' : 'refused', batchOk ? undefined : dbgCode(redditInlineWhy(open)), { count, ownerId: ownerId || undefined }, { cid, tab: tab.id, frame: sender.frameId });
  if (!batchOk) {
    console.warn('[MediaLatch] Inline Reddit Save all refused:', redditInlineWhy(open));
    await inlineRefuse(sender, cid);
    return;
  }
  await runInlineBatch({ scope: 'reddit.inline', label: 'Reddit', site: 'reddit', tab, sender, cid, count, key: `${tab.id}:${sender.frameId}:all:${ownerId}:${sig}`, busy: redditInlineBusy,
    item: (index) => ({ action: 'REDDIT_INLINE_OWNER_ITEM', token: message.token, index }), sanitize: (raw, index) => sanitizeRedditInlineMedia(raw, { ownerId, count, index, sig }),
    itemReasons: new Set(['STALE_ITEM', 'UNRESOLVED_BLOB', 'UNSUPPORTED_STREAM']), why: redditInlineWhy, code: redditInlineRefusalCode, dedupe: (media) => media.url, run: redditInlineRun });
}

// REDGIFS-INLINE-01: the inline Save control of the provider's own site. The content script sends only a one-shot token. The sender must be the
// extension's own content script in the TOP document of www.redgifs.com (never an embed or another site), the active tab, with a document id; the
// token travels back to that frame and document (RESOLVE_FRAME_MEDIA), which resolves the exact player it issued it for, so the context-menu capture
// is never read. The rest is the shared menu pipeline (resolution, verification, folders, download, feedback).
// the provider's own watch pages (never its /ifr/ embed player), and the player key the click named
const isRedgifsWatchUrl = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'www.redgifs.com' && !/^\/ifr\//i.test(u.pathname); } catch (_) { return false; } };
const redgifsInlineSenderOk = (message, sender) => inlineSenderOk(message, sender, isRedgifsWatchUrl, { top: true, doc: true }) && typeof message.player === 'string' && /^[a-f0-9]{16}$/.test(message.player);

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
    const attribution=await inlineAsk(sender.tab,sender,{action:'REDGIFS_INLINE_AUTHOR',token:message.token});
    info.selectedAuthor=FeedbackLib.safeAuthor('redgifs',attribution?.author);
    inlineRoutes.set(info, 'redgifs');
    await onContextMenuClicked(info, sender.tab);
  } finally {
    redgifsInlineActive--;
  }
}

// TIKTOK-CONTROLS-01: the Download control in the selected TikTok video's own action rail (content/content_tiktok.js). Only a one-shot token and the
// item id arrive. The sender must be this extension's content script in the TOP document of www.tiktok.com (active tab, document id); that document
// proves its frozen player again (TIKTOK_INLINE_PROOF: the same item, the same stream). The save then enters the shared admission with that stream as
// its source; the resolver reads the player's own item in the same document (worker/site_resolvers.js), never the right-click capture.
const isTikTokPageUrl = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'www.tiktok.com' || u.hostname === 'tiktok.com'); } catch (_) { return false; } };
const tiktokInlineSenderOk = (message, sender) => inlineSenderOk(message, sender, isTikTokPageUrl, { top: true, doc: true }) && typeof message.item === 'string' && /^\d{5,30}$/.test(message.item);
const TIKTOK_INLINE_REASONS = new Set(['STALE_ITEM']);

function handleTiktokInlineSave(message, sender) {
  return runInlineSingle({
    scope: 'tiktok.inline', phase: 'save', senderOk: tiktokInlineSenderOk, ask: { action: 'TIKTOK_INLINE_PROOF', token: message.token },
    // the item the message named and the proven player's own stream (a blob of this very page); anything else in the answer is ignored
    sanitize: (raw) => { try { return raw && raw.item === message.item && typeof raw.stream === 'string' && raw.stream.length <= 200 && raw.stream.startsWith('blob:' + new URL(sender.url).origin + '/') ? { item: raw.item, stream: raw.stream } : null; } catch (_) { return null; } },
    why: (answer) => inlineWhy(answer, TIKTOK_INLINE_REASONS),
    warn: (answer) => ['[MediaLatch] Inline TikTok save refused:', inlineWhy(answer, TIKTOK_INLINE_REASONS)],
    run: async (tab, sender, media, cid) => {
      const info = { menuItemId: 'save-image-item', pageUrl: sender.url, frameUrl: sender.url, frameId: sender.frameId, mediaType: 'video', srcUrl: media.stream, tiktokInline: { documentId: sender.documentId, item: media.item }, dbgCid: cid };
      inlineRoutes.set(info, 'tiktok');
      await onContextMenuClicked(info, tab);
    }
  }, message, sender);
}

// One router for the inline actions of the content script (content/content_inline.js): the route, and the label its failure is logged with.
const INLINE_ROUTES = {
  X_INLINE_SAVE: ['Inline X Save', handleXInlineSave],
  X_INLINE_SAVE_ALL: ['Inline X Save all', handleXInlineSaveAll],
  PIXIV_INLINE_SAVE: ['Inline Pixiv Save', (m, s) => handlePixivInlineSave(m, s, 'one')],
  PIXIV_INLINE_SAVE_ALL: ['Inline Pixiv Save', (m, s) => handlePixivInlineSave(m, s, 'all')],
  VK_INLINE_SAVE: ['Inline VK Save', handleVkInlineSave],
  VK_INLINE_SAVE_ALL: ['Inline VK Save all', handleVkInlineSaveAll],
  REDDIT_INLINE_SAVE: ['Inline Reddit Save', handleRedditInlineSave],
  REDDIT_INLINE_SAVE_ALL: ['Inline Reddit Save all', handleRedditInlineSaveAll],
  REDGIFS_INLINE_SAVE: ['Inline RedGIFs Save', handleRedgifsInlineSave],
  TIKTOK_INLINE_SAVE: ['Inline TikTok Save', handleTiktokInlineSave]
};
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    const route = message && Object.hasOwn(INLINE_ROUTES, message.action) ? INLINE_ROUTES[message.action] : null;
    if (route) route[1](message, sender).catch((e) => console.warn(`[MediaLatch] ${route[0]} failed:`, e?.message || e));
  });
}

// Lexical (const/let) state the vm-based tests read; top-level functions are already properties of the global object.
globalThis.activeProtectedBlobsByDownloadId = activeProtectedBlobsByDownloadId;
globalThis.earlyTerminalDownloadStates = earlyTerminalDownloadStates;
globalThis.MIME_EVIDENCE = MIME_EVIDENCE;
globalThis.activeOffscreenOwners = offscreenState.activeOffscreenOwners;
globalThis.DANBOORU_DOM_ALLOWED_EXTS = DANBOORU_DOM_ALLOWED_EXTS;
globalThis.lastDetectedRedditMediaByTab = lastDetectedRedditMediaByTab;
