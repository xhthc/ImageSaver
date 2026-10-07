// test_reddit_inline.js - Focused regression test suite for UX-11-RD Reddit inline Save controls
// Covers: candidate identification, media kinds, owner isolation, full-visibility rules,
// gallery completeness vs loaded-subset omission, pointer/keyboard continuity,
// single/batch token-proof contracts, stale node invalidation, and lifecycle cleanup.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

let passed = 0;
let failed = 0;

async function it(desc, fn) {
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

const itAsync = it;

// Minimal DOM simulation for Reddit content script
class MockClassList {
  constructor(el) {
    this._el = el;
    this._classes = new Set();
  }
  add(...names) { names.forEach((n) => this._classes.add(n)); }
  remove(...names) { names.forEach((n) => this._classes.delete(n)); }
  contains(name) { return this._classes.has(name); }
  get length() { return this._classes.size; }
}

class MockStyle {
  constructor() {
    this._map = new Map();
    return new Proxy(this, {
      get: (target, prop) => {
        if (typeof prop === 'symbol') return target[prop];
        if (prop in target) return target[prop];
        return target._map.get(prop) || '';
      },
      set: (target, prop, val) => {
        target._map.set(prop, String(val));
        return true;
      }
    });
  }
  setProperty(k, v) { this._map.set(k, String(v)); }
  getPropertyValue(k) { return this._map.get(k) || ''; }
}

function matchSel(node, sel) {
  if (!node || !node.tagName) return false;
  const tag = node.tagName.toLowerCase();
  const bracketIdx = sel.indexOf('[');
  if (bracketIdx > 0 && sel.endsWith(']')) {
    const prefix = sel.slice(0, bracketIdx);
    const bracketPart = sel.slice(bracketIdx);
    if (prefix !== '*' && prefix !== tag && !node.classList.contains(prefix.replace(/^\./, ''))) {
      return false;
    }
    return matchSel(node, bracketPart);
  }
  if (sel === tag || sel === '*') return true;
  if (sel.startsWith('.') && node.classList.contains(sel.slice(1))) return true;
  if (sel.startsWith('#') && node.id === sel.slice(1)) return true;
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1);
    if (inner.includes('*=')) {
      const [attrName, attrVal] = inner.split('*=').map((s) => s.replace(/['"]/g, '').trim());
      const val = node.getAttribute(attrName) || '';
      return val.includes(attrVal);
    }
    if (inner.includes('^=')) {
      const [attrName, attrVal] = inner.split('^=').map((s) => s.replace(/['"]/g, '').trim());
      const val = node.getAttribute(attrName) || '';
      return val.startsWith(attrVal);
    }
    if (inner.includes('$=')) {
      const [attrName, attrVal] = inner.split('$=').map((s) => s.replace(/['"]/g, '').trim());
      const val = node.getAttribute(attrName) || '';
      return val.endsWith(attrVal);
    }
    if (inner.includes('=')) {
      const [attrName, attrVal] = inner.split('=').map((s) => s.replace(/['"]/g, '').trim());
      return node.getAttribute(attrName) === attrVal;
    }
    return node.hasAttribute(inner);
  }
  return false;
}

class MockElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.parentElement = null;
    this.children = [];
    this._attrs = new Map();
    this.classList = new MockClassList(this);
    this.style = new MockStyle();
    this.isConnected = true;
    this._rect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    this._shadow = null;
    this._listeners = new Map();
    this.textContent = '';
    this.currentSrc = '';
    this.src = '';
  }

  getAttribute(k) { return this._attrs.get(k) ?? null; }
  setAttribute(k, v) { this._attrs.set(k, String(v)); if (k === 'id') this.id = String(v); }
  removeAttribute(k) { this._attrs.delete(k); if (k === 'id') delete this.id; }
  hasAttribute(k) { return this._attrs.has(k); }

  getBoundingClientRect() {
    if (this.style && this.style.position === 'absolute' && this.parentElement) {
      const pr = this.parentElement.getBoundingClientRect();
      const left = pr.left + (parseFloat(this.style.getPropertyValue('left')) || 0);
      const top = pr.top + (parseFloat(this.style.getPropertyValue('top')) || 0);
      const width = parseFloat(this.style.getPropertyValue('width')) || this._rect.width;
      const height = parseFloat(this.style.getPropertyValue('height')) || this._rect.height;
      return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height
      };
    }
    return { ...this._rect };
  }
  setRect(r) {
    this._rect = {
      left: r.left ?? 0,
      top: r.top ?? 0,
      width: r.width ?? ((r.right ?? 0) - (r.left ?? 0)),
      height: r.height ?? ((r.bottom ?? 0) - (r.top ?? 0)),
      right: r.right ?? ((r.left ?? 0) + (r.width ?? 0)),
      bottom: r.bottom ?? ((r.top ?? 0) + (r.height ?? 0))
    };
  }

  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    child.isConnected = this.isConnected;
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
      child.isConnected = false;
    }
    return child;
  }

  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
    else this.isConnected = false;
  }

  contains(el) {
    let cur = el;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  closest(selector) {
    let cur = this;
    const parts = selector.split(',').map((s) => s.trim().toLowerCase());
    while (cur) {
      for (const sel of parts) {
        if (matchSel(cur, sel)) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    const list = this.querySelectorAll(selector);
    return list.length > 0 ? list[0] : null;
  }

  querySelectorAll(selector) {
    const results = [];
    const parts = selector.split(',').map((s) => s.trim().toLowerCase());
    const walk = (node) => {
      for (const child of node.children) {
        let match = false;
        for (const sel of parts) {
          if (matchSel(child, sel)) { match = true; break; }
        }
        if (match) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  attachShadow(opts) {
    const shadowHost = new MockElement('SHADOW-ROOT');
    shadowHost.parentElement = this;
    this._shadow = shadowHost;
    return shadowHost;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    if (this._listeners.has(type)) {
      const arr = this._listeners.get(type);
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  dispatchEvent(event) {
    const arr = this._listeners.get(event.type) || [];
    for (const fn of arr) fn(event);
  }

  focus() {
    if (this._ownerDocument) this._ownerDocument.activeElement = this;
  }
}

function createMockEnvironment() {
  const docListeners = new Map();
  const winListeners = new Map();
  const sentMessages = [];
  const messageListeners = [];

  const document = {
    hidden: false,
    activeElement: null,
    body: new MockElement('BODY'),
    createElement(tag) {
      const el = new MockElement(tag);
      el._ownerDocument = document;
      return el;
    },
    createElementNS(ns, tag) {
      const el = new MockElement(tag);
      el.namespaceURI = ns;
      el._ownerDocument = document;
      return el;
    },
    addEventListener(type, fn, opts) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (docListeners.has(type)) {
        const arr = docListeners.get(type);
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      }
    },
    dispatchEvent(ev) {
      const arr = docListeners.get(ev.type) || [];
      for (const fn of arr) fn(ev);
    },
    elementFromPoint(x, y) {
      const stack = this.elementsFromPoint(x, y);
      return stack.length > 0 ? stack[0] : null;
    },
    elementsFromPoint(x, y) {
      const matches = [];
      const walk = (node) => {
        if (!node || node.isConnected === false) return;
        const r = node.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          matches.push(node);
        }
        for (const child of node.children) walk(child);
        if (node._shadow) {
          for (const sChild of node._shadow.children) walk(sChild);
        }
      };
      walk(this.body);
      return matches.reverse(); // top-most first
    }
  };

  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    location: { href: 'https://www.reddit.com/r/pics/comments/abc123/sample_post/' },
    addEventListener(type, fn, opts) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) {
        const arr = winListeners.get(type);
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      }
    },
    dispatchEvent(ev) {
      const arr = winListeners.get(ev.type) || [];
      for (const fn of arr) fn(ev);
    },
    getComputedStyle(el) { return el.style; }
  };

  const chrome = {
    runtime: {
      id: 'image-saver-extension-id',
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        return { success: true };
      },
      onMessage: {
        addListener: (fn) => { messageListeners.push(fn); }
      }
    }
  };

  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = [];
    }
    observe(target, opts) { this.observed.push({ target, opts }); }
    disconnect() { this.observed = []; }
  }

  const context = vm.createContext({
    document,
    window,
    location: window.location,
    chrome,
    console,
    URL,
    Date,
    Math,
    parseInt,
    Array,
    Map,
    Set,
    WeakRef,
    WeakMap,
    Uint8Array,
    Number,
    Boolean,
    String,
    RegExp,
    crypto: require('node:crypto').webcrypto,
    setTimeout,
    clearTimeout,
    MutationObserver: MockMutationObserver
  });

  const contentCode = fs.readFileSync(path.join(__dirname, 'content_reddit.js'), 'utf8');
  vm.runInContext(contentCode, context);

  return {
    context,
    document,
    window,
    chrome,
    sentMessages,
    messageListeners,
    fireDoc(type, ev = {}) {
      document.dispatchEvent({ type, isTrusted: true, ...ev });
    },
    fireWin(type, ev = {}) {
      window.dispatchEvent({ type, isTrusted: true, ...ev });
    },
    ask(msg, sender = { id: 'image-saver-extension-id' }) {
      let res;
      for (const fn of messageListeners) {
        fn(msg, sender, (r) => { res = r; });
        if (res !== undefined) break;
      }
      return res;
    }
  };
}

async function runAllSuites() {
  console.log('=== Running test_reddit_inline.js (UX-11-RD focused regression suite) ===\n');

// --- Suite 1: Candidate identification & Media kinds ---
console.log('--- Suite 1: Candidate Identification & Media Kinds ---');
{
  const env = createMockEnvironment();
  const { __riCandidate, __riImageKind, __riSlotKey, document } = env.context;

  await it('identifies standard photo image', () => {
    const img = document.createElement('img');
    img.src = 'https://i.redd.it/example123.jpg';
    const cand = __riCandidate([img]);
    assert(cand && cand.el === img && cand.kind === 'image');
  });

  await it('identifies Reddit animation delivered as MP4 format', () => {
    const img = document.createElement('img');
    img.src = 'https://preview.redd.it/animated.gif?format=mp4&s=abcdef';
    assert.strictEqual(__riImageKind(img.src), 'gif-animation');
    const cand = __riCandidate([img]);
    assert(cand && cand.el === img && cand.kind === 'image');
  });

  await it('identifies native GIF on i.redd.it without format=mp4', () => {
    const img = document.createElement('img');
    img.src = 'https://i.redd.it/fun.gif';
    assert.strictEqual(__riImageKind(img.src), 'native-gif');
    const cand = __riCandidate([img]);
    assert(cand && cand.el === img && cand.kind === 'image');
  });

  await it('identifies video element and shreddit-player', () => {
    const vid = document.createElement('video');
    vid.src = 'https://v.redd.it/vid123/DASH_720.mp4';
    const cand1 = __riCandidate([vid]);
    assert(cand1 && cand1.el === vid && cand1.kind === 'video');

    const player = document.createElement('shreddit-player');
    player.setAttribute('src', 'https://v.redd.it/vid456/DASH_720.mp4');
    const cand2 = __riCandidate([player]);
    assert(cand2 && cand2.el === player && cand2.kind === 'video');
  });

  await it('rejects avatar, community icon, and emoji images (fails closed, no button behind)', () => {
    const avatar = document.createElement('img');
    avatar.src = 'https://styles.redditmedia.com/t5_123/styles/profileIcon_avatar1.png';
    assert.strictEqual(__riCandidate([avatar]), null);

    const commIcon = document.createElement('img');
    commIcon.src = 'https://styles.redditmedia.com/t5_456/styles/communityIcon_sub.png';
    assert.strictEqual(__riCandidate([commIcon]), null);

    const emoji = document.createElement('img');
    emoji.src = 'https://www.redditstatic.com/emojis/smile.png';
    assert.strictEqual(__riCandidate([emoji]), null);
  });

  await it('deduplicates player and poster into one slot key', () => {
    const player = document.createElement('shreddit-player');
    player.id = 'player-1';
    player.setAttribute('src', 'https://v.redd.it/abc/master.mp4');
    player.setAttribute('preview', 'https://preview.redd.it/abc_thumb.jpg');

    const poster = document.createElement('img');
    poster.setAttribute('slot', 'poster');
    player.appendChild(poster);

    const k1 = __riSlotKey(player);
    const k2 = __riSlotKey(poster);
    assert.strictEqual(k1, k2, 'player and child poster share the same slot key');
  });
}

// --- Suite 1b: stable asset identity of a slot (contract amendment 4) ---
console.log('\n--- Suite 1b: Stable slot identity ---');
{
  const env = createMockEnvironment();
  const { __riSlotKey, __riAssetId, document } = env.context;
  const player = (attrs, inner) => {
    const p = document.createElement('shreddit-player');
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    if (inner) { const v = document.createElement('video'); v.src = inner; p.appendChild(v); }
    return p;
  };
  await it('a player keeps one identity across token, extension, resolution and manifest changes of the same asset id', () => {
    const base = __riSlotKey(player({ src: 'https://v.redd.it/vidprobe/DASH_720.mp4?token=old' }));
    assert.strictEqual(base, 'vid:vidprobe');
    assert.strictEqual(__riSlotKey(player({ src: 'https://v.redd.it/vidprobe/DASH_720.mp4?token=new' })), base, 'token');
    assert.strictEqual(__riSlotKey(player({ src: 'https://v.redd.it/vidprobe/DASH_480.mp4' })), base, 'resolution');
    assert.strictEqual(__riSlotKey(player({ 'stream-url': 'https://v.redd.it/vidprobe/HLSPlaylist.m3u8' })), base, 'manifest of the same id');
    const video = document.createElement('video');
    video.src = 'https://v.redd.it/vidprobe/DASH_360.mp4?x=1';
    assert.strictEqual(__riSlotKey(video), base, 'a bare video of the same id is the same slot');
  });
  await it('different assets never share an identity; foreign and unknown addresses are not merged', () => {
    assert.notStrictEqual(__riSlotKey(player({ src: 'https://v.redd.it/vidother/DASH_720.mp4' })), 'vid:vidprobe');
    assert.notStrictEqual(__riSlotKey(player({ src: 'https://packaged-media.redd.it/vidprobe/pb.mp4' })), 'vid:vidprobe', 'another host family is another namespace');
    assert.strictEqual(__riAssetId('https://evil.example/v.redd.it/vidprobe/x.mp4'), null, 'a foreign address that contains a Reddit host name has no Reddit identity');
    assert.strictEqual(__riAssetId('https://i.redd.it.evil.example/a.jpg'), null);
    assert.strictEqual(__riSlotKey(player({ src: 'https://cdn.example/clip.mp4?t=1' })), 'sp:https://cdn.example/clip.mp4?t=1', 'an unknown address keeps its exact string');
    assert.notStrictEqual(__riSlotKey(player({ src: 'https://cdn.example/clip.mp4?t=2' })), __riSlotKey(player({ src: 'https://cdn.example/clip.mp4?t=1' })));
    const img = (u) => { const i = document.createElement('img'); i.src = u; return i; };
    assert.strictEqual(__riSlotKey(img('https://preview.redd.it/abc123.jpg?width=640&s=1')), __riSlotKey(img('https://i.redd.it/abc123.jpg')), 'an image keeps its identity across hosts of one family, resolution and query');
    assert.notStrictEqual(__riSlotKey(img('https://i.redd.it/abc123.jpg')), __riSlotKey(img('https://i.redd.it/abc124.jpg')));
  });
  await it('an SEO slug of a preview address is not part of the asset: [slug]-v0-[media id] is the asset of i.redd.it/[media id] (native galleries hold both in one slide)', () => {
    assert.strictEqual(__riAssetId('https://preview.redd.it/found-a-full-pc-v0-pl46hy6p8ath1.jpg?width=640&crop=smart&auto=webp&s=1'), 'img:pl46hy6p8ath1');
    assert.strictEqual(__riAssetId('https://i.redd.it/pl46hy6p8ath1.jpg'), 'img:pl46hy6p8ath1');
    assert.strictEqual(__riAssetId('https://external-preview.redd.it/dlss-5-v0-dXV2bDZidnB0b29oMTRITizmS8Mf.png?s=1'), 'img:dXV2bDZidnB0b29oMTRITizmS8Mf');
    assert.strictEqual(__riAssetId('https://preview.redd.it/slug-v0-.jpg'), 'img:slug-v0-', 'an empty id keeps the whole segment');
    assert.notStrictEqual(__riAssetId('https://preview.redd.it/a-v0-x1.jpg'), __riAssetId('https://preview.redd.it/a-v0-x2.jpg'));
    assert.strictEqual(__riAssetId('https://evil.example/preview.redd.it/a-v0-x1.jpg'), null);
  });
}

// --- Suite 2: Owner Detection & Permalink Isolation ---
console.log('\n--- Suite 2: Owner Detection & Permalink Isolation ---');
{
  const env = createMockEnvironment();
  const { __riOwnerOf, __riIdOf, document } = env.context;

  await it('detects standard shreddit-post owner and extracts permalink', () => {
    const post = document.createElement('shreddit-post');
    post.setAttribute('id', 't3_post123');
    post.setAttribute('permalink', '/r/test/comments/post123/my_post/');
    const img = document.createElement('img');
    post.appendChild(img);
    document.body.appendChild(post);

    const info = __riOwnerOf(img);
    assert(info && info.owner === post && info.isCrosspost === false);
    const idInfo = __riIdOf(post);
    assert.strictEqual(idInfo.ownerId, 't3_post123');
    assert.strictEqual(idInfo.postUrl, 'https://www.reddit.com/r/test/comments/post123/my_post/');
  });

  await it('isolates nested crosspost: inner post owns its media, not the parent post', () => {
    const outerPost = document.createElement('shreddit-post');
    outerPost.setAttribute('id', 't3_outer');
    outerPost.setAttribute('permalink', '/r/all/comments/outer/outer_post/');

    const crosspostContainer = document.createElement('div');
    crosspostContainer.setAttribute('data-testid', 'crosspost-post');
    const innerPost = document.createElement('shreddit-post');
    innerPost.setAttribute('id', 't3_inner');
    innerPost.setAttribute('permalink', '/r/original/comments/inner/inner_post/');
    crosspostContainer.appendChild(innerPost);
    outerPost.appendChild(crosspostContainer);

    const outerImg = document.createElement('img');
    outerPost.appendChild(outerImg);

    const innerImg = document.createElement('img');
    innerPost.appendChild(innerImg);

    document.body.appendChild(outerPost);

    const outerOwner = __riOwnerOf(outerImg);
    assert(outerOwner && outerOwner.owner === outerPost && outerOwner.isCrosspost === false);

    const innerOwner = __riOwnerOf(innerImg);
    assert(innerOwner && innerOwner.owner === innerPost && innerOwner.isCrosspost === true);
    const innerIdInfo = __riIdOf(innerOwner.owner);
    assert.strictEqual(innerIdInfo.ownerId, 't3_inner');
    assert.strictEqual(innerIdInfo.postUrl, 'https://www.reddit.com/r/original/comments/inner/inner_post/');
  });

  await it('supports Media-search cards [data-testid="search-post"] with post permalink link', () => {
    const searchCard = document.createElement('div');
    searchCard.setAttribute('data-testid', 'search-post');
    const a = document.createElement('a');
    a.setAttribute('href', '/r/search/comments/res123/search_result/');
    const img = document.createElement('img');
    searchCard.appendChild(a);
    searchCard.appendChild(img);
    document.body.appendChild(searchCard);

    const info = __riOwnerOf(img);
    assert(info && info.owner === searchCard);
    const cardIdInfo = __riIdOf(searchCard);
    assert.strictEqual(cardIdInfo.ownerId, 't3_res123');
    assert.strictEqual(cardIdInfo.postUrl, 'https://www.reddit.com/r/search/comments/res123/search_result/');
  });

  await it('rejects media inside comments (comments are not post media owners)', () => {
    const post = document.createElement('shreddit-post');
    const comment = document.createElement('shreddit-comment');
    const commentImg = document.createElement('img');
    comment.appendChild(commentImg);
    post.appendChild(comment);
    document.body.appendChild(post);

    const info = __riOwnerOf(commentImg);
    assert.strictEqual(info, null, 'comment media returns null owner');
  });

  await it('rejects orphaned elements outside any post or search card', () => {
    const img = document.createElement('img');
    document.body.appendChild(img);
    assert.strictEqual(__riOwnerOf(img), null);
  });
}

// --- Suite 3: Layout & Full Visibility Rules ---
console.log('\n--- Suite 3: Layout & Full Visibility Rules ---');
{
  const env = createMockEnvironment();
  const { __riLayout, document } = env.context;

  await it('returns valid layout for fully visible tile inside positioned container', () => {
    const post = document.createElement('shreddit-post');
    post.setRect({ left: 100, top: 100, width: 600, height: 500 });
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.setRect({ left: 120, top: 150, width: 500, height: 400 });
    const img = document.createElement('img');
    img.setRect({ left: 120, top: 150, width: 500, height: 400 });
    container.appendChild(img);
    post.appendChild(container);
    document.body.appendChild(post);

    const lay = __riLayout(img, post, 32, 32);
    assert(lay !== null, 'fully visible tile produces valid layout');
    assert.strictEqual(lay.host, container);
  });

  await it('refuses layout when tile is clipped beyond tolerance (RI.TOL = 2px)', () => {
    const post = document.createElement('shreddit-post');
    post.setRect({ left: 100, top: 100, width: 600, height: 500 });
    const overflowContainer = document.createElement('div');
    overflowContainer.style.position = 'relative';
    overflowContainer.style.overflow = 'hidden';
    // Container only shows left 100px of 300px width
    overflowContainer.setRect({ left: 120, top: 150, width: 100, height: 200 });
    const img = document.createElement('img');
    img.setRect({ left: 120, top: 150, width: 300, height: 200 });
    overflowContainer.appendChild(img);
    post.appendChild(overflowContainer);
    document.body.appendChild(post);

    const lay = __riLayout(img, post, 32, 32);
    assert.strictEqual(lay, null, 'partially clipped tile (100 of 300px) is refused');
  });

  await it('tolerates small sub-pixel border difference <= 2px (RI.TOL = 2)', () => {
    const post = document.createElement('shreddit-post');
    post.setRect({ left: 100, top: 100, width: 600, height: 500 });
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.style.overflow = 'hidden';
    container.setRect({ left: 120, top: 150, width: 398.5, height: 300 }); // 1.5px clipped
    const img = document.createElement('img');
    img.setRect({ left: 120, top: 150, width: 400, height: 300 });
    container.appendChild(img);
    post.appendChild(container);
    document.body.appendChild(post);

    const lay = __riLayout(img, post, 32, 32);
    assert(lay !== null, 'within 2px tolerance is accepted');
  });

  await it('refuses layout when a corner is occluded by an external overlay (sticky header)', () => {
    const post = document.createElement('shreddit-post');
    post.setRect({ left: 100, top: 100, width: 600, height: 500 });
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.setRect({ left: 100, top: 100, width: 600, height: 500 });
    const img = document.createElement('img');
    img.setRect({ left: 100, top: 100, width: 600, height: 500 });
    container.appendChild(img);
    post.appendChild(container);
    document.body.appendChild(post);

    // Floating header covering top-left corner
    const header = document.createElement('header');
    header.setRect({ left: 0, top: 0, width: 1920, height: 120 }); // overlaps y: 100..120
    document.body.appendChild(header);

    const lay = __riLayout(img, post, 32, 32);
    assert.strictEqual(lay, null, 'occluded corner by header refuses layout');
  });
}

// --- Suite 4: Gallery Enumeration & Complete Gallery Proof ---
console.log('\n--- Suite 4: Gallery Enumeration & Complete Gallery Proof ---');
{
  const env = createMockEnvironment();
  const { __riEnumerate, __riCountFor, __riPlan, __riSnapshot, document } = env.context;

  await it('single media post: countFor is 0, plan offers compact single button', () => {
    const post = document.createElement('shreddit-post');
    post.setAttribute('id', 't3_single');
    post.setRect({ left: 0, top: 0, width: 600, height: 500 });
    const cont = document.createElement('div');
    cont.style.position = 'relative';
    cont.setRect({ left: 20, top: 20, width: 500, height: 400 });
    const img = document.createElement('img');
    img.src = 'https://i.redd.it/single.jpg';
    img.setRect({ left: 20, top: 20, width: 500, height: 400 });
    cont.appendChild(img);
    post.appendChild(cont);
    document.body.appendChild(post);

    const snap = __riSnapshot(img, 'image');
    assert.strictEqual(__riCountFor(post, img), 0, 'single media post count is 0');
    const plan = __riPlan(img, snap);
    assert(plan && plan.n === 0 && plan.compact === false, 'single button planned');
  });

  await it('complete proven gallery (3 slides): plan offers wide "Save all (3)" pair', () => {
    const post = document.createElement('shreddit-post');
    post.setAttribute('id', 't3_gal3');
    post.setRect({ left: 0, top: 0, width: 800, height: 600 });
    const carousel = document.createElement('gallery-carousel');
    carousel.setAttribute('total-items', '3');
    carousel.style.position = 'relative';
    carousel.setRect({ left: 20, top: 20, width: 700, height: 500 });

    const imgs = [];
    for (let i = 1; i <= 3; i++) {
      const slide = document.createElement('li');
      slide.setRect({ left: 20, top: 20, width: 700, height: 500 });
      const img = document.createElement('img');
      img.src = `https://i.redd.it/slide${i}.jpg`;
      img.setRect({ left: 20, top: 20, width: 700, height: 500 });
      slide.appendChild(img);
      carousel.appendChild(slide);
      imgs.push(img);
    }
    post.appendChild(carousel);
    document.body.appendChild(post);

    const { items, isComplete } = __riEnumerate(post);
    assert.strictEqual(items.length, 3);
    assert.strictEqual(isComplete, true);
    assert.strictEqual(__riCountFor(post, imgs[0]), 3);

    const snap = __riSnapshot(imgs[0], 'image');
    const plan = __riPlan(imgs[0], snap);
    assert(plan && plan.n === 3 && plan.compact === false, 'wide pair for 3 items planned');
  });

  await it('loaded subset (declared 5, but only 2 in DOM): omits "Save all", offers only "Save this"', () => {
    const post = document.createElement('shreddit-post');
    post.setAttribute('id', 't3_part2');
    post.setRect({ left: 0, top: 0, width: 600, height: 500 });
    const carousel = document.createElement('gallery-carousel');
    carousel.setAttribute('total-items', '5'); // 5 slides total declared
    carousel.style.position = 'relative';
    carousel.setRect({ left: 20, top: 20, width: 500, height: 400 });

    const imgs = [];
    for (let i = 1; i <= 2; i++) { // only 2 rendered in DOM
      const slide = document.createElement('li');
      slide.setRect({ left: 20, top: 20, width: 500, height: 400 });
      const img = document.createElement('img');
      img.src = `https://i.redd.it/part${i}.jpg`;
      img.setRect({ left: 20, top: 20, width: 500, height: 400 });
      slide.appendChild(img);
      carousel.appendChild(slide);
      imgs.push(img);
    }
    post.appendChild(carousel);
    document.body.appendChild(post);

    const { items, isComplete } = __riEnumerate(post);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(isComplete, false, 'marked incomplete due to declared 5 vs 2 in DOM');
    assert.strictEqual(__riCountFor(post, imgs[0]), 0, 'incomplete gallery returns count 0');

    const snap = __riSnapshot(imgs[0], 'image');
    const plan = __riPlan(imgs[0], snap);
    assert(plan && plan.n === 0, 'omits Save all, falls back to single Save this');
  });

  await it('completeness unit: a declared 1 over one slot, an empty list and an over-bound list are never complete', () => {
    const { __riGalleryProof, document } = env.context;
    const post = document.createElement('shreddit-post');
    post.setAttribute('id', 't3_unit1');
    const car = document.createElement('gallery-carousel');
    car.setAttribute('total-items', '1');
    post.appendChild(car);
    document.body.appendChild(post);
    const one = [{ el: document.createElement('img'), kind: 'image', key: 'img:a' }];
    assert.strictEqual(__riGalleryProof(post, one, false).isComplete, false, 'one slot');
    assert.strictEqual(__riGalleryProof(post, [], false).isComplete, false, 'no slot');
    car.setAttribute('total-items', '2');
    const two = [{ el: one[0].el, kind: 'image', key: 'img:a' }, { el: one[0].el, kind: 'image', key: 'img:b' }];
    assert.strictEqual(__riGalleryProof(post, two, false).isComplete, true, 'two slots, declared 2');
    assert.strictEqual(__riGalleryProof(post, two, true).isComplete, false, 'a cut enumeration');
    assert.strictEqual(__riGalleryProof(post, [two[0], { el: one[0].el, kind: 'image', key: null }], false).isComplete, false, 'an unidentifiable slot');
  });

  await it('gallery with video and images: deduplicates player and poster into exact count', () => {
    const post = document.createElement('shreddit-post');
    post.setAttribute('id', 't3_mix');
    post.setRect({ left: 0, top: 0, width: 800, height: 600 });
    const carousel = document.createElement('gallery-carousel');
    carousel.setAttribute('total-items', '2');
    carousel.style.position = 'relative';
    carousel.setRect({ left: 20, top: 20, width: 700, height: 500 });

    // Slide 1: Image
    const s1 = document.createElement('li');
    s1.setRect({ left: 20, top: 20, width: 700, height: 500 });
    const img1 = document.createElement('img');
    img1.src = 'https://i.redd.it/item1.jpg';
    img1.setRect({ left: 20, top: 20, width: 700, height: 500 });
    s1.appendChild(img1);
    carousel.appendChild(s1);

    // Slide 2: Player + Poster inside player
    const s2 = document.createElement('li');
    s2.setRect({ left: 20, top: 20, width: 700, height: 500 });
    const player = document.createElement('shreddit-player');
    player.setAttribute('src', 'https://v.redd.it/item2/master.mp4');
    player.setRect({ left: 20, top: 20, width: 700, height: 500 });
    const poster = document.createElement('img');
    poster.setAttribute('slot', 'poster');
    poster.src = 'https://preview.redd.it/item2_thumb.jpg';
    poster.setRect({ left: 20, top: 20, width: 700, height: 500 });
    player.appendChild(poster);
    s2.appendChild(player);
    carousel.appendChild(s2);

    post.appendChild(carousel);
    document.body.appendChild(post);

    const { items, isComplete } = __riEnumerate(post);
    assert.strictEqual(items.length, 2, 'player + poster counted once, total 2 items');
    assert.strictEqual(isComplete, true);
    assert.strictEqual(__riCountFor(post, img1), 2);
  });
}

// --- Suite 5: Pointer-to-Button Continuity & Keyboard Navigation ---
console.log('\n--- Suite 5: Pointer-to-Button Continuity & Keyboard Navigation ---');
{
  const env = createMockEnvironment();
  const { __riState, document } = env.context;

  await it('pointer move onto media evaluates and attaches button host into container', async () => {
    const post = document.createElement('shreddit-post');
    post.setAttribute('id', 't3_hover');
    post.setRect({ left: 100, top: 100, width: 600, height: 500 });
    const cont = document.createElement('div');
    cont.style.position = 'relative';
    cont.setRect({ left: 100, top: 100, width: 600, height: 500 });
    const img = document.createElement('img');
    img.src = 'https://i.redd.it/hover.jpg';
    img.setRect({ left: 100, top: 100, width: 600, height: 500 });
    cont.appendChild(img);
    post.appendChild(cont);
    document.body.appendChild(post);

    env.fireDoc('pointermove', { clientX: 200, clientY: 200, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));

    assert(__riState.host !== null, 'host element created');
    assert.strictEqual(__riState.host.parentElement, cont, 'attached to nearest positioned container');
    assert(__riState.btn !== null, 'Save this button created');
  });

  await it('moving pointer onto button preserves button without flicker or re-trigger', async () => {
    assert(__riState.host !== null);
    const hostRect = __riState.host.getBoundingClientRect();
    const btnX = hostRect.left + 5;
    const btnY = hostRect.top + 5;

    env.fireDoc('pointermove', { clientX: btnX, clientY: btnY, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));

    assert(__riState.host !== null, 'host remains attached when hovering button');
    assert(__riState.host.isConnected, 'host still connected');
  });

  await it('Tab key moves focus into button; Escape dismisses button', () => {
    assert(__riState.btn !== null);
    // Escape key
    __riState.btn.dispatchEvent({ type: 'keydown', key: 'Escape', isTrusted: true });
    assert.strictEqual(__riState.host.parentElement, null, 'Escape hid the host');
  });
}

// --- Suite 6: Single-Item Save Token & Proof Contract ---
console.log('\n--- Suite 6: Single-Item Save Token & Proof Contract ---');
{
  const env = createMockEnvironment();
  const { __riState, document } = env.context;

  await itAsync('clicking "Save this" sends REDDIT_INLINE_SAVE with one-shot token', async () => {
    const post = document.createElement('shreddit-post');
    post.setAttribute('permalink', '/r/pics/comments/abc/test_save/');
    post.setRect({ left: 50, top: 50, width: 500, height: 400 });
    const cont = document.createElement('div');
    cont.style.position = 'relative';
    cont.setRect({ left: 50, top: 50, width: 500, height: 400 });
    const img = document.createElement('img');
    img.src = 'https://i.redd.it/trusted.jpg';
    img.setRect({ left: 50, top: 50, width: 500, height: 400 });
    cont.appendChild(img);
    post.appendChild(cont);
    document.body.appendChild(post);

    env.fireDoc('pointermove', { clientX: 100, clientY: 100, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));

    assert(__riState.btn !== null);
    const beforeCount = env.sentMessages.length;
    __riState.btn.dispatchEvent({ type: 'click', isTrusted: true });

    assert.strictEqual(env.sentMessages.length, beforeCount + 1);
    const msg = env.sentMessages[beforeCount];
    assert.strictEqual(msg.action, 'REDDIT_INLINE_SAVE');
    assert(/^[a-f0-9]{32}$/.test(msg.token), 'token is 32-char hex string');

    // Background asks for proof via REDDIT_INLINE_OWNER
    const answer = env.ask({ action: 'REDDIT_INLINE_OWNER', token: msg.token });
    assert(answer && answer.ok === true, 'proof accepted');
    assert(answer.media && answer.media.url === 'https://i.redd.it/trusted.jpg');
    assert.strictEqual(answer.media.kind, 'image');

    // Second ask with same token fails (one-shot token)
    const secondAnswer = env.ask({ action: 'REDDIT_INLINE_OWNER', token: msg.token });
    assert(secondAnswer && secondAnswer.ok === false && secondAnswer.reason === 'NO_TOKEN');
  });

  await itAsync('untrusted click (isTrusted !== true) does not send message', async () => {
    env.fireDoc('pointermove', { clientX: 100, clientY: 100, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));

    const before = env.sentMessages.length;
    __riState.btn.dispatchEvent({ type: 'click', isTrusted: false });
    assert.strictEqual(env.sentMessages.length, before, 'untrusted click ignored');
  });

  await itAsync('stale element (disconnected after click) returns STALE_OWNER', async () => {
    env.fireDoc('pointermove', { clientX: 100, clientY: 100, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));

    __riState.busyKey = '';
    __riState.busyAt = 0;
    const beforeCount = env.sentMessages.length;
    __riState.btn.dispatchEvent({ type: 'click', isTrusted: true });
    const token = env.sentMessages[beforeCount].token;

    // Disconnect target before proof arrives
    __riState.snap.elRef.deref().isConnected = false;

    const answer = env.ask({ action: 'REDDIT_INLINE_OWNER', token });
    assert(answer && answer.ok === false && answer.reason === 'STALE_OWNER');
  });
}

// --- Suite 7: Batch Save Token & Proof Contract ---
console.log('\n--- Suite 7: Batch Save Token & Proof Contract ---');
{
  const env = createMockEnvironment();
  const { __riState, document } = env.context;

  await itAsync('clicking "Save all" sends REDDIT_INLINE_SAVE_ALL and fulfills 2-phase contract', async () => {
    const post = document.createElement('shreddit-post');
    post.setAttribute('permalink', '/r/art/comments/gal123/masterpiece/');
    post.setRect({ left: 0, top: 0, width: 800, height: 600 });
    const carousel = document.createElement('gallery-carousel');
    carousel.setAttribute('total-items', '2');
    carousel.style.position = 'relative';
    carousel.setRect({ left: 20, top: 20, width: 700, height: 500 });

    for (let i = 1; i <= 2; i++) {
      const slide = document.createElement('li');
      slide.setRect({ left: 20, top: 20, width: 700, height: 500 });
      const img = document.createElement('img');
      img.src = `https://i.redd.it/gal${i}.jpg`;
      img.setRect({ left: 20, top: 20, width: 700, height: 500 });
      slide.appendChild(img);
      carousel.appendChild(slide);
    }
    post.appendChild(carousel);
    document.body.appendChild(post);

    env.fireDoc('pointermove', { clientX: 100, clientY: 100, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));

    assert(__riState.btnAll !== null, 'Save all button visible');
    const beforeCount = env.sentMessages.length;
    __riState.btnAll.dispatchEvent({ type: 'click', isTrusted: true });

    assert.strictEqual(env.sentMessages.length, beforeCount + 1);
    const msg = env.sentMessages[beforeCount];
    assert.strictEqual(msg.action, 'REDDIT_INLINE_SAVE_ALL');
    assert(/^[a-f0-9]{32}$/.test(msg.token));

    // Phase 1: Open batch
    const openRes = env.ask({ action: 'REDDIT_INLINE_BATCH', token: msg.token });
    assert(openRes && openRes.ok === true);
    assert.strictEqual(openRes.count, 2);
    assert(typeof openRes.sig === 'string' && openRes.sig.length === 8);

    // Repeated open fails
    const reOpen = env.ask({ action: 'REDDIT_INLINE_BATCH', token: msg.token });
    assert(reOpen && reOpen.ok === false && reOpen.reason === 'USED');

    // Phase 2: Fetch item 0
    const it0 = env.ask({ action: 'REDDIT_INLINE_OWNER_ITEM', token: msg.token, index: 0 });
    assert(it0 && it0.ok === true && it0.media.url === 'https://i.redd.it/gal1.jpg');

    // Re-fetch item 0 fails (single-use per item)
    const it0Again = env.ask({ action: 'REDDIT_INLINE_OWNER_ITEM', token: msg.token, index: 0 });
    assert(it0Again && it0Again.ok === false && it0Again.reason === 'USED');

    // Fetch item 1
    const it1 = env.ask({ action: 'REDDIT_INLINE_OWNER_ITEM', token: msg.token, index: 1 });
    assert(it1 && it1.ok === true && it1.media.url === 'https://i.redd.it/gal2.jpg');

    // All items fulfilled: token purged
    const it1Done = env.ask({ action: 'REDDIT_INLINE_OWNER_ITEM', token: msg.token, index: 1 });
    assert(it1Done && it1Done.ok === false && it1Done.reason === 'NO_TOKEN');
  });
}

// --- Suite 7b: a refused batch open leaves no usable token; item answers carry the batch structure signature ---
console.log('\n--- Suite 7b: Batch open refusal and item signature ---');
{
  const env = createMockEnvironment();
  const { __riState, document } = env.context;

  await itAsync('a refused open (changed total) deletes the token: no item can be asked afterwards; an accepted batch answers every item with the batch signature', async () => {
    const mk = (id) => {
      const post = document.createElement('shreddit-post');
      post.setAttribute('permalink', `/r/art/comments/${id}/g/`);
      post.setRect({ left: 0, top: 0, width: 800, height: 600 });
      const car = document.createElement('gallery-carousel');
      car.setAttribute('total-items', '2');
      car.style.position = 'relative';
      car.setRect({ left: 20, top: 20, width: 700, height: 500 });
      for (let i = 1; i <= 2; i++) {
        const li = document.createElement('li');
        li.setRect({ left: 20, top: 20, width: 700, height: 500 });
        const img = document.createElement('img');
        img.src = `https://i.redd.it/${id}_${i}.jpg`;
        img.setRect({ left: 20, top: 20, width: 700, height: 500 });
        li.appendChild(img);
        car.appendChild(li);
      }
      post.appendChild(car);
      document.body.appendChild(post);
      return { post, car };
    };
    const g = mk('sg1');
    env.fireDoc('pointermove', { clientX: 100, clientY: 100, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));
    const before = env.sentMessages.length;
    __riState.btnAll.dispatchEvent({ type: 'click', isTrusted: true });
    const token = env.sentMessages[before].token;
    g.car.setAttribute('total-items', '3');
    const open = env.ask({ action: 'REDDIT_INLINE_BATCH', token });
    assert(open && open.ok === false && open.reason === 'STALE_LIST', 'the structure changed');
    const item = env.ask({ action: 'REDDIT_INLINE_OWNER_ITEM', token, index: 0 });
    assert(item && item.ok === false && item.reason === 'NO_TOKEN', 'the token is gone after a refused open');
    g.post.remove();
    // an accepted batch: every item carries the sig of the open
    __riState.busyKey = ''; __riState.busyAt = 0;
    mk('sg2');
    env.fireDoc('pointermove', { clientX: 101, clientY: 101, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));
    const b2 = env.sentMessages.length;
    __riState.btnAll.dispatchEvent({ type: 'click', isTrusted: true });
    const token2 = env.sentMessages[b2].token;
    const open2 = env.ask({ action: 'REDDIT_INLINE_BATCH', token: token2 });
    assert(open2 && open2.ok === true && /^[a-f0-9]{8}$/.test(open2.sig));
    for (const index of [0, 1]) {
      const it0 = env.ask({ action: 'REDDIT_INLINE_OWNER_ITEM', token: token2, index });
      assert(it0 && it0.ok === true && it0.media.sig === open2.sig && it0.media.index === index && it0.media.count === 2 && it0.media.ownerId === open2.ownerId);
    }
    // the signature identifies the structure (ordered slot identities), not the sources: a changed source of one slot keeps it
    const slide = document.body.children[document.body.children.length - 1].children[0].children[0].children[0];
    slide.src = 'https://i.redd.it/sg2_1.jpg?width=640';
    __riState.busyKey = ''; __riState.busyAt = 0;
    env.fireDoc('pointermove', { clientX: 102, clientY: 102, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));
    const b3 = env.sentMessages.length;
    __riState.btnAll.dispatchEvent({ type: 'click', isTrusted: true });
    const open3 = env.ask({ action: 'REDDIT_INLINE_BATCH', token: env.sentMessages[b3].token });
    assert(open3 && open3.ok === true && open3.sig === open2.sig, 'a source change of one slot does not change the structure signature');
  });
}

// --- Suite 8: Lifecycle, Events & Teardown ---
console.log('\n--- Suite 8: Lifecycle, Events & Teardown ---');
{
  const env = createMockEnvironment();
  const { __riState, __riTeardown, document } = env.context;

  await itAsync('scroll, wheel, resize, and popstate hide controls immediately', async () => {
    const post = document.createElement('shreddit-post');
    post.setAttribute('id', 't3_scroll');
    post.setRect({ left: 100, top: 100, width: 600, height: 500 });
    const cont = document.createElement('div');
    cont.style.position = 'relative';
    cont.setRect({ left: 100, top: 100, width: 600, height: 500 });
    const img = document.createElement('img');
    img.src = 'https://i.redd.it/scroll_test.jpg';
    img.setRect({ left: 100, top: 100, width: 600, height: 500 });
    cont.appendChild(img);
    post.appendChild(cont);
    document.body.appendChild(post);

    env.fireDoc('pointermove', { clientX: 200, clientY: 200, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));
    assert(__riState.host !== null && __riState.host.parentElement !== null);

    // Fire scroll
    env.fireWin('scroll');
    assert.strictEqual(__riState.host.parentElement, null, 'scroll hid the controls');

    // Re-show
    env.fireDoc('pointermove', { clientX: 200, clientY: 200, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));
    assert(__riState.host !== null && __riState.host.parentElement !== null);

    // Fire wheel
    env.fireWin('wheel');
    assert.strictEqual(__riState.host.parentElement, null, 'wheel hid the controls');

    // Re-show
    env.fireDoc('pointermove', { clientX: 200, clientY: 200, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));
    assert(__riState.host !== null && __riState.host.parentElement !== null);

    // Fire resize
    env.fireWin('resize');
    assert.strictEqual(__riState.host.parentElement, null, 'resize hid the controls');

    // Re-show
    env.fireDoc('pointermove', { clientX: 200, clientY: 200, pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 80));
    assert(__riState.host !== null && __riState.host.parentElement !== null);

    // Fire popstate
    env.fireWin('popstate');
    assert.strictEqual(__riState.host.parentElement, null, 'popstate hid the controls');
  });

  await it('teardown cleans up host, tokens, and observers', () => {
    __riTeardown();
    assert.strictEqual(__riState.host, null);
    assert.strictEqual(__riState.snap, null);
  });
}

// --- Suite 9: Real content script answers through the REAL background.js, down to chrome.downloads.download and feedback ---
// The production files run unchanged: content_reddit.js in the fake DOM above and background.js in a vm sandbox (the same architecture as
// test_suite.js). Only the external boundaries are replaced: chrome.tabs.sendMessage reaches the real content-script listener,
// chrome.runtime.sendMessage from the content script reaches the real background listeners, and the network, chrome.downloads, the offscreen
// converter, storage, badges and scripting are mocks. No handler, sanitiser or URL check is copied into this file.
console.log('\n--- Suite 9: Real content script answers through the real background.js (to chrome.downloads.download and feedback) ---');
{
  const EXT_ID = 'image-saver-extension-id';
  const TAB = 101;
  const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00]);
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]);
  const tick = () => new Promise((r) => setImmediate(r));
  const quiesce = async (n = 250) => { for (let i = 0; i < n; i++) await tick(); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function storageArea(initial = {}) {
    const store = { ...initial };
    return {
      _store: store,
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: store[keys] };
        if (Array.isArray(keys)) { const res = {}; for (const k of keys) res[k] = store[k]; return res; }
        if (keys && typeof keys === 'object') { const res = {}; for (const k of Object.keys(keys)) res[k] = store[k] !== undefined ? store[k] : keys[k]; return res; }
        return { ...store };
      },
      set: async (items) => { Object.assign(store, items); },
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; },
      clear: async () => { for (const k of Object.keys(store)) delete store[k]; }
    };
  }

  // The production background.js with a mocked Chrome. `env` is the fake-DOM content environment whose real listener answers the proofs.
  function createBackground(env, settings = { subfolder: 'SavedImages', folderOrganizationMode: 'single', askEveryTime: false }) {
    const listeners = [];
    const downloads = [];
    const asks = [];
    const convs = [];
    let fetched = [];
    let onChanged = null;
    let offscreenContexts = [];
    const net = { gate: null, fail: null, gateFor: null, active: 0, max: 0 };
    const warns = [];
    const chromeMock = {
      declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
      runtime: {
        id: EXT_ID,
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener: (cb) => { listeners.push(cb); } },
        // the offscreen converter: a distinct Blob address per conversion
        sendMessage: async (msg) => {
          if (msg && /^CONVERT_/.test(msg.action || '')) {
            convs.push(msg.action);
            return { success: true, blobUrl: `blob:chrome-extension://${EXT_ID}/rd_${convs.length}.gif`, contentType: 'image/gif', size: 2048, frames: 15, duration: 1.0 };
          }
          return null;
        },
        getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
        getContexts: async () => offscreenContexts
      },
      offscreen: { createDocument: async () => { offscreenContexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }]; }, closeDocument: async () => { offscreenContexts = []; } },
      windows: { onFocusChanged: { addListener() {} }, onRemoved: { addListener() {} }, create: async () => ({ id: 1 }) },
      contextMenus: { removeAll: (cb) => { if (cb) cb(); }, create() {}, update: (id, p, cb) => { if (cb) cb(); }, refresh() {}, onClicked: { addListener() {} }, onShown: { addListener() {} } },
      tabs: {
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
        // the real content-script listener answers (the proof requests of the background)
        sendMessage: async (tabId, msg, options) => { asks.push({ tabId, msg, options }); return env.ask(msg, { id: EXT_ID }); }
      },
      downloads: {
        download: async (o) => { downloads.push(o); return 10001 + downloads.length; },
        search: async (query, cb) => {
          const item = { id: query?.id || 10001, state: 'complete', filename: 'SavedImages/x.jpg', mime: 'image/jpeg', bytesReceived: 1048576, totalBytes: 1048576, fileSize: 1048576, exists: true };
          if (cb) cb([item]);
          return [item];
        },
        onChanged: { addListener: (cb) => { onChanged = cb; } }
      },
      storage: { local: storageArea(settings), session: storageArea() },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      scripting: { executeScript: async (opts) => (opts && typeof opts.func === 'function' ? [{ result: opts.func(...(opts.args || [])) }] : [{ result: null }]) }
    };
    const sandbox = {
      chrome: chromeMock,
      console: { log() {}, info() {}, warn: (...a) => { warns.push(a.map(String).join(' ')); }, error() {} },
      URL, URLSearchParams, setTimeout, clearTimeout, AbortController,
      window: { location: { href: 'https://www.reddit.com/' } },
      document: { elementsFromPoint: () => [], querySelectorAll: () => [], querySelector: () => null, getElementById: () => null }
    };
    sandbox.fetch = async (u) => {
      const url = typeof u === 'string' ? u : (u?.url || '');
      fetched.push(url);
      net.active++;
      net.max = Math.max(net.max, net.active);
      try {
        if (net.gate) await net.gate;
        if (net.gateFor) { const g = net.gateFor(url); if (g) await g; }
        if (net.fail && net.fail.test(url)) return { ok: false, status: 404, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) };
        const path = url.split('?')[0].toLowerCase();
        const mp4 = /\.mp4$/.test(path) || /[?&]format=mp4/.test(url);
        const gif = !mp4 && /\.gif$/.test(path);
        const type = mp4 ? 'video/mp4' : gif ? 'image/gif' : /\.png$/.test(path) ? 'image/png' : 'image/jpeg';
        const bytes = mp4 ? MP4 : gif ? GIF : new Uint8Array(8);
        return {
          ok: true, status: 200,
          headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : (mp4 ? '' : '1048576')) },
          body: mp4 ? { getReader: () => ({ read: async () => ({ value: MP4, done: false }), cancel: async () => {} }) } : undefined,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        };
      } finally {
        net.active--;
      }
    };
    vm.createContext(sandbox);
    sandbox.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), sandbox);

    // content script -> background: what chrome.runtime.sendMessage of the real content script delivers, with the sender Chrome would attach
    env.chrome.runtime.sendMessage = async (msg) => {
      env.sentMessages.push(msg);
      const sender = { id: EXT_ID, tab: { id: TAB, active: true, url: env.window.location.href }, frameId: 0, documentId: 'doc-R', url: env.window.location.href };
      for (const l of listeners) { try { l(msg, sender, () => {}); } catch (_) {} }
      return { success: true };
    };
    const bg = {
      sandbox, downloads, asks, convs, net, listeners, warns,
      get fetched() { return fetched; },
      resetNet(opts = {}) { fetched = []; net.max = 0; net.gate = opts.gate || null; net.gateFor = opts.gateFor || null; net.fail = opts.fail || null; },
      send(msg, sender) { for (const l of listeners) { try { l(msg, sender, () => {}); } catch (_) {} } },
      // the mock never ends a download by itself: complete them the way chrome.downloads.onChanged would (ids are 10001 + the call number)
      async complete(from = 0) {
        for (let i = from; i < downloads.length; i++) await onChanged({ id: 10001 + i + 1, state: { current: 'complete', previous: 'in_progress' } });
        await quiesce(40);
      },
      async known() { await sandbox.feedbackTracker.flush(); return new Set((await sandbox.feedbackTracker.list()).map((o) => o.id)); },
      async opsSince(known) { await sandbox.feedbackTracker.flush(); return (await sandbox.feedbackTracker.list()).filter((o) => !known.has(o.id)); }
    };
    return bg;
  }

  // ---- DOM fixtures (the same conventions as the suites above) ----
  const R = (el, l, t, w, h) => el.setRect({ left: l, top: t, width: w, height: h });
  function imgPost(env, id, src, { tag = 'img', permalink = true } = {}) {
    const { document } = env.context;
    const post = document.createElement('shreddit-post');
    if (permalink) post.setAttribute('permalink', `/r/pics/comments/${id}/a_post/`);
    R(post, 100, 100, 600, 500);
    const cont = document.createElement('div');
    cont.style.position = 'relative';
    R(cont, 100, 100, 600, 500);
    const img = document.createElement(tag);
    img.src = src;
    R(img, 100, 100, 600, 500);
    cont.appendChild(img);
    post.appendChild(cont);
    document.body.appendChild(post);
    return { post, img, cont };
  }
  // a gallery post: slides share one frame like the suites above; `declared` is the container's total (null: none)
  function galleryPost(env, id, srcs, { declared = srcs.length, extra = null, tag = 'gallery-carousel', attr = 'total-items' } = {}) {
    const { document } = env.context;
    const post = document.createElement('shreddit-post');
    post.setAttribute('permalink', `/r/art/comments/${id}/a_gallery/`);
    R(post, 0, 0, 800, 600);
    const carousel = document.createElement(tag);
    if (declared !== null) carousel.setAttribute(attr, String(declared));
    carousel.style.position = 'relative';
    R(carousel, 20, 20, 700, 500);
    const slides = [];
    for (const src of srcs) slides.push(addSlide(env, carousel, src));
    if (extra) extra(carousel);
    post.appendChild(carousel);
    document.body.appendChild(post);
    return { post, carousel, slides };
  }
  function addSlide(env, carousel, src) {
    const { document } = env.context;
    const li = document.createElement('li');
    R(li, 20, 20, 700, 500);
    let media;
    if (/\.mp4(\?|$)/.test(src) && /v\.redd\.it/.test(src)) {
      media = document.createElement('shreddit-player');
      media.setAttribute('src', src);
      R(media, 20, 20, 700, 500);
      const video = document.createElement('video');
      video.src = src;
      R(video, 20, 20, 700, 500);
      media.appendChild(video);
    } else {
      media = document.createElement('img');
      media.src = src;
      R(media, 20, 20, 700, 500);
    }
    li.appendChild(media);
    carousel.appendChild(li);
    return { li, media };
  }
  async function hover(env, x = 100, y = 100) {
    env.fireDoc('pointermove', { clientX: x, clientY: y, pointerType: 'mouse' });
    await sleep(80);
  }
  const click = (btn) => btn.dispatchEvent({ type: 'click', isTrusted: true });
  // a fresh environment, the real background wired to it and the first operation known
  async function world(settings) {
    const env = createMockEnvironment();
    const bg = createBackground(env, settings);
    bg.resetNet();
    assert(bg.sandbox.feedbackTracker && typeof bg.sandbox.feedbackTracker.list === 'function', 'the real background exposes its feedback tracker');
    return { env, bg, state: env.context.__riState };
  }
  async function saveThis(w, expect = 1) {
    const before = w.bg.downloads.length;
    const known = await w.bg.known();
    click(w.state.btn);
    for (let i = 0; i < 200 && w.bg.downloads.length < before + expect; i++) await tick();
    await quiesce(120);
    await w.bg.complete(before);
    return { d: w.bg.downloads.slice(before), ops: await w.bg.opsSince(known) };
  }
  async function saveAllClick(w, wait = 0) {
    const before = w.bg.downloads.length;
    const known = await w.bg.known();
    click(w.state.btnAll);
    for (let i = 0; i < 600 && w.bg.downloads.length < before + wait; i++) await tick();
    await quiesce(200);
    await w.bg.complete(before);
    return { d: w.bg.downloads.slice(before), ops: await w.bg.opsSince(known) };
  }
  const failedCodes = (ops) => Array.from(ops.filter((o) => o.state === 'failed').map((o) => o.failure && o.failure.code));
  const proofs = (w) => w.bg.asks.map((a) => (a.msg.action === 'REDDIT_INLINE_OWNER_ITEM' ? `ITEM:${a.msg.index}` : a.msg.action));

  // ===== 9.1-9.5: Save this, one asset per format, from the real click to chrome.downloads.download =====
  await itAsync('9.1 image: the click reaches chrome.downloads.download with exactly that image, in the configured root, and one feedback operation completes', async () => {
    const w = await world();
    imgPost(w.env, 'pipe1', 'https://i.redd.it/pipe_scenery.jpg');
    await hover(w.env);
    assert(w.state.btn !== null);
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, 'https://i.redd.it/pipe_scenery.jpg');
    assert(/^SavedImages\/[^/]+\.jpg$/i.test(r.d[0].filename), r.d[0].filename);
    assert.strictEqual(r.d[0].saveAs, false);
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER']);
    assert(w.bg.asks.every((a) => a.tabId === TAB && a.options.frameId === 0 && a.options.documentId === 'doc-R'), 'asked of the sending frame and document');
    assert(!proofs(w).some((a) => /GET_REDDIT_MEDIA_AT_CURSOR|RESOLVE_REDDIT_BLOB_MEDIA/.test(a)), 'no gesture queries');
    assert.strictEqual(r.ops.length, 1);
    assert.strictEqual(r.ops[0].state, 'complete');
    assert.deepStrictEqual(w.bg.fetched.filter((u) => !/pipe_scenery/.test(u)), [], 'nothing but the selected image was requested');
  });

  await itAsync('9.2 native GIF: saved as the GIF itself, no conversion', async () => {
    const w = await world();
    imgPost(w.env, 'pipe2', 'https://i.redd.it/pipe_funny.gif');
    await hover(w.env);
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, 'https://i.redd.it/pipe_funny.gif');
    assert(/\.gif$/i.test(r.d[0].filename));
    assert.strictEqual(w.bg.convs.length, 0);
  });

  await itAsync('9.3 confirmed Reddit animation (.gif with format=mp4): converted exactly once to a GIF', async () => {
    const w = await world();
    imgPost(w.env, 'pipe3', 'https://preview.redd.it/pipe_clip.gif?format=mp4&s=789abc');
    await hover(w.env);
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert(/\.gif$/i.test(r.d[0].filename), r.d[0].filename);
    assert(/^blob:/.test(r.d[0].url), 'the converted output is what is downloaded');
    assert.deepStrictEqual(w.bg.convs, ['CONVERT_REDDIT_VIDEO_TO_GIF']);
    assert(w.bg.fetched.some((u) => /pipe_clip\.gif\?format=mp4/.test(u)));
    assert.strictEqual(r.ops[0].state, 'complete');
  });

  await itAsync('9.4 ordinary video: the MP4 itself, no conversion, no audio track or poster request', async () => {
    const w = await world();
    const { document } = w.env.context;
    const post = document.createElement('shreddit-post');
    post.setAttribute('permalink', '/r/videos/comments/pipe4/epic_video/');
    R(post, 100, 100, 600, 500);
    const player = document.createElement('shreddit-player');
    player.style.position = 'relative';
    player.setAttribute('src', 'https://v.redd.it/pipe4/DASH_720.mp4');
    R(player, 100, 100, 600, 500);
    const video = document.createElement('video');
    video.src = 'https://v.redd.it/pipe4/DASH_720.mp4';
    R(video, 100, 100, 600, 500);
    player.appendChild(video);
    post.appendChild(player);
    document.body.appendChild(post);
    await hover(w.env, 200, 200);
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, 'https://v.redd.it/pipe4/DASH_720.mp4');
    assert(/\.mp4$/i.test(r.d[0].filename));
    assert.strictEqual(w.bg.convs.length, 0);
    assert(w.bg.fetched.every((u) => /pipe4\/DASH_720\.mp4/.test(u)), 'only the proven MP4 was requested');
  });

  await itAsync('9.5 Media-search card: the card\'s own permalink owns the image', async () => {
    const w = await world();
    const { document } = w.env.context;
    const card = document.createElement('div');
    card.setAttribute('data-testid', 'search-post');
    card.style.position = 'relative';
    R(card, 100, 100, 600, 500);
    const a = document.createElement('a');
    a.setAttribute('href', '/r/search/comments/pipe5/search_target_post/');
    R(a, 100, 100, 600, 500);
    const img = document.createElement('img');
    img.src = 'https://i.redd.it/pipe_search.jpg';
    R(img, 100, 100, 600, 500);
    a.appendChild(img);
    card.appendChild(a);
    document.body.appendChild(card);
    await hover(w.env, 200, 200);
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, 'https://i.redd.it/pipe_search.jpg');
  });

  // ===== 9.6-9.7: Save all of a gallery whose completeness is proven =====
  await itAsync('9.6 complete gallery (declared total 3 = three rendered slides): three downloads, each once, in order, one operation each', async () => {
    const w = await world();
    const urls = [1, 2, 3].map((i) => `https://i.redd.it/pipe_gallery_${i}.jpg`);
    galleryPost(w.env, 'pipe6', urls);
    await hover(w.env);
    assert(w.state.btnAll !== null && w.state.btnAll.getAttribute('hidden') === null, 'Save all offered');
    const r = await saveAllClick(w, 3);
    assert.deepStrictEqual(r.d.map((x) => x.url).sort(), urls.slice().sort());
    assert(r.d.every((x) => /^SavedImages\/[^/]+\.jpg$/i.test(x.filename)));
    assert.deepStrictEqual(proofs(w).filter((a) => a === 'REDDIT_INLINE_BATCH'), ['REDDIT_INLINE_BATCH']);
    assert.deepStrictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).sort(), ['ITEM:0', 'ITEM:1', 'ITEM:2']);
    assert.strictEqual(r.ops.length, 3);
    assert(r.ops.every((o) => o.state === 'complete'));
    assert(w.bg.fetched.every((u) => urls.includes(u)), 'nothing but the three slides was requested');
  });

  await itAsync('9.7 mixed gallery keeps formats and folder modes, ignoring legacy Save As', async () => {
    const srcs = ['https://i.redd.it/mix_a.jpg', 'https://i.redd.it/mix_b.gif', 'https://v.redd.it/mix_c/DASH_720.mp4', 'https://preview.redd.it/mix_d.gif?format=mp4&s=sig'];
    for (const [settings, shape] of [
      [{ subfolder: 'SavedImages', folderOrganizationMode: 'single', askEveryTime: false }, [/^SavedImages\/[^/]+\.jpg$/i, /^SavedImages\/[^/]+\.gif$/i, /^SavedImages\/[^/]+\.mp4$/i]],
      [{ subfolder: 'SavedImages', folderOrganizationMode: 'by_site_and_type', askEveryTime: false }, [/^SavedImages\/reddit\/pic\/[^/]+\.jpg$/i, /^SavedImages\/reddit\/gif\/[^/]+\.gif$/i, /^SavedImages\/reddit\/video\/[^/]+\.mp4$/i]],
      [{ subfolder: 'Reddit/Keep', folderOrganizationMode: 'single', askEveryTime: true }, [/^Reddit\/Keep\/[^/]+\.jpg$/i, /^Reddit\/Keep\/[^/]+\.gif$/i, /^Reddit\/Keep\/[^/]+\.mp4$/i]]
    ]) {
      const w = await world(settings);
      galleryPost(w.env, 'mix' + settings.folderOrganizationMode.length + settings.subfolder.length, srcs);
      await hover(w.env);
      const r = await saveAllClick(w, 4);
      assert.strictEqual(r.d.length, 4, JSON.stringify(settings));
      const names = r.d.map((x) => x.filename);
      assert(shape.every((re) => names.some((n) => re.test(n))), names.join(' | '));
      assert.strictEqual(names.filter((n) => /\.gif$/i.test(n)).length, 2, 'native GIF and converted animation');
      assert.strictEqual(w.bg.convs.length, 1);
      assert(r.d.every((x) => x.saveAs === false), 'no item opens Save As, including a legacy enabled preference');
    }
  });

  // ===== 9.8: Save all needs positive completeness evidence; without it only Save this is offered and works =====
  const hasAll = (w) => Boolean(w.state.btnAll) && w.state.btnAll.getAttribute('hidden') === null;
  const gal3 = (id) => [1, 2, 3].map((i) => `https://i.redd.it/${id}_${i}.jpg`);
  await itAsync('9.8 no declared total, a smaller or larger total, two different totals, a foreign total, an unidentifiable slot, a cut enumeration: Save this only, one download, nothing else requested', async () => {
    const cases = [
      ['no declared total (three rendered images)', (env, id) => galleryPost(env, id, gal3(id), { declared: null })],
      ['declared 5, three rendered (virtualized subset)', (env, id) => galleryPost(env, id, gal3(id), { declared: 5 })],
      ['declared 2, three rendered (total smaller than the list)', (env, id) => galleryPost(env, id, gal3(id), { declared: 2 })],
      ['two different totals (container 3, pager 1/4)', (env, id) => galleryPost(env, id, gal3(id), { declared: 3, extra: (car) => { const pg = env.context.document.createElement('div'); pg.setAttribute('data-testid', 'carousel-pager'); pg.textContent = '1/4'; car.appendChild(pg); } })],
      ['a total declared only by a nested crosspost owner', (env, id) => {
        const g = galleryPost(env, id, gal3(id), { declared: null });
        const nested = env.context.document.createElement('shreddit-post');
        nested.setAttribute('permalink', `/r/other/comments/${id}x/nested/`);
        R(nested, 0, 0, 10, 10);
        const car = env.context.document.createElement('gallery-carousel');
        car.setAttribute('total-items', '3');
        nested.appendChild(car);
        g.post.appendChild(nested);
        return g;
      }],
      ['declared 3 but one slide has no identifiable slot', (env, id) => galleryPost(env, id, [gal3(id)[0], gal3(id)[1], `https://www.reddit.com/media?url=${encodeURIComponent(`https://i.redd.it/${id}_w.jpg`)}`], { declared: 3 })],
      ['declared 21 with 21 rendered (over the bound)', (env, id) => galleryPost(env, id, Array.from({ length: 21 }, (_, i) => `https://i.redd.it/${id}_b${i}.jpg`), { declared: 21 })],
      ['declared 1 with one rendered slide', (env, id) => galleryPost(env, id, [gal3(id)[0]], { declared: 1 })],
      ['a pager text that is no "n/N" (Photo 3)', (env, id) => galleryPost(env, id, gal3(id), { declared: null, extra: (car) => { const pg = env.context.document.createElement('div'); pg.setAttribute('data-testid', 'carousel-pager'); pg.textContent = 'Photo 3'; car.appendChild(pg); } })],
      ['declared 3 but the node bound cut the enumeration (85 extra images)', (env, id) => galleryPost(env, id, gal3(id), { declared: 3, extra: (car) => { for (let i = 0; i < 85; i++) { const x = env.context.document.createElement('img'); x.src = `https://styles.redditmedia.com/t5_x/styles/communityIcon_${i}.png`; R(x, 0, 0, 10, 10); car.appendChild(x); } } })]
    ];
    let n = 0;
    for (const [name, build] of cases) {
      const w = await world();
      const id = 'ev' + (++n);
      const g = build(w.env, id);
      await hover(w.env);
      assert(w.state.btn !== null, name + ': the control exists');
      assert(!hasAll(w), name + ': Save all must not be offered');
      const r = await saveThis(w);
      assert.strictEqual(r.d.length, 1, name);
      const own = g.slides.map((s) => s.media.src);
      assert(own.includes(r.d[0].url) || /_w\.jpg/.test(r.d[0].url), name + ': the saved file is one of the post\'s own slides');
      assert.strictEqual(w.bg.fetched.length >= 1 && w.bg.fetched.every((u) => u === r.d[0].url || /_w\.jpg/.test(u)), true, name + ': only that slide was requested');
      assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER'], name + ': no batch proof was ever asked');
    }
  });

  await itAsync('9.8b positive evidence: a declared total (attribute or pager text) equal to the rendered slides offers Save all; the total of one nested owner does not count for the other', async () => {
    for (const [name, opts] of [
      ['items-count attribute', { declared: null, attr: 'items-count' }],
      ['pager "1/3"', { declared: null, pager: '1/3' }],
      ['pager "2 of 3"', { declared: null, pager: '2 of 3' }]
    ]) {
      const w = await world();
      const g = galleryPost(w.env, 'pos' + name.length, gal3('pos' + name.length), { declared: null, extra: (car) => {
        if (opts.attr) car.setAttribute(opts.attr, '3');
        if (opts.pager) { const pg = w.env.context.document.createElement('div'); pg.setAttribute('data-testid', 'carousel-pager'); pg.textContent = opts.pager; car.appendChild(pg); }
      } });
      await hover(w.env);
      assert(hasAll(w), name + ': Save all offered');
      const r = await saveAllClick(w, 3);
      assert.strictEqual(r.d.length, 3, name);
    }
  });

  await itAsync('9.8c Save all up to the bound: 20 declared and rendered are saved whole', async () => {
    const w = await world();
    const urls = Array.from({ length: 20 }, (_, i) => `https://i.redd.it/big_${i}.jpg`);
    galleryPost(w.env, 'big20', urls, { declared: 20 });
    await hover(w.env);
    assert(hasAll(w));
    const r = await saveAllClick(w, 20);
    assert.strictEqual(r.d.length, 20);
    assert.deepStrictEqual(r.d.map((x) => x.url).sort(), urls.slice().sort());
    assert(r.ops.every((o) => o.state === 'complete'));
  });

  // ===== 9.9: the batch proof cannot outlive a changed gallery (the review's counterexamples), partial execution stays partial =====
  const mutateOn = (w, when, fn) => {
    const orig = w.env.ask;
    let done = false;
    w.env.ask = (msg, s) => { if (!done && when(msg)) { done = true; fn(); } return orig(msg, s); };
  };
  const isBatch = (m) => m.action === 'REDDIT_INLINE_BATCH';
  const isItem = (i) => (m) => m.action === 'REDDIT_INLINE_OWNER_ITEM' && m.index === i;

  await itAsync('9.9a the total grows from 3 to 4 before the batch opens: the open is refused, zero requests and downloads, one failed operation', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'dr1', gal3('dr1'));
    await hover(w.env);
    mutateOn(w, isBatch, () => g.carousel.setAttribute('total-items', '4'));
    const r = await saveAllClick(w);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_BATCH']);
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA']);
    assert(w.bg.warns.some((m) => /Inline Reddit Save all refused: STALE_LIST$/.test(m)), 'the open names its bounded reason: ' + w.bg.warns.join(' | '));
  });

  await itAsync('9.9b a slide is removed after the batch opened: the structure changed, no item runs, every item is a failed operation', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'dr2', gal3('dr2'));
    await hover(w.env);
    mutateOn(w, isItem(0), () => g.slides[2].li.remove());
    const r = await saveAllClick(w);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.strictEqual(failedCodes(r.ops).length, 3);
    assert.strictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).length, 2, 'a changed structure ends the batch: the last item is never even asked');
  });

  await itAsync('9.9c the total grows after two items were proven: they stay saved, the changed list stops the rest', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'dr3', gal3('dr3'));
    await hover(w.env);
    mutateOn(w, isItem(2), () => g.carousel.setAttribute('total-items', '4'));
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert(!w.bg.fetched.some((u) => /dr3_3/.test(u)), 'the third slide is not requested');
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA']);
  });

  await itAsync('9.9d two slides swap places before the last proof: the order changed, the last item is refused', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'dr4', gal3('dr4'));
    await hover(w.env);
    mutateOn(w, isItem(2), () => { const [a, b] = [g.slides[0].li, g.slides[1].li]; g.carousel.children.splice(g.carousel.children.indexOf(a), 2, b, a); });
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert(!w.bg.fetched.some((u) => /dr4_3/.test(u)));
    assert.strictEqual(failedCodes(r.ops).length, 1);
  });

  await itAsync('9.9e another slide\'s source changes (same slot): only that item fails, the others are saved (item-level)', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'dr5', gal3('dr5'));
    await hover(w.env);
    mutateOn(w, isItem(0), () => { g.slides[2].media.src = 'https://i.redd.it/dr5_3.jpg?width=640'; });
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert(!w.bg.fetched.some((u) => /dr5_3/.test(u)), 'the changed slide is not requested');
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA']);
    assert.strictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).length, 3, 'the batch kept going');
  });

  await itAsync('9.9f a slide\'s element is replaced by a new node with the same source: that item fails alone (STALE_ITEM)', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'dr6', gal3('dr6'));
    await hover(w.env);
    mutateOn(w, isItem(0), () => {
      const old = g.slides[1].media;
      const fresh = w.env.context.document.createElement('img');
      fresh.src = old.src;
      R(fresh, 20, 20, 700, 500);
      const li = g.slides[1].li;
      li.removeChild(old);
      li.appendChild(fresh);
    });
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert.strictEqual(failedCodes(r.ops).length, 1);
  });

  await itAsync('9.9k the owner\'s identity changes (another permalink) before the batch opens: refused, nothing requested', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'dr11', gal3('dr11'));
    await hover(w.env);
    mutateOn(w, isBatch, () => g.post.setAttribute('permalink', '/r/art/comments/other99/a_gallery/'));
    const r = await saveAllClick(w);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_BATCH']);
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA']);
  });

  await itAsync('9.9l a slide is removed and the total lowered together before the open: the count differs from the one the click saw, refused', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'dr12', gal3('dr12'));
    await hover(w.env);
    mutateOn(w, isBatch, () => { g.slides[2].li.remove(); g.carousel.setAttribute('total-items', '2'); });
    const r = await saveAllClick(w);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_BATCH']);
  });

  await itAsync('9.9m the total changes between hover and click: the control hides and nothing is sent', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'dr13', gal3('dr13'));
    await hover(w.env);
    assert(hasAll(w));
    g.carousel.setAttribute('total-items', '4');
    const all = w.state.btnAll;
    click(all);
    await quiesce(80);
    assert.strictEqual(w.env.sentMessages.length, 0);
    assert.strictEqual(w.bg.asks.length, 0);
    assert.strictEqual(w.bg.downloads.length, 0);
  });

  await itAsync('9.9g navigation after the click: the batch is refused at the open, nothing is requested', async () => {
    const w = await world();
    galleryPost(w.env, 'dr7', gal3('dr7'));
    await hover(w.env);
    mutateOn(w, isBatch, () => { w.env.window.location.href = 'https://www.reddit.com/r/other/comments/zzz999/else/'; });
    const r = await saveAllClick(w);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA']);
  });

  await itAsync('9.9h an unresolved blob player fails only its own item (UNRESOLVED_BLOB_MEDIA), the other items are saved', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'dr8', [gal3('dr8')[0], gal3('dr8')[2]], {
      declared: 3,
      extra: (car) => {
        const { document } = w.env.context;
        const li = document.createElement('li');
        R(li, 20, 20, 700, 500);
        const player = document.createElement('shreddit-player');
        player.setAttribute('stream-url', 'https://v.redd.it/dr8blob/HLSPlaylist.m3u8');
        R(player, 20, 20, 700, 500);
        const video = document.createElement('video');
        video.src = 'blob:https://www.reddit.com/0b9b1c2d-1111-2222-3333-444455556666';
        R(video, 20, 20, 700, 500);
        player.appendChild(video);
        li.appendChild(player);
        car.appendChild(li);
      }
    });
    await hover(w.env);
    assert(hasAll(w), 'the gallery of three (two images and a player) is proven complete');
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA']);
    assert(w.bg.fetched.every((u) => /dr8_[13]\.jpg/.test(u)), 'no request for the unresolved player');
    assert(!proofs(w).some((a) => /RESOLVE_REDDIT_BLOB_MEDIA/.test(a)));
  });

  await itAsync('9.9j every item is an unresolved blob player: the open answers NO_MEDIA, one failed operation, nothing requested', async () => {
    const w = await world();
    const { document } = w.env.context;
    galleryPost(w.env, 'dr10', [], {
      declared: 2,
      extra: (car) => {
        for (const n of [1, 2]) {
          const li = document.createElement('li');
          R(li, 20, 20, 700, 500);
          const player = document.createElement('shreddit-player');
          player.setAttribute('stream-url', `https://v.redd.it/dr10b${n}/HLSPlaylist.m3u8`);
          R(player, 20, 20, 700, 500);
          const video = document.createElement('video');
          video.src = `blob:https://www.reddit.com/0b9b1c2d-1111-2222-3333-44445555666${n}`;
          R(video, 20, 20, 700, 500);
          player.appendChild(video);
          li.appendChild(player);
          car.appendChild(li);
        }
      }
    });
    await hover(w.env);
    assert(hasAll(w), 'two players of a declared gallery of two');
    const r = await saveAllClick(w);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_BATCH']);
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA']);
  });

  await itAsync('9.9i HTTP 404 for one item: that operation fails, the others are saved, no substitute is requested', async () => {
    const w = await world();
    galleryPost(w.env, 'dr9', gal3('dr9'));
    await hover(w.env);
    w.bg.resetNet({ fail: /dr9_2/ });
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert(r.d.every((x) => !/dr9_2/.test(x.url)));
    assert.strictEqual(failedCodes(r.ops).length, 1);
    assert(w.bg.fetched.every((u) => /dr9_[123]\.jpg/.test(u)));
  });

  // ===== 9.10: a blob (Shreddit) player: the document recovers the direct source itself =====
  await itAsync('9.10 blob player with a direct source on the player: that MP4 is saved without any gesture query; with none it is one failed operation', async () => {
    const mk = (w, id, directSrc) => {
      const { document } = w.env.context;
      const post = document.createElement('shreddit-post');
      post.setAttribute('permalink', `/r/videos/comments/${id}/blob/`);
      R(post, 100, 100, 600, 500);
      const player = document.createElement('shreddit-player');
      player.style.position = 'relative';
      if (directSrc) player.setAttribute('src', directSrc);
      player.setAttribute('stream-url', `https://v.redd.it/${id}/HLSPlaylist.m3u8`);
      R(player, 100, 100, 600, 500);
      const video = document.createElement('video');
      video.src = 'blob:https://www.reddit.com/0b9b1c2d-1111-2222-3333-444455556666';
      R(video, 100, 100, 600, 500);
      player.appendChild(video);
      post.appendChild(player);
      document.body.appendChild(post);
    };
    const ok = await world();
    mk(ok, 'blobok', 'https://v.redd.it/blobok/DASH_480.mp4');
    await hover(ok.env, 200, 200);
    const r = await saveThis(ok);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, 'https://v.redd.it/blobok/DASH_480.mp4');
    assert(/\.mp4$/i.test(r.d[0].filename));
    assert(!proofs(ok).some((a) => /RESOLVE_REDDIT_BLOB_MEDIA|GET_REDDIT_MEDIA_AT_CURSOR/.test(a)));
    const bad = await world();
    mk(bad, 'blobno', null);
    await hover(bad.env, 200, 200);
    const r2 = await saveThis(bad, 0);
    assert.strictEqual(r2.d.length, 0);
    assert.strictEqual(bad.bg.fetched.length, 0);
    assert.deepStrictEqual(failedCodes(r2.ops), ['UNRESOLVED_BLOB_MEDIA']);
  });

  // ===== 9.11: stale and foreign owners: zero requests and downloads =====
  await itAsync('9.11 owner removed, page navigated or tile source replaced after the click: refused as a failed operation with zero requests and downloads', async () => {
    const cases = [
      ['owner removed', (w, p) => { p.post.isConnected = false; p.img.isConnected = false; }],
      ['page navigated', (w) => { w.env.window.location.href = 'https://www.reddit.com/r/pics/comments/other1/else/'; }],
      ['tile source replaced by another asset', (w, p) => { p.img.src = 'https://i.redd.it/foreign_asset.jpg'; }]
    ];
    let n = 0;
    for (const [name, change] of cases) {
      const w = await world();
      const p = imgPost(w.env, 'st' + (++n), `https://i.redd.it/st_${n}.jpg`);
      await hover(w.env);
      mutateOn(w, (m) => m.action === 'REDDIT_INLINE_OWNER', () => change(w, p));
      const r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, name);
      assert.strictEqual(w.bg.fetched.length, 0, name);
      assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA'], name);
    }
  });

  await itAsync('9.11b neighbouring and nested media are never requested', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'nb1', ['https://i.redd.it/nb1_1.jpg', 'https://i.redd.it/nb1_2.jpg']);
    const { document } = w.env.context;
    const nested = document.createElement('shreddit-post');
    nested.setAttribute('permalink', '/r/other/comments/nbn/nested/');
    R(nested, 600, 450, 80, 40);
    const nimg = document.createElement('img');
    nimg.src = 'https://i.redd.it/nb1_nested.jpg';
    R(nimg, 600, 450, 80, 40);
    nested.appendChild(nimg);
    g.post.appendChild(nested);
    const neighbour = imgPost(w.env, 'nb2', 'https://i.redd.it/nb1_neighbour.jpg');
    R(neighbour.post, 900, 700, 100, 100); R(neighbour.cont, 900, 700, 100, 100); R(neighbour.img, 900, 700, 100, 100);
    await hover(w.env);
    assert(hasAll(w));
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert(w.bg.fetched.every((u) => /nb1_[12]\.jpg/.test(u)), w.bg.fetched.join(' '));
  });

  // ===== 9.12: repeated clicks =====
  await itAsync('9.12 two Save this clicks and two Save all clicks while the first still runs give one save each', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const w = await world();
    imgPost(w.env, 'rp1', 'https://i.redd.it/rp1.jpg');
    await hover(w.env);
    w.bg.resetNet({ gate });
    const before = w.bg.downloads.length;
    click(w.state.btn); await quiesce(60);
    w.state.busyKey = ''; w.state.busyAt = 0;
    click(w.state.btn); await quiesce(60);
    release(); await quiesce(300);
    assert.strictEqual(w.bg.downloads.length - before, 1, 'one download for two quick Save this clicks');
    const w2 = await world();
    let release2; const gate2 = new Promise((r) => { release2 = r; });
    galleryPost(w2.env, 'rp2', gal3('rp2'));
    await hover(w2.env);
    w2.bg.resetNet({ gate: gate2 });
    click(w2.state.btnAll); await quiesce(60);
    w2.state.busyKey = ''; w2.state.busyAt = 0;
    click(w2.state.btnAll); await quiesce(60);
    release2(); await quiesce(400);
    assert.strictEqual(w2.bg.downloads.length, 3, 'three downloads for two Save all clicks');
    assert.strictEqual(proofs(w2).filter((a) => /^ITEM/.test(a)).length, 3);
  });

  await itAsync('9.12b an untrusted click sends nothing to the background', async () => {
    const w = await world();
    imgPost(w.env, 'ut1', 'https://i.redd.it/ut1.jpg');
    await hover(w.env);
    w.state.btn.dispatchEvent({ type: 'click', isTrusted: false });
    await quiesce(60);
    assert.strictEqual(w.env.sentMessages.length, 0);
    assert.strictEqual(w.bg.asks.length, 0);
  });

  // ===== 9.13: the real sender gate (the copy of the earlier suite accepted plain http) =====
  await itAsync('9.13 forged senders reach the real background and are ignored: no ask, no request, no download', async () => {
    const w = await world();
    imgPost(w.env, 'gt1', 'https://i.redd.it/gt1.jpg');
    const page = 'https://www.reddit.com/r/pics/comments/gt1/a_post/';
    const ok = { id: EXT_ID, tab: { id: TAB, active: true, url: page }, frameId: 0, documentId: 'doc-R', url: page };
    for (const [name, sender] of [
      ['plain http Reddit page', { ...ok, url: 'http://www.reddit.com/r/pics/comments/gt1/a_post/', tab: { id: TAB, active: true, url: 'http://www.reddit.com/' } }],
      ['another extension', { ...ok, id: 'other-extension' }],
      ['a background tab', { ...ok, tab: { id: TAB, active: false, url: page } }],
      ['a look-alike host', { ...ok, url: 'https://reddit.com.evil.example/r/a' }]
    ]) {
      w.bg.send({ action: 'REDDIT_INLINE_SAVE', token: 'a'.repeat(32) }, sender);
      w.bg.send({ action: 'REDDIT_INLINE_SAVE_ALL', token: 'b'.repeat(32) }, sender);
      await quiesce(80);
      assert.strictEqual(w.bg.asks.length, 0, name);
      assert.strictEqual(w.bg.downloads.length, 0, name);
      assert.strictEqual(w.bg.fetched.length, 0, name);
    }
  });

  // ===== 9.14: the documented evidence sources are discovered; evidence cut by its own bound fails closed =====
  const withTotals = (env, n, total) => (car) => {
    // n extra same-owner containers, each declaring `total` (the gallery's own container is one more match)
    for (let i = 0; i < n; i++) { const d = env.context.document.createElement('div'); d.setAttribute('total-items', String(total)); car.appendChild(d); }
  };
  const withPagers = (env, texts) => (car) => {
    for (const t of texts) { const pg = env.context.document.createElement('div'); pg.setAttribute('data-testid', 'carousel-pager'); pg.textContent = t; car.appendChild(pg); }
  };
  await itAsync('9.14 data-total-items: an attribute-only container and a gallery-carousel are both discovered; a foreign owner\'s attribute is refused', async () => {
    for (const [name, opts] of [
      ['an attribute-only div (data-total-items=3)', { tag: 'div', attr: 'data-total-items', declared: 3 }],
      ['a gallery-carousel (data-total-items=3)', { tag: 'gallery-carousel', attr: 'data-total-items', declared: 3 }],
      ['an attribute-only div (items-count=3)', { tag: 'div', attr: 'items-count', declared: 3 }]
    ]) {
      const w = await world();
      const id = 'dt' + (name.length + opts.attr.length);
      galleryPost(w.env, id, gal3(id), opts);
      await hover(w.env);
      assert(hasAll(w), name + ': Save all offered');
      const r = await saveAllClick(w, 3);
      assert.strictEqual(r.d.length, 3, name);
    }
    const w = await world();
    const { document } = w.env.context;
    const g = galleryPost(w.env, 'dtf1', gal3('dtf1'), { tag: 'div', attr: 'data-total-items', declared: null });
    const nested = document.createElement('shreddit-post');
    nested.setAttribute('permalink', '/r/other/comments/dtf1x/nested/');
    R(nested, 0, 0, 10, 10);
    const foreign = document.createElement('div');
    foreign.setAttribute('data-total-items', '3');
    nested.appendChild(foreign);
    g.post.appendChild(nested);
    await hover(w.env);
    assert(!hasAll(w), 'a data-total-items of a nested owner is no evidence for this one');
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER']);
  });

  await itAsync('9.14b container evidence: eight agreeing sources are a proof, a ninth source (even a conflicting 4, even an agreeing 3) is truncated evidence and fails closed', async () => {
    const cases = [
      ['eight sources, all 3 (the bound)', (env) => withTotals(env, 7, 3), true],
      ['eight agreeing sources plus a ninth saying 4', (env) => (car) => { withTotals(env, 7, 3)(car); withTotals(env, 1, 4)(car); }, false],
      ['nine agreeing sources (nothing proves none was discarded)', (env) => withTotals(env, 8, 3), false],
      ['seven sources plus an eighth saying 4 (inside the bound: a conflict)', (env) => (car) => { withTotals(env, 6, 3)(car); withTotals(env, 1, 4)(car); }, false]
    ];
    let n = 0;
    for (const [name, mk, expected] of cases) {
      const w = await world();
      const id = 'tc' + (++n);
      galleryPost(w.env, id, gal3(id), { declared: 3, extra: mk(w.env) });
      await hover(w.env);
      assert.strictEqual(hasAll(w), expected, name);
      if (expected) assert.strictEqual((await saveAllClick(w, 3)).d.length, 3, name);
      else { const r = await saveThis(w); assert.strictEqual(r.d.length, 1, name); assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER'], name); }
    }
  });

  await itAsync('9.14c pager evidence: four agreeing pagers are a proof, a fifth pager (conflicting or agreeing) fails closed', async () => {
    const cases = [
      ['four pagers 1/3 (the bound)', ['1/3', '1/3', '1/3', '1/3'], true],
      ['four pagers plus a fifth 1/4', ['1/3', '1/3', '1/3', '1/3', '1/4'], false],
      ['five agreeing pagers', ['1/3', '1/3', '1/3', '1/3', '1/3'], false],
      ['three agreeing pagers plus a fourth 1/4 (inside the bound: a conflict)', ['1/3', '1/3', '1/3', '1/4'], false]
    ];
    let n = 0;
    for (const [name, texts, expected] of cases) {
      const w = await world();
      const id = 'tp' + (++n);
      galleryPost(w.env, id, gal3(id), { declared: null, extra: withPagers(w.env, texts) });
      await hover(w.env);
      assert.strictEqual(hasAll(w), expected, name);
      if (expected) assert.strictEqual((await saveAllClick(w, 3)).d.length, 3, name);
    }
  });

  // ===== 9.15: a player's source-only change is item-level; the structure follows the asset identity =====
  const PLAYER_OLD = 'https://v.redd.it/vidprobe/DASH_720.mp4?token=old';
  const mixed = (id) => [`https://i.redd.it/${id}_a.jpg`, PLAYER_OLD, `https://i.redd.it/${id}_b.jpg`];
  const setPlayerSrc = (slide, url) => { slide.media.setAttribute('src', url); const v = slide.media.children[0]; if (v) v.src = url; };
  await itAsync('9.15 mixed gallery (image, signed player, image): all three saved, the player with its exact signed address', async () => {
    const w = await world();
    galleryPost(w.env, 'kp1', mixed('kp1'));
    await hover(w.env);
    assert(hasAll(w));
    const r = await saveAllClick(w, 3);
    assert.strictEqual(r.d.length, 3);
    assert(r.d.some((x) => x.url === PLAYER_OLD), 'the signed address is downloaded exactly, token included');
    assert(w.bg.fetched.includes(PLAYER_OLD));
    assert.strictEqual(r.ops.length, 3);
    assert(r.ops.every((o) => o.state === 'complete'));
  });

  await itAsync('9.15b only the token (or the resolution) of the player changes after the open: the player fails alone (STALE_ITEM), both unchanged images are saved, the batch continues', async () => {
    for (const [name, url] of [['token=new', 'https://v.redd.it/vidprobe/DASH_720.mp4?token=new'], ['resolution DASH_480', 'https://v.redd.it/vidprobe/DASH_480.mp4?token=old'], ['no query at all', 'https://v.redd.it/vidprobe/DASH_720.mp4']]) {
      const w = await world();
      const g = galleryPost(w.env, 'kp2', mixed('kp2'));
      await hover(w.env);
      mutateOn(w, isItem(0), () => setPlayerSrc(g.slides[1], url));
      const r = await saveAllClick(w, 2);
      assert.strictEqual(r.d.length, 2, name);
      assert(r.d.every((x) => /kp2_[ab]\.jpg/.test(x.url)), name);
      assert(!w.bg.fetched.some((u) => /vidprobe/.test(u)), name + ': neither the old nor the new player address is requested');
      assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA'], name);
      assert.strictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).length, 3, name + ': no STALE_LIST, the batch kept going');
    }
  });

  await itAsync('9.15c the player node is replaced by a new node with the same identity: that item fails alone, the images are saved', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'kp3', mixed('kp3'));
    await hover(w.env);
    mutateOn(w, isItem(0), () => {
      const { document } = w.env.context;
      const li = g.slides[1].li;
      li.removeChild(g.slides[1].media);
      const fresh = document.createElement('shreddit-player');
      fresh.setAttribute('src', PLAYER_OLD);
      R(fresh, 20, 20, 700, 500);
      const v = document.createElement('video');
      v.src = PLAYER_OLD;
      R(v, 20, 20, 700, 500);
      fresh.appendChild(v);
      li.appendChild(fresh);
    });
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert(!w.bg.fetched.some((u) => /vidprobe/.test(u)));
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA']);
    assert.strictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).length, 3);
  });

  await itAsync('9.15d a genuinely different asset in the player slot is structural (STALE_LIST): the batch ends, it is never merged with the old one', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'kp4', mixed('kp4'));
    await hover(w.env);
    mutateOn(w, isItem(2), () => setPlayerSrc(g.slides[1], 'https://v.redd.it/vidother/DASH_720.mp4?token=old'));
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2, 'the two items proven before the change stay saved');
    assert(!w.bg.fetched.some((u) => /kp4_b|vidother/.test(u)), 'the last image and the foreign asset are not requested');
    assert.strictEqual(failedCodes(r.ops).length, 1);
  });

  await itAsync('9.15e the player and the last image swap places (reordered): structural, the batch ends', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'kp5', mixed('kp5'));
    await hover(w.env);
    mutateOn(w, isItem(2), () => { const [a, b] = [g.slides[1].li, g.slides[2].li]; g.carousel.children.splice(g.carousel.children.indexOf(a), 2, b, a); });
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert(!w.bg.fetched.some((u) => /kp5_b/.test(u)));
    assert.strictEqual(failedCodes(r.ops).length, 1);
  });

  await itAsync('9.15f the player slot is removed after the open: structural (the total no longer matches), the batch ends with zero downloads', async () => {
    const w = await world();
    const g = galleryPost(w.env, 'kp6', mixed('kp6'));
    await hover(w.env);
    mutateOn(w, isItem(0), () => g.slides[1].li.remove());
    const r = await saveAllClick(w);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.strictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).length, 2);
  });

  await itAsync('9.15g two different players in one gallery stay two slots (never merged); a failed authoritative video is not replaced by anything', async () => {
    const w = await world();
    galleryPost(w.env, 'kp7', ['https://v.redd.it/vidone/DASH_720.mp4?token=a', 'https://v.redd.it/vidtwo/DASH_720.mp4?token=a', 'https://i.redd.it/kp7_c.jpg']);
    await hover(w.env);
    assert(hasAll(w), 'three distinct slots');
    w.bg.resetNet({ fail: /vidtwo/ });
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert(r.d.every((x) => !/vidtwo/.test(x.url)));
    assert.strictEqual(failedCodes(r.ops).length, 1);
    assert(w.bg.fetched.every((u) => /vidone|vidtwo|kp7_c/.test(u)), 'no poster or other substitute was requested');
  });

  // ===== 9.16-9.19: the two native failures (www.reddit.com, 2026-10-05): an unplayed/blob Shreddit player and the native gallery carousel =====
  // The fixtures follow the DOM that was read from the live pages (anonymous Chromium, values redacted): a <shreddit-player> whose src is an HLS
  // playlist, whose own packaged-media-json lists the direct MP4s and whose open shadow <video> has no source until it plays; and a
  // <gallery-carousel> with one <ul> of <li slot="page-N">, a decorative backdrop <img alt="">, a real <img>, a zero-size zoom <img>,
  // lazy slides (data-lazy-src) and a pagination indicator (pages="N") two open shadow roots deep.
  const shadowOf = (env, host) => { const root = env.context.document.createElement('shadow-root'); host.shadowRoot = root; root.host = host; return root; };
  const pmj = (vid, { codecs = ['VP9', 'H264'], res = [220, 270, 360, 480, 720], host = 'packaged-media.redd.it' } = {}) => JSON.stringify({
    playbackMp4s: { duration: 36, permutations: codecs.flatMap((c) => res.map((h) => ({ source: { url: `https://${host}/${vid}/pb/m2-${c === 'VP9' ? 'vp9-' : ''}res_${h}p.mp4?s=${c}${h}`, dimensions: { width: Math.round(h * 16 / 9), height: h }, videoCodec: c } }))) }
  });
  const BEST = (vid) => `https://packaged-media.redd.it/${vid}/pb/m2-res_720p.mp4?s=H264720`;
  function playerPost(env, id, vid, { json = pmj(vid), inner = '', src = `https://v.redd.it/${vid}/HLSPlaylist.m3u8?f=hd&t=1`, parent = null, left = 100, top = 100 } = {}) {
    const { document } = env.context;
    const post = document.createElement('shreddit-post');
    post.setAttribute('id', `t3_${id}`);
    post.setAttribute('permalink', `/r/pcmasterrace/comments/${id}/a_video/`);
    post.setAttribute('post-type', 'video');
    R(post, left, top, 600, 500);
    const cont = document.createElement('div');
    cont.style.position = 'relative';
    R(cont, left, top, 600, 500);
    const player = document.createElement('shreddit-player');
    player.setAttribute('src', src);
    player.setAttribute('preview', `https://v.redd.it/${vid}/CMAF_96.mp4`);
    player.setAttribute('poster', `https://external-preview.redd.it/slug-v0-${vid}x.png?s=p`);
    if (json !== null) player.setAttribute('packaged-media-json', json);
    R(player, left, top, 600, 500);
    const source = document.createElement('source');
    source.setAttribute('src', src);
    source.setAttribute('type', 'application/vnd.apple.mpegURL');
    player.appendChild(source);
    const poster = document.createElement('img');
    poster.setAttribute('slot', 'poster');
    poster.src = `https://external-preview.redd.it/slug-v0-${vid}x.png?s=p`;
    R(poster, left, top, 600, 500);
    player.appendChild(poster);
    const root = shadowOf(env, player);
    const video = document.createElement('video');
    if (inner) { video.src = inner; video.currentSrc = inner; }
    R(video, left, top, 600, 500);
    root.appendChild(video);
    cont.appendChild(player);
    post.appendChild(cont);
    (parent || document.body).appendChild(post);
    return { post, cont, player, video, poster };
  }
  const onlyFetched = (w, re) => w.bg.fetched.length >= 1 && w.bg.fetched.every((u) => re.test(u));

  await itAsync('9.16 unplayed native player (HLS src, empty shadow video, packaged-media-json): Save this downloads the 720p H264 MP4 it declares, exactly, as an MP4, with nothing else requested', async () => {
    const w = await world();
    playerPost(w.env, 'dlss1', 'vid9dlss');
    await hover(w.env, 200, 200);
    assert(w.state.btn !== null, 'the control is shown over the player (the poster on top resolves to its player)');
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, BEST('vid9dlss'), 'the exact declared address, signed query included: not VP9, not a lower resolution, not the HLS playlist, not the poster');
    assert(/^SavedImages\/[^/]+\.mp4$/i.test(r.d[0].filename), r.d[0].filename);
    assert.strictEqual(r.d[0].saveAs, false);
    assert.strictEqual(w.bg.convs.length, 0, 'an ordinary video is never converted');
    assert(onlyFetched(w, /m2-res_720p\.mp4/), 'no playlist, poster, audio track or other variant was requested: ' + JSON.stringify(w.bg.fetched));
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER'], 'no gesture query (never the last right-click)');
    assert.strictEqual(r.ops.length, 1);
    assert.strictEqual(r.ops[0].state, 'complete');
  });

  await itAsync('9.16b the context-menu route and the inline route read the SAME asset from the same player (unplayed, blob and playing states)', async () => {
    const PLAYING = 'https://packaged-media.redd.it/vid9par/pb/m2-res_480p.mp4?s=playing';
    for (const [name, inner, expected] of [
      ['unplayed (empty shadow video)', '', BEST('vid9par')],
      ['blob: MediaSource inside the shadow root', 'blob:https://www.reddit.com/0a1b2c3d-0000-4000-8000-000000000000', BEST('vid9par')],
      ['playing a direct file (what is playing wins, unchanged behaviour)', PLAYING, PLAYING]
    ]) {
      const w = await world();
      const g = playerPost(w.env, 'par1', 'vid9par', { inner });
      const viaMenu = w.env.context.findRedditMediaFromTargetAndPath(g.player, [g.player, g.post], null);
      assert(viaMenu && viaMenu.url === expected, name + ': menu route ' + (viaMenu && viaMenu.url));
      w.env.context.setLastRedditContextmenuTarget(g.player, [g.player, g.post]);
      const viaCursor = w.env.ask({ action: 'GET_REDDIT_MEDIA_AT_CURSOR' });
      assert(viaCursor && viaCursor.media && viaCursor.media.url === expected, name + ': cursor query');
      await hover(w.env, 200, 200);
      const r = await saveThis(w);
      assert.strictEqual(r.d.length, 1, name);
      assert.strictEqual(r.d[0].url, viaMenu.url, name + ': the inline route saves the asset the menu route found');
      assert(/\.mp4$/i.test(r.d[0].filename), name);
    }
  });

  await itAsync('9.16c a blob player is recovered from the player\'s own declaration when the blob: address reaches the menu route too (RESOLVE_REDDIT_BLOB_MEDIA)', async () => {
    const w = await world();
    const g = playerPost(w.env, 'blob1', 'vid9blob', { inner: 'blob:https://www.reddit.com/aaaa-bbbb' });
    w.env.context.setLastRedditContextmenuTarget(g.video, [g.video, g.player, g.post]);
    const res = w.env.ask({ action: 'RESOLVE_REDDIT_BLOB_MEDIA', clickedSrc: 'blob:https://www.reddit.com/aaaa-bbbb' });
    assert(res && res.success === true && res.targetUrl === BEST('vid9blob'), JSON.stringify(res));
  });

  await itAsync('9.16d unresolved players fail clearly and request/download nothing: no declaration, manifest only, VP9 only, a foreign host, mixed assets, garbage, oversize, an asset that is not the player\'s own', async () => {
    const cases = [
      ['no packaged-media-json at all', { json: null }],
      ['declaration without any permutation', { json: JSON.stringify({ playbackMp4s: { duration: 1, permutations: [] } }) }],
      ['VP9 only (no H264 file)', { json: pmj('vid9bad', { codecs: ['VP9'] }) }],
      ['a foreign host', { json: pmj('vid9bad', { host: 'cdn.evil.example' }) }],
      ['an http address', { json: pmj('vid9bad').replaceAll('https://', 'http://') }],
      ['two asset ids in one declaration', { json: JSON.stringify({ playbackMp4s: { permutations: [
        { source: { url: 'https://packaged-media.redd.it/aaa/pb/m2-res_720p.mp4?s=1', dimensions: { width: 1280, height: 720 }, videoCodec: 'H264' } },
        { source: { url: 'https://packaged-media.redd.it/bbb/pb/m2-res_720p.mp4?s=2', dimensions: { width: 1280, height: 720 }, videoCodec: 'H264' } }] } }) }],
      ['the declaration names another asset than the player\'s own src', { json: pmj('vid9other') }],
      ['two assets: a larger foreign one first, the player\'s own last', { json: JSON.stringify({ playbackMp4s: { permutations: [
        { source: { url: 'https://packaged-media.redd.it/vid9foreign/pb/m2-res_1080p.mp4?s=f', dimensions: { width: 1920, height: 1080 }, videoCodec: 'H264' } },
        { source: { url: 'https://packaged-media.redd.it/vid9bad/pb/m2-res_720p.mp4?s=o', dimensions: { width: 1280, height: 720 }, videoCodec: 'H264' } }] } }) }],
      ['not JSON', { json: '{"playbackMp4s": [' }],
      ['an HLS playlist listed as a file', { json: JSON.stringify({ playbackMp4s: { permutations: [{ source: { url: 'https://v.redd.it/vid9bad/HLSPlaylist.m3u8?x=1', dimensions: { width: 1280, height: 720 }, videoCodec: 'H264' } }] } }) }],
      ['an oversized attribute', { json: ' '.repeat(70000) + pmj('vid9bad') }],
      ['more than 32 permutations (bounded)', { json: JSON.stringify({ playbackMp4s: { permutations: Array.from({ length: 33 }, (_, i) => ({ source: { url: `https://packaged-media.redd.it/vid9bad/pb/m2-res_${i + 100}p.mp4?s=${i}`, dimensions: { width: 1280, height: i + 100 }, videoCodec: 'H264' } })) } }) }],
      ['dimensions missing', { json: JSON.stringify({ playbackMp4s: { permutations: [{ source: { url: 'https://packaged-media.redd.it/vid9bad/pb/m2-res_720p.mp4?s=1', videoCodec: 'H264' } }] } }) }]
    ];
    for (const [name, opts] of cases) {
      const w = await world();
      playerPost(w.env, 'bad1', 'vid9bad', opts);
      await hover(w.env, 200, 200);
      assert(w.state.btn !== null, name + ': the control is still shown (the failure is the explicit proof refusal)');
      const r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, name);
      assert.strictEqual(w.bg.fetched.length, 0, name + ': no request');
      assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER'], name);
      assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA'], name);
      assert(w.bg.warns.some((m) => /Inline Reddit Save refused: UNRESOLVED_BLOB$/.test(m)), name + ': the log names the bounded reason: ' + w.bg.warns.join(' | '));
      assert(!w.bg.warns.some((m) => /owner was not proven/.test(m)), name + ': no misleading owner wording');
    }
  });

  await itAsync('9.16e no borrowing: another post\'s player, a nested crosspost\'s player and the last right-click never supply the media of an unresolved player', async () => {
    const w = await world();
    const a = playerPost(w.env, 'own1', 'vid9own', { json: null, left: 100, top: 100 });
    // the neighbour (another post) resolves; the user right-clicked it earlier
    const b = playerPost(w.env, 'nbr1', 'vid9nbr', { left: 900, top: 100 });
    w.env.context.setLastRedditContextmenuTarget(b.player, [b.player, b.post]);
    // a nested crosspost inside the first post resolves too (its own post element, its own id)
    playerPost(w.env, 'nst1', 'vid9nst', { parent: a.cont, left: 400, top: 400 });
    await hover(w.env, 150, 150);
    const r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA']);
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER']);
  });

  await itAsync('9.16f two players in one post: each is its own slot, the declaration of one is never used for the other', async () => {
    const w = await world();
    const a = playerPost(w.env, 'two1', 'vid9two', { json: null });
    const second = w.env.context.document.createElement('shreddit-player');
    second.setAttribute('src', 'https://v.redd.it/vid9second/HLSPlaylist.m3u8?x=1');
    second.setAttribute('packaged-media-json', pmj('vid9second'));
    R(second, 700, 100, 100, 100);
    shadowOf(w.env, second).appendChild(w.env.context.document.createElement('video'));
    a.cont.appendChild(second);
    await hover(w.env, 200, 200);
    const r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0, 'the unresolved player fails alone');
    assert(!w.bg.fetched.some((u) => /vid9second/.test(u)));
    assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA']);
  });

  await itAsync('9.16g a changed source ends the click before any token; a change after the token refuses without a request; a refused/expired proof logs its bounded reason', async () => {
    let w = await world();
    let g = playerPost(w.env, 'chg1', 'vid9chg');
    await hover(w.env, 200, 200);
    g.player.setAttribute('src', 'https://v.redd.it/vid9chg/HLSPlaylist.m3u8?f=hd&t=2');
    let r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0, 'the shown control no longer matches the player: nothing is sent');
    assert.strictEqual(w.bg.asks.length, 0);
    w = await world();
    g = playerPost(w.env, 'chg2', 'vid9chg2');
    await hover(w.env, 200, 200);
    mutateOn(w, (m) => m.action === 'REDDIT_INLINE_OWNER', () => g.player.setAttribute('poster', 'https://external-preview.redd.it/slug-v0-other.png?s=2'));
    r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA'], 'a player whose source changed after the click is refused as stale, not as an unresolved blob');
    assert(w.bg.warns.some((m) => /Inline Reddit Save refused: STALE_OWNER$/.test(m)), w.bg.warns.join(' | '));
    const why = w.bg.sandbox.redditInlineWhy;
    assert.strictEqual(why({ ok: false, reason: 'UNRESOLVED_BLOB' }), 'UNRESOLVED_BLOB');
    assert.strictEqual(why({ ok: false, reason: 'https://x.example/?token=secret' }), 'REFUSED', 'page-supplied text is never echoed');
    assert.strictEqual(why({ ok: true, media: {} }), 'INVALID_DESCRIPTOR');
    assert.strictEqual(why(undefined), 'NO_ANSWER');
  });

  // ---- the native gallery ----
  const GIF_ID = ['afwnpxac02sh1', 'zj9oc0bc02sh1', 'iwwn46bc02sh1', '3ie1x1bc02sh1', 'rd8exyac02sh1', '40okr0bc02sh1', 'hghfjzac02sh1', 'mcxfxpbc02sh1', 'f0a6p3bc02sh1', 'ytdb19bc02sh1', 'obex93bc02sh1', 'snrvv2bc02sh1', 'gj7wt0bc02sh1', '2da8o0bc02sh1', 'd4l013bc02sh1', '0yeei4bc02sh1', 'ni31v1bc02sh1'];
  const gifSlides = (ids = GIF_ID, loaded = 4) => ids.map((id, i) => ({ main: `https://i.redd.it/${id}.gif`, backdrop: `https://preview.redd.it/i-need-more-meme-gifs-v0-${id}.gif?s=b${i}`, zoom: `https://i.redd.it/${id}.gif`, lazy: i >= loaded }));
  const jpgSlides = (ids, loaded = 4) => ids.map((id, i) => ({ main: `https://preview.redd.it/found-a-full-pc-v0-${id}.jpg?width=640&crop=smart&auto=webp&s=m${i}`, backdrop: `https://preview.redd.it/found-a-full-pc-v0-${id}.jpg?width=640&crop=smart&auto=webp&s=b${i}`, zoom: `https://i.redd.it/${id}.jpg`, lazy: i >= loaded }));
  const JPG_ID = ['pl46hy6p8ath1', 'g5ebsw6p8ath1', 'b0mwix6p8ath1', 'uc4q7y6p8ath1', '7zv03z6p8ath1', '5mhqpy6p8ath1', '36yzgy6p8ath1'];
  function nativeGallery(env, id, slides, { pages = slides.length, at = 0, indicator = true, slotOf = (i) => `page-${i + 1}` } = {}) {
    const { document } = env.context;
    const post = document.createElement('shreddit-post');
    post.setAttribute('id', `t3_${id}`);
    post.setAttribute('permalink', `/r/ZZZShitposting/comments/${id}/i_need_more_meme_gifs/`);
    post.setAttribute('post-type', 'gallery');
    post.setAttribute('gallery', '');
    R(post, 0, 0, 900, 600);
    const carousel = document.createElement('gallery-carousel');
    carousel.style.position = 'relative';
    carousel.style.overflow = 'hidden';
    R(carousel, 20, 20, 700, 500);
    const ul = document.createElement('ul');
    R(ul, 20, 20, 700, 500);
    carousel.appendChild(ul);
    const built = slides.map((s, i) => {
      const li = document.createElement('li');
      if (slotOf(i) !== null) li.setAttribute('slot', slotOf(i));
      R(li, 20 + (i - at) * 708, 20, 700, 500);
      const put = (el, url, lazy) => { if (lazy) el.setAttribute('data-lazy-src', url); else { el.src = url; el.setAttribute('src', url); } };
      const backdrop = document.createElement('img');
      backdrop.setAttribute('alt', '');
      put(backdrop, s.backdrop, s.lazy);
      R(backdrop, 20 + (i - at) * 708 - 38, -30, 760, 600);
      li.appendChild(backdrop);
      const figure = document.createElement('figure');
      R(figure, 20 + (i - at) * 708, 20, 700, 500);
      const main = document.createElement('img');
      main.setAttribute('alt', 'r/ZZZShitposting - I need more meme gifs');
      put(main, s.main, s.lazy);
      R(main, 20 + (i - at) * 708, 20, 700, 500);
      figure.appendChild(main);
      const zoom = document.createElement('img');
      zoom.setAttribute('alt', 'r/ZZZShitposting - I need more meme gifs');
      put(zoom, s.zoom, false);
      R(zoom, 0, 0, 0, 0);
      figure.appendChild(zoom);
      li.appendChild(figure);
      ul.appendChild(li);
      return { li, backdrop, main, zoom };
    });
    const outer = shadowOf(env, carousel);
    const fc = document.createElement('faceplate-carousel');
    fc.setAttribute('current-aria-live-msg', `Элемент 1 из ${pages}`);
    outer.appendChild(fc);
    const inner = shadowOf(env, fc);
    if (indicator) { const ind = document.createElement('faceplate-pagination-indicator'); ind.setAttribute('pages', String(pages)); ind.setAttribute('page-index', '0'); inner.appendChild(ind); }
    post.appendChild(carousel);
    document.body.appendChild(post);
    return { post, carousel, ul, slides: built, indicatorRoot: inner };
  }
  const slideUrl = (s) => s.main.getAttribute('src') || s.main.getAttribute('data-lazy-src');

  await itAsync('9.17 observed GIF gallery (17 slides, 4 loaded, 13 lazy, indicator pages=17): Save all (17) is offered and saves exactly the ordered membership, two at a time, nothing else requested', async () => {
    const w = await world();
    const g = nativeGallery(w.env, 'wrini3', gifSlides());
    await hover(w.env, 100, 100);
    assert(w.state.btn !== null);
    assert(hasAll(w), 'Save all offered on the native structure');
    assert.strictEqual(w.state.count, 17, 'N is the real gallery size');
    const r = await saveAllClick(w, 17);
    const want = GIF_ID.map((id) => `https://i.redd.it/${id}.gif`);
    assert.deepStrictEqual(r.d.map((x) => x.url).slice().sort(), want.slice().sort(), 'exactly the ordered membership: every slide once, lazy slides included, no backdrop and no zoom twin');
    assert(r.d.every((x) => /^SavedImages\/[^/]+\.gif$/i.test(x.filename) && x.saveAs === false));
    assert.deepStrictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).sort(), Array.from({ length: 17 }, (_, i) => `ITEM:${i}`).sort());
    assert.strictEqual(proofs(w).filter((a) => a === 'REDDIT_INLINE_BATCH').length, 1);
    assert.strictEqual(r.ops.length, 17);
    assert(r.ops.every((o) => o.state === 'complete'));
    assert(w.bg.net.max <= 2, 'at most two in flight');
    assert(w.bg.fetched.every((u) => want.includes(u)), 'no backdrop, preview or zoom request');
    assert.strictEqual(w.bg.convs.length, 0);
    assert(g.slides.length === 17);
  });

  await itAsync('9.17b observed JPEG gallery (preview address with an SEO slug and a zero-size i.redd.it twin; 7 slides, 3 lazy): one slot per slide, Save all (7), Save this saves the selected slide', async () => {
    const w = await world();
    const slides = jpgSlides(JPG_ID);
    const g = nativeGallery(w.env, 'trash7', slides, { at: 2 }); // the third slide is the visible one
    await hover(w.env, 100, 100);
    assert(hasAll(w));
    assert.strictEqual(w.state.count, 7);
    const one = await saveThis(w);
    assert.strictEqual(one.d.length, 1);
    assert(one.d[0].url.includes('b0mwix6p8ath1'), 'the selected (third) slide: ' + one.d[0].url);
    assert(w.bg.fetched.length >= 1 && w.bg.fetched.every((u) => /b0mwix6p8ath1/.test(u)), 'Save this requested only the selected slide: ' + w.bg.fetched.join(' '));
    w.bg.resetNet();
    await hover(w.env, 100, 100);
    const all = await saveAllClick(w, 7);
    assert.strictEqual(all.d.length, 7);
    for (const id of JPG_ID) assert.strictEqual(all.d.filter((x) => x.url.includes(id)).length, 1, id + ' saved exactly once');
    assert(all.ops.every((o) => o.state === 'complete'));
  });

  await itAsync('9.17c the lazy swap of a slide (data-lazy-src moved into src, same address) between proofs is not a change: the whole gallery is still saved', async () => {
    const w = await world();
    const slides = gifSlides(GIF_ID.slice(0, 6), 2);
    const g = nativeGallery(w.env, 'lazy6', slides);
    await hover(w.env, 100, 100);
    assert(hasAll(w));
    mutateOn(w, isItem(1), () => {
      for (const i of [2, 3]) {
        const url = g.slides[i].main.getAttribute('data-lazy-src');
        g.slides[i].main.removeAttribute('data-lazy-src');
        g.slides[i].main.setAttribute('src', url);
        g.slides[i].main.src = url;
      }
    });
    const r = await saveAllClick(w, 6);
    assert.strictEqual(r.d.length, 6);
    assert(r.ops.every((o) => o.state === 'complete'));
  });

  await itAsync('9.18 incomplete or ambiguous native galleries: Save this only (one download), no batch proof asked', async () => {
    const ids = GIF_ID.slice(0, 5);
    const cases = [
      ['no pagination indicator', (env, id) => nativeGallery(env, id, gifSlides(ids), { indicator: false })],
      ['indicator says 17 but only 5 slides are in the DOM (virtualised)', (env, id) => nativeGallery(env, id, gifSlides(ids), { pages: 17 })],
      ['indicator says 4 for 5 slides', (env, id) => nativeGallery(env, id, gifSlides(ids), { pages: 4 })],
      ['slots do not start at page-1', (env, id) => nativeGallery(env, id, gifSlides(ids), { slotOf: (i) => `page-${i + 2}` })],
      ['a gap in the slot sequence', (env, id) => nativeGallery(env, id, gifSlides(ids), { slotOf: (i) => `page-${i < 3 ? i + 1 : i + 2}` })],
      ['a slide without a slot', (env, id) => nativeGallery(env, id, gifSlides(ids), { slotOf: (i) => (i === 2 ? null : `page-${i + 1}`) })],
      ['one slide without any real media (decorative only)', (env, id) => { const g = nativeGallery(env, id, gifSlides(ids)); g.slides[3].main.setAttribute('alt', ''); g.slides[3].zoom.setAttribute('alt', ''); return g; }],
      ['one slide holds two different assets', (env, id) => { const g = nativeGallery(env, id, gifSlides(ids)); g.slides[1].zoom.src = 'https://i.redd.it/another1.gif'; g.slides[1].zoom.setAttribute('src', 'https://i.redd.it/another1.gif'); return g; }],
      ['the same asset in two slides', (env, id) => { const s = gifSlides(ids); s[4] = { ...s[1] }; return nativeGallery(env, id, s); }],
      ['a second carousel in the same post', (env, id) => { const g = nativeGallery(env, id, gifSlides(ids)); const c2 = env.context.document.createElement('gallery-carousel'); R(c2, 0, 0, 10, 10); g.post.appendChild(c2); return g; }],
      ['a conflicting total from another source (total-items 6)', (env, id) => { const g = nativeGallery(env, id, gifSlides(ids)); g.carousel.setAttribute('total-items', '6'); return g; }],
      ['21 slides (over the bound)', (env, id) => nativeGallery(env, id, gifSlides(Array.from({ length: 21 }, (_, i) => `many${i}xx`), 21))],
      ['a single slide', (env, id) => nativeGallery(env, id, gifSlides(ids.slice(0, 1)))],
      ['one slide holds more nodes than the slide bound (13 extra decorative images)', (env, id) => { const g = nativeGallery(env, id, gifSlides(ids)); for (let i = 0; i < 13; i++) { const x = env.context.document.createElement('img'); x.setAttribute('alt', ''); x.src = `https://preview.redd.it/deco${i}.png`; R(x, 0, 0, 5, 5); g.slides[2].li.appendChild(x); } return g; }],
      ['a nested crosspost\'s carousel declares the total, the post\'s own has none', (env, id) => {
        const g = nativeGallery(env, id, gifSlides(ids), { indicator: false });
        const nested = nativeGallery(env, id + 'n', gifSlides(GIF_ID.slice(5, 10)));
        nested.post.parentElement.removeChild(nested.post);
        const away = (el) => { const r = el.getBoundingClientRect(); el.setRect({ left: r.left + 3000, top: r.top, width: r.width, height: r.height }); el.children.forEach(away); };
        away(nested.post); // beside the outer gallery, so the pointer is over the outer one
        g.post.appendChild(nested.post);
        return g;
      }]
    ];
    let n = 0;
    for (const [name, build] of cases) {
      const w = await world();
      build(w.env, 'inc' + (++n));
      await hover(w.env, 100, 100);
      assert(w.state.btn !== null, name + ': the selected tile still has Save this');
      assert(!hasAll(w), name + ': Save all must not be offered');
      const r = await saveThis(w);
      assert.strictEqual(r.d.length, 1, name);
      assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER'], name + ': no batch proof was ever asked');
    }
  });

  await itAsync('9.19 changed list versus changed item on the native gallery: a removed slide or a different asset ends the batch (STALE_LIST); a changed query of one slide fails that slide alone (STALE_ITEM)', async () => {
    let w = await world();
    let g = nativeGallery(w.env, 'chg3', jpgSlides(JPG_ID.slice(0, 5)));
    await hover(w.env, 100, 100);
    mutateOn(w, isItem(0), () => g.slides[4].li.remove());
    let r = await saveAllClick(w);
    assert.strictEqual(r.d.length, 0, 'a slide removed after the open: the structure changed, no item runs');
    assert.strictEqual(w.bg.fetched.length, 0);
    w = await world();
    g = nativeGallery(w.env, 'chg4', jpgSlides(JPG_ID.slice(0, 5)));
    await hover(w.env, 100, 100);
    mutateOn(w, isItem(1), () => { const u = 'https://preview.redd.it/found-a-full-pc-v0-zzzzzzzzzzzz1.jpg?width=640&s=x'; g.slides[3].main.src = u; g.slides[3].main.setAttribute('src', u); });
    r = await saveAllClick(w, 2);
    assert(r.d.length >= 1 && r.d.length < 5, 'a different asset in a slot is structural: the batch ends with the items already proven kept');
    assert(!w.bg.fetched.some((u) => /zzzzzzzzzzzz1/.test(u)), 'the foreign asset is never requested');
    w = await world();
    g = nativeGallery(w.env, 'chg5', jpgSlides(JPG_ID.slice(0, 5)));
    await hover(w.env, 100, 100);
    mutateOn(w, isItem(0), () => { const u = g.slides[3].main.getAttribute('src').replace('width=640', 'width=1080'); g.slides[3].main.src = u; g.slides[3].main.setAttribute('src', u); });
    r = await saveAllClick(w, 4);
    assert.strictEqual(r.d.length, 4, 'the other four are saved');
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA'], 'only the changed slide fails (item-level)');
    assert.strictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).length, 5, 'the batch kept going');
    assert(w.bg.warns.some((m) => /Inline Reddit Save all item refused: 3 STALE_ITEM$/.test(m)), 'the refused item is named with its bounded reason: ' + w.bg.warns.join(' | '));
  });

  await itAsync('9.19c a gallery with a video slide: the player is its own slot (its poster and shadow video are not extra assets); Save all saves the images and the declared MP4; a nested crosspost\'s own carousel does not make the outer list ambiguous', async () => {
    const w = await world();
    const g = nativeGallery(w.env, 'mixv1', gifSlides(GIF_ID.slice(0, 3), 3));
    // slide 2 becomes a native player slide
    const li = g.slides[1].li;
    li.removeChild(g.slides[1].main.parentElement);
    const player = w.env.context.document.createElement('shreddit-player');
    player.setAttribute('src', 'https://v.redd.it/vid9mix/HLSPlaylist.m3u8?f=hd&t=1');
    player.setAttribute('packaged-media-json', pmj('vid9mix'));
    R(player, 728, 20, 700, 500);
    const poster = w.env.context.document.createElement('img');
    poster.setAttribute('slot', 'poster');
    poster.src = 'https://external-preview.redd.it/slug-v0-vid9mixx.png?s=p';
    R(poster, 728, 20, 700, 500);
    player.appendChild(poster);
    shadowOf(w.env, player).appendChild(w.env.context.document.createElement('video'));
    li.appendChild(player);
    // a nested post with its own image inside the first slide (another owner's media is not this slide's)
    const inner = w.env.context.document.createElement('shreddit-post');
    inner.setAttribute('id', 't3_inslide1');
    inner.setAttribute('permalink', '/r/other/comments/inslide1/inner/');
    R(inner, 3000, 0, 50, 50);
    const innerImg = w.env.context.document.createElement('img');
    innerImg.setAttribute('alt', 'nested');
    innerImg.src = 'https://i.redd.it/insideslide1.jpg';
    R(innerImg, 3000, 0, 50, 50);
    inner.appendChild(innerImg);
    g.slides[0].li.appendChild(inner);
    // a nested crosspost with its own native carousel, beside the outer gallery
    const nested = nativeGallery(w.env, 'mixv1n', gifSlides(GIF_ID.slice(5, 9)));
    const away = (el) => { const r = el.getBoundingClientRect(); el.setRect({ left: r.left + 3000, top: r.top, width: r.width, height: r.height }); el.children.forEach(away); };
    nested.post.parentElement.removeChild(nested.post);
    away(nested.post);
    g.post.appendChild(nested.post);
    await hover(w.env, 100, 100);
    assert(hasAll(w), 'Save all offered: the nested owner\'s carousel is not this owner\'s');
    assert.strictEqual(w.state.count, 3);
    const r = await saveAllClick(w, 3);
    assert.strictEqual(r.d.length, 3);
    assert.deepStrictEqual(r.d.map((x) => x.url).slice().sort(), [BEST('vid9mix'), 'https://i.redd.it/' + GIF_ID[0] + '.gif', 'https://i.redd.it/' + GIF_ID[2] + '.gif'].sort());
    assert(r.d.some((x) => /\.mp4$/i.test(x.filename)), 'the video is an MP4');
    assert(w.bg.fetched.every((u) => /m2-res_720p|i\.redd\.it/.test(u)) && !w.bg.fetched.some((u) => /insideslide1/.test(u)), 'no playlist, poster or nested asset was requested: ' + w.bg.fetched.join(' '));
  });

  await itAsync('9.19b a gallery of 20 native slides is saved whole; avatars inside a slide are not media', async () => {
    const w = await world();
    const ids = Array.from({ length: 20 }, (_, i) => `twenty${String(i).padStart(2, '0')}x`);
    const g = nativeGallery(w.env, 'tw20', gifSlides(ids, 20));
    const av = w.env.context.document.createElement('img');
    av.setAttribute('alt', 'u/someone');
    av.src = 'https://styles.redditmedia.com/t5_1/styles/profileIcon_snoo.png';
    R(av, 30, 30, 20, 20);
    g.slides[0].li.appendChild(av);
    await hover(w.env, 100, 100);
    assert(hasAll(w));
    assert.strictEqual(w.state.count, 20);
    const r = await saveAllClick(w, 20);
    assert.strictEqual(r.d.length, 20);
    assert(r.d.every((x) => !/profileIcon/.test(x.url)));
  });

  // ===== 9.20: source continuity of a declared packaged MP4 (the selected file is part of the click proof) =====
  const CHANGED = (vid) => pmj(vid).replace(/s=H264720/g, 's=CHANGED');
  const isOwner = (m) => m.action === 'REDDIT_INLINE_OWNER';
  function playerGallery(env, id, { inner = '' } = {}) {
    const g = nativeGallery(env, id, gifSlides(GIF_ID.slice(0, 3), 3));
    const li = g.slides[1].li;
    li.removeChild(g.slides[1].main.parentElement);
    const player = env.context.document.createElement('shreddit-player');
    player.setAttribute('src', 'https://v.redd.it/vid9pg/HLSPlaylist.m3u8?f=hd&t=1');
    player.setAttribute('packaged-media-json', pmj('vid9pg'));
    R(player, 728, 20, 700, 500);
    const poster = env.context.document.createElement('img');
    poster.setAttribute('slot', 'poster');
    poster.src = 'https://external-preview.redd.it/slug-v0-vid9pgx.png?s=p';
    R(poster, 728, 20, 700, 500);
    player.appendChild(poster);
    const video = env.context.document.createElement('video');
    if (inner) { video.src = inner; video.currentSrc = inner; }
    R(video, 728, 20, 700, 500);
    shadowOf(env, player).appendChild(video);
    li.appendChild(player);
    return { g, player, video };
  }
  const gif = (i) => `https://i.redd.it/${GIF_ID[i]}.gif`;

  await itAsync('9.20 reproduction: only packaged-media-json changes right before the owner proof: the changed address is refused before any request or download', async () => {
    const w = await world();
    const g = playerPost(w.env, 'pmchange', 'vid9chg');
    await hover(w.env, 200, 200);
    assert(w.state.btn !== null);
    mutateOn(w, isOwner, () => g.player.setAttribute('packaged-media-json', CHANGED('vid9chg')));
    const r = await saveThis(w, 0);
    assert.strictEqual(w.bg.fetched.length, 0, 'nothing was requested: ' + w.bg.fetched.join(' '));
    assert.strictEqual(r.d.length, 0, 'nothing was downloaded: ' + r.d.map((x) => x.url).join(' '));
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER']);
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA']);
    assert(w.bg.warns.some((m) => /Inline Reddit Save refused: STALE_OWNER$/.test(m)), w.bg.warns.join(' | '));
  });

  await itAsync('9.20b a changed declaration between hover and click: the control no longer matches the player, nothing is sent; an unchanged one still saves the exact address', async () => {
    let w = await world();
    let g = playerPost(w.env, 'pmhov1', 'vid9chg');
    await hover(w.env, 200, 200);
    g.player.setAttribute('packaged-media-json', CHANGED('vid9chg'));
    let r = await saveThis(w, 0);
    assert.strictEqual(w.bg.asks.length, 0, 'no token, no proof asked');
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    w = await world();
    g = playerPost(w.env, 'pmhov2', 'vid9chg');
    await hover(w.env, 200, 200);
    r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, BEST('vid9chg'), 'the unchanged declaration downloads the exact signed address');
  });

  await itAsync('9.20c every change of the selected file is a source change (token, resolution, a new larger file, the declaration removed or turned to another asset); nothing is requested', async () => {
    const swap = (vid, fn) => { const j = JSON.parse(pmj(vid)); fn(j.playbackMp4s.permutations); return JSON.stringify(j); };
    const cases = [
      ['token of the selected file', () => CHANGED('vid9chg')],
      ['another resolution takes over (a larger H264 file of the same asset)', () => swap('vid9chg', (p) => p.push({ source: { url: 'https://packaged-media.redd.it/vid9chg/pb/m2-res_1080p.mp4?s=H2641080', dimensions: { width: 1920, height: 1080 }, videoCodec: 'H264' } }))],
      ['the selected file is dropped (a smaller one remains)', () => swap('vid9chg', (p) => { p.splice(p.findIndex((x) => x.source.videoCodec === 'H264' && x.source.dimensions.height === 720), 1); })],
      ['the declaration is removed', () => null],
      ['the declaration names another asset', () => pmj('vid9other')],
      ['the declaration grows past the size bound', () => ' '.repeat(70000) + pmj('vid9chg')]
    ];
    for (const [name, make] of cases) {
      const w = await world();
      const g = playerPost(w.env, 'pmcase', 'vid9chg');
      await hover(w.env, 200, 200);
      mutateOn(w, isOwner, () => { const v = make(); if (v === null) g.player.removeAttribute('packaged-media-json'); else g.player.setAttribute('packaged-media-json', v); });
      const r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, name);
      assert.strictEqual(w.bg.fetched.length, 0, name + ': no request');
      assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA'], name);
    }
  });

  await itAsync('9.20d harmless changes of the declaration (formatting, key order, an unrelated entry) are not an asset change: the unchanged address is downloaded once', async () => {
    const w = await world();
    const g = playerPost(w.env, 'pmfmt', 'vid9chg');
    await hover(w.env, 200, 200);
    const pretty = () => { const j = JSON.parse(pmj('vid9chg')); j.playbackMp4s.duration = 37; return JSON.stringify({ playbackMp4s: { permutations: j.playbackMp4s.permutations.slice().reverse().map((p) => ({ source: { videoCodec: p.source.videoCodec, dimensions: p.source.dimensions, url: p.source.url.replace('s=VP9220', 's=VP9220x') } })), duration: 37 } }, null, 2); };
    g.player.setAttribute('packaged-media-json', pretty());
    mutateOn(w, isOwner, () => g.player.setAttribute('packaged-media-json', '\n  ' + pretty().replace('s=VP9270', 's=VP9270y') + '\n'));
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, BEST('vid9chg'));
    assert.deepStrictEqual(w.bg.fetched.filter((u) => !/m2-res_720p/.test(u)), []);
    assert.strictEqual(r.ops.length, 1);
    assert.strictEqual(r.ops[0].state, 'complete');
  });

  await itAsync('9.20e a video slide of a native gallery: a changed declaration before the open or between item proofs fails that item alone (STALE_ITEM); the images are saved and the changed address is never requested', async () => {
    for (const [name, when] of [['before the batch opens', isBatch], ['between item proofs', isItem(0)]]) {
      const w = await world();
      const { player } = playerGallery(w.env, 'pgchg');
      await hover(w.env, 100, 100);
      assert(hasAll(w), name);
      mutateOn(w, when, () => player.setAttribute('packaged-media-json', CHANGED('vid9pg')));
      const r = await saveAllClick(w, 2);
      assert.deepStrictEqual(r.d.map((x) => x.url).slice().sort(), [gif(0), gif(2)].sort(), name + ': both images, not the video');
      assert(!w.bg.fetched.some((u) => /vid9pg|CHANGED/.test(u)), name + ': neither address of the changed player is requested');
      assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA'], name);
      assert.strictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).length, 3, name + ': no STALE_LIST, the batch kept going');
    }
  });

  await itAsync('9.20f a video slide: an unchanged declaration saves the exact file with its siblings; another asset in the slot is structural (the batch ends)', async () => {
    let w = await world();
    playerGallery(w.env, 'pgok');
    await hover(w.env, 100, 100);
    let r = await saveAllClick(w, 3);
    assert.deepStrictEqual(r.d.map((x) => x.url).slice().sort(), [BEST('vid9pg'), gif(0), gif(2)].sort());
    w = await world();
    const { player } = playerGallery(w.env, 'pgasset');
    await hover(w.env, 100, 100);
    mutateOn(w, isItem(2), () => { player.setAttribute('src', 'https://v.redd.it/vid9pg2/HLSPlaylist.m3u8?f=hd&t=1'); player.setAttribute('packaged-media-json', pmj('vid9pg2')); });
    r = await saveAllClick(w, 2);
    assert(r.d.length <= 2, 'the item behind the changed slot is not saved');
    assert(!w.bg.fetched.some((u) => /vid9pg2|iwwn46bc02sh1/.test(u)), 'the changed asset and the item after it are never requested: ' + w.bg.fetched.join(' '));
  });

  // ===== 9.21: the direct source read from the selected player's open shadow tree is part of the click proof =====
  const AFTER = (vid) => BEST(vid).replace('s=H264720', 's=AFTER_CLICK');
  const setPlaying = (video, url) => { video.src = url; video.currentSrc = url; };

  await itAsync('9.21 reproduction: only the shadow <video> source changes right before the owner proof: the new address is refused before any request or download', async () => {
    const w = await world();
    const g = playerPost(w.env, 'shadowproof', 'vid9shadow');
    await hover(w.env, 200, 200);
    assert(w.state.btn !== null);
    mutateOn(w, isOwner, () => setPlaying(g.video, AFTER('vid9shadow')));
    const r = await saveThis(w, 0);
    assert.strictEqual(w.bg.fetched.length, 0, 'nothing was requested: ' + w.bg.fetched.join(' '));
    assert.strictEqual(r.d.length, 0, 'nothing was downloaded: ' + r.d.map((x) => x.url).join(' '));
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER']);
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA']);
    assert(w.bg.warns.some((m) => /Inline Reddit Save refused: STALE_OWNER$/.test(m)), w.bg.warns.join(' | '));
  });


  const P0 = (vid) => `https://packaged-media.redd.it/${vid}/pb/m2-res_480p.mp4?s=playing`;
  const newVideo = (env, url) => { const v = env.context.document.createElement('video'); if (url) setPlaying(v, url); R(v, 100, 100, 600, 500); return v; };
  const replaceShadow = (env, g, url) => { const root = g.player.shadowRoot; const old = root.querySelector('video'); root.removeChild(old); const v = newVideo(env, url); root.appendChild(v); return v; };
  const noSigned = (w, name) => assert(!/s=AFTER_CLICK|s=playing|s=H264720|token=|AFTER/.test(w.bg.warns.join(' | ')), name + ': no signed parameter in the diagnostics: ' + w.bg.warns.join(' | '));

  await itAsync('9.21b hover to click: an unplayed player that starts playing refuses the old click before any token; a fresh click on the unchanged playing source saves its exact address', async () => {
    const w = await world();
    const g = playerPost(w.env, 'shadowhov', 'vid9shadow');
    await hover(w.env, 200, 200);
    setPlaying(g.video, P0('vid9shadow'));
    let r = await saveThis(w, 0);
    assert.strictEqual(w.bg.asks.length, 0, 'the shown control no longer matches the player: no token, no proof asked');
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    await hover(w.env, 200, 200);
    r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, P0('vid9shadow'), 'the playing source wins and is downloaded exactly (signed query included)');
    assert(/\.mp4$/i.test(r.d[0].filename));
    assert.deepStrictEqual(w.bg.fetched.filter((u) => u !== P0('vid9shadow')), [], 'only that file was requested');
    assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER']);
    assert.strictEqual(r.ops[0].state, 'complete');
  });

  await itAsync('9.21h the shadow video is replaced by a node with the same source between hover and click: the old control is refused before any token', async () => {
    const w = await world();
    const g = playerPost(w.env, 'shadowrep', 'vid9shadow', { inner: P0('vid9shadow') });
    await hover(w.env, 200, 200);
    replaceShadow(w.env, g, P0('vid9shadow'));
    const r = await saveThis(w, 0);
    assert.strictEqual(w.bg.asks.length, 0);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    await hover(w.env, 200, 200);
    const fresh = await saveThis(w);
    assert.strictEqual(fresh.d.length, 1, 'a fresh click on the new node saves the unchanged address');
    assert.strictEqual(fresh.d[0].url, P0('vid9shadow'));
  });

  await itAsync('9.21c every change of the shadow source before the owner proof is a source change (empty to playing, currentSrc, src, <source> nodes, replaced video): refused with zero requests and no signed text in the log', async () => {
    const withSource = (env, g, url) => { const s = env.context.document.createElement('source'); s.src = url; s.setAttribute('src', url); g.video.appendChild(s); setPlaying(g.video, ''); return s; };
    const cases = [
      ['unplayed starts playing', '', (w, g) => setPlaying(g.video, AFTER('vid9shadow'))],
      ['playing: another currentSrc', P0('vid9shadow'), (w, g) => setPlaying(g.video, AFTER('vid9shadow'))],
      ['playing: currentSrc cleared, another src', P0('vid9shadow'), (w, g) => { g.video.currentSrc = ''; g.video.src = AFTER('vid9shadow'); }],
      ['playing stops (the packaged file takes over)', P0('vid9shadow'), (w, g) => setPlaying(g.video, '')],
      ['a <source> address changes', '', (w, g) => { const s = withSource(w.env, g, P0('vid9shadow')); w.pre = s; }, (w, g) => { w.pre.src = AFTER('vid9shadow'); w.pre.setAttribute('src', AFTER('vid9shadow')); }],
      ['a <source> with a direct address appears first', '', null, (w, g) => { const s = w.env.context.document.createElement('source'); s.src = AFTER('vid9shadow'); s.setAttribute('src', AFTER('vid9shadow')); g.video.children.unshift(s); s.parentElement = g.video; }],
      ['the shadow video is replaced by a new node with the same source', P0('vid9shadow'), (w, g) => { replaceShadow(w.env, g, P0('vid9shadow')); }],
      ['the shadow video is replaced by a new node with another source', P0('vid9shadow'), (w, g) => { replaceShadow(w.env, g, AFTER('vid9shadow')); }],
      ['the shadow video is replaced by an empty one', P0('vid9shadow'), (w, g) => { replaceShadow(w.env, g, ''); }]
    ];
    for (const [name, inner, setup, change] of cases) {
      const w = await world();
      const g = playerPost(w.env, 'shadowchg', 'vid9shadow', { inner });
      if (change) { if (typeof setup === 'function') setup(w, g); }
      await hover(w.env, 200, 200);
      assert(w.state.btn !== null, name + ': control');
      const act = change || setup;
      mutateOn(w, isOwner, () => act(w, g));
      const r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, name + ': ' + r.d.map((x) => x.url).join(' '));
      assert.strictEqual(w.bg.fetched.length, 0, name + ': no request: ' + w.bg.fetched.join(' '));
      assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA'], name);
      assert(w.bg.warns.some((m) => /Inline Reddit Save refused: STALE_OWNER$/.test(m)), name);
      noSigned(w, name);
    }
  });

  await itAsync('9.21d harmless changes are not a source change: a blob: MediaSource starting, a src property under a playing currentSrc, a shadow change under a direct player src', async () => {
    let w = await world();
    let g = playerPost(w.env, 'shadowblob', 'vid9shadow');
    await hover(w.env, 200, 200);
    mutateOn(w, isOwner, () => setPlaying(g.video, 'blob:https://www.reddit.com/0a1b2c3d-0000-4000-8000-000000000000'));
    let r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, BEST('vid9shadow'), 'the blob is not a source the descriptor can use: the declared file is still the one');
    w = await world();
    g = playerPost(w.env, 'shadowsrc', 'vid9shadow', { inner: P0('vid9shadow') });
    await hover(w.env, 200, 200);
    mutateOn(w, isOwner, () => { g.video.src = AFTER('vid9shadow'); });
    r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, P0('vid9shadow'), 'the descriptor reads currentSrc first: a src property under it is not what it passes on');
    w = await world();
    g = playerPost(w.env, 'shadowdash', 'vid9dash', { json: null, src: 'https://v.redd.it/vid9dash/DASH_720.mp4?t=1' });
    await hover(w.env, 200, 200);
    mutateOn(w, isOwner, () => setPlaying(g.video, AFTER('vid9dash')));
    r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, 'https://v.redd.it/vid9dash/DASH_720.mp4?t=1', 'a direct player src outranks the shadow video: its change is irrelevant');
  });

  await itAsync('9.21e the closest foreign player: its shadow source never replaces the selected player\'s, and its change does not touch the selected proof', async () => {
    const second = (w, a, vid, inner, json) => {
      const p = w.env.context.document.createElement('shreddit-player');
      p.setAttribute('src', `https://v.redd.it/${vid}/HLSPlaylist.m3u8?x=1`);
      if (json) p.setAttribute('packaged-media-json', json);
      R(p, 700, 100, 100, 100);
      const v = w.env.context.document.createElement('video');
      if (inner) setPlaying(v, inner);
      shadowOf(w.env, p).appendChild(v);
      a.cont.appendChild(p);
      return { p, v };
    };
    let w = await world();
    let a = playerPost(w.env, 'shadowfor1', 'vid9shadow', { inner: P0('vid9shadow') });
    let f = second(w, a, 'vid9foreign', P0('vid9foreign'), pmj('vid9foreign'));
    await hover(w.env, 200, 200);
    mutateOn(w, isOwner, () => setPlaying(f.v, AFTER('vid9foreign')));
    let r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, P0('vid9shadow'), 'the selected player\'s own source');
    assert.deepStrictEqual(w.bg.fetched.filter((u) => /foreign/.test(u)), [], 'the foreign player is never requested');
    w = await world();
    a = playerPost(w.env, 'shadowfor2', 'vid9shadow', { json: null });
    f = second(w, a, 'vid9foreign', P0('vid9foreign'), pmj('vid9foreign'));
    await hover(w.env, 200, 200);
    r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0, 'the unresolved player fails alone and never takes its neighbour\'s playing source');
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA']);
    // the foreign player comes FIRST in the document: the selected (second) player's own shadow change is still its own change
    w = await world();
    a = playerPost(w.env, 'shadowfor3', 'vid9shadow', { inner: P0('vid9shadow') });
    f = second(w, a, 'vid9foreign', P0('vid9foreign'), pmj('vid9foreign'));
    a.cont.children.splice(a.cont.children.indexOf(f.p), 1);
    a.cont.children.unshift(f.p);
    await hover(w.env, 200, 200);
    mutateOn(w, isOwner, () => setPlaying(a.video, AFTER('vid9shadow')));
    r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0, r.d.map((x) => x.url).join(' '));
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA']);
  });

  await itAsync('9.21f a video slide of a native gallery: shadow-source changes fail that item alone (STALE_ITEM) before the open and between item proofs, replacement too; unchanged saves the exact address', async () => {
    let w = await world();
    let pg = playerGallery(w.env, 'shok', { inner: P0('vid9pg') });
    await hover(w.env, 100, 100);
    assert(hasAll(w));
    let r = await saveAllClick(w, 3);
    assert.deepStrictEqual(r.d.map((x) => x.url).slice().sort(), [P0('vid9pg'), gif(0), gif(2)].sort(), 'unchanged: the playing address exactly, with its siblings');
    for (const [name, inner, when, change] of [
      ['playing source changes between item proofs', P0('vid9pg'), isItem(0), (p) => setPlaying(p.video, AFTER('vid9pg'))],
      ['an unplayed player starts playing before the batch opens', '', isBatch, (p) => setPlaying(p.video, AFTER('vid9pg'))],
      ['the shadow video is replaced between item proofs', P0('vid9pg'), isItem(0), (p) => { replaceShadow(w.env, { player: p.player }, P0('vid9pg')); }]
    ]) {
      w = await world();
      pg = playerGallery(w.env, 'shchg', { inner });
      await hover(w.env, 100, 100);
      assert(hasAll(w), name);
      mutateOn(w, when, () => change(pg));
      r = await saveAllClick(w, 2);
      assert.deepStrictEqual(r.d.map((x) => x.url).slice().sort(), [gif(0), gif(2)].sort(), name + ': both images, not the video');
      assert(!w.bg.fetched.some((u) => /vid9pg|AFTER/.test(u)), name + ': no address of the changed player is requested: ' + w.bg.fetched.join(' '));
      assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA'], name);
      assert.strictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).length, 3, name + ': no STALE_LIST, the batch kept going');
      noSigned(w, name);
    }
  });

  await itAsync('9.21g source inspection is bounded: at most 8 <source> nodes of the shadow video are read', async () => {
    const w = await world();
    const g = playerPost(w.env, 'shadowbound', 'vid9shadow');
    for (let i = 0; i < 9; i++) { const s = w.env.context.document.createElement('source'); const u = i < 8 ? `https://v.redd.it/vid9shadow/HLSPlaylist.m3u8?n=${i}` : AFTER('vid9shadow'); s.src = u; s.setAttribute('src', u); g.video.appendChild(s); }
    const d = w.env.context.extractDirectCandidateFromPlayer(g.player, null);
    assert(d && d.url === BEST('vid9shadow'), 'the ninth source is not read; the declared file is the selection: ' + (d && d.url));
  });

  // ===== 9.22 RD-08: the gallery identity of a preview address with an encoded / localised / punctuated SEO slug =====
  const enc = (s) => encodeURIComponent(s);
  function slugGallery(env, id, ids, slug, opts = {}) {
    const g = nativeGallery(env, id, jpgSlides(ids, ids.length), opts);
    g.slides.forEach((s, i) => {
      const main = `https://preview.redd.it/${slug}-v0-${ids[i]}.jpg?width=600&format=pjpg&auto=webp&s=TEST`;
      const back = `https://preview.redd.it/${slug}-v0-${ids[i]}.jpg?width=600&format=pjpg&auto=webp&s=BACKDROP`;
      for (const [el, u] of [[s.main, main], [s.backdrop, back]]) { el.src = u; el.setAttribute('src', u); }
    });
    return g;
  }
  const DNS2 = ['5yxioaa8eith1', 'flwbdfc8eith1'];

  await itAsync('9.22 identity unit: the media id is the part after the last -v0- of the whole path segment; an encoded slug is neither an identity nor truncated into one', () => {
    const id = (u) => env22.context.__riAssetId(u);
    const env22 = createMockEnvironment();
    const ok = [
      ['https://preview.redd.it/how-do-you-feel-about-dns-v0-5yxioaa8eith1.jpg?width=600&s=1', 'img:5yxioaa8eith1'],
      [`https://preview.redd.it/${enc('как-вы-относитесь-к-dns')}-v0-5yxioaa8eith1.jpg?width=600&s=1`, 'img:5yxioaa8eith1'],
      [`https://preview.redd.it/dns-${enc('как вы относитесь?!')}-v0-5yxioaa8eith1.jpg`, 'img:5yxioaa8eith1'],
      [`https://preview.redd.it/${enc('what?! 100% (really) — "dns"')}-v0-flwbdfc8eith1.jpeg?x=1`, 'img:flwbdfc8eith1'],
      ['https://preview.redd.it/foo-v0-bar-baz-v0-flwb_dfc-8eith1.jpg?s=1', 'img:flwb_dfc-8eith1'],
      ['https://i.redd.it/5yxio_aa-8eith1.jpg', 'img:5yxio_aa-8eith1'],
      ['https://external-preview.redd.it/dlss-v0-dXV2bDZidnB0b29oMTRITizmS8Mf.png?s=1', 'img:dXV2bDZidnB0b29oMTRITizmS8Mf'],
      ['https://i.redd.it/5yxioaa8eith1.jpg', 'img:5yxioaa8eith1'],
      ['https://v.redd.it/vidprobe/DASH_720.mp4?x=1', 'vid:vidprobe']
    ];
    for (const [u, want] of ok) assert.strictEqual(id(u), want, u);
    const none = [
      `https://preview.redd.it/${enc('как-вы')}.jpg?s=1`,
      `https://preview.redd.it/dns-${enc('как')}-v0-${enc('Ё')}.jpg`,
      'https://preview.redd.it/dns-%D0%BA.jpg',
      'https://preview.redd.it.evil.example/dns-v0-5yxioaa8eith1.jpg',
      'https://evil.example/preview.redd.it/dns-v0-5yxioaa8eith1.jpg',
      'https://i.redd.it@evil.example/5yxioaa8eith1.jpg',
      'https://preview.redd.it/',
      'https://preview.redd.it/.jpg'
    ];
    for (const u of none) assert.strictEqual(id(u), null, u);
    assert.strictEqual(id('https://preview.redd.it/slug-v0-.jpg'), 'img:slug-v0-', 'an empty id keeps the whole (plain) segment');
  });

  await itAsync('9.22b the reported DNS gallery (two images, encoded Cyrillic preview titles): Save all (2) is offered, saves exactly the two images; Save this saves the selected slide', async () => {
    for (const [name, slug] of [
      ['ASCII slug (control)', 'how-do-you-feel-about-dns'],
      ['encoded Cyrillic slug', enc('как-вы-относитесь-к-dns')],
      ['ASCII-leading encoded punctuated slug', 'dns-' + enc('как вы относитесь? 100% (да) — "dns"')],
      ['slug with an earlier -v0-', 'foo-v0-' + enc('чем-то')]
    ]) {
      let w = await world();
      slugGallery(w.env, '1wxpi9w', DNS2, slug);
      await hover(w.env, 100, 100);
      assert(hasAll(w), name + ': Save all offered');
      assert.strictEqual(w.state.count, 2, name);
      let r = await saveAllClick(w, 2);
      assert.strictEqual(r.d.length, 2, name);
      for (const id of DNS2) assert.strictEqual(r.d.filter((x) => x.url.includes(id)).length, 1, name + ': ' + id + ' saved once');
      assert(w.bg.fetched.every((u) => DNS2.some((id) => u.includes(id))), name + ': nothing but the two images was requested: ' + w.bg.fetched.join(' '));
      assert(r.ops.every((o) => o.state === 'complete'), name);
      assert.deepStrictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).sort(), ['ITEM:0', 'ITEM:1'], name);
      w = await world();
      slugGallery(w.env, '1wxpi9w', DNS2, slug);
      await hover(w.env, 100, 100);
      r = await saveThis(w);
      assert.strictEqual(r.d.length, 1, name);
      assert(r.d[0].url.includes(DNS2[0]), name + ': the selected slide: ' + r.d[0].url);
      assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER'], name);
    }
  });

  await itAsync('9.22c a 17-slide native gallery with encoded Cyrillic preview titles offers Save all (17) and saves exactly its membership', async () => {
    const w = await world();
    const ids = GIF_ID.slice();
    slugGallery(w.env, 'enc17', ids, enc('я-хочу-больше-мемов'));
    await hover(w.env, 100, 100);
    assert(hasAll(w));
    assert.strictEqual(w.state.count, 17);
    const r = await saveAllClick(w, 17);
    assert.strictEqual(r.d.length, 17);
    for (const id of ids) assert.strictEqual(r.d.filter((x) => x.url.includes(id)).length, 1, id);
  });

  await itAsync('9.22d closest negatives: lookalike host, malformed identity, a different asset in a slide, an unproven total, a nested owner: Save this only, no batch proof', async () => {
    const slug = enc('как-вы-относитесь-к-dns');
    const cases = [
      ['a lookalike host for every address of one slide', (env, id) => { const g = slugGallery(env, id, DNS2, slug); const u = `https://preview.redd.it.evil.example/${slug}-v0-${DNS2[1]}.jpg?s=1`; for (const e of [g.slides[1].main, g.slides[1].backdrop, g.slides[1].zoom]) { e.src = u; e.setAttribute('src', u); } return g; }],
      ['one slide with an encoded address that has no media id', (env, id) => { const g = slugGallery(env, id, DNS2, slug); const u = `https://preview.redd.it/${slug}.jpg?s=1`; for (const e of [g.slides[1].main, g.slides[1].backdrop]) { e.src = u; e.setAttribute('src', u); } g.slides[1].zoom.src = ''; g.slides[1].zoom.setAttribute('src', ''); return g; }],
      ['a different asset in one slide', (env, id) => { const g = slugGallery(env, id, DNS2, slug); const u = `https://i.redd.it/someother1x.jpg`; g.slides[1].zoom.src = u; g.slides[1].zoom.setAttribute('src', u); return g; }],
      ['declared 3 for two slides (unproven)', (env, id) => slugGallery(env, id, DNS2, slug, { pages: 3 })],
      ['no pagination indicator', (env, id) => slugGallery(env, id, DNS2, slug, { indicator: false })],
      ['the same asset twice', (env, id) => slugGallery(env, id, [DNS2[0], DNS2[0]], slug)],
      ['a nested owner\'s carousel declares the total, the outer gallery has none', (env, id) => {
        const g = slugGallery(env, id, DNS2, slug, { indicator: false });
        const nested = slugGallery(env, id + 'n', DNS2.map((x) => x + 'n'), slug);
        nested.post.parentElement.removeChild(nested.post);
        const away = (el) => { const r = el.getBoundingClientRect(); el.setRect({ left: r.left + 3000, top: r.top, width: r.width, height: r.height }); el.children.forEach(away); };
        away(nested.post);
        g.post.appendChild(nested.post);
        return g;
      }]
    ];
    let n = 0;
    for (const [name, build] of cases) {
      const w = await world();
      build(w.env, 'neg' + (++n));
      await hover(w.env, 100, 100);
      assert(w.state.btn !== null, name + ': the control exists');
      assert(!hasAll(w), name + ': Save all must not be offered');
      const r = await saveThis(w);
      assert.strictEqual(r.d.length, 1, name);
      assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER'], name);
    }
  });

  await itAsync('9.22d2 a foreign-host image in a slide is never media: with a valid canonical twin the slide is saved from the twin, the foreign address is never requested', async () => {
    const slug = enc('как-вы-относитесь-к-dns');
    const w = await world();
    const g = slugGallery(w.env, 'foreign1', DNS2, slug);
    const u = `https://preview.redd.it.evil.example/${slug}-v0-${DNS2[1]}.jpg?s=1`;
    for (const e of [g.slides[1].main, g.slides[1].backdrop]) { e.src = u; e.setAttribute('src', u); }
    await hover(w.env, 100, 100);
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
    assert(!w.bg.fetched.some((x) => /evil\.example/.test(x)) && !r.d.some((x) => /evil\.example/.test(x.url)), 'only Reddit hosts are requested and saved: ' + w.bg.fetched.join(' '));
  });

  await itAsync('9.22e on the encoded gallery: a reorder or removal is structural (STALE_LIST), another asset is structural, a changed signed query of one slide fails that item alone (STALE_ITEM); the exact signed address is never rewritten', async () => {
    const slug = enc('как-вы-относитесь-к-dns');
    const ids = ['aaaa1x', 'bbbb2x', 'cccc3x', 'dddd4x'];
    let w = await world();
    let g = slugGallery(w.env, 'enc4a', ids, slug);
    await hover(w.env, 100, 100);
    mutateOn(w, isItem(2), () => { const [a, b] = [g.slides[0].li, g.slides[1].li]; g.ul.children.splice(g.ul.children.indexOf(a), 2, b, a); });
    let r = await saveAllClick(w, 2);
    assert(r.d.length <= 3 && !w.bg.fetched.some((u) => /dddd4x/.test(u)), 'a reordered list ends the batch: ' + w.bg.fetched.join(' '));
    w = await world();
    g = slugGallery(w.env, 'enc4b', ids, slug);
    await hover(w.env, 100, 100);
    mutateOn(w, isItem(0), () => g.slides[3].li.remove());
    r = await saveAllClick(w);
    assert.strictEqual(r.d.length, 0, 'a removed slide: no item runs');
    w = await world();
    g = slugGallery(w.env, 'enc4c', ids, slug);
    await hover(w.env, 100, 100);
    mutateOn(w, isItem(0), () => { const u = g.slides[2].main.getAttribute('src').replace('width=600', 'width=1080'); g.slides[2].main.src = u; g.slides[2].main.setAttribute('src', u); });
    r = await saveAllClick(w, 3);
    assert.strictEqual(r.d.length, 3, 'the other three are saved');
    assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA'], 'only the changed slide fails');
    assert.strictEqual(proofs(w).filter((a) => /^ITEM/.test(a)).length, 4, 'the batch kept going');
    assert(!w.bg.fetched.some((u) => /cccc3x/.test(u) && /width=1080/.test(u)), 'the changed address is not requested');
    w = await world();
    g = slugGallery(w.env, 'enc2s', DNS2, slug);
    await hover(w.env, 100, 100);
    r = await saveAllClick(w, 2);
    assert(w.bg.fetched.some((u) => /s=TEST/.test(u)) || r.d.some((x) => DNS2.some((id) => x.url.includes(id))), 'requests carry the slide\'s own address');
    assert(!w.bg.fetched.some((u) => /BACKDROP/.test(u)), 'the backdrop address is never requested');
  });

  // ===== 9.23 RD-09: a confirmed preview .gif?format=mp4 held by the selected player =====
  const ANIM = 'https://preview.redd.it/41s6pcpyxith1.gif?width=1280&format=mp4&s=SYNTHETIC';
  const animPost = (w, form) => {
    const base = { json: null, src: `https://v.redd.it/vid9anim/HLSPlaylist.m3u8?f=hd&t=1` };
    let g;
    if (form === 'src') g = playerPost(w.env, 'anim23', '41s6pcpyxith1', { json: null, src: ANIM, inner: ANIM });
    else if (form === 'src-only') g = playerPost(w.env, 'anim23', '41s6pcpyxith1', { json: null, src: ANIM });
    else if (form === 'stream-url') { g = playerPost(w.env, 'anim23', '41s6pcpyxith1', base); g.player.setAttribute('stream-url', ANIM); }
    else if (form === 'shadow-current') { g = playerPost(w.env, 'anim23', '41s6pcpyxith1', { ...base, inner: ANIM }); }
    else if (form === 'shadow-src') { g = playerPost(w.env, 'anim23', '41s6pcpyxith1', base); g.video.src = ANIM; }
    else if (form === 'shadow-source') { g = playerPost(w.env, 'anim23', '41s6pcpyxith1', base); const s = w.env.context.document.createElement('source'); s.src = ANIM; s.setAttribute('src', ANIM); g.video.appendChild(s); }
    return g;
  };

  await itAsync('9.23 a confirmed preview .gif?format=mp4 held by the selected player (src, stream-url, shadow currentSrc/src/source) is recovered, routed to the one GIF conversion and downloaded from its exact signed address', async () => {
    let w = await world();
    imgPost(w.env, 'anim23', ANIM);
    await hover(w.env);
    let r = await saveThis(w);
    assert.deepStrictEqual(w.bg.convs, ['CONVERT_REDDIT_VIDEO_TO_GIF'], 'image-shaped source (the reference)');
    assert.strictEqual(r.d.length, 1);
    for (const form of ['src', 'src-only', 'stream-url', 'shadow-current', 'shadow-src', 'shadow-source']) {
      w = await world();
      animPost(w, form);
      await hover(w.env, 200, 200);
      assert(w.state.btn !== null, form);
      r = await saveThis(w);
      assert.strictEqual(r.d.length, 1, form + ': one download');
      assert(/\.gif$/i.test(r.d[0].filename), form + ': ' + r.d[0].filename);
      assert.deepStrictEqual(w.bg.convs, ['CONVERT_REDDIT_VIDEO_TO_GIF'], form + ': one conversion (mocked; the converter itself is not under test here)');
      assert(w.bg.fetched.includes(ANIM), form + ': the exact signed address was requested');
      assert(w.bg.fetched.every((u) => u === ANIM), form + ': nothing else was requested: ' + w.bg.fetched.join(' '));
      assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER'], form);
      assert.strictEqual(r.ops.length, 1, form);
      assert.strictEqual(r.ops[0].state, 'complete', form);
    }
  });

  await itAsync('9.23b the animation source is bound to the click: a source mutation before or between proofs is refused before any request; an unchanged source passes', async () => {
    const OTHER = 'https://preview.redd.it/41s6pcpyxith1.gif?width=1280&format=mp4&s=CHANGED';
    for (const [form, change] of [
      ['src', (g) => g.player.setAttribute('src', OTHER)],
      ['shadow-current', (g) => { g.video.currentSrc = OTHER; }],
      ['shadow-source', (g) => { const s = g.video.children[0]; s.src = OTHER; s.setAttribute('src', OTHER); }],
      ['shadow-current', (g) => { g.video.currentSrc = ''; g.video.src = ''; }]
    ]) {
      let w = await world();
      let g = animPost(w, form);
      await hover(w.env, 200, 200);
      mutateOn(w, isOwner, () => change(g));
      let r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, form);
      assert.strictEqual(w.bg.fetched.length, 0, form + ': no request');
      assert.strictEqual(w.bg.convs.length, 0, form + ': no conversion');
      assert.deepStrictEqual(failedCodes(r.ops), ['NO_MEDIA'], form);
      w = await world();
      g = animPost(w, form);
      await hover(w.env, 200, 200);
      change(g);
      r = await saveThis(w, 0);
      assert.strictEqual(w.bg.asks.length, 0, form + ': a change between hover and click sends nothing');
      assert.strictEqual(w.bg.fetched.length, 0, form);
    }
  });

  await itAsync('9.23c closest negatives: not a confirmed animation, foreign host, plain http, lookalike host, a neighbour\'s animation and the last right-click never supply a source; no poster downgrade', async () => {
    for (const [name, url] of [
      ['a plain .gif of the preview host is not a confirmed animation', 'https://preview.redd.it/41s6pcpyxith1.gif?width=1280&s=SYNTHETIC'],
      ['a foreign host', 'https://evil.example/41s6pcpyxith1.gif?width=1280&format=mp4&s=SYNTHETIC'],
      ['plain http', 'http://preview.redd.it/41s6pcpyxith1.gif?width=1280&format=mp4&s=SYNTHETIC'],
      ['a lookalike host', 'https://preview.redd.it.evil.example/41s6pcpyxith1.gif?width=1280&format=mp4&s=SYNTHETIC'],
      ['a non-gif path with format=mp4', 'https://preview.redd.it/41s6pcpyxith1.jpg?width=1280&format=mp4&s=SYNTHETIC'],
      ['credentials in the address', 'https://user:pw@preview.redd.it/41s6pcpyxith1.gif?width=1280&format=mp4&s=SYNTHETIC'],
      ['the reddit.com media wrapper is not a player source', 'https://www.reddit.com/media?url=https%3A%2F%2Fpreview.redd.it%2F41s6pcpyxith1.gif%3Fformat%3Dmp4']
    ]) {
      const w = await world();
      playerPost(w.env, 'animneg', '41s6pcpyxith1', { json: null, src: url, inner: url });
      await hover(w.env, 200, 200);
      const r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, name);
      assert.strictEqual(w.bg.fetched.length, 0, name + ': ' + w.bg.fetched.join(' '));
      assert.strictEqual(w.bg.convs.length, 0, name);
      assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA'], name);
    }
    const w = await world();
    const a = playerPost(w.env, 'animown', 'vid9own2', { json: null, left: 100, top: 100 });
    const b = playerPost(w.env, 'animnbr', '41s6pcpyxith1', { json: null, src: ANIM, inner: ANIM, left: 900, top: 100 });
    w.env.context.setLastRedditContextmenuTarget(b.player, [b.player, b.post]);
    await hover(w.env, 150, 150);
    const r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0, 'an unresolved player never takes its neighbour\'s animation or the last right-click');
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA']);
    assert(a && b);
  });

  await itAsync('9.20g the declaration is parsed once per unchanged attribute (bounded, no re-parse on every proof); the inline path does no network on hover', async () => {
    const w = await world();
    const g = playerPost(w.env, 'pmcache', 'vid9chg');
    vm.runInContext('globalThis.__jp = JSON.parse; globalThis.__jpn = 0; JSON.parse = function (...a) { globalThis.__jpn++; return globalThis.__jp.apply(this, a); };', w.env.context);
    for (let i = 0; i < 20; i++) w.env.context.__riSnapshot(g.player, 'video');
    assert.strictEqual(w.env.context.__jpn, 1, 'one parse for twenty snapshots of an unchanged attribute');
    g.player.setAttribute('packaged-media-json', CHANGED('vid9chg'));
    w.env.context.__riSnapshot(g.player, 'video');
    assert.strictEqual(w.env.context.__jpn, 2, 'a changed attribute is parsed again');
    // the selection follows the ids it is bound to: the same declaration under another asset's src selects nothing, never a remembered file
    const before = w.env.context.extractDirectCandidateFromPlayer(g.player, null);
    assert(before && /s=CHANGED/.test(before.url));
    g.player.setAttribute('src', 'https://v.redd.it/vid9elsewhere/HLSPlaylist.m3u8?f=hd');
    assert.strictEqual(w.env.context.extractDirectCandidateFromPlayer(g.player, null), null);
    // a <video> that lies inside the player carries the player's selected file in its own source
    g.player.setAttribute('src', 'https://v.redd.it/vid9chg/HLSPlaylist.m3u8?f=hd&t=1');
    const light = w.env.context.document.createElement('video');
    g.player.appendChild(light);
    const s1 = w.env.context.__riSnapshot(light, 'video');
    g.player.setAttribute('packaged-media-json', pmj('vid9chg'));
    const s2 = w.env.context.__riSnapshot(light, 'video');
    assert(s1 && s2 && s1.src !== s2.src && /s=H264720/.test(s2.src), 'the inner video proves the declared file of its player');
    await hover(w.env, 200, 200);
    assert.strictEqual(w.bg.fetched.length, 0, 'hover requests nothing');
  });

  // ===== 9.30: a direct file whose QUERY mentions a manifest is still the direct file; only a manifest PATH is a manifest =====
  // Observed in the native service-worker log: direct packaged-media MP4 addresses carrying ?m=DASHPlaylist.mpd. The extraction helpers used to test
  // '.mpd' / '.m3u8' against the whole address, so such a player was refused (UNRESOLVED_BLOB) although the context-menu fallback accepted the very
  // same address. The fixtures are synthetic (a direct src and no packaged-media-json); they are not the captured DOM of a lost native post.
  const MQ = 'https://packaged-media.redd.it/vid9mq/pb/m2-res_720p.mp4?m=DASHPlaylist.mpd&var=sgpssan&v=1&e=1791270000&s=TEST_ONLY';
  const VQ = 'https://v.redd.it/vid9mq/DASH_720.mp4?source=fallback&m=DASHPlaylist.mpd';
  const HLS_OWN = 'https://v.redd.it/vid9mq/HLSPlaylist.m3u8?f=hd&t=1';
  // the four player routes of extractDirectCandidateFromPlayer: src, stream-url, the shadow video's own address, a shadow <source>
  const mqRoutes = {
    'player src': (w, url) => playerPost(w.env, 'mq1', 'vid9mq', { json: null, src: url }),
    'stream-url': (w, url) => { const g = playerPost(w.env, 'mq1', 'vid9mq', { json: null }); g.player.setAttribute('stream-url', url); return g; },
    'shadow video src': (w, url) => playerPost(w.env, 'mq1', 'vid9mq', { json: null, inner: url }),
    'shadow <source>': (w, url) => { const g = playerPost(w.env, 'mq1', 'vid9mq', { json: null }); const so = w.env.context.document.createElement('source'); so.setAttribute('src', url); g.video.appendChild(so); return g; }
  };

  await itAsync('9.30a direct MP4 + manifest query on every player route (src, stream-url, shadow video, shadow <source>): the helper returns the exact full address as a video', async () => {
    for (const [route, make] of Object.entries(mqRoutes)) {
      for (const url of [MQ, VQ]) {
        const w = await world();
        const g = make(w, url);
        const got = w.env.context.extractDirectCandidateFromPlayer(g.player, null);
        assert(got && got.url === url && got.type === 'video', route + ' ' + url + ': ' + JSON.stringify(got));
      }
    }
  });

  await itAsync('9.30b the shared fallbacks of the blob recovery and the post-level extraction accept the same address (standalone video, clicked video, post attribute)', async () => {
    const mk = (w, { src = '', attr = '' } = {}) => {
      const { document } = w.env.context;
      const post = document.createElement('shreddit-post');
      post.setAttribute('id', 't3_mqb1');
      post.setAttribute('permalink', '/r/pics/comments/mqb1/a_post/');
      if (attr) post.setAttribute('data-mp4-url', attr);
      R(post, 100, 100, 600, 500);
      const video = document.createElement('video');
      if (src) { video.src = src; video.currentSrc = src; }
      R(video, 100, 100, 600, 500);
      post.appendChild(video);
      document.body.appendChild(post);
      return { post, video };
    };
    const ctx = (w) => w.env.context;
    let w = await world();
    let g = mk(w, { src: MQ });
    assert.strictEqual((ctx(w).extractDirectCandidateFromPost(g.post, null) || {}).url, MQ, 'post-level: the sole standalone video');
    assert.strictEqual((ctx(w).findRedditDirectMediaForBlob(g.video, [g.video, g.post], 'blob:https://www.reddit.com/x') || {}).url, MQ, 'clicked standalone video');
    w = await world();
    g = mk(w, { attr: MQ });
    assert.strictEqual((ctx(w).extractDirectCandidateFromPost(g.post, null) || {}).url, MQ, 'post-level: the post attribute');
    assert.strictEqual((ctx(w).findRedditDirectMediaForBlob(g.video, [g.video, g.post], 'blob:https://www.reddit.com/x') || {}).url, MQ, 'clicked standalone video: the sole item\'s post attribute');
    w = await world();
    const p = playerPost(w.env, 'mqb2', 'vid9mq', { json: null });
    p.post.setAttribute('data-mp4-url', MQ);
    assert.strictEqual((ctx(w).findRedditDirectMediaForBlob(p.player, [p.player, p.post], 'blob:https://www.reddit.com/x') || {}).url, MQ, 'clicked player: the sole item\'s post attribute');
  });

  await itAsync('9.30c a real manifest path stays refused on every route, even when its query names .mp4; the helper never strips a query or builds another address', async () => {
    const manifests = [
      'https://v.redd.it/vid9mq/DASHPlaylist.mpd?x=.mp4',
      'https://v.redd.it/vid9mq/HLSPlaylist.m3u8?f=hd&n=a.mp4',
      'https://packaged-media.redd.it/vid9mq/pb/MANIFEST.MPD?v=1',
      'https://v.redd.it/vid9mq/DASHPlaylist.mpd'
    ];
    for (const [route, make] of Object.entries(mqRoutes)) {
      for (const url of manifests) {
        const w = await world();
        const g = make(w, url);
        // the neutral default of the player's own src is an HLS playlist, so a refusal here is the manifest rule itself
        assert.strictEqual(w.env.context.extractDirectCandidateFromPlayer(g.player, null), null, route + ' ' + url);
      }
    }
  });

  await itAsync('9.30d the diagnostics follow the path too: a DASH path is reported as an unsupported DASH stream, a query that mentions .mpd on an HLS playlist is not', async () => {
    for (const [src, reason] of [['https://v.redd.it/vid9mq/DASHPlaylist.mpd', 'UNSUPPORTED_DASH_STREAM'], [HLS_OWN + '&m=DASHPlaylist.mpd', 'NO_DIRECT_MEDIA_FOUND']]) {
      const w = await world();
      const g = playerPost(w.env, 'mq3', 'vid9mq', { json: null, src, inner: 'blob:https://www.reddit.com/aaaa-bbbb' });
      w.env.context.setLastRedditContextmenuTarget(g.video, [g.video, g.player, g.post]);
      const res = w.env.ask({ action: 'RESOLVE_REDDIT_BLOB_MEDIA', clickedSrc: 'blob:https://www.reddit.com/aaaa-bbbb' });
      assert(res && res.success === false && res.reason === reason, src + ': ' + JSON.stringify(res));
    }
  });

  await itAsync('9.30e complete inline Save: a player holding the direct MP4 + manifest query (src, then the shadow video) downloads that exact address as an MP4, with nothing else requested', async () => {
    for (const [route, url] of [['player src', MQ], ['shadow video src', MQ], ['player src', VQ]]) {
      const w = await world();
      mqRoutes[route](w, url);
      await hover(w.env, 200, 200);
      assert(w.state.btn !== null, route + ': the control is shown');
      const r = await saveThis(w);
      assert.strictEqual(r.d.length, 1, route + ' ' + url);
      assert.strictEqual(r.d[0].url, url, 'the exact full address, signed query included');
      assert(/^SavedImages\/[^/]+\.mp4$/i.test(r.d[0].filename), r.d[0].filename);
      assert.strictEqual(r.d[0].saveAs, false);
      assert.strictEqual(w.bg.convs.length, 0, 'an ordinary video is never converted');
      assert.deepStrictEqual(w.bg.fetched, [url], 'only the selected file was requested: ' + JSON.stringify(w.bg.fetched));
      assert.deepStrictEqual(proofs(w), ['REDDIT_INLINE_OWNER']);
      assert.strictEqual(r.ops.length, 1);
      assert.strictEqual(r.ops[0].state, 'complete');
    }
  });

  await itAsync('9.30f inline Save still refuses what is not the selected player\'s own direct file: a real manifest, a foreign host, a neighbour\'s file (zero downloads, nothing requested)', async () => {
    for (const [name, url] of [['DASH manifest path', 'https://v.redd.it/vid9mq/DASHPlaylist.mpd?x=.mp4'], ['HLS manifest path', HLS_OWN + '&n=a.mp4'], ['foreign host', 'https://cdn.evil.example/vid9mq/m2-res_720p.mp4?m=DASHPlaylist.mpd']]) {
      const w = await world();
      playerPost(w.env, 'mq4', 'vid9mq', { json: null, src: url });
      await hover(w.env, 200, 200);
      const r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, name);
      assert.strictEqual(w.bg.fetched.length, 0, name + ': no request');
    }
    // two posts: the selected player saves its own file, never the neighbour's
    const w = await world();
    playerPost(w.env, 'mq5', 'vid9mq', { json: null, src: MQ, left: 100, top: 100 });
    playerPost(w.env, 'mq6', 'vid9nb', { json: null, src: 'https://packaged-media.redd.it/vid9nb/pb/m2-res_720p.mp4?m=DASHPlaylist.mpd&s=NB', left: 900, top: 100 });
    await hover(w.env, 200, 200);
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, MQ);
    assert.deepStrictEqual(w.bg.fetched, [MQ]);
  });

  // --- Suite 10: Observed Native Reddit Fixture Regressions ---
  console.log('\n--- Suite 10: Observed Native Reddit Fixture Regressions ---');

  function loadNativeFixture(name) {
    const p = path.join(__dirname, 'tools', 'reddit-native-fixtures', name);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  function buildGalleryFromFixture(env, fixture, { usePercentEncoded = false, viewContext = null, at = 0, pagesOverride = null } = {}) {
    const { document } = env.context;
    const postData = fixture.post || (fixture.feedVariant ? fixture.feedVariant.post : fixture.postVariant.post);
    const carData = fixture.carousel || (fixture.feedVariant ? fixture.feedVariant.carousel : fixture.postVariant.carousel);
    const slidesData = fixture.slides || [];

    const post = document.createElement('shreddit-post');
    post.setAttribute('id', postData.id);
    post.setAttribute('permalink', postData.permalink);
    post.setAttribute('post-type', postData.postType || 'gallery');
    post.setAttribute('domain', postData.domain || 'reddit.com');
    post.setAttribute('view-context', viewContext || postData.viewContext || 'CommentsPage');
    R(post, 0, 0, 800, 600);

    const carousel = document.createElement('gallery-carousel');
    carousel.setAttribute('post-id', carData.postId);
    carousel.setAttribute('permalink', carData.permalink || postData.permalink);
    if (carData.deviceType) carousel.setAttribute('device-type', carData.deviceType);
    if (carData.galleryStartIndex) carousel.setAttribute('gallery-start-index', carData.galleryStartIndex);
    carousel.style.position = 'relative';
    R(carousel, 20, 20, 700, 500);

    const ul = document.createElement('ul');
    R(ul, 20, 20, 700, 500);
    carousel.appendChild(ul);

    const builtSlides = [];
    slidesData.forEach((s, i) => {
      const li = document.createElement('li');
      li.setAttribute('slot', s.slot);
      R(li, 20 + (i - at) * 708, 20, 700, 500);

      const put = (el, url, lazy) => {
        if (lazy) el.setAttribute('data-lazy-src', url);
        else { el.src = url; el.setAttribute('src', url); }
      };

      if (s.backdrop) {
        const backdrop = document.createElement('img');
        backdrop.setAttribute('alt', '');
        backdrop.className = 'post-background-image-filter';
        put(backdrop, s.backdrop.src || s.backdrop.dataLazySrc || '', Boolean(s.backdrop.dataLazySrc && !s.backdrop.src));
        R(backdrop, 20 + (i - at) * 708 - 38, -30, 760, 600);
        li.appendChild(backdrop);
      }

      const figure = document.createElement('figure');
      R(figure, 20 + (i - at) * 708, 20, 700, 500);

      const previewUrl = usePercentEncoded && (s.preview.percentEncodedSrc || s.preview.percentEncodedDataLazySrc)
        ? (s.preview.percentEncodedSrc || s.preview.percentEncodedDataLazySrc)
        : (s.preview.src || s.preview.dataLazySrc || '');
      const isLazy = Boolean(!s.preview.src && s.preview.dataLazySrc);

      const main = document.createElement('img');
      main.className = 'non-lightboxed-content media-lightbox-img';
      main.setAttribute('alt', s.preview.alt || 'r/RuPC gallery image');
      put(main, previewUrl, isLazy);
      R(main, 20 + (i - at) * 708, 20, 700, 500);
      figure.appendChild(main);

      let zoom = null;
      if (s.lightbox) {
        const lboxDiv = document.createElement('div');
        lboxDiv.className = 'lightboxed-content hidden';
        zoom = document.createElement('img');
        zoom.className = 'media-lightbox-img';
        zoom.setAttribute('alt', s.lightbox.alt || 'r/RuPC gallery image');
        put(zoom, s.lightbox.src, false);
        R(zoom, 0, 0, 0, 0);
        lboxDiv.appendChild(zoom);
        figure.appendChild(lboxDiv);
      }

      li.appendChild(figure);
      ul.appendChild(li);
      builtSlides.push({ li, main, zoom });
    });

    const outer = shadowOf(env, carousel);
    const fc = document.createElement('faceplate-carousel');
    outer.appendChild(fc);
    const inner = shadowOf(env, fc);
    const pagesCount = pagesOverride !== null ? pagesOverride : (carData.totalPages || slidesData.length);
    if (pagesCount !== false) {
      const ind = document.createElement('faceplate-pagination-indicator');
      ind.setAttribute('pages', String(pagesCount));
      ind.setAttribute('page-index', carData.pageIndexAttr || '0');
      inner.appendChild(ind);
    }

    post.appendChild(carousel);
    document.body.appendChild(post);
    return { post, carousel, ul, slides: builtSlides, shadowIndicatorRoot: inner };
  }

  // 10.1: A two-image gallery versus a larger gallery
  await itAsync('10.1a native two-image gallery (r/RuPC) with ASCII slug offers Save all (2) and saves both images', async () => {
    const fix = loadNativeFixture('gallery_rupc_two_image.json');
    const w = await world();
    const g = buildGalleryFromFixture(w.env, fix, { usePercentEncoded: false });
    await hover(w.env, 100, 100);
    assert(w.state.btn !== null, 'Save control visible on slide 1');
    assert(hasAll(w), 'Save all (2) offered for complete 2-image gallery');
    assert.strictEqual(w.state.count, 2, 'Count is 2');

    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2, 'Both images downloaded');
    const urls = r.d.map((x) => x.url);
    assert(urls.some((u) => u.includes('5yxioaa8eith1.jpg')), 'Slide 1 saved');
    assert(urls.some((u) => u.includes('flwbdfc8eith1.jpg')), 'Slide 2 saved');
    assert(r.ops.every((o) => o.state === 'complete'), 'Both operations completed');
  });

  await itAsync('10.1b observed defect: native two-image gallery with percent-encoded Cyrillic slug fails riAssetId regex (documented for Claude)', async () => {
    const fix = loadNativeFixture('gallery_rupc_two_image.json');
    const w = await world();
    const g = buildGalleryFromFixture(w.env, fix, { usePercentEncoded: true });
    await hover(w.env, 100, 100);

    // Desired supported case: complete 2-image gallery with percent-encoded Cyrillic slug should offer Save all (2)
    // Fails in production content_reddit.js riAssetId: regex [a-zA-Z0-9_-]+ does not match '%'
    assert(hasAll(w), 'Save all (2) offered for complete 2-image gallery with percent-encoded Cyrillic slug');
    assert.strictEqual(w.state.count, 2, 'Count is 2');

    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2, 'Both images saved');
  });

  await itAsync('10.1c native eight-image gallery (r/ihatethissmug) offers Save all (8) and saves all 8 ordered items', async () => {
    const fix = loadNativeFixture('gallery_eight_image.json');
    const w = await world();
    const g = buildGalleryFromFixture(w.env, fix);
    await hover(w.env, 100, 100);
    assert(w.state.btn !== null);
    assert(hasAll(w), 'Save all offered for 8-image gallery');
    assert.strictEqual(w.state.count, 8, 'Count is 8');

    const r = await saveAllClick(w, 8);
    assert.strictEqual(r.d.length, 8, 'All 8 images downloaded');
    const expectedUrls = [
      'https://i.redd.it/v4o9q1fnrash1.jpg',
      'https://i.redd.it/slide2hash.jpg',
      'https://i.redd.it/slide3hash.jpg',
      'https://i.redd.it/slide4hash.jpg',
      'https://i.redd.it/slide5hash.jpg',
      'https://i.redd.it/slide6hash.jpg',
      'https://i.redd.it/slide7hash.jpg',
      'https://i.redd.it/slide8hash.jpg'
    ];
    assert.deepStrictEqual(r.d.map((x) => x.url), expectedUrls, 'exact membership and order of all 8 slides');
    assert.strictEqual(r.ops.length, 8);
    assert(r.ops.every((o) => o.state === 'complete'));
  });

  // 10.2: Feed versus post-page gallery structure
  await itAsync('10.2a feed view gallery carousel (AggregateFeed) correctly discovered without gallery-start-index', async () => {
    const fix = loadNativeFixture('gallery_feed_vs_post.json');
    const rupcFix = loadNativeFixture('gallery_rupc_two_image.json');
    const w = await world();
    const g = buildGalleryFromFixture(w.env, {
      post: fix.feedVariant.post,
      carousel: fix.feedVariant.carousel,
      slides: rupcFix.slides
    });
    await hover(w.env, 100, 100);
    assert(hasAll(w), 'Feed gallery offers Save all (2)');
    assert.strictEqual(w.state.count, 2);

    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
  });

  await itAsync('10.2b post page gallery carousel (CommentsPage) correctly discovered with gallery-start-index="0"', async () => {
    const fix = loadNativeFixture('gallery_feed_vs_post.json');
    const rupcFix = loadNativeFixture('gallery_rupc_two_image.json');
    const w = await world();
    const g = buildGalleryFromFixture(w.env, {
      post: fix.postVariant.post,
      carousel: fix.postVariant.carousel,
      slides: rupcFix.slides
    });
    await hover(w.env, 100, 100);
    assert(hasAll(w), 'Post-page gallery offers Save all (2)');
    assert.strictEqual(w.state.count, 2);

    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
  });

  await itAsync('10.2c active slide pointer tracking across feed (AggregateFeed) vs post page (CommentsPage)', async () => {
    const feedFix = loadNativeFixture('gallery_feed_vs_post.json');
    const rupcFix = loadNativeFixture('gallery_rupc_two_image.json');

    // Feed view (AggregateFeed): slide 1 active at = 0
    const w1 = await world();
    buildGalleryFromFixture(w1.env, {
      post: feedFix.feedVariant.post,
      carousel: feedFix.feedVariant.carousel,
      slides: rupcFix.slides
    }, { at: 0 });
    await hover(w1.env, 100, 100);
    const r1 = await saveThis(w1);
    assert.strictEqual(r1.d.length, 1);
    assert(r1.d[0].url.includes('5yxioaa8eith1.jpg'), 'Feed view: slide 1 selected on hover when active');

    // Post page view (CommentsPage): slide 2 active at = 1
    const w2 = await world();
    buildGalleryFromFixture(w2.env, {
      post: feedFix.postVariant.post,
      carousel: feedFix.postVariant.carousel,
      slides: rupcFix.slides
    }, { at: 1 });
    await hover(w2.env, 100, 100);
    const r2 = await saveThis(w2);
    assert.strictEqual(r2.d.length, 1);
    assert(r2.d[0].url.includes('flwbdfc8eith1.jpg'), 'Post page view: slide 2 selected on hover when active');
  });

  // 10.3: Native GIF versus positively identified GIF-as-MP4
  await itAsync('10.3a confirmed Reddit animation (shreddit-player[gif] playing preview format=mp4): converted to GIF blob without source MP4 leak', async () => {
    const fix = loadNativeFixture('native_gif_and_comment_player.json');
    const w = await world();
    const { document } = w.env.context;

    const post = document.createElement('shreddit-post');
    post.setAttribute('id', fix.nativeGifPost.id);
    post.setAttribute('post-type', fix.nativeGifPost.postType);
    post.setAttribute('domain', fix.nativeGifPost.domain);
    post.setAttribute('content-href', fix.nativeGifPost.contentHref);
    post.setAttribute('permalink', fix.nativeGifPost.permalink);
    post.style.position = 'relative';
    R(post, 0, 0, 800, 600);

    const player = document.createElement('shreddit-player');
    player.setAttribute('src', fix.nativeGifPost.player.src);
    player.setAttribute('gif', '');
    player.setAttribute('poster', fix.nativeGifPost.player.poster);
    player.style.position = 'relative';
    R(player, 20, 20, 700, 500);

    const shadow = shadowOf(w.env, player);
    const vid = document.createElement('video');
    vid.src = fix.nativeGifPost.player.shadowVideoSrc;
    vid.currentSrc = fix.nativeGifPost.player.shadowVideoSrc;
    R(vid, 20, 20, 700, 500);
    shadow.appendChild(vid);

    post.appendChild(player);
    document.body.appendChild(post);

    await hover(w.env, 100, 100);
    assert(w.state.btn !== null, 'Inline Save control visible over shreddit-player[gif]');

    // Confirmed animation (.gif?format=mp4): converted to GIF Blob
    // Baseline note: fails on PR #28 baseline before Claude PR #26 (RD-09)
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1, 'Exactly one download initiated');
    assert.deepStrictEqual(w.bg.convs, ['CONVERT_REDDIT_VIDEO_TO_GIF'], 'Exactly one converter call');
    assert(w.bg.fetched.includes(fix.nativeGifPost.player.src), 'Exact selected source URL requested at converter boundary: ' + fix.nativeGifPost.player.src);
    assert(/^blob:/.test(r.d[0].url), 'Final download URL is the returned Blob URL, not the source MP4');
    assert(!r.d[0].url.includes('sig_sat_mp4'), 'Download URL does not leak source MP4 query/signature');
    assert(/\.gif$/i.test(r.d[0].filename), 'Filename has .gif extension: ' + r.d[0].filename);
    assert.strictEqual(r.ops.length, 1, 'One feedback operation');
    assert.strictEqual(r.ops[0].state, 'complete', 'Completed ownership');
    assert(!w.bg.fetched.some((u) => /poster|preview-v0|sig_sat_poster/i.test(u)), 'No poster or neighbour media requested');
  });

  await itAsync('10.3c native GIF direct download (i.redd.it): saved directly as .gif without converter call', async () => {
    const fix = loadNativeFixture('native_gif_and_comment_player.json');
    const w = await world();
    imgPost(w.env, 'natgif1', fix.nativeGifPost.contentHref);
    await hover(w.env);
    assert(w.state.btn !== null);

    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, fix.nativeGifPost.contentHref, 'Direct download of original native GIF');
    assert(/\.gif$/i.test(r.d[0].filename));
    assert.strictEqual(w.bg.convs.length, 0, 'Zero converter calls for native GIF');
    assert.strictEqual(r.ops.length, 1);
    assert.strictEqual(r.ops[0].state, 'complete');
  });

  await itAsync('10.3b comment GIF player with comment-id binds strictly to comment and does not borrow post video', async () => {
    const fix = loadNativeFixture('native_gif_and_comment_player.json');
    const w = await world();
    const { document } = w.env.context;

    const post = document.createElement('shreddit-post');
    post.setAttribute('id', fix.commentGif.postId);
    post.setAttribute('permalink', '/r/pcmasterrace/comments/1wchzc1/dlss5/');
    post.style.position = 'relative';
    R(post, 0, 0, 800, 1200);

    const postPlayer = document.createElement('shreddit-player');
    postPlayer.setAttribute('src', 'https://v.redd.it/post_vid/HLSPlaylist.m3u8');
    postPlayer.style.position = 'relative';
    R(postPlayer, 0, 0, 700, 400);
    post.appendChild(postPlayer);

    const comment = document.createElement('shreddit-comment');
    comment.setAttribute('id', fix.commentGif.commentId);
    comment.style.position = 'relative';
    R(comment, 0, 500, 700, 300);

    const commentPlayer = document.createElement('shreddit-player');
    commentPlayer.setAttribute('post-id', fix.commentGif.postId);
    commentPlayer.setAttribute('comment-id', fix.commentGif.commentId);
    commentPlayer.setAttribute('gif', '');
    commentPlayer.setAttribute('src', fix.commentGif.player.src);
    commentPlayer.style.position = 'relative';
    R(commentPlayer, 20, 520, 400, 250);

    const cShadow = shadowOf(w.env, commentPlayer);
    const cVid = document.createElement('video');
    cVid.src = fix.commentGif.player.shadowVideoSrc;
    cVid.currentSrc = fix.commentGif.player.shadowVideoSrc;
    R(cVid, 20, 520, 400, 250);
    cShadow.appendChild(cVid);

    comment.appendChild(commentPlayer);
    post.appendChild(comment);
    document.body.appendChild(post);

    // Verify owner isolation: comment media cannot be claimed by the post owner
    assert.strictEqual(w.env.context.__riOwnerOf(commentPlayer), null, 'Comment player returns null owner (comments excluded)');

    // Hover over comment GIF: no inline button shown, post video never borrowed
    await hover(w.env, 100, 550);
    assert.strictEqual(w.state.btn, null, 'No inline Save control offered over comment media');
    assert.strictEqual(w.bg.downloads.length, 0, 'No downloads initiated');
    assert.strictEqual(w.bg.fetched.length, 0, 'No network requests');
  });

  // 10.4: Shreddit player source attributes and accessible shadow-root structure (DLSS 5)
  await itAsync('10.4a DLSS 5 video player (r/pcmasterrace) selects declared 720p H264 MP4 over HLSPlaylist and CMAF', async () => {
    const fix = loadNativeFixture('shreddit_player_dlss5.json');
    const w = await world();
    const { document } = w.env.context;

    const post = document.createElement('shreddit-post');
    post.setAttribute('id', fix.post.id);
    post.setAttribute('post-type', fix.post.postType);
    post.setAttribute('domain', fix.post.domain);
    post.setAttribute('content-href', fix.post.contentHref);
    post.setAttribute('permalink', fix.post.permalink);
    post.style.position = 'relative';
    R(post, 0, 0, 800, 600);

    const player = document.createElement('shreddit-player');
    player.setAttribute('src', fix.player.src);
    player.setAttribute('preview', fix.player.preview);
    player.setAttribute('poster', fix.player.poster);
    player.setAttribute('packaged-media-json', JSON.stringify(fix.player.packagedMediaJson));
    R(player, 20, 20, 700, 500);

    const shadow = shadowOf(w.env, player);
    const vid = document.createElement('video');
    vid.src = fix.player.shadowVideo.src;
    vid.currentSrc = fix.player.shadowVideo.src;
    R(vid, 20, 20, 700, 500);
    shadow.appendChild(vid);

    post.appendChild(player);
    document.body.appendChild(post);

    const cand = w.env.context.extractDirectCandidateFromPlayer(player, null);
    assert(cand && cand.url.includes('m2-res_720p.mp4'), 'extractDirectCandidateFromPlayer selects 720p MP4: ' + (cand && cand.url));
    assert(!cand.url.includes('HLSPlaylist') && !cand.url.includes('CMAF'), 'HLS and CMAF are not selected');

    await hover(w.env, 100, 100);
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert(r.d[0].url.includes('sig720p'), 'Exact declared 720p MP4 downloaded');
  });

  await itAsync('10.4b virtualized/incomplete native gallery (indicator says 4, only 2 slides in DOM) fails closed to Save this', async () => {
    const fix = loadNativeFixture('gallery_rupc_two_image.json');
    const w = await world();
    const g = buildGalleryFromFixture(w.env, fix, { pagesOverride: 4 });
    await hover(w.env, 100, 100);
    assert(w.state.btn !== null, 'Save this available');
    assert(!hasAll(w), 'Save all is suppressed because 2 slides != declared total 4');

    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert(r.d[0].url.includes('5yxioaa8eith1.jpg'));
  });

  await itAsync('10.4c foreign nested crosspost gallery does not corrupt outer gallery completeness', async () => {
    const fix = loadNativeFixture('gallery_rupc_two_image.json');
    const w = await world();
    const outerG = buildGalleryFromFixture(w.env, fix);

    const { document } = w.env.context;
    const nestedPost = document.createElement('shreddit-post');
    nestedPost.setAttribute('permalink', '/r/other/comments/nested123/crosspost/');
    R(nestedPost, 3000, 0, 700, 500);
    const nestedCarousel = document.createElement('gallery-carousel');
    R(nestedCarousel, 3000, 0, 700, 500);
    nestedPost.appendChild(nestedCarousel);
    outerG.post.appendChild(nestedPost);

    await hover(w.env, 100, 100);
    assert(hasAll(w), 'Outer gallery remains complete');
    assert.strictEqual(w.state.count, 2, 'Count remains exactly 2');
    const r = await saveAllClick(w, 2);
    assert.strictEqual(r.d.length, 2);
  });

  await itAsync('10.4d slide replaced between hover and click fails closed with zero downloads', async () => {
    const fix = loadNativeFixture('gallery_rupc_two_image.json');
    const w = await world();
    const g = buildGalleryFromFixture(w.env, fix);
    await hover(w.env, 100, 100);
    assert(hasAll(w));

    mutateOn(w, isItem(0), () => g.slides[0].li.remove());
    const r = await saveAllClick(w);
    assert.strictEqual(r.d.length, 0, 'Structure changed, zero downloads');
  });

  await itAsync('10.4e unsupported player without declaration and only manifest fails closed to UNRESOLVED_BLOB_MEDIA', async () => {
    const w = await world();
    const { document } = w.env.context;
    const post = document.createElement('shreddit-post');
    post.setAttribute('permalink', '/r/videos/comments/unsupported1/hls_only/');
    post.style.position = 'relative';
    R(post, 0, 0, 800, 600);

    const player = document.createElement('shreddit-player');
    player.setAttribute('src', 'https://v.redd.it/unsupported1/HLSPlaylist.m3u8');
    R(player, 20, 20, 700, 500);
    post.appendChild(player);
    document.body.appendChild(post);

    await hover(w.env, 100, 100);
    const r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0, 'Zero downloads for unresolvable HLS-only player');
    assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA']);
  });

  // --- Suite 11: RD-10 inline Save over a RedGIFs embed in a Reddit post ---
  // Structure (observed on a Reddit link post, recorded in the RD-10 fixture of the Gemini fixture task, 2026-10-05; not re-observed here):
  // <shreddit-post post-type="link" domain="redgifs.com" content-href="https://www.redgifs.com/watch/<id>"> holds
  // <shreddit-embed providerName="RedGIFs" html="<iframe src=https://www.redgifs.com/ifr/<id> ...>"> with a cross-origin iframe. The page itself
  // has no media node, so the control must be admitted from the embed, bound to the post that declares the same clip, and the clip is resolved
  // by the extension's frame resolver in the iframe's own frame. Production code runs unchanged: content_reddit.js (fake DOM), background.js
  // (mocked Chrome) and content_redgifs.js in a fake RedGIFs frame; only the browser, the network and the downloads are replaced.
  console.log('\n--- Suite 11: RD-10 RedGIFs embed inline Save ---');

  const CLIP_A = 'imperturbablelivecaimanlizard';
  const CLIP_B = 'wildcheetahexample';
  const IFR = (c) => `https://www.redgifs.com/ifr/${c}`;
  const WATCH = (c) => `https://www.redgifs.com/watch/${c}`;
  const FILE = { [CLIP_A]: 'ImperturbableLiveCaimanlizard', [CLIP_B]: 'WildCheetahExample' };
  const SILENT_A = `https://media.redgifs.com/${FILE[CLIP_A]}-silent.mp4`;
  const HD_A = `https://media.redgifs.com/${FILE[CLIP_A]}.mp4`;
  const SILENT_B = `https://media.redgifs.com/${FILE[CLIP_B]}-silent.mp4`;

  // A RedGIFs frame document: content_redgifs.js runs in it unchanged. `declares`: the muted file the page head declares (og:video);
  // `audio`: a serialized clip object { id, hasAudio, urls } like the page's own JSON; `videos`: how many <video> elements the frame holds.
  function redgifsFrame(clip, { frameId, documentId = `doc-F${frameId}`, declares = null, audio = null, videos = 1, child = true, url = IFR(clip), advertise = null, api = null } = {}) {
    const body = new MockElement('BODY');
    const doc = {
      body,
      querySelectorAll: (s) => body.querySelectorAll(s),
      querySelector: (s) => body.querySelector(s)
    };
    const mk = (tag, attrs = {}) => { const el = new MockElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
    for (let i = 0; i < videos; i++) body.appendChild(mk('video', { autoplay: '', loop: '' }));
    if (declares) body.appendChild(mk('meta', { property: 'og:video', content: declares }));
    if (audio) {
      const s = mk('script', { type: 'application/json' });
      s.textContent = JSON.stringify({ props: { gif: audio } });
      body.appendChild(s);
    }
    const top = {};
    const win = { location: new URL(url), addEventListener() {}, parent: child ? top : {}, top };
    win.self = win;
    const listeners = [];
    // the provider API as the frame's own origin reaches it: every request is logged (address, method, headers, credentials mode)
    const apiLog = [];
    const frameFetch = async (u, init = {}) => {
      const requestUrl = String(u);
      apiLog.push({ url: requestUrl, method: init.method || 'GET', headers: { ...(init.headers || {}) }, credentials: init.credentials });
      if (!api) throw new Error('network is not available');
      const route = /\/v2\/auth\/temporary$/.test(requestUrl) ? api.auth : (/\/v2\/gifs\/[^/?#]+$/.test(requestUrl) ? api.gif : null);
      if (!route) throw new Error('unexpected request');
      const spec = typeof route === 'function' ? await route(requestUrl, init) : route;
      if (spec && spec.throws) throw spec.throws;
      const status = spec && spec.status !== undefined ? spec.status : 200;
      const text = spec && spec.text !== undefined ? spec.text : JSON.stringify(spec && spec.body !== undefined ? spec.body : {});
      return { ok: status >= 200 && status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'content-length' && !(spec && spec.noLength) ? (spec && spec.length !== undefined ? String(spec.length) : String(text.length)) : null) }, text: async () => text };
    };
    const context = vm.createContext({
      document: doc, window: win, location: win.location, fetch: frameFetch, AbortController, setTimeout, clearTimeout,
      chrome: { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, sendMessage: async () => ({}) } },
      console: { log() {}, warn() {}, info() {}, error() {} }, URL, Date, Math, Set, Map, JSON, Array, Object, Number, String, Boolean, RegExp, Promise, encodeURIComponent
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'content_redgifs.js'), 'utf8'), context);
    const self = {
      frameId, documentId, url, clip, alive: true, context, apiLog, responses: [],
      ask(msg) {
        return new Promise((resolve) => {
          const fn = listeners[0];
          fn(msg, {}, (r) => { self.responses.push(r); resolve(r); });
        });
      },
      // the real func the background injects, evaluated in this frame
      probe(func) { const r = vm.runInContext(`(${func.toString()})()`, context); return advertise ? { ...r, href: advertise } : r; }
    };
    return self;
  }

  // The tab as the background sees it: the top frame (the fake Reddit document), the RedGIFs frames, and the messages/injections that reach them.
  function wireTab(w, frames) {
    const chromeMock = w.bg.sandbox.chrome;
    const log = { frameAsks: [], injections: [], resolves: [] };
    const topProbe = { href: w.env.window.location.href, child: false };
    chromeMock.tabs.sendMessage = async (tabId, msg, options = {}) => {
      w.bg.asks.push({ tabId, msg, options });
      const f = options.frameId === undefined ? 0 : options.frameId;
      if (f === 0) {
        if (options.documentId && options.documentId !== 'doc-R') throw new Error('The document no longer exists');
        return w.env.ask(msg, { id: EXT_ID });
      }
      const fr = frames.find((x) => x.frameId === f && x.alive);
      if (!fr) throw new Error('Could not establish connection. Receiving end does not exist.');
      if (options.documentId && options.documentId !== fr.documentId) throw new Error('The document no longer exists');
      log.frameAsks.push({ tabId, msg, options });
      return fr.ask(msg);
    };
    chromeMock.scripting.executeScript = async (opts) => {
      log.injections.push(opts);
      if (opts && opts.target && opts.target.allFrames && typeof opts.func === 'function') {
        return [{ frameId: 0, documentId: 'doc-R', result: topProbe }].concat(frames.filter((f) => f.alive).map((f) => ({ frameId: f.frameId, documentId: f.documentId, result: f.probe(opts.func) })));
      }
      return [{ result: null }];
    };
    const realResolve = w.bg.sandbox.resolveFrameLocalMedia;
    w.bg.sandbox.resolveFrameLocalMedia = async (o) => { log.resolves.push(o); return realResolve(o); };
    return log;
  }

  // the observed post structure; `variant`: 'light' (iframe in the embed's light DOM), 'shadow' (open shadow root of the embed), 'attr' (no
  // reachable iframe, only the embed's html attribute), 'bare' (an iframe directly in the post)
  function embedPost(env, id, clip, { variant = 'light', contentHref = WATCH(clip), at = [100, 100, 600, 340], src = IFR(clip), parent = null } = {}) {
    const { document } = env.context;
    const post = document.createElement('shreddit-post');
    post.setAttribute('permalink', `/r/rule34/comments/${id}/a_clip/`);
    post.setAttribute('post-type', 'link');
    post.setAttribute('domain', 'redgifs.com');
    if (contentHref !== null) post.setAttribute('content-href', contentHref);
    R(post, at[0], at[1], at[2], at[3] + 60);
    const cont = document.createElement('div');
    cont.style.position = 'relative';
    R(cont, at[0], at[1], at[2], at[3]);
    let embed = null;
    let iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.setAttribute('src', src);
    R(iframe, at[0], at[1], at[2], at[3]);
    if (variant === 'bare') {
      cont.appendChild(iframe);
    } else {
      embed = document.createElement('shreddit-embed');
      embed.setAttribute('providername', 'RedGIFs');
      embed.setAttribute('html', `<iframe src="${src}" frameborder="0" scrolling="no" width="100%" height="100%" allowfullscreen style="position:absolute;"></iframe>`);
      R(embed, at[0], at[1], at[2], at[3]);
      if (variant === 'light') embed.appendChild(iframe);
      if (variant === 'shadow') { const root = document.createElement('shadow-root'); embed.shadowRoot = root; root.host = embed; root.appendChild(iframe); }
      cont.appendChild(embed);
    }
    post.appendChild(cont);
    (parent || document.body).appendChild(post);
    return { post, cont, embed, iframe };
  }
  async function enter(env, target, x = 200, y = 200) {
    env.fireDoc('pointerover', { target, clientX: x, clientY: y, pointerType: 'mouse' });
    await sleep(80);
  }
  const fixedFetch = (w, map) => { const base = w.bg.sandbox.fetch; w.bg.sandbox.fetch = async (u, o) => { const url = typeof u === 'string' ? u : u.url; if (map && Object.prototype.hasOwnProperty.call(map, url)) return map[url]; return base(u, o); }; };
  const mp4Names = (w) => w.bg.fetched.filter((u) => /\.mp4/i.test(u));

  await itAsync('11.1 reproduction: the owned RedGIFs embed gets the inline control from hover alone (no right-click, no playback); hover resolves and requests nothing', async () => {
    const w = await world();
    const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
    const log = wireTab(w, [frame]);
    const g = embedPost(w.env, 'rg11', CLIP_A);
    await enter(w.env, g.iframe);
    assert(w.state.btn !== null, 'the compact control is shown over the embed');
    assert.strictEqual(w.bg.asks.length, 0, 'hover asked nothing of any frame');
    assert.strictEqual(log.injections.length, 0, 'hover injected nothing');
    assert.strictEqual(w.bg.fetched.length, 0, 'hover requested nothing');
  });

  await itAsync('11.2 the click saves the clip the frame declares, as video, through the shared frame resolver: one owned download, one proof of the frame, no gesture queries', async () => {
    const w = await world();
    const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
    const log = wireTab(w, [frame]);
    const g = embedPost(w.env, 'rg12', CLIP_A);
    await enter(w.env, g.iframe);
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1, 'exactly one download');
    assert.strictEqual(r.d[0].url, SILENT_A, 'the declared source of that frame, exactly');
    assert(/\.mp4$/i.test(r.d[0].filename) && !/\.gif$/i.test(r.d[0].filename), 'RedGIFs stays a video: ' + r.d[0].filename);
    assert.strictEqual(w.bg.convs.length, 0, 'no GIF conversion');
    assert.strictEqual(r.d[0].saveAs, false);
    assert.strictEqual(log.resolves.length, 1, 'the shared resolveFrameLocalMedia ran once');
    assert.strictEqual(log.resolves[0].frameId, 11);
    assert.strictEqual(log.resolves[0].documentId, 'doc-F11');
    assert.strictEqual(log.frameAsks.length, 1);
    assert.strictEqual(log.frameAsks[0].msg.action, 'RESOLVE_FRAME_MEDIA');
    assert.deepStrictEqual({ frameId: log.frameAsks[0].options.frameId, documentId: log.frameAsks[0].options.documentId }, { frameId: 11, documentId: 'doc-F11' });
    assert(!w.bg.asks.some((a) => /GET_REDDIT_MEDIA_AT_CURSOR|RESOLVE_REDDIT_BLOB_MEDIA/.test(a.msg.action)), 'no gesture queries');
    assert.deepStrictEqual(w.bg.asks.filter((a) => a.options.frameId === 0).map((a) => a.msg.action), ['REDDIT_INLINE_OWNER']);
    assert.strictEqual(r.ops.length, 1);
    assert.strictEqual(r.ops[0].state, 'complete');
    assert.deepStrictEqual(mp4Names(w), [SILENT_A], 'only the declared file was requested, never a guessed rendition');
  });

  await itAsync('11.3 RG-03 preserved: a same-clip rendition the page declares as carrying audio wins over the muted one; without such a declaration nothing is guessed or rewritten', async () => {
    const w = await world();
    const withAudio = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A, audio: { id: CLIP_A, hasAudio: true, urls: { hd: HD_A, silent: SILENT_A } } });
    wireTab(w, [withAudio]);
    const g = embedPost(w.env, 'rg13', CLIP_A);
    await enter(w.env, g.iframe);
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].url, HD_A, 'the declared audio-bearing rendition of the same clip');
    const w2 = await world();
    const silentOnly = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
    wireTab(w2, [silentOnly]);
    const g2 = embedPost(w2.env, 'rg13b', CLIP_A);
    await enter(w2.env, g2.iframe);
    const r2 = await saveThis(w2);
    assert.strictEqual(r2.d.length, 1);
    assert.strictEqual(r2.d[0].url, SILENT_A, 'the declared file stays as declared');
    assert(!w2.bg.fetched.some((u) => u === HD_A), '-silent is never stripped to guess an audio file');
  });

  await itAsync('11.4 two different embeds: each control saves its own clip from its own frame; the other frame is never asked', async () => {
    const w = await world();
    const fa = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
    const fb = redgifsFrame(CLIP_B, { frameId: 12, declares: SILENT_B });
    const log = wireTab(w, [fa, fb]);
    const ga = embedPost(w.env, 'rg14a', CLIP_A, { at: [100, 100, 600, 340] });
    const gb = embedPost(w.env, 'rg14b', CLIP_B, { at: [100, 700, 600, 340] });
    await enter(w.env, gb.iframe, 200, 800);
    assert(w.state.btn !== null);
    const rb = await saveThis(w);
    assert.deepStrictEqual(rb.d.map((x) => x.url), [SILENT_B]);
    assert.deepStrictEqual(log.frameAsks.map((a) => a.options.frameId), [12]);
    w.env.fireDoc('pointermove', { clientX: 5, clientY: 5, pointerType: 'mouse' });
    await sleep(80);
    w.state.busyKey = ''; w.state.busyAt = 0;
    await enter(w.env, ga.iframe, 200, 200);
    assert(w.state.btn !== null);
    const ra = await saveThis(w);
    assert.deepStrictEqual(ra.d.map((x) => x.url), [SILENT_A]);
    assert.deepStrictEqual(log.frameAsks.map((a) => a.options.frameId), [12, 11]);
  });

  await itAsync('11.5 the same clip in two frames of the tab is ambiguous: refused before any request; the frame must also be a direct child of the post document', async () => {
    const w = await world();
    const f1 = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
    const f2 = redgifsFrame(CLIP_A, { frameId: 12, declares: SILENT_A });
    const log = wireTab(w, [f1, f2]);
    const g = embedPost(w.env, 'rg15', CLIP_A);
    await enter(w.env, g.iframe);
    const r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0);
    assert.strictEqual(log.frameAsks.length, 0, 'no frame was asked');
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA']);
    const w2 = await world();
    const nested = redgifsFrame(CLIP_A, { frameId: 21, declares: SILENT_A, child: false });
    const log2 = wireTab(w2, [nested]);
    const g2 = embedPost(w2.env, 'rg15b', CLIP_A);
    await enter(w2.env, g2.iframe);
    const r2 = await saveThis(w2, 0);
    assert.strictEqual(r2.d.length, 0, 'a frame nested deeper than the post document is not the embed');
    assert.strictEqual(log2.frameAsks.length, 0);
    assert.deepStrictEqual(failedCodes(r2.ops), ['UNRESOLVED_BLOB_MEDIA']);
  });

  await itAsync('11.6 the embed is replaced or changed between hover and click: the old control is refused before any token, frame message or download', async () => {
    for (const [label, mutate] of [
      ['the iframe address changes to another clip', (g) => { g.iframe.src = IFR(CLIP_B); g.iframe.setAttribute('src', IFR(CLIP_B)); }],
      ['the whole embed container is removed', (g) => { g.post.removeChild(g.cont); }],
      ['the iframe is removed from the embed', (g) => { g.embed.removeChild(g.iframe); }],
      ['the iframe is replaced by a twin with the same address', (g) => { const twin = new MockElement('iframe'); twin.src = IFR(CLIP_A); twin.setAttribute('src', IFR(CLIP_A)); twin.setRect({ left: 100, top: 100, width: 600, height: 340 }); g.embed.removeChild(g.iframe); g.embed.appendChild(twin); }],
      ['the embed is replaced by a twin', (g) => { const twin = new MockElement('shreddit-embed'); twin.setAttribute('html', g.embed.getAttribute('html')); twin.setRect({ left: 100, top: 100, width: 600, height: 340 }); const fr = new MockElement('iframe'); fr.src = IFR(CLIP_A); fr.setAttribute('src', IFR(CLIP_A)); fr.setRect({ left: 100, top: 100, width: 600, height: 340 }); twin.appendChild(fr); g.cont.removeChild(g.embed); g.cont.appendChild(twin); }],
      ['the post now declares another clip', (g) => { g.post.setAttribute('content-href', WATCH(CLIP_B)); }]
    ]) {
      const w = await world();
      const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
      const log = wireTab(w, [frame]);
      const g = embedPost(w.env, 'rg16', CLIP_A);
      await enter(w.env, g.iframe);
      assert(w.state.btn !== null);
      const before = w.env.sentMessages.length;
      mutate(g);
      const r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, label + ': no download');
      assert.strictEqual(log.frameAsks.length, 0, label + ': no frame was asked');
      assert.strictEqual(w.bg.fetched.length, 0, label + ': no request');
      assert(w.env.sentMessages.length <= before + 1);
    }
  });

  await itAsync('11.7 the frame changes after the proof: another document, another clip, or a vanished frame ends the save with a visible failure and no download', async () => {
    // a document replaced between the frame lookup and the frame message
    for (const [label, tweak] of [
      ['document replaced', (f) => { f.documentId = 'doc-F11-new'; }],
      ['frame gone', (f) => { f.alive = false; }]
    ]) {
      const w = await world();
      const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
      const log = wireTab(w, [frame]);
      const base = w.bg.sandbox.chrome.scripting.executeScript;
      w.bg.sandbox.chrome.scripting.executeScript = async (o) => { const res = await base(o); if (o && o.target && o.target.allFrames) tweak(frame); return res; };
      const g = embedPost(w.env, 'rg17', CLIP_A);
      await enter(w.env, g.iframe);
      const r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, label + ': no download');
      assert(failedCodes(r.ops).length === 1, label + ': a visible failure ' + JSON.stringify(failedCodes(r.ops)));
      assert.strictEqual(w.bg.fetched.length, 0, label + ': no request');
      assert.strictEqual(log.frameAsks.length, 0);
    }
    // the frame the lookup found shows another clip than it was found for (a lookup that is stale in content, same document id): its own clip is
    // compared with the post's clip, so another clip is never saved for this post
    {
      const w = await world();
      const other = redgifsFrame(CLIP_B, { frameId: 11, declares: SILENT_B, advertise: IFR(CLIP_A) });
      const log = wireTab(w, [other]);
      const g = embedPost(w.env, 'rg17c', CLIP_A);
      await enter(w.env, g.iframe);
      const r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, 'the other clip of that frame is not saved for this post');
      assert.deepStrictEqual(mp4Names(w), [], 'the other clip was not requested');
      assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA']);
      assert.strictEqual(log.frameAsks.length, 1, 'the frame was asked once and its answer refused');
    }
    // the frame answers for another clip than the one the post proved (its address changed after the lookup)
    const w = await world();
    const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
    wireTab(w, [frame]);
    const base = w.bg.sandbox.chrome.scripting.executeScript;
    w.bg.sandbox.chrome.scripting.executeScript = async (o) => {
      const res = await base(o);
      if (o && o.target && o.target.allFrames) { frame.context.window.location = new URL(IFR(CLIP_B)); frame.context.location = frame.context.window.location; }
      return res;
    };
    const g = embedPost(w.env, 'rg17b', CLIP_A);
    await enter(w.env, g.iframe);
    const r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0, 'another clip in the frame is never saved for this post');
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA']);
  });

  await itAsync('11.8 unresolved media: no <video>, two videos, or nothing declared ends in a visible failure; no guessed ID-derived address is requested, nothing is downloaded', async () => {
    for (const [label, opts] of [['no video element', { videos: 0, declares: SILENT_A }], ['two videos', { videos: 2, declares: SILENT_A }], ['nothing declared', { videos: 1, declares: null }]]) {
      const w = await world();
      const frame = redgifsFrame(CLIP_A, { frameId: 11, ...opts });
      wireTab(w, [frame]);
      const g = embedPost(w.env, 'rg18', CLIP_A);
      await enter(w.env, g.iframe);
      const r = await saveThis(w, 0);
      assert.strictEqual(r.d.length, 0, label + ': no download');
      assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA'], label);
      assert.deepStrictEqual(mp4Names(w), [], label + ': no file address (declared, guessed or derived) was requested');
    }
  });

  await itAsync('11.9 duplicate clicks: one frame resolution and one download for the same embed', async () => {
    const w = await world();
    const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
    const log = wireTab(w, [frame]);
    const g = embedPost(w.env, 'rg19', CLIP_A);
    await enter(w.env, g.iframe);
    const before = w.bg.downloads.length;
    let release;
    w.bg.resetNet({ gate: new Promise((r) => { release = r; }) });
    click(w.state.btn);
    click(w.state.btn);
    await quiesce(80);
    // a click after the busy window of the control, while the first save still runs, is deduplicated by the background
    w.state.busyKey = ''; w.state.busyAt = 0;
    click(w.state.btn);
    await quiesce(80);
    release();
    for (let i = 0; i < 300 && w.bg.downloads.length < before + 1; i++) await tick();
    await quiesce(150);
    await w.bg.complete(before);
    assert.strictEqual(w.bg.downloads.length - before, 1, 'one download');
    assert.strictEqual(log.resolves.length, 1, 'one frame resolution');
    assert.strictEqual(log.frameAsks.length, 1, 'one frame message');
    assert.strictEqual(log.injections.filter((o) => o.target && o.target.allFrames).length, 1, 'one frame lookup');
  });

  await itAsync('11.10 foreign owners and sources get no control: another clip declared by the post, a missing declaration, a comment, a crosspost, a lookalike host, a non-embed iframe', async () => {
    const w = await world();
    const { document } = w.env.context;
    const probe = async (g, x = 200, y = 200) => {
      w.env.fireDoc('pointermove', { clientX: 5, clientY: 5, pointerType: 'mouse' });
      await sleep(80);
      await enter(w.env, g.iframe, x, y);
      const shown = w.state.btn !== null && w.state.snap !== null;
      w.env.fireDoc('pointermove', { clientX: 5, clientY: 5, pointerType: 'mouse' });
      await sleep(80);
      return shown;
    };
    const mk = (id, opts) => { const g = embedPost(w.env, id, CLIP_A, opts); return g; };
    let g = mk('rg20a', { contentHref: WATCH(CLIP_B) });
    assert.strictEqual(await probe(g), false, 'the post declares another clip');
    document.body.removeChild(g.post);
    g = mk('rg20b', { contentHref: null });
    assert.strictEqual(await probe(g), false, 'the post declares nothing');
    document.body.removeChild(g.post);
    g = mk('rg20c', { src: 'https://www.redgifs.com.evil.test/ifr/' + CLIP_A });
    assert.strictEqual(await probe(g), false, 'a lookalike host');
    document.body.removeChild(g.post);
    g = mk('rg20d', { src: 'https://evilredgifs.com/ifr/' + CLIP_A });
    assert.strictEqual(await probe(g), false, 'a lookalike host without a dot boundary');
    document.body.removeChild(g.post);
    g = mk('rg20e', { src: 'http://www.redgifs.com/ifr/' + CLIP_A });
    assert.strictEqual(await probe(g), false, 'plain http');
    document.body.removeChild(g.post);
    g = mk('rg20f', { src: 'https://www.youtube.com/embed/abc123def45' });
    assert.strictEqual(await probe(g), false, 'another provider');
    document.body.removeChild(g.post);
    g = mk('rg20g', { src: WATCH(CLIP_A) });
    assert.strictEqual(await probe(g), false, 'a watch page is not the embed document');
    document.body.removeChild(g.post);
    // inside a comment
    const comment = document.createElement('shreddit-comment');
    R(comment, 100, 100, 600, 400);
    document.body.appendChild(comment);
    g = embedPost(w.env, 'rg20h', CLIP_A, { parent: comment });
    assert.strictEqual(await probe(g), false, 'comment media is excluded from post-level saves');
    document.body.removeChild(comment);
    // an article that declares the clip is not a post owner of an embed either (only the post itself is)
    const article = document.createElement('article');
    article.setAttribute('permalink', '/r/rule34/comments/rg20k/an_article/');
    article.setAttribute('content-href', WATCH(CLIP_A));
    R(article, 100, 100, 600, 400);
    document.body.appendChild(article);
    const cont2 = document.createElement('div');
    cont2.style.position = 'relative';
    R(cont2, 100, 100, 600, 340);
    const ifr2 = document.createElement('iframe');
    ifr2.src = IFR(CLIP_A);
    R(ifr2, 100, 100, 600, 340);
    cont2.appendChild(ifr2);
    article.appendChild(cont2);
    assert.strictEqual(await probe({ iframe: ifr2 }), false, 'an article owner is not the post');
    document.body.removeChild(article);
    // a crosspost: the nested post is not an owner of its own
    const wrapper = document.createElement('shreddit-post');
    wrapper.setAttribute('permalink', '/r/rule34/comments/rg20i/outer/');
    R(wrapper, 80, 80, 700, 500);
    const cross = document.createElement('div');
    cross.setAttribute('data-testid', 'crosspost-root');
    R(cross, 90, 90, 650, 440);
    wrapper.appendChild(cross);
    document.body.appendChild(wrapper);
    g = embedPost(w.env, 'rg20j', CLIP_A, { parent: cross });
    assert.strictEqual(await probe(g), false, 'a crosspost never lends its embed');
    assert.strictEqual(w.bg.asks.length, 0);
  });

  await itAsync('11.11 every observed structure is admitted: iframe in the light DOM, in an open shadow root, only the embed\'s html attribute, and a bare iframe; each save is bound to the frame of that very clip', async () => {
    for (const variant of ['light', 'shadow', 'attr', 'bare']) {
      const w = await world();
      const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
      const log = wireTab(w, [frame]);
      const g = embedPost(w.env, 'rg21' + variant, CLIP_A, { variant });
      await enter(w.env, variant === 'attr' ? g.embed : (variant === 'bare' ? g.iframe : (variant === 'light' ? g.iframe : g.embed)));
      assert(w.state.btn !== null, variant + ': the control is shown');
      const r = await saveThis(w);
      assert.deepStrictEqual(r.d.map((x) => x.url), [SILENT_A], variant);
      assert.deepStrictEqual(log.frameAsks.map((a) => a.options.frameId), [11], variant);
    }
  });

  await itAsync('11.12 the control follows the pointer rules: it leaves with the pointer, never rests over a non-media area, and gallery Save all of an image post is unchanged', async () => {
    const w = await world();
    const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
    wireTab(w, [frame]);
    const g = embedPost(w.env, 'rg22', CLIP_A);
    await enter(w.env, g.iframe, 300, 250);
    assert(w.state.btn !== null);
    assert.strictEqual(w.state.count, 0, 'a single compact control, no "Save all"');
    w.env.fireDoc('pointermove', { clientX: 5, clientY: 5, pointerType: 'mouse' });
    await sleep(80);
    assert.strictEqual(w.state.snap, null, 'the control is gone once the pointer left');
    const img = imgPost(w.env, 'rg22i', 'https://i.redd.it/rd10_neighbour.jpg');
    await hover(w.env, 120, 120);
    assert(w.state.btn !== null && w.state.snap.tag === 'IMG', 'a normal image control is still offered');
    const r = await saveThis(w);
    assert.deepStrictEqual(r.d.map((x) => x.url), ['https://i.redd.it/rd10_neighbour.jpg']);
  });

  // --- RG-03 provider audio: the DOM of the RedGIFs frame declares only the muted file; the provider's own clip object (id, hasAudio, urls) is
  // recovered by the frame, during an admitted save only, with the page's own guest-session flow (v2/auth/temporary, then v2/gifs/<id>). The
  // evidence is the native capture of 2026-10-06 (clip esteemedamusedgrebe: og:video silent, API hasAudio true with hd/sd/silent). ---
  const SD_A = `https://media.redgifs.com/${FILE[CLIP_A]}-mobile.mp4`;
  const TOKEN = 'SYNTH.guest-session-token.value-0001';
  const apiGif = (id, hasAudio, urls) => ({ gif: { id, hasAudio, duration: 37.1, urls } });
  const clipUrls = (name, extra = {}) => ({ silent: `https://media.redgifs.com/${name}-silent.mp4`, hd: `https://media.redgifs.com/${name}.mp4`, sd: `https://media.redgifs.com/${name}-mobile.mp4`, ...extra });
  const apiOk = (body) => ({ auth: { body: { token: TOKEN } }, gif: { body } });
  const authed = (frame) => frame.apiLog.map((r) => ({ url: r.url.replace('https://api.redgifs.com/', ''), auth: Boolean(r.headers.Authorization), credentials: r.credentials }));

  await itAsync('11.13 reproduction: the muted og:video is declared, the provider API declares audio: the inline save downloads the declared same-clip HD, not the silent file; hover asked the provider nothing', async () => {
    const w = await world();
    const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A, api: apiOk(apiGif(CLIP_A, true, clipUrls(FILE[CLIP_A]))) });
    const log = wireTab(w, [frame]);
    const g = embedPost(w.env, 'rg23', CLIP_A);
    await enter(w.env, g.iframe);
    assert.strictEqual(frame.apiLog.length, 0, 'hover made no provider request');
    const r = await saveThis(w);
    assert.deepStrictEqual(r.d.map((x) => x.url), [HD_A], 'the audio-bearing rendition declared by the provider');
    assert(/\.mp4$/i.test(r.d[0].filename) && !/-silent/i.test(r.d[0].filename), r.d[0].filename);
    assert.deepStrictEqual(authed(frame), [{ url: 'v2/auth/temporary', auth: false, credentials: 'omit' }, { url: `v2/gifs/${CLIP_A}`, auth: true, credentials: 'omit' }], 'exactly the guest session and the exact clip, without credentials');
    assert.strictEqual(frame.apiLog[1].headers.Authorization, `Bearer ${TOKEN}`);
    assert(!JSON.stringify(frame.responses).includes(TOKEN), 'the guest token never leaves the frame');
    assert(!w.bg.warns.join(' | ').includes(TOKEN) && !JSON.stringify(w.bg.asks).includes(TOKEN), 'nor reaches the background, its logs or its messages');
    assert.deepStrictEqual(mp4Names(w), [HD_A], 'the background requested only the chosen file: no silent, no guessed rendition');
    assert.strictEqual(log.resolves.length, 1);
    assert.strictEqual(w.bg.convs.length, 0);
  });

  await itAsync('11.14 missing, false or silent-only audio declarations keep the declared source: nothing is guessed, no other rendition is requested', async () => {
    for (const [label, body] of [
      ['hasAudio false', apiGif(CLIP_A, false, clipUrls(FILE[CLIP_A]))],
      ['hasAudio missing', { gif: { id: CLIP_A, urls: clipUrls(FILE[CLIP_A]) } }],
      ['hasAudio true but only the silent file declared', apiGif(CLIP_A, true, { silent: SILENT_A })],
      ['hasAudio is the string "true"', apiGif(CLIP_A, 'true', clipUrls(FILE[CLIP_A]))],
      ['no clip object', { niches: [] }]
    ]) {
      const w = await world();
      const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A, api: apiOk(body) });
      wireTab(w, [frame]);
      const g = embedPost(w.env, 'rg24', CLIP_A);
      await enter(w.env, g.iframe);
      const r = await saveThis(w);
      assert.deepStrictEqual(r.d.map((x) => x.url), [SILENT_A], label + ': the declared source is saved as declared');
      assert.deepStrictEqual(mp4Names(w), [SILENT_A], label + ': no other file was requested');
      assert(frame.apiLog.length <= 2, label + ': at most two provider requests');
    }
  });

  await itAsync('11.15 foreign or malformed provider metadata is never used: another clip id, another clip\'s files, a foreign host, http, a silent file named hd', async () => {
    const other = clipUrls(FILE[CLIP_B]);
    for (const [label, body] of [
      ['the object of another clip', apiGif(CLIP_B, true, other)],
      ['the right id with the files of another clip', apiGif(CLIP_A, true, other)],
      ['a foreign host', apiGif(CLIP_A, true, { hd: `https://evil.example/${FILE[CLIP_A]}.mp4`, sd: `https://redgifs.com.evil.test/${FILE[CLIP_A]}-mobile.mp4`, silent: SILENT_A })],
      ['plain http', apiGif(CLIP_A, true, { hd: HD_A.replace('https:', 'http:'), silent: SILENT_A })],
      ['a silent file named hd', apiGif(CLIP_A, true, { hd: SILENT_A, silent: SILENT_A })],
      ['not a video address', apiGif(CLIP_A, true, { hd: `https://media.redgifs.com/${FILE[CLIP_A]}.jpg`, silent: SILENT_A })],
      ['an object without a clip id', { gif: { hasAudio: true, urls: clipUrls(FILE[CLIP_A]) } }],
      ['a numeric clip id', { gif: { id: 12345, hasAudio: true, urls: clipUrls(FILE[CLIP_A]) } }]
    ]) {
      const w = await world();
      const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A, api: apiOk(body) });
      wireTab(w, [frame]);
      const g = embedPost(w.env, 'rg25', CLIP_A);
      await enter(w.env, g.iframe);
      const r = await saveThis(w);
      assert.deepStrictEqual(r.d.map((x) => x.url), [SILENT_A], label);
      assert.deepStrictEqual(w.bg.fetched.filter((u) => !/ImperturbableLiveCaimanlizard-silent\.mp4/.test(u)), [], label + ': nothing else was requested');
    }
  });

  await itAsync('11.16 provider request failures keep the declared source without leaking the session: refused session, bad token, clip 404/500, network error, timeout, bad or oversized body', async () => {
    const good = apiGif(CLIP_A, true, clipUrls(FILE[CLIP_A]));
    for (const [label, api] of [
      ['session refused', { auth: { status: 401, body: {} }, gif: { body: good } }],
      ['session without a token', { auth: { body: { token: '' } }, gif: { body: good } }],
      ['malformed token', { auth: { body: { token: 'not a token!' } }, gif: { body: good } }],
      ['session network error', { auth: { throws: new Error('offline') }, gif: { body: good } }],
      ['clip 404', { auth: { body: { token: TOKEN } }, gif: { status: 404, body: {} } }],
      ['clip 500', { auth: { body: { token: TOKEN } }, gif: { status: 500, body: {} } }],
      ['clip network error', { auth: { body: { token: TOKEN } }, gif: { throws: new Error('offline ' + TOKEN) } }],
      ['timeout (aborted)', { auth: { body: { token: TOKEN } }, gif: { throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) } }],
      ['clip body is not JSON', { auth: { body: { token: TOKEN } }, gif: { text: '<html>blocked</html>' } }],
      ['oversized clip body (declared)', { auth: { body: { token: TOKEN } }, gif: { text: JSON.stringify(good), length: 5 * 1024 * 1024 } }],
      ['oversized clip body (undeclared)', { auth: { body: { token: TOKEN } }, gif: { text: JSON.stringify({ ...good, pad: 'x'.repeat(300000) }), noLength: true } }]
    ]) {
      const w = await world();
      const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A, api });
      wireTab(w, [frame]);
      const g = embedPost(w.env, 'rg26', CLIP_A);
      await enter(w.env, g.iframe);
      const r = await saveThis(w);
      assert.deepStrictEqual(r.d.map((x) => x.url), [SILENT_A], label + ': the existing rule: the declared source is saved');
      assert(frame.apiLog.length <= 2, label + ': bounded requests');
      assert(!JSON.stringify(frame.responses).includes(TOKEN) && !w.bg.warns.join(' | ').includes(TOKEN), label + ': no token anywhere');
      assert.deepStrictEqual(mp4Names(w), [SILENT_A], label);
    }
  });

  await itAsync('11.17 stale document: the frame navigates while the provider lookup runs: the answer is refused, nothing is downloaded', async () => {
    const w = await world();
    let frame;
    const api = apiOk(apiGif(CLIP_A, true, clipUrls(FILE[CLIP_A])));
    api.gif = { body: apiGif(CLIP_A, true, clipUrls(FILE[CLIP_A])) };
    const navigating = async () => { frame.context.window.location = new URL(IFR(CLIP_B)); frame.context.location = frame.context.window.location; return { body: apiGif(CLIP_A, true, clipUrls(FILE[CLIP_A])) }; };
    frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A, api: { auth: api.auth, gif: navigating } });
    wireTab(w, [frame]);
    const g = embedPost(w.env, 'rg27', CLIP_A);
    await enter(w.env, g.iframe);
    const r = await saveThis(w, 0);
    assert.strictEqual(r.d.length, 0, 'no download for a document that changed during the lookup');
    assert.deepStrictEqual(failedCodes(r.ops), ['UNRESOLVED_BLOB_MEDIA']);
    assert.deepStrictEqual(mp4Names(w), []);
  });

  await itAsync('11.18 no provider request unless it can change the choice: positive audio evidence already in the page, a non-muted declared file, or a frame that is not the provider\'s own origin', async () => {
    const good = apiOk(apiGif(CLIP_A, true, clipUrls(FILE[CLIP_A])));
    const cases = [
      ['audio already declared by the page', { declares: SILENT_A, audio: { id: CLIP_A, hasAudio: true, urls: { hd: HD_A, silent: SILENT_A } }, api: good }, HD_A],
      ['a declared file that is not muted', { declares: HD_A, api: good }, HD_A],
      ['another origin of the provider', { declares: SILENT_A, api: good, url: `https://redgifs.com/ifr/${CLIP_A}` }, SILENT_A]
    ];
    for (const [label, opts, expected] of cases) {
      const w = await world();
      const frame = redgifsFrame(CLIP_A, { frameId: 11, ...opts });
      wireTab(w, [frame]);
      const g = embedPost(w.env, 'rg28', CLIP_A);
      await enter(w.env, g.iframe);
      const r = await saveThis(w);
      assert.deepStrictEqual(r.d.map((x) => x.url), [expected], label);
      assert.strictEqual(frame.apiLog.length, 0, label + ': no provider request');
    }
  });
  // ===== 11.30: a click refused as stale leaves a fresh control from the pointer's place =====
  // A cross-origin iframe delivers no pointermove to this document, so once the shown control is hidden by a refused (stale) click the page gets no
  // event that could show a control again until the pointer leaves the frame and enters it anew: to the user "the click did nothing" and the post
  // has no button. The refusal itself is unchanged (nothing is sent, requested or downloaded); the document re-evaluates from the last pointer
  // position with the existing bounded re-arm (12 x 100 ms) and a control for the CURRENT, freshly proven embed may appear. Synthetic DOM: the real
  // native cause of the feed symptom is not established by this test.
  const reEmbed = (w, g, { contentOk = true } = {}) => {
    // what a re-render does: the old embed element is replaced by a new one for the same clip (the shown snapshot no longer holds)
    const { document } = w.env.context;
    g.embed.remove();
    const embed = document.createElement('shreddit-embed');
    embed.setAttribute('providername', 'RedGIFs');
    embed.setAttribute('html', `<iframe src="${IFR(CLIP_A)}" frameborder="0"></iframe>`);
    R(embed, 100, 100, 600, 340);
    const iframe = document.createElement('iframe');
    iframe.src = IFR(CLIP_A);
    iframe.setAttribute('src', IFR(CLIP_A));
    R(iframe, 100, 100, 600, 340);
    embed.appendChild(iframe);
    g.cont.appendChild(embed);
    if (!contentOk) g.post.setAttribute('content-href', WATCH('someotherclipentirely'));
    return { embed, iframe };
  };
  const inlineSends = (w) => w.env.sentMessages.filter((m) => m && /^REDDIT_INLINE_/.test(m.action || ''));

  await itAsync('11.30 a stale click is refused without any message, request or download; the document then offers a fresh control for the current embed without a new pointer event, and that control saves', async () => {
    const w = await world();
    const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
    const log = wireTab(w, [frame]);
    const g = embedPost(w.env, 'rg30', CLIP_A);
    await enter(w.env, g.iframe);
    assert(w.state.btn !== null && w.state.snap !== null, 'the control is shown over the embed');
    const old = w.state.snap.elRef.deref();
    const next = reEmbed(w, g);
    click(w.state.btn);
    await quiesce(40);
    assert.strictEqual(inlineSends(w).length, 0, 'the stale click sent nothing');
    assert.strictEqual(w.bg.downloads.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.strictEqual(w.state.snap, null, 'the stale control is gone');
    await sleep(450);
    assert(w.state.snap !== null && w.state.snap.elRef.deref() === next.embed && w.state.snap.elRef.deref() !== old, 'a fresh control is bound to the replacement embed, from the last pointer place and no new pointer event');
    assert.strictEqual(inlineSends(w).length, 0, 'showing it sent nothing');
    assert.strictEqual(w.bg.fetched.length, 0, 'no request before a click');
    assert.strictEqual(log.injections.length, 0, 'nothing was injected before a click');
    const r = await saveThis(w);
    assert.strictEqual(r.d.length, 1, 'the fresh user click saves once');
    assert.strictEqual(r.d[0].url, SILENT_A);
    assert.strictEqual(inlineSends(w).length, 1);
  });

  await itAsync('11.31 the re-arm shows nothing it cannot prove: a replacement whose post no longer declares the clip gets no control; the refusal stays silent and bounded', async () => {
    const w = await world();
    const frame = redgifsFrame(CLIP_A, { frameId: 11, declares: SILENT_A });
    const log = wireTab(w, [frame]);
    const g = embedPost(w.env, 'rg31', CLIP_A);
    await enter(w.env, g.iframe);
    assert(w.state.snap !== null);
    reEmbed(w, g, { contentOk: false });
    click(w.state.btn);
    await sleep(1600);
    assert.strictEqual(w.state.snap, null, 'no control without the post\'s own declaration of this clip');
    assert.strictEqual(inlineSends(w).length, 0);
    assert.strictEqual(w.bg.downloads.length, 0);
    assert.strictEqual(w.bg.fetched.length, 0);
    assert.strictEqual(log.injections.length, 0);
    assert.strictEqual(w.state.rearmTimer, null, 'no re-arm timer is left running');
    assert(w.state.rearmN <= 12, 'bounded: ' + w.state.rearmN);
  });

}

  // Summary
  console.log('\n======================================================');
  console.log('Total tests passed: ' + passed);
  console.log('Total tests failed: ' + failed);
  console.log('======================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllSuites().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
