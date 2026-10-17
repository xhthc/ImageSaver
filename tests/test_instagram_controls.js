'use strict';
// INSTAGRAM-REELS-CONTROLS-01: Copy and Download in the selected Reel's video (upper-right), hover/keyboard visibility, the Download proof and route.
// SYNTHETIC: jsdom pages shaped like the Instagram Reels structure observed live on 2026-10-17
// (local-notes/checks/instagram-reels-controls01/discovery/discovery.md): a card holding the media box (video + full-size role=group layer +
// author link, position:relative) and, outside it, the native rail (Like, Comment, Share, More at the bottom). Layout, React fibers, trusted
// input, network and export are simulated; the production content scripts (content_copy_kit.js, content_instagram.js, content_context_target.js)
// and worker (background.js + worker modules) run unchanged. CSS :hover itself is not evaluated by jsdom (native fixture covers it).
// No live-site, real-file or audio claim.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict'), { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '..'), { JSDOM } = createRequire(path.join(ROOT, 'ui/package.json'))('jsdom');
const { createTestEnv } = require('./test_context_target_avatar');
const code = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
// each case reports its own result, so a run on the starting source lists every failing case
const test = async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('FAIL ' + name + ': ' + String(e && e.message || e).split('\n')[0]); } };

const PAGE = 'https://www.instagram.com/reels/DefTURuSN2j/';
const PK_A = '4008007149686414755', PK_B = '4009007149686320459', CODE_A = 'DefTURuSN2j', CODE_B = 'Dekcw6PxDML';
const URL_A = 'https://scontent-fra3-1.cdninstagram.com/o1/v/t2/f2/m86/AQAAAA.mp4?efg=eyJ2%3D&_nc_ht=x&oh=00_EXACT%2BA&oe=6A1B2C3D';
const URL_B = 'https://scontent-fra5-1.cdninstagram.com/o1/v/t2/f2/m86/AQBBBB.mp4?efg=eyJ2%3D&_nc_ht=y&oh=00_EXACT%2BB&oe=6A1B2C3D';
const MP4 = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x6d, 0x70, 0x34, 0x31, 0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65, 0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]);
const item = (pk, c, url, extra = {}) => ({ pk, code: c, user: { username: 'errejotapodcast' }, has_audio: true, video_versions: [{ type: 101, width: 720, url }], video_dash_manifest: '<MPD/>', ...extra });
const json = (items) => `<script type="application/json">${JSON.stringify({ require: [[{ result: { data: { xig_logged_out_reels_feed: { edges: items.map((node) => ({ node })) } } } }]] })}</script>`;
const reelCard = (n, stream, { boxStyle = 'position: relative', extraVideo = false } = {}) => `
  <div class="card" id="card-${n}">
    <div class="box" id="box-${n}" style="${boxStyle}">
      <div class="v"><div><div><div><div><div><div><video data-stream="${stream}"></video>${extraVideo ? '<video data-stream="blob:https://www.instagram.com/extra"></video>' : ''}</div></div></div></div></div></div></div>
      <div role="group" aria-label="Video player" class="layer" id="layer-${n}"></div>
      <a href="/errejotapodcast/reels/" aria-label="Reels by errejotapodcast" class="author">errejotapodcast</a>
    </div>
    <div class="rail" id="rail-${n}" style="display:flex;flex-direction:column">
      <div role="button" class="like"><svg aria-label="Like"></svg></div><div role="button"><svg aria-label="Comment"></svg></div>
      <div role="button"><svg aria-label="Share"></svg></div><div role="button" class="more"><svg aria-label="More"></svg></div>
    </div>
  </div>`;
const feedHtml = ({ items = [item(PK_A, CODE_A, URL_A), item(PK_B, CODE_B, URL_B)], cardOpts = [{}, {}], dialog = false } = {}) =>
  `${json(items)}<main><div id="feed">${dialog ? '<div role="dialog" id="viewer">' : ''}${reelCard(0, 'blob:https://www.instagram.com/aaaa-stream', cardOpts[0])}${dialog ? '</div>' : ''}${reelCard(1, 'blob:https://www.instagram.com/bbbb-stream', cardOpts[1])}</div></main>`;

function page({ url = PAGE, html = feedHtml(), docId = 'doc-1', worker = true, settings = {} } = {}) {
  const env = createTestEnv(), s = env.bgSandbox, dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window, d = w.document;
  Object.defineProperty(w, 'innerHeight', { configurable: true, value: 900 });
  const rects = new WeakMap(), content = [], p = { w, d, s, rects, sent: [], exported: [], fetched: [], failures: [], scripts: [], copied: [], docId, content, offset: 0 };
  p.observers = []; p.navigationListeners = 0;
  const NativeObserver = w.MutationObserver;
  w.MutationObserver = class extends NativeObserver { constructor(cb) { super(cb); p.observers.push(this); } };
  for (const v of d.querySelectorAll('video')) {
    Object.defineProperty(v, 'currentSrc', { configurable: true, get() { return this.getAttribute('data-stream') || ''; } });
    Object.defineProperty(v, 'paused', { configurable: true, get() { return this.getAttribute('data-playing') !== 'true'; } });
  }
  d.querySelector('#card-0 video')?.setAttribute('data-playing', 'true'); // the Reel in view plays (as observed)
  // layout: card n at y = 80 + n*830 - offset; media box 446x795 at x=100; rail to the right
  p.layout = () => {
    for (const card of d.querySelectorAll('.card')) {
      const n = Number(card.id.split('-').pop()), top = 80 + n * 830 - p.offset;
      rects.set(card, { left: 100, top, width: 520, height: 797 });
      for (const el of card.querySelectorAll('.box, .box *')) if (!el.closest('.author') && !el.matches('.image-saver-ig-reel-copy, .image-saver-ig-reel-save, .image-saver-ig-reel-copy *, .image-saver-ig-reel-save *')) rects.set(el, { left: 100, top, width: 446, height: 795 });
      for (const el of card.querySelectorAll('.author')) rects.set(el, { left: 116, top: top + 720, width: 144, height: 32 });
      for (const el of card.querySelectorAll('.rail, .rail *')) rects.set(el, { left: 560, top: top + 550, width: 40, height: 220 });
      for (const el of card.querySelectorAll('.image-saver-ig-reel-copy, .image-saver-ig-reel-save')) rects.set(el, { left: 494, top: top + (el.classList.contains('image-saver-ig-reel-save') ? 58 : 12), width: 40, height: 40 });
    }
    const viewer = d.getElementById('viewer'); if (viewer) rects.set(viewer, { left: 0, top: 0, width: 1024, height: 900 });
  };
  p.layout();
  w.Element.prototype.getBoundingClientRect = function () { const b = rects.get(this) || { left: 0, top: 0, width: 0, height: 0 }; return { ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top }; };
  const stack = (x, y) => [...d.querySelectorAll('*')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom; }).reverse();
  d.elementsFromPoint = stack; d.elementFromPoint = (x, y) => stack(x, y)[0] || null;
  const wrappers = new WeakMap(), add = w.EventTarget.prototype.addEventListener, remove = w.EventTarget.prototype.removeEventListener;
  w.EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if ((this === w || this === d) && ['scroll', 'resize', 'popstate'].includes(type)) p.navigationListeners++;
    if (typeof fn !== 'function') return add.call(this, type, fn, opts);
    if (!wrappers.has(fn)) wrappers.set(fn, (e) => fn(new Proxy(e, { get: (t, k) => (k === 'isTrusted' ? t.testTrusted === true : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) })));
    return add.call(this, type, wrappers.get(fn), opts);
  };
  w.EventTarget.prototype.removeEventListener = function (type, fn, opts) { return remove.call(this, type, wrappers.get(fn) || fn, opts); };
  // the page world's React fibers (observed shape): two levels above each <video>, coreVideoPlayerMetaData.videoFBID names the item
  for (const [n, pk] of [[0, PK_A], [1, PK_B]]) { const v = d.querySelector(`#card-${n} video`); if (v) v['__reactFiber$test'] = { memoizedProps: {}, return: { memoizedProps: {}, return: { memoizedProps: { coreVideoPlayerMetaData: { videoFBID: pk }, manifest: '<MPD/>' }, return: null } } }; }
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { p.copied.push(t); } } });
  w.chrome = {
    runtime: { id: s.chrome.runtime.id, onMessage: { addListener: (fn) => content.push(fn), removeListener: (fn) => { const i = content.indexOf(fn); if (i >= 0) content.splice(i, 1); } },
      sendMessage: async (msg) => { if (msg.action !== 'CONTEXT_TARGET_STATE') p.sent.push(msg); /* menu hints are not saves */ if (!worker) return; const sender = { id: s.chrome.runtime.id, tab: { id: 1, active: true, url: w.location.href }, frameId: 0, documentId: p.docId, url: w.location.href, ...p.sender }; for (const fn of s.chrome.runtime.onMessage._listeners) fn(msg, sender, () => {}); } },
    storage: { local: { get: (k, cb) => { const r = { ...(k && typeof k === 'object' ? k : {}) }; if (cb) cb(r); return Promise.resolve(r); } }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'en' }
  };
  s.TextDecoder = TextDecoder; s.Buffer = Buffer;
  s.chrome.storage.local.get = async (k) => ({ ...(k && typeof k === 'object' ? k : {}), ...settings });
  p.options = []; p.records = () => vm.runInContext('feedbackTracker.list()', env.bgContext);
  s.chrome.tabs.get = async (id) => ({ id, url: w.location.href });
  s.chrome.scripting.executeScript = async (call) => {
    p.scripts.push({ name: call.func && call.func.name, world: call.world || 'ISOLATED', target: call.target });
    if (call.target.documentIds && !call.target.documentIds.includes(p.docId)) throw Error('No document with id');
    return [{ result: w.eval('(' + call.func + ')')(...(call.args || [])), documentId: p.docId, frameId: 0 }];
  };
  s.chrome.tabs.sendMessage = async (id, msg, opts) => {
    if (opts && opts.documentId && opts.documentId !== p.docId) throw Error('No document with id');
    p.asked = (p.asked || 0) + 1; if (p.hook) p.hook(msg);
    return new Promise((resolve) => { let answered = false; for (const fn of [...content]) fn(msg, { id: s.chrome.runtime.id }, (v) => { answered = true; resolve(v); }); if (!answered) resolve(undefined); });
  };
  s.fetch = async (raw, o = {}) => { p.fetched.push(raw); if ([URL_A, URL_B].includes(raw)) return new Response(o.method === 'HEAD' ? null : MP4, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } }); return new Response('missing', { status: 404 }); };
  s.managedDownload = async (options) => { await sleep(p.slow || 0); const r = await s.fetch(options.url, { method: 'GET' }); if (!r.ok) throw Error('HTTP_ERROR'); p.options.push(options); p.exported.push(options.url); return s.chrome.downloads.download(options); };
  const fail = s.fbFail; s.fbFail = async (op, info) => { if (info && info.code) p.failures.push(info.code); return fail(op, info); };
  w.eval(code('lib/debug_journal.js')); w.eval(code('lib/i18n.js'));
  p.inject = () => { w.eval(code('content/content_copy_kit.js')); w.eval(code('content/content_instagram.js')); };
  w.eval(code('content/content_context_target.js'));
  p.inject();
  p.scan = async () => { w.__scanAndInjectInstagramCopyButtons(d); p.layout(); await sleep(5); };
  p.ours = (root = d) => [...root.querySelectorAll('.image-saver-ig-reel-copy, .image-saver-ig-reel-save')];
  p.save = (n) => d.querySelector(`#box-${n} .image-saver-ig-reel-save`);
  p.copy = (n) => d.querySelector(`#box-${n} .image-saver-ig-reel-copy`);
  p.press = (el, { trusted = true, key = '' } = {}) => {
    const e = key ? new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) : new w.MouseEvent('click', { bubbles: true, cancelable: true });
    e.testTrusted = trusted; el.dispatchEvent(e);
  };
  p.scroll = (n, code) => { p.offset = n * 830; p.layout(); for (const v of d.querySelectorAll('video')) v.removeAttribute('data-playing'); d.querySelector(`#card-${n} video`).setAttribute('data-playing', 'true'); w.history.pushState(null, '', `/reels/${code}/`); };
  p.close = () => w.close();
  return p;
}
const until = async (fn, ms = 3000) => { for (let i = 0; i < ms / 10 && !fn(); i++) await sleep(10); };

(async () => {
  // ---- placement ----
  await test('each Reel\'s media box gets exactly one Copy above one Download, in its upper-right; none in the native rail; the old rail Copy is gone', async () => {
    const p = page(); await p.scan();
    for (const n of [0, 1]) {
      const box = p.d.getElementById(`box-${n}`), mine = p.ours(p.d.getElementById(`card-${n}`));
      assert.equal(mine.length, 2, `card ${n}: ${mine.map((e) => e.className).join(' | ')}`);
      assert(mine.every((e) => e.parentElement === box), 'both are direct children of the Reel\'s own media box');
      assert(mine[0].classList.contains('image-saver-ig-reel-copy') && mine[1].classList.contains('image-saver-ig-reel-save'), 'Copy, then Download');
      assert.equal(mine[0].style.right, '12px'); assert.equal(mine[0].style.top, '12px'); assert.equal(mine[1].style.top, '58px');
      assert(box.classList.contains('image-saver-ig-hover-area'), 'only the media box is the hover area');
      assert.equal(p.d.querySelectorAll(`#card-${n} .image-saver-ig-copy-wrap`).length, 0, 'no old Copy in this Reel\'s rail');
      for (const el of mine) { assert.equal(el.getAttribute('role'), 'button'); assert.equal(el.getAttribute('tabindex'), '0'); assert.match(el.getAttribute('aria-label'), /MediaLatch|Copy/); }
    }
    assert(!p.d.getElementById('rail-0').classList.contains('image-saver-ig-hover-area'));
    const css = p.d.getElementById('image-saver-ig-styles').textContent;
    assert.match(css, /@media \(hover: hover\)[\s\S]*\.image-saver-ig-hover-area:not\(:hover\):not\(:has\(:focus-visible\)\) \.image-saver-ig-reel-copy/, 'hidden off-hover only where hover exists; keyboard focus reveals');
    p.close();
  });
  await test('repeated scans and a second injection never duplicate the pair; a pre-existing rail Copy in a Reel card is removed', async () => {
    const p = page();
    const old = p.d.createElement('div'); old.className = 'image-saver-ig-copy-wrap is-reel-rail'; p.d.getElementById('rail-0').prepend(old);
    await p.scan(); await p.scan(); p.inject(); await sleep(80); await p.scan();
    for (const n of [0, 1]) assert.equal(p.ours(p.d.getElementById(`card-${n}`)).length, 2);
    assert.equal(p.d.querySelectorAll('.image-saver-ig-copy-wrap').length, 0);
    p.close();
  });
  await test('a media box with two players, a static (unpositioned) box or a non-Reels page gets no pair; an ordinary post keeps its rail Copy', async () => {
    let p = page({ html: feedHtml({ cardOpts: [{ extraVideo: true }, { boxStyle: '' }] }) }); await p.scan();
    assert.equal(p.ours().length, 0, p.ours().map((e) => e.parentElement.id).join()); p.close();
    p = page({ url: 'https://www.instagram.com/p/DefTURuSN2j/', html: `<main><article id="post"><a href="/p/DefTURuSN2j/"><time>1h</time></a><img src="https://scontent.cdninstagram.com/x.jpg"><section style="display:flex;flex-direction:row"><div role="button"><svg aria-label="Like"></svg></div><div role="button"><svg aria-label="Comment"></svg></div></section></article></main>` });
    await p.scan();
    assert.equal(p.ours().length, 0); assert.equal(p.d.querySelectorAll('#post .image-saver-ig-copy-wrap').length, 1, 'ordinary-post Copy unchanged'); p.close();
    // the same Reel markup outside a Reel page (a home-feed or profile post) gets no pair; its rail Copy stays
    p = page({ url: 'https://www.instagram.com/p/DefTURuSN2j/' }); await p.scan();
    assert.equal(p.ours().length, 0); assert(p.d.querySelectorAll('.image-saver-ig-copy-wrap').length >= 1, 'rail Copy kept outside Reel pages'); p.close();
  });
  await test('a replaced media box gets its pair back once; controls left in a detached or foreign place are removed', async () => {
    const p = page(); await p.scan();
    const box = p.d.getElementById('box-0'), fresh = box.cloneNode(true); for (const e of p.ours(fresh)) e.remove(); fresh.classList.remove('image-saver-ig-hover-area');
    const v = box.querySelector('video'); const nv = fresh.querySelector('video'); Object.defineProperty(nv, 'currentSrc', { get: () => 'blob:https://www.instagram.com/aaaa-stream' }); Object.defineProperty(nv, 'paused', { get: () => false }); nv['__reactFiber$test'] = v['__reactFiber$test'];
    box.replaceWith(fresh); p.layout(); await p.scan(); await p.scan();
    assert.equal(p.ours(p.d.getElementById('card-0')).length, 2); assert(p.ours(p.d.getElementById('card-0')).every((e) => e.parentElement === fresh));
    const stray = p.d.createElement('div'); stray.className = 'image-saver-ig-reel-save'; p.d.getElementById('rail-1').append(stray); await p.scan();
    assert.equal(p.d.querySelectorAll('#rail-1 .image-saver-ig-reel-save').length, 0);
    p.close();
  });
  await test('review regression: native layer or rail removal alone clears the pair without an explicit scan', async () => {
    for (const selector of ['#layer-0', '#rail-0']) {
      const p = page();
      try {
        await p.scan(); await sleep(30);
        p.d.querySelector(selector).remove();
        await until(() => p.ours(p.d.getElementById('card-0')).length === 0, 600);
        assert.equal(p.ours(p.d.getElementById('card-0')).length, 0, selector + ' removal left stale controls');
        assert.equal(p.ours(p.d.getElementById('card-1')).length, 2, 'neighbor remains intact');
      } finally { p.close(); }
    }
  });
  await test('review regression: reinjection retains one proof listener, observer and set of navigation listeners', async () => {
    const p = page();
    try {
      await p.scan(); await sleep(30);
      const counts = () => ({ proofListeners: p.content.length, observers: p.observers.length, navigationListeners: p.navigationListeners });
      const before = counts(); p.inject(); p.inject(); await sleep(80); await p.scan();
      assert(JSON.stringify(counts()) === JSON.stringify(before), 'reinjection leaked registrations: ' + JSON.stringify({ before, after: counts() }));
      p.press(p.save(0)); await until(() => p.exported.length);
      assert.deepEqual(p.exported, [URL_A], 'kept control and proof listener still share one token map');
    } finally { p.close(); }
  });
  // ---- Copy ----
  await test('Copy on the Reel in view copies that Reel\'s link with the chosen host; a Reel not proven as the one in view copies nothing and says so', async () => {
    const p = page(); await p.scan();
    p.press(p.copy(0)); await until(() => p.copied.length);
    assert.deepEqual(p.copied, [`https://oginstagram.com/reel/${CODE_A}/`]); await sleep(20); assert(p.copy(0).classList.contains('is-success'));
    p.press(p.copy(1)); await sleep(60); assert.equal(p.copied.length, 1, 'the neighbouring Reel is not the page URL\'s Reel'); assert(p.copy(1).classList.contains('is-error'));
    p.close();
  });
  await test('author folders: selected Reel metadata username, preference off and both layouts, never the neighbouring/visible profile', async () => {
    for (const [mode, enabled, expected] of [['by_site_and_type', true, 'instagram/actual.creator/video/'], ['single', true, 'actual.creator/'], ['by_site_and_type', false, 'instagram/video/']]) {
      const p = page({ settings: { folderOrganizationMode: mode, instagramAuthorFolders: enabled }, html: feedHtml({ items: [item(PK_A, CODE_A, URL_A, { user: { username: 'Actual.Creator' } }), item(PK_B, CODE_B, URL_B, { user: { username: 'neighbour.creator' } })] }) });
      try { await p.scan(); p.press(p.save(0)); await until(() => p.exported.length); assert.deepEqual(p.exported, [URL_A]); assert(p.options[0].filename.startsWith('SavedImages/' + expected), p.options[0].filename); const records=await p.records(); assert.equal(records[0].author?.id, 'actual.creator'); } finally { p.close(); }
    }
  });
  await test('author folders: missing/invalid Reel username does not borrow a profile, commenter or neighbouring item', async () => {
    for (const user of [null, {}, { username: '../escape' }, { username: '...' }, { username: 123 }]) {
      const p=page({ settings:{ folderOrganizationMode:'by_site_and_type',instagramAuthorFolders:true },html:feedHtml({items:[item(PK_A,CODE_A,URL_A,{user}),item(PK_B,CODE_B,URL_B,{user:{username:'neighbour.creator'}})]}) });
      try { await p.scan(); p.press(p.save(0)); await until(()=>p.exported.length); assert(p.options[0].filename.startsWith('SavedImages/instagram/video/'),p.options[0].filename); const records=await p.records();assert.equal(records[0].author,undefined); } finally {p.close();}
    }
  });
  await test('author folders: scrolling to the next Reel uses its own username and signed file', async () => {
    const p=page({ settings:{ folderOrganizationMode:'by_site_and_type',instagramAuthorFolders:true },html:feedHtml({items:[item(PK_A,CODE_A,URL_A,{user:{username:'first.creator'}}),item(PK_B,CODE_B,URL_B,{user:{username:'next.creator'}})]}) });
    try { await p.scan();p.press(p.save(0));await until(()=>p.exported.length);p.scroll(1,CODE_B);await p.scan();p.press(p.save(1));await until(()=>p.exported.length===2);assert.deepEqual(p.exported,[URL_A,URL_B]);assert(p.options[0].filename.startsWith('SavedImages/instagram/first.creator/video/'));assert(p.options[1].filename.startsWith('SavedImages/instagram/next.creator/video/')); }finally{p.close();}
  });
  // ---- Download ----
  await test('Download on the Reel in view saves that Reel\'s own exact signed file through the real worker path; the right-click capture is not read', async () => {
    const p = page(); await p.scan();
    p.press(p.save(0)); await until(() => p.exported.length);
    assert.deepEqual(p.exported, [URL_A]); assert(!p.fetched.includes(URL_B));
    assert.deepEqual(p.sent.map((m) => [m.action, m.item]), [['INSTAGRAM_INLINE_SAVE', CODE_A]]); assert(/^[a-f0-9]{32}$/.test(p.sent[0].token));
    assert(!p.scripts.some((c) => ['selectSocialPlayer', 'readContextMediaTarget', 'verifyContextOwner'].includes(c.name)));
    assert.deepEqual(p.scripts.filter((c) => c.world === 'MAIN').map((c) => [c.name, JSON.stringify(c.target)]), [['readSocialPlayerItem', JSON.stringify({ tabId: 1, documentIds: ['doc-1'] })]]);
    p.close();
  });
  await test('after scrolling to the next Reel (page URL follows), its Download saves that Reel; the previous Reel is now unproven and refused', async () => {
    const p = page(); await p.scan(); p.scroll(1, CODE_B); await p.scan();
    p.press(p.save(1)); await until(() => p.exported.length); assert.deepEqual(p.exported, [URL_B]);
    p.press(p.save(0)); await sleep(200); assert.equal(p.exported.length, 1, 'the scrolled-away Reel is not saved'); assert(p.save(0).classList.contains('is-error'));
    p.close();
  });
  await test('keyboard Enter/Space work; an untrusted click does nothing; a quick double press makes one job; a later explicit press saves again', async () => {
    let p = page(); await p.scan(); p.press(p.save(0), { key: 'Enter' }); await until(() => p.exported.length); assert.deepEqual(p.exported, [URL_A]); p.close();
    p = page(); await p.scan(); p.press(p.save(0), { trusted: false }); await sleep(150); assert.deepEqual(p.sent, []); p.close();
    p = page(); await p.scan(); p.slow = 120; p.press(p.save(0)); p.press(p.save(0)); await sleep(400);
    assert.equal(p.exported.length, 1); assert.equal(p.sent.length, 1);
    await sleep(1600); p.press(p.save(0), { key: ' ' }); await until(() => p.exported.length === 2); assert.deepEqual(p.exported, [URL_A, URL_A]); p.close();
  });
  await test('review regression: nested dialog/menu covers refuse the underlying Reel before any message or request', async () => {
    for (const attrs of ['role="dialog"', 'aria-modal="true"', 'role="menu"', 'class="LoginModal"']) {
      const p = page();
      try {
        await p.scan();
        const cover = p.d.createElement('div'); cover.innerHTML = '<span>Sign up</span>';
        const holder = p.d.createElement('div'); holder.innerHTML = '<div ' + attrs + '></div>';
        const modal = holder.firstElementChild; modal.append(cover);
        p.d.getElementById('card-0').append(modal);
        p.rects.set(cover, { left: 150, top: 200, width: 350, height: 450 });
        p.press(p.save(0)); await sleep(160);
        assert.equal(p.sent.length, 0, attrs + ' must refuse before worker admission');
        assert.deepEqual(p.fetched, []); assert.deepEqual(p.exported, []);
        assert(p.save(0).classList.contains('is-error')); assert.equal(p.save(0).querySelector('svg').getAttribute('viewBox'), '0 0 20 20');
      } finally { p.close(); }
    }
  });
  await test('a covering dialog refuses visibly before any request; a video inside a legitimate viewing dialog still saves', async () => {
    let p = page(); await p.scan(); p.d.body.insertAdjacentHTML('beforeend', '<div role="dialog" id="cover">Sign up</div>'); p.rects.set(p.d.getElementById('cover'), { left: 150, top: 200, width: 500, height: 450 });
    p.press(p.save(0)); await sleep(150); assert.deepEqual(p.sent, []); assert(p.save(0).classList.contains('is-error')); p.close();
    p = page({ html: feedHtml({ dialog: true }) }); await p.scan(); p.press(p.save(0)); await until(() => p.exported.length); assert.deepEqual(p.exported, [URL_A]); p.close();
  });
  await test('a recycled stream or reparented player at the proof, a replaced document, or page data naming another Reel saves nothing', async () => {
    let p = page(); await p.scan(); p.hook = (m) => { if (m.action === 'INSTAGRAM_INLINE_PROOF') p.d.querySelector('#card-0 video').setAttribute('data-stream', 'blob:https://www.instagram.com/recycled'); };
    p.press(p.save(0)); await sleep(300); assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); assert.deepEqual(p.failures, ['NO_MEDIA']); p.close();
    p = page(); await p.scan(); p.hook = (m) => { if (m.action === 'INSTAGRAM_INLINE_PROOF') p.d.querySelector('#card-1 .v div div').append(p.d.querySelector('#card-0 video')); };
    p.press(p.save(0)); await sleep(300); assert.deepEqual(p.exported, []); p.close();
    p = page(); await p.scan(); const ask = p.s.chrome.tabs.sendMessage; p.s.chrome.tabs.sendMessage = async (id, m, o) => { const r = await ask(id, m, o); if (m.action === 'INSTAGRAM_INLINE_PROOF') p.docId = 'doc-2'; return r; };
    p.press(p.save(0)); await sleep(300); assert.deepEqual(p.exported, []); assert.deepEqual(p.failures, ['UNRESOLVED_BLOB_MEDIA']); p.close();
    // the player's own props name an item whose shortcode is not the proven Reel
    p = page({ html: feedHtml({ items: [item(PK_A, CODE_B, URL_A), item(PK_B, CODE_B, URL_B)] }) }); await p.scan();
    p.press(p.save(0)); await sleep(300); assert.deepEqual(p.exported, []); assert(!p.fetched.length, 'no request for a Reel the props do not confirm'); p.close();
  });
  await test('the worker refuses forged senders, a replayed token and an item the document did not prove', async () => {
    for (const sender of [{ url: 'https://www.instagram.com.evil.example/reels/x/' }, { frameId: 2 }, { documentId: '' }, { tab: { id: 1, active: false, url: PAGE } }, { url: 'http://www.instagram.com/reels/x/' }]) {
      const p = page(); await p.scan(); p.sender = sender; p.press(p.save(0)); await sleep(200);
      assert.deepEqual(p.exported, [], JSON.stringify(sender)); assert.equal(p.asked || 0, 0, 'no proof asked of a forged sender'); p.close();
    }
    let p = page(); await p.scan(); p.press(p.save(0)); await until(() => p.exported.length);
    p.w.chrome.runtime.sendMessage({ action: 'INSTAGRAM_INLINE_SAVE', token: p.sent[0].token, item: CODE_A }); await sleep(250); assert.equal(p.exported.length, 1); p.close();
    p = page(); await p.scan(); const real = p.w.chrome.runtime.sendMessage; p.w.chrome.runtime.sendMessage = (m) => real({ ...m, item: CODE_B }); p.press(p.save(0)); await sleep(250);
    assert.deepEqual(p.exported, []); p.close();
  });
  await test('an item the page offers only as separate DASH tracks ends visibly as an unsupported source, with no request', async () => {
    const p = page({ html: feedHtml({ items: [item(PK_B, CODE_B, URL_B)] }) }); await p.scan();
    p.press(p.save(0)); await sleep(300); assert.deepEqual(p.fetched, []); assert.deepEqual(p.failures, ['UNSUPPORTED_SOURCE']); p.close();
  });
  console.log(`${passed} Instagram Reel control checks passed, ${failed} failed (SYNTHETIC: simulated pages, layout, fibers, input, network and export)`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
