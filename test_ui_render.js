// Rendering tests of the real extension pages (React, shadcn/ui and Radix UI).
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
        if(msg.action === 'DOWNLOADS_LIST' || msg.action === 'DOWNLOADS_COMMAND') {
          if(msg.command==='remove'){if(state.failRemoval)return {success:false};const op=state.jobs?.find(j=>j.id===msg.id)?.op || msg.id;if(state.jobs)state.jobs=state.jobs.filter(j=>j.id!==msg.id);state.session=state.session.filter(r=>r.id!==op);}
          return {success:true,jobs:state.jobs || state.session.map(r=>({id:r.id,op:r.id,managed:false,filename:r.filename || 'media',state:r.state==='saving'?'receiving':r.state==='interrupted'?'failed':r.state,received:1024,total:r.state==='saving'?null:2048,speed:0,error:'',ready:false})).reverse(),paused:false};
        }
        if (msg.action === 'FEEDBACK_LIST') {
          const snapshot = state.session.slice().reverse();
          const gate = state.listGates && state.listGates.shift();
          if (gate) await gate;
          return { success: true, records: snapshot };
        }
        if (msg.action === 'FEEDBACK_MARK_SEEN' || msg.action === 'FEEDBACK_CLEAR') return { success: true, records: state.session.slice().reverse() };
        if (msg.action === 'DEBUG_LIST' || msg.action === 'DEBUG_CLEAR') {
          // DEBUG-MENU-01: the worker's private journal answer (the page re-sanitizes every event)
          if (state.failDebug) return { success: false, error: 'DEBUG_UNAVAILABLE' };
          const d = state.debug || (state.debug = { events: [] });
          if (msg.action === 'DEBUG_CLEAR') { if (state.failDebugClear) return { success: false, error: 'DEBUG_CLEAR_FAILED' }; d.events = []; d.dropped = 0; d.expired = 0; }
          return { success: true, events: d.events, retained: d.events.length, persisted: d.persisted ?? d.events.length, dropped: d.dropped || 0, expired: d.expired || 0, storageError: d.storageError || '' };
        }
        if (msg.action === 'STATISTICS_LIST' || msg.action === 'STATISTICS_CLEAR') {
          if (msg.action === 'STATISTICS_CLEAR') { if (state.failClear) return { success: false }; state.history = []; }
          return { success: true, stats: FB.computeStats(state.history), imported: 0 };
        }
        if (msg.action === 'HISTORY_LIST' || msg.action === 'HISTORY_CLEAR') {
          if (msg.action === 'HISTORY_CLEAR') { if (state.failClear) return { success: false }; state.history = []; }
          return { success: true, records: state.history.slice().reverse() };
        }
        return undefined;
      },
      onMessage: {
        addListener: (cb) => { (state.msgListeners = state.msgListeners || []).push(cb); },
        removeListener: (cb) => { state.msgListeners = (state.msgListeners || []).filter((x) => x !== cb); },
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
    // the browser UI language (UI-LOCALIZATION-01): Russian unless a test sets state.uiLanguage; a saved uiLanguage wins over it
    i18n: { getUILanguage: () => (state.uiLanguage === undefined ? 'ru' : state.uiLanguage) },
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
  // the pages render inside the language provider, as quick-main.tsx and full-main.tsx do
  p.language = U.createLanguage({ chrome, navigator: win.navigator });
  const provide = (el, titleKey) => U.React.createElement(U.I18nProvider, { language: p.language, titleKey }, el);
  if (kind === 'quick') {
    p.quick = U.createQuick({ chrome, window: win });
    await U.act(async () => { root.render(provide(U.React.createElement(U.QuickApp, { quick: p.quick }))); });
    await p.quick.ready;
  } else {
    p.settings = U.createSettings({ chrome, FolderPath: win.ImageSaverFolderPath });
    await U.act(async () => { root.render(provide(U.React.createElement(U.FullApp, { settings: p.settings }), 'app.title')); });
    await p.settings.load();
  }
  await U.act(async () => { await p.language.ready; });
  await p.settle(8);
  p.rows = () => p.qa('[data-slot="result-item"]');
  p.tabs = () => p.qa('[role="tab"]');
  p.unmount = async () => { await U.act(async () => { root.unmount(); }); };
  return p;
}

(async () => {
  // The real page components apply themes to both documents and expose one labelled choice in settings.
  {
    for(const kind of ['full','quick'])for(const stored of [undefined,'invalid']) {
      const first=await page(kind,{session:[],history:[],local:{uiLanguage:'en',...(stored===undefined?{}:{uiTheme:stored})}});
      assert(first.doc.documentElement.dataset.theme==='violet',`theme-default-${kind}-${stored}: missing or invalid preferences show Violet`);
      await first.unmount();
    }
    for (const theme of ['blue', 'dark', 'light', 'violet']) {
      const full = await page('full', { session: [], history: [], local: { historyEnabled: true, uiTheme: theme, uiLanguage: 'en' } });
      const quick = await page('quick', { session: [], history: [], local: { historyEnabled: true, uiTheme: theme, uiLanguage: 'en' } });
      assert(full.doc.documentElement.dataset.theme === theme && quick.doc.documentElement.dataset.theme === theme,
        `theme-render-${theme}: full and compact pages apply the saved palette`);
      assert(full.q('#themeSelect')?.getAttribute('role') === 'combobox' && full.q('label[for="themeSelect"]').textContent === 'Theme',
        `theme-control-${theme}: settings expose an accessible theme combobox`);
      await full.unmount(); await quick.unmount();
    }
  }
  const sessionRecords = (n = 7) => Array.from({ length: n }, (_, i) => rec({ filename: `file-number-${i + 1}.jpg` }));

  // =================================================================================================
  console.log('\n--- R1. Native-style download manager popup independent of statistics ---');
  {
    const jobs=[{id:'job-known',filename:'photo.png',state:'receiving',received:1024,total:4096,speed:1024},{id:'job-unknown',filename:'movie.mp4',state:'receiving',received:1024,total:null,speed:512},{id:'job-local',filename:'ready.png',state:'failed',received:2048,total:2048,ready:true,error:'EXPORT_FAILED'}];
    for(const enabled of [true,false]) {
      const p=await page('quick',{session:[],history:[],jobs,local:{historyEnabled:enabled}});
      assert(p.q('h1').textContent==='MediaLatch' && p.qa('[data-job]').length===3,'manager-render-1: jobs show with either statistics setting');
      assert(!p.q('#historyInvite') && !p.q('#enableHistoryButton'),'manager-render-2: no statistics gate or invitation');
      const bars=p.qa('progress');assert(bars.length===2 && bars[0].getAttribute('max')==='4096' && bars[0].getAttribute('value')==='1024' && !bars[1].hasAttribute('value'),'manager-render-3: measured total and unknown total remain distinct');
      assert(p.text().includes('размер неизвестен') && p.text().includes('Готовый файл сохранён для повтора'),'manager-render-4: unknown sizes and prepared-file retry are explicit');
      assert(p.q('button[aria-label="Отменить загрузку"]') && p.q('button[aria-label="Сохранить готовый файл снова"]'),'manager-render-5: cancel and local-file retry are accessible');
      await p.click(p.q('#openSettingsButton'));assert(p.calls.tabsCreate[0].endsWith('#saving') && p.closed.length===1,'manager-render-6: settings navigation closes only after opening');
      await p.unmount();
    }
    const p=await page('quick',{session:[],history:[],local:{},failMessages:true});assert(p.q('[role="alert"]')?.textContent.includes('Не удалось загрузить список'),'manager-render-7: manager loading failure is visible');await p.unmount();
    const preparation=await page('quick',{session:[],history:[],local:{},jobs:[{id:'op-preparation',managed:false,filename:'',state:'converting',received:0,total:null}]});
    assert(preparation.text().includes('Обработка медиа') && preparation.text().includes('Выбранное медиа') && preparation.text().includes('после подготовки'),'manager-render-8: processing is visible without invented byte progress or controls');
    assert(!preparation.q('button[aria-label="Отменить загрузку"]') && !preparation.q('progress').hasAttribute('value'),'manager-render-9: preparation does not promise transport cancellation');await preparation.unmount();
  }


    for(const lang of ['en','ru'])for(const theme of ['blue','dark','light'])for(const kind of ['quick','full']){
      const failed=unnamedFailure(), state={session:[failed],history:[],local:{uiLanguage:lang,uiTheme:theme},failRemoval:true};
      const p=await page(kind,state,{hash:'#downloads'});
      const label=lang==='ru'?'Удалить запись':'Remove record';
      const remove=p.q('button[aria-label="'+label+'"]');
      assert(remove,'unmanaged-dismiss: terminal removal is labelled in '+kind+' '+lang+' '+theme);
      assert(!p.q('button[aria-label="'+(lang==='ru'?'Повторить загрузку':'Retry download')+'"]'),'unmanaged-dismiss: no unproven retry');
      if(remove){await p.click(remove);assert(p.qa('[data-job]').length===1 && p.q('[role="alert"]'),'unmanaged-dismiss: persistence failure retains card with error');state.failRemoval=false;await p.click(remove);assert(p.qa('[data-job]').length===0,'unmanaged-dismiss: selected terminal card removed');}
      await p.unmount();
      const reopened=await page(kind,state,{hash:'#downloads'});assert(reopened.qa('[data-job]').length===0,'unmanaged-dismiss: no card on reopen');await reopened.unmount();
    }

  console.log('\n--- R3. Unread failures, acknowledgement and states ---');
  {
    const saved=rec({filename:'one-file.mp4'}),failed=unnamedFailure();
    const state={session:[saved,failed],history:[],local:{},jobs:[{id:'job-one',op:saved.id,filename:saved.filename,state:'complete',received:2048,total:2048},{id:'job-failed',op:failed.id,filename:'',state:'failed',received:0,error:'NO_MEDIA'}]};
    const p=await page('full',state,{hash:'#downloads'});
    assert(p.qa('[data-job]').length===2 && p.rows().length===2 && !p.text().includes('Результаты сохранения') && !p.q('[data-slot="results"]'),'manager-unified-1: one card per job, no separate results list or heading');
    const card=p.q('[data-job="job-one"]');
    assert(card.textContent.includes('2.0 KB / 2.0 KB') && card.querySelector('[data-slot="name"]').textContent===saved.filename,'manager-unified-2: byte progress and result summary share one card');
    assert(!card.querySelector('button button'),'manager-unified-3: action buttons are siblings of the details trigger');
    await p.click(card.querySelector('button[aria-expanded]'));
    assert(card.querySelector('[data-slot="result-details"]') && card.querySelector('[data-slot="filename-line"]'),'manager-unified-4: expanding the download retains complete result details');
    await p.click(p.q('[data-job="job-failed"] button[aria-expanded]'));
    assert(p.q('[data-job="job-failed"] [data-slot="report"]'),'manager-unified-5: failed download retains the copyable report');
    await p.click(card.querySelector('button[aria-label="Удалить запись и временный файл"]'));
    assert(!p.q('[data-job="job-one"]') && !state.session.some(r=>r.id===saved.id) && state.session.some(r=>r.id===failed.id),'manager-unified-6: removing a card clears only its diagnostic record, without resurrecting a duplicate');
    await p.unmount();
    const deep=await page('full',{session:[saved],history:[],local:{},jobs:[]},{search:`?op=${saved.id}`});
    assert(deep.rows().length===1 && deep.rows()[0].querySelector('button[aria-expanded="true"]') && !deep.q('button[aria-label="Удалить запись и временный файл"]'),'manager-unified-7: an old notification deep link still opens retained details without a fabricated queue action');
    await deep.unmount();
    const focusedRecord=rec({filename:'focused-clear.png'}),focusedState={session:[focusedRecord],history:[],local:{},jobs:[{id:'job-focus',op:focusedRecord.id,state:'complete',filename:'focused-clear.png',received:10,total:10}]};
    const clearing=await page('full',focusedState,{hash:'#downloads',search:`?op=${focusedRecord.id}`});
    const clear=clearing.q('button[aria-label="Очистить завершённые записи (файлы и статистика останутся)"]');
    await clearing.click(clear);
    assert(!clearing.rows().length && !clearing.qa('[data-job]').length,'manager-clear-focus-stale: successful bulk removal cannot reconstruct a deep-linked card from the independent old feedback snapshot');
    await clearing.unmount();
  }
  {
    const fail = unnamedFailure();
    const interrupted = rec({ state: 'interrupted', filename: 'part.webm', filenameKind: 'intended', output: { type: 'video', ext: '.webm', evidence: 'filename_hint' }, failure: failure('download', 'download_interrupted', { downloadError: 'NETWORK_FAILED' }) });
    const state = { session: [rec(), fail, interrupted, rec({ state: 'cancelled', output: {}, failure: failure('save', 'cancelled') }), rec({ state: 'saving', filename: 'now.jpg', filenameKind: 'intended', output: {} })], history: [], local: { historyEnabled: true } };
    const p = await page('full', state, {hash:'#downloads'});
    const kinds = p.rows().map((r) => r.getAttribute('data-state-kind'));
    assert(kinds.join() === 'saving,cancelled,interrupted,failed,complete' || kinds.length === 5, 'R3a: every state has its row');
    assert(p.rows().filter((r) => r.getAttribute('data-unread') === 'true').length === 2 && p.qa('[data-slot="result-item"] .bg-destructive, [data-slot="badge"]').length >= 2, 'R3b: the two unread failures are marked "новое"');
    assert(p.calls.messages.filter((m) => m === 'FEEDBACK_MARK_SEEN').length === 1, 'R3c: viewing the visible list acknowledges the failures once');
    assert(p.qa('[data-slot="result-item"] svg').every((s) => s.getAttribute('aria-hidden') === 'true'), 'R3d: state icons are decorative; the state is in the text');
    const pend = p.rows()[0];
    assert(/Сохранение/.test(pend.textContent) && p.qa('svg.animate-spin', pend).length === 1 && p.qa('svg.animate-spin', pend)[0].getAttribute('class').includes('motion-reduce:animate-none'), 'R3e: a pending result shows a spinner that stops under reduced motion');
    await p.click(p.rows()[3].querySelector('button')); // the unnamed failure
    const report = p.q('[data-slot="report"]');
    assert(report && /одна попытка возобновить/.test(report.textContent) && /не отправляется автоматически/.test(report.textContent), 'R3f: a failed result shows the bounded native resume and the no-submission promise');
    const preview = p.q('textarea[aria-label="Предпросмотр отчёта"]');
    assert(preview && preview.readOnly && preview.value.startsWith('MediaLatch bug report') && /browser: Chromium 126/.test(preview.value), 'R3g: the report preview is read-only and carries the browser only when reliable');
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R4. Report: notes, clipboard success and failure ---');
  {
    const texts = [];
    let denyClipboard = false;
    const clipboard = { writeText: async (t) => { if (denyClipboard) throw new Error('DENIED'); texts.push(t); } };
    const state = { session: [unnamedFailure()], history: [], local: { historyEnabled: true } };
    const p = await page('full', state, {hash:'#downloads', clipboard});
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
    assert(tabs.length === 7 && tabs.map((t) => t.textContent.trim()).join('|') === 'Загрузки|Статистика|Сохранение|Уведомления|Embed|Обновления|Отладка' && p.q('[role="tablist"]'), 'R5a: six tabs (DEBUG-MENU-01 adds Debug) in a tab list with the requested names');
    const sel = () => tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent.trim());
    const shown = () => p.qa('[role="tabpanel"]').filter((x) => !x.hidden && !x.hasAttribute('hidden')).map((x) => x.id || x.getAttribute('aria-labelledby'));
    assert(sel().join() === 'Embed' && p.qa('[role="tabpanel"]').length === 7 && shown().length === 1, 'R5b: the URL hash selects the section; exactly one panel is displayed');
    assert(p.qa('[role="tabpanel"]').every((panel) => panel.getAttribute('aria-labelledby') && p.doc.getElementById(panel.getAttribute('aria-labelledby'))), 'R5c: every panel is labelled by its tab');
    const tablist = p.q('[role="tablist"]');
    tablist.focus();
    await p.settle(4);
    assert(tablist.getAttribute('tabindex') === '0' && p.doc.activeElement === tabs[4] && tabs.filter((t) => t.getAttribute('tabindex') === '0').length === 1 && tabs[4].getAttribute('tabindex') === '0', 'R5d: the tab list is one tab stop and hands focus to the selected tab (roving focus)');
    assert(p.q('#settingsSaveBar') !== null, 'R5e: the settings save bar is visible for Embed');
    await p.mousedown(tabs[1]);
    assert(sel().join() === 'Статистика' && !p.q('#settingsSaveBar') && p.win.location.hash === '#history', 'R5f: choosing a tab shows its panel, hides the save bar and updates the hash');
    await p.mousedown(tabs[3]);
    assert(!p.q('#settingsSaveBar'), 'R5g: no save bar for Notifications (its preference applies immediately)');
    await p.mousedown(tabs[2]);
    assert(p.q('#settingsSaveBar'), 'R5h: the save bar is visible for Saving');
    tabs[1].focus();
    await p.mousedown(tabs[1]);
    await p.key(tabs[1], 'ArrowRight');
    assert(sel().join() === 'Сохранение' && p.doc.activeElement === tabs[2], 'R5i: ArrowRight moves focus and selection to the next tab');
    await p.key(tabs[2], 'ArrowLeft');
    await p.key(p.doc.activeElement, 'ArrowLeft');
    await p.key(p.doc.activeElement, 'ArrowLeft');
    assert(sel().join() === 'Отладка', 'R5j: ArrowLeft wraps from Downloads to Debug');
    await p.key(p.doc.activeElement, 'Home');
    assert(sel().join() === 'Загрузки', 'R5k: Home selects Downloads first');
    await p.key(p.doc.activeElement, 'End');
    assert(sel().join() === 'Отладка', 'R5l: End selects Debug last');
    p.win.history.replaceState(null, '', '#notifications');
    p.win.dispatchEvent(new p.win.HashChangeEvent('hashchange'));
    await p.settle(4);
    assert(sel().join() === 'Уведомления', 'R5m: a hash change switches the section');
    p.win.history.replaceState(null, '', '#nonsense');
    p.win.dispatchEvent(new p.win.HashChangeEvent('hashchange'));
    await p.settle(4);
    assert(sel().join() === 'Статистика', 'R5n: an invalid hash falls back to the default section');
    await p.unmount();

    const deep = await page('full', { session: [rec({ filename: 'a.jpg' }), failedOne], history: [], local: {} }, { hash: '#embed', search: '?op=' + encodeURIComponent(failedOne.id) });
    const open = deep.rows().filter((r) => r.querySelector('button').getAttribute('aria-expanded') === 'true');
    assert(deep.tabs().find((t) => t.getAttribute('aria-selected') === 'true').textContent.includes('Загрузки') && open.length === 1 && /Не удалось определить медиа/.test(open[0].textContent) && deep.scrolled.includes('result-item'), 'R5o: ?op= opens the history section, expands exactly that operation and scrolls to it');
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
    await p.mousedown(p.tabs()[2]); await p.mousedown(p.tabs()[0]); await p.settle(4);
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
    await p.mousedown(p.tabs()[4]); await p.mousedown(p.tabs()[2]);
    assert(p.q('#subfolderInput').value === 'x'.repeat(300), 'R7k: unsaved edits survive switching sections');
    state.failSet = true;
    await p.type(p.q('#subfolderInput'), 'ok');
    await p.click(p.q('#saveButton'));
    assert(/Не удалось сохранить настройки/.test(p.q('#statusMessage').textContent) && !p.q('#saveButton').disabled, 'R7l: a storage failure is reported and the button is released');
    state.failSet = false;

    // notifications
    await p.mousedown(p.tabs()[3]);
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
    await p.mousedown(p.tabs()[4]);
    const ids = ['xShareHostSelect', 'igShareHostSelect', 'ttShareHostSelect', 'youtubeShareHostSelect'];
    assert(ids.every((id) => { const t = p.q(`#${id}`); return t && t.getAttribute('role') === 'combobox' && p.q(`label[for="${id}"]`); }), 'R7q: the four share-host selects are labelled comboboxes');
    assert(ids.map((id) => p.q(`#${id}`).textContent).join('|') === 'fixupx.com|oginstagram.com|tnktok.com|koutube.com', 'R7r: missing preferences select the four preview defaults');
    const help = p.q('[data-slot="embed"] [data-slot="collapsible-trigger"]');
    assert(/Копировать ссылку/.test(p.q('[data-slot="embed"]').textContent) && help.getAttribute('aria-expanded') === 'false' && !/сторонние сервисы/.test(p.q('[data-slot="embed"]').textContent) && p.q('#settingsSaveBar'), 'R7s: concise description and explicit save remain; provider details start collapsed');
    await p.click(help);
    assert(help.getAttribute('aria-expanded') === 'true' && /сторонние сервисы/.test(p.q('[data-slot="embed"]').textContent) && /не скачивание MP4/.test(p.q('[data-slot="embed"]').textContent), 'R7s1: disclosure retains third-party and direct-embed explanations');
    await p.click(help);
    assert(help.getAttribute('aria-expanded') === 'false', 'R7s2: provider details can be collapsed again');
    await p.key(p.q('#xShareHostSelect'), 'Enter');
    await p.settle(6);
    const options = p.qa('[role="option"]');
    assert(options.length === 3 && options.map((o) => o.textContent).join('|') === 'fixupx.com (по умолчанию)|x.com (оригинал)|cunnyx.com (резерв)', 'R7t: preview default first, optional original and backup remain available');
    await p.key(options[1], 'Enter');
    await p.settle(6);
    assert(p.q('#xShareHostSelect').textContent === 'x.com', 'R7u: the original is an explicit selectable option');
    state.failSet = false;
    await p.click(p.q('#saveButton'));
    assert(p.calls.localSets[p.calls.localSets.length - 1].xShareHost === 'x.com' && p.calls.localSets[p.calls.localSets.length - 1].igShareHost === 'oginstagram.com', 'R7v: original choice saves without changing other preview defaults');
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R8. Clean all-time statistics ---');
  {
    const ok = rec({ output: { type:'pic', ext:'.jpg', evidence:'verified_mime', mime:'image/jpeg', sizeBytes:2048, sizeKind:'measured' } });
    const state = { session: [], history:[ok,unnamedFailure()], local:{historyEnabled:true} };
    const p = await page('full',state);
    const value = k => p.q('[data-stat="'+k+'"] [data-slot="value"]')?.textContent;
    assert(value('total') === '2' && value('success') === '1' && value('failed') === '1','R8a: aggregate outcome tiles');
    assert(!p.q('[data-slot="history"]') && !p.q('[data-slot="recent"]').closest('[role="tabpanel"]').hidden === false && /Без ограничения/.test(p.q('[data-slot="scope-note"]').textContent),'R8b: clean Statistics; download results live in another section');
    assert(/не менее 2,0 КБ/.test(p.q('[data-slot="size-text"]').textContent),'R8c: measured-size evidence retained');
    const sw=p.q('#statisticsEnabled');
    assert(sw && p.q('label[for="statisticsEnabled"]'),'R8d: labelled recording switch');
    await p.click(sw); assert(state.local.historyEnabled === false && value('total')==='2','R8e: turning recording off retains totals');
    state.failSet=true; await p.click(sw); assert(sw.getAttribute('aria-checked')==='false' && /Не удалось сохранить настройку учёта/.test(p.text()),'R8f: failed preference write is truthful');
    state.failSet=false;state.failClear=true;await p.click(p.byText('button',/Очистить статистику/));assert(value('total')==='2' && /итоги сохранены/.test(p.text()),'R8g: failed clear retains totals');
    state.failClear=false;await p.click(p.byText('button',/Очистить статистику/));assert(p.q('[data-slot="stats-message"]') && /Статистика очищена/.test(p.text()),'R8h: successful durable clear');
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R9. Long names, accessibility of names and identifiers ---');
  {
    const long = rec({ filename: `${'очень-длинное-имя-'.repeat(20)}.png`, site: 'a-very-long-subdomain.example-gallery-site.com' });
    const p = await page('full', { session: [long], history: [long], local: { historyEnabled: true } }, {hash:'#downloads'});
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
    assert(p.q('[data-slot="credits"]') && /shadcn\/ui/.test(p.q('[data-slot="credits"]').textContent) && /Radix UI/.test(p.q('[data-slot="credits"]').textContent), 'R9f: the interface credits its current component libraries');
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R10. UX-06: an open page follows the tracker (completion, failure, cancellation) ---');
  {
    const emit = (state, area = 'session') => { for (const cb of (state.changeListeners || []).slice()) cb({ imageSaverFeedbackV1: { newValue: {} } }, area); for(const cb of (state.msgListeners || []).slice())cb({action:'DOWNLOADS_CHANGED'}); };
    const state = { session: [rec({ filename: 'first.jpg' })], history: [], local: { historyEnabled: true } };
    const p = await page('full', state, {hash:'#downloads'});
    const rows = () => p.rows().map((r) => ({ name: (r.querySelector('[data-slot="name"]') || r.querySelector('[data-slot="legacy"]')).textContent, kind: r.getAttribute('data-state-kind'), unread: r.getAttribute('data-unread') }));
    assert(rows().length === 1 && rows()[0].name === 'first.jpg', 'R10a: the popup opens with one result');
    assert((state.changeListeners || []).length >= 3, 'R10b: the full page retains independent language/theme/results subscriptions');

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
    assert(rows().length === 8 && rows()[0].name === 'bulk-3.jpg', 'R10g: the full Downloads page retains all eight recent results');
    const trigger = p.rows()[0].querySelector('button');
    await p.click(trigger);
    emit(state);
    await p.settle(8);
    assert(p.rows()[0].querySelector('button').getAttribute('aria-expanded') === 'true' && p.rows().length === 8, 'R10h: a refresh does not collapse an opened row or duplicate rows');
    state.session.length = 0;
    emit(state);
    await p.settle(8);
    assert(p.rows().length === 0 && /Загрузок пока нет\./.test(p.q('[data-slot="empty"]').textContent), 'R10i: a clear elsewhere empties the open popup');
    await p.unmount();
    assert((state.changeListeners || []).length === 1, 'R10j: closing the page removes results/statistics/theme subscriptions; only the page-lifetime language controller remains');
    const requests = p.calls.messages.length;
    state.session.push(rec());
    emit(state);
    await sleep(20);
    assert(p.calls.messages.length === requests, 'R10k: after closing no more requests are made');

    // the full page: results and statistics follow
    const fstate = { session: [rec({ filename: 'a.jpg' })], history: [rec({ filename: 'h1.jpg' })], local: { historyEnabled: true } };
    const f = await page('full', fstate, { hash: '#history' });
    const val = (k) => f.q('[data-stat="' + k + '"] [data-slot="value"]').textContent;
    assert(val('total') === '1' && val('success') === '1' && !f.q('[data-slot="history"]'), 'R10l: the full page starts with one result and one history entry');
    fstate.history.push(rec({ state: 'failed', output: {}, failure: failure('download', 'network') }));
    fstate.session.push(unnamedFailure());
    for (const cb of (fstate.changeListeners || []).slice()) { cb({ imageSaverHistoryV1: { newValue: {} } }, 'local'); cb({ imageSaverFeedbackV1: { newValue: {} } }, 'session'); }
    for (const cb of fstate.msgListeners || []) { cb({action:'STATISTICS_CHANGED'}); cb({action:'DOWNLOADS_CHANGED'}); }
    await f.settle(10);
    assert(val('total') === '2' && val('failed') === '1' && !f.q('[data-slot="history"]') && f.qa('[data-slot="results-section"] [data-slot="result-item"]').length === 2, 'R10m: the open full page shows the new failure in the results and in the history, and updates the statistics');
    await f.unmount();
    assert((fstate.changeListeners || []).length === 1, 'R10n: closing the page removes the subscriptions of the results list and the history (only the page-lifetime language controller remains)');
  }

  // =================================================================================================
  console.log('\n--- R11. Regressions: keyboard accordion, failure inspectability, folder validation, honest stats rendering ---');
  {
    // Case 1: Activation of disclosure button toggling aria-expanded
    const singleRec = rec({ filename: 'keyboard-test.jpg', site: 'example.com' });
    const pQuick = await page('full', { session: [singleRec], history: [], local: { historyEnabled: true } }, {hash:'#downloads'});
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
    await p.mousedown(p.tabs()[5]);
    assert(p.win.location.hash === '#updates' && !p.q('#settingsSaveBar'), 'R12b: Updates deep link and tab do not use the unrelated save bar');
    assert(p.calls.releaseRequests.length === 1 && /Доступна версия 2.0.0.21/.test(p.q('[data-slot="update-status"]').textContent), 'R12c: entering Updates performs a release check and renders the available version');
    const link = p.q('[data-slot="updates"] a');
    assert(link.href === 'https://github.com/xhthc/MediaLatch/releases/tag/v2.0.0.21' && link.rel === 'noopener noreferrer' && !p.text().includes('evil'), 'R12d: release link stays in the fixed repository; remote HTML is not rendered');
    assert(p.q('#releaseChannelSelect').getAttribute('role') === 'combobox' && p.q('label[for="releaseChannelSelect"]'), 'R12e: release channel has an accessible label');
    assert(/той же папке/.test(p.text()) && /не скачивает и не устанавливает/.test(p.text()), 'R12f: panel explains manual replacement at the same path and reload');
    await p.mousedown(p.tabs()[1]); await p.mousedown(p.tabs()[5]);
    assert(p.calls.releaseRequests.length === 1, 'R12g: revisiting Updates uses the daily cache');
    await p.click(p.q('#checkUpdatesButton'));
    assert(p.calls.releaseRequests.length === 2, 'R12h: manual button bypasses the cache');
    fail = true; await p.click(p.q('#checkUpdatesButton'));
    assert(/ограничил запросы/.test(p.q('[data-slot="update-status"]').textContent) && /Последняя успешная проверка/.test(p.text()) && !p.q('#checkUpdatesButton').disabled, 'R12i: rate limit is visible; previous success stays dated and retry remains available');
    assert(p.calls.messages.every((m) => m!=='DOWNLOADS_COMMAND' && !/SAVE_MEDIA/.test(m)), 'R12j: update flow never sends a media-download command');
    await p.unmount();
    const empty = await page('full', { session: [], history: [], local: {} }, { hash: '#updates' });
    assert(/пока нет/.test(empty.q('[data-slot="update-status"]').textContent) && empty.calls.releaseRequests.length === 1, 'R12k: Updates deep link handles an empty published-release list');
    await empty.unmount();
  }

  // =================================================================================================
  console.log('\n--- R13. UI-LOCALIZATION-01: English / Русский on both pages, live switch, persistence and failures ---');
  {
    const chooseLanguage = async (p, name) => {
      await p.key(p.q('#languageSelect'), 'Enter');
      await p.settle(6);
      const option = p.qa('[role="option"]').find((o) => o.textContent.trim() === name);
      if (!option) return false;
      await p.key(option, 'Enter');
      await p.settle(8);
      return true;
    };
    const tabNames = (p) => p.tabs().map((t) => t.textContent.trim()).join('|');
    const failRec = rec({ state: 'failed', filename: 'clip <img src=x onerror=1> & co.mp4', filenameKind: 'intended', output: { type: 'video', ext: '.mp4', evidence: 'filename_hint' }, failure: failure('download', 'download_interrupted', { downloadError: 'NETWORK_FAILED' }) });
    const state = { session: [rec({ filename: 'Фото.jpg' }), failRec], history: [rec({ filename: 'old-entry.jpg' })], local: { historyEnabled: true } };

    const full = await page('full', state, { hash: '#saving' });
    assert(tabNames(full) === 'Загрузки|Статистика|Сохранение|Уведомления|Embed|Обновления|Отладка' && full.doc.documentElement.lang === 'ru' && full.doc.title === 'MediaLatch: загрузки и настройки', 'R13a: a Russian browser with no saved choice shows the Russian page (lang and title follow)');
    const langBox = full.q('#languageSelect');
    assert(langBox && langBox.getAttribute('role') === 'combobox' && full.q('label[for="languageSelect"]').textContent === 'Язык' && /Русский/.test(langBox.textContent), 'R13b: the language choice is a labelled combobox showing the current language');
    const quick = await page('quick', state);
    assert(quick.q('#openSettingsButton').getAttribute('aria-label') === 'Настройки' && quick.doc.documentElement.lang === 'ru', 'R13c: the compact popup opens in the same language');

    // an unsaved edit survives en -> ru -> en; only the language is written
    await full.type(full.q('#subfolderInput'), 'Unsaved/Edit');
    const setsBefore = full.calls.localSets.length;
    assert(await chooseLanguage(full, 'English'), 'R13d: setup - English is offered by its own name');
    assert(tabNames(full) === 'Downloads|Statistics|Saving|Notifications|Embed|Updates|Debug' && full.doc.documentElement.lang === 'en' && full.doc.title === 'MediaLatch: downloads and settings', 'R13e: ru -> en switches the open page at once (tabs, lang, title)');
    assert(full.q('#subfolderInput').value === 'Unsaved/Edit' && full.q('#folderPreviewPath').textContent === 'Downloads/Unsaved/Edit/photo.jpg' && JSON.stringify(full.calls.localSets.slice(setsBefore)) === JSON.stringify([{ uiLanguage: 'en' }]), 'R13f: the unsaved folder edit is kept and only uiLanguage is written');
    assert(/Save settings/.test(full.q('#saveButton').textContent) && /“MediaLatch: Save media”/.test(full.text()) && full.q('label[for="languageSelect"]').textContent === 'Language', 'R13g: buttons, labels and the fixed menu title follow');
    await quick.settle(6);
    assert(quick.q('#openSettingsButton').getAttribute('aria-label') === 'Settings' && quick.doc.documentElement.lang === 'en' && /Saved/.test(quick.qa('[data-job]')[1].textContent), 'R13h: the open compact popup follows the change made on the full page (rows and accessible names)');
    assert(quick.qa('[data-job]')[0].textContent.includes('clip <img src=x onerror=1> & co.mp4') && quick.doc.querySelectorAll('img').length === 0, 'R13i: an original file name is shown as text in every language, never as markup');
    assert(await chooseLanguage(full, 'Русский') && tabNames(full).startsWith('Загрузки') && full.q('#subfolderInput').value === 'Unsaved/Edit', 'R13j: en -> ru keeps the edit');
    assert(await chooseLanguage(full, 'English') && tabNames(full).startsWith('Downloads') && full.q('#subfolderInput').value === 'Unsaved/Edit' && state.local.uiLanguage === 'en' && state.local.subfolder === undefined, 'R13k: ru -> en again; the folder edit is still unsaved');
    await full.mousedown(full.tabs()[1]);
    assert(/Statistics/.test(full.text()) && /Record statistics/.test(full.text()) && !/Save history/.test(full.text()), 'R13l: statistics, history and results are English');
    const failRow = full.qa('[data-slot="results-section"] [data-slot="result-item"]').find((r) => r.getAttribute('data-state-kind') === 'failed');
    await full.click(failRow.querySelector('button'));
    assert(/Download interrupted/.test(failRow.textContent) && /Chrome code: NETWORK_FAILED/.test(failRow.textContent) && /Copy report/.test(failRow.textContent) && /MediaLatch bug report/.test(failRow.querySelector('textarea[readonly]').value), 'R13m: an older record is shown in English; diagnostic codes and the report format stay intact');

    // close / reopen: the saved choice is read again
    await quick.unmount();
    await full.unmount();
    const reopened = await page('full', state);
    assert(tabNames(reopened).startsWith('Downloads') && reopened.doc.documentElement.lang === 'en', 'R13n: a reopened page uses the saved English choice over the Russian browser');

    // a failed write keeps the language and says so
    state.failSet = true;
    await chooseLanguage(reopened, 'Русский');
    assert(tabNames(reopened).startsWith('Downloads') && state.local.uiLanguage === 'en' && /Could not save the language/.test(reopened.q('[data-slot="language-status"]').textContent), 'R13o: a failed write keeps English and reports the failure (no success state)');
    state.failSet = false;
    await reopened.unmount();

    // an unreadable preference shows the browser language and says so; an English browser defaults to English
    const unreadable = await page('full', { session: [], history: [], local: { uiLanguage: 'en' }, failGet: true });
    assert(tabNames(unreadable).startsWith('Загрузки') && /Не удалось прочитать сохранённый язык/.test(unreadable.q('[data-slot="language-status"]').textContent), 'R13p: an unreadable preference shows the browser language with a message');
    await unreadable.unmount();
    const enBrowser = await page('quick', { session: [], history: [], local: {}, uiLanguage: 'en-US' });
    assert(enBrowser.q('#openSettingsButton').getAttribute('aria-label') === 'Settings' && /Downloads/.test(enBrowser.text()) && !enBrowser.q('#enableHistoryButton'), 'R13q: an English browser with no saved choice gets the English compact popup');
    await enBrowser.unmount();
    const invalid = await page('quick', { session: [], history: [], local: { uiLanguage: 'de' }, uiLanguage: 'ru-RU' });
    assert(invalid.q('#openSettingsButton').getAttribute('aria-label') === 'Настройки' && invalid.calls.localSets.length === 0, 'R13r: an invalid saved value falls back to the browser language and is not rewritten');
    await invalid.unmount();
  }

  // =================================================================================================
  console.log('\n--- R20. Debug journal (DEBUG-MENU-01): loading, switch, filters, copy, export, clear, live, language ---');
  {
    const now = Date.now();
    const ev = (i, over = {}) => ({ seq: i, t: now - 60000 + i * 1000, lvl: 'info', src: 'worker', comp: 'menu', act: 'click', out: 'start', cid: 'a1b2c3d4', ...over });
    const events = [
      ev(1),
      ev(2, { src: 'content', comp: 'reddit.inline', act: 'click', out: 'refused', why: 'NOT_TRUSTED', lvl: 'warn', tab: 7, frame: 0, page: 'www.reddit.com', d: { which: 'this' } }),
      ev(3, { comp: 'op', act: 'fail', out: 'failed', why: 'NO_MEDIA', op: 'op-abc123', d: { stage: 'resolve', http: 404, host: 'cdn.example.com' } }),
      // a stored event with values the allowlist does not admit: they never reach the page
      ev(4, { comp: 'plan', act: 'select', out: 'ok', why: 'free text reason', d: { host: 'https://cdn.example.com/a/secret.jpg?token=SIGNED', filename: 'secret.jpg', url: 'https://x.test/?q=1' } })
    ];
    const state = { session: [], history: [], local: { debugEnabled: false }, debug: { events: events.slice(), dropped: 2, expired: 1 } };
    const texts = [];
    let denyClipboard = false;
    const clipboard = { writeText: async (t) => { if (denyClipboard) throw new Error('DENIED'); texts.push(t); } };
    const p = await page('full', state, { hash: '#debug', clipboard });
    const panel = () => p.q('[data-slot="debug"]');
    const rows = () => p.qa('[data-slot="debug-event"]');
    assert(panel() && /Журнал отладки/.test(panel().textContent) && p.tabs().find((t) => t.getAttribute('aria-selected') === 'true').textContent.trim() === 'Отладка', 'R20a: #debug opens the Debug section with the journal (Russian)');
    assert(rows().length === 4 && /хранится 4 · отброшено 2 · устарело 1/.test(p.q('[data-slot="debug-counts"]').textContent) && /Запись выключена/.test(p.q('[data-slot="debug-recording"]').textContent), 'R20b: events newest first, retained/dropped/expired counters and the recording state are shown');
    assert(/NOT_TRUSTED/.test(rows()[2].textContent) && /reddit\.inline\.click/.test(rows()[2].textContent) && !/secret|token=|SIGNED|free text|x\.test/.test(panel().textContent) && /cdn\.example\.com/.test(panel().textContent), 'R20c: rows show codes and hosts only; a full URL, a filename and free text from storage are not shown');
    const sw = p.q('#debugEnabledSwitch');
    await p.click(sw);
    assert(p.calls.localSets.some((v) => v.debugEnabled === true) && /Запись идёт/.test(p.q('[data-slot="debug-recording"]').textContent), 'R20d: the switch saves debugEnabled and shows that recording is on');
    await p.type(p.q('#debugSearch'), 'not_trusted');
    assert(rows().length === 1 && /NOT_TRUSTED/.test(rows()[0].textContent), 'R20e: search filters by codes (case-insensitive)');
    await p.type(p.q('#debugSearch'), 'zzz-no-such');
    assert(rows().length === 0 && p.q('[data-slot="debug-nomatch"]'), 'R20f: no match is shown as such');
    await p.type(p.q('#debugSearch'), '');
    const copy = p.byText('button', /Скопировать отчёт/);
    await p.click(copy);
    assert(texts.length === 1 && /Отчёт отладки MediaLatch/.test(texts[0]) && /reddit\.inline\.click \| refused NOT_TRUSTED/.test(texts[0]) && !/secret|token=/.test(texts[0]) && /Отчёт скопирован \(событий: 4\)/.test(p.q('[data-slot="debug-notice"]').textContent), 'R20g: the readable report is copied (oldest first, codes only) and success is shown only after the write');
    denyClipboard = true;
    await p.click(copy);
    assert(texts.length === 1 && /Не удалось скопировать/.test(p.q('[data-slot="debug-notice"]').textContent), 'R20h: a refused clipboard is reported as a failure');
    const blobs = [];
    p.win.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:chrome-extension://testid/debug'; };
    p.win.URL.revokeObjectURL = () => {};
    p.win.HTMLAnchorElement.prototype.click = function () { (p.downloads = p.downloads || []).push(this.getAttribute('download')); };
    await p.click(p.byText('button', /Скачать JSON/));
    const json = blobs.length ? JSON.parse(await blobs[0].text()) : null;
    assert(json && json.kind === 'MediaLatch debug journal' && json.events.length === 4 && json.dropped === 2 && !JSON.stringify(json).includes('secret') && /^medialatch-debug-.*\.json$/.test(p.downloads[0]) && /Файл JSON \(событий: 4\)/.test(p.q('[data-slot="debug-notice"]').textContent), 'R20i: JSON export holds the re-sanitized events and counters; a local file is offered');
    delete p.win.URL.createObjectURL;
    await p.click(p.byText('button', /Скачать JSON/));
    assert(/Не удалось подготовить файл JSON/.test(p.q('[data-slot="debug-notice"]').textContent), 'R20j: an export that cannot be prepared is reported as a failure');
    state.debug.events.push(ev(5, { comp: 'download', act: 'complete', out: 'ok', d: { downloadId: 42 } }));
    for (const cb of state.msgListeners || []) cb({ action: 'DEBUG_CHANGED' }, { id: 'testid' });
    await p.settle(6);
    assert(rows().length === 5 && /download\.complete/.test(rows()[0].textContent), 'R20k: a DEBUG_CHANGED notice from the extension reloads the list live');
    for (const cb of state.msgListeners || []) cb({ action: 'DEBUG_CHANGED' }, { id: 'other', tab: { id: 1 } });
    state.failDebugClear = true;
    await p.click(p.byText('button', /Очистить журнал/));
    assert(rows().length === 5 && /Не удалось очистить журнал/.test(p.q('[data-slot="debug-notice"]').textContent), 'R20l: a failed clear keeps every event and says nothing was deleted');
    state.failDebugClear = false;
    await p.click(p.byText('button', /Очистить журнал/));
    assert(rows().length === 0 && p.q('[data-slot="debug-empty"]') && /Журнал отладки очищен/.test(p.q('[data-slot="debug-notice"]').textContent) && p.calls.messages.filter((m) => m === 'DEBUG_CLEAR').length === 2, 'R20m: a successful clear empties the journal and says so');
    await p.unmount();
    const failing = await page('full', { session: [], history: [], local: {}, failDebug: true }, { hash: '#debug' });
    assert(/Не удалось загрузить журнал/.test(failing.q('[data-slot="debug"]').textContent), 'R20n: an unavailable journal is reported');
    await failing.unmount();
    const en = await page('full', { session: [], history: [], local: { uiLanguage: 'en', debugEnabled: true }, debug: { events: [ev(1)] } }, { hash: '#debug' });
    assert(/Debug journal/.test(en.q('[data-slot="debug"]').textContent) && /Recording/.test(en.q('[data-slot="debug-recording"]').textContent) && /1 kept · 0 dropped · 0 expired/.test(en.q('[data-slot="debug-counts"]').textContent) && /Background/.test(en.q('[data-slot="debug-event"]').textContent), 'R20o: the English page renders the journal in English');
    await en.unmount();
  }

  console.log(`\nИТОГИ: ${passed}/${passed + failed} пройдено (${failed} ошибок).`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Ошибка в тестовом сценарии:', err);
  process.exit(1);
});
