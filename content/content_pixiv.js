// content/content_pixiv.js - PIXIV-INLINE-01: the inline Save controls over Pixiv artwork images, scoped strictly to https://www.pixiv.net/*
// "Save this" (exactly the selected page, a proven page index included) on every artwork image, preview card or opened artwork; "Save all (N)" only when the card or the
// opened artwork itself shows the artwork's page count (2..100). One control (a closed shadow root in one fixed host) follows the hovered or focused image. Hover does a bounded
// DOM read and no network request. A click captures a fresh snapshot of that very image, mints a random one-shot token bound to the action and the snapshot, and sends ONLY
// the token; background.js validates the sender and asks THIS document (same frame and document id) to prove the snapshot again, then runs the existing Pixiv save route with
// the explicit inline mode (the artwork's declared originals are read there, never here). No URL of the click is trusted, no contextmenu event is simulated or reused,
// and a page count shown in the DOM only labels the button: the worker checks the artwork's real list against it.
(() => {
  const DBG = (globalThis.ImageSaverDebug && globalThis.ImageSaverDebug.client('content')) || { log() {}, cid() { return ''; }, enabled() { return false; } };
  // a second injection into this same world (re-injection) replaces the first instance instead of doubling its control and listeners
  if (globalThis.__medialatchPixivInline && typeof globalThis.__medialatchPixivInline.teardown === 'function') globalThis.__medialatchPixivInline.teardown();
  DBG.log('pixiv', 'init', 'info');
  const isI18n = globalThis.ImageSaverI18n;
  const isLabels = isI18n && typeof chrome !== 'undefined' ? isI18n.follow(chrome, typeof navigator !== 'undefined' ? navigator : null, () => {}) : null;
  const isLabel = (element, field, key, fallback, vars) => {
    if (isLabels) isLabels.label(element, field, key, vars, fallback);
    else if (field === 'textContent') element.textContent = fallback;
    else if (fallback === null) element.removeAttribute(field);
    else element.setAttribute(field, fallback);
  };

  const PX = { HOVER_MS: 60, MAX_STACK: 24, MIN_W: 96, MIN_H: 64, TOKEN_TTL: 15000, CLICK_GAP: 1500, INSET: 8, SIZE: 32, SETTLE_MS: 150, SETTLE_MAX: 12, TOL: 1, SCOPE_DEPTH: 6, SCAN_IMGS: 60, SCAN_NODES: 80, BATCH_MAX: 100,
    MULTI_W: 104, MULTI_H: 60, COMPACT_W: 80, COMPACT_H: 32, CORNER: 3 };
  const ASSET = /\/(\d{1,12})_p(\d{1,3})_(?:master|square|custom)\d+\.[a-z0-9]+$/i;
  const ARTWORK = /^\/(?:[a-z]{2}\/)?artworks\/(\d{1,12})\/?$/;
  const state = { host: null, btn: null, lbl: null, btnAll: null, lblAll: null, count: 0, compact: false, snap: null, observer: null, timer: null, settleTimer: null, href: '', x: 0, y: 0,
    busyKey: '', busyAt: 0, busyTimer: null, keyEl: null, dismissed: null, rearmN: 0 };
  const pending = new Map();

  // ---- what an image is: an artwork asset and its owner ----
  function assetOf(img) {
    try {
      const src = img.currentSrc || img.src || '';
      const u = new URL(src);
      if (u.protocol !== 'https:' || u.hostname !== 'i.pximg.net' || u.username || u.password || u.port) return null;
      const m = ASSET.exec(u.pathname);
      return m ? { src, id: m[1], index: Number(m[2]) } : null; // avatars, banners, emoji and everything else are not artwork pages
    } catch (_) { return null; }
  }

  function artworkOf(href) {
    try {
      const u = new URL(href, location.href);
      return u.protocol === 'https:' && u.hostname === 'www.pixiv.net' && !u.username && !u.password && !u.port ? (ARTWORK.exec(u.pathname) || [])[1] || '' : '';
    } catch (_) { return ''; }
  }

  // The original file the opened artwork's own image links to; any other link around an image is not that artwork's.
  function ownOriginalLink(href, id) {
    try {
      const u = new URL(href, location.href);
      return u.protocol === 'https:' && u.hostname === 'i.pximg.net' && new RegExp('/' + id + '_p\\d{1,3}\\.[a-z0-9]+$', 'i').test(u.pathname);
    } catch (_) { return false; }
  }

  // { layout, asset, anchor, link }: a card whose own link names the asset's artwork, or the opened artwork (page URL = asset's artwork). Everything else (another
  // artwork's card, a profile link, a recommended card whose link and asset disagree, a player or canvas) is not an owner and gets no control.
  function ownerOf(img) {
    if (!img || img.tagName !== 'IMG') return null;
    const asset = assetOf(img);
    if (!asset) return null;
    const anchor = typeof img.closest === 'function' ? img.closest('a[href]') : null;
    const wrap = anchor || img.parentElement;
    if (wrap && typeof wrap.querySelector === 'function' && wrap.querySelector('canvas, video')) return null; // an animation or player: unsupported, not offered
    const linked = anchor ? artworkOf(anchor.getAttribute('href')) : '';
    if (linked) return linked === asset.id ? { layout: 'preview', asset, anchor, link: new URL(anchor.getAttribute('href'), location.href).href } : null;
    if (artworkOf(location.href) !== asset.id) return null;
    if (anchor && !ownOriginalLink(anchor.getAttribute('href'), asset.id)) return null;
    return { layout: 'opened', asset, anchor, link: '' };
  }

  // The largest ancestor that shows only this artwork (no other artwork's asset or link): where its own page-count evidence can be.
  function scopeOf(img, id) {
    let best = null;
    for (let p = img.parentElement, depth = 0; p && depth < PX.SCOPE_DEPTH; p = p.parentElement, depth++) {
      const imgs = p.querySelectorAll('img');
      if (imgs.length > PX.SCAN_IMGS) break;
      for (const i of imgs) { const a = assetOf(i); if (a && a.id !== id) return best; }
      for (const a of p.querySelectorAll('a[href]')) { const other = artworkOf(a.getAttribute('href')); if (other && other !== id) return best; }
      best = p;
      if (p === document.body) break;
    }
    return best;
  }

  // A preview count must be an overlay on this thumbnail, never its title or author. The opened artwork's k/N counter can sit beside another page of that artwork.
  // The label only offers the action; the worker still verifies the complete declared list before admitting it.
  function countOf(scope, snap) {
    try {
      if (!scope) return 0;
      const preview = snap.layout === 'preview', img = snap.imgRef.deref();
      const box = preview && img ? img.getBoundingClientRect() : null;
      if (preview && !box) return 0;
      const found = new Set();
      for (const el of Array.from(scope.querySelectorAll('span, div')).slice(0, PX.SCAN_NODES)) {
        if (el.children.length > 1) continue;
        const m = (preview ? /^([1-9]\d{0,2})$/ : /^(\d{1,3})\s*\/\s*(\d{1,3})$/).exec(String(el.textContent || '').trim());
        if (!m) continue;
        if (preview) {
          // Also reject a numeric wrapper around a profile link, not only the text node inside that link.
          if ([el.closest('a[href]'), el.querySelector('a[href]')].some(a => a && artworkOf(a.getAttribute('href')) !== snap.id)) continue;
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0 && r.left >= box.left - PX.TOL && r.top >= box.top - PX.TOL && r.right <= box.right + PX.TOL && r.bottom <= box.bottom + PX.TOL)) continue;
        }
        found.add(Number(m[preview ? 1 : 2]));
      }
      const n = found.size === 1 ? [...found][0] : 0;
      return n >= 2 && n <= PX.BATCH_MAX ? n : 0;
    } catch (_) { return 0; }
  }

  // The cheap part: which image, which link, which artwork, page and asset (no DOM scan).
  function identityOf(img) {
    const o = ownerOf(img);
    if (!o || typeof img.getBoundingClientRect !== 'function') return null;
    return { imgRef: new WeakRef(img), anchorRef: o.anchor ? new WeakRef(o.anchor) : null, layout: o.layout, id: o.asset.id, index: o.asset.index, src: o.asset.src, link: o.link };
  }

  // The whole snapshot: the identity, the artwork's own scope and the page count its label shows (one bounded scan).
  function snapshotOf(img) {
    const snap = identityOf(img);
    if (!snap) return null;
    const scope = scopeOf(img, snap.id);
    snap.scopeRef = scope ? new WeakRef(scope) : null;
    snap.count = countOf(scope, snap);
    return snap;
  }

  // Is this still the same image, in the same place, for the same artwork and asset?
  function same(a, b) {
    return Boolean(a && b) && a.imgRef.deref() === b.imgRef.deref() && (a.anchorRef ? a.anchorRef.deref() : null) === (b.anchorRef ? b.anchorRef.deref() : null) &&
      a.layout === b.layout && a.id === b.id && a.index === b.index && a.src === b.src && a.link === b.link;
  }

  function holds(snap) {
    try {
      const img = snap.imgRef.deref();
      if (!img || img.isConnected === false) return false;
      return same(snap, identityOf(img));
    } catch (_) { return false; }
  }

  // ---- placement: the bottom-left corner of the visible part of the image, only where nothing else draws over it ----
  function placeOf(img, w, h, scope) {
    try {
      const r = img.getBoundingClientRect();
      const vw = (typeof window.innerWidth === 'number' && window.innerWidth) || r.right, vh = (typeof window.innerHeight === 'number' && window.innerHeight) || r.bottom;
      const L = Math.max(r.left, 0), T = Math.max(r.top, 0), R = Math.min(r.right, vw), B = Math.min(r.bottom, vh);
      if (!(R - L >= Math.max(PX.MIN_W, w + 2 * PX.INSET)) || !(B - T >= Math.max(PX.MIN_H, h + 2 * PX.INSET))) return null;
      const left = L + PX.INSET, top = B - PX.INSET - h;
      if (typeof document.elementFromPoint === 'function') {
        const c = PX.CORNER, own = state.host, card = scope || img.closest('a[href]') || img.parentElement;
        // a header, a dialog or a popover over the image or over the control's own place hides the control
        for (const [x, y] of [[L + c, T + c], [R - c, T + c], [R - c, B - c], [left + c, top + c], [left + w - c, top + h - c], [left + c, top + h - c]]) {
          const t = document.elementFromPoint(x, y);
          if (!t) return null;
          if (t === own || t === img || (card && typeof card.contains === 'function' && card.contains(t))) continue;
          return null;
        }
      }
      return { vis: { left: L, top: T, right: R, bottom: B }, left: Math.round(left), top: Math.round(top), w, h, sig: [L, T, R, B, w, h].map(Math.round).join(',') };
    } catch (_) { return null; }
  }

  // The placement the user actually sees is the host's own rectangle. The image must still call for exactly that place (the same corner of its visible part, the same size):
  // a card that moved (a reflow, a lazy sibling resizing) leaves the fixed control where the image used to be, and that control no longer belongs to it.
  function shownAt() {
    const h = state.host;
    if (!h || h.isConnected === false || typeof h.getBoundingClientRect !== 'function') return null;
    const r = h.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function atPlace(img, scope, shown) {
    const lay = shown && img ? placeOf(img, shown.w, shown.h, scope) : null;
    return Boolean(lay) && Math.abs(lay.left - shown.left) <= PX.TOL && Math.abs(lay.top - shown.top) <= PX.TOL;
  }

  // The control this image gets: a count shows the labelled pair when the visible part can hold it, else two icon buttons; one button otherwise. Nothing when even that does not fit.
  function planOf(img, snap) {
    const scope = snap.scopeRef && snap.scopeRef.deref();
    if (snap.count >= 2) {
      const wide = placeOf(img, PX.MULTI_W, PX.MULTI_H, scope);
      if (wide) return { n: snap.count, compact: false, lay: wide };
      const compact = placeOf(img, PX.COMPACT_W, PX.COMPACT_H, scope);
      return compact ? { n: snap.count, compact: true, lay: compact } : null;
    }
    const lay = placeOf(img, PX.SIZE, PX.SIZE, scope);
    return lay ? { n: 0, compact: false, lay } : null;
  }

  // ---- the control: one host, a closed shadow root, a real button for "Save this" and one for "Save all (N)" ----
  function iconOf() {
    try {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(ns, 'path');
      for (const [k, v] of [['d', 'M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) path.setAttribute(k, v);
      svg.appendChild(path);
      return svg;
    } catch (_) { return null; }
  }

  // tier: 'single' (one round button), 'wide' (two labelled buttons), 'compact' (round "Save this" and a short "Save all" with the count)
  function buttonCss(btn, tier, isAll) {
    const width = tier === 'wide' ? PX.MULTI_W : (tier === 'compact' && isAll ? PX.COMPACT_W - PX.SIZE - 4 : PX.SIZE);
    for (const [k, v] of [['all', 'initial'], ['box-sizing', 'border-box'], ['display', 'flex'], ['align-items', 'center'], ['justify-content', 'center'], ['gap', tier === 'wide' ? '6px' : '2px'], ['width', `${width}px`],
      ['height', `${tier === 'wide' ? 28 : PX.SIZE}px`], ['border-radius', '9999px'], ['border', '1px solid rgba(237,224,252,0.6)'], ['background', 'rgba(24,17,31,0.82)'], ['color', '#fff'], ['cursor', 'pointer'],
      ['padding', tier === 'wide' ? '0 10px' : (tier === 'compact' && isAll ? '0 4px' : '0')], ['font', '600 12px/1 system-ui, -apple-system, Segoe UI, sans-serif'], ['white-space', 'nowrap']]) btn.style.setProperty(k, v);
  }

  function makeButton(mode) {
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    const icon = iconOf();
    if (icon) btn.appendChild(icon);
    const lbl = document.createElement('span');
    btn.appendChild(lbl);
    // the control lives over the card, outside of it, but no press of it may reach a handler of the page
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'touchstart', 'touchend']) btn.addEventListener(type, (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); });
    btn.addEventListener('click', (e) => onClick(e, mode), true);
    btn.addEventListener('keydown', (e) => onButtonKey(e, mode), true);
    return { btn, lbl };
  }

  function ensureHost() {
    if (state.host) return state.host;
    const host = document.createElement('div');
    host.setAttribute('data-image-saver-inline', 'pixiv');
    for (const [k, v] of [['position', 'fixed'], ['z-index', '2147483000'], ['display', 'flex'], ['flex-direction', 'column'], ['align-items', 'flex-start'], ['gap', '4px'], ['margin', '0'], ['padding', '0']]) host.style.setProperty(k, v);
    const shadow = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
    const one = makeButton('one'), all = makeButton('all');
    shadow.appendChild(one.btn);
    shadow.appendChild(all.btn);
    Object.assign(state, { host, btn: one.btn, lbl: one.lbl, btnAll: all.btn, lblAll: all.lbl });
    render(0, false);
    return host;
  }

  // n >= 2: "Save this" and "Save all (n)"; otherwise only the compact single action.
  function render(n, compact) {
    const multi = n >= 2;
    state.count = multi ? n : 0;
    state.compact = multi && compact === true;
    const { btn, lbl, btnAll, lblAll } = state;
    if (!btn || !btnAll) return;
    const tier = !multi ? 'single' : (compact ? 'compact' : 'wide');
    buttonCss(btn, tier, false);
    buttonCss(btnAll, tier, true);
    state.host.style.setProperty('flex-direction', tier === 'compact' ? 'row' : 'column');
    state.host.style.setProperty('align-items', tier === 'compact' ? 'center' : 'flex-start');
    isLabel(btn, 'aria-label', 'inline.saveThisAria', 'MediaLatch: Save this media');
    isLabel(btn, 'title', 'inline.saveThisAria', 'MediaLatch: Save this media');
    // wide: the words; compact: icons only, the count on "Save all"; the accessible names are the full words in every tier
    isLabel(lbl, 'textContent', tier === 'wide' ? 'inline.saveThis' : null, tier === 'wide' ? 'Save this' : '');
    lbl.style.setProperty('display', tier === 'wide' ? 'inline' : 'none');
    isLabel(lblAll, 'textContent', tier === 'wide' ? 'inline.saveAll' : null, tier === 'wide' ? `Save all (${n})` : (tier === 'compact' ? String(n) : ''), { n });
    lblAll.style.setProperty('display', multi ? 'inline' : 'none');
    if (multi) {
      btnAll.removeAttribute('hidden');
      isLabel(btnAll, 'aria-label', 'inline.saveAllAria', `MediaLatch: Save all ${n} media in this post`, { n });
      isLabel(btnAll, 'title', 'inline.saveAllAria', `MediaLatch: Save all ${n} media in this post`, { n });
    } else {
      btnAll.setAttribute('hidden', '');
      isLabel(btnAll, 'aria-label', null, null);
      isLabel(btnAll, 'title', null, null);
      btnAll.style.setProperty('display', 'none');
    }
  }

  function apply(lay) {
    const host = ensureHost();
    if (!host.parentNode) (document.body || document.documentElement).appendChild(host);
    host.style.setProperty('width', `${lay.w}px`);
    host.style.setProperty('height', `${lay.h}px`);
    host.style.setProperty('left', `${lay.left}px`);
    host.style.setProperty('top', `${lay.top}px`);
  }

  function hide() {
    if (state.snap) DBG.log('pixiv.inline', 'hide', 'info', undefined, null, { lvl: 'debug' });
    for (const k of ['timer', 'settleTimer']) if (state[k]) { clearTimeout(state[k]); state[k] = null; }
    if (state.observer) { try { state.observer.disconnect(); } catch (_) {} state.observer = null; }
    state.snap = null;
    state.keyEl = null;
    if (state.host && typeof state.host.remove === 'function') state.host.remove();
  }

  // The image is still the artwork's own but has no safe place now (half scrolled, covered): hide, and look once more from the pointer's place when things have settled.
  function hideAndRearm() {
    const n = state.rearmN;
    hide();
    if (n >= PX.SETTLE_MAX) return;
    state.rearmN = n + 1;
    state.settleTimer = setTimeout(() => { state.settleTimer = null; evaluate(); }, PX.SETTLE_MS);
  }

  function recheck() {
    const snap = state.snap;
    if (!snap) return;
    const img = snap.imgRef.deref();
    if (!img || !holds(snap)) { hide(); return; }
    const plan = planOf(img, snap);
    if (!plan || plan.n !== snap.count) { hide(); return; }
    if (plan.compact !== state.compact) render(plan.n, plan.compact);
    apply(plan.lay);
  }

  function show(img, snap, plan) {
    DBG.log('pixiv.inline', 'show', 'info', undefined, () => ({ layout: snap.layout, count: plan.n, compact: Boolean(plan.compact), artwork: snap.id, index: snap.index }), { lvl: 'debug' });
    ensureHost();
    state.snap = snap;
    render(plan.n, plan.compact);
    apply(plan.lay);
    if (state.observer) { try { state.observer.disconnect(); } catch (_) {} state.observer = null; }
    if (typeof MutationObserver === 'function') {
      // Scoped to the shown image, its link and its parent: a source that changes, a link that changes, the image being removed or replaced. One pending check.
      let queued = false;
      state.observer = new MutationObserver(() => { if (queued) return; queued = true; setTimeout(() => { queued = false; if (state.snap) recheck(); }, PX.SETTLE_MS); });
      state.observer.observe(img, { attributes: true, attributeFilter: ['src', 'srcset', 'style', 'class'] });
      if (img.parentNode) state.observer.observe(img.parentNode, { childList: true });
      const a = snap.anchorRef && snap.anchorRef.deref();
      if (a) state.observer.observe(a, { attributes: true, attributeFilter: ['href'] });
    }
  }

  function imageInStack(stack) {
    const own = state.host;
    for (const el of stack.slice(0, PX.MAX_STACK)) {
      if (!el || (own && el === own)) continue;
      if (el.tagName === 'IMG') return el; // the topmost image decides: an avatar or an icon over the artwork gets no control
    }
    return null;
  }

  function evaluate() {
    state.timer = null;
    try {
      if (document.hidden) { hide(); return; }
      if (location.href !== state.href) { state.href = location.href; hide(); }
      if (typeof document.elementsFromPoint !== 'function') return;
      const img = imageInStack(document.elementsFromPoint(state.x, state.y));
      if (!img) { hide(); return; }
      if (state.dismissed && state.dismissed === img) return;
      const held = state.snap && state.snap.imgRef.deref() === img && holds(state.snap) ? state.snap : null;
      const snap = held || snapshotOf(img);
      if (!snap) { hide(); return; }
      const plan = planOf(img, snap);
      if (!plan) { hideAndRearm(); return; }
      const v = plan.lay.vis;
      if (!(state.x >= v.left - 1 && state.x <= v.right + 1 && state.y >= v.top - 1 && state.y <= v.bottom + 1)) { hide(); return; }
      if (held) { if (plan.compact !== state.compact) render(plan.n, plan.compact); apply(plan.lay); return; }
      show(img, snap, plan);
    } catch (_) { hide(); }
  }

  function onMove(e) {
    if (!e || (e.pointerType && e.pointerType !== 'mouse')) return;
    state.x = e.clientX;
    state.y = e.clientY;
    state.rearmN = 0;
    if (!state.timer) state.timer = setTimeout(evaluate, PX.HOVER_MS);
  }

  // Keyboard: focusing a card link or an opened image shows the control; Tab then moves to "Save this" and on to "Save all", Tab or Escape leaves it.
  function imageWithin(node) {
    if (!node) return null;
    if (node.tagName === 'IMG') return node;
    if (typeof node.querySelectorAll !== 'function') return null;
    const imgs = Array.from(node.querySelectorAll('img')).filter((i) => assetOf(i));
    return imgs.length === 1 ? imgs[0] : null;
  }

  function onFocusIn(e) {
    try {
      const t = e && e.target;
      if (!t || (state.host && t === state.host) || typeof t.closest !== 'function') return;
      const img = imageWithin(t.tagName === 'A' ? t : (t.closest('a[href]') || t));
      if (!img || state.dismissed === t) return;
      const snap = snapshotOf(img);
      const plan = snap && planOf(img, snap);
      if (!plan) return;
      show(img, snap, plan);
      state.keyEl = t;
    } catch (_) {}
  }

  function onFocusOut(e) { if (e && state.dismissed === e.target) state.dismissed = null; }

  function onDocKey(e) {
    if (!e || e.key !== 'Tab' || e.shiftKey || !state.keyEl || !state.btn || document.activeElement !== state.keyEl) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof state.btn.focus === 'function') state.btn.focus();
  }

  // Tab order inside the control: image, "Save this", "Save all"; Shift+Tab goes back; Tab past the last action or Escape dismisses.
  function onButtonKey(e, mode) {
    if (!e || (e.key !== 'Tab' && e.key !== 'Escape')) return;
    if (e.key === 'Tab' && state.count >= 2) {
      const next = mode === 'one' && !e.shiftKey ? state.btnAll : (mode === 'all' && e.shiftKey ? state.btn : null);
      if (next && typeof next.focus === 'function') { if (typeof e.preventDefault === 'function') e.preventDefault(); next.focus(); return; }
    }
    const back = state.keyEl;
    if (e.key === 'Tab' && typeof e.preventDefault === 'function') e.preventDefault();
    state.dismissed = back || null;
    hide();
    if (back && typeof back.focus === 'function') back.focus();
  }

  const tokenOf = () => {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  function send(message, token) {
    const cid = pending.get(token) ? pending.get(token).cid : undefined;
    if (cid) message.dbg = cid;
    try {
      const sent = chrome.runtime.sendMessage(message);
      if (sent && typeof sent.catch === 'function') sent.catch(() => { DBG.log('pixiv.inline', 'dispatch', 'failed', 'MESSAGE_FAILED', { action: message.action }, { cid }); });
      DBG.log('pixiv.inline', 'dispatch', 'start', undefined, { action: message.action }, { cid });
    } catch (_) {
      pending.delete(token);
      DBG.log('pixiv.inline', 'dispatch', 'failed', 'EXTENSION_CONTEXT_GONE', { action: message.action }, { cid });
    }
    if (state.btn) {
      state.btn.setAttribute('aria-busy', 'true');
      if (state.btnAll) state.btnAll.setAttribute('aria-busy', 'true');
      if (state.busyTimer) clearTimeout(state.busyTimer);
      state.busyTimer = setTimeout(() => { state.busyTimer = null; if (state.btn) state.btn.removeAttribute('aria-busy'); if (state.btnAll) state.btnAll.removeAttribute('aria-busy'); }, PX.CLICK_GAP);
    }
  }

  // "Save this" / "Save all (N)": only a real click. The control must still belong to a fresh snapshot of the very image it was shown for, and it must still have its place.
  function onClick(e, mode) {
    if (e) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    if (!e || e.isTrusted !== true) { DBG.log('pixiv.inline', 'click', 'refused', 'NOT_TRUSTED', { which: mode }); return; }
    const cid = DBG.cid();
    const shown = state.snap;
    const img = shown && shown.imgRef.deref();
    const fresh = img ? snapshotOf(img) : null;
    const at = shownAt();
    const gate = !shown ? 'NO_CONTROL' : !img ? 'TARGET_GONE' : !fresh ? 'NO_SNAPSHOT' : (mode === 'all' && (state.count < 2 || fresh.count !== state.count)) ? 'NOT_A_BATCH'
      : !same(fresh, shown) ? 'TARGET_CHANGED' : !atPlace(img, fresh.scopeRef && fresh.scopeRef.deref(), at) ? 'LAYOUT_LOST' : '';
    if (gate) { DBG.log('pixiv.inline', 'click', 'refused', gate, { which: mode }, { cid }); hide(); return; }
    const key = `${mode}|${fresh.id}|${mode === 'one' ? fresh.index : fresh.count}`;
    const now = Date.now();
    if (state.busyKey === key && now - state.busyAt < PX.CLICK_GAP) { DBG.log('pixiv.inline', 'click', 'skipped', 'BUSY', { which: mode }, { cid }); return; }
    DBG.log('pixiv.inline', 'click', 'start', undefined, () => ({ which: mode, layout: fresh.layout, artwork: fresh.id, index: fresh.index, count: mode === 'all' ? fresh.count : undefined }), { cid });
    state.busyKey = key;
    state.busyAt = now;
    for (const [t, v] of pending) if (now - v.at > PX.TOKEN_TTL) pending.delete(t);
    while (pending.size >= 8) pending.delete(pending.keys().next().value);
    const token = tokenOf();
    pending.set(token, { mode, snap: fresh, href: location.href, at: now, cid, place: at });
    send({ action: mode === 'all' ? 'PIXIV_INLINE_SAVE_ALL' : 'PIXIV_INLINE_SAVE', token }, token);
  }

  // The background asks this document to prove the snapshot a second time, for the very action the token was minted for. One shot, whatever the answer.
  function answerOwner(token, mode) {
    const entry = typeof token === 'string' ? pending.get(token) : null;
    pending.delete(token);
    if (!entry || Date.now() - entry.at > PX.TOKEN_TTL) return { ok: false, reason: 'NO_TOKEN' };
    if (entry.mode !== mode) return { ok: false, reason: 'MODE_MISMATCH' };
    if (location.href !== entry.href) return { ok: false, reason: 'STALE_OWNER' };
    if (!holds(entry.snap)) return { ok: false, reason: 'STALE_OWNER' };
    const s = entry.snap;
    // and the image still is where the control the user clicked was shown (a move between the click and the proof is a stale owner)
    if (!atPlace(s.imgRef.deref(), s.scopeRef && s.scopeRef.deref(), entry.place)) return { ok: false, reason: 'STALE_OWNER' };
    return { ok: true, media: { mode, src: s.src, link: s.link, count: mode === 'all' ? s.count : 0 } };
  }

  // A page that goes into the back/forward cache keeps its world and its listeners: only what is transient goes (the control, the tokens, the timers, the busy state), so the
  // restored page saves again by itself. A real unload (and a re-injection) still ends everything in teardown().
  function suspend() {
    hide();
    pending.clear();
    state.busyKey = ''; state.busyAt = 0; state.dismissed = null; state.rearmN = 0;
    if (state.busyTimer) { clearTimeout(state.busyTimer); state.busyTimer = null; }
    for (const b of [state.btn, state.btnAll]) if (b) b.removeAttribute('aria-busy');
  }

  function teardown() {
    DBG.log('pixiv', 'teardown', 'info');
    hide();
    pending.clear();
    if (state.busyTimer) { clearTimeout(state.busyTimer); state.busyTimer = null; }
    if (state.host && typeof state.host.remove === 'function') state.host.remove();
    for (const [target, type, fn, opts] of listeners) { try { target.removeEventListener(type, fn, opts); } catch (_) {} }
    listeners.length = 0;
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && typeof chrome.runtime.onMessage.removeListener === 'function') chrome.runtime.onMessage.removeListener(onProof);
    if (globalThis.__medialatchPixivInline && globalThis.__medialatchPixivInline.teardown === teardown) delete globalThis.__medialatchPixivInline;
  }

  const listeners = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); };
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    on(document, 'pointermove', onMove, { capture: true, passive: true });
    on(document, 'focusin', onFocusIn, true);
    on(document, 'focusout', onFocusOut, true);
    on(document, 'keydown', onDocKey, true);
    on(document, 'visibilitychange', hide, true);
    // the control is placed from the image's rectangle: it goes away when the page moves under it, and comes back by itself where the pointer rests on an artwork image
    for (const type of ['scroll', 'wheel', 'resize', 'popstate']) on(window, type, () => { state.rearmN = 0; hideAndRearm(); }, { capture: true, passive: true });
    on(window, 'blur', (e) => { if (e.target === window) hide(); }, true);
    on(window, 'pagehide', (e) => { if (e && e.persisted === true) suspend(); else teardown(); }, true);
    on(window, 'pageshow', (e) => { if (e && e.persisted === true) { suspend(); state.href = location.href; } }, true);
  }

  function onProof(message, sender, sendResponse) {
    if (!message || message.action !== 'PIXIV_INLINE_OWNER') return;
    // only the extension's own background (not a page, not a content script of another tab) may ask
    if (!sender || sender.tab || sender.id !== chrome.runtime.id) { DBG.log('pixiv.inline', 'proof', 'refused', 'FOREIGN_ASKER'); return; }
    const entry = typeof message.token === 'string' ? pending.get(message.token) : null;
    const cid = entry && entry.cid ? entry.cid : undefined;
    const answer = answerOwner(message.token, message.mode);
    DBG.log('pixiv.inline', 'proof', answer && answer.ok ? 'ok' : 'refused', answer && answer.ok ? undefined : (answer && answer.reason) || 'NO_ANSWER', () => ({ mode: message.mode, count: answer && answer.media && answer.media.count || undefined }), { cid });
    sendResponse(answer);
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) chrome.runtime.onMessage.addListener(onProof);

  globalThis.__medialatchPixivInline = { teardown };
})();
