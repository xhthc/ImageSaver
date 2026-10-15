// test_pixiv_saving.js - PIXIV-SAVING-POLISH-01: Pixiv originals through the manager's staging (truthful acquisition/errors, exact URL,
// byte/MIME checks, no whole-transfer deadline) and the Reddit/Pixiv author folders (selected-owner binding, safe path component).
// Shapes: the live public answers recorded for https://www.pixiv.net/en/artworks/150807991 (local-notes/checks/pixiv-saving-polish01/
// evidence); other ids/names are synthetic. Mocks prove code paths, not live CDN behavior.
'use strict';
const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
require('../lib/media_sources.js');
require('../offscreen/staging.js');
require('../worker/download_manager.js');
require('../lib/folder_path.js');
const { sniffMediaMagicBytes, isMalformedMediaContainer } = require('../offscreen.js');
const { createTestEnv } = require('./test_context_target_avatar');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e && e.stack || e)); }
}
const png = fs.readFileSync(path.join(__dirname, '..', 'icons/128.png'));
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(64, 1), Buffer.from([0xff, 0xd9])]);
const ID = '150807991', USER = '16741520', NAME = '巴莎卡_R';
const ORIGINAL = `https://i.pximg.net/img-original/img/2026/10/13/18/32/13/${ID}_p0.jpg`;
const MASTER = `https://i.pximg.net/img-master/img/2026/10/13/18/32/13/${ID}_p0_master1200.jpg`;
const THUMB = `https://i.pximg.net/c/250x250_80_a2/custom-thumb/img/2026/10/13/18/32/13/${ID}_p0_custom1200.jpg`;
const ART = `https://www.pixiv.net/en/artworks/${ID}`;

// ---- the manager's production staging (offscreen/staging.js) with a memory directory ----------------------------------------------------
function disk(fetcher) {
  const files = new Map(), requests = [];
  const dir = { getDirectoryHandle: async () => dir, getFileHandle: async (id, { create } = {}) => {
    if (!files.has(id)) { if (!create) throw Object.assign(Error('missing'), { name: 'NotFoundError' }); files.set(id, new Blob()); }
    return { createWritable: async () => { const chunks = []; return { write: async (x) => { chunks.push(x); }, close: async () => files.set(id, new Blob(chunks)), abort: async () => {} }; }, getFile: async () => files.get(id) };
  }, removeEntry: async (id) => { files.delete(id); } };
  const s = MediaLatchStaging.createStaging({ directory: async () => dir, estimate: async () => ({ quota: 1e9, usage: 0 }), origin: 'chrome-extension://test',
    fetch: async (...args) => { requests.push(args); return fetcher(...args); }, sniff: sniffMediaMagicBytes, malformed: isMalformedMediaContainer, url: () => 'blob:x', revoke() {} });
  return { s, files, requests };
}
// a body delivered in chunks with a delay between them (milliseconds, scaled by the shortened timers below)
function slowBody(bytes, parts, gap, signal) {
  let i = 0;
  const size = Math.ceil(bytes.length / parts);
  return new ReadableStream({ async pull(c) {
    if (i >= parts) return c.close();
    await new Promise((r, j) => { const t = setTimeout(r, gap); signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(Error('aborted'), { name: 'AbortError' })); }, { once: true }); });
    c.enqueue(bytes.subarray(i * size, (i + 1) * size)); i++;
  } });
}
// staging's 60 s stall deadline is shortened 1000x for these cases (the code under test is unchanged)
async function withFastTimers(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...a) => real(f, ms >= 60000 ? ms / 1000 : ms, ...a);
  try { return await fn(); } finally { globalThis.setTimeout = real; }
}
const job = (over = {}) => ({ id: 'job-pixiv', source: ORIGINAL + '?sig=EXACT%2Bsig', expectedMime: 'image/jpeg', ...over });

// ---- worker pipeline (background.js in the test VM) ---------------------------------------------------------------------------------
function worker({ head = { status: 200, type: 'image/jpeg', length: String(6554816) }, author = true, illust } = {}) {
  const env = createTestEnv(), s = env.bgSandbox, calls = [], managed = [], failures = [];
  s.TextDecoder = TextDecoder; s.Buffer = Buffer; s.console.info = () => {};
  const illustBody = illust || { error: false, body: { illustId: ID, id: ID, userId: USER, userName: NAME } };
  s.fetch = async (raw, o = {}) => {
    const url = String(raw), method = o.method || 'GET';
    calls.push({ url, method });
    if (url.endsWith(`/ajax/illust/${ID}/pages`)) return new Response(JSON.stringify({ error: false, body: [{ urls: { original: ORIGINAL } }] }), { headers: { 'content-type': 'application/json' } });
    if (/\/ajax\/illust\/\d+$/.test(url)) return new Response(JSON.stringify(illustBody), { headers: { 'content-type': 'application/json' } });
    if (url === ORIGINAL && method === 'GET' && o.headers && o.headers.Range && head !== 'abort') return new Response(null, { status: head.status, headers: { 'content-type': head.type } });
    if (url === ORIGINAL && method === 'HEAD') {
      if (head === 'abort') throw Object.assign(Error('The operation was aborted'), { name: 'AbortError' });
      return new Response(null, { status: head.status, headers: { 'content-type': head.type, 'content-length': head.length } });
    }
    return new Response('not found', { status: 404 });
  };
  s.resolveContextOwner = async () => 'proven';
  // the manager: records what it is asked to acquire and answers like its staging (default: complete)
  s.__managerAnswer = null;
  s.managedDownload = async (options, op, mime, maxBytes) => { managed.push({ url: options.url, mime, maxBytes, filename: options.filename }); if (s.__managerAnswer) throw Error(s.__managerAnswer); return s.chrome.downloads.download(options); };
  const fail = s.fbFail; s.fbFail = async (op, f) => { failures.push(f); return fail(op, f); };
  s.chrome.storage.local.get = async (d) => ({ ...d, pixivAuthorFolders: author, folderOrganizationMode: 'single', subfolder: 'SavedImages' });
  return { env, s, calls, managed, failures, save: (info) => s.onContextMenuClicked({ menuItemId: 'save-image-item', mediaType: 'image', frameId: 0, ...info }, { id: 1, url: info.pageUrl }) };
}

(async () => {
  // ===== 1. acquisition through the manager's staging ================================================================================
  await test('staging: the exact signed Pixiv URL is fetched once with credentials; progress reports receiving, then validating', async () => {
    const x = disk(async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) } })), events = [];
    const r = await x.s.stage(job(), (p) => events.push(p.state));
    assert.deepEqual(r, { size: jpeg.length, mime: 'image/jpeg' });
    assert.equal(x.requests.length, 1);
    assert.equal(x.requests[0][0], ORIGINAL + '?sig=EXACT%2Bsig');
    assert.equal(x.requests[0][1].credentials, 'include');
    assert(events.includes('validating'));
  });
  await test('staging: a slow body that keeps arriving is not cut by a whole-transfer deadline (only a stall is)', async () => {
    await withFastTimers(async () => {
      const x = disk(async (u, o) => new Response(slowBody(jpeg, 6, 40, o.signal), { headers: { 'content-length': String(jpeg.length) } }));
      // 6 x 40 ms = 240 ms total, four times the shortened 60 ms stall window
      const r = await x.s.stage(job(), () => {});
      assert.equal(r.size, jpeg.length);
    });
  });
  await test('staging: a stalled body ends as NETWORK_TIMEOUT and leaves no file', async () => {
    await withFastTimers(async () => {
      const x = disk(async (u, o) => new Response(slowBody(jpeg, 3, 200, o.signal), { headers: { 'content-length': String(jpeg.length) } }));
      await assert.rejects(x.s.stage(job(), () => {}), /^Error: NETWORK_TIMEOUT$/);
      assert.equal(x.files.size, 0);
    });
  });
  for (const [label, response, code] of [
    ['PNG bytes for an expected JPEG', () => new Response(png), 'INVALID_MEDIA'],
    ['an HTML answer', () => new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }), 'INVALID_MEDIA'],
    ['HTTP 403', () => new Response('x', { status: 403 }), 'AUTH_REQUIRED'],
    ['HTTP 500', () => new Response('x', { status: 500 }), 'HTTP_ERROR'],
    ['HTTP 429', () => new Response('x', { status: 429, headers: { 'retry-after': '5' } }), 'RATE_LIMIT'],
    ['a body shorter than declared', () => new Response(jpeg, { headers: { 'content-length': String(jpeg.length + 10) } }), 'INCOMPLETE_BODY'],
    ['an empty body', () => new Response(new Uint8Array()), 'EMPTY_BODY'],
  ]) {
    await test(`staging: ${label} is refused as ${code}`, async () => {
      const x = disk(async () => response());
      await assert.rejects(x.s.stage(job(), () => {}), new RegExp('^Error: ' + code + '$'));
      assert.equal(x.files.size, 0);
    });
  }

  // ===== 1b. the Pixiv 50 MiB body cap (job.maxBytes) in the production staging and the durable manager job ===========================
  const CAP = 50 * 1024 * 1024, CHUNK = 65536;
  const pngChunk = new Uint8Array(CHUNK); pngChunk.set(png.subarray(0, Math.min(png.length, CHUNK)));
  // a stream of `total` bytes starting with a real PNG; a counting disk keeps no bytes (bounded memory) and records writes and removal
  function capDisk(total, headers = {}) {
    const st = { written: 0, removed: false, writerOpened: false, pulled: 0 };
    const dir = { getDirectoryHandle: async () => dir, removeEntry: async () => { st.removed = true; st.written = 0; },
      getFileHandle: async () => ({ createWritable: async () => { st.writerOpened = true; return { write: async (b) => { st.written += b.byteLength; }, close: async () => {}, abort: async () => {} }; }, getFile: async () => ({ size: st.written }) }) };
    const s = MediaLatchStaging.createStaging({ directory: async () => dir, estimate: async () => ({ quota: 1e12, usage: 0 }), origin: 'chrome-extension://test',
      fetch: async () => (st.pulled = 0, new Response(new ReadableStream({ pull(c) { if (st.pulled >= total) return c.close(); const n = Math.min(CHUNK, total - st.pulled); st.pulled += n; c.enqueue(n === CHUNK ? pngChunk : pngChunk.slice(0, n)); } }), { headers })),
      sniff: sniffMediaMagicBytes, malformed: isMalformedMediaContainer, url: () => 'blob:x', revoke() {} });
    return { s, st };
  }
  const pngJob = (over = {}) => ({ id: 'job-cap', source: 'https://i.pximg.net/img-original/img/2026/10/13/1_p0.png', expectedMime: 'image/png', maxBytes: CAP, ...over });
  for (const [label, headers] of [['no Content-Length', {}], ['an encoded body with a small declared length', { 'content-encoding': 'gzip', 'content-length': '1000' }]]) {
    await test(`staging cap: a Pixiv body over 50 MiB with ${label} is refused as SIZE_EXCEEDED before that chunk is written, and cleaned up`, async () => {
      const x = capDisk(CAP + CHUNK, headers);
      await assert.rejects(x.s.stage(pngJob(), async () => {}), /^Error: SIZE_EXCEEDED$/);
      assert.equal(x.st.removed, true, 'the partial file is removed');
      assert.equal(x.st.pulled, CAP + CHUNK, 'stopped at the first chunk past the cap');
    });
  }
  await test('staging cap: a GET that declares more than 50 MiB (changed since the probe) is refused before anything is written', async () => {
    const x = capDisk(CAP + CHUNK, { 'content-length': String(CAP + 1) });
    await assert.rejects(x.s.stage(pngJob(), async () => {}), /^Error: SIZE_EXCEEDED$/);
    assert.equal(x.st.writerOpened, false);
  });
  await test('staging cap: a body of exactly 50 MiB is accepted; a job without a cap (other providers) keeps its existing behavior', async () => {
    const at = capDisk(CAP);
    assert.deepEqual(await at.s.stage(pngJob(), async () => {}), { size: CAP, mime: 'image/png' });
    const other = capDisk(CAP + CHUNK);
    assert.deepEqual(await other.s.stage(pngJob({ maxBytes: undefined, source: 'https://media.test/a.png' }), async () => {}), { size: CAP + CHUNK, mime: 'image/png' });
  });
  await test('manager: the cap is part of the durable job, applied by staging on the first run, on retry and after a worker restart; no export of an over-limit body', async () => {
    const LIMIT = 100000, OVER = 3 * CHUNK;
    let data = { jobs: [], paused: false }, next = 1;
    const staged = [], exports = [];
    const d = (staging) => ({ store: { get: async () => structuredClone(data), set: async (x) => { data = structuredClone(x); } }, id: () => String(next++), sleep: () => new Promise((r) => setTimeout(r, 2)),
      stage: async (j, signal, p) => { staged.push({ ...j }); return staging.stage(j, p); }, verify: async () => true, fileUrl: async (id) => 'blob:chrome-extension://test/' + id,
      remove: async () => {}, abort: async () => {}, stop: async () => {}, error: () => {},
      export: async (url, filename) => { exports.push(filename); return 500 + exports.length; }, search: async (id) => (Number.isInteger(id) ? { id, state: 'complete', filename: 'x' } : null), cancelExport: async () => {} });
    const m = MediaLatchDownloads.createManager(d(capDisk(OVER).s)); await m.ready;
    await assert.rejects(m.enqueue({ url: 'https://i.pximg.net/img-original/img/1_p0.png', filename: 'a.png' }, { mime: 'image/png', maxBytes: LIMIT }), /^Error: SIZE_EXCEEDED$/);
    assert.equal(staged[0].maxBytes, LIMIT);
    assert.deepEqual([data.jobs[0].state, data.jobs[0].error, data.jobs[0].maxBytes], ['failed', 'SIZE_EXCEEDED', LIMIT], 'stored with the job');
    await m.command('retry', data.jobs[0].id); await m.drain();
    assert.equal(staged.length, 2); assert.equal(staged[1].maxBytes, LIMIT, 'retry keeps the cap');
    assert.equal(data.jobs[0].error, 'SIZE_EXCEEDED');
    // a worker restart with the job still queued: a new manager from the same store stages it with the same cap
    data.jobs[0].state = 'queued'; data.jobs[0].error = '';
    const restarted = MediaLatchDownloads.createManager(d(capDisk(OVER).s)); await restarted.ready; await restarted.drain();
    assert.equal(staged.length, 3); assert.equal(staged[2].maxBytes, LIMIT, 'restart keeps the cap');
    assert.equal(data.jobs[0].error, 'SIZE_EXCEEDED');
    assert.equal(exports.length, 0, 'an over-limit body is never exported');
    // control: the same body without a cap (another provider) completes; invalid caps are not stored
    data = { jobs: [], paused: false };
    const plain = MediaLatchDownloads.createManager(d(capDisk(OVER).s)); await plain.ready;
    assert.equal(await plain.enqueue({ url: 'https://media.test/b.png', filename: 'b.png' }, { mime: 'image/png' }), 501);
    assert.equal(exports.length, 1);
    for (const bad of [-1, 0, 1.5, '100', null]) await plain.enqueue({ url: 'https://media.test/c.png', filename: 'c.png' }, { mime: 'image/png', maxBytes: bad }).catch(() => {});
    assert(data.jobs.every((j) => !('maxBytes' in j)), 'no cap stored without a valid one');
  });

  // ===== 2. pipeline: Pixiv plans go to the manager ===================================================================================
  await test('pipeline: opened post hands the exact declared original and its probed JPEG type to the manager (no data URL)', async () => {
    const w = worker({ author: false });
    await w.save({ srcUrl: MASTER, pageUrl: ART });
    assert.equal(w.managed.length, 1, JSON.stringify(w.failures));
    assert.equal(w.managed[0].url, ORIGINAL);
    assert.equal(w.managed[0].mime, 'image/jpeg');
    assert.equal(w.managed[0].maxBytes, 50 * 1024 * 1024, 'the 50 MiB body cap goes with the job');
    assert(!w.calls.some((c) => c.url === ORIGINAL && c.method === 'GET'), 'the worker does not download the body itself');
  });
  await test('pipeline: a declared size above 50 MiB is refused before any transfer (SIZE_EXCEEDED)', async () => {
    const w = worker({ author: false, head: { status: 200, type: 'image/jpeg', length: String(50 * 1024 * 1024 + 1) } });
    await w.save({ srcUrl: MASTER, pageUrl: ART });
    assert.equal(w.managed.length, 0);
    assert(w.failures.some((f) => f.code === 'SIZE_EXCEEDED'), JSON.stringify(w.failures));
  });
  for (const code of ['NETWORK_TIMEOUT', 'HTTP_ERROR', 'INVALID_MEDIA', 'AUTH_REQUIRED']) {
    await test(`pipeline: the manager's ${code} is recorded as that code at the save stage, with no invented status`, async () => {
      const w = worker({ author: false });
      w.s.__managerAnswer = code;
      await w.save({ srcUrl: MASTER, pageUrl: ART });
      const f = w.failures.find((x) => x.code === code);
      assert(f, JSON.stringify(w.failures));
      assert.equal(f.stage, 'save');
      assert(f.status === null || f.status === undefined, 'no synthetic HTTP status');
    });
  }
  await test('pipeline: the manager\'s final RATE_LIMIT is recorded with the observed 429', async () => {
    const w = worker({ author: false });
    w.s.__managerAnswer = 'RATE_LIMIT';
    await w.save({ srcUrl: MASTER, pageUrl: ART });
    assert(w.failures.some((f) => f.code === 'RATE_LIMIT' && f.status === 429), JSON.stringify(w.failures));
  });
  await test('pipeline: a final probe with no answer (deadline) continues to the manager, whose byte check decides', async () => {
    const w = worker({ author: false, head: 'abort' });
    await w.save({ srcUrl: MASTER, pageUrl: ART });
    assert.equal(w.managed.length, 1, JSON.stringify(w.failures));
    assert.equal(w.managed[0].url, ORIGINAL, 'the declared original, never the selected preview');
    assert.equal(w.managed[0].mime, 'image/jpeg', 'the expected type comes from the file extension');
    assert(!w.failures.some((f) => f.code === 'MIME_NOT_VERIFIED'));
  });
  await test('pipeline: an answered probe still decides (HTTP 403 stops before any transfer)', async () => {
    const w = worker({ author: false, head: { status: 403, type: 'text/html', length: '100' } });
    await w.save({ srcUrl: MASTER, pageUrl: ART });
    assert.equal(w.managed.length, 0);
    assert(w.failures.some((f) => f.code === 'AUTH_REQUIRED'), JSON.stringify(w.failures));
  });

  // ===== 3. author folders =========================================================================================================
  const ctx = createTestEnv().bgContext, run = (code) => vm.runInContext(code, ctx);
  await test('author folder: Pixiv is "<display name> (<user id>)", one portable segment', async () => {
    assert.deepEqual({ ...run(`authorFolder('pixiv', ${JSON.stringify(NAME)}, '${USER}')`) }, { site: 'pixiv', folder: `${NAME} (${USER})` });
    assert.equal(run(`authorFolder('pixiv', 'a/../b:c*?"<>|', '42')`).folder, 'a..bc (42)');
    assert.equal(run(`authorFolder('pixiv', '...', '42')`).folder, '42', 'an empty name keeps the id alone');
    const long = run(`authorFolder('pixiv', ${JSON.stringify('名'.repeat(80))}, '1234567890')`).folder;
    assert(long.endsWith(' (1234567890)') && long.length <= 50, 'shortening keeps the stable id');
    assert.equal(run(`authorFolder('pixiv', 'x', 'abc')`), null, 'a non-numeric id is refused');
  });
  await test('author folder: Reddit uses a valid username only (lowercase)', async () => {
    assert.equal(run(`authorFolder('reddit', 'Some_User-1').folder`), 'some_user-1');
    for (const bad of ['[deleted]', 'ab', 'a'.repeat(21), '../x', 'u/name', '']) assert.equal(run(`authorFolder('reddit', ${JSON.stringify(bad)})`), null, bad);
  });
  await test('path: the author folder applies only to a file owned by the same site; X keeps its rule', async () => {
    const p = (o) => run(`resolveDownloadPath(${JSON.stringify(o)})`);
    const pixiv = { site: 'pixiv', folder: `${NAME} (${USER})` };
    assert.equal(p({ filename: 'a.jpg', subfolder: 'Saved', author: pixiv, resolvedUrl: ORIGINAL, pageUrl: ART }), `Saved/${NAME} (${USER})/a.jpg`);
    assert.equal(p({ filename: 'a.jpg', subfolder: 'Saved', folderOrganizationMode: 'by_site_and_type', author: pixiv, resolvedUrl: ORIGINAL, pageUrl: ART, contentType: 'image/jpeg' }), `Saved/pixiv/${NAME} (${USER})/pic/a.jpg`);
    assert.equal(p({ filename: 'a.jpg', subfolder: 'Saved', author: pixiv, resolvedUrl: 'https://i.redd.it/a.jpg', pageUrl: 'https://www.reddit.com/r/x/' }), 'Saved/a.jpg', 'another site keeps the normal layout');
    assert.equal(p({ filename: 'a.mp4', subfolder: 'Saved', author: { site: 'reddit', folder: 'poster' }, resolvedUrl: 'https://v.redd.it/x/a.mp4', pageUrl: 'https://www.reddit.com/r/x/comments/abc/t/' }), 'Saved/poster/a.mp4');
    assert.equal(p({ filename: 'a.jpg', subfolder: 'Saved', xAuthor: 'Someone', resolvedUrl: 'https://pbs.twimg.com/media/a.jpg', pageUrl: 'https://x.com/someone/status/1' }), 'Saved/someone/a.jpg', 'X unchanged');
    assert.equal(p({ filename: 'a.jpg', subfolder: 'Saved', author: { site: 'pixiv', folder: '../../etc' }, resolvedUrl: ORIGINAL, pageUrl: ART }), 'Saved/etc/a.jpg', 'an injected folder stays one segment');
  });
  await test('pipeline: Pixiv author folder from the artwork\'s own metadata, one request for the save', async () => {
    const w = worker({ author: true });
    await w.save({ srcUrl: MASTER, pageUrl: ART });
    assert.equal(w.managed.length, 1, JSON.stringify(w.failures));
    assert(w.managed[0].filename.startsWith(`SavedImages/${NAME} (${USER})/`), w.managed[0].filename);
    assert.equal(w.calls.filter((c) => /\/ajax\/illust\/\d+$/.test(c.url)).length, 1);
  });
  await test('pipeline: a Pixiv preview whose link names another artwork gets no author folder and no metadata request', async () => {
    const w = worker({ author: true });
    const settings = { pixivAuthorFolders: true };
    const r = await w.s.selectedAuthorFolder(settings, { linkUrl: 'https://www.pixiv.net/en/artworks/999', pageUrl: 'https://www.pixiv.net/' }, { id: 1 }, THUMB);
    assert.equal(r, null);
    assert(!w.calls.some((c) => c.url.includes('/ajax/illust/')));
  });
  for (const [label, illust] of [
    ['another artwork', { error: false, body: { illustId: '1', userId: USER, userName: NAME } }],
    ['a missing user id (deleted)', { error: false, body: { illustId: ID, userId: '', userName: '' } }],
    ['an error answer', { error: true, message: 'deleted', body: [] }],
  ]) {
    await test(`pipeline: Pixiv metadata about ${label} keeps the normal layout`, async () => {
      const w = worker({ author: true, illust });
      await w.save({ srcUrl: MASTER, pageUrl: ART });
      assert.equal(w.managed.length, 1);
      assert(/^SavedImages\/[^/]+$/.test(w.managed[0].filename), w.managed[0].filename);
    });
  }
  await test('pipeline: the files of one artwork share a single metadata request', async () => {
    const w = worker({ author: true });
    const settings = { pixivAuthorFolders: true }, info = { pageUrl: ART };
    const [a, b] = await Promise.all([w.s.selectedAuthorFolder(settings, info, { id: 1 }, ORIGINAL), w.s.selectedAuthorFolder(settings, info, { id: 1 }, ORIGINAL.replace('_p0', '_p1'))]);
    assert.equal(a.folder, b.folder);
    assert.equal(w.calls.filter((c) => /\/ajax\/illust\/\d+$/.test(c.url)).length, 1);
  });
  await test('reddit: a context save asks only its admission proof, pinned to the admitting document; an inline save uses the author proven with its descriptor and asks nothing', async () => {
    const w = worker({ author: false });
    const asked = [];
    w.s.chrome.tabs.sendMessage = async (id, m, o) => { asked.push({ m, o }); return { ownerId: 't3_abc', author: 'Poster' }; };
    const reddit = { redditAuthorFolders: true }, page = 'https://www.reddit.com/r/pics/';
    assert.equal(await w.s.selectedAuthorFolder(reddit, { pageUrl: page }, { id: 1 }, 'https://i.redd.it/a.jpg'), null, 'no admission proof: no question');
    assert.equal(asked.length, 0);
    assert.equal((await w.s.selectedAuthorFolder(reddit, { pageUrl: page, authorProof: '1-1', authorDocumentId: 'doc-1' }, { id: 1 }, 'https://i.redd.it/a.jpg')).folder, 'poster');
    assert.deepEqual({ ...asked[0].m }, { action: 'GET_REDDIT_POST_AUTHOR', proof: '1-1' });
    assert.deepEqual({ ...asked[0].o }, { frameId: 0, documentId: 'doc-1' }, 'pinned to the admitting document');
    assert.equal((await w.s.selectedAuthorFolder(reddit, { pageUrl: page, redditInlineMedia: { ownerId: 't3_abc', author: 'Inliner' } }, { id: 1 }, '')).folder, 'inliner');
    assert.equal(await w.s.selectedAuthorFolder(reddit, { pageUrl: page, redditInlineMedia: { ownerId: 't3_abc', author: '' } }, { id: 1 }, ''), null, 'an inline descriptor without a proven author');
    assert.equal(asked.length, 1, 'an inline save never asks the page');
    assert.equal(await w.s.selectedAuthorFolder({ redditAuthorFolders: false }, { pageUrl: page, authorProof: '1-2' }, { id: 1 }, ''), null);
    assert.equal(asked.length, 1, 'no page question while the setting is off');
  });
  // The page side (content/content_reddit.js with the real gesture capture and owner rules) is covered by tests/test_reddit_inline.js Suite 12.

  console.log(`\n${passed}/${passed + failed} Pixiv saving / author folder checks passed`);
  // the author cache's 120 s expiry timer would keep this test process alive; the worker is unaffected
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exitCode = 1; });
