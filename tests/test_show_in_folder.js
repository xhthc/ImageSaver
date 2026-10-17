'use strict';
// REFACTOR-CHROME-API-01: "Show in folder" of a Downloads card, through the real authenticated worker route (background.js DOWNLOADS_COMMAND ->
// revealManagedDownload) and the real downloads controller (ui/src/core/downloads.js). chrome.downloads is intercepted: these checks prove which
// call is made with which id, never that the operating system opened a window (that is native evidence, recorded separately).
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
process.chdir(path.resolve(__dirname, '..'));
require('../lib/sites.js'); require('../lib/feedback.js'); require('../worker/feedback_tracker.js');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

// The worker with the real background.js and a stand-in manager whose persisted jobs the test decides.
function worker() {
  const listeners = [], shown = [], searches = [];
  const state = { jobs: [], items: [] };
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  const chrome = {
    runtime: { id: 'testid', lastError: null, getURL: (p) => 'chrome-extension://testid/' + p, getManifest: () => ({ version: '2.5.6' }), onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn) { listeners.push(fn); } }, getContexts: async () => [], sendMessage: async () => null },
    storage: { local: area, session: area, onChanged: { addListener() {} } },
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
    contextMenus: { removeAll: (cb) => cb && cb(), create() {}, update: (id, p, cb) => cb && cb(), refresh() {}, onClicked: { addListener() {} }, onShown: { addListener() {} } },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} }, query: async () => [], sendMessage: async () => {} },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    notifications: { create: async () => '1', clear: () => {}, onClicked: { addListener() {} } },
    downloads: { search: async (q) => { searches.push(JSON.parse(JSON.stringify(q))); return state.items.filter((x) => x.id === q.id).map((x) => ({ ...x })); }, show: (id) => { shown.push(id); }, download: async () => 1, cancel: async () => {}, onChanged: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} }
  };
  const sandbox = {
    chrome, URL, indexedDB: {}, crypto: { randomUUID: () => 'uuid' }, console: { log() {}, info() {}, warn() {}, error() {} }, setTimeout, clearTimeout, structuredClone,
    fetch: async () => ({ ok: true, status: 200, headers: new Map() }),
    importScripts: (file) => { if (/^(?:lib\/(?:media_sources|media_guard|sites)|worker\/(?:media_format|download_paths|candidates|site_resolvers|booru_resolvers|page_selection|x_recovery|toolbar_badge|offscreen|providers|pipeline|animation))\.js$/.test(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox); },
    ImageSaverFeedback: globalThis.ImageSaverFeedback, ImageSaverFeedbackTracker: globalThis.ImageSaverFeedbackTracker,
    MediaLatchDownloads: {
      createManager: () => ({ ready: Promise.resolve(), drain: async () => {}, command: async () => {}, list: async () => ({ jobs: state.jobs.map((j) => ({ ...j })), paused: false }) }),
      database: () => ({ get: async () => ({ jobs: [], paused: false }), set: async () => {} })
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), sandbox);
  const handler = listeners.find((fn) => fn.toString().includes("m?.action!=='DOWNLOADS_LIST'"));
  const page = { id: 'testid', url: chrome.runtime.getURL('popup/popup.html') }, popup = { id: 'testid', url: chrome.runtime.getURL('popup/quick.html') };
  const reveal = (id, from = page, extra = {}) => new Promise((resolve) => { const r = handler({ action: 'DOWNLOADS_COMMAND', command: 'showInFolder', id, ...extra }, from, (v) => resolve(JSON.parse(JSON.stringify(v)))); if (r === false) resolve('NOT_ADMITTED'); });
  return { state, shown, searches, reveal, page, popup, sandbox };
}
const complete = (id, downloadId, extra = {}) => ({ id, state: 'complete', downloadId, filename: 'photo (1).jpg', site: 'x', ...extra });
const item = (id, extra = {}) => ({ id, state: 'complete', exists: true, byExtensionId: 'testid', filename: 'C:\\Users\\u\\Downloads\\SavedImages\\photo (1).jpg', ...extra });

(async () => {
  // ---- the worker route ----
  await test('an owned, completed browser download is revealed with ITS recorded DownloadItem id (the collision-renamed file), from both extension pages', async () => {
    const w = worker(); w.state.jobs = [complete('job-a', 41), complete('job-b', 42)]; w.state.items = [item(41), item(42)];
    assert.deepEqual(await w.reveal('job-b'), { success: true });
    assert.deepEqual(await w.reveal('job-a', w.popup), { success: true });
    assert.deepEqual(w.shown, [42, 41], 'chrome.downloads.show(downloadId) with the job\'s own id; never open(), never the default folder');
    assert.deepEqual(w.searches, [{ id: 42 }, { id: 41 }], 'the browser is asked about exactly that id');
  });
  await test('the page names a job only: a page-supplied download id or path is ignored', async () => {
    const w = worker(); w.state.jobs = [complete('job-a', 41)]; w.state.items = [item(41), item(999)];
    assert.deepEqual(await w.reveal('job-a', w.page, { downloadId: 999, path: 'C:\\Windows\\system32' }), { success: true });
    assert.deepEqual(w.shown, [41]);
  });
  await test('foreign senders are refused before any browser call: a web page, a content script, another extension, an unlisted extension page', async () => {
    for (const from of [{ id: 'testid', url: 'https://example.com/' }, { id: 'testid', tab: { id: 1 }, url: 'https://x.com/home' }, { id: 'other', url: 'chrome-extension://other/popup/popup.html' }, { id: 'testid', url: 'chrome-extension://testid/offscreen.html' }]) {
      const w = worker(); w.state.jobs = [complete('job-a', 41)]; w.state.items = [item(41)];
      assert.deepEqual(await w.reveal('job-a', from), { success: false, error: 'FORBIDDEN' }, JSON.stringify(from));
      assert.deepEqual(w.shown, []); assert.deepEqual(w.searches, []);
    }
  });
  await test('refusals name their reason and call nothing: missing job, unfinished or failed job, no numeric id (chosen-folder export, null, string), wrong owner, missing history, unfinished item, removed file', async () => {
    const cases = [
      ['missing job', [], [], 'job-x', 'JOB_NOT_FOUND'],
      ['active job', [{ id: 'job-a', state: 'receiving', downloadId: null }], [], 'job-a', 'JOB_NOT_COMPLETE'],
      ['failed job', [{ id: 'job-a', state: 'failed', downloadId: 41 }], [item(41)], 'job-a', 'JOB_NOT_COMPLETE'],
      ['chosen-folder export (receipt id)', [complete('job-a', 'file:job-a')], [], 'job-a', 'NOT_A_BROWSER_DOWNLOAD'],
      ['null id', [complete('job-a', null)], [], 'job-a', 'NOT_A_BROWSER_DOWNLOAD'],
      ['string id', [complete('job-a', '41')], [item(41)], 'job-a', 'NOT_A_BROWSER_DOWNLOAD'],
      ['negative id', [complete('job-a', -1)], [], 'job-a', 'NOT_A_BROWSER_DOWNLOAD'],
      ['another extension\'s item', [complete('job-a', 41)], [item(41, { byExtensionId: 'someone-else' })], 'job-a', 'DOWNLOAD_NOT_IN_HISTORY'],
      ['a user download (no extension id)', [complete('job-a', 41)], [item(41, { byExtensionId: undefined })], 'job-a', 'DOWNLOAD_NOT_IN_HISTORY'],
      ['erased from browser history', [complete('job-a', 41)], [], 'job-a', 'DOWNLOAD_NOT_IN_HISTORY'],
      ['item not complete', [complete('job-a', 41)], [item(41, { state: 'interrupted' })], 'job-a', 'DOWNLOAD_NOT_COMPLETE'],
      ['file deleted from disk', [complete('job-a', 41)], [item(41, { exists: false })], 'job-a', 'FILE_REMOVED'],
      ['no job id', [complete('job-a', 41)], [item(41)], undefined, 'JOB_NOT_FOUND']
    ];
    for (const [name, jobs, items, id, code] of cases) {
      const w = worker(); w.state.jobs = jobs; w.state.items = items;
      assert.deepEqual(await w.reveal(id), { success: false, error: code }, name);
      assert.deepEqual(w.shown, [], name + ': no show()');
    }
  });

  // ---- the controller shared by the popup and the full manager ----
  const { createDownloads, jobActions } = await import('../ui/src/core/downloads.js');
  await test('only a finished, tracked browser download offers the action; a chosen-folder export, a preparation and unfinished rows never show a dead icon', async () => {
    assert.deepEqual(jobActions(complete('a', 41)), ['showInFolder']);
    assert.deepEqual(jobActions(complete('a', 0)), ['showInFolder'], 'id 0 is a valid DownloadItem id');
    for (const j of [complete('a', 'file:job-a'), complete('a', null), complete('a', 41, { managed: false }), { id: 'a', state: 'receiving', downloadId: 41 }, { id: 'a', state: 'failed', downloadId: 41, error: 'HTTP_ERROR' }, { id: 'a', state: 'cancelled', downloadId: 41 }])
      assert(!jobActions(j).includes('showInFolder'), JSON.stringify(j));
    assert.deepEqual(jobActions({ id: 'a', state: 'receiving' }), ['cancel']); assert.deepEqual(jobActions({ id: 'a', state: 'failed', error: 'HTTP_ERROR' }), ['retry']); assert.deepEqual(jobActions({ id: 'a', state: 'failed', error: 'EXPORT_UNCERTAIN' }), []);
  });
  function ui(replies) {
    const sent = [], changed = [];
    const chrome = { runtime: { sendMessage: async (m) => { sent.push(m); return replies(m); }, onMessage: { addListener: (fn) => changed.push(fn), removeListener() {} } } };
    const c = createDownloads({ chrome });
    return { c, sent, refresh: () => changed.forEach((fn) => fn({ action: 'DOWNLOADS_CHANGED' })) };
  }
  const list = { success: true, jobs: [complete('job-a', 41), complete('job-b', 42)], paused: false, batches: [] };
  await test('a failed reveal keeps every card, names that card, survives automatic refreshes and is cleared by the next command', async () => {
    let refuse = true;
    const u = ui((m) => (m.action === 'DOWNLOADS_LIST' ? list : m.command === 'showInFolder' ? (refuse ? { success: false, error: 'FILE_REMOVED' } : { success: true }) : { success: true }));
    await u.c.load();
    await u.c.command('showInFolder', 'job-b');
    let s = u.c.store.getState();
    assert.equal(s.error, 'downloads.revealFailed'); assert.equal(s.errorJob, 'job-b'); assert.deepEqual(s.jobs.map((j) => j.id), ['job-a', 'job-b'], 'the card stays');
    assert.deepEqual(u.sent.filter((m) => m.action === 'DOWNLOADS_COMMAND'), [{ action: 'DOWNLOADS_COMMAND', command: 'showInFolder', id: 'job-b' }], 'only the job id is sent');
    u.refresh(); await u.c.load();
    s = u.c.store.getState(); assert.equal(s.error, 'downloads.revealFailed', 'a normal refresh does not erase the failure'); assert.equal(s.errorJob, 'job-b');
    refuse = false; await u.c.command('showInFolder', 'job-a');
    s = u.c.store.getState(); assert.equal(s.error, ''); assert.equal(s.errorJob, '', 'a later successful command clears it');
    await u.c.command('showInFolder', 'job-a'); assert.equal(u.sent.filter((m) => m.command === 'showInFolder').length, 3, 'repeatable');
  });
  await test('closing the page owns nothing: a reveal is one request, a disposed controller does not write state afterwards', async () => {
    let release; const pending = new Promise((r) => { release = r; });
    const u = ui((m) => (m.action === 'DOWNLOADS_LIST' ? list : pending));
    await u.c.load(); const done = u.c.command('showInFolder', 'job-a'); u.c.dispose(); release({ success: false, error: 'FILE_REMOVED' }); await done;
    assert.equal(u.c.store.getState().error, '', 'a closed popup is not updated'); assert.equal(u.sent.filter((m) => m.command === 'showInFolder').length, 1);
  });
  console.log(`${passed} show-in-folder checks passed (intercepted chrome.downloads calls; no OS window evidence)`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
