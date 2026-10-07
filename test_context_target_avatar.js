// test_context_target_avatar.js - Regression test suite for X avatar saving via native context menu (X-AVATAR-01)
// Verifies production capture (content_context_target.js) and background handling (background.js).
// Covers:
// - X profile avatar behind touch overlay and placeholder background inside navigation anchor (linkUrl only)
// - X sidebar recommendation avatar behind touch overlay inside navigation anchor (linkUrl only)
// - Equivalent generic image behind overlay inside navigation anchor
// - Direct <img> clicked inside navigation anchor when Chrome supplies linkUrl without srcUrl
// - Direct anchor clicked directly over <img>
// - Negative: text-only link (NO_MEDIA, 0 fetches, 0 downloads)
// - Negative: ambiguous wrapper with multiple different images (NO_MEDIA, 0 fetches, 0 downloads)
// - Negative: gesture click on padding outside image bounds (NO_MEDIA, 0 fetches, 0 downloads)
// - Negative: stale / removed media (disconnected before save)
// - Negative: replaced media (src mutated after gesture)
// - Negative: synthetic / untrusted gesture (isTrusted: false)
// - Negative: left-click gesture (button: 0)
// - Negative: gesture older than 30s
// - Negative: cross-frame isolation (frame 0 does not borrow frame 5 gesture)
// - Negative: regression PR #21 (blob VIDEO + IMG + matching CSS background refuses with 0 fetches/downloads)
// - Negative: empty-src VIDEO + IMG + matching CSS background
// - Negative: direct MP4 VIDEO + IMG + matching CSS background
// - Negative: multiple IMG candidates with identical URLs (not coalesced)
// - Negative: conflicting CSS background with different URL
// - Negative: CSS decoration with multiple backgrounds (multi)
// - Negative: overlay probe points revealing another element at corner probe
// - Scope containment: media outside immediate scope does not cause ambiguity
// - Negative: reparented media element after gesture fails check()
// - Ordinary video recovery: overlay covering single video resolves video target
// - Settings parity: positive avatar save respects subfolder routing and ignores legacy Save As

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0;
let failed = 0;

async function test(desc, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${desc}`);
    console.error(err);
  }
}

// Read production sources
const contentTargetCode = fs.readFileSync(path.join(__dirname, 'content_context_target.js'), 'utf8');
const bgCodeRaw = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');

// Build test environment with Chrome mocks and background.js
function createTestEnv() {
  const downloadedCalls = [];
  const badgeHistory = [];
  let fetchedUrls = [];
  let dynamicRules = [];
  const networkSizes = {};

  const mockChrome = {
    declarativeNetRequest: {
      getDynamicRules: async () => dynamicRules,
      updateDynamicRules: async ({ removeRuleIds, addRules }) => {
        if (Array.isArray(removeRuleIds) && removeRuleIds.length > 0) {
          dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id));
        }
        if (Array.isArray(addRules)) {
          dynamicRules.push(...addRules);
        }
      }
    },
    runtime: {
      id: 'mock-extension-id',
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        _listeners: [],
        addListener: (cb) => { mockChrome.runtime.onMessage._listeners.push(cb); }
      },
      sendMessage: async (msg, sender) => null,
      getURL: (p) => `chrome-extension://mock-extension-id/${p}`,
      getContexts: async () => []
    },
    action: {
      setBadgeText: async ({ text, tabId }) => { badgeHistory.push({ text, tabId }); },
      setBadgeBackgroundColor: async ({ color, tabId }) => {},
      setTitle: async () => {},
      setIcon: async () => {}
    },
    contextMenus: {
      _handler: null,
      onClicked: {
        addListener: (cb) => { mockChrome.contextMenus._handler = cb; }
      },
      create: () => {},
      update: () => {},
      removeAll: (cb) => { if (cb) cb(); }
    },
    downloads: {
      download: async (opts) => {
        downloadedCalls.push(opts);
        return downloadedCalls.length;
      },
      search: async () => [],
      onChanged: { addListener: () => {} },
      onDeterminingFilename: { addListener: () => {} }
    },
    storage: {
      local: {
        get: async (k) => ({}),
        set: async () => {},
        remove: async () => {}
      },
      sync: {
        get: async (k) => ({}),
        set: async () => {},
        remove: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://x.com/home' }],
      get: async (id) => ({ id, url: 'https://x.com/home' }),
      sendMessage: async () => {}
    },
    scripting: {
      executeScript: async () => []
    },
    offscreen: {
      createDocument: async () => {},
      closeDocument: async () => {},
      Reason: { BLOB_CONVERSION: 'BLOB_CONVERSION' }
    }
  };

  const mockFetch = async (url, opts) => {
    const u = typeof url === 'string' ? url : (url?.url || '');
    fetchedUrls.push(u);
    const size = networkSizes[u];
    if (size !== undefined) {
      const headersMap = new Map([
        ['content-type', 'image/jpeg'],
        ['content-length', String(size)]
      ]);
      return {
        ok: true,
        status: 200,
        headers: {
          get: (h) => headersMap.get(String(h).toLowerCase()) || null,
          has: (h) => headersMap.has(String(h).toLowerCase())
        },
        blob: async () => ({ size, type: 'image/jpeg' }),
        arrayBuffer: async () => new ArrayBuffer(size)
      };
    }
    // 404 for unknown URLs (e.g. profile HTML pages)
    return {
      ok: false,
      status: 404,
      headers: {
        get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html' : null),
        has: (h) => String(h).toLowerCase() === 'content-type'
      }
    };
  };

  const bgSandbox = {
    chrome: mockChrome,
    fetch: mockFetch,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Set,
    Map,
    URL,
    Number,
    Array,
    Object,
    Promise,
    ArrayBuffer,
    Uint8Array,
    Math,
    String,
    Boolean,
    RegExp,
    AbortController
  };

  const bgContext = vm.createContext(bgSandbox);
  bgSandbox.importScripts = (file) => vm.runInContext(fs.readFileSync(path.resolve(__dirname, file), 'utf8'), bgSandbox);
  vm.runInContext(bgCodeRaw, bgContext);

  const contentXPath = path.resolve(__dirname, 'content_x.js');
  if (fs.existsSync(contentXPath)) {
    const contentXCode = fs.readFileSync(contentXPath, 'utf8');
    vm.runInContext(contentXCode, bgContext);
  }

  return {
    mockChrome,
    mockFetch,
    downloadedCalls,
    badgeHistory,
    fetchedUrls,
    networkSizes,
    bgSandbox,
    bgContext
  };
}

// Helper to create mock DOM elements for content script & background verification
function createMockElement(tag, opts = {}) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    parentElement: opts.parent || null,
    style: {},
    isConnected: true,
    _attrs: opts.attrs || {},
    _bg: opts.bg || 'none',
    _rect: opts.rect || { left: 0, top: 0, width: 100, height: 100 },
    src: opts.src || '',
    currentSrc: opts.currentSrc || opts.src || '',
    href: opts.href || ''
  };

  el.getAttribute = (name) => {
    if (name === 'href') return el.href || null;
    if (name in el._attrs) return el._attrs[name];
    return null;
  };
  el.hasAttribute = (name) => (name === 'href' && Boolean(el.href)) || name in el._attrs;
  el.matches = () => false;
  el.closest = (selector) => {
    const tags = selector.split(',').map((s) => s.trim().toLowerCase());
    for (let c = el; c; c = c.parentElement) {
      if (tags.includes(c.tagName.toLowerCase())) return c;
    }
    return null;
  };
  el.contains = (descendant) => {
    for (let c = descendant; c; c = c.parentElement) {
      if (c === el) return true;
    }
    return false;
  };
  el.getBoundingClientRect = () => {
    const r = el._rect;
    return {
      left: r.left,
      top: r.top,
      right: r.left + r.width,
      bottom: r.top + r.height,
      width: r.width,
      height: r.height
    };
  };
  el.getRootNode = () => null;
  el.querySelector = () => null;
  el.querySelectorAll = () => [];

  return el;
}

// Create a DOM tree and simulate user gesture in content_context_target.js
function simulateGesture(doc, target, gestureOpts = {}) {
  const listeners = {};
  const messages = [];
  const world = vm.createContext({
    window: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      getComputedStyle: (e) => ({ backgroundImage: e._bg || 'none', ...(e._computed || {}) })
    },
    document: doc,
    Date,
    Set,
    URL,
    Number,
    WeakRef,
    chrome: {
      runtime: {
        id: 'mock-extension-id',
        sendMessage: (message) => { messages.push(message); return Promise.resolve(); }
      }
    }
  });

  vm.runInContext(contentTargetCode, world);

  const eventType = gestureOpts.type || 'contextmenu';
  const evt = {
    isTrusted: gestureOpts.trusted !== false,
    type: eventType,
    button: gestureOpts.button ?? (eventType === 'mousedown' ? 2 : undefined),
    clientX: gestureOpts.x ?? 50,
    clientY: gestureOpts.y ?? 50,
    timeStamp: gestureOpts.timeStamp || Date.now(),
    target,
    composedPath: () => [target]
  };

  if (listeners[eventType]) {
    listeners[eventType](evt);
  }

  const rec = vm.runInContext('globalThis.__imageSaverContextTarget', world);
  if (rec && gestureOpts.ageMs) {
    rec.at -= gestureOpts.ageMs;
  }
  return { rec, world, messages };
}

// Execute context menu click through background.js
async function executeSaveClick(env, { docs, recs, info, frameId = 0, tabId = 1 }) {
  const { mockChrome, bgSandbox, downloadedCalls } = env;

  bgSandbox.window = {
    getComputedStyle: (e) => ({ backgroundImage: (e && e._bg) || 'none' })
  };
  if (typeof bgSandbox.resetActiveOffscreenTasks === 'function') {
    bgSandbox.resetActiveOffscreenTasks(0);
  }

  mockChrome.scripting.executeScript = async (opts) => {
    const fid = (opts.target.frameIds && opts.target.frameIds[0]) || 0;
    bgSandbox.document = docs[fid];
    bgSandbox.__imageSaverContextTarget = recs[fid];
    const result = opts.func(...(opts.args || []));
    return [{ result }];
  };

  const before = downloadedCalls.length;
  try {
    await mockChrome.contextMenus._handler(
      { menuItemId: 'save-image-item', frameId, ...info },
      { id: tabId, url: info.pageUrl || 'https://x.com/home' }
    );
  } finally {
    delete bgSandbox.__imageSaverContextTarget;
  }
  return downloadedCalls.slice(before);
}

// ---------------------------------------------------------------------------
// TEST RUNNER
// ---------------------------------------------------------------------------

async function runAllTests() {
  console.log('Running test_context_target_avatar.js...');

  // 1. X profile avatar behind touch overlay + placeholder background inside navigation anchor
  await test('1. X profile avatar: touch overlay over img with placeholder background resolves _400x400.jpg (0 profile fetches, 1 download)', async () => {
    const env = createTestEnv();
    const avatarNormal = 'https://pbs.twimg.com/profile_images/2106267824268206080/B1zEm0ML_200x200.jpg';
    const avatarOrig = 'https://pbs.twimg.com/profile_images/2106267824268206080/B1zEm0ML_400x400.jpg';
    env.networkSizes[avatarNormal] = 15000;
    env.networkSizes[avatarOrig] = 85000;

    // Build X avatar DOM tree:
    // <a href="https://x.com/EfesBiras/photo" role="link">
    //   <div class="presWrap">
    //     <div class="imgWrap">
    //       <div class="bgDiv" style="background-image: url(avatarNormal)"></div>
    //       <img src="avatarNormal">
    //     </div>
    //     <div class="touchOverlay"></div>
    //   </div>
    // </a>
    const anchor = createMockElement('a', { href: 'https://x.com/EfesBiras/photo', attrs: { role: 'link' } });
    const presWrap = createMockElement('div', { parent: anchor });
    const imgWrap = createMockElement('div', { parent: presWrap });
    const bgDiv = createMockElement('div', { parent: imgWrap, bg: `url("${avatarNormal}")` });
    const img = createMockElement('img', { parent: imgWrap, src: avatarNormal });
    const touchOverlay = createMockElement('div', { parent: presWrap });

    const hitStack = [touchOverlay, img, bgDiv, imgWrap, presWrap, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    // User right-clicks touchOverlay
    const { rec } = simulateGesture(doc, touchOverlay, { x: 50, y: 50 });
    assert(rec !== null, 'gesture record must be created');
    assert(rec.media !== null, 'media target must be detected');
    assert.strictEqual(rec.media.kind, 'img', 'media kind must be img');
    assert.strictEqual(rec.media.url, avatarNormal, 'media url must match avatar normal');
    assert.strictEqual(rec.media.check(), true, 'media.check() must pass');

    // Context menu click with linkUrl only (no srcUrl from Chromium)
    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://x.com/EfesBiras',
        linkUrl: 'https://x.com/EfesBiras/photo'
      }
    });

    assert.strictEqual(downloads.length, 1, 'exactly 1 download must be initiated');
    assert.strictEqual(downloads[0].url, avatarOrig, 'download url must be the 400x400 original');
    assert(/\.jpg$/i.test(downloads[0].filename), 'download filename must end in .jpg');
    assert(!env.fetchedUrls.includes('https://x.com/EfesBiras'), 'profile page must NOT be fetched');
  });

  // 2. X sidebar recommendation avatar behind touch overlay inside navigation anchor
  await test('2. X recommendation avatar: touch overlay inside <a href="/EfesBiras"> resolves _400x400.jpg', async () => {
    const env = createTestEnv();
    const avatarNormal = 'https://pbs.twimg.com/profile_images/9999/user_normal.jpg';
    const avatarOrig = 'https://pbs.twimg.com/profile_images/9999/user_400x400.jpg';
    env.networkSizes[avatarNormal] = 12000;
    env.networkSizes[avatarOrig] = 72000;

    const anchor = createMockElement('a', { href: 'https://x.com/EfesBiras', attrs: { role: 'link' } });
    const presWrap = createMockElement('div', { parent: anchor });
    const imgWrap = createMockElement('div', { parent: presWrap });
    const bgDiv = createMockElement('div', { parent: imgWrap, bg: `url("${avatarNormal}")` });
    const img = createMockElement('img', { parent: imgWrap, src: avatarNormal });
    const touchOverlay = createMockElement('div', { parent: presWrap });

    const hitStack = [touchOverlay, img, bgDiv, imgWrap, presWrap, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, touchOverlay, { x: 50, y: 50 });
    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://x.com/home',
        linkUrl: 'https://x.com/EfesBiras'
      }
    });

    assert.strictEqual(downloads.length, 1, 'exactly 1 download must be initiated');
    assert.strictEqual(downloads[0].url, avatarOrig, 'download url must be the 400x400 original');
    assert(/\.jpg$/i.test(downloads[0].filename), 'download filename must end in .jpg');
  });

  // 3. Equivalent generic image behind an overlay inside a navigation link
  await test('3. Generic image behind overlay in navigation link: saves image with 0 link fetches', async () => {
    const env = createTestEnv();
    const imgUrl = 'https://cdn.example.test/products/item123.jpg';
    env.networkSizes[imgUrl] = 100000;

    const anchor = createMockElement('a', { href: 'https://example.test/items/123' });
    const overlay = createMockElement('div', { parent: anchor });
    const img = createMockElement('img', { parent: anchor, src: imgUrl });

    const hitStack = [overlay, img, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert(rec?.media?.kind === 'img' && rec.media.url === imgUrl, 'must detect img under overlay');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://example.test/store',
        linkUrl: 'https://example.test/items/123'
      }
    });

    assert.strictEqual(downloads.length, 1, 'must download product image');
    assert.strictEqual(downloads[0].url, imgUrl, 'must download direct image URL');
  });

  // 4. Direct <img> clicked inside navigation link when Chrome menu info supplies linkUrl only
  await test('4. Direct <img> clicked inside navigation link with empty srcUrl in menu info: saves img', async () => {
    const env = createTestEnv();
    const imgUrl = 'https://cdn.example.test/photos/vacation.jpg';
    env.networkSizes[imgUrl] = 200000;

    const anchor = createMockElement('a', { href: 'https://example.test/posts/456' });
    const img = createMockElement('img', { parent: anchor, src: imgUrl });

    const hitStack = [img, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, img, { x: 50, y: 50 });
    assert(rec?.media?.kind === 'img' && rec.media.url === imgUrl, 'direct img gesture must record media');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://example.test/feed',
        linkUrl: 'https://example.test/posts/456'
      }
    });

    assert.strictEqual(downloads.length, 1, 'must download img');
    assert.strictEqual(downloads[0].url, imgUrl, 'must download correct img url');
  });

  // 5. Generic anchor <a> clicked directly over <img>
  await test('5. Anchor <a> clicked directly over <img>: resolves media under pointer', async () => {
    const env = createTestEnv();
    const imgUrl = 'https://cdn.example.test/cards/banner.jpg';
    env.networkSizes[imgUrl] = 150000;

    const container = createMockElement('div');
    const anchor = createMockElement('a', { parent: container, href: 'https://example.test/promo' });
    const img = createMockElement('img', { parent: anchor, src: imgUrl });

    const hitStack = [anchor, img, container];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, anchor, { x: 50, y: 50 });
    assert(rec?.media?.kind === 'img' && rec.media.url === imgUrl, 'anchor target over img must find img');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://example.test/home',
        linkUrl: 'https://example.test/promo'
      }
    });

    assert.strictEqual(downloads.length, 1, 'must download promo banner');
    assert.strictEqual(downloads[0].url, imgUrl, 'url matches');
  });

  // 6. Negative: plain text navigation link (NO_MEDIA, 0 fetches, 0 downloads)
  await test('6. Negative: text navigation link gives NO_MEDIA (0 fetches, 0 downloads, badge ERR)', async () => {
    const env = createTestEnv();
    const anchor = createMockElement('a', { href: 'https://x.com/EfesBiras' });
    const span = createMockElement('span', { parent: anchor });

    const hitStack = [span, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => [],
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, span, { x: 50, y: 50 });
    assert.strictEqual(rec?.media, null, 'text element must have no media');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://x.com/home',
        linkUrl: 'https://x.com/EfesBiras'
      }
    });

    assert.strictEqual(downloads.length, 0, 'no downloads for text link');
    assert.strictEqual(env.fetchedUrls.length, 0, 'no network fetches for text link');
    assert(env.badgeHistory.some((b) => b.text === 'ERR'), 'ERR badge must be flashed');
  });

  // 7. Negative: ambiguous wrapper containing two different images
  await test('7. Negative: ambiguous wrapper with two different images gives NO_MEDIA (0 fetches, 0 downloads)', async () => {
    const env = createTestEnv();
    const img1Url = 'https://cdn.example.test/picA.jpg';
    const img2Url = 'https://cdn.example.test/picB.jpg';
    env.networkSizes[img1Url] = 50000;
    env.networkSizes[img2Url] = 60000;

    const anchor = createMockElement('a', { href: 'https://example.test/album' });
    const overlay = createMockElement('div', { parent: anchor });
    const img1 = createMockElement('img', { parent: anchor, src: img1Url });
    const img2 = createMockElement('img', { parent: anchor, src: img2Url });

    // Under gesture point, both different images are detected in scope
    const hitStack = [overlay, img1, img2, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img1, img2, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert.strictEqual(rec?.media, null, 'ambiguous wrapper with different images must return no media');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://example.test/page',
        linkUrl: 'https://example.test/album'
      }
    });

    assert.strictEqual(downloads.length, 0, 'no downloads for ambiguous wrapper');
    assert.strictEqual(env.fetchedUrls.length, 0, 'no network fetches');
    assert(env.badgeHistory.some((b) => b.text === 'ERR'), 'ERR badge must be flashed');
  });

  // 8. Negative: gesture on padding outside image bounds
  await test('8. Negative: click on padding outside image bounds gives NO_MEDIA', async () => {
    const env = createTestEnv();
    const imgUrl = 'https://cdn.example.test/boxed.jpg';
    env.networkSizes[imgUrl] = 50000;

    // Card has rect 0..200, img is at 50..150
    const card = createMockElement('div', { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const anchor = createMockElement('a', { parent: card, href: 'https://example.test/card', rect: { left: 0, top: 0, width: 200, height: 200 } });
    const img = createMockElement('img', { parent: anchor, src: imgUrl, rect: { left: 50, top: 50, width: 100, height: 100 } });

    // Click at (10, 10) hits anchor and card, but NOT img
    const hitStackAtPadding = [anchor, card];
    const doc = {
      elementsFromPoint: (x, y) => {
        if (x >= 50 && x <= 150 && y >= 50 && y <= 150) return [img, anchor, card];
        return hitStackAtPadding;
      },
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, anchor, { x: 10, y: 10 });
    assert.strictEqual(rec?.media, null, 'click on padding must not select image');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://example.test/page',
        linkUrl: 'https://example.test/card'
      }
    });

    assert.strictEqual(downloads.length, 0, 'no downloads when clicking padding');
    assert.strictEqual(env.fetchedUrls.length, 0, 'no fetches when clicking padding');
  });

  // 9. Negative: stale / removed media (disconnected before save)
  await test('9. Negative: image disconnected after gesture refuses save (0 fetches, 0 downloads)', async () => {
    const env = createTestEnv();
    const imgUrl = 'https://cdn.example.test/removable.jpg';
    env.networkSizes[imgUrl] = 50000;

    const anchor = createMockElement('a', { href: 'https://example.test/link' });
    const overlay = createMockElement('div', { parent: anchor });
    const img = createMockElement('img', { parent: anchor, src: imgUrl });

    const hitStack = [overlay, img, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert(rec?.media !== null, 'media recorded at gesture');

    // Element removed from DOM before context menu action
    img.isConnected = false;

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://example.test/page',
        linkUrl: 'https://example.test/link'
      }
    });

    assert.strictEqual(downloads.length, 0, 'no downloads for disconnected media');
    assert.strictEqual(env.fetchedUrls.length, 0, 'no fetches for disconnected media');
    assert(env.badgeHistory.some((b) => b.text === 'ERR'), 'ERR badge must be flashed');
  });

  // 10. Negative: replaced media (src mutated after gesture)
  await test('10. Negative: image src changed after gesture refuses save (0 fetches, 0 downloads)', async () => {
    const env = createTestEnv();
    const oldUrl = 'https://cdn.example.test/original.jpg';
    const newUrl = 'https://cdn.example.test/mutated.jpg';
    env.networkSizes[oldUrl] = 50000;
    env.networkSizes[newUrl] = 60000;

    const anchor = createMockElement('a', { href: 'https://example.test/link' });
    const overlay = createMockElement('div', { parent: anchor });
    const img = createMockElement('img', { parent: anchor, src: oldUrl });

    const hitStack = [overlay, img, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert(rec?.media?.url === oldUrl, 'recorded original url');

    // Mutate image src
    img.src = newUrl;
    img.currentSrc = newUrl;

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://example.test/page',
        linkUrl: 'https://example.test/link'
      }
    });

    assert.strictEqual(downloads.length, 0, 'no downloads for mutated media');
    assert.strictEqual(env.fetchedUrls.length, 0, 'no fetches for mutated media');
    assert(env.badgeHistory.some((b) => b.text === 'ERR'), 'ERR badge must be flashed');
  });

  // 11. Negative: untrusted synthetic gesture (isTrusted: false)
  await test('11. Negative: synthetic event (isTrusted: false) is ignored and gives NO_MEDIA', async () => {
    const env = createTestEnv();
    const imgUrl = 'https://cdn.example.test/pic.jpg';
    env.networkSizes[imgUrl] = 50000;

    const anchor = createMockElement('a', { href: 'https://example.test/link' });
    const img = createMockElement('img', { parent: anchor, src: imgUrl });

    const hitStack = [img, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => [img, anchor],
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, img, { trusted: false });
    assert.strictEqual(rec, null, 'untrusted event must not create gesture record');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://example.test/page',
        linkUrl: 'https://example.test/link'
      }
    });

    assert.strictEqual(downloads.length, 0, 'no downloads for untrusted event');
    assert.strictEqual(env.fetchedUrls.length, 0, 'no fetches for untrusted event');
  });

  // 12. Negative: left click (button: 0) does not record context target
  await test('12. Negative: left-click (button: 0) does not record context target', async () => {
    const env = createTestEnv();
    const imgUrl = 'https://cdn.example.test/pic.jpg';

    const anchor = createMockElement('a', { href: 'https://example.test/link' });
    const img = createMockElement('img', { parent: anchor, src: imgUrl });

    const hitStack = [img, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => [img, anchor],
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, img, { type: 'mousedown', button: 0 });
    assert.strictEqual(rec, null, 'left click must not record context target');
  });

  // 13. Negative: gesture older than 30s is rejected
  await test('13. Negative: gesture older than 30s is rejected as stale', async () => {
    const env = createTestEnv();
    const imgUrl = 'https://cdn.example.test/pic.jpg';
    env.networkSizes[imgUrl] = 50000;

    const anchor = createMockElement('a', { href: 'https://example.test/link' });
    const overlay = createMockElement('div', { parent: anchor });
    const img = createMockElement('img', { parent: anchor, src: imgUrl });

    const hitStack = [overlay, img, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => [img, anchor],
      querySelector: () => null,
      hidden: false
    };

    // Stale gesture: 35 seconds old
    const { rec } = simulateGesture(doc, overlay, { ageMs: 35000 });
    assert(rec !== null, 'gesture was recorded');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://example.test/page',
        linkUrl: 'https://example.test/link'
      }
    });

    assert.strictEqual(downloads.length, 0, 'stale gesture must be refused');
    assert.strictEqual(env.fetchedUrls.length, 0, 'no network fetches');
  });

  // 14. Negative: cross-frame isolation (frame 0 does not borrow frame 5 gesture)
  await test('14. Negative: cross-frame isolation: frame 0 click does not borrow frame 5 gesture', async () => {
    const env = createTestEnv();
    const imgUrl = 'https://cdn.example.test/frame_img.jpg';
    env.networkSizes[imgUrl] = 50000;

    const anchor5 = createMockElement('a', { href: 'https://example.test/f5' });
    const img5 = createMockElement('img', { parent: anchor5, src: imgUrl });
    const doc5 = {
      elementsFromPoint: () => [img5, anchor5],
      querySelectorAll: () => [img5, anchor5],
      querySelector: () => null,
      hidden: false
    };

    const anchor0 = createMockElement('a', { href: 'https://example.test/f0' });
    const doc0 = {
      elementsFromPoint: () => [anchor0],
      querySelectorAll: () => [anchor0],
      querySelector: () => null,
      hidden: false
    };

    const { rec: rec5 } = simulateGesture(doc5, img5, { x: 50, y: 50 });

    // Click occurs in frame 0, but only frame 5 has a gesture record
    const downloads = await executeSaveClick(env, {
      docs: { 0: doc0, 5: doc5 },
      recs: { 5: rec5 },
      frameId: 0,
      info: {
        pageUrl: 'https://example.test/page',
        linkUrl: 'https://example.test/f0'
      }
    });

    assert.strictEqual(downloads.length, 0, 'frame 0 must not borrow frame 5 gesture');
    assert.strictEqual(env.fetchedUrls.length, 0, 'no fetches');
  });

  // 15. Regression (PR #21): anchor containing overlay, blob VIDEO, IMG, and CSS background with matching URL
  await test('15. Regression: overlay over blob VIDEO + IMG + matching CSS background must refuse (0 fetches, 0 downloads)', async () => {
    const env = createTestEnv();
    const posterUrl = 'https://cdn.example.test/media/poster.jpg';
    env.networkSizes[posterUrl] = 50000;

    const anchor = createMockElement('a', { href: 'https://example.test/video' });
    const overlay = createMockElement('div', { parent: anchor });
    const video = createMockElement('video', { parent: anchor, src: 'blob:https://example.test/player1' });
    const img = createMockElement('img', { parent: anchor, src: posterUrl });
    const cssBackground = createMockElement('div', { parent: anchor, bg: `url("${posterUrl}")` });

    const hitStack = [overlay, video, img, cssBackground, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert.strictEqual(rec?.media, null, 'must NOT record media when video candidate is present');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://example.test/feed',
        linkUrl: 'https://example.test/video'
      }
    });

    assert.strictEqual(downloads.length, 0, 'must have zero downloads for ambiguous video+img candidate');
    assert.strictEqual(env.fetchedUrls.length, 0, 'must have zero network fetches');
  });

  // 16. Negative: overlay over empty-src VIDEO + IMG + matching CSS background
  await test('16. Negative: overlay over empty-src VIDEO + IMG + matching CSS background must refuse', async () => {
    const env = createTestEnv();
    const posterUrl = 'https://cdn.example.test/media/empty_vid_poster.jpg';
    env.networkSizes[posterUrl] = 50000;

    const anchor = createMockElement('a', { href: 'https://example.test/video' });
    const overlay = createMockElement('div', { parent: anchor });
    const video = createMockElement('video', { parent: anchor, src: '' });
    const img = createMockElement('img', { parent: anchor, src: posterUrl });
    const cssBackground = createMockElement('div', { parent: anchor, bg: `url("${posterUrl}")` });

    const hitStack = [overlay, video, img, cssBackground, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert.strictEqual(rec?.media, null, 'empty-src video must prevent media recording');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: { pageUrl: 'https://example.test/feed', linkUrl: 'https://example.test/video' }
    });
    assert.strictEqual(downloads.length, 0);
    assert.strictEqual(env.fetchedUrls.length, 0);
  });

  // 17. Negative: overlay over direct MP4 VIDEO + IMG + matching CSS background
  await test('17. Negative: overlay over direct MP4 VIDEO + IMG + matching CSS background must refuse', async () => {
    const env = createTestEnv();
    const posterUrl = 'https://cdn.example.test/media/direct_poster.jpg';
    const videoUrl = 'https://cdn.example.test/media/direct_video.mp4';
    env.networkSizes[posterUrl] = 50000;
    env.networkSizes[videoUrl] = 500000;

    const anchor = createMockElement('a', { href: 'https://example.test/video' });
    const overlay = createMockElement('div', { parent: anchor });
    const video = createMockElement('video', { parent: anchor, src: videoUrl });
    const img = createMockElement('img', { parent: anchor, src: posterUrl });
    const cssBackground = createMockElement('div', { parent: anchor, bg: `url("${posterUrl}")` });

    const hitStack = [overlay, video, img, cssBackground, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert.strictEqual(rec?.media, null, 'direct video must prevent media recording');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: { pageUrl: 'https://example.test/feed', linkUrl: 'https://example.test/video' }
    });
    assert.strictEqual(downloads.length, 0);
    assert.strictEqual(env.fetchedUrls.length, 0);
  });

  // 18. Negative: multiple IMG candidates with identical URLs must NOT be coalesced
  await test('18. Negative: multiple IMG candidates even with identical URLs must refuse', async () => {
    const env = createTestEnv();
    const sharedUrl = 'https://cdn.example.test/media/shared.jpg';
    env.networkSizes[sharedUrl] = 50000;

    const anchor = createMockElement('a', { href: 'https://example.test/gallery' });
    const overlay = createMockElement('div', { parent: anchor });
    const img1 = createMockElement('img', { parent: anchor, src: sharedUrl });
    const img2 = createMockElement('img', { parent: anchor, src: sharedUrl });
    const cssBackground = createMockElement('div', { parent: anchor, bg: `url("${sharedUrl}")` });

    const hitStack = [overlay, img1, img2, cssBackground, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img1, img2, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert.strictEqual(rec?.media, null, 'multiple IMGs even with identical URL must refuse');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: { pageUrl: 'https://example.test/page', linkUrl: 'https://example.test/gallery' }
    });
    assert.strictEqual(downloads.length, 0);
    assert.strictEqual(env.fetchedUrls.length, 0);
  });

  // 19. Negative: conflicting CSS background with different URL
  await test('19. Negative: conflicting CSS background with different URL must refuse', async () => {
    const env = createTestEnv();
    const avatarUrl = 'https://cdn.example.test/avatar.jpg';
    const otherUrl = 'https://cdn.example.test/other.jpg';
    env.networkSizes[avatarUrl] = 50000;
    env.networkSizes[otherUrl] = 40000;

    const anchor = createMockElement('a', { href: 'https://example.test/user' });
    const overlay = createMockElement('div', { parent: anchor });
    const img = createMockElement('img', { parent: anchor, src: avatarUrl });
    const cssBg1 = createMockElement('div', { parent: anchor, bg: `url("${avatarUrl}")` });
    const cssBg2 = createMockElement('div', { parent: anchor, bg: `url("${otherUrl}")` });

    const hitStack = [overlay, img, cssBg1, cssBg2, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert.strictEqual(rec?.media, null, 'conflicting CSS background must refuse');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: { pageUrl: 'https://example.test/home', linkUrl: 'https://example.test/user' }
    });
    assert.strictEqual(downloads.length, 0);
    assert.strictEqual(env.fetchedUrls.length, 0);
  });

  // 20. Negative: CSS background with multiple background images (multi)
  await test('20. Negative: CSS decoration with multiple backgrounds (multi) must refuse', async () => {
    const env = createTestEnv();
    const avatarUrl = 'https://cdn.example.test/avatar.jpg';
    const bg1 = 'https://cdn.example.test/bg1.jpg';
    const bg2 = 'https://cdn.example.test/bg2.jpg';
    env.networkSizes[avatarUrl] = 50000;

    const anchor = createMockElement('a', { href: 'https://example.test/user' });
    const overlay = createMockElement('div', { parent: anchor });
    const img = createMockElement('img', { parent: anchor, src: avatarUrl });
    const cssMulti = createMockElement('div', { parent: anchor, bg: `url("${bg1}"), url("${bg2}")` });

    const hitStack = [overlay, img, cssMulti, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert.strictEqual(rec?.media, null, 'multi CSS background must refuse');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: { pageUrl: 'https://example.test/home', linkUrl: 'https://example.test/user' }
    });
    assert.strictEqual(downloads.length, 0);
  });

  // 21. Negative: overlay probe points failure (second asset at corner probe point)
  await test('21. Negative: overlay probe points: different element at corner probe refuses detect()', async () => {
    const env = createTestEnv();
    const avatarUrl = 'https://cdn.example.test/avatar.jpg';
    env.networkSizes[avatarUrl] = 50000;

    const anchor = createMockElement('a', { href: 'https://example.test/user', rect: { left: 0, top: 0, width: 100, height: 100 } });
    const overlay = createMockElement('div', { parent: anchor, rect: { left: 0, top: 0, width: 100, height: 100 } });
    const img1 = createMockElement('img', { parent: anchor, src: avatarUrl, rect: { left: 0, top: 0, width: 100, height: 100 } });
    const img2 = createMockElement('img', { parent: anchor, src: 'https://cdn.example.test/corner.jpg', rect: { left: 0, top: 0, width: 10, height: 10 } });

    const doc = {
      elementsFromPoint: (x, y) => {
        // At corner (5, 5), img2 is under pointer
        if (x <= 10 && y <= 10) return [overlay, img2, img1, anchor];
        return [overlay, img1, anchor];
      },
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img1, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert.strictEqual(rec?.media, null, 'corner probe revealing another element must refuse detect()');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: { pageUrl: 'https://example.test/home', linkUrl: 'https://example.test/user' }
    });
    assert.strictEqual(downloads.length, 0);
  });

  // 22. Scope containment: elements outside target's parent scope are not candidates
  await test('22. Scope containment: media outside immediate scope does not cause ambiguity', async () => {
    const env = createTestEnv();
    const avatarUrl = 'https://cdn.example.test/avatar.jpg';
    const outsideUrl = 'https://cdn.example.test/outside.jpg';
    env.networkSizes[avatarUrl] = 50000;

    const pageRoot = createMockElement('div');
    const outsideImg = createMockElement('img', { parent: pageRoot, src: outsideUrl });
    const anchor = createMockElement('a', { parent: pageRoot, href: 'https://example.test/user' });
    const overlay = createMockElement('div', { parent: anchor });
    const img = createMockElement('img', { parent: anchor, src: avatarUrl });

    // Hit stack includes outsideImg from pageRoot, but outsideImg is not inside anchor (scope)
    const hitStack = [overlay, img, anchor, outsideImg, pageRoot];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert(rec?.media !== null, 'media should be resolved within scope');
    assert.strictEqual(rec.media.url, avatarUrl, 'must resolve scoped avatar');

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: { pageUrl: 'https://example.test/home', linkUrl: 'https://example.test/user' }
    });
    assert.strictEqual(downloads.length, 1);
    assert.strictEqual(downloads[0].url, avatarUrl);
  });

  // 23. Stale / reparented target after gesture: media.check() fails
  await test('23. Negative: reparented media element after gesture fails media.check()', async () => {
    const env = createTestEnv();
    const avatarUrl = 'https://cdn.example.test/avatar.jpg';
    env.networkSizes[avatarUrl] = 50000;

    const anchor = createMockElement('a', { href: 'https://example.test/user' });
    const overlay = createMockElement('div', { parent: anchor });
    const img = createMockElement('img', { parent: anchor, src: avatarUrl });

    const hitStack = [overlay, img, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert(rec?.media !== null, 'media recorded at gesture');

    // Reparent img to a foreign container
    const foreign = createMockElement('div');
    img.parentElement = foreign;

    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: { pageUrl: 'https://example.test/home', linkUrl: 'https://example.test/user' }
    });
    assert.strictEqual(downloads.length, 0, 'reparented media must refuse');
    assert.strictEqual(env.fetchedUrls.length, 0);
  });

  // 24. Ordinary video recovery under overlay preserved (single video under overlay)
  await test('24. Ordinary video recovery: overlay covering single video resolves video target', async () => {
    const env = createTestEnv();
    const videoUrl = 'https://cdn.example.test/videos/sample.mp4';

    const container = createMockElement('div');
    const overlay = createMockElement('div', { parent: container });
    const video = createMockElement('video', { parent: container, src: videoUrl });

    const hitStack = [overlay, video, container];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => [],
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, overlay, { x: 50, y: 50 });
    assert(rec?.media !== null, 'video media must be recorded');
    assert.strictEqual(rec.media.kind, 'video', 'kind must be video');
    assert.strictEqual(rec.media.url, videoUrl, 'url must match video url');
    assert.strictEqual(rec.media.check(), true, 'check() must pass');
  });

  // 25. Settings parity: positive avatar save respects subfolder and ignores legacy Save As
  await test('25. Settings parity: avatar save respects subfolder routing and ignores legacy Save As', async () => {
    const env = createTestEnv();
    const avatarNormal = 'https://pbs.twimg.com/profile_images/1111/user_normal.jpg';
    const avatarOrig = 'https://pbs.twimg.com/profile_images/1111/user_400x400.jpg';
    env.networkSizes[avatarNormal] = 10000;
    env.networkSizes[avatarOrig] = 60000;

    env.mockChrome.storage.local.get = async () => ({
      subfolder: 'TwitterAvatars',
      folderOrganizationMode: 'single',
      askEveryTime: true
    });

    const anchor = createMockElement('a', { href: 'https://x.com/SomeUser', attrs: { role: 'link' } });
    const presWrap = createMockElement('div', { parent: anchor });
    const imgWrap = createMockElement('div', { parent: presWrap });
    const bgDiv = createMockElement('div', { parent: imgWrap, bg: `url("${avatarNormal}")` });
    const img = createMockElement('img', { parent: imgWrap, src: avatarNormal });
    const touchOverlay = createMockElement('div', { parent: presWrap });

    const hitStack = [touchOverlay, img, bgDiv, imgWrap, presWrap, anchor];
    const doc = {
      elementsFromPoint: (x, y) => hitStack,
      querySelectorAll: (q) => (q === 'img, picture, [srcset], a[href]' ? [img, anchor] : []),
      querySelector: () => null,
      hidden: false
    };

    const { rec } = simulateGesture(doc, touchOverlay, { x: 50, y: 50 });
    const downloads = await executeSaveClick(env, {
      docs: { 0: doc },
      recs: { 0: rec },
      info: {
        pageUrl: 'https://x.com/SomeUser',
        linkUrl: 'https://x.com/SomeUser'
      }
    });

    assert.strictEqual(downloads.length, 1, 'download initiated');
    assert.strictEqual(downloads[0].url, avatarOrig, 'original url chosen');
    assert.strictEqual(downloads[0].saveAs, false, 'legacy askEveryTime=true must not open a save dialog');
    assert(downloads[0].filename.includes('TwitterAvatars'), 'filename must route to configured subfolder');
  });

  // Menu policy: avatars can be saved from a profile, but not from a feed or profile hovercard in the feed.
  const avatar = { kind: 'img', url: 'https://pbs.twimg.com/profile_images/1111/user_normal.jpg' };
  const cases = [
    ['feed profile-link overlay', 'https://x.com/home', null, 'https://x.com/_A1nS', false],
    ['profile avatar link', 'https://x.com/caitaron', avatar, 'https://x.com/caitaron/photo', true],
    ['direct feed avatar', 'https://x.com/home', avatar, null, false],
    ['unproven CSS profile avatar', 'https://x.com/caitaron', { ...avatar, kind: 'css' }, 'https://x.com/caitaron/photo', false],
    ['profile-post avatar without photo link', 'https://x.com/XellviaVT', avatar, null, false],
    ['profile-post author avatar', 'https://x.com/XellviaVT', avatar, 'https://x.com/LOCONGAMER01', false],
    ['unresolved profile photo link', 'https://x.com/XellviaVT', null, 'https://x.com/XellviaVT/photo', false],
    ['foreign profile photo link', 'https://x.com/XellviaVT', avatar, 'https://x.com/LOCONGAMER01/photo', false],
    ['invalid profile photo link', 'https://x.com/XellviaVT', avatar, 'not a URL', false],
    ['profile media tab', 'https://x.com/caitaron/media', avatar, 'https://x.com/caitaron/photo', true],
    ['profile replies tab', 'https://x.com/caitaron/with_replies', avatar, 'https://x.com/caitaron/photo', true],
    ['profile likes tab', 'https://x.com/caitaron/likes', avatar, 'https://x.com/caitaron/photo', true],
    ['profile query and trailing slash', 'https://x.com/caitaron/?view=full', avatar, 'https://x.com/caitaron/photo', true],
    ['Twitter profile avatar', 'https://twitter.com/caitaron', avatar, 'https://twitter.com/caitaron/photo', true],
    ['feed hovercard avatar', 'https://x.com/home', avatar, 'https://x.com/caitaron/photo', false],
    ['search-result avatar', 'https://x.com/search?q=art', avatar, null, false],
    ['explore avatar', 'https://x.com/explore', avatar, null, false],
    ['notifications avatar', 'https://x.com/notifications', avatar, null, false],
    ['post-page avatar', 'https://x.com/caitaron/status/123', avatar, null, false],
    ['profile text link without media', 'https://x.com/caitaron', null, 'https://x.com/caitaron/photo', false, false],
    ['opened profile avatar', 'https://x.com/caitaron/photo', avatar, null, true],
    ['ordinary X post photo', 'https://x.com/home', { kind: 'img', url: 'https://pbs.twimg.com/media/OWN.jpg' }, 'https://x.com/author', true],
    ['X video', 'https://x.com/home', { kind: 'video', url: 'https://video.twimg.com/ext_tw_video/123/clip.mp4' }, 'https://x.com/author', true],
    ['avatar asset outside X', 'https://example.test/profile', avatar, null, true],
    ['Twitter preview', 'https://twitter.com/home', avatar, 'https://twitter.com/author', false],
    ['Twitter full photo', 'https://twitter.com/author/photo?view=full', avatar, null, true]
  ];
  for (const [label, page, media, linkHref, expected, selectable = true] of cases) {
    await test('26. Avatar menu policy: ' + label, async () => {
      const env = createTestEnv(); const props = [];
      env.mockChrome.contextMenus.update = (id, p, cb) => { if (id === 'save-image-item') props.push(p); if (cb) cb(); };
      const sender = { id: env.mockChrome.runtime.id, tab: { id: 1, active: true }, frameId: 0, documentId: 'avatar-policy', url: page };
      const deliver = async (msg) => { for (const f of env.mockChrome.runtime.onMessage._listeners) f(msg, sender, () => {}); await Promise.resolve(); };
      await deliver({ action: 'CONTEXT_TARGET_STATE', source: 'gesture', phase: 'down', gestureAt: 1, selectable, media, linkHref });
      assert.strictEqual(props.find((p) => 'visible' in p)?.visible, expected);
      assert.strictEqual(env.fetchedUrls.length, 0, 'menu policy does not resolve or fetch media');
      assert.strictEqual(env.downloadedCalls.length, 0, 'menu policy does not initiate downloads');
      if (!expected) {
        await deliver({ action: 'X_MEDIA_CONTEXTMENU_DETECTED', gestureAt: 1, media: { type: 'image', url: avatar.url } });
        assert(!props.some((p) => p.visible === true), 'provider label cannot resurrect a hidden preview action');
        sender.url = 'https://x.com/caitaron/photo';
        await deliver({ action: 'CONTEXT_TARGET_STATE', source: 'gesture', phase: 'down', gestureAt: 2, selectable: true, media: avatar, linkHref: null });
        assert.strictEqual(props.filter((p) => 'visible' in p).at(-1).visible, true, 'opened full avatar restores the action');
      }
    });
  }

  // Native link context: pointer-events:none images are absent from elementsFromPoint.
  const linkedImage = (url = avatar.url) => {
    const outer = createMockElement('div');
    const anchor = createMockElement('a', { parent: outer, href: 'https://x.com/caitaron/photo' });
    const image = createMockElement('img', { parent: anchor, src: url });
    image._computed = { pointerEvents: 'none' };
    anchor.querySelectorAll = (q) => q.includes('img') ? [image] : [];
    const doc = { elementsFromPoint: () => [anchor, outer], hidden: false };
    return { anchor, image, doc };
  };
  await test('27. Link-only profile avatar capture produces one IMG, visible menu and a real save', async () => {
    const f = linkedImage(); const env = createTestEnv();
    env.networkSizes[avatar.url] = 60000;
    const { rec, messages } = simulateGesture(f.doc, f.anchor, { timeStamp: 1 });
    assert.strictEqual(rec?.media?.kind, 'img');
    assert.strictEqual(rec.media.url, avatar.url);
    assert.strictEqual(rec.media.check(), true);
    const props = [];
    env.mockChrome.contextMenus.update = (id, p, cb) => { props.push(p); if (cb) cb(); };
    const sender = { id: env.mockChrome.runtime.id, tab: { id: 1, active: true }, frameId: 0, documentId: 'linked-avatar', url: 'https://x.com/caitaron' };
    for (const message of messages) for (const listener of env.mockChrome.runtime.onMessage._listeners) listener(message, sender, () => {});
    await Promise.resolve();
    assert.strictEqual(props.filter(p => 'visible' in p).at(-1).visible, true);
    const saved = await executeSaveClick(env, { docs: { 0: f.doc }, recs: { 0: rec }, info: { pageUrl: sender.url, linkUrl: f.anchor.href } });
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].url, avatar.url);
    assert(!env.fetchedUrls.includes(f.anchor.href), 'never fetch profile HTML');
  });
  await test('27. The same linked image appearing in both query and hit stack is not ambiguous', async () => {
    const f = linkedImage(); f.doc.elementsFromPoint = () => [f.anchor, f.image];
    assert.strictEqual(simulateGesture(f.doc, f.anchor).rec?.media?.kind, 'img');
  });
  await test('27. Generic linked image with pointer-events:none uses the same capture', async () => {
    const f = linkedImage('https://example.test/image.jpg'); f.anchor.href = 'https://example.test/item';
    assert.strictEqual(simulateGesture(f.doc, f.anchor).rec?.media?.url, 'https://example.test/image.jpg');
  });
  await test('27. Two linked descendant images with identical URLs are ambiguous', async () => {
    const f = linkedImage(); const other = createMockElement('img', { parent: f.anchor, src: avatar.url });
    f.anchor.querySelectorAll = q => q.includes('img') ? [f.image, other] : [];
    assert.strictEqual(simulateGesture(f.doc, f.anchor).rec.media, null);
  });
  await test('27. Linked-image capture is re-proven after its source changes', async () => {
    const f = linkedImage(); const env = createTestEnv(); const { rec } = simulateGesture(f.doc, f.anchor);
    assert.strictEqual(rec?.media?.kind, 'img');
    f.image.src = f.image.currentSrc = 'https://pbs.twimg.com/profile_images/9999/replacement.jpg';
    assert.strictEqual(rec.media.check(), false);
    const saved = await executeSaveClick(env, { docs: { 0: f.doc }, recs: { 0: rec }, info: { pageUrl: 'https://x.com/caitaron', linkUrl: f.anchor.href } });
    assert.strictEqual(saved.length, 0); assert.strictEqual(env.fetchedUrls.length, 0);
  });
  for (const condition of ['outside point', 'broad padding', 'hidden', 'transparent', 'too many', 'not a link']) {
    await test('27. Linked-image negative: ' + condition, async () => {
      const f = linkedImage();
      if (condition === 'outside point') f.image._rect.left = 200;
      if (condition === 'broad padding') f.image._rect.width = 60;
      if (condition === 'hidden') f.image._computed.visibility = 'hidden';
      if (condition === 'transparent') f.image._computed.opacity = '0';
      if (condition === 'too many') f.anchor.querySelectorAll = q => q.includes('img') ? Array.from({ length: 25 }, () => f.image) : [];
      if (condition === 'not a link') f.anchor.tagName = 'DIV';
      assert.strictEqual(simulateGesture(f.doc, f.anchor).rec.media, null);
    });
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

module.exports = { createTestEnv, createMockElement, simulateGesture, executeSaveClick };

if (require.main === module) {
  runAllTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}
