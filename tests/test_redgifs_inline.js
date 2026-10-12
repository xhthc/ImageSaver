'use strict';

/**
 * test_redgifs_inline.js
 *
 * REDGIFS-INLINE-01: the inline Save control of the provider's own site. The real content/content_redgifs.js runs in one vm context (a native-shaped mock
 * DOM with fake timers and a mock provider API) and the real background.js in another (mock Chrome); the two are wired the way Chrome wires them
 * (runtime.sendMessage with a sender, tabs.sendMessage pinned to a frame and a document). Node mocks only: no Chromium, no real provider request,
 * no real download, no native audio.
 */

const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { webcrypto } = require('crypto');

const CONTENT_CODE = fs.readFileSync(path.join(REPO_ROOT, 'content/content_redgifs.js'), 'utf8');
const BG_CODE = fs.readFileSync(path.join(REPO_ROOT, 'background.js'), 'utf8');

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Mock DOM (class names are matched case-sensitively, as a standards-mode document does)
// ---------------------------------------------------------------------------------------------------------------------------------------------
class El {
  constructor(tag, attrs = {}, rect = null) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.parentElement = null;
    this._kids = [];
    this._connected = false;
    this.attributes = {};
    this.src = '';
    this.currentSrc = '';
    this.textContent = '';
    this.rect = rect;
    this.listeners = {};
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }
  get parentNode() { return this.parentElement; }
  get isConnected() { return this._connected; }
  set isConnected(v) { this._link(Boolean(v)); }
  _link(v) { this._connected = v; for (const k of this._kids) k._link(v); }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; }
  setAttribute(n, v) {
    this.attributes[n] = String(v);
    if (n === 'src') { this.src = String(v); if (this.tagName === 'VIDEO') this.currentSrc = String(v); }
  }
  removeAttribute(n) { delete this.attributes[n]; }
  appendChild(c) {
    if (c.parentElement) c.parentElement.removeChild(c);
    c.parentElement = this;
    this._kids.push(c);
    c._link(this._connected);
    return c;
  }
  removeChild(c) {
    const i = this._kids.indexOf(c);
    if (i < 0) return null;
    this._kids.splice(i, 1);
    c.parentElement = null;
    c._link(false);
    return c;
  }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); else this._link(false); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  contains(n) { for (let c = n; c; c = c.parentElement) if (c === this) return true; return false; }
  // focus moves the document's activeElement and fires blur on the element that loses it and focus on the one that gets it, as a browser does
  focus() {
    const w = El.world;
    if (!w || w.doc.activeElement === this) return;
    const prev = w.doc.activeElement;
    w.doc.activeElement = this;
    if (prev) for (const l of prev.listeners.blur || []) l({ target: prev });
    for (const l of this.listeners.focus || []) l({ target: this });
  }
  blur() {
    const w = El.world;
    if (!w || w.doc.activeElement !== this) return;
    w.doc.activeElement = null;
    for (const l of this.listeners.blur || []) l({ target: this });
  }
  getBoundingClientRect() {
    if (this.attributes['data-image-saver-inline'] === 'redgifs' && this.parentElement) {
      // an absolutely positioned host: its place is the containing player's origin plus its own offset, so a scrolled player carries it along
      const p = this.parentElement.getBoundingClientRect();
      const l = p.left + parseFloat(this.style.props.left || '0');
      const tp = p.top + parseFloat(this.style.props.top || '0');
      return { left: l, top: tp, width: 32, height: 32, right: l + 32, bottom: tp + 32 };
    }
    const r = this.rect || { left: 0, top: 0, width: 0, height: 0 };
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
  }
  matches(sel) {
    const cls = (this.attributes.class || '').split(/\s+/);
    return sel.split(',').map((s) => s.trim()).some((p) => p.toLowerCase() === this.tagName.toLowerCase() || (p.startsWith('.') && cls.includes(p.slice(1))));
  }
  closest(sel) { for (let c = this; c; c = c.parentElement) if (c.matches(sel)) return c; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const k of n._kids) { if (k.matches(sel)) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

const TOKEN = 'synthetic-session-token';
const media = (name, suffix = '', ext = 'mp4') => `https://media.redgifs.com/${name}${suffix}.${ext}`;
const posterUrl = (name) => media(name, '-mobile', 'jpg');

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The page: the content script's world
// ---------------------------------------------------------------------------------------------------------------------------------------------
function makeWorld({ url = 'https://www.redgifs.com/niches/ecchi-anime', docId = 'doc-1', tabId = 7, frameId = 0, top = true, bg = null, gifs = {}, onApi = null } = {}) {
  const world = { url, docId, tabId, frameId, bg, gifs, fetchCalls: [], sent: [], now: 1_000_000_000_000, timers: [], timerSeq: 1, listeners: {}, messageListeners: [], cards: [], metas: [], layers: [] };
  const html = new El('html');
  const body = new El('body');
  html.appendChild(body);
  html.isConnected = true;
  world.body = body;
  world.html = html;
  El.world = world; // focus moves this world's activeElement
  const win = {
    location: new URL(url),
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (t, fn) => { (world.listeners[t] ||= []).push(fn); },
    removeEventListener() {}
  };
  win.top = top ? win : {};
  const doc = {
    documentElement: html,
    body,
    hidden: false,
    activeElement: null,
    createElement: (t) => new El(t),
    createElementNS: (ns, t) => new El(t),
    querySelectorAll: (s) => (/meta/.test(s) ? world.metas : html.querySelectorAll(s)),
    querySelector: (s) => (/meta/.test(s) ? null : html.querySelector(s)),
    contains: (n) => { for (let c = n; c; c = c.parentElement) if (c === html) return true; return false; },
    elementsFromPoint: (x, y) => {
      const inside = (r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
      const out = world.layers.filter((l) => l.el.isConnected && !l.hidden && inside(l.rect)).map((l) => l.el); // unrelated layers lie above everything
      for (const c of world.cards) {
        if (!c.video.isConnected || !inside(c.player.rect)) continue;
        const host = c.player._kids.find((k) => k.getAttribute('data-image-saver-inline') === 'redgifs');
        if (host && host.style.props.opacity === '1') out.push(host);
        if (c.tracking) out.push(c.tracking);
        out.push(c.overlay, c.video, c.holder, c.player, c.tap, c.gif);
      }
      return out.concat([body, html]);
    }
  };
  const chrome = {
    runtime: {
      id: 'testid',
      onMessage: { addListener: (fn) => world.messageListeners.push(fn) },
      sendMessage: (msg) => {
        world.sent.push(msg);
        return bg ? bg.fromContent(world, msg) : Promise.resolve();
      }
    }
  };
  const fetchImpl = async (u) => {
    u = String(u);
    world.fetchCalls.push(u);
    if (onApi) { const r = onApi(u, world.fetchCalls.length); if (r && typeof r.then === 'function') await r; }
    const reply = (b) => ({ ok: true, status: 200, headers: { get: () => null }, body: new Blob([JSON.stringify(b)]).stream() });
    if (u.endsWith('v2/auth/temporary')) return reply({ token: TOKEN });
    const id = decodeURIComponent(u.split('/v2/gifs/')[1] || '');
    return reply({ gif: world.gifs[id] });
  };
  world.ctx = vm.createContext({
    window: win, document: doc, chrome, fetch: fetchImpl, console: { log() {}, warn() {}, error() {} },
    URL, TextDecoder, Array, Object, Number, String, Boolean, Set, Map, Uint8Array, Promise, JSON, Math, RegExp, Error, Symbol, AbortController,
    crypto: webcrypto,
    Date: { now: () => world.now },
    requestAnimationFrame: (fn) => { const id = world.timerSeq++; world.timers.push({ id, at: world.now + 16, fn, every: 0, raf: true }); return id; },
    cancelAnimationFrame: (id) => { world.timers = world.timers.filter((tm) => tm.id !== id); },
    MutationObserver: class { constructor(cb) { world.observerCallback = cb; } observe() { world.observing = true; } disconnect() {} },
    setTimeout: (fn, ms) => { const id = world.timerSeq++; world.timers.push({ id, at: world.now + (ms || 0), fn, every: 0 }); return id; },
    clearTimeout: (id) => { world.timers = world.timers.filter((t) => t.id !== id); },
    setInterval: (fn, ms) => { const id = world.timerSeq++; world.timers.push({ id, at: world.now + ms, fn, every: ms }); return id; },
    clearInterval: (id) => { world.timers = world.timers.filter((t) => t.id !== id); }
  });
  world.win = win;
  world.doc = doc;
  world.run = () => vm.runInContext(CONTENT_CODE, world.ctx);
  world.advance = (ms) => {
    const end = world.now + ms;
    for (;;) {
      const due = world.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      world.now = Math.max(world.now, due.at);
      if (due.every) due.at += due.every; else world.timers = world.timers.filter((t) => t !== due);
      due.fn();
    }
    world.now = end;
  };
  world.fire = (type, event) => { for (const l of world.listeners[type] || []) l(event); };
  world.move = (x, y) => { world.fire('pointermove', { clientX: x, clientY: y, pointerType: 'mouse', isTrusted: true }); world.advance(70); };
  world.state = () => world.ctx.redgifsInlineState;
  world.hosts = () => world.html.querySelectorAll('div').filter((d) => d.getAttribute('data-image-saver-inline') === 'redgifs');
  world.hostOf = (card) => card.player._kids.find((k) => k.getAttribute('data-image-saver-inline') === 'redgifs') || null;
  world.btnOf = (card) => { const h = world.hostOf(card); return h ? h._kids[0] : null; };
  world.visible = (card) => { const h = world.hostOf(card); return Boolean(h && h.style.props.opacity === '1'); };
  // the observer reports a change of the page; the debounced scan then mounts and drops controls
  world.scan = () => { if (world.observerCallback) world.observerCallback([]); world.advance(150); };
  world.press = (btn, trusted = true) => { for (const l of btn.listeners.click || []) l({ isTrusted: trusted, stopPropagation() {}, preventDefault() {}, target: btn }); };
  world.key = (btn, key) => { let prevented = false; for (const l of btn.listeners.keydown || []) l({ key, preventDefault() { prevented = true; } }); return prevented; };
  // Tab / Shift+Tab over the native tab order: buttons and elements with tabindex >= 0, in document order
  world.tab = (shift = false) => {
    const list = [];
    const walk = (n) => { for (const k of n._kids) { if ((k.tagName === 'BUTTON' || Number(k.getAttribute('tabindex')) >= 0 && k.getAttribute('tabindex') !== null)) list.push(k); walk(k); } };
    walk(world.html);
    const at = list.indexOf(world.doc.activeElement);
    const next = shift ? (at <= 0 ? list[list.length - 1] : list[at - 1]) : (at < 0 || at === list.length - 1 ? list[0] : list[at + 1]);
    if (next) next.focus();
    world.advance(70);
    return next;
  };
  world.focusOrder = () => { const out = []; for (let i = 0; i < 40; i++) { const n = world.tab(); if (!n || out.includes(n)) break; out.push(n); } return out; };
  world.navigate = (u) => { world.win.location = new URL(u); world.url = u; };
  // Feed: GifPreview > TapTracker > Player > [Player-Poster image, Player-Video > video], the observed structure
  world.addCard = (name, { poster = true, blob = `blob:https://www.redgifs.com/card-${world.cards.length}`, parent = null, tracking = false, bare = false } = {}) => {
    const i = world.cards.length;
    const rect = { left: 0, top: 400 * i, width: 640, height: 360 };
    const gif = new El('div', { class: 'GifPreview GifPreview_isActive' }, rect);
    const tap = new El('div', { class: 'TapTracker' }, rect);
    const player = new El('div', { class: 'Player' }, rect);
    const posterEl = new El('img', { class: 'Player-Poster isHidden', src: poster ? posterUrl(name) : '' }, rect);
    const holder = new El('div', { class: 'Player-Video' }, rect);
    const video = new El('video', { class: 'isLoaded', src: blob }, rect);
    const overlay = new El('div', { class: 'touch-overlay' }, rect);
    if (poster) player.appendChild(posterEl);
    player.appendChild(holder);
    holder.appendChild(video);
    player.appendChild(overlay);
    if (bare) {
      (parent || world.body).appendChild(player);
    } else {
      gif.appendChild(tap);
      tap.appendChild(player);
      (parent || world.body).appendChild(gif);
    }
    const card = { name, blob, gif: bare ? player : gif, tap: bare ? player : tap, player, poster: posterEl, holder, video, overlay, y: rect.top + 100 };
    if (tracking) { card.tracking = new El('div', { class: 'tracking' }, rect); tap.appendChild(card.tracking); }
    world.cards.push(card);
    return card;
  };
  world.hover = (card) => world.move(100, card.y);
  // hover a player and activate its control with a trusted click
  world.activate = (card, trusted = true) => { world.hover(card); world.press(world.btnOf(card), trusted); };
  // the same Player and video node now show another clip
  world.swap = (card, name, blob = `blob:https://www.redgifs.com/swapped-${name}`) => { card.video.setAttribute('src', blob); card.poster.setAttribute('src', posterUrl(name)); card.blob = blob; };
  world.intervals = () => world.timers.filter((t) => t.every).length;
  world.frames = () => world.timers.filter((t) => t.raf).length;
  // where the control really is in the viewport
  world.rectOf = (card) => world.hostOf(card).getBoundingClientRect();
  world.addLayer = (rect) => { const el = new El('div', { class: 'modal' }, rect); world.body.appendChild(el); world.layers.push({ el, rect }); return el; };
  world.addOgVideo = (u) => world.metas.push({ getAttribute: (k) => ({ property: 'og:video', content: u })[k] || null });
  world.ask = (msg, sender = { id: 'testid' }) => new Promise((resolve) => {
    const r = world.messageListeners[0](msg, sender, resolve);
    if (r !== true) resolve(undefined);
  });
  return world;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The service worker: the real background.js with mock Chrome
// ---------------------------------------------------------------------------------------------------------------------------------------------
function makeBackground() {
  const env = { downloads: [], bgFetches: [], listeners: [], frameRequests: [], executed: [], worlds: new Map(), onFrameRequest: null, nextId: 9000 };
  const session = {};
  const local = {};
  const area = (store) => ({
    get: async (keys) => {
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store[k]]));
      if (keys && typeof keys === 'object') return Object.fromEntries(Object.keys(keys).map((k) => [k, store[k] !== undefined ? store[k] : keys[k]]));
      return { ...store };
    },
    set: async (items) => { Object.assign(store, JSON.parse(JSON.stringify(items))); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; }
  });
  const chrome = {
    runtime: {
      id: 'testid', lastError: null, getURL: (p) => `chrome-extension://testid/${p}`, getManifest: () => ({ version: '2.0.0' }),
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener: (cb) => env.listeners.push(cb) },
      getContexts: async () => [], sendMessage: async () => null
    },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
    contextMenus: { removeAll: (cb) => cb && cb(), create() {}, update: (id, p, cb) => cb && cb(), refresh() {}, onClicked: { addListener: (cb) => { env.menuHandler = cb; } }, onShown: { addListener() {} } },
    tabs: {
      onActivated: { addListener() {} }, onUpdated: { addListener() {} },
      sendMessage: async (tabId, msg, options = {}) => {
        const world = env.worlds.get(tabId);
        if (!world) throw new Error('Could not establish connection. Receiving end does not exist.');
        if (msg && msg.action === 'RESOLVE_FRAME_MEDIA') {
          env.frameRequests.push({ msg, options });
          if (env.onFrameRequest) env.onFrameRequest(world, msg);
        }
        if (options.frameId !== undefined && options.frameId !== world.frameId) throw new Error('No frame with id ' + options.frameId);
        if (options.documentId && options.documentId !== world.docId) throw new Error('No document with id ' + options.documentId);
        return world.ask(msg, { id: 'testid' });
      },
      create: async () => ({ id: 1 })
    },
    scripting: { executeScript: async (opts) => { env.executed.push(opts); throw new Error('no injection in this test'); } },
    downloads: {
      onChanged: { addListener() {} },
      download: (options, cb) => {
        env.downloads.push(options);
        const id = env.nextId++;
        if (typeof cb === 'function') cb(id);
        return Promise.resolve(id);
      },
      search: async () => [],
      show() {}
    },
    storage: { session: area(session), local: area(local) },
    notifications: { create: async (id) => id, clear() {}, onClicked: { addListener() {} } }
  };
  env.chrome = chrome;
  const sandbox = {
    chrome, console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, setTimeout, clearTimeout, AbortController,
    fetch: async (url) => {
      env.bgFetches.push(String(url));
      return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'video/mp4' : '1048576') } };
    },
    window: { location: { href: '', host: '', pathname: '/' }, addEventListener() {} },
    document: { elementsFromPoint: () => [], querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, createElement: () => ({ addEventListener() {}, removeAttribute() {}, load() {} }) }
  };
  sandbox.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'), sandbox);
  vm.createContext(sandbox);
  vm.runInContext(BG_CODE, sandbox);
  env.sandbox = sandbox;
  env.sender = (world, over = {}) => ({ id: 'testid', tab: { id: world.tabId, url: world.url, active: true }, frameId: world.frameId, url: world.url, documentId: world.docId, ...over });
  // what the content script's chrome.runtime.sendMessage reaches
  env.fromContent = (world, msg, sender = env.sender(world)) => {
    for (const l of env.listeners) l(msg, sender, () => {});
    return Promise.resolve();
  };
  env.attach = (world) => { env.worlds.set(world.tabId, world); world.bg = env; };
  env.idle = async () => {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 4));
      if (vm.runInContext('inFlightRequests.size === 0 && activeResolvingCount === 0', sandbox)) break;
    }
    await sandbox.feedbackTracker.flush();
    await new Promise((r) => setTimeout(r, 4));
  };
  env.ops = async () => sandbox.feedbackTracker.list();
  return env;
}

// One page wired to one worker
function pageAndWorker(opts = {}) {
  const bg = makeBackground();
  const world = makeWorld({ ...opts, bg });
  bg.attach(world);
  world.run();
  return { bg, world };
}

const sentInline = (world) => world.sent.filter((m) => m && m.action === 'REDGIFS_INLINE_SAVE');
const GIF = (name, hasAudio, urls) => ({ id: name, hasAudio, urls });
const refusedNothing = (bg, world) => {
  assert.equal(bg.downloads.length, 0, 'no download');
  assert.equal(world.fetchCalls.length, 0, 'no provider request');
};

// =============================================================================================================================================
// The control itself (content script only)
// =============================================================================================================================================
test('mount: every eligible player has exactly one hidden control, hover reveals only the hovered player\'s, nothing is sent or asked', async () => {
  const { world } = pageAndWorker();
  const a = world.addCard('ClipAlpha');
  const b = world.addCard('ClipBravo');
  assert.equal(world.hosts().length, 0, 'nothing before the page was scanned');
  world.scan();
  assert.equal(world.hosts().length, 2, 'one control per eligible player');
  for (const c of [a, b]) {
    const btn = world.btnOf(c);
    assert.equal(btn.tagName, 'BUTTON');
    assert.equal(btn.getAttribute('type'), 'button');
    assert.match(btn.getAttribute('aria-label'), /Save this clip/);
    assert.equal(world.visible(c), false, 'hidden until the pointer rests on its player or it takes the focus');
    assert.equal(world.hostOf(c).style.props['pointer-events'], 'none', 'a hidden control is not hit-testable');
  }
  const first = world.btnOf(a);
  const svg = first._kids[0];
  assert.equal(svg.tagName, 'SVG', 'the download icon, not a text label');
  assert.equal(svg.getAttribute('aria-hidden'), 'true', 'decorative');
  assert.equal(svg.getAttribute('width') + 'x' + svg.getAttribute('height'), '18x18');
  assert.equal(svg._kids[0].getAttribute('d'), 'M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14', 'the same path as the X and Reddit controls');
  assert.equal(first.textContent, '', 'no visible text');
  assert.equal(first.style.props.width + ' ' + first.style.props.height, '32px 32px');
  assert.equal(first.style.props.padding, '0');
  assert.equal(first.style.props['border-radius'], '9999px');
  world.scan();
  world.scan();
  assert.equal(world.hosts().length, 2, 'a repeated scan mounts nothing twice');
  world.hover(b);
  assert.equal(world.visible(b), true);
  assert.equal(world.visible(a), false);
  world.hover(a);
  assert.equal(world.visible(a), true);
  // upper-right of the player (640 wide), 8 px inset, 32 px button, inside the viewport
  assert.deepEqual([world.hostOf(a).style.props.left, world.hostOf(a).style.props.top], ['600px', '8px'], 'upper-right placement');
  world.win.innerWidth = 500; // a narrow viewport: the control stays inside the visible part of the player
  world.advance(300);
  assert.equal(world.hostOf(a).style.props.left, '460px');
  world.win.innerWidth = 1280;
  world.advance(300);
  assert.equal(world.visible(b), false, 'at most one control is visible');
  assert.equal(world.hosts().length, 2);
  assert.equal(world.sent.length, 0, 'mounting and hovering send nothing');
  assert.equal(world.fetchCalls.length, 0, 'and ask no provider');
  world.move(900, 5000); // away from every player
  assert.equal(world.visible(a), false, 'the control leaves with the pointer');
});

test('eligibility: Reddit documents, embedded /ifr/ players, frames and other sites register and mount nothing', async () => {
  for (const [what, opts] of Object.entries({
    'a Reddit document': { url: 'https://www.reddit.com/r/x/comments/abc/post/' },
    'an embedded /ifr/ player': { url: 'https://www.redgifs.com/ifr/clipalpha' },
    'a nested frame of the site': { url: 'https://www.redgifs.com/watch/clipalpha', top: false },
    'a lookalike host': { url: 'https://www.redgifs.com.evil.example/watch/clipalpha' },
    'the bare apex host': { url: 'https://redgifs.com/watch/clipalpha' }
  })) {
    const { world } = pageAndWorker(opts);
    world.addCard('ClipAlpha');
    assert.equal((world.listeners.pointermove || []).length + (world.listeners.scroll || []).length + (world.listeners.resize || []).length, 0, `${what}: no listener`);
    assert.equal(world.observing, undefined, `${what}: no observer`);
    world.scan();
    world.move(100, 100);
    assert.equal(world.hosts().length, 0, `${what}: no control`);
  }
});

test('structure: a node that is not a Player owning exactly one video gets no control', async () => {
  const { world } = pageAndWorker();
  const a = world.addCard('ClipAlpha');
  a.player.appendChild(new El('video', { src: 'blob:https://www.redgifs.com/second' }, a.player.rect)); // two players under one Player
  world.scan();
  world.hover(a);
  assert.equal(world.hosts().length, 0, 'ambiguous player');
});

test('keyboard: every eligible player is reachable in the native tab order without hover or a focusable child of its own', async () => {
  const { world } = pageAndWorker();
  const a = world.addCard('ClipAlpha');
  const b = world.addCard('ClipBravo');
  const c = world.addCard('ClipCharlie');
  const link = new El('a', { tabindex: '0' }, a.player.rect); // a native focusable child of the first player only
  a.player.appendChild(link);
  world.scan();
  assert.equal(world.doc.activeElement, null, 'nothing is focused, nothing was hovered');
  const order = world.focusOrder();
  assert.deepEqual(order.map((n) => n.tagName + ':' + (n === link ? 'native' : 'save')), ['A:native', 'BUTTON:save', 'BUTTON:save', 'BUTTON:save'], 'native order kept: the native child first, then each Save in document order');
  assert.deepEqual(order.slice(1), [world.btnOf(a), world.btnOf(b), world.btnOf(c)], 'every eligible player has its Save');
  // each reached Save is visible and has a visible focus; the previous one is hidden again
  world.doc.activeElement.blur();
  assert.equal(world.doc.activeElement, null);
  world.tab(); world.tab();
  assert.equal(world.doc.activeElement, world.btnOf(a));
  assert.equal(world.visible(a), true);
  assert.match(world.btnOf(a).style.props.outline, /solid/, 'visible focus');
  world.tab();
  assert.equal(world.doc.activeElement, world.btnOf(b));
  assert.equal(world.visible(b), true);
  assert.equal(world.visible(a), false, 'the control of the player left behind is hidden');
  assert.equal(world.btnOf(a).style.props.outline, 'none');
  world.tab(true);
  assert.equal(world.doc.activeElement, world.btnOf(a), 'Shift+Tab goes back');
  // Escape hides the control and releases the focus in place
  assert.equal(world.key(world.btnOf(a), 'Escape'), true);
  assert.equal(world.visible(a), false);
  assert.equal(world.doc.activeElement, null);
  // activation by keyboard is a trusted click on the focused control and saves that player
  world.btnOf(b).focus();
  world.press(world.btnOf(b), true);
  assert.equal(sentInline(world).length, 1);
  assert.equal(world.sent.length, 1, 'nothing else was sent');
  assert.equal(world.state().pending.size, 1);
  assert.equal([...world.state().pending.values()][0].video, b.video, 'the focused control names its own player');
});

test('keyboard and dynamic pages: a recycled player loses its stop, a new one gains it; reinjection adds nothing', async () => {
  const { world } = pageAndWorker();
  const a = world.addCard('ClipAlpha');
  const b = world.addCard('ClipBravo');
  world.scan();
  const before = Object.fromEntries(Object.entries(world.listeners).map(([k, v]) => [k, v.length]));
  world.run();
  world.run(); // reinjection into the same world
  world.scan();
  assert.deepEqual(Object.fromEntries(Object.entries(world.listeners).map(([k, v]) => [k, v.length])), before, 'no second set of listeners');
  assert.equal(world.hosts().length, 2, 'still one control per player');
  assert.equal(world.messageListeners.length, 1, 'one message listener');
  b.gif.remove(); // the feed recycles its card
  world.scan();
  assert.equal(world.hosts().length, 1);
  assert.equal(world.focusOrder().length, 1, 'only the remaining player is a stop');
  const next = world.addCard('ClipNext');
  world.scan();
  assert.equal(world.hosts().length, 2);
  world.doc.activeElement.blur();
  assert.deepEqual(world.focusOrder(), [world.btnOf(a), world.btnOf(next)]);
  // a player that stops being eligible (a second video appears) loses its control
  a.player.appendChild(new El('video', { src: 'blob:https://www.redgifs.com/extra' }, a.player.rect));
  world.scan();
  assert.equal(world.hostOf(a), null);
  assert.equal(world.hosts().length, 1);
});

test('activation: only a trusted click sends, the token and the player key only, a repeat of the same player inside the gap is one request', async () => {
  const { world } = pageAndWorker();
  const a = world.addCard('ClipAlpha');
  const b = world.addCard('ClipBravo');
  world.hover(b);
  world.press(world.btnOf(b), false);
  assert.equal(world.sent.length, 0, 'a click dispatched by the page sends nothing');
  world.press(world.btnOf(b), true);
  assert.equal(sentInline(world).length, 1);
  assert.deepEqual(Object.keys(sentInline(world)[0]).sort(), ['action', 'player', 'token']);
  assert.match(sentInline(world)[0].token, /^[a-f0-9]{32}$/);
  assert.match(sentInline(world)[0].player, /^[a-f0-9]{16}$/);
  world.press(world.btnOf(b), true);
  world.press(world.btnOf(b), true);
  assert.equal(sentInline(world).length, 1, 'a double click on one player is one request');
  world.hover(a);
  world.press(world.btnOf(a), true);
  assert.equal(sentInline(world).length, 2, 'another player inside the gap is a request of its own');
  assert.notEqual(sentInline(world)[0].player, sentInline(world)[1].player, 'the players are told apart');
  world.hover(b);
  world.press(world.btnOf(b), true);
  assert.equal(sentInline(world).length, 2, 'the first player is still inside its own gap');
  world.advance(2000);
  world.press(world.btnOf(b), true);
  assert.equal(sentInline(world).length, 3, 'after the gap the same player may save again');
  assert.equal(sentInline(world)[2].player, sentInline(world)[0].player, 'the same player keeps its key');
  assert.equal(world.fetchCalls.length, 0, 'the clicks themselves ask no provider');
});

test('a changed player is never saved: source, poster, node, navigation', async () => {
  const mutations = {
    'source changed': (w, c) => { c.video.setAttribute('src', 'blob:https://www.redgifs.com/recycled'); },
    'poster changed': (w, c) => { c.poster.setAttribute('src', posterUrl('ClipOther')); },
    'player removed': (w, c) => { c.gif.remove(); },
    'player node replaced': (w, c) => { c.video.remove(); c.holder.appendChild(new El('video', { src: c.blob }, c.player.rect)); },
    'document navigated': (w) => { w.navigate('https://www.redgifs.com/watch/other'); }
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    const { world } = pageAndWorker();
    const b = world.addCard('ClipBravo');
    world.hover(b);
    const btn = world.btnOf(b);
    mutate(world, b);
    world.press(btn, true);
    assert.equal(sentInline(world).length, 0, `${what}: nothing is sent`);
    assert.equal(world.visible(b), false, `${what}: the stale control is hidden`);
  }
});

test('occlusion: an unrelated layer over the player owns the pointer, the player\'s own tracking overlay does not', async () => {
  const { world } = pageAndWorker();
  const a = world.addCard('ClipAlpha', { tracking: true });
  const b = world.addCard('ClipBravo');
  world.scan();
  // normal hover: a tracking overlay of the card lies above the player and is its own
  world.hover(a);
  assert.equal(world.visible(a), true, 'an owned overlay does not hide the player');
  world.move(900, 5000);
  assert.equal(world.visible(a), false);
  // a modal dialog covers the second player: the hidden player behind it is not selected
  const modal = world.addLayer({ left: 0, top: b.player.rect.top, width: 640, height: 360 });
  world.hover(b);
  assert.equal(world.visible(b), false, 'no Save over an unrelated dialog');
  assert.equal(world.state().active, null);
  // a dialog over only a part of the player: the point outside it is still the player's
  world.layers[0].rect = { left: 0, top: b.player.rect.top, width: 50, height: 360 };
  world.move(300, b.y);
  assert.equal(world.visible(b), true, 'outside the dialog the player is hovered again');
  world.move(10, b.y);
  assert.equal(world.visible(b), false, 'under the dialog it is not');
  modal.remove();
  world.hover(b);
  assert.equal(world.visible(b), true, 'the dialog closed');
  // a visible control already shown is dropped when a dialog opens over the pointer
  world.addLayer({ left: 0, top: b.player.rect.top, width: 640, height: 360 });
  world.move(120, b.y);
  assert.equal(world.visible(b), false);
  assert.equal(world.sent.length, 0);
});

// =============================================================================================================================================
// The shared path (content script + worker)
// =============================================================================================================================================
const WATCH = 'https://www.redgifs.com/watch/clipwatch';

test('watch page: the inline click saves the exact clip through the shared pipeline, never the menu capture', async () => {
  const { bg, world } = pageAndWorker({ url: WATCH, gifs: { clipwatch: GIF('ClipWatch', true, { silent: media('ClipWatch', '-silent'), hd: media('ClipWatch'), sd: media('ClipWatch', '-mobile') }) } });
  const c = world.addCard('ClipWatch');
  world.addOgVideo(media('ClipWatch', '-silent'));
  world.ctx.__imageSaverContextTarget = { at: 4242, sentinel: true }; // a stale menu capture must neither decide nor change
  world.hover(c);
  assert.equal(world.fetchCalls.length, 0);
  world.press(world.btnOf(c), true);
  await bg.idle();
  assert.deepEqual(bg.downloads.map((d) => d.url), [media('ClipWatch')], 'the provider-declared audio-bearing file of the clicked clip');
  assert.deepEqual(world.fetchCalls.map((u) => u.replace(/^https:\/\/api\.redgifs\.com\//, '')), ['v2/auth/temporary', 'v2/gifs/clipwatch'], 'the existing two bounded requests, after the click');
  assert.equal(bg.executed.length, 0, 'the context-menu capture readers never ran');
  assert.equal(world.ctx.__imageSaverContextTarget.sentinel, true, 'the capture record is untouched');
  assert.equal(bg.frameRequests.length, 1);
  const { msg, options } = bg.frameRequests[0];
  assert.match(msg.inlineToken, /^[a-f0-9]{32}$/);
  assert.equal(msg.requireGesture, undefined, 'no gesture proof is borrowed');
  assert.deepEqual({ frameId: options.frameId, documentId: options.documentId }, { frameId: 0, documentId: 'doc-1' }, 'pinned to the sending frame and document');
  const [op] = await bg.ops();
  assert.equal(op.state === 'complete' || op.state === 'saving', true, 'feedback tracked the save: ' + op.state);
});

test('feed: the clicked non-first player is saved, a neighbor never', async () => {
  const gifs = {
    clipalpha: GIF('ClipAlpha', true, { hd: media('ClipAlpha') }),
    clipbravo: GIF('ClipBravo', true, { silent: media('ClipBravo', '-silent'), hd: media('ClipBravo'), sd: media('ClipBravo', '-mobile') })
  };
  const { bg, world } = pageAndWorker({ gifs });
  world.addCard('ClipAlpha');
  const b = world.addCard('ClipBravo');
  world.activate(b);
  await bg.idle();
  assert.deepEqual(bg.downloads.map((d) => d.url), [media('ClipBravo')]);
  assert.ok(!world.fetchCalls.some((u) => /clipalpha/.test(u)), 'the neighbor was never asked');
});

test('audio through the shared path: sound-bearing preferred, declared silence saved, known audio without a valid rendition refused, unknown audio kept', async () => {
  const run = async (gif) => {
    const { bg, world } = pageAndWorker({ gifs: { clipbravo: gif } });
    const b = world.addCard('ClipBravo');
    world.activate(b);
    await bg.idle();
    return { bg, world, ops: await bg.ops() };
  };
  const silent = media('ClipBravo', '-silent');
  const hd = media('ClipBravo');
  const sound = await run(GIF('ClipBravo', true, { silent, hd }));
  assert.deepEqual(sound.bg.downloads.map((d) => d.url), [hd]);
  const declaredSilence = await run(GIF('ClipBravo', false, { silent }));
  assert.deepEqual(declaredSilence.bg.downloads.map((d) => d.url), [silent], 'a declared silent clip is saved');
  const unknown = await run(GIF('ClipBravo', undefined, { silent }));
  assert.deepEqual(unknown.bg.downloads.map((d) => d.url), [silent], 'undeclared audio keeps the file');
  const knownRefused = await run(GIF('ClipBravo', true, { silent, bad: 'https://evil.example/ClipBravo.mp4' }));
  assert.equal(knownRefused.bg.downloads.length, 0, 'known audio, no valid sound rendition: nothing is saved');
  assert.equal(knownRefused.ops.filter((o) => o.state === 'failed').length, 1, 'a visible failed operation');
  const wrongClip = await run(GIF('ClipOther', true, { hd: media('ClipOther') }));
  assert.equal(wrongClip.bg.downloads.length, 0, 'the provider answering another clip saves nothing');
  const apiDown = await run(undefined);
  assert.equal(apiDown.bg.downloads.length, 0, 'no declaration, no file');
  assert.equal(apiDown.world.fetchCalls.length <= 2, true, 'request bounds hold');
});

test('a token is one-shot and bound to its document: replay, another document and a foreign sender are refused', async () => {
  const { bg, world } = pageAndWorker({ gifs: { clipbravo: GIF('ClipBravo', true, { hd: media('ClipBravo') }) } });
  const b = world.addCard('ClipBravo');
  world.activate(b);
  await bg.idle();
  assert.equal(bg.downloads.length, 1);
  const { token, player } = sentInline(world)[0];
  // replay of the consumed token through the worker
  await bg.fromContent(world, { action: 'REDGIFS_INLINE_SAVE', token, player });
  await bg.idle();
  assert.equal(bg.downloads.length, 1, 'a replayed token saves nothing');
  // a token the page never issued
  await bg.fromContent(world, { action: 'REDGIFS_INLINE_SAVE', token: 'a'.repeat(32), player });
  await bg.idle();
  assert.equal(bg.downloads.length, 1, 'an invented token saves nothing');
  // the frame resolver itself: a content-script sender, a foreign extension, a malformed token
  world.advance(2000);
  world.hover(b);
  world.press(world.btnOf(b), true);
  const live = sentInline(world)[1].token;
  for (const sender of [{ id: 'testid', tab: { id: 7 } }, { id: 'other-extension' }]) {
    const res = await world.ask({ action: 'RESOLVE_FRAME_MEDIA', clickedSrc: '', frameId: 0, inlineToken: live }, sender);
    assert.equal(res.success, false, 'a foreign resolver request is refused');
  }
  assert.equal((await world.ask({ action: 'RESOLVE_FRAME_MEDIA', clickedSrc: '', frameId: 0, inlineToken: 'nope' }, { id: 'testid' })).success, false);
  await bg.idle();
  assert.equal(bg.downloads.length, 2, 'the live token was not consumed by the refused callers and saved once');
});

test('the worker admits only the own-site top document of the active tab: forged and foreign senders do nothing', async () => {
  const { bg, world } = pageAndWorker({ gifs: { clipbravo: GIF('ClipBravo', true, { hd: media('ClipBravo') }) } });
  const b = world.addCard('ClipBravo');
  world.activate(b);
  const { token, player } = sentInline(world)[0];
  world.state().pending.clear(); // only the sender checks are under test: nothing could be resolved anyway
  const base = bg.sender(world);
  const forged = {
    'no tab (not a content script)': { tab: undefined },
    'another extension': { id: 'other-extension' },
    'a nested frame': { frameId: 3 },
    'an inactive tab': { tab: { id: 7, url: world.url, active: false } },
    'no document id': { documentId: undefined },
    'a Reddit page': { url: 'https://www.reddit.com/r/x/comments/abc/post/' },
    'an embedded player': { url: 'https://www.redgifs.com/ifr/clipbravo' },
    'a lookalike host': { url: 'https://www.redgifs.com.evil.example/watch/clipbravo' },
    'an http page': { url: 'http://www.redgifs.com/watch/clipbravo' }
  };
  await bg.idle();
  const before = { frames: bg.frameRequests.length, ops: (await bg.ops()).length };
  for (const [what, over] of Object.entries(forged)) {
    bg.fromContent(world, { action: 'REDGIFS_INLINE_SAVE', token, player }, { ...base, ...over });
    await bg.idle();
    assert.equal(bg.frameRequests.length, before.frames, `${what}: nothing was asked of any frame`);
  }
  for (const bad of ['', 'ZZ', 'a'.repeat(31), 'A'.repeat(32), 12345, null]) {
    bg.fromContent(world, { action: 'REDGIFS_INLINE_SAVE', token: bad, player });
    await bg.idle();
  }
  for (const bad of [undefined, '', 'ZZ', 'a'.repeat(15), 'A'.repeat(16), 12345, null]) {
    bg.fromContent(world, { action: 'REDGIFS_INLINE_SAVE', token, player: bad });
    await bg.idle();
  }
  assert.equal(bg.frameRequests.length, before.frames, 'malformed tokens and player keys ask nothing');
  // control: the same message from the genuine sender does reach the frame (the checks above are not vacuous)
  bg.fromContent(world, { action: 'REDGIFS_INLINE_SAVE', token, player }, base);
  await bg.idle();
  assert.equal(bg.frameRequests.length, before.frames + 1, 'the genuine sender is admitted');
  assert.equal(bg.downloads.length, 0, 'the issued token was cleared, so even the genuine request saves nothing');
});

test('the document that issued the token must still be the one asked: a navigation before the request refuses without downloads', async () => {
  const { bg, world } = pageAndWorker({ gifs: { clipbravo: GIF('ClipBravo', true, { hd: media('ClipBravo') }) } });
  const b = world.addCard('ClipBravo');
  world.hover(b);
  bg.onFrameRequest = (w) => { w.docId = 'doc-2'; }; // the frame navigated to a fresh document before the worker's request arrived
  world.press(world.btnOf(b), true);
  await bg.idle();
  assert.equal(bg.frameRequests.length, 1, 'the request was pinned to the sending document');
  assert.equal(bg.frameRequests[0].options.documentId, 'doc-1');
  assert.equal(bg.downloads.length, 0, 'nothing saved');
  assert.equal(world.fetchCalls.length, 0, 'the new document was never asked a provider');
});

test('continuity during the provider lookup: a player that changes while the clip is requested is not saved', async () => {
  const mutations = {
    'source recycled': (c) => c.video.setAttribute('src', 'blob:https://www.redgifs.com/recycled'),
    'poster changed': (c) => c.poster.setAttribute('src', posterUrl('ClipOther')),
    'player removed': (c) => c.gif.remove()
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    for (const at of [1, 2]) {
      let card = null;
      const { bg, world } = pageAndWorker({ gifs: { clipbravo: GIF('ClipBravo', true, { hd: media('ClipBravo') }) }, onApi: (u, n) => { if (n === at) mutate(card); } });
      card = world.addCard('ClipBravo');
      world.activate(card);
      await bg.idle();
      assert.equal(bg.downloads.length, 0, `${what} at request ${at}: nothing is saved`);
      assert.equal(world.fetchCalls.length, at, `${what} at request ${at}: nothing is asked after the change`);
    }
  }
});

const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(cond(), 'condition reached'); };

// A save that is still resolving: the first provider request waits until the test releases it
function gated() {
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  return { release: () => release(), onApi: (u) => { if (u.endsWith('v2/auth/temporary') && first) { first = false; return gate; } return undefined; } };
}
const TWO_GIFS = { clipalpha: GIF('ClipAlpha', true, { hd: media('ClipAlpha') }), clipbravo: GIF('ClipBravo', true, { hd: media('ClipBravo') }) };

test('distinct players: B is processed while A is still resolving, inside the old gap and after it', async () => {
  for (const delay of [0, 2000]) {
    const g = gated();
    const { bg, world } = pageAndWorker({ gifs: TWO_GIFS, onApi: g.onApi });
    const a = world.addCard('ClipAlpha');
    const b = world.addCard('ClipBravo');
    world.activate(a); // A waits at the provider
    world.advance(delay);
    world.activate(b);
    assert.equal(sentInline(world).length, 2, `${delay} ms: both activations were sent`);
    await bg.idle(); // B completes while A is held
    assert.deepEqual(bg.downloads.map((d) => d.url), [media('ClipBravo')], `${delay} ms: B was processed although A is still resolving`);
    g.release();
    await bg.idle();
    assert.deepEqual(bg.downloads.map((d) => d.url).sort(), [media('ClipAlpha'), media('ClipBravo')].sort(), `${delay} ms: and A completes afterwards`);
    const ops = await bg.ops();
    assert.equal(ops.length, 2, `${delay} ms: two operations, no silent drop`);
    assert.equal(ops.filter((o) => o.state === 'failed').length, 0);
  }
});

test('the same player: concurrent repeats are one save, at the control and at the worker', async () => {
  const g = gated();
  const { bg, world } = pageAndWorker({ gifs: TWO_GIFS, onApi: g.onApi });
  const a = world.addCard('ClipAlpha');
  world.activate(a);
  world.press(world.btnOf(a), true); // inside the gap: stopped at the control
  assert.equal(sentInline(world).length, 1);
  world.advance(2000);
  world.press(world.btnOf(a), true); // after the gap, A still resolving: a second token reaches the worker
  assert.equal(sentInline(world).length, 2);
  assert.equal(sentInline(world)[0].player, sentInline(world)[1].player, 'the same player key');
  assert.notEqual(sentInline(world)[0].token, sentInline(world)[1].token, 'but a token of its own');
  await bg.idle();
  g.release();
  await bg.idle();
  assert.deepEqual(bg.downloads.map((d) => d.url), [media('ClipAlpha')], 'one save');
  assert.equal((await bg.ops()).length, 1, 'one operation: the worker recognised the repeat of the same player');
  assert.equal(world.fetchCalls.length, 2, 'one lookup');
});

test('stale or foreign targets stay refused with distinct players in flight', async () => {
  const g = gated();
  const { bg, world } = pageAndWorker({ gifs: TWO_GIFS, onApi: g.onApi });
  const a = world.addCard('ClipAlpha');
  const b = world.addCard('ClipBravo');
  world.activate(a);
  world.activate(b);
  b.poster.setAttribute('src', posterUrl('ClipOther')); // B changes before its request is answered
  await bg.idle();
  assert.equal(bg.downloads.length, 0, 'B changed: not saved; A still waits');
  g.release();
  await bg.idle();
  assert.deepEqual(bg.downloads.map((d) => d.url), [media('ClipAlpha')], 'A is unaffected by B');
  assert.equal(world.fetchCalls.some((u) => /clipother/.test(u)), false);
});

test('bounded: more saves than the limit resolve at once are a visible failure, never a silent drop', async () => {
  const gate = new Promise(() => {}); // never released during the test: every started save stays in flight
  const { bg, world } = pageAndWorker({ gifs: TWO_GIFS, onApi: (u) => (u.endsWith('v2/auth/temporary') ? gate : undefined) });
  world.win.innerHeight = 4000; // a tall page: all five players are in the viewport
  const cards = ['ClipOne', 'ClipTwo', 'ClipThree', 'ClipFour', 'ClipFive'].map((n) => world.addCard(n));
  for (const c of cards) world.activate(c);
  await bg.idle();
  const ops = await bg.ops();
  assert.equal(sentInline(world).length, 5, 'all five activations were sent');
  assert.equal(ops.filter((o) => o.state === 'failed').length, 1, 'the fifth is a visible failed operation');
  assert.equal(ops.find((o) => o.state === 'failed').failure.code, 'RATE_LIMIT');
  assert.equal(world.fetchCalls.length, 4, 'four lookups started, the fifth never reached the provider');
});

test('placement: the control needs room for itself in the visible part of the player', async () => {
  // the pointer rests on the (visible part of the) player: `at` is where, default the usual hover point
  const room = async (mutate, at = null) => {
    const { world } = pageAndWorker();
    const a = world.addCard('ClipAlpha');
    world.scan();
    mutate(world, a);
    if (at) world.move(at[0], at[1]); else world.hover(a);
    return { world, a };
  };
  // ordinary: the whole player is visible
  let r = await room(() => {});
  assert.equal(r.world.visible(r.a), true);
  assert.deepEqual([r.world.hostOf(r.a).style.props.left, r.world.hostOf(r.a).style.props.top], ['600px', '8px'], 'upper-right, 8 px inset');
  // exactly enough room (32 px wide visible part): shown, inside the visible part
  r = await room((w) => { w.win.innerWidth = 32; });
  assert.equal(r.world.visible(r.a), true);
  assert.equal(r.world.hostOf(r.a).style.props.left, '0px');
  // horizontally clipped: only 10 px of the player lie inside the viewport
  r = await room((w, a) => { a.player.rect.left = 1270; }, [1275, 100]);
  assert.equal(r.world.visible(r.a), false, 'no control that would overflow the viewport');
  // vertically clipped: only 10 px of the player lie inside the viewport (top and bottom)
  r = await room((w, a) => { a.player.rect.top = -350; }, [100, 5]);
  assert.equal(r.world.visible(r.a), false, 'only the lower 10 px are visible');
  r = await room((w, a) => { w.win.innerHeight = 10; }, [100, 5]);
  assert.equal(r.world.visible(r.a), false, 'only the upper 10 px are visible');
  // a control already shown is withdrawn when the room goes (scrolling out), and returns when it is back
  const { world, a } = await room(() => {});
  assert.equal(world.visible(a), true);
  world.move(100, 5);
  a.player.rect.top = -350;
  world.advance(300);
  assert.equal(world.visible(a), false, 'withdrawn by the refresh');
  a.player.rect.top = 0;
  world.hover(a);
  assert.equal(world.visible(a), true);
});

test('stable placement: the control follows its player while the page scrolls or resizes, and is concealed when that cannot be proven', async () => {
  const { world } = pageAndWorker();
  const a = world.addCard('ClipAlpha');
  world.addCard('ClipBravo');
  world.scan();
  world.hover(a);
  assert.equal(world.hostOf(a).style.props.position, 'absolute', 'anchored inside its player, not to the viewport');
  assert.deepEqual([world.rectOf(a).left, world.rectOf(a).top], [600, 8]);
  // scrolling without pointer motion: many events, one frame; the control is placed again before the 250 ms refresh could run
  a.player.rect.top = -200; // the player's upper part leaves the viewport
  for (let i = 0; i < 5; i++) world.fire('scroll', {});
  assert.equal(world.frames(), 1, 'coalesced into one pending frame');
  world.advance(20);
  assert.equal(world.frames(), 0);
  assert.equal(world.visible(a), true);
  assert.deepEqual([world.rectOf(a).left, world.rectOf(a).top], [600, 8], 'at the upper-right of the visible part of its own player');
  a.player.rect.top = 60; // scrolled back: the player is lower again
  world.fire('scroll', {});
  world.advance(20);
  assert.deepEqual([world.rectOf(a).left, world.rectOf(a).top], [600, 68], 'follows the player, never left behind over another card');
  // resize
  world.win.innerWidth = 500;
  world.fire('resize', {});
  world.advance(20);
  assert.equal(world.rectOf(a).left, 460, 'inside the narrower viewport');
  world.win.innerWidth = 1280;
  world.fire('resize', {});
  world.advance(20);
  assert.equal(world.rectOf(a).left, 600);
  // a placement that cannot be proven (the control would not lie inside its player's visible part) is not shown
  const host = world.hostOf(a);
  const real = host.getBoundingClientRect.bind(host);
  host.getBoundingClientRect = () => ({ left: 5, top: -400, width: 32, height: 32, right: 37, bottom: -368 });
  world.fire('scroll', {});
  world.advance(20);
  assert.equal(world.visible(a), false, 'concealed until a fresh, provable placement');
  host.getBoundingClientRect = real;
  world.hover(a);
  assert.equal(world.visible(a), true, 'and shown again once it can be proven');
  // cleanup: a pending frame never outlives the control; scroll events with nothing visible schedule nothing
  world.fire('scroll', {});
  assert.equal(world.frames(), 1);
  world.move(900, 5000);
  assert.equal(world.visible(a), false);
  assert.equal(world.frames(), 0, 'cancelled with the control');
  world.fire('scroll', {});
  world.fire('resize', {});
  assert.equal(world.frames(), 0, 'nothing visible, nothing scheduled');
  assert.equal(world.intervals(), 0);
  // removed while a frame is pending
  world.hover(a);
  world.fire('scroll', {});
  a.gif.remove();
  world.advance(20);
  assert.equal(world.visible(a), false);
  assert.equal(world.frames(), 0);
  assert.equal(world.intervals(), 0);
  // hidden document
  const hidden = pageAndWorker();
  const h = hidden.world.addCard('ClipAlpha');
  hidden.world.scan();
  hidden.world.hover(h);
  hidden.world.fire('scroll', {});
  hidden.world.doc.hidden = true;
  hidden.world.advance(20);
  assert.equal(hidden.world.visible(h), false);
  assert.equal(hidden.world.frames(), 0);
  assert.equal(hidden.world.intervals(), 0);
  assert.equal(world.sent.length + hidden.world.sent.length, 0, 'placement sends and asks nothing');
});

test('occlusion without a generic parent: a Player placed straight under the body does not admit an unrelated layer', async () => {
  const { world } = pageAndWorker();
  const a = world.addCard('ClipAlpha', { bare: true });
  world.scan();
  assert.equal(a.player.parentElement, world.body, 'fixture: the only ancestor above the Player is the body');
  world.addLayer({ left: 0, top: a.player.rect.top, width: 640, height: 360 });
  world.hover(a);
  assert.equal(world.visible(a), false, 'a body cannot prove that a modal belongs to the player');
  assert.equal(world.state().active, null);
  world.move(900, 5000);
  const own = pageAndWorker();
  const b = own.world.addCard('ClipBravo', { bare: true });
  own.world.scan();
  own.world.hover(b);
  assert.equal(own.world.visible(b), true, 'without a layer the same bare Player is hovered normally');
});

test('occlusion without pointer motion: a layer that appears, goes or changes visibility under a resting pointer is noticed', async () => {
  const { world } = pageAndWorker();
  const a = world.addCard('ClipAlpha', { tracking: true });
  world.scan();
  world.hover(a);
  assert.equal(world.visible(a), true);
  // a layer inserted over the resting pointer: the existing observer + refresh conceal the control, no pointer event
  const layer = world.addLayer({ left: 0, top: a.player.rect.top, width: 640, height: 360 });
  world.scan();
  assert.equal(world.visible(a), false, 'concealed by the observed page change alone');
  assert.equal(world.state().active, null);
  // the layer leaves: the resting pointer is over the player again
  layer.remove();
  world.scan();
  assert.equal(world.visible(a), true, 'revealed again without motion');
  // a layer that is in the DOM but becomes visible / hidden (no mutation of the tree): the 250 ms refresh notices
  const lay = world.addLayer({ left: 0, top: a.player.rect.top, width: 640, height: 360 });
  lay.hiddenFlag = true;
  world.layers[world.layers.length - 1].hidden = true;
  world.advance(300);
  assert.equal(world.visible(a), true, 'a hidden layer covers nothing');
  world.layers[world.layers.length - 1].hidden = false;
  world.advance(300);
  assert.equal(world.visible(a), false, 'the layer became visible under the resting pointer');
  world.layers[world.layers.length - 1].hidden = true;
  world.advance(300);
  assert.equal(world.visible(a), true, 'and hidden again');
  // the player's own tracking overlay stays its own (the card contains it)
  assert.ok(a.tracking, 'fixture: an owned overlay lies above the player');
  // no continuous scanner: when the pointer rests nowhere near a player and nothing is shown or waiting, no interval runs
  world.move(900, 5000);
  world.advance(300);
  assert.equal(world.visible(a), false);
  assert.equal(world.intervals(), 0, 'no interval when no control is visible and no player waits behind a layer');
  assert.equal(world.sent.length, 0);
  assert.equal(world.fetchCalls.length, 0);
});

test('refresh lifecycle: no interval outlives its need, on every exit of the judging', async () => {
  const exits = {
    'the occluded player is left for an empty point': (w) => w.move(900, 5000),
    'the document is hidden': (w) => { w.doc.hidden = true; },
    'the player is removed': (w, a) => { a.gif.remove(); },
    'the page leaves the allowed site area': (w) => w.navigate('https://www.redgifs.com/ifr/clipalpha'),
    'hit testing is unavailable': (w) => { w.doc.elementsFromPoint = undefined; },
    'hit testing throws': (w) => { w.doc.elementsFromPoint = () => { throw new Error('hit test failed'); }; }
  };
  for (const covered of [true, false]) {
    for (const [what, leave] of Object.entries(exits)) {
      const { world } = pageAndWorker();
      const a = world.addCard('ClipAlpha');
      world.scan();
      if (covered) world.addLayer({ left: 0, top: a.player.rect.top, width: 640, height: 360 });
      world.hover(a);
      assert.equal(world.visible(a), !covered, `${what}: fixture`);
      world.advance(300);
      assert.equal(world.intervals(), 1, `${what}: the refresh runs while it is needed (${covered ? 'a player waits behind a layer' : 'a control is visible'})`);
      leave(world, a);
      world.advance(300);
      assert.equal(world.intervals(), 0, `${what}: no interval remains (${covered ? 'watching' : 'visible'})`);
      assert.equal(world.visible(a), false);
    }
  }
});

test('occlusion and the keyboard: a layer opening does not take the focused control away', async () => {
  const { world } = pageAndWorker({ gifs: TWO_GIFS });
  const a = world.addCard('ClipAlpha');
  world.scan();
  world.move(900, 5000);
  world.tab();
  assert.equal(world.doc.activeElement, world.btnOf(a));
  assert.equal(world.visible(a), true);
  world.addLayer({ left: 0, top: a.player.rect.top, width: 640, height: 360 });
  world.move(100, a.y);
  world.scan();
  world.advance(600);
  assert.equal(world.visible(a), true, 'the control the keyboard is on stays');
  world.press(world.btnOf(a), true);
  assert.equal(sentInline(world).length, 1, 'and still activates');
});

test('selection generation: the SAME node recycled to another clip is a request of its own, an unchanged one is not', async () => {
  // A completes, then the same Player and video show B inside the old gap: B is saved at once
  {
    const { bg, world } = pageAndWorker({ gifs: TWO_GIFS });
    const c = world.addCard('ClipAlpha');
    world.activate(c);
    await bg.idle();
    assert.deepEqual(bg.downloads.map((d) => d.url), [media('ClipAlpha')]);
    const keyA = sentInline(world)[0].player;
    world.advance(100); // inside the 1.5 s gap
    world.swap(c, 'ClipBravo');
    world.hover(c); // the refresh path: reveal judges the live selection
    world.press(world.btnOf(c), true);
    assert.equal(sentInline(world).length, 2, 'B sends its own request inside the old gap');
    assert.notEqual(sentInline(world)[1].player, keyA, 'with its own player key');
    await bg.idle();
    assert.deepEqual(bg.downloads.map((d) => d.url), [media('ClipAlpha'), media('ClipBravo')], 'both saved');
  }
  // A is still held at the provider, the node is recycled to B after the gap: B is not dropped as a duplicate of A, A refuses its changed target
  {
    const g = gated();
    const { bg, world } = pageAndWorker({ gifs: TWO_GIFS, onApi: g.onApi });
    const c = world.addCard('ClipAlpha');
    world.activate(c);
    await until(() => world.fetchCalls.length === 1); // A has reached the provider and waits there
    world.advance(2000);
    world.swap(c, 'ClipBravo');
    world.hover(c);
    world.press(world.btnOf(c), true);
    assert.equal(sentInline(world).length, 2);
    assert.notEqual(sentInline(world)[0].player, sentInline(world)[1].player, 'a fresh key for the new selection');
    await bg.idle(); // B completes while A is held
    assert.deepEqual(bg.downloads.map((d) => d.url), [media('ClipBravo')], 'B was processed');
    g.release();
    await bg.idle();
    assert.deepEqual(bg.downloads.map((d) => d.url), [media('ClipBravo')], 'the stale A request, frozen to its own source proof, still refuses');
    const ops = await bg.ops();
    assert.equal(ops.length, 2, 'two operations: B was not dropped');
    assert.equal(ops.filter((o) => o.state === 'failed').length, 1, 'only the stale A is a failure');
    assert.equal(world.fetchCalls.some((u) => /clipalpha/.test(u)), false, 'the stale A never asked for its clip');
  }
  // unchanged selection: hiding and showing the control again keeps the key and the throttle
  {
    const { bg, world } = pageAndWorker({ gifs: TWO_GIFS });
    const c = world.addCard('ClipAlpha');
    world.activate(c);
    const key = sentInline(world)[0].player;
    world.move(900, 5000); // the pointer leaves and returns inside the gap
    world.hover(c);
    world.press(world.btnOf(c), true);
    assert.equal(sentInline(world).length, 1, 'an unchanged repeat inside the gap is still one request');
    world.advance(2000);
    world.move(900, 5000);
    world.hover(c);
    world.press(world.btnOf(c), true);
    assert.equal(sentInline(world).length, 2);
    assert.equal(sentInline(world)[1].player, key, 'the same selection keeps its key across hide and show');
    await bg.idle();
    assert.equal(bg.downloads.length >= 1, true);
  }
  // an unrelated change (a scan, a neighbour) does not renew the key
  {
    const { world } = pageAndWorker({ gifs: TWO_GIFS });
    const c = world.addCard('ClipAlpha');
    world.addCard('ClipBravo');
    world.activate(c);
    const key = sentInline(world)[0].player;
    world.scan();
    world.scan();
    world.advance(2000);
    world.hover(c);
    world.press(world.btnOf(c), true);
    assert.equal(sentInline(world)[1].player, key);
  }
});

test('niche player (no id, no direct address) is recovered from its own poster through the inline path', async () => {
  const { bg, world } = pageAndWorker({ gifs: { clipbravo: GIF('ClipBravo', true, { silent: media('ClipBravo', '-silent'), hd: media('ClipBravo') }) } });
  world.addCard('ClipAlpha');
  const b = world.addCard('ClipBravo');
  world.activate(b);
  await bg.idle();
  assert.deepEqual(bg.downloads.map((d) => d.url), [media('ClipBravo')]);
  const noPoster = pageAndWorker({ gifs: { clipbravo: GIF('ClipBravo', true, { hd: media('ClipBravo') }) } });
  const c = noPoster.world.addCard('ClipBravo', { poster: false });
  noPoster.world.activate(c);
  await noPoster.bg.idle();
  assert.equal(noPoster.bg.downloads.length, 0, 'a player that proves no clip is refused');
  assert.equal(noPoster.world.fetchCalls.length, 0, 'before any provider request');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
(async () => {
  for (const t of queue) {
    try {
      await t.fn();
      passed++;
      console.log(`[PASS] ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`[FAIL] ${t.name}: ${err && err.message}`);
      if (process.env.DEBUG) console.error(err);
    }
  }
  console.log('\n========================================');
  console.log(`Summary: ${passed}/${passed + failed} tests passed (${failed} failed)`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
})();
