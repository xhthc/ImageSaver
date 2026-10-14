// Rendering tests of the real extension pages (React, shadcn/ui and Radix UI).
// bundled from ui/src and run in a jsdom window with the real lib/feedback.js and lib/folder_path.js and a mocked Chrome.
// Needs the UI dev dependencies:  npm ci --prefix ui   (jsdom, vite, react). Exit code 3 means they are missing.
// Evidence boundary: jsdom - roles, names, states, events and text are checked; there is no layout, no real focus ring or
// contrast rendering, no real clipboard, tabs, popup or Chromium. It is NOT an extension-popup test.
const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const ROOT = REPO_ROOT;
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
        if (msg.action === 'DOWNLOADS_LIST' && state.downloadGates?.length && (await state.downloadGates.shift()) === 'fail') throw new Error('MESSAGING_DOWN');
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
          if (state.guideGate && defaults && 'firstRunGuideDismissed' in defaults) await state.guideGate;
          const captured = { ...(defaults || {}), ...state.local };
          if (state.getGate) await state.getGate;
          return captured;
        },
        set: async (v) => {
          if (state.setGate) await state.setGate;
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
  const consoleErrors = [];
  const logError = win.console.error.bind(win.console);
  win.console.error = (...args) => { consoleErrors.push(args.join(' ')); logError(...args); };
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
  const p = { win, doc, U, state, calls, closed, scrolled, consoleErrors, chrome, root };
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
    {
      const stages=await page('quick',{session:[],history:[],local:{},jobs:[{id:'job-check',filename:'a.png',state:'validating',received:2048,total:2048},{id:'job-export',filename:'b.png',state:'exporting',received:2048,total:2048},{id:'job-wait',filename:'c.png',state:'queued',received:0,total:null},{id:'job-done',filename:'d.png',state:'complete',received:2048,total:2048}]});
      const bar=(id)=>stages.q(`[data-job="${id}"] progress`);
      assert(bar('job-check') && !bar('job-check').hasAttribute('value') && bar('job-export') && !bar('job-export').hasAttribute('value') && !bar('job-wait') && !bar('job-done'),'manager-render-9b: received bytes never draw a full bar before the save is confirmed; queued and finished jobs have no bar');
      await stages.unmount();
    }
    for(const lang of ['en','ru'])for(const kind of ['quick','full']) {
      const jobs=[{id:'browser-saved',filename:'photo.png',state:'complete',location:'browser'},{id:'directory-saved',filename:'clip.mp4',state:'complete',location:'directory'}];
      const state={session:[],history:[],jobs,local:{uiLanguage:lang,saveDirectoryId:'directory-saved'}};
      const p=await page(kind,state,{hash:'#downloads'});
      assert(p.qa('[data-job]').length===2 && !p.q('button[aria-label="Show file location"]') && !p.q('button[aria-label="Показать расположение файла"]'),'location-rollback: existing completed browser/directory cards remain without folder actions in '+kind+' '+lang);
      assert(p.qa('[data-job] button').length===(kind==='quick'?0:2),'popup-bulk-clear: completed cards have no per-file trash in popup; full manager retains it in '+lang);
      await p.unmount();
      if(kind==='full'){
        const saving=await page(kind,state,{hash:'#saving'});
        assert(saving.text().includes(lang==='ru'?'Выбрать папку':'Choose folder') && !/Explorer|Проводник|testid/.test(saving.text()),'location-rollback: choose-folder saving remains without helper setup in '+lang);
        await saving.unmount();
      }
    }
  }


    for(const lang of ['en','ru'])for(const theme of ['blue','dark','light','violet'])for(const kind of ['quick','full']){
      const failed=unnamedFailure(), state={session:[failed],history:[],local:{uiLanguage:lang,uiTheme:theme},failRemoval:true};
      const p=await page(kind,state,{hash:'#downloads'});
      const label=kind==='quick'?(lang==='ru'?'Очистить завершённые записи (файлы и статистика останутся)':'Clear finished records (files and statistics stay)'):(lang==='ru'?'Удалить запись':'Remove record');
      const remove=p.q('button[aria-label="'+label+'"]');
      assert(remove,'unmanaged-dismiss: supported removal is labelled in '+kind+' '+lang+' '+theme);
      if(kind==='quick')assert(!p.q('[data-job] button'),'popup-bulk-clear: failed feedback-only cards have no individual trash');
      assert(!p.q('button[aria-label="'+(lang==='ru'?'Повторить загрузку':'Retry download')+'"]'),'unmanaged-dismiss: no unproven retry');
      if(remove){await p.click(remove);assert(p.qa('[data-job]').length===1 && p.q('[role="alert"]'),'unmanaged-dismiss: persistence failure retains card with error');state.failRemoval=false;await p.click(remove);assert(p.qa('[data-job]').length===0,'unmanaged-dismiss: selected terminal card removed');}
      await p.unmount();
      const reopened=await page(kind,state,{hash:'#downloads'});assert(reopened.qa('[data-job]').length===0,'unmanaged-dismiss: no card on reopen');await reopened.unmount();
    }

    for(const lang of ['en','ru']){
      const state={session:[],history:[rec()],local:{uiLanguage:lang},jobs:[
        {id:'active',filename:'active.mp4',state:'receiving',received:100,total:1000},
        {id:'saved',filename:'saved.jpg',state:'complete',received:1000,total:1000},
        {id:'cancelled',filename:'cancelled.mp4',state:'cancelled',received:100,total:1000},
        {id:'retryable',filename:'retryable.jpg',state:'failed',received:1000,total:1000,ready:true,error:'EXPORT_FAILED'}
      ]};
      const p=await page('quick',state),clear=p.q('button[aria-label="'+(lang==='ru'?'Очистить завершённые записи (файлы и статистика останутся)':'Clear finished records (files and statistics stay)')+'"]');
      assert(p.qa('svg.lucide-trash-2').length===1 && !p.q('[data-job] svg.lucide-trash-2'),'popup-bulk-clear: only global trash remains across terminal and active states in '+lang);
      assert(p.q('[data-job="active"] button[aria-label="'+(lang==='ru'?'Отменить загрузку':'Cancel download')+'"]') && p.q('[data-job="retryable"] button[aria-label="'+(lang==='ru'?'Сохранить готовый файл снова':'Save prepared file again')+'"]'),'popup-bulk-clear: active cancellation and supported prepared-file retry stay reachable in '+lang);
      await p.click(clear);
      assert(p.qa('[data-job]').length===1 && p.q('[data-job="active"]') && clear.disabled && state.history.length===1,'popup-bulk-clear: global clear removes only terminal records, retains active job/statistics and disables when none remain in '+lang);
      await p.unmount();
      const reopened=await page('quick',state);
      assert(reopened.qa('[data-job]').length===1 && reopened.q('[data-job="active"]'),'popup-bulk-clear: reopening retains active job without cleared cards in '+lang);
      await reopened.unmount();
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
    assert(p.calls.localSets.length === 1 && saved.subfolder === 'My/Pics' && saved.folderOrganizationMode === 'by_site_and_type' && saved.saveDirectoryId === '' && saved.xAuthorFolders === false && saved.redditAuthorFolders === false && saved.pixivAuthorFolders === false && !('askEveryTime' in saved) && Object.keys(saved).length === 10, 'R7g: explicit Save writes the ten Saving/Embed keys, sanitized');
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

    const trigger=p.q('#authorFoldersTrigger');
    assert(trigger && p.q('label[for="authorFoldersTrigger"]') && trigger.getAttribute('aria-haspopup')==='menu','R7author1: author folders are one labelled menu button');
    const writes=p.calls.localSets.length;
    await p.key(trigger,'Enter');
    await p.click(p.q('[data-service="xAuthorFolders"]'));
    assert(p.calls.localSets.length===writes && p.q('#folderPreviewPath').textContent.includes('x/username/pic/'),'R7author2: author choice is a draft reflected in the preview');
    await p.key(p.q('[role="menu"]'),'Escape');
    await p.click(p.q('#saveButton'));assert(state.local.xAuthorFolders===true,'R7author3: explicit Save persists author choice');

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
    const helps = p.qa('[data-slot="embed"] [data-slot="collapsible-trigger"]');
    assert(helps.length === 4 && helps.every((h, i) => h.getAttribute('aria-expanded') === 'false' && h.getAttribute('aria-label').includes(p.q('label[for="' + ids[i] + '"]').textContent)) && /Копировать ссылку/.test(p.q('[data-slot="embed"]').textContent) && /сторонние сервисы/.test(p.q('[data-slot="embed"]').textContent) && p.q('#settingsSaveBar'), 'R7s: each platform has labelled collapsed help; third-party/scope note and explicit save remain visible');
    await p.click(helps[0]);
    assert(helps[0].getAttribute('aria-expanded') === 'true' && p.q('#xShareHostSelectHint').textContent.includes('cunnyx.com') && !p.q('#ttShareHostSelectHint') && p.q('#xShareHostSelect').getAttribute('aria-describedby') === 'xShareHostSelectHint', 'R7s1: X help explains only its services and describes the associated select');
    await p.click(helps[2]);
    assert(helps[0].getAttribute('aria-expanded') === 'false' && helps[2].getAttribute('aria-expanded') === 'true' && !p.q('#xShareHostSelectHint') && /не скачивание MP4/.test(p.q('#ttShareHostSelectHint').textContent), 'R7s2: opening TikTok closes other help and retains its direct-embed explanation');
    await p.click(helps[2]);
    assert(helps.every(h => h.getAttribute('aria-expanded') === 'false') && !p.q('#ttShareHostSelectHint') && !p.q('#xShareHostSelect').hasAttribute('aria-describedby'), 'R7s3: per-platform details close cleanly without a dangling description');
    const beforeEmbedChange = p.calls.localSets.length;
    await p.key(p.q('#xShareHostSelect'), 'Enter');
    await p.settle(6);
    const options = p.qa('[role="option"]');
    assert(options.length === 3 && options.map((o) => o.textContent).join('|') === 'fixupx.com (по умолчанию)|x.com (оригинал)|cunnyx.com (резерв)', 'R7t: preview default first, optional original and backup remain available');
    await p.key(options[1], 'Enter');
    await p.settle(6);
    assert(p.q('#xShareHostSelect').textContent === 'x.com', 'R7u: the original is an explicit selectable option');
    assert(p.calls.localSets.length === beforeEmbedChange && p.q('#settingsSaveBar').getAttribute('data-state') === 'dirty', 'R7u1: selecting a service stays a draft until explicit Save');
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
    const failRec = rec({ state: 'failed', site: 'x', filename: 'clip <img src=x onerror=1> & co.mp4', filenameKind: 'intended', output: { type: 'video', ext: '.mp4', evidence: 'filename_hint' }, failure: failure('download', 'download_interrupted', { downloadError: 'NETWORK_FAILED' }) });
    const state = { session: [rec({ filename: 'Фото.jpg' }), failRec], history: [rec({ filename: 'old-entry.jpg' })], local: { historyEnabled: true } };

    const full = await page('full', state, { hash: '#saving' });
    assert(tabNames(full) === 'Загрузки|Статистика|Сохранение|Уведомления|Embed|Обновления|Отладка' && full.doc.documentElement.lang === 'ru' && full.doc.title === 'MediaLatch: загрузки и настройки', 'R13a: a Russian browser with no saved choice shows the Russian page (lang and title follow)');
    const langBox = full.q('#languageSelect');
    assert(langBox && langBox.getAttribute('role') === 'combobox' && full.q('label[for="languageSelect"]').textContent === 'Язык' && /Русский/.test(langBox.textContent), 'R13b: the language choice is a labelled combobox showing the current language');
    const quick = await page('quick', state);
    assert(quick.q('#openSettingsButton').getAttribute('aria-label') === 'Настройки' && quick.doc.documentElement.lang === 'ru', 'R13c: the compact popup opens in the same language');
    assert(full.q('label[for="authorFoldersTrigger"]').textContent === 'Папки авторов' && full.q('#authorFoldersHint').textContent.includes('x.com') && full.q('label[for="xShareHostSelect"]').textContent === 'x.com', 'R13c-labels: Russian author-folder and link-preview settings display x.com');

    const trackMotion = (p) => {
      const animations = [], listeners = new Set();
      const media = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
      p.win.matchMedia = () => media;
      p.win.HTMLElement.prototype.animate = function () {
        const a = { target: this, cancelled: false, cancel() { this.cancelled = true; } };
        animations.push(a);
        return a;
      };
      return { animations, listeners, reduce() { media.matches = true; for (const fn of listeners) fn(); } };
    };
    const fullMotion = trackMotion(full), quickMotion = trackMotion(quick);

    // an unsaved edit survives en -> ru -> en; only the language is written
    await full.type(full.q('#subfolderInput'), 'Unsaved/Edit');
    const setsBefore = full.calls.localSets.length;
    assert(await chooseLanguage(full, 'English'), 'R13d: setup - English is offered by its own name');
    assert(tabNames(full) === 'Downloads|Statistics|Saving|Notifications|Embed|Updates|Debug' && full.doc.documentElement.lang === 'en' && full.doc.title === 'MediaLatch: downloads and settings', 'R13e: ru -> en switches the open page at once (tabs, lang, title)');
    assert(full.q('#subfolderInput').value === 'Unsaved/Edit' && full.q('#folderPreviewPath').textContent === 'Downloads/Unsaved/Edit/photo.jpg' && JSON.stringify(full.calls.localSets.slice(setsBefore)) === JSON.stringify([{ uiLanguage: 'en' }]), 'R13f: the unsaved folder edit is kept and only uiLanguage is written');
    assert(/Save settings/.test(full.q('#saveButton').textContent) && /“MediaLatch: Save media”/.test(full.text()) && full.q('label[for="languageSelect"]').textContent === 'Language', 'R13g: buttons, labels and the fixed menu title follow');
    assert(full.q('label[for="authorFoldersTrigger"]').textContent === 'Author folders' && full.q('#authorFoldersHint').textContent.includes('x.com') && full.q('label[for="xShareHostSelect"]').textContent === 'x.com', 'R13g-labels: English author-folder and link-preview labels display x.com');
    await quick.settle(6);
    assert(quick.q('#openSettingsButton').getAttribute('aria-label') === 'Settings' && quick.doc.documentElement.lang === 'en' && /Saved/.test(quick.qa('[data-job]')[1].textContent), 'R13h: the open compact popup follows the change made on the full page (rows and accessible names)');
    assert(full.qa('[data-slot="result-item"]').some((row) => row.textContent.includes('x.com')), 'R13h-labels: the loaded manager result card displays x.com for a stored x record');
    assert(quick.qa('[data-job]')[0].textContent.includes('clip <img src=x onerror=1> & co.mp4') && quick.doc.querySelectorAll('img').length === 0, 'R13i: an original file name is shown as text in every language, never as markup');
    assert(await chooseLanguage(full, 'Русский') && tabNames(full).startsWith('Загрузки') && full.q('#subfolderInput').value === 'Unsaved/Edit', 'R13j: en -> ru keeps the edit');
    assert(await chooseLanguage(full, 'English') && tabNames(full).startsWith('Downloads') && full.q('#subfolderInput').value === 'Unsaved/Edit' && state.local.uiLanguage === 'en' && state.local.subfolder === undefined, 'R13k: ru -> en again; the folder edit is still unsaved');
    await quick.settle(6);
    assert(fullMotion.animations.length === 3 && quickMotion.animations.length === 3 && fullMotion.animations.every((a) => a.target === full.q('[data-popup]')), 'R13k-motion: each committed switch animates both mounted pages once; storage echoes do not restart it');
    fullMotion.reduce();
    assert(fullMotion.animations.every((a) => a.cancelled), 'R13k-reduce: replacing the language cancels old effects; enabling reduced motion stops the current effect');
    await full.mousedown(full.tabs()[1]);
    assert(/Statistics/.test(full.text()) && /Record statistics/.test(full.text()) && !/Save history/.test(full.text()), 'R13l: statistics, history and results are English');
    const failRow = full.qa('[data-slot="results-section"] [data-slot="result-item"]').find((r) => r.getAttribute('data-state-kind') === 'failed');
    await full.click(failRow.querySelector('button'));
    assert(/Download interrupted/.test(failRow.textContent) && /Chrome code: NETWORK_FAILED/.test(failRow.textContent) && /Copy report/.test(failRow.textContent) && /MediaLatch bug report/.test(failRow.querySelector('textarea[readonly]').value), 'R13m: an older record is shown in English; diagnostic codes and the report format stay intact');

    // close / reopen: the saved choice is read again
    await quick.unmount();
    await full.unmount();
    assert(quickMotion.animations.every((a) => a.cancelled) && !quickMotion.listeners.size && !fullMotion.listeners.size, 'R13n-cleanup: closing pages cancels effects and releases preference listeners');
    const reopened = await page('full', state);
    assert(tabNames(reopened).startsWith('Downloads') && reopened.doc.documentElement.lang === 'en', 'R13n: a reopened page uses the saved English choice over the Russian browser');

    // a failed write keeps the language and says so
    state.failSet = true;
    const failedMotion = trackMotion(reopened);
    await chooseLanguage(reopened, 'Русский');
    assert(tabNames(reopened).startsWith('Downloads') && state.local.uiLanguage === 'en' && /Could not save the language/.test(reopened.q('[data-slot="language-status"]').textContent), 'R13o: a failed write keeps English and reports the failure (no success state)');
    assert(failedMotion.animations.length === 0, 'R13o-motion: a failed language write has no success transition');
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

  // =================================================================================================
  console.log('\n--- R21. FIRST-RUN-SETUP-01 / UI-COMPLETION-01: install-only welcome with one Continue ---');
  {
    const KEY = 'firstRunGuideDismissed';
    const T = {
      en: { title: 'Quick start', cont: 'Continue', menu: '“MediaLatch: Save media”', failSave: /Could not remember that the guide is closed/ },
      ru: { title: 'Быстрый старт', cont: 'Продолжить', menu: '«MediaLatch: Save media»', failSave: /Не удалось запомнить, что руководство закрыто/ },
    };
    const guide = (p) => p.q('section#onboarding');
    const main = (p) => p.q('[data-slot="main"]');
    const btn = (p, label, from) => p.qa('button', from || p.doc).find((b) => b.textContent.trim() === label);
    const selected = (p) => p.tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.getAttribute('data-section');
    const activePanel = (p) => p.q('[role="tabpanel"][data-state="active"]');
    // no tutorial entry anywhere on the normal page: no Quick start/Help button and no welcome text
    const noTutorialEntry = (p) => !p.q('#onboardingHelp') && !p.qa('button').some((b) => /Quick start|Быстрый старт|Skip|Пропустить/.test(b.textContent));
    {
      const p = await page('full', { session: [], history: [], local: { uiLanguage: 'en' } });
      assert(!p.consoleErrors.some((m) => /getSnapshot/.test(m)), 'R21C: the initial mounted snapshot has no getSnapshot caching warning');
      await p.unmount();
    }
    for (const lang of ['en', 'ru']) for (const theme of ['violet', 'blue', 'dark', 'light']) {
      const tx = T[lang];
      const p = await page('full', { session: [], history: [], local: { uiLanguage: lang, uiTheme: theme } }, { search: '?welcome=1' });
      const g = guide(p);
      assert(g && p.doc.documentElement.dataset.theme === theme, `R21a ${lang}/${theme}: the install URL shows the welcome screen in the saved theme`);
      assert(g && main(p).hidden && main(p).contains(p.q('[role="tablist"]')) && main(p).contains(p.q('#subfolderInput')) && !g.contains(p.q('[role="tablist"]')), `R21b ${lang}/${theme}: tabs, panels, Save bar and footer are mounted but hidden`);
      assert(g && p.q('#onboardingTitle').textContent === tx.title && p.qa('ol[aria-label] > li', g).length === 3 && g.textContent.includes(tx.menu) && !/Explorer|Проводник|helper|native/i.test(g.textContent), `R21c ${lang}/${theme}: three steps naming the real menu item`);
      assert(g && p.qa('button', g).map((b) => b.textContent.trim()).join('|') === tx.cont, `R21d ${lang}/${theme}: exactly one action, Continue; no Skip or jump buttons`);
      assert(p.q('#themeSelect') && p.q('#languageSelect') && noTutorialEntry(p), `R21e ${lang}/${theme}: theme and language stay available; no tutorial entry in the header`);
      assert(p.calls.localSets.length === 0 && p.calls.tabsCreate.length === 0 && p.calls.messages.every((m) => m !== 'DOWNLOADS_COMMAND'), `R21f ${lang}/${theme}: showing the welcome writes nothing and starts nothing`);
      await p.unmount();
    }

    // loading: the main interface is not flashed while the marker read is pending
    {
      let release;
      const state = { session: [], history: [], local: { uiLanguage: 'en' }, guideGate: new Promise((r) => { release = r; }) };
      const p = await page('full', state, { search: '?welcome=1' });
      assert(!guide(p) && main(p).hidden && p.q('[data-slot="welcome-loading"]')?.getAttribute('role') === 'status', 'R21g: while the marker is read only a loading status is shown');
      release();
      await p.settle(6);
      assert(guide(p) && !p.q('[data-slot="welcome-loading"]'), 'R21h: the welcome screen follows the read');
      await p.unmount();
      let release2;
      const done = { session: [], history: [], local: { uiLanguage: 'en', [KEY]: true }, guideGate: new Promise((r) => { release2 = r; }) };
      const q = await page('full', done, { search: '?welcome=1' });
      assert(main(q).hidden, 'R21i: an acknowledged profile also waits for the read');
      release2();
      await q.settle(6);
      assert(!guide(q) && !main(q).hidden && noTutorialEntry(q) && done.local[KEY] === true, 'R21j: a completed install reveals the normal page with no tutorial entry; the marker stays true');
      await q.unmount();
    }

    // ordinary pages, existing/completed profiles and the popup: no welcome, no tutorial entry, deep links unchanged
    for (const lang of ['en', 'ru']) for (const local of [{ uiLanguage: lang }, { uiLanguage: lang, [KEY]: true }]) {
      const p = await page('full', { session: [], history: [], local }, { hash: '#downloads' });
      assert(!guide(p) && !main(p).hidden && selected(p) === 'downloads' && noTutorialEntry(p) && p.calls.localSets.length === 0, `R21k ${lang}/${KEY in local ? 'completed' : 'existing'}: no automatic welcome or tutorial entry; deep link intact; nothing written`);
      await p.unmount();
    }
    const quick = await page('quick', { session: [], history: [], local: { uiLanguage: 'en' } }, { search: '?welcome=1' });
    assert(!quick.q('section#onboarding') && noTutorialEntry(quick) && quick.q('#openSettingsButton'), 'R21l: the compact popup is unchanged');
    await quick.unmount();

    // Continue writes only the marker, then reveals Saving and focuses its panel
    for (const lang of ['en', 'ru']) {
      const state = { session: [], history: [], local: { uiLanguage: lang, uiTheme: 'blue', subfolder: 'Kept' } };
      const p = await page('full', state, { search: '?welcome=1', hash: '#downloads' });
      await p.click(btn(p, T[lang].cont));
      assert(!guide(p) && !main(p).hidden && selected(p) === 'saving' && p.doc.activeElement === activePanel(p) && activePanel(p).contains(p.q('#subfolderInput')), `R21m ${lang}: Continue reveals Saving and focuses its panel`);
      assert(JSON.stringify(p.calls.localSets) === JSON.stringify([{ [KEY]: true }]) && state.local.uiTheme === 'blue' && state.local.subfolder === 'Kept' && noTutorialEntry(p), `R21n ${lang}: only the dedicated marker is written; no tutorial entry afterwards`);
      await p.unmount();
      const again = await page('full', state, { search: '?welcome=1' });
      assert(!guide(again) && !main(again).hidden, `R21o ${lang}: the welcome stays closed after a reload`);
      await again.unmount();
    }
    {
      const open = { session: [], history: [], local: { uiLanguage: 'en' } };
      const unfinished = await page('full', open, { search: '?welcome=1' });
      await unfinished.unmount();
      const reload = await page('full', open, { search: '?welcome=1' });
      assert(guide(reload) && !(KEY in open.local), 'R21p: closing the tab without Continue keeps the welcome for the next load');
      await reload.unmount();
    }

    // write/read failures keep the welcome screen with a visible error; the retry works and only then reveals Saving
    {
      const state = { session: [], history: [], local: { uiLanguage: 'en' }, failSet: true };
      const p = await page('full', state, { search: '?welcome=1' });
      await p.click(btn(p, 'Continue'));
      assert(guide(p) && main(p).hidden && T.en.failSave.test(p.q('[data-slot="onboarding-error"]').textContent) && !(KEY in state.local), 'R21q: a failed write keeps the welcome screen and the main interface hidden');
      assert(p.qa('button', guide(p)).every((b) => !b.disabled), 'R21r: Continue is enabled again for a retry');
      state.failSet = false;
      await p.click(btn(p, 'Continue'));
      assert(!guide(p) && state.local[KEY] === true && selected(p) === 'saving' && p.doc.activeElement === activePanel(p), 'R21s: the retry succeeds and reveals Saving');
      await p.unmount();
      const ru = await page('full', { session: [], history: [], local: { uiLanguage: 'ru' }, failSet: true }, { search: '?welcome=1' });
      await ru.click(btn(ru, 'Продолжить'));
      assert(T.ru.failSave.test(ru.q('[data-slot="onboarding-error"]').textContent), 'R21t: the failure is explained in Russian');
      await ru.unmount();
      const unreadable = await page('full', { session: [], history: [], local: { uiLanguage: 'en' }, failGet: true }, { search: '?welcome=1' });
      assert(guide(unreadable) && /Could not check whether this guide|Не удалось проверить/.test(unreadable.q('[data-slot="onboarding-error"]')?.textContent || ''), 'R21u: an unreadable marker leaves the welcome open with a visible error');
      await unreadable.unmount();
    }

    // language switch keeps the welcome and the mounted draft
    {
      const p = await page('full', { session: [], history: [], local: { uiLanguage: 'en' } }, { search: '?welcome=1' });
      const input = p.q('#subfolderInput');
      await p.type(input, 'Draft folder');
      await p.language.setLanguage('ru');
      await p.settle(6);
      assert(guide(p).textContent.includes(T.ru.menu) && p.q('#subfolderInput') === input && input.value === 'Draft folder', 'R21w: a language switch keeps the welcome and the mounted draft');
      await p.unmount();
    }

    // hidden Downloads does not acknowledge failures behind the welcome screen, nor while Saving is shown after Continue
    {
      const state = { session: [unnamedFailure()], history: [], local: { uiLanguage: 'en' } };
      const p = await page('full', state, { search: '?welcome=1', hash: '#downloads' });
      const acks = () => p.calls.messages.filter((m) => m === 'FEEDBACK_MARK_SEEN').length;
      assert(acks() === 0, 'R21D: an install welcome over a Downloads deep link acknowledges nothing');
      state.session.push(unnamedFailure());
      for (const cb of state.changeListeners || []) cb({ imageSaverFeedbackV1: { newValue: {} } }, 'session');
      await p.settle(8);
      assert(acks() === 0, 'R21A: a failure arriving behind the welcome screen is not acknowledged');
      await p.click(btn(p, 'Continue'));
      await p.settle(8);
      assert(acks() === 0 && selected(p) === 'saving', 'R21E: Continue shows Saving; Downloads stays unacknowledged');
      await p.mousedown(p.q('[role="tab"][data-section="downloads"]'));
      await p.settle(8);
      assert(acks() === 1, 'R21B: failures are acknowledged once Downloads is actually shown');
      await p.unmount();
    }
  }

  // =================================================================================================
  console.log('\n--- R22. UI-COMPLETION-01: settings lifecycle states ---');
  const btn22 = (p, label, from) => p.qa('button', from).find((b) => b.textContent.trim() === label);
  for (const lang of ['en', 'ru']) {
    const L = lang === 'en'
      ? { unsaved: 'Unsaved changes', failed: 'Could not save the settings', load: 'Could not load the settings', retry: 'Try again' }
      : { unsaved: 'Есть несохранённые изменения', failed: 'Не удалось сохранить настройки', load: 'Ошибка загрузки настроек', retry: 'Повторить' };
    const state = { session: [], history: [], local: { uiLanguage: lang, subfolder: 'Stored' } };
    const p = await page('full', state, { hash: '#saving' });
    const status = () => p.q('#statusMessage');
    assert(status().getAttribute('data-type') === '' && status().textContent === '', `R22a ${lang}: a freshly loaded form shows no status`);
    await p.type(p.q('#subfolderInput'), 'Changed');
    assert(status().getAttribute('data-type') === 'dirty' && status().textContent.includes(L.unsaved), `R22b ${lang}: an edit is shown as unsaved`);
    await p.type(p.q('#subfolderInput'), 'Stored');
    assert(status().getAttribute('data-type') === '', `R22c ${lang}: returning to the stored value clears the unsaved mark`);
    await p.mousedown(p.q('[role="tab"][data-section="embed"]'));
    await p.type(p.q('#subfolderInput'), 'Changed');
    assert(p.q('#settingsSaveBar') && status().getAttribute('data-type') === 'dirty', `R22d ${lang}: the unsaved mark is visible on the Embed tab too`);
    state.failSet = true;
    await p.click(p.q('#saveButton'));
    assert(status().getAttribute('data-type') === 'error' && status().textContent.includes(L.failed) && !p.q('#saveButton').disabled && state.local.subfolder === 'Stored', `R22e ${lang}: a failed save shows a lasting error and keeps the draft unsaved`);
    state.failSet = false;
    await p.click(p.q('#saveButton'));
    assert(status().getAttribute('data-type') === 'success' && state.local.subfolder === 'Changed', `R22f ${lang}: the retry saves and reports success`);
    await p.unmount();

    const broken = { session: [], history: [], uiLanguage: lang, local: { uiLanguage: lang, subfolder: 'Mine' }, failGet: true };
    const b = await page('full', broken, { hash: '#saving' });
    const alerts = () => b.qa('[data-slot="settings-load-error"]');
    assert(alerts().length === 2 && alerts()[0].textContent.includes(lang === 'en' ? L.load : 'Ошибка загрузки настроек') && b.q('#subfolderInput').disabled && b.q('#saveButton').disabled, `R22g ${lang}: a failed read is shown in Saving and Embed, the form and Save stay disabled`);
    assert(b.q('#statusMessage').textContent === '', `R22h ${lang}: the Save bar does not repeat the read failure`);
    broken.failGet = false;
    await b.click(btn22(b, L.retry, alerts()[0]));
    assert(alerts().length === 0 && !b.q('#subfolderInput').disabled && b.q('#subfolderInput').value === 'Mine' && b.calls.localSets.every((o) => !('subfolder' in o)), `R22i ${lang}: Retry reads the stored values through the same load, writing nothing`);
    assert(b.doc.activeElement === b.q('[role="tabpanel"][data-state="active"]'), `R22j ${lang}: focus moves to the recovered panel, not the page body`);
    await b.unmount();
  }

  // =================================================================================================
  console.log('\n--- R23. UI-COMPLETION-01: localized download failures and list recovery ---');
  {
    const codes = ['STORAGE_QUOTA', 'AUTH_REQUIRED', 'RATE_LIMIT', 'NETWORK_TIMEOUT', 'HTTP_404', 'INVALID_MEDIA', 'SOURCE_EXPIRED', 'EXPORT_UNCERTAIN', 'DIRECTORY_ACCESS_REQUIRED', 'NEW_UNMAPPED_CODE'];
    const expected = {
      en: { STORAGE_QUOTA: 'Local storage is full', AUTH_REQUIRED: 'Access required', RATE_LIMIT: 'Too many requests', NETWORK_TIMEOUT: 'Network error', HTTP_404: 'File not found', INVALID_MEDIA: 'Invalid content', SOURCE_EXPIRED: 'Source no longer available', EXPORT_UNCERTAIN: 'Save not confirmed', DIRECTORY_ACCESS_REQUIRED: 'Folder unavailable', NEW_UNMAPPED_CODE: 'Reason not determined' },
      ru: { STORAGE_QUOTA: 'Локальное хранилище заполнено', AUTH_REQUIRED: 'Нужен доступ', RATE_LIMIT: 'Слишком много запросов', NETWORK_TIMEOUT: 'Сетевая ошибка', HTTP_404: 'Файл не найден', INVALID_MEDIA: 'Недопустимое содержимое', SOURCE_EXPIRED: 'Источник больше недоступен', EXPORT_UNCERTAIN: 'Сохранение не подтверждено', DIRECTORY_ACCESS_REQUIRED: 'Папка недоступна', NEW_UNMAPPED_CODE: 'Причина не определена' },
    };
    for (const lang of ['en', 'ru']) for (const kind of ['quick', 'full']) {
      const jobs = codes.map((code) => ({ id: 'job-' + code, filename: code.toLowerCase() + '-with-a-rather-long-file-name-to-wrap.mp4', state: 'failed', received: 2048, total: 4096, speed: 0, error: code, ready: code === 'STORAGE_QUOTA' }));
      const p = await page(kind, { session: [], history: [], jobs, local: { uiLanguage: lang } }, kind === 'full' ? { hash: '#downloads' } : {});
      const cards = p.qa('[data-job]');
      const titles = cards.map((c) => c.querySelector('[data-slot="job-error"] p')?.textContent);
      assert(cards.length === codes.length && codes.every((c, i) => titles[i] === expected[lang][c]), `R23a ${kind}/${lang}: every error code has a localized title (${titles.join(' | ')})`);
      assert(cards.every((c, i) => c.querySelector('[data-slot="job-error"]').textContent.includes(codes[i]) && c.querySelector('[data-slot="job-error"] .font-mono')), `R23b ${kind}/${lang}: the technical code stays on its own small line`);
      const quota = cards[0].querySelector('[data-slot="job-error"]').textContent;
      assert(quota.includes(lang === 'en' ? 'Prepared file retained for retry' : 'Готовый файл сохранён для повтора') && (kind === 'full') === quota.includes(lang === 'en' ? 'Free some disk space' : 'Освободите место'), `R23c ${kind}/${lang}: retained bytes are named; the next step appears on the full page only`);
      const uncertain = cards[codes.indexOf('EXPORT_UNCERTAIN')];
      assert(!uncertain.querySelector(`button[aria-label="${lang === 'en' ? 'Retry download' : 'Повторить загрузку'}"]`) && cards[1].querySelector(`button[aria-label="${lang === 'en' ? 'Retry download' : 'Повторить загрузку'}"]`), `R23d ${kind}/${lang}: retry eligibility is unchanged (none for an uncertain export)`);
      await p.unmount();
    }
    // a resolver failure the shared taxonomy leaves uncategorized is explained by its code
    {
      const batch = rec({ state: 'failed', filename: '', filenameKind: '', output: {}, failure: failure('resolve', 'unknown', { code: 'BATCH_LIMIT' }) });
      const p = await page('full', { session: [batch], history: [], local: { uiLanguage: 'en' } }, { hash: '#downloads' });
      assert(p.rows()[0]?.textContent.includes('Too many media in one post'), 'R23e: a batch-limit failure is explained instead of "Reason not determined"');
      await p.unmount();
    }
    // list failure: retained cards, explicit retry, distinct from loading and empty
    for (const kind of ['quick', 'full']) {
      const state = { session: [], history: [], local: { uiLanguage: 'en' }, jobs: [{ id: 'job-live', filename: 'live.mp4', state: 'receiving', received: 1024, total: 4096, speed: 512 }] };
      const p = await page(kind, state, kind === 'full' ? { hash: '#downloads' } : {});
      assert(p.qa('[data-job]').length === 1 && !p.q('[data-slot="downloads-error"]'), `R23f ${kind}: the list loads`);
      state.failMessages = true;
      for (const cb of state.msgListeners || []) cb({ action: 'DOWNLOADS_CHANGED' });
      await p.settle(6);
      const alert = p.q('[data-slot="downloads-error"]');
      assert(alert && alert.textContent.includes('Downloads could not be loaded') && p.qa('[data-job]').length === 1 && p.q('progress[value="1024"]') && !p.q('[data-slot="empty"]'), `R23g ${kind}: a failed refresh keeps the card and its progress and is not shown as empty`);
      const retry = p.qa('button', alert).find((x) => x.textContent.trim() === 'Try again');
      assert(retry && !retry.disabled, `R23h ${kind}: the list error offers Try again`);
      await p.click(retry);
      assert(p.q('[data-slot="downloads-error"]') && p.qa('[data-job]').length === 1, `R23i ${kind}: a failing retry keeps the error and the card`);
      state.failMessages = false;
      state.jobs = [];
      await p.click(p.qa('button', p.q('[data-slot="downloads-error"]')).find((x) => x.textContent.trim() === 'Try again'));
      assert(!p.q('[data-slot="downloads-error"]') && p.q('[data-slot="empty"]'), `R23j ${kind}: a successful retry clears the error and shows the real (empty) list`);
      assert(p.doc.activeElement === p.q('section[aria-label="Downloads"]'), `R23j2 ${kind}: focus moves to the recovered list`);
      await p.unmount();
      const first = await page(kind, { session: [], history: [], local: { uiLanguage: 'en' }, failMessages: true }, kind === 'full' ? { hash: '#downloads' } : {});
      assert(first.q('[data-slot="downloads-error"]') && !first.q('[data-slot="empty"]') && !first.text().includes('Loading downloads'), `R23k ${kind}: a failed first load is an error, not loading or empty`);
      await first.unmount();
    }
  }

  // =================================================================================================
  console.log('\n--- R24. UI-COMPLETION-01 follow-up: truthful save status, overlapping retry, matched failure texts ---');
  for (const lang of ['en', 'ru']) for (const tab of ['saving', 'embed']) {
    const L = lang === 'en' ? { unsaved: 'Unsaved changes', saved: 'Settings saved' } : { unsaved: 'Есть несохранённые изменения', saved: 'Настройки успешно сохранены' };
    const state = { session: [], history: [], local: { uiLanguage: lang, subfolder: 'Stored', xShareHost: 'fixupx.com' } };
    const p = await page('full', state, { hash: '#' + tab });
    const status = () => p.q('#statusMessage');
    // the draft edit for each tab: the folder field on Saving, a share host on Embed (the Radix select writes through setField)
    const edit = async (n) => {
      if (tab === 'saving') await p.type(p.q('#subfolderInput'), 'Folder' + n);
      else { await p.U.act(async () => { p.settings.setField('xShareHost', n % 2 ? 'x.com' : 'cunnyx.com'); }); await p.settle(2); }
    };
    // clean save shows success
    await edit(1);
    await p.click(p.q('#saveButton'));
    assert(status().getAttribute('data-type') === 'success' && status().textContent.includes(L.saved), `R24a ${lang}/${tab}: a clean save still shows success`);
    // sequence 1: save, then edit immediately: unsaved replaces the stale success at once
    await edit(2);
    assert(status().getAttribute('data-type') === 'dirty' && status().textContent.includes(L.unsaved) && !status().textContent.includes(L.saved), `R24b ${lang}/${tab}: an edit right after a successful save shows unsaved changes, not "saved"`);
    // sequence 2: edit during an awaited save: saving while pending, then unsaved (not "saved") once it completes
    let release;
    state.setGate = new Promise((r) => { release = r; });
    await p.click(p.q('#saveButton'));
    assert(status().getAttribute('data-type') === 'saving', `R24c ${lang}/${tab}: the awaited write shows saving`);
    await edit(3);
    assert(status().getAttribute('data-type') === 'saving', `R24d ${lang}/${tab}: saving keeps precedence while the write is pending`);
    release(); state.setGate = null;
    await p.settle(6);
    assert(status().getAttribute('data-type') === 'dirty' && status().textContent.includes(L.unsaved), `R24e ${lang}/${tab}: after the awaited save the edit made meanwhile is shown as unsaved`);
    // a failure keeps precedence over the unsaved mark
    state.failSet = true;
    await p.click(p.q('#saveButton'));
    assert(status().getAttribute('data-type') === 'error', `R24f ${lang}/${tab}: a failed save shows its error, not just unsaved`);
    state.failSet = false;
    await p.click(p.q('#saveButton'));
    assert(status().getAttribute('data-type') === 'success', `R24g ${lang}/${tab}: the clean retry shows success again`);
    await p.unmount();
  }

  // overlapping list refresh: all four older-automatic -> queued-retry outcomes. Retry stays the same focused, busy control until its
  // own read finished; failure leaves it focused and usable, success hands focus to the recovered list; cards are retained throughout
  for (const kind of ['quick', 'full']) for (const auto of ['ok', 'fail']) for (const queued of ['ok', 'fail']) {
    const tag = `${kind}/auto-${auto}/queued-${queued}`;
    const state = { session: [], history: [], local: { uiLanguage: 'en' }, jobs: [{ id: 'job-live', filename: 'live.mp4', state: 'receiving', received: 1024, total: 4096, speed: 512 }] };
    const p = await page(kind, state, kind === 'full' ? { hash: '#downloads' } : {});
    const fire = () => { for (const cb of state.msgListeners || []) cb({ action: 'DOWNLOADS_CHANGED' }); };
    const reads = () => p.calls.messages.filter((m) => m === 'DOWNLOADS_LIST').length;
    const alertBox = () => p.q('[data-slot="downloads-error"]');
    const retryBtn = () => alertBox() && p.qa('button', alertBox()).find((x) => x.textContent.trim() === 'Try again');
    // the list becomes unavailable
    state.downloadGates = [Promise.resolve('fail')];
    fire();
    await p.settle(6);
    assert(retryBtn() && p.qa('[data-job]').length === 1, `R24h ${tag}: the list error offers Try again and keeps the card`);
    // an automatic refresh is in flight when the user activates Retry from the keyboard; both reads are held
    let finishAuto, finishQueued;
    state.downloadGates = [new Promise((r) => { finishAuto = r; }), new Promise((r) => { finishQueued = r; })];
    fire();
    await p.settle(2);
    const button = retryBtn();
    button.focus();
    await p.key(button, 'Enter');
    await p.click(button); // a native button activates on Enter with a click event
    assert(p.doc.activeElement === button && button.getAttribute('aria-disabled') === 'true' && !button.disabled, `R24i ${tag}: while the automatic refresh is pending Retry is busy but keeps focus`);
    const readsBusy = reads();
    await p.click(button);
    await p.settle(2);
    assert(reads() === readsBusy, `R24i2 ${tag}: activating the busy Retry again requests nothing more`);
    // the older automatic read finishes first
    finishAuto(auto);
    await p.settle(8);
    assert(retryBtn() === button && p.doc.activeElement === button && button.getAttribute('aria-disabled') === 'true' && p.qa('[data-job]').length === 1, `R24p ${tag}: after the automatic read the same Retry is still busy and focused; the card stays`);
    if (auto === 'ok') assert(alertBox() && !alertBox().textContent.includes('Downloads could not be loaded') && alertBox().textContent.includes('Loading downloads'), `R24q ${tag}: a successful background read is not presented as a failure while the retry is pending`);
    // then the queued user retry finishes
    finishQueued(queued);
    await p.settle(8);
    if (queued === 'ok') {
      assert(!alertBox() && p.doc.activeElement === p.q('section[aria-label="Downloads"]') && p.qa('[data-job]').length === 1, `R24j ${tag}: once the queued read succeeds, focus moves to the recovered list and the card stays`);
    } else {
      assert(retryBtn() === button && p.doc.activeElement === button && button.getAttribute('aria-disabled') === 'false' && alertBox()?.textContent.includes('Downloads could not be loaded') && p.qa('[data-job]').length === 1, `R24k ${tag}: a failed recovery leaves the same Retry focused and usable, the failure visible and the card in place`);
    }
    assert(reads() === readsBusy + 1, `R24l ${tag}: exactly one read was requested by the retry, after the automatic one`);
    await p.unmount();
  }

  // matched job + feedback record: the row, the expanded details and the manager card explain the same code
  for (const lang of ['en', 'ru']) for (const [code, title] of [['STORAGE_QUOTA', lang === 'en' ? 'Local storage is full' : 'Локальное хранилище заполнено'], ['PREPARED_FILE_MISSING', lang === 'en' ? 'Prepared file is gone' : 'Готовый файл недоступен']]) {
    const record = rec({ state: 'failed', filename: 'clip.mp4', filenameKind: 'intended', output: { type: 'video', ext: '.mp4', evidence: 'filename_hint' }, failure: failure('download', 'download_interrupted', { code }) });
    const jobs = [{ id: 'job-match', op: record.id, filename: 'clip.mp4', state: 'failed', received: 2048, total: 4096, speed: 0, error: code, ready: false }];
    const p = await page('full', { session: [record], history: [], jobs, local: { uiLanguage: lang } }, { search: '?op=' + record.id, hash: '#downloads' });
    const row = p.rows()[0];
    const details = p.q('[data-slot="result-details"]');
    const contradict = lang === 'en' ? /Chrome stopped downloading/ : /Chrome остановил загрузку/;
    assert(row && row.querySelector('[data-slot="job-error"] p').textContent === title, `R24m ${lang}/${code}: the manager card explains the code`);
    assert(details && details.querySelector('[data-slot="title"]').textContent.includes(title) && !contradict.test(details.textContent), `R24n ${lang}/${code}: the expanded details say the same, without the generic Chrome interruption text`);
    assert(details.textContent.includes(code), `R24o ${lang}/${code}: the recorded code stays visible as evidence`);
    await p.unmount();
  }

  // =================================================================================================
  console.log('\n--- R25. PIXIV-SAVING-POLISH-01: author-folder service menu ---');
  {
    const L = { en: { label: 'Author folders', off: 'Off' }, ru: { label: 'Папки авторов', off: 'Выкл.' } };
    const menu = (p) => p.q('[role="menu"]');
    const item = (p, key) => p.q(`[data-service="${key}"]`);
    const summary = (p) => p.q('#authorFoldersSummary').textContent;
    for (const lang of ['en', 'ru']) for (const theme of ['violet', 'blue', 'dark', 'light']) {
      const p = await page('full', { session: [], history: [], local: { uiLanguage: lang, uiTheme: theme } }, { hash: '#saving' });
      const trigger = p.q('#authorFoldersTrigger');
      assert(trigger && trigger.tagName === 'BUTTON' && p.q('label[for="authorFoldersTrigger"]').textContent === L[lang].label && trigger.getAttribute('aria-haspopup') === 'menu' && trigger.getAttribute('aria-expanded') === 'false', `R25a ${lang}/${theme}: one labelled menu button`);
      assert(summary(p) === L[lang].off && !p.q('#xAuthorFolders'), `R25b ${lang}/${theme}: defaults are off and the old switch is gone`);
      await p.unmount();
    }
    // the existing x.com choice survives; Reddit/Pixiv default off
    {
      const p = await page('full', { session: [], history: [], local: { uiLanguage: 'en', xAuthorFolders: true } }, { hash: '#saving' });
      assert(summary(p) === 'x.com' && p.q('#folderPreviewPath').textContent.includes('username/photo.jpg'), 'R25c: a stored x.com choice is shown and kept');
      await p.unmount();
    }
    // keyboard: open, several choices without closing, Escape closes and returns focus; explicit Save; reopen
    {
      const state = { session: [], history: [], local: { uiLanguage: 'en', xAuthorFolders: true, folderOrganizationMode: 'by_site_and_type' } };
      const p = await page('full', state, { hash: '#saving' });
      const trigger = p.q('#authorFoldersTrigger');
      trigger.focus();
      await p.key(trigger, 'Enter');
      assert(menu(p) && trigger.getAttribute('aria-expanded') === 'true', 'R25d: Enter opens the menu');
      const items = p.qa('[role="menuitemcheckbox"]');
      assert(items.map((x) => x.textContent.trim()).join('|') === 'x.com|Reddit|Pixiv' && items.map((x) => x.getAttribute('aria-checked')).join() === 'true,false,false', 'R25e: three labelled checkbox items with their states');
      await p.click(item(p, 'xAuthorFolders'));
      await p.click(item(p, 'redditAuthorFolders'));
      await p.click(item(p, 'pixivAuthorFolders'));
      assert(menu(p) && item(p, 'redditAuthorFolders').getAttribute('aria-checked') === 'true' && item(p, 'pixivAuthorFolders').getAttribute('aria-checked') === 'true' && item(p, 'xAuthorFolders').getAttribute('aria-checked') === 'false', 'R25f: several choices toggle while the menu stays open');
      assert(summary(p) === 'Reddit, Pixiv' && p.q('#folderPreviewPath').textContent.includes('reddit/username/pic/') && p.calls.localSets.length === 0 && p.q('#statusMessage').getAttribute('data-type') === 'dirty', 'R25g: a draft: summary and example follow, nothing is written, unsaved is shown');
      await p.key(menu(p), 'Escape');
      await p.settle(4);
      assert(!menu(p) && p.doc.activeElement === trigger, 'R25h: Escape closes the menu and returns focus to the button');
      state.failSet = true;
      await p.click(p.q('#saveButton'));
      assert(summary(p) === 'Reddit, Pixiv' && state.local.redditAuthorFolders === undefined && p.q('#statusMessage').getAttribute('data-type') === 'error', 'R25i: a failed save keeps the choices as an unsaved draft');
      state.failSet = false;
      await p.click(p.q('#saveButton'));
      assert(state.local.xAuthorFolders === false && state.local.redditAuthorFolders === true && state.local.pixivAuthorFolders === true, 'R25j: explicit Save writes the three choices');
      await p.unmount();
      const again = await page('full', state, { hash: '#saving' });
      assert(summary(again) === 'Reddit, Pixiv', 'R25k: the saved choices are shown after reopening');
      await again.unmount();
    }
    // Pixiv only: the example names the author with its user id; all off: no author folder
    {
      const p = await page('full', { session: [], history: [], local: { uiLanguage: 'ru', pixivAuthorFolders: true, folderOrganizationMode: 'by_site_and_type' } }, { hash: '#saving' });
      assert(p.q('#folderPreviewPath').textContent.includes('pixiv/Автор (12345678)/pic/') && summary(p) === 'Pixiv', 'R25l: a Pixiv-only choice shows the name + id example (RU)');
      await p.key(p.q('#authorFoldersTrigger'), 'Enter');
      await p.key(item(p, 'pixivAuthorFolders'), ' ');
      assert(item(p, 'pixivAuthorFolders')?.getAttribute('aria-checked') === 'false' && menu(p), 'R25m: Space toggles the focused choice and keeps the menu open');
      await p.key(menu(p), 'Escape');
      assert(summary(p) === 'Выкл.' && p.q('#folderPreviewPath').textContent.endsWith('/x/pic/photo.jpg'), 'R25n: no choice means the usual layout');
      await p.unmount();
    }
  }

  // Instagram preview host: a real dropdown choice, draft/save failure/retry and reopened preference.
  for (const lang of ['en', 'ru']) {
    const state = { session: [], history: [], local: { uiLanguage: lang } };
    const p = await page('full', state, { hash: '#embed' });
    await p.key(p.q('#igShareHostSelect'), 'Enter'); await p.settle();
    const option = p.qa('[role="option"]').find((n) => n.textContent.startsWith('kkclip.com'));
    assert(option && p.qa('[role="option"]').length === 4, `R26a ${lang}: Instagram exposes kkclip alongside the existing three choices`);
    await p.key(option, 'Enter');
    assert(p.q('#igShareHostSelect').textContent === 'kkclip.com' && p.calls.localSets.length === 0 && p.q('#settingsSaveBar').getAttribute('data-state') === 'dirty', `R26b ${lang}: selecting kkclip remains an unsaved draft`);
    await p.mousedown(p.q('[data-section="saving"]')); await p.mousedown(p.q('[data-section="embed"]'));
    await p.click(p.qa('[data-slot="embed"] [data-slot="collapsible-trigger"]')[1]);
    assert(p.q('#igShareHostSelect').textContent === 'kkclip.com' && p.q('#igShareHostSelectHint').textContent.includes('kkclip.com'), `R26c ${lang}: navigation retains the choice and localized help names the service`);
    state.failSet = true; await p.click(p.q('#saveButton'));
    assert(p.q('#igShareHostSelect').textContent === 'kkclip.com' && state.local.igShareHost === undefined && p.q('#statusMessage').getAttribute('data-type') === 'error', `R26d ${lang}: failed Save retains the kkclip draft and error`);
    state.failSet = false; await p.click(p.q('#saveButton'));
    assert(state.local.igShareHost === 'kkclip.com' && state.local.xShareHost === 'fixupx.com' && state.local.ttShareHost === 'tnktok.com' && state.local.youtubeShareHost === 'koutube.com', `R26e ${lang}: explicit Save persists kkclip without changing other defaults`);
    await p.unmount(); const again = await page('full', state, { hash: '#embed' });
    assert(again.q('#igShareHostSelect').textContent === 'kkclip.com', `R26f ${lang}: reopened settings show the saved kkclip choice`); await again.unmount();
  }

  console.log(`\nИТОГИ: ${passed}/${passed + failed} пройдено (${failed} ошибок).`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Ошибка в тестовом сценарии:', err);
  process.exit(1);
});
