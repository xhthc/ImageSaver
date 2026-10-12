'use strict';

// Domain-independent production capture -> background -> Chrome download contracts.
// Reuse the avatar harness; no production resolver/capture logic is copied here.
const assert = require('node:assert/strict');
const { createTestEnv, createMockElement: element, simulateGesture, executeSaveClick } = require('./test_context_target_avatar');

let passed = 0;
let failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name, error); }
}

function fixture(page, source, { direct = false, cssOnly = false, mediaTag = 'img' } = {}) {
  const anchor = element('a', { href: page + '/author', attrs: { role: 'link' } });
  const scope = element('div', { parent: anchor });
  const media = element(cssOnly ? 'div' : mediaTag, { parent: scope, src: cssOnly ? '' : source, bg: cssOnly ? `url("${source}")` : 'none' });
  const decoration = element('div', { parent: scope, bg: `url("${source}")` });
  const overlay = element('div', { parent: scope });
  let stack = cssOnly || mediaTag === 'video' ? [overlay, media, scope, anchor] : [overlay, media, decoration, scope, anchor];
  const target = direct ? media : overlay;
  if (direct) stack = [media, scope, anchor];
  const doc = {
    hidden: false,
    elementsFromPoint: () => stack,
    querySelectorAll: () => [media, anchor],
    querySelector: () => null
  };
  const gesture = simulateGesture(doc, target, { x: 50, y: 50 });
  return { anchor, scope, media, overlay, doc, rec: gesture.rec, changeStack: (next) => { stack = next; } };
}

function network(env, source, mime) {
  env.adapterRequests = [];
  env.mockChrome.tabs.sendMessage = async (...args) => { env.adapterRequests.push(args); return undefined; };
  env.bgSandbox.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    env.fetchedUrls.push(url);
    // Unknown alternatives are observable; they cannot succeed or substitute an asset.
    if (url !== source) return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/html' } });
    const bytes = Buffer.alloc(12000);
    if (mime === 'image/jpeg') bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    if (mime === 'image/png') bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (mime === 'image/gif') bytes.write('GIF89a');
    if (mime === 'video/mp4') { bytes.writeUInt32BE(24); bytes.write('ftypisom', 4); bytes.write('isommp42', 16); }
    if (mime === 'video/webm') bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
    if (mime === 'text/html') bytes.write('<!DOCTYPE html><html>not media</html>');
    return new Response(options.method === 'HEAD' ? null : bytes, { status: 200, headers: { 'Content-Type': mime, 'Content-Length': String(bytes.length) } });
  };
  env.mockChrome.tabs.get = async (id) => ({ id, url: 'https://unfamiliar.example.test/feed' });
}

async function save(env, f, page, frameId = 0, docs = { [frameId]: f.doc }, recs = { [frameId]: f.rec }) {
  return executeSaveClick(env, { docs, recs, frameId, info: { pageUrl: page + '/feed', linkUrl: f.anchor.href } });
}

async function main() {
  for (const mode of ['valid', 'stalled', 'oversized', 'declared oversized', 'malformed', 'no stream', 'HTTP error']) {
    await test(`generic MD5 metadata: ${mode} response stays bounded and cleans up`, async () => {
      const env = createTestEnv();
      const source = 'https://unlisted-cdn.example.test/1234567890abcdef1234567890abcdef.jpg';
      const original = 'https://unlisted-cdn.example.test/data/original/1234567890abcdef1234567890abcdef.png?sig=EXACT%2Bsignature&order=2';
      network(env, source, 'image/jpeg');
      const fallbackFetch = env.bgSandbox.fetch;
      const signals = [], timers = new Set();
      let readCount = 0, cancellations = 0;
      env.bgSandbox.TextDecoder = TextDecoder;
      env.bgSandbox.setTimeout = (fn, ms) => { assert([3000, 3500].includes(ms)); const id = setTimeout(fn, ms === 3000 ? 10 : ms); timers.add(id); return id; };
      env.bgSandbox.clearTimeout = id => { timers.delete(id); clearTimeout(id); };
      env.bgSandbox.fetch = async (url, opts = {}) => {
        if (!url.includes('tags=md5:')) {
          if (url === original) return new Response(null, { headers: { 'Content-Type': 'image/png', 'Content-Length': '50000' } });
          return fallbackFetch(url, opts);
        }
        signals.push(opts.signal);
        let at = 0;
        const chunks = mode === 'oversized'
          ? [new Uint8Array(1024 * 1024).fill(32), new TextEncoder().encode(JSON.stringify([{ file_url: original }]))]
          : [new TextEncoder().encode(mode === 'malformed' ? '{bad JSON' : JSON.stringify([{ file_url: original }]))];
        const reader = {
          read: async () => {
            readCount++;
            if (mode === 'stalled') return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
            return at < chunks.length ? { done: false, value: chunks[at++] } : { done: true };
          },
          cancel: async () => { cancellations++; }
        };
        return {
          ok: mode !== 'HTTP error', headers: new Headers({ ...(mode === 'declared oversized' ? { 'Content-Length': String(1024 * 1024 + 1) } : {}) }),
          body: mode === 'no stream' ? null : { getReader: () => reader, cancel: reader.cancel },
          json: async () => { if (mode === 'stalled') await reader.read(); return [{ file_url: original }]; }
        };
      };
      let finished = false;
      const plan = env.bgSandbox.resolveOriginalMediaPlan({ srcUrl: source, pageUrl: 'https://unfamiliar.example.test/feed', tabId: 1, frameId: 0 }).finally(() => { finished = true; });
      try {
        const result = await Promise.race([plan, new Promise((_, reject) => setTimeout(() => reject(new Error('metadata body did not settle')), 250))]);
        assert.equal(result.primaryUrl, mode === 'valid' ? original : source);
        assert.equal(signals.length, 3);
        assert(signals.every(signal => signal.aborted), 'all transfers abort after reading/refusal');
        assert.equal(timers.size, 0, 'all deadlines cleared');
        assert.equal(cancellations, mode === 'no stream' ? 0 : 3, 'every response stream cancelled');
        if (mode === 'declared oversized' || mode === 'no stream' || mode === 'HTTP error') assert.equal(readCount, 0);
        if (mode === 'oversized') assert.equal(readCount, 6, 'stop as soon as the actual byte limit is crossed');
      } finally {
        if (!finished) { for (const id of timers) clearTimeout(id); }
      }
    });
  }
  // Real worker callers keep their frame/document and execution-world bindings while dispatching before document_idle.
  const schedulingCases = [
    ['open-tab capture', b => b.injectContextTargetIntoOpenTabs(), { tabId: 1, allFrames: true }, ['lib/debug_journal.js', 'content/content_context_target.js', 'content/content_notifications.js']],
    ['selected owner', b => b.resolveContextOwner(1, 3, { src: 'https://cdn.example.test/selected.jpg' }), { tabId: 1, frameIds: [3] }, 'verifyContextOwner'],
    ['selected target', b => b.resolveContextMediaTarget(1, 3), { tabId: 1, frameIds: [3] }, 'readContextMediaTarget'],
    ['frame listener fallback', b => b.resolveFrameLocalMedia({ tabId: 1, frameId: 3, documentId: 'doc-selected', clickedSrc: 'blob:https://www.redgifs.com/selected' }), { tabId: 1, documentIds: ['doc-selected'] }, ['lib/debug_journal.js', 'lib/i18n.js', 'content/content_redgifs.js']],
    ['Reddit listener fallback', b => b.resolveRedditFrameBlobMedia({ tabId: 1, frameId: 3, clickedSrc: 'blob:https://www.reddit.com/selected' }), { tabId: 1, frameIds: [3] }, ['lib/debug_journal.js', 'lib/i18n.js', 'content/content_reddit.js']],
    ['X declared variants', b => b.recoverXPostMp4Variant(1, { isBlobPlayer: true, tweetId: '123' }), { tabId: 1 }, 'extractXPostVideoInMainWorld', 'MAIN'],
    ['generic DOM metadata', b => b.resolveOriginalMediaPlan({ tabId: 1, frameId: 3, srcUrl: 'https://cdn.example.test/selected.jpg', pageUrl: 'https://unlisted.example.test/feed' }), { tabId: 1, frameIds: [3] }, 'extractDomImageMetadata'],
    ['X listener fallback', b => b.onContextMenuClicked({ menuItemId: 'save-x-media-item', pageUrl: 'https://x.com/home' }, { id: 1, url: 'https://x.com/home' }), { tabId: 1 }, ['lib/debug_journal.js', 'lib/i18n.js', 'content/content_x.js']],
    ['embed frame address', b => b.redditInlineFindRedGifsFrame(1, { frameId: 0 }, 'wildcheetah'), { tabId: 1, allFrames: true }, 'func']
  ];
  for (const [name, run, target, entry, world] of schedulingCases) {
    await test(`immediate injection: ${name}`, async () => {
      const env = createTestEnv();
      const calls = [];
      env.mockChrome.tabs.sendMessage = async () => { throw new Error('No content listener'); };
      env.mockChrome.scripting.executeScript = async opts => { calls.push(opts); return [{ result: null }]; };
      await run(env.bgSandbox);
      assert.equal(calls.length, 1, 'the actual worker path reaches one injection');
      assert.equal(calls[0].injectImmediately, true, 'a loading document must not defer this request until document_idle');
      assert.deepEqual(JSON.parse(JSON.stringify(calls[0].target)), target);
      assert.equal(calls[0].world, world);
      if (Array.isArray(entry)) assert.deepEqual(Array.from(calls[0].files), entry);
      else assert.equal(calls[0].func.name, entry);
      assert.equal(env.downloadedCalls.length, 0, 'an empty injected answer must not authorize a download');
    });
  }

  for (const page of ['https://unfamiliar.example.test', 'https://another-unlisted.example.test']) {
    for (const [ext, mime] of [['jpg', 'image/jpeg'], ['png', 'image/png'], ['gif', 'image/gif']]) {
      await test(`${new URL(page).host}: overlay-selected ${ext} retains exact signed URL and format`, async () => {
        const env = createTestEnv();
        const source = `https://unlisted-cdn.example.test/media/selected.${ext}?token=synthetic%2Btoken&expires=123456&order=2`;
        const f = fixture(page, source);
        network(env, source, mime);
        const calls = await save(env, f, page);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, source);
        assert.match(calls[0].filename, new RegExp('\\.' + ext + '$'));
        assert(calls.every((call) => call.url !== f.anchor.href), 'an unverified navigation alternative must not become the saved media');
      });
    }
  }

  await test('direct IMG without Chrome srcUrl uses currentSrc rather than responsive src fallback', async () => {
    const env = createTestEnv();
    const page = 'https://responsive.example.test';
    const source = 'https://cdn.example.test/selected-large.png?token=SYNTHETIC';
    const f = fixture(page, source, { direct: true });
    f.media.src = 'https://cdn.example.test/small.png';
    f.rec = simulateGesture(f.doc, f.media).rec;
    network(env, source, 'image/png');
    const calls = await save(env, f, page);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, source);
    assert(!env.fetchedUrls.includes(f.media.src), 'do not substitute the responsive fallback');
  });

  await test('CSS-only selected image saves without an IMG or site adapter', async () => {
    const env = createTestEnv();
    const page = 'https://css.example.test';
    const source = 'https://cdn.example.test/css-picture.png?token=SYNTHETIC';
    const f = fixture(page, source, { cssOnly: true });
    network(env, source, 'image/png');
    const calls = await save(env, f, page);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, source);
  });

  await test('extensionless PNG source is selected by its verified MIME and gets .png', async () => {
    const env = createTestEnv();
    const page = 'https://extensionless.example.test';
    const source = 'https://cdn.example.test/asset?token=SYNTHETIC';
    const f = fixture(page, source);
    network(env, source, 'image/png');
    const calls = await save(env, f, page);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, source);
    assert.match(calls[0].filename, /\.png$/);
  });

  for (const [ext, mime] of [['mp4', 'video/mp4'], ['webm', 'video/webm']]) {
    await test(`generic overlay-selected ${ext} downloads the exact video source in its native format`, async () => {
      const env = createTestEnv();
      const page = 'https://videos.example.test';
      const source = `https://cdn.example.test/selected-video.${ext}?token=SYNTHETIC`;
      const f = fixture(page, source, { mediaTag: 'video' });
      network(env, source, mime);
      const calls = await save(env, f, page);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, source);
      assert.match(calls[0].filename, new RegExp('\\.' + ext + '$'));
    });
  }

  for (const mutation of ['currentSrc', 'signed query', 'detached', 'replaced node', 'covered', 'reparented']) {
    await test(`surviving overlay with ${mutation} refuses before any request/download`, async () => {
      const env = createTestEnv();
      const page = 'https://stale.example.test';
      const source = 'https://cdn.example.test/captured.jpg?token=ONE';
      const f = fixture(page, source);
      assert(f.rec.media && f.rec.media.check(), 'unchanged capture is proven first');
      network(env, source, 'image/jpeg');
      if (mutation === 'currentSrc') f.media.currentSrc = 'https://cdn.example.test/foreign.jpg';
      if (mutation === 'signed query') f.media.currentSrc = source.replace('ONE', 'TWO');
      if (mutation === 'detached') f.media.isConnected = false;
      if (mutation === 'reparented') f.media.parentElement = element('div');
      if (mutation === 'covered') f.changeStack([element('div'), f.scope, f.anchor]);
      if (mutation === 'replaced node') {
        f.media.isConnected = false;
        const replacement = element('img', { parent: f.scope, src: source });
        f.changeStack([f.overlay, replacement, f.scope, f.anchor]);
        f.doc.querySelectorAll = () => [replacement, f.anchor];
      }
      const calls = await save(env, f, page);
      assert.equal(calls.length, 0);
      assert.equal(env.fetchedUrls.length, 0, 'fail at common admission, before generic discovery/probing');
      assert.equal(env.adapterRequests.length, 0, 'do not ask a provider to recover a stale target');
    });
  }

  await test('frame 5 saves its own selected image, ignoring frame 0 capture', async () => {
    const env = createTestEnv();
    const page = 'https://frames.example.test';
    const own = 'https://cdn.example.test/frame-five.jpg?token=FIVE';
    const foreign = 'https://cdn.example.test/frame-zero.jpg?token=ZERO';
    const f = fixture(page, own);
    const outside = fixture(page, foreign);
    network(env, own, 'image/jpeg');
    const calls = await save(env, f, page, 5, { 0: outside.doc, 5: f.doc }, { 0: outside.rec, 5: f.rec });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, own);
    assert(!env.fetchedUrls.includes(foreign));
  });

  await test('frame 5 with no gesture never borrows frame 0 capture', async () => {
    const env = createTestEnv();
    const page = 'https://frames.example.test';
    const source = 'https://cdn.example.test/frame-zero.jpg';
    const f = fixture(page, source);
    network(env, source, 'image/jpeg');
    const calls = await save(env, f, page, 5, { 0: f.doc, 5: f.doc }, { 0: f.rec, 5: null });
    assert.equal(calls.length, 0);
    assert.equal(env.fetchedUrls.length, 0);
    assert.equal(env.adapterRequests.length, 0);
  });

  for (const mime of ['text/html', 'application/json']) await test(`HTTP 200 ${mime} at the selected JPG URL is refused rather than saved`, async () => {
    const env = createTestEnv();
    const page = 'https://mime.example.test';
    const source = 'https://cdn.example.test/looks-like-an-image.jpg';
    const f = fixture(page, source);
    network(env, source, 'text/html');
    const calls = await save(env, f, page);
    assert.equal(calls.length, 0);
    assert(env.fetchedUrls.includes(source), 'selected source was actually probed');
  });

  // ---- CLAUDE-RESUME-04: a player that has not been played (readyState 0, currentSrc empty), so Chrome's menu carries no source ----
  // The player's own declaration is the selection: its src attribute, or the first own <source> the browser's resource selection would take.
  // Nothing is played or loaded to find it; a re-sourced, detached, blob or manifest-only player is never saved generically.
  const unplayed = (page, { src = '', sources = [], overlay = false } = {}) => {
    const anchor = element('a', { href: page + '/watch', attrs: { role: 'link' } });
    const scope = element('div', { parent: anchor });
    const video = element('video', { parent: scope, attrs: src ? { src } : {} });
    video.src = src;
    video.currentSrc = '';
    video.readyState = 0;
    video.calls = [];
    video.play = () => { video.calls.push('play'); return Promise.resolve(); };
    video.load = () => { video.calls.push('load'); };
    video.canPlayType = (type) => (/^video\/(mp4|webm)/.test(type) ? 'probably' : '');
    const kids = sources.map((s) => { const el = element('source', { parent: video, attrs: { src: s.src, ...(s.type ? { type: s.type } : {}) } }); el.src = s.src; return el; });
    video.querySelectorAll = (sel) => (sel === 'source' ? kids : []);
    const cover = element('div', { parent: scope });
    const stack = overlay ? [cover, video, scope, anchor] : [video, scope, anchor];
    const doc = { hidden: false, elementsFromPoint: () => stack, querySelectorAll: () => [video, anchor], querySelector: () => null };
    const rec = simulateGesture(doc, overlay ? cover : video, { x: 50, y: 50 }).rec;
    return { anchor, scope, media: video, overlay: cover, doc, rec, video, kids };
  };

  await test('unplayed player (currentSrc empty) with a src attribute: saves exactly that source on the first save, without play()/load()', async () => {
    const env = createTestEnv();
    const page = 'https://preplay.example.test';
    const source = 'https://cdn.example.test/clip.mp4?token=SYNTHETIC&exp=1';
    const f = unplayed(page, { src: source });
    network(env, source, 'video/mp4');
    const calls = await save(env, f, page);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, source);
    assert.match(calls[0].filename, /\.mp4$/);
    assert.deepEqual(f.video.calls, [], 'never played or loaded');
  });

  for (const overlay of [false, true]) {
    await test(`unplayed player with only <source> children${overlay ? ' under a covering layer' : ''}: the first playable declared source is saved`, async () => {
      const env = createTestEnv();
      const page = 'https://preplay-sources.example.test';
      const skipped = 'https://cdn.example.test/clip.unplayable';
      const source = 'https://cdn.example.test/clip.webm?sig=SYNTHETIC';
      const f = unplayed(page, { sources: [{ src: skipped, type: 'video/x-unplayable' }, { src: source, type: 'video/webm' }, { src: 'https://cdn.example.test/later.mp4', type: 'video/mp4' }], overlay });
      network(env, source, 'video/webm');
      const calls = await save(env, f, page);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, source);
      assert(!env.fetchedUrls.includes(skipped) && !env.fetchedUrls.includes('https://cdn.example.test/later.mp4'), 'only the selected source is requested');
      assert.deepEqual(f.video.calls, [], 'never played or loaded');
    });
  }

  for (const change of ['re-sourced', 'detached', 'reparented']) {
    await test(`unplayed <source> player ${change} after the gesture is refused before any request`, async () => {
      const env = createTestEnv();
      const page = 'https://preplay-stale.example.test';
      const source = 'https://cdn.example.test/clip.mp4';
      const f = unplayed(page, { sources: [{ src: source, type: 'video/mp4' }] });
      assert(f.rec.media && f.rec.media.check(), 'the capture is proven first');
      network(env, source, 'video/mp4');
      if (change === 're-sourced') { f.kids[0].src = 'https://cdn.example.test/other.mp4'; f.kids[0]._attrs.src = f.kids[0].src; }
      if (change === 'detached') f.video.isConnected = false;
      if (change === 'reparented') f.video.parentElement = element('div');
      const calls = await save(env, f, page);
      assert.equal(calls.length, 0);
      assert.equal(env.fetchedUrls.length, 0);
    });
  }

  for (const [label, opts] of [['a blob: source (MSE)', { src: 'blob:https://preplay.example.test/abc' }], ['only a manifest <source>', { sources: [{ src: 'https://cdn.example.test/master.m3u8', type: '' }] }], ['no source at all', {}]]) {
    await test(`unplayed player with ${label}: nothing is guessed or saved generically`, async () => {
      const env = createTestEnv();
      const page = 'https://preplay-none.example.test';
      const f = unplayed(page, opts);
      network(env, 'https://cdn.example.test/never', 'video/mp4');
      const calls = await save(env, f, page);
      assert.equal(calls.length, 0);
      assert.equal(env.fetchedUrls.length, 0, 'no request for an undeclared or stream source');
      assert.deepEqual(f.video.calls, []);
    });
  }

  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
