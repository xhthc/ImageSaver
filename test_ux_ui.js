// test_ux_ui.js - focused regression tests for the extension pages (UX-05 behavior, UX-08 shadcn/ui migration).
// The behavior of the compact popup and the full page lives in framework-neutral controllers (ui/src/core/*.js); this suite
// runs those production modules in Node with the real lib/feedback.js and lib/folder_path.js and a mocked Chrome, and checks the
// committed build output (popup/*.html) and the UI sources statically. The rendering of the React components (roles, keyboard,
// clipboard, expansion) is covered by test_ui_render.js (jsdom).
// Evidence boundary: Node mocks only - no Chromium, no real layout, no real clipboard or tabs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');
const core = (name) => import(pathToFileURL(path.resolve(ROOT, 'ui/src/core', name)).href);

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log(`[PASS] ${name}`); } else { failed++; console.error(`[FAIL] ${name}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const load = (file) => { const sb = { URL, console }; vm.createContext(sb); vm.runInContext(read(file), sb); return sb; };
const FB = load('lib/feedback.js').ImageSaverFeedback;
const FolderPath = load('lib/folder_path.js').ImageSaverFolderPath;
// UI-LOCALIZATION-01: controllers store catalogue keys; the Russian text is what a Russian interface renders.
const I18n = load('lib/i18n.js').ImageSaverI18n;
const ru = (m) => I18n.message('ru', m);

// ---------------------------------------------------------------------------------------------------
// Records and a message-answering Chrome mock
// ---------------------------------------------------------------------------------------------------
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
    ...over
  });
}
const failure = (stage, category, extra = {}) => ({ stage, category, code: '', status: null, downloadError: '', ...extra });
const unnamedFailure = () => rec({ state: 'failed', filename: '', filenameKind: '', output: {}, failure: failure('resolve', 'unresolved', { code: 'NO_MEDIA' }) });

function makeChrome(state) {
  const calls = { tabsCreate: [], localSets: [], messages: [] };
  const chrome = {
    runtime: {
      id: 'testid',
      getManifest: () => ({ version: '2.0.0' }),
      getURL: (p) => `chrome-extension://testid/${p}`,
      sendMessage: async (msg) => {
        calls.messages.push(msg.action);
        if (state.failMessages) throw new Error('MESSAGING_DOWN');
        if (msg.action === 'FEEDBACK_LIST') {
          const snapshot = state.session.slice().reverse(); // captured when the request is made
          const gate = state.listGates && state.listGates.shift();
          if (gate) await gate;
          return { success: true, records: snapshot };
        }
        if (msg.action === 'FEEDBACK_MARK_SEEN' && state.failMarkSeen) return { success: false };
        if (msg.action === 'FEEDBACK_MARK_SEEN' || msg.action === 'FEEDBACK_CLEAR') return { success: true, records: state.session.slice().reverse() };
        if (msg.action === 'HISTORY_LIST' || msg.action === 'HISTORY_CLEAR') {
          if (msg.action === 'HISTORY_CLEAR') { if (state.failClear) return { success: false }; state.history = []; }
          return { success: true, records: state.history.slice().reverse(), pruneFailed: state.pruneFailed === true };
        }
        return undefined;
      }
    },
    storage: {
      local: {
        get: async (defaults) => {
          if (state.failGet) throw new Error('UNREADABLE');
          const captured = { ...(defaults || {}), ...state.local }; // the answer is fixed when the request is made
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
        }
      },
      onChanged: {
        addListener: (cb) => { (state.changeListeners = state.changeListeners || []).push(cb); },
        removeListener: (cb) => { state.changeListeners = (state.changeListeners || []).filter((x) => x !== cb); }
      }
    },
    tabs: { create: async (o) => { if (state.failTabs) throw new Error('TABS'); calls.tabsCreate.push(o.url); return { id: 1 }; } }
  };
  return { chrome, calls };
}

(async () => {
  const { createStore } = await core('store.js');
  const nav = await core('nav.js');
  const { createFeedbackList, browserLabel } = await core('feedbackList.js');
  const { createHistory } = await core('history.js');
  const { createQuick } = await core('quick.js');
  const { createSettings, DEFAULTS, ALLOWED_HOSTS, cleanHost, STATUS_MS } = await core('settings.js');
  const present = await core('present.js');

  // =================================================================================================
  console.log('\n--- 21. Static contract: pages, build output, tabs, permissions ---');
  {
    const manifest = JSON.parse(read('manifest.json'));
    const quickHtml = read('popup/quick.html');
    const fullHtml = read('popup/popup.html');
    assert(manifest.action.default_popup === 'popup/quick.html' && fs.existsSync(path.resolve(ROOT, 'popup/quick.html')) && fs.existsSync(path.resolve(ROOT, 'popup/popup.html')), '21a: the toolbar popup is the compact quick.html; popup.html remains the full page');
    assert(JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(['contextMenus', 'declarativeNetRequest', 'downloads', 'notifications', 'offscreen', 'scripting', 'storage']) && JSON.stringify(manifest.host_permissions) === JSON.stringify(['http://*/*', 'https://*/*']), '21b: no permission or host-permission change');
    assert(!manifest.content_security_policy && manifest.content_scripts.some((c) => (c.js || []).includes('content_youtube.js')) && !manifest.content_scripts.some((c) => (c.js || []).some((f) => /popup|feedback|history|app\.js|quick|assets/.test(f))), '21c: the default MV3 CSP is kept (not weakened); no UI code is injected into pages');
    assert(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(quickHtml + fullHtml) && !/\son\w+=/.test(quickHtml + fullHtml), '21d: no inline script or inline handler on either page (MV3 CSP)');
    assert(!/(?:src|href)="(?:https?:)?\/\//.test(quickHtml + fullHtml), '21e: no remote asset, script or stylesheet on either page');
    const refs = [];
    for (const [file, html] of [['popup/quick.html', quickHtml], ['popup/popup.html', fullHtml]]) {
      for (const m of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) refs.push([file, m[1]]);
    }
    const missing = refs.filter(([file, ref]) => !fs.existsSync(path.resolve(ROOT, path.posix.join(path.posix.dirname(file), ref))));
    assert(refs.length >= 6 && missing.length === 0, `21f: every local script and stylesheet the pages reference exists (${refs.length} references)`);
    const order = (html, a, b) => html.indexOf(a) > -1 && html.indexOf(b) > -1 && html.indexOf(a) < html.indexOf(b);
    assert(/<script src="\.\.\/lib\/folder_path\.js"><\/script>\s*<script src="\.\.\/lib\/feedback\.js"><\/script>/.test(fullHtml) && /<script src="\.\.\/lib\/feedback\.js"><\/script>/.test(quickHtml) && /type="module"[^>]*src="\.\/assets\//.test(quickHtml + fullHtml), '21g: the shared libraries (folder rules, feedback schema) are the classic scripts of the pages; the bundle is a local module');
    assert(!fs.existsSync(path.resolve(ROOT, 'popup/popup.js')) && !fs.existsSync(path.resolve(ROOT, 'popup/feedback.js')) && !fs.existsSync(path.resolve(ROOT, 'popup/history.js')) && !fs.existsSync(path.resolve(ROOT, 'popup/app.js')) && !fs.existsSync(path.resolve(ROOT, 'popup/quick.js')) && !fs.existsSync(path.resolve(ROOT, 'popup/details.html')), '21h: the previous hand-written page scripts are gone (one implementation)');
    const built = fs.readdirSync(path.resolve(ROOT, 'popup/assets')).map((f) => read(`popup/assets/${f}`)).join('\n');
    assert(!/\beval\s*\(/.test(built) && !/new Function\s*\(/.test(built) && !/importScripts|https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\/[^"'`\s)]*\.js/i.test(built), '21i: the built bundle has no eval, no new Function and no remote script reference');
    const src = ['ui/src'].flatMap((dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(path.resolve(ROOT, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.(tsx?|js)$/.test(e.name)) out.push(p); } }; walk(dir); return out; });
    const srcText = src.map((f) => read(f).replace(/\/\/.*$/gm, '')).join('\n');
    const nonUpdateSrc = src.filter((f) => f !== 'ui/src/core/updates.js').map((f) => read(f)).join('\n');
    assert(!/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|eval\(|new Function|document\.write|XMLHttpRequest|sendBeacon|WebSocket/.test(srcText) && !/\bfetch\b/.test(nonUpdateSrc), '21j: UI has no HTML injection, eval or telemetry; release-check controller is the only network boundary');
    const full = read('ui/src/components/app/full-app.tsx');
    const pan = read('ui/src/components/app/settings-panels.tsx');
    assert(['history', 'saving', 'notifications', 'embed', 'updates'].map((n) => I18n.t('ru', `tab.${n}`)).join('|') === 'Статистика и история|Сохранение|Уведомления|Embed|Обновления'
      && ['history', 'saving', 'notifications', 'embed', 'updates'].map((n) => I18n.t('en', `tab.${n}`)).join('|') === 'Statistics and history|Saving|Notifications|Embed|Updates'
      && full.includes('t(`tab.${name}`)') && /role|Tabs/.test(full), '21k: the five sections have their names in both languages (Radix Tabs provides the tab/tabpanel roles)');
    const ids = ['subfolderInput', 'folderModeSingle', 'folderModeBySiteType', 'xShareHostSelect', 'igShareHostSelect', 'ttShareHostSelect', 'youtubeShareHostSelect', 'saveButton', 'statusMessage', 'folderPreviewPath'];
    assert(ids.every((id) => (pan + read('ui/src/components/app/settings-panels.tsx')).includes(`"${id}"`) || pan.includes(`id="${id}"`)), '21l: every existing settings element ID is preserved on the full page');
    assert(/меняют только ссылки/.test(I18n.t('ru', 'embed.desc')) && /Ошибки сохранения остаются видимыми всегда/.test(I18n.t('ru', 'notify.hintErrors')) && /Настройка применяется сразу/.test(I18n.t('ru', 'notify.hint'))
      && /change only the links/.test(I18n.t('en', 'embed.desc')) && ['"embed.desc"', '"notify.hintErrors"', '"notify.hint"'].every((k) => pan.includes(k)), '21m: Embed explains that it changes copied links; Notifications explain immediate saving and always-visible failures');
    assert(!/gear-button/.test(full) && /openSettingsButton/.test(read('ui/src/components/app/quick-app.tsx')) && !/openSettingsButton/.test(full), '21n: the settings gear exists only in the compact popup');
    const css = read('ui/src/index.css');
    assert(/prefers-reduced-motion:\s*reduce/.test(css) && /:focus-visible/.test(css), '21o: reduced motion and visible keyboard focus are global rules');
    assert(order(read('ui/popup.html'), '../lib/folder_path.js', '/src/full-main.tsx') && order(read('ui/quick.html'), '../lib/feedback.js', '/src/quick-main.tsx'), '21p: the page sources load the shared libraries before the bundle');
  }

  // =================================================================================================
  console.log('\n--- 22. Navigation and deep links (ui/src/core/nav.js) ---');
  {
    const S = nav.sectionFromLocation;
    assert(S({ search: '', hash: '' }) === 'history' && S({ search: '', hash: '#saving' }) === 'saving' && S({ search: '', hash: '#notifications' }) === 'notifications' && S({ search: '', hash: '#embed' }) === 'embed', '22a: hash selects the section');
    assert(S({ search: '?section=embed', hash: '' }) === 'embed' && S({ search: '?section=embed', hash: '#saving' }) === 'embed', '22b: ?section= selects a section and wins over the hash');
    assert(S({ search: '?op=op-ui-0001', hash: '#embed' }) === 'history' && S({ search: '?op=op-ui-0001&section=saving', hash: '' }) === 'history', '22c: an operation deep link always opens the history section');
    assert(['#<img src=x onerror=alert(1)>', '#constructor', '#__proto__', '#HISTORY', '#saving%20', '#'].every((h) => S({ search: '', hash: h }) === 'history') && S({ search: '?section=../x', hash: '' }) === 'history' && S(null) === 'history', '22d: unknown or hostile values fall back to the default section');
    assert(JSON.stringify(nav.SECTIONS) === JSON.stringify(['history', 'saving', 'notifications', 'embed', 'updates']) && JSON.stringify(nav.SETTINGS_SECTIONS) === JSON.stringify(['saving', 'embed']) && nav.DEFAULT_SECTION === 'history', '22e: five sections; only Saving and Embed use the explicit save action');
    const chrome = makeChrome({}).chrome;
    assert(nav.pageUrl(chrome, '<script>') === 'chrome-extension://testid/popup/popup.html#history' && nav.pageUrl(chrome, 'saving') === 'chrome-extension://testid/popup/popup.html#saving' && nav.pageUrl(chrome, '__proto__') === 'chrome-extension://testid/popup/popup.html#history', '22f: page URLs are built only for known sections');
    assert(nav.operationUrl(chrome, 'op-ui-0001') === 'chrome-extension://testid/popup/popup.html?op=op-ui-0001#history' && nav.operationUrl(chrome, 'a&b#c') === 'chrome-extension://testid/popup/popup.html?op=a%26b%23c#history', '22g: operation deep links encode the identity');
    assert(nav.focusIdFromLocation({ search: '?op=op-ui-0007' }) === 'op-ui-0007' && nav.focusIdFromLocation({ search: '' }) === '' && nav.focusIdFromLocation(null) === '', '22h: the deep-linked operation id is read from ?op=');
  }

  // =================================================================================================
  console.log('\n--- 23. Compact popup: five results, filenames, gear navigation ---');
  {
    const session = [];
    for (let i = 1; i <= 7; i++) session.push(rec({ filename: `file-number-${i}.jpg` }));
    session.push(unnamedFailure());
    const state = { session, history: [], local: { historyEnabled: true } };
    const { chrome, calls } = makeChrome(state);
    const list = createFeedbackList({ chrome, FB, navigator: {} }, { limit: 5, openFull: true });
    await list.start();
    const s = list.store.getState();
    assert(s.status === 'ready' && s.records.length === 5, '23a: the compact popup shows exactly five recent results');
    const parts = s.records.map((r) => present.rowParts(FB, r));
    const names = parts.filter((p) => p.name).map((p) => p.name);
    assert(names.length === 4 && names[0] === 'file-number-7.jpg' && names[3] === 'file-number-4.jpg', '23b: results show the sanitized file name as the main text (newest first)');
    assert(/Не удалось определить медиа — example\.com/.test(parts[0].legacy) && parts[0].name === '', '23c: an unnamed failure keeps a useful summary row');
    assert(list.canOpenFull === true && createFeedbackList({ chrome, FB }, {}).canOpenFull === false, '23d: the operation link exists only where the popup asks for it');

    const closed = [];
    const quick = createQuick({ chrome, window: { close: () => closed.push(1) } });
    await quick.ready;
    await quick.openSettings('saving');
    assert(calls.tabsCreate.length === 1 && calls.tabsCreate[0] === 'chrome-extension://testid/popup/popup.html#saving', '23e: the gear opens popup/popup.html#saving');
    assert(closed.length === 1, '23f: the popup closes after the tab was opened');
    state.failTabs = true;
    let threw = false;
    try { await quick.openSettings('saving'); } catch (_) { threw = true; }
    assert(!threw && closed.length === 1 && calls.tabsCreate.length === 1, '23g: a failed tab creation neither throws, opens a tab nor closes the popup');
    state.failTabs = false;
    await list.openFull(s.records[0]);
    assert(calls.tabsCreate[calls.tabsCreate.length - 1] === `chrome-extension://testid/popup/popup.html?op=${encodeURIComponent(session[session.length - 1].id)}#history`, '23h: the details action deep-links to that operation');
    state.failTabs = true;
    let threw2 = false;
    try { await list.openFull(s.records[0]); } catch (_) { threw2 = true; }
    assert(!threw2, '23i: a failed deep-link tab creation does not throw');
    assert(browserLabel({ userAgentData: { brands: [{ brand: 'Not A Brand', version: '99' }, { brand: 'Chromium', version: '126' }] } }) === 'Chromium 126' && browserLabel({ userAgentData: { brands: [{ brand: 'Chromium', version: '12<6' }] } }) === '' && browserLabel(null) === '', '23j: only a reliable Chromium major version reaches the report');
  }

  // =================================================================================================
  console.log('\n--- 24. Deep link to an operation; honest NO_MEDIA presentation; long names ---');
  {
    const noMedia = rec({ state: 'failed', filename: '', filenameKind: '', output: {}, site: 'x', failure: failure('resolve', 'unresolved', { code: 'NO_MEDIA' }) });
    const longName = rec({ filename: `${'очень-длинное-имя-'.repeat(20)}.png` });
    const other = rec();
    const state = { session: [other, noMedia, longName], history: [], local: {} };
    const { chrome } = makeChrome(state);
    const list = createFeedbackList({ chrome, FB }, { focusId: noMedia.id });
    await list.start();
    const s = list.store.getState();
    assert(s.focusId === noMedia.id && s.records.some((r) => r.id === noMedia.id) && s.records.length === 3, '24a: ?op= is kept as the operation to expand and scroll to (the row of exactly that record)');
    const lines = FB.summarize(s.records.find((r) => r.id === noMedia.id)).lines.join('\n');
    assert(/HTTP-статус: не наблюдался/.test(lines) && /Код: NO_MEDIA/.test(lines) && /Этап: определение источника/.test(lines), '24b: the X NO_MEDIA failure at resolve shows an unobserved HTTP status, the code and the stage');
    assert(!/HTTP 4\d\d|HTTP 5\d\d|404|подтвердил, что файл отсутствует/.test(lines), '24c: no HTTP status or absence claim is invented for NO_MEDIA');
    const rl = s.records.find((r) => r.id === longName.id);
    assert(rl.filename === longName.filename && longName.filename.length <= 120, '24d: a long file name is bounded to 120 characters');
    assert(present.filenameLine(rl).includes(longName.filename) && /фактическое, по данным Chrome/.test(present.filenameLine(rl)) && present.filenameLine(rec({ filename: 'p.jpg', filenameKind: 'intended' })).endsWith('(запланированное, не подтверждено)') && present.filenameLine(unnamedFailure()) === '', '24e: details carry the complete name and say whether it is confirmed');
    assert(/имя запланировано, не подтверждено/.test(present.rowParts(FB, rec({ filename: 'q.jpg', filenameKind: 'intended' })).meta) && !/запланировано/.test(present.rowParts(FB, rl).meta), '24f: an unconfirmed name is marked in the row, a confirmed one is not');
    assert(present.hasReport(noMedia) && !present.hasReport(other) && present.hasReport(rec({ state: 'interrupted', output: {}, failure: failure('download', 'download_interrupted') })) && !present.hasReport(rec({ state: 'cancelled', output: {}, failure: failure('save', 'cancelled') })), '24g: only failed and interrupted results offer the retry hint and the report');
    const rep = present.buildReportText(FB, noMedia, 'save fails <b>bold</b> https://x.test/?token=NOTE123', { version: '2.0.0', browser: 'Chromium 126' });
    assert(rep.startsWith('Image Saver bug report') && /browser: Chromium 126/.test(rep) && /user_notes: save fails/.test(rep) && !/NOTE123|https?:/.test(rep), '24h: the report carries the browser only when reliable and redacts the notes');
    assert(/одна попытка возобновить/.test(present.RETRY_HINT) && /не отправляется автоматически/.test(present.REPORT_PRIVACY), '24i: the bounded native resume and the no-submission promise are stated');
    let clip = null;
    await present.copyText('abc', { clipboard: { writeText: async (t) => { clip = t; } } });
    let denied = false;
    try { await present.copyText('abc', { clipboard: { writeText: async () => { throw new Error('DENIED'); } } }); } catch (_) { denied = true; }
    let none = false;
    try { await present.copyText('abc', {}); } catch (_) { none = true; }
    assert(clip === 'abc' && denied && none, '24j: the clipboard is written only through copyText and its failures propagate');
    assert(present.postUrlOf(FB, rec({ postUrl: 'https://x.com/someone/status/1234567890?token=SECRET#frag' })) === 'https://x.com/someone/status/1234567890' && present.postUrlOf(FB, rec({ postUrl: 'javascript:alert(1)' })) === '' && present.postUrlOf(FB, rec({ postUrl: 'https://example.com/p/1' })) === '' && present.postUrlOf(FB, rec({ postUrl: 'https://u:p@x.com/a/status/1' })) === '', '24k: a post link is offered only for a validated X status URL, without query or fragment; anything else is unknown');
  }

  // =================================================================================================
  console.log('\n--- 25. Statistics over retained history (unknown/estimated metadata stays honest) ---');
  {
    const S = FB.computeStats;
    const mixed = [
      rec({ output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', mime: 'image/jpeg', sizeBytes: 2048, sizeKind: 'measured' } }),
      rec({ output: { type: 'pic', ext: '.png', evidence: 'filename_hint', sizeBytes: 4096, sizeKind: 'estimated' } }),
      rec({ output: { type: 'video', ext: '.mp4', evidence: 'verified_mime', mime: 'video/mp4', sizeBytes: 1000000, sizeKind: 'measured' } }),
      rec({ output: { type: 'gif', ext: '.gif', evidence: 'converted_output', mime: 'image/gif', sizeBytes: 3000, sizeKind: 'measured' } }),
      rec({ output: { type: 'unknown', ext: '', evidence: 'unknown' } }),
      rec({ state: 'failed', output: {}, failure: failure('download', 'network') }),
      rec({ state: 'interrupted', output: {}, failure: failure('download', 'download_interrupted', { downloadError: 'NETWORK_FAILED' }) }),
      rec({ state: 'failed', output: {}, failure: failure('download', 'outcome_unknown', { code: 'DOWNLOAD_OUTCOME_UNKNOWN' }) }),
      rec({ state: 'cancelled', output: {}, failure: failure('save', 'cancelled', { code: 'USER_CANCELED' }) }),
      rec({ state: 'saving', output: {} }),
      { evil: true }, null
    ];
    const s = S(mixed);
    assert(s.total === 9 && s.success === 5 && s.failed === 2 && s.unknown === 1 && s.cancelled === 1, '25a: outcomes are counted separately (success, failure/interruption, unknown, cancelled); non-terminal and malformed records are ignored');
    assert(s.types.pic.total === 2 && s.types.pic.verified === 1 && s.types.pic.hinted === 1 && s.types.video.verified === 1 && s.types.gif.verified === 1 && s.types.unknown === 1, '25b: types carry evidence labels (verified vs filename hint) and unknown stays unknown');
    assert(s.size.knownBytes === 2048 + 1000000 + 3000 && s.size.measuredCount === 3 && s.size.estimatedCount === 1 && s.size.missingCount === 1, '25c: only measured sizes of successful saves are summed; estimated and missing sizes are counted apart');
    assert(S([rec({ state: 'failed', output: { sizeBytes: 5000, sizeKind: 'measured' }, failure: failure('download', 'network') })]).size.knownBytes === 0, '25d: a failed record never contributes size');
    assert(S([]).total === 0 && S(null).total === 0 && S('x').success === 0, '25e: empty or invalid input yields empty statistics');

    const retained = mixed.filter((r) => r && r.state);
    const v = present.statsView(FB, retained, 'ok', true);
    const tile = (view, key) => view.tiles.find((t) => t.key === key);
    assert(/не более 50 операций за последние 7 дней/.test(v.note) && /не итоги за всё время/.test(v.note) && /не обязательно все загрузки/.test(v.note), '25f: the scope note states 50 operations / 7 days and that these are not lifetime totals');
    assert(tile(v, 'success').value === 5 && tile(v, 'failed').value === 2 && tile(v, 'cancelled').value === 1 && tile(v, 'unknown').value === 1 && /Результат неизвестен/.test(tile(v, 'unknown').label) && tile(v, 'total').value === 9, '25g: outcome counters are distinct');
    const pic = v.types.find((t) => t.key === 'pic');
    assert(pic.label === 'Изображения' && pic.value === 2 && pic.detail === 'тип подтверждён: 1; определён по расширению файла: 1' && v.types.find((t) => t.key === 'unknown').value === 1, '25h: type counters show the evidence split');
    assert(/не менее 981 КБ/.test(v.sizeText) && /измерен у 3 из 5 успешных сохранений/.test(v.sizeText) && /оценки по заголовкам \(1\) не суммируются/.test(v.sizeText) && /размер неизвестен у 1/.test(v.sizeText), '25i: the known total size states its coverage, excluded estimates and unknown sizes');
    const none = present.statsView(FB, [rec({ output: { type: 'pic', ext: '.jpg', evidence: 'filename_hint' } })], 'ok', true);
    assert(/Известный суммарный размер: неизвестен/.test(none.sizeText) && /измерен у 0 из 1/.test(none.sizeText), '25j: with no measured size the total is "unknown", never zero');
    const off = present.statsView(FB, [rec()], 'ok', false);
    assert(/Запись истории выключена: уже сохранённые записи остаются, новые операции не добавляются/.test(off.disabledNote) && tile(off, 'total').value === 1, '25k: with recording disabled the existing entries are still summarised and the behavior is explained');
    const eOff = present.statsView(FB, [], 'ok', false);
    const eOn = present.statsView(FB, [], 'ok', true);
    const ld = present.statsView(FB, null, 'loading', true);
    const er = present.statsView(FB, null, 'error', true);
    assert(eOff.state === 'empty' && /Включите запись истории/.test(eOff.message) && /В истории пока нет записей/.test(eOn.message) && ld.state === 'loading' && /Загрузка статистики/.test(ld.message) && er.state === 'error' && /Статистика недоступна/.test(er.message), '25l: empty, disabled, loading and error states are distinct');

    // the history controller: statistics follow the data, the toggle and the clear action
    const state = { session: [], history: [rec(), rec({ state: 'failed', output: {}, failure: failure('resolve', 'unresolved', { code: 'NO_MEDIA' }) })], local: { historyEnabled: true } };
    const { chrome } = makeChrome(state);
    const h = createHistory({ chrome, FB });
    assert(h.store.getState().status === 'loading' && h.stats() === null, '25m: before the history is loaded there are no statistics');
    await h.start();
    const hs = () => h.store.getState();
    const view = () => present.statsView(FB, hs().records, hs().status === 'error' ? 'error' : 'ok', hs().enabled);
    assert(hs().status === 'ready' && hs().enabled === true && h.stats().total === 2 && tile(view(), 'success').value === 1 && !view().disabledNote, '25n: the history section shows statistics for the loaded history');
    await h.setEnabled(false);
    assert(hs().enabled === false && state.local.historyEnabled === false && /Запись истории выключена/.test(view().disabledNote) && tile(view(), 'total').value === 2, '25o: switching recording off explains the behavior and keeps the statistics of existing entries');
    await h.clear();
    assert(hs().records.length === 0 && ru(hs().clearStatus) === 'История очищена.' && view().state === 'empty', '25p: clearing empties the statistics');
    state.history.push(rec());
    state.failClear = true;
    await h.clear();
    assert(/данные не удалены/.test(ru(hs().error)) && hs().records.length === 0 && hs().clearStatus === '' && hs().clearing === false, '25q: a failed clear is reported truthfully (nothing claimed cleared)');
    const stateErr = { session: [], history: [], local: {}, failMessages: true };
    const h2 = createHistory({ chrome: makeChrome(stateErr).chrome, FB });
    await h2.start();
    assert(h2.store.getState().status === 'error' && /Не удалось загрузить историю/.test(ru(h2.store.getState().error)) && present.statsView(FB, h2.store.getState().records, 'error', false).state === 'error', '25r: a messaging failure shows loading errors instead of statistics');
    const stP = { session: [], history: [rec()], local: { historyEnabled: true }, pruneFailed: true };
    const h3 = createHistory({ chrome: makeChrome(stP).chrome, FB });
    await h3.start();
    assert(/Не удалось удалить устаревшие записи из хранилища/.test(ru(h3.store.getState().error)) && h3.store.getState().status === 'ready', '25s: a failed pruning is reported while the retained records are still shown');
    const off2 = createHistory({ chrome: makeChrome({ session: [], history: [rec(), rec()], local: { historyEnabled: false, historyInviteDismissed: true } }).chrome, FB });
    await off2.start();
    assert(off2.store.getState().records.length === 2 && off2.store.getState().enabled === false && /Запись истории выключена/.test(present.statsView(FB, off2.store.getState().records, 'ok', false).disabledNote), '25t: the full page still shows retained records and statistics while recording is off, and explains it');
  }

  // =================================================================================================
  console.log('\n--- 26. Settings: persistence and isolation (ui/src/core/settings.js, history.js) ---');
  {
    const DEFAULTS_KEYS = ['subfolder', 'folderOrganizationMode', 'xShareHost', 'igShareHost', 'ttShareHost', 'youtubeShareHost'];
    const timers = [];
    const mountSettings = async (stateOver = {}) => {
      const state = { session: [], history: [], local: { notifySuccess: false, historyEnabled: true, unrelatedKey: 'keep-me', ...stateOver } };
      const { chrome, calls } = makeChrome(state);
      const settings = createSettings({ chrome, FolderPath, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} });
      await settings.load();
      return { state, calls, settings, chrome, st: () => settings.store.getState() };
    };

    const a = await mountSettings({ askEveryTime: true });
    const st = a.st;
    assert(st().subfolder === 'SavedImages' && st().folderOrganizationMode === 'single' && !('askEveryTime' in st()) && st().xShareHost === 'x.com' && st().igShareHost === 'instagram.com' && st().ttShareHost === 'tiktok.com' && st().youtubeShareHost === 'youtube.com' && st().loaded === true, '26a: existing defaults are loaded unchanged on the full page');
    assert(JSON.stringify(Object.keys(DEFAULTS).sort()) === JSON.stringify([...DEFAULTS_KEYS].sort()) && JSON.stringify(DEFAULTS) === JSON.stringify({ subfolder: 'SavedImages', folderOrganizationMode: 'single', xShareHost: 'x.com', igShareHost: 'instagram.com', ttShareHost: 'tiktok.com', youtubeShareHost: 'youtube.com' }), '26a2: the remaining settings have their previous defaults; Save As is absent');
    assert(st().notify.checked === false && st().notify.error === '', '26b: the Notifications section reflects the stored notifySuccess preference');
    assert(a.calls.localSets.length === 0, '26b2: loading and editing write nothing');

    a.settings.setField('subfolder', '  My/Pics  ');
    a.settings.setField('folderOrganizationMode', 'by_site_and_type');
    a.settings.setField('askEveryTime', true);
    a.settings.setField('xShareHost', 'fixupx.com');
    a.settings.setField('youtubeShareHost', 'koutube.com');
    a.settings.setField('notAKey', 'x');
    assert(a.calls.localSets.length === 0 && a.state.local.subfolder === undefined && !('notAKey' in st()) && !('askEveryTime' in st()), '26b3: edits stay in the form until the explicit save; unknown keys are ignored');
    assert(a.settings.preview().text === 'Загрузки/My/Pics/x/pic/photo.jpg' && a.settings.preview().error === false, '26b4: the example path follows the folder and the organization mode');
    assert(await a.settings.save() === true);
    const saved = a.calls.localSets[a.calls.localSets.length - 1];
    assert(JSON.stringify(Object.keys(saved).sort()) === JSON.stringify([...DEFAULTS_KEYS].sort()) && saved.folderOrganizationMode === 'by_site_and_type' && !('askEveryTime' in saved) && saved.xShareHost === 'fixupx.com' && saved.youtubeShareHost === 'koutube.com' && saved.igShareHost === 'instagram.com' && saved.ttShareHost === 'tiktok.com', '26c: "Сохранить настройки" writes exactly the six remaining Saving/Embed keys with allowlisted values');
    assert(a.state.local.notifySuccess === false && a.state.local.historyEnabled === true && a.state.local.unrelatedKey === 'keep-me', '26d: saving settings leaves notifySuccess, historyEnabled and unrelated values untouched');
    assert(st().subfolder === 'My/Pics' && /Настройки успешно сохранены/.test(ru(st().status.message)) && st().status.type === 'success' && timers.pop().ms === STATUS_MS, '26d2: the form shows the sanitized value and a success message that clears itself');

    a.settings.setField('subfolder', 'a:b/c');
    await a.settings.save();
    assert(/Папка исправлена: ab\/c/.test(ru(st().status.message)), '26d3: a corrected folder is reported');

    const before = a.calls.localSets.length;
    await a.settings.setNotifySuccess(true);
    const notifySet = a.calls.localSets[a.calls.localSets.length - 1];
    assert(a.calls.localSets.length === before + 1 && JSON.stringify(notifySet) === JSON.stringify({ notifySuccess: true }) && st().notify.checked === true, '26e: the notification preference saves immediately and writes only notifySuccess');
    assert(a.state.local.subfolder === 'ab/c', '26f: the folder setting is unaffected by the notification change');

    const hist = createHistory({ chrome: a.chrome, FB });
    await hist.start();
    const before2 = a.calls.localSets.length;
    await hist.setEnabled(false);
    assert(a.calls.localSets.length === before2 + 1 && JSON.stringify(a.calls.localSets[a.calls.localSets.length - 1]) === JSON.stringify({ historyEnabled: false }), '26g: the history switch writes only historyEnabled');

    a.state.failSet = true;
    await a.settings.setNotifySuccess(false);
    assert(st().notify.checked === true && /Не удалось сохранить настройку уведомлений/.test(ru(st().notify.error)) && a.state.local.notifySuccess === true, '26h: a storage failure reverts the notification preference and says so');
    await hist.setEnabled(true);
    assert(hist.store.getState().enabled === false && /Не удалось сохранить настройку истории/.test(ru(hist.store.getState().prefError)) && a.state.local.historyEnabled === false, '26h2: a storage failure reverts the history switch and says so');
    a.settings.setField('subfolder', 'x'.repeat(300));
    const setsBefore = a.calls.localSets.length;
    assert(await a.settings.save() === false);
    a.state.failSet = false;
    assert(a.calls.localSets.length === setsBefore && /Слишком|максимум/.test(ru(st().status.message)) && st().status.type === 'error' && st().subfolder === 'x'.repeat(300) && a.settings.preview().error === true, '26i: an invalid root is rejected explicitly, nothing is written and the input is not silently shortened');
    a.settings.setField('subfolder', 'a/b/c/d/e/f/g/h/i');
    await a.settings.save();
    assert(/Слишком много вложенных папок \(максимум 8\)/.test(ru(st().status.message)), '26i2: too many nested folders are rejected with the limit');
    a.settings.setField('subfolder', 'ok');
    a.state.failSet = true;
    assert(await a.settings.save() === false && /Не удалось сохранить настройки/.test(ru(st().status.message)) && st().saving === false, '26i3: a storage failure on save is reported and releases the button');
    a.state.failSet = false;

    const unreadableState = { session: [], history: [], local: { subfolder: 'MyMedia', xShareHost: 'fixupx.com' }, failGet: true };
    const unreadableApi = makeChrome(unreadableState);
    const unreadable = createSettings({ chrome: unreadableApi.chrome, FolderPath, setTimeout: () => 0, clearTimeout() {} });
    const origErr = console.error; console.error = () => {};
    await unreadable.load();
    console.error = origErr;
    assert(unreadable.store.getState().notify.checked === true && /показано значение по умолчанию/.test(ru(unreadable.store.getState().notify.error)) && /Ошибка загрузки настроек/.test(ru(unreadable.store.getState().status.message)) && unreadable.store.getState().loaded === false, '26j: unreadable settings keep the form disabled and explain the failure');
    assert(await unreadable.save() === false && unreadableApi.calls.localSets.length === 0 && unreadableState.local.subfolder === 'MyMedia', '26j2: a failed read cannot overwrite existing preferences with defaults');
    unreadableState.failGet = false;
    await unreadable.load();
    assert(unreadable.store.getState().loaded && unreadable.store.getState().subfolder === 'MyMedia' && unreadable.store.getState().xShareHost === 'fixupx.com' && await unreadable.save(), '26j3: successful reloading restores existing settings and permits saving');
    const e3 = createHistory({ chrome: makeChrome({ session: [], history: [], local: { historyEnabled: 'true' } }).chrome, FB });
    await e3.start();
    assert(e3.store.getState().enabled === false, '26k: a malformed history preference is shown as off (opt-in preserved)');
    const e4 = createHistory({ chrome: makeChrome({ session: [], history: [], local: {}, failGet: true }).chrome, FB });
    await e4.start();
    assert(e4.store.getState().enabled === false && /считается выключенной/.test(ru(e4.store.getState().prefError)), '26l: an unreadable history preference is off and says so');
    assert(cleanHost('xShareHost', 'evil.example') === 'x.com' && cleanHost('igShareHost', 'kirkstagram.com') === 'kirkstagram.com' && cleanHost('ttShareHost', '__proto__') === 'tiktok.com' && cleanHost('youtubeShareHost', 'koutube.com') === 'koutube.com' && ALLOWED_HOSTS.xShareHost.length === 3, '26m: a share host outside its allow-list falls back to the original service');
    const mal = await mountSettings({ xShareHost: 'evil.example', folderOrganizationMode: 'bogus', askEveryTime: 'yes', subfolder: 42 });
    assert(mal.st().xShareHost === 'x.com' && mal.st().folderOrganizationMode === 'single' && !('askEveryTime' in mal.st()) && mal.st().subfolder === 'SavedImages', '26n: malformed values are normalized and the removed preference is ignored');
  }

  // =================================================================================================
  console.log('\n--- 27. Compact popup while history is disabled: invitation, dismissal, preference changes ---');
  {
    const sessionRecords = () => Array.from({ length: 7 }, (_, i) => rec({ filename: `quick-${i + 1}.jpg` }));
    const mountQuick = async (local = {}, over = {}) => {
      const state = { session: sessionRecords(), history: [], local: { notifySuccess: false, ...local }, ...over };
      const { chrome, calls } = makeChrome(state);
      const closed = [];
      const quick = createQuick({ chrome, window: { close: () => closed.push(1) } });
      await quick.ready;
      const q = { state, calls, quick, closed, chrome, st: () => quick.store.getState() };
      // what the page shows: the list is mounted exactly while history is enabled
      q.showList = () => q.st().ready && q.st().enabled;
      q.showInvite = () => q.st().ready && !q.st().enabled && !q.st().dismissed;
      q.showMain = () => q.showList() || q.showInvite();
      return q;
    };

    const a = await mountQuick({});
    assert(a.showInvite() && a.showMain() && !a.showList(), '27a: history missing -> list and subtitle hidden, invitation shown');
    assert(a.st().mounted === false && !a.calls.messages.includes('FEEDBACK_LIST'), '27b: no list is mounted and the list is not even requested');
    for (const bad of ['true', 1, null, {}, 'yes', false]) {
      const q = await mountQuick({ historyEnabled: bad });
      assert(q.showInvite() && !q.showList() && q.st().mounted === false, `27d: historyEnabled ${JSON.stringify(bad)} is treated as disabled`);
    }

    const sessionBefore = JSON.stringify(a.state.session);
    await a.quick.dismissInvite();
    assert(JSON.stringify(a.calls.localSets) === JSON.stringify([{ historyInviteDismissed: true }]), '27e: dismissing writes only the separate dismissal preference');
    assert(a.state.local.historyEnabled === undefined && a.state.local.notifySuccess === false && JSON.stringify(a.state.session) === sessionBefore && !a.calls.messages.includes('FEEDBACK_CLEAR') && !a.calls.messages.includes('HISTORY_CLEAR'), '27f: dismissing does not enable history, clear records or change the notification preference');
    assert(!a.showInvite() && !a.showMain() && !a.showList(), '27g: after dismissal only the header remains (no blank container)');
    const restarted = await mountQuick(a.state.local); // reopening / browser restart: the same stored preferences
    assert(!restarted.showInvite() && !restarted.showMain() && restarted.st().mounted === false, '27i: the dismissal survives reopening the popup and a browser restart (persisted in storage.local)');

    const e = await mountQuick({});
    await e.quick.enableHistory();
    assert(JSON.stringify(e.calls.localSets) === JSON.stringify([{ historyEnabled: true }]) && e.state.local.historyInviteDismissed === undefined, '27j: "Включить историю" writes only historyEnabled (the dismissal preference is untouched)');
    assert(!e.showInvite() && e.showList() && e.showMain() && e.st().mounted === true && e.st().mount === 1, '27k: after a successful write the list (mounted once) appears and the invitation goes away');
    const mountId = e.st().mount;
    const list = createFeedbackList({ chrome: e.chrome, FB }, { limit: 5, openFull: true, isActive: () => e.quick.isActive(mountId) });
    await list.start();
    assert(list.store.getState().records.length === 5 && list.canOpenFull, '27l: the restored list keeps five results and their operation links');

    const f = await mountQuick({}, { failSet: true });
    await f.quick.enableHistory();
    assert(f.state.local.historyEnabled === undefined && f.showInvite() && !f.showList() && f.st().mounted === false && /Не удалось включить историю: настройка не сохранена/.test(ru(f.st().inviteError)), '27m: a failed write leaves history disabled and shows a truthful error');
    await f.quick.dismissInvite();
    assert(f.state.local.historyInviteDismissed === undefined && f.showInvite() && /Не удалось запомнить выбор/.test(ru(f.st().inviteError)), '27n: a failed dismissal write keeps the invitation and says so');
    const g = await mountQuick({}, { failGet: true });
    assert(g.showInvite() && !g.showList() && g.st().ready === true, '27o: an unreadable preference means disabled (the invitation is shown, no list)');

    const h = await mountQuick({ historyEnabled: true });
    assert(h.showList() && !h.showInvite() && h.st().mounted === true, '27p: with history enabled the existing compact list is shown');
    const h2 = await mountQuick({ historyEnabled: true, historyInviteDismissed: true });
    assert(h2.showList() && !h2.showInvite(), '27q: a stored dismissal does not hide the list once history is enabled');

    const p = await mountQuick({ historyInviteDismissed: true });
    assert(!p.showMain() && p.st().mounted === false, '27r: start state - disabled and dismissed (header only)');
    await p.chrome.storage.local.set({ historyEnabled: true }); // changed elsewhere (full page)
    assert(p.showList() && p.st().mounted === true, '27s: enabling history elsewhere shows the list in the open popup');
    const m1 = p.st().mount;
    await p.chrome.storage.local.set({ historyEnabled: false });
    assert(!p.showList() && !p.showMain() && p.st().mounted === false && p.st().mount === m1 + 1 && p.quick.isActive(m1) === false, '27t: disabling history elsewhere hides the list again (dismissal respected) and supersedes its mount');
    await p.chrome.storage.local.set({ historyInviteDismissed: false });
    assert(p.showInvite() && p.showMain(), '27u: clearing the dismissal elsewhere brings the invitation back');
    assert(!p.state.local.notifySuccess && p.state.local.historyEnabled === false, '27v: none of this touched the notification preference');
    await p.chrome.storage.local.set({ otherKey: 1 });
    assert(p.showInvite() && p.st().mount === m1 + 1, '27v2: an unrelated storage change does not touch the view');

    const quickSrc = read('ui/src/core/quick.js').replace(/\/\/.*$/gm, '');
    assert(!/notifySuccess|FEEDBACK_CLEAR|FEEDBACK_MARK_SEEN|HISTORY_CLEAR|downloads|notifications\./.test(quickSrc), '27w: the popup logic never touches notifications, the error badge, the tracker or the history records');
    assert(/data-popup="quick"/.test(read('ui/src/components/app/quick-app.tsx')) && /ResultsList[\s\S]*key=\{s\.mount\}/.test(read('ui/src/components/app/quick-app.tsx')) && /<ResultsList compact=\{false\}/.test(read('ui/src/components/app/full-app.tsx')), '27y: the full page keeps its own results list, independent of the popup preference');
  }

  // =================================================================================================
  console.log('\n--- 28. Compact popup races: stale preference read, superseded list mount ---');
  {
    const sessionWithUnread = () => [rec({ filename: 'older-1.jpg' }), unnamedFailure()];
    const mount = async (local, over = {}) => {
      const state = { session: sessionWithUnread(), history: [], local: { ...local }, ...over };
      const { chrome, calls } = makeChrome(state);
      const quick = createQuick({ chrome, window: { close() {} } });
      return { state, calls, quick, chrome, st: () => quick.store.getState() };
    };

    // 1. an older initial preference response must not overwrite a newer event
    const g1 = deferred();
    const a = await mount({ historyEnabled: true }, { getGate: g1.promise });
    await settle();
    assert(a.st().ready === false && a.st().mounted === false, '28a: until the initial read resolves nothing is shown');
    await a.chrome.storage.local.set({ historyEnabled: false }); // real storage.onChanged delivery while get() is pending
    g1.resolve();
    await settle();
    assert(a.state.local.historyEnabled === false && a.st().enabled === false && a.st().mounted === false && !a.calls.messages.includes('FEEDBACK_LIST'), '28b: the stale "enabled" response does not show the list (persisted false stays authoritative, list never requested)');
    assert(a.st().ready && !a.st().enabled && !a.st().dismissed, '28c: the view matches the persisted preference (invitation shown)');

    const g2 = deferred();
    const b = await mount({ historyEnabled: true, historyInviteDismissed: true }, { getGate: g2.promise });
    await b.chrome.storage.local.set({ historyEnabled: false });
    g2.resolve();
    await settle();
    assert(b.st().enabled === false && b.st().dismissed === true && b.st().mounted === false, '28d: an unaffected key (dismissal) is still initialised from the initial read while the changed key keeps the newer value');

    const g3 = deferred();
    const c = await mount({}, { getGate: g3.promise });
    await c.chrome.storage.local.set({ historyInviteDismissed: true });
    g3.resolve();
    await settle();
    assert(c.st().dismissed === true && c.st().enabled === false, '28e: a newer dismissal is not overwritten by the older "not dismissed" response');

    const g4 = deferred();
    const d = await mount({ historyEnabled: false }, { getGate: g4.promise });
    await d.chrome.storage.local.set({ historyEnabled: true });
    g4.resolve();
    await settle();
    assert(d.st().enabled === true && d.st().mounted === true, '28f: the opposite order works too: a newer "enabled" event wins over an older "disabled" response');

    const g5 = deferred();
    const e = await mount({ historyEnabled: true, historyInviteDismissed: false }, { getGate: g5.promise });
    g5.resolve();
    await settle();
    assert(e.st().enabled === true && e.st().dismissed === false && e.st().mounted === true, '28g: without events the initial response initialises both keys as before');

    // 2. a superseded list mount must not acknowledge unseen failures
    const l1 = deferred();
    const f = await mount({ historyEnabled: true }, { listGates: [l1.promise] });
    await f.quick.ready;
    const mountF = f.st().mount;
    const listF = createFeedbackList({ chrome: f.chrome, FB }, { limit: 5, isActive: () => f.quick.isActive(mountF) });
    const startedF = listF.start();
    await settle();
    assert(f.calls.messages.includes('FEEDBACK_LIST') && !f.calls.messages.includes('FEEDBACK_MARK_SEEN'), '28h: setup - the list request is pending and nothing was acknowledged');
    await f.chrome.storage.local.set({ historyEnabled: false });
    assert(f.st().mounted === false && f.quick.isActive(mountF) === false, '28i: disabling supersedes the mount while the response is pending');
    l1.resolve();
    const resF = await startedF;
    await settle();
    assert(resF.cancelled === true && !f.calls.messages.includes('FEEDBACK_MARK_SEEN') && !f.calls.messages.includes('FEEDBACK_CLEAR'), '28j: the late response of the cancelled list does not acknowledge the unread failure');
    assert(listF.store.getState().status === 'loading' && listF.store.getState().records.length === 0, '28k: the cancelled list renders nothing');

    const control = await mount({ historyEnabled: true });
    await control.quick.ready;
    const ctl = createFeedbackList({ chrome: control.chrome, FB }, { limit: 5, isActive: () => control.quick.isActive(control.st().mount) });
    await ctl.start();
    assert(control.calls.messages.filter((m) => m === 'FEEDBACK_MARK_SEEN').length === 1, '28l: control - a visible, current list still acknowledges unseen failures exactly once');

    // 3. re-enabling creates a valid current mount without stale side effects
    const l2 = deferred();
    const h = await mount({ historyEnabled: true }, { listGates: [l2.promise] });
    await h.quick.ready;
    const m1 = h.st().mount;
    const stale = createFeedbackList({ chrome: h.chrome, FB }, { limit: 5, isActive: () => h.quick.isActive(m1) });
    const staleStart = stale.start(); // its request waits on the gate
    await settle();
    await h.chrome.storage.local.set({ historyEnabled: false });
    h.state.session.push(rec({ filename: 'newer-after-reenable.jpg' }));
    await h.chrome.storage.local.set({ historyEnabled: true }); // a fresh mount; its own request is answered at once
    const m2 = h.st().mount;
    assert(m2 > m1 && h.quick.isActive(m1) === false && h.quick.isActive(m2) === true, '28m: the re-enabled mount is a new current mount; the old one stays superseded');
    const fresh = createFeedbackList({ chrome: h.chrome, FB }, { limit: 5, isActive: () => h.quick.isActive(m2) });
    await fresh.start();
    const seenAfterCurrent = h.calls.messages.filter((m) => m === 'FEEDBACK_MARK_SEEN').length;
    assert(fresh.store.getState().records.length === 3, '28n: the re-enabled mount rendered its own list');
    assert(fresh.store.getState().records[0].filename === 'newer-after-reenable.jpg' && seenAfterCurrent === 1, '28o: the current mount shows its newest data and acknowledged the failure once');
    l2.resolve(); // the stale first request finally answers
    await staleStart;
    await settle();
    assert(h.calls.messages.filter((m) => m === 'FEEDBACK_MARK_SEEN').length === 1 && stale.store.getState().records.length === 0, '28p: the stale response adds no second acknowledgement and does not render');

    // 4. the full page keeps acknowledging as before (no isActive supplied)
    const stateFull = { session: sessionWithUnread(), history: [], local: {} };
    const fullCalls = makeChrome(stateFull);
    const fullList = createFeedbackList({ chrome: fullCalls.chrome, FB }, {});
    await fullList.start();
    assert(fullCalls.calls.messages.includes('FEEDBACK_MARK_SEEN'), '28q: the full page (no lifecycle guard) still acknowledges unseen failures when its list is viewed');
  }

  // =================================================================================================
  console.log('\n--- 29. Full page: failures are acknowledged only when the History panel is displayed ---');
  {
    const mountFull = async (visible, over = {}) => {
      const state = { session: [rec({ filename: 'ok-before.jpg' }), unnamedFailure()], history: [], local: {}, ...over };
      const { chrome, calls } = makeChrome(state);
      const list = createFeedbackList({ chrome, FB }, { visible });
      const started = list.start();
      return { state, calls, list, started, seen: () => calls.messages.filter((m) => m === 'FEEDBACK_MARK_SEEN').length, rows: () => list.store.getState().records.length };
    };
    assert(/visible=\{section === "history"\}/.test(read('ui/src/components/app/full-app.tsx')) && /forceMount/.test(read('ui/src/components/app/full-app.tsx')), '29a0: the full-page results list is told whether the History panel is displayed, and the panels stay mounted');

    // hidden panel: a pending response arrives while another section is displayed
    const gate = deferred();
    const q = await mountFull(false, { listGates: [gate.promise] });
    await settle();
    assert(q.calls.messages.includes('FEEDBACK_LIST') && q.seen() === 0, '29a: setup - the list request is pending while the History panel is hidden');
    gate.resolve();
    await q.started;
    await settle();
    assert(q.seen() === 0, '29b: a hidden History panel does not acknowledge the unread failure');
    assert(q.rows() === 2 && q.list.store.getState().unreadIds.length === 1, '29c: the results were still rendered (ready when the user opens History)');
    q.list.setVisible(true);
    await settle();
    assert(q.seen() === 1, '29d: opening History acknowledges the displayed failure exactly once');
    q.list.setVisible(false); q.list.setVisible(true);
    await settle();
    assert(q.seen() === 1, '29e: switching away and back does not acknowledge again');

    // switching into History while the response is still pending
    const gP = deferred();
    const pending = await mountFull(false, { listGates: [gP.promise] });
    pending.list.setVisible(true);
    await settle();
    assert(pending.seen() === 0, '29f: setup - History opened while the response is pending; nothing acknowledged yet');
    gP.resolve();
    await pending.started;
    await settle();
    assert(pending.seen() === 1 && pending.rows() === 2, '29g: the response arriving while History is displayed shows the results and acknowledges them once');

    // switching away during a pending response
    const gA = deferred();
    const away = await mountFull(true, { listGates: [gA.promise] });
    await settle();
    away.list.setVisible(false);
    gA.resolve();
    await away.started;
    await settle();
    assert(away.seen() === 0 && away.rows() === 2, '29i: switching away before the response arrives leaves the failure unacknowledged');
    away.list.setVisible(true);
    await settle();
    assert(away.seen() === 1, '29j: returning to History acknowledges it');

    // controls
    const control = await mountFull(true);
    await control.started;
    assert(control.seen() === 1 && control.rows() === 2, '29k: control - a displayed History panel acknowledges the displayed errors');
    const deep = createFeedbackList({ chrome: makeChrome({ session: [rec(), unnamedFailure()], history: [], local: {} }).chrome, FB }, { visible: true, focusId: 'op-ui-0001' });
    await deep.start();
    assert(deep.store.getState().focusId === 'op-ui-0001', '29l: an operation deep link keeps its focus id');
    const clean = await mountFull(false, { session: [rec({ filename: 'only-ok.jpg' })] });
    await clean.started;
    clean.list.setVisible(true);
    await settle();
    assert(clean.seen() === 0, '29m: with no unread failures nothing is ever acknowledged');

    // a failed acknowledgement is retried the next time History is displayed
    const flaky = await mountFull(false, { failMarkSeen: true });
    await flaky.started;
    flaky.list.setVisible(true);
    await settle();
    assert(flaky.seen() === 1 && /Не удалось загрузить результаты сохранения/.test(ru(flaky.list.store.getState().error)), '29n: a failed acknowledgement is reported');
    flaky.state.failMarkSeen = false;
    flaky.list.setVisible(false); flaky.list.setVisible(true);
    await settle();
    assert(flaky.seen() === 2 && flaky.list.store.getState().error === '', '29o: the pending acknowledgement is retried when History is shown again, then completes');
    flaky.list.setVisible(false); flaky.list.setVisible(true);
    await settle();
    assert(flaky.seen() === 2, '29p: and is not repeated afterwards');
    const disposed = await mountFull(true, { listGates: [(() => { const d = deferred(); setTimeout(d.resolve, 5); return d.promise; })()] });
    disposed.list.dispose();
    await disposed.started;
    await settle();
    assert(disposed.seen() === 0 && disposed.rows() === 0, '29q: a disposed list neither renders nor acknowledges');

    // clearing completed results
    const clr = await mountFull(true);
    await clr.started;
    clr.state.session.length = 0;
    await clr.list.clear();
    assert(clr.list.store.getState().records.length === 0 && clr.list.store.getState().unreadIds.length === 0 && clr.list.store.getState().focusId === '' && clr.list.store.getState().clearing === false, '29r: clearing empties the list and the unread markers');
    const bad = await mountFull(true);
    await bad.started;
    bad.state.failMessages = true;
    await bad.list.clear();
    assert(bad.list.store.getState().records.length === 2 && /Не удалось загрузить результаты сохранения/.test(ru(bad.list.store.getState().error)) && bad.list.store.getState().clearing === false, '29s: a failed clear keeps the list and says so');
    const broken = createFeedbackList({ chrome: makeChrome({ session: [], history: [], local: {}, failMessages: true }).chrome, FB }, {});
    await broken.start();
    assert(broken.store.getState().status === 'error' && /Не удалось загрузить результаты/.test(ru(broken.store.getState().error)), '29t: a messaging failure is shown as text, the page keeps working');
    const s2 = createStore({ n: 0 });
    let calls2 = 0;
    const un = s2.subscribe(() => { calls2++; });
    s2.setState({ n: 1 }); s2.setState((s) => ({ n: s.n + 1 })); un(); s2.setState({ n: 9 });
    assert(calls2 === 2 && s2.getState().n === 9, '29u: the observable store notifies subscribers until they unsubscribe');
  }

  // =================================================================================================
  console.log('\n--- 30. Design tokens: text contrast (WCAG 2.x) and motion ---');
  {
    const css = read('ui/src/index.css');
    const rootBlock = /:root\s*\{([^}]*)\}/.exec(css)[1];
    const tok = {};
    for (const m of rootBlock.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tok[m[1]] = m[2];
    const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const over = (fg, alpha, bg) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
    const C = (a, b) => contrast(rgb(tok[a]), rgb(tok[b]));
    const body = [['foreground', 'background'], ['foreground', 'card'], ['foreground', 'popover'], ['foreground', 'accent'], ['foreground', 'muted'], ['card-foreground', 'card'], ['popover-foreground', 'popover'], ['secondary-foreground', 'secondary'], ['accent-foreground', 'accent']];
    assert(body.every(([a, b]) => C(a, b) >= 7), `30a: body text on every surface has contrast >= 7:1 (min ${Math.min(...body.map(([a, b]) => C(a, b))).toFixed(2)})`);
    const secondary = [['muted-foreground', 'background'], ['muted-foreground', 'card'], ['muted-foreground', 'muted'], ['muted-foreground', 'popover'], ['muted-foreground', 'accent']];
    assert(secondary.every(([a, b]) => C(a, b) >= 4.5), `30b: secondary text on every surface has contrast >= 4.5:1 (min ${Math.min(...secondary.map(([a, b]) => C(a, b))).toFixed(2)})`);
    assert(C('primary-foreground', 'primary') >= 4.5, `30c: button text on the primary colour has contrast >= 4.5:1 (${C('primary-foreground', 'primary').toFixed(2)})`);
    const status = ['danger', 'success', 'warning', 'ring'];
    const surfaces = ['background', 'card', 'popover'];
    assert(status.every((s) => surfaces.every((b) => C(s, b) >= 4.5)), '30d: status text and link colours (danger, success, warning, link) have contrast >= 4.5:1 on every surface');
    assert(contrast([255, 255, 255], over(rgb(tok.destructive), 0.6, rgb(tok.card))) >= 4.5 && C('primary-foreground', 'destructive') >= 4.5, '30e: white text on the destructive badge/button (also at 60% opacity over a card) has contrast >= 4.5:1');
    assert(C('border', 'background') >= 1.3 && C('ring', 'background') >= 3, `30f: borders are visible and the focus ring has contrast >= 3:1 against the page (${C('ring', 'background').toFixed(2)})`);
    assert(/--danger/.test(css) && !/text-red-|text-destructive/.test(['quick-app', 'full-app', 'result-row', 'result-details', 'stats-card', 'settings-panels', 'history-panel', 'results-list'].map((n) => read(`ui/src/components/app/${n}.tsx`)).join('\n') + read('ui/src/components/ui/alert.tsx')), '30g: error text uses the checked danger colour, not the darker destructive fill');
    assert(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration:\s*0\.01ms !important[\s\S]*transition-duration:\s*0\.01ms !important/.test(css) && /motion-reduce:animate-none/.test(read('ui/src/components/app/result-row.tsx')) && !/animate-|transition-/.test(read('ui/src/components/ui/tooltip.tsx')), '30h: reduced-motion rules cover animated controls; the tooltip has no motion');
    assert(/color-scheme:\s*dark/.test(css) && /@custom-variant dark/.test(css) && /<html lang="en" class="dark">/.test(read('ui/popup.html')) && /<html lang="en" class="dark">/.test(read('ui/quick.html')) && /documentElement\.lang = value\.lang/.test(read('ui/src/hooks/use-i18n.tsx')), '30i: both pages are explicitly dark; the static lang is replaced at runtime by the interface language');
  }

  // =================================================================================================
  console.log('\n--- 31. UX-06: results and history refresh while the page stays open (storage events, no polling) ---');
  {
    const keys = await core('keys.js');
    const emit = (state, changes, area = 'session') => { for (const cb of (state.changeListeners || []).slice()) cb(changes, area); };
    const FEED = { [keys.FEEDBACK_KEY]: { newValue: {} } };
    const mount = async (over = {}, options = {}) => {
      const state = { session: [rec({ filename: 'first.jpg' })], history: [], local: { historyEnabled: true }, ...over };
      const made = makeChrome(state);
      const list = createFeedbackList({ chrome: made.chrome, FB }, { limit: 5, ...options });
      await list.start();
      return { state, ...made, list, rows: () => list.store.getState().records, count: (a) => made.calls.messages.filter((m) => m === a).length };
    };

    // the keys are the persistence keys of the tracker and of the history store
    const trackerLib = (() => { const sb = { URL, console }; vm.createContext(sb); vm.runInContext(read('lib/feedback.js'), sb); vm.runInContext(read('lib/feedback_tracker.js'), sb); vm.runInContext(read('lib/feedback_history.js'), sb); return sb; })();
    assert(keys.FEEDBACK_KEY === trackerLib.ImageSaverFeedbackTracker.STORAGE_KEY && keys.HISTORY_KEY === trackerLib.ImageSaverFeedbackHistory.STORAGE_KEY && keys.HISTORY_ENABLED_KEY === trackerLib.ImageSaverFeedbackHistory.ENABLED_KEY, '31a: the watched keys are the tracker and history persistence keys and the history preference key');

    // a new result, a transition, a failure and a cancellation appear without reopening
    const a = await mount();
    assert(a.rows().length === 1 && a.count('FEEDBACK_LIST') === 1 && (a.state.changeListeners || []).length === 1, '31b: one list request and exactly one storage subscription after the page started');
    a.state.session.push(rec({ state: 'saving', filename: 'second.jpg', filenameKind: 'intended', output: {} }));
    emit(a.state, FEED);
    await settle();
    assert(a.rows().length === 2 && a.rows()[0].filename === 'second.jpg' && a.rows()[0].state === 'saving' && a.count('FEEDBACK_LIST') === 2, '31c: a new in-progress result appears when the tracker storage changes');
    a.state.session[a.state.session.length - 1] = { ...a.state.session[a.state.session.length - 1], state: 'complete', updatedAt: Date.now() };
    emit(a.state, FEED);
    await settle();
    assert(a.rows()[0].state === 'complete' && a.count('FEEDBACK_LIST') === 3, '31d: the completion updates the same result in place');
    a.state.session.push(unnamedFailure());
    emit(a.state, FEED);
    await settle();
    const failedId = a.rows()[0].id;
    assert(a.rows()[0].state === 'failed' && a.list.store.getState().unreadIds.includes(failedId) && a.count('FEEDBACK_MARK_SEEN') === 1, '31e: a failure appears marked as new and, the list being visible, is acknowledged once');
    const failedIndex = a.state.session.length - 1;
    a.state.session[failedIndex] = { ...a.state.session[failedIndex], seen: true };
    emit(a.state, FEED);
    await settle();
    assert(a.count('FEEDBACK_MARK_SEEN') === 1 && a.list.store.getState().unreadIds.includes(failedId), '31f: the refresh caused by the acknowledgement does not acknowledge again and keeps the "new" mark of this session');
    a.state.session.push(rec({ state: 'cancelled', filename: 'cancelled.jpg', output: {}, failure: failure('save', 'cancelled') }));
    emit(a.state, FEED);
    await settle();
    assert(a.rows()[0].state === 'cancelled' && a.rows().length === 4, '31g: a cancellation appears');
    a.state.session.length = 0;
    emit(a.state, FEED);
    await settle();
    assert(a.rows().length === 0 && a.list.store.getState().status === 'ready' && a.list.store.getState().unreadIds.length === 0, '31h: a clear elsewhere empties the open list and its marks');

    // other changes are ignored
    const n0 = a.count('FEEDBACK_LIST');
    emit(a.state, { [keys.HISTORY_KEY]: {} }, 'local');
    emit(a.state, { notifySuccess: { newValue: false } }, 'local');
    emit(a.state, FEED, 'sync');
    emit(a.state, FEED, 'managed');
    emit(a.state, null);
    await settle();
    assert(a.count('FEEDBACK_LIST') === n0, '31i: another key, the history key, other storage areas and malformed events do not refresh the results');
    a.state.session.push(rec({ filename: 'local-fallback.jpg' }));
    emit(a.state, FEED, 'local');
    await settle();
    assert(a.rows().length === 1 && a.count('FEEDBACK_LIST') === n0 + 1, '31j: the tracker\'s local-storage fallback is watched too');

    // a hidden list renders but does not acknowledge; showing it does
    const hidden = await mount({ session: [rec()] }, { visible: false });
    hidden.state.session.push(unnamedFailure());
    emit(hidden.state, FEED);
    await settle();
    assert(hidden.rows().length === 2 && hidden.count('FEEDBACK_MARK_SEEN') === 0, '31k: a failure that arrives while the panel is hidden is shown and stays unacknowledged');
    hidden.list.setVisible(true);
    await settle();
    assert(hidden.count('FEEDBACK_MARK_SEEN') === 1, '31l: showing the panel acknowledges it once');

    // coalescing: never two requests at once, the newest answer wins
    const g0 = deferred();
    const g1 = deferred();
    const cState = { session: [rec({ filename: 'c-0.jpg' })], history: [], local: {}, listGates: [g0.promise, g1.promise] };
    const cMade = makeChrome(cState);
    let inFlight = 0;
    let peak = 0;
    const baseSend = cMade.chrome.runtime.sendMessage;
    cMade.chrome.runtime.sendMessage = async (m) => {
      if (m.action !== 'FEEDBACK_LIST') return baseSend(m);
      inFlight++; peak = Math.max(peak, inFlight);
      try { return await baseSend(m); } finally { inFlight--; }
    };
    const cList = createFeedbackList({ chrome: cMade.chrome, FB }, { limit: 5 });
    const started = cList.start();
    await settle();
    for (let i = 0; i < 5; i++) emit(cState, FEED); // five changes while the first request is pending
    cState.session.push(rec({ filename: 'c-1.jpg' }));
    g0.resolve();
    await settle();
    for (let i = 0; i < 3; i++) emit(cState, FEED); // three more while the second one is pending
    cState.session.push(rec({ filename: 'c-2.jpg' }));
    g1.resolve();
    await started;
    await settle();
    const reqC = cMade.calls.messages.filter((m) => m === 'FEEDBACK_LIST').length;
    assert(peak === 1 && reqC === 3 && cList.store.getState().records[0].filename === 'c-2.jpg', `31m: eight changes during two requests make ${reqC} requests in total, never two at once, and the newest answer is shown`);
    cList.dispose();

    // subscriptions: one per controller, removed on dispose, nothing after
    const sState = { session: [rec()], history: [], local: {} };
    const sMade = makeChrome(sState);
    const l1 = createFeedbackList({ chrome: sMade.chrome, FB }, { limit: 5 });
    await l1.start();
    await l1.start();
    assert((sState.changeListeners || []).length === 1, '31n: starting a controller twice does not add a second subscription');
    const l2 = createFeedbackList({ chrome: sMade.chrome, FB }, { limit: 5 });
    await l2.start();
    assert((sState.changeListeners || []).length === 2, '31o: two lists on two pages hold one subscription each');
    l1.dispose();
    assert((sState.changeListeners || []).length === 1, '31p: dispose removes the subscription');
    const before = sMade.calls.messages.length;
    sState.session.push(rec());
    emit(sState, FEED);
    await settle();
    assert(sMade.calls.messages.length === before + 1 && l2.store.getState().records.length === 2 && l1.store.getState().records.length === 1, '31q: only the living list is refreshed; the disposed one neither requests nor renders');
    l2.dispose();
    assert((sState.changeListeners || []).length === 0, '31r: no subscription is left');

    // a request in flight when the page goes away, and a superseded mount
    const gd = deferred();
    const dState = { session: [rec()], history: [], local: {}, listGates: [] };
    const dMade = makeChrome(dState);
    const dList = createFeedbackList({ chrome: dMade.chrome, FB }, { limit: 5 });
    await dList.start();
    dState.listGates.push(gd.promise);
    dState.session.push(unnamedFailure());
    emit(dState, FEED);
    await settle();
    dList.dispose();
    gd.resolve();
    await settle();
    assert(dList.store.getState().records.length === 1 && !dMade.calls.messages.includes('FEEDBACK_MARK_SEEN'), '31s: an answer that arrives after dispose is not rendered and acknowledges nothing');
    let activeNow = true;
    const eState = { session: [rec()], history: [], local: {} };
    const eMade = makeChrome(eState);
    const eList = createFeedbackList({ chrome: eMade.chrome, FB }, { limit: 5, isActive: () => activeNow });
    await eList.start();
    activeNow = false;
    eState.session.push(unnamedFailure());
    emit(eState, FEED);
    await settle();
    assert(eList.store.getState().records.length === 1 && !eMade.calls.messages.includes('FEEDBACK_MARK_SEEN'), '31t: a superseded mount neither renders a refresh nor acknowledges it');
    eList.dispose();

    // failing refreshes keep the page working
    const f = await mount();
    f.state.failMessages = true;
    emit(f.state, FEED);
    await settle();
    assert(f.rows().length === 1 && /Не удалось загрузить результаты/.test(ru(f.list.store.getState().error)) && f.list.store.getState().status === 'ready', '31u: a failed refresh keeps the shown list and says so');
    f.state.failMessages = false;
    f.state.session.push(rec({ filename: 'after-failure.jpg' }));
    emit(f.state, FEED);
    await settle();
    assert(f.rows().length === 2 && f.list.store.getState().error === '', '31v: the next successful refresh recovers');
    const earlyState = { session: [rec({ filename: 'late.jpg' })], history: [], local: {}, failMessages: true };
    const earlyMade = makeChrome(earlyState);
    const eList2 = createFeedbackList({ chrome: earlyMade.chrome, FB }, { limit: 5 });
    await eList2.start();
    assert(eList2.store.getState().status === 'error' && eList2.store.getState().records.length === 0, '31w: when the first load fails the page shows the error and no list');
    earlyState.failMessages = false;
    emit(earlyState, FEED);
    await settle();
    assert(eList2.store.getState().status === 'ready' && eList2.store.getState().records.length === 1 && eList2.store.getState().error === '', '31wa: the next change recovers the list without reopening the page');
    eList2.dispose();

    // the history: its key refreshes the records and the statistics inputs, the preference follows elsewhere
    const hState = { session: [], history: [rec()], local: { historyEnabled: true } };
    const hMade = makeChrome(hState);
    const hist = createHistory({ chrome: hMade.chrome, FB });
    await hist.start();
    assert(hist.store.getState().records.length === 1 && (hState.changeListeners || []).length === 1 && hist.stats().total === 1, '31x: the history starts with one subscription');
    hState.history.push(rec({ state: 'failed', output: {}, failure: failure('download', 'network') }));
    emit(hState, { [keys.HISTORY_KEY]: {} }, 'local');
    await settle();
    assert(hist.store.getState().records.length === 2 && hist.stats().total === 2 && hist.stats().failed === 1, '31y: an operation that finishes while the page is open appears in the history and its statistics');
    const hn = hMade.calls.messages.filter((m) => m === 'HISTORY_LIST').length;
    emit(hState, { [keys.HISTORY_KEY]: {} }, 'session');
    emit(hState, { [keys.FEEDBACK_KEY]: {} }, 'session');
    await settle();
    assert(hMade.calls.messages.filter((m) => m === 'HISTORY_LIST').length === hn, '31z: session-storage changes (the tracker) do not refresh the history');
    emit(hState, { historyEnabled: { newValue: false, oldValue: true } }, 'local');
    assert(hist.store.getState().enabled === false, '31za: switching recording elsewhere updates the switch');
    hState.history.length = 0;
    emit(hState, { [keys.HISTORY_KEY]: {} }, 'local');
    await settle();
    assert(hist.store.getState().records.length === 0 && present.statsView(FB, hist.store.getState().records, 'ok', false).state === 'empty', '31zb: a clear elsewhere empties the history and the statistics');
    hist.dispose();
    assert((hState.changeListeners || []).length === 0, '31zc: the history removes its subscription');

    // no polling anywhere in the refresh code
    const refreshSrc = ['feedbackList.js', 'history.js', 'keys.js'].map((n) => read(`ui/src/core/${n}`).replace(/\/\/.*$/gm, '')).join('\n');
    assert(!/setInterval|setTimeout|requestAnimationFrame|MutationObserver|IntersectionObserver/.test(refreshSrc), '31zd: no timer, animation frame or observer in the refresh code: events only');
  }

  // ---------------------------------------------------------------------------------------------------
  // 32. Regressions: settings lifecycle, path limits, failure inspectability, stats honest counting, nav fallbacks
  // ---------------------------------------------------------------------------------------------------
  console.log('\n--- 32. Regressions: settings lifecycle, path limits, failure inspectability, stats honest counting, nav fallbacks ---');
  {
    // 32a: createSettings.dispose() clears statusTimer and suppresses post-dispose state modifications
    let timerCleared = false;
    let scheduledCb = null;
    const fakeSetTimeout = (cb, ms) => { scheduledCb = cb; return 999; };
    const fakeClearTimeout = (id) => { if (id === 999) timerCleared = true; };
    const setDeps = {
      chrome: makeChrome({ local: {} }).chrome,
      FolderPath,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout
    };
    const sCtrl = createSettings(setDeps);
    await sCtrl.load();
    await sCtrl.save();
    assert(scheduledCb !== null, '32a: showMessage scheduled status auto-clear timer');
    sCtrl.dispose();
    assert(timerCleared, '32b: dispose immediately cleared status auto-clear timer');
    scheduledCb();
    assert(sCtrl.store.getState().status.message !== '', '32c: post-disposal timer callback leaves state untouched');

    // 32d: Subfolder path sanitization edge case: whitespace/slashes only -> root: '', changed: true
    const sState = { local: {} };
    const sMade = makeChrome(sState);
    const sEdge = createSettings({ chrome: sMade.chrome, FolderPath });
    await sEdge.load();
    sEdge.setField('subfolder', '   ///   ');
    const saveRes = await sEdge.save();
    assert(saveRes === true, '32d: saving whitespace/slashes root succeeds');
    assert(sState.local.subfolder === '', '32e: root normalized to empty string');
    assert(
      ru(sEdge.store.getState().status.message).includes('Загрузки'),
      '32f: status message reports fallback to default Загрузки directory'
    );

    // 32g: Path limit rejections: excessive depth (>8) and excessive length (>120) fail closed without writing storage
    sEdge.setField('subfolder', '1/2/3/4/5/6/7/8/9');
    assert(sEdge.preview().error === true, '32g: preview flags 9-folder depth as error');
    assert(
      sEdge.preview().text.includes('Слишком много вложенных папок'),
      '32h: preview explains depth limit'
    );
    const writeCallsBefore = sMade.calls.localSets.length;
    const saveDepthFail = await sEdge.save();
    assert(saveDepthFail === false, '32i: saving excessive depth rejected');
    assert(sMade.calls.localSets.length === writeCallsBefore, '32j: storage.local.set not called when depth rejected');

    sEdge.setField('subfolder', 'a'.repeat(121));
    assert(sEdge.preview().error === true, '32k: preview flags >120 chars as error');
    assert(
      sEdge.preview().text.includes('Слишком длинный путь'),
      '32l: preview explains length limit'
    );
    const saveLenFail = await sEdge.save();
    assert(saveLenFail === false, '32m: saving excessive length rejected');
    assert(sMade.calls.localSets.length === writeCallsBefore, '32n: storage.local.set not called when length rejected');

    // 32o: Preview path generation with empty root across organization modes
    sEdge.setField('subfolder', '');
    sEdge.setField('folderOrganizationMode', 'single');
    assert(sEdge.preview().text === 'Загрузки/photo.jpg', '32o: empty subfolder in single mode shows Загрузки/photo.jpg');
    sEdge.setField('folderOrganizationMode', 'by_site_and_type');
    assert(sEdge.preview().text === 'Загрузки/x/pic/photo.jpg', '32p: empty subfolder in by_site_and_type mode shows Загрузки/x/pic/photo.jpg');

    // 32q: setNotifySuccess recovery from storage errors
    const notifyState = { local: {}, failSet: true };
    const notifyMade = makeChrome(notifyState);
    const notifyCtrl = createSettings({ chrome: notifyMade.chrome, FolderPath });
    await notifyCtrl.load();
    await notifyCtrl.setNotifySuccess(false);
    assert(notifyCtrl.store.getState().notify.checked === true, '32q: failed notify toggle reverts checkbox state');
    assert(
      ru(notifyCtrl.store.getState().notify.error).includes('Не удалось сохранить настройку'),
      '32r: failed notify toggle shows Russian error message'
    );
    notifyState.failSet = false;
    await notifyCtrl.setNotifySuccess(false);
    assert(notifyCtrl.store.getState().notify.checked === false, '32s: subsequent successful notify toggle updates state');
    assert(notifyCtrl.store.getState().notify.error === '', '32t: subsequent success clears error message');

    // 32u: Disallowed share host normalization on load and save
    const hostState = {
      local: {
        xShareHost: 'evil-x.com',
        igShareHost: 'bad-instagram.com',
        ttShareHost: 'malicious-tiktok.com',
        youtubeShareHost: 'attacker-youtube.com'
      }
    };
    const hostMade = makeChrome(hostState);
    const hostCtrl = createSettings({ chrome: hostMade.chrome, FolderPath });
    await hostCtrl.load();
    assert(hostCtrl.store.getState().xShareHost === 'x.com', '32u: load normalizes invalid xShareHost to default');
    assert(hostCtrl.store.getState().igShareHost === 'instagram.com', '32v: load normalizes invalid igShareHost to default');
    assert(hostCtrl.store.getState().ttShareHost === 'tiktok.com', '32w: load normalizes invalid ttShareHost to default');
    assert(hostCtrl.store.getState().youtubeShareHost === 'youtube.com', '32x: load normalizes invalid youtubeShareHost to default');

    hostCtrl.setField('youtubeShareHost', 'hacker.org');
    await hostCtrl.save();
    assert(hostState.local.youtubeShareHost === 'youtube.com', '32y: save sanitizes unapproved youtube share host to default');

    // 32z: Inspectable failure details across stages (download error, convert error code)
    const downloadFailRec = rec({
      state: 'failed',
      site: 'youtube.com',
      filename: 'short.mp4',
      failure: failure('download', 'download_interrupted', { downloadError: 'SERVER_BAD_CONTENT' })
    });
    assert(present.hasReport(downloadFailRec) === true, '32z: failed record offers bug report');
    const dlReport = present.buildReportText(FB, downloadFailRec, 'User note', { version: '2.0.0', browser: 'Chromium' });
    assert(dlReport.includes('SERVER_BAD_CONTENT'), '32za: report text preserves specific downloadError code');
    assert(dlReport.includes('download_interrupted'), '32zb: report text preserves failure category');

    const convertFailRec = rec({
      state: 'failed',
      site: 'reddit.com',
      failure: failure('convert', 'conversion_failed', { code: 'FFMPEG_TIMEOUT' })
    });
    const convReport = present.buildReportText(FB, convertFailRec, '', { version: '2.0.0', browser: 'Chromium' });
    assert(convReport.includes('FFMPEG_TIMEOUT'), '32zc: report text preserves conversion failure code');

    // 32zd: hasReport rejects complete and cancelled records
    const completeRec = rec({ state: 'complete' });
    const cancelledRec = rec({ state: 'cancelled' });
    assert(present.hasReport(completeRec) === false, '32zd: complete record has no bug report');
    assert(present.hasReport(cancelledRec) === false, '32ze: cancelled record has no bug report');

    // 32zf: Honest stats counting with zero sizeBytes, estimated sizes, and missing sizes
    const zeroSizeRec = rec({
      state: 'complete',
      output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', sizeBytes: 0, sizeKind: 'measured' }
    });
    const estSizeRec = rec({
      state: 'complete',
      output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', sizeBytes: 50000, sizeKind: 'estimated' }
    });
    const missingSizeRec = rec({
      state: 'complete',
      output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', sizeBytes: null, sizeKind: 'none' }
    });
    const statsMixed = FB.computeStats([zeroSizeRec, estSizeRec, missingSizeRec]);
    assert(statsMixed.total === 3, '32zf: stats total is 3');
    assert(statsMixed.success === 3, '32zg: stats success count is 3');
    assert(statsMixed.size.measuredCount === 1, '32zh: exactly 1 measured size (zero size included)');
    assert(statsMixed.size.knownBytes === 0, '32zi: knownBytes is 0');
    assert(statsMixed.size.estimatedCount === 1, '32zj: exactly 1 estimated size');
    assert(statsMixed.size.missingCount === 1, '32zk: exactly 1 missing size');

    const mixedView = present.statsView(FB, [zeroSizeRec, estSizeRec, missingSizeRec], 'ok', true);
    assert(mixedView.sizeText.includes('не менее 0 Б'), '32zl: statsView formats zero measured size truthfully');
    assert(mixedView.sizeText.includes('оценки по заголовкам (1) не суммируются'), '32zm: statsView notes estimated exclusion');
    assert(mixedView.sizeText.includes('размер неизвестен у 1'), '32zn: statsView notes missing count');

    // 32zo: All successful saves missing size -> sizeText is 'неизвестен'
    const missingOnlyView = present.statsView(FB, [missingSizeRec], 'ok', true);
    assert(missingOnlyView.sizeText.includes('неизвестен'), '32zo: missing sizes only reports unknown summary size');

    // 32zp: Navigation deep link resolution and parameter precedence
    assert(
      nav.sectionFromLocation({ search: '?op=op-999&section=saving', hash: '#embed' }) === 'history',
      '32zp: ?op= query overrides ?section= and hash'
    );
    assert(
      nav.sectionFromLocation({ search: '?section=embed', hash: '#saving' }) === 'embed',
      '32zq: ?section= query overrides hash'
    );
    assert(
      nav.sectionFromLocation({ hash: '#notifications' }) === 'notifications',
      '32zr: valid hash selects section'
    );
    assert(
      nav.sectionFromLocation({ search: '?section=nonexistent', hash: '#unknown' }) === 'history',
      '32zs: unknown section and hash falls back to default history'
    );
    assert(
      nav.focusIdFromLocation({ search: '?op=op%2Fwith%20spaces%23hash' }) === 'op/with spaces#hash',
      '32zt: focusIdFromLocation correctly decodes URI components'
    );
    assert(
      nav.pageUrl(makeChrome({}).chrome, 'nonexistent').endsWith('#history'),
      '32zu: pageUrl with invalid section falls back to #history'
    );
    assert(
      nav.operationUrl(makeChrome({}).chrome, 'op/with spaces').includes('op=op%2Fwith%20spaces'),
      '32zv: operationUrl encodes special characters in id'
    );
  }

  // ---------------------------------------------------------------------------------------------------
  console.log('\n--- 33. UI-LOCALIZATION-01: English / Russian catalogue, language preference and translated views ---');
  {
    const { createLanguage, LANGUAGE_KEY } = await core('language.js');
    const placeholders = (s) => (s.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(',');
    const enKeys = Object.keys(I18n.STRINGS.en).sort();
    const ruKeys = Object.keys(I18n.STRINGS.ru).sort();
    assert(JSON.stringify(enKeys) === JSON.stringify(ruKeys) && enKeys.length > 150, `33a: both languages define exactly the same ${enKeys.length} keys`);
    assert(enKeys.every((k) => placeholders(I18n.STRINGS.en[k]) === placeholders(I18n.STRINGS.ru[k])), '33b: every key has the same placeholders in both languages');
    assert(enKeys.every((k) => I18n.STRINGS.en[k].trim() && I18n.STRINGS.ru[k].trim() && !/<[a-z/!]/i.test(I18n.STRINGS.en[k] + I18n.STRINGS.ru[k])), '33c: no empty text and no markup in the catalogue (texts are rendered as text)');
    const same = enKeys.filter((k) => I18n.STRINGS.en[k] === I18n.STRINGS.ru[k]);
    assert(JSON.stringify(same) === JSON.stringify(['stats.type.gif', 'tab.embed', 'type.gif']), '33d: every text is translated except names that are the same in both languages: ' + same.join(', '));
    assert(I18n.MENU_TITLE === 'Image Saver: Save media' && !enKeys.some((k) => /Save (image|video|GIF)\b/.test(I18n.STRINGS.en[k]) && /^menu/.test(k)), '33e: the native menu title is the fixed "Image Saver: Save media" in both languages (no per-type titles)');
    // keys used by the sources exist in the catalogue
    const uiSrc = ['ui/src/components/app', 'ui/src/core', 'ui/src/hooks'].flatMap((d) => fs.readdirSync(path.resolve(ROOT, d)).map((f) => read(`${d}/${f}`))).join('\n')
      + ['content_x.js', 'content_reddit.js', 'content_redgifs.js', 'content_instagram.js', 'content_tiktok.js', 'content_youtube.js', 'lib/feedback_tracker.js'].map(read).join('\n');
    const used = new Set([...uiSrc.matchAll(/\b(?:t|isText|tr\.t|text)\(\s*["'`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)["'`]/g)].map((m) => m[1]));
    // every quoted key-shaped string whose first segment is a catalogue prefix (stored messages, EMBED_FIELDS labels, status keys)
    const prefixes = new Set(enKeys.map((k) => k.split('.')[0]));
    const stored = new Set([...uiSrc.matchAll(/["'`]([a-z]+(?:\.[A-Za-z0-9]+)+)["'`]/g)].map((m) => m[1]).filter((k) => prefixes.has(k.split('.')[0]) && !/\.(js|mjs|tsx?|json|html|com|pw|cr|png|jpg)$/.test(k)));
    const missing = [...used, ...stored].filter((k) => !Object.prototype.hasOwnProperty.call(I18n.STRINGS.en, k) && !/^(tab|embed)\.\$/.test(k));
    assert(used.size > 60 && stored.size > 100 && missing.length === 0, `33f: every catalogue key used in the sources exists (${used.size} direct uses, ${stored.size} key strings): ${missing.slice(0, 8).join(', ')}`);

    // interpolation and fallbacks
    assert(I18n.t('en', 'updates.installed', { version: '2.0.0.25' }) === 'Installed version: 2.0.0.25' && I18n.t('ru', 'updates.installed', { version: '2.0.0.25' }) === 'Установленная версия: 2.0.0.25', '33g: placeholders are substituted in both languages');
    assert(I18n.t('en', 'filename.actual', { name: '{name} <b>x</b> $& $1' }) === 'File name: {name} <b>x</b> $& $1 (actual, reported by Chrome)', '33h: a substituted value is inserted literally (no second substitution, no $-patterns, no markup interpretation)');
    assert(I18n.t('en', 'updates.installed') === 'Installed version: {version}' && I18n.t('de', 'results.empty') === 'No save results yet.' && I18n.t('ru', 'no.such.key') === 'no.such.key', '33i: a missing value keeps its placeholder; an unknown language uses English; an unknown key is shown as itself');
    assert(I18n.message('en', '') === '' && I18n.message('en', 'history.cleared') === 'History cleared.' && I18n.message('ru', { key: 'settings.error.tooDeep', vars: { max: 8 } }) === 'Слишком много вложенных папок (максимум 8)', '33j: stored messages (key or { key, vars }) render in the requested language');

    // the default rule: a valid saved choice wins; otherwise Russian only for a Russian browser
    assert(['ru', 'ru-RU', 'RU', 'ru_RU'].every((u) => I18n.browserDefault(u) === 'ru') && ['en', 'en-US', 'de-DE', 'uk', 'rus', '', undefined, null].every((u) => I18n.browserDefault(u) === 'en'), '33k: Russian browser -> ru, every other or unknown browser language -> en');
    assert(I18n.resolve('en', 'ru') === 'en' && I18n.resolve('ru', 'en-US') === 'ru' && ['EN', 'de', 1, null, undefined, {}, ''].every((v) => I18n.resolve(v, 'ru-RU') === 'ru' && I18n.resolve(v, 'fr') === 'en'), '33l: a saved valid choice wins; an invalid saved value is ignored');
    assert(I18n.locale('ru') === 'ru-RU' && I18n.locale('en') === 'en-US', '33m: dates and numbers use the locale of the language');

    // Inline text and accessible names stay current even inside closed shadow roots. Narrow/hidden actions must stay narrow/hidden.
    const inlineListeners = [];
    const labels = I18n.follow({
      i18n: { getUILanguage: () => 'en' },
      storage: { onChanged: { addListener: (cb) => inlineListeners.push(cb) } }
    }, null, () => {});
    const inlineNode = { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
    const inlineChange = (lang) => inlineListeners.forEach((cb) => cb({ uiLanguage: { newValue: lang } }, 'local'));
    labels.label(inlineNode, 'textContent', 'inline.saveAll', { n: 2 });
    labels.label(inlineNode, 'title', 'inline.saveAllAria', { n: 2 });
    inlineChange('ru');
    assert(inlineNode.textContent === 'Все (2)' && inlineNode.attrs.title.endsWith('(2)'), '33inline-a: existing count text and accessible names switch together');
    labels.label(inlineNode, 'textContent', 'inline.saveAll', { n: 5 });
    inlineChange('en');
    assert(inlineNode.textContent === 'Save all (5)', '33inline-b: relabelling uses the latest media count');
    labels.label(inlineNode, 'textContent', null, null, '5');
    labels.label(inlineNode, 'title', null, null, null);
    inlineChange('ru');
    assert(inlineNode.textContent === '5' && !('title' in inlineNode.attrs), '33inline-c: a switch preserves compact counts and removed titles');
    labels.label(inlineNode, 'title', 'inline.copied');
    inlineChange('en');
    assert(inlineNode.attrs.title === '✓ Link copied!', '33inline-d: a switch keeps the current success state instead of restoring the idle label');

    // the language controller
    const langPage = (local, extra = {}) => {
      const state = { local: { ...local }, ...extra };
      const made = makeChrome(state);
      made.chrome.i18n = { getUILanguage: () => (extra.ui === undefined ? 'ru-RU' : extra.ui) };
      return { state, made, lang: createLanguage({ chrome: made.chrome }) };
    };
    let L = langPage({});
    await L.lang.ready;
    assert(L.lang.store.getState().lang === 'ru' && L.lang.store.getState().error === '' && L.made.calls.localSets.length === 0, '33n: no saved choice and a Russian browser -> Russian, nothing is written');
    L = langPage({}, { ui: 'en-GB' });
    await L.lang.ready;
    assert(L.lang.store.getState().lang === 'en', '33o: no saved choice and a non-Russian browser -> English');
    L = langPage({ [LANGUAGE_KEY]: 'en' });
    await L.lang.ready;
    assert(LANGUAGE_KEY === 'uiLanguage' && L.lang.store.getState().lang === 'en', '33p: a saved English choice wins over a Russian browser');
    L = langPage({ [LANGUAGE_KEY]: 'fr' });
    await L.lang.ready;
    assert(L.lang.store.getState().lang === 'ru' && L.state.local.uiLanguage === 'fr' && L.made.calls.localSets.length === 0, '33q: an invalid saved value is ignored and not rewritten');
    L = langPage({ [LANGUAGE_KEY]: 'en' }, { failGet: true });
    await L.lang.ready;
    assert(L.lang.store.getState().lang === 'ru' && L.lang.store.getState().error === 'lang.readFailed' && L.made.calls.localSets.length === 0 && L.state.local.uiLanguage === 'en', '33r: an unreadable preference shows the browser language, says so and writes nothing (the saved value is kept)');
    // en -> ru -> en with persistence
    L = langPage({}, { ui: 'en-US' });
    await L.lang.ready;
    assert(await L.lang.setLanguage('ru') === true && L.lang.store.getState().lang === 'ru' && L.state.local.uiLanguage === 'ru', '33s: en -> ru: saved, then shown');
    assert(await L.lang.setLanguage('en') === true && L.lang.store.getState().lang === 'en' && L.state.local.uiLanguage === 'en' && JSON.stringify(L.made.calls.localSets) === JSON.stringify([{ uiLanguage: 'ru' }, { uiLanguage: 'en' }]), '33t: ru -> en: saved, then shown; only the language key is written');
    const reopened = createLanguage({ chrome: L.made.chrome });
    await reopened.ready;
    assert(reopened.store.getState().lang === 'en', '33u: a reopened page (or a restarted browser) reads the saved choice');
    assert(await L.lang.setLanguage('de') === false && L.made.calls.localSets.length === 2, '33v: an unsupported language is refused without a write');
    // a failed write keeps the previous language and reports it, never a success state
    L.state.failSet = true;
    assert(await L.lang.setLanguage('ru') === false && L.lang.store.getState().lang === 'en' && L.lang.store.getState().error === 'lang.saveFailed' && L.lang.store.getState().saving === false && L.state.local.uiLanguage === 'en', '33w: a failed write keeps the previous language, reports the failure and leaves the stored value intact');
    L.state.failSet = false;
    assert(await L.lang.setLanguage('ru') === true && L.lang.store.getState().error === '', '33x: a later successful write clears the failure');
    // a change on another extension page applies live; an older read never overrides it
    const other = createLanguage({ chrome: L.made.chrome });
    await other.ready;
    await L.made.chrome.storage.local.set({ uiLanguage: 'en' });
    assert(other.store.getState().lang === 'en' && L.lang.store.getState().lang === 'en', '33y: a change made on another page applies to every open page');
    await L.made.chrome.storage.local.set({ uiLanguage: 'ru' });
    await L.made.chrome.storage.local.set({ uiLanguage: 'xx' });
    assert(other.store.getState().lang === 'en', '33z: an invalid value written elsewhere falls back to the browser language (English here)');
    const gateState = { local: { uiLanguage: 'ru' } };
    let releaseGate;
    gateState.getGate = new Promise((r) => { releaseGate = r; });
    const gm = makeChrome(gateState);
    gm.chrome.i18n = { getUILanguage: () => 'en' };
    const slow = createLanguage({ chrome: gm.chrome });
    delete gateState.getGate;
    await gm.chrome.storage.local.set({ uiLanguage: 'en' });
    releaseGate();
    await slow.ready;
    assert(slow.store.getState().lang === 'en', '33za: an older, slower read does not override a newer change');
    const concurrent = langPage({ uiLanguage: 'en' });
    await concurrent.lang.ready;
    const commitLanguage = concurrent.made.chrome.storage.local.set;
    let finishLanguageWrite;
    const writeCompletion = new Promise((r) => { finishLanguageWrite = r; });
    concurrent.made.chrome.storage.local.set = async (value) => { await commitLanguage(value); await writeCompletion; };
    const olderWrite = concurrent.lang.setLanguage('ru');
    await new Promise(setImmediate);
    await commitLanguage({ uiLanguage: 'en' }); // another page committed a newer choice before the older completion arrived
    finishLanguageWrite();
    await olderWrite;
    assert(concurrent.lang.store.getState().lang === 'en' && concurrent.state.local.uiLanguage === 'en' && concurrent.lang.store.getState().saving === false, '33race: an older write completion cannot override a newer language change from another page');
    concurrent.lang.dispose();
    other.dispose();
    const before = (L.state.changeListeners || []).length;
    reopened.dispose();
    assert((L.state.changeListeners || []).length === before - 1, '33zb: dispose removes the storage subscription');

    // a language switch does not touch unsaved settings edits
    const sState = { local: {} };
    const sm = makeChrome(sState);
    sm.chrome.i18n = { getUILanguage: () => 'en' };
    const sCtl = createSettings({ chrome: sm.chrome, FolderPath });
    const sLang = createLanguage({ chrome: sm.chrome });
    await sCtl.load();
    await sLang.ready;
    sCtl.setField('subfolder', 'Unsaved/Edit');
    sCtl.setField('xShareHost', 'fixupx.com');
    await sLang.setLanguage('ru');
    await sLang.setLanguage('en');
    assert(sCtl.store.getState().subfolder === 'Unsaved/Edit' && sCtl.store.getState().xShareHost === 'fixupx.com' && JSON.stringify(sm.calls.localSets) === JSON.stringify([{ uiLanguage: 'ru' }, { uiLanguage: 'en' }]), '33zc: switching the language keeps unsaved settings edits and writes only the language');
    assert(sCtl.preview('en').text === 'Downloads/Unsaved/Edit/photo.jpg' && sCtl.preview('ru').text === 'Загрузки/Unsaved/Edit/photo.jpg', '33zd: the example path follows the language; the folder name stays as typed');
    sCtl.setField('subfolder', '1/2/3/4/5/6/7/8/9');
    assert(sCtl.preview('en').text === 'Too many nested folders (maximum 8)' && sCtl.preview('ru').text === 'Слишком много вложенных папок (максимум 8)', '33ze: validation messages are translated with their limits');

    // translated views of the same structured record (persisted records hold no text)
    const okRec = rec({ filename: 'Фото «оригинал».jpg', output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', mime: 'image/jpeg', sizeBytes: 1004544, sizeKind: 'measured' } });
    const failRec = rec({ state: 'failed', filename: '', filenameKind: '', output: {}, failure: failure('verify', 'server_error', { status: 500, code: 'HTTP_500' }) });
    const enRow = present.rowParts(FB, okRec, 'en');
    const ruRow = present.rowParts(FB, okRec, 'ru');
    assert(enRow.name === 'Фото «оригинал».jpg' && ruRow.name === enRow.name && enRow.meta === 'Saved — example.com · image .jpg' && ruRow.meta === 'Сохранено — example.com · изображение .jpg', '33zf: a row is presented in the selected language; the original file name is kept as it is');
    const enSum = FB.summarize(failRec, 'en');
    assert(enSum.title === 'Server error' && /HTTP error 500/.test(enSum.explanation) && enSum.lines.includes('Stage: checking the content') && enSum.lines.includes('HTTP status: 500') && enSum.lines.includes('Code: HTTP_500') && FB.summarize(failRec).title === 'Ошибка сервера', '33zg: failure details translate while diagnostic codes and statuses stay intact');
    assert(FB.formatSize(1004544, 'en') === '981 KB' && FB.formatSize(1004544, 'ru') === '981 КБ' && FB.formatSize(1536, 'en') === '1.5 KB' && FB.formatSize(1536, 'ru') === '1,5 КБ' && FB.formatSize(1536) === '1,5 КБ', '33zh: sizes use the unit and decimal mark of the language');
    assert(present.filenameLine(okRec, 'en') === 'File name: Фото «оригинал».jpg (actual, reported by Chrome)', '33zi: the file-name line is translated around the unchanged name');
    const enStats = present.statsView(FB, [okRec, failRec], 'ok', true, 'en');
    assert(enStats.tiles[0].label === 'Operations in history' && /^Known total size: at least 981 KB\. Size measured for 1 of 1 successful saves\.$/.test(enStats.sizeText) && /50 operations/.test(enStats.note), '33zj: statistics are presented in English');
    assert(FB.buildReport(failRec, { env: { version: '2.0.0' } }) === FB.buildReport(failRec, { env: { version: '2.0.0' } }) && /^Image Saver bug report\n/.test(FB.buildReport(failRec, { env: { version: '2.0.0' } })) && /http_status: 500/.test(FB.buildReport(failRec, { env: { version: '2.0.0' } })), '33zk: the copied bug report keeps its single format');
    const t0 = Date.UTC(2026, 9, 10, 15, 5);
    assert(present.formatDateTime(t0, 'en-US') !== present.formatDateTime(t0, 'ru-RU') && /\d/.test(present.formatTime(t0, 'en-US')), '33zl: dates are formatted with the locale of the language');

    // notifications follow the saved language (service worker notifier)
    const trackerCtx = (() => { const sb = { URL, console }; vm.createContext(sb); for (const f of ['lib/i18n.js', 'lib/feedback.js', 'lib/feedback_tracker.js']) vm.runInContext(read(f), sb); return sb; })();
    const notifyWith = async (deps) => {
      const sink = [];
      const notify = trackerCtx.ImageSaverFeedbackTracker.createNotifier({ getPrefs: async () => ({ notifySuccess: true }), notifications: { create: async (id, o) => { sink.push(o); return id; } }, iconUrl: 'i.png', ...deps });
      await notify(trackerCtx.ImageSaverFeedback.sanitizeRecord(JSON.parse(JSON.stringify(failRec))));
      await notify(trackerCtx.ImageSaverFeedback.sanitizeRecord(JSON.parse(JSON.stringify(okRec))));
      return sink;
    };
    let n = await notifyWith({ getLang: async () => 'en' });
    assert(n[0].title === 'Image Saver: Server error' && n[0].contextMessage === 'Click to open the details' && n[1].title === 'example.com: saved' && !/Resource/.test(n[1].message), '33zm: a saved English choice gives English notifications');
    n = await notifyWith({ getLang: async () => 'ru' });
    assert(n[0].title === 'Image Saver: Ошибка сервера' && n[0].contextMessage === 'Нажмите, чтобы открыть подробности' && n[1].title === 'example.com: сохранено' && !/Ресурс/.test(n[1].message), '33zn: a saved Russian choice gives Russian notifications');
    n = await notifyWith({ getLang: async () => { throw new Error('UNREADABLE'); } });
    assert(n[0].title === 'Image Saver: Server error', '33zo: an unreadable choice falls back to the browser rule (no Russian browser here -> English) and the notification is still shown');
    n = await notifyWith({ getLang: async () => 'de' });
    assert(n.length === 2 && n[1].title === 'example.com: saved', '33zp: an invalid saved value falls back to the browser rule');
  }

  console.log(`\nИТОГИ: ${passed}/${passed + failed} пройдено (${failed} ошибок).`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Ошибка в тестовом сценарии:', err);
  process.exit(1);
});
