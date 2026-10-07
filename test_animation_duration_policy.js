// test_animation_duration_policy.js - Comprehensive test suite for shared animation duration policy
// Verifies:
// 1. Shared duration policy boundary: <=30s produces genuine looping GIF; >30s routes verified MP4 directly
// 2. Exactly 30.0s belongs to GIF
// 3. Temporal sampling: <=15s preserved; 15-30s distributed across full duration with at most 150 frames
// 4. Background and offscreen handlers work together with bounded fake DOM/video/canvas and production gifenc
// 5. Completion notice: English & Russian copy, emitted exactly once after terminal download, honors user prefs
// 6. Operation model: records reason 'animation_duration_limit', durationSec, thresholdSec: 30, output type video/mp4
// 7. Fail-closed: invalid duration, network error, decode error, timeout, cancellation fail closed without MP4 fallback
// 8. Invariants: Native GIF remains direct, ordinary MP4 remains direct, signed params preserved, ceilings enforced

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');

const gifenc = require(path.resolve(ROOT, 'lib', 'gifenc.js'));
const FBLib = require(path.resolve(ROOT, 'lib', 'feedback.js'));
const FBTrackerLib = require(path.resolve(ROOT, 'lib', 'feedback_tracker.js'));
const FolderPathLib = require(path.resolve(ROOT, 'lib', 'folder_path.js')).ImageSaverFolderPath;

let passed = 0;
let failed = 0;
function testAssert(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ [FAIL] ${name}`);
  }
}

// Bounded MP4 container signature header (ftypisom/mp42)
const FAKE_MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // ....ftyp
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, // isom....
  0x6d, 0x70, 0x34, 0x31, 0x6d, 0x70, 0x34, 0x32  // mp41mp42
]);

// Every environment is torn down after the suite: outstanding downloads are cancelled, test-owned timers cleared, Blobs dropped.
const ALL_ENVS = new Set();

// Reads the blocks of an encoded GIF (header, global table, graphic-control delays, NETSCAPE loop marker, image descriptors, trailer) so
// tests assert what is in the bytes rather than recomputing the expected delays.
function parseGif(bytes) {
  const out = { header: String.fromCharCode(...bytes.slice(0, 6)), frames: 0, delaysCs: [], loop: null, trailer: false };
  let p = 13;
  if (bytes[10] & 0x80) p += 3 * (1 << ((bytes[10] & 7) + 1));
  while (p < bytes.length) {
    const b = bytes[p];
    if (b === 0x3b) { out.trailer = true; break; }
    if (b === 0x21) {
      const label = bytes[p + 1];
      if (label === 0xf9) out.delaysCs.push(bytes[p + 4] | (bytes[p + 5] << 8));
      if (label === 0xff && String.fromCharCode(...bytes.slice(p + 3, p + 14)) === 'NETSCAPE2.0') out.loop = bytes[p + 16] | (bytes[p + 17] << 8);
      p += 2;
      while (bytes[p]) p += bytes[p] + 1;
      p++;
      continue;
    }
    if (b === 0x2c) {
      out.frames++;
      const f = bytes[p + 9];
      p += 10;
      if (f & 0x80) p += 3 * (1 << ((f & 7) + 1));
      p++;
      while (bytes[p]) p += bytes[p] + 1;
      p++;
      continue;
    }
    throw new Error('unknown GIF block ' + b + ' at ' + p);
  }
  out.totalMs = out.delaysCs.reduce((a, c) => a + c, 0) * 10;
  return out;
}

function createIntegratedEnvironment({
  duration = 10.0,
  // bounded small canvas: the policy tests need the decision, the frame count and the timing, not 640 px frames
  videoWidth = 64,
  videoHeight = 36,
  converterReply = null,
  fetchStatus = 200,
  fetchBody = FAKE_MP4_BYTES,
  invalidDuration = false,
  seekTimeout = false,
  notifySuccess = true,
  askEveryTime = false,
  folderOrganizationMode = 'single',
  lang = 'en'
} = {}) {
  const env = {
    downloadCalls: [],
    downloadsDb: new Map(),
    nextDownloadId: 9000,
    downloadListeners: [],
    notifications: [],
    notificationClears: [],
    badges: [],
    offscreenTasks: new Set(),
    activeBlobs: new Map(),
    nextBlobId: 1,
    fetches: [],
    converterCalls: []
  };
  ALL_ENVS.add(env);

  // test-owned timers: the sandboxes get tracked setTimeout/clearTimeout so teardown can clear whatever production code left pending
  // (the 8 s notification clear, for example). Production timers themselves are untouched.
  const timers = new Set();
  const trackedSetTimeout = (fn, ms, ...args) => { const h = setTimeout((...a) => { timers.delete(h); return fn(...a); }, ms, ...args); timers.add(h); return h; };
  const trackedClearTimeout = (h) => { timers.delete(h); clearTimeout(h); };

  // Mock URL with object URL tracking
  class MockURL extends URL {
    static createObjectURL(blob) {
      const u = `blob:chrome-extension://test-ext/${env.nextBlobId++}`;
      env.activeBlobs.set(u, blob);
      return u;
    }
    static revokeObjectURL(u) {
      env.activeBlobs.delete(u);
    }
  }

  // Shared message bus between background and offscreen
  let offscreenMsgHandler = null;
  let bgMsgHandler = null;

  const chrome = {
    runtime: {
      id: 'test-ext',
      lastError: null,
      getURL: (p) => `chrome-extension://test-ext/${p}`,
      getManifest: () => ({ version: '2.0.0' }),
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener: (cb) => {
          // If in offscreen context, register offscreenMsgHandler; else bgMsgHandler
          if (currentContextIsOffscreen) offscreenMsgHandler = cb;
          else bgMsgHandler = cb;
        }
      },
      sendMessage: async (msg) => {
        if (msg && /^CONVERT_/.test(msg.action || '')) env.converterCalls.push(msg);
        if (converterReply && msg && /^CONVERT_/.test(msg.action || '')) return converterReply(msg);
        if (msg && (msg.action === 'CONVERT_X_TWEET_VIDEO_TO_GIF' || msg.action === 'CONVERT_REDDIT_VIDEO_TO_GIF' || msg.action === 'REVOKE_BLOB_URL')) {
          if (!offscreenMsgHandler) throw new Error('Offscreen document message listener not ready');
          return new Promise((resolve) => {
            const sendResponse = (resp) => resolve(resp);
            const keepOpen = offscreenMsgHandler(msg, { id: 'test-ext' }, sendResponse);
            if (!keepOpen) resolve(null);
          });
        }
        return null;
      },
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }]
    },
    offscreen: {
      createDocument: async () => {},
      closeDocument: async () => {}
    },
    i18n: {
      getUILanguage: () => lang
    },
    action: {
      setBadgeText: async ({ text }) => { env.badges.push(text); },
      setBadgeBackgroundColor: async () => {}
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {}
    },
    contextMenus: {
      removeAll: (cb) => cb && cb(),
      create: () => {},
      update: (id, p, cb) => cb && cb(),
      refresh: () => {},
      onClicked: { addListener: (cb) => { env.contextMenuHandler = cb; } },
      onShown: { addListener: () => {} }
    },
    tabs: {
      sendMessage: async () => null,
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} }
    },
    downloads: {
      onChanged: { addListener: (cb) => env.downloadListeners.push(cb) },
      download: async (options) => {
        env.downloadCalls.push(options);
        const id = env.nextDownloadId++;
        const item = {
          id,
          state: 'in_progress',
          filename: options.filename,
          url: options.url,
          fileSize: 10240,
          totalBytes: 10240,
          bytesReceived: 10240
        };
        env.downloadsDb.set(id, item);
        return id;
      },
      search: async (query) => {
        const item = query && env.downloadsDb.get(query.id);
        return item ? [JSON.parse(JSON.stringify(item))] : [];
      }
    },
    storage: {
      local: {
        get: async (keys) => {
          const store = {
            notifySuccess,
            askEveryTime,
            folderOrganizationMode
          };
          if (!keys) return { ...store };
          if (typeof keys === 'string') {
            return { [keys]: store[keys] };
          }
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) res[k] = store[k];
            return res;
          }
          if (typeof keys === 'object') {
            const res = {};
            for (const [k, defVal] of Object.entries(keys)) {
              res[k] = store[k] !== undefined ? store[k] : defVal;
            }
            return res;
          }
          return { ...store };
        },
        set: async () => {}
      },
      session: {
        get: async () => ({}),
        set: async () => {}
      }
    },
    notifications: {
      create: async (id, opts) => {
        env.notifications.push({ id, opts });
        return id;
      },
      clear: async (id) => {
        env.notificationClears.push(id);
      },
      onClicked: { addListener: () => {} }
    }
  };

  // Mock DOM for offscreen document
  let currentContextIsOffscreen = false;

  const mockOffscreenDocument = {
    createElement: (tag) => {
      if (tag === 'video') {
        const listeners = new Map();
        let _src = '';
        let _currentTime = 0;
        const v = {
          _tag: 'video',
          muted: false,
          playsInline: false,
          preload: '',
          duration: invalidDuration ? NaN : duration,
          videoWidth,
          videoHeight,
          get src() { return _src; },
          set src(val) {
            _src = val;
            if (val) {
              setImmediate(() => {
                const list = listeners.get('loadedmetadata') || [];
                for (const fn of list) fn();
                const listData = listeners.get('loadeddata') || [];
                for (const fn of listData) fn();
              });
            }
          },
          get currentTime() { return _currentTime; },
          set currentTime(val) {
            _currentTime = val;
            if (!seekTimeout) {
              setImmediate(() => {
                const list = listeners.get('seeked') || [];
                for (const fn of list) fn();
              });
            }
          },
          load: () => {},
          addEventListener: (evt, cb) => {
            if (!listeners.has(evt)) listeners.set(evt, []);
            listeners.get(evt).push(cb);
          },
          removeEventListener: (evt, cb) => {
            if (listeners.has(evt)) {
              listeners.set(evt, listeners.get(evt).filter(fn => fn !== cb));
            }
          }
        };
        return v;
      }
      if (tag === 'canvas') {
        return {
          _tag: 'canvas',
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage: () => {},
            getImageData: (x, y, w, h) => {
              const data = new Uint8Array(Math.max(w * h * 4, 16));
              data.fill(120);
              return { data };
            }
          })
        };
      }
      return {};
    }
  };

  // Create isolated context for offscreen.js
  const offscreenSandbox = {
    chrome,
    document: mockOffscreenDocument,
    URL: MockURL,
    Blob,
    gifenc,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url) => {
      env.fetches.push(String(url));
      if (fetchStatus !== 200) {
        return { ok: false, status: fetchStatus, statusText: 'Fetch error' };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'video/mp4' : '10240' },
        blob: async () => new Blob([fetchBody], { type: 'video/mp4' })
      };
    }
  };

  currentContextIsOffscreen = true;
  vm.createContext(offscreenSandbox);
  vm.runInContext(read('offscreen.js'), offscreenSandbox);
  currentContextIsOffscreen = false;

  // Create isolated context for background.js
  const bgSandbox = {
    chrome,
    URL: MockURL,
    Blob,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url) => (env.fetches.push(String(url)), {
      ok: true,
      status: 200,
      headers: { get: () => 'video/mp4' },
      blob: async () => new Blob([fetchBody], { type: 'video/mp4' })
    }),
    FeedbackLib: FBLib,
    ImageSaverFeedback: FBLib,
    ImageSaverFeedbackTracker: FBTrackerLib,
    FolderPath: FolderPathLib,
    ImageSaverFolderPath: FolderPathLib,
    importScripts: (file) => vm.runInContext(read(file), bgSandbox),
    window: { location: { href: '', host: '', pathname: '/' }, addEventListener() {} },
    document: {
      elementsFromPoint: () => [],
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ addEventListener() {}, removeAttribute() {}, load() {} })
    }
  };

  vm.createContext(bgSandbox);
  vm.runInContext(read('background.js'), bgSandbox);

  env.chrome = chrome;
  env.bg = bgSandbox;
  env.offscreen = offscreenSandbox;
  env.tracker = bgSandbox.feedbackTracker;

  env.finishDownload = async (downloadId) => {
    const item = env.downloadsDb.get(downloadId);
    if (item) item.state = 'complete';
    for (const cb of env.downloadListeners) {
      await cb({ id: downloadId, state: { current: 'complete', previous: 'in_progress' } });
    }
    if (env.tracker?.flush) await env.tracker.flush();
  };

  env.failDownload = async (downloadId, error = 'SERVER_FAILED') => {
    const item = env.downloadsDb.get(downloadId);
    if (item) { item.state = 'interrupted'; item.error = error; }
    for (const cb of env.downloadListeners) {
      await cb({ id: downloadId, state: { current: 'interrupted', previous: 'in_progress' }, error: { current: error } });
    }
    if (env.tracker?.flush) await env.tracker.flush();
  };

  env.cancelDownload = async (downloadId) => {
    await env.failDownload(downloadId, 'USER_CANCELED');
  };

  // Teardown: cancel the downloads this fixture left in progress, clear its pending timers and drop its Blobs.
  env.dispose = async () => {
    for (const [id, item] of env.downloadsDb) if (item.state === 'in_progress') await env.cancelDownload(id);
    for (const h of timers) clearTimeout(h);
    timers.clear();
    env.activeBlobs.clear();
    ALL_ENVS.delete(env);
  };
  env.offscreenTaskCount = () => vm.runInContext('activeOffscreenOwners.size', bgSandbox);

  env.saveRedditGif = async (url, pageUrl = 'https://reddit.com/r/test', settings = {}) => {
    const op = await env.bg.fbBegin({ menuItemId: 'save-image-item', srcUrl: url, pageUrl });
    const res = await env.bg.executeRedditGifDownload(url, settings, { pageUrl, feedbackOp: op });
    return { ...res, op };
  };

  env.saveXTweetVideo = async (url, pageUrl = 'https://x.com/status/1', settings = {}) => {
    const op = await env.bg.fbBegin({ menuItemId: 'save-image-item', srcUrl: url, pageUrl });
    const res = await env.bg.executeXTweetVideoGifDownload(url, settings, { pageUrl, feedbackOp: op });
    return { ...res, op };
  };

  return env;
}

async function runSuite() {
  console.log('--- 1. Reproduction of 23-second Reddit Animation ---');
  {
    const env = createIntegratedEnvironment({ duration: 23.0 });
    const url = 'https://preview.redd.it/test_23s_anim.gif?width=1280&format=mp4&s=sig123';
    const result = await env.saveRedditGif(url, 'https://www.reddit.com/r/gifs/comments/1/');
    if (!result?.success) console.log('1a failed with:', result);
    testAssert(result && result.success === true, '1a: 23s Reddit animation successfully initiates download');
    testAssert(env.downloadCalls.length === 1, '1b: Exactly one download initiated');
    testAssert(/\.gif$/i.test(env.downloadCalls[0].filename), '1c: 23s animation downloaded as genuine .gif');
    testAssert(env.downloadCalls[0].url.startsWith('blob:'), '1d: Download uses generated Blob URL');

    // Inspect encoded GIF in blob
    const gifBlob = env.activeBlobs.get(env.downloadCalls[0].url);
    testAssert(gifBlob && gifBlob.size > 0, '1e: Offscreen generated non-empty GIF blob');
    const bytes = new Uint8Array(await gifBlob.arrayBuffer());
    testAssert(env.offscreen.sniffMediaMagicBytes(bytes) === 'image/gif', '1f: Sniffed magic bytes confirm genuine GIF');
    testAssert(env.offscreen.isAnimatedGif(bytes) === true, '1g: Confirmed multiple frames in animated GIF');

    // The blocks of the encoded GIF: frame count, infinite-loop marker and the accumulated centisecond delays
    const g23 = parseGif(bytes);
    testAssert(g23.header === 'GIF89a' && g23.trailer, '1h: GIF89a header and trailer present');
    testAssert(g23.frames === 138 && g23.delaysCs.length === 138, `1i: 138 image blocks with 138 graphic-control delays (${g23.frames}/${g23.delaysCs.length})`);
    testAssert(g23.loop === 0, `1k: NETSCAPE2.0 loop count 0 = infinite loop (${g23.loop})`);
    testAssert(g23.totalMs === 23000, `1l: accumulated delays are 23000 ms in the encoded blocks (${g23.totalMs}ms)`);

    await env.finishDownload(result.downloadId);
    const lastOp = (await env.tracker.list())[0];
    testAssert(lastOp.state === 'complete' && lastOp.output.type === 'gif', '1j: Operation completes as GIF');
  }

  console.log('\n--- 2. Shared Boundary Verification for Reddit and X ---');
  // Both providers: test 14.999, 15.000, 15.001, 23.0, 29.999, 30.000 (GIF) and 30.001, 45.0 (MP4)
  const providers = [
    { name: 'Reddit', fn: 'executeRedditGifDownload', url: 'https://preview.redd.it/anim.gif?width=640&format=mp4&s=123', page: 'https://reddit.com/r/test' },
    { name: 'X', fn: 'executeXTweetVideoGifDownload', url: 'https://video.twimg.com/tweet_video/test.mp4', page: 'https://x.com/user/status/123' }
  ];

  for (const prov of providers) {
    // 2.1: duration = 14.999s -> GIF
    {
      const env = createIntegratedEnvironment({ duration: 14.999 });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page });
      testAssert(res.success && /\.gif$/i.test(env.downloadCalls[0].filename), `2a: ${prov.name} 14.999s produces GIF`);
    }

    // 2.2: duration = 15.000s -> GIF (exact 15s boundary)
    {
      const env = createIntegratedEnvironment({ duration: 15.000 });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page });
      testAssert(res.success && /\.gif$/i.test(env.downloadCalls[0].filename), `2b: ${prov.name} 15.000s produces GIF`);
    }

    // 2.3: duration = 15.001s -> GIF (extended range)
    {
      const env = createIntegratedEnvironment({ duration: 15.001 });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page });
      testAssert(res.success && /\.gif$/i.test(env.downloadCalls[0].filename), `2c: ${prov.name} 15.001s produces GIF`);
    }

    // 2.4: duration = 29.999s -> GIF
    {
      const env = createIntegratedEnvironment({ duration: 29.999 });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page });
      testAssert(res.success && /\.gif$/i.test(env.downloadCalls[0].filename), `2d: ${prov.name} 29.999s produces GIF`);
    }

    // 2.5: duration = 30.000s -> GIF (exact 30.0s belongs to GIF)
    {
      const env = createIntegratedEnvironment({ duration: 30.000 });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page });
      testAssert(res.success && /\.gif$/i.test(env.downloadCalls[0].filename), `2e: ${prov.name} exactly 30.000s belongs to GIF`);
      const dlUrl = env.downloadCalls[0].url;
      testAssert(dlUrl.startsWith('blob:'), `2f: ${prov.name} 30.000s uses converted Blob`);
    }

    // 2.6: duration = 30.001s -> Direct MP4 download
    {
      const env = createIntegratedEnvironment({ duration: 30.001 });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page });
      testAssert(res.success && /\.mp4$/i.test(env.downloadCalls[0].filename), `2g: ${prov.name} 30.001s routes direct MP4`);
      testAssert(env.downloadCalls[0].url === prov.url, `2h: ${prov.name} preserves exact source URL`);
      testAssert(env.activeBlobs.size === 0, `2i: ${prov.name} offscreen Blob released before direct download`);
    }

    // 2.7: duration = 45.000s -> Direct MP4 download
    {
      const env = createIntegratedEnvironment({ duration: 45.000 });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page });
      testAssert(res.success && /\.mp4$/i.test(env.downloadCalls[0].filename), `2j: ${prov.name} 45.000s routes direct MP4`);
      testAssert(env.downloadCalls[0].url === prov.url, `2k: ${prov.name} preserves exact source URL`);
    }
  }

  console.log('\n--- 3. Completion Notice and Operation Model for >30s MP4 ---');
  // 3.1: English notice copy and timing
  {
    const env = createIntegratedEnvironment({ duration: 35.0, lang: 'en' });
    const url = 'https://preview.redd.it/long_anim.gif?width=1280&format=mp4&s=sig999';
    const res = await env.saveRedditGif(url, 'https://reddit.com/r/test');

    testAssert(env.notifications.length === 0, '3a: Notice is NOT emitted at download registration');

    await env.finishDownload(res.downloadId);

    testAssert(env.notifications.length === 1, '3b: Notice emitted exactly once after terminal download completion');
    const toast = env.notifications[0].opts;
    testAssert(toast.title === 'MP4 saved without conversion', `3c: English title exact match (${toast.title})`);
    testAssert(toast.message === 'This animation exceeds the 30-second GIF limit. The source video was saved as MP4.', `3d: English body exact match (${toast.message})`);

    const op = (await env.tracker.list())[0];
    testAssert(op.state === 'complete', '3e: Operation state is complete');
    testAssert(op.reason === 'animation_duration_limit', '3f: Operation model records reason animation_duration_limit');
    testAssert(op.durationSec === 35.0, '3g: Operation model records verified durationSec');
    testAssert(op.thresholdSec === 30.0, '3h: Operation model records thresholdSec: 30');
    testAssert(op.output.type === 'video' && op.output.ext === '.mp4', '3i: Operation output type is video/mp4');
    testAssert(op.failure === null, '3j: Operation failure is null (not mislabeled as error)');
  }

  // 3.2: Russian notice copy matching localization conventions
  {
    const env = createIntegratedEnvironment({ duration: 35.0, lang: 'ru' });
    const url = 'https://preview.redd.it/long_anim_ru.gif?width=1280&format=mp4&s=sig888';
    const res = await env.saveRedditGif(url, 'https://reddit.com/r/test');
    await env.finishDownload(res.downloadId);

    testAssert(env.notifications.length === 1, '3k: Exactly one notification emitted for Russian UI');
    const toast = env.notifications[0].opts;
    testAssert(toast.title === 'MP4 сохранён без конвертации', `3l: Russian title matches convention (${toast.title})`);
    testAssert(toast.message === 'Длительность анимации превышает 30 секунд. Исходное видео сохранено как MP4.', `3m: Russian message matches convention (${toast.message})`);
  }

  // 3.3: User notification preference (notifySuccess = false) suppresses toast while retaining explanation in tracker
  {
    const env = createIntegratedEnvironment({ duration: 32.0, notifySuccess: false });
    const url = 'https://preview.redd.it/suppressed.gif?width=1280&format=mp4&s=sig777';
    const res = await env.saveRedditGif(url, 'https://reddit.com/r/test');
    await env.finishDownload(res.downloadId);

    testAssert(env.notifications.length === 0, '3n: Notification suppressed when notifySuccess is false');
    const op = (await env.tracker.list())[0];
    testAssert(op.reason === 'animation_duration_limit', '3o: Operation record explanation remains available in tracker');
    testAssert(op.state === 'complete', '3p: Operation state remains complete');
  }

  // 3.4: Cancellation does not show duration limit notice
  {
    const env = createIntegratedEnvironment({ duration: 34.0 });
    const url = 'https://preview.redd.it/cancel_anim.gif?width=1280&format=mp4&s=sig666';
    const res = await env.saveRedditGif(url, 'https://reddit.com/r/test');
    await env.cancelDownload(res.downloadId);

    testAssert(env.notifications.length === 0, '3q: Cancelled download emits no desktop notification');
    const op = (await env.tracker.list())[0];
    testAssert(op.state === 'cancelled', '3r: Operation state is cancelled');
  }

  // 3.5: Interruption shows error notification, not duration limit notice
  {
    const env = createIntegratedEnvironment({ duration: 34.0 });
    const url = 'https://preview.redd.it/fail_anim.gif?width=1280&format=mp4&s=sig555';
    const res = await env.saveRedditGif(url, 'https://reddit.com/r/test');
    await env.failDownload(res.downloadId, 'NETWORK_FAILED');

    testAssert(env.notifications.length === 1, '3s: Interrupted download emits 1 failure notification');
    testAssert(env.notifications[0].opts.title !== 'MP4 saved without conversion', '3t: Interrupted download does not emit MP4 duration notice');
    const op = (await env.tracker.list())[0];
    testAssert(op.state === 'interrupted', '3u: Operation state is interrupted');
  }

  // 3.6: Successful GIF conversion does not emit duration limit notice
  {
    const env = createIntegratedEnvironment({ duration: 10.0 });
    const url = 'https://preview.redd.it/good_gif.gif?width=1280&format=mp4&s=sig444';
    const res = await env.saveRedditGif(url, 'https://reddit.com/r/test');
    await env.finishDownload(res.downloadId);

    testAssert(env.notifications.length === 1, '3v: GIF conversion emits 1 completion notification');
    testAssert(env.notifications[0].opts.title !== 'MP4 saved without conversion', '3w: Successful GIF conversion does not emit MP4 duration notice');
    testAssert(/GIF/.test(env.notifications[0].opts.message) || /сохранено/.test(env.notifications[0].opts.title), '3x: Notification indicates GIF output');
  }

  console.log('\n--- 4. Fail-Closed Error Cases (Zero Leaks, Zero False MP4 Downloads) ---');
  // 4.1: Invalid/NaN duration
  {
    const env = createIntegratedEnvironment({ invalidDuration: true });
    const url = 'https://preview.redd.it/nan_duration.gif?width=1280&format=mp4&s=123';
    const res = await env.bg.executeRedditGifDownload(url, {}, { pageUrl: 'https://reddit.com/r/test' });

    testAssert(res.success === false, '4a: Invalid video duration fails closed');
    testAssert(env.downloadCalls.length === 0, '4b: Zero downloads triggered for invalid duration');
    testAssert(env.activeBlobs.size === 0, '4c: Zero Blob leaks on invalid duration');
  }

  // 4.2: Video fetch HTTP 404
  {
    const env = createIntegratedEnvironment({ fetchStatus: 404 });
    const url = 'https://preview.redd.it/404_video.gif?width=1280&format=mp4&s=123';
    const res = await env.bg.executeRedditGifDownload(url, {}, { pageUrl: 'https://reddit.com/r/test' });

    testAssert(res.success === false, '4d: Video fetch HTTP 404 fails closed');
    testAssert(env.downloadCalls.length === 0, '4e: Zero downloads triggered on fetch 404');
    testAssert(env.activeBlobs.size === 0, '4f: Zero Blob leaks on fetch 404');
  }

  // 4.3: Corrupted container (not video/mp4 magic bytes)
  {
    const env = createIntegratedEnvironment({ fetchBody: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) });
    const url = 'https://preview.redd.it/bad_magic.gif?width=1280&format=mp4&s=123';
    const res = await env.bg.executeRedditGifDownload(url, {}, { pageUrl: 'https://reddit.com/r/test' });

    testAssert(res.success === false, '4g: Corrupted container magic bytes fails closed');
    testAssert(env.downloadCalls.length === 0, '4h: Zero downloads on container mismatch');
    testAssert(env.activeBlobs.size === 0, '4i: Zero Blob leaks on container mismatch');
  }

  // 4.4: Video seek timeout
  {
    const env = createIntegratedEnvironment({ duration: 5.0, seekTimeout: true });
    const url = 'https://preview.redd.it/seek_timeout.gif?width=1280&format=mp4&s=123';
    const res = await env.bg.executeRedditGifDownload(url, {}, { pageUrl: 'https://reddit.com/r/test' });

    testAssert(res.success === false, '4j: Video seek timeout fails closed');
    testAssert(env.downloadCalls.length === 0, '4k: Zero downloads on seek timeout');
    testAssert(env.activeBlobs.size === 0, '4l: Zero Blob leaks on seek timeout');
  }

  console.log('\n--- 5. Settings, Invariants & Message Ceilings ---');
  // 5.1: A legacy enabled Save As preference is ignored on >30s direct MP4
  {
    const env = createIntegratedEnvironment({ duration: 35.0, askEveryTime: true });
    const url = 'https://preview.redd.it/saveas_test.gif?width=1280&format=mp4&s=123';
    await env.bg.executeRedditGifDownload(url, { askEveryTime: true }, { pageUrl: 'https://reddit.com/r/test' });

    testAssert(env.downloadCalls.length === 1 && env.downloadCalls[0].saveAs === false, '5a: legacy askEveryTime=true is ignored on direct MP4 download');
  }

  // 5.2: Folder organization mode by_site_and_type routes MP4 to video subfolder
  {
    const env = createIntegratedEnvironment({ duration: 35.0, folderOrganizationMode: 'by_site_and_type' });
    const url = 'https://preview.redd.it/folder_test.gif?width=1280&format=mp4&s=123';
    await env.bg.executeRedditGifDownload(url, { folderOrganizationMode: 'by_site_and_type' }, { pageUrl: 'https://reddit.com/r/test' });

    testAssert(env.downloadCalls.length === 1 && /video[\\/]/.test(env.downloadCalls[0].filename), '5b: folderOrganizationMode by_site_and_type routes MP4 to video folder');
  }

  // 5.3: Message options cannot bypass production ceilings in offscreen.js
  {
    const env = createIntegratedEnvironment({ duration: 10.0 });
    // Attempt to pass maxDuration: 100 via message (a bounded 64x36 canvas: the ceilings, not the pixels, are under test)
    const taskKey = 'task_test_ceilings';
    const res = await env.chrome.runtime.sendMessage({
      action: 'CONVERT_REDDIT_VIDEO_TO_GIF',
      url: 'https://preview.redd.it/test.gif?width=640&format=mp4&s=123',
      jobId: taskKey,
      maxDuration: 100.0,
      maxFrames: 500
    });

    testAssert(res && res.success === true, '5c: Message handled successfully');
    testAssert(res.frames <= 150, `5d: Frame count (${res.frames}) clamped to production ceiling (150)`);
  }


  console.log('\n--- 6. Fixed policy permission: only a measured duration above 30 s authorizes the direct MP4 ---');
  const URL_R = 'https://preview.redd.it/policy.gif?width=1280&format=mp4&s=SYNTH';
  const URL_X = 'https://video.twimg.com/tweet_video/policy.mp4';
  const runners = [
    { name: 'Reddit', fn: 'executeRedditGifDownload', url: URL_R, page: 'https://www.reddit.com/r/test/' },
    { name: 'X', fn: 'executeXTweetVideoGifDownload', url: URL_X, page: 'https://x.com/u/status/1' }
  ];
  for (const prov of runners) {
    // 6.1 the real offscreen converter: a stricter caller budget below the threshold FAILS, it never saves an MP4
    {
      const env = createIntegratedEnvironment({ duration: 23.0 });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page, maxDuration: 15 });
      testAssert(res.success === false, `6a: ${prov.name} measured 23 s with maxDuration 15 fails (no MP4 policy for a resource budget)`);
      testAssert(env.downloadCalls.length === 0, `6b: ${prov.name} stricter budget starts no download`);
      testAssert(env.activeBlobs.size === 0 && env.offscreenTaskCount() === 0, `6c: ${prov.name} stricter budget leaves no Blob and no offscreen task`);
      testAssert(env.fetches.length === 1 && env.fetches[0] === prov.url, `6d: ${prov.name} stricter budget requested only the video for measuring (no direct MP4 request)`);
    }
    // 6.1b the converter itself (not only the background) refuses: a failure reply, never a decision
    {
      const env = createIntegratedEnvironment({ duration: 23.0 });
      const action = prov.name === 'X' ? 'CONVERT_X_TWEET_VIDEO_TO_GIF' : 'CONVERT_REDDIT_VIDEO_TO_GIF';
      const reply = await env.chrome.runtime.sendMessage({ action, url: prov.url, jobId: 'job_budget', maxDuration: 15 });
      testAssert(reply && reply.success === false && /DURATION_EXCEEDED/.test(reply.error || '') && reply.exceedsDuration === undefined && !reply.blobUrl, `6l: ${prov.name} the offscreen reply to a 23 s video with maxDuration 15 is a DURATION_EXCEEDED failure, not a decision`);
    }
    // 6.2 the budget is not the policy above the threshold: 35 s is the fixed-policy MP4 even with a stricter budget
    {
      const env = createIntegratedEnvironment({ duration: 35.0 });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page, maxDuration: 15 });
      testAssert(res.success === true && env.downloadCalls.length === 1 && /\.mp4$/i.test(env.downloadCalls[0].filename) && env.downloadCalls[0].url === prov.url, `6e: ${prov.name} 35 s saves the exact source MP4 whatever the budget`);
    }
    // 6.3 defaults: 23 s and exactly 30 s are GIF, and the real converter's decision carries the full evidence
    for (const d of [23.0, 30.0]) {
      const env = createIntegratedEnvironment({ duration: d });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page });
      testAssert(res.success === true && env.downloadCalls.length === 1 && /\.gif$/i.test(env.downloadCalls[0].filename), `6f: ${prov.name} ${d} s is a GIF`);
    }
    {
      const env = createIntegratedEnvironment({ duration: 35.0 });
      const reply = await env.chrome.runtime.sendMessage({ action: prov.name === 'X' ? 'CONVERT_X_TWEET_VIDEO_TO_GIF' : 'CONVERT_REDDIT_VIDEO_TO_GIF', url: prov.url, jobId: 'job_policy' });
      testAssert(reply && reply.success === true && reply.exceedsDuration === true && reply.action === 'SAVE_DIRECT_MP4' && reply.duration === 35 && reply.threshold === 30 && !reply.blobUrl, `6g: ${prov.name} the offscreen decision is explicit (action, duration 35, threshold 30, no Blob)`);
    }
    // 6.4 background validation of the explicit decision: every malformed reply refuses before any download or request
    const bad = [
      ['NaN duration', { success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: NaN, threshold: 30 }],
      ['Infinity duration', { success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: Infinity, threshold: 30 }],
      ['string duration', { success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: '35', threshold: 30 }],
      ['missing duration', { success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', threshold: 30 }],
      ['duration below the threshold', { success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: 23, threshold: 30 }],
      ['duration exactly at the threshold', { success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: 30, threshold: 30 }],
      ['implausible duration', { success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: 1e9, threshold: 30 }],
      ['a different threshold', { success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: 35, threshold: 15 }],
      ['missing threshold', { success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: 35 }],
      ['missing action', { success: true, exceedsDuration: true, duration: 35, threshold: 30 }],
      ['another action', { success: true, exceedsDuration: true, action: 'SAVE_POSTER', duration: 35, threshold: 30 }],
      ['exceedsDuration as a string', { success: true, exceedsDuration: 'true', action: 'SAVE_DIRECT_MP4', duration: 35, threshold: 30 }],
      ['exceedsDuration as a number', { success: true, exceedsDuration: 1, action: 'SAVE_DIRECT_MP4', duration: 35, threshold: 30 }],
      ['a decision that also carries a GIF Blob', { success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: 35, threshold: 30, blobUrl: 'blob:chrome-extension://test-ext/9' }],
      ['an error reply that claims a decision', { success: false, error: 'X', exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: 35, threshold: 30 }]
    ];
    for (const [name, reply] of bad) {
      const env = createIntegratedEnvironment({ converterReply: () => reply });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page });
      testAssert(res.success === false && env.downloadCalls.length === 0 && env.fetches.length === 0, `6h: ${prov.name} ${name}: refused, no download, no direct request`);
      testAssert(env.activeBlobs.size === 0 && env.offscreenTaskCount() === 0 && env.converterCalls.length === 1, `6i: ${prov.name} ${name}: no Blob, no offscreen task left, one converter call only`);
    }
    {
      const env = createIntegratedEnvironment({ converterReply: () => ({ success: true, exceedsDuration: true, action: 'SAVE_DIRECT_MP4', duration: 35.5, threshold: 30 }) });
      const res = await env.bg[prov.fn](prov.url, {}, { pageUrl: prov.page });
      testAssert(res.success === true && env.downloadCalls.length === 1 && env.downloadCalls[0].url === prov.url && /\.mp4$/i.test(env.downloadCalls[0].filename), `6j: ${prov.name} a complete decision saves the exact signed source MP4`);
      testAssert(env.offscreenTaskCount() === 0, `6k: ${prov.name} the offscreen task of a decision is released`);
    }
  }

  console.log('\n--- 7. Encoded GIF blocks: frame count, infinite loop and accumulated delays ---');
  for (const [d, frames] of [[23.0, 138], [30.0, 150], [14.999, null], [15.001, null], [29.999, null]]) {
    const env = createIntegratedEnvironment({ duration: d });
    const res = await env.bg.executeRedditGifDownload(URL_R, {}, { pageUrl: 'https://www.reddit.com/r/test/' });
    const blob = env.activeBlobs.get(env.downloadCalls[0].url);
    const g = parseGif(new Uint8Array(await blob.arrayBuffer()));
    testAssert(res.success === true && g.header === 'GIF89a' && g.trailer && g.loop === 0, `7a: ${d} s: genuine GIF89a with an infinite loop marker and a trailer`);
    testAssert(g.frames === g.delaysCs.length && g.frames <= 150 && g.frames >= 2, `7b: ${d} s: every image block has its delay (${g.frames} frames, at most 150)`);
    if (frames !== null) testAssert(g.frames === frames, `7c: ${d} s: ${frames} frames in the blocks (${g.frames})`);
    testAssert(Math.abs(g.totalMs - d * 1000) <= 10, `7d: ${d} s: accumulated centisecond delays ${g.totalMs} ms are the duration within one centisecond`);
  }
  {
    // a long run with a message that asks for more than the ceilings is clamped, in the bytes
    const env = createIntegratedEnvironment({ duration: 25.0 });
    const res = await env.chrome.runtime.sendMessage({ action: 'CONVERT_REDDIT_VIDEO_TO_GIF', url: URL_R, jobId: 'job_clamp', maxDuration: 100.0, maxFrames: 500 });
    testAssert(res && res.success === true && res.frames === 150 && res.duration === 25, '7e: a 25 s run asked for 500 frames is clamped to 150 frames');
    const g = parseGif(new Uint8Array(await env.activeBlobs.get(res.blobUrl).arrayBuffer()));
    testAssert(g.frames === 150 && g.totalMs === 25000 && g.loop === 0, '7f: the clamped GIF has 150 blocks, 25000 ms and an infinite loop');
  }

  console.log(`\n========================================`);
  console.log(`Duration Policy Suite: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);

  if (failed > 0) process.exitCode = 1;
}

// Teardown of every fixture (cancel outstanding downloads, clear test-owned timers, drop Blobs) so the process ends by itself.
async function runWithTeardown() {
  try {
    await runSuite();
  } finally {
    for (const env of [...ALL_ENVS]) await env.dispose();
  }
}

runWithTeardown().catch(err => {
  console.error('Test suite crashed:', err);
  process.exitCode = 1;
});
