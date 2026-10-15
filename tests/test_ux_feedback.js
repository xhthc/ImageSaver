// test_ux_feedback.js - focused regression tests for UX-02 / UX-04 (download feedback + bug reports).
// Runs the production background.js and lib/feedback*.js in vm sandboxes, and the page controllers of ui/src/core (the code
// behind popup/*.html) against the production background, with mocked Chrome APIs. The React rendering is covered by
// test_ui_render.js. Evidence boundary: Node mocks only - no Chromium, no real notifications or clipboard.
const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const idbDouble = require('./helpers/idb.cjs');
const ROOT = REPO_ROOT;
const read = (p) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');
const bgCode = read('background.js') + `
globalThis.__exports = { executeMediaDownload, executeMediaPlan, createCandidateGroup, adaptCandidateToGroup,
  earlyTerminalDownloadStates, getUnseenFailureCount, restoreOrClearBadge, fbBegin, fbStage, fbFail, fbAttach, fbCancel,
  executeXTweetVideoGifDownload, executeRedditGifDownload };`;

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log(`[PASS] ${name}`); } else { failed++; console.error(`[FAIL] ${name}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------------------------------
// Environment: production background.js + mocked Chrome
// ---------------------------------------------------------------------------------------------------
// realManager: the production download manager (IndexedDB double) instead of direct browser downloads. Offscreen staging answers
// through env.staging; the browser's own downloads stay in env.downloadsDb until a test finishes them (MANAGER-BATCH-PROGRESS-01).
function makeEnv({ session = {}, local = {}, downloadsDb = null, noNotifications = false, captureManager = false, realManager = false, indexedDB = idbDouble() } = {}) {
  const env = {
    uuid: 0,
    downloadCalls: [],
    searchCalls: [],
    notifications: [],
    notificationClears: [],
    shown: [],
    badge: { text: '' },
    nextId: 5000,
    downloadsDb: downloadsDb || new Map(),   // id -> chrome.downloads item
    failNextDownloads: 0,
    failNotificationCreate: false,
    failSessionSet: false,
    failLocalGet: false,
    convertResponse: { success: true, blobUrl: 'blob:chrome-extension://testid/00000000-aaaa-bbbb-cccc-1234567890ab', contentType: 'image/gif', size: 2048, frames: 15, duration: 1 },
    convertGate: null,
    downloadListeners: [],
    messageListeners: [],
    notificationClickListeners: [],
    tabsMsgHandler: null,
    tabUrls: new Map(),
    createdTabs: [],
    fetchImpl: null,
    session: { ...session },
    local: { ...local }
  };

  const area = (store, flags) => ({
    get: async (keys) => {
      if (flags.get && flags.get()) throw new Error('STORAGE_GET_FAILED');
      if (typeof keys === 'string') return { [keys]: store()[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store()[k]]));
      if (keys && typeof keys === 'object') return Object.fromEntries(Object.keys(keys).map((k) => [k, store()[k] !== undefined ? store()[k] : keys[k]]));
      return { ...store() };
    },
    set: async (items) => {
      if (flags.set && flags.set()) throw new Error('STORAGE_SET_FAILED');
      Object.assign(store(), JSON.parse(JSON.stringify(items)));
    },
    remove: async (keys) => { for (const k of [].concat(keys)) delete store()[k]; }
  });

  const chrome = {
    runtime: {
      id: 'testid',
      lastError: null,
      getURL: (p) => `chrome-extension://testid/${p}`,
      getManifest: () => ({ version: '2.0.0' }),
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (cb) => env.messageListeners.push(cb) },
      getContexts: async () => [],
      sendMessage: async (msg) => {
        if (msg && typeof msg.action === 'string' && msg.action.startsWith('STAGING_') && env.staging) return env.staging(msg);
        if (msg && (msg.action === 'CONVERT_X_TWEET_VIDEO_TO_GIF' || msg.action === 'CONVERT_REDDIT_VIDEO_TO_GIF')) {
          env.lastConvertMessage = msg;
          if (env.convertGate) await env.convertGate;
          return typeof env.convertResponse === 'function' ? env.convertResponse(msg) : env.convertResponse;
        }
        return null;
      }
    },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    action: {
      setBadgeText: async ({ text }) => { env.badge.text = text; },
      setBadgeBackgroundColor: async () => {}
    },
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
    contextMenus: {
      removeAll: (cb) => cb && cb(),
      create() {},
      update: (id, p, cb) => cb && cb(),
      refresh() {},
      onClicked: { addListener: (cb) => { env.contextMenuHandler = cb; } },
      onShown: { addListener() {} }
    },
    tabs: {
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      get: async (id) => {if(env.closedTab===id)throw Error('TAB_CLOSED');return { id, url: env.tabUrls.get(id) || 'https://example.com/gallery/1' };},
      sendMessage: async (tabId, msg, options) => {
        if (msg?.action === 'MEDIALATCH_NOTICE') {
          if (noNotifications || env.failNotificationCreate) throw Error('PAGE_UNAVAILABLE');
          env.notifications.push({ id: msg.notice.id, opts: msg.notice, tabId, options }); return { success: true };
        }
        return env.tabsMsgHandler ? env.tabsMsgHandler(tabId, msg) : null;
      },
      create: async (opts) => { env.createdTabs.push(opts); return { id: 1 }; }
    },
    scripting: { executeScript: async () => [{ result: null }] },
    downloads: {
      onChanged: { addListener: (cb) => env.downloadListeners.push(cb) },
      download: (options, cb) => {
        env.downloadCalls.push(options);
        if (env.failNextDownloads > 0) {
          env.failNextDownloads--;
          throw new Error('Download failed: NETWORK_FAILED');
        }
        const id = env.nextId++;
        if (!env.downloadsDb.has(id)) env.downloadsDb.set(id, { id, state: 'in_progress', fileSize: 0, totalBytes: 0, bytesReceived: 0, exists: true, byExtensionId: 'testid', url: options.url });
        if (typeof cb === 'function') cb(id);
        return Promise.resolve(id);
      },
      search: async (query) => {
        env.searchCalls.push(query);
        const item = query && env.downloadsDb.get(query.id);
        return item ? [JSON.parse(JSON.stringify(item))] : [];
      },
      show: (id) => env.shown.push(id)
    },
    // a Russian browser UI with no saved language: notifications use the Russian catalogue (UI-LOCALIZATION-01)
    i18n: { getUILanguage: () => 'ru' },
    storage: {
      session: area(() => env.session, { set: () => env.failSessionSet }),
      local: area(() => env.local, { get: () => env.failLocalGet, set: () => env.failLocalWrite })
    }
  };
  env.chrome = chrome;

  const sandbox = {
    chrome, indexedDB, structuredClone,
    console: { log() {}, warn() {}, error() {} },
    URL, URLSearchParams, setTimeout: realManager ? (fn, ms, ...a) => setTimeout(fn, Math.min(ms, 5), ...a) : setTimeout, clearTimeout, AbortController,
    ...(realManager ? { crypto: { randomUUID: () => `uuid-${++env.uuid}` } } : {}),
    fetch: async (url) => {
      if (env.fetchImpl) return env.fetchImpl(String(url));
      const u = String(url);
      return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? (/\.mp4|format=mp4/.test(u) ? 'video/mp4' : 'image/jpeg') : '1048576') } };
    },
    window: { location: { href: '', host: '', pathname: '/' }, addEventListener() {} },
    document: { elementsFromPoint: () => [], querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, createElement: () => ({ addEventListener() {}, removeAttribute() {}, load() {} }) }
  };
  // This suite isolates feedback/statistics from the separately tested disk acquisition queue.
  sandbox.importScripts = (file) => {
    if(file !== 'lib/download_manager.js') vm.runInContext(read(file), sandbox);
    else if(realManager) vm.runInContext(read(file), sandbox);
    else if(captureManager) sandbox.MediaLatchDownloads={database:()=>({}),createManager:deps=>{env.managerDeps=deps;return {ready:Promise.resolve(),list:async()=>({jobs:[]})};}};
  };
  vm.createContext(sandbox);
  vm.runInContext(bgCode, sandbox);
  const originalClick=env.contextMenuHandler;
  env.contextMenuHandler=async(info,tab)=>{if(tab?.id)env.tabUrls.set(tab.id,tab.url);return originalClick(info,tab);};
  env.sandbox = sandbox;
  env.x = sandbox.__exports;
  const originalBegin=env.x.fbBegin;
  // Manually created legacy fixture operations explicitly represent a source-tab click.
  env.x.fbBegin=(info,tab)=>originalBegin(info,tab || {id:7,url:info.pageUrl});
  env.tracker = sandbox.feedbackTracker;

  env.emitDownload = async (delta) => { for (const l of env.downloadListeners) await l(delta); };
  env.finish = async (id, { state = 'complete', error = null, fileSize = 12345 } = {}) => {
    const item = env.downloadsDb.get(id);
    if (item) { item.state = state; item.fileSize = fileSize; item.error = error || undefined; }
    await env.emitDownload({ id, state: { current: state, previous: 'in_progress' }, ...(error ? { error: { current: error } } : {}) });
    await env.tracker.flush();
  };
  env.click = async (info, tab) => { const target=tab || { id: 7, url: info.pageUrl };env.tabUrls.set(target.id,target.url);await env.contextMenuHandler(info,target); await env.tracker.flush(); };
  env.records = async () => env.tracker.list();
  env.last = async () => (await env.tracker.list())[0];
  env.ready = async () => { await env.tracker.ready(); await env.tracker.flush(); };
  return env;
}

const imageClick = (n, page = 'https://example.com/gallery/1') => ({ menuItemId: 'save-image-item', srcUrl: `https://example.com/i/${n}.jpg`, pageUrl: page, mediaType: 'image' });
const settings = { subfolder: 'SavedImages', folderOrganizationMode: 'single' };

(async () => {
  const FBLib = (() => { const sb = { URL }; vm.createContext(sb); vm.runInContext(read('lib/feedback.js'), sb); return sb.ImageSaverFeedback; })();
  // the page controllers keep catalogue keys; the Russian text is what a Russian interface shows (UI-LOCALIZATION-01)
  const I18n = (() => { const sb = {}; vm.createContext(sb); vm.runInContext(read('lib/i18n.js'), sb); return sb.ImageSaverI18n; })();
  const ru = (m) => I18n.message('ru', m);
  const coreMod = (name) => import(pathToFileURL(path.resolve(ROOT, 'ui/src/core', name)).href);
  const { createFeedbackList } = await coreMod('feedbackList.js');
  const { createSettings } = await coreMod('settings.js');
  const present = await coreMod('present.js');

  // =================================================================================================
  console.log('\n--- 1. Pure helpers: redaction, classification, schema ---');
  {
    const t = FBLib.sanitizeText;
    const dirty = 'GET https://cdn.example.com/a.jpg?X-Amz-Signature=abc123&token=SECRET#frag failed at C:\\Users\\Ivan Petrov\\Pictures\\a.png and /home/ivan/.config/x Bearer abcdefghijklmnop cookie=sessionid=ZZZZ ' + 'A'.repeat(60) + '<script>alert(1)</script>';
    const clean = t(dirty, 400);
    assert(!/SECRET|abc123|frag|Ivan|Petrov|ivan|abcdefghijklmnop|ZZZZ|AAAAAAAAAA|https?:/.test(clean), '1a: sanitizeText removes URLs, signed params, fragments, local paths, tokens, cookies, opaque blobs');
    assert(t('x'.repeat(500), 50).length <= 50 && t('a\u202eb\u0000c\u2028d').indexOf('\u202e') === -1, '1b: sanitizeText bounds length and strips control/bidi characters');
    const p = FBLib.safeUrlParts('https://Video.TwImg.com:8443/ext/tweet_video/ABC.MP4?token=SECRET#frag');
    assert(p.host === 'video.twimg.com' && p.ext === '.mp4' && JSON.stringify(p).indexOf('SECRET') === -1 && JSON.stringify(p).indexOf('tweet_video') === -1, '1c: safeUrlParts keeps only host and extension');
    assert(FBLib.safeUrlParts('blob:chrome-extension://x/uuid').host === '' && FBLib.safeUrlParts('javascript:alert(1)').scheme === '' && FBLib.safeUrlParts('ftp://x.com/a.jpg').host === '', '1d: blob/javascript/ftp URLs retain no host');
    assert(FBLib.normalizeCode('NOT_FOUND') === 'NOT_FOUND' && FBLib.normalizeCode('Error: https://x.com/?token=1') === '' && FBLib.normalizeCode('<img src=x onerror=alert(1)>') === '' && FBLib.normalizeCode('HTTP 403 Forbidden') === '', '1e: normalizeCode accepts only machine-code-like tokens (no message text, no HTML)');
    assert(FBLib.normalizeStatus(403) === 403 && FBLib.normalizeStatus('403') === null && FBLib.normalizeStatus(99) === null && FBLib.normalizeStatus(NaN) === null, '1f: normalizeStatus accepts only real numeric HTTP statuses');
    const c = FBLib.classifyFailure;
    assert(c({ status: 404 }) === 'not_found' && c({ code: 'NOT_FOUND' }) === 'not_found' && c({ status: 410 }) === 'not_found', '1g: classify: confirmed absence');
    assert(c({ status: 403 }) === 'auth' && c({ code: 'AUTH_REQUIRED' }) === 'auth' && c({ downloadError: 'SERVER_FORBIDDEN' }) === 'auth', '1h: classify: auth/access');
    assert(c({ status: 429 }) === 'rate_limited' && c({ code: 'RATE_LIMIT' }) === 'rate_limited', '1i: classify: rate limit');
    assert(c({ downloadError: 'NETWORK_FAILED' }) === 'network' && c({ code: 'NETWORK_TIMEOUT' }) === 'network', '1j: classify: network/timeout');
    assert(c({ code: 'NON_IMAGE' }) === 'invalid_content' && c({ code: 'MIME_NOT_VERIFIED' }) === 'invalid_content', '1k: classify: invalid content/MIME');
    assert(c({ stage: 'convert', code: 'X' }) === 'conversion_failed' && c({ stage: 'download', downloadError: 'FILE_NO_SPACE' }) === 'download_interrupted', '1l: classify: conversion failure and download interruption');
    assert(c({ stage: 'verify' }) === 'unknown' && c({ code: 'AMBIGUOUS_OWNER' }) === 'ambiguous_ownership', '1m: classify: unknown stays unknown; ambiguous ownership recognized');
    assert(c({ stage: 'verify', code: 'FAILED with HTTP 503' }) === 'unknown', '1n: no HTTP status is invented from message text');
    const hostile = FBLib.sanitizeRecord({ id: 'op-abcdef', createdAt: 5, state: 'complete', site: '<b>x</b>', sourceHost: 'evil.com/path?token=1', output: { type: 'gif', ext: '.exe', evidence: 'verified_mime', mime: 'text/html', sizeBytes: -5 }, failure: { code: '<script>', status: 'abc', category: '__proto__' }, extra: { password: 'hunter2' } });
    assert(hostile.site === '' && hostile.sourceHost === '' && hostile.output.ext === '' && hostile.output.mime === '' && hostile.output.sizeBytes === null && hostile.failure.category === 'unknown' && hostile.failure.code === '' && hostile.failure.status === null && !('extra' in hostile), '1o: sanitizeRecord is an allowlist (hostile/unknown fields dropped)');
    assert(FBLib.sanitizeRecord({ id: '../../x', createdAt: 5 }) === null && FBLib.sanitizeRecord(null) === null, '1p: sanitizeRecord rejects malformed ids and non-objects');
  }

  // =================================================================================================
  console.log('\n--- 2. Real completion vs a returned download ID (production handler) ---');
  {
    const env = makeEnv();
    await env.ready();
    await env.click(imageClick('a1'));
    let r = await env.last();
    assert(env.downloadCalls.length === 1 && r.state === 'saving' && r.downloadId !== null, '2a: a returned download ID leaves the operation in "saving", not success');
    assert(env.notifications.length === 0, '2b: no notification before the download actually completes');
    await env.finish(r.downloadId);
    r = await env.last();
    assert(r.state === 'complete' && env.notifications.length === 1 && env.notifications[0].opts.kind === 'success' && env.notifications[0].options.frameId === 0, '2c: completion event -> complete + one own success notice in the source top frame');
    assert(r.output.sizeBytes === 12345 && r.output.sizeKind === 'measured', '2d: size is the measured size of the saved file (downloads.search fileSize)');
    assert(r.output.type === 'pic' && r.output.ext === '.jpg', '2e: output type/extension come from the actual saved filename');
    assert(r.output.evidence !== 'verified_mime' || r.output.mime === 'image/jpeg', '2f: a MIME is shown only with verified evidence');
    assert(/example\.com/.test(env.notifications[0].opts.title) && !/https?:|\?/.test(env.notifications[0].opts.title + env.notifications[0].opts.message), '2g: notification names the site and contains no URL');
    await env.finish(r.downloadId);
    await env.emitDownload({ id: r.downloadId, state: { current: 'complete' } });
    await env.tracker.flush();
    assert(env.notifications.length === 1 && (await env.records()).length === 1, '2h: repeated terminal events are idempotent (one notification, one record)');
    await env.emitDownload({ id: r.downloadId, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
    await env.tracker.flush();
    r = await env.last();
    assert(r.state === 'complete' && env.notifications.length === 1, '2i: a stale conflicting terminal event does not rewrite a finished operation');
    assert(env.searchCalls.every((q) => Object.keys(q).length === 1 && Number.isInteger(q.id)), '2j: downloads.search is only ever called for extension-owned download IDs');
  }

  // =================================================================================================
  console.log('\n--- 3. Pre-download failures (production handler) ---');
  {
    const env = makeEnv();
    await env.ready();
    env.fetchImpl = async () => ({ ok: false, status: 429, headers: { get: () => '' } });
    await env.click(imageClick('rl1'));
    let r = await env.last();
    assert(env.downloadCalls.length === 0 && ['failed'].includes(r.state), '3a: HTTP 429 before download -> failed, no download');
    assert(r.failure.category === 'rate_limited', '3b: HTTP 429 observed before download -> rate_limited');
    assert(env.notifications.length === 1 && env.notifications[0].opts.kind === 'error', '3c: failure produces an own error notice');
    assert(r.failure.status === 429 && r.failure.stage === 'resolve', '3d: the observed numeric status 429 is recorded with its stage');

    const env2 = makeEnv();
    await env2.ready();
    env2.fetchImpl = async () => ({ ok: false, status: 403, headers: { get: () => '' } });
    await env2.click(imageClick('au1'));
    const r2 = await env2.last();
    assert(r2.state === 'failed' && r2.downloadId === null && env2.downloadCalls.length === 0 && r2.failure.category === 'auth' && r2.failure.status === 403, '3e: HTTP 403 before download -> failed/auth with the observed status and no download id');

    const env3 = makeEnv();
    await env3.ready();
    await env3.click({ menuItemId: 'save-image-item', srcUrl: 'blob:https://example.com/abc-123', pageUrl: 'https://example.com/p', mediaType: 'video' });
    const r3 = await env3.last();
    assert(r3 && r3.state === 'failed' && r3.failure.category === 'unresolved' && r3.failure.status === null, '3f: unresolved blob -> "unresolved", status not observed (never 404 from the internal default)');
    assert(r3.sourceHost === '' && JSON.stringify(r3).indexOf('abc-123') === -1, '3g: blob URL identity is not retained');
  }

  // =================================================================================================
  console.log('\n--- 4. Conversion: states, failure, success (X and Reddit) ---');
  {
    const env = makeEnv();
    await env.ready();
    env.tabsMsgHandler = async (tabId, msg) => (msg.action === 'GET_X_MEDIA_AT_CURSOR' ? { type: 'x_tweet_video', url: 'https://video.twimg.com/tweet_video/CV1.mp4' } : null);
    let release;
    env.convertGate = new Promise((res) => { release = res; });
    const pending = env.contextMenuHandler({ menuItemId: 'save-x-media-item', pageUrl: 'https://x.com/u/status/1' }, { id: 8, url: 'https://x.com/u/status/1' });
    await tick(); await tick(); await tick();
    await env.tracker.flush();
    let r = await env.last();
    assert(r && r.state === 'converting' && r.conversion === 'x_tweet_video_gif', '4a: observable "converting" state during X animation conversion');
    release();
    await pending;
    await env.tracker.flush();
    r = await env.last();
    assert(r.state === 'saving' && r.output.type === 'gif' && r.output.evidence === 'converted_output' && r.output.frames === 15, '4b: a finished conversion is "saving", not success; frames measured by the encoder');
    assert(env.notifications.length === 0 && r.output.sizeKind === 'measured' && r.output.sizeBytes === 2048, '4c: conversion alone sends no notification; blob size is measured');
    await env.finish(r.downloadId, { fileSize: 2100 });
    r = await env.last();
    assert(r.state === 'complete' && r.output.sizeBytes === 2100 && env.notifications.length === 1, '4d: only the completed download is success; size updated to the saved file');
    assert(/GIF/.test(env.notifications[0].opts.message) && /MP4/.test(env.notifications[0].opts.message), '4e: notification states output type and conversion');
    assert(!env.session[env.tracker.STORAGE_KEY] || JSON.stringify(env.session[env.tracker.STORAGE_KEY]).indexOf('blob:') === -1, '4f: Blob URLs are never persisted in diagnostics');
    assert(env.lastConvertMessage && env.lastConvertMessage.pageUrl === undefined && env.lastConvertMessage.feedbackOp === undefined, '4g: feedback context is not sent to the offscreen document');

    const envF = makeEnv();
    await envF.ready();
    envF.tabsMsgHandler = env.tabsMsgHandler;
    envF.convertResponse = { success: false, error: 'GIF encoder exploded at https://x.com/?token=SECRET' };
    await envF.contextMenuHandler({ menuItemId: 'save-x-media-item', pageUrl: 'https://x.com/u/status/2' }, { id: 8, url: 'https://x.com/u/status/2' });
    await envF.tracker.flush();
    const rf = await envF.last();
    assert(rf.state === 'failed' && rf.failure.stage === 'convert' && rf.failure.category === 'conversion_failed' && envF.downloadCalls.length === 0, '4h: conversion failure -> failed at stage convert, no download');
    assert(rf.failure.code === '' && JSON.stringify(rf).indexOf('SECRET') === -1 && envF.notifications.length === 1, '4i: raw error text is not stored; failure is notified');

    const envR = makeEnv();
    await envR.ready();
    await envR.click({ menuItemId: 'save-image-item', srcUrl: 'https://preview.redd.it/anim9.gif?format=mp4&s=abcdef', pageUrl: 'https://www.reddit.com/r/gifs/comments/9/', mediaType: 'video' });
    const rr = await envR.last();
    assert(rr.conversion === 'reddit_animation_gif' && rr.state === 'saving' && rr.site === 'reddit', '4j: Reddit GIF-as-MP4 conversion tracked with its owning site');
    await envR.finish(rr.downloadId, { state: 'interrupted', error: 'NETWORK_FAILED' });
    const rr2 = await envR.last();
    assert(rr2.state === 'interrupted' && rr2.failure.category === 'network' && envR.notifications.length === 1, '4k: Reddit conversion followed by an interrupted download -> interrupted/network, notified');
  }

  // =================================================================================================
  console.log('\n--- 5. Interrupted and cancelled downloads ---');
  {
    const env = makeEnv();
    await env.ready();
    await env.click(imageClick('i1'));
    await env.click(imageClick('i2'));
    await env.click(imageClick('i3'));
    const recs = await env.records();
    const [c, b, a] = recs; // newest first: i3, i2, i1
    await env.finish(a.downloadId, { state: 'interrupted', error: 'SERVER_FORBIDDEN' });
    await env.finish(b.downloadId, { state: 'interrupted', error: 'USER_CANCELED' });
    await env.finish(c.downloadId, { state: 'interrupted', error: 'FILE_NO_SPACE' });
    const after = await env.records();
    const byId = Object.fromEntries(after.map((r) => [r.downloadId, r]));
    assert(byId[a.downloadId].state === 'interrupted' && byId[a.downloadId].failure.category === 'auth' && byId[a.downloadId].failure.downloadError === 'SERVER_FORBIDDEN', '5a: SERVER_FORBIDDEN -> interrupted/auth with the Chrome code');
    assert(byId[b.downloadId].state === 'cancelled' && byId[b.downloadId].failure.category === 'cancelled', '5b: USER_CANCELED -> cancelled');
    assert(byId[c.downloadId].state === 'interrupted' && byId[c.downloadId].failure.category === 'download_interrupted', '5c: other interruption -> download_interrupted');
    assert(env.notifications.length === 2, '5d: cancelled downloads are not notified; real failures are (2 of 3)');
    await env.x.restoreOrClearBadge();
    assert(env.badge.text === 'ERR', '5d2: routine restore preserves the readable error interval');
    await new Promise(r => setTimeout(r, 2600));
    await env.x.restoreOrClearBadge();
    assert((await env.sandbox.getUnseenFailureCount()) === 2 && env.badge.text === '!', '5e: unseen failures keep a persistent "!" badge even without notifications');
  }

  // =================================================================================================
  console.log('\n--- 6. Fallback after a recoverable primary failure ---');
  {
    const env = makeEnv();
    await env.ready();
    const op = await env.x.fbBegin({ pageUrl: 'https://example.com/g/1', sourceUrl: 'https://example.com/img/primary.gif', site: 'example.com' });
    const group = env.x.createCandidateGroup({
      id: 'fb_1', provider: 'generic', tier: 'unknown', source: 'initial_src',
      variants: [{ url: 'https://example.com/img/primary.gif', expectedExtension: '.gif' }], metadata: { contentType: 'image/gif', mediaType: 'gif' }
    });
    env.failNextDownloads = 1; // primary download call fails, emergency fallback succeeds
    const res = await env.x.executeMediaDownload({ targetImageUrl: 'https://example.com/img/primary.gif', rawImageUrl: 'https://example.com/img/fallback.png', settings, mediaPlan: group, pageUrl: 'https://example.com/g/1', feedbackOp: op });
    await env.tracker.flush();
    let r = await env.last();
    assert(res.success === true && r.state === 'saving' && r.fallback === true && env.notifications.length === 0, '6a: recoverable primary failure + successful fallback -> no final failure');
    assert(r.output.type === 'pic' && r.output.evidence === 'filename_hint' && r.output.mime === '' && r.output.sizeBytes === null, '6b: fallback is "unverified/filename hint" - no inherited primary GIF evidence, no MIME, no size');
    await env.finish(r.downloadId);
    r = await env.last();
    assert(r.state === 'complete' && env.notifications.length === 1 && /не оригинал/.test(FBLib.summarize(r).lines.join(' ')), '6c: fallback completion is reported as a non-original unverified file');

    const env2 = makeEnv();
    await env2.ready();
    const op2 = await env2.x.fbBegin({ pageUrl: 'https://example.com/g/1', sourceUrl: 'https://example.com/img/p.gif', site: 'example.com' });
    const group2 = env2.x.createCandidateGroup({ id: 'fb_2', provider: 'generic', tier: 'unknown', source: 'initial_src', variants: [{ url: 'https://example.com/img/p.gif', expectedExtension: '.gif' }], metadata: {} });
    env2.failNextDownloads = 2; // primary AND fallback calls fail
    let threw = false;
    try { await env2.x.executeMediaDownload({ targetImageUrl: 'https://example.com/img/p.gif', rawImageUrl: 'https://example.com/img/f.png', settings, mediaPlan: group2, pageUrl: 'https://example.com/g/1', feedbackOp: op2 }); } catch (_) { threw = true; }
    await env2.tracker.flush();
    const r2 = await env2.last();
    assert(threw && r2.state === 'failed' && r2.failure.stage === 'save' && env2.notifications.length === 1, '6d: when the fallback also fails, the operation fails once (stage save) and is notified once');
  }

  // =================================================================================================
  console.log('\n--- 7. Concurrency, early terminal events, unknown IDs ---');
  {
    const env = makeEnv();
    await env.ready();
    await Promise.all([env.click(imageClick('c1')), env.click(imageClick('c2')), env.click(imageClick('c3'))]);
    const recs = await env.records();
    assert(recs.length === 3 && new Set(recs.map((r) => r.id)).size === 3 && new Set(recs.map((r) => r.downloadId)).size === 3, '7a: concurrent operations get distinct correlation IDs and download IDs');
    const ids = recs.map((r) => r.downloadId).sort((x, y) => y - x);
    await env.finish(ids[0]);
    await env.finish(ids[2], { state: 'interrupted', error: 'NETWORK_FAILED' });
    await env.finish(ids[1]);
    const after = await env.records();
    const states = Object.fromEntries(after.map((r) => [r.downloadId, r.state]));
    assert(states[ids[0]] === 'complete' && states[ids[1]] === 'complete' && states[ids[2]] === 'interrupted', '7b: out-of-order terminal events settle the matching operations only');
    assert(env.notifications.length === 3, '7c: exactly one notification per finished operation');
    const before = (await env.records()).length;
    await env.emitDownload({ id: 99999, state: { current: 'complete' } });
    await env.emitDownload({ id: 424242, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
    await env.tracker.flush();
    assert((await env.records()).length === before && env.notifications.length === 3, '7d: terminal events for unrelated (non-extension) downloads are ignored');

    const envE = makeEnv();
    await envE.ready();
    const nextId = envE.nextId;
    envE.sandbox.earlyTerminalDownloadStates.set(nextId, { state: 'complete', errorCode: null, timestamp: Date.now() });
    envE.downloadsDb.set(nextId, { id: nextId, state: 'complete', fileSize: 777, exists: true });
    await envE.click(imageClick('e1'));
    const re = await envE.last();
    assert(re.state === 'complete' && re.output.sizeBytes === 777 && envE.notifications.length === 1, '7e: a terminal event that arrived before the download ID was registered completes the operation once');

    const envD = makeEnv();
    await envD.ready();
    envD.tabsMsgHandler = async () => ({ type: 'image', url: 'https://pbs.twimg.com/media/DUP?format=jpg&name=orig' });
    let hold;
    envD.fetchImpl = (u) => new Promise((res) => { hold = () => res({ ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : '100') } }); });
    const info = { menuItemId: 'save-x-media-item', pageUrl: 'https://x.com/u/status/3' };
    const p1 = envD.contextMenuHandler(info, { id: 8, url: info.pageUrl });
    await tick(); await tick(); await tick();
    await envD.contextMenuHandler(info, { id: 8, url: info.pageUrl });
    await envD.tracker.flush();
    assert((await envD.records()).length === 1, '7f: a duplicate in-flight request does not leave an orphan operation');
    hold && hold();
    await p1;
  }

  // =================================================================================================
  console.log('\n--- 8. Service-worker restart recovery and stale mappings ---');
  {
    const env = makeEnv();
    await env.ready();
    await env.click(imageClick('r1'));
    await env.click(imageClick('r2'));
    await env.click(imageClick('r3'));
    await env.click(imageClick('r4'));
    const [r4, r3, r2, r1] = await env.records();
    const orphan = await env.x.fbBegin({ pageUrl: 'https://example.com/p', sourceUrl: 'https://example.com/z.jpg', site: 'example.com' }); // never reached a download
    const gone = r4;
    // Chrome-side outcomes while the worker was dead:
    env.downloadsDb.get(r1.downloadId).state = 'complete'; env.downloadsDb.get(r1.downloadId).fileSize = 4321;
    env.downloadsDb.get(r2.downloadId).state = 'interrupted'; env.downloadsDb.get(r2.downloadId).error = 'SERVER_FORBIDDEN';
    // r3 still in progress; r4's download record vanished:
    env.downloadsDb.delete(gone.downloadId);
    const persisted = JSON.parse(JSON.stringify(env.session));
    const env2 = makeEnv({ session: persisted, downloadsDb: env.downloadsDb });
    await env2.ready();
    const rec = Object.fromEntries((await env2.records()).map((r) => [r.id, r]));
    assert(rec[r1.id].state === 'complete' && rec[r1.id].output.sizeBytes === 4321, '8a: restart reconciles a saving operation whose download completed (existing ID used)');
    assert(rec[r2.id].state === 'interrupted' && rec[r2.id].failure.category === 'auth', '8b: restart reconciles an interrupted download');
    assert(rec[r3.id].state === 'saving', '8c: an in-progress download stays "saving" until its event arrives');
    assert(rec[gone.id].state === 'failed' && rec[gone.id].failure.category === 'outcome_unknown', '8d: a missing download record is reported as unknown outcome, never as success');
    assert(rec[orphan].state === 'failed' && rec[orphan].failure.category === 'worker_restarted', '8e: an operation that never reached a download is reported as interrupted by the restart');
    assert(env2.downloadCalls.length === 0, '8f: recovery never re-downloads');
    await env2.finish(r3.downloadId);
    const after = Object.fromEntries((await env2.records()).map((r) => [r.id, r]));
    assert(after[r3.id].state === 'complete', '8g: a later event after restart completes the recovered mapping');
    const n = env2.notifications.length;
    const env3 = makeEnv({ session: JSON.parse(JSON.stringify(env2.session)), downloadsDb: env2.downloadsDb });
    await env3.ready();
    assert(env3.notifications.length === 0 && n >= 1, '8h: operations already notified are not notified again after another restart');
    const stale = (await env3.records()).find((r) => r.id === r1.id);
    await env3.emitDownload({ id: stale.downloadId, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
    await env3.tracker.flush();
    assert(((await env3.records()).find((r) => r.id === r1.id)).state === 'complete', '8i: a stale event for an already-terminal operation is ignored');
    const tampered = JSON.parse(JSON.stringify(env2.session));
    tampered[env.tracker.STORAGE_KEY].ops.push({ id: '../../evil', createdAt: 1 }, 'garbage', { id: 'op-zzzzzz', createdAt: 5, state: 'complete', output: { sizeBytes: 'big' }, password: 'x' });
    const env4 = makeEnv({ session: tampered, downloadsDb: env2.downloadsDb });
    await env4.ready();
    const list4 = await env4.records();
    assert(!list4.some((r) => r.id === '../../evil') && list4.every((r) => !('password' in r)), '8j: corrupted/tampered persisted records are sanitized or dropped');
  }

  // =================================================================================================
  console.log('\n--- 9. Storage, notification and clipboard failures never change the download ---');
  {
    const env = makeEnv();
    await env.ready();
    env.failNotificationCreate = true;
    await env.click(imageClick('n1'));
    let r = await env.last();
    await env.finish(r.downloadId);
    r = await env.last();
    assert(env.downloadCalls.length === 1 && r.state === 'complete', '9a: notification API errors do not affect the download or the record');

    const env2 = makeEnv({ noNotifications: true });
    await env2.ready();
    await env2.click(imageClick('n2'));
    const r2 = await env2.last();
    await env2.finish(r2.downloadId, { state: 'interrupted', error: 'NETWORK_FAILED' });
    assert((await env2.last()).state === 'interrupted' && (await env2.sandbox.getUnseenFailureCount()) === 1, '9b: without a notifications API the failure is still stored and flagged');

    const env3 = makeEnv();
    await env3.ready();
    env3.failSessionSet = true;
    await env3.click(imageClick('n3'));
    assert(env3.downloadCalls.length === 1 && (await env3.last()).state === 'saving', '9c: storage write failures do not abort or duplicate the download');

    const env4 = makeEnv({ local: { notifySuccess: false } });
    await env4.ready();
    await env4.click(imageClick('n4'));
    await env4.click(imageClick('n5'));
    const [b, a] = await env4.records();
    await env4.finish(a.downloadId);
    await env4.finish(b.downloadId, { state: 'interrupted', error: 'NETWORK_FAILED' });
    assert(env4.notifications.length === 1 && env4.notifications[0].opts.kind === 'error', '9d: success notices off suppress success while errors still notify');
    assert((await env4.records()).some((r) => r.state === 'complete'), '9e: the successful save is still listed');

    const env5 = makeEnv();
    await env5.ready();
    await env5.click(imageClick('n6'));
    const r5 = await env5.last();
    env5.failLocalGet = true; // the notifier cannot read the preference at completion time
    await env5.finish(r5.downloadId);
    assert((await env5.last()).state === 'complete' && env5.notifications.length === 1, '9f: a failing preference read keeps the documented default (success notification) and does not break feedback');

    const env7 = makeEnv();
    await env7.ready();
    env7.failLocalGet = true; // settings cannot be read by the handler itself
    await env7.click(imageClick('n7'));
    const r7 = await env7.last();
    assert(env7.downloadCalls.length === 0 && r7.state === 'failed' && r7.downloadId === null && env7.notifications.length === 1, '9h: an exception inside the production handler fails the operation visibly (no download, one notification)');

    const env6 = makeEnv();
    await env6.ready();
    const ids = [];
    for (let i = 0; i < 7; i++) { await env6.click(imageClick('b' + i)); }
    for (const rr of await env6.records()) await env6.finish(rr.downloadId);
    assert(env6.notifications.length === 7 && (await env6.records()).filter((r) => r.state === 'complete').length === 7, '9g: all seven successes reach the coalescing page renderer without undercounting');
    for (const closed of [false, true]) {
      const away = makeEnv(); await away.ready(); await away.click(imageClick('away'));
      const record = await away.last();
      if (closed) away.closedTab = record.noticeTarget.tabId;
      else away.tabUrls.set(record.noticeTarget.tabId, 'https://other.example/');
      await away.finish(record.downloadId, { state: 'interrupted', error: 'NETWORK_FAILED' });
      assert(away.notifications.length === 0 && (await away.last()).state === 'interrupted' && (await away.x.getUnseenFailureCount()) === 1, '9i: closed/navigated source never receives or redirects notices; failure and badge survive');
    }
    const retry = makeEnv({captureManager:true}); await retry.ready();
    const oldOp=await retry.x.fbBegin({pageUrl:'https://example.com/post',sourceUrl:'https://cdn.example.com/file.png'});
    await retry.x.fbFail(oldOp,{code:'NETWORK_FAILED'});await retry.tracker.flush();retry.notifications.length=0;
    for(const action of ['newAttempt','recoverAttempt']) {
      const op=await retry.managerDeps[action]({op:oldOp,source:'https://cdn.example.com/file.png',mime:'image/png'});
      const rec=await retry.tracker.get(op);
      assert(rec.noticeTarget?.tabId===7 && rec.noticeTarget.origin==='https://example.com','9j: production '+action+' retains original session route');
      await retry.x.fbFail(op,{code:'NETWORK_FAILED'});await retry.tracker.flush();
    }
    assert(retry.notifications.length===2 && retry.notifications.every(n=>n.tabId===7),'9k: retry/recovery outcomes notify original tab');
    const noRoute=await retry.managerDeps.newAttempt({op:'op-no-record',source:'https://cdn.example.com/file.png',mime:'image/png'});
    assert(!(await retry.tracker.get(noRoute)).noticeTarget,'9l: expired operation never guesses a replacement route');
    retry.tracker.get=async()=>{throw Error('FEEDBACK_UNAVAILABLE');};
    assert(await retry.managerDeps.newAttempt({op:oldOp,source:'https://cdn.example.com/file.png',mime:'image/png'}),'9m: unavailable notification route does not prevent an explicit retry');
  }

  // =================================================================================================
  console.log('\n--- 10. Privacy of persisted diagnostics, bounds and retention ---');
  {
    const env = makeEnv();
    await env.ready();
    const signed = 'https://cdn.example.com/private/user42/secret-name.jpg?X-Amz-Signature=SIGSECRET&token=TOKSECRET#fragSECRET';
    await env.click({ menuItemId: 'save-image-item', srcUrl: signed, pageUrl: 'https://example.com/u/user42/post/9?session=PAGESECRET', mediaType: 'image' });
    const r = await env.last();
    await env.finish(r.downloadId);
    const stored = JSON.stringify(env.session[env.tracker.STORAGE_KEY]);
    assert(!/SIGSECRET|TOKSECRET|fragSECRET|PAGESECRET|user42|private|X-Amz|\?|#/.test(stored), '10a: persisted state contains no paths, queries, fragments, signed parameters or tokens (only the saved basename, by design)');
    assert(!/blob:|data:/.test(stored), '10b: no Blob/data URLs in persisted diagnostics');
    assert(stored.length < 4000, '10c: persisted state stays small');
    assert(Object.keys(env.local).every((k) => k !== env.tracker.STORAGE_KEY), '10d: diagnostics live in session storage only (not persisted across browser restarts)');

    const FB = FBLib;
    let t = 1000;
    const store = {};
    const tr = vm.runInContext('globalThis', (() => { const s = { console }; vm.createContext(s); vm.runInContext(read('lib/feedback.js'), s); vm.runInContext(read('lib/feedback_tracker.js'), s); return s; })());
    const mk = (now) => tr.ImageSaverFeedbackTracker.createTracker({
      storage: { get: async (k) => store[k], set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
      now: () => now.v, genId: (() => { let n = 0; return () => 'op-' + (++n) + 'abcde'; })(),
      getDownloadItem: async () => null, peekEarlyTerminal: () => undefined, notify: async () => {}, log: () => {}
    });
    const clock = { v: Date.now() };
    const tracker = mk(clock);
    for (let i = 0; i < 30; i++) { const id = await tracker.begin({ pageUrl: 'https://example.com/', sourceUrl: 'https://example.com/a.jpg', site: 'example.com' }); await tracker.fail(id, { stage: 'resolve', code: 'NOT_FOUND' }); }
    assert((await tracker.list()).length === FB.LIMITS.maxOps, '10e: record count is bounded (oldest terminal evicted)');
    clock.v += FB.LIMITS.retentionMs + 1000;
    const id2 = await tracker.begin({ pageUrl: 'https://example.com/', sourceUrl: 'https://example.com/b.jpg', site: 'example.com' });
    const kept = await tracker.list();
    assert(kept.length === 1 && kept[0].id === id2, '10f: terminal records older than the retention window are evicted');
  }

  // =================================================================================================
  console.log('\n--- 11. Bug report: preview, bounds, redaction, malicious text ---');
  {
    const env = makeEnv();
    await env.ready();
    env.fetchImpl = async () => ({ ok: false, status: 403, headers: { get: () => '' } });
    await env.click(imageClick('rep1'));
    const rec = await env.last();
    const evil = '<img src=x onerror=alert(1)> https://evil.example/?token=NOTESECRET C:\\Users\\Ivan\\a.png ' + 'Z'.repeat(5000);
    const report = FBLib.buildReport(rec, { notes: evil, env: { version: '2.0.0', browser: 'Chromium 126' }, now: 1700000000000 });
    assert(report.length <= FBLib.LIMITS.report && report.startsWith('MediaLatch bug report'), '11a: report is bounded and starts with a title');
    assert(!/NOTESECRET|Ivan|ZZZZZZZZ|https?:\/\//.test(report), '11b: user notes are redacted (URLs, local paths, opaque strings) and bounded');
    assert(/correlation_id: op-/.test(report) && /extension_version: 2\.0\.0/.test(report) && /browser: Chromium 126/.test(report) && /timestamp: 2023-/.test(report), '11c: report has version, browser (when reliable), timestamp and correlation ID');
    assert(/http_status: (not observed|403)/.test(report) && /source_host: example\.com/.test(report) && !/example\.com\/i\//.test(report), '11d: status is observed-or-"not observed"; only the safe host is included');
    assert(/failing_stage: /.test(report) && /type_evidence: unknown/.test(report) && /expected_outcome: /.test(report) && /actual_outcome: /.test(report), '11e: report has stage, type evidence and expected/actual outcome');
    assert(!/browser:/.test(FBLib.buildReport(rec, { env: { version: '2.0.0' } })) && /extension_version: unknown/.test(FBLib.buildReport(rec, { env: { version: '<b>' } })), '11f: browser is omitted when unavailable; a malformed version is not echoed');
    const fakeHostile = Object.assign({}, rec, { site: '"><script>', failure: Object.assign({}, rec.failure, { code: '<script>alert(1)</script>' }), extra: 'x' });
    const rh = FBLib.buildReport(fakeHostile, {});
    assert(!/<script|alert\(1\)/.test(rh), '11g: report is generated from the allowlisted record only (hostile fields dropped)');
  }

  // =================================================================================================
  console.log('\n--- 12. UI boundary: the page controllers with the production background ---');
  {
    const env = makeEnv();
    await env.ready();
    env.fetchImpl = async () => ({ ok: false, status: 403, headers: { get: () => '' } });
    await env.click(imageClick('ui1'));
    env.fetchImpl = null;
    await env.click(imageClick('ui2'));
    const okRec = await env.last();
    await env.finish(okRec.downloadId);

    const clipboard = { texts: [], fail: false, writeText: async (t) => { if (clipboard.fail) throw new Error('DENIED'); clipboard.texts.push(t); } };
    const sentActions = [];
    const extSender = { id: 'testid', url: 'chrome-extension://testid/popup/popup.html' };
    const uiChrome = {
      runtime: {
        getManifest: () => ({ version: '2.0.0' }),
        getURL: (p) => `chrome-extension://testid/${p}`,
        sendMessage: (msg) => new Promise((resolve) => {
          sentActions.push(msg.action);
          let responded = false;
          for (const l of env.messageListeners) { const keep = l(msg, extSender, (resp) => { responded = true; resolve(resp); }); if (keep === true || responded) break; }
          if (!responded) setTimeout(() => resolve(undefined), 0);
        })
      },
      storage: { local: { get: async (d) => ({ ...d, ...env.local }), set: async (v) => { if (env.failLocalSet) throw new Error('QUOTA'); Object.assign(env.local, v); } } },
      tabs: { create: (o) => env.createdTabs.push(o) }
    };
    const navi = { clipboard, userAgentData: { brands: [{ brand: 'Not A Brand', version: '99' }, { brand: 'Chromium', version: '126' }] } };
    // The page behavior is the controller of ui/src/core; its React rendering (roles, clipboard UI, expansion) is covered by test_ui_render.js.
    const list = createFeedbackList({ chrome: uiChrome, FB: FBLib, navigator: navi }, { limit: 5, openFull: true });
    await list.start();
    const ls = list.store.getState();
    const rowsText = ls.records.map((r) => { const p = present.rowParts(FBLib, r); return p.name ? `${p.name} ${p.meta}` : p.legacy; }).join('\n');
    assert(ls.status === 'ready' && /Сохранено/.test(rowsText) && /Не удалось|Нужен доступ|Причина не определена/.test(rowsText), '12a: popup lists the recent results from the background tracker');
    const uiSrc = fs.readdirSync(path.resolve(ROOT, 'ui/src/components/app')).map((f) => read(`ui/src/components/app/${f}`)).join('\n') + read('ui/src/core/feedbackList.js');
    assert(!/dangerouslySetInnerHTML|innerHTML/.test(uiSrc), '12b: the UI renders through text nodes only (no HTML injection)');
    assert((await env.sandbox.getUnseenFailureCount()) === 0 && sentActions.includes('FEEDBACK_MARK_SEEN'), '12c: viewing the list acknowledges failures (badge cleared)');
    assert(env.badge.text !== '!', '12d: toolbar "!" badge is cleared after the failure was viewed');

    const failedRec = ls.records.find((r) => present.hasReport(r));
    const rep0 = present.buildReportText(FBLib, failedRec, '', { version: list.env.version, browser: list.env.browser });
    assert(rep0.startsWith('MediaLatch bug report') && /browser: Chromium 126/.test(rep0) && FBLib.LIMITS.notes === 500, '12e: details build a report (with browser only when reliable) and notes are bounded');
    const rep1 = present.buildReportText(FBLib, failedRec, 'save fails <b>bold</b> https://x.test/?token=NOTE123', { version: list.env.version, browser: list.env.browser });
    assert(/user_notes: save fails/.test(rep1) && !/NOTE123|https?:/.test(rep1), '12f: reproduction notes enter the report and are redacted');
    await present.copyText(rep1, navi);
    assert(clipboard.texts.length === 1 && clipboard.texts[0] === rep1, '12g: the report reaches the clipboard only through an explicit copy of exactly the previewed text');
    clipboard.fail = true;
    let copyFailed = false;
    try { await present.copyText(rep1, navi); } catch (_) { copyFailed = true; }
    assert(copyFailed && clipboard.texts.length === 1, '12h: a clipboard failure propagates, so the UI can report it truthfully and select the text for manual copy');
    assert(/одна попытка возобновить/.test(present.RETRY_HINT) && !present.hasReport(ls.records.find((r) => r.state === 'complete')) && !/>\s*(Повторить|Retry)/i.test(read('ui/src/components/app/result-details.tsx')), '12i: no blind retry control; the bounded native resume is explained');

    const settingsCtl = createSettings({ chrome: uiChrome, FolderPath: {}, setTimeout: () => 0, clearTimeout() {} });
    await settingsCtl.setNotifySuccess(false);
    assert(env.local.notifySuccess === false, '12j: the routine-success preference persists immediately');
    env.failLocalSet = true;
    await settingsCtl.setNotifySuccess(true);
    assert(settingsCtl.store.getState().notify.checked === false && /Не удалось сохранить настройку/.test(ru(settingsCtl.store.getState().notify.error)) && env.local.notifySuccess === false, '12k: a storage failure reverts the preference and is reported');
    env.failLocalSet = false;

    await list.openFull(ls.records[0]);
    assert(env.createdTabs.length === 1 && env.createdTabs[0].url === `chrome-extension://testid/popup/popup.html?op=${encodeURIComponent(ls.records[0].id)}#history`, '12l: the full page (history section, that operation) opens only after an explicit action');

    // Message API: sender validation
    let denied = null;
    const l = env.messageListeners.find(() => true);
    for (const listener of env.messageListeners) listener({ action: 'FEEDBACK_LIST' }, { id: 'testid', url: 'https://evil.example/page', tab: { id: 1 } }, (r) => { denied = r; });
    assert(denied && denied.success === false && denied.error === 'FORBIDDEN', '12m: content-script/web senders cannot read feedback records');
    let foreign = null;
    for (const listener of env.messageListeners) listener({ action: 'FEEDBACK_LIST' }, { id: 'other', url: 'chrome-extension://other/x.html' }, (r) => { foreign = r; });
    assert(foreign && foreign.success === false, '12n: other extensions cannot read feedback records');

    // Load failure shows an error instead of throwing
    const brokenChrome = Object.assign({}, uiChrome, { runtime: Object.assign({}, uiChrome.runtime, { sendMessage: async () => { throw new Error('NO_WORKER'); } }) });
    const broken = createFeedbackList({ chrome: brokenChrome, FB: FBLib, navigator: navi }, { limit: 5 });
    await broken.start();
    assert(broken.store.getState().status === 'error' && /Не удалось загрузить результаты/.test(ru(broken.store.getState().error)), '12o: a messaging failure is shown as text, the page keeps working');

    // Unknown metadata renders honestly
    const unknownRec = FBLib.sanitizeRecord({ id: 'op-unknown1', createdAt: Date.now(), state: 'complete' });
    const s = FBLib.summarize(unknownRec).lines.join('\n');
    assert(/сайт неизвестен/.test(s) && /тип неизвестен/.test(s) && /размер неизвестен/.test(s) && !/подтвержд/.test(s), '12p: unknown site/type/size stay "unknown" and nothing is claimed as verified');
    const estimated = FBLib.sanitizeRecord({ id: 'op-estimate', createdAt: Date.now(), state: 'complete', site: 'x', output: { type: 'video', ext: '.mp4', evidence: 'filename_hint', sizeBytes: 5242880, sizeKind: 'estimated' } });
    const es = FBLib.summarize(estimated).lines.join('\n');
    assert(/оценка по заголовкам/.test(es) && /не подтвержд/.test(es) && !/измерено/.test(es), '12q: header estimates and filename hints are labelled as such, not as measured/verified');
  }

  // =================================================================================================
  console.log('\n--- 13. Notification click handling (explicit user action) ---');
  {
    const env = makeEnv();
    await env.ready();
    await env.click(imageClick('k1'));
    await env.click(imageClick('k2'));
    const [b, a] = await env.records();
    await env.finish(a.downloadId);
    await env.finish(b.downloadId, { state: 'interrupted', error: 'NETWORK_FAILED' });
    const click = async (id, sender={id:'testid',tab:{id:7},frameId:0,url:'https://example.com/gallery/1'}) => { for (const l of env.messageListeners) await new Promise(resolve=>{const held=l({action:'MEDIALATCH_NOTICE_OPEN',id},sender,resolve);if(held!==true)resolve();}); };
    await click(a.id);
    await click(b.id);
    await click('someone-else:1');
    await click('../../x');
    await click(a.id,{id:'testid',tab:{id:8},frameId:0,url:'https://example.com/gallery/1'});
    await click(a.id,{id:'testid',tab:{id:7},frameId:1,url:'https://example.com/gallery/1'});
    await click(a.id,{id:'testid',tab:{id:7},frameId:0,url:'https://other.example/'});
    assert(env.shown.length === 0 && env.createdTabs.length === 2, '13a: own notice actions open manager for success/failure; invalid IDs, tabs, frames and origins are refused');
    assert(env.createdTabs[1].url === `chrome-extension://testid/popup/popup.html?op=${encodeURIComponent(b.id)}#downloads`, '13b: manager opens the exact stored operation');
  }

  // =================================================================================================
  console.log('\n--- 14. Static contract: permissions, pages, no remote code ---');
  {
    const manifest = JSON.parse(read('manifest.json'));
    assert(!manifest.permissions.includes('notifications') && !manifest.permissions.includes('tabs') && !manifest.permissions.includes('history') && !manifest.permissions.includes('clipboardWrite'), '14a: desktop-notification permission removed without new privileged permissions');
    assert(manifest.manifest_version === 3 && JSON.stringify(manifest.host_permissions) === JSON.stringify(['http://*/*', 'https://*/*']) && manifest.background.service_worker === 'background.js', '14b: MV3, host permissions and service worker are unchanged');
    assert(!manifest.content_scripts.some((c) => (c.js || []).some((f) => /feedback/.test(f))), '14c: no feedback code is injected into web pages');
    const popupHtml = read('popup/quick.html');
    const detailsHtml = read('popup/popup.html');
    assert(/<script src="\.\.\/lib\/feedback\.js"><\/script>/.test(popupHtml) && /id="root"/.test(popupHtml) && /type="module"/.test(popupHtml), '14d: the compact popup loads the shared feedback library and its bundle and has its mount point');
    assert(/id="root"/.test(detailsHtml) && /<DownloadsPanel full/.test(read('ui/src/components/app/full-app.tsx')) && !/<script[^>]+src="https?:/.test(popupHtml + detailsHtml) && !/\son\w+=/.test(popupHtml + detailsHtml), '14e: the full page exists; no remote scripts or inline handlers (MV3 CSP)');
    assert(fs.existsSync(path.resolve(ROOT, 'icons/notification.png')) && fs.readFileSync(path.resolve(ROOT, 'icons/notification.png')).slice(1, 4).toString() === 'PNG', '14f: notification icon is packaged');
    const fbSources = read('lib/feedback.js') + read('lib/feedback_tracker.js') + read('ui/src/core/feedbackList.js') + read('ui/src/core/statistics.js');
    assert(!/\binnerHTML\b|\beval\(|new Function|document\.write|\bfetch\(|XMLHttpRequest|sendBeacon|\.createIssue|api\.github\.com/.test(fbSources.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), '14g: feedback code has no innerHTML/eval and no network or issue-creation calls');
  }

  // =================================================================================================
  console.log('\n--- 15. Event/ID race: terminal event before the download ID is attached ---');
  {
    // Chrome item is already terminal and the REAL onChanged listener starts before downloads.download
    // hands back the ID; the listener is then held on its storage lookup while the handler attaches.
    const raceRun = async (terminal, { duplicate = false } = {}) => {
      const env = makeEnv();
      await env.ready();
      let release;
      const gate = new Promise((res) => { release = res; });
      const origGet = env.chrome.storage.session.get;
      env.chrome.storage.session.get = async (key) => {
        if (typeof key === 'string' && key.startsWith('active_dl_blob_')) await gate;
        return origGet(key);
      };
      let emitted;
      env.chrome.downloads.download = (options, cb) => {
        env.downloadCalls.push(options);
        const id = env.nextId++;
        env.downloadsDb.set(id, { id, state: terminal.state, error: terminal.error, fileSize: 999, exists: true });
        emitted = env.emitDownload({ id, state: { current: terminal.state, previous: 'in_progress' }, ...(terminal.error ? { error: { current: terminal.error } } : {}) });
        if (typeof cb === 'function') cb(id);
        return Promise.resolve(id);
      };
      const click = env.contextMenuHandler(imageClick('race'), { id: 7, url: 'https://example.com/gallery/1' });
      for (let i = 0; i < 40; i++) await tick();
      release();
      await click;
      await emitted;
      await env.tracker.flush();
      if (duplicate) {
        const id = env.nextId - 1;
        await env.emitDownload({ id, state: { current: terminal.state } });
        await env.emitDownload({ id, state: { current: terminal.state } });
        await env.tracker.flush();
      }
      return env;
    };

    const ec = await raceRun({ state: 'complete' });
    const rc = await ec.last();
    assert(rc.state === 'complete' && rc.output.sizeBytes === 999 && ec.notifications.length === 1 && ec.downloadCalls.length === 1, '15a: complete event before/during attachment -> complete, exactly one notification, one download call');
    assert(ec.searchCalls.every((q) => Object.keys(q).join() === 'id'), '15b: reconciliation looked up only the extension-owned download ID');
    assert(!ec.sandbox.earlyTerminalDownloadStates.has(ec.nextId - 1), '15c: no stale early-terminal cache entry is left behind');

    const ei = await raceRun({ state: 'interrupted', error: 'NETWORK_FAILED' });
    const ri = await ei.last();
    assert(ri.state === 'interrupted' && ri.failure.downloadError === 'NETWORK_FAILED' && ei.notifications.length === 1 && ei.downloadCalls.length === 1, '15d: interrupted event before/during attachment -> interrupted, one failure notification, one download call');

    const ed = await raceRun({ state: 'complete' }, { duplicate: true });
    assert((await ed.records()).length === 1 && ed.notifications.length === 1, '15e: duplicated terminal events after settlement produce no second result or notification');

    const eu = await raceRun({ state: 'interrupted', error: 'USER_CANCELED' });
    assert((await eu.last()).state === 'cancelled' && eu.notifications.length === 0, '15f: a cancel during attachment settles as cancelled (no toast)');

    const en = makeEnv();
    await en.ready();
    await en.click(imageClick('later'));
    const pending = await en.last();
    assert(pending.state === 'saving' && en.notifications.length === 0, '15g: an in-progress download is not settled by the owned-ID lookup');
    await en.finish(pending.downloadId);
    assert((await en.last()).state === 'complete' && en.notifications.length === 1 && en.downloadCalls.length === 1, '15h: ordinary later completion still settles once');
  }

  // =================================================================================================
  console.log('\n--- 16. Failure status provenance (NOT_FOUND, observed vs defaulted statuses) ---');
  {
    const run = async (plan) => {
      const env = makeEnv();
      await env.ready();
      env.sandbox.resolveOriginalMediaPlan = async () => env.x.adaptCandidateToGroup(plan);
      await env.click(imageClick('nf'));
      const rec = await env.last();
      const summary = FBLib.summarize(rec);
      // Timestamp digits must not be mistaken for an HTTP-status claim.
      const report = FBLib.buildReport(rec, { env: { version: '2.0.0' }, now: Date.UTC(2026, 0, 1, 0, 0, 0, 410) });
      const toast = env.notifications.length ? `${env.notifications[0].opts.title} ${env.notifications[0].opts.message}` : '';
      return { env, rec, summary, report, toast, all: `${summary.explanation} ${summary.lines.join(' ')} ${report} ${toast}` };
    };
    const base = { url: 'https://example.com/a.jpg', source: 'initial_src', error: 'NOT_FOUND' };

    for (const st of [404, 410]) {
      const r = await run({ ...base, _verificationStatus: st });
      assert(r.rec.state === 'failed' && r.rec.failure.category === 'not_found' && r.rec.failure.status === st && r.env.downloadCalls.length === 0, `16a-${st}: observed ${st} is kept with category not_found and no download`);
      assert(r.summary.explanation.includes(`HTTP ${st}`) && r.summary.lines.includes(`HTTP-статус: ${st}`) && new RegExp(`http_status: ${st}`).test(r.report), `16b-${st}: details and copied report show the observed status ${st}`);
    }

    const r500 = await run({ ...base, _verificationStatus: 500 });
    assert(r500.rec.failure.status === 500 && r500.rec.failure.category === 'server_error', '16c: observed 500 is kept and is NOT classified as "file absent"');
    assert(!/404\/410|подтвердил, что файл отсутствует/.test(r500.all) && r500.summary.explanation.includes('HTTP 500') && r500.toast.includes('Ошибка сервера'), '16d: 500 notification, details and report make no 404/410 absence claim');

    const rNone = await run({ ...base });
    assert(rNone.rec.failure.category === 'not_found' && rNone.rec.failure.status === null, '16e: NOT_FOUND without any status stays not_found with status unknown');
    assert(!/(?:HTTP(?:-статус)?[: ]+|http_status: )(?:404|410)\b/.test(rNone.all) && rNone.summary.lines.includes('HTTP-статус: не наблюдался') && /http_status: not observed/.test(rNone.report) && rNone.summary.explanation.includes('не наблюдался'), '16f: no HTTP claim in notification, details or report; status shown as "not observed"');
    assert(rNone.report.includes('timestamp: 2026-01-01T00:00:00.410Z'), '16f1: a valid timestamp containing status-like digits remains in the report');

    const rSyn = await run({ ...base, _verificationStatus: 404, _verificationStatusObserved: false });
    assert(rSyn.rec.failure.status === null && !/HTTP 404|HTTP-статус: 404|http_status: 404/.test(rSyn.all), '16g: a pipeline-default status (marked unobserved) is not reported as an observation');

    const rCtr = await run({ ...base, _verificationStatus: 200 });
    assert(rCtr.rec.failure.status === 200 && rCtr.rec.failure.category !== 'not_found' && !/404\/410/.test(rCtr.all), '16h: contradictory evidence (NOT_FOUND with HTTP 200) is not presented as confirmed absence');

    assert(FBLib.classifyFailure({ stage: 'download', code: 'NETWORK_FAILED' }) === 'network' && FBLib.classifyFailure({ code: 'NOT_FOUND' }) === 'not_found' && FBLib.classifyFailure({ code: 'NOT_FOUND', status: 500 }) === 'server_error' && FBLib.categoryText('not_found', null).explanation.indexOf('HTTP 4') === -1, '16i: network failure stays network; NOT_FOUND alone makes no numeric claim');

    // Real resolver path: an authoritative video whose probe reports no status (404 is the pipeline default).
    const envP = makeEnv();
    await envP.ready();
    envP.fetchImpl = async () => { throw new Error('NETWORK down'); };
    await envP.click({ menuItemId: 'save-image-item', srcUrl: 'https://example.com/v/clip.mp4', pageUrl: 'https://example.com/p', mediaType: 'video' });
    const rp = await envP.last();
    assert(rp && rp.state === 'failed' && rp.downloadId === null && envP.downloadCalls.length === 0 && !/HTTP 404/.test(FBLib.summarize(rp).explanation), '16j: a probe network failure on the production path never yields an invented HTTP 404 explanation');
  }

  // =================================================================================================
  console.log('\n--- 17. All-time statistics production integration ---');
  {
    const idb = idbDouble();
    const env = makeEnv({local:{historyEnabled:true},indexedDB:idb});await env.ready();
    const sender={id:'testid',url:'chrome-extension://testid/popup/popup.html'};
    const ask=(env,action,who=sender)=>new Promise(resolve=>{for(const l of env.messageListeners){let replied=false;const keep=l({action},who,r=>{replied=true;resolve(r)});if(keep||replied)return;}resolve(null);});
    const stats=async e=>(await ask(e,'STATISTICS_LIST')).stats;
    await env.click(imageClick('stat1'));const a=await env.last();assert((await stats(env)).total===0,'17a: in-flight operations are not counted');
    await env.finish(a.downloadId);assert((await stats(env)).success===1 && (await stats(env)).size.knownBytes===12345,'17b: native completion reaches aggregate counters with measured size');
    await env.emitDownload({id:a.downloadId,state:{current:'complete'}});await env.tracker.flush();assert((await stats(env)).total===1,'17c: duplicate completion does not count twice');
    env.fetchImpl=async()=>({ok:false,status:403,headers:{get:()=>''}});await env.click(imageClick('stat2'));env.fetchImpl=null;
    assert((await stats(env)).failed===1,'17d: source refusal counts a failure');
    await env.click(imageClick('stat3'));const b=await env.last();await env.finish(b.downloadId,{state:'interrupted',error:'USER_CANCELED'});
    assert((await stats(env)).cancelled===1 && (await stats(env)).total===3,'17e: cancellation is separate');
    assert(!env.local.imageSaverHistoryV1,'17f: new saves do not create legacy history');
    for(const who of [{id:'evil',url:sender.url},{id:'testid',url:'https://evil.example/'},{id:'testid',url:'https://www.reddit.com/'}])for(const action of ['STATISTICS_LIST','STATISTICS_CLEAR'])assert((await ask(env,action,who)).error==='FORBIDDEN','17g: page/foreign senders cannot read or clear statistics');
    env.local.historyEnabled=false;await env.click(imageClick('stat4'));await env.finish((await env.last()).downloadId);assert((await stats(env)).total===3,'17h: opt-out retains totals and excludes new completions');
    const restarted=makeEnv({local:env.local,session:env.session,downloadsDb:env.downloadsDb,indexedDB:idb});await restarted.ready();assert((await stats(restarted)).total===3 && restarted.downloadCalls.length===0,'17i: worker restart retains counters without replay or redownload');
    idb.fail=true;assert((await ask(restarted,'STATISTICS_CLEAR')).success===false && (await stats(restarted)).total===3,'17j: transaction abort keeps counters and returns failure');
    assert((await ask(restarted,'STATISTICS_CLEAR')).stats.total===0,'17k: clear is acknowledged only after transaction commit');
    const brokenIdb=idbDouble(), broken=makeEnv({local:{historyEnabled:true},indexedDB:brokenIdb});await broken.ready();await stats(broken);
    await broken.click(imageClick('stat-retry'));const pending=await broken.last();brokenIdb.failAll=true;await broken.finish(pending.downloadId);
    assert((await broken.tracker.get(pending.id)).historyPending===true,'17m: aborted statistics commit retains durable tracker delivery');
    brokenIdb.failAll=false;const recovered=makeEnv({local:broken.local,session:broken.session,downloadsDb:broken.downloadsDb,indexedDB:brokenIdb});await recovered.ready();await recovered.tracker.flush();assert((await stats(recovered)).success===1 && !(await recovered.tracker.get(pending.id)).historyPending,'17n: retry acknowledges exactly one committed completion');
    assert(/<StatisticsPanel \/>/.test(read('ui/src/components/app/full-app.tsx')) && !/<HistoryPanel \/>/.test(read('ui/src/components/app/full-app.tsx')),'17l: settings mounts clean Statistics');
  }

  console.log('\n--- 19. Identifiable file names in results ---');
  {
    const extSender = { id: 'testid', url: 'chrome-extension://testid/popup/popup.html' };
    const ask = (env, action) => new Promise((resolve) => {
      let responded = false;
      for (const l of env.messageListeners) { const keep = l({ action }, extSender, (r) => { responded = true; resolve(r); }); if (keep === true || responded) break; }
      if (!responded) setTimeout(() => resolve(undefined), 0);
    });
    const hEnv = (o = {}) => makeEnv({ ...o, local: { historyEnabled: true, ...(o.local || {}) } });
    const baseOf = (p) => String(p).split(/[\\/]/).pop();
    const B = FBLib.safeBasename;

    // pure basename extraction
    assert(B('C:\\Users\\Ivan\\Downloads\\SavedImages\\a b.jpg') === 'a b.jpg' && B('/home/ivan/Downloads/x/pic.png') === 'pic.png' && B('SavedImages/danbooru/pic/123.webp') === '123.webp' && B('plain.gif') === 'plain.gif' && B('D:/dir with space/файл 猫.mp4') === 'файл 猫.mp4', '19a: basename extraction for Windows, POSIX and mixed separators keeps ordinary Unicode');
    assert(['', '.', '..', 'C:\\dir\\', '/home/u/', null, undefined, 5, {}].every((v) => B(v) === ''), '19b: nothing usable (directories, dots, junk) gives an empty name, never a path');
    const evil = B('a\u202eb\u0000c\u2028d.jpg');
    assert(evil === 'a_b_c_d.jpg' && !/[\u0000-\u001f\u202a-\u202e\u2028\u2029]/.test(evil), '19c: control and bidirectional characters are neutralised');
    const long = B(`${'я'.repeat(400)}.jpeg`);
    assert(long.length <= 120 && long.endsWith('.jpeg') && long.includes('…'), '19d: an over-long name is bounded and keeps its extension');
    assert(!/[\\/]/.test(B('https://evil.example/path/img.jpg')) && !/[\\/]/.test(B('..\\..\\x/evil.png')), '19e: no separator survives in a basename');
    const rec = FBLib.sanitizeRecord({ id: 'op-legacy01', createdAt: 5, updatedAt: 6, state: 'complete', filename: 'C:\\x\\y\\z.png', filenameKind: 'weird' });
    assert(rec.filename === 'z.png' && rec.filenameKind === 'intended', '19f: schema stores a basename only and normalises an unknown kind to "intended"');
    const legacy = FBLib.sanitizeRecord({ id: 'op-legacy02', createdAt: 5, updatedAt: 6, state: 'complete', site: 'example.com', output: { type: 'pic', ext: '.jpg' } });
    assert(legacy.filename === '' && legacy.filenameKind === '', '19g: records without a name stay valid (legacy)');

    // requested vs actual (collision rename) through the production handler
    const env = hEnv();
    await env.ready();
    await env.click(imageClick('name1'));
    let r = await env.last();
    const requested = baseOf(env.downloadCalls[0].filename);
    assert(r.state === 'saving' && r.filename === requested && r.filenameKind === 'intended' && /\.jpg$/.test(r.filename), '19h: before completion the requested basename is recorded as "intended"');
    assert(env.downloadCalls[0].filename.includes('/') && !/[\\/]/.test(r.filename) && JSON.stringify(env.session.imageSaverFeedbackV1).indexOf('SavedImages') === -1, '19i: the requested path had directories, but only the basename is persisted');
    const ui = { ImageSaverFeedbackUI: { rowParts: (rec) => present.rowParts(FBLib, rec), filenameLine: present.filenameLine } };
    const parts = ui.ImageSaverFeedbackUI.rowParts(r);
    assert(parts.name === requested && /запланировано, не подтверждено/.test(parts.meta) && !/Сохранено/.test(parts.name), '19j: an unconfirmed name is labelled as intended and is the main row text');
    env.downloadsDb.get(r.downloadId).filename = `C:\\Users\\Ivan\\Downloads\\SavedImages\\${requested.replace('.jpg', '')} (1).jpg`; // Chrome renamed it (collision)
    await env.finish(r.downloadId);
    r = await env.last();
    assert(r.state === 'complete' && r.filename === `${requested.replace('.jpg', '')} (1).jpg` && r.filenameKind === 'actual', '19k: the actual DownloadItem name (collision rename) replaces the requested one, basename only');
    assert(!/запланировано/.test(ui.ImageSaverFeedbackUI.rowParts(r).meta) && /фактическое/.test(ui.ImageSaverFeedbackUI.filenameLine(r)), '19l: an actual name carries no intended caveat');
    assert(env.searchCalls.every((q) => Object.keys(q).join() === 'id' && Number.isInteger(q.id)), '19m: only extension-owned download IDs are looked up');

    // POSIX Save As path and missing filename
    const env2 = hEnv();
    await env2.ready();
    await env2.click(imageClick('name2'));
    const r2 = await env2.last();
    env2.downloadsDb.get(r2.downloadId).filename = '/home/ivan/Pictures/my saved/кот 猫.jpg';
    await env2.finish(r2.downloadId);
    assert((await env2.last()).filename === 'кот 猫.jpg' && (await env2.last()).filenameKind === 'actual', '19n: a POSIX Save As path is reduced to its basename');
    const env3 = hEnv();
    await env3.ready();
    await env3.click(imageClick('name3'));
    const r3 = await env3.last();
    await env3.finish(r3.downloadId); // item has no filename field
    const r3d = await env3.last();
    assert(r3d.state === 'complete' && r3d.filename === baseOf(env3.downloadCalls[0].filename) && r3d.filenameKind === 'intended', '19o: when Chrome reports no filename the intended name is kept and stays labelled as such');

    // interrupted keeps the intended name; failures before naming keep a useful summary
    const env4 = hEnv();
    await env4.ready();
    await env4.click(imageClick('name4'));
    const r4 = await env4.last();
    env4.downloadsDb.get(r4.downloadId).filename = 'C:\\Users\\Ivan\\Downloads\\partial.crdownload';
    await env4.finish(r4.downloadId, { state: 'interrupted', error: 'NETWORK_FAILED' });
    const r4d = await env4.last();
    assert(r4d.state === 'interrupted' && r4d.filenameKind === 'intended' && r4d.filename === baseOf(env4.downloadCalls[0].filename), '19p: an interrupted download keeps the requested name (not presented as the saved file)');
    const env5 = hEnv();
    await env5.ready();
    env5.fetchImpl = async () => ({ ok: false, status: 403, headers: { get: () => '' } });
    await env5.click(imageClick('name5'));
    const r5 = await env5.last();
    const p5 = ui.ImageSaverFeedbackUI.rowParts(r5);
    assert(r5.filename === '' && p5.name === '' && /Нужен доступ|auth|доступ/i.test(p5.legacy) && /example\.com/.test(p5.legacy), '19q: a failure before naming keeps the previous useful summary (title, site)');

    // converted GIF and fallback names
    const envX = hEnv();
    await envX.ready();
    envX.tabsMsgHandler = async (tabId, msg) => (msg.action === 'GET_X_MEDIA_AT_CURSOR' ? { type: 'x_tweet_video', url: 'https://video.twimg.com/tweet_video/CV1.mp4' } : null);
    await envX.contextMenuHandler({ menuItemId: 'save-x-media-item', pageUrl: 'https://x.com/u/status/1' }, { id: 8, url: 'https://x.com/u/status/1' });
    await envX.tracker.flush();
    const rx = await envX.last();
    assert(rx.filename === baseOf(envX.downloadCalls[0].filename) && /\.gif$/.test(rx.filename) && !/\.mp4$/.test(rx.filename) && rx.filenameKind === 'intended', '19r: a converted GIF shows its output .gif name, not the source MP4 name');
    envX.downloadsDb.get(rx.downloadId).filename = 'C:\\Users\\Ivan\\Downloads\\SavedImages\\x\\gif\\CV1 (2).gif';
    await envX.finish(rx.downloadId);
    assert((await envX.last()).filename === 'CV1 (2).gif' && (await envX.last()).filenameKind === 'actual', '19s: the converted file reports its actual name after completion');
    const envR = hEnv();
    await envR.ready();
    await envR.click({ menuItemId: 'save-image-item', srcUrl: 'https://preview.redd.it/anim9.gif?format=mp4&s=abcdef', pageUrl: 'https://www.reddit.com/r/gifs/comments/9/', mediaType: 'video' });
    const rr = await envR.last();
    assert(/\.gif$/.test(rr.filename) && rr.filename === baseOf(envR.downloadCalls[0].filename), '19t: a Reddit conversion also records its own GIF name');

    const envF = hEnv();
    await envF.ready();
    const op = await envF.x.fbBegin({ pageUrl: 'https://example.com/g/1', sourceUrl: 'https://example.com/img/primary.gif', site: 'example.com' });
    const group = envF.x.createCandidateGroup({ id: 'fb_n', provider: 'generic', tier: 'unknown', source: 'initial_src', variants: [{ url: 'https://example.com/img/primary.gif', expectedExtension: '.gif' }], metadata: { contentType: 'image/gif', mediaType: 'gif' } });
    envF.failNextDownloads = 1;
    await envF.x.executeMediaDownload({ targetImageUrl: 'https://example.com/img/primary.gif', rawImageUrl: 'https://example.com/img/fallback.png', settings, mediaPlan: group, pageUrl: 'https://example.com/g/1', feedbackOp: op });
    await envF.tracker.flush();
    const rf = await envF.last();
    assert(rf.fallback === true && rf.filename === baseOf(envF.downloadCalls[envF.downloadCalls.length - 1].filename) && /fallback|\.png/.test(rf.filename) && !/primary/.test(rf.filename), '19u: a fallback result uses its own file name, not the primary one');

    // persisted results, reports, notifications, hostile names, rendering
    const envH = hEnv();
    await envH.ready();
    await envH.click(imageClick('hist1'));
    const rh = await envH.last();
    envH.downloadsDb.get(rh.downloadId).filename = `C:\\Users\\Secret Person\\Downloads\\${'長'.repeat(300)}\u202e.jpg`;
    await envH.finish(rh.downloadId);
    const hres = await ask(envH, 'FEEDBACK_LIST');
    const he = hres.records[0];
    const stored = JSON.stringify(envH.local) + JSON.stringify(envH.session.imageSaverFeedbackV1);
    assert(he.filename.length <= 120 && he.filename.endsWith('_.jpg') === false && /\.jpg$/.test(he.filename) && !/Secret Person|Users|[\\\\]{2}/.test(stored), '19v: hostile/long names are bounded and persisted session/local storage hold no directory path');
    assert(he.filenameKind === 'actual', '19w: the persisted result keeps the filename kind');
    assert(env.notifications.length === 1 && !(env.notifications[0].opts.title + env.notifications[0].opts.message).includes(requested.replace(/\.[a-z]+$/, '')) && !envH.notifications.some((n) => (n.opts.title + n.opts.message).indexOf(he.filename.slice(0, 5)) !== -1), '19x: file names are not placed in desktop notifications');
    const failedRec = { ...he, state: 'failed', failure: { stage: 'download', category: 'download_interrupted', code: '', status: null, downloadError: 'NETWORK_FAILED' } };
    const report = FBLib.buildReport(failedRec, { notes: 'x', env: { version: '2.0.0' } });
    assert(report.indexOf(he.filename) === -1 && report.indexOf(he.filename.slice(0, 8)) === -1 && !/filename/i.test(report), '19y: file names never appear in a copied bug report');

    assert(present.filenameLine(he).includes(he.filename), '19aa: expanded details show the complete sanitized name');
    const rowSrc = read('ui/src/components/app/result-row.tsx');
    const detSrc = read('ui/src/components/app/result-details.tsx');
    assert(/block truncate[^"]*" data-slot="name"/.test(rowSrc) && /min-w-0 flex-1/.test(rowSrc) && /break-all/.test(detSrc) && /break-words/.test(detSrc), '19ab: long names are truncated in rows (ellipsis) and wrap in details, so they cannot widen the popup');
    const chromeP = { runtime: { getManifest: () => ({ version: '2.0.0' }), getURL: (p) => p, sendMessage: (m) => ask(envH, m.action) }, storage: { local: { get: async (d) => ({ ...d, ...envH.local }), set: async () => {} } }, tabs: { create() {} } };
    const plist = createFeedbackList({ chrome: chromeP, FB: FBLib, navigator: {} }, { limit: 5 });
    await plist.start();
    assert(present.rowParts(FBLib, plist.store.getState().records[0]).name === he.filename, '19ac: the popup recent-results list uses the same basename as main text');
    assert(JSON.stringify(Object.keys(he).sort()).indexOf('"downloadObject"') === -1 && !('url' in he) && !('path' in he), '19ad: no raw download object, URL or path field exists on a record');
  }

  // =================================================================================================
  console.log('\n--- 20. File names: URL/Blob/data input is rejected, never turned into a name ---');
  {
    const extSender = { id: 'testid', url: 'chrome-extension://testid/popup/popup.html' };
    const ask = (env, action) => new Promise((resolve) => {
      let responded = false;
      for (const l of env.messageListeners) { const keep = l({ action }, extSender, (r) => { responded = true; resolve(r); }); if (keep === true || responded) break; }
      if (!responded) setTimeout(() => resolve(undefined), 0);
    });
    const B = FBLib.safeBasename;
    const hEnv = (o = {}) => makeEnv({ ...o, local: { historyEnabled: true, ...(o.local || {}) } });
    const urls = [
      'https://cdn.example.com/image.jpg?token=SECRET#fragment',
      'http://cdn.example.com/a/b/image.jpg?X-Amz-Signature=SIGSECRET',
      'HTTPS://CDN.EXAMPLE.COM/image.jpg?token=SECRET',
      '  \n https://cdn.example.com/image.jpg?token=SECRET',
      'blob:https://example.com/private-id',
      'blob:null/private-id',
      'data:image/png;base64,iVBORw0KGgoSECRET',
      'javascript:alert(1)//x.jpg',
      'file:///C:/Users/Ivan/secret.jpg',
      'ftp://host/dir/name.png',
      `https://cdn.example.com/${'a/'.repeat(700)}image.jpg?token=SECRET#frag`
    ];
    assert(urls.every((u) => B(u) === ''), '20a: HTTP/HTTPS (signed query/fragment), Blob, data, javascript, file and long URLs are rejected whole by safeBasename');
    assert(urls.every((u) => { const r = FBLib.sanitizeRecord({ id: 'op-url00001', createdAt: 5, updatedAt: 6, state: 'complete', filename: u, filenameKind: 'actual' }); return r.filename === '' && r.filenameKind === '' && !/SECRET|private-id|image\.jpg|secret\.jpg|frag/.test(JSON.stringify(r)); }), '20b: sanitizeRecord retains no URL-derived name or secret (kind reset too)');
    const kept = {
      'C:\\Users\\Ivan\\Pictures\\a b.png': 'a b.png',
      'C:/Users/Ivan/x.png': 'x.png',
      'C://odd/drive/y.png': 'y.png',
      '\\\\server\\share\\dir\\f.jpg': 'f.jpg',
      '/home/ivan/Downloads/f.webp': 'f.webp',
      'D:\\файлы\\кот 猫.gif': 'кот 猫.gif',
      'note:x.png': 'note:x.png',
      'plain name.mp4': 'plain name.mp4'
    };
    assert(Object.entries(kept).every(([input, want]) => B(input) === want), '20c: Windows drive paths, UNC, POSIX paths and ordinary Unicode/colon names still yield their basename');
    assert(!/SECRET/.test(B(`${'x'.repeat(2000)}https://cdn.example.com/image.jpg?token=SECRET`)) || B(`${'x'.repeat(2000)}https://cdn.example.com/image.jpg?token=SECRET`).length <= 120, '20d: a non-URL string is still bounded');

    // production tracker: a URL reported as DownloadItem.filename never becomes the name
    const env = hEnv();
    await env.ready();
    await env.click(imageClick('u1'));
    const r = await env.last();
    const requested = String(env.downloadCalls[0].filename).split(/[\\/]/).pop();
    env.downloadsDb.get(r.downloadId).filename = 'https://cdn.example.com/image.jpg?token=SECRET#fragment';
    await env.finish(r.downloadId);
    const done = await env.last();
    assert(done.state === 'complete' && done.filename === requested && done.filenameKind === 'intended', '20e: a URL in DownloadItem.filename is ignored; the intended name stays, labelled as such');
    const storedAll = JSON.stringify(env.session.imageSaverFeedbackV1) + JSON.stringify(env.local);
    assert(!/SECRET|fragment|cdn\.example\.com\/image/.test(storedAll), '20f: no URL-derived secret is persisted in session feedback or local storage');

    // rejected input at attach time: the unnamed summary is kept
    const env2 = hEnv();
    await env2.ready();
    const op = await env2.x.fbBegin({ pageUrl: 'https://example.com/p', sourceUrl: 'https://example.com/a.jpg', site: 'example.com' });
    await env2.x.fbAttach(op, 777, { filename: 'blob:https://example.com/private-id' });
    await env2.tracker.flush();
    const r2 = await env2.last();
    assert(r2.filename === '' && r2.filenameKind === '', '20g: a Blob/URL name offered at attach time is dropped');
    await env2.finish(777, { state: 'interrupted', error: 'NETWORK_FAILED' });
    const parts = present.rowParts(FBLib, await env2.last());
    assert(parts.name === '' && /example\.com/.test(parts.legacy) && parts.legacy.length > 5, '20h: the rejected-name record keeps the useful unnamed summary (title, site)');

  }

  // =================================================================================================
  console.log('\n--- 21. Live results list on an open page ---');
  {
    const env = makeEnv({ local: { historyEnabled: true } });
    await env.ready();
    // The mock storage areas do not emit change events; chrome.storage.onChanged does in a browser. Emit them from the real writes.
    const listeners = [];
    const wrap = (areaName, area) => {
      const base = area.set;
      area.set = async (items) => {
        await base(items);
        const changes = {};
        for (const k of Object.keys(items)) changes[k] = { newValue: items[k] };
        for (const cb of listeners.slice()) cb(changes, areaName);
      };
    };
    wrap('session', env.chrome.storage.session);
    wrap('local', env.chrome.storage.local);
    const extSender = { id: 'testid', url: 'chrome-extension://testid/popup/popup.html' };
    const uiChrome = {
      runtime: {
        getManifest: () => ({ version: '2.0.0' }),
        getURL: (p) => `chrome-extension://testid/${p}`,
        sendMessage: (msg) => new Promise((resolve) => {
          let responded = false;
          for (const l of env.messageListeners) { const keep = l(msg, extSender, (resp) => { responded = true; resolve(resp); }); if (keep === true || responded) break; }
          if (!responded) setTimeout(() => resolve(undefined), 0);
        })
      },
      storage: {
        local: { get: async (d) => ({ ...d, ...env.local }), set: async (v) => { Object.assign(env.local, v); } },
        onChanged: { addListener: (cb) => { listeners.push(cb); }, removeListener: (cb) => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } }
      },
      tabs: { create: async () => ({ id: 1 }) }
    };
    const settleUi = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
    const list = createFeedbackList({ chrome: uiChrome, FB: FBLib, navigator: {} }, { limit: 5 });
    await list.start();
    assert(list.store.getState().records.length === 0 && listeners.length === 1, '21a: the page starts empty with one subscription');

    // a save begins: the open list shows it without reopening
    await env.click(imageClick('live1'));
    await settleUi();
    const first = list.store.getState().records[0];
    assert(list.store.getState().records.length === 1 && (first.state === 'saving' || first.state === 'resolving') && first.id, '21b: a save that starts while the page is open appears in the list (in progress)');
    // completion
    await env.finish(first.downloadId);
    await settleUi();
    const done = list.store.getState().records[0];
    assert(done.id === first.id && done.state === 'complete' && list.store.getState().records.length === 1, '21c: the completion updates the same result in place');
    // failure
    env.fetchImpl = async () => ({ ok: false, status: 403, headers: { get: () => '' } });
    await env.click(imageClick('live2'));
    env.fetchImpl = null;
    await settleUi();
    const failed = list.store.getState().records[0];
    assert(failed.state === 'failed' && list.store.getState().unreadIds.includes(failed.id), '21e: a failure appears at once, marked as new');
    assert((await env.sandbox.getUnseenFailureCount()) === 0 && env.badge.text !== '!', '21f: it was acknowledged because the list is visible: the toolbar "!" badge is cleared');
    // cancellation
    await env.click(imageClick('live3'));
    await settleUi();
    const pending = list.store.getState().records[0];
    await env.finish(pending.downloadId, { state: 'interrupted', error: 'USER_CANCELED' });
    await settleUi();
    assert(list.store.getState().records[0].id === pending.id && list.store.getState().records[0].state === 'cancelled', '21g: a cancellation updates the result');
    // clear
    await list.clear();
    await settleUi();
    assert(list.store.getState().records.length === 0, '21i: clearing the completed results empties the open list');

    // a hidden list shows a failure but keeps it unacknowledged until it is shown (the visible list of the first part is closed)
    list.dispose();
    assert(listeners.length === 0, '21ja: closing the visible list removes its subscription');
    const hiddenList = createFeedbackList({ chrome: uiChrome, FB: FBLib, navigator: {} }, { limit: 5, visible: false });
    await hiddenList.start();
    env.fetchImpl = async () => ({ ok: false, status: 403, headers: { get: () => '' } });
    await env.click(imageClick('live4'));
    env.fetchImpl = null;
    await settleUi();
    assert(hiddenList.store.getState().records[0].state === 'failed' && (await env.sandbox.getUnseenFailureCount()) >= 1, '21k: a failure that arrives while the panel is hidden is rendered and stays unacknowledged (the badge stays)');
    hiddenList.setVisible(true);
    await settleUi();
    assert((await env.sandbox.getUnseenFailureCount()) === 0, '21l: showing the panel acknowledges it');

    // closing the page ends the updates
    hiddenList.dispose();
    assert(listeners.length === 0, '21m: closing the page removes every subscription');
    const sends = [];
    const baseSend = uiChrome.runtime.sendMessage;
    uiChrome.runtime.sendMessage = (m) => { sends.push(m.action); return baseSend(m); };
    await env.click(imageClick('live5'));
    await settleUi();
    assert(sends.length === 0, '21n: a closed page makes no more requests');
  }


  // =================================================================================================
  console.log('\n--- 22. Durable explanation of the animation duration policy (reason, measured duration, threshold) ---');
  {
    const ctx = (() => { const s = { console }; vm.createContext(s); for (const f of ['lib/feedback.js', 'lib/feedback_tracker.js']) vm.runInContext(read(f), s); return vm.runInContext('globalThis', s); })();
    const FB = ctx.ImageSaverFeedback;
    const REASON = 'animation_duration_limit';
    const mem = () => { const store = {}; return { store, area: { get: async (k) => store[k], set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } } }; };
    const mkTracker = (m, extra = {}) => ctx.ImageSaverFeedbackTracker.createTracker(Object.assign({
      storage: m.area, now: () => 1700000000000, genId: (() => { let n = 0; return () => 'op-' + (++n) + 'abcdef'; })(),
      getDownloadItem: async () => undefined, peekEarlyTerminal: () => undefined, notify: async () => {}, log: () => {}
    }, extra));
    const mkNotifier = (sink, { notifySuccess = true, lang = 'en' } = {}) => ctx.ImageSaverFeedbackTracker.createNotifier({
      getPrefs: async () => ({ notifySuccess }), deliver: async (rec, o) => { sink.push({ id:rec.id, o }); return true; }, lang
    });
    const policyPatch = (d = 35, t = 30) => ({ conversion: 'none', reason: REASON, durationSec: d, thresholdSec: t,
      output: { type: 'video', ext: '.mp4', evidence: 'verified_mime', mime: 'video/mp4', durationSec: d, reason: REASON, thresholdSec: t } });
    const baseRec = (extra = {}) => Object.assign({ id: 'op-1abcdef', createdAt: 1700000000000, updatedAt: 1700000000000, state: 'complete', site: 'reddit.com' }, extra);

    for (const lang of ['en', 'ru']) {
      const notes = [], record = FB.sanitizeRecord(baseRec({ site: 'x' }));
      await mkNotifier(notes, { lang })(record);
      assert(notes.length === 1 && notes[0].o.title === (lang === 'en' ? 'x.com: saved' : 'x.com: сохранено') && FB.summarize(record, lang).lines[0].endsWith('x.com'), '22-x-label [' + lang + ']: notices and result details display x.com for existing x records');
      assert(record.site === 'x' && /resource_site: x\n/.test(FB.buildReport(record)) && FB.siteLabel('pixiv') === 'pixiv', '22-x-identity [' + lang + ']: display formatting leaves stored identifiers, diagnostics and other sites unchanged');
    }

    // schema: the allowlisted reason and the bounded numbers survive sanitization, record-level and in the output
    const ok = FB.sanitizeRecord(baseRec({ reason: REASON, durationSec: 35.25, thresholdSec: 30, output: { type: 'video', ext: '.mp4', evidence: 'verified_mime', mime: 'video/mp4', durationSec: 35.25, reason: REASON, thresholdSec: 30 } }));
    assert(ok.reason === REASON && ok.durationSec === 35.25 && ok.thresholdSec === 30 && ok.output.reason === REASON && ok.output.thresholdSec === 30 && ok.output.durationSec === 35.25, '22a: sanitizeRecord keeps the allowlisted reason, the measured duration and the threshold (record and output)');
    assert(JSON.stringify(FB.sanitizeRecord(JSON.parse(JSON.stringify(ok)))) === JSON.stringify(ok), '22b: a JSON round trip of the sanitized record is stable');
    const hostile = ['https://evil.example/?token=SECRET', '<script>alert(1)</script>', REASON + ' https://evil.example/x', 'ANIMATION_DURATION_LIMIT', { toString() { return REASON; } }, ['animation_duration_limit'], 'C:\\Users\\Ivan\\x', 'x'.repeat(5000)];
    for (const h of hostile) {
      const r = FB.sanitizeRecord(baseRec({ reason: h, output: { reason: h } }));
      assert(r.reason === '' && r.output.reason === '' && !/evil|script|Ivan|SECRET/.test(JSON.stringify(r)), '22c: an arbitrary reason is never persisted: ' + String(h).slice(0, 30));
    }
    for (const bad of [NaN, Infinity, -Infinity, -1, 1e12, '35', null, {}, [35]]) {
      const r = FB.sanitizeRecord(baseRec({ reason: REASON, durationSec: bad, thresholdSec: bad, output: { durationSec: bad, thresholdSec: bad } }));
      assert(r.durationSec === null && r.thresholdSec === null && r.output.durationSec === null && r.output.thresholdSec === null, '22d: an invalid duration/threshold is not persisted: ' + String(typeof bad === 'object' ? JSON.stringify(bad) : bad));
    }

    // presentation: the choice is explained while the record is live and after completion, never from invalid or inconsistent data
    const liveRec = FB.sanitizeRecord(baseRec({ state: 'saving', reason: REASON, durationSec: 35, thresholdSec: 30, output: { type: 'video', ext: '.mp4', evidence: 'verified_mime', mime: 'video/mp4', durationSec: 35 } }));
    const doneRec = FB.sanitizeRecord(baseRec({ reason: REASON, durationSec: 35, thresholdSec: 30, output: { type: 'video', ext: '.mp4', evidence: 'verified_mime', mime: 'video/mp4', durationSec: 35 } }));
    const policyLine = (rec) => FB.summarize(rec).lines.find((l) => /лимита GIF/.test(l)) || '';
    assert(/35 с/.test(policyLine(liveRec)) && /30 с/.test(policyLine(liveRec)) && /MP4/.test(policyLine(liveRec)), '22e: summarize explains the policy choice while the record is live (saving)');
    assert(/35 с/.test(policyLine(doneRec)) && /MP4/.test(policyLine(doneRec)), '22f: summarize explains the policy choice for the completed record (results and history, notifications or not)');
    for (const [name, rec] of [
      ['no reason', FB.sanitizeRecord(baseRec({ durationSec: 35, thresholdSec: 30 }))],
      ['duration below the threshold', FB.sanitizeRecord(baseRec({ reason: REASON, durationSec: 20, thresholdSec: 30 }))],
      ['duration exactly at the threshold', FB.sanitizeRecord(baseRec({ reason: REASON, durationSec: 30, thresholdSec: 30 }))],
      ['another threshold', FB.sanitizeRecord(baseRec({ reason: REASON, durationSec: 35, thresholdSec: 15 }))],
      ['no duration', FB.sanitizeRecord(baseRec({ reason: REASON, thresholdSec: 30 }))],
      ['failed download', FB.sanitizeRecord(baseRec({ state: 'failed', reason: REASON, durationSec: 35, thresholdSec: 30, failure: { stage: 'download', category: 'unknown' } }))]
    ]) assert(policyLine(rec) === '' && (name === 'failed download' || FB.durationLimitOf(rec) === null), '22g: no policy explanation for: ' + name);

    // tracker: patches are validated too (an invalid patch is ignored and never erases a valid value)
    {
      const m = mem();
      const t = mkTracker(m);
      const id = await t.begin({ site: 'reddit.com', sourceUrl: 'https://preview.redd.it/a.gif?s=1', pageUrl: 'https://www.reddit.com/' });
      await t.stage(id, 'saving', { reason: 'https://evil.example/?token=SECRET', durationSec: NaN, thresholdSec: '30', output: { reason: '<script>', durationSec: Infinity, thresholdSec: -5 } });
      let rec = await t.get(id);
      assert(rec.reason === '' && rec.durationSec === null && rec.thresholdSec === null && rec.output.reason === '' && !/evil|script|SECRET/.test(JSON.stringify(m.store)), '22h: an invalid stage patch is not stored or persisted');
      await t.stage(id, 'saving', policyPatch(35, 30));
      await t.stage(id, 'saving', { reason: 'nonsense', durationSec: 'x', thresholdSec: NaN });
      rec = await t.get(id);
      assert(rec.reason === REASON && rec.durationSec === 35 && rec.thresholdSec === 30 && rec.output.reason === REASON, '22i: a valid patch is stored and a later invalid one does not erase it');
      const id2 = await t.begin({ site: 'reddit.com' });
      await t.attachDownload(id2, 7102, { reason: 'bad reason', durationSec: -3, thresholdSec: 1e99, output: { reason: 'x' } });
      const rec2 = await t.get(id2);
      assert(rec2.reason === '' && rec2.durationSec === null && rec2.thresholdSec === null, '22j: an invalid attachDownload patch is ignored');
    }

    // worker restart before completion: reason, duration and threshold survive hydration and reconciliation; the notice follows completion
    for (const [lang, title, message] of [
      ['en', 'MP4 saved without conversion', 'This animation exceeds the 30-second GIF limit. The source video was saved as MP4.'],
      ['ru', 'MP4 сохранён без конвертации', 'Длительность анимации превышает 30 секунд. Исходное видео сохранено как MP4.']
    ]) {
      const m = mem();
      const first = mkTracker(m);
      const id = await first.begin({ site: 'reddit.com', sourceUrl: 'https://preview.redd.it/long.gif?s=SIG', pageUrl: 'https://www.reddit.com/r/x/' });
      await first.stage(id, 'converting', { conversion: 'reddit_animation_gif', expectedType: 'gif' });
      await first.stage(id, 'saving', policyPatch(35, 30));
      await first.attachDownload(id, 7201, { filename: 'long.mp4' });
      await first.flush();
      const before = await first.get(id);
      assert(before.state === 'saving' && before.reason === REASON && before.threshold === undefined && before.thresholdSec === 30 && before.durationSec === 35, '22k [' + lang + ']: before the restart the live record carries reason 35 s / threshold 30 s');
      const notes = [];
      const second = mkTracker(m, { getDownloadItem: async () => ({ state: 'complete', filename: 'C:\\Users\\u\\Downloads\\long.mp4', fileSize: 4096 }), notify: mkNotifier(notes, { lang }) });
      await second.ready();
      await second.flush();
      const after = await second.get(id);
      assert(after.state === 'complete' && after.reason === REASON && after.durationSec === 35 && after.thresholdSec === 30 && after.output.type === 'video' && after.output.ext === '.mp4' && after.output.durationSec === 35, '22l [' + lang + ']: after hydration and reconciliation the completed record keeps reason, duration, threshold and the MP4 output');
      assert(notes.length === 1 && notes[0].o.title === title && notes[0].o.message === message, '22m [' + lang + ']: one completion notice with the policy copy: ' + (notes[0] && notes[0].o.title));
      await second.downloadTerminal(7201, 'complete');
      await second.flush();
      assert(notes.length === 1, '22n [' + lang + ']: a duplicate completion event makes no second notice');
    }

    // notifications disabled: no toast, the record and its summary still explain the choice (results / history)
    {
      const m = mem();
      const notes = [];
      const t = mkTracker(m, { getDownloadItem: async () => ({ state: 'complete', filename: 'a.mp4', fileSize: 10 }), notify: mkNotifier(notes, { notifySuccess: false }) });
      const id = await t.begin({ site: 'reddit.com' });
      await t.stage(id, 'saving', policyPatch(40, 30));
      await t.attachDownload(id, 7301, { filename: 'a.mp4' });
      await t.flush();
      const rec = await t.get(id);
      assert(notes.length === 0 && rec.state === 'complete' && /40 с/.test(policyLine(rec)), '22o: with success notifications disabled there is no toast and the result still explains why MP4 was saved');
    }

    // the persisted result: a restart keeps the explanation, and a tampered stored reason is dropped on load
    {
      const m = mem();
      const t = mkTracker(m);
      const id = await t.begin({ site: 'reddit.com' });
      await t.stage(id, 'saving', policyPatch(35, 30));
      await t.flush();
      const key = ctx.ImageSaverFeedbackTracker.STORAGE_KEY;
      const stored = m.store[key].ops.find((r) => r.id === id);
      assert(stored.reason === REASON && stored.durationSec === 35 && stored.thresholdSec === 30 && stored.output.reason === REASON, '22q: the stored result keeps reason, duration and threshold');
      stored.reason = 'https://evil.example/?token=SECRET';
      stored.output.reason = 'javascript:alert(1)';
      const reloaded = mkTracker(m);
      await reloaded.ready();
      const tampered = await reloaded.get(id);
      assert(tampered.reason === '' && !/evil|SECRET/.test(JSON.stringify(tampered)) && policyLine(tampered) === '', '22s: a tampered stored reason is dropped on load');
    }

    // the notifier decides from the validated policy explanation of the record, never from a raw reason alone
    {
      const notes = [];
      const notify = mkNotifier(notes);
      const rawRecords = [
        { reason: REASON, durationSec: 20, thresholdSec: 30 },
        { reason: REASON },
        { reason: REASON, durationSec: NaN, thresholdSec: 30 },
        { reason: 'https://evil.example/?token=SECRET', durationSec: 35, thresholdSec: 30 }
      ];
      for (const raw of rawRecords) await notify(Object.assign(FB.sanitizeRecord(baseRec({ output: { type: 'video', ext: '.mp4', evidence: 'verified_mime', mime: 'video/mp4' } })), raw));
      assert(notes.length === 4 && notes.every((n) => n.o.title !== 'MP4 saved without conversion' && !/30-second|evil|SECRET/.test(n.o.message)), '22t2: a raw reason without a valid measured duration above the threshold never selects the policy notice');
    }

    // other outcomes never show the policy notice
    {
      const m = mem();
      const notes = [];
      const t = mkTracker(m, { notify: mkNotifier(notes) });
      const id = await t.begin({ site: 'reddit.com' });
      await t.stage(id, 'saving', policyPatch(35, 30));
      await t.attachDownload(id, 7401, { filename: 'a.mp4' });
      await t.downloadTerminal(7401, 'interrupted', 'NETWORK_FAILED');
      await t.flush();
      assert(notes.length === 1 && notes[0].o.title !== 'MP4 saved without conversion' && !/MP4/.test(notes[0].o.message), '22t: an interrupted download shows the failure, not the policy notice');
    }
  }

  // =================================================================================================
  console.log('\n--- 23. A failed startup read of the operation list never overwrites the stored operations ---');
  {
    // Worker start (hydrate) reads the stored list once. If that read is rejected, the first mutation used to persist only the new operation
    // over the stored list: an unseen failure and a running download (still owned, its terminal event may come later) were erased.
    const ctx = (() => { const s = { console }; vm.createContext(s); for (const f of ['lib/feedback.js', 'lib/feedback_tracker.js']) vm.runInContext(read(f), s); return vm.runInContext('globalThis', s); })();
    const KEY = ctx.ImageSaverFeedbackTracker.STORAGE_KEY;
    const T0 = 1700000000000;
    const stored = () => ({ v: 1, ops: [
      { id: 'op-oldfail', createdAt: T0, updatedAt: T0, state: 'failed', seen: false, site: 'reddit.com', failure: { stage: 'resolve', category: 'not_found', code: 'NOT_FOUND', status: null, downloadError: '' } },
      { id: 'op-running', createdAt: T0, updatedAt: T0, state: 'saving', site: 'x.com', downloadId: 7501 }
    ] });
    const mk = ({ getFailures }) => {
      const store = { [KEY]: stored() };
      let reads = 0;
      const items = { 7501: { id: 7501, state: 'complete', filename: 'C:/d/x.mp4', fileSize: 10 } };
      const t = ctx.ImageSaverFeedbackTracker.createTracker({
        storage: { get: async (k) => { reads++; if (reads <= getFailures) throw new Error('UNREADABLE'); return store[k]; }, set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
        now: () => T0 + 1000, genId: (() => { let n = 0; return () => 'op-new' + (++n) + 'abc'; })(),
        getDownloadItem: async (id) => items[id] || null, peekEarlyTerminal: () => undefined, notify: async () => {}, log: () => {}
      });
      return { t, store };
    };

    // one rejected read at start: the next operation sees and keeps the stored list, and the running download is reconciled
    {
      const { t, store } = mk({ getFailures: 1 });
      const id = await t.begin({ site: 'example.com' });
      const listed = await t.list();
      const ids = listed.map((r) => r.id);
      const persisted = (store[KEY].ops || []).map((r) => r.id);
      assert(['op-oldfail', 'op-running', id].every((x) => ids.includes(x) && persisted.includes(x)), '23a: after a failed start read the stored operations survive next to the new one: ' + JSON.stringify({ ids, persisted }));
      const old = listed.find((r) => r.id === 'op-oldfail');
      assert(old && old.state === 'failed' && old.seen === false && t.unseenFailureCount() === 1, '23b: the stored unseen failure stays unseen');
      const run = listed.find((r) => r.id === 'op-running');
      assert(run && run.state === 'complete', '23c: the stored running download is reconciled from its own download item: ' + (run && run.state));
      const fresh = listed.find((r) => r.id === id);
      assert(fresh && fresh.state === 'resolving', '23d: the operation created meanwhile is not treated as a restarted one: ' + (fresh && fresh.state));
    }
    // the store stays unreadable: nothing is written over it, the in-memory operation still works
    {
      const { t, store } = mk({ getFailures: Infinity });
      const before = JSON.stringify(store[KEY]);
      const id = await t.begin({ site: 'example.com' });
      await t.fail(id, { stage: 'resolve', code: 'NOT_FOUND' });
      await t.flush();
      assert(JSON.stringify(store[KEY]) === before, '23e: an unreadable store is never overwritten by a partial list');
      const listed = await t.list();
      assert(listed.length === 1 && listed[0].id === id && listed[0].state === 'failed', '23f: the new operation is still tracked in memory');
    }
    // nearest positive: a readable store behaves as before
    {
      const { t, store } = mk({ getFailures: 0 });
      const id = await t.begin({ site: 'example.com' });
      const persisted = (store[KEY].ops || []).map((r) => r.id);
      assert(persisted.length === 3 && persisted.includes(id) && (await t.list()).find((r) => r.id === 'op-running').state === 'complete', '23g: a readable store hydrates and reconciles as before');
    }
  }

  // =================================================================================================
  console.log('\n--- 24. Operations kept in memory while the store was unreadable are persisted once it can be read ---');
  {
    // While the start read fails nothing is written (23e). The first successful read merges the stored list with the operations of this
    // worker; that merged list must be written then, even when the recovering call only reads (list/get) and no stored record needed a
    // change, or a later worker restart loses the operations created meanwhile.
    const ctx = (() => { const s = { console }; vm.createContext(s); for (const f of ['lib/feedback.js', 'lib/feedback_tracker.js']) vm.runInContext(read(f), s); return vm.runInContext('globalThis', s); })();
    const API = ctx.ImageSaverFeedbackTracker;
    const KEY = API.STORAGE_KEY;
    const T0 = 1700000000000;
    const oldTerminal = { id: 'op-oldfail', createdAt: T0, updatedAt: T0, state: 'failed', seen: true, site: 'reddit.com', failure: { stage: 'resolve', category: 'not_found', code: 'NOT_FOUND', status: null, downloadError: '' } };
    const world = (initial) => {
      const store = initial === undefined ? {} : { [KEY]: { v: 1, ops: initial } };
      const env = { readable: false, writes: 0, store };
      env.storage = {
        get: async (k) => { if (!env.readable) throw new Error('UNREADABLE'); return store[k] === undefined ? undefined : JSON.parse(JSON.stringify(store[k])); },
        set: async (k, v) => { env.writes++; store[k] = JSON.parse(JSON.stringify(v)); }
      };
      let n = 0;
      env.make = () => API.createTracker({ storage: env.storage, now: () => T0 + 1000, genId: () => 'op-new' + (++n) + 'abc',
        getDownloadItem: async () => undefined, peekEarlyTerminal: () => undefined, notify: async () => {}, log: () => {} });
      return env;
    };
    const ids = (list) => list.map((r) => r.id).sort();

    for (const [label, initial, recover] of [
      ['terminal-only store, list()', [oldTerminal], (t) => t.list()],
      ['empty store, list()', undefined, (t) => t.list()],
      ['terminal-only store, get()', [oldTerminal], (t, id) => t.get(id)]
    ]) {
      const env = world(initial);
      const t = env.make();
      await t.ready();
      const failedId = await t.begin({ site: 'example.com' });
      await t.fail(failedId, { stage: 'resolve', code: 'NOT_FOUND' });
      const runningId = await t.begin({ site: 'example.com' });
      await t.flush();
      assert(env.writes === 0, `24a (${label}): nothing is written while the store is unreadable`);
      env.readable = true;
      await recover(t, failedId);
      await t.flush();
      const stored = (env.store[KEY] && env.store[KEY].ops) || [];
      const want = (initial ? ['op-oldfail'] : []).concat([failedId, runningId]).sort();
      assert(env.writes > 0 && JSON.stringify(ids(stored)) === JSON.stringify(want), `24b (${label}): the first successful read writes the merged list: ` + JSON.stringify(ids(stored)));
      const mine = (await t.list()).find((r) => r.id === runningId);
      assert(mine && mine.state === 'resolving', `24c (${label}): an operation of this worker is not reconciled as restarted: ` + (mine && mine.state));
      const nf = stored.find((r) => r.id === failedId);
      assert(nf && nf.state === 'failed' && nf.failure && nf.failure.code === 'NOT_FOUND' && nf.seen === false, `24d (${label}): the stored new failure keeps its own outcome and stays unseen`);
      const next = env.make();
      const after = await next.list();
      assert(after.some((r) => r.id === failedId && r.state === 'failed'), `24e (${label}): another tracker instance (worker restart) still has the new failure: ` + JSON.stringify(ids(after)));
    }
    // reads stay unavailable: read-only calls never write either
    {
      const env = world([oldTerminal]);
      const t = env.make();
      const id = await t.begin({ site: 'example.com' });
      await t.fail(id, { stage: 'resolve', code: 'NOT_FOUND' });
      await t.list();
      await t.get(id);
      await t.flush();
      assert(env.writes === 0 && JSON.stringify(env.store[KEY].ops.map((r) => r.id)) === '["op-oldfail"]', '24f: an unreadable store is never written, also not by list/get');
    }
    // a normal start (readable at once) writes nothing extra for a read-only call
    {
      const env = world([oldTerminal]);
      env.readable = true;
      const t = env.make();
      await t.list();
      await t.flush();
      assert(env.writes === 0, '24g: a readable start without changes performs no write');
    }
  }

  // =================================================================================================
  console.log('\n--- 25. F08: feedback retention pruning and active operation preservation ---');
  {
    const ctx = (() => { const s = { console }; vm.createContext(s); for (const f of ['lib/feedback.js', 'lib/feedback_tracker.js']) vm.runInContext(read(f), s); return vm.runInContext('globalThis', s); })();
    const KEY = ctx.ImageSaverFeedbackTracker.STORAGE_KEY;
    const T0 = 1700000000000;
    const DAY = 24 * 60 * 60 * 1000;
    const expiredTime = T0 - (DAY + 60000); // 1 minute past 24-hour retention window
    const recentTime = T0 - 60000;         // 1 minute ago

    // 25a: expired terminal records do not survive hydration into list(), get() or unseenFailureCount()
    {
      const store = {
        [KEY]: {
          v: 1,
          ops: [
            { id: 'op-exp-complete', state: 'complete', createdAt: expiredTime, updatedAt: expiredTime, site: 'example.com' },
            { id: 'op-exp-failed', state: 'failed', seen: false, createdAt: expiredTime, updatedAt: expiredTime, site: 'example.com' },
            { id: 'op-valid-term', state: 'complete', createdAt: recentTime, updatedAt: recentTime, site: 'example.com' },
            { id: 'op-valid-active', state: 'saving', downloadId: 101, createdAt: recentTime, updatedAt: recentTime, site: 'example.com' }
          ]
        }
      };
      let n = 0;
      const t = ctx.ImageSaverFeedbackTracker.createTracker({
        storage: { get: async (k) => store[k], set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
        now: () => T0,
        genId: () => 'op-gen-' + (++n),
        getDownloadItem: async () => undefined,
        peekEarlyTerminal: () => undefined,
        notify: async () => {},
        log: () => {}
      });

      const list = await t.list();
      assert(!list.some((o) => o.id === 'op-exp-complete'), '25a1: expired complete record pruned on hydration list()');
      assert(!list.some((o) => o.id === 'op-exp-failed'), '25a2: expired failed record pruned on hydration list()');
      assert(list.some((o) => o.id === 'op-valid-term'), '25a3: unexpired terminal record kept on hydration list()');
      assert(list.some((o) => o.id === 'op-valid-active'), '25a4: active in-flight record kept on hydration list()');
      assert((await t.get('op-exp-complete')) === null, '25a5: get() returns null for expired terminal record');
      assert((await t.get('op-exp-failed')) === null, '25a6: get() returns null for expired failed record');
      assert(t.unseenFailureCount() === 0, '25a7: unseenFailureCount() excludes expired failures');
    }

    // 25b: terminal records that expire in-memory while idle are pruned on list() and get()
    {
      const clock = { v: T0 };
      const store = {};
      let n = 0;
      const t = ctx.ImageSaverFeedbackTracker.createTracker({
        storage: { get: async (k) => store[k], set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
        now: () => clock.v,
        genId: () => 'op-idle-' + (++n),
        getDownloadItem: async () => undefined,
        peekEarlyTerminal: () => undefined,
        notify: async () => {},
        log: () => {}
      });

      const id = await t.begin({ site: 'example.com' });
      await t.fail(id, { stage: 'resolve', code: 'NETWORK_ERR' });
      assert((await t.list()).length === 1, '25b1: freshly failed record in list');
      assert(t.unseenFailureCount() === 1, '25b2: unseen failure counts while unexpired');

      // Advance clock past 24h retention window without intervening mutations
      clock.v += DAY + 1000;
      assert((await t.list()).length === 0, '25b3: record pruned on list() once expired in memory');
      assert((await t.get(id)) === null, '25b4: get() returns null once record expired');
      assert(t.unseenFailureCount() === 0, '25b5: unseen failure count 0 once record expired');
    }

    // 25c: maxOps trimming evicts terminal records but preserves active operations without silent discard
    {
      const store = {};
      let n = 0;
      const t = ctx.ImageSaverFeedbackTracker.createTracker({
        storage: { get: async (k) => store[k], set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
        now: () => T0,
        genId: () => 'op-act-' + (++n),
        getDownloadItem: async () => undefined,
        peekEarlyTerminal: () => undefined,
        notify: async () => {},
        log: () => {}
      });

      // Start 20 active operations (saturating maxOps)
      const activeIds = [];
      for (let i = 0; i < 20; i++) {
        const id = await t.begin({ site: 'example.com' });
        activeIds.push(id);
      }
      assert((await t.list()).length === 20, '25c1: 20 active operations tracked');

      // Start the 21st active operation
      const id21 = await t.begin({ site: 'example.com' });
      activeIds.push(id21);
      const list21 = await t.list();
      assert(list21.length === 21, '25c2: active operations exceed maxOps without dropping in-flight work');
      assert(list21.some((o) => o.id === activeIds[0]), '25c3: oldest active operation was NOT silently discarded');
      assert(await t.get(activeIds[0]) !== null, '25c4: oldest active operation still retrievable via get()');

      // Complete the first operation (now terminal)
      await t.attachDownload(activeIds[0], 2001);
      await t.downloadTerminal(2001, 'complete');

      // Start the 22nd operation: eviction should now reclaim the terminal operation
      const id22 = await t.begin({ site: 'example.com' });
      const list22 = await t.list();
      assert(!list22.some((o) => o.id === activeIds[0]), '25c5: terminal operation evicted when capacity exceeded');
      assert(list22.some((o) => o.id === id22), '25c6: newest operation tracked');
      // All remaining 21 active operations are still intact
      for (let i = 1; i < activeIds.length; i++) {
        assert(list22.some((o) => o.id === activeIds[i]), `25c7: active op ${activeIds[i]} preserved`);
      }
    }
  }

  // =================================================================================================
  console.log('\n--- 26. F4: acknowledge only the displayed failure snapshot ---');
  {
    const env = makeEnv();
    await env.ready();
    const tracker = env.sandbox.feedbackTracker;
    const extSender = { id: 'testid', url: 'chrome-extension://testid/popup/popup.html' };

    const failedIds = [];
    for (let i = 0; i < 7; i++) {
      const id = await tracker.begin({ site: 'example.com' });
      await tracker.fail(id, { stage: 'resolve', code: 'NETWORK_ERR' });
      failedIds.push(id);
    }
    assert(tracker.unseenFailureCount() === 7, '26a: 7 unseen failures initially');
    assert((await env.sandbox.getUnseenFailureCount()) === 7, '26b: background sees 7 unseen failures');

    const sentMessages = [];
    const uiChrome = {
      runtime: {
        getManifest: () => ({ version: '2.0.0' }),
        getURL: (p) => `chrome-extension://testid/${p}`,
        sendMessage: (msg) => new Promise((resolve) => {
          sentMessages.push(msg);
          let responded = false;
          for (const l of env.messageListeners) {
            const keep = l(msg, extSender, (resp) => { responded = true; resolve(resp); });
            if (keep === true || responded) break;
          }
          if (!responded) setTimeout(() => resolve(undefined), 0);
        })
      },
      storage: {
        session: {
          get: async () => env.session,
          set: async (v) => Object.assign(env.session, v)
        },
        local: {
          get: async () => env.local,
          set: async (v) => Object.assign(env.local, v)
        },
        onChanged: { addListener() {} }
      }
    };

    const list = createFeedbackList({ chrome: uiChrome, FB: FBLib }, { limit: 5, visible: true });
    await list.start();

    assert(list.store.getState().records.length === 5, '26c: controller displays exactly 5 records');
    const markSeenMsgs = sentMessages.filter((m) => m.action === 'FEEDBACK_MARK_SEEN');
    assert(markSeenMsgs.length === 1, '26d: FEEDBACK_MARK_SEEN sent exactly once');
    assert(Array.isArray(markSeenMsgs[0].ids) && markSeenMsgs[0].ids.length === 5, '26e: payload contains exactly the 5 displayed IDs');
    assert(tracker.unseenFailureCount() === 2, '26f: exactly 2 hidden failures remain unseen in tracker');
    assert((await env.sandbox.getUnseenFailureCount()) === 2, '26g: badge count is 2 (only displayed failures acknowledged)');

    const sendExtMessage = (msg, sender = extSender) => new Promise((resolve) => {
      let responded = false;
      for (const l of env.messageListeners) {
        const keep = l(msg, sender, (resp) => {
          responded = true;
          resolve(resp);
        });
        if (keep === true || responded) break;
      }
      if (!responded) setTimeout(() => resolve(undefined), 0);
    });

    const lateId = await tracker.begin({ site: 'example.com' });
    await tracker.fail(lateId, { stage: 'resolve', code: 'LATE_ERR' });
    assert(tracker.unseenFailureCount() === 3, '26h: late failure remains unseen (now 3 unseen)');

    const hiddenList = createFeedbackList({ chrome: uiChrome, FB: FBLib }, { limit: 5, visible: false });
    const countBeforeHidden = sentMessages.filter((m) => m.action === 'FEEDBACK_MARK_SEEN').length;
    await hiddenList.start();
    assert(sentMessages.filter((m) => m.action === 'FEEDBACK_MARK_SEEN').length === countBeforeHidden, '26i: hidden list sends no acknowledgement');

    const disposedList = createFeedbackList({ chrome: uiChrome, FB: FBLib }, { limit: 5, visible: true });
    disposedList.dispose();
    await disposedList.start();
    assert(sentMessages.filter((m) => m.action === 'FEEDBACK_MARK_SEEN').length === countBeforeHidden, '26j: disposed list sends no acknowledgement');

    const respUnknown = await sendExtMessage({ action: 'FEEDBACK_MARK_SEEN', ids: ['non-existent-id', 'another-fake'] });
    assert(respUnknown?.success === true && tracker.unseenFailureCount() === 3, '26k: unknown IDs do not alter unseen count');

    const respDupes = await sendExtMessage({ action: 'FEEDBACK_MARK_SEEN', ids: [lateId, lateId, lateId] });
    assert(respDupes?.success === true && tracker.unseenFailureCount() === 2, '26l: duplicate IDs acknowledge the item once');

    const oversizeId = 'a'.repeat(200);
    const respMalformed = await sendExtMessage({ action: 'FEEDBACK_MARK_SEEN', ids: [oversizeId, 12345, null, {}] });
    assert(respMalformed?.success === true && tracker.unseenFailureCount() === 2, '26m: malformed/oversized IDs are ignored');

    const respNoIds = await sendExtMessage({ action: 'FEEDBACK_MARK_SEEN' });
    assert(respNoIds?.success === true && tracker.unseenFailureCount() === 2, '26n: missing ids array acknowledges nothing (no fallback)');

    const rogueSender = { id: 'other-extension-id', url: 'chrome-extension://other/popup.html' };
    const respForbidden = await sendExtMessage({ action: 'FEEDBACK_MARK_SEEN', ids: [lateId] }, rogueSender);
    assert(respForbidden?.success === false && respForbidden?.error === 'FORBIDDEN', '26o: unauthorized sender is rejected');

    // 6. Failed acknowledgement remains retryable only for applicable visible snapshot
    // Add 1 fresh failure so it is at index 0 of displayed list
    const retryFailId = await tracker.begin({ site: 'example.com' });
    await tracker.fail(retryFailId, { stage: 'resolve', code: 'RETRY_FAIL_ERR' });
    assert(tracker.unseenFailureCount() === 3, '26p1: fresh failure is unseen');

    let failAck = true;
    const retryMessages = [];
    const failUiChrome = {
      runtime: {
        getManifest: () => ({ version: '2.0.0' }),
        getURL: (p) => `chrome-extension://testid/${p}`,
        sendMessage: (msg) => new Promise((resolve) => {
          retryMessages.push(msg);
          if (msg.action === 'FEEDBACK_MARK_SEEN' && failAck) {
            return resolve({ success: false });
          }
          let responded = false;
          for (const l of env.messageListeners) {
            const keep = l(msg, extSender, (resp) => { responded = true; resolve(resp); });
            if (keep === true || responded) break;
          }
          if (!responded) setTimeout(() => resolve(undefined), 0);
        })
      },
      storage: uiChrome.storage
    };

    const retryList = createFeedbackList({ chrome: failUiChrome, FB: FBLib }, { limit: 5, visible: true });
    await retryList.start();
    assert(retryMessages.filter((m) => m.action === 'FEEDBACK_MARK_SEEN').length === 1, '26p: mark seen attempted');
    assert(tracker.unseenFailureCount() === 3, '26q: acknowledgement failed so unseen count unchanged');

    failAck = false;
    retryList.setVisible(false);
    retryList.setVisible(true);
    await new Promise((r) => setTimeout(r, 20));
    assert(retryMessages.filter((m) => m.action === 'FEEDBACK_MARK_SEEN').length === 2, '26r: retried acknowledgement on visibility');
    assert(tracker.unseenFailureCount() === 2, '26s: retried snapshot successfully acknowledged');

    const fullList = createFeedbackList({ chrome: uiChrome, FB: FBLib }, { limit: 50, visible: true });
    await fullList.start();
    assert(tracker.unseenFailureCount() === 0, '26t: full page with limit=50 acknowledges cleanly');

    // 26u: Hidden refresh pushes old IDs below limit; visible acknowledges only the 5 displayed IDs
    {
      const envU = makeEnv();
      await envU.ready();
      const trackerU = envU.sandbox.feedbackTracker;
      const uIds = [];
      for (let i = 0; i < 7; i++) {
        const id = await trackerU.begin({ site: 'reddit' });
        await trackerU.fail(id, { stage: 'resolve', code: 'NO_MEDIA' });
        uIds.push(id);
      }
      assert(trackerU.unseenFailureCount() === 7, '26u1: 7 failures initially unseen');

      let ackPromiseU;
      const acksU = [];
      const uiChromeU = {
        runtime: {
          getManifest: () => ({ version: '2.0.0.24' }),
          getURL: (p) => `chrome-extension://testid/${p}`,
          sendMessage: (msg) => {
            const resp = (async () => {
              if (msg.action === 'FEEDBACK_MARK_SEEN') {
                acksU.push([...msg.ids]);
                await trackerU.markSeen(msg.ids);
              }
              return { success: true, records: await trackerU.list() };
            })();
            if (msg.action === 'FEEDBACK_MARK_SEEN') ackPromiseU = resp;
            return resp;
          }
        },
        storage: {
          session: { get: async () => envU.session, set: async (v) => Object.assign(envU.session, v) },
          local: { get: async () => envU.local, set: async (v) => Object.assign(envU.local, v) },
          onChanged: { addListener() {} }
        }
      };

      const hiddenUi = createFeedbackList({ chrome: uiChromeU, FB: FBLib }, { limit: 5, visible: false });
      await hiddenUi.start();
      assert(acksU.length === 0, '26u2: hidden list sends no acknowledgement on start');

      // Add 2 more failures while hidden
      for (let i = 0; i < 2; i++) {
        const id = await trackerU.begin({ site: 'reddit' });
        await trackerU.fail(id, { stage: 'resolve', code: 'NO_MEDIA' });
        uIds.push(id);
      }
      assert(trackerU.unseenFailureCount() === 9, '26u3: 9 failures total unseen');

      await hiddenUi.start(); // refresh while still hidden
      assert(acksU.length === 0, '26u4: hidden refresh sends no acknowledgement');

      const displayedIds = hiddenUi.store.getState().records.map((r) => r.id);
      assert(displayedIds.length === 5, '26u5: snapshot displays top 5 failures');

      hiddenUi.setVisible(true);
      await ackPromiseU;

      const flatAcks = acksU.flat();
      const hiddenAcked = flatAcks.filter((id) => !displayedIds.includes(id));
      assert(hiddenAcked.length === 0, `26u6: no hidden IDs acknowledged (got ${hiddenAcked.length})`);
      assert(flatAcks.length === 5, `26u7: exactly 5 visible IDs acknowledged (got ${flatAcks.length})`);
      assert(trackerU.unseenFailureCount() === 4, `26u8: 4 older unviewed failures remain unseen (got ${trackerU.unseenFailureCount()})`);
      assert((await envU.sandbox.getUnseenFailureCount()) === 4, '26u9: toolbar badge count matches remaining 4 unseen');

      hiddenUi.dispose();
    }

    // 26v: Failed acknowledgement followed by a newer applicable snapshot
    {
      const envV = makeEnv();
      await envV.ready();
      const trackerV = envV.sandbox.feedbackTracker;
      const vIds = [];
      for (let i = 0; i < 5; i++) {
        const id = await trackerV.begin({ site: 'reddit' });
        await trackerV.fail(id, { stage: 'resolve', code: 'ERR_INIT' });
        vIds.push(id);
      }
      assert(trackerV.unseenFailureCount() === 5, '26v1: 5 initial failures');

      let failAckV = true;
      let ackAttemptV = null;
      const acksV = [];
      const uiChromeV = {
        runtime: {
          getManifest: () => ({ version: '2.0.0.24' }),
          getURL: (p) => `chrome-extension://testid/${p}`,
          sendMessage: (msg) => {
            const resp = (async () => {
              if (msg.action === 'FEEDBACK_MARK_SEEN') {
                acksV.push([...msg.ids]);
                if (failAckV) return { success: false };
                await trackerV.markSeen(msg.ids);
              }
              return { success: true, records: await trackerV.list() };
            })();
            if (msg.action === 'FEEDBACK_MARK_SEEN') ackAttemptV = resp;
            return resp;
          }
        },
        storage: {
          session: { get: async () => envV.session, set: async (v) => Object.assign(envV.session, v) },
          local: { get: async () => envV.local, set: async (v) => Object.assign(envV.local, v) },
          onChanged: { addListener() {} }
        }
      };

      const liveList = createFeedbackList({ chrome: uiChromeV, FB: FBLib }, { limit: 5, visible: true });
      await liveList.start();
      assert(acksV.length === 1, '26v2: acknowledgement attempted initially');
      assert(trackerV.unseenFailureCount() === 5, '26v3: failed acknowledgement leaves all 5 unseen');

      // Now add 2 newer failures, pushing 2 of the previous failures below limit
      for (let i = 0; i < 2; i++) {
        const id = await trackerV.begin({ site: 'reddit' });
        await trackerV.fail(id, { stage: 'resolve', code: 'ERR_NEW' });
        vIds.push(id);
      }
      assert(trackerV.unseenFailureCount() === 7, '26v4: 7 unseen failures total');

      // Acknowledgement now succeeds on refresh
      failAckV = false;
      await liveList.start();
      await ackAttemptV;

      assert(acksV.length === 2, '26v5: second acknowledgement attempt occurred');
      const latestAckPayload = acksV[1];
      const currentDisplayed = liveList.store.getState().records.map((r) => r.id);
      assert(currentDisplayed.length === 5, '26v6: current snapshot has 5 items');
      // The payload must NOT include the 2 pushed-off old IDs
      const pushedOffIds = vIds.slice(0, 2); // the two oldest IDs
      const leakedPushedOff = latestAckPayload.filter((id) => pushedOffIds.includes(id));
      assert(leakedPushedOff.length === 0, `26v7: pushed-off IDs not acknowledged on newer snapshot (leaked: ${leakedPushedOff})`);
      assert(latestAckPayload.length === 5, `26v8: payload contains only the 5 currently visible items (got ${latestAckPayload.length})`);
      assert(trackerV.unseenFailureCount() === 2, `26v9: 2 older unviewed failures remain unseen (got ${trackerV.unseenFailureCount()})`);
      assert((await envV.sandbox.getUnseenFailureCount()) === 2, '26v10: toolbar badge count matches remaining 2 unseen');

      liveList.dispose();
    }
  }

  // =================================================================================================
  console.log('\n--- 27. F6: persist successful retention pruning ---');
  {
    const ctx = (() => { const s = { console }; vm.createContext(s); for (const f of ['lib/feedback.js', 'lib/feedback_tracker.js']) vm.runInContext(read(f), s); return vm.runInContext('globalThis', s); })();
    const STORAGE_KEY = ctx.ImageSaverFeedbackTracker.STORAGE_KEY;
    const DAY = 24 * 60 * 60 * 1000;
    const T0 = 1700000000000;

    // 27a: Central reproduction: 7 terminal records, 25h passes, fresh tracker hydrates and persists cleanup
    {
      const clock = { v: T0 };
      const expiredOps = [];
      for (let i = 0; i < 7; i++) {
        expiredOps.push(FBLib.sanitizeRecord({
          id: `op-exp-${i}`,
          createdAt: T0,
          updatedAt: T0,
          state: 'complete',
          site: 'example.com'
        }));
      }
      let writeCount = 0;
      let lastWritten = null;
      const store = {
        [STORAGE_KEY]: { v: FBLib.SCHEMA_VERSION, ops: expiredOps }
      };
      const storage = {
        get: async (k) => store[k],
        set: async (k, v) => {
          writeCount++;
          lastWritten = JSON.parse(JSON.stringify(v));
          store[k] = lastWritten;
        }
      };

      // Advance clock 25 hours
      clock.v = T0 + 25 * 3600 * 1000;

      const t = ctx.ImageSaverFeedbackTracker.createTracker({
        storage,
        now: () => clock.v,
        genId: () => 'op-new',
        getDownloadItem: async () => undefined,
        peekEarlyTerminal: () => undefined,
        notify: async () => {},
        log: () => {}
      });

      await t.ready();
      const listed = await t.list();
      assert(listed.length === 0, '27a1: 0 records listed after 25h expiry');
      assert(writeCount === 1, '27a2: pruned snapshot was persisted to storage (writeCount === 1)');
      assert(Array.isArray(store[STORAGE_KEY]?.ops) && store[STORAGE_KEY].ops.length === 0, '27a3: storage holds 0 ops after pruning write');
    }

    // 27b: Clean hydration with valid unexpired records does not perform an unnecessary write
    {
      const clock = { v: T0 };
      const validOps = [
        FBLib.sanitizeRecord({
          id: 'op-valid-1',
          createdAt: T0,
          updatedAt: T0,
          state: 'complete',
          site: 'example.com'
        })
      ];
      let writeCount = 0;
      const store = {
        [STORAGE_KEY]: { v: FBLib.SCHEMA_VERSION, ops: validOps }
      };
      const storage = {
        get: async (k) => store[k],
        set: async (k, v) => { writeCount++; store[k] = JSON.parse(JSON.stringify(v)); }
      };

      const t = ctx.ImageSaverFeedbackTracker.createTracker({
        storage,
        now: () => clock.v,
        genId: () => 'op-new',
        getDownloadItem: async () => undefined,
        peekEarlyTerminal: () => undefined,
        notify: async () => {},
        log: () => {}
      });

      await t.ready();
      const listed = await t.list();
      assert(listed.length === 1, '27b1: unexpired record listed');
      assert(writeCount === 0, '27b2: clean hydration performed zero writes');
      const item = await t.get('op-valid-1');
      assert(item !== null && writeCount === 0, '27b3: get() on unexpired record performed zero writes');
    }

    // 27c: In-memory expiry pruning via list() and get() persists cleanup
    {
      const clock = { v: T0 };
      let writeCount = 0;
      const store = {};
      const storage = {
        get: async (k) => store[k],
        set: async (k, v) => { writeCount++; store[k] = JSON.parse(JSON.stringify(v)); }
      };

      let n = 0;
      const t = ctx.ImageSaverFeedbackTracker.createTracker({
        storage,
        now: () => clock.v,
        genId: () => `op-live-${++n}`,
        getDownloadItem: async () => undefined,
        peekEarlyTerminal: () => undefined,
        notify: async () => {},
        log: () => {}
      });

      const id1 = await t.begin({ site: 'example.com' });
      await t.stage(id1, 'saving', {});
      await t.attachDownload(id1, 101);
      await t.downloadTerminal(101, 'complete');

      const id2 = await t.begin({ site: 'example.com' });
      await t.stage(id2, 'saving', {});
      await t.attachDownload(id2, 102);
      await t.downloadTerminal(102, 'complete');

      const writesAfterCreate = writeCount;
      assert((await t.list()).length === 2, '27c1: 2 records currently tracked');

      // Advance clock past 24h retention window
      clock.v += DAY + 1000;

      // list() triggers evict() and persists
      const listedAfterExpiry = await t.list();
      assert(listedAfterExpiry.length === 0, '27c2: records pruned on list()');
      assert(writeCount === writesAfterCreate + 1, '27c3: list() pruning was persisted');
      assert(store[STORAGE_KEY].ops.length === 0, '27c4: stored ops length is 0');

      // get() on an expired record also persists if not already pruned
      clock.v = T0;
      const t2 = ctx.ImageSaverFeedbackTracker.createTracker({
        storage,
        now: () => clock.v,
        genId: () => `op-get-${++n}`,
        getDownloadItem: async () => undefined,
        peekEarlyTerminal: () => undefined,
        notify: async () => {},
        log: () => {}
      });
      const id3 = await t2.begin({ site: 'example.com' });
      await t2.attachDownload(id3, 103);
      await t2.downloadTerminal(103, 'complete');
      const writesBeforeGetPrune = writeCount;

      clock.v += DAY + 1000;
      const got = await t2.get(id3);
      assert(got === null, '27c5: get() returns null for expired record');
      assert(writeCount === writesBeforeGetPrune + 1, '27c6: get() persisted the eviction');
    }

    // 27d: Persistent failed reads never overwrite stored list; later successful recovery persists merged list
    {
      const clock = { v: T0 };
      const initialOps = [
        FBLib.sanitizeRecord({
          id: 'op-init-1',
          createdAt: T0,
          updatedAt: T0,
          state: 'complete',
          site: 'example.com'
        })
      ];
      const store = {
        [STORAGE_KEY]: { v: FBLib.SCHEMA_VERSION, ops: initialOps }
      };
      let failGet = true;
      let setAttempts = 0;
      const storage = {
        get: async (k) => {
          if (failGet) throw new Error('READ_FAIL');
          return store[k];
        },
        set: async (k, v) => {
          setAttempts++;
          store[k] = JSON.parse(JSON.stringify(v));
        }
      };

      const t = ctx.ImageSaverFeedbackTracker.createTracker({
        storage,
        now: () => clock.v,
        genId: () => 'op-failread-1',
        getDownloadItem: async () => undefined,
        peekEarlyTerminal: () => undefined,
        notify: async () => {},
        log: () => {}
      });

      // Begin operation while storage is unreadable
      const newId = await t.begin({ site: 'example.com' });
      assert(setAttempts === 0, '27d1: unreadable store is never overwritten on begin');
      assert(store[STORAGE_KEY].ops.length === 1 && store[STORAGE_KEY].ops[0].id === 'op-init-1', '27d2: stored list preserved intact');

      // Now storage becomes readable
      failGet = false;
      const listed = await t.list();
      assert(listed.length === 2, '27d3: successful read merges stored and in-memory operations');
      assert(setAttempts === 1, '27d4: deferred persist writes merged list once storage is readable');
      assert(store[STORAGE_KEY].ops.length === 2, '27d5: store contains both ops');
    }

    // 27e: Failed cleanup write does not crash tracker
    {
      const clock = { v: T0 };
      const expiredOps = [
        FBLib.sanitizeRecord({
          id: 'op-exp-err',
          createdAt: T0,
          updatedAt: T0,
          state: 'complete',
          site: 'example.com'
        })
      ];
      const store = {
        [STORAGE_KEY]: { v: FBLib.SCHEMA_VERSION, ops: expiredOps }
      };
      const storage = {
        get: async (k) => store[k],
        set: async () => { throw new Error('STORAGE_WRITE_FAILURE'); }
      };

      clock.v = T0 + 25 * 3600 * 1000;
      const t = ctx.ImageSaverFeedbackTracker.createTracker({
        storage,
        now: () => clock.v,
        genId: () => 'op-new',
        getDownloadItem: async () => undefined,
        peekEarlyTerminal: () => undefined,
        notify: async () => {},
        log: () => {}
      });

      await t.ready();
      let listResult;
      try {
        listResult = await t.list();
      } catch (e) {
        listResult = 'THREW';
      }
      assert(Array.isArray(listResult) && listResult.length === 0, '27e1: failed cleanup write handled gracefully without throwing');
    }
  }

  // =================================================================================================
  console.log('\n--- 28. Tracker delivery to statistics: session failure, opt-in and clear boundaries ---');
  {
    // Recovery of a failed commit, idempotent repeats and restart are section 17 (17c, 17m, 17n); these are the remaining boundaries.
    const extSender = { id: 'testid', url: 'chrome-extension://testid/popup/popup.html' };
    // an asynchronous answer (keep === true) is awaited; only a message nobody handles resolves to null
    const ask = (env, action) => new Promise((resolve) => {
      for (const l of env.messageListeners) {
        let responded = false;
        const keep = l({ action }, extSender, (r) => { responded = true; resolve(r); });
        if (keep === true || responded) return;
      }
      resolve(null);
    });
    const total = async (env) => (await ask(env, 'STATISTICS_LIST')).stats.total;
    const saveOne = async (env, n) => {
      await env.click(imageClick(n));
      const r = await env.last();
      await env.finish(r.downloadId);
      return env.last();
    };

    // 28d: Session persistence failure does not destructively overwrite stored records
    {
      const env = makeEnv({ local: { historyEnabled: true } });
      await env.ready();
      await saveOne(env, 'persist_ok');
      await env.tracker.flush();
      const countBefore = env.session[env.sandbox.ImageSaverFeedbackTracker.STORAGE_KEY]?.ops?.length || 0;
      assert(countBefore >= 1, '28d1: record persisted in session');

      env.failSessionSet = true;
      await env.click(imageClick('fail_session'));
      const r = await env.last();
      if (r && r.downloadId) await env.finish(r.downloadId);
      await env.tracker.flush();
      env.failSessionSet = false;

      const opsAfter = env.session[env.sandbox.ImageSaverFeedbackTracker.STORAGE_KEY]?.ops || [];
      assert(opsAfter.length >= countBefore, '28d2: session storage write failure did not destroy stored records');
    }

    // 28e: Disabled recording never counts, and enabling later does not count retroactively
    {
      const idb = idbDouble();
      const envDis = makeEnv({ local: { historyEnabled: false }, indexedDB: idb });
      await envDis.ready();
      const opDis = await saveOne(envDis, 'disabled_save');
      await envDis.tracker.flush();
      assert(await total(envDis) === 0, '28e1: a save while recording is off is not counted');
      const disRec = await envDis.tracker.get(opDis.id);
      assert(disRec && !disRec.historyPending, '28e2: historyPending is NOT set for a save made while recording was off');
      envDis.local.historyEnabled = true;
      const envRecreated = makeEnv({ session: envDis.session, local: envDis.local, downloadsDb: envDis.downloadsDb, indexedDB: idb });
      await envRecreated.ready();
      await envRecreated.tracker.flush();
      assert(await total(envRecreated) === 0, '28e3: enabling recording later does not count a save made while it was off');
    }

    // 28f: An unreadable recording preference never counts at that time
    {
      const envUnread = makeEnv({ local: { historyEnabled: true } });
      await envUnread.ready();
      await total(envUnread);
      envUnread.failLocalGet = true;
      await saveOne(envUnread, 'unread_pref_save');
      await envUnread.tracker.flush();
      envUnread.failLocalGet = false;
      assert(await total(envUnread) === 0, '28f1: an unreadable preference never authorizes counting');
    }

    // 28g: A clear while a delivery is pending cannot resurrect the operation
    {
      const idb = idbDouble();
      const envClear = makeEnv({ local: { historyEnabled: true }, indexedDB: idb });
      await envClear.ready();
      await total(envClear);
      await envClear.click(imageClick('pending_before_clear'));
      const opClear = await envClear.last();
      idb.failAll = true;
      await envClear.finish(opClear.downloadId);
      idb.failAll = false;
      const pRec = await envClear.tracker.get(opClear.id);
      assert(pRec && pRec.historyPending === true, '28g1: record has historyPending === true');
      const clrRes = await ask(envClear, 'STATISTICS_CLEAR');
      assert(clrRes.success === true, '28g2: STATISTICS_CLEAR succeeded');
      const envClear2 = makeEnv({ session: envClear.session, local: envClear.local, downloadsDb: envClear.downloadsDb, indexedDB: idb });
      await envClear2.ready();
      await envClear2.tracker.flush();
      assert(await total(envClear2) === 0, '28g3: the clear boundary prevents counting an operation created before it');
      const recAfterClear = await envClear2.tracker.get(opClear.id);
      assert(recAfterClear && !recAfterClear.historyPending, '28g4: historyPending cleared after the rejected pre-clear delivery');
    }

    // 28i: Delivery bookkeeping write serializes ahead of concurrent begin; both survive restart
    {
      const state = {};
      let rejectDelivery, releaseWrite, holdOnce = true, writeStarted;
      let deliveryStarted;
      const delivery = new Promise((resolve) => { deliveryStarted = resolve; });
      const started = new Promise((resolve) => { writeStarted = resolve; });

      const tCtx = (() => {
        const s = { URL, console, setTimeout, clearTimeout };
        vm.createContext(s);
        for (const f of ['lib/feedback.js', 'lib/feedback_tracker.js']) {
          vm.runInContext(read(f), s);
        }
        return vm.runInContext('globalThis', s);
      })();
      // the statistics sink's commit, held and then rejected
      const history = { record: () => new Promise((_, reject) => { rejectDelivery = reject; deliveryStarted(); }) };

      let opCount = 0;
      const makeTrack = (storageDeps = {}) => tCtx.ImageSaverFeedbackTracker.createTracker({
        now: () => 1800000000000,
        genId: () => `op-r2-${++opCount}`,
        getDownloadItem: async () => null,
        storage: {
          get: async (key) => (state[key] ? JSON.parse(JSON.stringify(state[key])) : null),
          set: async (key, value) => { state[key] = JSON.parse(JSON.stringify(value)); }
        },
        onFinished: (rec) => history.record(rec),
        ...storageDeps
      });

      const tracker = makeTrack({
        storage: {
          get: async (key) => (state[key] ? JSON.parse(JSON.stringify(state[key])) : null),
          set: async (key, value) => {
            const snapshot = JSON.parse(JSON.stringify(value));
            if (holdOnce && snapshot.ops && snapshot.ops.some((r) => r.historyPending)) {
              holdOnce = false;
              writeStarted();
              await new Promise((resolve) => { releaseWrite = resolve; });
            }
            state[key] = snapshot;
          }
        }
      });

      const opA = await tracker.begin({ site: 'reddit' });
      await tracker.fail(opA, { code: 'NO_MEDIA' });
      await delivery; // wait for history.record to be invoked

      rejectDelivery(new Error('transient statistics storage failure'));
      await started; // wait for bookkeeping persist to start and pause at barrier

      // While bookkeeping write is held, start concurrent operation B
      let opBFinishedWhileHeld = false;
      const opBPromise = tracker.begin({ site: 'reddit' }).then((id) => {
        opBFinishedWhileHeld = true;
        return id;
      });

      // Flush microtasks to allow any unblocked promise chain to run
      for (let i = 0; i < 10; i++) await Promise.resolve();

      assert(!opBFinishedWhileHeld, '28i1: opB must serialize behind locked bookkeeping write');

      // Now release the held bookkeeping write
      releaseWrite();
      const opB = await opBPromise;
      await tracker.flush();

      // Persisted state must have BOTH opA and opB
      const finalStored = state.imageSaverFeedbackV1?.ops?.map((r) => r.id) || [];
      assert(finalStored.includes(opA), '28i2: opA is present in persisted storage');
      assert(finalStored.includes(opB), '28i3: opB is present in persisted storage (not overwritten by delayed bookkeeping write)');

      // Recreated tracker hydrates both opA and opB
      const recreated = makeTrack();
      await recreated.ready();
      const hydratedIds = (await recreated.list()).map((r) => r.id);
      assert(hydratedIds.includes(opA), '28i4: recreated tracker hydrates opA');
      assert(hydratedIds.includes(opB), '28i5: recreated tracker hydrates opB');
    }

    // A removed download must not reappear from its terminal feedback record; keep other results and statistics.
    {
      const context={URL,console,setTimeout,clearTimeout};vm.createContext(context);
      for(const file of ['lib/feedback.js','lib/feedback_tracker.js'])vm.runInContext(read(file),context);
      const store={};let sequence=0,failWrite=false,failRead=false;
      const make=()=>context.ImageSaverFeedbackTracker.createTracker({ genId:()=>`op-remove-${++sequence}`,storage:{get:async key=>{if(failRead)throw Error('READ_FAILED');return store[key] || null},set:async(key,value)=>{if(failWrite)throw Error('WRITE_FAILED');store[key]=JSON.parse(JSON.stringify(value))}},getDownloadItem:async()=>null });
      const tracker=make();
      const removed = await tracker.begin({site:'reddit'}), kept = await tracker.begin({site:'x'}), active = await tracker.begin({site:'reddit'});
      await tracker.fail(removed,{code:'REMOVED'});await tracker.fail(kept,{code:'KEPT'});
      await tracker.clearFinished(removed);
      assert((await tracker.list()).map(r=>r.id).join() === [active,kept].join(), '28i6: selective clear removes only the selected terminal result');
      let activeRejected=false;try{await tracker.clearFinished(active)}catch(_){activeRejected=true}
      assert(activeRejected && Boolean(await tracker.get(active)), '28i7: selective clear cannot acknowledge removing an active operation');
      failWrite=true;let rejected=false;
      try{await tracker.clearFinished(kept)}catch(_){rejected=true}
      assert(rejected && Boolean(await tracker.get(kept)),'28i8: selective clear refuses an unpersisted deletion and restores its diagnostic');
      failWrite=false;const restarted=make();
      assert(Boolean(await restarted.get(kept)) && !await restarted.get(removed),'28i9: restart retains failed deletion and never resurrects acknowledged deletion');
      failRead=true;const unreadable=make();rejected=false;
      try{await unreadable.clearFinished(kept)}catch(_){rejected=true}
      assert(rejected,'28i10: unreadable storage cannot acknowledge selective deletion');
    }
    {
      const context={URL,console,setTimeout,clearTimeout};vm.createContext(context);
      for(const file of ['lib/feedback.js','lib/feedback_tracker.js'])vm.runInContext(read(file),context);
      const store={};let release,sequence=0;
      const deps={genId:()=>`op-pending-remove-${++sequence}`,storage:{get:async key=>store[key] || null,set:async(key,value)=>{store[key]=JSON.parse(JSON.stringify(value))}},getDownloadItem:async()=>null};
      const tracker=context.ImageSaverFeedbackTracker.createTracker({...deps,onFinished:()=>new Promise((_,reject)=>{release=()=>reject(Error('STATISTICS_COMMIT_FAILED'))})});
      const id=await tracker.begin({site:'reddit'});await tracker.fail(id,{code:'NO_MEDIA'});
      let rejected=false;try{await tracker.clearFinished(id)}catch(_){rejected=true}
      assert(rejected && Boolean(await tracker.get(id)),'28i11: in-flight statistics delivery prevents selective removal');
      release();await tracker.flush();rejected=false;
      try{await tracker.clearFinished(id)}catch(_){rejected=true}
      assert(rejected && (await tracker.get(id)).historyPending,'28i12: failed statistics delivery remains durable after a refused removal');
      const delivered=[];const restarted=context.ImageSaverFeedbackTracker.createTracker({...deps,onFinished:async record=>{delivered.push(record.id)}});
      await restarted.ready();await restarted.flush();
      assert(delivered.includes(id),'28i13: pending statistics survives restart and is delivered again');
    }
    // 28j: clearFinished during an in-flight delivery outcome does not resurrect the cleared record
    {
      const state = {};
      let releaseHistory;
      const historyCalled = new Promise((resolve) => {
        releaseHistory = resolve;
      });
      let holdHistoryDelivery = true;
      let resumeHistory;

      const tCtx = (() => {
        const s = { URL, console, setTimeout, clearTimeout };
        vm.createContext(s);
        for (const f of ['lib/feedback.js', 'lib/feedback_tracker.js']) {
          vm.runInContext(read(f), s);
        }
        return vm.runInContext('globalThis', s);
      })();

      let opCount = 0;
      const tracker = tCtx.ImageSaverFeedbackTracker.createTracker({
        now: () => 1800000000000,
        genId: () => `op-clr-${++opCount}`,
        getDownloadItem: async () => null,
        storage: {
          get: async (key) => (state[key] ? JSON.parse(JSON.stringify(state[key])) : null),
          set: async (key, value) => { state[key] = JSON.parse(JSON.stringify(value)); }
        },
        onFinished: async () => {
          if (holdHistoryDelivery) {
            holdHistoryDelivery = false;
            releaseHistory();
            await new Promise((resolve) => { resumeHistory = resolve; });
            throw new Error('history failed');
          }
        }
      });

      const opToClear = await tracker.begin({ site: 'reddit' });
      await tracker.fail(opToClear, { code: 'FAIL_CLEAR' });
      await historyCalled; // onFinished is in-flight

      // User clears finished operations while history delivery is in flight
      await tracker.clearFinished();
      const listAfterClear = await tracker.list();
      assert(listAfterClear.length === 0, '28j1: tracker cleared in-memory operations');

      // Now resume history failure, triggering bookkeeping error handler
      resumeHistory();
      await tracker.flush();

      // Record must NOT have been resurrected in tracker or persisted storage
      const listAfterResume = await tracker.list();
      assert(listAfterResume.length === 0, '28j2: cleared record not reintroduced to tracker');
      const storedAfterResume = state.imageSaverFeedbackV1?.ops || [];
      assert(storedAfterResume.length === 0, '28j3: cleared record not reintroduced to persisted storage');

      // Recreated tracker also has 0 records
      const recreated = tCtx.ImageSaverFeedbackTracker.createTracker({
        now: () => 1800000000000,
        genId: () => `op-rec-${++opCount}`,
        getDownloadItem: async () => null,
        storage: {
          get: async (key) => (state[key] ? JSON.parse(JSON.stringify(state[key])) : null),
          set: async (key, value) => { state[key] = JSON.parse(JSON.stringify(value)); }
        }
      });
      await recreated.ready();
      assert((await recreated.list()).length === 0, '28j4: recreated tracker has 0 records');
    }
  }

  // =================================================================================================
  console.log('\n--- 29. Post batches: X "Save all" through the production handlers and the production download manager ---');
  {
    // Fixtures: the document's answers, offscreen staging, the browser's own downloads and the media pipeline tail (resolution and
    // verification have their own suites). Everything else is production: the Save all handler, the one-shot sender gate, the item
    // run into the shared save path, the operation tracker, the durable queue and the DOWNLOADS_LIST snapshot.
    const idb = idbDouble();
    const post = (id) => `https://x.com/someone/status/${id}`;
    const POPUP = { id: 'testid', url: 'chrome-extension://testid/popup/quick.html' };
    const sleep = (ms = 15) => new Promise((r) => setTimeout(r, ms));
    async function until(fn, what) { for (let i = 0; i < 800; i++) { if (await fn()) return; await sleep(5); } throw new Error('TEST_TIMEOUT ' + what); }
    function worker(opts = {}) {
      const env = makeEnv({ realManager: true, indexedDB: idb, ...opts });
      env.plan = [];
      env.gates = new Map();            // url fragment -> promise the pipeline tail waits for before it enqueues
      env.stagingFails = new Set();     // url fragments whose staging fails
      env.staging = async (msg) => {
        if (msg.action === 'STAGING_PREPARE') return [...env.stagingFails].some((f) => msg.job.source.includes(f)) ? { success: false, error: 'INVALID_MEDIA' } : { success: true, size: 2048, mime: 'image/jpeg' };
        if (msg.action === 'STAGING_URL') return { success: true, url: 'blob:chrome-extension://testid/' + msg.id };
        return { success: true, valid: true };
      };
      const sb = env.sandbox;
      sb.resolveOriginalMediaPlan = async ({ srcUrl }) => ({ primaryUrl: srcUrl });
      sb.executeMediaDownload = async ({ targetImageUrl, feedbackOp, pageUrl }) => {
        env.plan.push(targetImageUrl);
        for (const [fragment, gate] of env.gates) if (targetImageUrl.includes(fragment)) await gate;
        try { await sb.managedDownload({ url: targetImageUrl, filename: 'file.jpg', saveAs: false }, feedbackOp, 'image/jpeg', 0, pageUrl); } catch (_) { /* the queue already failed the operation */ }
      };
      env.manager = vm.runInContext('downloadManager', sb);
      env.sender = (tab, id) => ({ id: 'testid', tab: { id: tab, active: true, url: post(id) }, frameId: 0, documentId: 'doc-' + tab, url: post(id) });
      // the page proves a list of `items` (url or 'STALE'), answers each item by index
      env.docs = new Map();
      env.document = (id, items) => env.docs.set(id, items);
      env.tabsMsgHandler = async (tabId, msg) => {
        const id = tabId === 7 ? '2090' : '2091', items = env.docs.get(id);
        if (msg.action === 'X_INLINE_BATCH') return { ok: true, count: items.length, ownerId: id, sig: 'abcdef01' };
        if (msg.action === 'X_INLINE_OWNER_ITEM') {
          const it = items[msg.index];
          if (it === 'STALE') return { ok: false, reason: 'STALE_ITEM' };
          const url = typeof it === 'string' ? it : it.url;
          return { ok: true, media: { type: 'image', url, src: url, sourceType: 'image', tweetId: typeof it === 'string' ? id : it.tweet, postUrl: post(id), mediaIndex: msg.index, pageUrl: post(id) } };
        }
        return null;
      };
      env.saveAll = (tab, id) => { for (const cb of env.messageListeners) cb({ action: 'X_INLINE_SAVE_ALL', token: 'a'.repeat(32) }, env.sender(tab, id), () => {}); };
      env.snapshot = () => new Promise((resolve) => { for (const cb of env.messageListeners) { if (cb({ action: 'DOWNLOADS_LIST' }, POPUP, resolve) === true) return; } });
      env.command = (command, id) => new Promise((resolve) => { for (const cb of env.messageListeners) { if (cb({ action: 'DOWNLOADS_COMMAND', command, id }, POPUP, resolve) === true) return; } });
      return env;
    }
    const counts = (b) => [b.saved, b.failed, b.cancelled, b.skipped, b.remaining].join('/');
    const img = (n) => `https://pbs.twimg.com/media/IMG${n}.jpg`;
    const finishAll = async (env) => { for (const [id, item] of env.downloadsDb) if (item.state === 'in_progress') await env.finish(id); };
    const batchOf = (snap, site = 'x') => snap.batches.filter((b) => b.site === site);

    const env = worker();
    await env.ready(); await env.manager.ready;
    // A: 6 proven items. 0 held in the pipeline, 1 saved, 2 fails in staging, 3 refused by the document, 4 repeats item 0 (the busy guard) and
    // 5 repeats its address as another post's item (the in-flight guard discards its operation) while item 0 runs.
    env.gates.set('IMG0', new Promise((resolve) => { env.openGate = resolve; }));
    env.stagingFails.add('IMG2');
    env.document('2090', [img(0), img(1), img(2), 'STALE', img(0), { url: img(0), tweet: '2092' }]);
    env.saveAll(7, '2090');
    await until(async () => { const b = batchOf(await env.snapshot())[0]; return b && b.failed === 2 && b.skipped === 2; }, 'items 1..5 settled');
    let snap = await env.snapshot();
    let a = snap.batches[0];
    assert(snap.batches.length === 1 && a.count === 6 && counts(a) === '0/2/0/2/2', `29a: while item 0 is still preparing and item 1 is exporting: 0 saved, 2 failed (staging, refusal), 2 skipped duplicates (busy and discarded), 2 remaining (${counts(a)})`);
    assert(snap.jobs.filter((j) => j.batch === a.id).length === 4 && snap.jobs.every((j) => j.batch === a.id), '29b: the rows of the batch carry its id: the preparing item, the exporting and the failed job, and the refused operation (the duplicates have no row)');
    env.openGate();
    await until(async () => (await env.snapshot()).jobs.filter((j) => j.state === 'exporting').length === 2, 'both exports accepted');
    snap = await env.snapshot(); a = snap.batches[0];
    assert(counts(a) === '0/2/0/2/2' && env.downloadCalls.length === 2, `29c: both files are with the browser but unfinished: still 0 saved, 2 remaining (${counts(a)})`);
    assert(env.plan.filter((u) => u.includes('IMG0')).length === 1, '29d: the repeated item was not requested a second time');
    // the browser finishes both files; repeated completion events change nothing
    const [first, second] = [...env.downloadsDb.keys()];
    await env.finish(first); await env.finish(first); await env.emitDownload({ id: first, state: { current: 'complete', previous: 'in_progress' } });
    await until(async () => counts((await env.snapshot()).batches[0]).startsWith('1/'), 'first saved');
    await env.finish(second); await env.finish(second);
    await until(async () => counts((await env.snapshot()).batches[0]) === '2/2/0/2/0', 'second saved');
    snap = await env.snapshot(); a = snap.batches[0];
    assert(counts(a) === '2/2/0/2/0' && a.saved + a.failed + a.cancelled + a.skipped + a.remaining === a.count, `29e: every proven item is counted once; only the two finished files are saved (${counts(a)}); finished is not "all saved"`);
    assert(!JSON.stringify(snap).includes('twimg') && !JSON.stringify(snap.batches).includes('http'), '29f: no media address in the batch summary');
    // retry of the failed staging updates its slot: one more saved, failed goes down, never above the count
    const failedJob = snap.jobs.find((j) => j.batch === a.id && j.state === 'failed' && j.managed !== false);
    env.stagingFails.clear();
    assert((await env.command('retry', failedJob.id)).success === true, '29g: retry is accepted through the existing command');
    await until(async () => (await env.snapshot()).jobs.find((j) => j.id === failedJob.id).state === 'exporting', 'retry exporting');
    assert(counts((await env.snapshot()).batches[0]) === '2/1/0/2/1', '29h: the retried slot is active again (not failed, not saved)');
    await env.finish([...env.downloadsDb.keys()].pop());
    await until(async () => counts((await env.snapshot()).batches[0]) === '3/1/0/2/0', 'retry saved');
    assert((await env.snapshot()).jobs.filter((j) => j.batch === a.id).length === 4, '29i: a retry is the same row, not a second one');

    // B: a second post at the same time is a separate batch with its own counts
    env.document('2091', [img(10), img(11)]);
    env.saveAll(8, '2091');
    await until(async () => { const s = await env.snapshot(); return s.batches.length === 2 && s.jobs.filter((j) => j.state === 'exporting').length === 2; }, 'second batch exporting');
    snap = await env.snapshot();
    const bB = snap.batches.find((b) => b.count === 2), bA = snap.batches.find((b) => b.count === 6);
    assert(counts(bB) === '0/0/0/0/2' && counts(bA) === '3/1/0/2/0', `29j: two batches stay separate (${counts(bA)} and ${counts(bB)})`);
    await finishAll(env);
    await until(async () => counts((await env.snapshot()).batches.find((b) => b.count === 2)) === '2/0/0/0/0', 'B saved');

    // Clearing: each row goes through the existing remove command; the summary disappears with its last row and nothing comes back
    const rows = (await env.snapshot()).jobs.filter((j) => j.batch === bA.id);
    for (const j of rows.slice(0, -1)) assert((await env.command('remove', j.id)).success === true, '29k: a finished row is removed');
    assert((await env.snapshot()).batches.some((b) => b.id === bA.id), '29l: the summary stays while one of its rows is listed');
    const last = await env.command('remove', rows.at(-1).id);
    assert(last.success === true && !last.batches.some((b) => b.id === bA.id) && last.batches.some((b) => b.id === bB.id), '29m: the last row removed: the summary is gone, the other batch is untouched');
    const again = await env.snapshot();
    assert(!again.batches.some((b) => b.id === bA.id) && !again.jobs.some((j) => j.batch === bA.id), '29n: removed rows and their summary are not resurrected by the next list');

    // Restart: a worker dies with a batch in progress (own queue storage; the dead worker is frozen). The browser's export is reconciled,
    // the preparations that died are failed, the never-started slot is skipped, and nothing is requested or resumed.
    const idb2 = idbDouble();
    const env2 = worker({ indexedDB: idb2 });
    await env2.ready(); await env2.manager.ready;
    env2.gates.set('IMG21', new Promise(() => {})); env2.gates.set('IMG22', new Promise(() => {}));   // items 1 and 2 never finish preparing
    env2.document('2090', [img(20), img(21), img(22), img(23)]);
    env2.saveAll(7, '2090');
    await until(async () => { const s = await env2.snapshot(); return s.batches[0] && s.jobs.some((j) => j.state === 'exporting') && s.batches[0].remaining === 4 && env2.plan.length === 3; }, 'batch C in progress');
    let s0 = await env2.snapshot();
    assert(counts(s0.batches[0]) === '0/0/0/0/4', `29o: before the restart: three slots preparing or exporting, one never started: 0 saved, 4 remaining (${counts(s0.batches[0])})`);
    const exporting = [...env2.downloadsDb.entries()].filter(([, item]) => item.state === 'in_progress').map(([id]) => id);
    env2.chrome.downloads.search = () => new Promise(() => {}); env2.sandbox.setTimeout = () => 0;   // the old worker is gone
    const restarted = worker({ indexedDB: idb2, session: env2.session, local: env2.local, downloadsDb: env2.downloadsDb });
    await restarted.ready(); await restarted.manager.ready; await sleep(80);
    let s2 = await restarted.snapshot();
    const c = s2.batches[0];
    assert(counts(c) === '0/2/0/1/1', `29p: after the restart the two dead preparations are failed, the never-started slot is skipped, the browser's export is still active (${counts(c)})`);
    assert(s2.jobs.some((j) => j.batch === c.id && j.state === 'exporting') && s2.jobs.filter((j) => j.batch === c.id && j.managed === false && j.state === 'failed').length === 2, '29q: the export is reconciled (not repeated) and the two dead preparations are listed as failed rows of the batch');
    assert(restarted.downloadCalls.length === 0 && restarted.plan.length === 0, '29r: the restart requests, downloads and exports nothing');
    for (const id of exporting) await restarted.finish(id);
    await until(async () => (await restarted.snapshot()).batches[0].remaining === 0, 'restart batch settled');
    s2 = await restarted.snapshot();
    assert(counts(s2.batches[0]) === '1/2/0/1/0', `29s: the finished export is saved exactly once and every slot is accounted for (${counts(s2.batches[0])})`);
    const again2 = worker({ indexedDB: idb2, session: restarted.session, local: restarted.local, downloadsDb: restarted.downloadsDb });
    await again2.ready(); await again2.manager.ready;
    assert(counts((await again2.snapshot()).batches[0]) === '1/2/0/1/0', '29t: a second restart and reopen keep the same summary');

    // ---- 30. Page notices of a post batch (MANAGER-BATCH-NOTICES-01): the same harness, the notice transport and the content-script payload ----
    console.log('\n--- 30. One page notice per post batch: canonical counts, event ordering, delivery checks ---');
    const nworker = (opts = {}) => {
      const e = worker({ indexedDB: idbDouble(), local: { uiLanguage: 'en', ...(opts.local || {}) }, ...Object.fromEntries(Object.entries(opts).filter(([k]) => k !== 'local')) });
      e.tabUrls.set(7, post('2090')); e.tabUrls.set(8, post('2091'));
      const inner = e.tabsMsgHandler;
      e.single = null;
      e.tabsMsgHandler = async (tabId, msg) => {
        if (msg.action === 'X_INLINE_OWNER') return e.single ? { ok: true, media: { type: 'image', url: e.single.url, src: e.single.url, sourceType: 'image', tweetId: e.single.tweet, postUrl: post('2090'), pageUrl: post('2090') } } : null;
        return inner(tabId, msg);
      };
      e.saveOne = (tab, id) => { for (const cb of e.messageListeners) cb({ action: 'X_INLINE_SAVE', token: 'b'.repeat(32) }, e.sender(tab, id), () => {}); };
      e.open = (id, sender = { id: 'testid', frameId: 0, tab: { id: 7 }, url: post('2090') }) => new Promise((resolve) => { for (const cb of e.messageListeners) { if (cb({ action: 'MEDIALATCH_NOTICE_OPEN', id }, sender, resolve) === true) return; } });
      e.batchNotes = () => e.notifications.filter((x) => x.opts.batch);
      return e;
    };
    const waitFinal = (e, id, text) => until(() => e.batchNotes().filter((x) => !id || x.opts.batch === id).some((x) => x.opts.final && x.opts.message === text), 'final notice ' + text);
    // the manager keeps at most two transfers per source host in flight: finish the browser's downloads as they appear
    const finishLoop = async (e, cond, what) => { for (let i = 0; i < 1200; i++) { for (const [id, item] of e.downloadsDb) if (item.state === 'in_progress') await e.finish(id); if (await cond()) return; await sleep(5); } throw new Error('TEST_TIMEOUT ' + what); };
    const batchId = async (e) => (await e.snapshot()).batches[0].id;
    const ALLOWED = ['kind', 'title', 'message', 'actionLabel', 'dismissLabel', 'successEnabled', 'summaryTitle', 'savedLabel', 'failedLabel', 'batch', 'final', 'id', 'origin', 'theme'].sort().join();

    // N1: one batch, mixed outcomes, a refusal before any job, a busy and a discarded duplicate, repeated completion events
    {
      const e = nworker();
      await e.ready(); await e.manager.ready;
      e.gates.set('IMG0', new Promise((resolve) => { e.openGate = resolve; }));
      e.stagingFails.add('IMG2');
      e.document('2090', [img(0), img(1), img(2), 'STALE', img(0), { url: img(0), tweet: '2092' }]);
      e.saveAll(7, '2090');
      await until(async () => { const b = (await e.snapshot()).batches[0]; return b && b.failed === 2 && b.skipped === 2; }, 'N1 settled items');
      const id = await batchId(e);
      await until(() => e.batchNotes().length > 0, 'first notice');
      const early = e.batchNotes().at(-1).opts;
      assert(/^Saved 0 of 6 · .*remaining$/.test(early.message), `30a: the first card appears once an item has a result, with the canonical counts (${early.message})`);
      assert(early.kind === 'error' && early.final === false && early.batch === id && early.title === 'x.com post', '30b: a failing batch is an error card, not final while items remain, with the batch id of the worker');
      assert(e.notifications.every((x) => x.opts.batch), '30c: no operation of the batch gets a card of its own: the refusal and the staging failure ended before any count was settled');
      e.openGate();
      await until(async () => (await e.snapshot()).jobs.filter((j) => j.state === 'exporting').length === 2, 'N1 exports accepted');
      const before = e.batchNotes().length;
      assert(!e.batchNotes().some((x) => /Saved [12] of 6/.test(x.opts.message)), '30d: accepted exports are not saved: no notice counts them');
      const [first, second] = [...e.downloadsDb.keys()];
      await e.finish(first); await e.finish(first); await e.emitDownload({ id: first, state: { current: 'complete', previous: 'in_progress' } });
      await until(() => e.batchNotes().some((x) => /^Saved 1 of 6/.test(x.opts.message)), 'first saved notice');
      await e.finish(second); await e.finish(second);
      await waitFinal(e, id, 'Saved 2 of 6 · 2 failed · 2 skipped');
      const notes = e.batchNotes();
      assert(new Set(notes.map((x) => x.opts.batch)).size === 1 && notes.length >= 2, `30e: one batch, one card identity (${notes.length} updates, one batch id)`);
      assert(notes.every((x, i) => i === 0 || x.opts.message !== notes[i - 1].opts.message), '30f: repeated completion events deliver nothing: consecutive updates always differ');
      const last = notes.at(-1).opts, snap = (await e.snapshot()).batches[0];
      assert(last.final === true && last.kind === 'error' && last.message === `Saved ${snap.saved} of ${snap.count} · ${snap.failed} failed · ${snap.skipped} skipped`, `30g: the final card equals the manager's canonical counts (${last.message})`);
      assert(notes.every((x) => Object.keys(x.opts).sort().join() === ALLOWED && x.opts.origin === 'https://x.com' && x.tabId === 7), '30h: only the notice fields, for the original tab and origin');
      assert(!JSON.stringify(notes).match(/twimg|IMG\d|\.jpg|file\.jpg|someone|status\/2090|Downloads|C:\\|blob:/), '30i: no file name, source address, author, page path or local path in any notice');
      assert(notes.every((x) => x.opts.successEnabled === true && x.opts.actionLabel === 'Open manager' && x.opts.dismissLabel === 'Dismiss notification'), '30j: the existing Open manager and dismiss labels');
      // the card's Open manager names a finished operation of this batch; the existing sender, record, tab and origin checks apply
      const ops = new Set((await e.tracker.list()).filter((r) => FBLib.isTerminal(r.state)).map((r) => r.id));
      assert(notes.every((x) => ops.has(x.opts.id)), '30k: every card names a finished operation that still has its record');
      const tabsBefore = e.createdTabs.length;
      const ok = await e.open(last.id);
      assert(ok.success === true && e.createdTabs.length === tabsBefore + 1 && e.createdTabs.at(-1).url.endsWith(`?op=${encodeURIComponent(last.id)}#downloads`), '30l: Open manager opens the existing deep link of that operation');
      assert((await e.open(last.id, { id: 'testid', frameId: 0, tab: { id: 8 }, url: post('2090') })).success === false && (await e.open(last.id, { id: 'testid', frameId: 0, tab: { id: 7 }, url: 'https://evil.example/' })).success === false && (await e.open(last.id, { id: 'other', frameId: 0, tab: { id: 7 }, url: post('2090') })).success === false && (await e.open(snap.id)).success === false && e.createdTabs.length === tabsBefore + 1, '30m: another tab, another origin, another extension and a batch id are refused; there is no batch command');
      // an unrelated single save from the same page while the batch card exists: its own ordinary notice, no batch field, counts untouched
      e.single = { url: img(90), tweet: '2093' };
      const batchNow = e.batchNotes().length;
      e.saveOne(7, '2090');
      await until(() => [...e.downloadsDb.keys()].length === 3, 'single export');
      await e.finish([...e.downloadsDb.keys()].pop());
      await until(() => e.notifications.some((x) => !x.opts.batch), 'single notice');
      const single = e.notifications.find((x) => !x.opts.batch);
      assert(single.opts.kind === 'success' && single.opts.title === 'x.com: saved' && single.opts.batch === undefined && e.batchNotes().length === batchNow && (await e.snapshot()).batches[0].saved === 2, '30n: an unrelated single save gets the ordinary notice and does not change the batch');
      // retry of the failed staging updates the same card identity with the new canonical counts
      const failedJob = (await e.snapshot()).jobs.find((j) => j.batch === id && j.state === 'failed' && j.managed !== false);
      e.stagingFails.clear();
      await e.command('retry', failedJob.id);
      await until(async () => (await e.snapshot()).jobs.find((j) => j.id === failedJob.id).state === 'exporting', 'retry exporting');
      await e.finish([...e.downloadsDb.keys()].pop());
      await waitFinal(e, id, 'Saved 3 of 6 · 1 failed · 2 skipped');
      assert(new Set(e.batchNotes().map((x) => x.opts.batch)).size === 1, '30o: the retry updates the same batch card, never a second one');
    }

    // N2: two posts at the same time are two cards with their own counts; neither counts the other's items
    {
      const e = nworker();
      await e.ready(); await e.manager.ready;
      e.stagingFails.add('IMGB1');
      e.document('2090', [img('A0'), img('A1'), img('A2')]); e.document('2091', [img('B0'), img('B1')]);
      e.saveAll(7, '2090'); e.saveAll(8, '2091');
      await finishLoop(e, async () => { const s = await e.snapshot(); return s.batches.length === 2 && s.batches.every((b) => b.remaining === 0); }, 'both batches settled');
      const snap = await e.snapshot(), A = snap.batches.find((b) => b.count === 3), B = snap.batches.find((b) => b.count === 2);
      await waitFinal(e, A.id, 'All 3 files saved'); await waitFinal(e, B.id, 'Saved 1 of 2 · 1 failed');
      const own = (b) => e.batchNotes().filter((x) => x.opts.batch === b.id);
      assert(A.id !== B.id && own(A).every((x) => x.tabId === 7 && /of 3|All 3/.test(x.opts.message)) && own(B).every((x) => x.tabId === 8 && /of 2/.test(x.opts.message)), '30p: two simultaneous posts have separate batch ids, tabs and counts');
      assert(own(A).at(-1).opts.kind === 'success' && own(B).at(-1).opts.kind === 'error', '30q: all saved is a success card; a failure makes only its own batch an error card');
    }

    // N3: successful-save notices off: an all-saved batch is silent, a failing batch shows only its failures
    {
      const e = nworker({ local: { notifySuccess: false } });
      await e.ready(); await e.manager.ready;
      e.document('2090', [img('C0'), img('C1')]);
      e.saveAll(7, '2090');
      await finishLoop(e, async () => (await e.snapshot()).batches[0]?.saved === 2, 'quiet batch saved');
      await sleep(120);
      assert(e.notifications.every(x=>x.opts.dismissBatch===true), '30r: with success notices off an all-saved batch sends only quiet removals, never a card');
      const f = nworker({ local: { notifySuccess: false } });
      await f.ready(); await f.manager.ready;
      f.stagingFails.add('IMGD1');
      f.document('2090', [img('D0'), img('D1'), img('D2')]);
      f.saveAll(7, '2090');
      await finishLoop(f, async () => (await f.snapshot()).batches[0]?.remaining === 0, 'failing batch settled');
      await waitFinal(f, null, '1 failed');
      assert(f.batchNotes().every((x) => x.opts.successEnabled === false && !/Saved|All/.test(x.opts.message) && x.opts.kind === 'error'), '30s: with success notices off the card lists only what failed, as an error card');
    }

    // N4: the page navigated or closed: nothing is sent to another origin or tab; the batch and the manager are unaffected; the card returns on the next result
    {
      const e = nworker();
      await e.ready(); await e.manager.ready;
      e.gates.set('IMGE1', new Promise((resolve) => { e.openGate = resolve; }));
      e.document('2090', [img('E0'), img('E1'), img('E2')]);
      e.tabUrls.set(7, 'https://other.example/elsewhere');          // the tab navigated away from the post's origin
      e.saveAll(7, '2090');
      await finishLoop(e, async () => (await e.snapshot()).batches[0]?.saved === 2, 'navigated batch counts');
      await sleep(120);
      assert(e.notifications.length === 0, '30t: after the tab navigated to another origin no notice is sent anywhere');
      e.closedTab = 7;                                               // the tab was closed
      e.openGate();
      await finishLoop(e, async () => (await e.snapshot()).batches[0].saved === 3, 'closed tab batch counts');
      await sleep(120);
      assert(e.notifications.length === 0 && (await e.snapshot()).batches[0].remaining === 0, '30u: a closed tab gets nothing and the batch still settles in the manager');
    }
    {
      const e = nworker();
      await e.ready(); await e.manager.ready;
      e.gates.set('IMGF2', new Promise((resolve) => { e.openGate = resolve; }));
      e.document('2090', [img('F0'), img('F1'), img('F2')]);
      e.saveAll(7, '2090');                                           // no popup read at all: only the worker's own API is used
      await until(async () => (await e.manager.list()).jobs.filter((j) => j.state === 'exporting').length === 2, 'popup-free batch exporting');
      await finishLoop(e, async () => e.batchNotes().length > 0, 'notice without a popup');
      e.openGate();
      await finishLoop(e, async () => (await e.manager.list()).batches[0].remaining === 0, 'popup-free batch settled');
      await waitFinal(e, null, 'All 3 files saved');
      assert(e.batchNotes().length >= 2 && e.notifications.every((x) => x.opts.batch) && !e.messageCalls, '30v: with the popup never opened the notices still follow the worker-owned counts');
    }

    // N5: a worker restart: the reconciliation of an unfinished batch is one batch notice, never a card per operation
    {
      const idb3 = idbDouble();
      const a = nworker({ indexedDB: idb3 });
      await a.ready(); await a.manager.ready;
      a.gates.set('IMGG1', new Promise(() => {}));
      a.document('2090', [img('G0'), img('G1'), img('G2')]);
      a.saveAll(7, '2090');
      await until(async () => { const s = await a.snapshot(); return s.jobs.some((j) => j.state === 'exporting') && a.plan.length === 3; }, 'restart batch in progress');
      a.chrome.downloads.search = () => new Promise(() => {}); a.sandbox.setTimeout = () => 0;
      const restarted = nworker({ indexedDB: idb3, session: a.session, local: a.local, downloadsDb: a.downloadsDb });
      await restarted.ready(); await restarted.manager.ready;
      await until(() => restarted.batchNotes().length > 0, 'restart notice');
      await sleep(80);
      const last = restarted.batchNotes().at(-1).opts;
      assert(restarted.notifications.every((x) => x.opts.batch) && /failed/.test(last.message) && new Set(restarted.batchNotes().map((x) => x.opts.batch)).size === 1, `30w: the restart reconciliation is one batch notice and no per-operation card (${last.message})`);
    }

    // N6: event ordering. A refused item's operation fails (and would notify) BEFORE the loop settles its slot: the operation never gets a
    // card of its own, and the batch card appears only with the canonical counts once the slot is settled.
    {
      const e = nworker();
      await e.ready(); await e.manager.ready;
      const settle = e.sandbox.batchSettle; let release; const gate = new Promise((resolve) => { release = resolve; });
      e.sandbox.batchSettle = async (...a) => { await gate; return settle(...a); };
      e.document('2090', ['STALE', img('H1')]);
      e.saveAll(7, '2090');
      await until(async () => (await e.tracker.list()).some((r) => r.state === 'failed'), 'the refused operation failed');
      await e.tracker.flush(); await sleep(120);
      assert(e.notifications.length === 0 && (await e.snapshot()).batches[0].failed === 0, '30x: the failed operation produced no card of its own and the unsettled slot is not counted yet');
      release();
      await until(() => e.batchNotes().length > 0, 'batch card after the settlement');
      assert(e.batchNotes().every((x) => /^Saved 0 of 2 · 1 failed/.test(x.opts.message)) && e.notifications.every((x) => x.opts.batch), '30y: after the settlement the batch card shows the failure with the canonical counts');
      await finishLoop(e, async () => (await e.snapshot()).batches[0].remaining === 0, 'ordering batch settled');
      await waitFinal(e, null, 'Saved 1 of 2 · 1 failed');
    }

    // ---- 34. Pixiv artworks and Pawchive posts (MANAGER-BATCH-PROGRESS-02): the production loops (savePixivPostMedia, savePawchivePostMedia) feed the same slots ----
    // Production: the provider loops, onContextMenuClicked for every item (operation, slot binding), the shared save path, the operation tracker, the durable
    // queue, the notice transport. Fixtures: the document admission of the post (covered by test_post_media.js), the media pipeline tail and offscreen staging.
    console.log('\n--- 34. Pixiv artworks and Pawchive posts: one summary and one page notice per post ---');
    const PXPAGE = 'https://www.pixiv.net/', PWCARD = 'https://pawchive.pw/fanbox/user/37736420';
    const PX = (n, id = '150000001') => `https://i.pximg.net/img-original/img/2026/10/13/18/32/13/${id}_p${n}.jpg`;
    const pxPost = (id = '150000001') => `https://www.pixiv.net/artworks/${id}`;
    const hexOf = (n) => n.toString(16).padStart(64, 'c');
    const PW = (n, ext = 'jpg') => `https://file.pawchive.pw/data/${hexOf(n).slice(0, 2)}/${hexOf(n).slice(2, 4)}/${hexOf(n)}.${ext}?f=file-${n}.${ext}`;
    const pworker = (page, opts = {}) => {
      const e = worker({ indexedDB: idbDouble(), local: { uiLanguage: 'en', historyEnabled: true, ...(opts.local || {}) }, ...Object.fromEntries(Object.entries(opts).filter(([k]) => k !== 'local')) });
      e.tabUrls.set(7, page); e.sandbox.console.info = () => {};
      e.batchNotes = () => e.notifications.filter((x) => x.opts.batch);
      e.singleNotes = () => e.notifications.filter((x) => !x.opts.batch);
      e.tab = { id: 7, url: page };
      e.pixiv = (items, id) => e.sandbox.savePixivPostMedia({ postUrl: pxPost(id), items }, { frameId: 0, pageUrl: page, srcUrl: items[0] }, e.tab);
      e.pawchive = (items, missingCode) => e.sandbox.savePawchivePostMedia({ postUrl: PWCARD + '/post/1', items, ...(missingCode ? { missingCode } : {}) }, { frameId: 0, pageUrl: page }, e.tab);
      // media answers of the probes (Pawchive) by address fragment: HTTP status, or a page that is not media
      e.answers = new Map();
      e.fetchImpl = async (url) => {
        for (const [fragment, how] of e.answers) if (url.includes(fragment)) return how === 'html' ? { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : '10') } } : { ok: false, status: how, headers: { get: () => '' } };
        return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : '2048') } };
      };
      e.stats = async () => { await e.tracker.flush(); return new Promise((resolve) => { for (const cb of e.messageListeners) { if (cb({ action: 'STATISTICS_LIST' }, { id: 'testid', url: 'chrome-extension://testid/popup/popup.html' }, resolve) === true) return; } }); };
      e.inFlight = (url) => vm.runInContext(`inFlightRequests.add(${JSON.stringify(url)})`, e.sandbox);
      return e;
    };
    const summary = async (e, site) => (await e.snapshot()).batches.filter((b) => b.site === site);
    const settled = (e, site) => finishLoop(e, async () => { const b = (await summary(e, site))[0]; return b && b.remaining === 0; }, site + ' group settled');
    // a loop's pages beyond the two per host wait for the browser's downloads: finish them while the loop runs
    const runGroup = async (e, site, start) => { const run = start(); await settled(e, site); await run; };

    // P1: Pixiv, mixed: saved, a job failure, a duplicate of an address already being saved, saved. One group, one card, no per-file card.
    {
      const e = pworker(PXPAGE);
      await e.ready(); await e.manager.ready;
      e.stagingFails.add('_p1.jpg'); e.inFlight(PX(2));
      await runGroup(e, 'pixiv', () => e.pixiv([PX(0), PX(1), PX(2), PX(3)]));
      const [b] = await summary(e, 'pixiv'), snap = await e.snapshot();
      assert(b && b.count === 4 && counts(b) === '2/1/0/1/0' && b.site === 'pixiv' && b.partial === undefined && snap.batches.length === 1, `34a: one Pixiv group of 4 proven pages: 2 saved, 1 failed, 1 duplicate skipped (${b && counts(b)})`);
      assert(e.plan.length === 3 && !e.plan.includes(PX(2)) && snap.jobs.length === 3 && snap.jobs.every((j) => j.batch === b.id), '34b: only the proven pages that were not duplicates reached the shared save path; every row names its group');
      await waitFinal(e, b.id, 'Saved 2 of 4 · 1 failed · 1 skipped');
      const cards = e.batchNotes();
      assert(cards.length >= 1 && cards.every((x) => x.opts.batch === b.id && x.opts.title === 'Pixiv post') && e.singleNotes().length === 0 && new Set(cards.map((x) => x.tabId)).size === 1 && cards[0].tabId === 7, '34c: one updating card titled "Pixiv post" on the original tab; the individual file operations produce no card of their own');
      assert(cards.at(-1).opts.final === true && cards.at(-1).opts.kind === 'error' && !/All 4/.test(cards.at(-1).opts.message), '34d: a mixed result is an error card, never "all saved"');
      const total = (await e.stats());
      assert(total.stats.total === 3 && total.stats.success === 2 && total.stats.failed === 1, '34e: statistics count the three file operations once each; the group is not an operation');
    }
    // P2: Pixiv, every page saved: the final text says all files saved; a single manager row per page keeps its actions
    {
      const e = pworker(PXPAGE);
      await e.ready(); await e.manager.ready;
      await runGroup(e, 'pixiv', () => e.pixiv([PX(0), PX(1), PX(2)]));
      const [b] = await summary(e, 'pixiv');
      assert(counts(b) === '3/0/0/0/0', '34f: three confirmed saves');
      await waitFinal(e, b.id, 'All 3 files saved');
      assert(e.batchNotes().at(-1).opts.kind === 'success' && e.singleNotes().length === 0, '34g: all saved is a success card and nothing else is shown');
    }
    // P3: Pixiv, rate limit: the first limited page stops the remainder, every page is accounted for
    {
      const e = pworker(PXPAGE);
      await e.ready(); await e.manager.ready;
      const adapt = e.sandbox.adaptCandidateToGroup;
      e.sandbox.adaptCandidateToGroup = (o) => { const p = adapt(o); if (p && o.url === PX(1)) { p._rateLimited = true; p.error = 'RATE_LIMIT'; } return p; };
      e.gates.set('_p0.jpg', new Promise((resolve) => { e.openGate = resolve; }));
      const running = e.pixiv([PX(0), PX(1), PX(2), PX(3)]);
      await until(async () => { const x = (await summary(e, 'pixiv'))[0]; return x && x.failed === 3; }, 'the limited page and the two never-started pages failed');
      let [b] = await summary(e, 'pixiv');
      assert(counts(b) === '0/3/0/0/1', `34h: the limit fails its page and stops the remainder, all counted at once; the held page is still in progress (${counts(b)})`);
      e.openGate(); await running; await settled(e, 'pixiv');
      [b] = await summary(e, 'pixiv');
      assert(counts(b) === '1/3/0/0/0' && e.plan.length === 1 && e.plan[0] === PX(0), `34i: the stopped pages were never requested (${counts(b)})`);
      await waitFinal(e, b.id, 'Saved 1 of 4 · 3 failed');
      assert(e.singleNotes().length === 0, '34j: no ordinary notice for the rate-limited pages');
    }
    // P4: Pixiv, retry: the failed page's job is retried into the same slot; the group becomes all saved and never gains an item
    {
      const e = pworker(PXPAGE);
      await e.ready(); await e.manager.ready;
      e.stagingFails.add('_p1.jpg');
      await runGroup(e, 'pixiv', () => e.pixiv([PX(0), PX(1), PX(2)]));
      let [b] = await summary(e, 'pixiv');
      assert(counts(b) === '2/1/0/0/0', '34k: before the retry: 2 saved, 1 failed');
      await waitFinal(e, b.id, 'Saved 2 of 3 · 1 failed');
      e.stagingFails.clear();
      const failed = (await e.snapshot()).jobs.find((j) => j.state === 'failed');
      assert((await e.command('retry', failed.id)).success === true, '34l: the supported per-file retry is accepted');
      await finishLoop(e, async () => counts((await summary(e, 'pixiv'))[0]) === '3/0/0/0/0', 'retry saved');
      [b] = await summary(e, 'pixiv');
      const afterRetry = await e.snapshot();
      assert(b.count === 3 && afterRetry.jobs.filter((j) => j.batch === b.id).length === 3 && afterRetry.batches.length === 1, `34m: the retry replaced its slot: no new item, no new group, and no extra member row (${afterRetry.jobs.length} rows, ${afterRetry.batches.length} groups)`);
      await waitFinal(e, b.id, 'All 3 files saved');
      assert(e.singleNotes().length === 0 && e.batchNotes().filter((x) => x.opts.final).length >= 2, '34n: the same card moved from the error to all saved; the retried operation made no card of its own');
      // removing a file row does not change the group's counts, and removing every row retires the summary
      const rows = (await e.snapshot()).jobs.filter((j) => j.batch === b.id);
      for (const j of rows.slice(0, 2)) assert((await e.command('remove', j.id)).success === true);
      assert(counts((await summary(e, 'pixiv'))[0]) === '3/0/0/0/0', '34o: removing rows keeps the counts');
      const last = await e.command('remove', rows[2].id);
      assert(last.success === true && last.batches.length === 0, `34p: removing the last member row leaves no orphan summary (${JSON.stringify(last.batches.map((x) => counts(x)))})`);
    }
    // P9: cancelling a queued page: the slot is cancelled (never saved, never failed) and the card says so
    {
      const e = pworker(PXPAGE);
      await e.ready(); await e.manager.ready;
      const run = e.pixiv([PX(0), PX(1), PX(2)]);
      let queued = null;
      await until(async () => { queued = (await e.snapshot()).jobs.find((j) => j.state === 'queued' && j.batch); return Boolean(queued); }, 'a page waits in the queue behind the two active ones');
      assert(queued && (await e.command('cancel', queued.id)).success === true, '34x1: the supported per-file Cancel is accepted for a queued page');
      await runGroup(e, 'pixiv', async () => run);
      const [b] = await summary(e, 'pixiv');
      assert(counts(b) === '2/0/1/0/0', `34x2: two pages saved, one cancelled (${counts(b)})`);
      await waitFinal(e, b.id, 'Saved 2 of 3 · 1 cancelled');
      assert(e.singleNotes().length === 0, '34x3: no ordinary notice for the cancelled page');
    }
    // P5: two Pixiv posts at once: separate groups, separate cards, nothing merged with another post
    {
      const e = pworker(PXPAGE);
      await e.ready(); await e.manager.ready;
      e.stagingFails.add('150000002_p1');
      const runs = Promise.all([e.pixiv([PX(0), PX(1)], '150000001'), e.pixiv([PX(0, '150000002'), PX(1, '150000002')], '150000002')]);
      await finishLoop(e, async () => (await e.snapshot()).batches.length === 2 && (await e.snapshot()).batches.every((b) => b.remaining === 0), 'both groups settled');
      await runs;
      const batches = (await e.snapshot()).batches.sort((a, b) => counts(b).localeCompare(counts(a)));
      assert(batches.length === 2 && new Set(batches.map((b) => b.id)).size === 2 && counts(batches[0]) === '2/0/0/0/0' && counts(batches[1]) === '1/1/0/0/0', '34q: two concurrent posts, two groups with their own counts');
      await waitFinal(e, batches[0].id, 'All 2 files saved'); await waitFinal(e, batches[1].id, 'Saved 1 of 2 · 1 failed');
      assert(e.singleNotes().length === 0, '34r: one card per post');
    }
    // P6: the loop ends early: pages never started are skipped, none is saved or invented
    {
      const e = pworker(PXPAGE);
      await e.ready(); await e.manager.ready;
      const adapt = e.sandbox.adaptCandidateToGroup;
      e.sandbox.adaptCandidateToGroup = (o) => { if (o.url === PX(2)) throw new Error('LOOP_FAILURE'); return adapt(o); };
      const loopError = await e.pixiv([PX(0), PX(1), PX(2), PX(3), PX(4)]).then(() => null, (x) => x);
      assert(loopError && loopError.message === 'LOOP_FAILURE', '34s0: the loop failure is still reported to the caller');
      await settled(e, 'pixiv');
      const [b] = await summary(e, 'pixiv');
      assert(b.count === 5 && counts(b) === '2/0/0/3/0', `34s: after an unexpected exit the started pages are decided by their jobs and the never-started ones are skipped (${counts(b)})`);
    }
    // P7: a failed write while opening the group: no group, no fabricated counts, and the pages are still saved ordinarily
    {
      const idbF = idbDouble();
      const e = pworker(PXPAGE, { indexedDB: idbF });
      await e.ready(); await e.manager.ready;
      idbF.fail = true;
      await e.pixiv([PX(0), PX(1)]);
      await finishLoop(e, async () => (await e.snapshot()).jobs.length === 2 && (await e.snapshot()).jobs.every((j) => j.state === 'complete'), 'ordinary saves');
      const snap = await e.snapshot();
      assert(snap.batches.length === 0 && snap.jobs.every((j) => j.batch === undefined), '34t: the rejected write left no group and no counts; the pages were saved as ordinary files');
      await until(() => e.singleNotes().length === 2, 'ordinary notices');
      assert(e.batchNotes().length === 0, '34u: without a group the ordinary per-file notices remain');
    }
    // P8: worker restart: a Pixiv group reconciles honestly: the two held pages (operation, no job) fail, the never-started pages are skipped
    {
      const idbR = idbDouble();
      const e = pworker(PXPAGE, { indexedDB: idbR });
      await e.ready(); await e.manager.ready;
      e.gates.set('_p0.jpg', new Promise(() => {})); e.gates.set('_p1.jpg', new Promise(() => {}));
      e.pixiv([PX(0), PX(1), PX(2), PX(3)]).catch(() => {});
      await until(async () => e.plan.length === 2 && (await summary(e, 'pixiv'))[0]?.remaining === 4, 'two pages held, two not started');
      const again = pworker(PXPAGE, { indexedDB: idbR, session: e.session, local: e.local, downloadsDb: e.downloadsDb });
      await again.ready(); await again.manager.ready;
      const [b] = await summary(again, 'pixiv');
      assert(b && b.site === 'pixiv' && b.count === 4 && counts(b) === '0/2/0/2/0', `34v: the restored Pixiv group is reconciled: held pages failed, unstarted pages skipped, nothing remains open (${b && counts(b)})`);
      assert(again.plan.length === 0, '34w: the restart fetched nothing');
      await until(() => again.batchNotes().length > 0, 'the restart reconciliation notice');
      assert(again.batchNotes().every((x) => x.opts.title === 'Pixiv post' && x.opts.message === 'Saved 0 of 4 · 2 failed · 2 skipped') && again.singleNotes().length === 0, '34x0: the reconciliation is one Pixiv card');
    }

    // W1: Pawchive, partly imported post with known counts: three declared originals saved, the missing ones are a diagnostic, never a slot
    {
      const e = pworker(PWCARD);
      await e.ready(); await e.manager.ready;
      await runGroup(e, 'pawchive', () => e.pawchive([PW(1), PW(2), PW(3)], 'NOT_ARCHIVED_P2_V1'));
      const [b] = await summary(e, 'pawchive'), snap = await e.snapshot();
      assert(b && b.count === 3 && counts(b) === '3/0/0/0/0' && b.partial === true && snap.batches.length === 1, `34x: three proven originals in one Pawchive group flagged partial; the missing originals are not slots (${b && counts(b)})`);
      assert(!JSON.stringify(snap.batches).includes('P2') && Object.keys(b).sort().join() === 'cancelled,count,createdAt,failed,id,partial,remaining,saved,site,skipped', '34y: the group carries no missing-file count, only the boolean');
      await waitFinal(e, b.id, 'Saved 3 of 3 · some originals not imported');
      const diag = (await e.tracker.list()).filter((r) => r.failure && /^NOT_ARCHIVED/.test(r.failure.code));
      assert(diag.length === 1 && diag[0].failure.code === 'NOT_ARCHIVED_P2_V1' && !(await e.manager.isBatchOp(diag[0].id)), '34z: the specific diagnosis keeps its own failed operation and its counts, outside the slots');
      assert(e.batchNotes().every((x) => !/All 3/.test(x.opts.message)) && e.singleNotes().length === 1 && /not imported|Original not imported/i.test(e.singleNotes()[0].opts.title + e.singleNotes()[0].opts.message), '34aa: a partial post never says all files were saved; the diagnosis is shown by its own error notice');
      const st = await e.stats();
      assert(st.stats.total === 4 && st.stats.success === 3 && st.stats.failed === 1, '34ab: statistics keep their meaning: three saves and the diagnostic as one failed operation');
    }
    // W2: unknown missing count (plain NOT_ARCHIVED), and an all-declared post
    {
      const e = pworker(PWCARD);
      await e.ready(); await e.manager.ready;
      await runGroup(e, 'pawchive', () => e.pawchive([PW(1), PW(2)], 'NOT_ARCHIVED'));
      const [b] = await summary(e, 'pawchive');
      await waitFinal(e, b.id, 'Saved 2 of 2 · some originals not imported');
      assert(b.partial === true && (await e.tracker.list()).some((r) => r.failure && r.failure.code === 'NOT_ARCHIVED'), '34ac: an unknown number of missing originals stays unknown');
      const full = pworker(PWCARD);
      await full.ready(); await full.manager.ready;
      await runGroup(full, 'pawchive', () => full.pawchive([PW(1), PW(2), PW(3)]));
      const [fb] = await summary(full, 'pawchive');
      assert(fb.partial === undefined, '34ad: a complete post has no partial flag');
      await waitFinal(full, fb.id, 'All 3 files saved');
      assert(full.batchNotes().at(-1).opts.title === 'Pawchive post' && full.singleNotes().length === 0, '34ae: a complete post says all files saved under the Pawchive label');
    }
    // W3: mixed: a refused item (not media), an HTTP 404, a rate limit that stops the remainder, a duplicate, and a saved one
    {
      const e = pworker(PWCARD);
      await e.ready(); await e.manager.ready;
      e.answers.set(hexOf(2), 'html'); e.answers.set(hexOf(3), 404); e.answers.set(hexOf(4), 429); e.inFlight(PW(1));
      await runGroup(e, 'pawchive', () => e.pawchive([PW(0), PW(1), PW(2), PW(3), PW(4), PW(5), PW(6)]));
      const [b] = await summary(e, 'pawchive');
      assert(b.count === 7 && counts(b) === '1/5/0/1/0', `34af: saved 1; failed: not media, 404, 429, and the two after the limit; the duplicate is skipped (${counts(b)})`);
      assert(b.saved + b.failed + b.cancelled + b.skipped + b.remaining === b.count && (await e.tracker.list()).filter((r) => r.state === 'failed').length === 5, '34ag: every proven item is counted exactly once');
      assert(e.singleNotes().length === 0 && e.batchNotes().at(-1).opts.final === true, '34ah: pre-job refusals and rate limits make no card of their own');
    }
    // W4: the cap boundary: 100 originals with a partial import are one group of 100 plus the diagnostic; 101 are refused as before; one original is the ordinary path
    {
      const e = pworker(PWCARD);
      await e.ready(); await e.manager.ready;
      e.answers.set('cccc', 404);
      await e.pawchive(Array.from({ length: 100 }, (_, i) => PW(i)), 'NOT_ARCHIVED');
      const [b] = await summary(e, 'pawchive');
      assert(b.count === 100 && b.partial === true && counts(b) === '0/100/0/0/0', '34ai: exactly 100 proven originals are one group; the missing ones add no slot');
      assert((await e.tracker.list()).filter((r) => r.failure && r.failure.code === 'NOT_ARCHIVED').length === 1, '34aj: and one diagnostic operation');
      const over = pworker(PWCARD);
      await over.ready(); await over.manager.ready;
      await over.pawchive(Array.from({ length: 101 }, (_, i) => PW(i)), 'NOT_ARCHIVED');
      assert((await over.snapshot()).batches.length === 0 && (await over.tracker.list()).length === 1 && (await over.tracker.list())[0].failure.code === 'BATCH_LIMIT' && over.plan.length === 0, '34ak: 101 originals are refused with BATCH_LIMIT, no group, no request, no truncation');
      const one = pworker(PWCARD);
      await one.ready(); await one.manager.ready;
      await one.pawchive([PW(1)], 'NOT_ARCHIVED_P1_V0');
      await finishLoop(one, async () => (await one.tracker.list()).filter((r) => r.state === 'complete').length === 1, 'single original saved');
      assert((await one.snapshot()).batches.length === 0 && (await one.tracker.list()).length === 2, '34al: one declared original keeps the ordinary single-file path (and its diagnostic)');
    }
    // W5: success notices off: an all-saved Pawchive group is silent, but a partial post's diagnostic error remains visible
    {
      const e = pworker(PWCARD, { local: { notifySuccess: false } });
      await e.ready(); await e.manager.ready;
      await runGroup(e, 'pawchive', () => e.pawchive([PW(1), PW(2)], 'NOT_ARCHIVED_P1_V1'));
      await e.tracker.flush(); await sleep(120);
      assert(e.batchNotes().every((x) => x.opts.dismissBatch === true || x.opts.kind === 'error') && e.batchNotes().every((x) => !/Saved 2 of 2/.test(x.opts.message)) && e.singleNotes().filter((x) => x.opts.kind === 'error').length === 1, '34am: with success notices off no success card is created; the partial-import error is still shown');
    }
    // W6: two Pawchive posts and a Pixiv post at once keep separate groups and labels
    {
      const e = pworker(PWCARD);
      await e.ready(); await e.manager.ready;
      const runs = Promise.all([e.pawchive([PW(1), PW(2)]), e.pawchive([PW(11), PW(12), PW(13)], 'NOT_ARCHIVED'), e.pixiv([PX(0), PX(1)])]);
      await finishLoop(e, async () => { const s = await e.snapshot(); return s.batches.length === 3 && s.batches.every((b) => b.remaining === 0); }, 'three groups settled');
      await runs;
      const s = await e.snapshot();
      assert(s.batches.map((b) => b.site).sort().join() === 'pawchive,pawchive,pixiv' && s.batches.filter((b) => b.partial).length === 1, '34an: concurrent groups stay separate');
      await until(() => e.batchNotes().filter((x) => x.opts.final).length >= 3, 'three final cards');
      assert(new Set(e.batchNotes().map((x) => x.opts.batch)).size === 3 && ['Pawchive post', 'Pixiv post'].every((t) => e.batchNotes().some((x) => x.opts.title === t)), '34ao: one card per post with the right service label');
    }
  }

  // 31. A manager-polled completion/failure must notify after the feedback record becomes terminal.
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const outcome of ['complete', 'failed']) {
    const s = {console, setTimeout, clearTimeout, URL, AbortController}; vm.createContext(s);
    for (const file of ['lib/feedback.js', 'lib/feedback_tracker.js', 'lib/download_manager.js']) vm.runInContext(read(file), s);
    s.FeedbackLib = s.ImageSaverFeedback;
    const bg = read('background.js');
    const a = bg.indexOf('async function feedbackNotifyRecord('), b = bg.indexOf('var feedbackNotifier =');
    const c = bg.indexOf('async function batchMemberOp('), d = bg.indexOf('async function downloadManagerSnapshot(');
    if (a < 0 || b < a || c < 0 || d < c) throw Error('Missing production notification helpers');
    vm.runInContext('var downloadManager=null,feedbackTracker=null,feedbackNotifier=null;' + bg.slice(a,b) + bg.slice(c,d), s);
    let sequence = 0; const notices = [];
    s.feedbackNotifier = s.ImageSaverFeedbackTracker.createNotifier({lang:'en',getPrefs:async()=>({notifySuccess:true}),deliver:async(record,opts)=>{notices.push(opts);return true;}});
    s.feedbackTracker = s.ImageSaverFeedbackTracker.createTracker({storage:{get:async()=>null,set:async()=>{}},genId:()=>'op-order-'+(++sequence),getDownloadItem:async()=>({id:99,state:'in_progress'}),notify:record=>s.feedbackNotifyRecord(record)});
    await s.feedbackTracker.ready;
    s.downloadManager = s.MediaLatchDownloads.createManager({
      store:{get:async()=>({jobs:[],paused:false}),set:async()=>{}},id:()=>'id-order-'+(++sequence),sleep:()=>sleep(1),batchChanged:value=>s.batchNoticeChanged(value),
      stage:async()=>{if(outcome==='failed')throw Error('NETWORK_FAILED');return {size:8,mime:'image/png'};},fileUrl:async()=>'blob:test',export:async()=>99,
      search:async()=>({id:99,state:'complete',filename:'polled.png',fileSize:8}),attach:async(job,id)=>s.feedbackTracker.attachDownload(job.op,id),
      complete:async job=>s.feedbackTracker.downloadTerminal(job.downloadId,'complete'),failed:async job=>s.feedbackTracker.fail(job.op,{stage:'download',code:job.error}),remove:async()=>{}
    });
    await s.downloadManager.ready;
    const batch = await s.downloadManager.openBatch('x',2), op = await s.feedbackTracker.begin({noticeTarget:{tabId:7,origin:'https://x.com'}});
    await s.downloadManager.bindSlot({id:batch,i:0},op);
    await s.downloadManager.enqueue({url:'https://media.test/polled',filename:'polled.png'},{op}).catch(()=>{});
    await s.downloadManager.drain(); await s.feedbackTracker.flush(); await sleep(30);
    assert(notices.length===1 && notices[0].message.includes(outcome==='complete'?'Saved 1 of 2':'1 failed'), `31 ${outcome}: the first terminal result is delivered once without an onChanged event or another slot change`);
  }

  console.log('\n--- 32. Statistics by site: owning-site attribution through the production worker ---');
  {
    const idb = idbDouble();
    const env = makeEnv({ local: { historyEnabled: true }, indexedDB: idb, captureManager: true }); await env.ready();
    const sender = { id: 'testid', url: 'chrome-extension://testid/popup/popup.html' };
    const ask = (action) => new Promise((resolve) => { for (const l of env.messageListeners) { let replied = false; const keep = l({ action }, sender, (r) => { replied = true; resolve(r); }); if (keep || replied) return; } resolve(null); });
    const snap = async () => await ask('STATISTICS_LIST');
    const sum = (s) => Object.values(s.sites).reduce((n, b) => n + b.total, 0);
    const finish = async (pageUrl, sourceUrl) => { const op = await env.x.fbBegin({ pageUrl, sourceUrl, site: env.sandbox.fbSiteOf(pageUrl, sourceUrl) }); await env.x.fbFail(op, { code: 'NETWORK_FAILED' }); await env.tracker.flush(); return op; };
    const first = await snap();
    assert(first.success && Object.keys(first.sites).join() === env.sandbox.MediaLatchStatistics.SITES.join() && first.sites.danbooru && first.sites.zerochan && first.sites.tenor && !first.sites.booru, '32a: the snapshot carries every category bucket in the shared order');
    await finish('https://www.reddit.com/r/gifs/comments/abc/', 'https://thumbs2.redgifs.com/clip.mp4');
    let s = await snap(); assert(s.sites.reddit.total === 1 && s.sites.redgifs.total === 0, '32b: Reddit-embedded RedGIFs is counted for Reddit');
    await finish('https://www.redgifs.com/watch/clip', 'https://thumbs2.redgifs.com/clip.mp4');
    await finish('https://twitter.com/a/status/1', 'https://pbs.twimg.com/media/a.jpg');
    await finish('https://example.com/gallery/1', 'https://cdn.example.net/a.jpg');
    await finish('https://danbooru.donmai.us/posts/1', 'https://cdn.donmai.us/a.jpg');
    const unknown = await env.x.fbBegin({ sourceUrl: 'https://pbs.twimg.com/media/b.jpg' }); await env.x.fbFail(unknown, { code: 'NETWORK_FAILED' }); await env.tracker.flush();
    s = await snap();
    assert(s.sites.redgifs.total === 1 && s.sites.x.total === 1 && s.sites.other.total === 1 && s.sites.danbooru.total === 1, '32c: owning pages give their own categories and a generic site is only "other"');
    assert(s.sites.unattributed.total === 1 && s.stats.total === 6 && sum(s) === s.stats.total, '32d: an operation without owning-site metadata stays unattributed (a media CDN gives no site) and the buckets add up to the total');
    for (const k of ['success', 'failed', 'cancelled', 'unknown']) assert(Object.values(s.sites).reduce((n, b) => n + b[k], 0) === s.stats[k], '32e: every outcome metric reconciles: ' + k);
    assert(!JSON.stringify(s).includes('example') && !JSON.stringify(s).includes('donmai') && !JSON.stringify(s).includes('twimg'), '32f: the snapshot names no host');

    // A retry and a restart recovery keep the owning site of the attempt they replace
    const old = await finish('https://www.reddit.com/r/a/comments/1/', 'https://i.redd.it/a.jpg');
    const before = (await snap()).sites.reddit.failed;
    for (const action of ['newAttempt', 'recoverAttempt']) {
      const op = await env.managerDeps[action]({ op: old, source: 'https://i.redd.it/a.jpg', mime: 'image/jpeg' });
      assert((await env.tracker.get(op)).site === 'reddit', '32g: ' + action + ' keeps the owning site of the previous record');
      await env.x.fbFail(op, { code: 'NETWORK_FAILED' }); await env.tracker.flush();
    }
    assert((await snap()).sites.reddit.failed === before + 2, '32h: the attempts are counted under the same site');
    const gone = await env.managerDeps.newAttempt({ op: 'op-evicted', source: 'https://pbs.twimg.com/a.jpg', mime: 'image/jpeg', selectedPage: 'https://x.com' });
    assert((await env.tracker.get(gone)).site === 'x', '32i: without the previous record the admitting page origin the job keeps gives the site');
    const lost = await env.managerDeps.newAttempt({ op: 'op-evicted', source: 'https://pbs.twimg.com/a.jpg', mime: 'image/jpeg' });
    assert((await env.tracker.get(lost)).site === '', '32j: with neither, the site stays unknown: a media CDN never gives it');
    const recovered = await env.managerDeps.recoverAttempt({ op: 'op-evicted', source: 'https://i.redd.it/a.jpg', mime: 'image/jpeg', selectedPage: 'https://www.reddit.com' });
    assert((await env.tracker.get(recovered)).site === 'reddit', '32k: a recovered attempt without its record takes the admitting origin');
    const unknownOld = await env.x.fbBegin({ sourceUrl: 'https://cdn.example.net/a.jpg', site: 'unknown-site' });
    await env.x.fbFail(unknownOld, { code: 'NETWORK_FAILED' }); await env.tracker.flush();
    const renewed = await env.managerDeps.newAttempt({ op: unknownOld, source: 'https://cdn.example.net/a.jpg', mime: 'image/jpeg', selectedPage: 'https://www.pixiv.net' });
    assert((await env.tracker.get(renewed)).site === 'pixiv', '32l: an unknown earlier site yields to the admitting origin');

    // Disabled recording preserves every bucket; the global clear empties all of them; a late pre-clear completion is ignored
    const kept = JSON.stringify((await snap()).sites);
    env.local.historyEnabled = false; await finish('https://www.pixiv.net/artworks/1', 'https://i.pximg.net/a.jpg');
    assert(JSON.stringify((await snap()).sites) === kept, '32m: recording off preserves every bucket');
    env.local.historyEnabled = true;
    const lateOp = await env.x.fbBegin({ pageUrl: 'https://www.pixiv.net/artworks/2', sourceUrl: 'https://i.pximg.net/b.jpg', site: 'pixiv' });
    const cleared = await ask('STATISTICS_CLEAR');
    assert(cleared.success && cleared.stats.total === 0 && Object.values(cleared.sites).every((b) => b.total === 0), '32n: clearing is global');
    await env.x.fbFail(lateOp, { code: 'NETWORK_FAILED' }); await env.tracker.flush();
    s = await snap(); assert(s.stats.total === 0 && sum(s) === 0, '32o: a completion of an operation that began before the clear never returns, in any bucket');
    await new Promise((r) => setTimeout(r, 8)); await finish('https://www.pixiv.net/artworks/3', 'https://i.pximg.net/c.jpg');
    s = await snap(); assert(s.stats.total === 1 && s.sites.pixiv.total === 1 && sum(s) === 1, '32p: the next operation after the clear is counted once, in its own bucket');
  }

  // 33. Converted outputs keep a private owning-site token even after their bounded feedback record is evicted.
  {
    const env=makeEnv({captureManager:true,local:{historyEnabled:true}});await env.ready();let admitted;
    const manager=vm.runInContext('downloadManager',env.sandbox);
    const queue=manager.enqueue;manager.enqueue=async(options,meta)=>{admitted=meta;return 101;};
    const old=await env.x.fbBegin({site:'reddit',sourceUrl:'https://v.redd.it/source/DASH_360.mp4'});
    await env.sandbox.managedDownload({url:'blob:chrome-extension://testid/converted',filename:'converted.gif'},old,'image/gif');
    manager.enqueue=queue;
    assert(admitted.site==='reddit' && admitted.selectedPage==='','33a: converted output captures the known owner without requiring a page URL');
    await env.x.fbFail(old,{code:'EXPORT_FAILED'});
    for(let i=0;i<21;i++){const op=await env.x.fbBegin({site:'x'});await env.x.fbFail(op,{code:'NETWORK_FAILED'});}
    await env.tracker.flush();assert(!(await env.tracker.get(old)),'33b: the original feedback record really was evicted');
    for(const action of ['newAttempt','recoverAttempt']){
      const op=await env.managerDeps[action]({op:old,source:'blob:chrome-extension://testid/converted',mime:'image/gif',site:admitted.site});
      assert((await env.tracker.get(op)).site==='reddit','33c: '+action+' uses the private job owner after record eviction');
    }
    const corrected=await env.x.fbBegin({site:'pixiv'});await env.x.fbFail(corrected,{code:'EXPORT_FAILED'});
    const op=await env.managerDeps.newAttempt({op:corrected,source:'blob:chrome-extension://testid/converted',mime:'image/gif',site:'reddit'});
    assert((await env.tracker.get(op)).site==='pixiv','33d: a retained corrected record still outranks the admitted job token');
  }

  console.log(`\nИТОГИ: ${passed}/${passed + failed} пройдено (${failed} ошибок).`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Ошибка в тестовом сценарии:', err);
  process.exit(1);
});

