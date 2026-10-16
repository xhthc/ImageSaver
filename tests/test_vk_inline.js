'use strict';
// VK-INLINE-01: the inline Save this / Save all (N) controls on vk.ru, through the production routes: the real content script (content/content_inline.js, in a jsdom window) -> a real
// message to the real background.js (sender checks, one-shot token, same frame and document proof, frozen batch items) -> the real generic resolver and download pipeline (the one the
// context menu uses; there is no VK downloader). Everything the pages here contain is DERIVED, not live VK: the host family (*.vkuserphoto.ru), the .jpg extension, the
// /photo-OWNER_ID, /video-... and /clip-... link routes and a loaded <img> were observed or are public route shapes; the post markup, semantic ARIA attachment lists (standards-derived, not observed on VK), the attribute NAMES that carry the post
// key, the video hosts (taken from the page's own published CSP) and the query parameter names are placeholders chosen only to exercise the code (the handler reads values, never names).
// Layout is stubbed (jsdom has none). A fixture proves the code, not the current live VK DOM; the blocked paths are listed in the handoff.
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
  const rects = new WeakMap(), shadows = new WeakMap();
  Object.defineProperty(w, 'innerWidth', { value: 1400 }); Object.defineProperty(w, 'innerHeight', { value: 2400 });
  // jsdom has no layout, hit testing, loading or trusted events: the harness supplies rectangles, a hit stack, closed-shadow access, `complete`/natural sizes and a test flag for isTrusted
  const rectOf = (el) => {
    if (el.getAttribute && el.getAttribute('data-image-saver-inline')) { const st = el.style; return { left: parseFloat(st.left), top: parseFloat(st.top), width: parseFloat(st.width), height: parseFloat(st.height) }; }
    return rects.get(el);
  };
  w.Element.prototype.getBoundingClientRect = function () { const r = rectOf(this); return r ? { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
  const hitDepth = (el) => { let d = 0; for (let p = el; p; p = p.parentElement) d++; return d; };
  const stackAt = (x, y) => {
    const hits = [];
    for (const el of w.document.querySelectorAll('*')) { const r = rectOf(el); if (r && x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) hits.push([el.hasAttribute('data-image-saver-inline') ? 1e9 : (r.z || 0) * 1e6 + hitDepth(el), el]); }
    return hits.sort((a, b) => b[0] - a[0]).map((h) => h[1]);
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

  const page = { w, d: w.document, bg, s, calls, failures, opened, sent, asks, logs, begun, contentListeners, documentId: 'doc-1', senderOverride: null, proofHook: null, beforeAsk: null, delay: {}, cancelled: false, rects, loaded: () => loaded(w.document) };
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
  s.TextDecoder = TextDecoder; s.Buffer = Buffer;
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
    place(el, left, top, width, height, z) { if (el) rects.set(el, { left, top, width, height, z }); },
    async hover(x, y) { w.document.dispatchEvent(new w.MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true })); await sleep(90); },
    host() { return w.document.querySelector('[data-image-saver-inline="vk"]'); },
    root() { const h = page.host(); return h && shadows.get(h); },
    buttons() { const root = page.root(); const b = root ? root.querySelectorAll('button') : []; return b.length ? { one: b[0], all: b[1], host: page.host() } : null; },
    both() { const b = page.buttons(); return Boolean(b) && !b.all.hasAttribute('hidden'); },
    click(btn, trusted = true) { const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true }); ev.testTrusted = trusted; btn.dispatchEvent(ev); return ev; },
    media() { return calls.filter((c) => /vkuserphoto\.ru|userapi\.com|okcdn\.ru/.test(c.url)); },
    exported() { return bg.downloadedCalls.map((x) => x.url); },
    async settle(n) { if (n) await until(() => bg.downloadedCalls.length >= n, `${n} exports`); await sleep(120); }
  });
  return page;
}

// ---- derived pages ----
// attachments: [{ t: 'photo'|'video'|'clip'|'stray'|'overflow', n, src?, inner? }]; the post key sits in an attribute VALUE of the post box (the attribute name is arbitrary on purpose)
function postHtml({ items, extra = '', boxAttr = 'data-post-id' }) {
  const tile = (it, k) => {
    if (it.t === 'photo') return `<a id="a${k}" role="listitem" aria-posinset="${k + 1}" aria-setsize="${items.length}" href="${route.photo(it.n)}"><img id="i${k}" src="${it.src || photo(it.n)}"></a>`;
    if (it.t === 'video') return `<a id="a${k}" role="listitem" aria-posinset="${k + 1}" aria-setsize="${items.length}" href="${route.video(it.n)}"><img id="i${k}" src="${poster(it.n)}">${it.inner || ''}</a>`;
    if (it.t === 'clip') return `<a id="a${k}" role="listitem" aria-posinset="${k + 1}" aria-setsize="${items.length}" href="${route.clip(it.n)}"><img id="i${k}" src="${poster(it.n)}">${it.inner || ''}</a>`;
    if (it.t === 'overflow') return `<a id="a${k}" role="listitem" aria-posinset="${k + 1}" aria-setsize="${items.length}" href="${route.photo(it.n)}"><img id="i${k}" src="${photo(it.n)}"><span id="o${k}">+3</span></a>`;
    return `<img id="i${k}" src="${it.src || photo(it.n)}">`; // a stray image that is not an attachment link
  };
  return `<!doctype html><body><div id="app"><div id="box" ${boxAttr}="wall-${OWNER}_${POST}"><a id="hdr" href="/club${OWNER}"><img id="ava" src="${AVATAR}"></a><div id="atts" role="list">${items.map(tile).join('')}${extra}</div></div>
    <div id="reco"><a id="ra" href="/photo-111_222"><img id="ri" src="${photo(90)}"></a></div></div></body>`;
}
const photos = (n) => Array.from({ length: n }, (_, k) => ({ t: 'photo', n: k + 1 }));
function postPage(opts = {}) {
  const items = opts.items || photos(3), p = build({ ...opts, html: postHtml({ ...opts, items }) });
  p.place(p.d.getElementById('app'), 0, 0, 1400, 2400); p.place(p.d.getElementById('box'), 90, 40, 700, 2300); p.place(p.d.getElementById('atts'), 100, 100, 600, 2200);
  p.place(p.d.getElementById('hdr'), 100, 50, 48, 48); p.place(p.d.getElementById('ava'), 100, 50, 48, 48);
  items.forEach((_, k) => { const y = 100 + k * 420; p.place(p.d.getElementById('a' + k), 100, y, 600, 400); p.place(p.d.getElementById('i' + k), 100, y, 600, 400); const o = p.d.getElementById('o' + k); if (o) p.place(o, 620, y + 20, 60, 30, 1); });
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
const message = (p, which) => p.sent.filter((m) => m.action === which);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name); console.error(e.stack || e.message || e); }
}

(async () => {
  console.log('\n--- VK-INLINE-01: registration ---');
  await test('manifest: VK is served by the one inline content script (top frame, no new permission)', async () => {
    const m = JSON.parse(code('manifest.json')), entries = m.content_scripts.filter((c) => c.js.includes('content/content_inline.js'));
    assert.equal(entries.length, 1); assert(entries[0].matches.includes('https://vk.ru/*') && entries[0].matches.includes('https://vk.com/*')); assert(!entries[0].all_frames, 'the top frame only');
    assert.deepEqual(entries[0].js, ['lib/debug_journal.js', 'lib/i18n.js', 'content/content_inline.js']);
    assert.deepEqual(m.permissions, ['contextMenus', 'downloads', 'storage', 'scripting', 'declarativeNetRequest', 'offscreen']); assert.deepEqual(m.host_permissions, ['http://*/*', 'https://*/*']);
    assert(code('tools/verify.mjs').includes("'test_vk_inline.js'"), 'the suite runs in tools/verify.mjs');
  });

  await test('registries: vk is appended after every existing site, a VK batch has labels in both languages and no author is invented', async () => {
    const root = { structuredClone, console }; vm.createContext(root);
    for (const f of ['lib/feedback.js', 'lib/sites.js', 'lib/i18n.js']) vm.runInContext(code(f), root);
    const SITES = root.MediaLatchSites.SITES, ids = SITES.map((s) => s.id), vk = SITES[SITES.length - 1];
    assert.equal(vk.id, 'vk'); assert.equal(ids.filter((id) => id === 'vk').length, 1); assert.equal(ids[ids.length - 2], 'wikimedia', 'nothing was reordered');
    assert.deepEqual([...vk.domains], ['vk.com', 'vk.ru', 'vkvideo.ru', 'vkuserphoto.ru', 'userapi.com']);
    for (const lang of ['en', 'ru']) for (const key of ['statistics.site.vk', 'downloads.batch.site.vk']) assert(root.ImageSaverI18n.t(lang, key) && root.ImageSaverI18n.t(lang, key) !== key, lang + ' ' + key);
    const FB = root.ImageSaverFeedback;
    assert.equal(FB.safeAuthor('vk', { site: 'vk', id: '218466214', name: 'Wall owner' }), null, 'the wall owner is not an author');
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
    await hover(p, 0);
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
      p.click(p.buttons().one); await sleep(250);
      assert.equal(p.exported().length, 0, JSON.stringify(override)); assert.equal(p.media().length, 0, JSON.stringify(override));
    }
  });

  await test('forged answers from the proof are refused by the worker: another host, a lookalike host, plain http, credentials, a port, a kind that does not fit its host, a manifest', async () => {
    const forged = [
      { kind: 'photo', url: 'https://evil.example/a.jpg' }, { kind: 'photo', url: 'https://vkuserphoto.ru.evil.example/a.jpg' }, { kind: 'photo', url: 'https://evilvkuserphoto.ru/a.jpg' },
      { kind: 'photo', url: photo(1).replace('https:', 'http:') }, { kind: 'photo', url: 'https://user:pw@sun9-52.vkuserphoto.ru/a.jpg' }, { kind: 'photo', url: 'https://sun9-52.vkuserphoto.ru:8443/a.jpg' },
      { kind: 'video', url: photo(1) }, { kind: 'video', url: 'https://vkvd1.okcdn.ru/hls/index.m3u8?x=1' }, { kind: 'video', url: 'https://evil.example/v.mp4' }, { kind: 'audio', url: photo(1) }, { kind: 'photo', url: 42 }, { kind: 'photo' }
    ];
    for (const media of forged) {
      const p = postPage(); await hover(p, 0);
      p.proofHook = (msg, v) => (msg.action === 'VK_INLINE_OWNER' ? { ok: true, media } : v);
      p.click(p.buttons().one); await sleep(250);
      assert.equal(p.calls.length, 0, 'no request for ' + JSON.stringify(media)); assert.deepEqual(p.exported(), []); assert(p.failures.length >= 1, 'refused visibly');
    }
    // a batch item bound to another post, count, index or structure signature, or without its attachment id, is refused item by item
    for (const bind of [{ ownerId: '1_2' }, { count: 9 }, { index: 7 }, { sig: 'deadbeef' }, { id: '' }, { ownerId: undefined }]) {
      const p = postPage(); await hover(p, 0);
      p.proofHook = (msg, v) => (msg.action === 'VK_INLINE_OWNER_ITEM' && v && v.ok ? { ok: true, media: { ...v.media, ...bind } } : v);
      p.click(p.buttons().all); await sleep(500);
      assert.equal(p.media().length, 0, 'no request for a forged binding ' + JSON.stringify(bind)); assert.deepEqual(p.exported(), []);
    }
  });

  await test('the selected photo is replaced, removed or moved before the click or before the proof: refused, no media request', async () => {
    let p = postPage(); await hover(p, 0);
    p.d.getElementById('i0').setAttribute('src', photo(9)); p.click(p.buttons().one); await sleep(200);
    assert.equal(p.sent.length, 0, 'a replaced source never reaches the worker'); assert.equal(p.media().length, 0);
    p = postPage(); await hover(p, 0);
    p.beforeAsk = () => p.d.getElementById('i0').setAttribute('src', photo(9));
    p.click(p.buttons().one); await sleep(250); assert.equal(p.media().length, 0, 'replaced between the click and the proof'); assert(p.failures.length >= 1);
    p = postPage(); await hover(p, 0);
    p.beforeAsk = () => p.d.getElementById('a0').remove();
    p.click(p.buttons().one); await sleep(250); assert.equal(p.media().length, 0, 'removed between the click and the proof');
    p = postPage(); await hover(p, 0);
    p.beforeAsk = () => { const old = p.d.getElementById('i0'), twin = old.cloneNode(); old.replaceWith(twin); p.loaded(); p.place(twin, 100, 100, 600, 400); }; // a virtualized feed recycles the node: the same address in a new element
    p.click(p.buttons().one); await sleep(250); assert.equal(p.media().length, 0, 'recycled between the click and the proof');
    p = postPage(); await hover(p, 0);
    p.beforeAsk = () => p.place(p.d.getElementById('i0'), 100, 900, 600, 400);
    p.click(p.buttons().one); await sleep(250); assert.equal(p.media().length, 0, 'moved between the click and the proof');
  });

  await test('viewer reopen and clip auto-advance: the next media under the same element is never saved for the earlier click', async () => {
    let p = viewerPage(); await p.hover(500, 500);
    p.beforeAsk = () => { p.w.history.pushState({}, '', `/photo-${OWNER}_457239418`); p.d.getElementById('big').setAttribute('src', photo(8)); };
    p.click(p.buttons().one); await sleep(250);
    assert.equal(p.media().length, 0); assert.deepEqual(p.exported(), []);
    p = playerPage(video(1)); await p.hover(500, 300);
    p.beforeAsk = () => { p.w.history.pushState({}, '', `/clip-${OWNER}_456239778`); p.d.getElementById('v').setAttribute('src', video(2)); };
    p.click(p.buttons().one); await sleep(250);
    assert.equal(p.media().length, 0); assert.deepEqual(p.exported(), []);
  });

  await test('SPA navigation: a control shown on the earlier address saves nothing on the new one; the next hover proves the new page from scratch', async () => {
    const p = postPage(); await hover(p, 0); const old = p.buttons().one;
    p.w.history.pushState({}, '', '/feed');
    p.click(old); await sleep(200);
    assert.equal(p.sent.length, 0, 'the earlier address owns nothing now'); assert.equal(p.exported().length, 0);
    await hover(p, 0); assert(p.buttons() && !p.both(), 'the new address is judged on its own: a photo, but no post list');
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
    const log = [], bare = build({ contentLog: log, html: postHtml({ items: photos(3) }).replace(`wall-${OWNER}_${POST}`, 'nothing-here') });
    bare.place(bare.d.getElementById('app'), 0, 0, 1400, 2400); photos(3).forEach((_, k) => { bare.place(bare.d.getElementById('a' + k), 100, 100 + k * 420, 600, 400); bare.place(bare.d.getElementById('i' + k), 100, 100 + k * 420, 600, 400); });
    await bare.hover(300, 300); assert.equal(log.filter((a) => a[1] === 'list' && a[3] === 'NO_ROOT').length, 1, 'no wrapper names the post');
  });

  await test('a reposted/nested post is not part of this post: its media is neither counted nor saved and has no Save all', async () => {
    const extra = `<div id="rp" data-copy="wall-555555555_77"><a id="rpa" href="/photo-555555555_88"><img id="rpi" src="${photo(77)}"></a></div>`;
    const stage = () => { const p = postPage({ items: photos(2), extra }); p.place(p.d.getElementById('rp'), 100, 1000, 600, 400); p.place(p.d.getElementById('rpa'), 100, 1000, 600, 400); p.place(p.d.getElementById('rpi'), 100, 1000, 600, 400); return p; };
    const p = stage();
    await hover(p, 0); assert(/Save all \(2\)/.test(p.root().textContent), 'the repost is not counted');
    p.click(p.buttons().all); await p.settle(2); assert.deepEqual(p.exported(), [photo(1), photo(2)]);
    const q = stage(); await q.hover(300, 1200); assert(q.buttons() && !q.both(), 'the repost photo is its own media: Save this only');
  });

  await test('a comment of the post and a page that never names the post key: the comment photo is its own media, and without a wrapper that names the post there is no Save all', async () => {
    const extra = `<div id="cm" data-c="post${OWNER}_${POST}_9999"><a id="cma" href="/photo-${OWNER}_777"><img id="cmi" src="${photo(88)}"></a></div>`;
    const p = postPage({ items: photos(2), extra }); p.place(p.d.getElementById('cm'), 100, 1000, 600, 400); p.place(p.d.getElementById('cma'), 100, 1000, 600, 400); p.place(p.d.getElementById('cmi'), 100, 1000, 600, 400);
    await hover(p, 0); assert(/Save all \(2\)/.test(p.root().textContent), 'the comment photo is not counted');
    p.click(p.buttons().all); await p.settle(2); assert.deepEqual(p.exported(), [photo(1), photo(2)]);
    const q = postPage({ items: photos(2), extra }); q.place(q.d.getElementById('cm'), 100, 1000, 600, 400); q.place(q.d.getElementById('cma'), 100, 1000, 600, 400); q.place(q.d.getElementById('cmi'), 100, 1000, 600, 400);
    await q.hover(300, 1200); assert(q.buttons() && !q.both(), 'a comment photo: Save this only');
    const bare = build({ html: postHtml({ items: photos(3) }).replace(`wall-${OWNER}_${POST}`, 'nothing-here') });
    bare.place(bare.d.getElementById('app'), 0, 0, 1400, 2400); photos(3).forEach((_, k) => { bare.place(bare.d.getElementById('a' + k), 100, 100 + k * 420, 600, 400); bare.place(bare.d.getElementById('i' + k), 100, 100 + k * 420, 600, 400); });
    await bare.hover(300, 300); assert(bare.buttons() && !bare.both(), 'no wrapper names the post: the photo can be saved, the list is not proven');
  });

  await test('the list changed after the hover (an attachment added or removed): Save all is refused with no request', async () => {
    let p = postPage(); await hover(p, 0);
    p.d.getElementById('a2').remove(); p.click(p.buttons().all); await sleep(250);
    assert.equal(p.media().length, 0); assert.equal(p.sent.length, 0);
    p = postPage(); await hover(p, 0);
    p.d.getElementById('atts').insertAdjacentHTML('beforeend', `<a id="a9" href="${route.photo(4)}"><img id="i9" src="${photo(4)}"></a>`); p.loaded(); p.place(p.d.getElementById('i9'), 100, 1360, 600, 400);
    p.click(p.buttons().all); await sleep(250); assert.equal(p.media().length, 0);
  });

  await test('the admitted list is saved as it was: a navigation or a removed tile after admission redirects, drops or adds nothing', async () => {
    const p = postPage(); p.delay[photo(1)] = 60; await hover(p, 0);
    let n = 0; p.beforeAsk = (msg) => { if (msg.action === 'VK_INLINE_OWNER_ITEM' && ++n === 2) { p.w.history.pushState({}, '', '/feed'); p.d.getElementById('a2').remove(); } };
    p.click(p.buttons().all); await sleep(700);
    const saved = p.exported(); assert(saved.length <= 3 && saved.every((u) => [photo(1), photo(2), photo(3)].includes(u)), 'nothing outside the admitted list: ' + saved.join(' '));
    assert(!p.media().some((c) => c.url === photo(90)), 'no other post was requested');
  });

  await test('Save this and Save all of the same photo: the photo is saved once and the batch skips it as a duplicate', async () => {
    const p = postPage(); p.delay[photo(2)] = 250; await hover(p, 1);
    p.click(p.buttons().one); await sleep(60); p.click(p.buttons().all); await sleep(900);
    const saved = p.exported(); assert.equal(saved.filter((u) => u === photo(2)).length, 1, 'photo 2 once: ' + saved.join(' ')); assert(saved.includes(photo(1)) && saved.includes(photo(3)));
  });

  await test('Cancel remaining: a cancelled batch starts no further item and records no refusal for the unstarted ones', async () => {
    let p = postPage({ batch: true }); p.cancelled = true; await hover(p, 0);
    p.click(p.buttons().all); await sleep(300); assert.equal(p.media().length, 0); assert.deepEqual(p.exported(), []); assert.deepEqual(p.failures, []);
    p = postPage({ batch: true, items: photos(4) }); p.delay[photo(1)] = 120; p.delay[photo(2)] = 120; await hover(p, 0);
    p.beforeAsk = (msg) => { if (msg.action === 'VK_INLINE_OWNER_ITEM' && msg.index === 1) p.cancelled = true; };
    p.click(p.buttons().all); await sleep(700);
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
    const top = parseFloat(p.host().style.top); assert(top < 100 + 450 / 2, 'in the upper half: ' + top);
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
    await hover(p, 0); p.click(p.buttons().all); await sleep(900);
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
  await test('positive and negative post owners are distinct identities',async()=>{
    const p=postPage();p.d.getElementById('box').setAttribute('data-post-id','wall'+OWNER+'_'+POST);await hover(p,0);assert(p.buttons()&&!p.both(),'opposite signed owner never opens batch');
  });
  await test('incidental URL text is not an intrinsic post boundary',async()=>{
    const p=postPage({boxAttr:'data-url'});await hover(p,0);assert(p.buttons()&&!p.both(),'only intrinsic post attributes establish owner');
  });
  await test('a large profile avatar is excluded regardless of rendered size',async()=>{
    const p=postPage();p.place(p.d.getElementById('hdr'),800,1800,200,200);p.place(p.d.getElementById('ava'),800,1800,200,200);await p.hover(900,1900);assert.equal(p.host(),null);assert.equal(p.calls.length,0);
  });
  await test('missing, incomplete and inconsistent accessible lists never claim whole-post completion',async()=>{
    for(const mutate of [p=>p.d.getElementById('atts').removeAttribute('role'),p=>p.d.getElementById('a2').remove(),p=>p.d.getElementById('a1').setAttribute('aria-posinset','1'),p=>p.d.getElementById('a1').setAttribute('aria-setsize','4'),p=>p.d.getElementById('a1').removeAttribute('aria-setsize')]){
      const p=postPage();mutate(p);await hover(p,0);assert(p.buttons()&&!p.both(),'unproven list stays single');
    }
  });
  await test('independent lists with separate totals cannot be merged into a whole post',async()=>{
    const p=postPage();const second=p.d.createElement('div');second.setAttribute('role','list');p.d.getElementById('atts').append(second);second.append(p.d.getElementById('a2'));await hover(p,0);assert(p.buttons()&&!p.both());
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
      assert(p.host()); assert.equal(p.host().style.left, '208px'); assert.equal(p.host().style.top, '108px');
    }
  });
  await test('scroll keeps the same tall photo selected and moves its control below a fixed header', async () => {
    const p = viewerPage(), img = p.d.getElementById('big');
    const header = p.d.createElement('header'); header.style.position = 'fixed'; p.d.body.append(header);
    p.place(header, 0, 0, 1400, 56, 10);
    p.place(img, 200, 100, 800, 3000); await p.hover(500, 500);
    const host = p.host(); assert(host);
    p.place(img, 200, -500, 800, 3000);
    p.w.dispatchEvent(new p.w.Event('scroll')); await sleep(75);
    assert.equal(p.host(), host, 'the shown control is kept, without pointer rediscovery');
    assert.equal(host.style.left, '208px'); assert.equal(host.style.top, '64px');
    p.place(img, 200, -900, 800, 3000); p.w.dispatchEvent(new p.w.Event('scroll')); await sleep(75);
    assert.equal(p.host(), host); assert.equal(host.style.top, '64px');
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [photo(7)]);
  });
  await test('nested scrolling keeps keyboard-selected media until it leaves the viewport', async () => {
    const p = viewerPage(), img = p.d.getElementById('big');
    img.setAttribute('tabindex', '0'); img.focus(); await sleep(30); assert(p.host());
    p.place(img, 200, -300, 800, 1000); img.parentElement.dispatchEvent(new p.w.Event('scroll')); await sleep(75);
    assert(p.host(), 'keyboard target does not depend on stale pointer coordinates'); assert.equal(p.host().style.top, '8px');
    p.place(img, 200, -1200, 800, 1000); p.w.dispatchEvent(new p.w.Event('scroll')); await sleep(75);
    assert.equal(p.host(), null, 'no floating control for offscreen media'); assert.equal(p.sent.length, 0);
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
    const p=carouselPage();await p.hover(300,300);assert(p.buttons()&&!p.both());assert.equal(p.host().style.left,'108px');assert.equal(p.host().style.top,'108px');
    p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(1)]);
  });
  await test('a carousel cover inside its own post finds only the visible photo', async()=>{
    const p=carouselPage();p.place(p.d.getElementById('cover'),100,100,600,500,1);await p.hover(300,300);assert(p.buttons());p.click(p.buttons().one);await p.settle(1);assert.deepEqual(p.exported(),[photo(1)]);
  });
  await test('clipped carousel photos place the control inside the visible slide',async()=>{
    const p=carouselPage();p.a.style.pointerEvents='auto';p.place(p.a,-100,100,800,500);await p.hover(300,300);assert(p.buttons());assert.equal(p.host().style.left,'108px');
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
    await p.hover(300,300);assert(p.host());assert.equal(p.host().style.top,'108px');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
