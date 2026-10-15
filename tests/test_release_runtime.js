// Offline release regressions for prefetched body limits and signed-URL logging.
const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const CAP = 50 * 1024 * 1024;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x6d, 0x70, 0x34, 0x31, 0x6d, 0x70, 0x34, 0x32]);
const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const background = ['background.js', 'worker/media_format.js', 'worker/providers.js', 'worker/pipeline.js']
  .map(read).join('\n');
const offscreen = require('./helpers/offscreen.cjs').source();
const redgifs = read('content/content_redgifs.js');
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
    read('lib/media_guard.js'),
    functionSource(background, 'sniffMediaMagicBytes'),
    functionSource(background, 'cancelResponseBody')
  ].join('\n'), sandbox);
  return { sandbox, requests, logs, deadlines, timers, close: () => { for (const t of timers) clearTimeout(t); timers.clear(); } };
}

let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
(async () => {
  // Pixiv originals are no longer fetched into worker memory: see tests/test_pixiv_saving.js (manager staging path).

  for (const [name, config, error] of [
    ['GIF declared input ceiling selects source MP4', { declared: CAP + 1 }, null],
    ['GIF chunked input ceiling', { overflow: true }, /SIZE|budget|limit/i],
    ['GIF streamless input refusal', { stream: false }, /ReadableStream|stream/i]
  ]) await test(name, async () => {
    const fixture = response({ ...config, type: 'video/mp4', bytes: MP4 }), env = environment(fixture);
    try {
      const conversion = env.sandbox.convertXTweetVideoToGif('https://video.twimg.com/tweet_video/clip.mp4?sig=EXACT');
      if (error) await assert.rejects(conversion, error);
      else {
        const decision = await conversion;
        assert.equal(decision.exceedsSize, true);
        assert.equal(decision.action, 'SAVE_DIRECT_MP4');
        assert.equal(decision.sizeKind, 'input');
        assert.equal(decision.sizeBytes, CAP + 1);
        assert.equal(decision.thresholdBytes, CAP);
        assert.equal(decision.blobUrl, undefined);
        assert.equal(fixture.state.reads, 2, 'Only the bounded container prefix and EOF are read');
      }
      assert.equal(fixture.state.buffered, 0, 'No unbounded blob API');
      assert.equal(fixture.state.cancels, config.stream === false ? 0 : 1, 'Reader released when present');
      assert.equal(env.requests[0].options.signal.aborted, true);
      assert.equal(env.timers.size, 0);
    } finally { env.close(); }
  });

  // one implementation (lib/media_guard.js), loaded by both contexts: the worker's global and the offscreen document's global are checked separately
  assert(read('background.js').includes("importScripts('lib/media_guard.js')") && read('offscreen.html').includes('lib/media_guard.js'));
  for (const context of ['background', 'offscreen']) await test(`${context} redaction covers Reddit and signed CDNs`, async () => {
    const env = context === 'offscreen' ? environment(response()) : null;
    const sandbox = env ? env.sandbox : vm.createContext({ URL });
    if (!env) vm.runInContext(read('lib/media_guard.js'), sandbox);
    try {
      const reddit = 'https://v.redd.it/clip/HLSPlaylist.m3u8?a=123,REDDIT_SECRET&v=1';
      assert(!sandbox.sanitizeUrlForLog(reddit).includes('REDDIT_SECRET'));
      for (const key of ['X-Amz-Credential', 'X-Goog-Credential', 'Policy', 'Key-Pair-Id', 'hdnts', 'hdnea']) {
        const url = `https://cdn.example.test/a.jpg?${key}=CDN_SECRET&id=42`;
        const logged = sandbox.sanitizeUrlForLog(url);
        assert(!logged.includes('CDN_SECRET'), key);
        assert(logged.includes('id=42'));
      }
    } finally { if (env) env.close(); }
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
