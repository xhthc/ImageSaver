'use strict';

/**
 * test_redgifs_selected_target.js
 *
 * Standalone production regression suite for RedGIFs target identity (F02).
 * Exercises the real content/content_redgifs.js with native-shaped DOM collections,
 * realistic parent-child hierarchy, dynamic detach/replacement, and network tracking.
 *
 * Covers:
 * 1. Second of two videos under a shared overlay (Regression: baseline selects first video)
 * 2. Conflicting clickedSrc vs path (Regression: baseline ignores conflict)
 * 3. Detached selected video with live neighbor (Regression: baseline accepts detached target)
 * 4. Same-node source replacement (Regression: baseline accepts replaced node)
 * 5. Replaced/recycled container (Regression: baseline returns detached container video)
 * 6. Direct video click (Nearest positive)
 * 7. Unique single-player overlay (Nearest positive)
 * 8. Exact selection with consistent evidence (Nearest positive)
 * 9. Single supported embed in frame (Nearest positive)
 * 10. Frame message listener dispatch and zero network on refusal
 * 11+. STAB-04 correction: selected-source continuity on every selection route (F1), matching embed-page identity (F2) and
 *      signed script addresses (F3); see the block after test 10.
 */

const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const CONTENT_SCRIPT_PATH = path.join(REPO_ROOT, 'content/content_redgifs.js');
const CONTENT_SCRIPT_CODE = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');

/**
 * Creates a native-shaped non-Array collection (NodeList / HTMLCollection).
 * Must not inherit Array.prototype methods like filter, map, slice.
 */
function createNativeCollection(items = []) {
  const collection = {
    length: items.length,
    item(i) {
      return (i >= 0 && i < items.length) ? items[i] : null;
    },
    [Symbol.iterator]: function* () {
      for (let i = 0; i < items.length; i++) {
        yield items[i];
      }
    }
  };
  for (let i = 0; i < items.length; i++) {
    collection[i] = items[i];
  }
  return collection;
}

/**
 * Mock element with realistic tree traversal and isConnected tracking.
 */
class MockDOMElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.parentElement = null;
    this._children = [];
    this._isConnected = false;
    this.attributes = {};
    this.src = '';
    this.currentSrc = '';
    this.textContent = '';

    for (const [k, v] of Object.entries(attrs)) {
      this.setAttribute(k, v);
    }
  }

  get isConnected() {
    return this._isConnected;
  }

  set isConnected(val) {
    this._setConnectedRecursively(Boolean(val));
  }

  _setConnectedRecursively(val) {
    this._isConnected = val;
    for (const ch of this._children) {
      ch._setConnectedRecursively(val);
    }
  }

  get children() {
    return createNativeCollection(this._children);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  setAttribute(name, val) {
    const sVal = String(val);
    this.attributes[name] = sVal;
    if (name === 'src') {
      this.src = sVal;
      if (this.tagName === 'VIDEO' && !this.currentSrc) {
        this.currentSrc = sVal;
      }
    }
    if (name === 'currentSrc' && this.tagName === 'VIDEO') {
      this.currentSrc = sVal;
    }
  }

  appendChild(child) {
    if (child.parentElement) {
      child.parentElement.removeChild(child);
    }
    child.parentElement = this;
    this._children.push(child);
    child._setConnectedRecursively(this._isConnected);
    return child;
  }

  removeChild(child) {
    const idx = this._children.indexOf(child);
    if (idx !== -1) {
      this._children.splice(idx, 1);
      child.parentElement = null;
      child._setConnectedRecursively(false);
      return child;
    }
    return null;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.removeChild(this);
    } else {
      this._setConnectedRecursively(false);
    }
  }

  matches(sel) {
    const strict = MockDOMElement.strictClassCase === true;
    const parts = sel.split(',').map(s => (strict ? s.trim() : s.trim().toLowerCase()));
    const tag = this.tagName.toLowerCase();
    const className = strict ? (this.attributes['class'] || '') : (this.attributes['class'] || '').toLowerCase();
    const id = (this.attributes['id'] || '').toLowerCase();

    for (const part of parts) {
      if ((strict ? part.toLowerCase() : part) === tag) return true;
      if (part.startsWith('.') && className.split(/\s+/).includes(part.slice(1))) return true;
      if (part.startsWith('#') && id === part.slice(1)) return true;
      if (part.startsWith('[') && part.endsWith(']')) {
        const attrContent = part.slice(1, -1);
        if (attrContent.includes('=')) {
          const [aName, aVal] = attrContent.split('=').map(s => s.replace(/["']/g, '').trim());
          if (this.attributes[aName] === aVal) return true;
        } else {
          if (Object.prototype.hasOwnProperty.call(this.attributes, attrContent)) return true;
        }
      }
    }
    return false;
  }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.matches && cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelector(sel) {
    const all = this._queryAllInternal(sel);
    return all.length > 0 ? all[0] : null;
  }

  querySelectorAll(sel) {
    return createNativeCollection(this._queryAllInternal(sel));
  }

  _queryAllInternal(sel) {
    const results = [];
    const walk = (node) => {
      for (const ch of node._children) {
        if (ch.matches(sel)) {
          results.push(ch);
        }
        walk(ch);
      }
    };
    walk(this);
    return results;
  }
}

/**
 * Creates an isolated mock environment for content/content_redgifs.js
 */
function createTestEnvironment(pageUrl = 'https://www.redgifs.com/watch/ImperturbableLiveCaimanlizard') {
  const fetchCalls = [];
  const networkRequests = [];
  const messageListeners = [];
  const sentMessages = [];

  const html = new MockDOMElement('html');
  const body = new MockDOMElement('body');
  html.appendChild(body);
  html.isConnected = true; // body and all attached elements are connected

  const doc = {
    location: new URL(pageUrl),
    body,
    documentElement: html,
    createElement: (tag, attrs) => new MockDOMElement(tag, attrs),
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    contains: (node) => {
      let cur = node;
      while (cur) {
        if (cur === html) return true;
        cur = cur.parentElement;
      }
      return false;
    }
  };

  const windowListeners = {};
  const win = {
    location: new URL(pageUrl),
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
    removeEventListener: () => {}
  };

  const mockChrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => messageListeners.push(fn)
      },
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        return { success: true };
      }
    }
  };

  const mockFetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    networkRequests.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => '100' },
      body: new Blob([JSON.stringify({ token: 'mock-token' })]).stream()
    };
  };

  const ctx = vm.createContext({
    window: win,
    document: doc,
    chrome: mockChrome,
    fetch: mockFetch,
    console: { log() {}, warn() {}, error() {} },
    URL,
    TextDecoder,
    AbortController,
    Date,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Set,
    Map,
    setTimeout,
    clearTimeout
  });

  vm.runInContext(CONTENT_SCRIPT_CODE, ctx);

  return {
    ctx,
    doc,
    body,
    fetchCalls,
    networkRequests,
    messageListeners,
    windowListeners,
    sentMessages
  };
}

let testsPassed = 0;
let testsFailed = 0;

function runTest(name, fn) {
  try {
    fn();
    testsPassed++;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    testsFailed++;
    console.error(`[FAIL] ${name}: ${err.message}`);
    if (process.env.DEBUG) console.error(err);
  }
}

console.log('--- Running test_redgifs_selected_target.js ---');

// 1. Regression: Second of two videos under a shared overlay
runTest('Regression 1: Second of two videos under shared overlay selects exact clicked target', () => {
  const env = createTestEnvironment();
  const card = env.doc.createElement('div', { class: 'redgifs-player', 'data-id': 'SharedCard' });
  const video1 = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/FirstClip.mp4',
    currentSrc: 'https://media.redgifs.com/FirstClip.mp4'
  });
  const video2 = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/SecondClip.mp4',
    currentSrc: 'https://media.redgifs.com/SecondClip.mp4'
  });
  const overlay = env.doc.createElement('div', { class: 'touch-overlay' });

  card.appendChild(video1);
  card.appendChild(video2);
  card.appendChild(overlay);
  env.body.appendChild(card);

  // Gesture path contains overlay and card
  env.ctx.setLastContextmenuTarget(overlay, [overlay, card, env.body]);

  const target = env.ctx.findClickedVideo('https://media.redgifs.com/SecondClip.mp4');
  assert.strictEqual(target, video2, 'Must select video2 (SecondClip), NOT video1 (FirstClip)');

  const res = env.ctx.resolveFrameRedGifsMedia('https://media.redgifs.com/SecondClip.mp4');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.targetUrl, 'https://media.redgifs.com/SecondClip.mp4');
});

// 2. Regression: Conflicting clickedSrc vs path
runTest('Regression 2: Conflicting clickedSrc vs gesture target refuses resolution and makes zero network requests', () => {
  const env = createTestEnvironment();
  const card = env.doc.createElement('div', { class: 'redgifs-player' });
  const video1 = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/FirstClip.mp4',
    currentSrc: 'https://media.redgifs.com/FirstClip.mp4'
  });
  card.appendChild(video1);
  env.body.appendChild(card);

  // User right clicks directly on video1 (FirstClip)
  env.ctx.setLastContextmenuTarget(video1, [video1, card, env.body]);

  // But context menu reports clickedSrc for an unrelated clip
  const conflictingSrc = 'https://media.redgifs.com/UnrelatedClip.mp4';
  const target = env.ctx.findClickedVideo(conflictingSrc);
  assert.strictEqual(target, null, 'Must refuse when clickedSrc conflicts with clicked video target');

  const res = env.ctx.resolveFrameRedGifsMedia(conflictingSrc);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.targetUrl, null);
  assert.strictEqual(env.networkRequests.length, 0, 'Must not perform network requests on refusal');
});

// 3. Regression: Detached selected video with a live neighbor
runTest('Regression 3: Detached selected video refuses resolution and does not fall back to live neighbor', () => {
  const env = createTestEnvironment();
  const card = env.doc.createElement('div', { class: 'redgifs-player' });
  const video1 = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/SurvivingClip.mp4',
    currentSrc: 'https://media.redgifs.com/SurvivingClip.mp4'
  });
  const video2 = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/DetachedClip.mp4',
    currentSrc: 'https://media.redgifs.com/DetachedClip.mp4'
  });
  card.appendChild(video1);
  card.appendChild(video2);
  env.body.appendChild(card);

  // User clicks video2
  env.ctx.setLastContextmenuTarget(video2, [video2, card, env.body]);

  // Page removes video2 from DOM before resolution
  video2.remove();
  assert.strictEqual(video2.isConnected, false);
  assert.strictEqual(video1.isConnected, true);

  const target = env.ctx.findClickedVideo('https://media.redgifs.com/DetachedClip.mp4');
  assert.strictEqual(target, null, 'Must not return detached video nor fall back to surviving neighbor');

  const res = env.ctx.resolveFrameRedGifsMedia('https://media.redgifs.com/DetachedClip.mp4');
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.targetUrl, null);
  assert.strictEqual(env.networkRequests.length, 0);
});

// 4. Regression: Same-node source replacement
runTest('Regression 4: Same-node source replacement refuses when requested source no longer matches node', () => {
  const env = createTestEnvironment();
  const card = env.doc.createElement('div', { class: 'redgifs-player' });
  const video = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/OriginalClip.mp4',
    currentSrc: 'https://media.redgifs.com/OriginalClip.mp4'
  });
  card.appendChild(video);
  env.body.appendChild(card);

  env.ctx.setLastContextmenuTarget(video, [video, card, env.body]);

  // Dynamic replacement: player re-assigns node to next clip in playlist
  video.src = 'https://media.redgifs.com/ReplacedNextClip.mp4';
  video.currentSrc = 'https://media.redgifs.com/ReplacedNextClip.mp4';

  // Context menu resolving the original clicked clip
  const target = env.ctx.findClickedVideo('https://media.redgifs.com/OriginalClip.mp4');
  assert.strictEqual(target, null, 'Must not return node whose source has been replaced with another clip');

  const res = env.ctx.resolveFrameRedGifsMedia('https://media.redgifs.com/OriginalClip.mp4');
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.targetUrl, null);
  assert.strictEqual(env.networkRequests.length, 0);
});

// 5. Regression: Replaced / recycled container
runTest('Regression 5: Recycled or detached container refuses and does not borrow from new container', () => {
  const env = createTestEnvironment();
  const card1 = env.doc.createElement('div', { class: 'redgifs-player', id: 'card1' });
  const video1 = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/RecycledOldClip.mp4',
    currentSrc: 'https://media.redgifs.com/RecycledOldClip.mp4'
  });
  const overlay1 = env.doc.createElement('div', { class: 'overlay' });
  card1.appendChild(video1);
  card1.appendChild(overlay1);
  env.body.appendChild(card1);

  env.ctx.setLastContextmenuTarget(overlay1, [overlay1, card1, env.body]);

  // Feed recycling: card1 is detached, card2 is inserted
  card1.remove();
  assert.strictEqual(card1.isConnected, false);

  const card2 = env.doc.createElement('div', { class: 'redgifs-player', id: 'card2' });
  const video2 = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/NewFeedClip.mp4',
    currentSrc: 'https://media.redgifs.com/NewFeedClip.mp4'
  });
  card2.appendChild(video2);
  env.body.appendChild(card2);

  const target = env.ctx.findClickedVideo('https://media.redgifs.com/RecycledOldClip.mp4');
  assert.strictEqual(target, null, 'Must not resolve against detached/recycled container or borrow new feed card');

  const res = env.ctx.resolveFrameRedGifsMedia('https://media.redgifs.com/RecycledOldClip.mp4');
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.targetUrl, null);
  assert.strictEqual(env.networkRequests.length, 0);
});

// 6. Nearest positive: Direct video click
runTest('Positive 6: Direct video click resolves immediately and accurately', () => {
  const env = createTestEnvironment();
  const video = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/DirectClip.mp4',
    currentSrc: 'https://media.redgifs.com/DirectClip.mp4'
  });
  env.body.appendChild(video);

  env.ctx.setLastContextmenuTarget(video, [video, env.body]);

  const target = env.ctx.findClickedVideo('https://media.redgifs.com/DirectClip.mp4');
  assert.strictEqual(target, video);

  const res = env.ctx.resolveFrameRedGifsMedia('https://media.redgifs.com/DirectClip.mp4');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.targetUrl, 'https://media.redgifs.com/DirectClip.mp4');
});

// 7. Nearest positive: Unique single-player overlay
runTest('Positive 7: Unique single-player overlay resolves the unique video in card', () => {
  const env = createTestEnvironment();
  const card = env.doc.createElement('div', { class: 'redgifs-player' });
  const video = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/SinglePlayerClip.mp4',
    currentSrc: 'https://media.redgifs.com/SinglePlayerClip.mp4'
  });
  const overlay = env.doc.createElement('div', { class: 'overlay' });
  card.appendChild(video);
  card.appendChild(overlay);
  env.body.appendChild(card);

  env.ctx.setLastContextmenuTarget(overlay, [overlay, card, env.body]);

  const target = env.ctx.findClickedVideo('https://media.redgifs.com/SinglePlayerClip.mp4');
  assert.strictEqual(target, video);

  const res = env.ctx.resolveFrameRedGifsMedia('https://media.redgifs.com/SinglePlayerClip.mp4');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.targetUrl, 'https://media.redgifs.com/SinglePlayerClip.mp4');
});

// 8. Nearest positive: Exact selection with consistent evidence in multi-video container
runTest('Positive 8: Multi-video container resolves exact matching video when evidence is consistent', () => {
  const env = createTestEnvironment();
  const card = env.doc.createElement('div', { class: 'card' });
  const videoA = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/MultiAlpha.mp4',
    currentSrc: 'https://media.redgifs.com/MultiAlpha.mp4'
  });
  const videoB = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/MultiBeta.mp4',
    currentSrc: 'https://media.redgifs.com/MultiBeta.mp4'
  });
  card.appendChild(videoA);
  card.appendChild(videoB);
  env.body.appendChild(card);

  env.ctx.setLastContextmenuTarget(card, [card, env.body]);

  const target = env.ctx.findClickedVideo('https://media.redgifs.com/MultiBeta.mp4');
  assert.strictEqual(target, videoB);

  const res = env.ctx.resolveFrameRedGifsMedia('https://media.redgifs.com/MultiBeta.mp4');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.targetUrl, 'https://media.redgifs.com/MultiBeta.mp4');
});

// 9. Nearest positive: Single supported embed in frame
runTest('Positive 9: Single supported embed in frame resolves with or without gesture', () => {
  const env = createTestEnvironment('https://www.redgifs.com/ifr/SoloEmbedClip');
  const video = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/SoloEmbedClip.mp4',
    currentSrc: 'https://media.redgifs.com/SoloEmbedClip.mp4'
  });
  env.body.appendChild(video);

  const target = env.ctx.findClickedVideo('https://media.redgifs.com/SoloEmbedClip.mp4');
  assert.strictEqual(target, video);

  const res = env.ctx.resolveFrameRedGifsMedia('https://media.redgifs.com/SoloEmbedClip.mp4');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.targetUrl, 'https://media.redgifs.com/SoloEmbedClip.mp4');
});

// 10. Frame message listener dispatch and zero network on refusal
runTest('Integration 10: RESOLVE_FRAME_MEDIA runtime listener responds properly and refuses cleanly', () => {
  const env = createTestEnvironment();
  assert.strictEqual(env.messageListeners.length, 1, 'Runtime onMessage listener must be registered');
  const onMessageListener = env.messageListeners[0];

  const card = env.doc.createElement('div', { class: 'redgifs-player' });
  const video = env.doc.createElement('video', {
    src: 'https://media.redgifs.com/MessageClip.mp4',
    currentSrc: 'https://media.redgifs.com/MessageClip.mp4'
  });
  card.appendChild(video);
  env.body.appendChild(card);

  env.ctx.setLastContextmenuTarget(video, [video, card, env.body]);

  // Dispatch message with matching source
  let responseVal = null;
  onMessageListener(
    { action: 'RESOLVE_FRAME_MEDIA', clickedSrc: 'https://media.redgifs.com/MessageClip.mp4', frameId: 0 },
    {},
    (res) => { responseVal = res; }
  );

  assert.strictEqual(responseVal.success, true);
  assert.strictEqual(responseVal.targetUrl, 'https://media.redgifs.com/MessageClip.mp4');

  // Dispatch message with conflicting source
  let conflictResponseVal = null;
  onMessageListener(
    { action: 'RESOLVE_FRAME_MEDIA', clickedSrc: 'https://media.redgifs.com/ConflictClip.mp4', frameId: 0 },
    {},
    (res) => { conflictResponseVal = res; }
  );

  assert.strictEqual(conflictResponseVal.success, false);
  assert.strictEqual(conflictResponseVal.targetUrl, null);
  assert.strictEqual(env.networkRequests.length, 0, 'Zero network requests on refusal');
});

// =============================================================================
// STAB-04 correction of the RedGIFs target identity (F1 selected-source replacement, F2 matching embed-page request, F3 signed script URLs).
// Test boundary: the real content/content_redgifs.js, its production message listener and provider path, on a native-shaped mock DOM and a mock fetch.
// No native Chromium, no real provider request and no download is performed here.
// =============================================================================

const OLD_BLOB = 'blob:https://www.redgifs.com/selected-old';
const REPLACED = 'https://media.redgifs.com/ReplacedNextClip.mp4';
const asyncTests = [];

function runTestAsync(name, fn) {
  asyncTests.push({ name, fn });
}

function setSource(video, src) {
  video.src = src;
  video.currentSrc = src;
}

// One production request through the registered message listener (what the background sends); synchronous unless a provider request follows
function ask(env, clickedSrc, extra = {}) {
  let answer = null;
  env.messageListeners[0]({ action: 'RESOLVE_FRAME_MEDIA', clickedSrc, frameId: 0, ...extra }, {}, (res) => { answer = res; });
  return answer;
}

// The selection is refused on every production entry before any provider request
function assertRefused(env, clickedSrc, label) {
  assert.strictEqual(env.ctx.findClickedVideo(clickedSrc), null, `${label}: findClickedVideo must refuse`);
  const res = env.ctx.resolveFrameRedGifsMedia(clickedSrc);
  assert.strictEqual(res.success, false, `${label}: resolver must fail`);
  assert.strictEqual(res.targetUrl, null, `${label}: resolver must not name a clip`);
  const answered = ask(env, clickedSrc);
  assert.ok(answered && answered.success === false && answered.targetUrl === null, `${label}: the message listener must refuse`);
  assert.strictEqual(env.fetchCalls.length, 0, `${label}: no provider request on a refused selection`);
}

// The same DOM, five ways to select its player: a direct target, the composed path, the owning card, the closest card, the parent container
const ROUTES = {
  direct: (env, video, card) => ({ target: video, path: [video, card, env.body] }),
  composedPath: (env, video, card, overlay) => ({ target: overlay, path: [overlay, video, card, env.body] }),
  ownerCard: (env, video, card, overlay) => ({ target: overlay, path: [overlay, card, env.body] }),
  closestCard: (env, video, card, overlay) => ({ target: overlay, path: [overlay] }),
  parent: (env, video, card, overlay) => ({ target: overlay, path: [overlay] })
};

function buildRoute(routeName, src, pageUrl) {
  const env = createTestEnvironment(pageUrl);
  // the parent route needs a container that is not a recognised player card
  const card = env.doc.createElement('div', routeName === 'parent' ? { class: 'wrap' } : { class: 'redgifs-player' });
  const video = env.doc.createElement('video', { src, currentSrc: src });
  const overlay = env.doc.createElement('div', { class: 'touch-overlay' });
  card.appendChild(video);
  card.appendChild(overlay);
  env.body.appendChild(card);
  const { target, path } = ROUTES[routeName](env, video, card, overlay);
  env.ctx.setLastContextmenuTarget(target, path);
  return { env, card, video, overlay };
}

const REPLACEMENTS = {
  'blob to a direct clip': (v) => setSource(v, REPLACED),
  'blob to another blob': (v) => setSource(v, 'blob:https://www.redgifs.com/selected-next'),
  'source cleared': (v) => setSource(v, '')
};

// ---- F1 -------------------------------------------------------------------

for (const routeName of Object.keys(ROUTES)) {
  runTest(`F1 ${routeName}: the unchanged blob player is selected, a replaced source on the same node is refused before any provider request`, () => {
    for (const [what, mutate] of Object.entries(REPLACEMENTS)) {
      const { env, video } = buildRoute(routeName, OLD_BLOB);
      assert.strictEqual(env.ctx.findClickedVideo(OLD_BLOB), video, `${what}: the unchanged player is the selection (control)`);
      mutate(video);
      assertRefused(env, OLD_BLOB, `${routeName} / ${what}`);
    }
  });
}

runTest('F1 signed direct source: a signed address that changes after the gesture on the same node is refused on every route', () => {
  const signed = (sig) => `https://media.redgifs.com/SignedSel.mp4?sig=${sig}&exp=4102444800`;
  for (const routeName of Object.keys(ROUTES)) {
    const { env, video } = buildRoute(routeName, signed('aaaa'));
    assert.strictEqual(env.ctx.findClickedVideo(signed('aaaa')), video, `${routeName}: the exact signed address is the selection (control)`);
    setSource(video, signed('bbbb'));
    assertRefused(env, signed('aaaa'), `${routeName} / signed`);
  }
});

runTest('F1 child sources: a <source> that changes after the gesture is not the selected player any more', () => {
  const env = createTestEnvironment();
  const card = env.doc.createElement('div', { class: 'redgifs-player' });
  const video = env.doc.createElement('video', { src: OLD_BLOB, currentSrc: OLD_BLOB });
  const source = env.doc.createElement('source', { src: OLD_BLOB });
  video.appendChild(source);
  card.appendChild(video);
  env.body.appendChild(card);
  env.ctx.setLastContextmenuTarget(video, [video, card, env.body]);
  assert.strictEqual(env.ctx.findClickedVideo(OLD_BLOB), video, 'control');
  source.setAttribute('src', 'blob:https://www.redgifs.com/selected-next');
  assertRefused(env, OLD_BLOB, 'child source replaced');
});

runTest('F1 recycled player: the card stays, its player node is replaced by a new one; the new node is not the selection', () => {
  for (const routeName of ['ownerCard', 'closestCard', 'composedPath']) {
    const { env, card, video } = buildRoute(routeName, OLD_BLOB);
    video.remove();
    const next = env.doc.createElement('video', { src: 'blob:https://www.redgifs.com/selected-next', currentSrc: 'blob:https://www.redgifs.com/selected-next' });
    card.appendChild(next);
    assertRefused(env, OLD_BLOB, `${routeName} / recycled node`);
  }
});

runTest('F1 competing player: a player that appears in the card does not take over the selection (an unchanged selection stays itself)', () => {
  // the selected player is unchanged: a late competitor neither replaces it nor is borrowed from
  const { env, card, video } = buildRoute('ownerCard', OLD_BLOB);
  const late = env.doc.createElement('video', { src: 'https://media.redgifs.com/LateCompetitor.mp4', currentSrc: 'https://media.redgifs.com/LateCompetitor.mp4' });
  card.appendChild(late);
  assert.strictEqual(env.ctx.findClickedVideo(OLD_BLOB), video, 'the selected player is still the selection');
  assert.notStrictEqual(env.ctx.findClickedVideo('https://media.redgifs.com/LateCompetitor.mp4'), late, 'the late player is not selectable by its own address either');

  // the selected player changed and another node now holds the reported blob: the exact address match must not hand over the selection
  const swapped = buildRoute('ownerCard', OLD_BLOB);
  setSource(swapped.video, REPLACED);
  swapped.card.appendChild(swapped.env.doc.createElement('video', { src: OLD_BLOB, currentSrc: OLD_BLOB }));
  assertRefused(swapped.env, OLD_BLOB, 'competitor holds the reported blob');
});

runTest('F1 detached card: a recycled feed card does not lend its successor (blob request)', () => {
  const { env, card } = buildRoute('ownerCard', OLD_BLOB);
  card.remove();
  const card2 = env.doc.createElement('div', { class: 'redgifs-player' });
  card2.appendChild(env.doc.createElement('video', { src: 'blob:https://www.redgifs.com/feed-next', currentSrc: 'blob:https://www.redgifs.com/feed-next' }));
  env.body.appendChild(card2);
  assertRefused(env, OLD_BLOB, 'detached card');
});

runTest('F1 no recent gesture: a blob request names the frame\'s only player only when that player still holds the blob', () => {
  for (const [what, mutate] of Object.entries(REPLACEMENTS)) {
    const env = createTestEnvironment();
    const video = env.doc.createElement('video', { src: OLD_BLOB, currentSrc: OLD_BLOB });
    env.body.appendChild(video);
    assert.strictEqual(env.ctx.findClickedVideo(OLD_BLOB), video, `${what}: the player that holds the blob is selected without a gesture (control)`);
    mutate(video);
    assertRefused(env, OLD_BLOB, `no gesture / ${what}`);
  }
});

runTest('F1 stale gesture: a gesture older than the recent window is not a proof, the document rule applies', () => {
  const env = createTestEnvironment();
  const video = env.doc.createElement('video', { src: OLD_BLOB, currentSrc: OLD_BLOB });
  env.body.appendChild(video);
  const realDate = env.ctx.Date;
  env.ctx.setLastContextmenuTarget(video, [video, env.body]);
  setSource(video, REPLACED);
  const later = Date.now() + 16000;
  env.ctx.Date = { now: () => later };
  try {
    assertRefused(env, OLD_BLOB, 'stale gesture');
  } finally {
    env.ctx.Date = realDate;
  }
});

runTest('F1 fresh gesture: a gesture taken after the replacement selects the new source, and the stale blob address no longer names it', () => {
  const { env, video } = buildRoute('direct', OLD_BLOB);
  setSource(video, REPLACED);
  assertRefused(env, OLD_BLOB, 'before the fresh gesture');
  env.ctx.setLastContextmenuTarget(video, [video, env.body]);
  assert.strictEqual(env.ctx.findClickedVideo(REPLACED), video, 'the exact new address selected by the new gesture is the selection');
  const res = env.ctx.resolveFrameRedGifsMedia(REPLACED);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.targetUrl, REPLACED);
  assert.strictEqual(env.ctx.findClickedVideo(OLD_BLOB), null, 'the old blob address conflicts with the player that now shows a direct address');
});

runTestAsync('F1 production listener and provider path: the unchanged blob player recovers its clip; the same player after a replacement asks nobody', async () => {
  const CLIP = 'RecoverClip';
  const HD = `https://media.redgifs.com/${CLIP}.mp4`;
  const SILENT = `https://media.redgifs.com/${CLIP}-silent.mp4`;
  const gif = { gif: { id: CLIP, hasAudio: true, urls: { silent: SILENT, hd: HD, sd: `https://media.redgifs.com/${CLIP}-mobile.mp4` } } };
  const build = () => {
    const env = createTestEnvironment(`https://www.redgifs.com/ifr/${CLIP}`);
    const video = env.doc.createElement('video', { src: OLD_BLOB, currentSrc: OLD_BLOB });
    env.body.appendChild(video);
    // the page declares only the muted file (observed behavior); the provider's API declares the audio-bearing renditions
    const script = env.doc.createElement('script', { type: 'application/json' });
    script.textContent = JSON.stringify({ gif: { id: CLIP, urls: { silent: SILENT } } });
    env.body.appendChild(script);
    env.ctx.fetch = async (url) => {
      env.fetchCalls.push({ url: String(url) });
      const body = String(url).endsWith('v2/auth/temporary') ? { token: 'synthetic-session-token' } : gif;
      return { ok: true, status: 200, headers: { get: () => null }, body: new Blob([JSON.stringify(body)]).stream() };
    };
    env.ctx.setLastContextmenuTarget(video, [video, env.body]);
    return { env, video };
  };
  const answerAsync = (env, clickedSrc) => new Promise((resolve) => {
    env.messageListeners[0]({ action: 'RESOLVE_FRAME_MEDIA', clickedSrc, frameId: 0 }, {}, resolve);
  });

  const ok = build();
  const recovered = await answerAsync(ok.env, OLD_BLOB);
  assert.strictEqual(recovered.success, true, 'unchanged blob: the same-clip recovery succeeds');
  assert.strictEqual(recovered.targetUrl, HD, 'unchanged blob: the provider-declared audio-bearing rendition is the target');
  assert.strictEqual(ok.env.fetchCalls.length, 2, 'unchanged blob: exactly the guest session and the clip were requested');

  const replaced = build();
  setSource(replaced.video, REPLACED);
  const refused = await answerAsync(replaced.env, OLD_BLOB);
  assert.strictEqual(refused.success, false, 'replaced source: refused');
  assert.strictEqual(refused.targetUrl, null);
  assert.strictEqual(replaced.env.fetchCalls.length, 0, 'replaced source: the provider was never asked');
  const viaProvider = await replaced.env.ctx.resolveFrameRedGifsMediaWithProvider(OLD_BLOB);
  assert.strictEqual(viaProvider.success, false, 'replaced source: the provider-enriched resolver refuses as well');
  assert.strictEqual(replaced.env.fetchCalls.length, 0);
});

// ---- F2 -------------------------------------------------------------------

const EMBED_URL = 'https://www.redgifs.com/ifr/SoloEmbedClip';

function embedFrame(videoCount = 1) {
  const env = createTestEnvironment(EMBED_URL);
  const videos = [];
  for (let i = 0; i < videoCount; i++) {
    const blob = `blob:https://www.redgifs.com/same-${i}`;
    const v = env.doc.createElement('video', { src: blob, currentSrc: blob });
    env.body.appendChild(v);
    videos.push(v);
  }
  return { env, video: videos[0], videos };
}

runTest('F2 matching embed page: the unchanged blob player of its own /ifr/ document is selected with and without a gesture', () => {
  const { env, video } = embedFrame();
  assert.strictEqual(env.ctx.findClickedVideo(EMBED_URL), video, 'without a gesture');
  env.ctx.setLastContextmenuTarget(video, [video, env.body]);
  assert.strictEqual(env.ctx.findClickedVideo(EMBED_URL), video, 'after a gesture on the same player (was refused)');
  assert.strictEqual(env.ctx.findClickedVideo('blob:https://www.redgifs.com/same-0'), video, 'its own blob address is still the selection');
});

runTest('F2 matching embed page: the request resolves the clip the page declares, through the production listener', () => {
  const { env, video } = embedFrame();
  const script = env.doc.createElement('script', { type: 'application/json' });
  script.textContent = JSON.stringify({ video: { id: 'SoloEmbedClip', contentUrl: 'https://media.redgifs.com/SoloEmbedClip.mp4' } });
  env.body.appendChild(script);
  env.ctx.setLastContextmenuTarget(video, [video, env.body]);
  const answered = ask(env, EMBED_URL);
  assert.strictEqual(answered.success, true);
  assert.strictEqual(answered.targetUrl, 'https://media.redgifs.com/SoloEmbedClip.mp4');
});

runTest('F2 embed page through each gesture route: the frame clip identity selects the unchanged player, a replaced one is refused', () => {
  for (const routeName of Object.keys(ROUTES)) {
    const { env, video } = buildRoute(routeName, OLD_BLOB, EMBED_URL);
    assert.strictEqual(env.ctx.findClickedVideo(EMBED_URL), video, `${routeName}: the frame clip identity selects the unchanged player`);
    setSource(video, REPLACED);
    assertRefused(env, EMBED_URL, `${routeName} / replaced after the gesture`);
  }
});

runTest('F2 negatives: foreign clip, changed source (also to the same clip), navigated frame, ambiguous frame and unrelated addresses are refused', () => {
  const foreign = embedFrame();
  foreign.env.ctx.setLastContextmenuTarget(foreign.video, [foreign.video, foreign.env.body]);
  assertRefused(foreign.env, 'https://www.redgifs.com/ifr/OtherClip', 'foreign clip (gesture)');
  assertRefused(embedFrame().env, 'https://www.redgifs.com/ifr/OtherClip', 'foreign clip (no gesture)');

  for (const next of [REPLACED, 'https://media.redgifs.com/SoloEmbedClip.mp4']) {
    const mutated = embedFrame();
    mutated.env.ctx.setLastContextmenuTarget(mutated.video, [mutated.video, mutated.env.body]);
    assert.strictEqual(mutated.env.ctx.findClickedVideo(EMBED_URL), mutated.video, 'control');
    setSource(mutated.video, next);
    assertRefused(mutated.env, EMBED_URL, `source changed to ${next}`);
  }

  const navigated = embedFrame();
  navigated.env.ctx.setLastContextmenuTarget(navigated.video, [navigated.video, navigated.env.body]);
  navigated.env.ctx.window.location = new URL('https://www.redgifs.com/ifr/OtherClip');
  assertRefused(navigated.env, EMBED_URL, 'frame navigated to another clip');

  const ambiguous = embedFrame(2);
  assertRefused(ambiguous.env, EMBED_URL, 'two players, no gesture');
  ambiguous.env.ctx.setLastContextmenuTarget(ambiguous.video, [ambiguous.video, ambiguous.env.body]);
  assertRefused(ambiguous.env, EMBED_URL, 'two players, gesture on one');

  for (const unrelated of ['https://example.com/ifr/SoloEmbedClip', 'https://www.redgifs.com.evil.example/ifr/SoloEmbedClip', 'https://media.redgifs.com/Unrelated.mp4']) {
    const frame = embedFrame();
    frame.env.ctx.setLastContextmenuTarget(frame.video, [frame.video, frame.env.body]);
    assertRefused(frame.env, unrelated, `unrelated address ${unrelated}`);
  }
});

// ---- F3 -------------------------------------------------------------------

const SIGNED = 'https://media.redgifs.com/SignedClip.mp4?sig=synthetic-required&exp=4102444800';

function resolveWithScripts(scripts) {
  const env = createTestEnvironment('https://www.redgifs.com/ifr/SignedClip');
  const video = env.doc.createElement('video', { src: 'blob:https://www.redgifs.com/current', currentSrc: 'blob:https://www.redgifs.com/current' });
  env.body.appendChild(video);
  for (const spec of scripts) {
    const script = env.doc.createElement('script', spec.json ? { type: 'application/json' } : {});
    script.textContent = spec.text;
    env.body.appendChild(script);
  }
  env.ctx.setLastContextmenuTarget(video, [video, env.body]);
  return env.ctx.resolveFrameRedGifsMedia('blob:https://www.redgifs.com/current');
}

runTest('F3 signed unstructured script: the complete quoted address is the only candidate, query bytes intact', () => {
  const res = resolveWithScripts([{ text: `var cfg={url:"${SIGNED}"};` }]);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.targetUrl, SIGNED);
  assert.deepStrictEqual(Array.from(res.candidates), [SIGNED], 'no unsigned derivative of the signed address exists');
});

runTest('F3 JSON control and the supported escape decoding give the same complete address', () => {
  const json = resolveWithScripts([{ text: JSON.stringify({ url: SIGNED }), json: true }]);
  assert.deepStrictEqual(Array.from(json.candidates), [SIGNED], 'structured JSON');
  const escaped = resolveWithScripts([{ text: 'var s="https:\\/\\/media.redgifs.com\\/SignedClip.mp4?sig=abc\\u0026exp=4102444800";' }]);
  assert.deepStrictEqual(Array.from(escaped.candidates), ['https://media.redgifs.com/SignedClip.mp4?sig=abc&exp=4102444800'], 'JSON-escaped slashes and ampersand in an unstructured script');
});

runTest('F3 multiple query keys and extension-like query text are preserved as one address', () => {
  const tricky = 'https://media.redgifs.com/SignedClip.mp4?sig=a&exp=1&file=other.webm&x=.mp4&Policy=p~q_r-s';
  const res = resolveWithScripts([{ text: `var cfg={url:"${tricky}"};` }]);
  assert.deepStrictEqual(Array.from(res.candidates), [tricky]);
});

runTest('F3 delimiters of an unquoted address end it without becoming part of the query', () => {
  const want = 'https://media.redgifs.com/SignedClip.mp4?sig=a&exp=1';
  for (const text of [`a{background:url(${want});}`, `var a='${want}';`, `{"u":"${want}","v":1}`, `src=${want};`, `[${want}]`, `x=${want}, y=2`]) {
    const res = resolveWithScripts([{ text }]);
    assert.deepStrictEqual(Array.from(res.candidates), [want], `delimiter case: ${text}`);
  }
});

runTest('F3 rejected addresses: lookalike hosts, other schemes, another clip, an id only in the query and an extension only in the query', () => {
  const bad = [
    'https://evilredgifs.com/SignedClip.mp4?sig=x',
    'https://media.redgifs.com.evil.example/SignedClip.mp4?sig=x',
    'http://media.redgifs.com/SignedClip.mp4?sig=x',
    'https://media.redgifs.com/OtherClip.mp4?sig=y',
    'https://media.redgifs.com/OtherClip.mp4?ref=SignedClip',
    'https://media.redgifs.com/SignedClip?file=a.mp4',
    'https://www.redgifs.com/watch/SignedClip?sig=z'
  ];
  const onlyBad = resolveWithScripts([{ text: bad.map((u, i) => `var u${i}="${u}";`).join('\n') }]);
  assert.strictEqual(onlyBad.success, false, 'none of them is a candidate: ' + JSON.stringify(onlyBad.candidates));
  const mixed = resolveWithScripts([{ text: bad.map((u, i) => `var u${i}="${u}";`).join('\n') + `\nvar ok="${SIGNED}";` }]);
  assert.deepStrictEqual(Array.from(mixed.candidates), [SIGNED], 'only the signed address of the selected clip remains');
  const json = resolveWithScripts([{ text: JSON.stringify({ a: 'https://media.redgifs.com/OtherClip.mp4?ref=SignedClip', b: SIGNED }), json: true }]);
  assert.deepStrictEqual(Array.from(json.candidates), [SIGNED], 'structured JSON: an id that only appears in the query names no clip');
});

runTest('F3 deduplication and bounds: a repeated address is one candidate, a page-declared unsigned twin is kept as declared, the cap holds', () => {
  const twice = resolveWithScripts([{ text: `var a="${SIGNED}"; var b="${SIGNED}";` }]);
  assert.deepStrictEqual(Array.from(twice.candidates), [SIGNED]);

  const unsigned = 'https://media.redgifs.com/SignedClip.mp4';
  const both = resolveWithScripts([
    { text: JSON.stringify({ video: { id: 'SignedClip', contentUrl: unsigned } }), json: true },
    { text: `var a="${SIGNED}";` }
  ]);
  assert.strictEqual(both.candidates.length, 2, 'two different addresses declared by the page stay two candidates');
  assert.ok(both.candidates.includes(unsigned) && both.candidates.includes(SIGNED), 'neither is rewritten into the other');

  const many = [];
  for (let i = 0; i < 30; i++) many.push(`var u${i}="https://media.redgifs.com/SignedClip.mp4?sig=${i}";`);
  const capped = resolveWithScripts([{ text: many.join('\n') }]);
  assert.ok(capped.candidates.length <= 20 && capped.diagnostics.candidateCount <= 20, 'at most MAX_COLLECTED_CANDIDATES');
  assert.ok(capped.candidates.every((u) => /^https:\/\/media\.redgifs\.com\/SignedClip\.mp4\?sig=\d+$/.test(u)), 'every candidate keeps its own query');
});

// =============================================================================
// Review correction of #65: trusted events only (G1), quoted addresses kept whole (G2), clip identity by file name (G3).
// The registered window listeners are invoked (not setLastContextmenuTarget), the same boundary as the production event path.
// =============================================================================

function fire(env, type, target, { trusted = true, button = 2, path } = {}) {
  const event = { target, button, timeStamp: 1, composedPath: () => path || [target, env.body] };
  if (trusted !== 'missing') event.isTrusted = trusted;
  for (const listener of env.windowListeners[type] || []) listener(event);
}

function trustFrame() {
  const env = createTestEnvironment('https://www.redgifs.com/ifr/SelectedClip');
  const old = 'blob:https://www.redgifs.com/old';
  const video = env.doc.createElement('video', { src: old, currentSrc: old, 'data-mp4': 'https://media.redgifs.com/SelectedClip.mp4' });
  env.body.appendChild(video);
  return { env, video, old, next: 'blob:https://www.redgifs.com/new' };
}

const contextMessages = (env) => env.sentMessages.filter((m) => m && m.action === 'REDGIFS_MEDIA_CONTEXTMENU_DETECTED').length;

runTest('G1 trusted events: the registered contextmenu and right-button mousedown listeners record the selection, a source change is refused', () => {
  for (const type of ['contextmenu', 'mousedown']) {
    const { env, video, old, next } = trustFrame();
    fire(env, type, video);
    assert.strictEqual(contextMessages(env), 1, `${type}: the trusted gesture notifies the background`);
    const unchanged = env.ctx.resolveFrameRedGifsMedia(old);
    assert.strictEqual(unchanged.success, true, `${type}: unchanged player resolves`);
    assert.strictEqual(unchanged.targetUrl, 'https://media.redgifs.com/SelectedClip.mp4');
    setSource(video, next);
    assert.strictEqual(env.ctx.resolveFrameRedGifsMedia(old).success, false, `${type}: changed source is refused`);
  }
});

runTest('G1 untrusted events cannot refresh, clear or redirect the proof and notify nobody', () => {
  for (const type of ['contextmenu', 'mousedown']) {
    for (const trusted of [false, 'missing']) {
      const { env, video, old, next } = trustFrame();
      fire(env, 'contextmenu', video);
      setSource(video, next);
      assert.strictEqual(env.ctx.resolveFrameRedGifsMedia(old).success, false, 'control: refused');
      const messages = env.sentMessages.length;
      fire(env, type, video, { trusted });
      assert.strictEqual(env.ctx.resolveFrameRedGifsMedia(old).success, false, `${type}/${trusted}: an untrusted event does not refresh the proof`);
      assert.strictEqual(env.sentMessages.length, messages, `${type}/${trusted}: no new context-identification message`);
    }
  }
  // an untrusted event on another player neither clears nor redirects the trusted proof
  const { env, video, old } = trustFrame();
  const other = env.doc.createElement('video', { src: 'blob:https://www.redgifs.com/other', currentSrc: 'blob:https://www.redgifs.com/other' });
  env.body.appendChild(other);
  fire(env, 'contextmenu', video);
  const messages = env.sentMessages.length;
  for (const type of ['contextmenu', 'mousedown']) fire(env, type, other, { trusted: false });
  assert.strictEqual(env.sentMessages.length, messages, 'no notification for the untrusted events');
  const res = env.ctx.resolveFrameRedGifsMedia(old);
  assert.strictEqual(res.success, true, 'the trusted selection is still the selection');
  assert.strictEqual(env.ctx.findClickedVideo(old), video, 'it was not redirected to the other player');
});

runTest('G1 a later trusted gesture selects the new source; a keyboard-triggered trusted contextmenu is recorded', () => {
  const { env, video, old, next } = trustFrame();
  fire(env, 'contextmenu', video);
  setSource(video, next);
  assert.strictEqual(env.ctx.resolveFrameRedGifsMedia(old).success, false);
  fire(env, 'contextmenu', video, { trusted: true, button: 0 });
  assert.strictEqual(env.ctx.resolveFrameRedGifsMedia(next).success, true, 'the new source after a new trusted gesture');
  const kb = trustFrame();
  fire(kb.env, 'contextmenu', kb.video, { trusted: true, button: 0 });
  assert.strictEqual(kb.env.ctx.findClickedVideo(kb.old), kb.video, 'keyboard contextmenu (button 0) selects the focused player');
  assert.strictEqual(contextMessages(kb.env), 1);
});

// ---- G2: a quoted address is the declared address -----------------------------------------------------------------------------

const QUOTES = ['"', "'", '`'];

runTest('G2 quoted signed addresses keep every byte inside the quotes, including punctuation endings', () => {
  const base = 'https://media.redgifs.com/SignedClip.mp4?sig=required';
  const declared = [base + ',', base + ')', base + ']', base + ';', base + '}', base + ',)];}', base + '&exp=4102444800,', base + "&q='x'"];
  for (const quote of QUOTES) {
    for (const url of declared) {
      if (url.includes(quote)) continue;
      const res = resolveWithScripts([{ text: `var cfg={url:${quote}${url}${quote}};` }]);
      assert.strictEqual(res.targetUrl, url, `${quote} ${url}: targetUrl`);
      assert.deepStrictEqual(Array.from(res.candidates), [url], `${quote} ${url}: exact candidates`);
    }
  }
  for (const url of declared) {
    const json = resolveWithScripts([{ text: JSON.stringify({ url }), json: true }]);
    assert.deepStrictEqual(Array.from(json.candidates), [url], `JSON control ${url}`);
  }
});

runTest('G2 controls: unquoted wrappers still end the address, an unterminated quote does not swallow the script, escapes decode', () => {
  const want = 'https://media.redgifs.com/SignedClip.mp4?sig=a&exp=1';
  for (const text of [`a{background:url(${want});}`, `src=${want};`, `[${want}]`, `x=${want}, y=2`, `"${want}", "z"`, `"${want} trailing text`]) {
    assert.deepStrictEqual(Array.from(resolveWithScripts([{ text }]).candidates), [want], text);
  }
  const escaped = resolveWithScripts([{ text: 'var s="https:\\/\\/media.redgifs.com\\/SignedClip.mp4?sig=abc,\\u0026exp=4102444800";' }]);
  assert.deepStrictEqual(Array.from(escaped.candidates), ['https://media.redgifs.com/SignedClip.mp4?sig=abc,&exp=4102444800']);
});

// ---- G3: the clip is the media file's own identity ---------------------------------------------------------------------------

function resolveDeclared(kind, urls) {
  const env = createTestEnvironment('https://www.redgifs.com/ifr/SignedClip');
  const video = env.doc.createElement('video', { src: 'blob:https://www.redgifs.com/current', currentSrc: 'blob:https://www.redgifs.com/current' });
  env.body.appendChild(video);
  if (kind === 'script' || kind === 'json') {
    const script = env.doc.createElement('script', kind === 'json' ? { type: 'application/json' } : {});
    script.textContent = kind === 'json' ? JSON.stringify({ urls }) : urls.map((u, i) => `var u${i}="${u}";`).join('\n');
    env.body.appendChild(script);
  } else if (kind === 'meta') {
    const realQuery = env.doc.querySelectorAll;
    const metas = urls.map((u) => ({ getAttribute: (k) => ({ property: 'og:video', content: u })[k] || null }));
    env.doc.querySelectorAll = (sel) => (/meta/.test(sel) ? metas : realQuery(sel));
  } else if (kind === 'performance') {
    env.ctx.performance = { getEntriesByType: () => urls.map((name) => ({ name })) };
  }
  env.ctx.setLastContextmenuTarget(video, [video, env.body]);
  return env.ctx.resolveFrameRedGifsMedia('blob:https://www.redgifs.com/current');
}

const OTHER_CLIPS = [
  'https://media.redgifs.com/OtherSignedClip.mp4',
  'https://media.redgifs.com/SignedClipExtra.mp4?sig=x',
  'https://media.redgifs.com/SignedClip-extra.mp4',
  'https://media.redgifs.com/SignedClip/OtherClip.mp4',
  'https://media.redgifs.com/SignedClip/Other.mp4?sig=y',
  'https://media.redgifs.com/OtherClip.mp4?ref=SignedClip&x=SignedClip.mp4'
];

runTest('G3 another clip is never the selected clip: overlapping ids, directory and query occurrences, on every discovery path', () => {
  const good = 'https://media.redgifs.com/SignedClip.mp4?sig=required,&exp=4102444800';
  for (const kind of ['script', 'json', 'meta', 'performance']) {
    const onlyBad = resolveDeclared(kind, OTHER_CLIPS);
    assert.strictEqual(onlyBad.success, false, `${kind}: none of the other clips is a candidate: ${JSON.stringify(onlyBad.candidates)}`);
    const mixed = resolveDeclared(kind, [...OTHER_CLIPS.slice(0, 3), good, ...OTHER_CLIPS.slice(3)]);
    assert.strictEqual(mixed.success, true, `${kind}: mixed declarations`);
    assert.deepStrictEqual(Array.from(mixed.candidates), [good], `${kind}: only the selected clip, request bytes intact`);
    assert.strictEqual(mixed.targetUrl, good);
  }
});

runTest('G3 the selected clip is accepted by its exact case-insensitive id and the documented rendition suffixes, signed query intact', () => {
  for (const kind of ['script', 'json', 'meta', 'performance']) {
    for (const url of [
      'https://media.redgifs.com/signedclip.mp4?sig=a',
      'https://media.redgifs.com/SIGNEDCLIP-mobile.mp4?sig=b&exp=1',
      'https://thumbs2.redgifs.com/SignedClip-silent.webm?sig=c',
      'https://media.redgifs.com/SignedClip.mp4'
    ]) {
      const res = resolveDeclared(kind, [url]);
      assert.deepStrictEqual(Array.from(res.candidates || []), [url], `${kind}: ${url}`);
    }
  }
});

// ---- gesture-bound request (requireGesture): an address-less request names the player of this document's own fresh selection only ----------------------

runTest('Gesture-bound request: a fresh document without a recorded gesture never substitutes its sole video', () => {
  const direct = 'https://media.redgifs.com/ReplacementNextClip.mp4';
  const env = createTestEnvironment('https://www.redgifs.com/watch/orangeworrisomelacewing');
  const video = env.doc.createElement('video', { src: direct, currentSrc: direct });
  env.body.appendChild(video);
  assert.strictEqual(env.ctx.findClickedVideo('', true), null, 'no gesture: the gesture-bound lookup refuses');
  const bound = ask(env, '', { requireGesture: true });
  assert.ok(bound && bound.success === false && bound.targetUrl === null, 'the listener refuses a gesture-bound request');
  assert.strictEqual(env.fetchCalls.length, 0, 'no provider request');
  // the established contract of every other caller (no flag): the document's single player is still resolved
  assert.strictEqual(env.ctx.findClickedVideo(''), video, 'unflagged callers keep the single-player fallback');
  assert.strictEqual(ask(env, '').success, true);
});

runTest('Gesture-bound request: the document\'s own fresh trusted selection resolves; a stale one (over 30 s) and an untrusted one do not', () => {
  const direct = 'https://media.redgifs.com/OwnClip.mp4';
  const build = () => {
    const env = createTestEnvironment('https://www.redgifs.com/watch/ownclip');
    const a = env.doc.createElement('video', { src: direct, currentSrc: direct });
    const b = env.doc.createElement('video', { src: 'https://media.redgifs.com/OtherClip.mp4', currentSrc: 'https://media.redgifs.com/OtherClip.mp4' });
    env.body.appendChild(a);
    env.body.appendChild(b);
    return { env, a, b };
  };
  const { env, a } = build();
  fire(env, 'contextmenu', a);
  assert.strictEqual(env.ctx.findClickedVideo('', true), a, 'fresh trusted selection: the selected player');
  // the background admitted the capture stamped 777 (same isolated world); the request is bound to that selection
  env.ctx.__imageSaverContextTarget = { at: 777 };
  assert.strictEqual(ask(env, '', { requireGesture: true, gestureAt: 777 }).targetUrl, direct);
  for (const wrong of [{ requireGesture: true }, { requireGesture: true, gestureAt: null }, { requireGesture: true, gestureAt: 778 }]) {
    const refused = ask(env, '', wrong);
    assert.ok(refused && refused.success === false && refused.targetUrl === null, 'a request not bound to the latest capture is refused: ' + JSON.stringify(wrong));
  }
  // a later selection of the other player replaces the record: the earlier operation is refused, not redirected to it
  const second = env.doc.createElement('video', { src: 'https://media.redgifs.com/SecondGestureClip.mp4', currentSrc: 'https://media.redgifs.com/SecondGestureClip.mp4' });
  env.body.appendChild(second);
  fire(env, 'contextmenu', second);
  env.ctx.__imageSaverContextTarget = { at: 9999 };
  const redirected = ask(env, '', { requireGesture: true, gestureAt: 777 });
  assert.ok(redirected && redirected.success === false && redirected.targetUrl === null, 'a later trusted selection never redirects the earlier operation');
  assert.strictEqual(ask(env, '', { requireGesture: true, gestureAt: 9999 }).targetUrl, 'https://media.redgifs.com/SecondGestureClip.mp4', 'the later selection resolves its own operation');

  // 20 s old: outside the 15 s window of ordinary requests, inside the 30 s window the admission proof allows
  const aged = build();
  fire(aged.env, 'contextmenu', aged.a);
  const realDate = aged.env.ctx.Date;
  const at = (ms) => { aged.env.ctx.Date = { now: () => Date.now() + ms }; };
  at(20000);
  assert.strictEqual(aged.env.ctx.findClickedVideo('', true), aged.a, 'a 20 s old selection still binds the gesture-bound request');
  assert.strictEqual(aged.env.ctx.findClickedVideo(''), null, 'an ordinary request keeps its 15 s window (two players: ambiguous)');
  at(31000);
  assert.strictEqual(aged.env.ctx.findClickedVideo('', true), null, 'over 30 s: stale');
  aged.env.ctx.Date = realDate;

  const forged = build();
  fire(forged.env, 'contextmenu', forged.a, { trusted: false });
  assert.strictEqual(forged.env.ctx.findClickedVideo('', true), null, 'an event dispatched by the page selects nothing');
});

// ---- F4: own-site player proven by its own poster (.Player / .Player-Poster / .GifPreview, observed 2026-10-07) ---------------------------------

// The observed structure: GifPreview > TapTracker > Player > [Player-Poster image, Player-Video > video]; a feed holds several cards, the page names
// no clip (/niches/<name>), the player is blob-only. Class names are matched case-sensitively, as a real standards-mode document does.
const NICHE_URL = 'https://www.redgifs.com/niches/ecchi-anime';
const posterUrl = (name) => `https://media.redgifs.com/${name}-mobile.jpg`;
const TOKEN = 'synthetic-session-token';

const strictly = (fn) => async () => {
  MockDOMElement.strictClassCase = true;
  try { await fn(); } finally { MockDOMElement.strictClassCase = false; }
};

function nicheFeed(names = ['ClipAlpha', 'ClipBravo'], pageUrl = NICHE_URL) {
  const env = createTestEnvironment(pageUrl);
  const feed = env.doc.createElement('div', { class: 'previewFeed' });
  env.body.appendChild(feed);
  const cards = names.map((name, i) => {
    const blob = `blob:https://www.redgifs.com/niche-${i}`;
    const gif = env.doc.createElement('div', { class: 'GifPreview GifPreview_isActive GifPreview_isVideo' });
    const preview = env.doc.createElement('img', { src: posterUrl(name) });
    const tap = env.doc.createElement('div', { class: 'TapTracker' });
    const player = env.doc.createElement('div', { class: 'Player' });
    const poster = env.doc.createElement('img', { class: 'Player-Poster isHidden', src: posterUrl(name) });
    const holder = env.doc.createElement('div', { class: 'Player-Video' });
    const video = env.doc.createElement('video', { class: 'isLoaded', src: blob, currentSrc: blob });
    const overlay = env.doc.createElement('div', { class: 'touch-overlay' });
    feed.appendChild(gif);
    gif.appendChild(preview);
    gif.appendChild(tap);
    tap.appendChild(player);
    player.appendChild(poster);
    player.appendChild(holder);
    holder.appendChild(video);
    player.appendChild(overlay);
    return {
      name, blob, gif, tap, player, poster, holder, video, overlay,
      path: [video, holder, player, tap, gif, feed, env.body],
      overlayPath: [overlay, player, tap, gif, feed, env.body]
    };
  });
  return { env, feed, cards };
}

const mediaOf = (name, suffix = '', ext = 'mp4') => `https://media.redgifs.com/${name}${suffix}.${ext}`;

// Provider mock: the guest session, then the clip by id; hooks run on every request (a way to change the page during the lookup)
function providerMock(env, gifs, { onRequest, status = 200 } = {}) {
  const reply = (body) => ({ ok: status === 200, status, headers: { get: () => null }, body: new Blob([JSON.stringify(body)]).stream() });
  env.ctx.fetch = async (url, opts) => {
    const u = String(url);
    env.fetchCalls.push({ url: u, opts });
    if (onRequest) onRequest(u, env.fetchCalls.length);
    if (u.endsWith('v2/auth/temporary')) return reply({ token: TOKEN });
    const id = decodeURIComponent(u.split('/v2/gifs/')[1] || '');
    return reply({ gif: gifs[id] });
  };
}

// the mock document has no attribute selectors: the page's og:video is modeled as the existing G3 tests do
function addOgVideo(env, url) {
  const realQuery = env.doc.querySelectorAll;
  const metas = [{ getAttribute: (k) => ({ property: 'og:video', content: url })[k] || null }];
  env.doc.querySelectorAll = (sel) => (/meta/.test(sel) ? metas : realQuery(sel));
}

const answerAsync = (env, clickedSrc, extra = {}) => new Promise((resolve) => {
  env.messageListeners[0]({ action: 'RESOLVE_FRAME_MEDIA', clickedSrc, frameId: 0, ...extra }, {}, resolve);
});

const refusedAnswer = (answer, label) => assert.ok(answer && answer.success === false && answer.targetUrl === null, `${label}: refused (${JSON.stringify(answer && answer.diagnostics && answer.diagnostics.rejectionReasons)})`);

runTestAsync('F4 observed niche structure: the blob-only player with no id and no direct address proves its clip by its own poster and recovers it from the provider', strictly(async () => {
  const { env, cards } = nicheFeed(['ClipAlpha', 'ClipBravo']);
  const [first, second] = cards;
  // the second (not first) card is the clicked one; every route that reaches its player selects it, the first card's player never
  for (const [what, path] of [['video', second.path], ['overlay in the Player', second.overlayPath]]) {
    env.ctx.setLastContextmenuTarget(path[0], path);
    assert.strictEqual(env.ctx.findClickedVideo(second.blob), second.video, `${what}: the clicked player is selected`);
  }
  env.ctx.setLastContextmenuTarget(second.video, second.path);
  const base = env.ctx.resolveFrameRedGifsMedia(second.blob);
  assert.strictEqual(base.success, false, 'the page declares no direct address');
  assert.strictEqual(base.diagnostics.videoId, 'clipbravo', 'the clicked card names its own clip');
  assert.strictEqual(base.diagnostics.videoIdSource, 'player_poster');
  assert.strictEqual(env.fetchCalls.length, 0, 'the synchronous resolver asks nobody');

  providerMock(env, { clipbravo: { id: 'ClipBravo', hasAudio: true, urls: { silent: mediaOf('ClipBravo', '-silent'), hd: mediaOf('ClipBravo'), sd: mediaOf('ClipBravo', '-mobile'), poster: mediaOf('ClipBravo', '-poster', 'jpg'), thumbnail: mediaOf('ClipBravo', '-mobile', 'jpg') } } });
  const answer = await answerAsync(env, second.blob);
  assert.strictEqual(answer.success, true, 'recovered');
  assert.strictEqual(answer.targetUrl, mediaOf('ClipBravo'), 'the audio-bearing rendition of the clicked clip');
  assert.ok(answer.candidates.every((u) => /ClipBravo/.test(u) && /\.mp4$/.test(u)), 'only video renditions of the clicked clip: a poster is never a candidate');
  assert.ok(!answer.candidates.some((u) => /ClipAlpha/.test(u)), 'no neighbor');
  assert.strictEqual(answer.candidateAudio[mediaOf('ClipBravo')], 'present');
  assert.strictEqual(answer.candidateAudio[mediaOf('ClipBravo', '-silent')], 'absent', 'the muted rendition is never audio evidence');
  assert.deepStrictEqual(env.fetchCalls.map((c) => c.url), ['https://api.redgifs.com/v2/auth/temporary', 'https://api.redgifs.com/v2/gifs/clipbravo'], 'the existing two bounded requests');
  assert.ok(env.fetchCalls.every((c) => c.opts && c.opts.credentials === 'omit'), 'no credentials');
  assert.ok(!JSON.stringify(answer).includes(TOKEN), 'the guest session never leaves the frame');
  assert.ok(first.video.isConnected, 'control: the first player was never involved');
}));

runTestAsync('F4 audio declarations: a sound-bearing clip prefers its audio rendition, a declared muted clip is kept, an undeclared one prefers the unmuted file', strictly(async () => {
  const run = async (gif) => {
    const { env, cards } = nicheFeed(['ClipBravo']);
    env.ctx.setLastContextmenuTarget(cards[0].video, cards[0].path);
    providerMock(env, { clipbravo: gif });
    return answerAsync(env, cards[0].blob);
  };
  const silent = mediaOf('ClipBravo', '-silent');
  const hd = mediaOf('ClipBravo');
  const mutedOnly = await run({ id: 'ClipBravo', hasAudio: false, urls: { silent } });
  assert.strictEqual(mutedOnly.success, true, 'a declared silent clip is recovered too');
  assert.strictEqual(mutedOnly.targetUrl, silent);
  assert.strictEqual(mutedOnly.diagnostics.providerAudio, 'AUDIO_FALSE');
  const noAudioFlag = await run({ id: 'ClipBravo', urls: { silent, hd } });
  assert.strictEqual(noAudioFlag.targetUrl, hd, 'no audio declaration: the rendition not named muted may carry the sound');
  assert.deepStrictEqual(Array.from(noAudioFlag.candidates).sort(), [hd, silent].sort(), 'the muted rendition stays available');
  assert.strictEqual(noAudioFlag.diagnostics.providerAudio, 'NO_AUDIO_DECLARED');
  const bearing = await run({ id: 'ClipBravo', hasAudio: true, urls: { silent, hd } });
  assert.strictEqual(bearing.targetUrl, hd);
  assert.strictEqual(bearing.diagnostics.providerAudio, 'present');
}));

runTestAsync('F4 known audio: a clip the provider declares with sound is never saved as a muted file when no validated sound-bearing rendition exists', strictly(async () => {
  const silent = mediaOf('ClipBravo', '-silent');
  const hd = mediaOf('ClipBravo');
  const run = async (gif) => {
    const { env, cards } = nicheFeed(['ClipBravo']);
    env.ctx.setLastContextmenuTarget(cards[0].video, cards[0].path);
    providerMock(env, { clipbravo: gif });
    const answer = await answerAsync(env, cards[0].blob);
    return { answer, env };
  };
  const knownAudioRefused = ({ answer, env }, label) => {
    refusedAnswer(answer, label);
    assert.strictEqual(answer.diagnostics.providerAudio, 'AUDIO_NO_VALID_RENDITION', `${label}: an accurate diagnostic, not "no audio declared"`);
    assert.ok(!answer.candidates && !answer.candidateAudio, `${label}: no candidate is offered`);
    assert.strictEqual(env.fetchCalls.length, 2, `${label}: only the two bounded requests`);
    assert.ok(!JSON.stringify(answer).includes(TOKEN), `${label}: the guest session stays in the frame`);
  };
  knownAudioRefused(await run({ id: 'ClipBravo', hasAudio: true, urls: { silent } }), 'hasAudio true, only the silent rendition declared');
  knownAudioRefused(await run({ id: 'ClipBravo', hasAudio: true, urls: { silent, hd: 'https://evil.example/ClipBravo.mp4', sd: mediaOf('ClipAlpha', '-mobile'), mobile: 'http://media.redgifs.com/ClipBravo-mobile.mp4' } }), 'hasAudio true, sound URLs foreign, of another clip or not https, valid silent URL');
  knownAudioRefused(await run({ id: 'ClipBravo', hasAudio: true, urls: { poster: mediaOf('ClipBravo', '-poster', 'jpg') } }), 'hasAudio true, only a poster declared');
  knownAudioRefused(await run({ id: 'ClipBravo', hasAudio: true, urls: {} }), 'hasAudio true, nothing declared');

  // controls: a validated sound rendition still wins, declared silence and unknown audio keep succeeding, a muted file is never called sound
  const withSound = await run({ id: 'ClipBravo', hasAudio: true, urls: { silent, hd, bad: 'https://evil.example/ClipBravo.mp4' } });
  assert.strictEqual(withSound.answer.targetUrl, hd, 'control: the validated sound rendition');
  assert.strictEqual(withSound.answer.diagnostics.providerAudio, 'present');
  assert.strictEqual(withSound.answer.candidateAudio[silent], 'absent');
  const declaredSilence = await run({ id: 'ClipBravo', hasAudio: false, urls: { silent } });
  assert.strictEqual(declaredSilence.answer.targetUrl, silent, 'control: a declared silent clip is saved');
  assert.strictEqual(declaredSilence.answer.diagnostics.providerAudio, 'AUDIO_FALSE');
  const unknown = await run({ id: 'ClipBravo', urls: { silent } });
  assert.strictEqual(unknown.answer.targetUrl, silent, 'control: undeclared audio keeps the declared file');
  assert.strictEqual(unknown.answer.diagnostics.providerAudio, 'NO_AUDIO_DECLARED');
  assert.strictEqual(unknown.answer.candidateAudio[silent], 'absent', 'unknown audio is never claimed present');
}));

runTestAsync('F4 refusals before any request: a missing, foreign, non-image, conflicting or ambiguous poster, an ambiguous player or a foreign origin never reaches the provider', strictly(async () => {
  const refusals = {
    'no poster': (c) => c.poster.remove(),
    'poster of a foreign host': (c) => c.poster.setAttribute('src', 'https://evil.example/ClipBravo-mobile.jpg'),
    'poster lookalike host': (c) => c.poster.setAttribute('src', 'https://media.redgifs.com.evil.example/ClipBravo-mobile.jpg'),
    'poster is a video address': (c) => c.poster.setAttribute('src', mediaOf('ClipBravo')),
    'poster that is not a clip file': (c) => c.poster.setAttribute('src', 'https://www.redgifs.com/'),
    'plain preview image is no proof': (c) => { c.poster.setAttribute('class', 'isHidden'); },
    'two posters naming different clips': (c) => c.player.appendChild(new MockDOMElement('img', { class: 'Player-Poster', src: posterUrl('ClipAlpha') })),
    'a second player under the same Player': (c) => { const v = new MockDOMElement('video', { src: 'blob:https://www.redgifs.com/second', currentSrc: 'blob:https://www.redgifs.com/second' }); c.player.appendChild(v); }
  };
  for (const [what, mutate] of Object.entries(refusals)) {
    const { env, cards } = nicheFeed(['ClipBravo']);
    const c = cards[0];
    mutate(c);
    providerMock(env, { clipbravo: { id: 'ClipBravo', hasAudio: true, urls: { hd: mediaOf('ClipBravo') } } });
    env.ctx.setLastContextmenuTarget(c.video, c.path);
    const answer = await answerAsync(env, c.blob);
    refusedAnswer(answer, what);
    assert.strictEqual(env.fetchCalls.length, 0, `${what}: the provider was never asked`);
  }
  // the same structure on a foreign origin (the content script also runs on Reddit pages): no proof there
  const foreign = nicheFeed(['ClipBravo'], 'https://www.reddit.com/r/something/comments/abc/post/');
  providerMock(foreign.env, { clipbravo: { id: 'ClipBravo', urls: { hd: mediaOf('ClipBravo') } } });
  foreign.env.ctx.setLastContextmenuTarget(foreign.cards[0].video, foreign.cards[0].path);
  refusedAnswer(await answerAsync(foreign.env, foreign.cards[0].blob), 'foreign origin');
  assert.strictEqual(foreign.env.fetchCalls.length, 0, 'foreign origin: no request');
}));

runTestAsync('F4 conflicts: a poster that contradicts the player\'s own clip evidence is refused, a poster outranks a feed or another clip\'s metadata', strictly(async () => {
  // the player already names another clip by its direct address: the poster contradicts it
  const conflict = nicheFeed(['ClipBravo']);
  setSource(conflict.cards[0].video, mediaOf('ClipAlpha'));
  conflict.env.ctx.setLastContextmenuTarget(conflict.cards[0].video, conflict.cards[0].path);
  providerMock(conflict.env, { clipbravo: { id: 'ClipBravo', hasAudio: true, urls: { hd: mediaOf('ClipBravo') } } });
  const res = conflict.env.ctx.resolveFrameRedGifsMedia(mediaOf('ClipAlpha'));
  assert.strictEqual(res.success, false, 'a direct address of one clip under a poster of another is refused');
  assert.deepStrictEqual(Array.from(res.diagnostics.rejectionReasons), ['CONFLICTING_CLIP_ID']);
  refusedAnswer(await answerAsync(conflict.env, mediaOf('ClipAlpha')), 'conflict');
  assert.strictEqual(conflict.env.fetchCalls.length, 0);

  // a watch page of clip W whose clicked player shows the poster of clip Y: the player is Y, W's metadata never stands in for it
  const watch = nicheFeed(['ClipYankee'], 'https://www.redgifs.com/watch/ClipWhiskey');
  addOgVideo(watch.env, mediaOf('ClipWhiskey', '-silent'));
  watch.env.ctx.setLastContextmenuTarget(watch.cards[0].video, watch.cards[0].path);
  const base = watch.env.ctx.resolveFrameRedGifsMedia(watch.cards[0].blob);
  assert.strictEqual(base.success, false, 'the page\'s own og:video belongs to another clip');
  assert.strictEqual(base.diagnostics.videoId, 'clipyankee');
  providerMock(watch.env, { clipyankee: { id: 'ClipYankee', hasAudio: true, urls: { hd: mediaOf('ClipYankee') } } });
  const answer = await answerAsync(watch.env, watch.cards[0].blob);
  assert.strictEqual(answer.targetUrl, mediaOf('ClipYankee'));
  assert.ok(!answer.candidates.some((u) => /Whiskey/.test(u)), 'the watched clip is not a candidate of the clicked player');

  // the same page's own player (poster of the watched clip): the page metadata and the poster agree and the existing path is kept
  const own = nicheFeed(['ClipWhiskey'], 'https://www.redgifs.com/watch/ClipWhiskey');
  addOgVideo(own.env, mediaOf('ClipWhiskey', '-silent'));
  own.env.ctx.setLastContextmenuTarget(own.cards[0].video, own.cards[0].path);
  const ownBase = own.env.ctx.resolveFrameRedGifsMedia(own.cards[0].blob);
  assert.strictEqual(ownBase.success, true, 'the declared muted file is still found');
  assert.strictEqual(ownBase.targetUrl, mediaOf('ClipWhiskey', '-silent'));
}));

runTestAsync('F4 wrong clip or provider failure stays a refusal: another clip id, an HTTP error, no declared video file, only a poster', strictly(async () => {
  const build = (gifs, opts) => {
    const f = nicheFeed(['ClipBravo']);
    f.env.ctx.setLastContextmenuTarget(f.cards[0].video, f.cards[0].path);
    providerMock(f.env, gifs, opts);
    return f;
  };
  const cases = {
    'the provider answers another clip': [{ clipbravo: { id: 'ClipOther', hasAudio: true, urls: { hd: mediaOf('ClipOther') } } }, undefined],
    'HTTP failure': [{}, { status: 500 }],
    'no gif in the answer': [{}, undefined],
    'only a poster declared': [{ clipbravo: { id: 'ClipBravo', hasAudio: true, urls: { poster: mediaOf('ClipBravo', '-poster', 'jpg') } } }, undefined],
    'only another clip\'s files declared': [{ clipbravo: { id: 'ClipBravo', hasAudio: true, urls: { hd: mediaOf('ClipAlpha') } } }, undefined],
    'only a foreign host declared': [{ clipbravo: { id: 'ClipBravo', hasAudio: true, urls: { hd: 'https://evil.example/ClipBravo.mp4' } } }, undefined]
  };
  for (const [what, [gifs, opts]] of Object.entries(cases)) {
    const { env, cards } = build(gifs, opts);
    const answer = await answerAsync(env, cards[0].blob);
    refusedAnswer(answer, what);
    assert.ok(env.fetchCalls.length <= 2, `${what}: at most the two bounded requests`);
  }
}));

runTestAsync('F4 continuity: a poster, a source or the node that changes during the lookup refuses the answer, each before the next request or before the answer', strictly(async () => {
  const mutations = {
    'poster changed to another clip': (c) => c.poster.setAttribute('src', posterUrl('ClipAlpha')),
    'player source changed': (c) => setSource(c.video, 'blob:https://www.redgifs.com/recycled'),
    'player removed': (c) => c.video.remove(),
    'card removed': (c) => c.gif.remove()
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    for (const atRequest of [1, 2]) {
      const { env, cards } = nicheFeed(['ClipBravo']);
      const c = cards[0];
      env.ctx.setLastContextmenuTarget(c.video, c.path);
      providerMock(env, { clipbravo: { id: 'ClipBravo', hasAudio: true, urls: { hd: mediaOf('ClipBravo') } } }, { onRequest: (u, n) => { if (n === atRequest) mutate(c); } });
      const answer = await answerAsync(env, c.blob);
      refusedAnswer(answer, `${what} at request ${atRequest}`);
      assert.strictEqual(answer.diagnostics.providerAudio, 'FRAME_CHANGED', `${what} at request ${atRequest}`);
      assert.strictEqual(env.fetchCalls.length, atRequest, `${what}: nothing is asked after the change was seen`);
    }
  }
}));

runTestAsync('F4 recycled player: the same node under a different poster, or a new node, is not the gesture\'s selection (no request)', strictly(async () => {
  const same = nicheFeed(['ClipBravo']);
  const c = same.cards[0];
  same.env.ctx.setLastContextmenuTarget(c.video, c.path);
  assert.strictEqual(same.env.ctx.findClickedVideo(c.blob), c.video, 'control: the unchanged player is the selection');
  c.poster.setAttribute('src', posterUrl('ClipAlpha'));
  providerMock(same.env, { clipalpha: { id: 'ClipAlpha', hasAudio: true, urls: { hd: mediaOf('ClipAlpha') } } });
  assert.strictEqual(same.env.ctx.findClickedVideo(c.blob), null, 'the poster changed: not the player the gesture saw');
  refusedAnswer(await answerAsync(same.env, c.blob), 'poster changed after the gesture');
  assert.strictEqual(same.env.fetchCalls.length, 0);

  const swapped = nicheFeed(['ClipBravo']);
  const d = swapped.cards[0];
  swapped.env.ctx.setLastContextmenuTarget(d.video, d.path);
  d.video.remove();
  const next = swapped.env.doc.createElement('video', { src: d.blob, currentSrc: d.blob });
  d.holder.appendChild(next);
  providerMock(swapped.env, { clipbravo: { id: 'ClipBravo', hasAudio: true, urls: { hd: mediaOf('ClipBravo') } } });
  refusedAnswer(await answerAsync(swapped.env, d.blob), 'a recycled node with the same blob address');
  assert.strictEqual(swapped.env.fetchCalls.length, 0);
}));

runTestAsync('F4 gesture binding: untrusted events and a stale or foreign gesture are refused without requests; the admitted trusted selection recovers', strictly(async () => {
  const forged = nicheFeed(['ClipAlpha', 'ClipBravo']);
  providerMock(forged.env, { clipalpha: { id: 'ClipAlpha', hasAudio: true, urls: { hd: mediaOf('ClipAlpha') } }, clipbravo: { id: 'ClipBravo', hasAudio: true, urls: { hd: mediaOf('ClipBravo') } } });
  fire(forged.env, 'contextmenu', forged.cards[0].video, { trusted: false, path: forged.cards[0].path });
  refusedAnswer(await answerAsync(forged.env, '', { requireGesture: true, gestureAt: 5 }), 'an event dispatched by the page selects nothing for a gesture-bound request');
  assert.strictEqual(forged.env.fetchCalls.length, 0);
  // an ordinary request keeps its established exact-address rule; the forged event on the first card redirects it nowhere
  const ordinary = await answerAsync(forged.env, forged.cards[1].blob);
  assert.strictEqual(ordinary.targetUrl, mediaOf('ClipBravo'), 'the exact blob address names its own player; the forged gesture on the other card changes nothing');

  const { env, cards } = nicheFeed(['ClipAlpha', 'ClipBravo']);
  providerMock(env, { clipbravo: { id: 'ClipBravo', hasAudio: true, urls: { hd: mediaOf('ClipBravo') } } });
  fire(env, 'contextmenu', cards[1].video, { path: cards[1].path });
  env.ctx.__imageSaverContextTarget = { at: 4242 };
  for (const wrong of [{ requireGesture: true }, { requireGesture: true, gestureAt: 1 }]) {
    refusedAnswer(await answerAsync(env, '', wrong), 'not bound to the latest capture ' + JSON.stringify(wrong));
  }
  assert.strictEqual(env.fetchCalls.length, 0, 'no request for an unbound operation');
  const bound = await answerAsync(env, '', { requireGesture: true, gestureAt: 4242 });
  assert.strictEqual(bound.success, true, 'the admitted selection (address-less request) recovers its clip');
  assert.strictEqual(bound.targetUrl, mediaOf('ClipBravo'));
  // a later trusted gesture on the other card redirects nothing: the earlier operation is refused
  fire(env, 'contextmenu', cards[0].video, { path: cards[0].path });
  env.ctx.__imageSaverContextTarget = { at: 9999 };
  const before = env.fetchCalls.length;
  refusedAnswer(await answerAsync(env, '', { requireGesture: true, gestureAt: 4242 }), 'an earlier operation after a later gesture');
  assert.strictEqual(env.fetchCalls.length, before, 'and it asks nobody');
}));

// ---- summary --------------------------------------------------------------

(async () => {
  for (const t of asyncTests) {
    try {
      await t.fn();
      testsPassed++;
      console.log(`[PASS] ${t.name}`);
    } catch (err) {
      testsFailed++;
      console.error(`[FAIL] ${t.name}: ${err.message}`);
      if (process.env.DEBUG) console.error(err);
    }
  }
  console.log('\n========================================');
  console.log(`Summary: ${testsPassed}/${testsPassed + testsFailed} tests passed (${testsFailed} failed)`);
  console.log('========================================');
  process.exit(testsFailed > 0 ? 1 : 0);
})();
