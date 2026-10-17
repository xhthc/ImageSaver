// test_reddit_inline_diagnostic.js
// Regression test suite for tools/diagnostics/reddit-inline-diagnostic.js
// Covers: selection refusal, light/open-shadow frame evidence, child document uncertainty,
// clip ID agreement/mismatch, URL query redaction, HTML attribute extraction without raw HTML leakage,
// geometry/clipping/position evidence, corner hit-testing, event logging, DOM mutation detection,
// record bounds/truncation, cleanup on timeout/manual stop, isolated-world notice, and synthetic labeling.

'use strict';

const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  runRedditInlineDiagnostic,
  controller,
  redactUrl,
  parseRedGifsUrl,
  extractRedGifsClipId,
  extractIframeSrcFromHtmlAttr,
  resolveNearestOwner,
  isConnectedToOwner,
  inspectPostIdentity,
  inspectEmbedAndClip,
  inspectGeometryAndLayout
} = require('../tools/diagnostics/reddit-inline-diagnostic.js');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function it(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Minimal Mock DOM Harness for Node.js Testing (Strictly [SYNTHETIC])
// ---------------------------------------------------------------------------

class SyntheticMockHTMLCollection {
  constructor(elements = []) {
    for (let i = 0; i < elements.length; i++) {
      this[i] = elements[i];
    }
    this.length = elements.length;
  }

  item(i) {
    return this[i] || null;
  }

  *[Symbol.iterator]() {
    for (let i = 0; i < this.length; i++) {
      yield this[i];
    }
  }
}

class SyntheticMockElement {
  constructor(tag, attrs = {}) {
    this.tagName = (tag || '').toUpperCase();
    this.nodeType = 1;
    this.attributes = { ...attrs };
    this.id = attrs.id || '';
    this.className = attrs.class || attrs.className || '';
    this.parentElement = null;
    this._childrenList = [];
    this._customChildren = null;
    this.shadowRoot = null;
    this._listeners = new Map();
    this._rect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    this._syntheticLabel = '[SYNTHETIC]';
  }

  get children() {
    return this._customChildren || new SyntheticMockHTMLCollection(this._childrenList);
  }

  set children(val) {
    if (Array.isArray(val)) {
      this._childrenList = [...val];
      this._customChildren = null;
    } else if (val && typeof val === 'object') {
      this._customChildren = val;
    }
  }

  getAttribute(name) {
    return this.attributes[name] !== undefined ? this.attributes[name] : null;
  }

  _notifyMutation(mutation) {
    let cur = this;
    while (cur) {
      if (cur._observers) {
        for (const { observer, options } of cur._observers) {
          if (cur === this || options.subtree) {
            observer.callback([mutation]);
          }
        }
      }
      cur = cur.parentElement;
    }
    const root = typeof this.getRootNode === 'function' ? this.getRootNode() : null;
    if (root && root !== this && typeof root._notifyMutation === 'function') {
      root._notifyMutation(mutation);
    }
  }

  setAttribute(name, val) {
    this.attributes[name] = String(val);
    if (name === 'id') this.id = String(val);
    if (name === 'class' || name === 'className') this.className = String(val);
    this._notifyMutation({ type: 'attributes', target: this, attributeName: name });
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'id') this.id = '';
    if (name === 'class' || name === 'className') this.className = '';
  }

  appendChild(child) {
    child.parentElement = this;
    this._childrenList.push(child);
    this._notifyMutation({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
    return child;
  }

  removeChild(child) {
    const idx = this._childrenList.indexOf(child);
    if (idx >= 0) {
      this._childrenList.splice(idx, 1);
      child.parentElement = null;
      this._notifyMutation({ type: 'childList', target: this, addedNodes: [], removedNodes: [child] });
    }
    return child;
  }

  attachShadow(init) {
    this.shadowRoot = new SyntheticMockShadowRoot(this, init && init.mode);
    return this.shadowRoot;
  }

  getRootNode() {
    let cur = this;
    while (cur.parentElement) cur = cur.parentElement;
    if (cur._shadowHost && cur._shadowHost.shadowRoot) {
      return cur._shadowHost.shadowRoot;
    }
    return cur;
  }

  closest(selector) {
    const match = (el) => {
      const tag = el.tagName.toLowerCase();
      const s = selector.toLowerCase();
      if (s.includes('shreddit-post') && tag === 'shreddit-post') return true;
      if (s.includes('shreddit-embed') && tag === 'shreddit-embed') return true;
      if (s.includes('shreddit-comment') && tag === 'shreddit-comment') return true;
      if (s.includes('[data-testid="comment"]') && el.getAttribute('data-testid') === 'comment') return true;
      if (s.includes('.comment') && el.className.includes('comment')) return true;
      if (s.includes('crosspost') && (tag.includes('crosspost') || el.getAttribute('data-testid') === 'crosspost')) return true;
      return false;
    };

    let cur = this;
    while (cur) {
      if (cur.tagName && match(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  contains(el) {
    if (!el) return false;
    if (el === this) return true;
    let cur = el.parentElement;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  querySelector(selector) {
    const s = selector.toLowerCase();
    const find = (node) => {
      for (const ch of node.children) {
        const tag = ch.tagName.toLowerCase();
        if (s === 'iframe' && tag === 'iframe') return ch;
        if (s === 'shreddit-embed' && tag === 'shreddit-embed') return ch;
        const res = find(ch);
        if (res) return res;
      }
      return null;
    };
    return find(this);
  }

  querySelectorAll(selector) {
    const out = [];
    const s = selector.toLowerCase();
    const collect = (node) => {
      for (const ch of node.children) {
        const tag = ch.tagName.toLowerCase();
        if (s === 'iframe' && tag === 'iframe') out.push(ch);
        if (s === 'shreddit-embed' && tag === 'shreddit-embed') out.push(ch);
        collect(ch);
      }
    };
    collect(this);
    return out;
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  setRect(r) {
    this._rect = { ...r };
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    if (this._listeners.has(type)) {
      this._listeners.get(type).delete(fn);
    }
  }

  dispatchEvent(event) {
    event.target = this;
    if (this._listeners.has(event.type)) {
      for (const fn of this._listeners.get(event.type)) {
        fn(event);
      }
    }
  }
}

class SyntheticMockShadowRoot {
  constructor(host, mode = 'open') {
    this.host = host;
    this.mode = mode;
    this._childrenList = [];
    this._customChildren = null;
    this._listeners = new Map();
    this.nodeType = 11;
  }

  get children() {
    return this._customChildren || new SyntheticMockHTMLCollection(this._childrenList);
  }

  set children(val) {
    if (Array.isArray(val)) {
      this._childrenList = [...val];
      this._customChildren = null;
    } else if (val && typeof val === 'object') {
      this._customChildren = val;
    }
  }

  appendChild(child) {
    child.parentElement = null;
    child._shadowHost = this.host;
    this._childrenList.push(child);
    this._notifyMutation({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
    return child;
  }

  removeChild(child) {
    const idx = this._childrenList.indexOf(child);
    if (idx >= 0) {
      this._childrenList.splice(idx, 1);
      child.parentElement = null;
      child._shadowHost = null;
      this._notifyMutation({ type: 'childList', target: this, addedNodes: [], removedNodes: [child] });
    }
    return child;
  }

  querySelector(selector) {
    const s = selector.toLowerCase();
    for (const ch of this.children) {
      if (s === 'iframe' && ch.tagName.toLowerCase() === 'iframe') return ch;
    }
    return null;
  }

  _notifyMutation(mutation) {
    if (this._observers) {
      for (const { observer, options } of this._observers) {
        if (options.subtree || mutation.target === this) {
          observer.callback([mutation]);
        }
      }
    }
  }
}

class SyntheticMockMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.target = null;
  }

  observe(target, options = {}) {
    this.target = target;
    if (!target._observers) target._observers = [];
    target._observers.push({ observer: this, options });
  }

  disconnect() {
    if (this.target && this.target._observers) {
      this.target._observers = this.target._observers.filter((o) => o.observer !== this);
      this.target = null;
    }
  }
}

function createSyntheticMockEnvironment() {
  const styles = new Map();

  const doc = {
    _listeners: new Map(),
    elementFromPoint: (x, y) => null,
    addEventListener: (type, fn) => {
      if (!doc._listeners.has(type)) doc._listeners.set(type, new Set());
      doc._listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      if (doc._listeners.has(type)) doc._listeners.get(type).delete(fn);
    },
    dispatchEvent: (evt) => {
      if (doc._listeners.has(evt.type)) {
        for (const fn of doc._listeners.get(evt.type)) fn(evt);
      }
    }
  };

  const win = {
    innerWidth: 1920,
    innerHeight: 1080,
    scrollX: 0,
    scrollY: 0,
    document: doc,
    MutationObserver: SyntheticMockMutationObserver,
    getComputedStyle: (el) => {
      if (styles.has(el)) return styles.get(el);
      return {
        overflow: 'visible',
        overflowX: 'visible',
        overflowY: 'visible',
        position: 'static'
      };
    },
    setComputedStyle: (el, cs) => {
      styles.set(el, cs);
    }
  };

  return { doc, win };
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

console.log('Running test_reddit_inline_diagnostic.js...');

// 1. Selection refusal
it('selection refusal: null or undefined element returns NO_SELECTION', () => {
  const res1 = resolveNearestOwner(null);
  assert.strictEqual(res1.ok, false);
  assert.strictEqual(res1.error, 'NO_SELECTION');

  const res2 = runRedditInlineDiagnostic(null, { autoLog: false });
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.error, 'NO_SELECTION');
});

it('selection refusal: element without shreddit-post returns NO_SHREDDIT_POST_OWNER without scanning', () => {
  const [SYNTHETIC] = [true];
  const orphan = new SyntheticMockElement('div', { id: 'orphan-1' });
  const res = resolveNearestOwner(orphan);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'NO_SHREDDIT_POST_OWNER');
});

it('selection refusal: comment media is refused as REJECTED_COMMENT_OWNER', () => {
  const [SYNTHETIC] = [true];
  const post = new SyntheticMockElement('shreddit-post', { id: 't3_commentpost' });
  const comment = new SyntheticMockElement('shreddit-comment', { id: 't1_abc' });
  const video = new SyntheticMockElement('video', { src: 'https://v.redd.it/test' });
  post.appendChild(comment);
  comment.appendChild(video);

  const res = resolveNearestOwner(video);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'REJECTED_COMMENT_OWNER');
});

// 2. URL and Attribute Redaction
it('redactUrl: strips query string and hash fragment from URLs', () => {
  const u1 = redactUrl('https://www.redgifs.com/watch/optimisticnegativerat?param1=val&token=secret#frag');
  assert.strictEqual(u1, 'https://www.redgifs.com/watch/optimisticnegativerat');

  const u2 = redactUrl('https://www.redgifs.com/ifr/optimisticnegativerat?autoplay=0');
  assert.strictEqual(u2, 'https://www.redgifs.com/ifr/optimisticnegativerat');

  const u3 = redactUrl('/r/subreddit/comments/1wchzc1/some_title/?utm_source=share#top');
  assert.strictEqual(u3, 'https://www.reddit.com/r/subreddit/comments/1wchzc1/some_title/');

  const u4 = redactUrl('relative/path/file.mp4?sig=secret#anchor');
  assert.strictEqual(u4, 'relative/path/file.mp4');

  const u5 = redactUrl('');
  assert.strictEqual(u5, '');
});

// 3. RedGIFs clip ID extraction
it('extractRedGifsClipId: extracts normalized clip IDs from watch and ifr paths', () => {
  assert.strictEqual(extractRedGifsClipId('https://www.redgifs.com/watch/OptimisticNegativeRat?foo=bar'), 'optimisticnegativerat');
  assert.strictEqual(extractRedGifsClipId('https://redgifs.com/ifr/OptimisticNegativeRat'), 'optimisticnegativerat');
  assert.strictEqual(extractRedGifsClipId('https://i.redd.it/image.png'), null);
});

it('extractIframeSrcFromHtmlAttr: parses iframe src from html attribute without echoing raw HTML', () => {
  const htmlRaw = '<iframe src="https://www.redgifs.com/ifr/OptimisticNegativeRat?autoplay=0" frameborder="0"></iframe>';
  const src = extractIframeSrcFromHtmlAttr(htmlRaw);
  assert.strictEqual(src, 'https://www.redgifs.com/ifr/OptimisticNegativeRat?autoplay=0');

  const htmlEntity = '&lt;iframe src=&quot;https://www.redgifs.com/ifr/OptimisticNegativeRat&quot;&gt;&lt;/iframe&gt;';
  const srcEntity = extractIframeSrcFromHtmlAttr(htmlEntity);
  assert.strictEqual(srcEntity, 'https://www.redgifs.com/ifr/OptimisticNegativeRat');
});

// 4. Light-DOM Frame Evidence and Clip Agreement
it('light_dom frame evidence: detects reachable light-DOM iframe and matching clip IDs', () => {
  const [SYNTHETIC] = [true];
  const post = new SyntheticMockElement('shreddit-post', {
    id: 't3_1wchzc1',
    'post-type': 'link',
    domain: 'redgifs.com',
    'content-href': 'https://www.redgifs.com/watch/optimisticnegativerat'
  });
  const embed = new SyntheticMockElement('shreddit-embed', {
    providername: 'RedGIFs',
    html: '<iframe src="https://www.redgifs.com/ifr/optimisticnegativerat?autoplay=0"></iframe>'
  });
  const iframe = new SyntheticMockElement('iframe', {
    src: 'https://www.redgifs.com/ifr/optimisticnegativerat?autoplay=0'
  });
  embed.appendChild(iframe);
  post.appendChild(embed);

  const res = inspectEmbedAndClip(embed, post);
  assert.strictEqual(res.embed.reachability, 'light_dom');
  assert.strictEqual(res.embed.hasReachableIframe, true);
  assert.strictEqual(res.embed.iframeSrcRedacted, 'https://www.redgifs.com/ifr/optimisticnegativerat');
  assert.strictEqual(res.clipIdentity.clipIdsAgree, true);
  assert.strictEqual(res.clipIdentity.effectiveClipId, 'optimisticnegativerat');
});

// 5. Open-Shadow Frame Evidence
it('open_shadow frame evidence: detects iframe inside open shadowRoot', () => {
  const [SYNTHETIC] = [true];
  const post = new SyntheticMockElement('shreddit-post', {
    id: 't3_shadow1',
    'content-href': 'https://www.redgifs.com/watch/shadowclipid'
  });
  const embed = new SyntheticMockElement('shreddit-embed', { providername: 'RedGIFs' });
  const shadow = embed.attachShadow({ mode: 'open' });
  const shadowFrame = new SyntheticMockElement('iframe', {
    src: 'https://www.redgifs.com/ifr/shadowclipid'
  });
  shadow.appendChild(shadowFrame);
  post.appendChild(embed);

  const res = inspectEmbedAndClip(embed, post);
  assert.strictEqual(res.embed.reachability, 'open_shadow');
  assert.strictEqual(res.embed.hasReachableIframe, true);
  assert.strictEqual(res.clipIdentity.fromIframeSrc, 'shadowclipid');
  assert.strictEqual(res.clipIdentity.clipIdsAgree, true);
  assert.strictEqual(res.clipIdentity.effectiveClipId, 'shadowclipid');
});

// 6. Inaccessible child document uncertainty
it('inaccessible child document: marks cross_origin_inaccessible when contentDocument throws', () => {
  const [SYNTHETIC] = [true];
  const post = new SyntheticMockElement('shreddit-post', { id: 't3_xorig' });
  const embed = new SyntheticMockElement('shreddit-embed', { providername: 'RedGIFs' });
  const iframe = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/testclip' });
  Object.defineProperty(iframe, 'contentDocument', {
    get: () => {
      throw new Error('SecurityError: Blocked a frame with origin from accessing a cross-origin frame.');
    }
  });
  embed.appendChild(iframe);
  post.appendChild(embed);

  const res = inspectEmbedAndClip(embed, post);
  assert.strictEqual(res.embed.childDocumentAccess, 'cross_origin_inaccessible');
});

// 7. Clip ID Mismatch Detection
it('clip identity: detects mismatch when content-href and iframe src differ', () => {
  const [SYNTHETIC] = [true];
  const post = new SyntheticMockElement('shreddit-post', {
    id: 't3_mismatch',
    'content-href': 'https://www.redgifs.com/watch/clipone'
  });
  const embed = new SyntheticMockElement('shreddit-embed', { providername: 'RedGIFs' });
  const iframe = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/cliptwo' });
  embed.appendChild(iframe);
  post.appendChild(embed);

  const res = inspectEmbedAndClip(embed, post);
  assert.strictEqual(res.clipIdentity.fromContentHref, 'clipone');
  assert.strictEqual(res.clipIdentity.fromIframeSrc, 'cliptwo');
  assert.strictEqual(res.clipIdentity.clipIdsAgree, false);
  assert.strictEqual(res.clipIdentity.effectiveClipId, null);
});

// 8. Geometry, clipping ancestors, positioned container
it('geometry and layout: identifies positioned container, clipping ancestors, and visible bounds', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();

  const post = new SyntheticMockElement('shreddit-post', { id: 't3_geom' });
  post.setRect({ left: 50, top: 100, right: 650, bottom: 500, width: 600, height: 400 });

  const container = new SyntheticMockElement('div', { class: 'pos-container' });
  container.setRect({ left: 50, top: 100, right: 650, bottom: 500, width: 600, height: 400 });
  win.setComputedStyle(container, { position: 'relative', overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' });

  const embed = new SyntheticMockElement('shreddit-embed');
  embed.setRect({ left: 60, top: 120, right: 600, bottom: 450, width: 540, height: 330 });

  post.appendChild(container);
  container.appendChild(embed);

  const layout = inspectGeometryAndLayout(embed, embed, post, win, doc);
  assert.strictEqual(layout.observations.hasPositionedContainer, true);
  assert.strictEqual(layout.positionContainer.position, 'relative');
  assert.strictEqual(layout.observations.hasClippingAncestor, true);
  assert.strictEqual(layout.clippingAncestors[0].overflow, 'hidden');
  assert.strictEqual(layout.visibleRect.width, 540);
  assert.strictEqual(layout.visibleRect.height, 330);
  assert.strictEqual(layout.observations.dimensionsSufficient, true);
  assert.strictEqual(layout.observations.isWhollyOffscreen, false);
});

// 9. Corner hit-testing
it('corner hit-testing: detects covered corner when elementFromPoint returns external node', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();

  const post = new SyntheticMockElement('shreddit-post', { id: 't3_hit' });
  post.setRect({ left: 100, top: 100, right: 500, bottom: 500, width: 400, height: 400 });
  const embed = new SyntheticMockElement('shreddit-embed');
  embed.setRect({ left: 100, top: 100, right: 500, bottom: 500, width: 400, height: 400 });
  post.appendChild(embed);

  const externalOverlay = new SyntheticMockElement('header', { class: 'sticky-header' });

  doc.elementFromPoint = (x, y) => {
    // Simulate top-right corner covered by external sticky header
    if (x > 400 && y < 200) return externalOverlay;
    return embed;
  };

  const layout = inspectGeometryAndLayout(embed, embed, post, win, doc);
  assert.ok(layout.observations.coveredCorners.includes('topRight'));
  assert.strictEqual(layout.cornerHitTests.topRight.isWithinOwner, false);
  assert.strictEqual(layout.cornerHitTests.topLeft.isWithinOwner, true);
});

// 10. Observation session: pointer and focus events
it('observation session: records pointerenter, pointerleave, focusin, and focusout events', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();

  const post = new SyntheticMockElement('shreddit-post', { id: 't3_events' });
  const embed = new SyntheticMockElement('shreddit-embed', { providername: 'RedGIFs' });
  post.appendChild(embed);

  const session = runRedditInlineDiagnostic(embed, {
    window: win,
    document: doc,
    maxDurationMs: 5000,
    autoLog: false
  });

  // Dispatch pointerover
  doc.dispatchEvent({ type: 'pointerover', target: embed, clientX: 200, clientY: 250 });
  // Dispatch pointerout to outside
  const outside = new SyntheticMockElement('div');
  doc.dispatchEvent({ type: 'pointerout', target: embed, relatedTarget: outside });
  // Dispatch focusin
  post.dispatchEvent({ type: 'focusin', target: embed });

  const report = session.stop('TEST_STOP');
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.observation.status, 'completed');
  assert.strictEqual(report.observation.stopReason, 'TEST_STOP');

  const events = report.observation.events;
  assert.ok(events.some((e) => e.type === 'pointerenter'));
  assert.ok(events.some((e) => e.type === 'pointerleave'));
  assert.ok(events.some((e) => e.type === 'focusin'));
});

// 11. DOM mutation detection
it('observation session: MutationObserver records attribute and childList mutations', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();

  const post = new SyntheticMockElement('shreddit-post', { id: 't3_mut' });
  const embed = new SyntheticMockElement('shreddit-embed', { providername: 'RedGIFs' });
  const iframe = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/initialclip' });
  embed.appendChild(iframe);
  post.appendChild(embed);

  const session = runRedditInlineDiagnostic(embed, {
    window: win,
    document: doc,
    maxDurationMs: 5000,
    autoLog: false
  });

  // Trigger attribute mutation on iframe
  iframe.setAttribute('src', 'https://www.redgifs.com/ifr/mutatedclip?autoplay=0');

  // Trigger childList mutation
  const newFrame = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/replaced' });
  embed.removeChild(iframe);
  embed.appendChild(newFrame);

  const report = session.stop('MUTATION_CHECK');
  const mutations = report.observation.events.filter((e) => e.type === 'dom_mutation');
  assert.ok(mutations.length >= 2, `Expected at least 2 mutation events, got ${mutations.length}`);
  assert.ok(mutations.some((m) => m.kind === 'attribute' && m.attr === 'src'));
  assert.ok(mutations.some((m) => m.kind === 'childList'));
});

// 12. Record caps and truncation
it('record caps: marks isEventsTruncated when event limit is reached', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();

  const post = new SyntheticMockElement('shreddit-post', { id: 't3_cap' });
  const embed = new SyntheticMockElement('shreddit-embed');
  post.appendChild(embed);

  const session = runRedditInlineDiagnostic(embed, {
    window: win,
    document: doc,
    maxEvents: 5,
    maxDurationMs: 5000,
    autoLog: false
  });

  for (let i = 0; i < 10; i++) {
    doc.dispatchEvent({ type: 'pointerover', target: embed, clientX: 10 + i, clientY: 20 });
  }

  const report = session.stop('CAP_CHECK');
  assert.strictEqual(report.observation.events.length, 5);
  assert.strictEqual(report.observation.isEventsTruncated, true);
});

// 13. Cleanup on manual stop
it('cleanup: stop() disconnects observer, clears timer, and removes all listeners', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();

  const post = new SyntheticMockElement('shreddit-post', { id: 't3_clean' });
  const embed = new SyntheticMockElement('shreddit-embed');
  post.appendChild(embed);

  let stoppedReport = null;
  const session = runRedditInlineDiagnostic(embed, {
    window: win,
    document: doc,
    maxDurationMs: 5000,
    autoLog: false,
    onStop: (rep) => { stoppedReport = rep; }
  });

  assert.strictEqual(session.isStopped(), false);
  const rep = session.stop('MANUAL_STOP');

  assert.strictEqual(session.isStopped(), true);
  assert.strictEqual(rep.observation.status, 'completed');
  assert.strictEqual(rep.observation.stopReason, 'MANUAL_STOP');
  assert.ok(stoppedReport !== null);

  // Subsequent events must not be added after stop
  doc.dispatchEvent({ type: 'pointerover', target: embed, clientX: 50, clientY: 50 });
  assert.strictEqual(session.getReport().observation.events.length, 0);
});

// 14. Cleanup on timeout
it('cleanup on timeout: timer automatically stops session with TIMEOUT_30S', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();

  const post = new SyntheticMockElement('shreddit-post', { id: 't3_timeout' });
  const embed = new SyntheticMockElement('shreddit-embed');
  post.appendChild(embed);

  let timerFn = null;
  win.setTimeout = (fn) => { timerFn = fn; return 456; };
  win.clearTimeout = () => { timerFn = null; };

  let stoppedReport = null;
  const session = runRedditInlineDiagnostic(embed, {
    window: win,
    document: doc,
    maxDurationMs: 20,
    autoLog: false,
    onStop: (rep) => {
      stoppedReport = rep;
    }
  });

  assert.strictEqual(session.isStopped(), false);
  assert.ok(typeof timerFn === 'function');
  timerFn();
  assert.strictEqual(session.isStopped(), true);
  assert.ok(stoppedReport !== null);
  assert.strictEqual(stoppedReport.observation.status, 'completed');
  assert.strictEqual(stoppedReport.observation.stopReason, 'TIMEOUT_30S');
});

// 15. Isolated-world notice present in output report
it('isolated-world notice: explicitly documents inability to read __riState from page console', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();

  const post = new SyntheticMockElement('shreddit-post', { id: 't3_notice' });
  const embed = new SyntheticMockElement('shreddit-embed');
  post.appendChild(embed);

  const session = runRedditInlineDiagnostic(embed, { window: win, document: doc, autoLog: false });
  const report = session.stop('CHECK_NOTICE');
  assert.ok(typeof report.isolatedWorldNotice === 'string');
  assert.ok(report.isolatedWorldNotice.includes('isolated world'));
  assert.ok(report.isolatedWorldNotice.includes('__riState'));
});

// 16. Probe 1 regression: timeout autoLogs report when autoLog is true
it('probe 1: browser default timeout stops and autoLogs report', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();
  const post = new SyntheticMockElement('shreddit-post', { id: 't3_probe1' });
  const embed = new SyntheticMockElement('shreddit-embed');
  post.appendChild(embed);

  let timerFn = null;
  win.setTimeout = (fn) => { timerFn = fn; return 123; };
  win.clearTimeout = () => { timerFn = null; };

  let loggedCount = 0;
  win.console = {
    log: () => { loggedCount++; },
    warn: () => {},
    error: () => {}
  };

  const session = runRedditInlineDiagnostic(embed, {
    window: win,
    document: doc,
    maxDurationMs: 15,
    autoLog: true
  });

  assert.strictEqual(session.isStopped(), false);
  assert.ok(typeof timerFn === 'function');
  timerFn();
  assert.strictEqual(session.isStopped(), true);
  assert.ok(loggedCount > 0);
});

// 17. Probe 2 regression: open shadow mutation observed with null parentElement
it('probe 2: open shadow source change observed when child has null parentElement', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();
  const post = new SyntheticMockElement('shreddit-post', { id: 't3_probe2' });
  const embed = new SyntheticMockElement('shreddit-embed');
  post.appendChild(embed);
  const shadow = embed.attachShadow({ mode: 'open' });
  const frame = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/firstclip' });
  shadow.appendChild(frame);

  assert.strictEqual(frame.parentElement, null);
  assert.strictEqual(frame.getRootNode(), shadow);

  const session = runRedditInlineDiagnostic(embed, { window: win, document: doc, autoLog: false });
  frame.setAttribute('src', 'https://www.redgifs.com/ifr/secondclip');

  const report = session.stop();
  assert.strictEqual(report.embed.reachability, 'open_shadow');
  assert.strictEqual(report.observation.events.length, 1);
  assert.strictEqual(report.observation.events[0].attr, 'src');
  assert.strictEqual(report.embed.iframeSrcRedacted, 'https://www.redgifs.com/ifr/secondclip');
});

// 18. Probe 3 regression: stop() refreshes state so report is coherent with final DOM
it('probe 3: stop() refreshes post and embed snapshot to match final DOM mutation state', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();
  const post = new SyntheticMockElement('shreddit-post', {
    id: 't3_probe3',
    'content-href': 'https://www.redgifs.com/watch/firstclip'
  });
  const embed = new SyntheticMockElement('shreddit-embed');
  post.appendChild(embed);
  const frame = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/firstclip' });
  embed.appendChild(frame);

  const session = runRedditInlineDiagnostic(embed, { window: win, document: doc, autoLog: false });
  post.setAttribute('content-href', 'https://www.redgifs.com/watch/secondclip');
  frame.setAttribute('src', 'https://www.redgifs.com/ifr/secondclip');

  const report = session.stop('VERIFY_COHERENCE');
  assert.strictEqual(report.clipIdentity.fromContentHref, 'secondclip');
  assert.strictEqual(report.clipIdentity.fromIframeSrc, 'secondclip');
  assert.strictEqual(report.clipIdentity.clipIdsAgree, true);
  assert.strictEqual(report.clipIdentity.effectiveClipId, 'secondclip');
});

// 19. Probe 4 regression: foreign host URLs with injected RedGIFs paths are rejected
it('probe 4: foreign hosts with embedded redgifs paths are rejected', () => {
  const parsed = parseRedGifsUrl('https://evil.example/path/https://www.redgifs.com/ifr/firstclip');
  assert.strictEqual(parsed, null);

  const parsedValid = parseRedGifsUrl('https://www.redgifs.com/watch/validclip');
  assert.ok(parsedValid !== null);
  assert.strictEqual(parsedValid.clipId, 'validclip');
});

// 20. Probe 5 regression: nested-owner media is not borrowed by ancestor post
it('probe 5: nested post media is not borrowed by outer post', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();
  const outerPost = new SyntheticMockElement('shreddit-post', { id: 't3_outer' });
  const innerPost = new SyntheticMockElement('shreddit-post', { id: 't3_inner' });
  const innerEmbed = new SyntheticMockElement('shreddit-embed');
  const innerFrame = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/innerclip' });

  innerEmbed.appendChild(innerFrame);
  innerPost.appendChild(innerEmbed);
  outerPost.appendChild(innerPost);

  const outerSession = runRedditInlineDiagnostic(outerPost, { window: win, document: doc, autoLog: false });
  const outerReport = outerSession.stop();

  assert.strictEqual(outerReport.embed.hasEmbedHost, false);
  assert.strictEqual(outerReport.embed.hasReachableIframe, false);
  assert.strictEqual(outerReport.clipIdentity.fromIframeSrc, null);
});

// 21. Native HTMLCollection without filter method
it('native collection: inspectEmbedAndClip operates on HTMLCollection without Array.filter', () => {
  const [SYNTHETIC] = [true];
  const post = new SyntheticMockElement('shreddit-post', {
    id: 't3_htmlcoll',
    'content-href': 'https://www.redgifs.com/watch/collclip'
  });
  const embed = new SyntheticMockElement('shreddit-embed', { providername: 'RedGIFs' });
  const frame = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/collclip' });
  embed.appendChild(frame);
  post.appendChild(embed);

  assert.strictEqual(Array.isArray(embed.children), false);
  assert.strictEqual(typeof embed.children.filter, 'undefined');
  assert.strictEqual(typeof embed.children.item, 'function');

  const res = inspectEmbedAndClip(embed, post);
  assert.strictEqual(res.embed.reachability, 'light_dom');
  assert.strictEqual(res.embed.hasReachableIframe, true);
  assert.strictEqual(res.embed.iframeSrcRedacted, 'https://www.redgifs.com/ifr/collclip');
  assert.strictEqual(res.clipIdentity.clipIdsAgree, true);
});

// 22. Browser-entry VM test: auto-start with $0, timeout auto-log, and manual stop
it('browser-entry VM: auto-starts on $0 without module export and logs report on timeout and manual stop', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();
  const post = new SyntheticMockElement('shreddit-post', {
    id: 't3_vmentry',
    'content-href': 'https://www.redgifs.com/watch/vmclip'
  });
  const embed = new SyntheticMockElement('shreddit-embed');
  const frame = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/vmclip' });
  embed.appendChild(frame);
  post.appendChild(embed);

  const timers = [];
  const logs = [];
  const fakeWin = {
    ...win,
    document: doc,
    $0: embed,
    console: {
      log: (...args) => logs.push(args),
      warn: () => {},
      error: () => {}
    },
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    URL,
    Date
  };

  const vmContext = vm.createContext({
    window: fakeWin,
    document: doc,
    $0: embed,
    console: fakeWin.console,
    URL,
    Date,
    setTimeout: fakeWin.setTimeout,
    clearTimeout: fakeWin.clearTimeout
  });

  const toolCode = fs.readFileSync(path.join(REPO_ROOT, 'tools/diagnostics/reddit-inline-diagnostic.js'), 'utf8');
  vm.runInContext(toolCode, vmContext);

  assert.ok(fakeWin.__redditInlineDiagnostic);
  assert.ok(typeof fakeWin.__redditInlineDiagnostic.stop === 'function');

  // Verify auto-start log
  const startedLogs = logs.filter((args) => typeof args[0] === 'string' && args[0].includes('Started 30s observation'));
  assert.strictEqual(startedLogs.length, 1);

  // Trigger timeout callback
  assert.strictEqual(timers.length, 1);
  const beforeTimeout = logs.length;
  timers[0]();

  const timeoutReports = logs.slice(beforeTimeout).filter((args) => typeof args[0] === 'string' && args[0].includes('Completed Report'));
  assert.strictEqual(timeoutReports.length, 1);

  const jsonReportStr = logs.slice(beforeTimeout)[1][0];
  const parsedReport = JSON.parse(jsonReportStr);
  assert.strictEqual(parsedReport.tool, 'reddit-inline-diagnostic');
  assert.strictEqual(parsedReport.observation.stopReason, 'TIMEOUT_30S');
  assert.strictEqual(parsedReport.clipIdentity.effectiveClipId, 'vmclip');
});

// 23. Detached selected embed: replaced by new embed in owner
it('detached selected embed: resolves current owned embed instead of detached target and marks embedReplaced', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();
  const post = new SyntheticMockElement('shreddit-post', {
    id: 't3_replace',
    'content-href': 'https://www.redgifs.com/watch/firstclip'
  });
  const firstEmbed = new SyntheticMockElement('shreddit-embed');
  const firstFrame = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/firstclip' });
  firstEmbed.appendChild(firstFrame);
  post.appendChild(firstEmbed);

  const session = runRedditInlineDiagnostic(firstEmbed, { window: win, document: doc, autoLog: false });

  // Simulate Reddit replacing the embed with a new one and updating post content-href
  post.removeChild(firstEmbed);
  const secondEmbed = new SyntheticMockElement('shreddit-embed');
  const secondFrame = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/secondclip' });
  secondEmbed.appendChild(secondFrame);
  post.appendChild(secondEmbed);
  post.setAttribute('content-href', 'https://www.redgifs.com/watch/secondclip');

  const report = session.stop('VERIFY_REPLACEMENT');
  assert.strictEqual(report.initial.embed.iframeSrcRedacted, 'https://www.redgifs.com/ifr/firstclip');
  assert.strictEqual(report.final.embed.iframeSrcRedacted, 'https://www.redgifs.com/ifr/secondclip');
  assert.strictEqual(report.final.clipIdentity.clipIdsAgree, true);
  assert.strictEqual(report.final.clipIdentity.effectiveClipId, 'secondclip');
  assert.strictEqual(report.final.embed.targetConnected, false);
  assert.strictEqual(report.final.embed.targetDetached, true);
  assert.strictEqual(report.final.embed.embedReplaced, true);
  assert.strictEqual(report.final.embed.embedRemoved, false);
  assert.strictEqual(report.stateChange.embedReplaced, true);
});

// 24. Detached selected embed: completely removed from owner without replacement
it('detached selected embed: marks embedRemoved and does not use detached frame when embed is removed', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();
  const post = new SyntheticMockElement('shreddit-post', {
    id: 't3_removed',
    'content-href': 'https://www.redgifs.com/watch/onlyclip'
  });
  const embed = new SyntheticMockElement('shreddit-embed');
  const frame = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/onlyclip' });
  embed.appendChild(frame);
  post.appendChild(embed);

  const session = runRedditInlineDiagnostic(embed, { window: win, document: doc, autoLog: false });

  // Completely remove embed
  post.removeChild(embed);

  const report = session.stop('VERIFY_REMOVAL');
  assert.strictEqual(report.final.embed.hasEmbedHost, false);
  assert.strictEqual(report.final.embed.hasReachableIframe, false);
  assert.strictEqual(report.final.embed.targetConnected, false);
  assert.strictEqual(report.final.embed.targetDetached, true);
  assert.strictEqual(report.final.embed.embedRemoved, true);
  assert.strictEqual(report.final.embed.embedReplaced, false);
  assert.strictEqual(report.stateChange.embedRemoved, true);
});

// 25. Traversal budget exhaustion: 60-node cap marks traversalBudgetExhausted and propagates to report
it('traversal budget exhaustion: sets traversalBudgetExhausted when siblings remain beyond 60 nodes and exposes in report', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();
  const post = new SyntheticMockElement('shreddit-post', {
    id: 't3_exhaust',
    'content-href': 'https://www.redgifs.com/watch/exhaustclip'
  });

  // Append 70 sibling div elements, followed by embed at position 71
  for (let i = 0; i < 70; i++) {
    post.appendChild(new SyntheticMockElement('div'));
  }
  const embed = new SyntheticMockElement('shreddit-embed');
  const frame = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/exhaustclip' });
  embed.appendChild(frame);
  post.appendChild(embed);

  // Calling inspectEmbedAndClip on post (traversal must stop at 60 and mark budgetExhausted)
  const res = inspectEmbedAndClip(post, post);
  assert.strictEqual(res.embed.hasEmbedHost, false);
  assert.strictEqual(res.traversalBudgetExhausted, true);
  assert.strictEqual(res.embed.traversalBudgetExhausted, true);
  assert.strictEqual(res.embed.absenceInconclusive, true);

  // Calling in full observation session exposes exhaustion in JSON report
  const session = runRedditInlineDiagnostic(post, { window: win, document: doc, autoLog: false });
  const report = session.stop('EXHAUSTION_CHECK');
  assert.strictEqual(report.traversalBudgetExhausted, true);
  assert.strictEqual(report.embed.traversalBudgetExhausted, true);
  assert.strictEqual(report.final.embed.traversalBudgetExhausted, true);
  assert.strictEqual(report.observation.traversalBudgetExhausted, true);
});

// 26. Mutation bounds: caps addedNodes inspection and iframe load listeners, reporting missedEvidence
it('mutation bounds: caps addedNodes inspection and iframe load listeners, reporting missedEvidence', () => {
  const [SYNTHETIC] = [true];
  const { doc, win } = createSyntheticMockEnvironment();
  const post = new SyntheticMockElement('shreddit-post', { id: 't3_mutbounds' });
  const embed = new SyntheticMockElement('shreddit-embed');
  post.appendChild(embed);

  const session = runRedditInlineDiagnostic(embed, { window: win, document: doc, autoLog: false });

  // Simulate a mutation adding 20 nodes with iframes
  const addedNodes = [];
  for (let i = 0; i < 20; i++) {
    const d = new SyntheticMockElement('div');
    const f = new SyntheticMockElement('iframe', { src: `https://www.redgifs.com/ifr/clip${i}` });
    d.appendChild(f);
    addedNodes.push(d);
  }

  // Trigger childList mutation directly with 20 nodes
  embed._notifyMutation({
    type: 'childList',
    target: embed,
    addedNodes,
    removedNodes: []
  });

  const report = session.stop('BOUNDS_CHECK');
  const mutationEvt = report.observation.events.find((e) => e.type === 'dom_mutation' && e.kind === 'childList');
  assert.ok(mutationEvt);
  assert.strictEqual(mutationEvt.added.length, 5); // Bounded to 5
  assert.strictEqual(mutationEvt.capped, true);
  assert.strictEqual(mutationEvt.missedEvidence, true);
  assert.strictEqual(report.observation.missedEvidence, true);
});

// 27. Follow-up bounds: light and shadow child scans of embedHost are strictly capped at MAX_TRAVERSAL_NODES
it('follow-up bounds: inspectEmbedAndClip bounds light and shadow child scans of selected embed host', () => {
  const [SYNTHETIC] = [true];
  const post = new SyntheticMockElement('shreddit-post', {
    id: 't3_embedbounds',
    'content-href': 'https://www.redgifs.com/watch/boundedclip'
  });
  const embed = new SyntheticMockElement('shreddit-embed');
  post.appendChild(embed);

  const children = Array.from({ length: 10000 }, () => new SyntheticMockElement('div'));
  children[9999] = new SyntheticMockElement('iframe', { src: 'https://www.redgifs.com/ifr/boundedclip' });
  for (const child of children) child.parentElement = embed;

  let indexedReads = 0;
  embed.children = new Proxy({
    length: children.length,
    item(i) { return children[i] || null; }
  }, {
    get(target, key) {
      if (/^\d+$/.test(String(key))) {
        indexedReads++;
        return children[Number(key)];
      }
      return target[key];
    }
  });

  const res = inspectEmbedAndClip(embed, post);
  // Indexed reads must be bounded by owner scan (<=60) + light DOM scan (<=60) = <=120, far below 10,000
  assert.ok(indexedReads <= 120, `indexedReads (${indexedReads}) must not exceed bounded limits`);
  assert.strictEqual(res.embed.traversalBudgetExhausted, true);
  assert.strictEqual(res.embed.scanIncomplete, true);
  assert.strictEqual(res.embed.hasReachableIframe, false);
  assert.strictEqual(res.embed.reachability, 'inconclusive_budget_exhausted');
  assert.strictEqual(res.embed.absenceInconclusive, true);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n========================================`);
console.log(`Summary: ${passedTests}/${totalTests} tests passed (${failedTests} failed)`);
console.log(`========================================\n`);

if (failedTests > 0) {
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
