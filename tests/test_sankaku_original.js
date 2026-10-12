'use strict';

// Actual DOMParser + production injected reader/resolver. Needs the existing UI dev dependencies; no live site or native Chrome acceptance.
const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(require('node:path').join(REPO_ROOT, 'ui/package.json'))('jsdom');
const { createTestEnv } = require('./test_context_target_avatar');

const ID = '60rvBvKNPr3';
const HASH = '96ff39f4efbc327c9e603b094e760c7f';
const POST = `https://chan.sankakucomplex.com/ru/posts/${ID}`;
const FEED = 'https://chan.sankakucomplex.com/ru/';
const PREVIEW = `https://v.sankakucomplex.com/data/preview/96/ff/${HASH}.avif?e=123&m=PREVIEW`;
const original = (ext = 'jpg') => `https://s.sankakucomplex.com/data/96/ff/${HASH}.${ext}?e=456&m=SIGNED%2Bvalue&order=2`;
const esc = s => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const card = (source = PREVIEW, post = POST) => `<div class="post-preview-container"><a class="post-preview-link" href="${post}"><picture><img src="${esc(source)}"></picture></a></div>`;
const postHtml = (url = original(), id = ID) => `<h2 id="page-title"><a href="/">Sankaku</a>/<a href="https://chan.sankakucomplex.com/ru/posts/${id}">Post</a></h2><div id="post-view"><div id="stats"><a id="highres" itemprop="contentUrl" href="${esc(url)}">Original</a></div><div id="post-content"><img id="image" src="${esc(PREVIEW)}"></div></div>`;

function setup({ page = FEED, html = card(), declaration = postHtml(), ext = 'jpg', mime = 'image/jpeg', postStatus = 200, mediaStatus = 200, redirected = false, mutate, responseType = 'text/html', chunks, contentLength, delayAt, delayMs = 12000, networkError, clock } = {}) {
  const env = createTestEnv();
  const dom = new JSDOM(html, { url: page });
  const requests = [], injections = [], signals = [], failures = [], events = [];
  env.bgSandbox.sankakuFailures = failures; env.bgSandbox.sankakuEvents = events;
  vm.runInContext('fbFail = async (op, info) => sankakuFailures.push(info); dbg = (comp, act, out, why, d) => sankakuEvents.push({ comp, act, out, why, d: typeof d === "function" ? d() : d });', env.bgContext);
  let cancellations = 0;
  const source = dom.window.document.querySelector('img').src;
  const expected = original(ext);
  const pageFetch = async (url, options) => {
    requests.push({ url, options }); signals.push(options.signal);
    const delay = () => new Promise((resolve, reject) => {
      const timer = clock.setTimeout(resolve, delayMs);
      options.signal.addEventListener('abort', () => { clock.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once:true });
    });
    if (delayAt === 'headers') await delay();
    if (networkError) throw new TypeError('Private request failed?token=SECRET');
    if (mutate) mutate(dom.window.document);
    const data = chunks || [new TextEncoder().encode(declaration)];
    let i = 0;
    return { url: POST, ok: postStatus === 200, status: postStatus, redirected, type: redirected ? 'opaqueredirect' : 'basic', headers: new Headers({ 'content-type': responseType, ...(contentLength ? { 'content-length': String(contentLength) } : {}) }), body: {
      getReader: () => ({ read: async () => { if (delayAt === 'body' && i === 0) await delay(); return i < data.length ? { done: false, value: data[i++] } : { done:true }; }, cancel: async () => { cancellations++; } }),
      cancel: async () => { cancellations++; }
    } };
  };
  env.mockChrome.scripting.executeScript = async options => {
    injections.push(options);
    if (options.func.name !== 'readSankakuOriginal') return [];
    const world = vm.createContext({ document: dom.window.document, location: dom.window.location, DOMParser: dom.window.DOMParser, URL, AbortController, Uint8Array, TextDecoder, setTimeout, clearTimeout, ...(clock || {}), fetch: pageFetch, args: options.args });
    return [{ result: await vm.runInContext(`(${options.func.toString()})(...args)`, world) }];
  };
  env.bgSandbox.fetch = async (url, options) => {
    env.fetchedUrls.push(url);
    assert.equal(url, expected, 'probe only the declared exact original; no transformed URLs or preview');
    assert.equal(options.method, 'HEAD');
    return new Response(null, { status: mediaStatus, headers: { 'content-type': mime, 'content-length': '1919486' } });
  };
  const plan = () => vm.runInContext('resolveOriginalMediaPlan', env.bgContext)({ srcUrl: source, pageUrl: page, linkUrl: POST, tabId: 17, frameId: 3 });
  const save = () => env.mockChrome.contextMenus._handler({ menuItemId: 'save-image-item', srcUrl: source, pageUrl: page, linkUrl: POST, frameId: 3 }, { id: 17, url: page });
  return { env, dom, requests, injections, signals, failures, events, plan, save, source, expected, get cancellations() { return cancellations; } };
}

function manualClock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: key => timers.delete(key),
    advance: async ms => { now += ms; for (const [key, timer] of timers) if (timer.at <= now) { timers.delete(key); timer.fn(); } await new Promise(setImmediate); },
    get pending() { return timers.size; }
  };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
(async () => {
  for (const [ext, mime] of [['jpg','image/jpeg'], ['png','image/png'], ['gif','image/gif'], ['avif','image/avif'], ['mp4','video/mp4'], ['webm','video/webm']]) {
    await test(`feed AVIF preview -> declared ${ext}, exact signature and real format`, async () => {
      const h = setup({ ext, mime, declaration: postHtml(original(ext)) });
      const p = await h.plan();
      assert.equal(p.primaryUrl, h.expected); assert.equal(p.provider, 'sankaku'); assert.equal(p.tier, 'original');
      assert.equal(p.metadata.contentType, mime); assert.equal(p.metadata.verified, true);
      assert.equal(p.metadata.contentLength, 1919486);
      assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, POST);
      assert.equal(h.requests[0].options.credentials, 'same-origin'); assert.equal(h.requests[0].options.redirect, 'manual');
      assert.deepEqual(JSON.parse(JSON.stringify(h.injections[0].target)), { tabId: 17, frameIds: [3] });
      assert.equal(h.injections[0].injectImmediately, true); assert.equal(h.injections[0].world, undefined);
      assert.equal(h.signals[0].aborted, true); assert.equal(h.cancellations, 1);
    });
  }
  for (const [ext, mime] of [['jpg','image/jpeg'], ['gif','image/gif'], ['mp4','video/mp4']]) {
    await test(`real context handler downloads selected original ${ext}, never the preview`, async () => {
      const h = setup({ ext, mime, declaration: postHtml(original(ext)) });
      await h.save();
      assert.equal(h.env.downloadedCalls.length, 1);
      assert.equal(h.env.downloadedCalls[0].url, h.expected);
      assert.match(h.env.downloadedCalls[0].filename, new RegExp('\\.' + ext + '$'));
    });
  }
  await test('sample on its own post uses current DOM without a request', async () => {
    const sample = PREVIEW.replace('/preview/', '/sample/').replace(`${HASH}.avif`, `sample-${HASH}.webp`);
    const h = setup({ page: POST, html: postHtml().replaceAll(esc(PREVIEW), esc(sample)) });
    assert.equal((await h.plan()).primaryUrl, h.expected); assert.equal(h.requests.length, 0);
  });
  await test('recommendation inside another post resolves its own linked post', async () => {
    const h = setup({ page: 'https://chan.sankakucomplex.com/ru/posts/09az5jkleMk' });
    assert.equal((await h.plan()).primaryUrl, h.expected); assert.equal(h.requests.length, 1);
  });
  for (const [name, declaration] of [
    ['foreign hash', postHtml(original().replace(HASH, '96ff1111111111111111111111111111'))],
    ['foreign host', postHtml(original().replace('s.sankakucomplex.com', 's.sankakucomplex.com.evil.test'))],
    ['preview as original', postHtml(PREVIEW)],
    ['another post identity', postHtml(original(), '09az5jkleMk')],
    ['duplicate original declaration', postHtml().replace('</div><div id="post-content">', `<a id="highres" itemprop="contentUrl" href="${esc(original())}"></a></div><div id="post-content">`)],
    ['login page', '<form>Log in</form>'],
    ['credentials in URL', postHtml(original().replace('https://', 'https://user:secret@'))],
    ['foreign port', postHtml(original().replace('.com/data/', '.com:8443/data/'))]
  ]) {
    await test(name + ' refuses; no CDN probes or download', async () => {
      const h = setup({ declaration }); assert.equal(await h.plan(), null); assert.equal(h.env.fetchedUrls.length, 0); assert.equal(h.env.downloadedCalls.length, 0);
    });
  }
  await test('duplicate selected preview is ambiguous before any request', async () => {
    const h = setup({ html: card() + card() }); assert.equal(await h.plan(), null); assert.equal(h.requests.length, 0);
  });
  for (const [name, mutate] of [
    ['changed image', doc => { doc.querySelector('img').src = PREVIEW + 'changed'; }],
    ['detached card', doc => { doc.querySelector('a').remove(); }],
    ['relinked card', doc => { doc.querySelector('a').href = '/ru/posts/09az5jkleMk'; }]
  ]) await test(name + ' during fetch refuses before probing', async () => {
    const h = setup({ mutate }); assert.equal(await h.plan(), null); assert.equal(h.env.fetchedUrls.length, 0);
  });
  for (const status of [401,403,404,410,429]) {
    await test('post HTTP ' + status + ' reported without preview fallback', async () => {
      const h = setup({ postStatus: status }); const p = await h.plan(); assert.equal(p._verificationStatus, status); assert(p.error); assert.equal(h.env.fetchedUrls.length, 0); assert.equal(h.signals[0].aborted, true); assert.equal(h.cancellations, 1);
    });
    await test('original HTTP ' + status + ' stops actual save', async () => {
      const h = setup({ mediaStatus: status });
      // The shared probe retries 403 with one bounded Range GET.
      h.env.bgSandbox.fetch = async url => { h.env.fetchedUrls.push(url); assert.equal(url, h.expected); return new Response(null, { status }); };
      await h.save(); assert.equal(h.env.downloadedCalls.length, 0);
      assert(h.env.fetchedUrls.length > 0 && h.env.fetchedUrls.every(url => url === h.expected), 'only the exact declared original may be probed');
    });
  }
  await test('login redirect returns AUTH_REQUIRED and aborts the transfer', async () => {
    const h = setup({ redirected: true }); assert.equal((await h.plan()).error, 'AUTH_REQUIRED'); assert.equal(h.signals[0].aborted, true); assert.equal(h.env.fetchedUrls.length, 0);
  });
  for (const options of [{ contentLength: 1024*1024+1 }, { chunks: [new Uint8Array(1024*1024), new Uint8Array(1)] }, { responseType:'application/json' }]) {
    await test('bounded HTML response refusal cleans up the reader/request', async () => {
      const h=setup(options); assert.equal(await h.plan(), null); assert.equal(h.env.fetchedUrls.length, 0); assert.equal(h.cancellations, 1); assert.equal(h.signals[0].aborted, true);
    });
  }
  await test('HTML at the declared media URL refuses without preview fallback', async () => {
    const h = setup({ mime:'text/html' }); await h.save(); assert.equal(h.env.downloadedCalls.length, 0);
  });
  await test('a direct original keeps the generic exact-source save path', async () => {
    const h=setup({ html:card(original()) }); await h.save(); assert.equal(h.requests.length, 0); assert.equal(h.env.downloadedCalls[0].url, h.expected);
  });
  for (const delayAt of ['headers', 'body']) await test(`12-second ${delayAt} response saves with one request, without a repeat click`, async () => {
    const clock = manualClock(), h = setup({ clock, delayAt });
    const saving = h.save(); await new Promise(setImmediate);
    await clock.advance(9000); assert.equal(h.signals[0].aborted, false, 'a slow response survives the old 8-second deadline');
    await clock.advance(3000); await saving;
    assert.equal(h.env.downloadedCalls[0].url, h.expected); assert.equal(h.requests.length, 1); assert.equal(clock.pending, 0);
  });
  for (const delayAt of ['headers', 'body']) await test(`hung ${delayAt} stops at 20 seconds with network feedback and debug, never a preview`, async () => {
    const clock = manualClock(), h = setup({ clock, delayAt, delayMs:60000 });
    const saving = h.save(); await new Promise(setImmediate); await clock.advance(20000); await saving;
    assert.equal(h.failures[0].code, 'NETWORK_TIMEOUT'); assert.equal(h.failures[0].stage, 'resolve');
    assert.equal(h.events.find(e => e.comp === 'sankaku').why, 'NETWORK_TIMEOUT');
    assert.equal(h.env.downloadedCalls.length, 0); assert.equal(h.env.fetchedUrls.length, 0); assert.equal(clock.pending, 0);
  });
  await test('metadata network failure retains its code without raw errors or signed addresses', async () => {
    const h = setup({ networkError:true }); await h.save();
    assert.equal(h.failures[0].code, 'NETWORK_ERROR'); assert.equal(h.env.downloadedCalls.length, 0);
    const event = h.events.find(e => e.comp === 'sankaku'); assert.equal(event.why, 'NETWORK_ERROR');
    const clean = h.env.bgSandbox.ImageSaverDebug.sanitizeEvent({ ...event, t:Date.now(), src:'worker' });
    assert(clean); assert(!JSON.stringify(clean).match(/SECRET|SIGNED|PREVIEW|sankakucomplex/));
  });
  console.log(`${passed}/${passed} Sankaku checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
