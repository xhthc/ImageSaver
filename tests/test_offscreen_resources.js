// test_offscreen_resources.js - Focused verification and regression suite for offscreen media validation and resource lifetime
const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createOffscreenTestServer, FIXTURE_BYTES } = require('../tools/fixtures/offscreen-server.js');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res
        .then(() => {
          passCount++;
          console.log(`  ✓ ${name}`);
        })
        .catch(err => {
          failCount++;
          console.error(`  ✗ ${name}`);
          console.error(err);
        });
    }
    passCount++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failCount++;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

// Load offscreen.js into an isolated VM sandbox
const offscreenPath = path.resolve(REPO_ROOT, 'offscreen.js');
const offscreenSource = require('./helpers/offscreen.cjs').source();
const gifenc = require(path.resolve(REPO_ROOT, 'offscreen', 'gifenc.js'));

function createTestSandbox(overrides = {}) {
  let messageListener = null;
  const createdBlobs = new Map(); // blobUrl -> blob
  const revokedBlobs = new Set();
  let nextBlobId = 1;
  const createdVideos = [];
  const createdCanvases = [];

  const mockChrome = {
    runtime: {
      id: 'image-saver-test-extension-id',
      getURL: (p) => `chrome-extension://image-saver-test-extension-id/${p}`,
      onMessage: {
        addListener: (cb) => { messageListener = cb; }
      }
    }
  };

  const MockURL = Object.assign(class extends URL {}, {
    createObjectURL: (blob) => {
      const u = `blob:chrome-extension://mock-id/${nextBlobId++}`;
      createdBlobs.set(u, blob);
      return u;
    },
    revokeObjectURL: (u) => {
      revokedBlobs.add(u);
      createdBlobs.delete(u);
    }
  });

  const mockDocument = {
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
          duration: 0.2,
          videoWidth: 64,
          videoHeight: 64,
          loadCalls: 0,
          _manual: false,
          get src() { return _src; },
          set src(val) {
            _src = val;
            if (val && !v._manual) {
              setTimeout(() => {
                const list = listeners.get('loadedmetadata') || [];
                for (const fn of list) fn();
              }, 5);
            }
          },
          get currentTime() { return _currentTime; },
          set currentTime(val) {
            _currentTime = val;
            if (!v._manual) {
              setTimeout(() => {
                const list = listeners.get('seeked') || [];
                for (const fn of list) fn();
              }, 5);
            }
          },
          load: () => { v.loadCalls++; },
          addEventListener: (evt, cb) => {
            if (!listeners.has(evt)) listeners.set(evt, []);
            listeners.get(evt).push(cb);
          },
          removeEventListener: (evt, cb) => {
            if (listeners.has(evt)) {
              listeners.set(evt, listeners.get(evt).filter(fn => fn !== cb));
            }
          },
          dispatchEvent: (evt) => {
            const type = typeof evt === 'string' ? evt : evt.type;
            const list = listeners.get(type) || [];
            for (const fn of list) fn(evt);
          },
          _listeners: listeners
        };
        createdVideos.push(v);
        return v;
      }
      if (tag === 'canvas') {
        const c = {
          _tag: 'canvas',
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage: () => {},
            getImageData: (x, y, w, h) => {
              const data = new Uint8Array(Math.max(w * h * 4, 16));
              data[0] = 128;
              data[1] = 64;
              data[2] = 32;
              data[3] = 255;
              return { data };
            }
          })
        };
        createdCanvases.push(c);
        return c;
      }
      return {};
    }
  };

  const activeTimers = new Set();
  let nextTimerId = 1;
  const wrappedSetTimeout = (fn, ms, ...args) => {
    const id = nextTimerId++;
    activeTimers.add(id);
    const realTimer = setTimeout(() => {
      activeTimers.delete(id);
      fn(...args);
    }, ms);
    return { id, realTimer, [Symbol.toPrimitive]: () => id };
  };
  const wrappedClearTimeout = (handle) => {
    if (handle) {
      if (typeof handle === 'object' && handle.id) {
        activeTimers.delete(handle.id);
        clearTimeout(handle.realTimer);
      } else {
        activeTimers.delete(handle);
        clearTimeout(handle);
      }
    }
  };

  let effectiveFetch = async () => { throw new Error('fetch not implemented in base sandbox'); };
  if (overrides.fetch) {
    const rawFetch = overrides.fetch;
    effectiveFetch = async (...args) => {
      const resp = await rawFetch(...args);
      if (resp && !resp.headers) resp.headers = { get: () => null };
      if (resp && typeof resp.blob === 'function' && resp.body === undefined) {
        let consumed = false;
        resp.body = {
          getReader: () => ({
            read: async () => {
              if (consumed) return { done: true };
              consumed = true;
              const b = await resp.blob();
              const buf = await b.arrayBuffer();
              return { done: false, value: new Uint8Array(buf) };
            },
            cancel: async () => {}
          })
        };
      }
      return resp;
    };
  }

  const baseSandbox = {
    chrome: mockChrome,
    document: mockDocument,
    URL: MockURL,
    Blob,
    AbortController,
    setTimeout: wrappedSetTimeout,
    clearTimeout: wrappedClearTimeout,
    console,
    gifenc,
    fetch: effectiveFetch
  };

  const sandbox = Object.assign({}, baseSandbox, overrides, { fetch: effectiveFetch });
  vm.createContext(sandbox);
  vm.runInContext(offscreenSource, sandbox);

  return {
    sandbox,
    createdBlobs,
    revokedBlobs,
    createdVideos,
    createdCanvases,
    activeTimers,
    dispatchMessage: (msg, sender = { id: 'image-saver-test-extension-id' }) => {
      return new Promise((resolve) => {
        const handled = messageListener(msg, sender, resolve);
        if (!handled) resolve(undefined);
      });
    }
  };
}

async function runAllSuites() {
  console.log('=== MediaLatch: Offscreen Media Validation & Resource Lifetime Regressions ===\n');

  // ---------------------------------------------------------------------------
  // Suite 1: Valid media formats at validation boundary
  // ---------------------------------------------------------------------------
  console.log('--- Suite 1: Valid Media Formats at Validation Boundary ---');

  test('sniffMediaMagicBytes: identifies valid JPEG SOI marker', () => {
    const { sandbox } = createTestSandbox();
    const mime = sandbox.sniffMediaMagicBytes(FIXTURE_BYTES.jpeg);
    assert.strictEqual(mime, 'image/jpeg');
  });

  test('sniffMediaMagicBytes: identifies valid PNG 8-byte signature', () => {
    const { sandbox } = createTestSandbox();
    const mime = sandbox.sniffMediaMagicBytes(FIXTURE_BYTES.png);
    assert.strictEqual(mime, 'image/png');
  });

  test('sniffMediaMagicBytes: identifies valid WebP RIFF....WEBP signature', () => {
    const { sandbox } = createTestSandbox();
    const mime = sandbox.sniffMediaMagicBytes(FIXTURE_BYTES.webp);
    assert.strictEqual(mime, 'image/webp');
  });

  test('sniffMediaMagicBytes: identifies valid AVIF still image (ftyp avif)', () => {
    const { sandbox } = createTestSandbox();
    const mime = sandbox.sniffMediaMagicBytes(FIXTURE_BYTES.avif);
    assert.strictEqual(mime, 'image/avif');
  });

  test('sniffMediaMagicBytes: identifies valid AVIF sequence (ftyp avis)', () => {
    const { sandbox } = createTestSandbox();
    const avisBytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x73, 0x00, 0x00, 0x00, 0x00, 0x61, 0x76, 0x69, 0x73]);
    const mime = sandbox.sniffMediaMagicBytes(avisBytes);
    assert.strictEqual(mime, 'image/avif');
  });

  test('sniffMediaMagicBytes: identifies AVIF via mif1 with avif compatible brand', () => {
    const { sandbox } = createTestSandbox();
    const mifAvif = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6D, 0x69, 0x66, 0x31,
      0x00, 0x00, 0x00, 0x00, 0x6D, 0x69, 0x61, 0x66, 0x61, 0x76, 0x69, 0x66
    ]);
    const mime = sandbox.sniffMediaMagicBytes(mifAvif);
    assert.strictEqual(mime, 'image/avif');
  });

  test('sniffMediaMagicBytes: identifies valid MP4 container (ftyp isom)', () => {
    const { sandbox } = createTestSandbox();
    const mime = sandbox.sniffMediaMagicBytes(FIXTURE_BYTES.mp4);
    assert.strictEqual(mime, 'video/mp4');
  });

  test('sniffMediaMagicBytes: identifies valid WebM EBML container', () => {
    const { sandbox } = createTestSandbox();
    const mime = sandbox.sniffMediaMagicBytes(FIXTURE_BYTES.webm);
    assert.strictEqual(mime, 'video/webm');
  });

  test('sniffMediaMagicBytes: identifies valid SVG payload (image/svg+xml)', () => {
    const { sandbox } = createTestSandbox();
    const mime = sandbox.sniffMediaMagicBytes(FIXTURE_BYTES.svg);
    assert.strictEqual(mime, 'image/svg+xml');
  });

  test('sniffMediaMagicBytes: identifies valid SVG with XML declaration and DOCTYPE', () => {
    const { sandbox } = createTestSandbox();
    const fullSvg = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
      '<!-- Generator: Adobe Illustrator -->\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="blue"/></svg>'
    );
    const mime = sandbox.sniffMediaMagicBytes(fullSvg);
    assert.strictEqual(mime, 'image/svg+xml');
  });

  await test('fetchProtectedBlob: succeeds for valid protected SVG download (image/svg+xml)', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/svg+xml' : null },
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.svg], { type: 'image/svg+xml' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/icon.svg' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.contentType, 'image/svg+xml');
    assert.strictEqual(createdBlobs.size, 1);
  });

  await test('fetchProtectedBlob: corrects misleading Content-Type for SVG (server sent image/jpeg, body is SVG)', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.svg], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/icon.jpg' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.contentType, 'image/svg+xml', 'MIME must be corrected to image/svg+xml');
    assert.strictEqual(createdBlobs.size, 1);
  });

  test('isAnimatedGif: confirms multi-frame animated GIF', () => {
    const { sandbox } = createTestSandbox();
    const isAnim = sandbox.isAnimatedGif(FIXTURE_BYTES.gif89a);
    assert.strictEqual(isAnim, true);
  });

  test('isAnimatedGif: rejects single-frame static GIF as non-animation', () => {
    const { sandbox } = createTestSandbox();
    const staticGif = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0A, 0x00, 0x0A, 0x00, 0x80, 0x00, 0x00,
      0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF,
      0x2C, 0x00, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x0A, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
      0x3B
    ]);
    assert.strictEqual(sandbox.sniffMediaMagicBytes(staticGif), 'image/gif');
    assert.strictEqual(sandbox.isAnimatedGif(staticGif), false);
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Masquerading responses and error rejection
  // ---------------------------------------------------------------------------
  console.log('\n--- Suite 2: Masquerading Responses and Error Rejection ---');

  await test('fetchProtectedBlob: rejects HTML body masquerading under image/jpeg header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob(['<!DOCTYPE html><html><body><h1>Access Denied</h1></body></html>'], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0, 'No Blob URL should be created on rejected payload');
  });

  await test('fetchProtectedBlob: rejects HTML body masquerading under image/svg+xml header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/svg+xml' : null },
        blob: async () => new sandbox.Blob(['<!DOCTYPE html><html><body><h1>Error Page</h1></body></html>'], { type: 'image/svg+xml' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.svg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects Cloudflare challenge masquerading under image/svg+xml header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/svg+xml' : null },
        blob: async () => new sandbox.Blob(['<html><head><title>Just a moment...</title></head><body><div class="cf-challenge"></div></body></html>'], { type: 'image/svg+xml' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.svg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects XML error response masquerading under image/svg+xml header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/svg+xml' : null },
        blob: async () => new sandbox.Blob(['<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>'], { type: 'image/svg+xml' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.svg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects HTML body with leading whitespace and newlines', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob(['\r\n   <html><head><title>Cloudflare Challenge</title></head></html>'], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects HTML with UTF-8 BOM masquerading under image/png header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => {
        const bomHtml = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('<!doctype html><html></html>')]);
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/png' : null },
          blob: async () => new sandbox.Blob([bomHtml], { type: 'image/png' })
        };
      }
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.png' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects JSON object error masquerading under image/jpeg header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob(['{"error":"Forbidden","message":"API rate limit exceeded","code":403}'], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://img3.gelbooru.com/target.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects JSON array error masquerading under video/mp4 header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'video/mp4' : null },
        blob: async () => new sandbox.Blob(['[{"error":"Video not found"}]'], { type: 'video/mp4' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://img3.gelbooru.com/target.mp4' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects plain text 404 error masquerading under image/jpeg header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob(['404 Not Found: Media asset deleted by administrator'], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects plain text 403 error masquerading under image/jpeg header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob(['403 Forbidden: Missing valid signature cookie'], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects plain text 500 error masquerading under image/jpeg header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob(['500 Internal Server Error in image cache backend'], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects plain text Access Denied masquerading under image/jpeg header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob(['Access Denied: Hotlinking is not permitted for your IP address'], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  // ---------------------------------------------------------------------------
  // Suite 3: Empty bodies, malformed/truncated headers & misleading Content-Type
  // ---------------------------------------------------------------------------
  console.log('\n--- Suite 3: Empty Bodies, Malformed/Truncated Headers & Misleading Content-Type ---');

  await test('fetchProtectedBlob: rejects empty 0-byte body', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob([], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Received empty blob body/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects truncated 1-byte body', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob([new Uint8Array([0xFF])], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Received truncated media body/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects truncated 2-byte body (SOI without marker payload)', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob([new Uint8Array([0xFF, 0xD8])], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Received truncated media body/i);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('fetchProtectedBlob: rejects malformed 12-byte ftyp container under video/mp4 header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'video/mp4' : null },
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.malformedFtyp], { type: 'video/mp4' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/clip.mp4' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Received malformed media container/i);
    assert.strictEqual(createdBlobs.size, 0, 'No Blob URL should be created for malformed ftyp container');
  });

  await test('fetchProtectedBlob: rejects malformed 12-byte ftyp container under image/jpeg header', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.malformedFtyp], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/pic.jpg' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Received malformed media container/i);
    assert.strictEqual(createdBlobs.size, 0, 'No Blob URL should be created for malformed ftyp under misleading image/jpeg header');
  });

  test('sniffMediaMagicBytes: rejects malformed ftyp box with size < 16', () => {
    const { sandbox } = createTestSandbox();
    const sniffed = sandbox.sniffMediaMagicBytes(FIXTURE_BYTES.malformedFtyp);
    assert.strictEqual(sniffed, null, 'Corrupted ftyp box with size < 16 must not be falsely verified as video/mp4');
  });

  test('sniffMediaMagicBytes: leaves mif1 box with truncated compatible brand list undecided (null)', () => {
    const { sandbox } = createTestSandbox();
    const truncatedMif1 = new Uint8Array([
      0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x6D, 0x69, 0x66, 0x31,
      0x00, 0x00, 0x00, 0x00
    ]);
    const sniffed = sandbox.sniffMediaMagicBytes(truncatedMif1);
    assert.strictEqual(sniffed, null, 'Truncated mif1 must not be decided as MP4 before compatible brands arrive');
  });

  await test('fetchProtectedBlob: corrects misleading Content-Type (server sent image/jpeg, body is WebP)', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.webp], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.contentType, 'image/webp', 'Magic byte sniffing must correct misleading Content-Type to actual image/webp');
    assert.strictEqual(createdBlobs.size, 1);
  });

  await test('fetchProtectedBlob: corrects misleading Content-Type (server sent image/jpeg, body is PNG)', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.png], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.contentType, 'image/png');
    assert.strictEqual(createdBlobs.size, 1);
  });

  await test('fetchProtectedBlob: corrects misleading Content-Type (server sent image/jpeg, body is AVIF)', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.avif], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/target.jpg' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.contentType, 'image/avif');
    assert.strictEqual(createdBlobs.size, 1);
  });

  await test('fetchProtectedBlob: corrects misleading Content-Type (server sent image/jpeg, body is MP4)', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.mp4], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://img3.gelbooru.com/target.jpg' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.contentType, 'video/mp4');
    assert.strictEqual(createdBlobs.size, 1);
  });

  // ---------------------------------------------------------------------------
  // Suite 4: Transport, concurrency, and task/Blob lifetime
  // ---------------------------------------------------------------------------
  console.log('\n--- Suite 4: Transport, Concurrency, and Task/Blob Lifetime ---');

  await test('Blob URL lifecycle: explicit REVOKE_BLOB_URL revokes exact Blob URL', async () => {
    const { sandbox, dispatchMessage, createdBlobs, revokedBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.jpeg], { type: 'image/jpeg' })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/pic.jpg' });
    assert.strictEqual(res.success, true);
    const targetUrl = res.blobUrl;
    assert.strictEqual(createdBlobs.has(targetUrl), true);

    const revokeRes = await dispatchMessage({ action: 'REVOKE_BLOB_URL', blobUrl: targetUrl });
    assert.strictEqual(revokeRes.success, true);
    assert.strictEqual(createdBlobs.has(targetUrl), false);
    assert.strictEqual(revokedBlobs.has(targetUrl), true);
  });

  await test('REVOKE_BLOB_URL: idempotent on repeated calls and safe with invalid input', async () => {
    const { dispatchMessage } = createTestSandbox();
    const res1 = await dispatchMessage({ action: 'REVOKE_BLOB_URL', blobUrl: 'blob:nonexistent' });
    assert.strictEqual(res1.success, true);
    const res2 = await dispatchMessage({ action: 'REVOKE_BLOB_URL', blobUrl: null });
    assert.strictEqual(res2.success, true);
    const res3 = await dispatchMessage({ action: 'REVOKE_BLOB_URL', blobUrl: 12345 });
    assert.strictEqual(res3.success, true);
  });

  await test('Concurrent tasks: overlapping execution with late completion maintains independent Blob lifecycles', async () => {
    let taskAResolve = null;
    let taskBResolve = null;

    const { sandbox, dispatchMessage, createdBlobs, revokedBlobs } = createTestSandbox({
      fetch: async (url) => {
        if (url.includes('taskA')) {
          // Task A starts first, but completes late
          return {
            ok: true,
            status: 200,
            headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
            blob: () => new Promise(resolve => {
              taskAResolve = () => resolve(new sandbox.Blob([FIXTURE_BYTES.jpeg], { type: 'image/jpeg' }));
            })
          };
        } else {
          // Task B starts second, completes early
          return {
            ok: true,
            status: 200,
            headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
            blob: () => new Promise(resolve => {
              taskBResolve = () => resolve(new sandbox.Blob([FIXTURE_BYTES.jpeg], { type: 'image/jpeg' }));
            })
          };
        }
      }
    });

    // Start Task A
    const promiseA = dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/taskA.jpg' });

    // Start Task B while Task A is in flight
    const promiseB = dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/taskB.jpg' });

    // Complete Task B first (early completion)
    await new Promise(r => setTimeout(r, 10));
    taskBResolve();
    const resB = await promiseB;
    assert.strictEqual(resB.success, true);
    const blobB = resB.blobUrl;
    assert.strictEqual(createdBlobs.has(blobB), true);

    // Release Task B while Task A is still pending completion
    await dispatchMessage({ action: 'REVOKE_BLOB_URL', blobUrl: blobB });
    assert.strictEqual(revokedBlobs.has(blobB), true);

    // Complete Task A (late completion)
    await new Promise(r => setTimeout(r, 10));
    taskAResolve();
    const resA = await promiseA;
    assert.strictEqual(resA.success, true);
    const blobA = resA.blobUrl;

    // Verify Task A's Blob was created and remains intact despite Task B's revocation
    assert.notStrictEqual(blobA, blobB);
    assert.strictEqual(createdBlobs.has(blobA), true);
    assert.strictEqual(revokedBlobs.has(blobA), false, 'Late-completing Task A blob must NOT be revoked by Task B release');

    // Clean up Task A
    await dispatchMessage({ action: 'REVOKE_BLOB_URL', blobUrl: blobA });
    assert.strictEqual(revokedBlobs.has(blobA), true);
  });

  await test('fetchProtectedBlob: handles HTTP 429 rate limit with bounded retry and succeeds on 2nd attempt', async () => {
    let attempt = 0;
    const { sandbox, dispatchMessage } = createTestSandbox({
      fetch: async () => {
        attempt++;
        if (attempt === 1) {
          return {
            status: 429,
            ok: false,
            headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '0' : null }
          };
        }
        return {
          status: 200,
          ok: true,
          headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
          blob: async () => new sandbox.Blob([FIXTURE_BYTES.jpeg], { type: 'image/jpeg' })
        };
      }
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/img.jpg' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(attempt, 2, 'Should retry once on HTTP 429');
  });

  await test('fetchProtectedBlob: fails truthfully if HTTP 429 persists on second attempt', async () => {
    let attempt = 0;
    const { dispatchMessage } = createTestSandbox({
      fetch: async () => {
        attempt++;
        return {
          status: 429,
          ok: false,
          headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '0' : null }
        };
      }
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/img.jpg' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 429);
    assert.strictEqual(attempt, 2, 'Should not exceed 2 total attempts');
  });

  await test('fetchProtectedBlob: external AbortSignal cancels stream transfer and executes reader.cancel()', async () => {
    let readerCancelled = false;
    const extController = new AbortController();

    const { sandbox } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}), // Stalled forever
            cancel: async () => { readerCancelled = true; }
          })
        }
      })
    });

    const fetchPromise = sandbox.fetchProtectedBlob('https://oimages.anime-pictures.net/img.jpg', {
      signal: extController.signal
    });

    setTimeout(() => {
      extController.abort(new Error('User cancelled'));
    }, 10);

    const res = await fetchPromise;
    assert.strictEqual(res.success, false);
    assert.strictEqual(readerCancelled, true, 'Stream reader must be cancelled on abort');
    assert.match(res.error, /cancelled|aborted/i);
  });

  await test('fetchProtectedBlob: stream inactivity stall timeout aborts transfer and cleans up reader', async () => {
    let readerCancelled = false;
    const origSetTimeout = setTimeout;

    const { sandbox } = createTestSandbox({
      __INACTIVITY_TIMEOUT_MS: 30, // Accelerated test timeout
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        body: {
          getReader: () => ({
            read: () => new Promise((resolve) => {
              // Simulates stall: never returns chunk
            }),
            cancel: async () => { readerCancelled = true; }
          })
        }
      })
    });

    const res = await sandbox.fetchProtectedBlob('https://oimages.anime-pictures.net/stalled.jpg');
    assert.strictEqual(res.success, false);
    assert.strictEqual(readerCancelled, true, 'Stalled reader must be cancelled on inactivity timeout');
    assert.match(res.error, /Transfer stalled/i);
  });

  await test('fetchProtectedBlob: total body timeout limit (600s) aborts transfer and cleans up reader', async () => {
    let readerCancelled = false;

    const { sandbox } = createTestSandbox({
      __TOTAL_BODY_TIMEOUT_MS: 50, // Accelerated test timeout
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        body: {
          getReader: () => ({
            read: () => new Promise((resolve) => {
              // Keeps sending small chunks every 20ms so inactivity timeout (60s) never triggers,
              // but total transfer time exceeds total body timeout ceiling (50ms)
              setTimeout(() => {
                resolve({ done: false, value: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]) });
              }, 20);
            }),
            cancel: async () => { readerCancelled = true; }
          })
        }
      })
    });

    const res = await sandbox.fetchProtectedBlob('https://oimages.anime-pictures.net/img.jpg');
    assert.strictEqual(res.success, false);
    assert.strictEqual(readerCancelled, true, 'Reader must be cancelled on total body timeout');
    assert.match(res.error, /Body transfer exceeded total budget/i);
  });

  await test('fetchProtectedBlob: pre-aborted signal aborts immediately without network request', async () => {
    let fetchCalled = false;
    const preAbortedController = new AbortController();
    preAbortedController.abort(new Error('Pre-aborted'));

    const { sandbox } = createTestSandbox({
      fetch: async () => {
        fetchCalled = true;
        throw new Error('Fetch should not have been called');
      }
    });

    const res = await sandbox.fetchProtectedBlob('https://oimages.anime-pictures.net/img.jpg', {
      signal: preAbortedController.signal
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(fetchCalled, false, 'Pre-aborted fetch must reject before network request');
    assert.match(res.error, /Pre-aborted/i);
  });

  await test('fetchProtectedBlob: removes external abort listener on failure as well as success', async () => {
    const extController = new AbortController();
    let listenerCount = 0;
    const origAdd = extController.signal.addEventListener.bind(extController.signal);
    const origRemove = extController.signal.removeEventListener.bind(extController.signal);
    extController.signal.addEventListener = (evt, fn, opts) => {
      if (evt === 'abort') listenerCount++;
      return origAdd(evt, fn, opts);
    };
    extController.signal.removeEventListener = (evt, fn, opts) => {
      if (evt === 'abort') listenerCount--;
      return origRemove(evt, fn, opts);
    };

    const { sandbox } = createTestSandbox({
      fetch: async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: { get: () => 'text/plain' }
      })
    });

    const res = await sandbox.fetchProtectedBlob('https://oimages.anime-pictures.net/forbidden.jpg', {
      signal: extController.signal
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(listenerCount, 0, 'options.signal abort listener must be cleaned up on fetch failure');
  });

  // ---------------------------------------------------------------------------
  // Suite 5: Confirmed-animation conversion cleanup & budgets
  // ---------------------------------------------------------------------------
  console.log('\n--- Suite 5: Confirmed-Animation Conversion Cleanup & Budgets ---');

  await test('convertXTweetVideoToGif: converts synthetic frames to genuine looping GIF', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox();
    const f1 = new Uint8Array(400); // 10x10 RGBA
    const f2 = new Uint8Array(400);
    f2[0] = 255; // Distinguishable frame

    const res = await sandbox.convertXTweetVideoToGif('https://video.twimg.com/tweet_video/test.mp4', {
      frames: [f1, f2],
      width: 10,
      height: 10,
      duration: 0.1
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.contentType, 'image/gif');
    assert.strictEqual(res.frames, 2);
    assert.strictEqual(createdBlobs.has(res.blobUrl), true);
  });

  await test('convertRedditVideoToGif: converts confirmed Reddit animation to genuine looping GIF', async () => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox();
    const f1 = new Uint8Array(400);
    const f2 = new Uint8Array(400);
    f2[1] = 255;

    const res = await sandbox.convertRedditVideoToGif('https://v.redd.it/test.mp4', {
      frames: [f1, f2],
      width: 10,
      height: 10,
      duration: 0.1
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.contentType, 'image/gif');
    assert.strictEqual(res.frames, 2);
    assert.strictEqual(createdBlobs.has(res.blobUrl), true);
  });

  await test('convertMp4VideoToGif: frame budget limit (maxFrames: 150) throws FRAME_COUNT_EXCEEDED', async () => {
    const { sandbox } = createTestSandbox();
    const frames = new Array(151).fill(new Uint8Array(400));
    await assert.rejects(
      async () => {
        await sandbox.convertXTweetVideoToGif('https://video.twimg.com/test.mp4', {
          frames,
          width: 10,
          height: 10,
          maxFrames: 150
        });
      },
      /FRAME_COUNT_EXCEEDED/
    );
  });

  await test('convertMp4VideoToGif: duration budget limit (maxDurationSec: 15.0s) throws DURATION_EXCEEDED', async () => {
    const { sandbox } = createTestSandbox();
    const f1 = new Uint8Array(400);
    const f2 = new Uint8Array(400);
    await assert.rejects(
      async () => {
        await sandbox.convertXTweetVideoToGif('https://video.twimg.com/test.mp4', {
          frames: [f1, f2],
          width: 10,
          height: 10,
          duration: 15.5,
          maxDuration: 15.0
        });
      },
      /DURATION_EXCEEDED/
    );
  });

  await test('convertMp4VideoToGif: size budget limit (maxSizeBytes) throws SIZE_EXCEEDED', async () => {
    const { sandbox } = createTestSandbox();
    const f1 = new Uint8Array(400);
    const f2 = new Uint8Array(400);
    await assert.rejects(
      async () => {
        await sandbox.convertXTweetVideoToGif('https://video.twimg.com/test.mp4', {
          frames: [f1, f2],
          width: 10,
          height: 10,
          duration: 0.1,
          maxSizeBytes: 10 // impossibly small 10-byte cap
        });
      },
      /SIZE_EXCEEDED/
    );
  });

  await test('convertMp4VideoToGif: oversized input cancellation or truncated MP4 never authorizes a direct save', async () => {
    for (const cancel of [true, false]) {
      const controller = new AbortController();
      let reads = 0;
      let cancels = 0;
      const { sandbox, createdBlobs, createdVideos, createdCanvases } = createTestSandbox({
        fetch: async () => ({
          ok: true, status: 200,
          headers: { get: () => String(50 * 1024 * 1024 + 1) },
          body: { getReader: () => ({
            read: async () => {
              if (reads++) return { done: true };
              if (cancel) controller.abort();
              return { done: false, value: FIXTURE_BYTES.mp4.slice(0, 12) };
            },
            cancel: async () => { cancels++; }
          }) }
        })
      });
      await assert.rejects(() => sandbox.convertRedditVideoToGif('https://preview.redd.it/animation.gif?format=mp4&s=exact', { signal: controller.signal }), cancel ? /CONVERSION_CANCELLED/ : /Invalid MP4/);
      assert.strictEqual(cancels, 1);
      assert.strictEqual(createdBlobs.size, 0);
      assert.strictEqual(createdVideos.length, 0);
      assert.strictEqual(createdCanvases.length, 0);
    }
  });

  await test('convertMp4VideoToGif: oversized corrupt encoder output stays a conversion error', async () => {
    const bytes = new Uint8Array(15 * 1024 * 1024 + 1);
    const { sandbox, createdBlobs } = createTestSandbox({
      gifenc: { ...gifenc, GIFEncoder: () => ({ writeFrame() {}, finish() {}, bytes: () => bytes }) }
    });
    await assert.rejects(() => sandbox.convertXTweetVideoToGif('https://video.twimg.com/tweet_video/test.mp4', {
      frames: [new Uint8Array(400), new Uint8Array(400)], width: 10, height: 10, duration: 0.1
    }), /CORRUPTED_OUTPUT/);
    assert.strictEqual(createdBlobs.size, 0);
  });

  await test('convertMp4VideoToGif: total operational budget timeout (45s) aborts conversion and cleans up resources', async () => {
    const { sandbox, createdVideos, createdCanvases } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.mp4], { type: 'video/mp4' })
      })
    });

    const extController = new AbortController();
    let listenerCount = 0;
    const origAdd = extController.signal.addEventListener.bind(extController.signal);
    const origRemove = extController.signal.removeEventListener.bind(extController.signal);
    extController.signal.addEventListener = (evt, fn, opts) => {
      if (evt === 'abort') listenerCount++;
      return origAdd(evt, fn, opts);
    };
    extController.signal.removeEventListener = (evt, fn, opts) => {
      if (evt === 'abort') listenerCount--;
      return origRemove(evt, fn, opts);
    };

    // Make mock video stall so conversion exceeds totalTimeoutMs (50ms)
    const origCreateElement = sandbox.document.createElement.bind(sandbox.document);
    sandbox.document.createElement = (tag) => {
      const el = origCreateElement(tag);
      if (tag === 'video') {
        el._manual = true; // Never fires loadedmetadata, simulating stalled decoder
      }
      return el;
    };

    await assert.rejects(
      async () => {
        await sandbox.convertXTweetVideoToGif('https://video.twimg.com/test.mp4', {
          totalTimeoutMs: 50,
          signal: extController.signal
        });
      },
      /TIMEOUT: GIF conversion exceeded operational budget/
    );

    assert.strictEqual(listenerCount, 0, 'options.signal abort listener must be cleaned up on timeout');
    if (createdVideos.length > 0) {
      assert.strictEqual(createdVideos[0].src, '', 'Video element source must be unloaded on timeout');
      assert.strictEqual(createdVideos[0].loadCalls > 0, true, 'video.load() must be called to release decoder');
    }
  });

  await test('convertMp4VideoToGif: mocked DOM video success path cleans up video, canvas, and signal listeners', async () => {
    const { sandbox, createdVideos, createdCanvases } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.mp4], { type: 'video/mp4' })
      })
    });

    const extController = new AbortController();
    let listenerCount = 0;
    const origAdd = extController.signal.addEventListener.bind(extController.signal);
    const origRemove = extController.signal.removeEventListener.bind(extController.signal);
    extController.signal.addEventListener = (evt, fn, opts) => {
      if (evt === 'abort') listenerCount++;
      return origAdd(evt, fn, opts);
    };
    extController.signal.removeEventListener = (evt, fn, opts) => {
      if (evt === 'abort') listenerCount--;
      return origRemove(evt, fn, opts);
    };

    const res = await sandbox.convertXTweetVideoToGif('https://video.twimg.com/test.mp4', {
      signal: extController.signal
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.contentType, 'image/gif');
    assert.strictEqual(listenerCount, 0, 'Abort listener must be removed after DOM conversion success');
    assert.strictEqual(createdVideos.length, 1);
    assert.strictEqual(createdVideos[0].src, '', 'video.src must be cleared to release decoder');
    assert.strictEqual(createdVideos[0].loadCalls > 0, true, 'video.load() must be called in finally');
    assert.strictEqual(createdCanvases.length, 1);
    assert.strictEqual(createdCanvases[0].width, 0, 'canvas.width must be reset to 0');
    assert.strictEqual(createdCanvases[0].height, 0, 'canvas.height must be reset to 0');
  });

  await test('convertMp4VideoToGif: mocked DOM video error path unloads video decoder, resets canvas, and removes signal listener', async () => {
    const { sandbox, createdVideos, createdCanvases } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.mp4], { type: 'video/mp4' })
      })
    });

    const extController = new AbortController();
    let listenerCount = 0;
    const origAdd = extController.signal.addEventListener.bind(extController.signal);
    const origRemove = extController.signal.removeEventListener.bind(extController.signal);
    extController.signal.addEventListener = (evt, fn, opts) => {
      if (evt === 'abort') listenerCount++;
      return origAdd(evt, fn, opts);
    };
    extController.signal.removeEventListener = (evt, fn, opts) => {
      if (evt === 'abort') listenerCount--;
      return origRemove(evt, fn, opts);
    };

    // Video createElement override that triggers an error event on load
    const origCreateElement = sandbox.document.createElement.bind(sandbox.document);
    sandbox.document.createElement = (tag) => {
      const el = origCreateElement(tag);
      if (tag === 'video') {
        el._manual = true;
        setTimeout(() => {
          el.dispatchEvent(new Event('error'));
        }, 10);
      }
      return el;
    };

    await assert.rejects(
      async () => {
        await sandbox.convertXTweetVideoToGif('https://video.twimg.com/test.mp4', {
          signal: extController.signal
        });
      },
      /Video element failed to load source/i
    );

    assert.strictEqual(listenerCount, 0, 'Abort listener must be removed after DOM conversion error');
    assert.strictEqual(createdVideos.length, 1);
    assert.strictEqual(createdVideos[0].src, '', 'video.src must be cleared on video error');
    assert.strictEqual(createdVideos[0].loadCalls > 0, true, 'video.load() must be called on error');
  });

  await test('convertMp4VideoToGif: mocked DOM cancellation path aborts mid-conversion, cleans up video, canvas, and removes signal listener', async () => {
    const { sandbox, createdVideos, createdCanvases } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        blob: async () => new sandbox.Blob([FIXTURE_BYTES.mp4], { type: 'video/mp4' })
      })
    });

    const extController = new AbortController();
    let listenerCount = 0;
    const origAdd = extController.signal.addEventListener.bind(extController.signal);
    const origRemove = extController.signal.removeEventListener.bind(extController.signal);
    extController.signal.addEventListener = (evt, fn, opts) => {
      if (evt === 'abort') listenerCount++;
      return origAdd(evt, fn, opts);
    };
    extController.signal.removeEventListener = (evt, fn, opts) => {
      if (evt === 'abort') listenerCount--;
      return origRemove(evt, fn, opts);
    };

    // Video createElement that aborts external controller during metadata event
    const origCreateElement = sandbox.document.createElement.bind(sandbox.document);
    sandbox.document.createElement = (tag) => {
      const el = origCreateElement(tag);
      if (tag === 'video') {
        el._manual = true;
        setTimeout(() => {
          extController.abort(new Error('User cancelled conversion'));
          el.dispatchEvent('loadedmetadata');
        }, 10);
      }
      return el;
    };

    await assert.rejects(
      async () => {
        await sandbox.convertXTweetVideoToGif('https://video.twimg.com/test.mp4', {
          signal: extController.signal
        });
      },
      /cancelled/i
    );

    assert.strictEqual(listenerCount, 0, 'Abort listener must be removed after cancellation');
    assert.strictEqual(createdVideos.length, 1);
    assert.strictEqual(createdVideos[0].src, '', 'video.src must be cleared on cancellation');
    assert.strictEqual(createdVideos[0].loadCalls > 0, true, 'video.load() must be called on cancellation');
  });

  await test('convertMp4VideoToGif: rejects video source with non-MP4 container bytes (HTML error)', async () => {
    const { sandbox } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        blob: async () => new sandbox.Blob(['<!DOCTYPE html><html><body>Error</body></html>'], { type: 'video/mp4' })
      })
    });

    await assert.rejects(
      async () => {
        await sandbox.convertXTweetVideoToGif('https://video.twimg.com/test.mp4');
      },
      /Invalid MP4 container bytes/
    );
  });

  test('calculateGifFrameDelays: diffuses rounding error without cumulative timing drift', () => {
    const { sandbox } = createTestSandbox();
    const delays = sandbox.calculateGifFrameDelays(3.0, 45); // 3 seconds, 45 frames
    assert.strictEqual(delays.length, 45);
    const totalDelaysMs = delays.reduce((a, b) => a + b, 0);
    assert.strictEqual(Math.round(totalDelaysMs / 1000), 3, 'Total delay must equal 3 seconds without drift');
  });

  // ---------------------------------------------------------------------------
  // Suite 6: Security and MV3 message boundaries
  // ---------------------------------------------------------------------------
  console.log('\n--- Suite 6: Security and MV3 Message Boundaries ---');

  await test('message handler: rejects unauthorized sender with UNAUTHORIZED_SENDER', async () => {
    const { dispatchMessage } = createTestSandbox();
    const res = await dispatchMessage(
      { action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/img.jpg' },
      { id: 'foreign-extension-attacker-id' }
    );
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'UNAUTHORIZED_SENDER');
  });

  await test('offscreen IPC: content/page/missing senders cannot start any privileged command', async () => {
    let calls = 0;
    const { dispatchMessage, createdBlobs, revokedBlobs, createdVideos, createdCanvases } = createTestSandbox({ fetch: async () => { calls++; throw Error('unexpected fetch'); }, __REDDIT_HLS_LOADER: async () => { calls++; throw Error('unexpected loader'); } });
    const own = 'image-saver-test-extension-id';
    const senders = [{}, { id: 'foreign' }, { id: own, tab: { id: 7 }, url: 'https://example.org/' }, { id: own, url: `chrome-extension://${own}/popup/popup.html` }, { id: own, url: `chrome-extension://${own}/offscreen.html` }];
    const commands = ['FETCH_GELBOORU_BLOB', 'FETCH_PROTECTED_BLOB', 'REVOKE_BLOB_URL', 'CONVERT_X_TWEET_VIDEO_TO_GIF', 'CONVERT_REDDIT_VIDEO_TO_GIF', 'ASSEMBLE_REDDIT_HLS', 'STAGING_PREPARE', 'STAGING_URL', 'STAGING_REMOVE', 'STAGING_DIRECTORY_EXPORT'];
    for (const sender of senders) for (const action of commands) {
      const reply = await dispatchMessage({ action, url: 'https://oimages.anime-pictures.net/test.jpg', blobUrl: 'blob:chrome-extension://owned/1', frames: [{ rgba: { buffer: [0, 0], constructor: { name: 'Uint8Array' } } }] }, sender);
      assert.strictEqual(reply?.error, 'UNAUTHORIZED_SENDER', action);
    }
    assert.strictEqual(calls, 0); assert.strictEqual(createdBlobs.size, 0); assert.strictEqual(revokedBlobs.size, 0); assert.strictEqual(createdVideos.length, 0); assert.strictEqual(createdCanvases.length, 0);
  });

  await test('offscreen IPC: even a worker cannot submit synthetic conversion fields', async () => {
    let fetches = 0;
    const { dispatchMessage, createdBlobs, createdVideos, createdCanvases } = createTestSandbox({ fetch: async () => { fetches++; throw Error('unexpected fetch'); } });
    for (const action of ['CONVERT_X_TWEET_VIDEO_TO_GIF', 'CONVERT_REDDIT_VIDEO_TO_GIF']) for (const key of ['frames', 'duration', 'width', 'height']) {
      const reply = await dispatchMessage({ action, url: 'https://video.twimg.com/tweet_video/test.mp4', [key]: key === 'frames' ? [{ rgba: { buffer: [0], constructor: { name: 'Uint8Array' } } }] : 999999 });
      assert.strictEqual(reply?.error, 'INVALID_CONVERSION_OPTIONS');
    }
    assert.strictEqual(fetches, 0); assert.strictEqual(createdBlobs.size, 0); assert.strictEqual(createdVideos.length, 0); assert.strictEqual(createdCanvases.length, 0);
    for (const sender of [{ id: 'image-saver-test-extension-id' }, { id: 'image-saver-test-extension-id', url: 'chrome-extension://image-saver-test-extension-id/background.js' }]) {
      assert.strictEqual((await dispatchMessage({ action: 'REVOKE_BLOB_URL', blobUrl: 'blob:owned' }, sender)).success, true);
    }
  });

  // REDDIT-HLS-01: the offscreen action hands the master to the assembly module; only a complete result gets a Blob URL
  await test('ASSEMBLE_REDDIT_HLS: success returns one Blob URL and light metadata; failure keeps the module code and creates no Blob', async () => {
    const calls = [];
    let outcome = 'ok';
    const loader = async () => ({
      assembleRedditHls: async (opts) => {
        calls.push(opts.masterUrl);
        if (outcome === 'ok') return { blob: new Blob([new Uint8Array(7)], { type: 'video/mp4' }), size: 7, durationSec: 1.5, fragments: 2, video: { codec: 'avc1.4d401f' }, audio: { codec: 'mp4a.40.2' } };
        const e = new Error('x'); e.code = outcome; if (outcome === 'HTTP_ERROR') e.status = 403; throw e;
      }
    });
    const { dispatchMessage, createdBlobs } = createTestSandbox({ __REDDIT_HLS_LOADER: loader });
    const url = 'https://v.redd.it/x1/HLSPlaylist.m3u8';
    const ok = await dispatchMessage({ action: 'ASSEMBLE_REDDIT_HLS', url });
    assert.deepStrictEqual([ok.success, ok.contentType, ok.size, ok.duration, ok.fragments], [true, 'video/mp4', 7, 1.5, 2]);
    assert.ok(/^blob:/.test(ok.blobUrl));
    assert.strictEqual(createdBlobs.size, 1);
    assert.deepStrictEqual(calls, [url]);
    for (const code of ['UNSUPPORTED_LAYOUT', 'TOO_LARGE', 'INCOMPLETE', 'BUSY', 'HTTP_ERROR']) {
      outcome = code;
      const bad = await dispatchMessage({ action: 'ASSEMBLE_REDDIT_HLS', url });
      assert.strictEqual(bad.success, false);
      assert.strictEqual(bad.error, code);
      if (code === 'HTTP_ERROR') assert.strictEqual(bad.status, 403);
      assert.strictEqual('blobUrl' in bad, false);
    }
    assert.strictEqual(createdBlobs.size, 1, 'no Blob for a failed assembly');
    const none = await dispatchMessage({ action: 'ASSEMBLE_REDDIT_HLS' });
    assert.deepStrictEqual([none.success, none.error], [false, 'FOREIGN_SOURCE']);
    assert.strictEqual(calls.length, 6);
  });

  await test('ASSEMBLE_REDDIT_HLS: unauthorized sender refused; an unloadable or crashing module is a fixed code', async () => {
    const { dispatchMessage } = createTestSandbox({ __REDDIT_HLS_LOADER: async () => { throw new Error('secret path D:\\x'); } });
    const bad = await dispatchMessage({ action: 'ASSEMBLE_REDDIT_HLS', url: 'https://v.redd.it/x1/HLSPlaylist.m3u8' }, { id: 'foreign-extension-attacker-id' });
    assert.deepStrictEqual([bad.success, bad.error], [false, 'UNAUTHORIZED_SENDER']);
    const own = await dispatchMessage({ action: 'ASSEMBLE_REDDIT_HLS', url: 'https://v.redd.it/x1/HLSPlaylist.m3u8' });
    assert.deepStrictEqual([own.success, own.error, Object.keys(own).length], [false, 'ASSEMBLE_FAILED', 2]);
  });

  await test('getProtectedHostInfo: strictly allows only anime-pictures and gelbooru domains', () => {
    const { sandbox } = createTestSandbox();
    assert.notStrictEqual(sandbox.getProtectedHostInfo('https://oimages.anime-pictures.net/img.jpg'), null);
    assert.notStrictEqual(sandbox.getProtectedHostInfo('https://gelbooru.com/img.jpg'), null);
    assert.notStrictEqual(sandbox.getProtectedHostInfo('https://img3.gelbooru.com/img.jpg'), null);

    // Negative boundaries
    assert.strictEqual(sandbox.getProtectedHostInfo('https://evil.com/?oimages.anime-pictures.net'), null);
    assert.strictEqual(sandbox.getProtectedHostInfo('https://oimages.anime-pictures.net.evil.com/img.jpg'), null);
    assert.strictEqual(sandbox.getProtectedHostInfo('https://gelbooru.com.attacker.com/img.jpg'), null);
    assert.strictEqual(sandbox.getProtectedHostInfo('ftp://oimages.anime-pictures.net/img.jpg'), null);
    assert.strictEqual(sandbox.getProtectedHostInfo('javascript:alert(1)'), null);
    assert.strictEqual(sandbox.getProtectedHostInfo(''), null);
    assert.strictEqual(sandbox.getProtectedHostInfo(null), null);
  });

  test('sanitizeUrlForLog: recursively redacts sensitive parameters from URLs and objects', () => {
    const { sandbox } = createTestSandbox();
    const cleanUrl = sandbox.sanitizeUrlForLog('https://img.gelbooru.com/pic.jpg?token=secret123&auth=abc&id=42&sig=deadbeef');
    assert.match(cleanUrl, /token=(?:\[REDACTED\]|%5BREDACTED%5D)/);
    assert.match(cleanUrl, /auth=(?:\[REDACTED\]|%5BREDACTED%5D)/);
    assert.match(cleanUrl, /sig=(?:\[REDACTED\]|%5BREDACTED%5D)/);
    assert.match(cleanUrl, /id=42/);

    const cleanObj = sandbox.sanitizeUrlForLog({
      media: 'https://example.com/file?secret=xyz',
      nested: ['https://example.com/pic?key=pass']
    });
    assert.match(cleanObj.media, /secret=(?:\[REDACTED\]|%5BREDACTED%5D)/);
    assert.match(cleanObj.nested[0], /key=(?:\[REDACTED\]|%5BREDACTED%5D)/);
  });

  // ---------------------------------------------------------------------------
  // Suite 6b: Independent follow-up - BOM/whitespace SVG prefix and truncated ftyp box (real FETCH_PROTECTED_BLOB handler)
  // ---------------------------------------------------------------------------
  console.log('\n--- Suite 6b: BOM/Whitespace SVG Preamble and Truncated ftyp Box ---');

  const fetchBytesViaHandler = async (bytes, mime) => {
    const { sandbox, dispatchMessage, createdBlobs } = createTestSandbox({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? mime : null },
        blob: async () => new sandbox.Blob([bytes], { type: mime })
      })
    });
    const res = await dispatchMessage({ action: 'FETCH_PROTECTED_BLOB', url: 'https://oimages.anime-pictures.net/probe' });
    return { res, createdBlobs, sandbox };
  };

  const longPreamble = '<?xml version="1.0"?>\n<!--' + 'x'.repeat(90) + '-->\n';
  const svgRoot = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
  const bomSvg = Buffer.from('﻿' + longPreamble + svgRoot);
  const wsSvg = Buffer.from('\n  \t' + longPreamble + svgRoot);
  const bomWsSvg = Buffer.from('﻿\r\n ' + longPreamble + svgRoot);

  for (const [label, body] of [['BOM', bomSvg], ['leading whitespace', wsSvg], ['BOM + whitespace', bomWsSvg]]) {
    await test(`fetchProtectedBlob: accepts ${label} SVG with root beyond 64 bytes (image/svg+xml)`, async () => {
      assert.strictEqual(body.indexOf('<svg') > 64, true, 'fixture root must lie beyond the 64-byte prefix');
      const { res, createdBlobs, sandbox } = await fetchBytesViaHandler(body, 'image/svg+xml');
      assert.strictEqual(sandbox.isSvgPayload(body), true);
      assert.strictEqual(res.success, true, res.error);
      assert.strictEqual(res.contentType, 'image/svg+xml');
      assert.strictEqual(res.size, body.length);
      assert.strictEqual(createdBlobs.size, 1);
    });

    await test(`fetchProtectedBlob: corrects image/jpeg to SVG for ${label} SVG with root beyond 64 bytes`, async () => {
      const { res, createdBlobs } = await fetchBytesViaHandler(body, 'image/jpeg');
      assert.strictEqual(res.success, true, res.error);
      assert.strictEqual(res.contentType, 'image/svg+xml');
      assert.strictEqual(createdBlobs.size, 1);
    });
  }

  const htmlRoot = '<html><body>Access blocked</body></html>';
  const errorRoot = '<Error><Code>AccessDenied</Code></Error>';
  const notSvgRoot = '<note><to>x</to></note>';
  for (const size of [4, 64]) {
    await test(`fetchProtectedBlob: rejects a complete ${size}-byte whitespace-only body`, async () => {
      const { res, createdBlobs } = await fetchBytesViaHandler(Buffer.alloc(size, 0x20), 'image/jpeg');
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Rejected non-media payload/i);
      assert.strictEqual(createdBlobs.size, 0);
    });
  }
  await test('fetchProtectedBlob: preserves SVG foreignObject while rejecting an HTML document containing an SVG', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="20" height="20"><body xmlns="http://www.w3.org/1999/xhtml">label</body></foreignObject></svg>';
    const positive = await fetchBytesViaHandler(Buffer.from(' '.repeat(90) + svg), 'image/jpeg');
    assert.strictEqual(positive.res.success, true, positive.res.error);
    assert.strictEqual(positive.res.contentType, 'image/svg+xml');
    assert.strictEqual(positive.createdBlobs.size, 1);
    const negative = await fetchBytesViaHandler(Buffer.from(' '.repeat(90) + '<html><body>' + svg + '</body></html>'), 'image/jpeg');
    assert.strictEqual(negative.res.success, false);
    assert.strictEqual(negative.createdBlobs.size, 0);
  });
  for (const prefix of [' '.repeat(90), '\uFEFF' + ' '.repeat(90)]) {
    await test('fetchProtectedBlob: verifies SVG after a whitespace-only 64-byte prefix', async () => {
      const { res, createdBlobs } = await fetchBytesViaHandler(Buffer.from(prefix + svgRoot), 'image/jpeg');
      assert.strictEqual(res.success, true, res.error);
      assert.strictEqual(res.contentType, 'image/svg+xml');
      assert.strictEqual(createdBlobs.size, 1);
    });
    for (const root of [htmlRoot, errorRoot]) {
      await test('fetchProtectedBlob: refuses error body after a whitespace-only 64-byte prefix', async () => {
        const { res, createdBlobs } = await fetchBytesViaHandler(Buffer.from(prefix + root), 'image/jpeg');
        assert.strictEqual(res.success, false);
        assert.match(res.error, /Rejected non-media payload/i);
        assert.strictEqual(createdBlobs.size, 0);
      });
    }
  }
  await test('fetchProtectedBlob: refuses a whitespace-only inspection window without a verified SVG root', async () => {
    const { res, createdBlobs } = await fetchBytesViaHandler(Buffer.from(' '.repeat(1100) + htmlRoot), 'image/jpeg');
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Rejected non-media payload/i);
    assert.strictEqual(createdBlobs.size, 0);
  });
  for (const [prefixLabel, prefix] of [['BOM', '﻿'], ['leading whitespace', '\n  \t']]) {
    for (const [rootLabel, root] of [['HTML', htmlRoot], ['XML error', errorRoot], ['non-SVG XML root', notSvgRoot]]) {
      for (const mime of ['image/svg+xml', 'image/jpeg']) {
        await test(`fetchProtectedBlob: rejects ${prefixLabel} + long preamble + ${rootLabel} under ${mime} with 0 Blob leaks`, async () => {
          const { res, createdBlobs } = await fetchBytesViaHandler(Buffer.from(prefix + longPreamble + root), mime);
          assert.strictEqual(res.success, false);
          assert.match(res.error, /Rejected non-media payload/i);
          assert.strictEqual(createdBlobs.size, 0);
        });
      }
    }
  }

  await test('sniffMediaMagicBytes: 64-byte binary contract unchanged (JPEG/PNG with whitespace-like later bytes, whitespace-led non-XML)', () => {
    const { sandbox } = createTestSandbox();
    assert.strictEqual(sandbox.sniffMediaMagicBytes(FIXTURE_BYTES.jpeg), 'image/jpeg');
    assert.strictEqual(sandbox.sniffMediaMagicBytes(FIXTURE_BYTES.png), 'image/png');
    assert.strictEqual(sandbox.sniffMediaMagicBytes(Buffer.from('  \n  {"a":1}')), null);
    assert.strictEqual(sandbox.sniffMediaMagicBytes(Buffer.from('    \n\n\t\t  ')), null);
  });

  const ftypBox = (size, major, ...compat) => {
    const b = Buffer.alloc(Math.max(size, 16));
    b.writeUInt32BE(size, 0);
    b.write('ftyp', 4, 'latin1');
    b.write(major, 8, 'latin1');
    compat.forEach((c, i) => { if (16 + i * 4 + 4 <= b.length) b.write(c, 16 + i * 4, 'latin1'); });
    return b;
  };
  const freeBox = () => { const b = Buffer.alloc(8); b.writeUInt32BE(8, 0); b.write('free', 4, 'latin1'); return b; };
  const truncatedFtyp = Buffer.from([0, 0, 0, 32, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);

  await test('isMalformedMediaContainer: complete body shorter than declared ftyp box is malformed; bounded prefix of a large body is not', () => {
    const { sandbox } = createTestSandbox();
    assert.strictEqual(sandbox.isMalformedMediaContainer(truncatedFtyp, truncatedFtyp.length), true);
    // Same 20-byte prefix, but the complete body is large enough to hold the declared box: stays accepted.
    assert.strictEqual(sandbox.isMalformedMediaContainer(truncatedFtyp, 4096), false);
    assert.strictEqual(sandbox.isMalformedMediaContainer(truncatedFtyp), false, 'unknown total size must not reject');
    // Padding box before ftyp: box end is offset + size.
    const padded = Buffer.concat([freeBox(), truncatedFtyp]);
    assert.strictEqual(sandbox.isMalformedMediaContainer(padded, padded.length), true);
    assert.strictEqual(sandbox.isMalformedMediaContainer(padded, 8 + 32 - 1), true);
    assert.strictEqual(sandbox.isMalformedMediaContainer(padded, 8 + 32), false);
  });

  for (const mime of ['video/mp4', 'image/jpeg']) {
    await test(`fetchProtectedBlob: rejects complete 20-byte body declaring a 32-byte ftyp under ${mime} with 0 Blob leaks`, async () => {
      const { res, createdBlobs } = await fetchBytesViaHandler(truncatedFtyp, mime);
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Received malformed media container/i);
      assert.strictEqual(createdBlobs.size, 0);
    });

    await test(`fetchProtectedBlob: rejects ftyp truncated after free padding under ${mime} with 0 Blob leaks`, async () => {
      const { res, createdBlobs } = await fetchBytesViaHandler(Buffer.concat([freeBox(), truncatedFtyp]), mime);
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Received malformed media container/i);
      assert.strictEqual(createdBlobs.size, 0);
    });
  }

  await test('fetchProtectedBlob: accepts valid MP4 whose ftyp box fits exactly, with and without free padding', async () => {
    const plain = ftypBox(32, 'isom', 'isom', 'mp42');
    const padded = Buffer.concat([freeBox(), ftypBox(32, 'isom', 'isom', 'mp42')]);
    for (const body of [plain, padded]) {
      const { res, createdBlobs } = await fetchBytesViaHandler(body, 'video/mp4');
      assert.strictEqual(res.success, true, res.error);
      assert.strictEqual(res.contentType, 'video/mp4');
      assert.strictEqual(createdBlobs.size, 1);
    }
  });

  await test('fetchProtectedBlob: accepts large MP4 body (ftyp prefix is a short bounded prefix) and corrects image/jpeg MIME', async () => {
    const body = Buffer.concat([ftypBox(32, 'isom', 'isom', 'mp42'), Buffer.alloc(4096, 1)]);
    for (const mime of ['video/mp4', 'image/jpeg']) {
      const { res, createdBlobs } = await fetchBytesViaHandler(body, mime);
      assert.strictEqual(res.success, true, res.error);
      assert.strictEqual(res.contentType, 'video/mp4');
      assert.strictEqual(createdBlobs.size, 1);
    }
  });

  await test('fetchProtectedBlob: preserves AVIF major and compatible brands that fit their declared ftyp box', async () => {
    const major = ftypBox(24, 'avif', 'mif1', 'avif');
    const viaCompat = Buffer.concat([ftypBox(32, 'mif1', 'miaf', 'avif'), Buffer.alloc(64, 2)]);
    for (const body of [major, viaCompat]) {
      const { res, createdBlobs } = await fetchBytesViaHandler(body, 'image/jpeg');
      assert.strictEqual(res.success, true, res.error);
      assert.strictEqual(res.contentType, 'image/avif');
      assert.strictEqual(createdBlobs.size, 1);
    }
  });

  // ---------------------------------------------------------------------------
  // Suite 7: Real local HTTP fixture on wire (finite deterministic server)
  // ---------------------------------------------------------------------------
  console.log('\n--- Suite 7: Real Local HTTP Fixture on Wire (Finite Deterministic Server) ---');

  const fixtureServer = createOffscreenTestServer();
  const serverInfo = await fixtureServer.start();
  console.log(`  (Started ephemeral test HTTP fixture on 127.0.0.1:${serverInfo.port})`);

  try {
    const createWireSandbox = () => {
      return createTestSandbox({
        fetch: async (url, opts) => {
          const parsed = new URL(url);
          const mappedUrl = serverInfo.urlFor(parsed.pathname);
          const httpResp = await fetch(mappedUrl, opts);
          return httpResp;
        }
      });
    };

    await test('Wire fixture: chunked streaming JPEG accumulated and verified over wire', async () => {
      const { sandbox, dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/chunked-stream'
      });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.contentType, 'image/jpeg');
      assert.strictEqual(res.size, FIXTURE_BYTES.jpeg.length);
      assert.strictEqual(createdBlobs.size, 1);
    });

    await test('Wire fixture: valid SVG downloaded and verified over wire', async () => {
      const { sandbox, dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/valid.svg'
      });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.contentType, 'image/svg+xml');
      assert.strictEqual(res.size, FIXTURE_BYTES.svg.length);
      assert.strictEqual(createdBlobs.size, 1);
    });

    await test('Wire fixture: rejects misleading SVG HTML over wire with 0 Blob leaks', async () => {
      const { sandbox, dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/misleading-svg-html'
      });
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Rejected non-media payload/i);
      assert.strictEqual(createdBlobs.size, 0);
    });

    await test('Wire fixture: rejects malformed ftyp over wire under video/mp4 with 0 Blob leaks', async () => {
      const { sandbox, dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/malformed-ftyp.mp4'
      });
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Received malformed media container/i);
      assert.strictEqual(createdBlobs.size, 0);
    });

    await test('Wire fixture: rejects malformed ftyp over wire under image/jpeg with 0 Blob leaks', async () => {
      const { sandbox, dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/malformed-ftyp.jpg'
      });
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Received malformed media container/i);
      assert.strictEqual(createdBlobs.size, 0);
    });

    await test('Wire fixture: streaming HTTP 403 terminates transport promptly on refusal', async () => {
      fixtureServer.resetStreamStats();
      const { sandbox, dispatchMessage } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/slow-stream-403'
      });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.status, 403);

      // Wait 60ms to verify no trailing chunks keep streaming
      await new Promise(r => setTimeout(r, 60));
      const stats = fixtureServer.getStreamStats().stream403;
      assert.strictEqual(stats.clientClosed, true, 'Client socket must close promptly upon HTTP 403 refusal');
      assert.strictEqual(stats.bytesSent <= 2048, true, `Bytes sent should stop immediately (got ${stats.bytesSent})`);
    });

    await test('Wire fixture: streaming HTTP 200 text/html terminates transport promptly on refusal', async () => {
      fixtureServer.resetStreamStats();
      const { sandbox, dispatchMessage } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/slow-stream-html'
      });
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Rejected non-image Content-Type/i);

      // Wait 60ms to verify no trailing chunks keep streaming
      await new Promise(r => setTimeout(r, 60));
      const stats = fixtureServer.getStreamStats().streamHtml;
      assert.strictEqual(stats.clientClosed, true, 'Client socket must close promptly upon text/html refusal');
      assert.strictEqual(stats.bytesSent <= 2048, true, `Bytes sent should stop immediately (got ${stats.bytesSent})`);
    });

    await test('Wire fixture: streaming HTTP 429 closes first response body promptly before retry', async () => {
      fixtureServer.resetStreamStats();
      const { sandbox, dispatchMessage } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/slow-stream-429'
      });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.status, 429);

      // Wait 60ms to verify no trailing chunks keep streaming
      await new Promise(r => setTimeout(r, 60));
      const stats = fixtureServer.getStreamStats().stream429;
      assert.strictEqual(stats.clientClosed, true, 'Client socket must close promptly upon 429 refusal');
      assert.strictEqual(stats.bytesSent <= 4096, true, `Bytes sent should stop immediately (got ${stats.bytesSent})`);
    });

    await test('Wire fixture: rejects HTTP 200 masquerading HTML over wire with 0 Blob leaks', async () => {
      const { sandbox, dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/masquerading-html'
      });
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Rejected non-media payload/i);
      assert.strictEqual(createdBlobs.size, 0);
    });

    await test('Wire fixture: rejects HTTP 200 masquerading JSON over wire with 0 Blob leaks', async () => {
      const { sandbox, dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/masquerading-json'
      });
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Rejected non-media payload/i);
      assert.strictEqual(createdBlobs.size, 0);
    });

    await test('Wire fixture: rejects HTTP 200 masquerading 404 text over wire with 0 Blob leaks', async () => {
      const { sandbox, dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/masquerading-text'
      });
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Rejected non-media payload/i);
      assert.strictEqual(createdBlobs.size, 0);
    });

    await test('Wire fixture: rejects truncated 2-byte body over wire with 0 Blob leaks', async () => {
      const { sandbox, dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/truncated.jpg'
      });
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Received truncated media body/i);
      assert.strictEqual(createdBlobs.size, 0);
    });

    await test('Wire fixture: HTTP 429 rate limit retried over wire and succeeds on 2nd attempt', async () => {
      fixtureServer.resetRateLimit();
      const { sandbox, dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/rate-limit-retry'
      });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.contentType, 'image/jpeg');
      assert.strictEqual(createdBlobs.size, 1);
    });

    // ---------------------------------------------------------------------------
    // Suite 8: Protected Body Byte Ceiling & Resource Bounds
    // ---------------------------------------------------------------------------
    console.log('\n--- Suite 8: Protected Body Byte Ceiling & Resource Bounds ---');

    await test('fetchProtectedBlob: rejects excessive declared Content-Length before streaming with 0 Blob leaks', async () => {
      let readCalled = false;
      let cancelCalled = false;
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => {
            if (h.toLowerCase() === 'content-type') return 'image/jpeg';
            if (h.toLowerCase() === 'content-length') return '1000';
            return null;
          }
        },
        body: {
          getReader: () => ({
            read: async () => { readCalled = true; return { done: true }; },
            cancel: async () => { cancelCalled = true; }
          })
        }
      });

      const { dispatchMessage, createdBlobs } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/test.jpg',
        options: { maxBodyBytes: 100 }
      });

      assert.strictEqual(res.success, false);
      assert.match(res.error, /Protected body size exceeds budget/i);
      assert.strictEqual(readCalled, false, 'Should reject on headers before reading stream');
      assert.strictEqual(cancelCalled, true, 'Discarded body should be cancelled');
      assert.strictEqual(createdBlobs.size, 0, 'Zero Blob URLs created on rejection');
    });

    await test('fetchProtectedBlob: rejects untrusted small declared Content-Length when actual stream crosses budget', async () => {
      const chunk1 = Buffer.alloc(60, 0x41);
      chunk1[0] = 0xFF; chunk1[1] = 0xD8; chunk1[2] = 0xFF; chunk1[3] = 0xE0;
      const chunk2 = Buffer.alloc(60, 0x42);
      let cancelCalled = false;
      let readCount = 0;

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => {
            if (h.toLowerCase() === 'content-type') return 'image/jpeg';
            if (h.toLowerCase() === 'content-length') return '10'; // Untrusted small declared length!
            return null;
          }
        },
        body: {
          getReader: () => ({
            read: async () => {
              readCount++;
              if (readCount === 1) return { done: false, value: new Uint8Array(chunk1) };
              if (readCount === 2) return { done: false, value: new Uint8Array(chunk2) };
              return { done: true };
            },
            cancel: async () => { cancelCalled = true; }
          })
        }
      });

      const { dispatchMessage, createdBlobs } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/test.jpg',
        options: { maxBodyBytes: 100 }
      });

      assert.strictEqual(res.success, false);
      assert.match(res.error, /Protected body size exceeds budget/i);
      assert.strictEqual(cancelCalled, true, 'Reader should be cancelled upon budget overflow');
      assert.strictEqual(createdBlobs.size, 0, 'Zero Blob URLs created');
    });

    await test('fetchProtectedBlob: rejects chunked stream crossing budget without Content-Length header', async () => {
      const chunk1 = Buffer.alloc(60, 0x41);
      chunk1[0] = 0xFF; chunk1[1] = 0xD8; chunk1[2] = 0xFF; chunk1[3] = 0xE0;
      const chunk2 = Buffer.alloc(60, 0x42);
      let cancelCalled = false;
      let readCount = 0;

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null)
        },
        body: {
          getReader: () => ({
            read: async () => {
              readCount++;
              if (readCount === 1) return { done: false, value: new Uint8Array(chunk1) };
              if (readCount === 2) return { done: false, value: new Uint8Array(chunk2) };
              return { done: true };
            },
            cancel: async () => { cancelCalled = true; }
          })
        }
      });

      const { dispatchMessage, createdBlobs } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/test.jpg',
        options: { maxBodyBytes: 100 }
      });

      assert.strictEqual(res.success, false);
      assert.match(res.error, /Protected body size exceeds budget/i);
      assert.strictEqual(cancelCalled, true);
      assert.strictEqual(createdBlobs.size, 0);
    });

    await test('fetchProtectedBlob: accepts valid media exactly at budget (exact boundary condition)', async () => {
      const exactBytes = Buffer.alloc(50, 0x00);
      FIXTURE_BYTES.jpeg.copy(exactBytes, 0);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => {
            if (h.toLowerCase() === 'content-type') return 'image/jpeg';
            if (h.toLowerCase() === 'content-length') return '50';
            return null;
          }
        },
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true };
                sent = true;
                return { done: false, value: new Uint8Array(exactBytes) };
              },
              cancel: async () => {}
            };
          }
        }
      });

      const { dispatchMessage, createdBlobs } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/test.jpg',
        options: { maxBodyBytes: 50 }
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.size, 50);
      assert.strictEqual(res.contentType, 'image/jpeg');
      assert.strictEqual(createdBlobs.size, 1);
    });

    await test('fetchProtectedBlob G1: streamless response refuses unstreamable body without calling response.blob()', async () => {
      let blobCalled = 0;
      const overflowBlob = new Blob([Buffer.alloc(120, 0x41)], { type: 'image/jpeg' });
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => {
            if (h.toLowerCase() === 'content-type') return 'image/jpeg';
            if (h.toLowerCase() === 'content-length') return '10'; // lying length!
            return null;
          }
        },
        body: null, // No getReader!
        blob: async () => {
          blobCalled++;
          return overflowBlob;
        }
      });

      const { dispatchMessage, createdBlobs, activeTimers } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/test.jpg',
        options: { maxBodyBytes: 100 }
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(blobCalled, 0, 'response.blob() must NEVER be called without a usable reader');
      assert.match(res.error, /ReadableStream reader is required/i);
      assert.strictEqual(createdBlobs.size, 0);
      assert.strictEqual(activeTimers.size, 0, 'Zero timers remaining');
    });

    await test('fetchProtectedBlob G1: missing Content-Length on streamless response refuses without calling blob()', async () => {
      let blobCalled = 0;
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null)
        },
        body: null,
        blob: async () => {
          blobCalled++;
          return new Blob([Buffer.alloc(120, 0x41)], { type: 'image/jpeg' });
        }
      });

      const { dispatchMessage, createdBlobs, activeTimers } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/test.jpg',
        options: { maxBodyBytes: 100 }
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(blobCalled, 0, 'response.blob() must not be called');
      assert.match(res.error, /ReadableStream reader is required/i);
      assert.strictEqual(createdBlobs.size, 0);
      assert.strictEqual(activeTimers.size, 0);
    });

    await test('fetchProtectedBlob G1: default FETCH_PROTECTED_BLOB with missing Content-Length and body:null refuses without calling blob()', async () => {
      let blobCalled = 0;
      const validJpeg120 = Buffer.alloc(120, 0x41);
      validJpeg120[0] = 0xFF; validJpeg120[1] = 0xD8; validJpeg120[2] = 0xFF; validJpeg120[3] = 0xE0;
      validJpeg120[118] = 0xFF; validJpeg120[119] = 0xD9;

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null)
        },
        body: null,
        blob: async () => {
          blobCalled++;
          return new Blob([validJpeg120], { type: 'image/jpeg' });
        }
      });

      const { dispatchMessage, createdBlobs, activeTimers } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/img.jpg'
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(blobCalled, 0, 'response.blob() must not be called');
      assert.match(res.error, /ReadableStream reader is required/i);
      assert.strictEqual(createdBlobs.size, 0);
      assert.strictEqual(activeTimers.size, 0);
    });

    await test('fetchProtectedBlob G1: default FETCH_PROTECTED_BLOB with lying Content-Length: 10 and body:null refuses without calling blob()', async () => {
      let blobCalled = 0;
      const validJpeg120 = Buffer.alloc(120, 0x41);
      validJpeg120[0] = 0xFF; validJpeg120[1] = 0xD8; validJpeg120[2] = 0xFF; validJpeg120[3] = 0xE0;
      validJpeg120[118] = 0xFF; validJpeg120[119] = 0xD9;

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => {
            if (h.toLowerCase() === 'content-type') return 'image/jpeg';
            if (h.toLowerCase() === 'content-length') return '10';
            return null;
          }
        },
        body: null,
        blob: async () => {
          blobCalled++;
          return new Blob([validJpeg120], { type: 'image/jpeg' });
        }
      });

      const { dispatchMessage, createdBlobs, activeTimers } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/img.jpg'
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(blobCalled, 0, 'response.blob() must not be called');
      assert.match(res.error, /ReadableStream reader is required/i);
      assert.strictEqual(createdBlobs.size, 0);
      assert.strictEqual(activeTimers.size, 0);
    });

    await test('fetchProtectedBlob G1: default FETCH_GELBOORU_BLOB with missing Content-Length and body:null refuses without calling blob()', async () => {
      let blobCalled = 0;
      const validJpeg120 = Buffer.alloc(120, 0x41);
      validJpeg120[0] = 0xFF; validJpeg120[1] = 0xD8; validJpeg120[2] = 0xFF; validJpeg120[3] = 0xE0;
      validJpeg120[118] = 0xFF; validJpeg120[119] = 0xD9;

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null)
        },
        body: null,
        blob: async () => {
          blobCalled++;
          return new Blob([validJpeg120], { type: 'image/jpeg' });
        }
      });

      const { dispatchMessage, createdBlobs, activeTimers } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_GELBOORU_BLOB',
        url: 'https://img3.gelbooru.com/img.jpg'
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(blobCalled, 0, 'response.blob() must not be called');
      assert.match(res.error, /ReadableStream reader is required/i);
      assert.strictEqual(createdBlobs.size, 0);
      assert.strictEqual(activeTimers.size, 0);
    });

    await test('fetchProtectedBlob G1: default FETCH_GELBOORU_BLOB with lying Content-Length: 10 and body:null refuses without calling blob()', async () => {
      let blobCalled = 0;
      const validJpeg120 = Buffer.alloc(120, 0x41);
      validJpeg120[0] = 0xFF; validJpeg120[1] = 0xD8; validJpeg120[2] = 0xFF; validJpeg120[3] = 0xE0;
      validJpeg120[118] = 0xFF; validJpeg120[119] = 0xD9;

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => {
            if (h.toLowerCase() === 'content-type') return 'image/jpeg';
            if (h.toLowerCase() === 'content-length') return '10';
            return null;
          }
        },
        body: null,
        blob: async () => {
          blobCalled++;
          return new Blob([validJpeg120], { type: 'image/jpeg' });
        }
      });

      const { dispatchMessage, createdBlobs, activeTimers } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_GELBOORU_BLOB',
        url: 'https://img3.gelbooru.com/img.jpg'
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(blobCalled, 0, 'response.blob() must not be called');
      assert.match(res.error, /ReadableStream reader is required/i);
      assert.strictEqual(createdBlobs.size, 0);
      assert.strictEqual(activeTimers.size, 0);
    });

    await test('fetchProtectedBlob G2: budget validation rejects Infinity and preserves finite bound', async () => {
      let fetchCalled = false;
      const mockFetch = async () => {
        fetchCalled = true;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'image/jpeg' },
          body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) }
        };
      };

      const { sandbox, createdBlobs, activeTimers } = createTestSandbox({
        fetch: mockFetch,
        __DEFAULT_MAX_PROTECTED_BODY_BYTES: 100
      });

      const res = await sandbox.fetchProtectedBlob('https://oimages.anime-pictures.net/test.jpg', {
        maxBodyBytes: Infinity
      });

      assert.strictEqual(res.success, false);
      assert.match(res.error, /INVALID_BODY_BUDGET/i);
      assert.strictEqual(fetchCalled, false, 'Fetch must not be called on invalid budget');
      assert.strictEqual(createdBlobs.size, 0);
      assert.strictEqual(activeTimers.size, 0);
    });

    await test('fetchProtectedBlob G2: budget validation rejects NaN, invalid type, non-positive, and excessive budget', async () => {
      let fetchCalled = false;
      const mockFetch = async () => {
        fetchCalled = true;
        return { ok: true, status: 200, headers: { get: () => 'image/jpeg' } };
      };

      const { sandbox, createdBlobs, activeTimers } = createTestSandbox({ fetch: mockFetch });

      const invalidBudgets = [NaN, '100', null, {}, 0, -1, -500, 1.5, 100 * 1024 * 1024]; // 100 MiB exceeds max allowed 50 MiB
      for (const invalid of invalidBudgets) {
        const res = await sandbox.fetchProtectedBlob('https://oimages.anime-pictures.net/test.jpg', {
          maxBodyBytes: invalid
        });
        assert.strictEqual(res.success, false, `Budget ${invalid} should be rejected`);
        assert.match(res.error, /INVALID_BODY_BUDGET/i);
        assert.strictEqual(fetchCalled, false);
        assert.strictEqual(createdBlobs.size, 0);
        assert.strictEqual(activeTimers.size, 0);
      }
    });

    await test('fetchProtectedBlob G2: preserves exact-boundary success on validated budget', async () => {
      const exactBytes = Buffer.alloc(50, 0x00);
      FIXTURE_BYTES.jpeg.copy(exactBytes, 0);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => {
            if (h.toLowerCase() === 'content-type') return 'image/jpeg';
            if (h.toLowerCase() === 'content-length') return '50';
            return null;
          }
        },
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true };
                sent = true;
                return { done: false, value: new Uint8Array(exactBytes) };
              },
              cancel: async () => {}
            };
          }
        }
      });

      const { sandbox, createdBlobs, activeTimers } = createTestSandbox({ fetch: mockFetch });
      const res = await sandbox.fetchProtectedBlob('https://oimages.anime-pictures.net/test.jpg', {
        maxBodyBytes: 50
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.size, 50);
      assert.strictEqual(createdBlobs.size, 1);
      assert.strictEqual(activeTimers.size, 0);
    });

    await test('fetchProtectedBlob G3: IPC message with options.signal does not forward signal or leak timers', async () => {
      let fetchCalled = false;
      const validBytes = Buffer.alloc(40, 0x41);
      validBytes[0] = 0xFF; validBytes[1] = 0xD8; validBytes[2] = 0xFF; validBytes[3] = 0xE0;
      const mockFetch = async () => {
        fetchCalled = true;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'image/jpeg' },
          body: {
            getReader: () => {
              let sent = false;
              return {
                read: async () => {
                  if (sent) return { done: true };
                  sent = true;
                  return { done: false, value: new Uint8Array(validBytes) };
                },
                cancel: async () => {}
              };
            }
          }
        };
      };

      const { dispatchMessage, createdBlobs, activeTimers } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/test.jpg',
        options: { signal: {}, maxBodyBytes: 100 }
      });

      // IPC ignores options.signal (local-only), respects maxBodyBytes, and leaks zero timers!
      assert.strictEqual(res.success, true);
      assert.strictEqual(fetchCalled, true);
      assert.strictEqual(createdBlobs.size, 1);
      assert.strictEqual(activeTimers.size, 0, 'Zero timers remaining after reply');
    });

    await test('fetchProtectedBlob G3: local function rejects malformed signal before allocating resources', async () => {
      let fetchCalled = false;
      const mockFetch = async () => {
        fetchCalled = true;
        return { ok: true, status: 200, headers: { get: () => 'image/jpeg' } };
      };

      const { sandbox, createdBlobs, activeTimers } = createTestSandbox({ fetch: mockFetch });
      const res = await sandbox.fetchProtectedBlob('https://oimages.anime-pictures.net/test.jpg', {
        signal: {} // Invalid: plain object, not an AbortSignal
      });

      assert.strictEqual(res.success, false);
      assert.match(res.error, /INVALID_SIGNAL/i);
      assert.strictEqual(fetchCalled, false, 'No fetch attempted');
      assert.strictEqual(createdBlobs.size, 0);
      assert.strictEqual(activeTimers.size, 0, 'Zero timers allocated or leaked');
    });

    await test('fetchProtectedBlob G3: IPC message rejects invalid url with zero timers', async () => {
      const { dispatchMessage, activeTimers } = createTestSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: '' // empty url
      });

      assert.strictEqual(res.success, false);
      assert.match(res.error, /INVALID_URL/i);
      assert.strictEqual(activeTimers.size, 0);
    });

    await test('fetchProtectedBlob: slow progressing stream within budget succeeds and resets inactivity timer', async () => {
      const chunk1 = Buffer.alloc(20, 0x41);
      chunk1[0] = 0xFF; chunk1[1] = 0xD8; chunk1[2] = 0xFF; chunk1[3] = 0xE0;
      const chunk2 = Buffer.alloc(20, 0x42);
      let readCount = 0;

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null)
        },
        body: {
          getReader: () => ({
            read: async () => {
              readCount++;
              if (readCount === 1) {
                await new Promise(r => setTimeout(r, 20));
                return { done: false, value: new Uint8Array(chunk1) };
              }
              if (readCount === 2) {
                await new Promise(r => setTimeout(r, 20));
                return { done: false, value: new Uint8Array(chunk2) };
              }
              return { done: true };
            },
            cancel: async () => {}
          })
        }
      });

      const { dispatchMessage, createdBlobs } = createTestSandbox({ fetch: mockFetch });
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/test.jpg',
        options: { maxBodyBytes: 100 }
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.size, 40);
      assert.strictEqual(createdBlobs.size, 1);
    });

    await test('fetchProtectedBlob: task isolation — overflow rejection does not affect concurrent task within budget', async () => {
      const overflowBytes = Buffer.alloc(200, 0xFF);
      overflowBytes[0] = 0xFF; overflowBytes[1] = 0xD8; overflowBytes[2] = 0xFF; overflowBytes[3] = 0xE0;
      const validBytes = Buffer.alloc(40, 0xEE);
      validBytes[0] = 0xFF; validBytes[1] = 0xD8; validBytes[2] = 0xFF; validBytes[3] = 0xE0;

      const mockFetch = async (url) => {
        if (url.includes('overflow')) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h) => {
                if (h.toLowerCase() === 'content-type') return 'image/jpeg';
                if (h.toLowerCase() === 'content-length') return '200';
                return null;
              }
            },
            body: {
              getReader: () => {
                let chunksDelivered = 0;
                return {
                  read: async () => {
                    chunksDelivered++;
                    if (chunksDelivered > 2) return { done: true };
                    return { done: false, value: new Uint8Array(overflowBytes) };
                  },
                  cancel: async () => {}
                };
              }
            }
          };
        }
        return {
          ok: true,
          status: 200,
          headers: {
            get: (h) => {
              if (h.toLowerCase() === 'content-type') return 'image/jpeg';
              if (h.toLowerCase() === 'content-length') return '40';
              return null;
            }
          },
          body: {
            getReader: () => {
              let sent = false;
              return {
                read: async () => {
                  if (sent) return { done: true };
                  sent = true;
                  return { done: false, value: new Uint8Array(validBytes) };
                },
                cancel: async () => {}
              };
            }
          }
        };
      };

      const { dispatchMessage, createdBlobs } = createTestSandbox({ fetch: mockFetch });
      const [resOverflow, resValid] = await Promise.all([
        dispatchMessage({
          action: 'FETCH_PROTECTED_BLOB',
          url: 'https://oimages.anime-pictures.net/overflow.jpg',
          options: { maxBodyBytes: 100 }
        }),
        dispatchMessage({
          action: 'FETCH_PROTECTED_BLOB',
          url: 'https://oimages.anime-pictures.net/valid.jpg',
          options: { maxBodyBytes: 100 }
        })
      ]);

      assert.strictEqual(resOverflow.success, false);
      assert.match(resOverflow.error, /Protected body size exceeds budget/i);
      assert.strictEqual(resValid.success, true);
      assert.strictEqual(resValid.size, 40);
      assert.strictEqual(createdBlobs.size, 1);
      assert.strictEqual(createdBlobs.has(resValid.blobUrl), true);
    });

    await test('Wire fixture: rejects declared Content-Length exceeding budget over wire with 0 Blob leaks', async () => {
      const { dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/declared-overflow.jpg',
        options: { maxBodyBytes: 100 }
      });
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Protected body size exceeds budget/i);
      assert.strictEqual(createdBlobs.size, 0);
    });

    await test('Wire fixture: rejects streaming body exceeding budget over HTTP wire with 0 Blob leaks', async () => {
      fixtureServer.resetStreamStats();
      const { dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/chunked-overflow.jpg',
        options: { maxBodyBytes: 100 }
      });
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Protected body size exceeds budget/i);
      assert.strictEqual(createdBlobs.size, 0);

      // Verify stream on wire terminated promptly
      await new Promise(r => setTimeout(r, 60));
      const stats = fixtureServer.getStreamStats().streamOverflow;
      assert.strictEqual(stats.clientClosed, true, 'Client socket must close on budget overflow');
    });

    await test('Wire fixture: accepts exactly-at-budget streaming media over HTTP wire', async () => {
      const { dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/exact-budget.jpg',
        options: { maxBodyBytes: 50 }
      });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.size, 50);
      assert.strictEqual(res.contentType, 'image/jpeg');
      assert.strictEqual(createdBlobs.size, 1);
    });

    await test('Wire fixture: slow progressing stream over wire succeeds within budget', async () => {
      const { dispatchMessage, createdBlobs } = createWireSandbox();
      const res = await dispatchMessage({
        action: 'FETCH_PROTECTED_BLOB',
        url: 'https://oimages.anime-pictures.net/slow-progress.jpg',
        options: { maxBodyBytes: 100 }
      });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.size, 50);
      assert.strictEqual(res.contentType, 'image/jpeg');
      assert.strictEqual(createdBlobs.size, 1);
    });
  } finally {
    await fixtureServer.stop();
    console.log('  (Cleaned up and stopped ephemeral test HTTP fixture)');
  }


  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n======================================================');
  console.log(`Total tests passed: ${passCount}`);
  console.log(`Total tests failed: ${failCount}`);
  console.log('======================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runAllSuites().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
