'use strict';
const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const { createUpdates, isNewer, versionParts, selectRelease, RELEASES_API, RELEASES_URL, CHECK_INTERVAL_MS } = await import(pathToFileURL(path.join(REPO_ROOT, 'ui/src/core/updates.js')));
  // the controller stores catalogue keys (UI-LOCALIZATION-01); the Russian text is what a Russian interface shows
  require('../lib/i18n.js'); // the shared catalogue (sets globalThis.ImageSaverI18n)
  const ru = (m) => globalThis.ImageSaverI18n.message('ru', m);
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log(`[PASS] ${name}`); };
  const release = (tag, prerelease = false, extra = {}) => ({ tag_name: tag, draft: false, prerelease, ...extra });
  const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
  function harness(options = {}) {
    const local = options.local || {}, requests = [], writes = [];
    let time = 1700000000000;
    const chrome = {
      runtime: { getManifest: () => ({ version: '2.0.0.20' }) },
      storage: { local: {
        get: async () => { if (options.failGet) throw Error('storage'); return local; },
        set: async (value) => { if (options.failSet) throw Error('storage'); Object.assign(local, value); writes.push(value); },
      } },
    };
    const deps = { chrome, now: () => time, fetch: async (url, init) => { requests.push({ url, init }); return options.fetch ? options.fetch(url, init) : response(options.releases || []); }, ...options.deps };
    return { make: () => createUpdates(deps), local, requests, writes, advance: (ms) => { time += ms; } };
  }

  await test('Numeric four-component versions; equality, malformed tags and downgrade rejected', () => {
    assert.equal(isNewer('2.0.0.100', '2.0.0.20'), true);
    assert.equal(isNewer('2.0.0.9', '2.0.0.20'), false);
    assert.equal(isNewer('2.0.0.20', '2.0.0.20'), false);
    assert.equal(isNewer('2.1', '2.1.0.0'), false);
    for (const value of ['2.0.0.21-beta', '2.0.0.21.1', '02.0', '65536', '<script>', null]) assert.equal(versionParts(value), null);
  });
  await test('Stable vs beta, drafts, highest version and stable tie preference', () => {
    const list = [release('v2.0.0.21', true), release('v2.0.0.20'), release('v9', false, { draft: true }), release('v2.0.0.9'), release('not-version')];
    assert.equal(selectRelease(list, 'stable').version, '2.0.0.20');
    assert.equal(selectRelease(list, 'beta').version, '2.0.0.21');
    assert.equal(selectRelease([release('v2.0.0.21', true), release('2.0.0.21')], 'beta').prerelease, false);
    assert.equal(selectRelease([], 'stable'), null);
    assert.throws(() => selectRelease({}, 'stable'), /invalid/);
  });
  await test('Response URLs/HTML never navigate or persist; anonymous request uses fixed repository', async () => {
    assert.equal(RELEASES_API, 'https://api.github.com/repos/xhthc/MediaLatch/releases?per_page=100');
    assert.equal(RELEASES_URL, 'https://github.com/xhthc/MediaLatch/releases');
    const h = harness({ releases: [release('v2.0.0.21', false, { html_url: 'https://evil.test', body: '<script>evil()</script>', assets: [{ browser_download_url: 'https://evil.test' }] })] });
    const u = h.make(); await u.check();
    assert.equal(h.requests[0].url, RELEASES_API);
    assert.equal(h.requests[0].init.credentials, 'omit');
    assert.equal(h.requests[0].init.referrerPolicy, 'no-referrer');
    assert.equal(h.requests[0].init.redirect, 'error');
    assert.equal(u.store.getState().release.url, `${RELEASES_URL}/tag/v2.0.0.21`);
    assert.equal(/evil|script|body|assets|Authorization/.test(JSON.stringify(h.local) + JSON.stringify(h.requests)), false);
  });
  await test('Daily cache across page instances; manual check bypasses; expiry rechecks', async () => {
    const h = harness(); await h.make().check(); await h.make().check(); assert.equal(h.requests.length, 1);
    await h.make().check(true); assert.equal(h.requests.length, 2);
    h.advance(CHECK_INTERVAL_MS); await h.make().check(); assert.equal(h.requests.length, 3);
  });
  await test('Repository rename discards cached failures from the old endpoint and preserves the selected channel', async () => {
    const h = harness({ local: {
      imageSaverReleaseChannel: 'beta',
      imageSaverReleaseCheckV2: { channel: 'beta', attemptedAt: 1700000000000, checkedAt: 0, release: null, error: 'network' }
    }, releases: [release('v2.0.0.25', true)] });
    const u = h.make(); await u.check();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, 'https://api.github.com/repos/xhthc/MediaLatch/releases?per_page=100');
    assert.equal(u.store.getState().channel, 'beta');
    assert.equal(u.store.getState().release.url, 'https://github.com/xhthc/MediaLatch/releases/tag/v2.0.0.25');
    assert.equal(u.store.getState().error, '');
  });
  await test('Empty successful list is cached as no releases, not an API error', async () => {
    const u = harness().make(); await u.check();
    const s = u.store.getState(); assert.equal(s.release, null); assert.equal(s.error, ''); assert.ok(s.checkedAt);
  });
  await test('Channel selection persists; beta cache cannot suppress a stable check', async () => {
    const h = harness({ releases: [release('v2.0.0.21', true)] });
    const u = h.make(); await u.check(); assert.equal(u.store.getState().release, null);
    await u.setChannel('beta'); assert.equal(u.store.getState().release.version, '2.0.0.21');
    assert.equal(h.local.imageSaverReleaseChannel, 'beta');
    await h.make().check(); assert.equal(h.requests.length, 2);
    h.local.imageSaverReleaseChannel = 'stable'; await h.make().check(); assert.equal(h.requests.length, 3);
  });
  await test('Failed preference write keeps old channel and does not fetch', async () => {
    const h = harness({ failSet: true }); const u = h.make(); await u.load(); await u.setChannel('beta');
    assert.equal(u.store.getState().channel, 'stable'); assert.match(ru(u.store.getState().notice), /Не удалось сохранить канал/);
    assert.equal(h.requests.length, 0);
  });
  await test('Offline/API/malformed responses retain previous successful result and show failure', async () => {
    for (const fetch of [async () => { throw Error('offline'); }, async () => response(null, 404), async () => response(null, 403), async () => response(null, 429), async () => response({}), async () => ({ ok: true, json: async () => { throw Error('json'); } })]) {
      const options = { releases: [release('v2.0.0.21')] }; const h = harness(options); const u = h.make(); await u.check();
      const checkedAt = u.store.getState().checkedAt; options.fetch = fetch; h.advance(1000); await u.check(true);
      assert.ok(u.store.getState().error); assert.equal(u.store.getState().release.version, '2.0.0.21');
      assert.equal(u.store.getState().checkedAt, checkedAt);
      await h.make().check(); assert.equal(h.requests.length, 2);
    }
  });
  await test('Concurrent checks share one request; channel writes cannot overlap that request', async () => {
    let finish; const h = harness({ fetch: () => new Promise((r) => { finish = r; }) }); const u = h.make();
    const first = u.check(); await new Promise(setImmediate); const second = u.check(true); await u.setChannel('beta');
    assert.equal(h.requests.length, 1); assert.equal(h.local.imageSaverReleaseChannel, undefined);
    finish(response([])); await Promise.all([first, second]); assert.equal(u.store.getState().checking, false);
  });
  await test('Ten-second timeout aborts request and surfaces timeout', async () => {
    let timeout; const h = harness({ deps: { setTimeout: (fn, ms) => { assert.equal(ms, 10000); timeout = fn; return 1; }, clearTimeout: () => {} },
      fetch: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))) });
    const u = h.make(); const p = u.check(); await new Promise(setImmediate); timeout(); await p;
    assert.match(ru(u.store.getState().error), /10 секунд/); assert.equal(u.store.getState().checking, false);
  });
  await test('Closing page aborts in-flight request without persisting a false failure', async () => {
    const h = harness({ fetch: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))) });
    const u = h.make(); const p = u.check(); await new Promise(setImmediate); u.dispose(); await p;
    assert.equal(h.writes.length, 0);
  });
  await test('Unreadable storage requires manual check; failed cache write remains visible', async () => {
    const h = harness({ failGet: true, failSet: true }); const u = h.make(); await u.check(); assert.equal(h.requests.length, 0);
    await u.check(true); assert.equal(h.requests.length, 1); assert.ok(u.store.getState().checkedAt);
    assert.match(ru(u.store.getState().notice), /Не удалось сохранить результат/);
  });
  await test('Future cache timestamp never suppresses checking after clock rollback', async () => {
    const h = harness({ local: { imageSaverReleaseCheckV3: { channel: 'stable', attemptedAt: Number.MAX_SAFE_INTEGER, checkedAt: Number.MAX_SAFE_INTEGER, release: null } } });
    await h.make().check(); assert.equal(h.requests.length, 1);
  });
  await test('Cached releases from the previous repository are ignored', async () => {
    const h = harness({ local: { imageSaverReleaseCheckV1: { channel: 'stable', attemptedAt: 1700000000000, checkedAt: 1700000000000, release: release('v9') } } });
    const u = h.make(); await u.check();
    assert.equal(h.requests.length, 1); assert.equal(u.store.getState().release, null);
    assert.ok(h.local.imageSaverReleaseCheckV3);
  });
  console.log(`Release checks: ${passed}/${passed} passed.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
