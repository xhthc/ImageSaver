'use strict';
// PIXIV-INLINE-01: the inline Save this / Save all (N) controls over Pixiv previews and opened artwork images, through the production routes: the real content script
// (content/content_pixiv.js, in a jsdom window) -> a real message to the real background.js (sender checks, one-shot token, same frame and document proof, explicit inline mode)
// -> the real resolver (lib/site_resolvers.js) and the real Pixiv batch/single save path. Fixtures: the DOM is Pixiv-shaped (card link + thumbnail + page-count label, opened image
// + "k/N" label, recommended cards); layout is stubbed (jsdom has none); the manager is stood in for by the exact-URL export of tests/test_post_media.js. A fixture proves the
// code, not the current live Pixiv DOM.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const { JSDOM } = createRequire(path.join(ROOT, 'ui/package.json'))('jsdom');
const { createTestEnv } = require('./test_context_target_avatar');
const png = fs.readFileSync(path.join(ROOT, 'icons/128.png'));
const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 4000) { for (let t = 0; t < ms; t += 10) { if (await fn()) return; await sleep(10); } throw new Error('TIMEOUT ' + what); }

const A = '150000001', B = '150000002', C = '150000003';     // A: four pages, B: one page, C: three pages
const PAGES = { [A]: 4, [B]: 1, [C]: 3 };
const thumb = (id, n = 0) => `https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/10/12/00/00/00/${id}_p${n}_square1200.jpg`;
const master = (id, n) => `https://i.pximg.net/img-master/img/2026/10/12/00/00/00/${id}_p${n}_master1200.jpg`;
const original = (id, n) => `https://i.pximg.net/img-original/img/2026/10/12/00/00/00/${id}_p${n}.png?sig=EXACT%2B&order=${n}`;
const originals = (id) => Array.from({ length: PAGES[id] }, (_, n) => original(id, n));
const FEED = 'https://www.pixiv.net/en/';

const feedHtml = `<!doctype html><body><section id="feed">
 <div id="c1"><a id="a1" href="/en/artworks/${A}"><img id="i1" src="${thumb(A)}"></a><span id="b1">4</span></div>
 <div id="c2"><a id="a2" href="/en/artworks/${B}"><img id="i2" src="${thumb(B)}"></a></div>
 <div id="c3"><a id="a3" href="/users/9"><img id="av" src="https://i.pximg.net/user-profile/img/2026/10/12/00/00/00/123_50.jpg"></a></div>
 <div id="c4"><a id="a4" href="/en/artworks/${C}"><img id="i4" src="${thumb(C)}"></a><span id="b4">3</span></div></section></body>`;
const openedHtml = (id, label, n) => `<!doctype html><body><main><div id="pages">${Array.from({ length: n }, (_, k) => `<div id="f${k}"><a id="oa${k}" href="${original(id, k)}"><img id="o${k}" src="${master(id, k)}"></a>${k === 0 && label ? `<div id="badge">${label}</div>` : ''}</div>`).join('')}</div>
 <div id="recs"><div id="rc"><a id="ra" href="/en/artworks/${C}"><img id="ri" src="${thumb(C)}"></a><span id="rb">3</span></div></div></main></body>`;

function build({ url, html, lang = 'en', pages = PAGES, bodyOf }) {
  const bg = createTestEnv(), s = bg.bgSandbox, calls = [], failures = [], opened = [], sent = [], asks = [], contentListeners = [];
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window;
  const rects = new WeakMap(), shadows = new WeakMap();
  Object.defineProperty(w, 'innerWidth', { value: 1400 }); Object.defineProperty(w, 'innerHeight', { value: 2000 });
  // jsdom has no layout, hit testing or trusted events: the harness supplies rectangles, a hit stack, closed-shadow access and a test flag for isTrusted
  const rectOf = (el) => {      // the control host is fixed at the pixels its style names; everything else has the rectangle the test placed
    if (el.getAttribute && el.getAttribute('data-image-saver-inline')) { const st = el.style; return { left: parseFloat(st.left), top: parseFloat(st.top), width: parseFloat(st.width), height: parseFloat(st.height) }; }
    return rects.get(el);
  };
  w.Element.prototype.getBoundingClientRect = function () { const r = rectOf(this); return r ? { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
  const stackAt = (x, y) => {
    const hits = [];
    for (const el of w.document.querySelectorAll('*')) { const r = rectOf(el); if (r && x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) hits.push([el.hasAttribute('data-image-saver-inline') ? -1 : r.width * r.height, el]); }
    return hits.sort((a, b) => a[0] - b[0]).map((h) => h[1]);
  };
  w.document.elementsFromPoint = stackAt;
  w.document.elementFromPoint = (x, y) => stackAt(x, y)[0] || null;
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (init) { const root = attach.call(this, init); shadows.set(this, root); return root; };
  const wrapped = new WeakMap(), add = w.EventTarget.prototype.addEventListener, remove = w.EventTarget.prototype.removeEventListener;
  w.EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (typeof fn !== 'function') return add.call(this, type, fn, opts);
    if (!wrapped.has(fn)) wrapped.set(fn, function (ev) { return fn.call(this, new Proxy(ev, { get: (t, p) => (p === 'isTrusted' ? t.testTrusted === true : (typeof t[p] === 'function' ? t[p].bind(t) : t[p])) })); });
    return add.call(this, type, wrapped.get(fn), opts);
  };
  w.EventTarget.prototype.removeEventListener = function (type, fn, opts) { return remove.call(this, type, wrapped.get(fn) || fn, opts); };

  const page = { w, d: w.document, bg, s, calls, failures, opened, sent, asks, contentListeners, documentId: 'doc-1', senderOverride: null, proofHook: null, rects };
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
    const frame = page.senderOverride && 'frameId' in page.senderOverride ? page.senderOverride.frameId : 0;      // the frame that sent the message is the frame that answers
    if (opts.frameId !== frame || (opts.documentId && opts.documentId !== page.documentId)) throw new Error('Could not establish connection. Receiving end does not exist.');
    return new Promise((resolve) => {
      let answered = false;
      for (const cb of contentListeners) cb(msg, { id: 'mock-extension-id' }, (v) => { answered = true; resolve(page.proofHook ? page.proofHook(v) : v); });
      setTimeout(() => { if (!answered) resolve(undefined); }, 30);
    });
  };
  s.chrome.scripting.executeScript = async (call) => {
    if (call.target.documentIds && !call.target.documentIds.includes(page.documentId)) throw new Error('No document with id');
    return [{ result: w.eval('(' + call.func + ')')(...(call.args || [])), documentId: page.documentId }];
  };
  s.TextDecoder = TextDecoder; s.Buffer = Buffer; s.console.info = () => {};
  const list = Object.values(PAGES).length ? Object.keys(PAGES).flatMap((id) => originals(id)) : [];
  s.fetch = async (raw, options = {}) => {
    calls.push({ url: raw, method: options.method || 'GET' });
    const m = /\/ajax\/illust\/(\d+)\/pages$/.exec(raw);
    if (m) return new Response(JSON.stringify({ error: false, body: bodyOf ? bodyOf(m[1]) : (pages[m[1]] ? originals(m[1]).slice(0, pages[m[1]]).map((o) => ({ urls: { original: o } })) : []) }), { headers: { 'content-type': 'application/json' } });
    return list.includes(raw) ? new Response(options.method === 'HEAD' ? null : png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } }) : new Response('not found', { status: 404 });
  };
  vm.runInContext('PAWCHIVE_POST_MEDIA_PACE_MS=0', s);
  s.batchOpen = async (site, count, partial) => { opened.push([site, count, partial]); return null; };
  const fail = s.fbFail; s.fbFail = async (op, failure) => { failures.push(failure); return fail(op, failure); };
  s.managedDownload = async (options) => { const r = await s.fetch(options.url, { method: 'GET' }); if (!r.ok) throw new Error('HTTP_ERROR'); return s.chrome.downloads.download(options); };
  const content = code('content/content_pixiv.js');
  w.eval(code('lib/i18n.js'));
  page.inject = () => w.eval(content);
  page.inject();
  Object.assign(page, {
    place(el, left, top, width, height) { rects.set(el, { left, top, width, height }); },
    async hover(x, y) { w.document.dispatchEvent(new w.MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true })); await sleep(90); },
    host() { return w.document.querySelector('[data-image-saver-inline="pixiv"]'); },
    shadowRoot() { return shadows.get(page.host()); },
    buttons() { const h = page.host(), root = h && shadows.get(h); const b = root ? root.querySelectorAll('button') : []; return b.length ? { one: b[0], all: b[1], host: h } : null; },
    click(btn, trusted = true) { const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true }); ev.testTrusted = trusted; btn.dispatchEvent(ev); return ev; },
    media() { return calls.filter((c) => list.includes(c.url)); },
    metadata() { return calls.filter((c) => /\/pages$/.test(c.url)); },
    exported() { return bg.downloadedCalls.map((x) => x.url); },
    async settle(n) { if (n) await until(() => bg.downloadedCalls.length >= n, `${n} exports`); await sleep(100); }
  });
  return page;
}

// the feed: card A (four pages, label 4), card B (one page), an avatar, card C (three pages, label 3)
function feed(opts = {}) {
  const p = build({ url: FEED, html: feedHtml, ...opts });
  const place = (id, x, y) => { p.place(p.d.getElementById('c' + id), x - 10, y - 10, 220, 260); p.place(p.d.getElementById('a' + id), x, y, 200, 200); const badge = p.d.getElementById('b' + id); if (badge) p.place(badge, x + 158, y + 8, 34, 20); };
  place(1, 100, 100); place(2, 400, 100); place(3, 700, 100); place(4, 1000, 100);
  p.place(p.d.getElementById('i1'), 100, 100, 200, 200); p.place(p.d.getElementById('i2'), 400, 100, 200, 200); p.place(p.d.getElementById('av'), 700, 100, 200, 200); p.place(p.d.getElementById('i4'), 1000, 100, 200, 200);
  p.place(p.d.getElementById('feed'), 0, 0, 1400, 700);
  return p;
}
// the opened artwork: every page image stacked, the page label near the first one, a recommended card elsewhere
function opened(id, label, n, opts = {}) {
  const p = build({ url: `https://www.pixiv.net/en/artworks/${id}`, html: openedHtml(id, label, n), ...opts });
  for (let k = 0; k < n; k++) { p.place(p.d.getElementById('f' + k), 100, 60 + k * 420, 600, 400); p.place(p.d.getElementById('oa' + k), 100, 60 + k * 420, 600, 400); p.place(p.d.getElementById('o' + k), 100, 60 + k * 420, 600, 400); }
  p.place(p.d.getElementById('pages'), 90, 50, 620, 1700);
  p.place(p.d.getElementById('rc'), 800, 60, 220, 260); p.place(p.d.getElementById('ra'), 800, 60, 200, 200); p.place(p.d.getElementById('ri'), 800, 60, 200, 200);
  p.place(p.d.getElementById('rb'), 958, 68, 34, 20); // the recommended card's own page-count overlay
  return p;
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name); console.error(e.stack || e.message || e); }
}

(async () => {
  console.log('\n--- PIXIV-INLINE-01: registration ---');
  await test('manifest: one Pixiv-only content script (top frame, no new permission); the manifest-driven package and syntax lists include it', async () => {
    const m = JSON.parse(code('manifest.json')), entries = m.content_scripts.filter((c) => c.js.includes('content/content_pixiv.js'));
    assert.equal(entries.length, 1); assert.deepEqual(entries[0].matches, ['https://www.pixiv.net/*']); assert.deepEqual(entries[0].js, ['lib/debug_journal.js', 'lib/i18n.js', 'content/content_pixiv.js']); assert(!entries[0].all_frames, 'the top frame only');
    assert.deepEqual(m.permissions, ['contextMenus', 'downloads', 'storage', 'scripting', 'declarativeNetRequest', 'offscreen']); assert.deepEqual(m.host_permissions, ['http://*/*', 'https://*/*']);
    // tools/package.mjs ships every content/content_*.js a manifest entry references (and refuses a missing one); tools/verify.mjs syntax-checks every content script of the manifest
    const pkg = code('tools/package.mjs'), ver = code('tools/verify.mjs');
    assert(pkg.includes('content\\/content_[a-z_]+\\.js') && /^content\/content_[a-z_]+\.js$/.test('content/content_pixiv.js'));
    assert(pkg.includes('(manifest.content_scripts || []).flatMap(item => [...(item.js || []), ...(item.css || [])])') && ver.includes('manifest.content_scripts.flatMap(entry => entry.js)'));
    assert(ver.includes("'test_pixiv_inline.js'"), 'the suite runs in tools/verify.mjs');
  });

  console.log('\n--- PIXIV-INLINE-01: controls ---');
  await test('a preview of a multi-page artwork shows the two labelled actions with the page count, from the card alone: no request on hover', async () => {
    const p = feed(); await p.hover(150, 150);
    const b = p.buttons();
    assert(b && p.host().parentNode === p.d.body, 'one control host in the document');
    assert.equal(b.one.getAttribute('aria-label'), 'MediaLatch: Save this media'); assert.equal(b.one.textContent.trim(), 'Save this');
    assert.equal(b.all.textContent.trim(), 'Save all (4)'); assert.equal(b.all.getAttribute('aria-label'), 'MediaLatch: Save all 4 media in this post');
    assert.equal(p.calls.length, 0, 'no metadata crawl, no media request'); assert.equal(p.sent.length, 0);
  });
  await test('a one-page artwork has only Save this; an avatar and the empty page have no control', async () => {
    const p = feed(); await p.hover(450, 150);
    const b = p.buttons(); assert(b && b.all.hasAttribute('hidden'), 'Save all is hidden for one page'); assert.equal(b.one.textContent.trim(), '');
    await p.hover(750, 150); assert(!p.host(), 'an avatar gets no control');
    await p.hover(20, 650); assert(!p.host(), 'nothing under the pointer');
  });
  await test('count evidence: numeric authors052/52 and a numeric title below the image never create Save all', async () => {
    for (const [word, linked] of [['052', true], ['52', true], ['16', false]]) {
      const p = feed(); p.d.getElementById('b1').remove();
      const wrap = p.d.createElement('div'), label = p.d.createElement('span'); label.textContent = word;
      const parent = linked ? p.d.createElement('a') : wrap;
      if (linked) { parent.href = '/users/9'; wrap.appendChild(parent); }
      parent.appendChild(label); p.d.getElementById('c1').appendChild(wrap);
      for (const el of [wrap, parent, label]) p.place(el, 100, 320, 60, 20);
      await p.hover(150, 150); assert(p.buttons().all.hasAttribute('hidden'), word + ': metadata is not a count');
      assert.equal(p.calls.length, 0, 'no hover metadata lookup');
      p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [original(A, 0)]);
      assert(!p.failures.some(f => f.code === 'POST_MEDIA_MISMATCH')); p.w.close();
    }
  });
  await test('count evidence: the real thumbnail badge wins over numeric author metadata and saves the declared list', async () => {
    const p = feed(), author = p.d.createElement('a'), label = p.d.createElement('span');
    author.href = '/users/9'; label.textContent = '052'; author.appendChild(label); p.d.getElementById('c1').appendChild(author);
    p.place(label, 100, 320, 60, 20); await p.hover(150, 150);
    assert.equal(p.buttons().all.textContent.trim(), 'Save all (4)'); assert.equal(p.calls.length, 0);
    p.click(p.buttons().all); await p.settle(4); assert.deepEqual(p.exported().sort(), originals(A).sort());
    assert(!p.failures.some(f => f.code === 'POST_MEDIA_MISMATCH')); p.w.close();
  });
  await test('count evidence: profile-linked numbers and their wrappers over a thumbnail are not page counts', async () => {
    const p = feed(); p.d.getElementById('b1').remove();
    const wrap = p.d.createElement('div'), author = p.d.createElement('a'), label = p.d.createElement('span');
    author.href = '/users/9'; label.textContent = '52'; author.appendChild(label); wrap.appendChild(author); p.d.getElementById('c1').appendChild(wrap);
    for (const el of [wrap, author, label]) p.place(el, 258, 108, 34, 20);
    await p.hover(150, 150); assert(p.buttons().all.hasAttribute('hidden')); assert.equal(p.calls.length, 0); p.w.close();
  });
  await test('count evidence: ambiguous, noncanonical or zero-size preview labels do not offer Save all', async () => {
    const p = feed(), other = p.d.createElement('span'); other.textContent = '3'; p.d.getElementById('c1').appendChild(other); p.place(other, 218, 108, 34, 20);
    await p.hover(150, 150); assert(p.buttons().all.hasAttribute('hidden'), 'two distinct visible labels are ambiguous'); assert.equal(p.calls.length, 0); p.w.close();
    const q = feed(); q.d.getElementById('b1').textContent = '004'; await q.hover(150, 150); assert(q.buttons().all.hasAttribute('hidden'), 'leading zeros are not a native count'); q.w.close();
    const r = feed(); r.place(r.d.getElementById('b1'), 258, 108, 0, 0); await r.hover(150, 150); assert(r.buttons().all.hasAttribute('hidden'), 'an unlaid-out label is not visible evidence'); r.w.close();
  });
  await test('Russian labels', async () => {
    const p = feed({ lang: 'ru' }); await p.hover(150, 150);
    const b = p.buttons(); assert.equal(b.one.textContent.trim(), 'Сохранить'); assert.equal(b.all.textContent.trim(), 'Все (4)');
    assert(/Сохранить все медиа/.test(b.all.getAttribute('aria-label')));
  });
  await test('opened artwork: both actions on every page image, also on page 2; a single-page artwork only Save this', async () => {
    const p = opened(A, '1/4', 4); await p.hover(300, 60 + 2 * 420 + 100);
    let b = p.buttons(); assert(b && !b.all.hasAttribute('hidden') && b.all.textContent.trim() === 'Save all (4)', 'the page label of the artwork gives N on the third page image');
    const q = opened(B, '', 1); await q.hover(300, 160); b = q.buttons(); assert(b && b.all.hasAttribute('hidden'), 'one page: only Save this');
  });
  await test('a recommended card on an opened artwork is its own artwork: both actions are about that artwork', async () => {
    const p = opened(A, '1/4', 4); await p.hover(850, 100);
    const b = p.buttons(); assert(b && b.all.textContent.trim() === 'Save all (3)', 'the recommended card shows its own count');
    p.click(b.one); await p.settle(1);
    assert.deepEqual(p.exported(), [original(C, 0)], 'Save this on the recommended card saves that artwork page, not the opened one');
  });

  console.log('\n--- PIXIV-INLINE-01: Save this / Save all through the production route ---');
  await test('preview: Save this = exactly the selected page (one export, no group); Save all = every declared page in order, one group', async () => {
    const p = feed(); await p.hover(150, 150);
    p.click(p.buttons().one); await p.settle(1);
    assert.deepEqual(p.exported(), [original(A, 0)]); assert.equal(p.opened.length, 0, 'a single page opens no group'); assert.equal(p.metadata().length, 1);
    const q = feed(); await q.hover(150, 150);
    q.click(q.buttons().all); await q.settle(4);
    assert.deepEqual(q.exported().sort(), originals(A).sort(), 'all and only this artwork pages'); assert.deepEqual(q.opened, [['pixiv', 4, undefined]]); assert.equal(q.metadata().length, 1);
    assert.deepEqual(q.media().filter((c) => c.method === 'GET').map((c) => c.url).sort(), originals(A).sort(), 'each original requested once');
  });
  await test('opened artwork: Save this on page 2 = exactly page 2 (a proven nonzero index); Save all = all four pages once, in order', async () => {
    const p = opened(A, '1/4', 4); await p.hover(300, 60 + 2 * 420 + 100);
    p.click(p.buttons().one); await p.settle(1);
    assert.deepEqual(p.exported(), [original(A, 2)], 'page index 2, not page 0'); assert.equal(p.opened.length, 0);
    const q = opened(A, '1/4', 4); await q.hover(300, 60 + 2 * 420 + 100);
    q.click(q.buttons().all); await q.settle(4);
    assert.deepEqual(q.exported().sort(), originals(A).sort()); assert.deepEqual(q.opened, [['pixiv', 4, undefined]]);
  });
  await test('a one-page artwork (preview and opened): Save this saves its single original', async () => {
    const p = feed(); await p.hover(450, 150); p.click(p.buttons().one); await p.settle(1);
    assert.deepEqual(p.exported(), [original(B, 0)]);
    const q = opened(B, '', 1); await q.hover(300, 160); q.click(q.buttons().one); await q.settle(1);
    assert.deepEqual(q.exported(), [original(B, 0)]);
  });
  await test('Save all on a count the artwork does not have is refused after one metadata request: nothing is saved', async () => {
    const p = feed({ pages: { [A]: 3, [B]: 1, [C]: 3 } }); await p.hover(150, 150);   // the card says 4, the artwork declares 3
    p.click(p.buttons().all); await p.settle();
    assert.equal(p.exported().length, 0); assert.equal(p.media().length, 0); assert(p.failures.some((f) => f.code === 'POST_MEDIA_MISMATCH'), 'a visible failure');
    const q = feed({ pages: { [A]: 1, [B]: 1, [C]: 3 } }); await q.hover(150, 150);    // the label says 4 but the artwork has one page: never "Save all" of a single page
    q.click(q.buttons().all); await q.settle(); assert.equal(q.exported().length, 0); assert(q.failures.some((f) => f.code === 'POST_MEDIA_MISMATCH'));
  });
  await test('Save this on a page the declared list does not have is refused (never page 0 or another page)', async () => {
    const p = opened(A, '1/4', 4, { pages: { [A]: 2, [B]: 1, [C]: 3 } }); await p.hover(300, 60 + 3 * 420 + 100);
    p.click(p.buttons().one); await p.settle();
    assert.equal(p.exported().length, 0); assert.equal(p.media().length, 0); assert(p.failures.some((f) => f.code === 'POST_MEDIA_MISMATCH'));
  });
  await test('a failed original is that action\'s visible failure; cap and metadata errors are refusals before any media request', async () => {
    const big = feed({ pages: { [A]: 101, [B]: 1, [C]: 3 }, bodyOf: () => Array.from({ length: 101 }, (_, i) => ({ urls: { original: original(A, i) } })) });
    await big.hover(150, 150); big.click(big.buttons().all); await big.settle();
    assert.equal(big.media().length, 0); assert(big.failures.some((f) => f.code === 'BATCH_LIMIT'));
    const none = feed({ bodyOf: () => [] }); await none.hover(150, 150); none.click(none.buttons().one); await none.settle();
    assert.equal(none.media().length, 0); assert(none.failures.some((f) => f.code === 'POST_MEDIA_UNAVAILABLE'));
  });
  await test('the declared list is verified: a foreign or mismatching original refuses the whole action', async () => {
    const body = (id) => originals(id).map((o, i) => ({ urls: { original: i === 1 ? o.replace(id, '999999999') : o } }));
    const p = feed({ bodyOf: body }); await p.hover(150, 150); p.click(p.buttons().all); await p.settle();
    assert.equal(p.exported().length, 0); assert.equal(p.media().length, 0); assert(p.failures.some((f) => f.code === 'POST_MEDIA_MISMATCH'));
  });

  console.log('\n--- PIXIV-INLINE-01: token, sender and owner proof ---');
  await test('an untrusted (script) click sends nothing; a trusted one sends only a random token', async () => {
    const p = feed(); await p.hover(150, 150);
    p.click(p.buttons().one, false); await sleep(60); assert.equal(p.sent.length, 0, 'a synthetic click is ignored');
    p.click(p.buttons().one); await p.settle(1);
    assert.equal(p.sent.length, 1); assert.deepEqual(Object.keys(p.sent[0]).sort().filter((k) => k !== 'dbg'), ['action', 'token']); assert(/^[a-f0-9]{32}$/.test(p.sent[0].token)); assert.equal(p.sent[0].action, 'PIXIV_INLINE_SAVE');
  });
  await test('forged, replayed, expired, swapped-action and unknown tokens save nothing and are refused visibly', async () => {
    const p = feed(); await p.hover(150, 150);
    const send = (msg, snd) => { for (const cb of p.s.chrome.runtime.onMessage._listeners) cb(msg, Object.assign({ id: 'mock-extension-id', tab: { id: 1, active: true, url: FEED }, frameId: 0, documentId: 'doc-1', url: FEED }, snd), () => {}); };
    send({ action: 'PIXIV_INLINE_SAVE', token: 'f'.repeat(32) }); await p.settle();
    assert.equal(p.exported().length, 0); assert.equal(p.calls.length, 0, 'an unknown token: no provider request'); assert(p.failures.some((f) => f.code === 'NO_MEDIA'));
    // the same token twice: the second is refused
    p.click(p.buttons().one); await p.settle(1); const token = p.sent[0].token; p.failures.length = 0; const before = p.calls.length;
    send({ action: 'PIXIV_INLINE_SAVE', token }); await p.settle(); assert.equal(p.calls.length, before, 'a replayed token requests nothing'); assert(p.failures.some((f) => f.code === 'NO_MEDIA'));
    // a token minted for Save this, sent as Save all (and the other way round)
    const q = feed(); await q.hover(150, 150); q.click(q.buttons().one); await q.settle(1);
    const mint = (qq, which) => { qq.click(qq.buttons()[which]); return qq.sent[qq.sent.length - 1]; };
    const r = feed(); await r.hover(150, 150);
    r.s.chrome.runtime.onMessage._listeners.splice(0, r.s.chrome.runtime.onMessage._listeners.length, ...r.s.chrome.runtime.onMessage._listeners.map((cb) => (m, snd, res) => cb(m.action === 'PIXIV_INLINE_SAVE' ? Object.assign({}, m, { action: 'PIXIV_INLINE_SAVE_ALL' }) : m, snd, res)));
    mint(r, 'one'); await r.settle(); assert.equal(r.exported().length, 0, 'a Save this token cannot run Save all'); assert.equal(r.metadata().length, 0); assert(r.failures.some((f) => f.code === 'NO_MEDIA'));
    const t = feed(); await t.hover(150, 150);
    t.s.chrome.runtime.onMessage._listeners.splice(0, t.s.chrome.runtime.onMessage._listeners.length, ...t.s.chrome.runtime.onMessage._listeners.map((cb) => (m, snd, res) => cb(m.action === 'PIXIV_INLINE_SAVE_ALL' ? Object.assign({}, m, { action: 'PIXIV_INLINE_SAVE' }) : m, snd, res)));
    mint(t, 'all'); await t.settle(); assert.equal(t.exported().length, 0, 'a Save all token cannot run Save this'); assert.equal(t.metadata().length, 0);
    // expired
    const u = feed(); await u.hover(150, 150); const now = u.w.Date.now, ask = u.s.chrome.tabs.sendMessage; u.s.chrome.tabs.sendMessage = async (...x) => { u.w.Date.now = () => now() + 16000; return ask(...x); }; u.click(u.buttons().one); await u.settle();
    assert.equal(u.exported().length, 0); assert.equal(u.calls.length, 0, 'an expired token requests nothing'); assert(u.failures.some((f) => f.code === 'NO_MEDIA'));
  });
  await test('wrong sender, frame, tab, origin or document: the message is ignored or the proof is not given; no provider request', async () => {
    const cases = { 'foreign extension id': { id: 'other-extension' }, 'a subframe': { frameId: 3 }, 'an inactive tab': { tab: { id: 1, active: false, url: FEED } }, 'another origin': { url: 'https://evil.example/' }, 'pixiv.net (not www)': { url: 'https://pixiv.net/en/' }, 'no tab': { tab: undefined } };
    for (const [name, snd] of Object.entries(cases)) {
      const p = feed(); await p.hover(150, 150); p.senderOverride = snd; p.click(p.buttons().one); await p.settle();
      assert.equal(p.exported().length, 0, name); assert.equal(p.calls.length, 0, name + ': no provider request');
    }
    const p = feed(); await p.hover(150, 150); p.documentId = 'doc-1'; p.senderOverride = { documentId: 'doc-OTHER' }; p.click(p.buttons().one); await p.settle();
    assert.equal(p.exported().length, 0, 'a replaced document does not answer'); assert.equal(p.calls.length, 0);
  });
  await test('only the extension\'s own background may ask this document for its proof, once per token', async () => {
    const p = feed(); await p.hover(150, 150);
    p.s.chrome.tabs.sendMessage = async () => undefined;            // the worker never asks: the token stays pending
    p.click(p.buttons().one); await sleep(60); const token = p.sent[0].token;
    const ask = (sender, mode = 'one') => { let got; let called = false; for (const cb of p.contentListeners) cb({ action: 'PIXIV_INLINE_OWNER', token, mode }, sender, (v) => { called = true; got = v; }); return { called, got }; };
    assert(!ask({ id: 'other-extension' }).called, 'a foreign extension gets no answer');
    assert(!ask({ id: 'mock-extension-id', tab: { id: 2 } }).called, 'neither does a content script or a page (a sender with a tab)');
    assert(!ask(undefined).called);
    const swapped = ask({ id: 'mock-extension-id' }, 'all'); assert(swapped.called && swapped.got.ok === false && swapped.got.reason === 'MODE_MISMATCH', 'the proof is for the action the token was minted for');
    const again = ask({ id: 'mock-extension-id' }); assert(again.called && again.got.ok === false && again.got.reason === 'NO_TOKEN', 'the failed proof also consumed the token');
    const q = feed(); await q.hover(150, 150); q.s.chrome.tabs.sendMessage = async () => undefined; q.click(q.buttons().all); await sleep(60);
    let got; for (const cb of q.contentListeners) cb({ action: 'PIXIV_INLINE_OWNER', token: q.sent[0].token, mode: 'all' }, { id: 'mock-extension-id' }, (v) => { got = v; });
    assert.deepEqual(JSON.parse(JSON.stringify(got)), { ok: true, media: { mode: 'all', src: thumb(A), link: `https://www.pixiv.net/en/artworks/${A}`, count: 4 } }, 'the exact descriptor, nothing else');
  });
  await test('forged answers from the proof are refused by the worker: another artwork, another host, a link that disagrees, a count that is not 2..100', async () => {
    const tamper = {
      'other artwork source': (v) => ({ ...v, media: { ...v.media, src: thumb('149999999') } }),
      'foreign host': (v) => ({ ...v, media: { ...v.media, src: thumb(A).replace('i.pximg.net', 'evil.example') } }),
      'not an artwork asset': (v) => ({ ...v, media: { ...v.media, src: 'https://i.pximg.net/user-profile/img/2026/10/12/00/00/00/123_50.jpg' } }),
      'link of another artwork': (v) => ({ ...v, media: { ...v.media, link: `https://www.pixiv.net/en/artworks/${B}` } }),
      'link on another site': (v) => ({ ...v, media: { ...v.media, link: `https://evil.example/en/artworks/${A}` } }),
      'wrong action in the answer': (v) => ({ ...v, media: { ...v.media, mode: 'all', count: 4 } }),
      'no media': () => ({ ok: true })
    };
    for (const [name, fn] of Object.entries(tamper)) {
      const p = feed(); await p.hover(150, 150); p.proofHook = fn; p.click(p.buttons().one); await p.settle();
      assert.equal(p.exported().length, 0, name); assert.equal(p.media().length, 0, name + ': no media request'); assert.equal(p.metadata().length, 0, name + ': no metadata request');
    }
    for (const count of [1, 101, 2.5, '4', null]) {
      const p = feed(); await p.hover(150, 150); p.proofHook = (v) => ({ ...v, media: { ...v.media, count } }); p.click(p.buttons().all); await p.settle();
      assert.equal(p.exported().length, 0, 'count ' + count); assert.equal(p.media().length, 0);
    }
    // an opened artwork's image that arrives with a link (not the opened layout) is another artwork's card and must name this artwork
    const o = opened(A, '1/4', 4); await o.hover(300, 100); o.proofHook = (v) => ({ ...v, media: { ...v.media, link: `https://www.pixiv.net/en/artworks/${C}` } }); o.click(o.buttons().one); await o.settle();
    assert.equal(o.exported().length, 0); assert.equal(o.media().length, 0);
  });
  await test('the owner moved before the click or before the proof: recycled link, new source, removed image, navigation, new label are refused without requests', async () => {
    const mk = async () => { const p = feed(); await p.hover(150, 150); return p; };
    const beforeClick = {
      'recycled card, same source, another artwork link': (p) => p.d.getElementById('a1').setAttribute('href', `/en/artworks/${B}`),
      'lazy rerender: new source': (p) => p.d.getElementById('i1').setAttribute('src', thumb(B)),
      'removed': (p) => p.d.getElementById('i1').remove(),
      'the label changed': (p) => { p.d.getElementById('b1').textContent = '5'; }
    };
    for (const [name, change] of Object.entries(beforeClick)) { const p = await mk(); change(p); p.click(p.buttons().all || p.buttons().one); await p.settle(); assert.equal(p.exported().length, 0, name); assert.equal(p.calls.length, 0, name); }
    const afterClick = {
      'recycled link': (p) => p.d.getElementById('a1').setAttribute('href', `/en/artworks/${B}`),
      'new source': (p) => p.d.getElementById('i1').setAttribute('src', thumb(B)),
      'removed': (p) => p.d.getElementById('i1').remove(),
      'navigation': (p) => p.w.history.pushState({}, '', '/en/tags/x')
    };
    for (const [name, change] of Object.entries(afterClick)) {
      const p = await mk(); const origAsk = p.s.chrome.tabs.sendMessage;
      p.s.chrome.tabs.sendMessage = async (...a) => { change(p); return origAsk(...a); };
      p.click(p.buttons().all); await p.settle(); assert.equal(p.exported().length, 0, name + ' before the proof'); assert.equal(p.calls.length, 0, name);
    }
  });
  await test('navigation after the proof: before /pages replies no page is saved; the control hides on SPA navigation', async () => {
    const p = feed(); await p.hover(150, 150);
    const fetch = p.s.fetch; p.s.fetch = async (raw, o) => { if (/\/pages$/.test(raw)) p.w.history.pushState({}, '', '/en/tags/x'); return fetch(raw, o); };
    p.click(p.buttons().all); await p.settle(); assert.equal(p.exported().length, 0, 'the admitting document moved before the list was fixed'); assert.equal(p.media().length, 0);
    await p.hover(150, 150); assert(!p.host() || p.buttons(), 'no stale control is left');
  });
  await test('after the list is fixed a navigation or the card disappearing does not redirect, drop or add anything: the admitted post is saved as it was', async () => {
    const p = feed(); await p.hover(150, 150);
    const fetch = p.s.fetch; let moved = false;
    p.s.fetch = async (raw, o) => { if (!moved && p.media().length === 0 && originals(A).includes(raw)) { moved = true; p.w.history.pushState({}, '', '/en/tags/x'); p.d.getElementById('i1').remove(); } return fetch(raw, o); };
    p.click(p.buttons().all); await p.settle(4);
    assert(moved); assert.deepEqual(p.exported().sort(), originals(A).sort()); assert.deepEqual(p.opened, [['pixiv', 4, undefined]]);
  });
  await test('a double click and a second click while running start one action; a later action is not suppressed', async () => {
    const p = feed(); await p.hover(150, 150);
    const b = p.buttons(); p.click(b.one); p.click(b.one); await p.settle(1);
    assert.equal(p.sent.length, 1, 'the second activation is the busy case'); assert.equal(p.exported().length, 1);
    p.click(b.all); await p.settle(5); assert.equal(p.sent.length, 2, 'Save all is a different action'); assert.deepEqual(p.exported().filter((u, i, a) => a.indexOf(u) === i).sort(), originals(A).sort());
    await sleep(1600); p.click(p.buttons().one); await sleep(200); assert.equal(p.sent.length, 3, 'a later click of the same action after the gap is a new request');
  });

  console.log('\n--- PIXIV-INLINE-01: page behaviour ---');
  await test('scroll hides the control; a stationary pointer then finds the artwork now under it (no stuck control on the old card)', async () => {
    const p = feed(); await p.hover(150, 150); assert(p.buttons() && p.host());
    p.place(p.d.getElementById('i1'), 100, 600, 200, 200); p.place(p.d.getElementById('a1'), 100, 600, 200, 200); p.place(p.d.getElementById('c1'), 90, 590, 220, 260);
    p.place(p.d.getElementById('i2'), 100, 100, 200, 200); p.place(p.d.getElementById('a2'), 100, 100, 200, 200); p.place(p.d.getElementById('c2'), 90, 90, 220, 260);
    p.w.dispatchEvent(new p.w.Event('scroll'));
    assert(!p.host(), 'hidden at once');
    await sleep(400); const b = p.buttons(); assert(b && p.host(), 'back where the pointer rests'); assert.equal(b.all.hasAttribute('hidden'), true, 'and it is the one-page artwork now under the pointer');
    p.click(b.one); await p.settle(1); assert.deepEqual(p.exported(), [original(B, 0)], 'the action belongs to the artwork under the pointer, not the old card');
  });
  await test('something drawn over the image (a header, a dialog) hides the control; an image too small gets none', async () => {
    const p = feed(); const cover = p.d.createElement('div'); p.d.body.appendChild(cover); p.place(cover, 90, 90, 240, 60);
    await p.hover(250, 250); assert(!p.host(), 'a header over the top of the image: no control over the covered image');
    cover.remove(); await p.hover(251, 251); assert(p.host() && p.buttons(), 'and it returns when nothing covers the image');
    const q = feed(); q.place(q.d.getElementById('i1'), 100, 100, 60, 40); await q.hover(120, 120); assert(!q.host(), 'a thumbnail too small to hold the control');
  });
  await test('re-injection leaves one control and one message per click; teardown removes the listeners', async () => {
    const p = feed(); p.inject(); p.inject(); await p.hover(150, 150);
    assert.equal(p.d.querySelectorAll('[data-image-saver-inline="pixiv"]').length, 1);
    p.click(p.buttons().one); await p.settle(1); assert.equal(p.sent.length, 1); assert.equal(p.exported().length, 1);
    p.w.__medialatchPixivInline.teardown(); assert(!p.host(), 'the control is gone');
    await p.hover(150, 150); assert(!p.host(), 'and nothing listens any more');
  });
  await test('keyboard: focusing the card link shows the control; Tab reaches Save this and Save all; Escape dismisses', async () => {
    const p = feed(); p.d.getElementById('a1').focus(); p.d.getElementById('a1').dispatchEvent(new p.w.FocusEvent('focusin', { bubbles: true }));
    const b = p.buttons(), root = p.shadowRoot(), key = (el, k, shift = false) => el.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
    assert(b && p.host(), 'shown by focus');
    key(p.d.getElementById('a1'), 'Tab'); assert.equal(root.activeElement, b.one, 'Tab from the card link goes to Save this');
    key(b.one, 'Tab'); assert.equal(root.activeElement, b.all, 'and on to Save all');
    key(b.all, 'Tab', true); assert.equal(root.activeElement, b.one, 'Shift+Tab goes back');
    key(b.one, 'Escape'); assert(!p.host(), 'Escape dismisses'); assert.equal(p.d.activeElement, p.d.getElementById('a1'), 'and returns the focus to the card link');
    const q = feed(); q.d.getElementById('a1').dispatchEvent(new q.w.FocusEvent('focusin', { bubbles: true })); const kb = q.buttons();
    q.click(kb.all); await q.settle(4); assert.equal(q.exported().length, 4, 'activating Save all from the keyboard path');
  });
  await test('unsupported targets get no control: an animation/canvas card, an image whose link is not its artwork, a non-pximg image', async () => {
    const a = feed(); a.d.getElementById('a1').appendChild(a.d.createElement('canvas')); await a.hover(150, 150); assert(!a.host(), 'ugoira-like canvas');
    const b = feed(); b.d.getElementById('a1').setAttribute('href', `/en/artworks/${B}`); await b.hover(150, 150); assert(!b.host(), 'link and asset disagree');
    const c = feed(); c.d.getElementById('i1').setAttribute('src', 'https://example.com/x.jpg'); await c.hover(150, 150); assert(!c.host(), 'not an artwork asset');
    const d = opened(A, '1/4', 4); d.d.getElementById('oa1').setAttribute('href', 'https://www.pixiv.net/users/9'); await d.hover(300, 60 + 420 + 100); assert(!d.host(), 'an opened image wrapped by a link of something else');
  });

  await test('a preview of a later page keeps its page index; a lazy image gets its control only once it shows an artwork asset; other pximg images get none', async () => {
    const p = feed(); p.d.getElementById('i1').setAttribute('src', thumb(A, 2)); await p.hover(150, 150); p.click(p.buttons().one); await p.settle(1);
    assert.deepEqual(p.exported(), [original(A, 2)], 'the selected page is page 2 of the artwork, not its cover');
    const q = feed(); q.d.getElementById('i1').setAttribute('src', 'https://s.pximg.net/common/images/placeholder.gif'); await q.hover(150, 150); assert(!q.host(), 'a placeholder is not an artwork asset');
    q.d.getElementById('i1').setAttribute('src', thumb(A)); await q.hover(151, 151); assert(q.host() && q.buttons(), 'the real source shows the control');
    const r = feed(); r.d.getElementById('i1').setAttribute('src', 'https://i.pximg.net/c/540x540/novel-cover-master/img/2026/10/12/00/00/00/123456_abcdef_master1200.jpg'); await r.hover(150, 150); assert(!r.host(), 'a novel cover or banner');
  });
  await test('SPA navigation: a control shown on one page is hidden by the next pointer move on the new address', async () => {
    const p = feed(); await p.hover(150, 150); assert(p.host());
    p.w.history.pushState({}, '', '/en/ranking.php'); p.d.getElementById('i1').remove(); await p.hover(151, 151); assert(!p.host(), 'the card is gone with the old page');
  });

  console.log('\n--- PIXIV-INLINE-01 follow-up: back/forward cache, displayed placement, overlapping actions ---');
  await test('F1 back/forward cache: a persisted pagehide clears the control, tokens and busy state; pageshow resumes pointer and keyboard saving with one proof handler', async () => {
    const p = feed(); await p.hover(150, 150); assert(p.host()); assert.equal(p.contentListeners.length, 1);
    const ask = p.s.chrome.tabs.sendMessage; p.s.chrome.tabs.sendMessage = async () => undefined;      // the worker never asks: the token stays pending
    p.click(p.buttons().one); await sleep(60); const token = p.sent[0].token; p.s.chrome.tabs.sendMessage = ask;
    p.w.dispatchEvent(new p.w.PageTransitionEvent('pagehide', { persisted: true }));
    assert(!p.host(), 'the control is gone while the page is cached'); assert.equal(p.contentListeners.length, 1, 'the proof handler is kept, once');
    let got; for (const cb of p.contentListeners) cb({ action: 'PIXIV_INLINE_OWNER', token, mode: 'one' }, { id: 'mock-extension-id' }, (v) => { got = v; });
    assert.deepEqual(JSON.parse(JSON.stringify(got)), { ok: false, reason: 'NO_TOKEN' }, 'a token of the suspended page proves nothing');
    p.w.dispatchEvent(new p.w.PageTransitionEvent('pageshow', { persisted: true }));
    assert.equal(p.contentListeners.length, 1, 'no second proof handler after the restore');
    await p.hover(150, 150); const b = p.buttons(); assert(b && p.host(), 'pointer: the control is back');
    p.click(b.one); await p.settle(1);
    assert.equal(p.sent.length, 2, 'the busy state of the suspended page did not swallow the first click after the restore'); assert.deepEqual(p.exported(), [original(A, 0)]);
    // keyboard
    await p.hover(5, 5); assert(!p.host());
    p.w.dispatchEvent(new p.w.PageTransitionEvent('pagehide', { persisted: true })); p.w.dispatchEvent(new p.w.PageTransitionEvent('pageshow', { persisted: true }));
    p.d.getElementById('a1').dispatchEvent(new p.w.FocusEvent('focusin', { bubbles: true })); assert(p.buttons() && p.host(), 'keyboard: the control is shown by focus after the restore');
  });
  await test('F1 a real unload (not persisted) still ends everything; a re-injection after it gives one control and one proof handler', async () => {
    const p = feed(); await p.hover(150, 150); assert(p.host());
    p.w.dispatchEvent(new p.w.PageTransitionEvent('pagehide', { persisted: false }));
    assert(!p.host()); assert.equal(p.contentListeners.length, 0, 'the proof handler is removed'); assert(!p.w.__medialatchPixivInline);
    await p.hover(150, 150); assert(!p.host(), 'nothing listens any more');
    p.inject(); p.inject(); await p.hover(150, 150); assert.equal(p.contentListeners.length, 1); assert.equal(p.d.querySelectorAll('[data-image-saver-inline="pixiv"]').length, 1);
    p.click(p.buttons().one); await p.settle(1); assert.equal(p.sent.length, 1); assert.equal(p.exported().length, 1);
  });

  const moveCard = (p, n, x, y) => { for (const el of ['i', 'a']) p.place(p.d.getElementById(el + n), x, y, 200, 200); p.place(p.d.getElementById('c' + n), x - 10, y - 10, 220, 260); const badge = p.d.getElementById('b' + n); if (badge) p.place(badge, x + 158, y + 8, 34, 20); };      // card n of the feed fixture (1 = artwork A, 2 = B)
  await test('F2 an intact card that moved away (a reflow, no scroll, no mutation) leaves a control that no longer saves it: refused with no request, also with another card under the old control', async () => {
    const p = feed(); await p.hover(150, 150); const b = p.buttons();
    moveCard(p, 1, 800, 500); moveCard(p, 2, 100, 100);                    // A moved; B now where A was: the old control is over B
    p.click(b.one); await p.settle();
    assert.equal(p.sent.length, 0, 'refused before a token is minted'); assert.equal(p.calls.length, 0, 'no provider request'); assert.equal(p.exported().length, 0, 'no export');
    const q = feed(); await q.hover(150, 150); const c = q.buttons();
    moveCard(q, 1, 800, 500);                                               // A moved, nothing under the old control
    q.click(c.all); await q.settle(); assert.equal(q.sent.length, 0); assert.equal(q.calls.length, 0); assert.equal(q.exported().length, 0);
  });
  await test('F2 a move between the click and the owner proof is a stale owner: nothing is requested', async () => {
    const p = feed(); await p.hover(150, 150); const ask = p.s.chrome.tabs.sendMessage;
    p.s.chrome.tabs.sendMessage = async (...a) => { moveCard(p, 1, 800, 500); return ask(...a); };
    p.click(p.buttons().all); await p.settle();
    assert.equal(p.sent.length, 1, 'the click was admitted by the displayed control'); assert.equal(p.calls.length, 0, 'but the proof refused the moved owner'); assert.equal(p.exported().length, 0);
    assert(p.failures.some((f) => f.code === 'NO_MEDIA'), 'a visible refusal');
  });
  await test('F2 an ordinary reposition keeps working: the control follows the image and the next click is bound to the new place; a batch that was already admitted is not touched by a later move', async () => {
    const p = feed(); await p.hover(150, 150); const before = p.host().style.top;
    moveCard(p, 1, 140, 140); p.d.getElementById('i1').setAttribute('style', 'outline:0');       // the card moved a little and the page told us (a mutation of the shown image)
    await sleep(400); assert.notEqual(p.host().style.top, before, 'the control followed the image'); assert(p.buttons());
    p.click(p.buttons().one); await p.settle(1); assert.deepEqual(p.exported(), [original(A, 0)], 'and saves that artwork from its new place');
    const q = feed(); await q.hover(150, 150); const fetch = q.s.fetch; let moved = false;
    q.s.fetch = async (raw, o) => { if (!moved && originals(A).includes(raw)) { moved = true; moveCard(q, 1, 900, 600); } return fetch(raw, o); };
    q.click(q.buttons().all); await q.settle(4);
    assert(moved); assert.deepEqual(q.exported().sort(), originals(A).sort(), 'the admitted batch is frozen: moving the card afterwards changes nothing');
  });

  // a page held in flight at the shared save boundary; the batch loop's slot calls are recorded at the existing helper boundaries (the real manager's duplicate path is covered by test_ux_feedback 34a)
  const overlapping = async (opts = {}) => {
    const p = opts.opened ? opened(A, '1/4', 4) : feed(), held = opts.held || original(A, 0), base = p.s.managedDownload, entered = [], begins = [], settles = [], discards = [];
    let release; const gate = new Promise((r) => { release = r; });
    p.s.managedDownload = async (options, ...rest) => { entered.push(options.url); if (options.url === held) await gate; return base(options, ...rest); };
    p.s.batchOpen = async (site, count, partial) => { p.opened.push([site, count, partial]); return { id: 'batch-x' }; };      // a group, so every item has a slot
    p.s.batchSettle = async (ref, none) => { settles.push([ref && ref.i, none]); };
    const fbBegin = p.s.fbBegin; p.s.fbBegin = async (info, tab) => { begins.push(info.slot ? info.slot.i : null); return fbBegin(info, tab); };
    const fbDiscard = p.s.fbDiscard; p.s.fbDiscard = async (op) => { discards.push(op); return fbDiscard(op); };
    return Object.assign(p, { entered, begins, settles, discards, release, count: (u) => entered.filter((x) => x === u).length });
  };
  for (const first of ['one', 'all']) {
    await test(`F3 ${first} then ${first === 'one' ? 'all' : 'one'} while page 0 is in flight: the page is saved once, the other pages once each, the overlapped slot is a skipped duplicate, a later explicit save works`, async () => {
      const p = await overlapping(); await p.hover(150, 150); const b = p.buttons(), other = first === 'one' ? 'all' : 'one';
      p.click(b[first]); await until(() => p.count(original(A, 0)) === 1, 'the first action is on page 0');
      p.click(b[other]); await sleep(350);
      assert.equal(p.count(original(A, 0)), 1, 'page 0 never entered the save twice');
      p.release(); await until(() => p.exported().length >= 4, 'the rest finished'); await sleep(150);
      assert.deepEqual(p.exported().sort(), originals(A).sort(), 'four pages, four files: each exactly once (never five)');
      assert.equal(p.failures.length, 0, 'an overlapped duplicate is not a failure');
      if (first === 'one') {
        assert(!p.begins.includes(0), 'the overlapped batch slot started no operation'); assert.equal(p.discards.length, 1, 'only the Save all click itself was discarded'); assert(p.begins.includes(1) && p.begins.includes(2) && p.begins.includes(3), 'the other pages were saved by the batch');
        const skipped = p.settles.find((x) => x[0] === 0); assert(skipped && skipped[1] === undefined, 'the slot is settled by the loop without an operation: skipped, never saved');
      } else {
        assert.equal(p.discards.length, 2, 'the Save all click itself and the overlapping single were discarded (not failed): the single saved nothing'); assert(p.begins.includes(0), 'the batch kept page 0 (its slot has the operation)');
      }
      await sleep(1600); p.click(p.buttons().one); await until(() => p.exported().length === 5, 'a later explicit Save this exports the page again');
      assert.equal(p.exported().filter((u) => u === original(A, 0)).length, 2, 'the claim was released');
    });
  }
  await test('F3 the guard is per page: Save all while Save this of page 2 runs saves pages 0, 1 and 3 and that page once; a failed save releases its claim', async () => {
    const held = original(A, 2), p = await overlapping({ opened: true, held }); await p.hover(300, 60 + 2 * 420 + 100); const b = p.buttons();
    p.click(b.one); await until(() => p.count(held) === 1, 'Save this is on page 2'); p.click(b.all); await sleep(350);
    assert.equal(p.count(held), 1); assert.deepEqual(p.entered.filter((u) => u !== held).sort(), [original(A, 0), original(A, 1), original(A, 3)].sort(), 'the other pages were not suppressed');
    p.release(); await until(() => p.exported().length >= 4, 'finished'); await sleep(100); assert.deepEqual(p.exported().sort(), originals(A).sort());
    const f = feed(), base = f.s.managedDownload; let failOnce = true;
    f.s.managedDownload = async (o, ...r) => { if (failOnce && o.url === original(A, 0)) { failOnce = false; throw new Error('HTTP_ERROR'); } return base(o, ...r); };
    await f.hover(150, 150); f.click(f.buttons().one); await sleep(300); assert.equal(f.exported().length, 0); assert(f.failures.length >= 1, 'the first save failed visibly');
    await sleep(1600); f.click(f.buttons().one); await f.settle(1); assert.deepEqual(f.exported(), [original(A, 0)], 'a failed save did not leave the page claimed');
  });

  console.log('\n--- PIXIV-INLINE-01: unchanged context-menu scope ---');
  await test('F3 direct-original context-menu save keeps its own page claim and a later explicit save still works', async () => {
    const p = opened(A, '1/4', 4), raw = original(A, 0);
    p.d.getElementById('o0').setAttribute('src', raw);
    // A valid context-menu owner is already admitted; exercise the real resolver/pipeline after that boundary.
    p.s.resolveContextOwner = async (_tab, _frame, claim) => { claim.documentId = 'doc-1'; return 'proven'; };
    const info = () => ({ menuItemId: 'save-image-item', srcUrl: raw, pageUrl: p.w.location.href, frameId: 0, mediaType: 'image' });
    await p.s.onContextMenuClicked(info(), { id: 1, url: p.w.location.href });
    assert.deepEqual(p.exported(), [raw], 'an exact original must not be discarded as its own duplicate');
    assert.equal(p.failures.length, 0);
    assert.equal(vm.runInContext('inFlightRequests.size', p.s), 0, 'the owned page claim is released');
    await p.s.onContextMenuClicked(info(), { id: 1, url: p.w.location.href });
    assert.deepEqual(p.exported(), [raw, raw], 'a later explicit save is independent after completion');
    assert.equal(vm.runInContext('inFlightRequests.size', p.s), 0);
  });

  await test('the context menu keeps its defaults (a feed preview is the whole artwork, an opened image only its page) and cannot carry an inline mode', async () => {
    const p = feed(), resolve = p.s.resolveOriginalMediaPlan, seen = [];
    p.s.resolveOriginalMediaPlan = async (a, ...r) => { seen.push(a); return resolve(a, ...r); };
    const card = `https://www.pixiv.net/en/artworks/${A}`;
    const batch = await resolve({ srcUrl: thumb(A), pageUrl: FEED, linkUrl: card, allowPostMedia: true });
    assert.deepEqual(Array.from(batch.pixivPostMedia.items), originals(A), 'default: the preview saves the whole artwork');
    const single = await resolve({ srcUrl: master(A, 2), pageUrl: card, linkUrl: original(A, 2), allowPostMedia: true });
    assert(!single.pixivPostMedia && single.primaryUrl === original(A, 2), 'default: the opened image saves only its page (' + (single.primaryUrl || single.error) + ')');
    // a menu click (Chrome builds its info; nothing of the page reaches it) is not an inline request, whatever fields it carries
    await p.s.onContextMenuClicked({ menuItemId: 'save-image-item', srcUrl: thumb(A), pageUrl: FEED, linkUrl: card, mediaType: 'image', frameId: 0, pixivInline: { mode: 'one', count: 0, documentId: 'doc-1' } }, { id: 1, url: FEED });
    assert(seen.length >= 1 && seen.every((a) => a.pixivInline === undefined), "the explicit mode is set only for the worker's own inline request");
    // and the strict inline entry exists only for it: a mode in the resolver's arguments is honoured, a missing one never falls back to the other scope
    for (const bad of [{ mode: 'both' }, { mode: 'one' }, {}]) {
      const r = await resolve({ srcUrl: thumb(A), pageUrl: FEED, linkUrl: '', allowPostMedia: true, pixivInline: bad });
      assert.equal(r.error, 'POST_MEDIA_MISMATCH', JSON.stringify(bad) + ': a preview without its own link is no owner');
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
