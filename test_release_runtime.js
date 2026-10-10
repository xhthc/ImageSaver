// Offline release regressions for prefetched body limits and signed-URL logging.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const CAP = 50 * 1024 * 1024;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x6d, 0x70, 0x34, 0x31, 0x6d, 0x70, 0x34, 0x32]);
const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const background = read('background.js');
const offscreen = read('offscreen.js');
const redgifs = read('content_redgifs.js');
const functionSource = (source, name) => {
  const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?^}', 'm'));
  assert(match, `Missing production function ${name}`);
  return match[0];
};

function response({ type = 'image/jpeg', bytes = JPEG, declared, stream = true, overflow = false, stalled = false, status = 200 } = {}) {
  const state = { reads: 0, cancels: 0, buffered: 0 };
  const make = (signal) => ({
    ok: status === 200, status,
    headers: { get: (name) => name === 'content-type' ? type : name === 'content-length' ? (declared === undefined ? null : String(declared)) : null },
    body: stream ? {
      getReader: () => ({
        read: async () => {
          state.reads++;
          if (stalled) return new Promise((_, reject) => {
            const fail = () => reject(signal.reason || new Error('Aborted'));
            if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
          });
          if (overflow) return state.reads <= 51 ? { done: false, value: new Uint8Array(1024 * 1024) } : { done: true };
          return state.reads === 1 ? { done: false, value: bytes } : { done: true };
        },
        cancel: async () => { state.cancels++; }
      }),
      cancel: async () => { state.cancels++; }
    } : null,
    arrayBuffer: async () => {
      state.buffered++;
      if (overflow) throw new Error('UNBOUNDED_ARRAY_BUFFER');
      if (stalled) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    blob: async () => { state.buffered++; return new Blob([bytes], { type }); }
  });
  return { state, make };
}

function environment(fixture) {
  const requests = [], logs = [], deadlines = [], timers = new Set();
  const sandbox = {
    URL, Blob, Uint8Array, ArrayBuffer, AbortController, Buffer,
    console: { log: (...args) => logs.push(args.join(' ')), warn() {}, error() {} },
    gifenc: {},
    setTimeout: (fn, ms) => {
      deadlines.push(ms);
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, Math.min(ms, 20));
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => { timers.delete(timer); clearTimeout(timer); },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return fixture.make(options.signal);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(offscreen, sandbox);
  vm.runInContext([
    functionSource(background, 'sniffMediaMagicBytes'),
    functionSource(background, 'sanitizeUrlForLog'),
    functionSource(background, 'cancelResponseBody'),
    functionSource(background, 'fetchPixivImageAsDataUrl')
  ].join('\n'), sandbox);
  return { sandbox, requests, logs, deadlines, timers, close: () => { for (const t of timers) clearTimeout(t); timers.clear(); } };
}

let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
async function pixivRefusal(name, config, error) {
  await test(name, async () => {
    const fixture = response(config), env = environment(fixture);
    try {
      await assert.rejects(Promise.race([
        env.sandbox.fetchPixivImageAsDataUrl('https://i.pximg.net/a.jpg'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TEST_BODY_STALLED')), 100))
      ]), error);
      assert.equal(fixture.state.buffered, 0, 'No unbounded body API');
      assert.equal(env.requests[0].options.signal.aborted, true, 'Request aborted on exit');
      assert.equal(env.timers.size, 0, 'Deadline released');
    } finally { env.close(); }
  });
}

(async () => {
  for (const [type, bytes] of [['image/jpeg', JPEG], ['image/png', PNG]]) {
    await test(`Pixiv ${type} bytes and request URL survive`, async () => {
      const fixture = response({ type, bytes }), env = environment(fixture);
      const url = 'https://i.pximg.net/a.png?token=PIXIV_SECRET&sig=SIGNATURE';
      try {
        const result = await env.sandbox.fetchPixivImageAsDataUrl(url);
        assert.equal(result, `data:${type};base64,${Buffer.from(bytes).toString('base64')}`);
        assert.equal(env.requests[0].url, url);
        assert.equal(fixture.state.buffered, 0);
        assert.equal(env.requests[0].options.signal.aborted, true);
        assert(!env.logs.join('\n').includes('PIXIV_SECRET'));
        assert(env.deadlines.includes(20000));
      } finally { env.close(); }
    });
  }
  await pixivRefusal('Pixiv rejects HTTP200 HTML', { type: 'text/html', bytes: Buffer.from('<html>Error</html>') }, /MIME|non-image/i);
  await pixivRefusal('Pixiv rejects HTML labelled JPEG', { bytes: Buffer.from('<html>Error</html>') }, /Invalid.*image|non-media/i);
  await pixivRefusal('Pixiv rejects empty body', { bytes: new Uint8Array() }, /empty|Invalid.*image/i);
  await pixivRefusal('Pixiv rejects oversized declared body before reading', { declared: CAP + 1 }, /SIZE|budget|limit/i);
  await pixivRefusal('Pixiv rejects chunked overflow before buffering', { overflow: true }, /SIZE|budget|limit/i);
  await pixivRefusal('Pixiv requires a bounded stream', { stream: false }, /ReadableStream|stream/i);
  await pixivRefusal('Pixiv body keeps the20s deadline', { stalled: true }, /Aborted|abort|TIMEOUT/i);

  for (const [name, config, error] of [
    ['GIF declared input ceiling', { declared: CAP + 1 }, /SIZE|budget|limit/i],
    ['GIF chunked input ceiling', { overflow: true }, /SIZE|budget|limit/i],
    ['GIF streamless input refusal', { stream: false }, /ReadableStream|stream/i]
  ]) await test(name, async () => {
    const fixture = response({ ...config, type: 'video/mp4', bytes: MP4 }), env = environment(fixture);
    try {
      await assert.rejects(env.sandbox.convertXTweetVideoToGif('https://video.twimg.com/tweet_video/clip.mp4?sig=EXACT'), error);
      assert.equal(fixture.state.buffered, 0, 'No unbounded blob API');
      assert.equal(env.requests[0].options.signal.aborted, true);
      assert.equal(env.timers.size, 0);
    } finally { env.close(); }
  });

  for (const source of [background, offscreen]) await test(`${source === background ? 'background' : 'offscreen'} redaction covers Reddit and signed CDNs`, async () => {
    const sandbox = { URL };
    vm.createContext(sandbox);
    vm.runInContext(functionSource(source, 'sanitizeUrlForLog'), sandbox);
    const reddit = 'https://v.redd.it/clip/HLSPlaylist.m3u8?a=123,REDDIT_SECRET&v=1';
    assert(!sandbox.sanitizeUrlForLog(reddit).includes('REDDIT_SECRET'));
    for (const key of ['X-Amz-Credential', 'X-Goog-Credential', 'Policy', 'Key-Pair-Id', 'hdnts', 'hdnea']) {
      const url = `https://cdn.example.test/a.jpg?${key}=CDN_SECRET&id=42`;
      const logged = sandbox.sanitizeUrlForLog(url);
      assert(!logged.includes('CDN_SECRET'), key);
      assert(logged.includes('id=42'));
    }
  });
  for (const [name, config, accepted] of [
    ['bounded JSON', { bytes: Buffer.from('{"token":"example"}') }, true],
    ['declared overflow', { declared: 256 * 1024 + 1 }, false],
    ['chunked overflow', { overflow: true }, false],
    ['no stream', { stream: false }, false],
    ['HTTP error', { status: 403 }, false]
  ]) await test(`RedGIFs provider ${name}`, async () => {
    const fixture = response(config), controller = new AbortController();
    const sandbox = { TextDecoder, Uint8Array, PROVIDER_API: 'https://api.redgifs.com/', PROVIDER_MAX_BYTES: 256 * 1024,
      fetch: async () => fixture.make(controller.signal) };
    vm.createContext(sandbox);
    const fn = redgifs.match(/^  async function providerGet\([^\n]*\) \{[\s\S]*?^  }/m);
    assert(fn); vm.runInContext(fn[0], sandbox);
    const result = await sandbox.providerGet('v2/auth/temporary', '', controller.signal);
    assert.equal(result.ok, accepted);
    assert.equal(fixture.state.buffered, 0);
    if (config.stream !== false) assert(fixture.state.cancels > 0, 'The response is released');
    if (config.overflow) assert.equal(fixture.state.reads, 1, 'Stop at the first overflowing chunk');
  });
  console.log(`${passed}/${passed + failed} release runtime checks passed`);
  process.exitCode = failed ? 1 : 0;
})();
