'use strict';

/**
 * test_redgifs_reinjection.js
 *
 * Verifies that content_redgifs.js initialization is idempotent within a single
 * document/frame execution context, preventing duplicate DOM and runtime listeners,
 * preventing message multiplication on gestures, maintaining single-response resolver
 * behavior, preserving captured closure state across re-injections, and allowing fresh
 * independent frames to initialize normally.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REDGIFS_SCRIPT_PATH = process.env.REDGIFS_SCRIPT_PATH || path.join(__dirname, 'content_redgifs.js');
const REDGIFS_CODE = fs.readFileSync(REDGIFS_SCRIPT_PATH, 'utf8');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`[FAIL] ${name}`);
    console.error(err);
  }
}

/**
 * Creates a mock DOM element.
 */
function createMockElement(tag, attrs = {}) {
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children,
    childNodes: children,
    attributes: { ...attrs },
    classList: {
      _classes: new Set((attrs.class || '').split(/\s+/).filter(Boolean)),
      contains(c) { return this._classes.has(c); },
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      [Symbol.iterator]() { return this._classes[Symbol.iterator](); }
    },
    getAttribute(name) {
      if (name in this.attributes) return this.attributes[name];
      if (name in this) return this[name];
      return null;
    },
    setAttribute(name, val) {
      this.attributes[name] = String(val);
      if (name === 'src') this.src = String(val);
      if (name === 'href') this.href = String(val);
    },
    appendChild(child) {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    querySelector(sel) {
      const all = el.querySelectorAll(sel);
      return all.length > 0 ? all[0] : null;
    },
    querySelectorAll(sel) {
      const results = [];
      function recurse(node) {
        for (const ch of node.children) {
          if (matchesSel(ch, sel)) results.push(ch);
          recurse(ch);
        }
      }
      recurse(el);
      return results;
    },
    matches(sel) {
      if (Array.isArray(sel)) return sel.some(s => matchesSel(el, s));
      return matchesSel(el, sel);
    },
    closest(sel) {
      let cur = el;
      while (cur) {
        if (Array.isArray(sel) ? sel.some(s => matchesSel(cur, s)) : matchesSel(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
  };

  for (const [k, v] of Object.entries(attrs)) {
    el[k] = v;
  }
  return el;
}

function matchesSel(el, sel) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (sel === 'video' && tag === 'video') return true;
  if (sel === 'iframe' && tag === 'iframe') return true;
  if (sel === 'script' && tag === 'script') return true;
  if (sel === 'a' && tag === 'a') return true;
  if (sel === 'iframe[src*="redgifs.com"]' && tag === 'iframe') {
    const s = el.src || el.getAttribute('src') || '';
    return s.includes('redgifs.com');
  }
  if (sel === 'a[href*="redgifs.com"]' && tag === 'a') {
    const h = el.href || el.getAttribute('href') || '';
    return h.includes('redgifs.com');
  }
  if (sel.includes('.redgifs-player') && el.classList.contains('redgifs-player')) return true;
  if (sel.includes('shreddit-post') && tag === 'shreddit-post') return true;
  return false;
}

/**
 * Creates a mock document & execution world environment.
 */
function createMockEnvironment(options = {}) {
  const href = options.url || 'https://www.redgifs.com/watch/ImperturbableLiveCaimanlizard';
  const parsedUrl = new URL(href);

  const windowListeners = {
    mousedown: [],
    contextmenu: []
  };
  const messageListeners = [];
  const sentMessages = [];

  const mockWindow = {
    location: {
      href: parsedUrl.href,
      hostname: parsedUrl.hostname,
      pathname: parsedUrl.pathname,
      search: parsedUrl.search,
      protocol: parsedUrl.protocol,
      toString() { return this.href; }
    },
    addEventListener: (event, handler, useCapture) => {
      if (!windowListeners[event]) windowListeners[event] = [];
      windowListeners[event].push({ handler, useCapture: !!useCapture });
    },
    removeEventListener: (event, handler) => {
      if (windowListeners[event]) {
        windowListeners[event] = windowListeners[event].filter(entry => entry.handler !== handler);
      }
    }
  };

  const rootHtml = createMockElement('html');
  const body = createMockElement('body');
  rootHtml.appendChild(body);

  const mockDocument = {
    location: mockWindow.location,
    body,
    documentElement: rootHtml,
    createElement: (tag) => createMockElement(tag),
    querySelector: (sel) => rootHtml.querySelector(sel),
    querySelectorAll: (sel) => rootHtml.querySelectorAll(sel)
  };

  const mockChrome = {
    runtime: {
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        return { success: true };
      },
      onMessage: {
        addListener: (cb) => {
          messageListeners.push(cb);
        }
      }
    }
  };

  const sandbox = {
    console,
    Date,
    URL,
    Array,
    Object,
    Number,
    String,
    Set,
    WeakRef,
    window: mockWindow,
    document: mockDocument,
    chrome: mockChrome
  };

  vm.createContext(sandbox);

  return {
    sandbox,
    mockWindow,
    mockDocument,
    mockChrome,
    windowListeners,
    messageListeners,
    sentMessages,
    body
  };
}

/**
 * Dispatches a simulated right-click gesture to mock window listeners.
 */
function simulateRightClick(env, target) {
  const path = [];
  let cur = target;
  while (cur) {
    path.push(cur);
    cur = cur.parentElement;
  }
  const timeStamp = 5000;

  const mousedownEvent = {
    isTrusted: true,
    button: 2,
    target,
    composedPath: () => path,
    timeStamp
  };

  const contextmenuEvent = {
    isTrusted: true,
    button: 2,
    target,
    composedPath: () => path,
    timeStamp
  };

  for (const entry of (env.windowListeners.mousedown || [])) {
    entry.handler(mousedownEvent);
  }
  for (const entry of (env.windowListeners.contextmenu || [])) {
    entry.handler(contextmenuEvent);
  }
}

// -----------------------------------------------------------------------------
// Proof 1: Repeated evaluation in one context does not add listeners again.
// -----------------------------------------------------------------------------
runTest('Language subscriptions remain single after catalogue and script reinjection', () => {
  const env = createMockEnvironment();
  const listeners = [];
  env.mockChrome.storage = {
    local: { get: async () => ({ uiLanguage: 'en' }) },
    onChanged: { addListener: (cb) => listeners.push(cb) }
  };
  const catalogue = fs.readFileSync(path.join(__dirname, 'lib/i18n.js'), 'utf8');
  vm.runInContext(catalogue, env.sandbox);
  vm.runInContext(REDGIFS_CODE, env.sandbox);
  const initialCount = listeners.length;
  assert(initialCount > 0, 'The real language subscriber is loaded');
  for (let i = 0; i < 5; i++) {
    vm.runInContext(catalogue, env.sandbox);
    vm.runInContext(REDGIFS_CODE, env.sandbox);
  }
  assert.equal(listeners.length, initialCount, 'Reinjection must not add discarded language subscribers');
});

runTest('Proof 1: Repeated evaluation in one context does not add duplicate DOM or runtime listeners', () => {
  const env = createMockEnvironment();

  // First evaluation
  vm.runInContext(REDGIFS_CODE, env.sandbox);

  const mousedownCount1 = env.windowListeners.mousedown.length;
  const contextmenuCount1 = env.windowListeners.contextmenu.length;
  const messageListenerCount1 = env.messageListeners.length;

  assert.strictEqual(mousedownCount1, 1, 'First evaluation should register exactly 1 mousedown listener');
  assert.strictEqual(contextmenuCount1, 1, 'First evaluation should register exactly 1 contextmenu listener');
  assert.strictEqual(messageListenerCount1, 1, 'First evaluation should register exactly 1 runtime.onMessage listener');

  // Second evaluation (simulating programmatic re-injection into same frame)
  vm.runInContext(REDGIFS_CODE, env.sandbox);

  const mousedownCount2 = env.windowListeners.mousedown.length;
  const contextmenuCount2 = env.windowListeners.contextmenu.length;
  const messageListenerCount2 = env.messageListeners.length;

  assert.strictEqual(mousedownCount2, 1, 'Second evaluation must not add another mousedown listener');
  assert.strictEqual(contextmenuCount2, 1, 'Second evaluation must not add another contextmenu listener');
  assert.strictEqual(messageListenerCount2, 1, 'Second evaluation must not add another runtime.onMessage listener');
});

// -----------------------------------------------------------------------------
// Proof 2: Gesture after repeated evaluation does not multiply messages.
// -----------------------------------------------------------------------------
runTest('Proof 2: Gesture after repeated evaluation does not multiply dispatched messages', () => {
  // Environment A: evaluated once
  const envA = createMockEnvironment();
  vm.runInContext(REDGIFS_CODE, envA.sandbox);

  const videoA = createMockElement('video', {
    src: 'https://media.redgifs.com/ImperturbableLiveCaimanlizard.mp4',
    currentSrc: 'https://media.redgifs.com/ImperturbableLiveCaimanlizard.mp4'
  });
  envA.body.appendChild(videoA);

  simulateRightClick(envA, videoA);
  const msgCountA = envA.sentMessages.length;
  assert(msgCountA > 0, 'Gesture in single-evaluation environment must dispatch at least one contextmenu detection message');

  // Environment B: evaluated TWICE
  const envB = createMockEnvironment();
  vm.runInContext(REDGIFS_CODE, envB.sandbox);
  vm.runInContext(REDGIFS_CODE, envB.sandbox); // Re-injected

  const videoB = createMockElement('video', {
    src: 'https://media.redgifs.com/ImperturbableLiveCaimanlizard.mp4',
    currentSrc: 'https://media.redgifs.com/ImperturbableLiveCaimanlizard.mp4'
  });
  envB.body.appendChild(videoB);

  simulateRightClick(envB, videoB);
  const msgCountB = envB.sentMessages.length;

  assert.strictEqual(msgCountB, msgCountA,
    `Re-injected environment dispatched ${msgCountB} messages, expected exactly ${msgCountA} (no duplicate message emissions)`
  );
  assert.strictEqual(envB.sentMessages[0].action, 'REDGIFS_MEDIA_CONTEXTMENU_DETECTED');
});

// -----------------------------------------------------------------------------
// Proof 3: Resolver request receives one response and retains source selection.
// -----------------------------------------------------------------------------
runTest('Proof 3: Resolver request receives exactly one response and retains existing source-selection behavior', () => {
  const env = createMockEnvironment();
  // Evaluated twice to test resolver after re-injection
  vm.runInContext(REDGIFS_CODE, env.sandbox);
  vm.runInContext(REDGIFS_CODE, env.sandbox);

  const video = createMockElement('video', {
    src: 'https://media.redgifs.com/ImperturbableLiveCaimanlizard-silent.mp4',
    currentSrc: 'https://media.redgifs.com/ImperturbableLiveCaimanlizard-silent.mp4'
  });
  env.body.appendChild(video);

  const script = createMockElement('script', {
    id: '__NEXT_DATA__',
    type: 'application/json'
  });
  script.textContent = JSON.stringify({
    props: {
      pageProps: {
        current: {
          id: 'ImperturbableLiveCaimanlizard',
          hasAudio: true,
          urls: {
            hd: 'https://media.redgifs.com/ImperturbableLiveCaimanlizard.mp4?sig=test1',
            sd: 'https://media.redgifs.com/ImperturbableLiveCaimanlizard-mobile.mp4?sig=test2',
            silent: 'https://media.redgifs.com/ImperturbableLiveCaimanlizard-silent.mp4'
          }
        }
      }
    }
  });
  env.body.appendChild(script);

  // Set the contextmenu target before resolution
  env.sandbox.setLastContextmenuTarget(video, [video, env.body]);

  // Dispatch RESOLVE_FRAME_MEDIA to onMessage listeners
  let responseCount = 0;
  let receivedResponse = null;

  const msg = {
    action: 'RESOLVE_FRAME_MEDIA',
    clickedSrc: 'https://media.redgifs.com/ImperturbableLiveCaimanlizard-silent.mp4',
    frameId: 1
  };
  const sender = { tab: { id: 101 }, frameId: 1 };
  const sendResponse = (resp) => {
    responseCount++;
    receivedResponse = resp;
  };

  assert.strictEqual(env.messageListeners.length, 1, 'Exactly one message listener should exist to receive the message');
  for (const listener of env.messageListeners) {
    listener(msg, sender, sendResponse);
  }

  assert.strictEqual(responseCount, 1, 'Resolver message must invoke sendResponse exactly once');
  assert.ok(receivedResponse, 'Response must be received');
  assert.strictEqual(receivedResponse.success, true, 'Resolver response must be successful');
  assert.strictEqual(
    receivedResponse.targetUrl,
    'https://media.redgifs.com/ImperturbableLiveCaimanlizard.mp4?sig=test1',
    'Audio-bearing HD rendition must win over silent rendition according to existing ranking policy'
  );
});

// -----------------------------------------------------------------------------
// Proof 4: Fresh independent frame/document initializes normally.
// -----------------------------------------------------------------------------
runTest('Proof 4: Fresh independent frame/document initializes normally', () => {
  const frame1 = createMockEnvironment({ url: 'https://www.redgifs.com/ifr/wildcheetah' });
  const frame2 = createMockEnvironment({ url: 'https://www.redgifs.com/ifr/slowturtle' });

  // Frame 1 evaluated twice
  vm.runInContext(REDGIFS_CODE, frame1.sandbox);
  vm.runInContext(REDGIFS_CODE, frame1.sandbox);

  // Frame 2 evaluated once
  vm.runInContext(REDGIFS_CODE, frame2.sandbox);

  assert.strictEqual(frame1.windowListeners.mousedown.length, 1, 'Frame 1 has 1 mousedown listener');
  assert.strictEqual(frame1.windowListeners.contextmenu.length, 1, 'Frame 1 has 1 contextmenu listener');
  assert.strictEqual(frame1.messageListeners.length, 1, 'Frame 1 has 1 runtime message listener');

  assert.strictEqual(frame2.windowListeners.mousedown.length, 1, 'Frame 2 must initialize its own mousedown listener');
  assert.strictEqual(frame2.windowListeners.contextmenu.length, 1, 'Frame 2 must initialize its own contextmenu listener');
  assert.strictEqual(frame2.messageListeners.length, 1, 'Frame 2 must initialize its own runtime message listener');

  // Verify Frame 2 functions independently
  const video2 = createMockElement('video', {
    src: 'https://media.redgifs.com/slowturtle.mp4',
    currentSrc: 'https://media.redgifs.com/slowturtle.mp4'
  });
  frame2.body.appendChild(video2);

  simulateRightClick(frame2, video2);
  assert.strictEqual(frame2.sentMessages.length, 2, 'Frame 2 sent contextmenu detection messages');
  assert.strictEqual(frame1.sentMessages.length, 0, 'Frame 1 was not affected by Frame 2 gesture');
});

// -----------------------------------------------------------------------------
// Proof 5: Repeated evaluation does not reset captured state unexpectedly.
// -----------------------------------------------------------------------------
runTest('Proof 5: Repeated evaluation preserves captured state and resolves through runtime onMessage without borrowing', () => {
  const env = createMockEnvironment();
  vm.runInContext(REDGIFS_CODE, env.sandbox);

  // 1. Create two distinct video cards
  const card1 = createMockElement('div', { class: 'redgifs-player', id: 'card1' });
  const video1 = createMockElement('video', {
    src: 'https://media.redgifs.com/FirstClip.mp4',
    currentSrc: 'https://media.redgifs.com/FirstClip.mp4'
  });
  const overlay1 = createMockElement('div', { class: 'touch-overlay' });
  card1.appendChild(video1);
  card1.appendChild(overlay1);
  env.body.appendChild(card1);

  const card2 = createMockElement('div', { class: 'redgifs-player', id: 'card2' });
  const video2 = createMockElement('video', {
    src: 'https://media.redgifs.com/SecondClip.mp4',
    currentSrc: 'https://media.redgifs.com/SecondClip.mp4'
  });
  const overlay2 = createMockElement('div', { class: 'touch-overlay' });
  card2.appendChild(video2);
  card2.appendChild(overlay2);
  env.body.appendChild(card2);

  // 2. Capture a real simulated gesture on the first card's overlay
  simulateRightClick(env, overlay1);

  // 3. Evaluate the production script again (simulating programmatic reinjection)
  vm.runInContext(REDGIFS_CODE, env.sandbox);

  // 4. Dispatch RESOLVE_FRAME_MEDIA through registered onMessage handlers
  const responsesCard1 = [];
  const msgCard1 = {
    action: 'RESOLVE_FRAME_MEDIA',
    clickedSrc: 'https://media.redgifs.com/FirstClip.mp4',
    frameId: 0
  };
  const sender = { tab: { id: 201 }, frameId: 0 };
  for (const listener of env.messageListeners) {
    listener(msgCard1, sender, (resp) => {
      responsesCard1.push(resp);
    });
  }

  // 5. Assert exactly one response, successful resolution of the selected first clip, and no borrowing of the second clip
  assert.strictEqual(
    responsesCard1.length,
    1,
    `Expected exactly 1 response from onMessage after reinjection, received ${responsesCard1.length}`
  );
  assert.strictEqual(responsesCard1[0].success, true, 'First clip resolution must succeed');
  assert.strictEqual(
    responsesCard1[0].targetUrl,
    'https://media.redgifs.com/FirstClip.mp4',
    'Resolver must resolve the selected first clip'
  );
  assert.notStrictEqual(
    responsesCard1[0].targetUrl,
    'https://media.redgifs.com/SecondClip.mp4',
    'Resolver must not borrow the second clip'
  );

  // 6. Capture a subsequent gesture on the second card and prove the same initialized script resolves that newly selected clip
  simulateRightClick(env, overlay2);

  const responsesCard2 = [];
  const msgCard2 = {
    action: 'RESOLVE_FRAME_MEDIA',
    clickedSrc: 'https://media.redgifs.com/SecondClip.mp4',
    frameId: 0
  };
  for (const listener of env.messageListeners) {
    listener(msgCard2, sender, (resp) => {
      responsesCard2.push(resp);
    });
  }

  assert.strictEqual(
    responsesCard2.length,
    1,
    `Expected exactly 1 response for subsequent gesture on card2, received ${responsesCard2.length}`
  );
  assert.strictEqual(responsesCard2[0].success, true, 'Second clip resolution must succeed');
  assert.strictEqual(
    responsesCard2[0].targetUrl,
    'https://media.redgifs.com/SecondClip.mp4',
    'Resolver must resolve the newly selected second clip'
  );
  assert.notStrictEqual(
    responsesCard2[0].targetUrl,
    'https://media.redgifs.com/FirstClip.mp4',
    'Resolver must not retain or borrow the first clip for the second gesture'
  );
});

// Summary
console.log('\n========================================');
console.log(`Summary: ${passedTests}/${totalTests} tests passed (${failedTests} failed)`);
console.log('========================================');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
