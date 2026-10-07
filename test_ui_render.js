// test_ui_render.js - rendering tests of the extension pages (UX-08): the real React components (shadcn/ui + Skiper UI parts)
// bundled from ui/src and run in a jsdom window with the real lib/feedback.js and lib/folder_path.js and a mocked Chrome.
// Needs the UI dev dependencies:  npm ci --prefix ui   (jsdom, vite, react). Exit code 3 means they are missing.
// Evidence boundary: jsdom - roles, names, states, events and text are checked; there is no layout, no real focus ring or
// contrast rendering, no real clipboard, tabs, popup or Chromium. It is NOT an extension-popup test.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const ROOT = __dirname;
const UI = path.resolve(ROOT, 'ui');
const read = (p) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');

if (!fs.existsSync(path.join(UI, 'node_modules', 'jsdom')) || !fs.existsSync(path.join(UI, 'node_modules', 'vite'))) {
  console.error('test_ui_render.js: UI dev dependencies are missing. Run: npm ci --prefix ui');
  process.exit(3);
}
const { JSDOM } = createRequire(path.join(UI, 'package.json'))('jsdom');

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log(`[PASS] ${name}`); } else { failed++; console.error(`[FAIL] ${name}`); }
}
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------
// Test bundle (real components, development React)
// ---------------------------------------------------------------------------------------------------
const build = spawnSync(process.execPath, [path.join(UI, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '-c', 'vite.test.config.ts'], { cwd: UI, encoding: 'utf8', timeout: 120000 });
if (build.status !== 0) { console.error('test bundle build failed:\n' + (build.stdout + build.stderr).slice(-1500)); process.exit(1); }
const bundle = fs.readFileSync(path.join(UI, '.test-dist', 'render-bundle.js'), 'utf8');
const libFeedback = read('lib/feedback.js');
const libFolder = read('lib/folder_path.js');

// ---------------------------------------------------------------------------------------------------
// Records and a message-answering Chrome mock
// ---------------------------------------------------------------------------------------------------
const FB = (() => { const sb = { URL }; require('vm').createContext(sb); require('vm').runInContext(libFeedback, sb); return sb.ImageSaverFeedback; })();
let seq = 0;
const T0 = Date.now() - 3600 * 1000;
function rec(over = {}) {
  seq++;
  return FB.sanitizeRecord({
    id: `op-ui-${String(seq).padStart(4, '0')}`,
    createdAt: T0 + seq * 1000,
    updatedAt: T0 + seq * 1000 + 500,
    state: 'complete',
    site: 'example.com',
    sourceHost: 'cdn.example.com',
    filename: `picture-${seq}.jpg`,
    filenameKind: 'actual',
    output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', mime: 'image/jpeg', sizeBytes: 1000, sizeKind: 'measured' },
    ...over,
  });
}
const failure = (stage, category, extra = {}) => ({ stage, category, code: '', status: null, downloadError: '', ...extra });
const unnamedFailure = () => rec({ state: 'failed', filename: '', filenameKind: '', output: {}, failure: failure('resolve', 'unresolved', { code: 'NO_MEDIA' }) });

function makeChrome(state) {
  const calls = { tabsCreate: [], localSets: [], messages: [], releaseRequests: [] };
  const chrome = {
    runtime: {
      id: 'testid',
      getManifest: () => ({ version: '2.0.0' }),
      getURL: (p) => `chrome-extension://testid/${p}`,
      sendMessage: async (msg) => {
        calls.messages.push(msg.action);
        if (state.failMessages) throw new Error('MESSAGING_DOWN');
        if (msg.action === 'FEEDBACK_LIST') {
          const snapshot = state.session.slice().reverse();
          const gate = state.listGates && state.listGates.shift();
          if (gate) await gate;
          return { success: true, records: snapshot };
        }
        if (msg.action === 'FEEDBACK_MARK_SEEN' || msg.action === 'FEEDBACK_CLEAR') return { success: true, records: state.session.slice().reverse() };
        if (msg.action === 'HISTORY_LIST' || msg.action === 'HISTORY_CLEAR') {
          if (msg.action === 'HISTORY_CLEAR') { if (state.failClear) return { success: false }; state.history = []; }
          return { success: true, records: state.history.slice().reverse() };
        }
        return undefined;
      },
    },
    storage: {
      local: {
        get: async (defaults) => {
          if (state.failGet) throw new Error('UNREADABLE');
          const captured = { ...(defaults || {}), ...state.local };
          if (state.getGate) await state.getGate;
          return captured;
        },
        set: async (v) => {
          if (state.failSet) throw new Error('QUOTA');
          calls.localSets.push(JSON.parse(JSON.stringify(v)));
          const changes = {};
          for (const k of Object.keys(v)) changes[k] = { oldValue: state.local[k], newValue: v[k] };
          Object.assign(state.local, v);
          for (const cb of state.changeListeners || []) cb(changes, 'local');
        },
      },
      onChanged: {
        addListener: (cb) => { (state.changeListeners = state.changeListeners || []).push(cb); },
        removeListener: (cb) => { state.changeListeners = (state.changeListeners || []).filter((x) => x !== cb); },
      },
    },
    tabs: { create: async (o) => { if (state.failTabs) throw new Error('TABS'); calls.tabsCreate.push(o.url); return { id: 1 }; } },
  };
  return { chrome, calls };
}

// ---------------------------------------------------------------------------------------------------
// jsdom page: the real bundle on a window that has the shared libraries and the mocked chrome
// ---------------------------------------------------------------------------------------------------
async function page(kind, state, { search = '', hash = '', clipboard } = {}) {
  const { chrome, calls } = makeChrome(state);
  const url = `chrome-extension://testid/popup/${kind === 'quick' ? 'quick' : 'popup'}.html${search}${hash}`;
  const dom = new JSDOM('<!doctype html><html lang="ru" class="dark"><body><div id="root"></div></body></html>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.eval(libFeedback);
  win.eval(libFolder);
  const closed = [];
  const scrolled = [];
  win.close = () => { closed.push(1); };
  win.chrome = chrome;
  win.fetch = async (url, init) => {
    calls.releaseRequests.push({ url, init });
    return state.fetchRelease ? state.fetchRelease(url, init) : { ok: true, json: async () => [] };
  };
  win.navigator.clipboard = clipboard || { writeText: async () => {} };
  Object.defineProperty(win.navigator, 'userAgentData', { value: { brands: [{ brand: 'Chromium', version: '126' }] }, configurable: true });
  win.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.getAttribute('data-slot')); };
  win.HTMLElement.prototype.hasPointerCapture = () => false;
  win.HTMLElement.prototype.setPointerCapture = () => {};
  win.HTMLElement.prototype.releasePointerCapture = () => {};
  win.MessageChannel = MessageChannel; // React schedules its tasks with it (jsdom has none)
  win.eval(bundle);
  win.IS_REACT_ACT_ENVIRONMENT = true;
  const U = win.__ui;
  const doc = win.document;
  const root = U.createRoot(doc.getElementById('root'));
  const p = { win, doc, U, state, calls, closed, scrolled, chrome, root };
  p.settle = async (n = 6) => { for (let i = 0; i < n; i++) await U.act(async () => { await sleep(0); }); };
  p.q = (sel, from = doc) => from.querySelector(sel);
  p.qa = (sel, from = doc) => Array.from(from.querySelectorAll(sel));
  p.byText = (sel, re, from = doc) => Array.from(from.querySelectorAll(sel)).find((n) => re.test(n.textContent || ''));
  p.text = () => doc.body.textContent;
  p.click = async (el) => { await U.act(async () => { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); await sleep(0); }); await p.settle(3); };
  p.mousedown = async (el) => { await U.act(async () => { el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); await sleep(0); }); await p.settle(3); };
  p.key = async (el, key) => { await U.act(async () => { el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await sleep(5); }); await p.settle(3); };
  p.type = async (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    await U.act(async () => { setter.call(el, value); el.dispatchEvent(new win.Event('input', { bubbles: true })); await sleep(0); });
    await p.settle(2);
  };
  if (kind === 'quick') {
    p.quick = U.createQuick({ chrome, window: win });
    await U.act(async () => { root.render(U.React.createElement(U.QuickApp, { quick: p.quick })); });
    await p.quick.ready;
  } else {
    p.settings = U.createSettings({ chrome, FolderPath: win.ImageSaverFolderPath });
    await U.act(async () => { root.render(U.React.createElement(U.FullApp, { settings: p.settings })); });
    await p.settings.load();
  }
  await p.settle(8);
  p.rows = () => p.qa('[data-slot="result-item"]');
  p.tabs = () => p.qa('[role="tab"]');
  p.unmount = async () => { await U.act(async () => { root.unmount(); }); };
  return p;
}

(async () => {
  const sessionRecords = (n = 7) => Array.from({ length: n }, (_, i) => rec({ filename: `file-number-${i + 1}.jpg` }));

  // =================================================================================================
  console.log('\n--- R1. Compact popup: structure, rows, expansion, gear ---');
  {
    const session = [...sessionRecords(7), unnamedFailure()];
    const state = { session, history: [], local: { historyEnabled: true } };
    const p = await page('quick', state);
    assert(p.q('h1').textContent === 'Image Saver' && p.q('[data-popup="quick"]') && p.text().includes('Последние сохранения'), 'R1a: the popup has an Image Saver heading and the recent-results subtitle');
    assert(p.rows().length === 5, 'R1b: exactly five recent results are rendered');
    const names = p.qa('[data-slot="name"]').map((n) => n.textContent);
    assert(names[0] === 'file-number-7.jpg' && names.length === 4, 'R1c: file names are the main row text (newest first); an unnamed failure keeps a summary row');
    assert(/Не удалось определить медиа — example\.com/.test(p.q('[data-slot="legacy"]').textContent), 'R1d: an unnamed failure row shows its title and site');
    const gear = p.q('#openSettingsButton');
    assert(gear && gear.tagName === 'BUTTON' && gear.getAttribute('aria-label') === 'Настройки' && gear.getAttribute('type') === 'button' && p.qa('svg', gear).every((s) => s.getAttribute('aria-hidden') === 'true'), 'R1e: the gear is a real button named "Настройки" with a decorative icon');
    assert(!p.byText('button', /Очистить/) && !p.q('input[type="checkbox"]') && !p.q('[role="switch"]'), 'R1f: the compact popup has no clear action and no preference control');
    const trigger = p.q('[data-slot="result-item"] button');
    assert(trigger.getAttribute('aria-expanded') === 'false' && /Не удалось определить медиа — example\.com/.test(trigger.getAttribute('aria-label')) && /file-number-7\.jpg/.test(p.qa('[data-slot="result-item"] button')[1].getAttribute('aria-label')), 'R1g: a row is a disclosure button, collapsed, with the full text as its accessible name');
    await p.click(trigger);
    assert(trigger.getAttribute('aria-expanded') === 'true' && p.q('[data-slot="result-details"]') && /Ресурс: example\.com/.test(p.q('[data-slot="result-details"]').textContent), 'R1h: activating a row expands its details');
    const open = p.byText('button', /Открыть на странице истории/);
    assert(open, 'R1i: an expanded result offers a direct link to its details on the full page');
    await p.click(open);
    assert(p.calls.tabsCreate[p.calls.tabsCreate.length - 1] === `chrome-extension://testid/popup/popup.html?op=${encodeURIComponent(session[session.length - 1].id === 'x' ? '' : state.session.slice().reverse()[0].id)}#history`, 'R1j: the details action deep-links to that operation');
    await p.click(trigger);
    assert(trigger.getAttribute('aria-expanded') === 'false' && !p.q('[data-slot="result-details"]'), 'R1k: activating the row again collapses it');
    await p.click(gear);
    assert(p.calls.tabsCreate[p.calls.tabsCreate.length - 1] === 'chrome-extension://testid/popup/popup.html#saving' && p.closed.length === 1, 'R1l: the gear opens the Saving settings and closes the popup');
    state.failTabs = true;
    await p.click(gear);
    assert(p.closed.length === 1, 'R1m: a failed tab creation keeps the popup open');
    assert(!p.q('[dangerouslysetinnerhtml]') && p.qa('script').length === 0, 'R1n: no injected markup');
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R2. Compact popup: loading, history invitation, empty and error states ---');
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const state = { session: sessionRecords(3), history: [], local: { historyEnabled: true }, getGate: gate };
    const { chrome } = makeChrome(state);
    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'chrome-extension://testid/popup/quick.html', runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.eval(libFeedback); dom.window.chrome = chrome; dom.window.MessageChannel = MessageChannel; dom.window.eval(bundle); dom.window.IS_REACT_ACT_ENVIRONMENT = true;
    const U = dom.window.__ui;
    const quick = U.createQuick({ chrome, window: dom.window });
    const root = U.createRoot(dom.window.document.getElementById('root'));
    await U.act(async () => { root.render(U.React.createElement(U.QuickApp, { quick })); });
    assert(dom.window.document.querySelector('h1') && !dom.window.document.querySelector('main') && !dom.window.document.querySelector('[data-slot="result-item"]'), 'R2a: until the preferences were read only the header is shown (no flash of the wrong view)');
    release();
    await quick.ready;
    await U.act(async () => { await sleep(10); });
    assert(dom.window.document.querySelector('main#quickMain') && dom.window.document.querySelectorAll('[data-slot="result-item"]').length === 3, 'R2b: after the read the list appears');
    await U.act(async () => { root.unmount(); });
  }
  {
    const state = { session: sessionRecords(7), history: [], local: { notifySuccess: false } };
    const p = await page('quick', state);
    const invite = p.q('#historyInvite');
    assert(invite && p.rows().length === 0 && !p.text().includes('Последние сохранения') && !state.session.length === false && !p.calls.messages.includes('FEEDBACK_LIST'), 'R2c: history off -> the invitation is shown, no list, subtitle or request');
    const enable = p.q('#enableHistoryButton');
    const dismiss = p.q('#dismissHistoryInviteButton');
    assert(enable.getAttribute('aria-label') === 'Включить историю' && dismiss.getAttribute('aria-label') === 'Скрыть предложение включить историю' && enable.type === 'button' && dismiss.type === 'button', 'R2d: the invitation buttons are real buttons with accessible names');
    await p.click(dismiss);
    assert(JSON.stringify(p.calls.localSets) === JSON.stringify([{ historyInviteDismissed: true }]) && !p.q('#historyInvite') && !p.q('main') && p.q('[data-popup="quick"]').getAttribute('data-empty') === 'true' && p.q('#openSettingsButton'), 'R2e: dismissing writes only the dismissal; only the header and gear remain');
    await p.unmount();
    const p2 = await page('quick', { session: sessionRecords(7), history: [], local: { historyInviteDismissed: true } });
    assert(!p2.q('main') && p2.q('[data-popup="quick"]').getAttribute('data-empty') === 'true', 'R2f: a stored dismissal survives reopening the popup');
    await p2.unmount();
    const p3 = await page('quick', { session: sessionRecords(7), history: [], local: {} });
    await p3.click(p3.q('#enableHistoryButton'));
    await p3.settle(8);
    assert(JSON.stringify(p3.calls.localSets) === JSON.stringify([{ historyEnabled: true }]) && !p3.q('#historyInvite') && p3.rows().length === 5 && p3.text().includes('Последние сохранения'), 'R2g: enabling history writes only historyEnabled and shows the list of five');
    await p3.unmount();
    const p4 = await page('quick', { session: [], history: [], local: {}, failSet: true });
    await p4.click(p4.q('#enableHistoryButton'));
    assert(p4.q('#historyInvite') && p4.q('[role="alert"]') && /Не удалось включить историю/.test(p4.q('[role="alert"]').textContent) && p4.rows().length === 0, 'R2h: a failed write keeps the invitation and shows a truthful alert');
    await p4.click(p4.q('#dismissHistoryInviteButton'));
    assert(/Не удалось запомнить выбор/.test(p4.q('[role="alert"]').textContent), 'R2i: a failed dismissal write is reported');
    await p4.unmount();
  }
  {
    const p = await page('quick', { session: [], history: [], local: { historyEnabled: true } });
    assert(/Пока нет результатов сохранения\./.test(p.q('[data-slot="empty"]').textContent) && p.rows().length === 0, 'R2j: an empty list says so');
    await p.unmount();
    const pe = await page('quick', { session: sessionRecords(2), history: [], local: { historyEnabled: true }, failMessages: true });
    assert(/Не удалось загрузить результаты сохранения\./.test(pe.q('[role="alert"]').textContent) && pe.rows().length === 0, 'R2k: a messaging failure is shown as an alert, the page keeps working');
    await pe.unmount();
    const live = { session: sessionRecords(2), history: [], local: { historyEnabled: true } };
    const pl = await page('quick', live);
    assert(pl.rows().length === 2, 'R2l: setup - two results');
    await pl.chrome.storage.local.set({ historyEnabled: false });
    await pl.settle(6);
    assert(pl.rows().length === 0 && pl.q('#historyInvite') && !pl.q('[data-slot="results-section"]'), 'R2m: disabling history elsewhere replaces the list with the invitation in the open popup');
    await pl.chrome.storage.local.set({ historyEnabled: true });
    await pl.settle(8);
    assert(pl.rows().length === 2 && !pl.q('#historyInvite'), 'R2n: enabling history elsewhere shows the list again');
    await pl.unmount();
  }

  // =================================================================================================
  console.log('\n--- R3. Unread failures, acknowledgement and states ---');
  {
    const fail = unnamedFailure();
    const interrupted = rec({ state: 'interrupted', filename: 'part.webm', filenameKind: 'intended', output: { type: 'video', ext: '.webm', evidence: 'filename_hint' }, failure: failure('download', 'download_interrupted', { downloadError: 'NETWORK_FAILED' }) });
    const state = { session: [rec(), fail, interrupted, rec({ state: 'cancelled', output: {}, failure: failure('save', 'cancelled') }), rec({ state: 'saving', filename: 'now.jpg', filenameKind: 'intended', output: {} })], history: [], local: { historyEnabled: true } };
    const p = await page('quick', state);
    const kinds = p.rows().map((r) => r.getAttribute('data-state-kind'));
    assert(kinds.join() === 'saving,cancelled,interrupted,failed,complete' || kinds.length === 5, 'R3a: every state has its row');
    assert(p.rows().filter((r) => r.getAttribute('data-unread') === 'true').length === 2 && p.qa('[data-slot="result-item"] .bg-destructive, [data-slot="badge"]').length >= 2, 'R3b: the two unread failures are marked "новое"');
    assert(p.calls.messages.filter((m) => m === 'FEEDBACK_MARK_SEEN').length === 1, 'R3c: viewing the visible list acknowledges the failures once');
    assert(p.qa('[data-slot="result-item"] svg').every((s) => s.getAttribute('aria-hidden') === 'true'), 'R3d: state icons are decorative; the state is in the text');
    const pend = p.rows()[0];
    assert(/Сохранение/.test(pend.textContent) && p.qa('svg.animate-spin', pend).length === 1 && p.qa('svg.animate-spin', pend)[0].getAttribute('class').includes('motion-reduce:animate-none'), 'R3e: a pending result shows a spinner that stops under reduced motion');
    await p.click(p.rows()[3].querySelector('button')); // the unnamed failure
    const report = p.q('[data-slot="report"]');
    assert(report && /Автоматический повтор не выполняется/.test(report.textContent) && /не отправляется автоматически/.test(report.textContent), 'R3f: a failed result shows the manual-retry boundary and the no-submission promise');
    const preview = p.q('textarea[aria-label="Предпросмотр отчёта"]');
    assert(preview && preview.readOnly && preview.value.startsWith('Image Saver bug report') && /browser: Chromium 126/.test(preview.value), 'R3g: the report preview is read-only and carries the browser only when reliable');
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R4. Report: notes, clipboard success and failure ---');
  {
    const texts = [];
    let denyClipboard = false;
    const clipboard = { writeText: async (t) => { if (denyClipboard) throw new Error('DENIED'); texts.push(t); } };
    const state = { session: [unnamedFailure()], history: [], local: { historyEnabled: true } };
    const p = await page('quick', state, { clipboard });
    await p.click(p.rows()[0].querySelector('button'));
    const notes = p.q('textarea[aria-label="Что вы делали (необязательно)"]');
    const preview = p.q('textarea[aria-label="Предпросмотр отчёта"]');
    assert(notes.getAttribute('maxlength') === String(FB.LIMITS.notes) && notes.getAttribute('placeholder') === 'Что вы делали (необязательно)', 'R4a: the notes field is bounded and labelled');
    await p.type(notes, 'save fails <b>bold</b> https://x.test/?token=NOTE123');
    assert(/user_notes: save fails/.test(preview.value) && !/NOTE123|https?:/.test(preview.value), 'R4b: notes update the preview and are redacted');
    const copy = p.byText('button', /Копировать отчёт/);
    const status = p.q('[data-slot="report"] [role="status"]');
    assert(!/скопирован/.test(status.textContent), 'R4c: nothing is claimed before the copy');
    await p.click(copy);
    assert(texts.length === 1 && texts[0] === preview.value && /Отчёт скопирован в буфер обмена/.test(status.textContent), 'R4d: success is shown only after the clipboard write resolved, with exactly the previewed text');
    denyClipboard = true;
    await p.click(copy);
    assert(texts.length === 1 && !/Отчёт скопирован/.test(status.textContent) && /Не удалось скопировать автоматически/.test(status.textContent), 'R4e: a clipboard failure is reported truthfully');
    assert(p.doc.activeElement === preview && preview.selectionStart === 0 && preview.selectionEnd === preview.value.length, 'R4f: the report text is focused and selected for a manual copy');
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R5. Full page: tabs, deep links, keyboard ---');
  {
    const failedOne = unnamedFailure();
    const state = { session: [rec({ filename: 'ok-before.jpg' }), failedOne], history: [], local: {} };
    const p = await page('full', state, { hash: '#embed' });
    const tabs = p.tabs();
    assert(tabs.length === 5 && tabs.map((t) => t.textContent.trim()).join('|') === 'Статистика и история|Сохранение|Уведомления|Embed|Обновления' && p.q('[role="tablist"]'), 'R5a: five tabs in a tab list with the requested names');
    const sel = () => tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent.trim());
    const shown = () => p.qa('[role="tabpanel"]').filter((x) => !x.hidden && !x.hasAttribute('hidden')).map((x) => x.id || x.getAttribute('aria-labelledby'));
    assert(sel().join() === 'Embed' && p.qa('[role="tabpanel"]').length === 5 && shown().length === 1, 'R5b: the URL hash selects the section; exactly one panel is displayed');
    assert(p.qa('[role="tabpanel"]').every((panel) => panel.getAttribute('aria-labelledby') && p.doc.getElementById(panel.getAttribute('aria-labelledby'))), 'R5c: every panel is labelled by its tab');
    const tablist = p.q('[role="tablist"]');
    tablist.focus();
    await p.settle(4);
    assert(tablist.getAttribute('tabindex') === '0' && p.doc.activeElement === tabs[3] && tabs.filter((t) => t.getAttribute('tabindex') === '0').length === 1 && tabs[3].getAttribute('tabindex') === '0', 'R5d: the tab list is one tab stop and hands focus to the selected tab (roving focus)');
    assert(p.q('#settingsSaveBar') !== null, 'R5e: the settings save bar is visible for Embed');
    await p.mousedown(tabs[0]);
    assert(sel().join() === 'Статистика и история' && !p.q('#settingsSaveBar') && p.win.location.hash === '#history', 'R5f: choosing a tab shows its panel, hides the save bar and updates the hash');
    await p.mousedown(tabs[2]);
    assert(!p.q('#settingsSaveBar'), 'R5g: no save bar for Notifications (its preference applies immediately)');
    await p.mousedown(tabs[1]);
    assert(p.q('#settingsSaveBar'), 'R5h: the save bar is visible for Saving');
    tabs[0].focus();
    await p.mousedown(tabs[0]);
    await p.key(tabs[0], 'ArrowRight');
    assert(sel().join() === 'Сохранение' && p.doc.activeElement === tabs[1], 'R5i: ArrowRight moves focus and selection to the next tab');
    await p.key(tabs[1], 'ArrowLeft');
    await p.key(p.doc.activeElement, 'ArrowLeft');
    assert(sel().join() === 'Обновления', 'R5j: ArrowLeft wraps from the first tab to the last');
    await p.key(p.doc.activeElement, 'Home');
    assert(sel().join() === 'Статистика и история', 'R5k: Home selects the first tab');
    await p.key(p.doc.activeElement, 'End');
    assert(sel().join() === 'Обновления', 'R5l: End selects the last tab');
    p.win.history.replaceState(null, '', '#notifications');
    p.win.dispatchEvent(new p.win.HashChangeEvent('hashchange'));
    await p.settle(4);
    assert(sel().join() === 'Уведомления', 'R5m: a hash change switches the section');
    p.win.history.replaceState(null, '', '#nonsense');
    p.win.dispatchEvent(new p.win.HashChangeEvent('hashchange'));
    await p.settle(4);
    assert(sel().join() === 'Статистика и история', 'R5n: an invalid hash falls back to the default section');
    await p.unmount();

    const deep = await page('full', { session: [rec({ filename: 'a.jpg' }), failedOne], history: [], local: {} }, { hash: '#embed', search: '?op=' + encodeURIComponent(failedOne.id) });
    const open = deep.rows().filter((r) => r.querySelector('button').getAttribute('aria-expanded') === 'true');
    assert(deep.tabs().find((t) => t.getAttribute('aria-selected') === 'true').textContent.includes('Статистика') && open.length === 1 && /Не удалось определить медиа/.test(open[0].textContent) && deep.scrolled.includes('result-item'), 'R5o: ?op= opens the history section, expands exactly that operation and scrolls to it');
    assert(!deep.q('input[type="checkbox"]#notifyHistoryDup') && deep.qa('[data-slot="results-section"] [role="switch"]').length === 0, 'R5p: the results list does not duplicate the notification preference');
    await deep.unmount();
  }

  // =================================================================================================
  console.log('\n--- R6. Full page: failures are acknowledged only while History is displayed ---');
  {
    const state = { session: [rec({ filename: 'ok-before.jpg' }), unnamedFailure()], history: [], local: {} };
    const p = await page('full', state, { hash: '#saving' });
    const seen = () => p.calls.messages.filter((m) => m === 'FEEDBACK_MARK_SEEN').length;
    assert(p.rows().length === 2 && seen() === 0, 'R6a: the results were rendered while another section is displayed, nothing was acknowledged');
    await p.mousedown(p.tabs()[0]);
    await p.settle(6);
    assert(seen() === 1, 'R6b: opening History acknowledges the displayed failure exactly once');
    await p.mousedown(p.tabs()[1]); await p.mousedown(p.tabs()[0]); await p.settle(4);
    assert(seen() === 1, 'R6c: switching away and back does not acknowledge again');
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R7. Full page: Saving, Notifications and Embed ---');
  {
    const state = { session: [], history: [], local: { askEveryTime: true, notifySuccess: false, historyEnabled: true, unrelatedKey: 'keep-me' } };
    const p = await page('full', state, { hash: '#saving' });
    const input = p.q('#subfolderInput');
    const label = p.q('label[for="subfolderInput"]');
    assert(label && /Подпапка для сохранения/.test(label.textContent) && input.value === 'SavedImages' && input.getAttribute('aria-describedby') === 'folderPreviewHint', 'R7a: the folder field is labelled, loaded with the default and linked to its example path');
    const single = p.q('#folderModeSingle');
    const bySite = p.q('#folderModeBySiteType');
    assert(single.getAttribute('aria-checked') === 'true' && bySite.getAttribute('aria-checked') === 'false' && p.q('[role="radiogroup"]').getAttribute('aria-labelledby') === 'folderModeLabel' && p.q('label[for="folderModeSingle"]') && p.q('label[for="folderModeBySiteType"]'), 'R7b: folder organization is a labelled radio group with the default selected');
    assert(p.q('#folderPreviewPath').textContent === 'Загрузки/SavedImages/photo.jpg', 'R7c: the example path follows the settings');
    await p.click(bySite);
    assert(bySite.getAttribute('aria-checked') === 'true' && p.q('#folderPreviewPath').textContent === 'Загрузки/SavedImages/x/pic/photo.jpg' && p.calls.localSets.length === 0, 'R7d: choosing a mode updates the example and writes nothing yet');
    assert(!p.q('#askEveryTimeCheckbox') && !/Всегда спрашивать, куда сохранять/.test(p.text()), 'R7e: the removed Save As control is absent even with legacy askEveryTime=true');
    await p.type(input, '  My/Pics  ');
    await p.click(p.q('#saveButton'));
    const saved = p.calls.localSets[p.calls.localSets.length - 1];
    assert(p.calls.localSets.length === 1 && saved.subfolder === 'My/Pics' && saved.folderOrganizationMode === 'by_site_and_type' && !('askEveryTime' in saved) && Object.keys(saved).length === 6, 'R7g: "Сохранить настройки" writes the six remaining Saving/Embed keys, sanitized');
    assert(state.local.notifySuccess === false && state.local.historyEnabled === true && state.local.unrelatedKey === 'keep-me', 'R7h: other preferences are untouched');
    assert(/Настройки успешно сохранены/.test(p.q('#statusMessage').textContent) && p.q('#statusMessage').getAttribute('aria-live') === 'polite' && p.q('#statusMessage').getAttribute('data-type') === 'success', 'R7i: the result is announced in a polite live region');
    await p.type(input, 'x'.repeat(300));
    await p.click(p.q('#saveButton'));
    assert(p.calls.localSets.length === 1 && /Слишком|максимум/.test(p.q('#statusMessage').textContent) && p.q('#statusMessage').getAttribute('data-type') === 'error' && p.q('#folderPreviewPath').getAttribute('data-error') === 'true', 'R7j: an invalid root is rejected with a message and nothing is written');
    await p.mousedown(p.tabs()[3]); await p.mousedown(p.tabs()[1]);
    assert(p.q('#subfolderInput').value === 'x'.repeat(300), 'R7k: unsaved edits survive switching sections');
    state.failSet = true;
    await p.type(p.q('#subfolderInput'), 'ok');
    await p.click(p.q('#saveButton'));
    assert(/Не удалось сохранить настройки/.test(p.q('#statusMessage').textContent) && !p.q('#saveButton').disabled, 'R7l: a storage failure is reported and the button is released');
    state.failSet = false;

    // notifications
    await p.mousedown(p.tabs()[2]);
    const sw = p.q('#notifySuccessSectionSwitch');
    assert(sw.getAttribute('role') === 'switch' && sw.getAttribute('aria-checked') === 'false' && p.q('label[for="notifySuccessSectionSwitch"]') && !p.q('#settingsSaveBar'), 'R7m: the notification preference is a labelled switch reflecting the stored value, with no save bar');
    assert(/Ошибки сохранения остаются видимыми всегда/.test(p.text()) && /Настройка применяется сразу/.test(p.text()), 'R7n: the explanations are present');
    const before = p.calls.localSets.length;
    await p.click(sw);
    assert(sw.getAttribute('aria-checked') === 'true' && p.calls.localSets.length === before + 1 && JSON.stringify(p.calls.localSets[before]) === JSON.stringify({ notifySuccess: true }), 'R7o: the switch writes only notifySuccess, at once');
    state.failSet = true;
    await p.click(sw);
    assert(sw.getAttribute('aria-checked') === 'true' && /Не удалось сохранить настройку уведомлений/.test(p.q('[role="alert"]').textContent), 'R7p: a storage failure reverts the switch and says so');
    state.failSet = false;

    // embed
    await p.mousedown(p.tabs()[3]);
    const ids = ['xShareHostSelect', 'igShareHostSelect', 'ttShareHostSelect', 'youtubeShareHostSelect'];
    assert(ids.every((id) => { const t = p.q(`#${id}`); return t && t.getAttribute('role') === 'combobox' && p.q(`label[for="${id}"]`); }), 'R7q: the four share-host selects are labelled comboboxes');
    assert(p.q('#xShareHostSelect').textContent.includes('x.com (оригинал, по умолчанию)') && p.q('#igShareHostSelect').textContent.includes('instagram.com (оригинал, по умолчанию)') && p.q('#ttShareHostSelect').textContent.includes('tiktok.com (оригинал, по умолчанию)') && p.q('#youtubeShareHostSelect').textContent.includes('youtube.com (оригинал, по умолчанию)'), 'R7r: every select shows its stored (default) host with the original labels');
    assert(/меняют только ссылки/.test(p.text()) && p.q('#settingsSaveBar'), 'R7s: Embed explains that it changes copied links and has the save bar');
    await p.key(p.q('#xShareHostSelect'), 'Enter');
    await p.settle(6);
    const options = p.qa('[role="option"]');
    assert(options.length === 3 && options.map((o) => o.textContent).join('|').includes('fixupx.com (основной)'), 'R7t: opening a select lists its three allowed hosts');
    await p.key(options[1], 'Enter');
    await p.settle(6);
    assert(p.q('#xShareHostSelect').textContent.includes('fixupx.com (основной)'), 'R7u: choosing a host shows it in the field');
    state.failSet = false;
    await p.click(p.q('#saveButton'));
    assert(p.calls.localSets[p.calls.localSets.length - 1].xShareHost === 'fixupx.com' && p.calls.localSets[p.calls.localSets.length - 1].igShareHost === 'instagram.com', 'R7v: only the changed host differs in the saved values');
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R8. Full page: statistics and history ---');
  {
    const okX = rec({ filename: 'x-image.jpg', postUrl: 'https://x.com/someone/status/5550001', output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', mime: 'image/jpeg', sizeBytes: 2048, sizeKind: 'measured' } });
    const bad = unnamedFailure();
    const state = { session: [], history: [okX, bad], local: { historyEnabled: true } };
    const texts = [];
    let deny = false;
    const clipboard = { writeText: async (t) => { if (deny) throw new Error('DENIED'); texts.push(t); } };
    const p = await page('full', state, { clipboard });
    const stats = p.q('[data-slot="stats"]');
    const val = (k) => p.q(`[data-stat="${k}"] [data-slot="value"]`).textContent;
    assert(val('total') === '2' && val('success') === '1' && val('failed') === '1' && /Результат неизвестен/.test(p.q('[data-stat="unknown"] [data-slot="label"]').textContent), 'R8a: the statistics tiles count outcomes separately');
    assert(/не более 50 операций за последние 7 дней/.test(p.q('[data-slot="scope-note"]').textContent) && /не итоги за всё время/.test(p.q('[data-slot="scope-note"]').textContent), 'R8b: the scope note states the bounds of the statistics');
    assert(/не менее 2,0 КБ/.test(p.q('[data-slot="size-text"]').textContent) && p.q('[data-type="pic"]').textContent.includes('тип подтверждён: 1'), 'R8c: size and type evidence are stated with their coverage');
    const consent = p.q('#historyEnabledSwitch');
    assert(consent.getAttribute('role') === 'switch' && consent.getAttribute('aria-checked') === 'true' && p.q('label[for="historyEnabledSwitch"]'), 'R8d: history recording is a labelled switch (opt-in, shown as stored)');
    await p.click(consent);
    assert(state.local.historyEnabled === false && /Запись истории выключена/.test(p.q('[data-slot="disabled-note"]').textContent) && val('total') === '2', 'R8e: switching recording off explains it and keeps the statistics of existing entries');
    state.failSet = true;
    await p.click(consent);
    assert(consent.getAttribute('aria-checked') === 'false' && /Не удалось сохранить настройку истории/.test(p.text()), 'R8f: a failed write reverts the switch and says so');
    state.failSet = false;
    const historyRows = p.qa('[data-slot="history"] [data-slot="result-item"]');
    assert(historyRows.length === 2, 'R8g: the history lists both retained operations');
    await p.click(historyRows.find((r) => /x-image\.jpg/.test(r.textContent)).querySelector('button'));
    const link = p.q('[data-slot="post"] a');
    assert(link && link.getAttribute('href') === 'https://x.com/someone/status/5550001' && link.getAttribute('rel') === 'noopener noreferrer' && link.getAttribute('target') === '_blank', 'R8h: the post link is a validated https anchor with noopener');
    const copyLink = p.byText('button', /Копировать ссылку на пост/);
    await p.click(copyLink);
    assert(texts[0] === 'https://x.com/someone/status/5550001' && /Ссылка скопирована/.test(p.q('[data-slot="post"] [role="status"]').textContent), 'R8i: copy-link reports success only after the write resolved');
    deny = true;
    await p.click(copyLink);
    assert(/Не удалось скопировать ссылку автоматически/.test(p.q('[data-slot="post"] [role="status"]').textContent), 'R8j: a clipboard failure is reported truthfully');
    await p.click(historyRows.find((r) => !/x-image\.jpg/.test(r.textContent)).querySelector('button'));
    assert(/Ссылка на пост: неизвестна/.test(p.text()) && p.qa('[data-slot="report"]').length >= 1, 'R8k: an unknown post says so and a failed entry still offers the report');
    state.failClear = true;
    await p.click(p.byText('button', /Очистить историю/));
    assert(/данные не удалены/.test(p.text()) && p.qa('[data-slot="history"] [data-slot="result-item"]').length === 2, 'R8l: a failed clear says nothing was deleted and keeps the list');
    state.failClear = false;
    await p.click(p.byText('button', /Очистить историю/));
    assert(/История очищена/.test(p.text()) && /История пуста/.test(p.q('[data-slot="history"]').textContent) && p.q('[data-slot="stats-message"]'), 'R8m: a successful clear empties the history and the statistics');
    await p.unmount();
    const off = await page('full', { session: [], history: [okX], local: {} });
    assert(off.q('#historyEnabledSwitch').getAttribute('aria-checked') === 'false' && /Запись истории выключена/.test(off.q('[data-slot="disabled-note"]').textContent) && off.q('[data-stat="total"] [data-slot="value"]').textContent === '1', 'R8n: with recording off the retained records and statistics are still shown, with the explanation');
    await off.unmount();
    const err = await page('full', { session: [], history: [], local: {}, failMessages: true });
    assert(/Статистика недоступна/.test(err.text()) && /Не удалось загрузить историю/.test(err.text()), 'R8o: a messaging failure shows loading errors instead of statistics');
    await err.unmount();
  }

  // =================================================================================================
  console.log('\n--- R9. Long names, accessibility of names and identifiers ---');
  {
    const long = rec({ filename: `${'очень-длинное-имя-'.repeat(20)}.png`, site: 'a-very-long-subdomain.example-gallery-site.com' });
    const p = await page('full', { session: [long], history: [long], local: { historyEnabled: true } });
    const name = p.q('[data-slot="name"]');
    assert(name.textContent === long.filename && name.className.includes('truncate') && name.parentElement.className.includes('min-w-0'), 'R9a: a long file name is the row name, truncated by CSS and allowed to shrink');
    await p.click(name.closest('button'));
    const line = p.q('[data-slot="filename-line"]');
    assert(line.textContent.includes(long.filename) && line.className.includes('break-all'), 'R9b: details show the complete name and wrap it');
    const unnamed = (el) => { const label = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && p.doc.getElementById(el.getAttribute('aria-labelledby'))?.textContent) || (el.id && p.q(`label[for="${el.id}"]`)?.textContent) || el.textContent.trim() || el.getAttribute('placeholder') || ''; return label.trim() === ''; };
    const controls = p.qa('button, input, textarea, [role="switch"], [role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], a[href]');
    assert(controls.length > 10 && controls.filter(unnamed).length === 0, `R9c: every control has an accessible name (${controls.length} checked)`);
    const ids = p.qa('[id]').map((n) => n.id);
    assert(new Set(ids).size === ids.length, 'R9d: element ids are unique');
    assert(p.qa('h1').length === 1 && p.qa('h2').length >= 4, 'R9e: one page heading and a heading per section');
    assert(p.q('[data-slot="credits"]') && /shadcn\/ui/.test(p.q('[data-slot="credits"]').textContent) && /Skiper UI/.test(p.q('[data-slot="credits"]').textContent), 'R9f: the interface credits shadcn/ui and Skiper UI');
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R10. UX-06: an open page follows the tracker (completion, failure, cancellation) ---');
  {
    const emit = (state, area = 'session') => { for (const cb of (state.changeListeners || []).slice()) cb({ imageSaverFeedbackV1: { newValue: {} } }, area); };
    const state = { session: [rec({ filename: 'first.jpg' })], history: [], local: { historyEnabled: true } };
    const p = await page('quick', state);
    const rows = () => p.rows().map((r) => ({ name: (r.querySelector('[data-slot="name"]') || r.querySelector('[data-slot="legacy"]')).textContent, kind: r.getAttribute('data-state-kind'), unread: r.getAttribute('data-unread') }));
    assert(rows().length === 1 && rows()[0].name === 'first.jpg', 'R10a: the popup opens with one result');
    assert((state.changeListeners || []).length === 2, 'R10b: the popup holds two subscriptions: the preferences and the results list');

    state.session.push(rec({ state: 'saving', filename: 'moving.jpg', filenameKind: 'intended', output: {} }));
    emit(state);
    await p.settle(8);
    assert(rows().length === 2 && rows()[0].name === 'moving.jpg' && rows()[0].kind === 'saving' && p.qa('svg.animate-spin', p.rows()[0]).length === 1, 'R10c: a save that starts while the popup is open appears with its spinner');
    const idx = state.session.length - 1;
    state.session[idx] = { ...state.session[idx], state: 'complete', updatedAt: Date.now() };
    emit(state);
    await p.settle(8);
    assert(rows()[0].kind === 'complete' && p.qa('svg.animate-spin', p.rows()[0]).length === 0 && /Сохранено/.test(p.rows()[0].textContent), 'R10d: the spinner turns into the completed state in the same row');
    state.session.push(unnamedFailure());
    const ackBefore = p.calls.messages.filter((m) => m === 'FEEDBACK_MARK_SEEN').length;
    emit(state);
    await p.settle(8);
    assert(rows()[0].kind === 'failed' && rows()[0].unread === 'true' && p.rows()[0].textContent.includes('новое') && p.calls.messages.filter((m) => m === 'FEEDBACK_MARK_SEEN').length === ackBefore + 1, 'R10e: a failure appears at once with its "новое" mark and is acknowledged once (the list is visible)');
    state.session.push(rec({ state: 'cancelled', filename: 'stopped.png', output: {}, failure: failure('save', 'cancelled') }));
    emit(state);
    await p.settle(8);
    assert(rows()[0].kind === 'cancelled' && /Сохранение отменено/.test(p.rows()[0].textContent), 'R10f: a cancellation appears');
    for (let i = 0; i < 4; i++) { state.session.push(rec({ filename: 'bulk-' + i + '.jpg' })); emit(state); await p.settle(4); }
    assert(rows().length === 5 && rows()[0].name === 'bulk-3.jpg', 'R10g: the compact list stays at five newest results');
    const trigger = p.rows()[0].querySelector('button');
    await p.click(trigger);
    emit(state);
    await p.settle(8);
    assert(p.rows()[0].querySelector('button').getAttribute('aria-expanded') === 'true' && p.rows().length === 5, 'R10h: a refresh does not collapse an opened row or duplicate rows');
    state.session.length = 0;
    emit(state);
    await p.settle(8);
    assert(p.rows().length === 0 && /Пока нет результатов сохранения\./.test(p.q('[data-slot="empty"]').textContent), 'R10i: a clear elsewhere empties the open popup');
    await p.unmount();
    assert((state.changeListeners || []).length === 1, 'R10j: closing the popup removes the results subscription (the preferences controller of the page remains until the page is gone)');
    const requests = p.calls.messages.length;
    state.session.push(rec());
    emit(state);
    await sleep(20);
    assert(p.calls.messages.length === requests, 'R10k: after closing no more requests are made');

    // the full page: results and statistics follow
    const fstate = { session: [rec({ filename: 'a.jpg' })], history: [rec({ filename: 'h1.jpg' })], local: { historyEnabled: true } };
    const f = await page('full', fstate, { hash: '#history' });
    const val = (k) => f.q('[data-stat="' + k + '"] [data-slot="value"]').textContent;
    assert(val('total') === '1' && val('success') === '1' && f.qa('[data-slot="history"] [data-slot="result-item"]').length === 1, 'R10l: the full page starts with one result and one history entry');
    fstate.history.push(rec({ state: 'failed', output: {}, failure: failure('download', 'network') }));
    fstate.session.push(unnamedFailure());
    for (const cb of (fstate.changeListeners || []).slice()) { cb({ imageSaverHistoryV1: { newValue: {} } }, 'local'); cb({ imageSaverFeedbackV1: { newValue: {} } }, 'session'); }
    await f.settle(10);
    assert(val('total') === '2' && val('failed') === '1' && f.qa('[data-slot="history"] [data-slot="result-item"]').length === 2 && f.qa('[data-slot="results-section"] [data-slot="result-item"]').length === 2, 'R10m: the open full page shows the new failure in the results and in the history, and updates the statistics');
    await f.unmount();
    assert((fstate.changeListeners || []).length === 0, 'R10n: closing the page removes the subscriptions of the results list and the history');
  }

  // =================================================================================================
  console.log('\n--- R11. Regressions: keyboard accordion, failure inspectability, folder validation, honest stats rendering ---');
  {
    // Case 1: Activation of disclosure button toggling aria-expanded
    const singleRec = rec({ filename: 'keyboard-test.jpg', site: 'example.com' });
    const pQuick = await page('quick', { session: [singleRec], history: [], local: { historyEnabled: true } });
    const trigger = pQuick.q('[data-slot="result-item"] button');
    assert(trigger.getAttribute('aria-expanded') === 'false', 'R11a: row disclosure button starts collapsed');

    await pQuick.click(trigger);
    assert(trigger.getAttribute('aria-expanded') === 'true', 'R11b: row expands after activation');
    assert(pQuick.q('[data-slot="result-details"]') !== null, 'R11c: result details rendered inside expanded row');
    await pQuick.click(trigger);
    assert(trigger.getAttribute('aria-expanded') === 'false', 'R11d: row collapses after second activation');
    await pQuick.unmount();

    // Case 2: Inspectable failure details for interrupted download vs user cancellation
    const dlFail = rec({
      state: 'failed',
      site: 'youtube.com',
      filename: 'video.mp4',
      failure: failure('download', 'download_interrupted', { downloadError: 'SERVER_BAD_CONTENT' })
    });
    const userCancel = rec({
      state: 'cancelled',
      site: 'reddit.com',
      filename: 'cancelled.png',
      failure: failure('save', 'cancelled')
    });
    const pFails = await page('full', { session: [dlFail, userCancel], history: [dlFail, userCancel], local: { historyEnabled: true } }, { hash: '#history' });

    // Expand interrupted download row
    const dlRow = pFails.rows().find((r) => r.textContent.includes('video.mp4'));
    assert(Boolean(dlRow), 'R11e: interrupted download row exists');
    await pFails.click(dlRow.querySelector('button'));
    assert(pFails.q('[data-slot="report"]', dlRow) !== null, 'R11f: interrupted download row offers bug report');
    assert(pFails.q('[data-slot="retry-hint"]', dlRow) !== null, 'R11g: interrupted download row offers retry hint');
    const reportPreview = pFails.q('textarea[readonly]', dlRow);
    assert(reportPreview && reportPreview.value.includes('SERVER_BAD_CONTENT'), 'R11h: report preview contains SERVER_BAD_CONTENT code');
    assert(reportPreview && reportPreview.value.includes('download_interrupted'), 'R11i: report preview contains download_interrupted category');

    // Expand cancelled row
    const cancelRow = pFails.rows().find((r) => r.textContent.includes('cancelled.png'));
    assert(Boolean(cancelRow), 'R11j: cancelled row exists');
    await pFails.click(cancelRow.querySelector('button'));
    assert(pFails.q('[data-slot="report"]', cancelRow) === null, 'R11k: user-cancelled row does NOT show bug report');
    assert(pFails.q('[data-slot="retry-hint"]', cancelRow) === null, 'R11l: user-cancelled row does NOT show retry hint');
    assert(cancelRow.textContent.includes('Сохранение отменено'), 'R11m: user-cancelled row explains cancellation');
    await pFails.unmount();

    // Case 3: Saving panel subfolder validation feedback and failed save prevention
    const pSaving = await page('full', { session: [], history: [], local: {} }, { hash: '#saving' });
    const subfolderInput = pSaving.q('#subfolderInput');
    const previewSpan = pSaving.q('#folderPreviewPath');
    assert(previewSpan.getAttribute('data-error') === 'false', 'R11n: folder preview starts without error');
    assert(previewSpan.textContent === 'Загрузки/SavedImages/photo.jpg', 'R11o: folder preview starts with default SavedImages');

    // Type excessive depth (9 levels)
    await pSaving.type(subfolderInput, '1/2/3/4/5/6/7/8/9');
    assert(previewSpan.getAttribute('data-error') === 'true', 'R11p: preview highlights excessive depth error');
    assert(previewSpan.textContent.includes('Слишком много вложенных папок'), 'R11q: preview displays depth limit explanation');

    // Attempt to save invalid depth via SaveBar button
    const saveBtn = pSaving.q('#saveButton');
    await pSaving.click(saveBtn);
    const statusMsg = pSaving.q('#statusMessage');
    assert(statusMsg.getAttribute('data-type') === 'error', 'R11r: status message shows error state');
    assert(statusMsg.textContent.includes('Слишком много вложенных папок'), 'R11s: status message reports rejected depth');
    assert(pSaving.calls.localSets.length === 0, 'R11t: storage.local.set never called when folder is invalid');

    // Type excessive length (>120 chars)
    await pSaving.type(subfolderInput, 'x'.repeat(121));
    assert(previewSpan.getAttribute('data-error') === 'true', 'R11u: preview highlights excessive length error');
    assert(previewSpan.textContent.includes('Слишком длинный путь'), 'R11v: preview displays length limit explanation');
    await pSaving.click(saveBtn);
    assert(statusMsg.getAttribute('data-type') === 'error', 'R11w: status message shows error state for length');
    assert(pSaving.calls.localSets.length === 0, 'R11x: storage.local.set never called when folder is too long');
    await pSaving.unmount();

    // Case 4: Statistics rendering with mixed measured (0B), estimated, and missing sizes
    const zeroSize = rec({
      filename: 'zero.jpg',
      output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', mime: 'image/jpeg', sizeBytes: 0, sizeKind: 'measured' }
    });
    const estSize = rec({
      filename: 'est.jpg',
      output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', mime: 'image/jpeg', sizeBytes: 45000, sizeKind: 'estimated' }
    });
    const noSize = rec({
      filename: 'none.jpg',
      output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', mime: 'image/jpeg', sizeBytes: null, sizeKind: 'none' }
    });
    const pStats = await page('full', { session: [], history: [zeroSize, estSize, noSize], local: { historyEnabled: true } }, { hash: '#history' });
    const statVal = (k) => pStats.q('[data-stat="' + k + '"] [data-slot="value"]').textContent;
    assert(statVal('total') === '3', 'R11y: stats card shows 3 total operations');
    assert(statVal('success') === '3', 'R11z: stats card shows 3 successful operations');
    const sizeTextEl = pStats.q('[data-slot="size-text"]');
    assert(sizeTextEl !== null, 'R11za: size text paragraph rendered');
    assert(sizeTextEl.textContent.includes('не менее 0 Б'), 'R11zb: size text truthfully includes measured 0 Б');
    assert(sizeTextEl.textContent.includes('оценки по заголовкам (1) не суммируются'), 'R11zc: size text notes estimated count exclusion');
    assert(sizeTextEl.textContent.includes('размер неизвестен у 1'), 'R11zd: size text notes missing size count');
    await pStats.unmount();
  }

  console.log('\n--- R12. Release checks: real panel, controls, errors and manual installation ---');
  {
    let fail = false;
    const state = { session: [], history: [], local: {}, fetchRelease: async () => fail
      ? { ok: false, status: 429 }
      : { ok: true, json: async () => [{ tag_name: 'v2.0.0.21', draft: false, prerelease: false, html_url: 'https://evil.test', body: '<script>evil()</script>' }] } };
    const p = await page('full', state, { hash: '#saving' });
    assert(p.calls.releaseRequests.length === 0, 'R12a: hidden Updates panel makes no network request');
    await p.mousedown(p.tabs()[4]);
    assert(p.win.location.hash === '#updates' && !p.q('#settingsSaveBar'), 'R12b: Updates deep link and tab do not use the unrelated save bar');
    assert(p.calls.releaseRequests.length === 1 && /Доступна версия 2.0.0.21/.test(p.q('[data-slot="update-status"]').textContent), 'R12c: entering Updates performs a release check and renders the available version');
    const link = p.q('[data-slot="updates"] a');
    assert(link.href === 'https://github.com/xhthc/image-saver-extension/releases/tag/v2.0.0.21' && link.rel === 'noopener noreferrer' && !p.text().includes('evil'), 'R12d: release link stays in the fixed repository; remote HTML is not rendered');
    assert(p.q('#releaseChannelSelect').getAttribute('role') === 'combobox' && p.q('label[for="releaseChannelSelect"]'), 'R12e: release channel has an accessible label');
    assert(/той же папке/.test(p.text()) && /не скачивает и не устанавливает/.test(p.text()), 'R12f: panel explains manual replacement at the same path and reload');
    await p.mousedown(p.tabs()[0]); await p.mousedown(p.tabs()[4]);
    assert(p.calls.releaseRequests.length === 1, 'R12g: revisiting Updates uses the daily cache');
    await p.click(p.q('#checkUpdatesButton'));
    assert(p.calls.releaseRequests.length === 2, 'R12h: manual button bypasses the cache');
    fail = true; await p.click(p.q('#checkUpdatesButton'));
    assert(/ограничил запросы/.test(p.q('[data-slot="update-status"]').textContent) && /Последняя успешная проверка/.test(p.text()) && !p.q('#checkUpdatesButton').disabled, 'R12i: rate limit is visible; previous success stays dated and retry remains available');
    assert(p.calls.messages.every((m) => !/DOWNLOAD|SAVE_MEDIA/.test(m)), 'R12j: update flow never sends a media-download command');
    await p.unmount();
    const empty = await page('full', { session: [], history: [], local: {} }, { hash: '#updates' });
    assert(/пока нет/.test(empty.q('[data-slot="update-status"]').textContent) && empty.calls.releaseRequests.length === 1, 'R12k: Updates deep link handles an empty published-release list');
    await empty.unmount();
  }

  console.log(`\nИТОГИ: ${passed}/${passed + failed} пройдено (${failed} ошибок).`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Ошибка в тестовом сценарии:', err);
  process.exit(1);
});
