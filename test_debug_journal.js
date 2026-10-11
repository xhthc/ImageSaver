'use strict';
// test_debug_journal.js - DEBUG-MENU-01: the opt-in debug journal.
// The real lib/debug_journal.js (schema, retention, journal, producer client) and the real background.js (single writer, ingestion
// with sender-derived context, private list/clear, worker events) with a mocked Chrome. Mock results are not native acceptance.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); } catch (err) { failed++; console.error('  ✗ ' + name); console.error(err && err.stack ? err.stack : err); }
}
const LIB = fs.readFileSync(path.join(__dirname, 'lib', 'debug_journal.js'), 'utf8');
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m); // vm objects come from another realm
const tick = () =>new Promise((r) => setImmediate(r));
const quiesce = async (n = 30) => { for (let i = 0; i < n; i++) await tick(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function loadLib(extra = {}) {
  const ctx = vm.createContext({ URL, Date, Math, JSON, Uint8Array, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout, Promise, ...extra });
  vm.runInContext(LIB, ctx);
  return ctx;
}
const D = loadLib().ImageSaverDebug;
const NOW = Date.now();
const ev = (over = {}) => ({ t: NOW, lvl: 'info', comp: 'menu', act: 'click', out: 'start', ...over });

function memStorage({ failSet = false, failGet = false } = {}) {
  const data = {};
  const s = {
    data, writes: 0, failSet, failGet,
    get: async (k) => { if (s.failGet) throw new Error('READ'); return data[k] === undefined ? undefined : JSON.parse(JSON.stringify(data[k])); },
    set: async (k, v) => { if (s.failSet) throw new Error('QUOTA'); s.writes++; data[k] = JSON.parse(JSON.stringify(v)); }
  };
  return s;
}

(async () => {
  console.log('=== test_debug_journal.js (DEBUG-MENU-01) ===\n--- L: schema, retention, journal, client ---');

  await test('L1 sanitize: codes, hosts, numbers and ids pass; addresses become hosts; free text, unknown keys, tokens, paths and raw errors never pass', () => {
    const out = D.sanitizeEvent(ev({
      src: 'worker', why: 'TARGET_CHANGED', cid: 'a1b2c3d4', op: 'op-abc-123',
      d: {
        host: 'https://cdn.example.com/a/secret.jpg?token=SIGNED&sig=x#frag', srcHost: 'blob:https://x.com/123', pageHost: 'www.reddit.com', http: 404, mime: 'Video/MP4; codecs=x',
        n: 3, ok: true, postId: '2108779775812927788', ownerId: 't3_abc12', mediaId: 'K_media-1', kind: 'video',
        url: 'https://x.test/?q=1', filename: 'secret.jpg', folder: 'SavedImages', error: new Error('raw stack').stack, stage: 'C:\\Users\\me\\file', reason: 'some free text',
        detail: 'deadbeefdeadbeefdeadbeefdeadbeef', which: 'a'.repeat(60), cookie: 'sid=1', text: 'post text'
      }
    }), { src: 'content', tab: 7, frame: 2, doc: 'ABCDEF0123', page: 'https://www.reddit.com/r/x/comments/1/a?utm=1' });
    same(out.d, { host: 'cdn.example.com', srcHost: 'blob', pageHost: 'www.reddit.com', http: 404, mime: 'video/mp4', n: 3, ok: true, postId: '2108779775812927788', ownerId: 't3_abc12', mediaId: 'K_media-1', kind: 'video' });
    assert.strictEqual(out.src, 'content', 'the context (sender) decides the source, not the event');
    assert.deepStrictEqual([out.tab, out.frame, out.page, out.why, out.cid, out.op], [7, 2, 'www.reddit.com', 'TARGET_CHANGED', 'a1b2c3d4', 'op-abc-123']);
    assert(!JSON.stringify(out).match(/secret|token|SIGNED|frag|x\.test|Users|stack|free text|deadbeef|sid=|post text|SavedImages/));
    assert.strictEqual(D.sanitizeEvent(ev({ why: 'free text' }), { src: 'worker' }).why, undefined);
    assert.strictEqual(D.sanitizeEvent(ev({ comp: 'Bad Comp' }), { src: 'worker' }), null);
    assert.strictEqual(D.sanitizeEvent(ev(), { src: 'evil' }), null);
    assert.strictEqual(D.sanitizeEvent(ev({ t: 5 }), { src: 'worker' }), null);
    assert.strictEqual(D.sanitizeEvent(ev({ cid: 'f'.repeat(32) }), { src: 'worker' }).cid, undefined, 'a 32-hex value (a one-shot token) is never an attempt id');
  });

  await test('L2 retention: age (expired), count and bytes (dropped), oldest first', () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ ...D.sanitizeEvent(ev({ t: NOW - (9 - i) * 1000 }), { src: 'worker' }), seq: i + 1 }));
    let p = D.prune(list, NOW, { retentionMs: 4500 });
    assert.deepStrictEqual([p.events.length, p.expired, p.dropped], [5, 5, 0]);
    p = D.prune(list, NOW, { maxEvents: 3 });
    assert.deepStrictEqual([p.events.length, p.events[0].seq, p.dropped], [3, 8, 7]);
    const last4 = list.slice(-4).reduce((a, e) => a + JSON.stringify(e).length + 1, 2);
    p = D.prune(list, NOW, { maxBytes: last4 });
    assert(p.events.length === 4 && p.dropped === 6 && p.bytes === last4);
    assert.deepStrictEqual([D.MAX_EVENTS, D.MAX_BYTES, D.RETENTION_MS], [2000, 1048576, 86400000]);
    const full = D.prune(Array.from({ length: 2100 }, (_, i) => ({ ...list[0], t: NOW, seq: i + 1 })), NOW);
    assert(full.events.length === 2000 && full.dropped === 100);
  });

  await test('L3 journal: batched write, list re-sanitizes, a failed write is not reported as persisted and is retried, restart keeps written events only', async () => {
    const st = memStorage();
    let timers = [];
    const deps = { storage: st, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} };
    const j = D.createJournal(deps);
    j.append(ev({ act: 'one' }), { src: 'worker' });
    j.append(ev({ act: 'two' }), { src: 'content', tab: 1 });
    assert.strictEqual(st.writes, 0, 'nothing is written before the batch');
    st.failSet = true;
    await j.flush();
    let l = await j.list();
    assert(l.retained === 2 && l.persisted === 0 && l.storageError === 'STORAGE_WRITE', 'a failed write is visible and not claimed as persisted');
    st.failSet = false;
    l = await j.list();
    assert(l.persisted === 2 && l.storageError === '' && l.events.map(e => e.seq).join() === '1,2', 'refresh retries unsaved events without a new append or duplicate sequence');
    j.append(ev({ act: 'three' }), { src: 'worker' });
    l = await j.list();
    assert(l.retained === 3 && l.persisted === 3 && l.storageError === '' && l.events.map((e) => e.act).join() === 'one,two,three' && l.events.every((e, i) => e.seq === i + 1));
    j.append(ev({ act: 'four' }), { src: 'worker' }); // pending, never written: lost on restart (it was never acknowledged)
    const j2 = D.createJournal({ storage: st, setTimer: () => 0, clearTimer: () => {} });
    l = await j2.list();
    assert.strictEqual(l.events.map((e) => e.act).join(), 'one,two,three', 'acknowledged events survive a restart');
    timers = [];
  });

  await test('L4 clear: removes only the journal, is serialized with appends/flushes, a late event from before the clear never comes back, a failed clear keeps everything', async () => {
    const st = memStorage();
    st.data.other = { keep: true };
    let now = NOW;
    const j = D.createJournal({ storage: st, now: () => now, setTimer: () => 0, clearTimer: () => {} });
    j.append(ev({ act: 'a', t: NOW - 10 }), { src: 'worker' });
    await j.flush();
    j.append(ev({ act: 'late', t: NOW - 5 }), { src: 'worker' }); // created before the clear, delivered after it
    now = NOW + 1;
    const [cleared, listed] = await Promise.all([j.clear(), j.list()]);
    assert(cleared === true && listed.retained === 0, 'the clear wins over the pending event created before it');
    j.append(ev({ act: 'b', t: NOW + 2 }), { src: 'worker' });
    const after = await j.list();
    assert.strictEqual(after.events.map((e) => e.act).join(), 'b');
    assert.deepStrictEqual(st.data.other, { keep: true }, 'clear touches nothing but the journal');
    const reopened = await D.createJournal({ storage: st, setTimer: () => 0, clearTimer: () => {} }).list();
    assert.strictEqual(reopened.events.map((e) => e.act).join(), 'b', 'a restart does not resurrect cleared events');
    st.failSet = true;
    await assert.rejects(j.clear());
    st.failSet = false;
    assert.strictEqual((await j.list()).retained, 1, 'a failed clear deletes nothing');
  });

  await test('L5 unreadable hydration preserves old storage and bounded unsaved events; recovery merges them before writing', async () => {
    const st = memStorage({ failGet: true });
    st.data[D.STORAGE_KEY] = { v: 1, events: [{ ...D.sanitizeEvent(ev({ act: 'old', t: NOW - 10 }), { src: 'worker' }), seq: 7 }], dropped: 3, expired: 4, clearedAt: NOW - 50 };
    const j = D.createJournal({ storage: st, setTimer: () => 0, clearTimer: () => {} });
    j.append(ev({ act: 'late', t: NOW - 100 }), { src: 'worker' });
    j.append(ev({ act: 'new' }), { src: 'worker' });
    let l = await j.list();
    assert(l.retained === 2 && l.persisted === 0 && l.storageError === 'STORAGE_READ' && st.writes === 0);
    await assert.rejects(j.clear(), /STORAGE_READ/);
    assert(st.data[D.STORAGE_KEY].events[0].act === 'old' && st.writes === 0, 'failed read/clear cannot destroy unread records');
    st.failGet = false;
    l = await j.list();
    same(l.events.map(e => [e.act, e.seq]), [['old', 7], ['new', 8]], 'recovered hydration merges the new event and honors the stored clear boundary');
    assert(l.persisted === 2 && l.storageError === '' && l.dropped === 3 && l.expired === 4);
    const reopened = D.createJournal({ storage: st, setTimer: () => 0, clearTimer: () => {} });
    same((await reopened.list()).events.map(e => e.act), ['old', 'new'], 'both acknowledged records survive restart');
    st.failGet = true;
    const bounded = D.createJournal({ storage: st, setTimer: () => 0, clearTimer: () => {} });
    for (let i = 0; i < 501; i++) bounded.append(ev({ act: 'item', d: { n: i } }), { src: 'worker' });
    l = await bounded.list();
    assert(l.retained === 500 && l.persisted === 0 && l.dropped === 1 && l.events[0].d.n === 1);
    st.failGet = false;
    l = await bounded.list();
    assert(l.retained === 502 && l.persisted === 502 && l.dropped === 4, 'recovery preserves pending overflow and stored eviction counters');
  });

  await test('L6 client: off sends nothing (and builds no details); on sends sanitized events; live toggle; early events wait for the preference; a gone extension context stops it', async () => {
    const sent = [];
    const listeners = [];
    let enabled = false;
    let resolveGet;
    const chrome = {
      runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } },
      storage: { local: { get: () => new Promise((r) => { resolveGet = () => r({ debugEnabled: enabled }); }) }, onChanged: { addListener: (fn) => listeners.push(fn) } }
    };
    const ctx = loadLib({ chrome });
    const c = ctx.ImageSaverDebug.client('content');
    c.log('reddit.inline', 'click', 'refused', 'NOT_TRUSTED', { which: 'this' }); // before the preference is known
    assert.strictEqual(sent.length, 0);
    enabled = true;
    resolveGet();
    await quiesce(3);
    assert(sent.length === 1 && sent[0].action === 'DEBUG_EVENT' && sent[0].ev.why === 'NOT_TRUSTED' && sent[0].ev.src === 'content', 'the early event is sent once recording is known to be on');
    c.log('x', 'y', 'ok', undefined, { host: 'https://a.example/x?sig=1', filename: 'f.jpg' });
    same(sent[1].ev.d, { host: 'a.example' });
    assert(/^[a-f0-9]{8}$/.test(c.cid()));
    for (const fn of listeners) fn({ debugEnabled: { newValue: false } }, 'local');
    let built = 0;
    c.log('x', 'y', 'ok', undefined, () => { built++; return {}; });
    assert(sent.length === 2 && built === 0 && c.cid() === '', 'off: nothing sent, no details built, no attempt id');
    assert.strictEqual(ctx.ImageSaverDebug.client('content'), c, 'one client per document');
    vm.runInContext(LIB, ctx);
    assert.strictEqual(ctx.ImageSaverDebug.client('content'), c, 'reinjection keeps the first client (idempotent)');
    for (const fn of listeners) fn({ debugEnabled: { newValue: true } }, 'local');
    chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
    c.log('x', 'y', 'ok');
    c.log('x', 'z', 'ok');
    assert.strictEqual(c.enabled(), false, 'a gone context turns the client off instead of throwing');
  });

  await test('L7 live producer toggles beat stale initial preference success and rejection, including lazy off', async () => {
    for (const latest of [false, true]) for (const reject of [false, true]) {
      const initial = deferred(), listeners = [], sent = [];
      let built = 0;
      const ctx = loadLib({ chrome: { runtime: { sendMessage: async m => { sent.push(m); } }, storage: { local: { get: () => initial.promise }, onChanged: { addListener: fn => listeners.push(fn) } } } });
      const c = ctx.ImageSaverDebug.client('content');
      listeners[0]({ debugEnabled: { newValue: latest } }, 'local');
      if (reject) initial.reject(new Error('READ')); else initial.resolve({ debugEnabled: !latest });
      await quiesce(2);
      c.log('menu', 'click', 'start', undefined, () => { built++; return {}; });
      assert(c.enabled() === latest && built === Number(latest) && sent.length === Number(latest));
    }
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  console.log('\n--- W: the worker (real background.js) ---');
  const EXT = 'debugtestextid';
  function worker({ enabled = false, failJournalSet = false, initialPrefRead = null, indexedDB } = {}) {
    const listeners = [];
    const changeListeners = [];
    const local = { debugEnabled: enabled };
    const badges = [];
    const chrome = {
      runtime: {
        id: EXT,
        getURL: (p) => `chrome-extension://${EXT}/${p}`,
        onInstalled: { addListener() {} }, onStartup: { addListener() {} },
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: async () => undefined,
        getContexts: async () => [],
        getManifest: () => ({ version: '2.0.0.26' })
      },
      declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
      contextMenus: { removeAll: (cb) => { if (cb) cb(); }, create() {}, update: (_i, _p, cb) => { if (cb) cb(); }, refresh() {}, onClicked: { addListener: (fn) => { chrome._menu = fn; } }, onShown: { addListener() {} } },
      windows: { create: async () => ({ id: 1 }), onFocusChanged: { addListener() {} }, onRemoved: { addListener() {} } },
      storage: {
        local: {
          get: async (k) => {
            if (k === 'debugEnabled' && initialPrefRead) return initialPrefRead;
            if (typeof k === 'string') return { [k]: local[k] };
            if (k && typeof k === 'object' && !Array.isArray(k)) { const r = {}; for (const key of Object.keys(k)) r[key] = local[key] !== undefined ? local[key] : k[key]; return r; }
            return { ...local };
          },
          set: async (items) => {
            if (failJournalSet && items && Object.prototype.hasOwnProperty.call(items, 'imageSaverDebugV1')) throw new Error('QUOTA');
            const changes = {};
            for (const key of Object.keys(items)) { changes[key] = { oldValue: local[key], newValue: items[key] }; local[key] = items[key]; }
            for (const fn of changeListeners) fn(changes, 'local');
          }
        },
        session: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener: (fn) => changeListeners.push(fn) }
      },
      action: { setBadgeText: async (d) => { badges.push(d.text); }, setBadgeBackgroundColor: async () => {} },
      downloads: { download: async () => 1, search: async () => [], onChanged: { addListener() {} } },
      tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} }, sendMessage: async () => undefined, query: async () => [] },
      scripting: { executeScript: async () => [] },
      notifications: { onClicked: { addListener() {} }, create: async () => {} }
    };
    const sandbox = { chrome, indexedDB, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, URL, URLSearchParams, setTimeout, clearTimeout, AbortController, TextEncoder, TextDecoder, crypto: require('node:crypto').webcrypto, fetch: async () => ({ ok: false, status: 404, headers: { get: () => null } }) };
    vm.createContext(sandbox);
    sandbox.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), sandbox);
    const send = (msg, sender) => new Promise((resolve) => {
      let answered = false;
      for (const fn of listeners) {
        const keep = fn(msg, sender, (r) => { answered = true; resolve(r); });
        if (answered) return;
        if (keep === true) return;
      }
      setTimeout(() => resolve(undefined), 0);
    });
    const page = (file) => ({ id: EXT, url: `chrome-extension://${EXT}/${file}` });
    const tabSender = (frameId = 0) => ({ id: EXT, tab: { id: 42, active: true, url: 'https://www.reddit.com/r/x/' }, frameId, documentId: 'ABCDEF0123456789ABCDEF0123456789', url: frameId ? 'https://www.redgifs.com/ifr/clip' : 'https://www.reddit.com/r/x/comments/1/a/' });
    const setEnabled = (on) => chrome.storage.local.set({ debugEnabled: on });
    const list = async () => { await sandbox.debugJournal.flush(); return send({ action: 'DEBUG_LIST' }, page('popup/popup.html')); };
    return { sandbox, chrome, send, page, tabSender, setEnabled, list, badges, local };
  }

  await test('W1 off by default: producer events and worker events are not recorded and nothing is written', async () => {
    const w = worker();
    await quiesce();
    assert.strictEqual(w.sandbox.debugState, 'off');
    await w.send({ action: 'DEBUG_EVENT', ev: ev({ comp: 'reddit.inline', act: 'click', out: 'refused', why: 'NOT_TRUSTED' }) }, w.tabSender());
    w.sandbox.dbg('menu', 'click', 'start', undefined, () => { throw new Error('details must not be built while off'); });
    const l = await w.list();
    assert(l.success === true && l.retained === 0 && l.recording === false && w.local.imageSaverDebugV1 === undefined);
  });

  await test('W2 on: the context comes from the sender (content/frame, tab, frame, page host); the producer cannot claim source, tab or page; foreign or malformed events are dropped', async () => {
    const w = worker({ enabled: true });
    await quiesce();
    await w.send({ action: 'DEBUG_EVENT', ev: ev({ src: 'worker', tab: 999, page: 'evil.example', comp: 'reddit.inline', act: 'click', out: 'refused', why: 'TARGET_CHANGED' }) }, w.tabSender(0));
    await w.send({ action: 'DEBUG_EVENT', ev: ev({ comp: 'redgifs.frame', act: 'resolve', out: 'ok' }) }, w.tabSender(3));
    await w.send({ action: 'DEBUG_EVENT', ev: ev({ comp: 'x', act: 'y' }) }, { id: 'another-extension', tab: { id: 1 }, frameId: 0, url: 'https://a.example/' });
    await w.send({ action: 'DEBUG_EVENT', ev: { comp: 'no time' } }, w.tabSender(0));
    await w.send({ action: 'DEBUG_EVENT', ev: ev({ comp: 'popup', act: 'history' }) }, w.page('popup/quick.html'));
    const l = await w.list();
    const [a, b, c] = l.events;
    assert.strictEqual(l.retained, 3);
    assert.deepStrictEqual([a.src, a.tab, a.frame, a.page, a.doc, a.why], ['content', 42, 0, 'www.reddit.com', 'ABCDEF01', 'TARGET_CHANGED']);
    assert.deepStrictEqual([b.src, b.frame, b.page], ['frame', 3, 'www.redgifs.com']);
    assert.deepStrictEqual([c.src, c.comp], ['popup', 'popup']);
  });

  await test('W3 only the full settings page may read or clear the journal', async () => {
    const w = worker({ enabled: true });
    await quiesce();
    for (const sender of [w.tabSender(0), w.page('popup/quick.html'), w.page('offscreen.html'), { id: 'another-extension', url: `chrome-extension://${EXT}/popup/popup.html` }, { id: EXT, url: 'https://evil.example/popup/popup.html' }]) {
      for (const action of ['DEBUG_LIST', 'DEBUG_CLEAR']) {
        const r = await w.send({ action }, sender);
        assert(r && r.success === false && r.error === 'FORBIDDEN', `${action} from ${sender.url} is refused`);
      }
    }
    w.sandbox.dbg('menu', 'click', 'start');
    const l = await w.list();
    assert(l.success === true && l.retained === 1);
    const cleared = await w.send({ action: 'DEBUG_CLEAR' }, w.page('popup/popup.html'));
    assert(cleared.success === true && cleared.retained === 0);
  });

  await test('W4 live toggle in the worker: off stops recording at once and keeps the journal; on again records', async () => {
    const w = worker({ enabled: true });
    await quiesce();
    w.sandbox.dbg('a', 'one', 'ok');
    await w.setEnabled(false);
    w.sandbox.dbg('a', 'two', 'ok');
    await w.send({ action: 'DEBUG_EVENT', ev: ev({ comp: 'a', act: 'three' }) }, w.tabSender());
    let l = await w.list();
    assert.strictEqual(l.events.map((e) => e.act).join(), 'one', 'off keeps what was recorded and records nothing new');
    await w.setEnabled(true);
    w.sandbox.dbg('a', 'four', 'ok');
    l = await w.list();
    assert.strictEqual(l.events.map((e) => e.act).join(), 'one,four');
  });

  await test('W5 a flood from producers is bounded (rate limit) and reported once as a worker event', async () => {
    const w = worker({ enabled: true });
    await quiesce();
    for (let i = 0; i < 260; i++) w.send({ action: 'DEBUG_EVENT', ev: ev({ comp: 'flood', act: 'x' }) }, w.tabSender());
    const l = await w.list();
    assert(l.events.filter((e) => e.comp === 'flood').length === 200 && l.events.some((e) => e.comp === 'debug' && e.why === 'RATE_LIMIT'));
  });

  await test('W6 worker actions are recorded with the attempt id and operation: a context-menu click without media (refused before resolution)', async () => {
    const w = worker({ enabled: true });
    await quiesce();
    await w.chrome._menu({ menuItemId: 'save-image-item', pageUrl: 'https://a.example/page', frameId: 0 }, { id: 9, url: 'https://a.example/page' });
    const l = await w.list();
    const flow = l.events.map((e) => `${e.comp}.${e.act}:${e.out}${e.why ? ':' + e.why : ''}`);
    assert(flow.includes('menu.click:start') && flow.includes('menu.click:refused:NO_MEDIA_ASSOCIATION') && flow.includes('op.begin:start') && flow.includes('op.fail:failed:NO_MEDIA'), JSON.stringify(flow));
    const cid = l.events.find((e) => e.comp === 'menu' && e.act === 'click').cid;
    const op = l.events.find((e) => e.comp === 'op' && e.act === 'begin');
    assert(cid && op.cid === cid && l.events.find((e) => e.comp === 'op' && e.act === 'fail').op === op.op, 'click, operation and failure are correlated');
  });

  await test('W7 a failing journal store never changes a save: the same refusal, badge and feedback happen with a broken journal', async () => {
    const run = async (opts) => {
      const w = worker(opts);
      await quiesce();
      await w.chrome._menu({ menuItemId: 'save-image-item', pageUrl: 'https://a.example/page', frameId: 0 }, { id: 9, url: 'https://a.example/page' });
      await quiesce();
      const ops = await w.sandbox.feedbackTracker.list();
      return { badges: w.badges.slice(), ops: ops.map((o) => [o.state, o.failure && o.failure.code]), w };
    };
    const off = await run({ enabled: false });
    const broken = await run({ enabled: true, failJournalSet: true });
    same(broken.badges, off.badges);
    same(broken.ops, off.ops);
    const l = await broken.w.list();
    assert(l.success === true && l.retained > 0 && l.persisted === 0 && l.storageError === 'STORAGE_WRITE', 'the journal says its events were not written');
  });

  await test('W8 live worker toggles beat stale preference success and rejection', async () => {
    for (const latest of [false, true]) for (const reject of [false, true]) {
      const initial = deferred();
      const w = worker({ enabled: !latest, initialPrefRead: initial.promise });
      await w.setEnabled(latest);
      if (reject) initial.reject(new Error('READ')); else initial.resolve({ debugEnabled: !latest });
      await quiesce(2);
      w.sandbox.dbg('menu', 'click', 'start');
      const listed = await w.list();
      assert(w.sandbox.debugState === (latest ? 'on' : 'off') && listed.retained === Number(latest));
    }
  });

  await test('W9 offscreen answered failures, absent answers and rejected transport have different sanitized outcomes', async () => {
    const w = worker({ enabled: true });
    await quiesce(2);
    const cases = [
      [{ success: false, error: 'INVALID_URL: message.url must be a non-empty string' }, 'INVALID_URL'],
      [{ success: false, error: 'Protected fetch failed after retries', status: 429 }, 'OFFSCREEN_FAILED'],
      [{ success: false, error: 'HTTP 403 https://cdn.example/a?token=SECRET', status: 403 }, 'OFFSCREEN_FAILED'],
      [{ success: false, error: 'ASSEMBLE_FAILED' }, 'ASSEMBLE_FAILED'],
      [undefined, 'NO_ANSWER'],
      [{ success: false, error: 'SIZE_EXCEEDED: GIF input limit is50MiB' }, 'SIZE_EXCEEDED'],
      [{ success: false, error: 'SIZE_EXCEEDED: Encoded GIF size (16000000 bytes) exceeds limit of 15728640 bytes https://cdn.example/a?token=SECRET' }, 'SIZE_EXCEEDED'],
      [{ success: false, error: 'FAILED: secret details' }, 'OFFSCREEN_FAILED'],
    ];
    for (const [reply] of cases) {
      w.chrome.runtime.sendMessage = async () => reply;
      assert.strictEqual(await w.sandbox.offscreenRequest({ action: 'FETCH_PROTECTED_BLOB' }), reply);
    }
    w.chrome.runtime.sendMessage = async () => { throw new Error('port closed with secret details'); };
    await assert.rejects(w.sandbox.offscreenRequest({ action: 'FETCH_PROTECTED_BLOB' }), /port closed/);
    let captured;
    w.sandbox.feedbackTracker = { fail: async (_op, info) => { captured = info; } };
    const info = { stage: 'convert', code: cases[6][0].error };
    await w.sandbox.fbFail('op-mv3ol3so-gwjeu9', info);
    assert.strictEqual(captured, info, 'The existing failure receives its original data unchanged');
    const listed = await w.list();
    const operation = listed.events.find(e => e.comp === 'op' && e.act === 'fail');
    assert(operation.why === 'SIZE_EXCEEDED' && operation.op === 'op-mv3ol3so-gwjeu9' && operation.d.stage === 'convert');
    const failures = listed.events.filter(e => e.comp === 'offscreen' && e.out === 'failed');
    same(failures.map(e => e.why), cases.map(c => c[1]).concat('MESSAGE_FAILED'));
    assert(failures[1].d.http === 429 && failures[2].d.http === 403 && !JSON.stringify(listed).match(/SECRET|secret details|cdn\.example/));
  });

  await test('W10 real IndexedDB adapter waits for commit, rejects abort, recovers a read failure and retains acknowledged events across workers', async () => {
    const data = new Map(), transactions = [];
    const fake = { auto: false, failMode: '', opens: 0, open() {
      const req = {};
      fake.opens++;
      setImmediate(() => { req.result = db; if (fake.opens === 1) req.onupgradeneeded?.(); req.onsuccess(); });
      return req;
    } };
    const db = { createObjectStore() {}, transaction(_store, mode) {
      const req = {}, tx = { objectStore: () => ({
        get: key => { req.result = data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : undefined; return req; },
        put: (value, key) => { req.commit = () => data.set(key, JSON.parse(JSON.stringify(value))); return req; }
      }) };
      const complete = () => { req.commit?.(); tx.oncomplete(); };
      const abort = () => { tx.error = new Error('ABORT'); tx.onabort(); };
      transactions.push({ req, tx, complete, abort });
      if (fake.auto) setImmediate(() => { if (fake.failMode === mode) { fake.failMode = ''; abort(); } else complete(); });
      return tx;
    } };
    const w = worker({ enabled: true, indexedDB: fake });
    await quiesce(2);
    const storage = w.sandbox.debugIdbStorage();
    let acknowledged = false;
    const put = storage.set('probe', { keep: true }).then(() => { acknowledged = true; });
    await quiesce(2);
    assert(!acknowledged && !data.has('probe'), 'a request is not persistence before transaction completion');
    transactions.at(-1).req.onsuccess?.();
    assert(!acknowledged);
    transactions.at(-1).complete();
    await put;
    assert(acknowledged && data.get('probe').keep === true);
    const bad = storage.set('probe', { keep: false });
    await quiesce(2);
    transactions.at(-1).abort();
    await assert.rejects(bad, /ABORT/);
    assert(data.get('probe').keep === true);
    fake.auto = true;
    await w.send({ action: 'DEBUG_EVENT', ev: ev({ act: 'old' }) }, w.tabSender());
    assert((await w.list()).persisted === 1 && !w.local.imageSaverDebugV1, 'normal worker writes use IndexedDB rather than fallback');
    const restarted = worker({ enabled: true, indexedDB: fake });
    await quiesce(2);
    fake.failMode = 'readonly';
    await restarted.send({ action: 'DEBUG_EVENT', ev: ev({ act: 'new' }) }, restarted.tabSender());
    assert(await restarted.sandbox.debugJournal.flush() === false);
    assert(data.get(D.STORAGE_KEY).events.map(e => e.act).join() === 'old', 'aborted read cannot overwrite the prior journal');
    const recovered = await restarted.list();
    assert(recovered.persisted === 2 && recovered.events.map(e => e.act).join() === 'old,new');
    fake.failMode = 'readwrite';
    await restarted.send({ action: 'DEBUG_EVENT', ev: ev({ act: 'retry' }) }, restarted.tabSender());
    assert(await restarted.sandbox.debugJournal.flush() === false);
    assert((await restarted.list()).persisted === 3, 'a recovered transaction persists dirty records without a new event');
    const third = worker({ enabled: false, indexedDB: fake });
    await quiesce(2);
    assert((await third.list()).events.map(e => e.act).join() === 'old,new,retry');
  });

  await test('U1 clear invalidates late UI lists/errors, coalesces changes during clear, and preserves rows on failed clear', async () => {
    const { createDebug } = await import(require('node:url').pathToFileURL(path.join(__dirname, 'ui/src/core/debug.js')).href);
    const listed = act => ({ success: true, events: act ? [{ ...ev({ src: 'worker', act }), seq: 1 }] : [], retained: act ? 1 : 0, persisted: act ? 1 : 0 });
    for (const scenario of ['late-list', 'late-error', 'change', 'failed-clear']) {
      const gate = deferred(), clearGate = deferred();
      let reads = 0;
      const api = { runtime: { id: 'debugtest', onMessage: { addListener() {}, removeListener() {} }, sendMessage: async m => {
        if (m.action === 'DEBUG_CLEAR') return clearGate.promise;
        reads++;
        return reads === 1 ? listed('old') : reads === 2 ? gate.promise : listed('new');
      } }, storage: { local: { get: async () => ({ debugEnabled: false }) }, onChanged: { addListener() {}, removeListener() {} } } };
      const c = createDebug({ chrome: api });
      await c.start();
      const syncing = c.sync(false);
      const clearing = c.clear();
      if (scenario === 'change') { await c.sync(false); assert(reads === 2, 'changes during clear do not load a pre-clear snapshot'); }
      clearGate.resolve(scenario === 'failed-clear' ? { success: false, error: 'DEBUG_CLEAR_FAILED' } : listed(''));
      assert(await clearing === (scenario !== 'failed-clear'));
      assert(c.store.getState().retained === Number(scenario === 'failed-clear'));
      if (scenario === 'late-error') gate.reject(new Error('OLD_READ')); else gate.resolve(listed('old'));
      await syncing;
      const state = c.store.getState();
      same(state.events.map(e => e.act), scenario === 'change' ? ['new'] : scenario === 'failed-clear' ? ['old'] : []);
      assert(state.status === 'ready' && !state.error && state.notice === (scenario === 'failed-clear' ? 'debug.error.clear' : 'debug.cleared'));
      c.dispose();
    }
  });

  console.log(`\nTotal tests passed: ${passed}\nTotal tests failed: ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
