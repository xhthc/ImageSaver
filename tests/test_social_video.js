'use strict';
// TT-IG-VIDEO-01: the selected TikTok video / Instagram Reel through the browser menu "MediaLatch: Save media".
// SYNTHETIC: jsdom pages built from the structure observed live on 2026-10-17 (local-notes/checks/tt-ig-video01/discovery/discovery.md).
// React fibers, layout, hit tests and trusted input are simulated; the network and the export are stand-ins. The production capture
// (content/content_context_target.js), admission (background.js onContextMenuClicked) and resolution (worker/providers.js,
// worker/site_resolvers.js) run unchanged. No live-site, real-file or audio claim.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict'), { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '..'), { JSDOM } = createRequire(path.join(ROOT, 'ui/package.json'))('jsdom');
const { createTestEnv } = require('./test_context_target_avatar');
const code = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };

const TT_PAGE = 'https://www.tiktok.com/@seyro67/video/7695998843653082388';
const TT_URL = 'https://v16-webapp-prime.tiktok.com/video/tos/alisg/tos-alisg-pve-0037/oSELECTED/?a=1988&expire=1792400000&policy=2&signature=EXACT%2Bsig%3D&btag=e000';
const TT_NEIGHBOUR = 'https://v16-webapp-prime.tiktok.com/video/tos/alisg/tos-alisg-pve-0037/oNEIGHBOUR/?expire=1792400000&signature=OTHER';
const IG_PAGE = 'https://www.instagram.com/reels/DefTURuSN2j/';
const IG_URL = 'https://scontent-fra3-1.cdninstagram.com/o1/v/t2/f2/m86/AQSELECTED.mp4?efg=eyJ2%3D&_nc_ht=x&oh=00_EXACT%2B&oe=6A1B2C3D';
const IG_NEIGHBOUR = 'https://scontent-fra3-1.cdninstagram.com/o1/v/t2/f2/m86/AQNEIGHBOUR.mp4?oh=00_OTHER&oe=6A1B2C3D';
const IG_PK = '4008007149686414755', IG_PK_B = '4009007149686320459';
const MP4 = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x6d, 0x70, 0x34, 0x31, 0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65, 0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]); // synthetic: ftyp + free + empty mdat

const tiktokHtml = ({ itemId = '7695998843653082388', permalink = false } = {}) => `<main>
  <div data-e2e="recommend-list-item-container" id="item-a">${permalink ? `<a href="/@seyro67/video/${itemId}">post</a>` : ''}
    <div id="xgwrapper-0-${itemId}" data-e2e="feed-video"><div class="host"><div class="xg"><video id="media" data-stream="blob:https://www.tiktok.com/aaaa-selected"></video></div></div></div></div>
  <div data-e2e="recommend-list-item-container" id="item-b">
    <div id="xgwrapper-0-7695725156328557856" data-e2e="feed-video"><div class="host"><div class="xg"><video id="neighbour" data-stream="blob:https://www.tiktok.com/bbbb-neighbour"></video></div></div></div></div>
</main>`;
const igJson = (items) => `<script type="application/json">${JSON.stringify({ require: [['ScheduledServerJS', 'handle', null, [{ result: { data: { xig_logged_out_reels_feed: { edges: items.map((node) => ({ node })) } } } }]]] })}</script>`;
const igItem = (pk, code, url, extra = {}) => ({ pk, code, user: { username: 'errejotapodcast' }, has_audio: true, video_versions: [101, 102, 103].map((type) => ({ type, width: 720, height: 1280, url })), video_dash_manifest: '<MPD/>', ...extra });
// as observed live: the pressed overlay and its video meet only 5 levels above the overlay, so the overlay's parent holds no video
const instagramHtml = ({ items = [igItem(IG_PK, 'DefTURuSN2j', IG_URL), igItem(IG_PK_B, 'Dekcw6PxDML', IG_NEIGHBOUR)], twoAtPoint = false } = {}) => `${igJson(items)}<main>
  <div class="reel" id="reel-a"><div><div><div><div class="player"><video id="media" data-stream="blob:https://www.instagram.com/aaaa-selected"></video></div></div></div></div>
    ${twoAtPoint ? '<div><video id="twin" data-stream="blob:https://www.instagram.com/cccc-twin"></video></div>' : ''}<div><div><div><div><div class="overlay" id="overlay-a"></div></div></div></div></div></div>
  <div class="reel" id="reel-b"><div><div><div><div class="player"><video id="neighbour" data-stream="blob:https://www.instagram.com/bbbb-neighbour"></video></div></div></div></div><div><div><div><div><div class="overlay" id="overlay-b"></div></div></div></div></div></div>
</main>`;

function page({ url, html, settings = {}, inline = false, docId = 'doc-1' }) {
  const env = createTestEnv(), s = env.bgSandbox, dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window, d = w.document;
  const rects = new WeakMap(), listeners = [];
  const p = { w, d, s, rects, exported: [], fetched: [], failures: [], scripts: [], status: 206, docId };
  p.records = () => vm.runInContext('feedbackTracker.list()', env.bgContext);
  for (const v of d.querySelectorAll('video')) Object.defineProperty(v, 'currentSrc', { configurable: true, get() { return this.getAttribute('data-stream') || ''; } });
  const box = (id, b) => { const el = d.getElementById(id) || d.querySelector(id); if (el) rects.set(el, b); };
  const A = { left: 100, top: 80, width: 446, height: 795 }, B = { left: 100, top: 906, width: 446, height: 795 };
  for (const id of ['media', 'overlay-a', 'twin']) box(id, A);
  for (const id of ['neighbour', 'overlay-b']) box(id, B);
  for (const el of d.querySelectorAll('[id^="xgwrapper-"]')) rects.set(el, el.contains(d.getElementById('media')) ? A : B);
  p.scroll = (dy) => { for (const el of d.querySelectorAll('*')) { const b = rects.get(el); if (b) rects.set(el, { ...b, top: b.top - dy }); } };
  w.Element.prototype.getBoundingClientRect = function () { const b = rects.get(this) || { left: 0, top: 0, width: 0, height: 0 }; return { ...b, right: b.left + b.width, bottom: b.top + b.height }; };
  const stack = (x, y) => [...d.querySelectorAll('*')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom; }).reverse();
  d.elementsFromPoint = stack; d.elementFromPoint = (x, y) => stack(x, y)[0] || null;
  // trusted input is simulated: an event a test marks testTrusted is reported trusted to the page's listeners (the content script's too)
  const wrappers = new WeakMap(), add = w.EventTarget.prototype.addEventListener;
  w.EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (!wrappers.has(fn)) wrappers.set(fn, (e) => fn(new Proxy(e, { get: (t, k) => (k === 'isTrusted' ? t.testTrusted === true : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) })));
    return add.call(this, type, wrappers.get(fn), opts);
  };
  // React fibers of the observed shape (memoizedProps / return), set on the elements the page's React owns
  p.fiber = (el, chain) => { let f = null; for (const props of [...chain].reverse()) f = { memoizedProps: props, return: f }; el['__reactFiber$test'] = f; };
  w.chrome = { runtime: { id: s.chrome.runtime.id, onMessage: { addListener: (fn) => listeners.push(fn), removeListener() {} }, sendMessage: async () => {} }, storage: { local: { get: async () => ({ uiLanguage: 'en' }) }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'en' } };
  w.eval(code('lib/debug_journal.js'));
  if (inline) { w.eval(code('lib/i18n.js')); w.eval(code('lib/sites.js')); w.eval(code('content/content_inline.js')); }
  w.eval(code('content/content_context_target.js'));
  // worker side: the REAL admission and resolution; executeScript runs the serialized function in this document (both worlds: jsdom has one)
  s.TextDecoder = TextDecoder; s.Buffer = Buffer;
  s.chrome.tabs.get = async (id) => ({ id, url: w.location.href });
  s.chrome.storage.local.get = async (k) => ({ ...(k && typeof k === 'object' ? k : {}), ...settings });
  s.chrome.scripting.executeScript = async (call) => {
    p.scripts.push({ name: call.func && call.func.name, world: call.world || 'ISOLATED', target: call.target });
    if (call.target.documentIds && !call.target.documentIds.includes(p.docId)) throw Error('No document with id');
    return [{ result: w.eval('(' + call.func + ')')(...(call.args || [])), documentId: p.docId, frameId: 0 }];
  };
  s.chrome.tabs.sendMessage = async (id, msg, opts) => {
    if (opts && opts.documentId && opts.documentId !== p.docId) throw Error('No document with id');
    return new Promise((resolve) => { let answered = false; for (const fn of listeners) fn(msg, { id: s.chrome.runtime.id }, (v) => { answered = true; resolve(v); }); if (!answered) resolve(undefined); });
  };
  s.fetch = async (raw, o = {}) => {
    p.fetched.push(raw);
    if ([TT_URL, IG_URL, TT_NEIGHBOUR, IG_NEIGHBOUR].includes(raw) || /AQSILENT|oSILENT/.test(raw)) {
      if (p.status !== 200 && p.status !== 206) return new Response('denied', { status: p.status, headers: { 'content-type': 'text/html' } });
      return new Response(o.method === 'HEAD' ? null : MP4, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } });
    }
    return new Response('missing', { status: 404 });
  };
  s.managedDownload = async (options) => { const r = await s.fetch(options.url, { method: 'GET' }); if (!r.ok) throw Error('HTTP_ERROR'); p.exported.push(options); return s.chrome.downloads.download(options); };
  const fail = s.fbFail; s.fbFail = async (op, info) => { if (info && info.code) p.failures.push(info.code); return fail(op, info); }; // the badge reporter repeats a failure without a code
  // a right-click at (x, y): the pressed element receives the trusted right press and the contextmenu event
  p.rightClick = (x, y, shiftKey = false) => {
    const t = d.elementFromPoint(x, y);
    const down = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y, shiftKey }); down.testTrusted = true; t.dispatchEvent(down);
    const menu = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y, shiftKey }); menu.testTrusted = true; t.dispatchEvent(menu);
    return menu;
  };
  // the menu item click as Chrome reports it (a layer: page context without srcUrl; a <video>: its blob srcUrl)
  p.save = async (info = {}) => { await s.onContextMenuClicked({ menuItemId: info.srcUrl ? 'save-image-item' : 'save-css-media-item', pageUrl: w.location.href, frameId: 0, ...info }, { id: 1, url: w.location.href }); await sleep(30); };
  p.close = () => { try { w.__medialatchInline?.teardown(); } catch (_) {} w.close(); };
  return p;
}
const igPage = (opts = {}) => {
  const p = page({ url: IG_PAGE, html: instagramHtml(opts), ...opts });
  const meta = (id) => ({ coreVideoPlayerMetaData: { videoFBID: id, routeTracePolicy: 'polaris.reelsTab' }, manifest: '<MPD><AdaptationSet contentType="audio"/></MPD>' });
  p.fiber(p.d.getElementById('media'), [{ className: 'x1lliihq' }, { videoElementCallbacks: {} }, meta(opts.fbid || IG_PK)]);
  p.fiber(p.d.getElementById('neighbour'), [{ className: 'x1lliihq' }, { videoElementCallbacks: {} }, meta(IG_PK_B)]);
  if (p.d.getElementById('twin')) p.fiber(p.d.getElementById('twin'), [{}, {}, meta(IG_PK_B)]);
  return p;
};
const ttPage = (opts = {}) => {
  const p = page({ url: TT_PAGE, html: tiktokHtml(opts), ...opts });
  const deep = (item) => [...Array.from({ length: 24 }, () => ({ className: 'layer' })), { item }, { props: { item } }];
  const selected = opts.item || { id: opts.fiberId || '7695998843653082388', author: 'seyro67', video: { playAddr: TT_URL, downloadAddr: TT_URL, format: 'mp4' } };
  p.fiber(p.d.querySelector('#item-a .host'), deep(selected));
  p.fiber(p.d.querySelector('#item-b .host'), deep({ id: '7695725156328557856', author: 'seyro67', video: { playAddr: TT_NEIGHBOUR } }));
  // TikTok's own handler cancels the browser menu on its player (observed live)
  for (const v of p.d.querySelectorAll('video')) v.addEventListener('contextmenu', (e) => e.preventDefault());
  return p;
};
const until = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await sleep(10); };

(async () => {
  // ---- Instagram ----
  await test('Instagram: a right-click on the Reel overlay saves that Reel\'s own progressive file, exact signed address, never the neighbour', async () => {
    const p = igPage();
    p.rightClick(300, 400); await p.save(); await until(() => p.exported.length);
    assert.deepEqual(p.exported.map((o) => o.url), [IG_URL], 'exactly the selected item\'s video_versions URL, query untouched');
    assert(!p.fetched.includes(IG_NEIGHBOUR), 'the neighbour was never requested');
    const main = p.scripts.filter((c) => c.world === 'MAIN');
    assert.deepEqual(main.map((c) => [c.name, JSON.stringify(c.target)]), [['readSocialPlayerItem', JSON.stringify({ tabId: 1, documentIds: ['doc-1'] })]], 'one page-world read, pinned to the admitting document');
    assert(!p.scripts.some((c) => c.name === 'resolveFrameLocalMediaImpl'), 'the RedGIFs frame resolver is not involved');
    p.close();
  });
  await test('Instagram: browser-menu video saves use the selected item username for author folders', async () => {
    const p = igPage({ settings: { folderOrganizationMode: 'by_site_and_type', instagramAuthorFolders: true } });
    p.rightClick(300, 400); await p.save(); await until(() => p.exported.length);
    assert.equal(p.exported.length, 1);
    assert(/^SavedImages\/instagram\/errejotapodcast\/video\/[^/]+$/.test(p.exported[0].filename), p.exported[0].filename);

    p.close();
  });
  await test('Instagram: after scrolling the feed, a right-click on the next Reel saves that Reel (URL of the page names another item)', async () => {
    const p = igPage();
    p.scroll(826); p.w.history.pushState(null, '', '/reels/Dekcw6PxDML/');
    p.rightClick(300, 400); await p.save(); await until(() => p.exported.length);
    assert.deepEqual(p.exported.map((o) => o.url), [IG_NEIGHBOUR], 'the Reel under the pointer now, by its own player props');
    p.close();
  });
  await test('Instagram: scrolling between the right-click and the menu click refuses (the captured player is no longer under the point); nothing is requested', async () => {
    const p = igPage();
    p.rightClick(300, 400); p.scroll(826); await p.save();
    assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); assert.equal(p.failures.length, 1, "one visible failure " + JSON.stringify(p.failures));
    assert(!p.scripts.some((c) => c.world === 'MAIN'), 'no page-world read after the selection changed');
    p.close();
  });
  await test('Instagram: a player replaced by SPA navigation, or a replaced document, saves nothing', async () => {
    let p = igPage();
    p.rightClick(300, 400);
    const v = p.d.getElementById('media'), fresh = v.cloneNode(); Object.defineProperty(fresh, 'currentSrc', { get: () => 'blob:https://www.instagram.com/new-item' }); p.rects.set(fresh, p.rects.get(v)); v.replaceWith(fresh);
    await p.save(); assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); p.close();
    // the document is replaced right after the gesture was read (admission pinned to doc-1): the pinned player reads must fail
    p = igPage(); p.rightClick(300, 400);
    const run = p.s.chrome.scripting.executeScript; p.s.chrome.scripting.executeScript = async (call) => { const r = await run(call); if (call.func.name === 'readContextMediaTarget') p.docId = 'doc-2'; return r; };
    await p.save();
    assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); assert.deepEqual(p.failures, ['UNRESOLVED_BLOB_MEDIA']); assert(!p.scripts.some((c) => c.world === 'MAIN')); p.close();
  });
  await test('Instagram: two players at the pressed point select nothing (never a guess between them)', async () => {
    const p = igPage({ twoAtPoint: true });
    p.rightClick(300, 400); await p.save();
    assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); assert.deepEqual(p.failures, ['NO_MEDIA']); p.close();
  });
  await test('Instagram: an item the page declares only as separate DASH tracks is an honest unsupported source, not a silent or guessed file', async () => {
    const p = igPage({ items: [igItem(IG_PK_B, 'Dekcw6PxDML', IG_NEIGHBOUR)] });
    p.rightClick(300, 400); await p.save();
    assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); assert.deepEqual(p.failures, ['UNSUPPORTED_SOURCE']); p.close();
  });
  await test('Instagram: a declared file on a lookalike or non-HTTPS host is refused before any request', async () => {
    for (const bad of ['https://scontent.cdninstagram.com.evil.example/o1/v/AQ.mp4?oh=1', 'http://scontent-fra3-1.cdninstagram.com/o1/v/AQ.mp4', 'https://scontent-fra3-1.cdninstagram.com:8443/o1/v/AQ.mp4', 'https://user:pw@scontent-fra3-1.cdninstagram.com/o1/AQ.mp4', 'https://evilcdninstagram.com/o1/AQ.mp4']) {
      const p = igPage({ items: [igItem(IG_PK, 'DefTURuSN2j', bad)] });
      p.rightClick(300, 400); await p.save();
      assert.deepEqual(p.exported, [], bad); assert.deepEqual(p.fetched, [], bad); assert.deepEqual(p.failures, ['UNRESOLVED_BLOB_MEDIA'], bad); p.close();
    }
  });
  await test('Instagram: expired access (HTTP 403 from the CDN) ends as an access failure with no export', async () => {
    const p = igPage(); p.status = 403;
    p.rightClick(300, 400); await p.save();
    assert.deepEqual(p.exported, []); assert(p.fetched.every((u) => u === IG_URL)); assert(p.failures.length >= 1 && p.failures.every((c) => c === 'AUTH_REQUIRED'), JSON.stringify(p.failures)); // the AUTH badge repeats the same code p.close();
  });
  await test('Instagram: declared audio is reported; a declared-silent item stays silent rather than borrowing another file', async () => {
    let p = igPage(); p.rightClick(300, 400);
    let r = await p.s.resolveSocialPlayerMedia({ tabId: 1, documentId: 'doc-1', site: 'instagram' });
    assert.equal(r.success, true); assert.equal(r.audio, 'present'); assert.equal(r.targetUrl, IG_URL); p.close();
    p = igPage({ items: [igItem(IG_PK, 'DefTURuSN2j', IG_URL.replace('AQSELECTED', 'AQSILENT'), { has_audio: false })] }); p.rightClick(300, 400);
    r = await p.s.resolveSocialPlayerMedia({ tabId: 1, documentId: 'doc-1', site: 'instagram' });
    assert.equal(r.audio, 'absent'); assert(r.targetUrl.includes('AQSILENT')); p.close();
  });
  for (const [site, create] of [['Instagram', igPage], ['TikTok', ttPage]]) {
    for (const [name, attrs] of [['dialog role', { role: 'dialog' }], ['native dialog', {}], ['modal surface', { 'aria-modal': 'true' }], ['modal class', { class: 'LoginModal' }], ['consent banner', {}]]) {
      await test(site + ': a covering ' + name + ' never selects or downloads the video behind it', async () => {
        const p = create();
        try {
          const cover = p.d.createElement(name === 'native dialog' ? 'dialog' : name === 'consent banner' ? 'tiktok-cookie-banner' : 'section');
          for (const [key, value] of Object.entries(attrs)) cover.setAttribute(key, value);
          cover.textContent = 'Sign in to continue'; p.d.body.append(cover);
          p.rects.set(cover, { left: 0, top: 0, width: 1000, height: 1000 });
          p.rightClick(300, 400); await p.save();
          assert.equal(p.w.__imageSaverContextTarget?.media, null, 'a covering surface owns no underlying player');
          assert.deepEqual(p.fetched, []); assert.deepEqual(p.exported, []);
          assert(!p.scripts.some(c => c.world === 'MAIN'), 'no page metadata read for the wrong target');
        } finally { p.close(); }
      });
    }
    await test(site + ': a legitimate player inside a viewing dialog still saves its own file', async () => {
      const p = create();
      try {
        const dialog = p.d.createElement('section'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
        const card = p.d.getElementById(site === 'TikTok' ? 'item-a' : 'reel-a'); card.replaceWith(dialog); dialog.append(card);
        p.rightClick(300, 400); await p.save(site === 'TikTok' ? { srcUrl: 'blob:https://www.tiktok.com/aaaa-selected', mediaType: 'video' } : {}); await until(() => p.exported.length);
        assert.deepEqual(p.exported.map(o => o.url), [site === 'TikTok' ? TT_URL : IG_URL]);
      } finally { p.close(); }
    });
  }
  // ---- TikTok ----
  // TIKTOK-CONTROLS-01: a plain right-click keeps TikTok's own menu (the rail Download is the primary save); Shift+right-click keeps the browser menu
  await test('TikTok: a real Shift+right-click on the player keeps the browser menu (the site cancels it); a plain one stays TikTok\x27s; outside the player, untrusted events and other sites are untouched', async () => {
    const p = ttPage();
    assert.equal(p.rightClick(300, 400).defaultPrevented, true, 'plain right-click: TikTok\x27s own handler runs (its menu)');
    assert.equal(p.rightClick(300, 400, true).defaultPrevented, false, 'Shift: the page handler on the player did not cancel the browser menu');
    const untrusted = new p.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true }); p.d.getElementById('media').dispatchEvent(untrusted);
    assert.equal(untrusted.defaultPrevented, true, 'a synthetic event is not ours to protect');
    const outside = p.d.createElement('div'); p.d.body.append(outside); outside.addEventListener('contextmenu', (e) => e.preventDefault());
    const e2 = new p.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true }); e2.testTrusted = true; outside.dispatchEvent(e2);
    assert.equal(e2.defaultPrevented, true, 'outside a TikTok player the page keeps its own handling'); p.close();
    const q = igPage(); const v = q.d.getElementById('media'); v.addEventListener('contextmenu', (e) => e.preventDefault());
    const e3 = new q.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true }); e3.testTrusted = true; v.dispatchEvent(e3);
    assert.equal(e3.defaultPrevented, true, 'Instagram handlers are not changed'); q.close();
  });
  await test('TikTok: the menu on the <video> (blob srcUrl) saves that item\'s playAddr exactly; the neighbour player is never asked or fetched', async () => {
    const p = ttPage();
    p.rightClick(300, 400); await p.save({ srcUrl: 'blob:https://www.tiktok.com/aaaa-selected', mediaType: 'video' }); await until(() => p.exported.length);
    assert.deepEqual(p.exported.map((o) => o.url), [TT_URL]); assert(!p.fetched.includes(TT_NEIGHBOUR));
    assert.deepEqual(p.scripts.filter((c) => c.world === 'MAIN').map((c) => c.name), ['readSocialPlayerItem']); p.close();
  });
  await test('TikTok: Chrome\'s srcUrl of another player than the captured one is refused (no substitution)', async () => {
    const p = ttPage();
    p.rightClick(300, 400); await p.save({ srcUrl: 'blob:https://www.tiktok.com/bbbb-neighbour', mediaType: 'video' });
    assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); p.close();
  });
  await test('TikTok: a new right-click on the neighbour arriving after the admission of the first one is not taken for it', async () => {
    const p = ttPage();
    p.rightClick(300, 400);
    const run = p.s.chrome.scripting.executeScript;
    p.s.chrome.scripting.executeScript = async (call) => { const r = await run(call); if (call.func.name === 'verifyContextOwner') { p.scroll(826); p.rightClick(300, 400); } return r; };
    await p.save({ srcUrl: 'blob:https://www.tiktok.com/aaaa-selected', mediaType: 'video' });
    assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); assert.deepEqual(p.failures, ['UNRESOLVED_BLOB_MEDIA']); p.close();
  });
  await test('TikTok: props whose item is not the wrapper\'s item, a photo post, or an off-CDN/redirecting address are refused', async () => {
    for (const opts of [{ fiberId: '7695725156328557856' }, { item: { id: '7695998843653082388', imagePost: { images: [] }, video: { playAddr: TT_URL } } },
      { item: { id: '7695998843653082388', video: { playAddr: 'https://www.tiktok.com/aweme/v1/play/?video_id=v0&signature=x' } } },
      { item: { id: '7695998843653082388', video: { playAddr: 'https://v16-webapp-prime.tiktok.com.evil.example/video/tos/x/' } } }]) {
      const p = ttPage(opts);
      p.rightClick(300, 400); await p.save({ srcUrl: 'blob:https://www.tiktok.com/aaaa-selected', mediaType: 'video' });
      assert.deepEqual(p.exported, [], JSON.stringify(opts)); assert.deepEqual(p.fetched, [], JSON.stringify(opts)); p.close();
    }
  });
  await test('TikTok: browser-menu author folders use the matching player item even without a DOM permalink', async () => {
    let p = ttPage({ permalink: true, inline: true, settings: { folderOrganizationMode: 'by_site_and_type', tiktokAuthorFolders: true } });
    p.rightClick(300, 400); await p.save({ srcUrl: 'blob:https://www.tiktok.com/aaaa-selected', mediaType: 'video' }); await until(() => p.exported.length);
    assert(/^SavedImages\/tiktok\/seyro67\/video\/[^/]+$/.test(p.exported[0].filename), p.exported[0].filename); p.close();
    p = ttPage({ inline: true, settings: { folderOrganizationMode: 'by_site_and_type', tiktokAuthorFolders: true } });
    p.rightClick(300, 400); await p.save({ srcUrl: 'blob:https://www.tiktok.com/aaaa-selected', mediaType: 'video' }); await until(() => p.exported.length);
    assert(/^SavedImages\/tiktok\/seyro67\/video\/[^/]+$/.test(p.exported[0].filename), p.exported[0].filename); p.close();
  });
  await test('TikTok: item attribution overrides an independently proven DOM permalink; unknown metadata leaves no stale label or folder', async () => {
    for (const [author, segment] of [[{uniqueId:'Source.Creator',nickname:'Display only'},'source.creator/'],[null,'']]) {
      const p=ttPage({permalink:true,inline:true,item:{id:'7695998843653082388',author,video:{playAddr:TT_URL}},settings:{folderOrganizationMode:'by_site_and_type',tiktokAuthorFolders:true}});
      try {p.rightClick(300,400);await p.save({srcUrl:'blob:https://www.tiktok.com/aaaa-selected',mediaType:'video'});await until(()=>p.exported.length);assert(p.exported[0].filename.startsWith('SavedImages/tiktok/'+segment+'video/'),p.exported[0].filename);const records=await p.records();assert.equal(records[0].author?.id,segment?'source.creator':undefined);}finally{p.close();}
    }
  });
  // ---- unchanged contracts ----
  await test('The same layered player on another site still selects nothing (no new generic admission), and RedGIFs validation is not widened', async () => {
    const p = page({ url: 'https://videos.example/watch/1', html: instagramHtml() });
    p.rightClick(300, 400);
    assert.equal(p.w.__imageSaverContextTarget.media, null, 'the capture names no player under a deep layer outside TikTok/Instagram (unchanged generic detection)');
    await p.save();
    assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); assert.deepEqual(p.failures, ['NO_MEDIA']); assert(!p.scripts.some((c) => c.world === 'MAIN'));
    for (const u of [IG_URL, TT_URL]) assert.equal(p.s.validateRedGifsCandidateUrl(u).valid, false, u);
    assert.equal(p.s.socialVideoSiteOf('https://www.tiktok.com.evil.example/@a/video/1'), ''); assert.equal(p.s.socialVideoSiteOf('http://www.instagram.com/reels/x/'), '');
    p.close();
  });
  // ---- the manager keeps the exact source through cancellation and retry ----
  await test('Manager: cancelling and retrying the TikTok job re-requests the same exact signed address with the browser\'s credentials, no redirect', async () => {
    require('../lib/media_sources.js'); require('../worker/download_manager.js'); require('../offscreen/staging.js');
    const { sniffMediaMagicBytes, isMalformedMediaContainer } = require('../offscreen.js');
    const calls = [];
    let release = null, failOnce = false, exports = 0;
    const native = new Map(), files = new Map();
    const dir = { getDirectoryHandle: async () => dir, getFileHandle: async (id) => ({ createWritable: async () => { const chunks = []; return { write: async (x) => chunks.push(x), close: async () => files.set(id, new Blob(chunks)), abort: async () => {} }; }, getFile: async () => files.get(id) }), removeEntry: async (id) => files.delete(id) };
    const staging = globalThis.MediaLatchStaging.createStaging({ directory: async () => dir,
      estimate: async () => ({ quota: 1e9, usage: 0 }), origin: 'chrome-extension://test', sniff: sniffMediaMagicBytes, malformed: isMalformedMediaContainer, url: () => 'blob:chrome-extension://test/local', revoke: () => {},
      fetch: async (url, opts) => { calls.push({ url, credentials: opts.credentials, redirect: opts.redirect }); if (calls.length === 1) await new Promise((r) => { release = r; opts.signal.addEventListener('abort', r); }); if (opts.signal.aborted) throw Object.assign(Error('aborted'), { name: 'AbortError' }); if (failOnce) { failOnce = false; return new Response('busy', { status: 500 }); } return new Response(MP4, { headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } }); } });
    let data = { jobs: [], paused: false }, next = 1;
    const m = globalThis.MediaLatchDownloads.createManager({ store: { get: async () => structuredClone(data), set: async (x) => { data = structuredClone(x); } }, id: () => 'job-' + next++, sleep: async () => sleep(2),
      stage: (j, signal, progress) => staging.stage(j, progress), verify: async () => true, fileUrl: async () => 'blob:chrome-extension://test/x', remove: async () => {}, abort: async (id, attempt) => staging.abort(id, attempt), stop: async () => {},
      export: async (url, filename) => { exports++; const id = 100 + exports; native.set(id, { id, url, filename, state: 'complete' }); return id; }, search: async (id, url) => (Number.isInteger(id) ? native.get(id) : [...native.values()].find((x) => x.url === url)), cancelExport: async () => {}, error: () => {} });
    await m.ready;
    // cancel while the TikTok transfer runs: the request is aborted, nothing is exported, the job ends cancelled (terminal, as for every site)
    const first = m.enqueue({ url: TT_URL, filename: 'SavedImages/tiktok/video/clip.mp4' }, {}).catch((e) => e);
    await until(() => calls.length === 1);
    await m.command('cancel', (await m.list()).jobs[0].id); if (release) release();
    assert.equal((await first).message, 'CANCELLED'); assert.equal((await m.list()).jobs[0].state, 'cancelled'); assert.equal(exports, 0);
    // a failed transfer (the CDN answered 500 once) is retried with the same exact address; the second attempt completes and exports once
    failOnce = true;
    const second = m.enqueue({ url: TT_URL, filename: 'SavedImages/tiktok/video/clip2.mp4' }, {}).catch((e) => e);
    await until(() => calls.length === 2); await second; await sleep(30);
    const failed = (await m.list()).jobs.find((j) => j.filename.endsWith('clip2.mp4'));
    assert.equal(failed.state, 'failed'); assert.equal(failed.source, undefined, 'the public job view never shows the signed address');
    await m.command('retry', failed.id); await until(() => calls.length === 3); await m.drain();
    const done = (await m.list()).jobs.find((j) => j.id === failed.id); assert.equal(done.state, 'complete', done.error); assert.equal(exports, 1);
    assert.deepEqual(calls.map((c) => c.url), [TT_URL, TT_URL, TT_URL], 'the exact signed address every time, never re-resolved or rewritten');
    assert(calls.every((c) => c.credentials === 'include' && c.redirect === 'error'), 'cookies sent (TikTok needs them); a redirect is an error, not a new source');
  });
  console.log(`${passed} social video checks passed (SYNTHETIC: simulated pages, layout, fibers, input, network and export)`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
