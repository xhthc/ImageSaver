// test_reddit_frame_lifecycle.js - Focused production-backed regression tests for
// Reddit inline RedGIFs embed frame and pinned-document lifecycle.
//
// Traces:
//   handleRedditInlineSave -> redditInlineRun -> redditInlineFindRedGifsFrame
//   -> onContextMenuClicked -> resolveMediaTarget -> resolveFrameLocalMedia
//
// Grounded in native reproduction from serviceworker.md (clip evilunequaledbufflehead):
//   Discovery finds frame 393 with documentId F4DFACCA4D03CA6899BB4FB205485CB8;
//   later injection fails with "Error: No document with id ... in tab with id ...";
//   operation stops cleanly with UNRESOLVED_BLOB_MEDIA, zero network fetches and zero downloads.
//
// Covers:
//   1. Unchanged-document positive control (successful HD video download, exact fetch & pinned injection)
//   2. Exact serviceworker.md reproduction: document disappears between find and inject -> zero fetches, zero downloads
//   3. Document replaced by another document in same frame (navigation/reload race) -> zero fetches, zero downloads
//   4. Frame navigates to a different clip (clip mismatch refusal) -> zero fetches, zero downloads
//   5. Duplicate matching frames in tab (ambiguity refusal) -> zero fetches, zero downloads, zero child messages
//   6. Non-direct-child frame (nested cross-origin frame refusal) -> zero fetches, zero downloads, zero child messages
//   7. Refused cases strictly never fetch or download unverified ID-derived candidate or silent variant
//   8. Positive user-initiated recovery: fresh trusted user save after refusal succeeds with new document ID

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

let passed = 0;
let failed = 0;

async function test(desc, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + desc);
  } catch (err) {
    failed++;
    console.error('  ✗ ' + desc);
    console.error(err.stack || err.message || err);
  }
}

const EXT_ID = 'imagesaverextid0001';
const TAB_ID = 525188672;
const CLIP_EVIL = 'evilunequaledbufflehead';
const CLIP_WILD = 'wildcheetahexample';
const REDDIT_POST_URL = 'https://www.reddit.com/r/RedGIFsAmateur/comments/1qzjm4p/anime_gif_by_hentaiuni/';
const REDDIT_OWNER_ID = 't3_1qzjm4p';
const INLINE_TOKEN_1 = '0123456789abcdef0123456789abcdef';
const INLINE_TOKEN_2 = 'fedcba9876543210fedcba9876543210';

function storageArea(initial = {}) {
  const store = { ...initial };
  return {
    get: async (keys) => {
      if (!keys) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) { const r = {}; for (const k of keys) r[k] = store[k]; return r; }
      if (typeof keys === 'object') { const r = {}; for (const [k, d] of Object.entries(keys)) r[k] = store[k] !== undefined ? store[k] : d; return r; }
      return { ...store };
    },
    set: async (items) => { Object.assign(store, items); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; },
    clear: async () => { for (const k of Object.keys(store)) delete store[k]; }
  };
}

// Builds a clean VM harness running the REAL background.js with controllable frame state.
function createHarness({ frames = [] } = {}) {
  const listeners = [];
  const downloads = [];
  const badges = [];
  const warns = [];
  const logs = [];
  const fetches = [];
  const sentMessages = [];
  const injections = [];
  const downloadChangedListeners = [];
  let tabFrames = frames.map((f) => ({ ...f }));
  let terminalResolver = null;

  function notifyTerminal() {
    if (terminalResolver) {
      terminalResolver();
      terminalResolver = null;
    }
  }

  const chromeMock = {
    runtime: {
      id: EXT_ID,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async () => ({ success: true }),
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      getContexts: async () => []
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {}
    },
    contextMenus: {
      removeAll: (cb) => { if (cb) cb(); },
      create() {},
      update: (_id, _p, cb) => { if (cb) cb(); },
      refresh() {},
      onClicked: { addListener() {} },
      onShown: { addListener() {} }
    },
    windows: {
      create: async () => ({ id: 1 }),
      onFocusChanged: { addListener() {} },
      onRemoved: { addListener() {} }
    },
    storage: {
      local: storageArea({ subfolder: 'SavedImages', folderOrganizationMode: 'single', askEveryTime: false }),
      session: storageArea()
    },
    action: {
      setBadgeText: async (details) => {
        badges.push({ type: 'text', ...details });
        if (details && (details.text === 'OK' || details.text === 'ERR')) {
          notifyTerminal();
        }
      },
      setBadgeBackgroundColor: async (details) => { badges.push({ type: 'color', ...details }); }
    },
    downloads: {
      download: async (options) => {
        const id = 1350 + downloads.length + 1;
        downloads.push({ id, ...options });
        setTimeout(async () => {
          for (const cb of downloadChangedListeners) {
            try { await cb({ id, state: { current: 'complete' } }); } catch (_) {}
          }
        }, 10);
        return id;
      },
      search: async (query, cb) => {
        const item = { id: query?.id || 1351, state: 'complete', filename: 'SavedImages/item.mp4', mime: 'video/mp4' };
        if (cb) cb([item]);
        return [item];
      },
      onChanged: {
        addListener: (cb) => { downloadChangedListeners.push(cb); }
      }
    },
    tabs: {
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      sendMessage: async (tabId, msg, options = {}) => {
        sentMessages.push({ tabId, msg, options: JSON.parse(JSON.stringify(options)) });
        const targetFrameId = options.frameId === undefined ? 0 : options.frameId;

        // Top document responds to REDDIT_INLINE_OWNER verification:
        if (targetFrameId === 0) {
          if (msg && msg.action === 'REDDIT_INLINE_OWNER') {
            return {
              ok: true,
              media: {
                kind: 'video',
                url: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
                redgifsEmbed: true,
                ownerId: REDDIT_OWNER_ID,
                postUrl: REDDIT_POST_URL
              }
            };
          }
          return null;
        }

        // Child frame message delivery (RESOLVE_FRAME_MEDIA):
        const frame = tabFrames.find((f) => f.frameId === targetFrameId && f.alive);
        if (!frame) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }

        if (options.documentId && options.documentId !== frame.documentId) {
          throw new Error(`No document with id ${options.documentId} in tab with id ${tabId}`);
        }

        if (msg && msg.action === 'RESOLVE_FRAME_MEDIA') {
          if (!frame.hasScript) {
            // Content script not yet injected: triggers fallback to executeScript
            throw new Error('Could not establish connection. Receiving end does not exist.');
          }
          const clip = frame.clipKey || CLIP_EVIL;
          const urlName = clip === CLIP_EVIL ? 'EvilUnequaledBufflehead' : (clip === CLIP_WILD ? 'WildCheetahExample' : clip);
          const hdUrl = `https://media.redgifs.com/${urlName}.mp4`;
          return {
            success: true,
            targetUrl: hdUrl,
            clipId: clip,
            candidateAudio: { [hdUrl]: 'present' },
            candidates: [hdUrl],
            diagnostics: { videoId: clip, providerAudio: 'present' }
          };
        }
        return null;
      }
    },
    scripting: {
      executeScript: async (opts) => {
        injections.push({
          target: { ...opts?.target },
          files: opts?.files ? [...opts.files] : undefined,
          isFunc: typeof opts?.func === 'function'
        });

        // 1. Discovery probe: target = { tabId, allFrames: true }, func = ...
        if (opts && opts.target && opts.target.allFrames && typeof opts.func === 'function') {
          const results = [{ frameId: 0, documentId: 'doc-top-reddit', result: { href: REDDIT_POST_URL, child: false } }];
          for (const f of tabFrames.filter((x) => x.alive)) {
            results.push({
              frameId: f.frameId,
              documentId: f.documentId,
              result: { href: f.href, child: f.child !== false }
            });
          }
          return results;
        }

        // 2. Targeted injection: target = { tabId, documentIds: [...] } or { tabId, frameIds: [...] }
        if (opts && opts.target && Array.isArray(opts.target.documentIds)) {
          const targetDocId = opts.target.documentIds[0];
          const frame = tabFrames.find((f) => f.alive && f.documentId === targetDocId);
          if (!frame) {
            // Matches native Chromium error observed in serviceworker.md:
            throw new Error(`No document with id ${targetDocId} in tab with id ${opts.target.tabId}`);
          }
          frame.hasScript = true;
          return [{ frameId: frame.frameId, documentId: frame.documentId, result: null }];
        }

        if (opts && opts.target && Array.isArray(opts.target.frameIds)) {
          const targetFrameId = opts.target.frameIds[0];
          const frame = tabFrames.find((f) => f.alive && f.frameId === targetFrameId);
          if (!frame) {
            throw new Error(`No frame with id ${targetFrameId} in tab with id ${opts.target.tabId}`);
          }
          frame.hasScript = true;
          return [{ frameId: frame.frameId, documentId: frame.documentId, result: null }];
        }

        return [{ result: null }];
      }
    }
  };

  const sandbox = {
    chrome: chromeMock,
    console: {
      log: (...a) => { logs.push(a.map(String).join(' ')); },
      info: (...a) => { logs.push(a.map(String).join(' ')); },
      warn: (...a) => { warns.push(a.map(String).join(' ')); },
      error: (...a) => { warns.push(a.map(String).join(' ')); },
      debug() {}
    },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    AbortController,
    window: { location: { href: REDDIT_POST_URL } },
    document: {
      elementsFromPoint: () => [],
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null
    }
  };

  sandbox.fetch = async (url, init = {}) => {
    const urlStr = String(url);
    fetches.push({
      url: urlStr,
      method: init?.method || 'GET',
      headers: { ...(init?.headers || {}) }
    });
    if (/media\.redgifs\.com\/.*\.mp4/i.test(urlStr)) {
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'video/mp4' : '32317984') },
        arrayBuffer: async () => new ArrayBuffer(1024)
      };
    }
    return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
  };

  vm.createContext(sandbox);
  sandbox.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), sandbox);

  // Awaits production-handler terminal event (OK / ERR badge or timeout), avoiding fixed sleeps
  async function triggerInlineSave({ token = INLINE_TOKEN_1, timeoutMs = 1000 } = {}) {
    const sender = {
      id: EXT_ID,
      tab: { id: TAB_ID, active: true, url: REDDIT_POST_URL },
      frameId: 0,
      documentId: 'doc-top-reddit',
      url: REDDIT_POST_URL
    };
    const terminalPromise = new Promise((resolve) => {
      terminalResolver = resolve;
    });
    for (const listener of listeners) {
      listener({ action: 'REDDIT_INLINE_SAVE', token }, sender, () => {});
    }
    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([terminalPromise, timeout]);
    await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    sandbox,
    downloads,
    badges,
    warns,
    logs,
    fetches,
    sentMessages,
    injections,
    getFrames: () => tabFrames,
    setFrames: (newFrames) => { tabFrames = newFrames; },
    triggerInlineSave
  };
}

console.log('=== Running Reddit Frame & Pinned-Document Lifecycle Suite ===\n');

(async () => {
  // Test 1: Positive Control - Unchanged document resolves and downloads audio-bearing MP4
  await test('1. Positive control: frame 393 document unchanged, resolves and downloads verified MP4 with exact fetch and pinned injection', async () => {
    const h = createHarness({
      frames: [
        {
          frameId: 393,
          documentId: 'F4DFACCA4D03CA6899BB4FB205485CB8',
          href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
          clipKey: CLIP_EVIL,
          child: true,
          alive: true,
          hasScript: false
        }
      ]
    });

    await h.triggerInlineSave();

    assert.strictEqual(h.downloads.length, 1, 'Expected exactly 1 download');
    assert.strictEqual(h.downloads[0].url, 'https://media.redgifs.com/EvilUnequaledBufflehead.mp4');
    assert.strictEqual(h.downloads[0].filename, 'SavedImages/EvilUnequaledBufflehead.mp4');
    assert(h.badges.some((b) => b.text === 'OK'), 'Expected OK badge after successful download');
    assert(!h.warns.some((w) => /Не удалось внедрить/.test(w)), 'Expected no injection error warnings');

    // Assert exact media request and pinned document ID injection:
    assert.strictEqual(h.fetches.length, 1, 'Expected exactly 1 media verification fetch');
    assert.strictEqual(h.fetches[0].url, 'https://media.redgifs.com/EvilUnequaledBufflehead.mp4', 'Expected fetch for verified MP4');
    assert(h.injections.some((inj) => inj.target?.documentIds?.includes('F4DFACCA4D03CA6899BB4FB205485CB8')),
      'Expected injection pinned to document F4DFACCA4D03CA6899BB4FB205485CB8');
    assert(!h.injections.some((inj) => inj.target && Array.isArray(inj.target.frameIds)),
      'Must never execute unpinned frameId injection');
  });

  // Test 2: Native Reproduction (serviceworker.md lines 174-197)
  // Discovery returns documentId F4DFACCA4D03CA6899BB4FB205485CB8, but document is destroyed before injection.
  await test('2. Reproduction: pinned document disappears before injection -> No document with id -> UNRESOLVED_BLOB_MEDIA (zero fetches, zero downloads)', async () => {
    const h = createHarness({
      frames: [
        {
          frameId: 393,
          documentId: 'F4DFACCA4D03CA6899BB4FB205485CB8',
          href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
          clipKey: CLIP_EVIL,
          child: true,
          alive: true,
          hasScript: false
        }
      ]
    });

    // Intercept discovery: right after discovery runs, destroy the frame document before injection
    const origExecute = h.sandbox.chrome.scripting.executeScript;
    h.sandbox.chrome.scripting.executeScript = async (opts) => {
      const res = await origExecute(opts);
      if (opts && opts.target && opts.target.allFrames) {
        // Frame document vanished from tab immediately after discovery!
        h.setFrames([]);
      }
      return res;
    };

    await h.triggerInlineSave();

    // Verification of exact native reproduction symptoms:
    assert.strictEqual(h.downloads.length, 0, 'Zero downloads must occur when pinned document is missing');
    assert.strictEqual(h.fetches.length, 0, 'Zero network fetches must occur when pinned document is missing');
    assert(h.warns.some((w) => /Не удалось внедрить content_redgifs\.js во фрейм 393: Error: No document with id F4DFACCA4D03CA6899BB4FB205485CB8/.test(w)),
      'Expected exact "No document with id" injection error warning');
    assert(h.warns.some((w) => /Embedded RedGIFs clip not resolved in its frame \(UNRESOLVED_BLOB_MEDIA\)/.test(w)),
      'Expected UNRESOLVED_BLOB_MEDIA warning');
    assert(h.warns.some((w) => /Отмена скачивания: не удалось разрешить blob URL \(UNRESOLVED_BLOB_MEDIA\)/.test(w)),
      'Expected cancellation of blob URL download');
    assert(h.badges.some((b) => b.text === 'ERR'), 'Expected ERR badge on unresolved document');
    assert(!h.injections.some((inj) => inj.target && Array.isArray(inj.target.frameIds)),
      'Must never fall back to unpinned frameIds');
    assert(!h.fetches.some((f) => f.url.includes(CLIP_EVIL)), 'Must never fetch unverified candidate on refused proof');
  });

  // Test 3: Document replaced by a new document during lookup (Navigation/reload race)
  await test('3. Navigation race: documentId changed in frame 393 before injection -> refused with ERR, zero fetches and zero downloads', async () => {
    const h = createHarness({
      frames: [
        {
          frameId: 393,
          documentId: 'doc-old-initial',
          href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
          clipKey: CLIP_EVIL,
          child: true,
          alive: true,
          hasScript: false
        }
      ]
    });

    const origExecute = h.sandbox.chrome.scripting.executeScript;
    h.sandbox.chrome.scripting.executeScript = async (opts) => {
      const res = await origExecute(opts);
      if (opts && opts.target && opts.target.allFrames) {
        // Frame reloaded and received a new documentId!
        h.setFrames([
          {
            frameId: 393,
            documentId: 'doc-new-reloaded',
            href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
            clipKey: CLIP_EVIL,
            child: true,
            alive: true,
            hasScript: false
          }
        ]);
      }
      return res;
    };

    await h.triggerInlineSave();

    assert.strictEqual(h.downloads.length, 0, 'Must not download to old or replaced document');
    assert.strictEqual(h.fetches.length, 0, 'Zero network fetches on document replacement race');
    assert(h.warns.some((w) => /No document with id doc-old-initial/.test(w)), 'Expected injection refusal for stale documentId');
    assert(h.badges.some((b) => b.text === 'ERR'), 'Expected ERR badge');
    assert(!h.injections.some((inj) => inj.target && Array.isArray(inj.target.frameIds)),
      'Must never fall back to unpinned frameIds');
  });

  // Test 4: Replaced frame document exposes a different clip (Clip mismatch)
  await test('4. Content mismatch: frame 393 navigates to another clip -> clipId mismatch refused with zero fetches and zero downloads', async () => {
    const h = createHarness({
      frames: [
        {
          frameId: 393,
          documentId: 'doc-393-different',
          href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
          clipKey: CLIP_EVIL,
          child: true,
          alive: true,
          hasScript: true
        }
      ]
    });

    // When message is delivered, the frame has navigated to CLIP_WILD
    const origSend = h.sandbox.chrome.tabs.sendMessage;
    h.sandbox.chrome.tabs.sendMessage = async (tabId, msg, options) => {
      if (msg && msg.action === 'RESOLVE_FRAME_MEDIA') {
        const urlName = 'WildCheetahExample';
        const hdUrl = `https://media.redgifs.com/${urlName}.mp4`;
        return {
          success: true,
          targetUrl: hdUrl,
          clipId: CLIP_WILD, // Foreign clip!
          candidateAudio: { [hdUrl]: 'present' },
          candidates: [hdUrl],
          diagnostics: { videoId: CLIP_WILD, providerAudio: 'present' }
        };
      }
      return origSend(tabId, msg, options);
    };

    await h.triggerInlineSave();

    assert.strictEqual(h.downloads.length, 0, 'Foreign clip must never be downloaded');
    assert.strictEqual(h.fetches.length, 0, 'Zero network fetches on clip mismatch');
    assert(h.warns.some((w) => /Embedded RedGIFs clip not resolved in its frame/.test(w)),
      'Expected UNRESOLVED_BLOB_MEDIA on clip mismatch');
    assert(h.badges.some((b) => b.text === 'ERR'), 'Expected ERR badge');
  });

  // Test 5: Duplicate matching frames in tab (Ambiguity refusal)
  await test('5. Ambiguity: two direct-child frames report same clip -> discovery returns null -> zero fetches, zero downloads, zero child messages', async () => {
    const h = createHarness({
      frames: [
        {
          frameId: 393,
          documentId: 'doc-393-dup1',
          href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
          clipKey: CLIP_EVIL,
          child: true,
          alive: true,
          hasScript: true
        },
        {
          frameId: 394,
          documentId: 'doc-394-dup2',
          href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
          clipKey: CLIP_EVIL,
          child: true,
          alive: true,
          hasScript: true
        }
      ]
    });

    await h.triggerInlineSave();

    assert.strictEqual(h.downloads.length, 0, 'Ambiguous frames must produce zero downloads');
    assert.strictEqual(h.fetches.length, 0, 'Ambiguous frames must produce zero network fetches');
    assert.strictEqual(h.sentMessages.filter((m) => m.options.frameId > 0).length, 0,
      'No frame message should be sent when discovery finds duplicate frames');
    assert(h.warns.some((w) => /no single frame shows the embedded RedGIFs clip/.test(w)),
      'Expected warning that no single frame uniquely shows the clip');
    assert(h.badges.some((b) => b.text === 'ERR'), 'Expected ERR badge');
  });

  // Test 6: Nested cross-origin frame (child: false)
  await test('6. Non-direct-child: frame reporting clip is nested (child: false) -> filtered out -> zero fetches, zero downloads, zero child messages', async () => {
    const h = createHarness({
      frames: [
        {
          frameId: 393,
          documentId: 'doc-393-nested',
          href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
          clipKey: CLIP_EVIL,
          child: false, // Nested deeper!
          alive: true,
          hasScript: true
        }
      ]
    });

    await h.triggerInlineSave();

    assert.strictEqual(h.downloads.length, 0, 'Nested cross-origin frames must be refused');
    assert.strictEqual(h.fetches.length, 0, 'Nested cross-origin frames must produce zero fetches');
    assert.strictEqual(h.sentMessages.filter((m) => m.options.frameId > 0).length, 0,
      'No frame message should be sent for nested frames');
    assert(h.warns.some((w) => /no single frame shows the embedded RedGIFs clip/.test(w)));
    assert(h.badges.some((b) => b.text === 'ERR'));
  });

  // Test 7: Refused cases strictly never fetch or download unverified ID-derived MP4 or silent source
  await test('7. Fallback prevention: stale or refused proof never fetches or downloads ID-derived candidate or silent variant', async () => {
    const h = createHarness({
      frames: [
        {
          frameId: 393,
          documentId: 'doc-stale-dead',
          href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
          clipKey: CLIP_EVIL,
          child: true,
          alive: false // Dead
        }
      ]
    });

    await h.triggerInlineSave();

    assert.strictEqual(h.downloads.length, 0, 'Must never initiate downloads on stale proof');
    assert.strictEqual(h.fetches.length, 0, 'Must never initiate fetches on stale proof');
    assert(!h.downloads.some((d) => d.url.includes('-silent')), 'Must never download -silent file on refused proof');
    assert(!h.downloads.some((d) => d.url === `https://media.redgifs.com/${CLIP_EVIL}.mp4`),
      'Must never guess unverified ID-derived URL for embed save');
    assert(!h.fetches.some((f) => f.url.includes(CLIP_EVIL)),
      'Must never fetch unverified candidate for embed save');
  });

  // Test 8: User-initiated positive recovery after refused attempt
  await test('8. User-initiated recovery: fresh trusted save after refusal succeeds with new document ID without automatic retry', async () => {
    // Phase 1: Attempt 1 with stale vanishing document
    const h = createHarness({
      frames: [
        {
          frameId: 393,
          documentId: 'doc-393-stale',
          href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
          clipKey: CLIP_EVIL,
          child: true,
          alive: true,
          hasScript: false
        }
      ]
    });

    let interceptDiscovery = true;
    const origExecute = h.sandbox.chrome.scripting.executeScript;
    h.sandbox.chrome.scripting.executeScript = async (opts) => {
      const res = await origExecute(opts);
      if (interceptDiscovery && opts && opts.target && opts.target.allFrames) {
        h.setFrames([]); // Vanishes for attempt 1
      }
      return res;
    };

    // Attempt 1 runs with token 1:
    await h.triggerInlineSave({ token: INLINE_TOKEN_1 });

    assert.strictEqual(h.downloads.length, 0, 'Attempt 1 must produce zero downloads');
    assert.strictEqual(h.fetches.length, 0, 'Attempt 1 must produce zero network fetches');
    assert(h.badges.some((b) => b.text === 'ERR'), 'Attempt 1 must flash ERR badge');

    // Phase 2: User-initiated retry. Embed reloads in frame 393 with a fresh documentId:
    interceptDiscovery = false;
    h.setFrames([
      {
        frameId: 393,
        documentId: 'doc-393-fresh',
        href: `https://www.redgifs.com/ifr/${CLIP_EVIL}`,
        clipKey: CLIP_EVIL,
        child: true,
        alive: true,
        hasScript: false
      }
    ]);

    // Attempt 2 runs with NEW token 2 (fresh user save gesture):
    await h.triggerInlineSave({ token: INLINE_TOKEN_2 });

    assert.strictEqual(h.downloads.length, 1, 'Attempt 2 must successfully download');
    assert.strictEqual(h.downloads[0].url, 'https://media.redgifs.com/EvilUnequaledBufflehead.mp4');
    assert.strictEqual(h.downloads[0].filename, 'SavedImages/EvilUnequaledBufflehead.mp4');
    assert.strictEqual(h.fetches.length, 1, 'Attempt 2 must execute exactly 1 media verification fetch');
    assert.strictEqual(h.fetches[0].url, 'https://media.redgifs.com/EvilUnequaledBufflehead.mp4');
    assert(h.injections.some((inj) => inj.target?.documentIds?.includes('doc-393-fresh')),
      'Attempt 2 must be pinned strictly to fresh documentId doc-393-fresh');
    assert(h.badges.some((b) => b.text === 'OK'), 'Attempt 2 must flash OK badge on completion');
  });

  console.log(`\n======================================================`);
  console.log(`Total tests passed: ${passed}`);
  console.log(`Total tests failed: ${failed}`);
  console.log(`======================================================`);

  if (failed > 0) {
    process.exit(1);
  }
})();
