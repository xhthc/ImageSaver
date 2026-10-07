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

  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
