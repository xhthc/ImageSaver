'use strict';
const assert = require('node:assert/strict');
const { createTestEnv } = require('./test_context_target_avatar');

const cases = [
  { id: '4731293', src: 'https://s3.zerochan.net/240/43/25/4731293.avif', full: 'https://static.zerochan.net/Izayoi.Nonomi.full.4731293.png', size: 2582528 },
  { id: '4730884', src: 'https://s3.zerochan.net/240/34/17/4730884.avif', full: 'https://static.zerochan.net/Silver.Wolf.LV.999.full.4730884.png', size: 14210048 }
];
function fixture(selected, unavailable = false) {
  const env = createTestEnv(), s = env.bgSandbox, calls = [];
  s.console.info = () => {};
  s.resolveContextOwner = async () => 'proven';
  s.fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url.endsWith('?json')) {
      if (unavailable || options.credentials !== 'include') return new Response('Checking browser...', { status: 503 });
      return new Response(JSON.stringify({ id: Number(selected.id), full: selected.full }), { headers: { 'content-type': 'application/json' } });
    }
    if (url === selected.full) return new Response(null, { headers: { 'content-type': selected.full.endsWith('.avif') ? 'image/avif' : 'image/png', 'content-length': String(selected.size) } });
    if (url === selected.src) return new Response(null, { headers: { 'content-type': 'image/avif', 'content-length': '10240' } });
    return new Response(null, { status: 404 });
  };
  return { env, s, calls };
}
(async () => {
  for (const selected of cases) {
    const f = fixture(selected), args = { srcUrl: selected.src, pageUrl: 'https://www.zerochan.net/', linkUrl: 'https://www.zerochan.net/' + selected.id };
    const plan = await f.s.resolveOriginalMediaPlan(args);
    assert.equal(plan.primaryUrl, selected.full, 'Numbered preview resolves the declared PNG using the active site session');
    assert.equal(plan.metadata.contentType, 'image/png');
    assert.equal(plan.metadata.contentLength, selected.size);
    assert.equal(f.calls.filter(x => x.url.endsWith('?json')).length, 1);
    assert.equal(f.calls.find(x => x.url.endsWith('?json')).credentials, 'include');
    await f.s.onContextMenuClicked({ menuItemId: 'save-image-item', ...args, mediaType: 'image', frameId: 0 }, { id: 1, url: args.pageUrl });
    assert.equal(f.env.downloadedCalls.length, 1);
    assert.equal(f.env.downloadedCalls[0].url, selected.full, 'The production handler exports the original URL, never the AVIF preview');
    assert(f.env.downloadedCalls[0].filename.endsWith('.png'));

    const failed = fixture(selected, true);
    assert.equal(await failed.s.resolveOriginalMediaPlan(args), null, 'Unavailable metadata cannot report a preview as a successful original');
    await failed.s.onContextMenuClicked({ menuItemId: 'save-image-item', ...args, frameId: 0 }, { id: 1, url: args.pageUrl });
    assert.equal(failed.env.downloadedCalls.length, 0);
  }
  const original = { ...cases[0], full: 'https://static.zerochan.net/OriginalArt.full.4731293.avif' };
  const genuine = fixture(original, true);
  const plan = await genuine.s.resolveOriginalMediaPlan({ srcUrl: original.full, pageUrl: 'https://www.zerochan.net/4731293' });
  assert.equal(plan.primaryUrl, original.full, 'Genuine original AVIF remains supported');
  assert.equal(plan.metadata.contentType, 'image/avif');
  console.log('PASS: Zerochan session-backed original PNG resolution/export, metadata failure refusal and genuine original AVIF');
})().catch(error => { console.error(error); process.exitCode = 1; });
