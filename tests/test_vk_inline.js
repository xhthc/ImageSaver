'use strict';
// VK-INLINE-01: the inline Save this / Save all (N) controls on vk.ru, through the production routes: the real content script (content/content_inline.js, in a jsdom window) -> a real
// message to the real background.js (sender checks, one-shot token, same frame and document proof, frozen batch items) -> the real generic resolver and download pipeline (the one the
// context menu uses; there is no VK downloader). Everything the pages here contain is DERIVED, not live VK: the host family (*.vkuserphoto.ru), the .jpg extension, the
// /photo-OWNER_ID, /video-... and /clip-... link routes and a loaded <img> were observed or are public route shapes; the post markup, semantic ARIA attachment lists (standards-derived, not observed on VK), the attribute NAMES that carry the post
// key, the video hosts (taken from the page's own published CSP) and the query parameter names are placeholders chosen only to exercise the code (the handler reads values, never names).
// The final carousel/grid regressions reproduce sanitized live VK structure captured on 2026-10-16; other structures above remain derived. Layout is stubbed (jsdom has none). A fixture proves code, not original bytes or live-site acceptance.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const { JSDOM } = createRequire(path.join(ROOT, 'ui/package.json'))('jsdom');
const { createTestEnv } = require('./test_context_target_avatar');
const png = fs.readFileSync(path.join(ROOT, 'icons/128.png'));
const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 4000) { for (let t = 0; t < ms; t += 10) { if (await fn()) return; await sleep(10); } throw new Error('TIMEOUT ' + what); }
// a minimal complete MP4 start (ftyp isom): what the existing direct-video verification accepts
const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x6d, 0x70, 0x34, 0x31]);

const OWNER = '218466214', POST = '1601', PAGE = `https://vk.ru/wall-${OWNER}_${POST}`;
const SIG = 'S1gN4tUr3x9z', SHORT = '48151623';            // fake signature bytes that must never reach a log; a short numeric secret
const photo = (n, host = 'sun9-52.vkuserphoto.ru') => `https://${host}/impg/p${n}AbCd/photo${n}.jpg?size=849x1133&quality=95&sign=${SIG}${n}&cs=${SHORT}&type=album`;
const video = (n, host = 'vkvd1.okcdn.ru') => `https://${host}/vid${n}/video${n}.mp4?extra=${SIG}${n}&hash=${SHORT}`;
const poster = (n) => photo(500 + n);
const AVATAR = 'https://sun9-1.vkuserphoto.ru/impg/avatar.jpg?size=50x50&sign=' + SIG;
const route = { photo: (n) => `/photo-${OWNER}_45723941${n}`, video: (n) => `/video-${OWNER}_45623900${n}`, clip: (n) => `/clip-${OWNER}_45623977${n}` };

function build({ url = PAGE, html, lang = 'en', failUrls = [], batch = false, contentLog = null }) {
  const bg = createTestEnv(), s = bg.bgSandbox, calls = [], failures = [], opened = [], sent = [], asks = [], logs = [], begun = [], contentListeners = [];
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window;
  const rects = new WeakMap(), shadows = new WeakMap(), placed = new Set(), pinned = new Set();
  Object.defineProperty(w, 'innerWidth', { value: 1400 }); Object.defineProperty(w, 'innerHeight', { value: 2400 });
  // jsdom has no layout, hit testing, loading or trusted events: the harness supplies rectangles, a hit stack, closed-shadow access, `complete`/natural sizes and a test flag for isTrusted
  const rectOf = (el) => {
    // the control is a local absolute child of its container (or of the body): its page rectangle is the container's rectangle plus its own offset
    if (el.getAttribute && el.getAttribute('data-image-saver-inline')) { const st = el.style, base = el.parentElement && el.parentElement !== el.ownerDocument.body ? rects.get(el.parentElement) : null; return { left: (base ? base.left : 0) + parseFloat(st.left), top: (base ? base.top : 0) + parseFloat(st.top), width: parseFloat(st.width), height: parseFloat(st.height) }; }
    return rects.get(el);
  };
  w.Element.prototype.getBoundingClientRect = function () { const r = rectOf(this); return r ? { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
  // paint order of an element: the (z, depth) of every transformed ancestor (a stacking context) from the outside in, then its own z and depth; compared lexicographically, highest first
  const orderKey = (el, r) => {
    const ancestors = []; for (let a = el.parentElement; a; a = a.parentElement) ancestors.unshift(a);
    const key = []; for (const a of ancestors) { const tr = a.style && a.style.transform; if (tr && tr !== 'none') key.push((rects.get(a) || {}).z || 0, hitDepth(a)); }
    key.push(el.hasAttribute('data-image-saver-inline') ? 1e9 : (r.z || 0), hitDepth(el));
    return key;
  };
  const cmpKey = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (b[i] ?? -1) - (a[i] ?? -1); if (d) return d; } return 0; };
  const hitDepth = (el) => { let d = 0; for (let p = el; p; p = p.parentElement) d++; return d; };
  // like a browser, a point outside an ancestor that clips its content does not hit the content (an image that overflows its tile is only hit inside the tile)
  const clippedAt = (el, x, y) => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = w.getComputedStyle(a); if (!/^(?:hidden|clip)$/.test(cs.overflow) && !/^(?:hidden|clip)$/.test(cs.overflowX) && !/^(?:hidden|clip)$/.test(cs.overflowY)) continue;
      const r = rects.get(a); if (r && !(x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height)) return true;
    }
    return false;
  };
  const stackAt = (x, y) => {
    const hits = [];
    for (const el of w.document.querySelectorAll('*')) { const r = rectOf(el); if (r && x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height && !clippedAt(el, x, y)) hits.push([orderKey(el, r), el]); }
    return hits.sort((a, b) => cmpKey(a[0], b[0])).map((h) => h[1]);
  };
  w.document.elementsFromPoint = stackAt;
  w.document.elementFromPoint = (x, y) => stackAt(x, y)[0] || null;
  const loaded = (root) => {
    for (const img of root.querySelectorAll('img')) { if (img.__vk) continue; img.__vk = true; Object.defineProperty(img, 'complete', { configurable: true, get() { return !this.hasAttribute('data-loading'); } }); Object.defineProperty(img, 'naturalWidth', { configurable: true, get() { return this.hasAttribute('data-loading') ? 0 : 849; } }); Object.defineProperty(img, 'naturalHeight', { configurable: true, get() { return this.hasAttribute('data-loading') ? 0 : 1133; } }); Object.defineProperty(img, 'currentSrc', { configurable: true, get() { return this.getAttribute('src') || ''; } }); }
    for (const v of root.querySelectorAll('video')) { if (v.__vk) continue; v.__vk = true; Object.defineProperty(v, 'currentSrc', { configurable: true, get() { return this.getAttribute('src') || ''; } }); }
  };
  loaded(w.document);
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (init) { const root = attach.call(this, init); shadows.set(this, root); return root; };
  const wrapped = new WeakMap(), add = w.EventTarget.prototype.addEventListener, remove = w.EventTarget.prototype.removeEventListener;
  w.EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (typeof fn !== 'function') return add.call(this, type, fn, opts);
    if (!wrapped.has(fn)) wrapped.set(fn, function (ev) { return fn.call(this, new Proxy(ev, { get: (t, p) => (p === 'isTrusted' ? t.testTrusted === true : (typeof t[p] === 'function' ? t[p].bind(t) : t[p])) })); });
    return add.call(this, type, wrapped.get(fn), opts);
  };
  w.EventTarget.prototype.removeEventListener = function (type, fn, opts) { return remove.call(this, type, wrapped.get(fn) || fn, opts); };

  const page = { w, d: w.document, bg, s, calls, failures, opened, sent, asks, logs, begun, contentListeners, documentId: 'doc-1', senderOverride: null, proofHook: null, beforeAsk: null, delay: {}, cancelled: false, scrolled: 0, rects, loaded: () => loaded(w.document) };
  w.chrome = { runtime: { id: 'mock-extension-id', sendMessage: (msg) => {
    sent.push(msg);
    const sender = Object.assign({ id: 'mock-extension-id', tab: { id: 1, active: true, url: w.location.href }, frameId: 0, documentId: page.documentId, url: w.location.href }, page.senderOverride);
    for (const cb of s.chrome.runtime.onMessage._listeners) cb(msg, sender, () => {});
    return Promise.resolve();
  }, onMessage: { addListener: (fn) => contentListeners.push(fn), removeListener: (fn) => { const i = contentListeners.indexOf(fn); if (i >= 0) contentListeners.splice(i, 1); } } },
  i18n: { getUILanguage: () => lang }, storage: { local: { get: async () => ({ uiLanguage: lang }) }, onChanged: { addListener() {} } } };
  s.chrome.tabs.get = async (id) => ({ id, url: w.location.href });
  s.chrome.tabs.sendMessage = async (tabId, msg, opts = {}) => {
    asks.push({ msg, opts });
    if (page.beforeAsk) page.beforeAsk(msg);
    const frame = page.senderOverride && 'frameId' in page.senderOverride ? page.senderOverride.frameId : 0;      // the frame that sent the message is the frame that answers
    if (opts.frameId !== frame || (opts.documentId && opts.documentId !== page.documentId)) throw new Error('Could not establish connection. Receiving end does not exist.');
    return new Promise((resolve) => {
      let answered = false;
      for (const cb of contentListeners) cb(msg, { id: 'mock-extension-id' }, (v) => { answered = true; resolve(page.proofHook ? page.proofHook(msg, v) : v); });
      setTimeout(() => { if (!answered) resolve(undefined); }, 30);
    });
  };
  s.chrome.scripting.executeScript = async (call) => {
    if (call.target.documentIds && !call.target.documentIds.includes(page.documentId)) throw new Error('No document with id');
    return [{ result: w.eval('(' + call.func + ')')(...(call.args || [])), documentId: page.documentId }];
  };
  s.TextDecoder = TextDecoder; s.URLSearchParams = URLSearchParams; s.Buffer = Buffer;
  // a stale or foreign context-menu capture must never decide an inline click: if the pipeline asked the gesture gate about this selection it would be refused
  s.resolveContextOwner = async () => 'refused';
  // everything the worker prints or journals is collected (never forwarded): a secret must not be in any of it
  const say = (...args) => { logs.push(args.map((a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (_) { return String(a); } }).join(' ')); };
  s.console = { log: say, info: say, warn: say, error: say, debug: say };
  // the journal stores what its own sanitizer lets through (allowlisted keys, a host instead of an address); the same reduction is applied here to see what would be stored
  const journal = s.dbg; s.dbg = (comp, act, out, why, details, extra) => { try { logs.push('journal ' + JSON.stringify(s.ImageSaverDebug.sanitizeEvent({ t: Date.now(), lvl: 'info', comp, act, out, why: why || undefined, d: typeof details === 'function' ? details() : details }, { src: 'worker' }))); } catch (_) {} return journal(comp, act, out, why, details, extra); };
  const isMp4 = (u) => /\.mp4(\?|$)/.test(u);
  s.fetch = async (raw, options = {}) => {
    calls.push({ url: raw, method: options.method || 'GET' });
    if (page.delay[raw]) await sleep(page.delay[raw]);
    if (failUrls.includes(raw)) return new Response('gone', { status: 404 });
    if (/^https:\/\/vk\.(?:ru|com)\/al_video\.php\?act=show$/.test(raw)) {
      const form = new URLSearchParams(options.body); (page.vkRequests ||= []).push({ url: raw, options, form });
      return Response.json(page.vkMetadata?.[form.get('video')] || { payload: [0, []] });
    }
    if (page.vkFiles?.[raw]) {
      const f = page.vkFiles[raw];
      return new Response(options.method === 'HEAD' ? null : f.bytes, { headers: { 'content-type': f.mime, 'content-length': String(f.bytes.length) } });
    }
    if (isMp4(raw)) return new Response(options.method === 'HEAD' ? null : mp4, { headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) } });
    if (/vkuserphoto\.ru|userapi\.com/.test(raw)) return new Response(options.method === 'HEAD' ? null : png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    return new Response('not found', { status: 404 });
  };
  vm.runInContext('PAWCHIVE_POST_MEDIA_PACE_MS=0', s);
  // the progress record of a batch: a stand-in that records what the manager would be told (the real manager is exercised by test_download_manager / test_ux_feedback)
  s.batchOpen = async (site, count, partial) => { opened.push([site, count, partial]); return batch ? { id: 'batch-test' } : null; };
  s.batchStopped = async (ref) => Boolean(ref) && page.cancelled;
  const fail = s.fbFail; s.fbFail = async (op, failure) => { failures.push(failure); return fail(op, failure); };
  const begin = s.fbBegin; s.fbBegin = async (o, t) => { begun.push(o); return begin(o, t); };
  s.managedDownload = async (options) => { const r = await s.fetch(options.url, { method: 'GET' }); if (!r.ok) throw new Error('HTTP_ERROR'); return s.chrome.downloads.download(options); };
  const content = code('content/content_inline.js');
  w.eval(code('lib/i18n.js'));
  if (contentLog) w.ImageSaverDebug = { client: () => ({ log: (...args) => contentLog.push(args), cid: () => 'c0ffee00', enabled: () => true }) }; // the content script's journal client, spied
  page.inject = () => w.eval(content);
  page.inject();
  Object.assign(page, {
    place(el, left, top, width, height, z) { if (el) { rects.set(el, { left, top, width, height, z }); placed.add(el); } },
    pin(el) { pinned.add(el); },                       // a fixed element (a site header) does not move with the page
    // the page scrolls by dy: every placed element moves, a pinned one does not; scroll listeners run
    async scroll(dy) { page.scrolled += dy; for (const el of placed) { const r = rects.get(el); if (r && !pinned.has(el)) rects.set(el, { ...r, top: r.top - dy }); } w.dispatchEvent(new w.Event('scroll')); await sleep(200); },
    // where the control is: its page rectangle and the id of the node it is attached to
    box() { const h = page.host(); if (!h) return null; const r = h.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, parent: h.parentElement && h.parentElement.id }; },
    // a pointer move; the kit evaluates it after its 60 ms hover timer. By default the test runs that same evaluation at once (and drops the pending timer) instead of waiting for it;
    // slow = true waits for the real timer (timers fire in order, so 72 ms always sees it), which is how the debounce itself is exercised
    async hover(x, y, slow = false) {
      w.document.dispatchEvent(new w.MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
      const c = w.__medialatchInline && w.__medialatchInline.vk;
      if (slow || !c) { await sleep(72); return; }
      w.clearTimeout(c.st.timer); c.st.timer = null; c.evaluate(); await Promise.resolve();
    },
    host() { return w.document.querySelector('[data-image-saver-inline="vk"]'); },
    root() { const h = page.host(); return h && shadows.get(h); },
    buttons() { const root = page.root(); const b = root ? root.querySelectorAll('button') : []; return b.length ? { one: b[0], all: b[1], host: page.host() } : null; },
    both() { const b = page.buttons(); return Boolean(b) && !b.all.hasAttribute('hidden'); },
    click(btn, trusted = true) { const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true }); ev.testTrusted = trusted; btn.dispatchEvent(ev); return ev; },
    media() { return calls.filter((c) => /vkuserphoto\.ru|userapi\.com|okcdn\.ru/.test(c.url)); },
    exported() { return bg.downloadedCalls.map((x) => x.url); },
    // waits until the pipeline has been quiet for a moment (a click's messages, proofs, requests, exports and failures have all happened), instead of a fixed worst-case sleep
    async idle(quiet = 60, max = 3000) {
      const sig = () => [sent.length, asks.length, calls.length, failures.length, begun.length, opened.length, bg.downloadedCalls.length].join();
      let last = sig(), since = Date.now(); const start = since;
      while (Date.now() - start < max) { await sleep(10); const s = sig(); if (s !== last) { last = s; since = Date.now(); } else if (Date.now() - since >= quiet) return; }
    },
    async settle(n) { if (n) await until(() => bg.downloadedCalls.length >= n, `${n} exports`); await page.idle(50); }
  });
  return page;
}

// ---- derived pages ----
// A post as VK renders it (structure captured 2026-10-16 from the live community page and feed, sanitized: collage-post.json, carousel-initial.json): the post box names itself with an intrinsic
// data-post-id, its attachments are links of the /photo-, /video-, /clip- OWNER_ID routes that wrap exactly one image, and a collage lays them out in a media-grid of media-grid-item tiles.
// Everything else here (hosts' query parameters, the +N tile, the comment markup, the video/clip tiles) is derived. attachments: [{ t: 'photo'|'video'|'clip'|'stray'|'overflow', n, src?, inner? }].
const KEY = `-${OWNER}_${POST}`;
function postHtml({ items, extra = '', boxAttr = 'data-post-id', key = KEY }) {
  const tile = (it, k) => {
    if (it.t === 'stray') return `<img id="i${k}" src="${it.src || photo(it.n)}">`; // a stray image that is not an attachment link, outside every tile
    const href = it.t === 'video' ? route.video(it.n) : it.t === 'clip' ? route.clip(it.n) : route.photo(it.n);
    const img = it.t === 'video' || it.t === 'clip' ? poster(it.n) : (it.src || photo(it.n));
    return `<div id="g${k}" data-testid="media-grid-item" style="position:relative;overflow:hidden"><a id="a${k}" href="${href}"><img id="i${k}" src="${img}">${it.inner || ''}${it.t === 'overflow' ? `<span id="o${k}">+3</span>` : ''}</a></div>`;
  };
  return `<!doctype html><body><div id="app"><div id="box" data-testid="post" ${boxAttr}="${key}" data-post-nesting-lvl="0"><a id="hdr" href="/club${OWNER}"><img id="ava" src="${AVATAR}"></a><div id="atts" data-testid="media-grid" data-sortable-root="true">${items.map(tile).join('')}</div>${extra}</div>
    <div id="reco"><a id="ra" href="/photo-111_222"><img id="ri" src="${photo(90)}"></a></div></div></body>`;
}
const photos = (n) => Array.from({ length: n }, (_, k) => ({ t: 'photo', n: k + 1 }));
function barePage(opts = {}) {                                   // the same post whose box carries no identity at all
  const b = build({ ...opts, html: postHtml({ items: photos(3) }).replace(KEY, 'nothing-here') });
  b.place(b.d.getElementById('app'), 0, 0, 1400, 2400); photos(3).forEach((_, k) => { for (const id of ['g', 'a', 'i']) b.place(b.d.getElementById(id + k), 100, 100 + k * 420, 600, 400); });
  return b;
}
function postPage(opts = {}) {
  const items = opts.items || photos(3), p = build({ ...opts, url: opts.url || PAGE, html: postHtml({ ...opts, items }) });
  p.place(p.d.getElementById('app'), 0, 0, 1400, 2400); p.place(p.d.getElementById('box'), 90, 40, 700, 2300); p.place(p.d.getElementById('atts'), 100, 100, 600, 2200);
  p.place(p.d.getElementById('hdr'), 100, 50, 48, 48); p.place(p.d.getElementById('ava'), 100, 50, 48, 48);
  items.forEach((_, k) => { const y = 100 + k * 420; p.place(p.d.getElementById('g' + k), 100, y, 600, 400); p.place(p.d.getElementById('a' + k), 100, y, 600, 400); p.place(p.d.getElementById('i' + k), 100, y, 600, 400); const o = p.d.getElementById('o' + k); if (o) p.place(o, 620, y + 20, 60, 30, 1); });
  p.place(p.d.getElementById('reco'), 900, 100, 220, 260); p.place(p.d.getElementById('ra'), 900, 100, 200, 200); p.place(p.d.getElementById('ri'), 900, 100, 200, 200);
  return p;
}
const at = (k) => [300, 300 + k * 420];                         // a point on tile k
const hover = (p, k) => p.hover(...at(k));
// a viewer-like page: one big image, no post root, the page address names a photo
function viewerPage(src = photo(7)) {
  const p = build({ url: `https://vk.ru/photo-${OWNER}_457239417`, html: `<!doctype html><body><div id="layer"><img id="big" src="${src}"></div></body>` });
  p.place(p.d.getElementById('layer'), 0, 0, 1400, 2000); p.place(p.d.getElementById('big'), 200, 100, 800, 1000);
  return p;
}
// an opened video / clip layer with one <video>
function playerPage(src, url = `https://vk.ru/video-${OWNER}_456239001`, extra = '', contentLog = null) {
  const p = build({ contentLog, url, html: `<!doctype html><body><div id="layer"><video id="v" src="${src}"></video>${extra}</div></body>` });
  p.place(p.d.getElementById('layer'), 0, 0, 1400, 2000); p.place(p.d.getElementById('v'), 200, 100, 800, 450);
  return p;
}
// ---- sanitized live structure: feed posts with a carousel or a collage (carousel-initial.json, carousel-second.json, collage-post.json of 2026-10-16) ----
// Kept from the captures: data-post-id + data-post-nesting-lvl on the post box and a second element with the same key inside it, the attachmentCarousel/gallery region, role=group slides
// labelled "k из N" with data-testid carousel-slide-k and data-index, the primary-attachment-photo frame, a zero-size photo link around an absolute image, full-height sibling arrow
// layers, the media-grid of media-grid-item tiles (two large ones and 90px thumbnails). Derived (never seen live): the carousel counter element, video/clip tiles, the +N tile,
// the comment and repost markup and every image size. A null item is a slide the page has not rendered yet.
const FEED = 'https://vk.ru/feed', FEEDKEY = '-218466214_25';
const hrefOf = (it) => (it.t === 'video' ? route.video(it.n) : it.t === 'clip' ? route.clip(it.n) : route.photo(it.n));
const srcOf = (it) => (it.t === 'video' || it.t === 'clip' ? poster(it.n) : (it.src || photo(it.n)));
function slideHtml(id, k, n, it) {
  const open = `<div id="${id}s${k}" role="group" aria-roledescription="Слайд" aria-label="${k + 1} из ${n}" data-testid="carousel-slide-${k}" data-index="${k}" style="overflow:hidden">`;
  if (!it) return open + '</div>';
  return open + `<div data-testid="carousel-slide"><div id="${id}f${k}" data-testid="primary-attachment-photo" style="position:relative;overflow:hidden"><div id="${id}c${k}" style="position:absolute"><a id="${id}a${k}" aria-label="Фотография" data-testid="primary-attachment-interactive-wrapper" href="${hrefOf(it)}"><img id="${id}i${k}" data-testid="primary-attachment-image-content" style="position:absolute" src="${srcOf(it)}">${it.inner || ''}</a></div></div></div></div>`;
}
function tileHtml(id, k, it) {
  const open = `<div id="${id}g${k}" data-testid="media-grid-item" style="position:relative">`;
  if (it.t === 'overlay') return open + `<span id="${id}o${k}">+${it.n}</span></div>`;
  const img = k < 2 ? `<div id="${id}f${k}" style="overflow:hidden"><img id="${id}i${k}" src="${srcOf(it)}"></div>` : `<img id="${id}i${k}" data-testid="media-grid-image" style="position:absolute" src="${srcOf(it)}">`;
  return open + `<div><a id="${id}a${k}" aria-label="Фотография" href="${hrefOf(it)}">${img}${it.inner || ''}</a></div></div>`;
}
function feedPost(id, post) {
  const { key = FEEDKEY, kind = 'carousel', items = photos(3), declared = items.length, nesting = '0', extra = '', counter = declared } = post;
  const head = `<div id="${id}" data-testid="post" data-post-id="${key}" data-post-nesting-lvl="${nesting}"><div id="${id}hdr"><a id="${id}ha" href="/club${OWNER}"><img id="${id}ava" src="${AVATAR}"></a></div>`;
  const foot = `<div id="${id}foot" data-post-id="${key}"></div>${extra}</div>`;
  if (kind === 'carousel') return head + `<div id="${id}car" class="attachmentCarousel" data-testid="gallery" role="region" aria-roledescription="Карусель" style="position:relative;overflow:hidden"><button id="${id}prev" data-testid="carousel-arrow-prev"></button><button id="${id}next" data-testid="carousel-arrow-next"></button>${counter ? `<span id="${id}cnt" data-testid="carousel-counter">1/${counter}</span>` : ''}<div id="${id}trk" style="display:flex;transform:translateX(0px)">${items.map((it, k) => slideHtml(id, k, declared, it)).join('')}</div></div>` + foot;
  return head + `<div id="${id}grid" data-testid="media-grid" data-sortable-root="true">${items.map((it, k) => tileHtml(id, k, it)).join('')}</div>` + foot;
}
// where everything is, for the post that starts at page height `at`; the active slide of a carousel is the visible one
function layoutPost(p, id, post, at, active) {
  const $ = (s) => p.d.getElementById(id + s), put = (s, ...a) => { if ($(s)) p.place($(s), ...a); };
  const items = post.items || photos(3), n = post.declared || items.length, top = at + 72;
  p.place($(''), 581, at, 551, 1411); put('hdr', 581, at, 551, 64); put('ha', 601, at + 4, 56, 56); put('ava', 601, at + 4, 56, 56); put('foot', 581, at + 1320, 551, 88);
  if ((post.kind || 'carousel') === 'carousel') {
    put('car', 581, top, 551, 710); put('trk', 581 - active * 551, top, n * 551, 710);
    if (active < n - 1) put('next', 1080, top, 52, 710, 2); if (active > 0) put('prev', 581, top, 52, 710, 2); put('cnt', 1090, top + 8, 40, 20, 2);
    items.forEach((it, k) => { const x = 581 + (k - active) * 551; put('s' + k, x, top, 551, 710); put('f' + k, x, top, 551, 710); put('c' + k, x, top, 551, 710); put('a' + k, x, top + 1, 0, 0); put('i' + k, x, top + 1, 551, 708, 1); });
  } else {
    put('grid', 581, top, 551, 458);
    items.forEach((it, k) => {
      if (k < 2) { const x = 581 + k * 277; put('g' + k, x, top, 275, 366); put('a' + k, x, top, 275, 366); put('f' + k, x, top, 275, 366); put('i' + k, x, top - 13, 275, 517); }
      else { const x = 581 + (k - 2) * 92, y = top + 368; put('g' + k, x, y, 90, 90); put('a' + k, x, y + 90, 0, 0); put('i' + k, x, y, 90, 90); put('o' + k, x, y, 90, 90, 1); }
    });
  }
}
function feedPage(posts, opts = {}) {
  const ids = posts.map((_, i) => 'p' + i);
  const p = build({ ...opts, url: opts.url || FEED, html: `<!doctype html><body><div id="feedroot">${posts.map((post, i) => feedPost(ids[i], post)).join('')}</div></body>` });
  p.state = { active: posts.map(() => 0), tops: posts.map((_, i) => 100 + i * 1500) }; p.ids = ids;
  p.relayout = () => { p.place(p.d.getElementById('feedroot'), 0, 0, 1400, 6000); posts.forEach((post, i) => layoutPost(p, ids[i], post, p.state.tops[i] - p.scrolled, p.state.active[i])); p.loaded(); };
  p.relayout();
  return p;
}
const centerOf = (p, id) => { const r = p.rects.get(p.d.getElementById(id)); return [r.left + r.width / 2, r.top + r.height / 2]; };
const hoverOn = (p, id) => p.hover(...centerOf(p, id));
const message = (p, which) => p.sent.filter((m) => m.action === which);
// Observed /al_video.php?act=show response shape; identities and signed file addresses below are synthetic.
const vkVideoKey = n => route.video(n).slice('/video'.length);
const vkProgressive = n => `https://vkvd712.okcdn.ru/?type=4&id=${n}&sig=${SIG}${n}&expires=2000000000`;
function vkVideoData(n, url = vkProgressive(n)) {
  const [oid, vid] = vkVideoKey(n).split('_').map(Number);
  return { payload: [0, [null, null, null, null, { mvData: { oid, vid, is_live: false }, player: { params: [{ oid, vid, url1080: url, hls: `https://vkvd712.okcdn.ru/${n}/index.m3u8?sig=${SIG}` }] } }]] };
}
function vkMetadata(p, n, data = vkVideoData(n)) {
  (p.vkMetadata ||= {})[vkVideoKey(n)] = data;
  (p.vkFiles ||= {})[vkProgressive(n)] = { bytes: mp4, mime: 'video/mp4' };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log('  ✓ ' + name + (Date.now() - t0 > 1500 ? ` (${Date.now() - t0} ms)` : '')); } catch (e) { failed++; console.error('  ✗ ' + name); console.error(e.stack || e.message || e); }
}

(async () => {
  console.log('\n--- VK-INLINE-01: registration ---');
  await test('manifest: VK is served by the one inline content script (top frame, no new permission)', async () => {
    const m = JSON.parse(code('manifest.json')), entries = m.content_scripts.filter((c) => c.js.includes('content/content_inline.js'));
    assert.equal(entries.length, 1); assert(entries[0].matches.includes('https://vk.ru/*') && entries[0].matches.includes('https://vk.com/*')); assert(!entries[0].all_frames, 'the top frame only');
    assert.deepEqual(entries[0].js, ['lib/debug_journal.js', 'lib/i18n.js', 'lib/sites.js', 'content/content_inline.js']);
    assert.deepEqual(m.permissions, ['contextMenus', 'downloads', 'storage', 'scripting', 'declarativeNetRequest', 'offscreen']); assert.deepEqual(m.host_permissions, ['http://*/*', 'https://*/*']);
    assert(code('tools/verify.mjs').includes("'test_vk_inline.js'"), 'the suite runs in tools/verify.mjs');
  });

  await test('registries: vk is appended after every existing site, a VK batch has labels in both languages and no author is invented', async () => {
    const root = { structuredClone, console }; vm.createContext(root);
    for (const f of ['lib/feedback.js', 'lib/sites.js', 'lib/i18n.js']) vm.runInContext(code(f), root);
    const SITES = root.MediaLatchSites.SITES, ids = SITES.map((s) => s.id), vk = SITES.find(s=>s.id==='vk');
    assert.equal(vk.id, 'vk'); assert.equal(ids.filter((id) => id === 'vk').length, 1); assert.equal(ids[ids.indexOf('vk')-1], 'wikimedia', 'nothing was reordered');
    assert.deepEqual([...vk.domains], ['vk.com', 'vk.ru', 'vkvideo.ru', 'vkuserphoto.ru', 'userapi.com']);
    for (const lang of ['en', 'ru']) for (const key of ['statistics.site.vk', 'downloads.batch.site.vk']) assert(root.ImageSaverI18n.t(lang, key) && root.ImageSaverI18n.t(lang, key) !== key, lang + ' ' + key);
    const FB = root.ImageSaverFeedback;
    assert.equal(FB.safeAuthor('vk', { site: 'vk', id: '218466214', name: 'Posting account' }).id, '218466214', 'shape validation accepts explicit metadata; wall IDs alone never supply it');
    assert.deepEqual(JSON.parse(JSON.stringify(FB.safeAuthor('pixiv', { site: 'pixiv', id: '12', name: 'n' }))), { site: 'pixiv', id: '12', name: 'n' }, 'existing author labels are untouched');
    assert.equal(FB.authorLabel('x', { site: 'x', id: 'abc', name: 'abc' }), '@abc');
  });

  await test('privacy: a VK signature, a hash or a short numeric secret never survives log redaction', async () => {
    const guard = require(path.join(ROOT, 'lib/media_guard.js'));
    for (const url of [photo(1), video(1), `https://vkvd1.okcdn.ru/?expires=1&sig=${SIG}&hash=${SHORT}`]) {
      const shown = guard.sanitizeUrlForLog(url);
      assert(!shown.includes(SIG) && !shown.includes(SHORT), shown);
    }
    assert(guard.sanitizeUrlForLog(photo(1)).includes('size=849x1133'), 'harmless parameters stay readable');
  });

  console.log('\n--- VK-INLINE-01: Save this on a photo ---');
  await test('hover shows the control on a photo of the post and does no network work; lookalike hosts get no handler', async () => {
    const p = postPage();
    await p.hover(...at(0), true);
    assert(p.both(), 'a post with three attachments offers both actions');
    assert.equal(p.calls.length, 0, 'hover requests nothing'); assert.equal(p.sent.length, 0);
    for (const url of ['https://vk.ru.evil.example/wall-1_2', 'https://notvk.ru/wall-1_2', 'https://example.com/wall-1_2']) {
      const q = build({ url, html: postHtml({ items: photos(3) }) });
      await q.hover(300, 300); assert.equal(q.host(), null, 'no handler on ' + url);
    }
  });

  await test('Save this saves exactly the selected photo: its exact signed address, one request, one export, site vk, and the message carries only a token', async () => {
    const p = postPage();
    await hover(p, 1);
    p.click(p.buttons().one); await p.settle(1);
    assert.deepEqual(p.exported(), [photo(2)], 'neither a neighbour nor a rewritten address');
    assert.deepEqual(p.media().map((c) => c.url).filter((u, i, a) => a.indexOf(u) === i), [photo(2)], 'no other VK address was requested');
    const m = message(p, 'VK_INLINE_SAVE'); assert.equal(m.length, 1);
    assert.deepEqual(Object.keys(m[0]).filter((k) => !['dbg'].includes(k)).sort(), ['action', 'token']); assert(/^[a-f0-9]{32}$/.test(m[0].token));
    assert.equal(p.begun.length, 1); assert.equal(p.begun[0].site, 'vk'); assert.deepEqual(p.failures, []);
  });

  await test('every neighbour is its own target: Save this on the first and on the last photo saves that photo only', async () => {
    for (const k of [0, 2]) {
      const p = postPage(); await hover(p, k); p.click(p.buttons().one); await p.settle(1);
      assert.deepEqual(p.exported(), [photo(k + 1)]);
    }
  });

  await test('unsupported targets get no control: an avatar, a loading image, a foreign host, a video or clip poster; nothing is requested', async () => {
    const p = postPage({ items: [{ t: 'photo', n: 1 }, { t: 'photo', n: 2, src: 'https://img.example.net/a.jpg' }, { t: 'video', n: 1 }, { t: 'clip', n: 1 }, { t: 'photo', n: 5 }] });
    await p.hover(120, 70); assert.equal(p.host(), null, 'the avatar-sized image under the profile link');
    await hover(p, 1); assert.equal(p.host(), null, 'a foreign host');
    await hover(p, 2); assert.equal(p.host(), null, 'the poster of a video is not a photo');
    await hover(p, 3); assert.equal(p.host(), null, 'the poster of a clip is not a photo');
    p.d.getElementById('i4').setAttribute('data-loading', ''); await hover(p, 4); assert.equal(p.host(), null, 'an image that has not loaded');
    assert.equal(p.calls.length, 0); assert.equal(p.sent.length, 0);
  });

  await test('a photo outside the post (a recommendation) is its own media: Save this only, never Save all of the post', async () => {
    const p = postPage();
    await p.hover(1000, 200); assert(p.buttons(), 'the selected recommended photo can be saved'); assert(!p.both(), 'but it is not part of the post list');
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(90)]);
  });

  await test('a viewer (one big photo, no post root) offers Save this for exactly that photo and never Save all', async () => {
    const p = viewerPage(); await p.hover(500, 500);
    assert(p.buttons() && !p.both());
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(7)]);
  });

  await test('an untrusted (script) click sends nothing; a trusted click sends only a random one-shot token', async () => {
    const p = postPage(); await hover(p, 0);
    p.click(p.buttons().one, false); await sleep(80); assert.equal(p.sent.length, 0); assert.equal(p.calls.length, 0);
    p.click(p.buttons().one, true); await p.settle(1); assert.equal(p.sent.length, 1);
  });

  await test('forged, replayed, swapped-action and unknown tokens save nothing and are refused visibly', async () => {
    const p = postPage(); await hover(p, 0);
    p.click(p.buttons().one); await p.settle(1);
    const token = p.sent[0].token, before = p.exported().length;
    for (const forged of [{ action: 'VK_INLINE_SAVE', token }, { action: 'VK_INLINE_SAVE', token: 'a'.repeat(32) }, { action: 'VK_INLINE_SAVE_ALL', token }, { action: 'VK_INLINE_SAVE', token: 'zz' }, { action: 'VK_INLINE_SAVE' }]) {
      p.w.chrome.runtime.sendMessage(forged); await sleep(120);
    }
    assert.equal(p.exported().length, before, 'a replay or a forged token exports nothing');
    assert(p.failures.length >= 1, 'a refused token is a visible failure, not silence');
  });

  await test('wrong sender, frame, tab, origin or document: the message is ignored or the proof is not given; no media request', async () => {
    for (const override of [{ url: 'https://example.com/wall-1_2' }, { url: 'https://vk.ru.evil.example/' }, { frameId: 5 }, { tab: { id: 1, active: false, url: PAGE } }, { id: 'other-extension' }, { tab: undefined }, { documentId: 'doc-2' }, { documentId: '' }, { documentId: undefined }]) {
      const p = postPage(); await hover(p, 0); p.senderOverride = override;
      p.click(p.buttons().one); await p.idle();
      assert.equal(p.exported().length, 0, JSON.stringify(override)); assert.equal(p.media().length, 0, JSON.stringify(override));
    }
  });

  await test('forged answers from the proof are refused by the worker: another host, a lookalike host, plain http, credentials, a port, a kind that does not fit its host, a manifest', async () => {
    const forged = [
      { kind: 'photo', url: 'https://evil.example/a.jpg' }, { kind: 'photo', url: 'https://vkuserphoto.ru.evil.example/a.jpg' }, { kind: 'photo', url: 'https://evilvkuserphoto.ru/a.jpg' },
      { kind: 'photo', url: photo(1).replace('https:', 'http:') }, { kind: 'photo', url: 'https://user:pw@sun9-52.vkuserphoto.ru/a.jpg' }, { kind: 'photo', url: 'https://sun9-52.vkuserphoto.ru:8443/a.jpg' },
      { kind: 'video', url: photo(1) }, { kind: 'video', url: 'https://vkvd1.okcdn.ru/hls/index.m3u8?x=1' }, { kind: 'video', url: 'https://evil.example/v.mp4' }, { kind: 'audio', url: photo(1) }, { kind: 'photo', url: 42 }, { kind: 'photo' },
      { kind: 'video-page', url: 'https://evil.example' + route.video(1), id: route.video(1).slice(1) },
      { kind: 'video-page', url: 'https://vk.ru' + route.video(1), id: route.video(2).slice(1) },
      { kind: 'video-page', url: 'https://vk.ru' + route.photo(1), id: route.photo(1).slice(1) },
      { kind: 'video-page', url: 'https://vk.ru/al_video.php', id: route.video(1).slice(1) },
      { kind: 'video-page', url: 'https://vk.ru' + route.video(1) },
    ];
    for (const media of forged) {
      const p = postPage(); await hover(p, 0);
      p.proofHook = (msg, v) => (msg.action === 'VK_INLINE_OWNER' ? { ok: true, media } : v);
      p.click(p.buttons().one); await p.idle();
      assert.equal(p.calls.length, 0, 'no request for ' + JSON.stringify(media)); assert.deepEqual(p.exported(), []); assert(p.failures.length >= 1, 'refused visibly');
    }
    // a batch item bound to another post, count, index or structure signature, or without its attachment id, is refused item by item
    for (const bind of [{ ownerId: '1_2' }, { count: 9 }, { index: 7 }, { sig: 'deadbeef' }, { id: '' }, { ownerId: undefined }]) {
      const p = postPage(); await hover(p, 0);
      p.proofHook = (msg, v) => (msg.action === 'VK_INLINE_OWNER_ITEM' && v && v.ok ? { ok: true, media: { ...v.media, ...bind } } : v);
      p.click(p.buttons().all); await p.idle();
      assert.equal(p.media().length, 0, 'no request for a forged binding ' + JSON.stringify(bind)); assert.deepEqual(p.exported(), []);
    }
  });

  await test('the selected photo is replaced, removed or moved before the click or before the proof: refused, no media request', async () => {
    let p = postPage(); await hover(p, 0);
    p.d.getElementById('i0').setAttribute('src', photo(9)); p.click(p.buttons().one); await p.idle();
    assert.equal(p.sent.length, 0, 'a replaced source never reaches the worker'); assert.equal(p.media().length, 0);
    p = postPage(); await hover(p, 0);
    p.beforeAsk = () => p.d.getElementById('i0').setAttribute('src', photo(9));
    p.click(p.buttons().one); await p.idle(); assert.equal(p.media().length, 0, 'replaced between the click and the proof'); assert(p.failures.length >= 1);
    p = postPage(); await hover(p, 0);
    p.beforeAsk = () => p.d.getElementById('a0').remove();
    p.click(p.buttons().one); await p.idle(); assert.equal(p.media().length, 0, 'removed between the click and the proof');
    p = postPage(); await hover(p, 0);
    p.beforeAsk = () => { const old = p.d.getElementById('i0'), twin = old.cloneNode(); old.replaceWith(twin); p.loaded(); p.place(twin, 100, 100, 600, 400); }; // a virtualized feed recycles the node: the same address in a new element
    p.click(p.buttons().one); await p.idle(); assert.equal(p.media().length, 0, 'recycled between the click and the proof');
    p = postPage(); await hover(p, 0);
    p.beforeAsk = () => p.place(p.d.getElementById('i0'), 100, 900, 600, 400);
    p.click(p.buttons().one); await p.idle(); assert.equal(p.media().length, 0, 'moved between the click and the proof');
  });

  await test('viewer reopen and clip auto-advance: the next media under the same element is never saved for the earlier click', async () => {
    let p = viewerPage(); await p.hover(500, 500);
    p.beforeAsk = () => { p.w.history.pushState({}, '', `/photo-${OWNER}_457239418`); p.d.getElementById('big').setAttribute('src', photo(8)); };
    p.click(p.buttons().one); await p.idle();
    assert.equal(p.media().length, 0); assert.deepEqual(p.exported(), []);
    p = playerPage(video(1)); await p.hover(500, 300);
    p.beforeAsk = () => { p.w.history.pushState({}, '', `/clip-${OWNER}_456239778`); p.d.getElementById('v').setAttribute('src', video(2)); };
    p.click(p.buttons().one); await p.idle();
    assert.equal(p.media().length, 0); assert.deepEqual(p.exported(), []);
  });

  await test('SPA navigation: a control shown on the earlier address saves nothing on the new one; the next hover proves the new page from scratch', async () => {
    const p = postPage(); await hover(p, 0); const old = p.buttons().one;
    p.w.history.pushState({}, '', '/feed');
    p.click(old); await p.idle();
    assert.equal(p.sent.length, 0, 'the earlier address owns nothing now'); assert.equal(p.exported().length, 0);
    await hover(p, 0); assert(p.buttons(), 'the new address is judged on its own, from the post the page declares, not from the old address');
  });

  await test('a double click and a second click while running start one save; a later explicit save works', async () => {
    const p = postPage(); p.delay[photo(1)] = 120; await hover(p, 0);
    p.click(p.buttons().one); p.click(p.buttons().one); await p.settle(1);
    assert.equal(p.exported().length, 1);
    await sleep(1600); await hover(p, 0); p.click(p.buttons().one); await p.settle(2);
    assert.equal(p.exported().length, 2);
  });

  await test('keyboard: focusing the photo link shows the control; Tab reaches Save this and Save all; Escape dismisses', async () => {
    const p = postPage(); const a = p.d.getElementById('a1'); a.focus(); a.dispatchEvent(new p.w.FocusEvent('focusin', { bubbles: true })); await sleep(60);
    const b = p.buttons(); assert(b && p.both(), 'focus shows both actions');
    b.one.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(p.root().activeElement, b.all, 'Tab moves to Save all');
    b.all.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await sleep(40);
    assert.equal(p.host(), null, 'Escape dismisses');
  });

  await test('Russian labels and a re-injection that leaves one control and one message per click', async () => {
    const p = postPage({ lang: 'ru' }); await hover(p, 0);
    assert(/Сохранить/.test(p.root().textContent) && /3/.test(p.root().textContent), p.root().textContent);
    p.inject(); p.inject(); await hover(p, 0);
    assert.equal(p.contentListeners.length, 1, 'one proof handler');
    p.click(p.buttons().one); await p.settle(1); assert.equal(p.sent.length, 1); assert.equal(p.exported().length, 1);
  });

  console.log('\n--- VK-INLINE-01: Save all (N) ---');
  await test('a post with three photo attachments offers Save all (3): every attachment once, in order, as one VK batch', async () => {
    const p = postPage(); await hover(p, 1);
    assert(p.both()); assert(/Save all \(3\)/.test(p.root().textContent), p.root().textContent);
    p.click(p.buttons().all); await p.settle(3);
    assert.deepEqual(p.exported(), [photo(1), photo(2), photo(3)]);
    assert.deepEqual(p.opened.map((o) => o.slice(0, 2)), [['vk', 3]]); assert.deepEqual(p.failures, []);
    assert.equal(message(p, 'VK_INLINE_SAVE_ALL').length, 1);
  });

  await test('a mixed post: every attachment is accounted for; videos and clips without a declared file fail visibly, none disappears and none counts as saved', async () => {
    const p = postPage({ items: [{ t: 'photo', n: 1 }, { t: 'video', n: 1 }, { t: 'clip', n: 1 }, { t: 'photo', n: 2 }] });
    await hover(p, 0); assert(/Save all \(4\)/.test(p.root().textContent), p.root().textContent);
    p.click(p.buttons().all); await p.settle(2);
    assert.deepEqual(p.exported(), [photo(1), photo(2)], 'the posters are not saved as videos');
    assert.deepEqual(p.opened.map((o) => o.slice(0, 2)), [['vk', 4]]);
    assert.equal(p.failures.filter((f) => f.code === 'UNSUPPORTED_SOURCE').length, 2, 'the video and the clip are failed items: ' + JSON.stringify(p.failures));
    assert(p.failures.every((f) => f.code === 'UNSUPPORTED_SOURCE' || f.code === ''), 'no other failure was recorded');
    assert.equal(p.begun.length, 4, 'every attachment has an operation of its own: two saved, two failed');
    assert.equal(p.media().filter((c) => /okcdn/.test(c.url)).length, 0, 'no request guessed a video address');
  });

  await test('a direct video file declared by an attachment is saved through the video path with its exact address', async () => {
    const inner = `<video id="pv" src="${video(1)}"></video>`;
    const p = postPage({ items: [{ t: 'photo', n: 1 }, { t: 'video', n: 1, inner }] });
    p.place(p.d.getElementById('pv'), 100, 520, 600, 400); p.loaded();
    await hover(p, 0); p.click(p.buttons().all); await p.settle(2);
    assert.deepEqual(p.exported().slice().sort(), [photo(1), video(1)].sort());
    assert(p.calls.some((c) => c.url === video(1)), 'the declared file itself was requested'); assert.deepEqual(p.failures, []);
  });

  await test('unproven lists offer only Save this: a stray image, an overflow tile, a duplicate attachment, one attachment, more than 100', async () => {
    const cases = {
      stray: [{ t: 'photo', n: 1 }, { t: 'photo', n: 2 }, { t: 'stray', n: 3 }],
      overflow: [{ t: 'photo', n: 1 }, { t: 'overflow', n: 2 }],
      duplicate: [{ t: 'photo', n: 1 }, { t: 'photo', n: 1 }],
      single: [{ t: 'photo', n: 1 }]
    };
    for (const [name, items] of Object.entries(cases)) {
      const p = postPage({ items }); await hover(p, 0); assert(p.buttons(), name + ': Save this stays'); assert(!p.both(), name + ': no Save all');
    }
    const many = postPage({ items: Array.from({ length: 101 }, (_, k) => ({ t: 'photo', n: 100 + k })) });
    await hover(many, 0); assert(many.buttons(), 'Save this stays'); assert(!many.both(), 'a list over the cap is never truncated into a Save all');
  });

  await test('why a post list is not proven goes to the journal (a code and a count, never an address), so the missing DOM detail is visible without another capture', async () => {
    const cases = [['UNCLAIMED_MEDIA', [{ t: 'photo', n: 1 }, { t: 'photo', n: 2 }, { t: 'stray', n: 3 }]], ['OVERFLOW_TILE', [{ t: 'photo', n: 1 }, { t: 'overflow', n: 2 }]], ['DUPLICATE', [{ t: 'photo', n: 1 }, { t: 'photo', n: 1 }]]];
    for (const [code, items] of cases) {
      const log = [], p = postPage({ items, contentLog: log }); await hover(p, 0);
      const refused = log.filter((a) => a[0] === 'vk.inline' && a[1] === 'list'); assert.equal(refused.length, 1, code); assert.equal(refused[0][3], code); assert.deepEqual(Object.keys(refused[0][4]), ['count']);
      await hover(p, 0); assert.equal(log.filter((a) => a[1] === 'list').length, 1, 'once per element');
    }
    const log = [], bare = barePage({ contentLog: log });
    await bare.hover(300, 300); assert.equal(log.filter((a) => a[1] === 'list' && a[3] === 'NO_ROOT').length, 1, 'no wrapper names the post');
  });

  await test('a reposted/nested post is not part of this post: its media is neither counted nor saved and has no Save all', async () => {
    const extra = `<div id="rp" data-post-id="-555555555_77" data-post-nesting-lvl="1"><a id="rpa" href="/photo-555555555_88"><img id="rpi" src="${photo(77)}"></a></div>`;
    const stage = () => { const p = postPage({ items: photos(2), extra }); p.place(p.d.getElementById('rp'), 100, 1000, 600, 400); p.place(p.d.getElementById('rpa'), 100, 1000, 600, 400); p.place(p.d.getElementById('rpi'), 100, 1000, 600, 400); return p; };
    const p = stage();
    await hover(p, 0); assert(/Save all \(2\)/.test(p.root().textContent), 'the repost is not counted');
    p.click(p.buttons().all); await p.settle(2); assert.deepEqual(p.exported(), [photo(1), photo(2)]);
    const q = stage(); await q.hover(300, 1200); assert(q.buttons() && !q.both(), 'the repost photo is its own media: Save this only');
  });

  await test('a comment of the post and a page that never names the post key: the comment photo is its own media, and without a wrapper that names the post there is no Save all', async () => {
    const extra = `<div id="cm" data-c="post${KEY}_9999"><a id="cma" href="/photo-${OWNER}_777"><img id="cmi" src="${photo(88)}"></a></div>`;
    const p = postPage({ items: photos(2), extra }); p.place(p.d.getElementById('cm'), 100, 1000, 600, 400); p.place(p.d.getElementById('cma'), 100, 1000, 600, 400); p.place(p.d.getElementById('cmi'), 100, 1000, 600, 400);
    await hover(p, 0); assert(/Save all \(2\)/.test(p.root().textContent), 'the comment photo is not counted');
    p.click(p.buttons().all); await p.settle(2); assert.deepEqual(p.exported(), [photo(1), photo(2)]);
    const q = postPage({ items: photos(2), extra }); q.place(q.d.getElementById('cm'), 100, 1000, 600, 400); q.place(q.d.getElementById('cma'), 100, 1000, 600, 400); q.place(q.d.getElementById('cmi'), 100, 1000, 600, 400);
    await q.hover(300, 1200); assert(q.buttons() && !q.both(), 'a comment photo: Save this only');
    const bare = barePage();
    await bare.hover(300, 300); assert(bare.buttons() && !bare.both(), 'no wrapper names the post: the photo can be saved, the list is not proven');
  });

  await test('the list changed after the hover (an attachment added or removed): Save all is refused with no request', async () => {
    let p = postPage(); await hover(p, 0);
    p.d.getElementById('a2').remove(); p.click(p.buttons().all); await p.idle();
    assert.equal(p.media().length, 0); assert.equal(p.sent.length, 0);
    p = postPage(); await hover(p, 0);
    p.d.getElementById('atts').insertAdjacentHTML('beforeend', `<a id="a9" href="${route.photo(4)}"><img id="i9" src="${photo(4)}"></a>`); p.loaded(); p.place(p.d.getElementById('i9'), 100, 1360, 600, 400);
    p.click(p.buttons().all); await p.idle(); assert.equal(p.media().length, 0);
  });

  await test('the admitted list is saved as it was: a navigation or a removed tile after admission redirects, drops or adds nothing', async () => {
    const p = postPage(); p.delay[photo(1)] = 60; await hover(p, 0);
    let n = 0; p.beforeAsk = (msg) => { if (msg.action === 'VK_INLINE_OWNER_ITEM' && ++n === 2) { p.w.history.pushState({}, '', '/feed'); p.d.getElementById('a2').remove(); } };
    p.click(p.buttons().all); await p.idle(220);
    const saved = p.exported(); assert(saved.length <= 3 && saved.every((u) => [photo(1), photo(2), photo(3)].includes(u)), 'nothing outside the admitted list: ' + saved.join(' '));
    assert(!p.media().some((c) => c.url === photo(90)), 'no other post was requested');
  });

  await test('Save this and Save all of the same photo: the photo is saved once and the batch skips it as a duplicate', async () => {
    const p = postPage(); p.delay[photo(2)] = 250; await hover(p, 1);
    p.click(p.buttons().one); await sleep(60); p.click(p.buttons().all); await p.idle(320);
    const saved = p.exported(); assert.equal(saved.filter((u) => u === photo(2)).length, 1, 'photo 2 once: ' + saved.join(' ')); assert(saved.includes(photo(1)) && saved.includes(photo(3)));
  });

  await test('Cancel remaining: a cancelled batch starts no further item and records no refusal for the unstarted ones', async () => {
    let p = postPage({ batch: true }); p.cancelled = true; await hover(p, 0);
    p.click(p.buttons().all); await p.idle(); assert.equal(p.media().length, 0); assert.deepEqual(p.exported(), []); assert.deepEqual(p.failures, []);
    p = postPage({ batch: true, items: photos(4) }); p.delay[photo(1)] = 120; p.delay[photo(2)] = 120; await hover(p, 0);
    p.beforeAsk = (msg) => { if (msg.action === 'VK_INLINE_OWNER_ITEM' && msg.index === 1) p.cancelled = true; };
    p.click(p.buttons().all); await p.idle(220);
    assert(!p.exported().includes(photo(3)) && !p.exported().includes(photo(4)), 'items after the cancellation never start: ' + p.exported().join(' '));
  });

  await test('a failed original is that item\'s visible failure; the others in the batch are saved (partial, never silent)', async () => {
    const p = postPage({ failUrls: [photo(2)] }); await hover(p, 0);
    p.click(p.buttons().all); await p.settle(2);
    assert.deepEqual(p.exported(), [photo(1), photo(3)]); assert(p.failures.some((f) => f.code === 'MIME_NOT_VERIFIED'), JSON.stringify(p.failures)); assert.equal(p.begun.length, 3, 'one operation per attachment');
  });

  console.log('\n--- VK-INLINE-01: video and clip ---');
  await test('an opened video with a direct file: Save this saves exactly that file; the control sits away from the player bar', async () => {
    const p = playerPage(video(1)); await p.hover(500, 300);
    const b = p.buttons(); assert(b && !p.both(), 'the player offers Save this');
    const top = p.box().top; assert(top < 100 + 450 / 2, 'in the upper half: ' + top);
    p.click(b.one); await p.settle(1);
    assert.deepEqual(p.exported(), [video(1)]); assert(p.calls.some((c) => c.url === video(1)));
  });

  await test('blob/MSE, manifest and foreign-host videos, and a poster over a player, get no control and save nothing', async () => {
    for (const src of ['blob:https://vk.ru/00000000-0000-0000-0000-000000000000', 'https://vkvd1.okcdn.ru/hls/index.m3u8?extra=' + SIG, 'https://vkvd1.okcdn.ru/dash/manifest.mpd?hash=' + SHORT, 'https://evil.example/video.mp4', '']) {
      const p = playerPage(src); await p.hover(500, 300); assert.equal(p.host(), null, 'no control for ' + (src.slice(0, 30) || '(no source)'));
      assert.equal(p.calls.length, 0);
    }
    const p = playerPage('blob:https://vk.ru/0', undefined, `<img id="po" src="${poster(1)}">`); p.place(p.d.getElementById('po'), 200, 100, 800, 450); p.loaded();
    await p.hover(500, 300); assert.equal(p.host(), null, 'a poster is not the video'); assert.equal(p.sent.length, 0);
  });

  await test('an opened video that cannot be saved says why in the journal (transport and host only), so a real transport gap is visible without a new capture', async () => {
    for (const [src, transport, host] of [['blob:https://vk.ru/0000', 'blob', 'blob:https://vk.ru/0000'], [`https://vkvd1.okcdn.ru/hls/index.m3u8?extra=${SIG}`, 'manifest', 'https://vkvd1.okcdn.ru/hls/index.m3u8?extra=' + SIG], ['https://evil.example/video.mp4', 'host', 'https://evil.example/video.mp4']]) {
      const log = [], p = playerPage(src, undefined, '', log); await p.hover(500, 300);
      const refused = log.filter((a) => a[0] === 'vk.inline' && a[1] === 'candidate' && a[3] === 'VIDEO_TRANSPORT');
      assert.equal(refused.length, 1, transport); assert.equal(refused[0][4].transport, transport); assert.deepEqual(Object.keys(refused[0][4]).sort(), ['host', 'kind', 'transport']);
      // what the journal would keep: a code and a host, never the address
      const root = { console }; vm.createContext(root); vm.runInContext(code('lib/debug_journal.js'), root);
      const kept = root.ImageSaverDebug.sanitizeDetails(refused[0][4]); assert.equal(JSON.stringify(kept).includes(SIG), false); assert(kept.transport === transport);
      await p.hover(520, 320); assert.equal(log.filter((a) => a[3] === 'VIDEO_TRANSPORT').length, 1, 'once per element, not per pointer move');
    }
  });

  console.log('\n--- VK-INLINE-01: privacy ---');
  await test('no console, journal or notification text of a photo/video save carries a signature, a hash or a short numeric secret', async () => {
    const p = postPage({ items: [{ t: 'photo', n: 1 }, { t: 'photo', n: 2 }, { t: 'video', n: 1, inner: `<video id="pv" src="${video(1)}"></video>` }], failUrls: [photo(2)] });
    p.place(p.d.getElementById('pv'), 100, 940, 600, 400); p.loaded();
    await hover(p, 0); p.click(p.buttons().all); await p.idle(150);
    assert(p.exported().length >= 1 && p.failures.length >= 1, 'a successful and a failed item both logged');
    const all = p.logs.join('\n');
    for (const secret of [SIG, SHORT]) assert(!all.includes(secret), 'a secret reached the output: ' + all.split('\n').find((l) => l.includes(secret)));
    assert(p.logs.length > 3, 'something was logged');
  });


  console.log('\n--- VK review regressions ---');
  await test('an outer app reference cannot broaden a post batch into recommendations',async()=>{
    const p=postPage();p.d.getElementById('app').setAttribute('data-url',PAGE);await hover(p,0);
    assert(/Save all \(3\)/.test(p.root().textContent),'only post attachments');p.click(p.buttons().all);await p.settle(3);assert.deepEqual(p.exported(),[photo(1),photo(2),photo(3)]);
  });
  await test('only an exact post identity names an owner: a bare owner id, a conflicting pair or a lookalike attribute opens no batch',async()=>{
    for(const mutate of [b=>b.setAttribute('data-post-id',OWNER),b=>b.setAttribute('data-post-id','wall'+OWNER),b=>b.setAttribute('id','post'+OWNER+'_'+(POST+1)),b=>{b.removeAttribute('data-post-id');b.setAttribute('data-post','x'+KEY);}]){
      const p=postPage();mutate(p.d.getElementById('box'));await hover(p,0);assert(p.buttons()&&!p.both(),'no owner, no batch');
    }
  });
  await test('incidental URL text is not an intrinsic post boundary',async()=>{
    const p=postPage({boxAttr:'data-url'});await hover(p,0);assert(p.buttons()&&!p.both(),'only intrinsic post attributes establish owner');
  });
  await test('a large profile avatar is excluded regardless of rendered size',async()=>{
    const p=postPage();p.place(p.d.getElementById('hdr'),800,1800,200,200);p.place(p.d.getElementById('ava'),800,1800,200,200);await p.hover(900,1900);assert.equal(p.host(),null);assert.equal(p.calls.length,0);
  });
  await test('a grid that is incomplete, inconsistent or not the only group never claims whole-post completion',async()=>{
    const mutations={
      'a tile without its attachment link':p=>p.d.getElementById('a2').remove(),
      'the grid is no longer declared':p=>p.d.getElementById('atts').removeAttribute('data-testid'),
      'a tile outside the grid':p=>p.d.getElementById('box').append(p.d.getElementById('g2')),
      'no group declared at all (loose attachments)':p=>p.d.querySelectorAll('[data-testid="media-grid-item"]').forEach((tile)=>tile.removeAttribute('data-testid')),
      'two attachments in one tile':p=>p.d.getElementById('g1').append(p.d.getElementById('a2')),
      'a second independent grid':p=>{const second=p.d.createElement('div');second.setAttribute('data-testid','media-grid');p.d.getElementById('box').append(second);second.append(p.d.getElementById('g2'));}
    };
    for(const [name,mutate] of Object.entries(mutations)){const p=postPage();mutate(p);await hover(p,0);assert(p.buttons()&&!p.both(),name+': the unproven list stays single');}
  });
  await test('short access_key in a successful save stays out of all output',async()=>{
    const secret='8675309',src=photo(1)+'&access_key='+secret,p=postPage({items:[{t:'photo',n:1,src}]});await hover(p,0);p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[src]);assert(!p.logs.join('\n').includes(secret),'access_key leaked');
  });
  await test('shared pipeline duplicate logging hides the signed address',async()=>{
    const p=postPage();vm.runInContext('inFlightRequests.add('+JSON.stringify(photo(1))+')',p.s);await hover(p,0);p.click(p.buttons().one);await sleep(220);assert.deepEqual(p.exported(),[]);assert(!p.logs.join('\n').includes(SIG),'duplicate URL leaked');
  });


  await test('a replaced document cannot contribute metadata after the inline owner proof',async()=>{
    const p=postPage();const original=p.s.chrome.scripting.executeScript;
    p.s.chrome.scripting.executeScript=async call=>{if(call.func.name==='extractDomImageMetadata'){p.documentId='doc-2';p.d.getElementById('i0').setAttribute('data-original',photo(9));}return original(call);};
    await hover(p,0);p.click(p.buttons().one);await sleep(380);assert(!p.calls.some(c=>c.url===photo(9)),'replacement document original was requested');assert(!p.exported().includes(photo(9)));assert.deepEqual(p.exported(),[photo(1)]);
  });


  await test('a recycled node cannot replace the frozen source during late generic metadata discovery',async()=>{
    const p=postPage();const original=p.s.chrome.scripting.executeScript;let discovered=false;
    p.s.chrome.scripting.executeScript=async call=>{if(call.func.name==='extractDomImageMetadata'){discovered=true;const old=p.d.getElementById('i0'),replacement=p.d.createElement('img');replacement.src=photo(1);replacement.setAttribute('data-original',photo(9));old.replaceWith(replacement);p.loaded();}return original(call);};
    await hover(p,0);p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(1)]);assert.equal(discovered,false,'no unbound rediscovery after admission');
  });
  await test('an image overlay never selects a different video underneath',async()=>{
    const extra='<a id="profile" href="/club123"><img id="overlay" src="'+AVATAR+'"></a>',p=playerPage(video(1),undefined,extra);
    p.place(p.d.getElementById('profile'),400,200,200,200,1);p.place(p.d.getElementById('overlay'),400,200,200,200,1);p.loaded();await p.hover(500,300);assert.equal(p.host(),null,'unrelated overlay is not the selected video');assert.deepEqual(p.exported(),[]);
  });


  console.log('\n--- VK placement regressions ---');
  await test('photo and video controls start at the upper-left inset', async () => {
    for (const p of [viewerPage(), playerPage(video(1))]) {
      await p.hover(500, 300);
      assert(p.host()); assert.equal(p.box().left, 208); assert.equal(p.box().top, 108);
    }
  });
  await test('scroll: the control keeps its constant upper-left offset on the photo, moves with it, hides when that corner leaves the viewport or goes under a fixed header, and never slides down the picture', async () => {
    const p = viewerPage(), img = p.d.getElementById('big');
    const header = p.d.createElement('header'); header.style.position = 'fixed'; p.d.body.append(header);
    p.place(header, 0, 0, 1400, 56, 10); p.pin(header);
    p.place(img, 200, 100, 800, 3000); await p.hover(500, 500);
    const host = p.host(); assert(host); const first = p.box(); assert.equal(first.left, 208); assert.equal(first.top, 108);
    await p.scroll(40);
    assert.equal(p.host(), host, 'the shown control is kept, without pointer rediscovery');
    assert.deepEqual([p.box().left, p.box().top], [208, 68], 'moved with the photo by exactly the scrolled distance, offset unchanged');
    await p.scroll(30);
    assert.equal(p.host(), null, 'the corner is under the fixed header: hidden, never shifted below it');
    await p.scroll(-70);
    assert(p.host(), 'it returns with the corner'); assert.deepEqual([p.box().left, p.box().top], [208, 108], 'same offset again');
    await p.scroll(400);
    assert.equal(p.host(), null, 'the upper-left corner is above the viewport: nothing floats down the photo'); assert.equal(p.sent.length, 0);
    await p.scroll(-400);
    assert(p.host()); p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(7)]);
  });
  await test('nested scrolling: keyboard-selected media keeps its corner offset and hides, not clamps, once the corner is scrolled out', async () => {
    const p = viewerPage(), img = p.d.getElementById('big');
    img.setAttribute('tabindex', '0'); img.focus(); await sleep(30); assert(p.host());
    p.place(img, 200, 40, 800, 1000); img.parentElement.dispatchEvent(new p.w.Event('scroll')); await sleep(260);
    assert(p.host(), 'keyboard target does not depend on stale pointer coordinates'); assert.equal(p.box().top, 48);
    p.place(img, 200, -300, 800, 1000); p.w.dispatchEvent(new p.w.Event('scroll')); await sleep(260);
    assert.equal(p.host(), null, 'the corner is offscreen: no control floats over the photo'); assert.equal(p.sent.length, 0);
  });
  await test('scroll never moves a control onto a changed source or through a dialog', async () => {
    const p = viewerPage(), img = p.d.getElementById('big'); await p.hover(500, 500);
    img.src = photo(8); p.w.dispatchEvent(new p.w.Event('scroll')); await sleep(75); assert.equal(p.host(), null);
    await p.hover(500, 500); assert(p.host());
    const dialog = p.d.createElement('div'); dialog.style.position = 'fixed'; p.d.body.append(dialog);
    p.place(dialog, 0, 0, 1400, 2400, 20); p.w.dispatchEvent(new p.w.Event('scroll')); await sleep(75);
    assert.equal(p.host(), null); assert.equal(p.sent.length, 0);
  });


  console.log('\n--- VK carousel regressions ---');
  function carouselPage() {
    const p = build({ url: 'https://vk.ru/feed', html: '<div data-post-id="-1_2"><div id="viewport" tabindex="0" style="overflow:hidden"><div id="track"><img id="c1" style="pointer-events:none" src="'+photo(1)+'"><img id="c2" style="pointer-events:none" src="'+photo(2)+'"></div><div id="cover"></div></div></div>' });
    const view=p.d.getElementById('viewport'), track=p.d.getElementById('track'), a=p.d.getElementById('c1'), b=p.d.getElementById('c2');
    p.place(view,100,100,600,500);p.place(track,100,100,1200,500);p.place(a,100,100,600,500);p.place(b,700,100,600,500);
    const original=p.d.elementsFromPoint;
    p.d.elementsFromPoint=(x,y)=>original(x,y).filter(el=>{
      if(p.w.getComputedStyle(el).pointerEvents==='none')return false;
      for(let n=el.parentElement;n;n=n.parentElement)if(n.style.overflow==='hidden'){const r=n.getBoundingClientRect();if(x<r.left||x>r.right||y<r.top||y>r.bottom)return false;}
      return true;
    });
    p.d.elementFromPoint=(x,y)=>p.d.elementsFromPoint(x,y)[0]||null;
    return Object.assign(p,{view,track,a,b});
  }
  await test('a carousel image absent from the hit stack offers Save this without inventing a whole-post count', async()=>{
    const p=carouselPage();await p.hover(300,300);assert(p.buttons()&&!p.both());assert.equal(p.box().left,108);assert.equal(p.box().top,108);
    p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(1)]);
  });
  await test('a carousel cover inside its own post finds only the visible photo', async()=>{
    const p=carouselPage();p.place(p.d.getElementById('cover'),100,100,600,500,1);await p.hover(300,300);assert(p.buttons());p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(1)]);
  });
  await test('clipped carousel photos place the control inside the visible slide',async()=>{
    const p=carouselPage();p.a.style.pointerEvents='auto';p.place(p.a,-100,100,800,500);await p.hover(300,300);assert(p.buttons());assert.equal(p.box().left,108);
  });
  await test('a focused carousel exposes its one visible photo and switching slides changes the selected file',async()=>{
    const p=carouselPage();p.view.focus();await sleep(35);assert(p.buttons());
    p.place(p.a,-500,100,600,500);p.place(p.b,100,100,600,500);p.place(p.track,-500,100,1200,500);p.track.style.transform='translateX(-600px)';
    await p.hover(300,300);assert(p.buttons());p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(2)]);
  });
  await test('a crossfade with two overlapping visible photos stays ambiguous',async()=>{
    const p=carouselPage();p.place(p.b,100,100,600,500);await p.hover(300,300);assert.equal(p.host(),null);assert.equal(p.sent.length,0);
  });
  await test('carousel recovery never crosses a dialog or activates beneath a navigation button',async()=>{
    const p=carouselPage(),button=p.d.createElement('button');p.view.append(button);p.place(button,600,250,60,60,2);await p.hover(620,270);assert.equal(p.host(),null);
    const dialog=p.d.createElement('div');p.d.body.append(dialog);p.place(dialog,200,200,200,200,10);await p.hover(300,300);assert.equal(p.host(),null);assert.equal(p.sent.length,0);
  });


  await test('a modal inside the post blocks recovery and hides an existing carousel control',async()=>{
    for(const opened of [false,true]){
      const p=carouselPage();if(opened){await p.hover(300,300);assert(p.host());}
      const dialog=p.d.createElement('div');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');p.view.append(dialog);p.place(dialog,100,100,600,500,20);
      if(opened)await sleep(200);else await p.hover(300,300);
      assert.equal(p.host(),null);assert.equal(p.sent.length,0);
    }
  });
  await test('a photo inside its own dialog remains an eligible selected media',async()=>{
    const p=carouselPage();p.view.setAttribute('role','dialog');p.view.setAttribute('aria-modal','true');await p.hover(300,300);assert(p.host());p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(1)]);
  });


  await test('a fixed photo viewer with its own cover is not mistaken for a site header',async()=>{
    const p=carouselPage();p.view.setAttribute('role','dialog');p.view.style.position='fixed';const cover=p.d.getElementById('cover');p.place(cover,100,100,600,500,1);
    await p.hover(300,300);assert(p.host());assert.equal(p.box().top,108);
  });


  // Observed live VK DOM: zero-size inline links contain absolute photos; full-height carousel arrows are sibling layers.
  function liveCarouselPage() {
    const p=build({url:'https://vk.ru/millenniumtl',html:'<div data-post-id="-218466214_25"><div class="attachmentCarousel" data-testid="gallery" role="region"><button id="prev" data-testid="carousel-arrow-prev"></button><button id="next" data-testid="carousel-arrow-next"></button><div id="slides">'+[1,2].map(n=>'<div id="slide'+n+'" data-testid="carousel-slide-'+(n-1)+'" role="group" aria-label="'+n+' из 2"><div data-testid="carousel-slide"><div id="frame'+n+'" data-testid="primary-attachment-photo" style="overflow:hidden;position:relative"><div><a id="link'+n+'" href="'+route.photo(n)+'"><img id="live'+n+'" data-testid="primary-attachment-image-content" style="position:absolute" src="'+photo(n)+'"></a></div></div></div></div>').join('')+'</div></div></div>'});
    const gallery=p.d.querySelector('.attachmentCarousel'),prev=p.d.getElementById('prev'),next=p.d.getElementById('next');gallery.style.overflow='hidden';
    p.place(gallery,100,100,551,710);p.place(next,599,100,52,710,2);
    const show=index=>{for(let n=1;n<=2;n++){const x=100+(n-index)*551;p.place(p.d.getElementById('slide'+n),x,100,551,710);p.place(p.d.getElementById('frame'+n),x,100,551,710);p.place(p.d.getElementById('link'+n),x,101,0,0);p.place(p.d.getElementById('live'+n),x,101,551,708);}if(index===2)p.place(prev,100,100,52,710,2);};show(1);
    return Object.assign(p,{gallery,prev,next,show});
  }
  await test('live VK first slide is not hidden by its full-height next-arrow hit area',async()=>{
    const p=liveCarouselPage();await p.hover(350,300);assert(p.host());assert.equal(p.box().left,108);assert.equal(p.box().top,109);p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(1)]);
  });
  await test('live VK previous-arrow layer preserves upper-left placement and the selected second photo',async()=>{
    const p=liveCarouselPage();p.show(2);await p.hover(350,300);assert(p.host());assert.equal(p.box().left,108);assert.equal(p.box().top,109);p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(2)]);
  });
  await test('live VK carousel layers cannot permit a foreign dialog over the media',async()=>{
    const p=liveCarouselPage(),dialog=p.d.createElement('div');dialog.setAttribute('role','dialog');p.gallery.append(dialog);p.place(dialog,100,100,551,710,5);await p.hover(350,300);assert.equal(p.host(),null);assert.equal(p.sent.length,0);
  });


  // Live collage: 275px main photos and a row of 90px thumbnails in declared media-grid items.
  function liveGridPage() {
    const p=build({url:'https://vk.ru/feed',html:'<div data-post-id="-1_2"><div data-testid="media-grid">'+[1,2].map(n=>'<div id="tile'+n+'" data-testid="media-grid-item" style="overflow:hidden"><a id="gridLink'+n+'" href="'+route.photo(n)+'"><img id="gridPhoto'+n+'" data-testid="media-grid-image" src="'+photo(n)+'"></a></div>').join('')+'</div></div>'});
    for(let n=1;n<=2;n++){const x=100+(n-1)*92;p.place(p.d.getElementById('tile'+n),x,100,90,90);p.place(p.d.getElementById('gridLink'+n),x,190,0,0);p.place(p.d.getElementById('gridPhoto'+n),x,100,90,90);}
    return p;
  }
  await test('live 90px collage thumbnails expose their own Save this action without a guessed whole-post count',async()=>{
    const p=liveGridPage();await p.hover(135,135);assert(p.host()&&p.both(),'the two proven tiles are a list');assert.equal(p.box().left,104,'a 90px tile uses the tight inset');p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(1)]);
  });
  await test('moving to the next small collage tile changes the selected source and button corner',async()=>{
    const p=liveGridPage();await p.hover(135,135);assert(p.host());await p.hover(225,135);assert.equal(p.box().left,196);p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(2)]);
  });
  await test('a 90px image outside a proven photo grid remains below the media threshold',async()=>{
    const p=liveGridPage();p.d.getElementById('tile1').removeAttribute('data-testid');await p.hover(135,135);assert.equal(p.host(),null);assert.equal(p.sent.length,0);
  });


  console.log('\n--- VK-INLINE-POST-ACTIONS-03: feed carousels and collages (sanitized live structure) ---');
  const orderOf = (n, from = 1) => Array.from({ length: n }, (_, k) => photo(from + k));
  const savedAll = async (p, n) => { p.click(p.buttons().all); await p.settle(n); };
  await test('a three-slide carousel in the feed (no wall URL): Save this + Save all (3) on the visible slide, attached to the carousel\'s positioned root at that slide\'s corner; Save all saves every slide once, in order', async () => {
    const p = feedPage([{ items: photos(3) }]);
    await hoverOn(p, 'p0s0');
    assert(p.both(), 'both actions'); assert(/Save all \(3\)/.test(p.root().textContent), p.root().textContent);
    assert.deepEqual(p.box(), { left: 589, top: 181, width: 104, height: 60, parent: 'p0car' }, 'upper-left of the slide, inside the carousel\'s own positioned root (where its arrow layers are)');
    await savedAll(p, 3);
    assert.deepEqual(p.exported(), orderOf(3), 'every slide once, in slide order, exact declared addresses'); assert.deepEqual(p.opened.map((o) => o.slice(0, 2)), [['vk', 3]]); assert.deepEqual(p.failures, []);
    assert.equal(message(p, 'VK_INLINE_SAVE_ALL').length, 1); assert.equal(p.begun.length, 3); assert(p.begun.every((o) => o.site === 'vk'));
  });
  await test('a five-slide carousel: Save this saves the visible slide only; Save all (5) saves all five including the offscreen ones, in order', async () => {
    let p = feedPage([{ items: photos(5) }]); p.state.active[0] = 2; p.relayout();
    await hoverOn(p, 'p0s2'); assert(p.both() && /Save all \(5\)/.test(p.root().textContent), p.root().textContent); assert.equal(p.box().parent, 'p0car');
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(3)], 'the selected slide, not its neighbours');
    p = feedPage([{ items: photos(5) }]); p.state.active[0] = 4; p.relayout();
    await hoverOn(p, 'p0s4'); await savedAll(p, 5); assert.deepEqual(p.exported(), orderOf(5)); assert.deepEqual(p.opened.map((o) => o.slice(0, 2)), [['vk', 5]]);
  });
  await test('a carousel whose slides are not all rendered (lazy), whose count evidence disagrees or whose slides are out of order offers Save this only and journals the specific missing declaration', async () => {
    const loose = '<a id="lz" href="/photo-' + OWNER + '_999"><img id="lzi" src="' + photo(99) + '"></a>';
    const cases = { LOOSE_ATTACHMENT: { items: photos(3), extra: loose }, LAZY_SLIDE: { items: [...photos(3), null, null], declared: 5 }, LAZY_SLIDES: { items: photos(3), declared: 5 }, COUNT_MISMATCH: { items: photos(3), counter: 5 }, SLIDE_ORDER: { items: photos(3) } };
    for (const [code, post] of Object.entries(cases)) {
      const log = [], p = feedPage([post], { contentLog: log });
      if (code === 'SLIDE_ORDER') { p.d.getElementById('p0trk').append(p.d.getElementById('p0s0')); p.relayout(); }
      if (code === 'LOOSE_ATTACHMENT') { p.place(p.d.getElementById('lz'), 581, 1100, 300, 200); p.place(p.d.getElementById('lzi'), 581, 1100, 300, 200); }
      await hoverOn(p, 'p0s0'); assert(p.buttons() && !p.both(), code + ': Save this only');
      const refused = log.filter((a) => a[0] === 'vk.inline' && a[1] === 'list'); assert.equal(refused.length, 1, code); assert.equal(refused[0][3], code); assert.deepEqual(Object.keys(refused[0][4]), ['count']);
      p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(1)], code + ': Save this still works');
    }
  });
  await test('slides that arrive later complete the list: the shown control updates to Save all (N) by itself, and N is the number of rendered sources', async () => {
    const p = feedPage([{ items: [...photos(2), null], declared: 3 }]);
    await hoverOn(p, 'p0s0'); assert(p.buttons() && !p.both(), 'one slide is not rendered yet');
    p.d.getElementById('p0s2').outerHTML = slideHtml('p0', 2, 3, { t: 'photo', n: 3 }); p.relayout(); await sleep(500);
    assert(p.both() && /Save all \(3\)/.test(p.root().textContent), 'complete now: ' + p.root().textContent);
    await savedAll(p, 3); assert.deepEqual(p.exported(), orderOf(3));
  });
  await test('a collage of eight (two large tiles, six 90px thumbnails): every tile offers both actions inside its own tile; Save all (8) saves them in grid order', async () => {
    const p = feedPage([{ kind: 'collage', items: photos(8) }]);
    await hoverOn(p, 'p0g0'); assert(p.both() && /Save all \(8\)/.test(p.root().textContent), p.root().textContent); assert.equal(p.box().parent, 'p0g0'); assert.deepEqual([p.box().left, p.box().top], [589, 180]);
    const thumb = p.rects.get(p.d.getElementById('p0g5')); await hoverOn(p, 'p0g5');
    const b = p.box(); assert(p.both(), 'a 90px thumbnail keeps both actions'); assert.equal(b.parent, 'p0g5');
    assert(b.left >= thumb.left && b.top >= thumb.top && b.left + b.width <= thumb.left + thumb.width && b.top + b.height <= thumb.top + thumb.height, 'inside the thumbnail: ' + JSON.stringify(b));
    assert(/Save all 8/.test(p.buttons().all.getAttribute('aria-label')), p.buttons().all.getAttribute('aria-label'));
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(6)], 'Save this on a thumbnail saves that thumbnail\'s photo only');
    const q = feedPage([{ kind: 'collage', items: photos(8) }]); await hoverOn(q, 'p0g5'); await savedAll(q, 8);
    assert.deepEqual(q.exported(), orderOf(8)); assert.deepEqual(q.opened.map((o) => o.slice(0, 2)), [['vk', 8]]);
  });
  await test('a collage with a "+N" overflow tile stays single-only; a declared lazy photo does not hide the full batch', async () => {
    const log = [], p = feedPage([{ kind: 'collage', items: [...photos(7), { t: 'overlay', n: 3 }] }], { contentLog: log });
    await hoverOn(p, 'p0g0'); assert(p.buttons() && !p.both());
    assert(log.some((a) => a[1] === 'list' && a[3] === 'OVERFLOW_TILE'), JSON.stringify(log.filter((a) => a[1] === 'list')));
    await hoverOn(p, 'p0g4'); assert(p.buttons() && !p.both(), 'a thumbnail of that post is no better');
    const q = feedPage([{ kind: 'collage', items: photos(8) }]); q.d.getElementById('p0i6').setAttribute('data-loading', ''); await hoverOn(q, 'p0g0'); assert(q.buttons() && q.both(), 'the exact linked source is declared even before the browser decodes the image');
  });
  await test('feed ownership: neighbouring posts own their own lists, the page address names nothing, and a second element carrying the post key does not narrow the post', async () => {
    const two = () => feedPage([{ key: '-1_10', items: photos(3) }, { key: '-1_11', kind: 'collage', items: [{ t: 'photo', n: 11 }, { t: 'photo', n: 12 }] }]);
    const p = two(); await hoverOn(p, 'p1g1'); assert(p.both() && /Save all \(2\)/.test(p.root().textContent), p.root().textContent);
    await savedAll(p, 2); assert.deepEqual(p.exported(), [photo(11), photo(12)], 'the second post only'); assert(!p.media().some((c) => c.url === photo(1)), 'the neighbour was never requested');
    const q = two(); await hoverOn(q, 'p0s0'); assert(/Save all \(3\)/.test(q.root().textContent)); await savedAll(q, 3); assert.deepEqual(q.exported(), orderOf(3), 'the first post only');
    const r = feedPage([{ items: photos(3) }]); const inner = r.d.createElement('div'); inner.setAttribute('data-post-id', FEEDKEY); const trk = r.d.getElementById('p0trk'); trk.parentElement.insertBefore(inner, trk); inner.append(trk);
    await hoverOn(r, 'p0s0'); assert(r.both() && /Save all \(3\)/.test(r.root().textContent), 'an inner wrapper with the same key is the same post');
  });
  await test('a post nested in the post (a repost, nesting level 1) and a comment of the post are not part of its list; their own photos are single-save only', async () => {
    const repost = '<div id="rp" data-post-id="-555555555_77" data-post-nesting-lvl="1"><a id="rpa" href="/photo-555555555_88"><img id="rpi" src="' + photo(77) + '"></a></div>';
    const comment = '<div id="cm" data-c="post' + FEEDKEY + '_9999"><a id="cma" href="/photo-' + OWNER + '_777"><img id="cmi" src="' + photo(88) + '"></a></div>';
    const nested = '<div id="rq" data-post-id="-555555555_78" data-post-nesting-lvl="1"><div id="rqg" data-testid="media-grid">' + [0, 1].map((k) => '<div id="rqg' + k + '" data-testid="media-grid-item" style="position:relative"><a id="rqa' + k + '" href="/photo-555555555_9' + k + '"><img id="rqi' + k + '" src="' + photo(70 + k) + '"></a></div>').join('') + '</div></div>';
    const stage = () => {
      const p = feedPage([{ items: photos(3), extra: repost + comment + nested }]);
      for (const [id, y] of [['rp', 1100], ['cm', 1520]]) { p.place(p.d.getElementById(id), 581, y, 400, 300); p.place(p.d.getElementById(id + 'a'), 581, y, 400, 300); p.place(p.d.getElementById(id + 'i'), 581, y, 400, 300); }
      p.place(p.d.getElementById('rq'), 581, 1900, 400, 300); p.place(p.d.getElementById('rqg'), 581, 1900, 400, 300);
      for (const k of [0, 1]) for (const id of ['rqg', 'rqa', 'rqi']) p.place(p.d.getElementById(id + k), 581 + k * 200, 1900, 200, 300);
      return p;
    };
    const p = stage(); await hoverOn(p, 'p0s0'); assert(/Save all \(3\)/.test(p.root().textContent), 'neither the repost nor the comment is counted'); await savedAll(p, 3); assert.deepEqual(p.exported(), orderOf(3));
    for (const id of ['rpi', 'cmi', 'rqi0']) { const q = stage(); await hoverOn(q, id); assert(q.buttons() && !q.both(), id + ': Save this only (a nested post\'s own two-tile grid is not a list either)'); }
  });
  await test('stable local anchor: scrolling moves the control with its slide at an unchanged offset; it is never in the zero-size link, never fixed to the viewport and never slides down the picture', async () => {
    const p = feedPage([{ items: photos(3) }]); const header = p.d.createElement('header'); p.d.body.append(header); p.place(header, 0, 0, 1400, 56, 10); p.pin(header);
    await hoverOn(p, 'p0s0'); const host = p.host(), first = p.box(), local = [host.style.left, host.style.top];
    assert.equal(first.parent, 'p0car'); assert.equal(host.closest('a'), null, 'not inside the zero-size photo link'); assert.equal(host.style.position, 'absolute', 'a local child, not fixed to the viewport');
    for (const dy of [30, 25]) {
      await p.scroll(dy);
      assert.equal(p.host(), host, 'the same control'); assert.equal(host.parentElement.id, 'p0car'); assert.deepEqual([host.style.left, host.style.top], local, 'the offset inside its container never changes');
    }
    assert.deepEqual([p.box().left, p.box().top], [589, 181 - 55], 'moved with the slide by exactly the scrolled distance');
    await p.scroll(70); assert.equal(p.host(), null, 'under the fixed header: hidden, not shifted below it');
    await p.scroll(-70); assert(p.host() && p.box().top === 126, 'back at the same corner offset'); assert.equal(p.host().style.left, local[0]);
    await p.scroll(-55); assert(p.host() && p.box().top === 181);
    await p.scroll(300); assert.equal(p.host(), null, 'the corner left the viewport: nothing floats over the middle of the picture'); assert.equal(p.sent.length, 0);
    await p.scroll(-300); assert(p.host()); p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(1)]);
  });
  await test('a positioned, sized link around the photo is never the container: the control stays outside the link', async () => {
    const p = feedPage([{ items: photos(3) }]); p.d.getElementById('p0car').style.position = 'static'; const a = p.d.getElementById('p0a0'); a.style.position = 'relative'; a.style.display = 'block'; p.place(a, 581, 173, 551, 708);
    await hoverOn(p, 'p0s0'); assert(p.host() && p.both()); assert.equal(p.box().parent, 'p0c0'); assert.equal(p.host().closest('a'), null);
  });
  await test('a scroller between the photo and the page leaves no container that would move with the photo: no control (the page itself is not a safe place)', async () => {
    const p = feedPage([{ items: photos(3) }]); for (const id of ['p0c0', 'p0f0']) p.d.getElementById(id).style.position = 'static';
    const s = p.d.getElementById('p0car'); s.style.position = 'static'; p.d.getElementById('p0').style.overflow = 'auto';
    await hoverOn(p, 'p0s0'); assert.equal(p.host(), null, 'an inner scroller cannot be followed from the page'); assert.equal(p.sent.length, 0);
  });
  await test('the media is moved into another container (same place, same offset) between the click and the proof: refused', async () => {
    const p = feedPage([{ items: photos(3) }]); p.d.getElementById('p0car').style.position = 'static'; await hoverOn(p, 'p0s0'); assert(p.host()); assert.equal(p.box().parent, 'p0c0');
    p.beforeAsk = () => { const other = p.d.createElement('div'); other.id = 'alt'; other.style.position = 'absolute'; p.d.getElementById('p0f0').append(other); other.append(p.d.getElementById('p0a0')); p.place(other, 581, 172, 551, 710); };
    p.click(p.buttons().one); await p.idle(); assert.equal(p.media().length, 0, 'the place is the same, the container is not: not the place the control was shown for'); assert(p.failures.length >= 1);
  });
  await test('a full-height arrow layer above the sliding track: the control sits in the carousel\'s own context, above the layer, and the pointer reaches it (not the arrow)', async () => {
    const p = feedPage([{ items: photos(3) }]); p.state.active[0] = 1; p.relayout(); await hoverOn(p, 'p0s1'); await sleep(350);
    assert(p.host() && p.both()); const b = p.box(); assert.equal(b.parent, 'p0car');
    assert.equal(p.d.elementFromPoint(b.left + 20, b.top + 14), p.host(), 'the pointer reaches the control, not the previous-arrow layer');
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(2)]);
  });
  await test('a control found under another layer of the post is moved out of that container to the next one that works', async () => {
    // no positioned carousel root: the nearest container is inside the sliding track, below the arrow layer, so the first container is given up for the next one that works (here the post box)
    const p = feedPage([{ items: photos(3) }]); p.d.getElementById('p0car').style.position = 'static'; p.d.getElementById('p0').style.position = 'relative'; p.state.active[0] = 1; p.relayout();
    await hoverOn(p, 'p0s1'); await sleep(1000);
    const b = p.box(); assert(p.host(), 'still offered'); assert.notEqual(b.parent, 'p0c1', 'not in the container that is below the layer'); assert.equal(p.d.elementFromPoint(b.left + 20, b.top + 14), p.host());
  });
  await test('hover-to-button travel: moving the pointer from the slide onto the control keeps the same control and its actions work', async () => {
    const p = feedPage([{ items: photos(3) }]); await hoverOn(p, 'p0s0'); const host = p.host(), b = p.box();
    await p.hover(b.left + 10, b.top + 10); await p.hover(b.left + 14, b.top + 40);
    assert.equal(p.host(), host); assert(p.both()); p.click(p.buttons().all); await p.settle(3); assert.deepEqual(p.exported(), orderOf(3));
  });
  await test('slide change: the control follows to the newly visible slide and Save this saves that slide', async () => {
    const p = feedPage([{ items: photos(3) }]); await hoverOn(p, 'p0s0'); assert.equal(p.box().parent, 'p0car'); assert.equal(p.box().left, 589);
    p.state.active[0] = 1; p.relayout(); p.d.getElementById('p0trk').style.transform = 'translateX(-551px)'; await sleep(450);
    assert(p.host(), 'it re-arms from the pointer onto the new slide'); assert.equal(p.box().parent, 'p0car'); assert.equal(p.box().left, 589, 'at the corner of the slide that is now shown'); assert(p.both());
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(2)]);
  });
  await test('keyboard: focusing the photo link shows the control; Tab reaches Save this and Save all; Escape dismisses', async () => {
    const p = feedPage([{ items: photos(3) }]); const a = p.d.getElementById('p0a0'); a.focus(); a.dispatchEvent(new p.w.FocusEvent('focusin', { bubbles: true })); await sleep(60);
    const b = p.buttons(); assert(b && p.both()); b.one.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); assert.equal(p.root().activeElement, b.all);
    b.all.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await sleep(40); assert.equal(p.host(), null);
  });
  await test('overlays: a foreign dialog or a foreign element over the corner hides the control, the carousel\'s own arrow layer does not, and the control never covers the arrow icon', async () => {
    let p = feedPage([{ items: photos(3) }]); p.state.active[0] = 1; p.relayout(); await hoverOn(p, 'p0s1');
    assert(p.host() && p.both(), 'the full-height previous-arrow layer is the carousel\'s own'); const prev = p.rects.get(p.d.getElementById('p0prev')); assert(p.box().top + p.box().height < prev.top + prev.height / 2 - 14, 'clear of the arrow icon in the middle of the layer');
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(2)]);
    for (const make of [(d) => { const e = d.createElement('div'); e.setAttribute('role', 'dialog'); e.setAttribute('aria-modal', 'true'); return e; }, (d) => { const e = d.createElement('div'); e.style.position = 'fixed'; return e; }]) {
      p = feedPage([{ items: photos(3) }]); await hoverOn(p, 'p0s0'); assert(p.host());
      const over = make(p.d); p.d.body.append(over); p.place(over, 560, 150, 700, 400, 20); await hoverOn(p, 'p0s0'); await sleep(200);
      assert.equal(p.host(), null, 'covered by a foreign layer'); assert.equal(p.sent.length, 0);
    }
  });
  await test('mixed carousel: every slot is accounted for; a video or clip with no declared direct file is a failed item, a poster is never saved as a video', async () => {
    const p = feedPage([{ items: [{ t: 'photo', n: 1 }, { t: 'video', n: 1 }, { t: 'clip', n: 1 }, { t: 'photo', n: 2 }] }]);
    await hoverOn(p, 'p0s0'); assert(/Save all \(4\)/.test(p.root().textContent), p.root().textContent); await savedAll(p, 2);
    assert.deepEqual(p.exported(), [photo(1), photo(2)]); assert.deepEqual(p.opened.map((o) => o.slice(0, 2)), [['vk', 4]]);
    assert.equal(p.failures.filter((f) => f.code === 'UNSUPPORTED_SOURCE').length, 2, JSON.stringify(p.failures)); assert.equal(p.begun.length, 4); assert.equal(p.media().filter((c) => /okcdn/.test(c.url)).length, 0);
    const q = feedPage([{ items: [{ t: 'photo', n: 1 }, { t: 'video', n: 1, inner: '<video id="pv" src="' + video(1) + '"></video>' }] }]); q.place(q.d.getElementById('pv'), 1132, 173, 551, 708); q.loaded();
    await hoverOn(q, 'p0s0'); await savedAll(q, 2); assert.deepEqual(q.exported().slice().sort(), [photo(1), video(1)].sort()); assert.deepEqual(q.failures, []);
  });
  await test('overlapping Save this and Save all of a carousel slide: the slide is saved once, the rest of the post is saved', async () => {
    const p = feedPage([{ items: photos(3) }]); p.delay[photo(2)] = 250; p.state.active[0] = 1; p.relayout(); await hoverOn(p, 'p0s1');
    p.click(p.buttons().one); await sleep(60); p.click(p.buttons().all); await p.idle(320);
    const saved = p.exported(); assert.equal(saved.filter((u) => u === photo(2)).length, 1, saved.join(' ')); assert(saved.includes(photo(1)) && saved.includes(photo(3)));
  });
  await test('stale owner or list: an identity that changes, a slide that arrives, a slide whose source changes or a recycled post saves nothing and requests nothing', async () => {
    let p = feedPage([{ items: photos(3) }]); await hoverOn(p, 'p0s0'); assert(p.both(), 'the batch was offered before the change'); p.d.getElementById('p0').setAttribute('data-post-id', '-9_9'); p.click(p.buttons().all); await p.idle();
    assert.equal(p.media().length, 0, 'the post is another post now'); assert.equal(p.exported().length, 0);
    p = feedPage([{ items: photos(3) }]); await hoverOn(p, 'p0s0'); assert(p.both(), 'the batch was offered before the change'); p.d.getElementById('p0trk').insertAdjacentHTML('beforeend', slideHtml('p0', 3, 3, { t: 'photo', n: 4 })); p.loaded();
    p.click(p.buttons().all); await p.idle(); assert.equal(p.media().length, 0, 'a slide arrived after the hover: the list changed'); assert.equal(p.sent.length, 0);
    p = feedPage([{ items: photos(3) }]); await hoverOn(p, 'p0s0'); assert(p.both(), 'the batch was offered before the change'); p.beforeAsk = (msg) => { if (msg.action === 'VK_INLINE_BATCH') p.d.getElementById('p0i1').setAttribute('src', photo(9)); };
    p.click(p.buttons().all); await p.idle(); assert.equal(p.media().length, 0, 'a slide changed source between the click and the admission: nothing is saved'); assert(!p.exported().includes(photo(9)));
    p = feedPage([{ items: photos(3) }]); await hoverOn(p, 'p0s0'); assert(p.both(), 'the batch was offered before the change'); p.beforeAsk = (msg) => { if (msg.action === 'VK_INLINE_BATCH') p.d.getElementById('p0').setAttribute('data-post-id', '-9_9'); };
    p.click(p.buttons().all); await p.idle(); assert.equal(p.media().length, 0, 'the post named another post when the batch was admitted'); assert.equal(p.exported().length, 0);
    p = feedPage([{ items: photos(3) }]); await hoverOn(p, 'p0s0'); assert(p.both(), 'the batch was offered before the change'); p.beforeAsk = (msg) => { if (msg.action === 'VK_INLINE_OWNER') p.d.getElementById('p0').remove(); };
    p.click(p.buttons().one); await p.idle(); assert.equal(p.media().length, 0, 'the post was recycled between the click and the proof');
  });
  await test('teardown and re-injection leave one control and no stray host inside the page\'s containers', async () => {
    const p = feedPage([{ items: photos(3) }]); await hoverOn(p, 'p0s0'); assert.equal(p.d.querySelectorAll('[data-image-saver-inline]').length, 1);
    p.inject(); assert.equal(p.d.querySelectorAll('[data-image-saver-inline]').length, 0, 'the first instance removed its control from the page\'s container');
    await hoverOn(p, 'p0s0'); assert.equal(p.d.querySelectorAll('[data-image-saver-inline]').length, 1); assert.equal(p.contentListeners.length, 1);
  });


  await test('a sibling +N overlay on a linked collage tile refuses a visible-subset batch', async () => {
    const p = feedPage([{ kind: 'collage', items: photos(8) }]);
    p.d.getElementById('p0g7').insertAdjacentHTML('beforeend', '<span>+12</span>');
    await hoverOn(p, 'p0g0');
    assert(p.buttons() && !p.both(), 'the linked tile still declares an unknown remainder outside its photo link');
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(1)], 'single selected photo remains available');
  });
  await test('a repeated-key inner wrapper never hides the outer repost nesting boundary', async () => {
    const p = feedPage([{ items: photos(3) }]), root = p.d.getElementById('p0'), track = p.d.getElementById('p0car'), inner = p.d.createElement('div');
    root.setAttribute('data-post-nesting-lvl', '1'); inner.setAttribute('data-post-id', FEEDKEY);
    track.parentElement.insertBefore(inner, track); inner.append(track);
    await hoverOn(p, 'p0s0'); assert(p.buttons() && !p.both(), 'nested repost photos stay single-save even through repeated identity wrappers');
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(1)]);
  });


  await test('live four-slide carousel declares its lazy fourth source before decoding: Save all saves all four without slide switching', async () => {
    const p = feedPage([{ items: photos(4) }]);
    p.d.getElementById('p0i3').setAttribute('data-loading', '');
    assert.equal(p.d.getElementById('p0i3').naturalWidth, 0, 'the browser has not decoded the last slide');
    await hoverOn(p, 'p0s0'); assert(p.both(), 'all four exact sources already belong to the labelled post');
    assert(/Save all \(4\)/.test(p.root().textContent)); await savedAll(p, 4);
    assert.deepEqual(p.exported(), orderOf(4)); assert.deepEqual(p.failures, []);
  });
  await test('a lazy slide with no source refuses the batch, while a declared source that fails is counted as a failed slot', async () => {
    const p = feedPage([{ items: photos(4) }]);
    p.d.getElementById('p0i3').removeAttribute('src'); p.d.getElementById('p0i3').setAttribute('data-loading', '');
    await hoverOn(p, 'p0s0'); assert(p.buttons() && !p.both(), 'a slide label alone cannot invent a missing source');
    const q = feedPage([{ items: photos(4) }], { failUrls: [photo(4)] });
    q.d.getElementById('p0i3').setAttribute('data-loading', ''); await hoverOn(q, 'p0s0'); assert(q.both());
    await savedAll(q, 3); assert.deepEqual(q.exported(), orderOf(3)); assert.equal(q.begun.length, 4); const records = await q.s.feedbackTracker.list(); assert.equal(records.filter(r => r.state === 'failed').length, 1, 'one failed operation, regardless of repeated internal failure callbacks');
  });

  await test('live mixed collage: five photos and two linked video posters save seven owned files via identity-bound progressive metadata', async () => {
    const items = [...photos(3), { t: 'video', n: 1 }, { t: 'video', n: 2 }, { t: 'photo', n: 4 }, { t: 'photo', n: 5 }];
    const p = feedPage([{ kind: 'collage', items }]); vkMetadata(p, 1); vkMetadata(p, 2);
    await hoverOn(p, 'p0g0'); assert(p.both()); p.click(p.buttons().all); await p.settle(7);
    assert.deepEqual(p.exported(), [photo(1), photo(2), photo(3), vkProgressive(1), vkProgressive(2), photo(4), photo(5)]);
    assert.equal(p.failures.length, 0);
    assert.deepEqual(p.vkRequests.map(r => r.form.get('video')).sort(), [vkVideoKey(1), vkVideoKey(2)]);
    assert(p.vkRequests.every(r => r.options.credentials === 'include' && r.options.redirect === 'error' && r.form.get('autoplay') === '0'));
    assert.equal(p.calls.filter(c => /m3u8|poster/.test(c.url)).length, 0);
    assert(!p.logs.join('\n').includes(SIG), 'metadata and signed sources never enter logs');
  });
  await test('video metadata refuses another identity, duplicate players, live/DRM streams, manifests and foreign destinations without losing the photo slot', async () => {
    const cases = [
      d => { d.payload[1][4].mvData.vid++; },
      d => { d.payload[1][4].player.params[0].oid++; },
      d => { d.payload[1][4].player.params.push({ ...d.payload[1][4].player.params[0] }); },
      d => { d.payload[1][4].mvData.is_live = true; },
      d => { d.payload[1][4].player.params[0].drm = true; },
      d => { delete d.payload[1][4].player.params[0].url1080; },
      ...['https://evil.example/video.mp4', 'http://vkvd712.okcdn.ru/v.mp4', 'https://a:b@vkvd712.okcdn.ru/v.mp4', 'https://vkvd712.okcdn.ru:8443/v.mp4', 'https://okcdn.ru.evil.example/v.mp4', 'https://vkvd712.okcdn.ru/hls/index.m3u8', 'https://vkvd712.okcdn.ru/dash/index.mpd'].map(url => d => { d.payload[1][4].player.params[0].url1080 = url; }),
    ];
    for (const change of cases) {
      const p = feedPage([{ kind: 'collage', items: [{ t: 'photo', n: 1 }, { t: 'video', n: 1 }] }]); const data = vkVideoData(1); change(data); vkMetadata(p, 1, data);
      await hoverOn(p, 'p0g0'); p.click(p.buttons().all); await p.settle(1);
      assert.equal(p.vkRequests?.length, 1, 'the video must reach its bounded metadata resolver');
      assert.deepEqual(p.exported(), [photo(1)]); assert.equal(p.calls.filter(c => c.url === vkProgressive(1)).length, 0);
      assert.equal((await p.s.feedbackTracker.list()).filter(r => r.state === 'failed').length, 1);
    }
  });
  await test('a declared video-quality URL with image bytes is refused as invalid media, not exported as a poster', async () => {
    const p = feedPage([{ kind: 'collage', items: [{ t: 'photo', n: 1 }, { t: 'video', n: 1 }] }]); vkMetadata(p, 1); p.vkFiles[vkProgressive(1)] = { bytes: png, mime: 'image/png' };
    await hoverOn(p, 'p0g0'); p.click(p.buttons().all); await p.settle(1);
    assert.equal(p.vkRequests?.length, 1); assert(p.calls.some(c => c.url === vkProgressive(1)));
    assert.deepEqual(p.exported(), [photo(1)]); assert(p.failures.some(f => f.code === 'INVALID_MEDIA'));
  });
  await test('cancelling the admitted batch during video metadata or its probe prevents the next media request', async () => {
    for (const delayed of ['https://vk.ru/al_video.php?act=show', vkProgressive(1)]) {
      const p = feedPage([{ kind: 'collage', items: [{ t: 'photo', n: 1 }, { t: 'video', n: 1 }] }], { batch: true }); vkMetadata(p, 1);
      p.delay[delayed] = 160;
      await hoverOn(p, 'p0g0'); p.click(p.buttons().all); await until(() => p.calls.some(c => c.url === delayed), 'video request begins'); p.cancelled = true; await p.idle(240);
      assert.deepEqual(p.exported(), [photo(1)]); assert.equal(p.calls.filter(c => c.url === vkProgressive(1)).length, delayed === vkProgressive(1) ? 1 : 0);
    }
  });
  await test('batch cancellation during the item proof starts no video metadata request', async () => {
    const p = feedPage([{ kind: 'collage', items: [{ t: 'photo', n: 1 }, { t: 'video', n: 1 }] }], { batch: true }); vkMetadata(p, 1);
    p.beforeAsk = msg => { if (msg.action === 'VK_INLINE_OWNER_ITEM' && msg.index === 1) p.cancelled = true; };
    await hoverOn(p, 'p0g0'); p.click(p.buttons().all); await p.idle(150);
    assert(p.asks.some(q => q.msg.action === 'VK_INLINE_OWNER_ITEM' && q.msg.index === 1));
    assert.equal(p.vkRequests?.length || 0, 0); assert.equal(p.calls.filter(c => c.url === vkProgressive(1)).length, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
