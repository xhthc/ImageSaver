// test_first_run.js - FIRST-RUN-SETUP-01: the quick-start guide trigger (service worker) and its state controller.
// Worker: only runtime.onInstalled reason=install opens popup.html?welcome=1; every other reason, and a failing tab open, leave the
// installation work intact. Controller: the one dismissed marker is written only by an explicit Continue, never on load, and failed
// reads/writes stay visible. Evidence boundary: mocked Chrome in Node; the rendered guide is covered by test_ui_render.js.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.error(`  ✗ ${name}`); console.error(error); }
}
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// ---------------------------------------------------------------------------------------------------
// Service worker: the production background.js with a minimal Chrome
// ---------------------------------------------------------------------------------------------------
function worker({ tabsCreate } = {}) {
  const created = [];
  const rules = { updates: 0 };
  let installed;
  const chrome = {
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => { rules.updates++; } },
    runtime: {
      id: 'mock-id', lastError: null,
      onInstalled: { addListener: (cb) => { installed = cb; } }, onStartup: { addListener: () => {} }, onMessage: { addListener: () => {} },
      sendMessage: async () => null, getURL: (p) => `chrome-extension://mock-id/${p}`, getContexts: async () => [], getManifest: () => ({ version: '2.0.0' }),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {}, setIcon: async () => {} },
    contextMenus: { onClicked: { addListener: () => {} }, create: () => {}, update: () => {}, removeAll: (cb) => { if (cb) cb(); } },
    downloads: { download: async () => 1, search: async () => [], onChanged: { addListener: () => {} }, onDeterminingFilename: { addListener: () => {} } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener: () => {} } },
    tabs: { query: async () => [], get: async (id) => ({ id }), sendMessage: async () => {}, create: tabsCreate ? (o) => tabsCreate(o, created) : async (o) => { created.push(o.url); return { id: 1 }; } },
    scripting: { executeScript: async () => [] },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {}, Reason: { BLOB_CONVERSION: 'BLOB_CONVERSION' } },
  };
  const sandbox = {
    chrome, fetch: async () => ({ ok: false, status: 404, headers: { get: () => null, has: () => false } }),
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Set, Map, URL, Number, Array, Object, Promise, ArrayBuffer, Uint8Array, Math, String, Boolean, RegExp, AbortController,
  };
  vm.createContext(sandbox);
  sandbox.importScripts = (file) => vm.runInContext(fs.readFileSync(path.resolve(ROOT, file), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), sandbox);
  return { created, rules, fire: async (details) => { installed(details); await tick(); } };
}

// ---------------------------------------------------------------------------------------------------
// Controller: ui/src/core/onboarding.js with a storage mock
// ---------------------------------------------------------------------------------------------------
function storage({ local = {}, failGet = false, failSet = false } = {}) {
  const s = { local, failGet, failSet, sets: [], listeners: [] };
  s.chrome = {
    storage: {
      local: {
        get: async (defaults) => { if (s.failGet) throw new Error('UNREADABLE'); return { ...(defaults || {}), ...s.local }; },
        set: async (v) => {
          if (s.failSet) throw new Error('QUOTA');
          s.sets.push(JSON.parse(JSON.stringify(v)));
          const changes = {};
          for (const k of Object.keys(v)) changes[k] = { oldValue: s.local[k], newValue: v[k] };
          Object.assign(s.local, v);
          for (const cb of s.listeners) cb(changes, 'local');
        },
      },
      onChanged: { addListener: (cb) => { s.listeners.push(cb); }, removeListener: (cb) => { s.listeners = s.listeners.filter((x) => x !== cb); } },
    },
  };
  return s;
}

(async () => {
  const { createOnboarding, ONBOARDING_KEY, WELCOME_PARAM, welcomeFromLocation } = await import(pathToFileURL(path.join(ROOT, 'ui/src/core/onboarding.js')).href);
  const welcome = { search: '?welcome=1' };
  const plain = { search: '' };

  console.log('\n--- worker trigger ---');
  await test('fresh install opens exactly one full-page guide tab', async () => {
    const w = worker();
    await w.fire({ reason: 'install' });
    assert.deepStrictEqual(w.created, [`chrome-extension://mock-id/popup/popup.html?${WELCOME_PARAM}=1`]);
    assert(welcomeFromLocation(new URL(w.created[0])), 'the opened URL is the one the page treats as the install guide');
  });
  await test('update, browser update, startup-like and empty details never open a tab', async () => {
    const w = worker();
    for (const details of [{ reason: 'update' }, { reason: 'chrome_update' }, { reason: 'shared_module_update' }, {}, undefined]) await w.fire(details);
    assert.strictEqual(w.created.length, 0);
  });
  await test('a rejected tab open does not break the install work or throw', async () => {
    const w = worker({ tabsCreate: async () => { throw new Error('TABS'); } });
    await w.fire({ reason: 'install' });
    const sync = worker({ tabsCreate: () => { throw new Error('SYNC'); } });
    await sync.fire({ reason: 'install' });
    assert(w.rules.updates >= 1 && sync.rules.updates >= 1, 'declarativeNetRequest rules are still set up');
  });
  await test('the worker writes no guide marker', () => {
    const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
    assert(!src.includes(ONBOARDING_KEY), 'only the page writes the dismissed marker');
  });

  console.log('\n--- controller ---');
  await test('welcome parameter is read strictly', () => {
    assert(welcomeFromLocation({ search: '?welcome=1' }) && welcomeFromLocation({ search: '?op=a&welcome=1' }));
    assert(!welcomeFromLocation({ search: '?welcome=0' }) && !welcomeFromLocation({ search: '?welcome=true' }) && !welcomeFromLocation({ search: '' }) && !welcomeFromLocation(undefined));
  });
  await test('install URL opens only after the marker is known; loading never writes', async () => {
    const st = storage();
    const c = createOnboarding({ chrome: st.chrome, location: welcome });
    assert.strictEqual(c.store.getState().open, false, 'hidden until the marker was read');
    await c.ready;
    assert.strictEqual(c.store.getState().open, true);
    assert.strictEqual(st.sets.length, 0, 'no write on load');
    c.dispose();
  });
  await test('update/startup/popup (no welcome) never opens, with or without a marker, and writes nothing', async () => {
    for (const local of [{}, { [ONBOARDING_KEY]: true }, { otherPreference: 1 }]) {
      const st = storage({ local });
      const c = createOnboarding({ chrome: st.chrome, location: plain });
      await c.ready;
      assert.strictEqual(c.store.getState().open, false);
      assert.strictEqual(st.sets.length, 0);
      c.dispose();
    }
  });
  await test('a reload of an unfinished install guide keeps it; an acknowledged guide stays closed', async () => {
    const st = storage();
    const first = createOnboarding({ chrome: st.chrome, location: welcome });
    await first.ready;
    first.dispose();
    const reload = createOnboarding({ chrome: st.chrome, location: welcome });
    await reload.ready;
    assert.strictEqual(reload.store.getState().open, true, 'closing the tab is not completion');
    assert.strictEqual(await reload.dismiss(), true);
    assert.deepStrictEqual(st.sets, [{ [ONBOARDING_KEY]: true }], 'exactly the one dedicated key is written');
    reload.dispose();
    const again = createOnboarding({ chrome: st.chrome, location: welcome });
    await again.ready;
    assert.strictEqual(again.store.getState().open, false, 'dismissed stays dismissed on the same install URL');
    again.dispose();
  });
  await test('there is no manual reopen: a completed or ordinary page never opens the welcome and never rewrites the marker', async () => {
    for (const [location, local] of [[plain, { [ONBOARDING_KEY]: true, uiTheme: 'dark' }], [welcome, { [ONBOARDING_KEY]: true }], [plain, {}]]) {
      const st = storage({ local });
      const c = createOnboarding({ chrome: st.chrome, location });
      await c.ready;
      assert(!('show' in c), 'no manual show method');
      assert.strictEqual(c.store.getState().open, false);
      assert.strictEqual(await c.dismiss(), false, 'Continue is only available while the install welcome is open');
      assert.strictEqual(st.sets.length, 0);
      if (ONBOARDING_KEY in local) assert.strictEqual(st.local[ONBOARDING_KEY], true, 'an existing true marker is never reset');
      c.dispose();
    }
  });
  await test('failed write: guide stays open with a visible error, nothing is marked done, retry succeeds', async () => {
    const st = storage({ failSet: true });
    const c = createOnboarding({ chrome: st.chrome, location: welcome });
    await c.ready;
    assert.strictEqual(await c.dismiss(), false);
    let s = c.store.getState();
    assert(s.open && !s.dismissed && !s.saving && s.error === 'onboarding.saveFailed');
    assert.strictEqual(st.sets.length, 0);
    st.failSet = false;
    assert.strictEqual(await c.dismiss(), true);
    s = c.store.getState();
    assert(!s.open && s.dismissed && s.error === '');
    c.dispose();
  });
  await test('failed read: install guide stays open with a visible error and is not treated as dismissed', async () => {
    const st = storage({ local: { [ONBOARDING_KEY]: true }, failGet: true });
    const c = createOnboarding({ chrome: st.chrome, location: welcome });
    await c.ready;
    const s = c.store.getState();
    assert(s.open && !s.dismissed && s.error === 'onboarding.readFailed' && s.ready);
    assert.strictEqual(st.sets.length, 0, 'a failed read writes nothing');
    st.failGet = false;
    assert.strictEqual(await c.dismiss(), true, 'Continue still records the choice and clears the error');
    assert.strictEqual(c.store.getState().error, '');
    c.dispose();
    const quiet = createOnboarding({ chrome: storage({ failGet: true }).chrome, location: plain });
    await quiet.ready;
    assert.strictEqual(quiet.store.getState().open, false, 'a failed read never opens the guide for an ordinary page');
    quiet.dispose();
  });
  await test('double activation while saving writes once', async () => {
    const st = storage();
    const c = createOnboarding({ chrome: st.chrome, location: welcome });
    await c.ready;
    const [a, b] = await Promise.all([c.dismiss(), c.dismiss()]);
    assert(a === true && b === false);
    assert.strictEqual(st.sets.length, 1);
    c.dispose();
  });
  await test('a marker written elsewhere closes an unfinished install guide; a delayed read cannot reopen it', async () => {
    const st = storage();
    const c = createOnboarding({ chrome: st.chrome, location: welcome });
    await c.ready;
    for (const cb of st.listeners) cb({ [ONBOARDING_KEY]: { newValue: true } }, 'local');
    assert.strictEqual(c.store.getState().open, false);
    for (const cb of st.listeners) cb({ unrelated: { newValue: 1 } }, 'local');
    for (const cb of st.listeners) cb({ [ONBOARDING_KEY]: { newValue: false } }, 'sync');
    assert.strictEqual(c.store.getState().open, false, 'other keys and areas are ignored');
    c.dispose();
    let release;
    const slow = storage();
    const get = slow.chrome.storage.local.get;
    slow.chrome.storage.local.get = async (d) => { await new Promise((r) => { release = r; }); return get(d); };
    const late = createOnboarding({ chrome: slow.chrome, location: welcome });
    await tick(2);
    for (const cb of slow.listeners) cb({ [ONBOARDING_KEY]: { newValue: true } }, 'local');
    release();
    await late.ready;
    assert.strictEqual(late.store.getState().dismissed, true, 'the newer event wins over the older read');
    assert.strictEqual(late.store.getState().open, false);
    late.dispose();
  });
  await test('dispose detaches the storage listener and stops updates', async () => {
    const st = storage();
    const c = createOnboarding({ chrome: st.chrome, location: welcome });
    await c.ready;
    c.dispose();
    assert.strictEqual(st.listeners.length, 0);
    assert.strictEqual(await c.dismiss(), false);
    assert.strictEqual(st.sets.length, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
