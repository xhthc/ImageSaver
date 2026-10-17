'use strict';
// TIKTOK-CONTROLS-02: separate Copy and Download controls below the selected TikTok video's native More button, the Download proof and route, and the
// Shift-scoped browser menu. SYNTHETIC: jsdom pages shaped like the TikTok structure observed live on 2026-10-17
// (local-notes/checks/tiktok-controls01/discovery/discovery.md): article > section#media-card (player, overlay) then section.SectionActionBarContainer,
// and TikTok's own menu as a body portal [data-e2e=context-menu]. Layout, fibers, trusted input, network and export are simulated; the production
// content scripts (content_copy_kit.js, content_tiktok.js, content_context_target.js) and worker (background.js + worker modules) run unchanged.
// No live-site, real-file or audio claim.
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '..'), { JSDOM } = createRequire(path.join(ROOT, 'ui/package.json'))('jsdom');
const { createTestEnv } = require('./test_context_target_avatar');
const code = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
// each case reports its own result, so a run on the starting source lists every failing case
const test = async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('FAIL ' + name + ': ' + String(e && e.message || e).split('\n')[0]); } };

const PAGE = 'https://www.tiktok.com/@dxtmrgpz/video/7669022120734772512';
const A = '7669022120734772512', B = '7695725156328557856';
const URL_A = 'https://v16-webapp-prime.tiktok.com/video/tos/alisg/tos-alisg-pve-0037/oAAAA/?a=1988&expire=1792400000&signature=EXACT%2BA%3D';
const URL_B = 'https://v19-webapp-prime.tiktok.com/video/tos/alisg/tos-alisg-pve-0037/oBBBB/?a=1988&expire=1792400000&signature=EXACT%2BB%3D';
const MP4 = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x6d, 0x70, 0x34, 0x31, 0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65, 0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]);

const card = (n, id, stream) => `
  <article id="one-column-item-${n}" data-e2e="recommend-list-item-container" class="css-1-ArticleItemContainer">
    <div class="css-2-DivContentFlexLayout">
      <section id="media-card-${n}" data-e2e="feed-video" aria-label="Watch in full screen" class="css-3-SectionMediaCardContainer">
        <canvas></canvas>
        <div class="css-4-DivVideoPlayerContainer"><div class="css-5-DivContainer"><div class="css-6-DivBasicPlayerWrapper"><div id="xgwrapper-0-${id}"><div class="xg"><video data-stream="${stream}"></video></div></div></div></div>
          <div class="css-7-DivMediaCardOverlay"></div><button aria-label="Volume"></button><button data-e2e="more-menu-icon"></button></div>
      </section>
      <section class="css-8-SectionActionBarContainer">
        <div class="css-9-DivAvatarActionItemContainer"><a data-e2e="video-author-avatar" href="/@dxtmrgpz"></a><button data-e2e="feed-follow"></button></div>
        <div><div data-e2e="like-icon" aria-label="Like"><button></button></div></div>
        <div data-e2e="comment-icon"><button></button></div>
        <div><div data-e2e="favorite-icon"><button></button></div></div>
        <div><div data-e2e="share-icon" aria-label="Share video"><button></button></div></div>
        <a data-e2e="video-music" href="/music/x"></a>
      </section>
    </div>
  </article>`;
const feedHtml = ({ twoPlayers = false } = {}) => `<div id="app"><div id="main-content-video_detail"><div id="column-list-container">
  ${card(0, A, 'blob:https://www.tiktok.com/aaaa-stream')}${card(1, B, 'blob:https://www.tiktok.com/bbbb-stream')}
  <article data-e2e="recommend-list-item-container" id="placeholder"><div class="css-2-DivContentFlexLayout"></div></article>
</div></div></div>`;
const MENU = `<div><div id=":r27:" data-e2e="context-menu" role="dialog"><div class="desktop-playback">
  <div data-e2e="right-click-menu-popover_download-video">Download video</div><div data-e2e="right-click-menu-popover_share" aria-label="Share">Share</div>
  <div data-e2e="right-click-menu-popover_copy-link">Copy link</div></div></div></div>`;

function page({ url = PAGE, html = feedHtml(), docId = 'doc-1', worker = true } = {}) {
  const env = createTestEnv(), s = env.bgSandbox, dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window, d = w.document;
  Object.defineProperty(w, 'innerHeight', { configurable: true, value: 1800 }); // both cards on screen
  const rects = new WeakMap(), content = [], p = { w, d, s, rects, sent: [], exported: [], fetched: [], failures: [], scripts: [], docId, content };
  p.resizeInstances = [];
  w.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.targets = new Set(); p.resizeInstances.push(this); }
    observe(el) { this.targets.add(el); }
    unobserve(el) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); }
  };
  for (const v of d.querySelectorAll('video')) Object.defineProperty(v, 'currentSrc', { configurable: true, get() { return this.getAttribute('data-stream') || ''; } });
  // layout: card n occupies a 446x640 player at y = 80 + n*890, its rail to the right
  p.layout = () => {
    for (const art of d.querySelectorAll('article[id^="one-column-item-"]')) {
      const n = Number(art.id.split('-').pop()), top = 80 + n * 890;
      const set = (sel, b) => { for (const el of art.querySelectorAll(sel)) rects.set(el, b); };
      rects.set(art, { left: 100, top, width: 520, height: 700 });
      set('section[data-e2e="feed-video"], [class*="DivVideoPlayerContainer"], [class*="DivContainer"], [class*="DivBasicPlayerWrapper"], [id^="xgwrapper-"], .xg, video, [class*="DivMediaCardOverlay"]', { left: 100, top, width: 446, height: 640 });
      set('section[class*="SectionActionBarContainer"]', { left: 560, top: top + 200, width: 48, height: 440 });
      for (const b of art.querySelectorAll('section[class*="SectionActionBarContainer"] > *, .image-saver-tt-copy-wrap, .image-saver-tt-save-wrap')) if (!rects.has(b)) rects.set(b, { left: 564, top: top + 220, width: 40, height: 40 });
    }
    const menu = d.querySelector('[data-e2e="context-menu"]'); if (menu) for (const el of [menu, ...menu.querySelectorAll('*')]) rects.set(el, { left: 200, top: 200, width: 300, height: 400 });
  };
  p.layout();
  const anchorGeometry = new WeakMap(); p.anchorGeometry = anchorGeometry;
  const prepareAnchors = () => {
    for (const more of d.querySelectorAll('button[data-e2e="more-menu-icon"]')) {
      if (Object.hasOwn(more, 'offsetParent')) continue;
      anchorGeometry.set(more, { host: more.parentElement, left: 390, top: 8, width: 48, height: 48 });
      for (const [key, field] of [['offsetParent','host'],['offsetLeft','left'],['offsetTop','top'],['offsetWidth','width'],['offsetHeight','height']])
        Object.defineProperty(more, key, { configurable: true, get: () => anchorGeometry.get(more)[field] });
    }
  };
  prepareAnchors(); p.prepareAnchors = prepareAnchors;
  w.Element.prototype.getBoundingClientRect = function () { const b = rects.get(this) || { left: 0, top: 0, width: 0, height: 0 }; return { ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top }; };
  const stack = (x, y) => [...d.querySelectorAll('*')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom; }).reverse();
  d.elementsFromPoint = stack; d.elementFromPoint = (x, y) => stack(x, y)[0] || null;
  // trusted input is simulated: an event marked testTrusted is reported trusted to the listeners
  const wrappers = new WeakMap(), add = w.EventTarget.prototype.addEventListener, remove = w.EventTarget.prototype.removeEventListener;
  w.EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (typeof fn !== 'function') return add.call(this, type, fn, opts);
    if (!wrappers.has(fn)) wrappers.set(fn, (e) => fn(new Proxy(e, { get: (t, k) => (k === 'isTrusted' ? t.testTrusted === true : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) })));
    return add.call(this, type, wrappers.get(fn), opts);
  };
  w.EventTarget.prototype.removeEventListener = function (type, fn, opts) { return remove.call(this, type, wrappers.get(fn) || fn, opts); };
  // the page world's React fibers (observed shape): the player wrapper's component props name its item
  for (const [id, url] of [[A, URL_A], [B, URL_B]]) {
    const host = d.querySelector(`#xgwrapper-0-${id}`)?.parentElement; if (!host) continue;
    let f = null; for (const props of [...[{ item: { id, author: 'dxtmrgpz', video: { playAddr: url } } }, ...Array.from({ length: 24 }, () => ({ className: 'layer' }))]].reverse()) f = { memoizedProps: props, return: f };
    host['__reactFiber$test'] = f; // walking .return from the host reaches the item 24 levels up
  }
  w.chrome = {
    runtime: { id: s.chrome.runtime.id, onMessage: { addListener: (fn) => content.push(fn), removeListener: (fn) => { const i = content.indexOf(fn); if (i >= 0) content.splice(i, 1); } },
      sendMessage: async (msg) => { if (msg.action !== 'CONTEXT_TARGET_STATE') p.sent.push(msg); /* menu hints are not saves */ if (!worker) return; const sender = { id: s.chrome.runtime.id, tab: { id: 1, active: true, url: w.location.href }, frameId: 0, documentId: p.docId, url: w.location.href, ...p.sender }; for (const fn of s.chrome.runtime.onMessage._listeners) fn(msg, sender, () => {}); } },
    storage: { local: { get: (k, cb) => { const r = { ...(k && typeof k === 'object' ? k : {}) }; if (cb) cb(r); return Promise.resolve(r); } }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'en' }
  };
  // the worker: REAL admission, resolution, probe; the network and the export are stand-ins
  s.TextDecoder = TextDecoder; s.Buffer = Buffer;
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
  s.managedDownload = async (options) => { await sleep(p.slow || 0); const r = await s.fetch(options.url, { method: 'GET' }); if (!r.ok) throw Error('HTTP_ERROR'); p.exported.push(options.url); return s.chrome.downloads.download(options); };
  const fail = s.fbFail; s.fbFail = async (op, info) => { if (info && info.code) p.failures.push(info.code); return fail(op, info); };
  w.eval(code('lib/debug_journal.js')); w.eval(code('lib/i18n.js'));
  p.inject = () => { w.eval(code('content/content_copy_kit.js')); w.eval(code('content/content_tiktok.js')); };
  w.eval(code('content/content_context_target.js'));
  p.inject();
  p.scan = async () => { prepareAnchors(); w.__scanAndInjectTikTokCopyButtons(d); p.layout(); await sleep(5); };
  p.rail = (n) => d.querySelector(`#one-column-item-${n} section[class*="SectionActionBarContainer"]`);
  p.ours = (root = d) => [...root.querySelectorAll('.image-saver-tt-copy-wrap, .image-saver-tt-save-wrap')];
  p.save = (n) => d.querySelector(`#one-column-item-${n} .image-saver-tt-save-wrap`);
  p.press = (el, { trusted = true, key = '' } = {}) => {
    const e = key ? new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) : new w.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 584, clientY: 300 });
    e.testTrusted = trusted; el.dispatchEvent(e);
  };
  p.close = () => w.close();
  return p;
}
const until = async (fn, ms = 3000) => { for (let i = 0; i < ms / 10 && !fn(); i++) await sleep(10); };
const rightClick = (p, el, shift) => {
  const b = el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
  for (const type of ['mousedown', 'contextmenu']) { const e = new p.w.MouseEvent(type, { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y, shiftKey: shift }); e.testTrusted = true; el.dispatchEvent(e); if (type === 'contextmenu') return e; }
};

(async () => {
  // ---- placement: separate Copy and Download below the owning native More icon ----
  await test('each loaded card gets one Copy and one Download below its native More button, leaving the action rail untouched', async () => {
    const p = page();
    try {
      await p.scan();
      for (const n of [0, 1]) {
        const card = p.d.getElementById('one-column-item-' + n), more = card.querySelector('button[data-e2e="more-menu-icon"]');
        const mine = p.ours(card);
        assert.equal(mine.length, 2); assert(mine.every(e => e.parentElement === more.offsetParent));
        assert.equal(p.ours(p.rail(n)).length, 0, 'native action rail is untouched');
        assert.equal(mine[0].style.position, 'absolute');
        assert.equal(mine[0].style.left, '394px'); assert.equal(mine[0].style.top, '62px');
        assert.equal(mine[1].style.left, '394px'); assert.equal(mine[1].style.top, '108px');
        assert.equal(mine[1].getAttribute('role'), 'button'); assert.equal(mine[1].getAttribute('tabindex'), '0');
        assert.match(mine[1].getAttribute('aria-label'), /MediaLatch/);
      }
      assert.equal(p.ours(p.d.getElementById('placeholder')).length, 0);
    } finally { p.close(); }
  });
  await test('hovered Copy and Download glyphs retain contrast over a white video frame', async () => {
    const p = page();
    try {
      await p.scan();
      const rules = [...p.d.styleSheets].flatMap(sheet => [...sheet.cssRules]);
      const rgb = value => {
        const channels = value.match(/[\d.]+/g)?.map(Number);
        assert(channels && channels.length >= 3, 'expected an actual RGB colour');
        return channels;
      };
      const luminance = channels => channels.slice(0, 3).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      for (const control of p.ours(p.d.getElementById('one-column-item-0'))) {
        const selector = '.' + control.classList[0] + ':hover';
        const rule = rules.find(rule => rule.selectorText?.split(',').map(s => s.trim()).includes(selector));
        assert(rule, 'production hover rule exists for ' + selector);
        const bg = rgb(rule.style.getPropertyValue('background-color')), fg = rgb(p.w.getComputedStyle(control).color);
        const alpha = bg[3] ?? 1, overWhite = bg.slice(0, 3).map(c => c * alpha + 255 * (1 - alpha));
        const light = Math.max(luminance(fg), luminance(overWhite)), dark = Math.min(luminance(fg), luminance(overWhite));
        const contrast = (light + 0.05) / (dark + 0.05);
        assert(contrast >= 3, selector + ' contrast over white is ' + contrast.toFixed(2) + ':1; expected at least 3:1');
      }
    } finally { p.close(); }
  });
  await test('native More removal, replacement, ambiguity and resize never leave detached or duplicate controls', async () => {
    const p = page();
    try {
      await p.scan(); const art = p.d.getElementById('one-column-item-0');
      const old = art.querySelector('button[data-e2e="more-menu-icon"]'), host = old.parentElement;
      old.remove(); await sleep(80);
      assert.equal(p.ours(art).length, 0, 'More-only removal triggers cleanup without an explicit scan');
      const fresh = old.cloneNode(); host.append(fresh); p.prepareAnchors(); await sleep(80);
      assert.equal(p.ours(art).length, 2);
      p.anchorGeometry.get(fresh).left = 250; p.anchorGeometry.get(fresh).top = 14;
      p.w.dispatchEvent(new p.w.Event('resize')); await sleep(80);
      assert.equal(p.ours(art)[0].style.left, '254px'); assert.equal(p.ours(art)[0].style.top, '68px');
      const duplicate = fresh.cloneNode(); host.append(duplicate); p.prepareAnchors(); await sleep(80);
      assert.equal(p.ours(art).length, 0, 'two native More anchors are ambiguous');
      duplicate.remove(); await sleep(80); assert.equal(p.ours(art).length, 2);
    } finally { p.close(); }
  });
  await test('repeated scans, a second injection of the scripts and the observer never duplicate a control', async () => {
    const p = page(); await p.scan(); await p.scan(); p.inject(); await sleep(80); await p.scan();
    p.w.dispatchEvent(new p.w.PopStateEvent('popstate')); await sleep(80);
    assert.equal(p.resizeInstances.filter(r => r.targets.size > 0).length, 1, 'old reinjected callbacks cannot restart disconnected observers');
    for (const n of [0, 1]) assert.equal(p.ours(p.d.getElementById(`one-column-item-${n}`)).length, 2);
    p.close();
  });
  await test('TikTok\'s own right-click menu (a body portal with Share and Copy link) never receives a control, and one placed there earlier is removed', async () => {
    const p = page(); await p.scan();
    p.d.body.insertAdjacentHTML('beforeend', MENU); p.layout();
    const stale = p.d.createElement('div'); stale.className = 'image-saver-tt-copy-wrap'; p.d.querySelector('[data-e2e="context-menu"] .desktop-playback').append(stale);
    await p.scan(); await sleep(60);
    assert.equal(p.ours(p.d.querySelector('[data-e2e="context-menu"]')).length, 0);
    p.d.querySelector('[data-e2e="context-menu"]').parentElement.remove(); await p.scan();
    for (const n of [0, 1]) assert.equal(p.ours(p.d.getElementById(`one-column-item-${n}`)).length, 2, 'menu open/close leaves the rails as they were');
    p.close();
  });
  await test('old action-rail controls move below More; replacing its host restores exactly one pair', async () => {
    const p = page();
    try {
      p.rail(0).insertAdjacentHTML('beforeend', '<div class="image-saver-tt-copy-wrap"></div><div class="image-saver-tt-save-wrap"></div>');
      await p.scan();
      assert.equal(p.ours(p.rail(0)).length, 0);
      const old = p.d.querySelector('#media-card-0 [class*="DivVideoPlayerContainer"]'), fresh = old.cloneNode(true);
      for (const e of p.ours(fresh)) e.remove(); old.replaceWith(fresh); p.layout(); await p.scan(); await p.scan();
      assert.equal(p.ours(p.d.getElementById('one-column-item-0')).length, 2);
      assert(p.ours(p.d.getElementById('one-column-item-0')).every(e => e.parentElement === fresh));
    } finally { p.close(); }
  });
  await test('a card with two players is ambiguous: Copy may stay, no Download', async () => {
    const p = page(); const extra = p.d.createElement('video'); p.d.querySelector('#media-card-0 .xg').append(extra);
    await p.scan();
    assert.equal(p.d.querySelectorAll('#one-column-item-0 .image-saver-tt-save-wrap').length, 0); assert.equal(p.d.querySelectorAll('#one-column-item-1 .image-saver-tt-save-wrap').length, 1);
    p.close();
  });
  await test('review regression: unknown containers cannot replace a missing More anchor', async () => {
    for (const shape of ['DivContentContainer', 'RightContainer', 'ActionItemContainer', '']) {
      const p = page();
      try {
        p.d.querySelector('#one-column-item-0 button[data-e2e="more-menu-icon"]').remove();
        if (shape) p.d.querySelector('#one-column-item-0').insertAdjacentHTML('beforeend', '<div class="css-unknown-' + shape + '">Caption only</div>');
        p.d.querySelector('#media-card-0').insertAdjacentHTML('beforeend', '<div class="image-saver-tt-copy-wrap"></div><div class="image-saver-tt-save-wrap"></div>');
        await p.scan();
        assert.equal(p.ours(p.d.querySelector('#one-column-item-0')).length, 0, shape || 'no rail');
        assert.equal(p.ours(p.d.querySelector('#one-column-item-1')).length, 2, 'the adjacent valid card is preserved');
      } finally { p.close(); }
    }
  });
  await test('review regression: covers inside the card refuse; a viewing dialog containing the actual video remains usable', async () => {
    for (const attr of ['role="dialog"', 'aria-modal="true"', 'class="ShareModal"', 'role="menu"', 'data-e2e="context-menu"']) {
      const p = page();
      try {
        await p.scan();
        p.d.querySelector('#one-column-item-0').insertAdjacentHTML('beforeend', '<div id="local-cover" ' + attr + '>Login or share sheet</div>');
        p.rects.set(p.d.getElementById('local-cover'), { left: 100, top: 80, width: 446, height: 640 });
        p.press(p.save(0)); await sleep(60);
        assert.deepEqual(p.sent, [], attr); assert.deepEqual(p.exported, [], attr);
        assert(p.save(0).classList.contains('is-error'), 'refusal stays visible');
      } finally { p.close(); }
    }
    const p = page();
    try {
      const art = p.d.querySelector('#one-column-item-0'), dialog = p.d.createElement('dialog');
      art.before(dialog); dialog.append(art); await p.scan();
      p.press(p.save(0)); await until(() => p.exported.length);
      assert.deepEqual(p.exported, [URL_A], 'the dialog owns the selected player');
    } finally { p.close(); }
  });
  await test('review regression: invisible players refuse; a card becoming ambiguous loses its controls', async () => {
    let p = page();
    try {
      await p.scan();
      p.rects.set(p.d.querySelector('#media-card-0 video'), { left: 100, top: 80, width: 0, height: 0 });
      p.press(p.save(0)); await sleep(60); assert.deepEqual(p.sent, []); assert.deepEqual(p.exported, []);
    } finally { p.close(); }
    p = page();
    try {
      await p.scan();
      p.d.querySelector('#one-column-item-0').insertAdjacentHTML('beforeend', '<div id="xgwrapper-0-7669022120734772999"><video></video></div>');
      await p.scan();
      assert.equal(p.ours(p.d.querySelector('#one-column-item-0')).length, 0);
      assert.equal(p.ours(p.d.querySelector('#one-column-item-1')).length, 2);
    } finally { p.close(); }
  });
  await test('review regression: local and transport refusals have a non-color error glyph and localized label', async () => {
    for (const mode of ['covered', 'throw', 'reject']) {
      const p = page();
      try {
        await p.scan(); const button = p.save(0), normal = button.innerHTML;
        if (mode === 'covered') {
          p.d.querySelector('#one-column-item-0').insertAdjacentHTML('beforeend', '<div role="dialog" id="transport-cover"></div>');
          p.rects.set(p.d.getElementById('transport-cover'), { left: 100, top: 80, width: 446, height: 640 });
        } else {
          const real = p.w.chrome.runtime.sendMessage;
          p.w.chrome.runtime.sendMessage = (m) => {
            if (m.action !== 'TIKTOK_INLINE_SAVE') return real(m);
            if (mode === 'throw') throw Error('Extension context invalidated');
            return Promise.reject(Error('Receiving end does not exist'));
          };
        }
        p.press(button); await sleep(60);
        assert(button.classList.contains('is-error'), mode); assert.notEqual(button.innerHTML, normal, 'error is not color alone');
        assert.equal(button.getAttribute('aria-label'), 'The action could not be completed.');
        assert.equal(button.getAttribute('title'), 'The action could not be completed.');
        assert.deepEqual(p.exported, []);
      } finally { p.close(); }
    }
  });
  // ---- Download: the trusted press freezes the card's own player; the worker resolves exactly that item ----
  await test('Download on card B saves B\'s own exact signed file through the real worker path; A is never asked or fetched; the right-click capture is not read', async () => {
    const p = page(); await p.scan();
    rightClick(p, p.d.querySelector('#media-card-0 [class*="DivMediaCardOverlay"]'), false); // an earlier right-click on A
    p.press(p.save(1)); await until(() => p.exported.length);
    assert.deepEqual(p.exported, [URL_B]); assert(!p.fetched.includes(URL_A));
    assert.deepEqual(p.sent.map((m) => [m.action, m.item]), [['TIKTOK_INLINE_SAVE', B]], 'only a token and the item id travel');
    assert(/^[a-f0-9]{32}$/.test(p.sent[0].token));
    assert(!p.scripts.some((c) => c.name === 'selectSocialPlayer' || c.name === 'readContextMediaTarget' || c.name === 'verifyContextOwner'), 'no right-click capture involved');
    assert.deepEqual(p.scripts.filter((c) => c.world === 'MAIN').map((c) => [c.name, JSON.stringify(c.target)]), [['readSocialPlayerItem', JSON.stringify({ tabId: 1, documentIds: ['doc-1'] })]]);
    p.close();
  });
  await test('keyboard (Enter/Space) presses work; an untrusted click does nothing; a rapid second press makes no second job; a later explicit press saves again', async () => {
    let p = page(); await p.scan();
    p.press(p.save(0), { key: 'Enter' }); await until(() => p.exported.length); assert.deepEqual(p.exported, [URL_A]); p.close();
    p = page(); await p.scan(); p.press(p.save(0), { trusted: false }); await sleep(150); assert.deepEqual(p.sent, []); assert.deepEqual(p.exported, []); p.close();
    p = page(); await p.scan(); p.slow = 120;
    p.press(p.save(1)); p.press(p.save(1)); await sleep(400);
    assert.equal(p.exported.length, 1, 'one job for a double click'); assert.equal(p.sent.length, 1, 'the second press is ignored while busy');
    await sleep(1600); p.press(p.save(1), { key: ' ' }); await until(() => p.exported.length === 2);
    assert.deepEqual(p.exported, [URL_B, URL_B], 'an explicit later save is honoured'); p.close();
  });
  await test('a player covered by a dialog/menu, offscreen, recycled to another stream or reparented before the proof saves nothing and requests nothing', async () => {
    let p = page(); await p.scan(); p.d.body.insertAdjacentHTML('beforeend', '<div role="dialog" id="cover"></div>'); p.rects.set(p.d.getElementById('cover'), { left: 0, top: 0, width: 1024, height: 768 });
    p.press(p.save(0)); await sleep(150); assert.deepEqual(p.sent, [], 'covered: nothing sent'); assert(p.save(0).classList.contains('is-error'), 'a visible refusal'); p.close();
    p = page(); await p.scan(); for (const sel of ['#one-column-item-0', '#one-column-item-0 *']) for (const el of p.d.querySelectorAll(sel)) { const b = p.rects.get(el); if (b) p.rects.set(el, { ...b, top: b.top - 5000 }); }
    p.press(p.save(0)); await sleep(150); assert.deepEqual(p.sent, [], 'offscreen: nothing sent'); p.close();
    p = page(); await p.scan(); p.hook = (m) => { if (m.action === 'TIKTOK_INLINE_PROOF') p.d.querySelector('#media-card-1 video').setAttribute('data-stream', 'blob:https://www.tiktok.com/recycled'); };
    p.press(p.save(1)); await sleep(300); assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); assert.deepEqual(p.failures, ['NO_MEDIA']); p.close();
    p = page(); await p.scan(); p.hook = (m) => { if (m.action === 'TIKTOK_INLINE_PROOF') p.d.querySelector('#one-column-item-0 .xg').append(p.d.querySelector('#media-card-1 video')); };
    p.press(p.save(1)); await sleep(300); assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); p.close();
  });
  await test('the worker refuses forged senders and items, replays, a replaced document and an item the page props do not confirm', async () => {
    for (const sender of [{ url: 'https://www.tiktok.com.evil.example/@a/video/1' }, { frameId: 3 }, { documentId: '' }, { tab: { id: 1, active: false, url: PAGE } }, { url: 'http://www.tiktok.com/@a/video/1' }]) {
      const p = page(); await p.scan(); p.sender = sender; p.press(p.save(0)); await sleep(200);
      assert.deepEqual(p.exported, [], JSON.stringify(sender)); assert.equal(p.asked || 0, 0, 'no proof is asked of a forged sender'); p.close();
    }
    let p = page(); await p.scan(); p.press(p.save(0)); await until(() => p.exported.length);
    p.w.chrome.runtime.sendMessage({ action: 'TIKTOK_INLINE_SAVE', token: p.sent[0].token, item: A }); await sleep(250);
    assert.equal(p.exported.length, 1, 'a replayed token saves nothing more'); p.close();
    p = page(); await p.scan(); const real = p.w.chrome.runtime.sendMessage; p.w.chrome.runtime.sendMessage = (m) => real({ ...m, item: B }); p.press(p.save(0)); await sleep(250);
    assert.deepEqual(p.exported, [], 'the item named by the message must be the one the document proves'); p.close();
    // the document is replaced right after it proved the player: the pinned page-world read must fail
    p = page(); await p.scan(); const ask = p.s.chrome.tabs.sendMessage; p.s.chrome.tabs.sendMessage = async (id, m, o) => { const r = await ask(id, m, o); if (m.action === 'TIKTOK_INLINE_PROOF') p.docId = 'doc-2'; return r; };
    p.press(p.save(0)); await sleep(300); assert.deepEqual(p.exported, []); assert.deepEqual(p.fetched, []); assert.deepEqual(p.failures, ['UNRESOLVED_BLOB_MEDIA']); p.close();
    // the player moves into another card's wrapper after its document proved it: the page props then name that other item, which is refused
    p = page(); await p.scan(); const ask2 = p.s.chrome.tabs.sendMessage; p.s.chrome.tabs.sendMessage = async (id, m, o) => { const r = await ask2(id, m, o); if (m.action === 'TIKTOK_INLINE_PROOF') p.d.querySelector('#xgwrapper-0-' + A + ' .xg').append(p.d.querySelector('#media-card-1 video')); return r; };
    p.press(p.save(1)); await sleep(300); assert.deepEqual(p.exported, [], 'a player that changed wrapper after the proof is not saved as the other item'); assert(!p.fetched.includes(URL_A)); assert.deepEqual(p.failures, ['UNRESOLVED_BLOB_MEDIA']); p.close();
    p = page(); await p.scan(); p.d.querySelector('#xgwrapper-0-' + B).parentElement['__reactFiber$test'] = { memoizedProps: { item: { id: A, video: { playAddr: URL_A } } }, return: null };
    p.press(p.save(1)); await sleep(300); assert.deepEqual(p.exported, [], 'props naming another item are refused'); assert(!p.fetched.includes(URL_A)); p.close();
  });
  // ---- right-click: TikTok keeps its own menu; Shift+right-click on a player card opens the browser menu ----
  await test('right-click: plain keeps TikTok\'s own menu; Shift on the player card (overlay or player) keeps the browser menu and is captured as the player; Shift on the rail or elsewhere is TikTok\'s', async () => {
    const p = page({ worker: false }); await p.scan();
    let tiktokMenu = 0; p.d.addEventListener('contextmenu', (e) => { tiktokMenu++; e.preventDefault(); e.stopPropagation(); }); // TikTok's own listener (above the card, observed)
    const overlay = p.d.querySelector('#media-card-0 [class*="DivMediaCardOverlay"]');
    assert.equal(rightClick(p, overlay, false).defaultPrevented, true); assert.equal(tiktokMenu, 1, 'plain right-click: TikTok opens its menu');
    assert.equal(rightClick(p, overlay, true).defaultPrevented, false); assert.equal(tiktokMenu, 1, 'Shift right-click on the overlay: the page handler is not reached, nothing is prevented');
    assert.equal(p.w.__imageSaverContextTarget.media && p.w.__imageSaverContextTarget.media.kind, 'player', 'the capture names the card\'s player for "Save media"');
    assert.equal(rightClick(p, p.d.querySelector('#media-card-0 video'), true).defaultPrevented, false, 'Shift on the player itself as well');
    assert.equal(rightClick(p, p.d.querySelector('#one-column-item-0 [data-e2e="like-icon"]'), true).defaultPrevented, true, 'the rail is not a player card');
    assert.equal(tiktokMenu, 2);
    p.close();
    const q = page({ url: 'https://www.instagram.com/reels/DefTURuSN2j/', worker: false }); let igMenu = 0; q.d.addEventListener('contextmenu', (e) => { igMenu++; e.preventDefault(); });
    rightClick(q, q.d.querySelector('#media-card-0 [class*="DivMediaCardOverlay"]'), true); assert.equal(igMenu, 1, 'other sites keep their own handlers'); q.close();
  });
  console.log(`${passed} TikTok control checks passed, ${failed} failed (SYNTHETIC: simulated pages, layout, fibers, input, network and export)`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
