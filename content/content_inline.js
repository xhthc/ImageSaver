// content/content_inline.js - INLINE-UNIFIED-01: the inline Save controls of every supported site in ONE module (X, Reddit, Pixiv and the RedGIFs own-site player).
// Shared here: the control (one host, a closed shadow root, a real button for "Save this" and one for "Save all (N)"), its hover/focus/keyboard lifecycle, the one-shot
// tokens, the pending/batch stores, the trusted click, the message to the worker, the sender-checked proof listener and teardown. Per site (the handlers below): which node is
// a candidate, who owns it and how that is proven again, where the control goes, how many media "Save all" covers and what the descriptor of each one is.
// Hover does bounded DOM work and no network request. A click captures a fresh snapshot of that very element, mints a random one-shot token bound to it and sends ONLY the
// token; background.js validates the sender and asks THIS document (same frame and document id) to prove the snapshot again and to build the descriptor. No URL of the click is
// trusted, no cursor state of the context menu is reused and no contextmenu event is simulated. The site scripts (content_x.js, content_reddit.js, content_redgifs.js) keep the
// context-menu detection and expose what both use through globalThis.__medialatchSite; only the handler of the page's own host is started (the top frame only).
(() => {
  const DBG = (globalThis.ImageSaverDebug && globalThis.ImageSaverDebug.client('content')) || { log() {}, cid() { return ''; }, enabled() { return false; } };
  // a second injection into this same world (re-injection) replaces the first instance instead of doubling its controls and listeners; it keeps the first one's language subscription
  const prev = globalThis.__medialatchInline;
  if (prev && typeof prev.teardown === 'function') prev.teardown();
  const isI18n = globalThis.ImageSaverI18n;
  const isLabels = (prev && prev.labels) || (isI18n && typeof chrome !== 'undefined' ? isI18n.follow(chrome, typeof navigator !== 'undefined' ? navigator : null, () => {}) : null);
  const isLabel = (element, field, key, fallback, vars) => {
    if (isLabels) isLabels.label(element, field, key, vars, fallback);
    else if (field === 'textContent') element.textContent = fallback;
    else if (fallback === null) element.removeAttribute(field);
    else element.setAttribute(field, fallback);
  };
  const SITE = globalThis.__medialatchSite || {};

  // ---- shared kit ----
  const K = { HOVER_MS: 60, MAX_STACK: 24, MIN_W: 96, MIN_H: 64, TOKEN_TTL: 15000, CLICK_GAP: 1500, INSET: 8, SIZE: 32, SETTLE_MS: 100, SETTLE_MAX: 12, BATCH_MAX: 100, BATCH_TTL: 180000,
    MULTI_W: 104, MULTI_H: 60, COMPACT_W: 80, COMPACT_H: 32, CORNER: 3, TOL: 2, MAX_PENDING: 8, MAX_BATCHES: 4 };
  const PRESSES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'touchstart', 'touchend'];
  const listeners = [];
  const proofs = [];
  const controls = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); };
  const here = () => (typeof location !== 'undefined' && location.href) || '';

  // '' when the browser has no random source: nothing is minted without one
  const randomHex = (bytes) => {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') return '';
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  };

  // FNV-1a of a string: the structure signature of a list, never a URL
  function hashOf(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  // a media's ancestors up to its owner: the same chain of nodes proves the same place of the tree
  const sameChain = (a, b) => a.chain.length === b.chain.length && a.chain.every((ref, i) => ref.deref() === b.chain[i].deref());
  const clipsOf = (cs) => ['overflow', 'overflowX', 'overflowY'].some((k) => cs[k] && cs[k] !== 'visible');

  // What can move or replace the shown media: the owner's structure, the media's own source/style and its ancestors up to the owner
  function watchOwner(observer, el, snap) {
    const owner = snap.ownerRef.deref();
    if (!owner) return;
    observer.observe(owner, { childList: true, subtree: true });
    observer.observe(el, { attributes: true, attributeFilter: ['src', 'poster', 'style', 'class'] });
    for (const ref of snap.chain) {
      const node = ref.deref();
      if (node) observer.observe(node, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  }

  // a token store: expired entries go, at most `cap` live ones stay (the oldest is dropped first)
  function stash(map, token, entry, ttl, cap) {
    for (const [t, v] of map) if (entry.at - v.at > ttl) map.delete(t);
    while (map.size >= cap) map.delete(map.keys().next().value);
    map.set(token, entry);
  }

  // send the token only; the buttons stay aria-busy for the click gap
  function dispatch(scope, message, token, map, holder, buttons) {
    const entry = map && map.get(token);
    const cid = entry ? entry.cid : undefined;
    if (cid) message.dbg = cid;
    try {
      const sent = chrome.runtime.sendMessage(message);
      if (sent && typeof sent.catch === 'function') sent.catch(() => { DBG.log(scope, 'dispatch', 'failed', 'MESSAGE_FAILED', { action: message.action }, { cid }); });
      DBG.log(scope, 'dispatch', 'start', undefined, { action: message.action }, { cid });
    } catch (_) {
      if (map) map.delete(token);
      DBG.log(scope, 'dispatch', 'failed', 'EXTENSION_CONTEXT_GONE', { action: message.action }, { cid });
    }
    for (const b of buttons) if (b) b.setAttribute('aria-busy', 'true');
    if (holder.busyTimer) clearTimeout(holder.busyTimer);
    holder.busyTimer = setTimeout(() => { holder.busyTimer = null; for (const b of buttons) if (b) b.removeAttribute('aria-busy'); }, K.CLICK_GAP);
  }

  // Decorative (aria-hidden): the button's own label names it
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

  function styleButton(btn, w, h, gap, pad) {
    for (const [k, v] of [['all', 'initial'], ['box-sizing', 'border-box'], ['display', 'flex'], ['align-items', 'center'], ['justify-content', 'center'], ['gap', gap], ['width', `${w}px`], ['height', `${h}px`],
      ['border-radius', '9999px'], ['border', '1px solid rgba(237,224,252,0.6)'], ['background', 'rgba(24,17,31,0.82)'], ['color', '#fff'], ['cursor', 'pointer'], ['padding', pad],
      ['font', '600 12px/1 system-ui, -apple-system, Segoe UI, sans-serif'], ['white-space', 'nowrap']]) btn.style.setProperty(k, v);
  }

  // A real <button>: the download icon, optionally a label span; no press of it may reach a handler of the page; click and keydown are caught in the capture phase
  function makeButton(onClick, onKey, withLabel = true) {
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    const icon = iconOf();
    if (icon) btn.appendChild(icon);
    let lbl = null;
    if (withLabel) { lbl = document.createElement('span'); btn.appendChild(lbl); }
    for (const type of PRESSES) btn.addEventListener(type, (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); });
    btn.addEventListener('click', onClick, true);
    btn.addEventListener('keydown', onKey, true);
    return { btn, lbl, icon };
  }

  // ---- the control: one per site that shows "Save this" / "Save all (N)" over the media it owns ----
  // `make(ctl)` returns the site's rules: name, K (constants), fixed, align, modes, hideOn/rearmOn, candidate, snapshot, holds, same, plan, heldPlan, stale, watch, focusTarget,
  // showDetail, prepare, proof, onOver. ctl holds the state, the stores and the lifecycle the rules use.
  function createControl(make) {
    const st = { host: null, btn: null, btnAll: null, lbl: null, lblAll: null, count: 0, compact: false, snap: null, el: null, observer: null, timer: null, settleTimer: null, settleN: 0,
      rearmTimer: null, viewportFrame: null, rearmN: 0, sig: '', href: '', x: 0, y: 0, busyKey: '', busyAt: 0, busyTimer: null, keyEl: null, dismissed: null };
    const pending = new Map();
    const batches = new Map();
    const ctl = { st, pending, batches };
    const site = make(ctl);
    const C = site.K;
    const scope = `${site.name}.inline`;
    const [ONE, ALL] = site.modes || ['this', 'all'];
    const own = (el) => Boolean(st.host && (el === st.host || (typeof st.host.contains === 'function' && st.host.contains(el))));
    const size = () => (st.count >= 2
      ? (st.compact ? { w: C.COMPACT_W, h: C.COMPACT_H } : { w: C.MULTI_W, h: C.MULTI_H })
      : { w: C.SIZE, h: C.SIZE });
    const cidOf = (token) => {
      const entry = typeof token === 'string' ? (pending.get(token) || batches.get(token)) : null;
      return entry && entry.cid ? entry.cid : undefined;
    };
    const clearTimer = (k) => { if (st[k]) { clearTimeout(st[k]); st[k] = null; } };
    const unobserve = () => { if (st.observer) { try { st.observer.disconnect(); } catch (_) {} st.observer = null; } };

    // tier: 'single' (one round button), 'wide' (two labelled buttons), 'compact' (round "Save this" and a short "Save all" with the count)
    function tierCss(btn, tier, isAll) {
      const w = tier === 'wide' ? C.MULTI_W : (tier === 'compact' && isAll ? C.COMPACT_W - C.SIZE - 4 : C.SIZE);
      styleButton(btn, w, tier === 'wide' ? 28 : C.SIZE, tier === 'wide' ? '6px' : '2px', tier === 'wide' ? '0 10px' : (tier === 'compact' && isAll ? '0 4px' : '0'));
    }

    // n >= 2: "Save this" and "Save all (n)"; otherwise only the single action. wide: the words; compact: icons only, the count on "Save all"; the accessible names are the full words in every tier
    function render(n, compact = false) {
      const multi = n >= 2;
      st.count = multi ? n : 0;
      st.compact = multi && compact === true;
      const { btn, lbl, btnAll, lblAll } = st;
      if (!btn || !btnAll) return;
      const tier = !multi ? 'single' : (compact ? 'compact' : 'wide');
      tierCss(btn, tier, false);
      tierCss(btnAll, tier, true);
      const hs = st.host && st.host.style;
      if (hs) {
        hs.setProperty('flex-direction', tier === 'compact' ? 'row' : 'column');
        hs.setProperty('align-items', tier === 'compact' ? 'center' : site.align);
        hs.setProperty('justify-content', 'flex-end');
      }
      isLabel(btn, 'aria-label', 'inline.saveThisAria', 'MediaLatch: Save this media');
      isLabel(btn, 'title', 'inline.saveThisAria', 'MediaLatch: Save this media');
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

    function ensureHost() {
      if (st.host) return st.host;
      const host = document.createElement('div');
      host.setAttribute('data-image-saver-inline', site.name);
      for (const [k, v] of [['position', site.fixed ? 'fixed' : 'absolute'], ['z-index', String(C.Z)], ['display', 'flex'], ['flex-direction', 'column'], ['align-items', site.align], ['gap', '4px'],
        ['width', `${C.SIZE}px`], ['height', `${C.SIZE}px`], ['margin', '0'], ['padding', '0']]) host.style.setProperty(k, v);
      const root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
      const one = makeButton((e) => click(ONE, e), (e) => buttonKey(e, ONE));
      const all = makeButton((e) => click(ALL, e), (e) => buttonKey(e, ALL));
      root.appendChild(one.btn);
      root.appendChild(all.btn);
      Object.assign(st, { host, btn: one.btn, lbl: one.lbl, btnAll: all.btn, lblAll: all.lbl });
      render(0, false);
      return host;
    }

    // Attach the control at the proven place: a local child of the proven container (the same node is moved, never duplicated) or, for a fixed host, the page body.
    function apply(lay) {
      const host = ensureHost();
      const into = lay.host || document.body || document.documentElement;
      if (host.parentNode !== into) into.appendChild(host);
      host.style.setProperty('width', `${lay.w}px`);
      host.style.setProperty('height', `${lay.h}px`);
      host.style.setProperty('left', `${lay.left}px`);
      host.style.setProperty('top', `${lay.top}px`);
    }

    function hide() {
      if (st.viewportFrame !== null) { window.cancelAnimationFrame(st.viewportFrame); st.viewportFrame = null; }
      if (st.snap) DBG.log(scope, 'hide', 'info', undefined, null, { lvl: 'debug' });
      for (const k of ['timer', 'settleTimer', 'rearmTimer']) clearTimer(k);
      unobserve();
      st.snap = null; st.el = null; st.keyEl = null; st.sig = ''; st.settleN = 0; st.rearmN = 0;
      if (st.host && typeof st.host.remove === 'function') st.host.remove();
    }

    // The media is still the owner's own but has no safe visible place (a hidden slide, a half-scrolled tile, covered): hide the whole control now and look again a few times
    // (bounded) from the pointer's place, so it returns by itself once the tile has settled.
    function hideUntilVisible() {
      const n = st.rearmN;
      hide();
      st.rearmN = n;
      if (n >= C.SETTLE_MAX || st.rearmTimer) { if (n >= C.SETTLE_MAX) DBG.log(scope, 'rearm', 'skipped', 'REARM_EXHAUSTED', { attempt: n }, { lvl: 'debug' }); return; }
      st.rearmN = n + 1;
      st.rearmTimer = setTimeout(() => {
        st.rearmTimer = null;
        DBG.log(scope, 'rearm', 'info', undefined, { attempt: n + 1 }, { lvl: 'debug' });
        evaluate();
      }, C.SETTLE_MS);
    }

    // Re-prove the shown control: same owner, still a safe visible place, the right actions; follow a moving slide for a bounded time.
    function recheck() {
      st.settleTimer = null;
      const snap = st.snap;
      if (!snap) return;
      const el = snap.elRef.deref();
      if (!(el && site.holds(snap))) { hide(); return; }
      const plan = site.plan(el, snap);
      if (!plan) { hideUntilVisible(); return; }
      if (site.stale && site.stale(plan, snap)) { hide(); return; }
      if (plan.n !== st.count || plan.compact !== st.compact) render(plan.n, plan.compact);
      apply(plan.lay);
      if (plan.lay.sig !== st.sig) {
        st.sig = plan.lay.sig;
        if (st.settleN < C.SETTLE_MAX) { st.settleN++; st.settleTimer = setTimeout(recheck, C.SETTLE_MS); }
      } else {
        st.settleN = 0;
      }
    }

    function show(el, snap, plan) {
      DBG.log(scope, 'show', 'info', undefined, () => site.showDetail(el, snap, plan), { lvl: 'debug' });
      ensureHost();
      st.snap = snap;
      st.el = el;
      st.sig = plan.lay.sig;
      st.settleN = 0;
      clearTimer('settleTimer');
      render(plan.n, plan.compact);
      apply(plan.lay);
      unobserve();
      if (typeof MutationObserver === 'function') {
        let queued = false;
        const host = st.host;
        st.observer = new MutationObserver((records) => {
          if (Array.isArray(records) && records.length && records.every((rec) => rec && rec.target === host)) return;
          if (queued) return;
          queued = true;
          setTimeout(() => { queued = false; if (st.snap) recheck(); }, C.SETTLE_MS);
        });
        site.watch(st.observer, el, snap);
      }
    }

    function evaluate() {
      st.timer = null;
      try {
        if (document.hidden) { hide(); return; }
        const href = here();
        if (href !== st.href) { st.href = href; hide(); }
        if (typeof document.elementsFromPoint !== 'function') return;
        const cand = site.candidate(document.elementsFromPoint(st.x, st.y));
        if (!cand) { hide(); return; }
        if (st.dismissed && st.dismissed === cand.el) return;
        const held = st.snap && st.snap.elRef.deref() === cand.el && site.holds(st.snap) ? st.snap : null;
        const snap = held || site.snapshot(cand.el, cand.kind);
        if (!snap) { hide(); return; }
        const plan = held && site.heldPlan ? site.heldPlan(cand.el, snap) : site.plan(cand.el, snap);
        if (!plan) { hideUntilVisible(); return; }
        // The pointer must be on the VISIBLE part of this media (a clipped remainder of a raw rectangle is not the media).
        const v = plan.lay.vis;
        if (!(st.x >= v.left - 1 && st.x <= v.right + 1 && st.y >= v.top - 1 && st.y <= v.bottom + 1)) { hide(); return; }
        st.rearmN = 0;
        if (held) { if (plan.compact !== st.compact) render(plan.n, plan.compact); apply(plan.lay); st.sig = plan.lay.sig; return; }
        show(cand.el, snap, plan);
      } catch (_) {
        hide();
      }
    }

    function onMove(e) {
      if (!e || (e.pointerType && e.pointerType !== 'mouse')) return;
      st.x = e.clientX;
      st.y = e.clientY;
      st.rearmN = 0;
      if (!st.timer) st.timer = setTimeout(evaluate, C.HOVER_MS);
    }

    // Keyboard: focusing an owned media (or its focusable wrapper) shows the control; Tab then moves to "Save this" and on to "Save all", and Tab or Escape leaves it.
    function onFocusIn(e) {
      try {
        const t = e && e.target;
        if (!t || own(t)) return;
        const f = site.focusTarget(t);
        if (!f || st.dismissed === t) return;
        const snap = site.snapshot(f.el, f.kind);
        if (!snap) return;
        const plan = site.plan(f.el, snap);
        if (!plan) return;
        show(f.el, snap, plan);
        st.keyEl = t;
      } catch (_) {}
    }

    function onFocusOut(e) {
      if (e && st.dismissed === e.target) st.dismissed = null;
    }

    function onDocKey(e) {
      if (!e || e.key !== 'Tab' || e.shiftKey || !st.keyEl || !st.btn || document.activeElement !== st.keyEl) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof st.btn.focus === 'function') st.btn.focus();
    }

    // Tab order inside the control: media, "Save this", "Save all"; Shift+Tab goes back; Tab past the last action or Escape dismisses.
    function buttonKey(e, which) {
      if (!e || (e.key !== 'Tab' && e.key !== 'Escape')) return;
      if (e.key === 'Tab' && st.count >= 2) {
        const next = which === ONE && !e.shiftKey ? st.btnAll : (which === ALL && e.shiftKey ? st.btn : null);
        if (next && typeof next.focus === 'function') { if (typeof e.preventDefault === 'function') e.preventDefault(); next.focus(); return; }
      }
      const back = st.keyEl;
      if (e.key === 'Tab' && typeof e.preventDefault === 'function') e.preventDefault();
      st.dismissed = back || null;
      hide();
      if (back && typeof back.focus === 'function') back.focus();
    }

    // "Save this" / "Save all (N)": only a real click. The site proves the control still belongs to a fresh snapshot of the very element it was shown for and still has its place
    // (prepare returns a refusal code, or the key, store, entry and action of the request); the kit does the rest: busy gap, token, message.
    function click(which, e) {
      if (e) {
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (typeof e.preventDefault === 'function') e.preventDefault();
      }
      if (!e || e.isTrusted !== true) { DBG.log(scope, 'click', 'refused', 'NOT_TRUSTED', { which }); return; }
      const cid = DBG.cid();
      const r = site.prepare(which, st.snap, cid);
      if (r.gate) { DBG.log(scope, 'click', 'refused', r.gate, r.detail, { cid }); (r.soft ? hideUntilVisible : hide)(); return; }
      const now = Date.now();
      if (st.busyKey === r.key && now - st.busyAt < C.CLICK_GAP) { DBG.log(scope, 'click', 'skipped', 'BUSY', { which }, { cid }); return; }
      const token = randomHex(16);
      if (!token) { DBG.log(scope, 'click', 'failed', 'NO_RANDOM', null, { cid }); return; }
      DBG.log(scope, 'click', 'start', undefined, r.start, { cid });
      st.busyKey = r.key;
      st.busyAt = now;
      r.entry.at = now;
      const store = r.store === 'batches' ? batches : pending;
      stash(store, token, r.entry, store === batches ? C.BATCH_TTL : C.TOKEN_TTL, store === batches ? K.MAX_BATCHES : K.MAX_PENDING);
      dispatch(scope, { action: r.action, token }, token, store, st, [st.btn, st.btnAll]);
    }

    // One snapshot per listed item, each of them in the same owner: the snapshots, or the index of the item that is not
    function snapshotAll(items, owner) {
      const snaps = [];
      for (const it of items) {
        const snap = site.snapshot(it.el, it.kind);
        if (!snap || snap.ownerRef.deref() !== owner) return { index: snaps.length };
        snaps.push(snap);
      }
      return { snaps };
    }

    // The batch: phase 1 (open) proves the page, the owner and the whole list again and freezes every item's descriptor (site.admit returns a refusal code or null); phase 2 (item)
    // hands out ONE frozen descriptor, once, right before that item is saved. A navigation away from the admitted page still stops the slots that have not started.
    function batchEntry(token) {
      const entry = typeof token === 'string' ? batches.get(token) : null;
      if (!entry || Date.now() - entry.at > C.BATCH_TTL) { batches.delete(token); return null; }
      return entry;
    }

    function batchOpen(token) {
      const entry = batchEntry(token);
      if (!entry) return { ok: false, reason: 'NO_TOKEN' };
      if (entry.opened) return { ok: false, reason: 'USED' };
      entry.opened = true;
      const reason = site.admit(entry);
      if (reason) { batches.delete(token); return { ok: false, reason }; }
      return { ok: true, count: entry.count, ownerId: entry.ownerId, sig: entry.sig };
    }

    function batchItem(token, index) {
      const entry = batchEntry(token);
      if (!entry) return { ok: false, reason: 'NO_TOKEN' };
      const item = Number.isInteger(index) && index >= 0 && index < entry.items.length ? entry.items[index] : null;
      if (!item || !entry.opened) return { ok: false, reason: 'NO_TOKEN' };
      if (item.used) return { ok: false, reason: 'USED' };
      item.used = true;
      if (entry.items.every((it) => it.used)) batches.delete(token);
      if (here() !== entry.href) return { ok: false, reason: 'STALE_OWNER' };
      return entry.frozen[index];
    }

    // The worker's proof questions (one handler per action): only the extension's own background (not a page, not a content script of another tab) may ask
    function onProof(message, sender, sendResponse) {
      const rule = message && site.proof[message.action];
      if (!rule) return;
      if (!sender || sender.tab || sender.id !== chrome.runtime.id) { DBG.log(scope, 'proof', 'refused', 'FOREIGN_ASKER'); return; }
      const cid = cidOf(message.token);
      const answer = rule.run(message);
      DBG.log(scope, rule.phase, answer && answer.ok ? 'ok' : 'refused', answer && answer.ok ? undefined : (answer && answer.reason) || 'NO_ANSWER', () => rule.detail(message, answer), { cid });
      sendResponse(answer);
      return true;
    }

    // A page that goes into the back/forward cache keeps its world and its listeners: only what is transient goes (the control, the tokens, the timers, the busy state), so the
    // restored page saves again by itself. A real unload (and a re-injection) still ends everything in teardown().
    function suspend() {
      hide();
      pending.clear();
      batches.clear();
      st.busyKey = ''; st.busyAt = 0; st.dismissed = null; st.rearmN = 0;
      clearTimer('busyTimer');
      for (const b of [st.btn, st.btnAll]) if (b) b.removeAttribute('aria-busy');
    }

    function teardown() {
      DBG.log(site.name, 'teardown', 'info');
      suspend();
      if (st.host && typeof st.host.remove === 'function') st.host.remove();
      Object.assign(st, { host: null, btn: null, btnAll: null, lbl: null, lblAll: null });
    }

    Object.assign(ctl, { site, scope, own, size, render, ensureHost, apply, hide, hideUntilVisible, recheck, show, evaluate, onMove, click, snapshotAll, batchOpen, batchItem, suspend, teardown });
    if (typeof document.addEventListener === 'function' && typeof window.addEventListener === 'function') {
      on(document, 'pointermove', onMove, { capture: true, passive: true });
      if (site.onOver) on(document, 'pointerover', site.onOver, { capture: true, passive: true });
      on(document, 'focusin', onFocusIn, true);
      on(document, 'focusout', onFocusOut, true);
      on(document, 'keydown', onDocKey, true);
      on(document, 'visibilitychange', hide, true);
      for (const type of site.hideOn) on(window, type, hide, { capture: true, passive: true });
      for (const type of site.rearmOn) on(window, type, () => { st.rearmN = 0; hideUntilVisible(); }, { capture: true, passive: true });
      for (const type of site.followOn || []) on(window, type, () => {
        if (!st.snap) { st.rearmN = 0; hideUntilVisible(); return; }
        if (st.viewportFrame === null) st.viewportFrame = window.requestAnimationFrame(() => {
          st.viewportFrame = null;
          if (document.hidden) hide(); else recheck();
        });
      }, { capture: true, passive: true });
      on(window, 'blur', (e) => { if (e.target === window) hide(); }, true);
    }
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) { chrome.runtime.onMessage.addListener(onProof); proofs.push(onProof); }
    controls.push(ctl);
    return ctl;
  }

  // ---- Pixiv (https://www.pixiv.net/*): the artwork images ----
  // "Save this" (exactly the selected page, a proven page index included) on every artwork image, preview card or opened artwork; "Save all (N)" only when the card or the opened artwork
  // itself shows the artwork's page count (2..100). The control is one fixed host at the bottom-left of the image's visible part. A page count shown in the DOM only labels the
  // button: the worker checks the artwork's real list against it and reads the declared originals (never here).
  function pixivHandler() {
    const PX = { ...K, SETTLE_MS: 150, TOL: 1, Z: 2147483000, SCOPE_DEPTH: 6, SCAN_IMGS: 60, SCAN_NODES: 80 };
    const ASSET = /\/(\d{1,12})_p(\d{1,3})_(?:master|square|custom)\d+\.[a-z0-9]+$/i;
    const ARTWORK = /^\/(?:[a-z]{2}\/)?artworks\/(\d{1,12})\/?$/;
    DBG.log('pixiv', 'init', 'info');

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
        const preview = snap.layout === 'preview', img = snap.elRef.deref();
        const box = preview && img ? img.getBoundingClientRect() : null;
        if (preview && !box) return 0;
        const found = new Set();
        for (const el of Array.from(scope.querySelectorAll('span, div')).slice(0, PX.SCAN_NODES)) {
          if (el.children.length > 1) continue;
          const m = (preview ? /^([1-9]\d{0,2})$/ : /^(\d{1,3})\s*\/\s*(\d{1,3})$/).exec(String(el.textContent || '').trim());
          if (!m) continue;
          if (preview) {
            // Also reject a numeric wrapper around a profile link, not only the text node inside that link.
            if ([el.closest('a[href]'), el.querySelector('a[href]')].some((a) => a && artworkOf(a.getAttribute('href')) !== snap.id)) continue;
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
      return { elRef: new WeakRef(img), anchorRef: o.anchor ? new WeakRef(o.anchor) : null, layout: o.layout, id: o.asset.id, index: o.asset.index, src: o.asset.src, link: o.link };
    }

    // The whole snapshot: the identity, the artwork's own scope and the page count its label shows (one bounded scan).
    function snapshot(img) {
      const snap = identityOf(img);
      if (!snap) return null;
      const scope = scopeOf(img, snap.id);
      snap.scopeRef = scope ? new WeakRef(scope) : null;
      snap.count = countOf(scope, snap);
      return snap;
    }

    // Is this still the same image, in the same place, for the same artwork and asset?
    function same(a, b) {
      return Boolean(a && b) && a.elRef.deref() === b.elRef.deref() && (a.anchorRef ? a.anchorRef.deref() : null) === (b.anchorRef ? b.anchorRef.deref() : null) &&
        a.layout === b.layout && a.id === b.id && a.index === b.index && a.src === b.src && a.link === b.link;
    }

    function holds(snap) {
      try {
        const img = snap.elRef.deref();
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
          const c = PX.CORNER, card = scope || img.closest('a[href]') || img.parentElement;
          // a header, a dialog or a popover over the image or over the control's own place hides the control
          for (const [x, y] of [[L + c, T + c], [R - c, T + c], [R - c, B - c], [left + c, top + c], [left + w - c, top + h - c], [left + c, top + h - c]]) {
            const t = document.elementFromPoint(x, y);
            if (!t) return null;
            if (ctl.own(t) || t === img || (card && typeof card.contains === 'function' && card.contains(t))) continue;
            return null;
          }
        }
        return { vis: { left: L, top: T, right: R, bottom: B }, left: Math.round(left), top: Math.round(top), w, h, sig: [L, T, R, B, w, h].map(Math.round).join(',') };
      } catch (_) { return null; }
    }

    // The placement the user actually sees is the host's own rectangle. The image must still call for exactly that place (the same corner of its visible part, the same size):
    // a card that moved (a reflow, a lazy sibling resizing) leaves the fixed control where the image used to be, and that control no longer belongs to it.
    function shownAt() {
      const h = ctl.st.host;
      if (!h || h.isConnected === false || typeof h.getBoundingClientRect !== 'function') return null;
      const r = h.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    function atPlace(img, scope, shown) {
      const lay = shown && img ? placeOf(img, shown.w, shown.h, scope) : null;
      return Boolean(lay) && Math.abs(lay.left - shown.left) <= PX.TOL && Math.abs(lay.top - shown.top) <= PX.TOL;
    }

    // The control this image gets: a count shows the labelled pair when the visible part can hold it, else two icon buttons; one button otherwise. Nothing when even that does not fit.
    function plan(img, snap) {
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

    function imageWithin(node) {
      if (!node) return null;
      if (node.tagName === 'IMG') return node;
      if (typeof node.querySelectorAll !== 'function') return null;
      const imgs = Array.from(node.querySelectorAll('img')).filter((i) => assetOf(i));
      return imgs.length === 1 ? imgs[0] : null;
    }

    // The background asks this document to prove the snapshot a second time, for the very action the token was minted for. One shot, whatever the answer.
    function answerOwner(token, mode) {
      const entry = typeof token === 'string' ? ctl.pending.get(token) : null;
      ctl.pending.delete(token);
      if (!entry || Date.now() - entry.at > PX.TOKEN_TTL) return { ok: false, reason: 'NO_TOKEN' };
      if (entry.mode !== mode) return { ok: false, reason: 'MODE_MISMATCH' };
      if (location.href !== entry.href) return { ok: false, reason: 'STALE_OWNER' };
      if (!holds(entry.snap)) return { ok: false, reason: 'STALE_OWNER' };
      const s = entry.snap;
      // and the image still is where the control the user clicked was shown (a move between the click and the proof is a stale owner)
      if (!atPlace(s.elRef.deref(), s.scopeRef && s.scopeRef.deref(), entry.place)) return { ok: false, reason: 'STALE_OWNER' };
      return { ok: true, media: { mode, src: s.src, link: s.link, count: mode === 'all' ? s.count : 0 } };
    }

    const ctl = createControl((c) => ({
      name: 'pixiv', K: PX, fixed: true, align: 'flex-start', modes: ['one', 'all'], hideOn: [], rearmOn: ['scroll', 'wheel', 'resize', 'popstate'],
      candidate(stack) {
        for (const el of stack.slice(0, PX.MAX_STACK)) {
          if (!el || c.own(el)) continue;
          if (el.tagName === 'IMG') return { el, kind: 'image' }; // the topmost image decides: an avatar or an icon over the artwork gets no control
        }
        return null;
      },
      snapshot, holds, plan,
      stale: (p, snap) => p.n !== snap.count,
      watch(observer, img, snap) {
        // Scoped to the shown image, its link and its parent: a source that changes, a link that changes, the image being removed or replaced.
        observer.observe(img, { attributes: true, attributeFilter: ['src', 'srcset', 'style', 'class'] });
        if (img.parentNode) observer.observe(img.parentNode, { childList: true });
        const a = snap.anchorRef && snap.anchorRef.deref();
        if (a) observer.observe(a, { attributes: true, attributeFilter: ['href'] });
      },
      focusTarget(t) {
        if (typeof t.closest !== 'function') return null;
        const img = imageWithin(t.tagName === 'A' ? t : (t.closest('a[href]') || t));
        return img ? { el: img, kind: 'image' } : null;
      },
      showDetail: (img, snap, p) => ({ layout: snap.layout, count: p.n, compact: Boolean(p.compact), artwork: snap.id, index: snap.index }),
      prepare(which, shown, cid) {
        const mode = which;
        const img = shown && shown.elRef.deref();
        const fresh = img ? snapshot(img) : null;
        const at = shownAt();
        const gate = !shown ? 'NO_CONTROL' : !img ? 'TARGET_GONE' : !fresh ? 'NO_SNAPSHOT' : (mode === 'all' && (c.st.count < 2 || fresh.count !== c.st.count)) ? 'NOT_A_BATCH'
          : !same(fresh, shown) ? 'TARGET_CHANGED' : !atPlace(img, fresh.scopeRef && fresh.scopeRef.deref(), at) ? 'LAYOUT_LOST' : '';
        if (gate) return { gate, detail: { which: mode } };
        return {
          key: `${mode}|${fresh.id}|${mode === 'one' ? fresh.index : fresh.count}`,
          store: 'pending',
          entry: { mode, snap: fresh, href: location.href, cid, place: at },
          action: mode === 'all' ? 'PIXIV_INLINE_SAVE_ALL' : 'PIXIV_INLINE_SAVE',
          start: () => ({ which: mode, layout: fresh.layout, artwork: fresh.id, index: fresh.index, count: mode === 'all' ? fresh.count : undefined })
        };
      },
      proof: { PIXIV_INLINE_OWNER: { phase: 'proof', run: (m) => answerOwner(m.token, m.mode), detail: (m, a) => ({ mode: m.mode, count: a && a.media && a.media.count || undefined }) } }
    }));
    return ctl;
  }

  // ---- VK (https://vk.ru/*, https://vk.com/*): photos, videos and clips ----
  // The control is Pixiv-shaped (one fixed host over the visible part of the selected media) with X/Reddit-shaped batches (every item of "Save all" is frozen at admission and proven
  // again right before it runs). What is selected: a loaded photo <img> on a VK photo CDN host, or an opened <video> whose own source is a direct file; its EXACT address travels, the
  // worker validates the host again and the generic context-menu pipeline resolves and saves it (no VK downloader, no rewritten address, no size guess). The nearest intrinsic signed post boundary owns the list;
  // an attachment is a link of the /photo-, /video-,
  // /clip- OWNER_ID route that wraps exactly one media element, and a list that cannot be proven (media no link claims, a "+N" tile, a repeated attachment, a nested post, over the cap)
  // offers no "Save all". A video or clip tile whose source the DOM does not declare as a direct file is a failed item of the batch (never omitted, never its poster); a blob, a manifest
  // or an unlisted host gets no control at all. The wall owner of the URL is never an author. Not verified against the live DOM: see the handoff (feed posts, comments, video transport).
  function vkHandler() {
    const VK = { ...K, SETTLE_MS: 150, TOL: 1, Z: 2147483000, DEPTH: 60, ANCHORS: 400 };
    const PHOTO_HOST = /(?:^|\.)(?:vkuserphoto\.ru|userapi\.com)$/;
    // the media hosts the page's own CSP names (not checked against the three example posts): a video from any other host gets no control
    const VIDEO_HOST = /(?:^|\.)(?:vkvideo\.ru|userapi\.com|vkuser\.net|okcdn\.ru|mycdn\.me|cdn-vk\.ru|vk\.com|vk\.ru)$/;
    const SITE_HOST = /^(?:vk\.ru|vk\.com)$/;
    const ATTACHMENT = /^\/(photo|video|clip)(-?\d{1,12})_(\d{1,12})\/?$/;
    const FILE = /\.(?:mp4|webm|ogv|mov|m4v)$/i;
    const NO_OWNER = { deref: () => null };
    const MODAL = 'dialog, [role="dialog"], [aria-modal="true"]';
    const noted = new WeakSet();
    DBG.log('vk', 'init', 'info');

    const urlOf = (raw) => { try { const u = new URL(raw, location.href); return u.protocol === 'https:' && !u.username && !u.password && !u.port ? u : null; } catch (_) { return null; } };
    const listNote = (el, code, n) => { if (!noted.has(el)) { noted.add(el); DBG.log('vk.inline', 'list', 'refused', code, { count: n }, { lvl: 'debug' }); } };
    const note = (el, reason, transport) => { if (el && !noted.has(el)) { noted.add(el); DBG.log('vk.inline', 'candidate', 'refused', reason, { kind: 'video', transport, host: String(el.currentSrc || el.src || '') }, { lvl: 'debug' }); } };

    // ---- what a media element is ----
    function photoOk(img) {
      try {
        const u = urlOf(img.currentSrc || img.src || '');
        if (!u || !PHOTO_HOST.test(u.hostname) || !img.complete || !(img.naturalWidth > 0)) return false;
        const a = anchorOf(img);
        if (a && !routeOf(a)) {
          const linked = urlOf(a.getAttribute('href') || '');
          if (!linked || !PHOTO_HOST.test(linked.hostname)) return false;
        }
        const r = img.getBoundingClientRect();
        return r.width >= VK.MIN_W && r.height >= VK.MIN_H; // an avatar, an emoji or a badge is smaller than a media tile
      } catch (_) { return false; }
    }
    // the source of an opened <video> that the browser itself plays: a direct https file on a VK media host (never blob:, a manifest, a poster or another host)
    function directVideo(v) {
      const u = urlOf(v.currentSrc || v.src || '');
      return Boolean(u && VIDEO_HOST.test(u.hostname) && FILE.test(u.pathname));
    }
    function routeOf(a) {
      const u = a && typeof a.getAttribute === 'function' ? urlOf(a.getAttribute('href') || '') : null;
      const m = u && SITE_HOST.test(u.hostname) ? ATTACHMENT.exec(u.pathname) : null;
      return m ? { kind: m[1], id: `${m[1]}${m[2]}_${m[3]}` } : null;
    }
    const anchorOf = (el) => (el && typeof el.closest === 'function' ? el.closest('a[href]') : null);

    // ---- the post: the key the page names, found in attribute values only ----
    function pageKey() {
      try {
        const u = new URL(location.href);
        const m = /^\/wall(-?\d{1,12})_(\d{1,12})\/?$/.exec(u.pathname) || /^wall(-?\d{1,12})_(\d{1,12})$/.exec(u.searchParams.get('w') || '');
        return m ? `${m[1]}_${m[2]}` : '';
      } catch (_) { return ''; }
    }
    // Only intrinsic, exact post identity can establish a boundary; references in outer app URLs cannot own a post.
    function postIdentity(el) {
      const ids = new Set();
      for (const name of ['id', 'data-post-id', 'data-post', 'data-wall-post-id']) {
        const m = /^(?:wall|post)?(-?\d{1,12}_\d{1,12})$/.exec(el.getAttribute(name) || '');
        if (m) ids.add(m[1]);
      }
      return ids.size === 1 ? [...ids][0] : (ids.size ? 'ambiguous' : '');
    }
    function rootOf(el, key) {
      if (!key) return null;
      for (let p = el.parentElement, n = 0; p && p !== document.body && p !== document.documentElement && n < VK.DEPTH; p = p.parentElement, n++) {
        const id = postIdentity(p);
        if (id) return id === key ? p : null;
      }
      return null;
    }
    // a comment or reply of this post (an id that extends the post key, key_COMMENT): its attachments are not the post's
    function inComment(el, root, key) {
      const re = new RegExp('(?<![0-9-])' + key + '_[0-9]');
      for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
        for (const name of p.getAttributeNames()) { const v = p.getAttribute(name) || ''; if (v.length <= 600 && re.test(v)) return true; }
        if (p === root) break;
      }
      return false;
    }
    // another post nested in the owner (a repost): an attribute value that names a post other than this one
    const OTHER_POST = /(?:wall|post)(-?\d{1,12})_(\d{1,12})/g;
    function otherPost(el, root, key) {
      for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
        for (const name of p.getAttributeNames()) {
          const v = p.getAttribute(name) || '';
          if (v.length > 600) continue;
          for (const m of v.matchAll(OTHER_POST)) if (`${m[1]}_${m[2]}` !== key) return true;
          if (/post|copy/i.test(name)) for (const m of v.matchAll(/(?<![0-9-])(-?\d{1,12})_(\d{1,12})(?![0-9])/g)) if (`${m[1]}_${m[2]}` !== key) return true;
        }
        if (p === root) break;
      }
      return false;
    }

    // the list of the click that is being prepared (one synchronous pass): every item is snapshotted against the same enumeration
    let session = null;
    // [{ el, kind: 'photo'|'video'|'tile', id }] in document order, or null when the list cannot be proven
    const enumerate = (root, key) => (session && session.root === root && session.key === key ? session.items : scan(root, key));
    let why = { code: '', n: 0 };
    const refuse = (code, n = 0) => { why = { code, n }; return null; };
    function scan(root, key) {
      if (!root || typeof root.querySelectorAll !== 'function') return refuse('NO_ROOT');
      const anchors = Array.from(root.querySelectorAll('a[href]'));
      if (anchors.length > VK.ANCHORS) return refuse('TOO_MANY_LINKS', anchors.length);
      const items = [], seen = new Set(), claimed = new Set();
      for (const a of anchors) {
        const r = routeOf(a);
        const media = r ? Array.from(a.querySelectorAll('img, video')) : [];
        if (!r || !media.length || otherPost(a, root, key) || inComment(a, root, key)) continue; // a text link is no attachment; a nested post's or a comment's media is not this post's
        if (/(?:^|\s)\+\d{1,3}(?:\s|$)/.test(a.textContent || '')) return refuse('OVERFLOW_TILE'); // a "+N" tile hides more attachments
        const videos = media.filter((m) => m.tagName === 'VIDEO'), imgs = media.filter((m) => m.tagName === 'IMG');
        let el = null, kind = 'photo';
        if (r.kind === 'photo') {
          if (videos.length || imgs.length !== 1 || !photoOk(imgs[0])) return refuse('PHOTO_TILE', items.length);
          el = imgs[0];
        } else {
          el = videos.length === 1 ? videos[0] : (!videos.length && imgs.length === 1 ? imgs[0] : null);
          if (!el) return refuse('TILE_STRUCTURE', items.length);
          kind = el.tagName === 'VIDEO' && directVideo(el) ? 'video' : 'tile';
        }
        if (seen.has(r.id)) return refuse('DUPLICATE', items.length); // the same attachment twice: the structure is not understood
        seen.add(r.id);
        for (const m of media) claimed.add(m);
        items.push({ el, kind, id: r.id, link: a });
      }
      for (const m of root.querySelectorAll('img, video')) { // media that no attachment link claims: unknown structure, never a guess
        if (claimed.has(m) || otherPost(m, root, key) || inComment(m, root, key)) continue;
        if (m.tagName === 'VIDEO' || photoOk(m)) return refuse('UNCLAIMED_MEDIA', items.length);
      }
      if (items.length > VK.BATCH_MAX) return refuse('OVER_CAP', items.length);
      // Rendered tiles are not a complete list. Accept only one explicitly declared accessible list with every position.
      // These semantics are standards-derived, not observed VK markup; absent evidence keeps Save this only.
      let list = null;
      for (let i = 0; i < items.length; i++) {
        const item = items[i].link.closest('[role="listitem"]');
        const owner = item && item.parentElement && item.parentElement.closest('[role="list"]');
        const pos = item && item.getAttribute('aria-posinset'), size = item && item.getAttribute('aria-setsize');
        if (!owner || !root.contains(owner) || (list && owner !== list) || !/^[1-9]\d{0,2}$/.test(pos || '') || !/^[1-9]\d{0,2}$/.test(size || '') ||
            Number(pos) !== i + 1 || Number(size) !== items.length) return refuse('UNPROVEN_LIST', items.length);
        list = owner;
      }
      return items;
    }

    // ---- identity ----
    // { elRef, anchorRef, kind, src, route, key, ownerRef, href, count }; `counted` false builds only the identity (the cheap part)
    function snapshot(el, kind, counted = true) {
      try {
        if (!el || typeof el.getBoundingClientRect !== 'function') return null;
        const anchor = anchorOf(el), route = anchor ? routeOf(anchor) : null;
        if (kind === 'photo') { if (el.tagName !== 'IMG' || !photoOk(el) || (route && route.kind !== 'photo')) return null; }
        else if (kind === 'video') { if (el.tagName !== 'VIDEO' || !directVideo(el)) return null; }
        else if (kind === 'tile') { if (!route || route.kind === 'photo' || (el.tagName !== 'IMG' && el.tagName !== 'VIDEO')) return null; } // only a list asks for a tile
        else return null;
        const key = pageKey(), found = key ? rootOf(el, key) : null, root = found && !otherPost(el, found, key) && !inComment(el, found, key) ? found : null;
        const snap = { elRef: new WeakRef(el), anchorRef: anchor ? new WeakRef(anchor) : null, kind, src: String(el.currentSrc || el.src || ''), route: route ? route.id : '', key: root ? key : '', ownerRef: root ? new WeakRef(root) : NO_OWNER, href: location.href, count: 0 };
        if (counted && key && !root) listNote(el, 'NO_ROOT', 0);
        if (counted && root && kind !== 'tile') {
          const items = enumerate(root, key);
          if (!items) listNote(el, why.code || 'NO_LIST', why.n);
          snap.count = items && items.length >= 2 && items.some((i) => i.el === el) ? items.length : 0;
        }
        return snap;
      } catch (_) { return null; }
    }
    function same(a, b) {
      return Boolean(a && b) && a.elRef.deref() === b.elRef.deref() && (a.anchorRef ? a.anchorRef.deref() : null) === (b.anchorRef ? b.anchorRef.deref() : null) && a.kind === b.kind && a.src === b.src &&
        a.route === b.route && a.key === b.key && a.ownerRef.deref() === b.ownerRef.deref() && a.href === b.href;
    }
    function holds(snap) {
      try {
        const el = snap.elRef.deref();
        if (!el || el.isConnected === false || (snap.ownerRef.deref() && snap.ownerRef.deref().isConnected === false)) return false;
        return same(snap, snapshot(el, snap.kind, false));
      } catch (_) { return false; }
    }

    function visibleOf(el) {
      try {
        const r = el.getBoundingClientRect();
        let left = Math.max(r.left, 0), top = Math.max(r.top, 0), right = Math.min(r.right, window.innerWidth), bottom = Math.min(r.bottom, window.innerHeight), clip = null, reached = false;
        for (let p = el, n = 0; p && n < VK.DEPTH; p = p.parentElement, n++) {
          const cs = window.getComputedStyle(p);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') return null;
          if (p !== el) {
            const x = /^(?:hidden|clip|auto|scroll|overlay)$/.test(cs.overflow) || /^(?:hidden|clip|auto|scroll|overlay)$/.test(cs.overflowX);
            const y = /^(?:hidden|clip|auto|scroll|overlay)$/.test(cs.overflow) || /^(?:hidden|clip|auto|scroll|overlay)$/.test(cs.overflowY);
            if (x || y) {
              const box = p.getBoundingClientRect(); clip ||= p;
              if (x) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
              if (y) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
            }
          }
          if (p === document.body || p === document.documentElement) { reached = true; break; }
        }
        return reached && right > left && bottom > top ? { left, top, right, bottom, clip } : null;
      } catch (_) { return null; }
    }

    // Keep the control at the visible upper-left corner, below a full-width fixed/sticky site header.
    function placeOf(el, w, h, scope) {
      try {
        const visible = visibleOf(el);
        if (!visible) return null;
        const L = visible.left, R = visible.right, B = visible.bottom;
        let T = visible.top;
        if (typeof document.elementFromPoint === 'function') {
          for (let n = 0; n < VK.MAX_STACK && T < B; n++) {
            let below = T;
            for (const x of [L + VK.CORNER, R - VK.CORNER]) {
              let hit = document.elementFromPoint(x, T + VK.CORNER);
              if (hit?.closest(MODAL) && !hit.closest(MODAL).contains(el)) return null;
              if (ctl.own(hit) || hit === el || hit?.contains(el)) continue;
              for (let depth = 0; hit && depth < VK.DEPTH; depth++, hit = hit.parentElement) {
                if (hit.contains(el)) break;
                const pos = window.getComputedStyle(hit).position, box = hit.getBoundingClientRect();
                if ((pos === 'fixed' || pos === 'sticky') && box.left <= L && box.right >= R && box.top <= T && box.bottom > T) {
                  below = Math.max(below, box.bottom); break;
                }
              }
            }
            if (below === T) break;
            T = below;
          }
        }
        if (!(R - L >= Math.max(VK.MIN_W, w + 2 * VK.INSET)) || !(B - T >= Math.max(VK.MIN_H, h + 2 * VK.INSET))) return null;
        const left = L + VK.INSET, y = T + VK.INSET;
        if (typeof document.elementFromPoint === 'function') {
          const c = VK.CORNER, card = scope || anchorOf(el) || visible.clip || el.parentElement;
          for (const [px, py] of [[L + c, T + c], [R - c, T + c], [R - c, B - c], [left + c, y + c], [left + w - c, y + h - c], [left + c, y + h - c]]) {
            const t = document.elementFromPoint(px, py);
            if (!t || (t.closest(MODAL) && !t.closest(MODAL).contains(el))) return null;
            if (ctl.own(t) || t === el || (card && typeof card.contains === 'function' && card.contains(t))) continue;
            return null;
          }
        }
        return { vis: { left: L, top: T, right: R, bottom: B }, left: Math.round(left), top: Math.round(y), w, h, sig: [L, T, R, B, w, h].map(Math.round).join(',') };
      } catch (_) { return null; }
    }
    function shownAt() {
      const h = ctl.st.host;
      if (!h || h.isConnected === false || typeof h.getBoundingClientRect !== 'function') return null;
      const r = h.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    function atPlace(el, snap, shown) {
      const lay = shown && el ? placeOf(el, shown.w, shown.h, snap.ownerRef.deref()) : null;
      return Boolean(lay) && Math.abs(lay.left - shown.left) <= VK.TOL && Math.abs(lay.top - shown.top) <= VK.TOL;
    }
    function plan(el, snap) {
      const scope = snap.ownerRef.deref();
      if (snap.count >= 2) {
        const wide = placeOf(el, VK.MULTI_W, VK.MULTI_H, scope);
        if (wide) return { n: snap.count, compact: false, lay: wide };
        const compact = placeOf(el, VK.COMPACT_W, VK.COMPACT_H, scope);
        return compact ? { n: snap.count, compact: true, lay: compact } : null;
      }
      const lay = placeOf(el, VK.SIZE, VK.SIZE, scope);
      return lay ? { n: 0, compact: false, lay } : null;
    }

    // ---- descriptors and proofs ----
    // What the worker gets for one item. A tile whose source is not a declared direct file is refused as an unsupported source: its poster is never a substitute.
    function describe(snap, bind) {
      if (snap.kind === 'tile') return { ok: false, reason: 'UNSUPPORTED_SOURCE' };
      const media = { kind: snap.kind, url: snap.src, id: snap.route };
      return { ok: true, media: bind ? { ...media, ...bind } : media };
    }
    // The background asks this document to prove the snapshot a second time, for the very action the token was minted for. One shot, whatever the answer.
    function answerOwner(token) {
      const entry = typeof token === 'string' ? ctl.pending.get(token) : null;
      ctl.pending.delete(token);
      if (!entry || Date.now() - entry.at > VK.TOKEN_TTL) return { ok: false, reason: 'NO_TOKEN' };
      if (location.href !== entry.href || !holds(entry.snap)) return { ok: false, reason: 'STALE_OWNER' };
      const s = entry.snap;
      if (!atPlace(s.elRef.deref(), s, entry.place)) return { ok: false, reason: 'STALE_OWNER' }; // the media moved between the click and the proof
      return describe(s);
    }
    // Phase 1 of a batch: the page, the owner and the whole list are proven again and every item's descriptor is frozen (its exact source, its attachment id, its place in the list).
    function admit(entry) {
      const root = entry.items[0].snap.ownerRef.deref();
      if (!root || root.isConnected === false || here() !== entry.href || pageKey() !== entry.ownerId) return 'STALE_OWNER';
      if (!entry.items.every((it) => holds(it.snap))) return 'STALE_ITEM';
      const now = enumerate(root, entry.ownerId);
      if (!now || now.length !== entry.items.length || !now.every((it, i) => it.el === entry.items[i].snap.elRef.deref())) return 'STALE_ITEM';
      entry.frozen = entry.items.map((it, index) => describe(it.snap, { ownerId: entry.ownerId, index, count: entry.count, sig: entry.sig }));
      return null;
    }

    function candidate(stack) {
      const top = stack.slice(0, VK.MAX_STACK), first = top.find(el => el && !ctl.own(el));
      const modal = first && typeof first.closest === 'function' ? first.closest(MODAL) : null;
      for (const el of top) {
        if (modal && (el?.tagName === 'IMG' || el?.tagName === 'VIDEO') && !modal.contains(el)) return null;
        if (!el || ctl.own(el)) continue;
        if (el.tagName === 'IMG' && top.some((v) => v && v.tagName === 'VIDEO')) return null; // an image overlay does not prove the player underneath is its own media
        if (el.tagName === 'VIDEO') {
          const v = el;
          if (!directVideo(v)) { const u = urlOf(v.currentSrc || v.src || ''); note(v, 'VIDEO_TRANSPORT', !u ? 'blob' : (!VIDEO_HOST.test(u.hostname) ? 'host' : (FILE.test(u.pathname) ? 'other' : 'manifest'))); return null; }
          return { el: v, kind: 'video' };
        }
        if (el.tagName === 'IMG') return photoOk(el) && !(routeOf(anchorOf(el)) && routeOf(anchorOf(el)).kind !== 'photo') ? { el, kind: 'photo' } : null; // the topmost image decides; a poster is not a photo
      }
      // A carousel image may use pointer-events:none. Recover only within the top hit's local post layers.
      if (!first || first === document.body || first === document.documentElement || typeof first.closest !== 'function' ||
          first.closest('button, input, select, textarea, [role="button"]')) return null;
      let boundary = null;
      for (let p = first, n = 0; p && p !== document.body && n < VK.DEPTH; p = p.parentElement, n++) {
        if (postIdentity(p)) { boundary = p; break; }
      }
      for (let node = first, n = 0; node && node !== boundary && node !== document.body && node !== document.documentElement && n < VK.DEPTH; node = node.parentElement, n++) {
        const el = mediaWithin(node, { x: ctl.st.x, y: ctl.st.y });
        if (el) return el.tagName === 'IMG' && photoOk(el) && !(routeOf(anchorOf(el)) && routeOf(anchorOf(el)).kind !== 'photo') ? { el, kind: 'photo' } : null;
        if (!boundary || node.matches(MODAL)) break;
      }
      return null;
    }
    function mediaWithin(node, point = null) {
      if (!node || typeof node.querySelectorAll !== 'function') return null;
      if (node.tagName === 'IMG' || node.tagName === 'VIDEO') return node;
      const found = [], walker = document.createTreeWalker(node, 1);
      for (let el, n = 0; (el = walker.nextNode());) {
        if (++n > VK.ANCHORS) return null;
        if (el.tagName !== 'IMG' && el.tagName !== 'VIDEO') continue;
        const box = visibleOf(el);
        if (!box || (point && !(point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom))) continue;
        found.push(el);
        if (found.length > 1) return null;
      }
      return found.length === 1 ? found[0] : null;
    }

    const ctl = createControl((c) => ({
      name: 'vk', K: VK, fixed: true, align: 'flex-start', modes: ['one', 'all'], hideOn: ['popstate'], rearmOn: [], followOn: ['scroll', 'resize'],
      candidate, snapshot, holds, plan, admit,
      heldPlan: (el, snap) => { const s = c.size(), lay = placeOf(el, s.w, s.h, snap.ownerRef.deref()); return lay ? { n: c.st.count, compact: c.st.compact, lay } : null; },
      stale: (p, snap) => p.n !== snap.count,
      watch(observer, el, snap) {
        // the shown media, its link, its parent and the post: a source that changes, a link that changes, the media removed or replaced, an attachment added or removed
        observer.observe(el, { attributes: true, attributeFilter: ['src', 'srcset', 'poster', 'style', 'class'] });
        if (el.parentNode) observer.observe(el.parentNode, { childList: true });
        const a = snap.anchorRef && snap.anchorRef.deref();
        if (a) observer.observe(a, { attributes: true, attributeFilter: ['href'] });
        const root = snap.ownerRef.deref();
        for (let p = el.parentElement, n = 0; p && p !== document.body && n < VK.DEPTH; p = p.parentElement, n++) {
          observer.observe(p, { attributes: true, attributeFilter: ['style', 'class', 'hidden'], childList: true });
          if (p === root) break;
        }
        if (root) observer.observe(root, { childList: true, subtree: true });
      },
      focusTarget(t) {
        if (typeof t.closest !== 'function') return null;
        const el = mediaWithin(t.tagName === 'A' ? t : (anchorOf(t) || t));
        const kind = el && (el.tagName === 'VIDEO' ? 'video' : 'photo');
        return kind && (kind === 'video' ? directVideo(el) : photoOk(el)) ? { el, kind } : null;
      },
      showDetail: (el, snap, p) => ({ kind: snap.kind, count: p.n, compact: Boolean(p.compact) }),
      prepare(which, shown, cid) {
        const el = shown && shown.elRef.deref(), root = shown && shown.ownerRef.deref(), fresh = el ? snapshot(el, shown.kind) : null, at = shownAt();
        const base = !shown ? 'NO_CONTROL' : !el ? 'TARGET_GONE' : !fresh ? 'NO_SNAPSHOT' : (which === 'all' && (!root || c.st.count < 2 || fresh.count !== c.st.count)) ? 'NOT_A_BATCH'
          : !same(fresh, shown) ? 'TARGET_CHANGED' : !atPlace(el, fresh, at) ? 'LAYOUT_LOST' : '';
        if (base) return { gate: base, detail: { which } };
        if (which === 'one') {
          return { key: `one|${fresh.src}`, store: 'pending', entry: { snap: fresh, href: location.href, cid, place: at }, action: 'VK_INLINE_SAVE', start: () => ({ which, kind: fresh.kind }) };
        }
        // "Save all (N)": only on this explicit click. A fresh enumeration must equal what the control showed; every item gets its own snapshot; the background proves each again before it runs.
        const items = scan(root, fresh.key);
        if (!items || items.length !== c.st.count || !items.some((i) => i.el === el)) return { gate: 'LIST_CHANGED', detail: { which, count: items ? items.length : 0, n: c.st.count } };
        session = { root, key: fresh.key, items };
        let all;
        try { all = c.snapshotAll(items.map((i) => ({ el: i.el, kind: i.kind })), root); } finally { session = null; }
        if (!all.snaps) return { gate: 'ITEM_NOT_OWNED', detail: { which, index: all.index } };
        const sig = hashOf(all.snaps.map((s) => `${s.kind}:${s.route}:${s.src}`).join('|'));
        return { key: `all|${fresh.key}|${sig}`, store: 'batches', action: 'VK_INLINE_SAVE_ALL',
          entry: { items: all.snaps.map((snap) => ({ snap, used: false })), href: location.href, opened: false, sig, ownerId: fresh.key, count: all.snaps.length, cid },
          start: () => ({ which, count: all.snaps.length }) };
      },
      proof: {
        VK_INLINE_OWNER: { phase: 'proof', run: (m) => answerOwner(m.token), detail: (m, a) => ({ kind: a && a.media && a.media.kind }) },
        VK_INLINE_BATCH: { phase: 'batch.proof', run: (m) => c.batchOpen(m.token), detail: (m, a) => ({ count: a && a.count }) },
        VK_INLINE_OWNER_ITEM: { phase: 'item.proof', run: (m) => c.batchItem(m.token, m.index), detail: (m, a) => ({ index: Number.isInteger(m.index) ? m.index : undefined, kind: a && a.media && a.media.kind }) }
      }
    }));
    return ctl;
  }

  // ---- X (https://x.com/*, https://twitter.com/*): the media of a post ----
  // One control (a closed shadow root in one host element) attached INSIDE the selected media's own tile: a local absolute child of the nearest positioned ancestor that is not above
  // the nearest clipping ancestor, so the browser clips it with the tile and moves it with the slide. Its place comes from the visible part of the media (clipped by every clipping
  // ancestor, the owning post and the viewport), never from a raw image or carousel-track rectangle; when no such container can be proven it is hidden. "Save this" is always there,
  // "Save all (N)" only for a post with several owned media. The worker's descriptor is built with the context-menu builder (findMedia) for the element the snapshot proves.
  function xHandler(x) {
    const XI = { ...K, Z: 1, CHAIN: 14, DEPTH: 40, ENUM_NODES: 400 };
    const { ownerOf, imageKind, idOf, snapshot, holds, promoted, findMedia } = x;
    const kindOf = (el) => (el.tagName === 'VIDEO' ? 'video' : imageKind(el.currentSrc || el.src));

    function same(a, b) {
      return a.elRef.deref() === b.elRef.deref() && a.ownerRef.deref() === b.ownerRef.deref() && a.articleRef.deref() === b.articleRef.deref() &&
        a.isQuote === b.isQuote && a.id === b.id && a.tag === b.tag && a.src === b.src && a.kind === b.kind && sameChain(a, b);
    }

    // pointer-events:none media is absent from the hit stack; its local layer must contain exactly one media at this point.
    function mediaWithin(node, point = null) {
      if (!node) return null;
      if (node.tagName === 'VIDEO' || node.tagName === 'IMG') return node;
      if (typeof node.querySelectorAll !== 'function') return null;
      const nodes = Array.from(node.querySelectorAll('video, img'));
      if (point && nodes.length > XI.ENUM_NODES) return null;
      const list = point ? nodes.filter((m) => {
        if (typeof m.getBoundingClientRect !== 'function') return false;
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
      }) : nodes.filter((m) => m.tagName === 'VIDEO' || imageKind(m.currentSrc || m.src));
      return list.length === 1 && kindOf(list[0]) ? list[0] : null;
    }

    function candidate(stack) {
      const top = stack.slice(0, XI.MAX_STACK);
      for (const el of top) {
        if (!el || ctl.own(el)) continue;
        if (el.tagName === 'VIDEO') return { el, kind: 'video' };
        if (el.tagName === 'IMG') {
          const kind = imageKind(el.currentSrc || el.src);
          if (!kind) return null; // the topmost image is an avatar, emoji or card: no button for the media behind it
          if (kind === 'photo') return { el, kind };
          // a poster over its own player: the player is the selected media
          const player = top.find((v) => v && v.tagName === 'VIDEO' && ownerOf(v) && ownerOf(v).owner === (ownerOf(el) || {}).owner);
          return player ? { el: player, kind: 'video' } : { el, kind };
        }
      }
      for (const node of top) {
        if (!node || node === document.body || node === document.documentElement || ctl.own(node)) continue;
        if (typeof node.closest !== 'function' || !node.closest('article')) return null;
        const el = mediaWithin(node, { x: ctl.st.x, y: ctl.st.y });
        if (el) return { el, kind: kindOf(el) };
      }
      return null;
    }

    // ---- placement: the visible part of the selected media and a container that clips and moves the control with it ----
    // { vis, host, left, top, sig } or null when no safe place can be proven. `w`/`h` are the control's size.
    function layout(el, owner, w, h, compact = false) {
      try {
        if (!el || !owner || typeof el.getBoundingClientRect !== 'function' || typeof window.getComputedStyle !== 'function') return null;
        const r = el.getBoundingClientRect();
        let L = r.left, T = r.top, Rt = r.right, B = r.bottom;
        const clip = (b) => { L = Math.max(L, b.left); T = Math.max(T, b.top); Rt = Math.min(Rt, b.right); B = Math.min(B, b.bottom); };
        let container = null, containerAt = -1, clipAt = -1, reached = false;
        let depth = 0;
        for (let p = el.parentElement; p && depth < XI.DEPTH; p = p.parentElement, depth++) {
          const cs = window.getComputedStyle(p);
          if (!cs) return null;
          if (p !== owner && clipsOf(cs)) {
            clip(p.getBoundingClientRect());
            if (clipAt < 0) clipAt = depth;
          }
          if (containerAt < 0 && cs.position && cs.position !== 'static') { container = p; containerAt = depth; }
          if (p === owner) { reached = true; break; }
        }
        // A control inside a positioned ancestor is clipped by that ancestor and everything above it; a clipping ancestor below
        // the container would not clip it, so the nearest clipping ancestor must be the container itself or above it.
        if (!reached || !container || (clipAt >= 0 && containerAt > clipAt)) return null;
        const carouselLeft = L, carouselRight = Rt;
        clip(owner.getBoundingClientRect());
        const vw = (typeof window.innerWidth === 'number' && window.innerWidth) || 0;
        const vh = (typeof window.innerHeight === 'number' && window.innerHeight) || 0;
        clip({ left: 0, top: 0, right: vw || Rt, bottom: vh || B });
        if (!(Rt - L >= Math.max(XI.MIN_W, w + 2 * XI.INSET)) || !(B - T >= Math.max(XI.MIN_H, h + 2 * XI.INSET))) return null;
        // A carousel may expose only part of neighbouring media: keep the icon pair inside that visible part.
        // Vertical clipping and clipping by the post or viewport still hide the control; only ancestor-clipped supported media qualifies.
        if (T - r.top > XI.TOL || r.bottom - B > XI.TOL) return null;
        if ((L - r.left > XI.TOL || r.right - Rt > XI.TOL) &&
            (!compact || !kindOf(el) || clipAt < 0 || L - carouselLeft > XI.TOL || carouselRight - Rt > XI.TOL)) return null;
        if (covered(owner, { left: L, top: T, right: Rt, bottom: B },
          { left: Rt - XI.INSET - w, top: T + XI.INSET, right: Rt - XI.INSET, bottom: T + XI.INSET + h })) return null;
        const cr = container.getBoundingClientRect();
        // a scaled or rotated container: local pixels no longer equal viewport pixels
        if (typeof container.offsetWidth === 'number' && container.offsetWidth > 0 && Math.abs(cr.width - container.offsetWidth) > 2) return null;
        const left = Math.round(Rt - XI.INSET - w - cr.left - (container.clientLeft || 0) + (container.scrollLeft || 0));
        const top = Math.round(T + XI.INSET - cr.top - (container.clientTop || 0) + (container.scrollTop || 0));
        return { vis: { left: L, top: T, right: Rt, bottom: B }, host: container, left, top, w, h, sig: [L, T, Rt, B, cr.left, cr.top, w, h].map(Math.round).join(',') };
      } catch (_) {
        return null;
      }
    }

    // Rounded media corners may hit the enclosing card backdrop; accepting it also requires owned control-area hits.
    function covered(owner, vis, control) {
      if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return false;
      const d = XI.CORNER;
      let backdrop = false;
      for (const box of [vis, control]) {
        if (box === control && !backdrop) break;
        for (const [px, py] of [[box.left + d, box.top + d], [box.right - d, box.top + d], [box.left + d, box.bottom - d], [box.right - d, box.bottom - d]]) {
          const t = document.elementFromPoint(px, py);
          if (!t) return true;
          if (ctl.own(t) || (typeof owner.contains === 'function' && owner.contains(t))) continue;
          if (box !== vis || typeof t.contains !== 'function' || !t.contains(owner)) return true;
          backdrop = true;
        }
      }
      return false;
    }

    // ---- the media a post owns (for the explicit "Save all"): its own photos, videos and GIFs, nothing nested or around it ----
    // The identity of a media slot from X's own thumbnail/media paths, used only to count a player and its poster once.
    function slotKey(el) {
      const srcs = el.tagName === 'VIDEO'
        ? [(el.getAttribute && el.getAttribute('poster')) || el.poster || '', el.currentSrc || el.src || '']
        : [el.currentSrc || el.src || ''];
      for (const s of srcs) {
        let m;
        if (/^https:\/\/pbs\.twimg\.com\//.test(s) && (m = /\/media\/([^/?#.]+)/.exec(s))) return `p:${m[1]}`;
        if ((m = /\/tweet_video(?:_thumb)?\/([^/?#.]+)/.exec(s))) return `g:${m[1]}`;
        if ((m = /\/(?:ext_tw_video|amplify_video)(?:_thumb)?\/(\d+)/.exec(s))) return `v:${m[1]}`;
      }
      return null;
    }

    // [{ el, kind }] in document order: only elements whose own container is this owner (media of a nested quote or article, avatars,
    // emoji, link cards, hidden or zero-size elements and a poster that belongs to a player in the same slot are not counted).
    function enumerate(owner) {
      if (!owner || typeof owner.querySelectorAll !== 'function') return [];
      const out = [];
      const seen = new Map();
      const nodes = Array.from(owner.querySelectorAll('video, img'));
      if (nodes.length > XI.ENUM_NODES) return [];
      for (const el of nodes) {
        const o = ownerOf(el);
        if (!o || o.owner !== owner || typeof el.getBoundingClientRect !== 'function') continue;
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        let kind = 'video';
        if (el.tagName !== 'VIDEO') {
          kind = imageKind(el.currentSrc || el.src);
          if (!kind) continue;
          if (kind !== 'photo') {
            const slot = el.parentElement && el.parentElement.parentElement;
            if (slot && slot !== owner && typeof slot.querySelector === 'function' && slot.querySelector('video')) continue;
          }
        }
        const key = slotKey(el);
        if (key && seen.has(key)) {
          const at = seen.get(key);
          if (out[at].el.tagName !== 'VIDEO' && el.tagName === 'VIDEO') out[at] = { el, kind };
          continue;
        }
        if (key) seen.set(key, out.length);
        out.push({ el, kind });
      }
      return out;
    }

    // N when the hovered media belongs to a post with several owned media (2..BATCH_MAX), otherwise 0 (a one-item post: no "all").
    function countFor(owner, el) {
      const items = enumerate(owner);
      return items.length >= 2 && items.length <= XI.BATCH_MAX && items.some((i) => i.el === el) ? items.length : 0;
    }

    // The control this media gets and the place for it. A post with several owned media always keeps both explicit actions: the labelled pair when the tile can hold it, else two
    // icon-only buttons (the count on the second) that fit any tile the single button would fit; if not even that fits, nothing is shown (never a single action that hides Save all).
    function plan(el, snap) {
      const owner = snap.ownerRef.deref();
      const n = countFor(owner, el);
      if (n >= 2) {
        const wide = layout(el, owner, XI.MULTI_W, XI.MULTI_H);
        if (wide) return { n, compact: false, lay: wide };
        const compact = layout(el, owner, XI.COMPACT_W, XI.COMPACT_H, true);
        return compact ? { n, compact: true, lay: compact } : null;
      }
      const lay = layout(el, owner, XI.SIZE, XI.SIZE);
      return lay ? { n: 0, compact: false, lay } : null;
    }

    function heldPlan(el, snap) {
      const s = ctl.size();
      const lay = layout(el, snap.ownerRef.deref(), s.w, s.h, ctl.st.compact);
      return lay ? { n: ctl.st.count, compact: ctl.st.compact, lay } : null;
    }

    // One item's descriptor, built with the context-menu builder for the element the snapshot proves.
    function describe(snap) {
      const el = snap.elRef.deref();
      const media = el ? findMedia([el], null) : null;
      if (!media) return { ok: false, reason: 'NO_MEDIA' };
      const expected = snap.kind === 'photo' ? ['image'] : snap.kind === 'gif-poster' ? ['x_tweet_video'] : snap.kind === 'video-poster' ? ['video'] : ['video', 'x_tweet_video'];
      if (!expected.includes(media.type)) return { ok: false, reason: 'KIND_MISMATCH' };
      if (typeof media.x === 'number' || media.isBlobPlayer === true) {
        // a player's recovery looks the post up by point: this element's own centre, never the context-menu cursor (also when no menu was ever opened)
        const r = el.getBoundingClientRect();
        media.x = Math.round(r.left + r.width / 2);
        media.y = Math.round(r.top + r.height / 2);
      }
      return { ok: true, media };
    }

    // The background asks this document to prove the snapshot a second time and to build the descriptor with the context-menu builder.
    function answerOwner(token) {
      const entry = typeof token === 'string' ? ctl.pending.get(token) : null;
      ctl.pending.delete(token);
      if (!entry || Date.now() - entry.at > XI.TOKEN_TTL) return { ok: false, reason: 'NO_TOKEN' };
      if (!holds(entry.snap)) return { ok: false, reason: 'STALE_OWNER' };
      return describe(entry.snap);
    }

    // The post itself (not the item) still is the one the batch was started for: connected, same permalink, not promoted, same page.
    function ownerHolds(snap, entry) {
      try {
        const owner = snap.ownerRef.deref();
        const article = snap.articleRef.deref();
        return Boolean(owner && article && owner.isConnected !== false && article.isConnected !== false && here() === entry.href && idOf(owner, snap.isQuote) === snap.id && !promoted(article));
      } catch (_) {
        return false;
      }
    }

    // Phase 1 of a batch: every item and the owner's list of media are proven again before any privileged work starts. This is the batch's admission: each slot's descriptor is
    // frozen here (its exact source addresses and post/media identity), so later scrolling, unloading or recycling of the post cannot change, add or drop a slot. A player's page
    // point is dropped: a later recovery finds its post by id, never at a position that scrolling has since given to another post.
    function admit(entry) {
      if (!entry.items.every((it) => ownerHolds(it.snap, entry))) return 'STALE_OWNER';
      if (!entry.items.every((it) => holds(it.snap))) return 'STALE_ITEM';
      const owner = entry.items[0].snap.ownerRef.deref();
      const now = enumerate(owner);
      if (now.length !== entry.items.length || !now.every((it, i) => it.el === entry.items[i].snap.elRef.deref())) return 'STALE_ITEM';
      entry.frozen = entry.items.map((it) => {
        const d = describe(it.snap);
        if (d.ok) { d.media.x = null; d.media.y = null; }
        return d;
      });
      return null;
    }

    const proofDetail = (m, a) => ({
      index: Number.isInteger(m.index) ? m.index : undefined, count: a && a.count, type: a && a.media && a.media.type, host: a && a.media && a.media.url,
      isQuote: Boolean(a && a.media && a.media.isQuoteTweet), postId: a && a.media ? (a.media.tweetId || undefined) : (a && a.ownerId)
    });

    const ctl = createControl((c) => ({
      name: 'x', K: XI, align: 'flex-end', hideOn: ['scroll', 'wheel', 'resize', 'popstate'], rearmOn: [],
      candidate, snapshot, holds, plan, heldPlan, admit,
      watch: watchOwner,
      focusTarget(t) {
        // a focus anywhere outside a post costs one closest() call, never a subtree query
        if (typeof t.closest !== 'function' || !(t.closest(x.post) || t.closest('article'))) return null;
        const el = mediaWithin(t);
        const kind = el && kindOf(el);
        return kind ? { el, kind } : null;
      },
      showDetail: (el, snap, p) => ({ kind: snap.kind, count: p.n, compact: Boolean(p.compact), isQuote: Boolean(snap.isQuote), postId: snap.id || undefined }),
      prepare(which, shown, cid) {
        const st = c.st;
        const el = shown && shown.elRef.deref();
        const owner = shown && shown.ownerRef.deref();
        const s = c.size();
        // A fresh snapshot of the very element the button belongs to, equal to what the hover showed, still in a provable place.
        // (the journal names the first gate that refused, in the guard's own order and short-circuit)
        const fresh = el ? snapshot(el, shown.kind) : null;
        if (which === 'this') {
          const gate = !shown ? 'NO_CONTROL' : !el ? 'TARGET_GONE' : !fresh ? 'NO_SNAPSHOT' : !same(fresh, shown) ? 'TARGET_CHANGED' : !holds(shown) ? 'OWNER_NOT_HELD'
            : !layout(el, fresh.ownerRef.deref(), s.w, s.h, st.compact) ? 'LAYOUT_LOST' : '';
          if (gate) return { gate, detail: () => ({ which, kind: shown && shown.kind, isQuote: Boolean(shown && shown.isQuote) }) };
          return { key: `${fresh.id}|${fresh.src}`, store: 'pending', entry: { snap: fresh, cid }, action: 'X_INLINE_SAVE',
            start: () => ({ which, kind: fresh.kind, isQuote: Boolean(fresh.isQuote), postId: fresh.id || undefined }) };
        }
        // "Save all (N)": only on this explicit click. A fresh enumeration must equal what the control showed; every item gets its own fresh snapshot; the background then asks
        // for each item's proof again just before that item is saved.
        const gate = !fresh ? (!shown ? 'NO_CONTROL' : (!el ? 'TARGET_GONE' : 'NO_SNAPSHOT')) : !owner ? 'OWNER_GONE' : st.count < 2 ? 'NOT_A_BATCH'
          : !same(fresh, shown) ? 'TARGET_CHANGED' : !holds(shown) ? 'OWNER_NOT_HELD' : !layout(el, owner, s.w, s.h, st.compact) ? 'LAYOUT_LOST' : '';
        if (gate) return { gate, detail: { which, count: st.count } };
        const items = enumerate(owner);
        if (items.length !== st.count || items.length > XI.BATCH_MAX || !items.some((i) => i.el === el)) return { gate: 'LIST_CHANGED', detail: { which, count: items.length, n: st.count } };
        const all = c.snapshotAll(items, owner);
        if (!all.snaps) return { gate: 'ITEM_NOT_OWNED', detail: { which, index: all.index } };
        const sig = hashOf(all.snaps.map((v) => `${v.kind}:${v.src}`).join('|'));
        return { key: `all|${fresh.id}|${sig}`, store: 'batches', action: 'X_INLINE_SAVE_ALL',
          entry: { items: all.snaps.map((snap) => ({ snap, used: false })), href: here(), opened: false, sig, ownerId: fresh.id, count: all.snaps.length, cid },
          start: () => ({ which, count: all.snaps.length, postId: fresh.id || undefined }) };
      },
      proof: {
        X_INLINE_OWNER: { phase: 'proof', run: (m) => answerOwner(m.token), detail: proofDetail },
        X_INLINE_BATCH: { phase: 'batch.proof', run: (m) => c.batchOpen(m.token), detail: proofDetail },
        X_INLINE_OWNER_ITEM: { phase: 'item.proof', run: (m) => c.batchItem(m.token, m.index), detail: proofDetail }
      }
    }));
    return ctl;
  }

  // ---- Reddit (https://*.reddit.com/*): the media of a post ("Save all (N)" only for a post with a complete proven gallery) ----
  // The owner rules (which container owns a node, its post id, a RedGIFs embed) stay in content_reddit.js: the context menu uses them too.
  function redditHandler(r) {
    const RI = { ...K, Z: 10, CHAIN: 14, DEPTH: 40, ENUM_NODES: 400, SLIDE_NODES: 12, BATCH_MIN: 2, EVIDENCE_CONTAINERS: 8, EVIDENCE_PAGERS: 4 };
    const { ownerOf, idOf, authored, attr, embed, isAnimationUrl, isNativeGifUrl, isPreviewVideo, firstMainVideo, declaredStreamOf, playerCandidate, blobFallback } = r;
    const embedHost = embed.host, embedFrame = embed.frame, embedSrc = embed.src, embedOf = embed.of;

    function imageKind(url) {
      if (!url || typeof url !== 'string') return null;
      try {
        const u = new URL(url, 'https://www.reddit.com');
        const path = u.pathname.toLowerCase();
        const host = u.hostname.toLowerCase();

        // Explicitly reject non-content images: avatars, community icons, emojis, badges, awards
        if (path.includes('/avatar/') || path.includes('/avatars/') || path.includes('/styles/profileicon') || path.includes('/profileicon')) return null;
        if (path.includes('/styles/communityicon') || path.includes('/communityicon')) return null;
        if (path.includes('/emojis/') || path.includes('/emoji/')) return null;
        if (path.includes('/badges/') || path.includes('/badge/')) return null;
        if (path.includes('/awards/') || path.includes('/award_images/')) return null;
        if (path.includes('/reactions/')) return null;

        const isReddIt = host === 'redd.it' || host.endsWith('.redd.it');
        const isRedditWrapper = (host === 'reddit.com' || host.endsWith('.reddit.com')) && path === '/media';
        if (isReddIt || isRedditWrapper) {
          if (isAnimationUrl(url)) return 'gif-animation';
          if (isNativeGifUrl(url)) return 'native-gif';
          return 'image';
        }
      } catch (_) {}
      return null;
    }

    // the source of an <img>: a slide that is not near the viewport yet keeps the same address in data-lazy-src until it is swapped into src
    const imgSrc = (el) => el.currentSrc || el.src || attr(el, 'data-lazy-src');
    // The exact source of a media node, kept whole for source continuity at the item proof (never reduced to an identity): every address the
    // node or its player holds, so a changed query, resolution or token is a source change of that slot.
    // A player's source also holds the address the descriptor will pass on, from whichever source it selects (src/stream-url, the open shadow
    // <video> or its <source> nodes, else the file packaged-media-json selects): the proof covers what the descriptor uses, never the raw
    // attribute, so a reformatted declaration or a blob: MediaSource that selects the same address is no change and a different one is.
    const playerOf = (el) => (el.tagName === 'SHREDDIT-PLAYER' ? el : (typeof el.closest === 'function' ? el.closest('shreddit-player') : null));
    // the one shadow <video> the descriptor reads (first <video> of the player's own open shadow root); a replaced node is a changed source
    const shadowVideo = (el) => {
      if (el.tagName === 'SHREDDIT-EMBED') return embedFrame(el);
      const p = playerOf(el);
      const root = p && p.shadowRoot;
      return firstMainVideo(root);
    };
    const srcOf = (el) => {
      const host = embedHost(el);
      if (host) {
        const o = ownerOf(host);
        return ['embed', embedSrc(host), o && o.owner ? attr(o.owner, 'content-href') : ''].join('|');
      }
      if (el.tagName !== 'VIDEO' && el.tagName !== 'SHREDDIT-PLAYER') return imgSrc(el);
      const inner = el.tagName === 'SHREDDIT-PLAYER' ? firstMainVideo(el) : null;
      const player = playerOf(el);
      return [el.currentSrc || el.src || '', attr(el, 'src'), attr(el, 'stream-url'), inner ? (inner.currentSrc || inner.src || '') : '', attr(el, 'poster') || el.poster || '', player ? ((playerCandidate(player, null) || {}).url || '') : ''].join('|');
    };

    function snapshot(el, kind) {
      const o = ownerOf(el);
      if (!o || !o.owner) return null;
      if (typeof el.getBoundingClientRect !== 'function') return null;
      const idInfo = idOf(o.owner, o.isCrosspost);
      if (!idInfo || !idInfo.ownerId) return null;

      const chain = [];
      for (let p = el.parentElement; p && chain.length < RI.CHAIN; p = p.parentElement) {
        chain.push(new WeakRef(p));
        if (p === o.owner) break;
      }
      return {
        elRef: new WeakRef(el),
        ownerRef: new WeakRef(o.owner),
        isCrosspost: Boolean(o.isCrosspost),
        ownerId: idInfo.ownerId,
        postUrl: idInfo.postUrl,
        tag: el.tagName,
        kind,
        src: srcOf(el),
        shadow: (() => { const v = shadowVideo(el); return v ? new WeakRef(v) : null; })(),
        chain,
        href: here()
      };
    }

    function holds(s) {
      try {
        const el = s.elRef.deref();
        const owner = s.ownerRef.deref();
        if (!el || !owner || el.isConnected === false || owner.isConnected === false) return false;
        const o = ownerOf(el);
        if (!o || o.owner !== owner || Boolean(o.isCrosspost) !== s.isCrosspost) return false;
        if (el.tagName !== s.tag || srcOf(el) !== s.src) return false;
        if ((shadowVideo(el) || null) !== (s.shadow ? (s.shadow.deref() || null) : null)) return false;
        const idInfo = idOf(owner, s.isCrosspost);
        if (!idInfo || idInfo.ownerId !== s.ownerId) return false;
        let p = el.parentElement;
        for (const ref of s.chain) {
          if (!p || ref.deref() !== p) return false;
          p = p.parentElement;
        }
        return true;
      } catch (_) {
        return false;
      }
    }

    function same(a, b) {
      if (!a || !b) return false;
      return a.elRef?.deref() === b.elRef?.deref() &&
        a.ownerRef?.deref() === b.ownerRef?.deref() &&
        a.isCrosspost === b.isCrosspost &&
        a.ownerId === b.ownerId &&
        a.tag === b.tag &&
        a.src === b.src &&
        (a.shadow ? a.shadow.deref() : null) === (b.shadow ? b.shadow.deref() : null) &&
        a.kind === b.kind &&
        sameChain(a, b);
    }

    function candidate(stack) {
      for (const el of stack.slice(0, RI.MAX_STACK)) {
        if (!el || ctl.own(el)) continue;
        if (el.tagName === 'VIDEO') {
          if (isPreviewVideo(el)) continue; // the scrub preview of a player: the player below it is the candidate
          return { el, kind: 'video' };
        }
        if (el.tagName === 'SHREDDIT-PLAYER') return { el, kind: 'video' };
        if (el.tagName === 'IFRAME' || el.tagName === 'SHREDDIT-EMBED') {
          const e = embedOf(el);
          if (e) return { el: e.host, kind: 'video' };
          continue;
        }
        if (el.tagName === 'IMG') {
          const kind = imageKind(imgSrc(el));
          if (!kind) return null; // fails closed: topmost non-media image means no button behind it
          const player = stack.slice(0, RI.MAX_STACK).find((v) =>
            v && (v.tagName === 'VIDEO' || v.tagName === 'SHREDDIT-PLAYER') &&
            ownerOf(v)?.owner === ownerOf(el)?.owner
          );
          return player ? { el: player, kind: 'video' } : { el, kind: 'image' };
        }
      }
      return null;
    }

    function layout(el, owner, w, h) {
      try {
        if (!el || !owner || typeof el.getBoundingClientRect !== 'function' || typeof window.getComputedStyle !== 'function') return null;
        const rect = el.getBoundingClientRect();
        let L = rect.left, T = rect.top, Rt = rect.right, B = rect.bottom;
        const clip = (b) => { L = Math.max(L, b.left); T = Math.max(T, b.top); Rt = Math.min(Rt, b.right); B = Math.min(B, b.bottom); };
        let container = null, containerAt = -1, clipAt = -1, reached = false;
        let depth = 0;
        for (let p = el.parentElement; p && depth < RI.DEPTH; p = p.parentElement, depth++) {
          const cs = window.getComputedStyle(p);
          if (!cs) return null;
          if (clipsOf(cs)) {
            clip(p.getBoundingClientRect());
            if (clipAt < 0) clipAt = depth;
          }
          if (containerAt < 0 && cs.position && cs.position !== 'static') {
            container = p;
            containerAt = depth;
          }
          if (p === owner) { reached = true; break; }
        }
        if (!reached || !container || (clipAt >= 0 && containerAt > clipAt)) return null;
        clip(owner.getBoundingClientRect());
        const vw = (typeof window.innerWidth === 'number' && window.innerWidth) || 0;
        const vh = (typeof window.innerHeight === 'number' && window.innerHeight) || 0;
        clip({ left: 0, top: 0, right: vw || Rt, bottom: vh || B });
        if (!(Rt - L >= Math.max(RI.MIN_W, w + 2 * RI.INSET)) || !(B - T >= Math.max(RI.MIN_H, h + 2 * RI.INSET))) return null;
        if (L - rect.left > RI.TOL || T - rect.top > RI.TOL || rect.right - Rt > RI.TOL || rect.bottom - B > RI.TOL) return null;
        if (covered(owner, { left: L, top: T, right: Rt, bottom: B })) return null;
        const cr = container.getBoundingClientRect();
        if (typeof container.offsetWidth === 'number' && container.offsetWidth > 0 && Math.abs(cr.width - container.offsetWidth) > 2) return null;
        const left = Math.round(Rt - RI.INSET - w - cr.left - (container.clientLeft || 0) + (container.scrollLeft || 0));
        const top = Math.round(T + RI.INSET - cr.top - (container.clientTop || 0) + (container.scrollTop || 0));
        return { vis: { left: L, top: T, right: Rt, bottom: B }, host: container, left, top, w, h, sig: [L, T, Rt, B, cr.left, cr.top, w, h].map(Math.round).join(',') };
      } catch (_) {
        return null;
      }
    }

    function covered(owner, vis) {
      if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return false;
      const d = RI.CORNER;
      for (const [x, y] of [[vis.left + d, vis.top + d], [vis.right - d, vis.top + d], [vis.left + d, vis.bottom - d], [vis.right - d, vis.bottom - d]]) {
        const t = document.elementFromPoint(x, y);
        if (!t || !(ctl.own(t) || (typeof owner.contains === 'function' && owner.contains(t)))) return true;
      }
      return false;
    }

    // The stable identity of an asset from its Reddit media address: the host family and the asset id, never the query, token, extension or
    // resolution (contract amendment 4: a source-only change of one slot is item-level, not structural). The host is anchored, so a foreign
    // address that merely contains a Reddit host name never gets a Reddit identity.
    function assetId(s) {
      if (!s || typeof s !== 'string') return null;
      // The whole first path segment of an anchored Reddit image host (up to / ? #): preview addresses carry an SEO slug that may be percent-encoded,
      // localised or punctuated, [slug]-v0-[media id].[ext]. The media id is what follows the LAST -v0- and must be a plain id of [A-Za-z0-9_-]; a segment
      // without -v0- must itself be a plain id. Anything else (an encoded segment with no recoverable id, an encoded id) is unidentifiable, never a
      // truncated slug. The address itself is never rewritten.
      let m = s.match(/^(?:https?:)?\/\/(?:i|preview|external-preview)\.redd\.it\/([^/?#]+)/i);
      if (m) {
        const base = m[1].replace(/\.[A-Za-z0-9]{1,5}$/, '');
        const at = base.lastIndexOf('-v0-');
        const id = at >= 0 && at + 4 < base.length ? base.slice(at + 4) : base;
        return /^[A-Za-z0-9_-]+$/.test(id) ? `img:${id}` : null;
      }
      m = s.match(/^(?:https?:)?\/\/v\.redd\.it\/([a-zA-Z0-9_-]+)/i);
      if (m) return `vid:${m[1]}`;
      m = s.match(/^(?:https?:)?\/\/packaged-media\.redd\.it\/([a-zA-Z0-9_-]+)/i);
      if (m) return `pm:${m[1]}`;
      return null;
    }

    function slotKey(el) {
      if (!el) return null;
      const player = el.tagName === 'SHREDDIT-PLAYER' ? el : el.closest?.('shreddit-player');
      if (player) {
        const raw = [player.getAttribute?.('stream-url'), player.getAttribute?.('src')];
        for (const s of raw) { const id = assetId(s); if (id) return id; }
        // an address that carries no recognised asset id keeps its exact string as the identity (never merged with another)
        const pSrc = raw.find(Boolean) || player.getAttribute?.('id') || '';
        if (pSrc) return `sp:${pSrc}`;
      }
      const srcs = el.tagName === 'VIDEO'
        ? [(el.getAttribute && el.getAttribute('poster')) || el.poster || '', el.currentSrc || el.src || '']
        : [imgSrc(el)];
      for (const s of srcs) { const id = assetId(s); if (id) return id; }
      return null;
    }

    // ---- the native gallery (contract amendment 6) ----
    // Observed on www.reddit.com (post page and feed): <gallery-carousel> holds ONE <ul> of <li slot="page-1" ... slot="page-N"> (every slide is in
    // the DOM, laid out side by side; a slide that is not near the viewport keeps its source in data-lazy-src), and its open shadow roots hold a
    // pagination indicator whose `pages` attribute is the gallery's size. A slide holds one decorative backdrop <img alt=""> and the real media.
    const PAGE = /^page-(\d{1,3})$/;
    const isSlide = (li) => Boolean(li) && li.tagName === 'LI' && PAGE.test(attr(li, 'slot'));

    // The owner's native carousel: null when it has none (the generic evidence applies); { bad: true } when its structure is ambiguous (more than
    // one carousel, a carousel bound exceeded, no single <ul>); else { slides } with the <li> children in DOM order.
    function slideCarousel(owner) {
      const found = Array.from(owner.querySelectorAll('gallery-carousel'));
      if (found.length > RI.EVIDENCE_CONTAINERS) return { bad: true };
      const mine = found.filter((c) => { const o = ownerOf(c); return Boolean(o && o.owner === owner); });
      const lists = mine.map((c) => Array.from(c.children || []).filter((k) => k.tagName === 'UL'));
      const native = mine.filter((c, i) => lists[i].length === 1 && Array.from(lists[i][0].children || []).some(isSlide));
      if (native.length === 0) return null;
      if (mine.length !== 1 || native.length !== 1) return { bad: true };
      const ul = lists[0][0];
      return { slides: Array.from(ul.children || []) };
    }

    // One slide is one slot: the slot of its single real media. Decorative images (alt="" or aria-hidden), the poster and inner video of a
    // player and non-Reddit-media images are not media; one slide must not hold two different assets and must hold one.
    function slide(owner, li) {
      const none = { el: li, kind: 'image', key: null, slide: li };
      const nodes = Array.from(li.querySelectorAll('shreddit-player, video, img'));
      if (nodes.length > RI.SLIDE_NODES) return none;
      const media = [];
      for (const el of nodes) {
        const o = ownerOf(el);
        if (!o || o.owner !== owner) continue;
        if (el.tagName !== 'SHREDDIT-PLAYER' && typeof el.closest === 'function' && el.closest('shreddit-player')) continue;
        if (el.tagName === 'IMG') {
          if (el.getAttribute('alt') === '' || el.getAttribute('aria-hidden') === 'true') continue;
          if (!imageKind(imgSrc(el))) continue;
        }
        media.push(el);
      }
      if (media.length === 0) return none;
      const keys = media.map(slotKey);
      if (keys.some((k) => !k) || new Set(keys).size !== 1) return none;
      const sized = (m) => { const rect = typeof m.getBoundingClientRect === 'function' ? m.getBoundingClientRect() : null; return Boolean(rect) && rect.width > 0 && rect.height > 0; };
      const el = media.find((m) => m.tagName !== 'IMG') || media.find(sized) || media[0];
      return { el, kind: el.tagName === 'IMG' ? 'image' : 'video', key: keys[0], slide: li };
    }

    // the list of a post's media: [{ el, kind, key }] plus items/isComplete/keys/sig (the structure of the list: ordered slot identities, never URLs)
    function listOf(out, proof) {
      out.items = out;
      out.isComplete = proof.isComplete;
      out.keys = out.map((i) => i.key);
      out.sig = hashOf(out.keys.join('|'));
      return out;
    }

    function enumerateSlides(owner, sc) {
      const out = [];
      let whole = !sc.bad && sc.slides.length >= RI.BATCH_MIN && sc.slides.length <= RI.BATCH_MAX;
      if (whole) sc.slides.forEach((li, i) => { const m = isSlide(li) ? PAGE.exec(attr(li, 'slot')) : null; if (!m || Number(m[1]) !== i + 1) whole = false; });
      if (whole) for (const li of sc.slides) out.push(slide(owner, li));
      return listOf(out, galleryProof(owner, out, !whole));
    }

    function enumerate(owner) {
      if (!owner || typeof owner.querySelectorAll !== 'function') return [];
      const sc = slideCarousel(owner);
      if (sc) return enumerateSlides(owner, sc);
      const out = [];
      const seen = new Map();
      const all = Array.from(owner.querySelectorAll('shreddit-player, video, img'));
      // a list cut by the node bound can never be proven whole
      const truncated = all.length > RI.ENUM_NODES;
      for (const el of all.slice(0, RI.ENUM_NODES)) {
        const o = ownerOf(el);
        if (!o || o.owner !== owner || typeof el.getBoundingClientRect !== 'function') continue;
        const rect = el.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) continue;

        let kind = 'video';
        if (el.tagName === 'IMG') {
          if (!imageKind(el.currentSrc || el.src)) continue;
          kind = 'image';
        }
        const key = slotKey(el);
        if (key && seen.has(key)) {
          const at = seen.get(key);
          if (out[at].el.tagName === 'IMG' && (el.tagName === 'VIDEO' || el.tagName === 'SHREDDIT-PLAYER')) {
            out[at] = { el, kind: 'video', key };
          }
          continue;
        }
        if (key) seen.set(key, out.length);
        out.push({ el, kind, key });
      }
      return listOf(out, galleryProof(owner, out, truncated));
    }

    // Positive same-owner completeness evidence (contract amendment 4): exactly one declared total, read from a gallery container or its
    // pager that belongs to this owner. No declared total, two different totals, or a total of a nested/crossposted owner is no evidence.
    function declaredTotal(owner) {
      if (!owner || typeof owner.querySelectorAll !== 'function') return null;
      const totals = new Set();
      const mine = (n) => { const o = ownerOf(n); return Boolean(o && o.owner === owner); };
      const containers = Array.from(owner.querySelectorAll('gallery-carousel, [data-testid="carousel"], [total-items], [items-count], [data-total-items]'));
      const pagers = Array.from(owner.querySelectorAll('[data-testid="carousel-pager"]'));
      // evidence cut by its own bound can never be unambiguous (a discarded node might say another total): no proof
      if (containers.length > RI.EVIDENCE_CONTAINERS || pagers.length > RI.EVIDENCE_PAGERS) return null;
      for (const c of containers) {
        if (!mine(c)) continue;
        for (const a of ['total-items', 'items-count', 'data-total-items']) {
          const v = typeof c.getAttribute === 'function' ? c.getAttribute(a) : null;
          if (typeof v === 'string' && /^\d{1,3}$/.test(v.trim())) totals.add(parseInt(v, 10));
        }
      }
      // the native gallery states its size in the pagination indicator of its own open shadow roots (pages="N"; the aria-live text is localised, never read)
      for (const c of containers) {
        if (c.tagName !== 'GALLERY-CAROUSEL' || !mine(c)) continue;
        const outer = c.shadowRoot || null;
        const inner = outer && typeof outer.querySelector === 'function' ? (outer.querySelector('faceplate-carousel') || null) : null;
        const indicators = [];
        for (const root of [outer, inner && inner.shadowRoot]) if (root && typeof root.querySelectorAll === 'function') indicators.push(...Array.from(root.querySelectorAll('faceplate-pagination-indicator')));
        if (indicators.length > RI.EVIDENCE_PAGERS) return null;
        for (const ind of indicators) { const v = attr(ind, 'pages'); if (/^\d{1,3}$/.test(v.trim())) totals.add(parseInt(v, 10)); }
      }
      for (const p of pagers) {
        if (!mine(p)) continue;
        const text = String(p.textContent || (typeof p.getAttribute === 'function' ? p.getAttribute('aria-label') : '') || '').trim();
        const m = text.match(/^\d{1,3}\s*(?:\/|of)\s*(\d{1,3})$/i);
        if (m) totals.add(parseInt(m[1], 10));
      }
      return totals.size === 1 ? totals.values().next().value : null;
    }

    // The list is the whole gallery only when the declared total equals the enumerated distinct slots (2..100, every slot identifiable,
    // enumeration not cut). Anything else is Save this only; a count of rendered images is never evidence.
    function galleryProof(owner, items, truncated = false) {
      const n = items ? items.length : 0;
      const declared = declaredTotal(owner);
      const isComplete = !truncated && declared !== null && declared === n && n >= RI.BATCH_MIN && n <= RI.BATCH_MAX && items.every((i) => i.key) &&
        new Set(items.map((i) => i.key)).size === n;
      return { isComplete, count: n, declared };
    }

    // The hovered node is one of the list's slots: the node itself or the player that holds it (a <video> inside its shreddit-player is one slot)
    const has = (items, el) => items.some((i) => i.el === el || (typeof i.el.contains === 'function' && i.el.contains(el)) ||
      (i.slide && typeof i.slide.contains === 'function' && i.slide.contains(el)));

    function countFor(owner, el) {
      const items = enumerate(owner);
      if (!items.isComplete || !has(items, el)) return 0;
      return items.length;
    }

    function plan(el, snap) {
      const owner = snap.ownerRef.deref();
      const n = countFor(owner, el);
      if (n >= 2) {
        const wide = layout(el, owner, RI.MULTI_W, RI.MULTI_H);
        if (wide) return { n, compact: false, lay: wide };
        const compact = layout(el, owner, RI.COMPACT_W, RI.COMPACT_H);
        return compact ? { n, compact: true, lay: compact } : null;
      }
      const lay = layout(el, owner, RI.SIZE, RI.SIZE);
      return lay ? { n: 0, compact: false, lay } : null;
    }

    function heldPlan(el, snap) {
      const s = ctl.size();
      const lay = layout(el, snap.ownerRef.deref(), s.w, s.h);
      return lay ? { n: ctl.st.count, compact: ctl.st.compact, lay } : null;
    }

    function mediaWithin(node) {
      if (!node) return null;
      if (node.tagName === 'VIDEO' || node.tagName === 'SHREDDIT-PLAYER') return node;
      const e = embedOf(node);
      if (e) return e.host;
      if (node.tagName === 'IMG' && imageKind(imgSrc(node))) return node;
      if (typeof node.querySelectorAll !== 'function') return null;
      const list = Array.from(node.querySelectorAll('shreddit-player, video, img')).filter(
        (m) => m.tagName === 'VIDEO' || m.tagName === 'SHREDDIT-PLAYER' || imageKind(imgSrc(m))
      );
      return list.length === 1 ? list[0] : null;
    }

    function describe(snap, index = null, count = null) {
      if (!snap) return { ok: false, reason: 'NO_MEDIA' };
      const el = snap.elRef ? snap.elRef.deref() : null;
      const owner = snap.ownerRef ? snap.ownerRef.deref() : null;
      if (!el || !owner || el.isConnected === false || owner.isConnected === false) {
        return { ok: false, reason: 'STALE_OWNER' };
      }

      const idInfo = idOf(owner, snap.isCrosspost);
      if (!idInfo || !idInfo.ownerId) return { ok: false, reason: 'STALE_OWNER' };
      const ownerId = idInfo.ownerId;
      const postUrl = idInfo.postUrl || null;

      // a RedGIFs embed: the proven clip, as the canonical embed address; the background finds the frame of that clip and resolves it there
      if (embedHost(el)) {
        const e = embedOf(el);
        if (!e || e.owner !== owner) return { ok: false, reason: 'STALE_OWNER' };
        const media = { kind: 'video', url: `https://www.redgifs.com/ifr/${e.clip}`, ownerId, redgifsEmbed: true };
        if (postUrl) media.postUrl = postUrl;
        return { ok: true, media };
      }

      let url = '';
      let kind = snap.kind === 'video' ? 'video' : 'image';
      let blobPlayer = false;

      if (snap.kind === 'video' || el.tagName === 'VIDEO' || el.tagName === 'SHREDDIT-PLAYER' || el.closest?.('shreddit-player')) {
        kind = 'video';
        const player = el.tagName === 'SHREDDIT-PLAYER' ? el : el.closest?.('shreddit-player');
        if (player) {
          const found = playerCandidate(player, postUrl);
          if (found && found.url && !found.url.startsWith('blob:')) {
            url = found.url;
            blobPlayer = true;
          } else {
            const fallback = blobFallback(player, [player, owner], '');
            if (fallback && fallback.url && !fallback.url.startsWith('blob:')) {
              url = fallback.url;
              blobPlayer = true;
            } else {
              // No direct file anywhere: the stream the selected player itself declares (frozen here, never looked up again), or a positively
              // identified stream that cannot be saved. A blob with no declaration stays unresolved.
              const stream = declaredStreamOf(player);
              if (stream && stream.saveable && index === null) {
                const media = { kind: 'video', url: stream.url, ownerId, redditHls: true };
                if (postUrl) media.postUrl = postUrl;
                return { ok: true, media };
              }
              return { ok: false, reason: stream ? 'UNSUPPORTED_STREAM' : 'UNRESOLVED_BLOB' };
            }
          }
        } else if (el.tagName === 'VIDEO') {
          const vSrc = el.currentSrc || el.src || '';
          if (vSrc.startsWith('blob:')) {
            const direct = blobFallback(el, [el, owner], vSrc);
            if (direct && direct.url && !direct.url.startsWith('blob:')) {
              url = direct.url;
              blobPlayer = true;
            } else {
              return { ok: false, reason: 'UNRESOLVED_BLOB' };
            }
          } else if (vSrc) {
            url = vSrc;
            blobPlayer = false;
          } else {
            return { ok: false, reason: 'NO_MEDIA' };
          }
        }
      } else {
        kind = 'image';
        url = imgSrc(el);
        if (!url) return { ok: false, reason: 'NO_MEDIA' };
        if (!imageKind(url)) return { ok: false, reason: 'NO_MEDIA' };
      }

      if (!url || typeof url !== 'string' || !url.startsWith('https://') || url.length > 2048) {
        return { ok: false, reason: 'NO_MEDIA' };
      }

      const media = { kind, url, ownerId };
      if (postUrl) media.postUrl = postUrl;
      if (blobPlayer) media.blobPlayer = true;
      if (index !== null && count !== null) {
        media.index = index;
        media.count = count;
      }
      return { ok: true, media };
    }

    function answerOwner(token) {
      const entry = typeof token === 'string' ? ctl.pending.get(token) : null;
      ctl.pending.delete(token);
      if (!entry || Date.now() - entry.at > RI.TOKEN_TTL) return { ok: false, reason: 'NO_TOKEN' };
      const snap = entry.snap;
      if (!holds(snap)) return { ok: false, reason: 'STALE_OWNER' };
      if (here() !== entry.href) return { ok: false, reason: 'STALE_OWNER' };
      if (!layout(snap.elRef.deref(), snap.ownerRef.deref(), RI.SIZE, RI.SIZE)) return { ok: false, reason: 'STALE_OWNER' };
      return authored(describe(snap), snap);
    }

    function ownerHolds(snap, entry) {
      try {
        const owner = snap.ownerRef.deref();
        if (!owner || owner.isConnected === false) return false;
        if (here() !== entry.href) return false;
        const idInfo = idOf(owner, snap.isCrosspost);
        return Boolean(idInfo && idInfo.ownerId === snap.ownerId);
      } catch (_) {
        return false;
      }
    }

    // The owner's list as it is now against the one the batch was started for (contract amendment 4): the owner connected, complete again
    // by positive evidence, the same count, the same order and the same slot identities. null means the structure changed.
    function listHolds(entry) {
      const owner = entry.items[0].snap.ownerRef.deref();
      if (!owner || owner.isConnected === false) return null;
      const now = enumerate(owner);
      const ok = now.isComplete && now.length === entry.count && now.every((it, i) => it.key === entry.keys[i]);
      return ok ? now : null;
    }

    // Phase 1 of a batch: the page, the owner and the whole list (completeness, count, order, identities) are proven again and every item is described; a changed structure or an
    // owner mismatch ends the batch, an item that cannot be described fails alone later. The batch's admission: every slot's descriptor (exact address, post id, author) or its own
    // refusal is frozen now, so later scrolling, unloading or recycling of the post cannot change, add or drop a slot; a navigation away still stops the slots that have not started.
    function admit(entry) {
      // ownerHolds also compares the page URL and the owner's id
      if (!entry.items.every((it) => ownerHolds(it.snap, entry))) return 'STALE_OWNER';
      if (!listHolds(entry)) return 'STALE_LIST';
      entry.frozen = entry.items.map((it, i) => {
        if (!holds(it.snap)) return { ok: false, reason: 'STALE_ITEM' };
        const d = authored(describe(it.snap, i, entry.count), it.snap);
        if (d.ok) d.media.sig = entry.sig;
        return d;
      });
      return entry.frozen.some((d) => d.ok) ? null : 'NO_MEDIA';
    }

    const layoutName = (el) => (el ? (embedHost(el) ? 'embed' : String(el.tagName || '').toLowerCase()) : undefined);
    const proofDetail = (m, a) => ({
      index: Number.isInteger(m.index) ? m.index : undefined, count: a && a.count, kind: a && a.media && a.media.kind, host: a && a.media && a.media.url,
      hls: Boolean(a && a.media && a.media.redditHls), ownerId: a && (a.ownerId || (a.media && a.media.ownerId))
    });

    const ctl = createControl((c) => ({
      name: 'reddit', K: RI, align: 'flex-end', hideOn: ['popstate'], rearmOn: ['scroll', 'wheel', 'resize'],
      candidate, snapshot, holds, plan, heldPlan, admit,
      watch: watchOwner,
      // A cross-origin iframe (a RedGIFs embed) takes the pointer from this document: no pointermove arrives while it is over the frame, only the entry onto it.
      onOver(e) {
        const t = e && e.target;
        if (t && (t.tagName === 'IFRAME' || t.tagName === 'SHREDDIT-EMBED')) c.onMove(e);
      },
      focusTarget(t) {
        if (typeof t.closest !== 'function' || !t.closest(r.post)) return null;
        const el = mediaWithin(t);
        if (!el) return null;
        const kind = (el.tagName === 'VIDEO' || el.tagName === 'SHREDDIT-PLAYER' || embedHost(el)) ? 'video' : imageKind(imgSrc(el));
        return kind ? { el, kind } : null;
      },
      showDetail: (el, snap, p) => ({ kind: snap.kind, count: p.n, compact: Boolean(p.compact), ownerId: snap.ownerId, layout: layoutName(el) }),
      prepare(which, shown, cid) {
        const st = c.st;
        const el = shown && shown.elRef.deref();
        const owner = shown && shown.ownerRef.deref();
        const s = c.size();
        const fresh = el ? snapshot(el, shown.kind) : null;
        if (which === 'this') {
          // A stale control is refused: nothing is sent. A cross-origin iframe (a RedGIFs embed) gives this document no pointer event to show a control again, so the refusal
          // re-evaluates from the last pointer place with the existing bounded re-arm; only a freshly proven candidate shows one.
          // (The journal names the first gate that refused, in the same order and with the same short-circuit as the guard.)
          const gate = !shown ? 'NO_CONTROL' : !el ? 'TARGET_GONE' : !fresh ? 'NO_SNAPSHOT' : !same(fresh, shown) ? 'TARGET_CHANGED' : !holds(shown) ? 'OWNER_NOT_HELD'
            : !layout(el, fresh.ownerRef.deref(), s.w, s.h) ? 'LAYOUT_LOST' : '';
          if (gate) return { gate, soft: true, detail: () => ({ which, kind: shown && shown.kind, ownerId: shown && shown.ownerId, layout: layoutName(el) }) };
          return { key: `${fresh.ownerId}|${fresh.src}`, store: 'pending', entry: { snap: fresh, href: here(), cid }, action: 'REDDIT_INLINE_SAVE',
            start: () => ({ which, kind: fresh.kind, ownerId: fresh.ownerId, layout: layoutName(el) }) };
        }
        const gate = !fresh ? (!shown ? 'NO_CONTROL' : (!el ? 'TARGET_GONE' : 'NO_SNAPSHOT')) : !owner ? 'OWNER_GONE' : st.count < RI.BATCH_MIN ? 'NOT_A_BATCH'
          : !same(fresh, shown) ? 'TARGET_CHANGED' : !holds(shown) ? 'OWNER_NOT_HELD' : !layout(el, owner, s.w, s.h) ? 'LAYOUT_LOST' : '';
        if (gate) return { gate, detail: { which, count: st.count } };
        const items = enumerate(owner);
        if (!items.isComplete || items.length !== st.count || items.length > RI.BATCH_MAX || !has(items, el)) {
          return { gate: 'LIST_CHANGED', detail: { which, count: items.length, n: st.count, partial: !items.isComplete } };
        }
        const all = c.snapshotAll(items, owner);
        if (!all.snaps) return { gate: 'ITEM_NOT_OWNED', detail: { which, index: all.index } };
        return { key: `all|${fresh.ownerId}|${items.sig}`, store: 'batches', action: 'REDDIT_INLINE_SAVE_ALL',
          entry: { items: all.snaps.map((snap) => ({ snap, used: false })), href: here(), opened: false, sig: items.sig, keys: items.keys.slice(), ownerId: fresh.ownerId, count: all.snaps.length, cid },
          start: () => ({ which, count: all.snaps.length, ownerId: fresh.ownerId }) };
      },
      proof: {
        REDDIT_INLINE_OWNER: { phase: 'proof', run: (m) => answerOwner(m.token), detail: proofDetail },
        REDDIT_INLINE_BATCH: { phase: 'batch.proof', run: (m) => c.batchOpen(m.token), detail: proofDetail },
        REDDIT_INLINE_OWNER_ITEM: { phase: 'item.proof', run: (m) => c.batchItem(m.token, m.index), detail: proofDetail }
      }
    }));
    // what the tests of this handler reach (the same names the page-side code uses)
    ctl.api = { K: RI, state: ctl.st, pending: ctl.pending, batches: ctl.batches, candidate, imageKind, slotKey, assetId, enumerate, galleryProof, declaredTotal, listHolds, countFor, layout, covered, plan,
      snapshot, holds, describe, answerOwner, batchOpen: ctl.batchOpen, batchItem: ctl.batchItem, teardown: ctl.teardown, evaluate: ctl.evaluate, onMove: ctl.onMove,
      onClick: (e) => ctl.click('this', e), onClickAll: (e) => ctl.click('all', e), ensureHost: ctl.ensureHost, hide: ctl.hide };
    return ctl;
  }

  // ---- RedGIFs (https://www.redgifs.com/*, the top document of the provider's own site): the players ----
  // Every eligible `.Player` (it owns exactly one video) gets its own real <button> as its last child, so keyboard users reach it in the native tab order (after the player's own
  // focusable children) without hovering first. The button is hidden (transparent, no pointer events, but focusable) until the pointer rests on its player or it takes the focus; it
  // never covers anything while hidden. No Reddit document and no embedded /ifr/ player is eligible. Mounting, hovering and focusing do no provider or background work. A trusted
  // activation stores a one-shot target for the live player (node, source and poster evidence, document location) in the store content_redgifs.js owns and sends only its token and
  // the player's own key; the worker then asks this same document to resolve THAT player (RESOLVE_FRAME_MEDIA with inlineToken), so the context-menu capture is neither read nor
  // written and the player must survive every asynchronous step unchanged. Not a hover control of the other sites: it has no "Save all" and one button per player.
  function redgifsHandler(r) {
    const RG = { ...K, Z: 2147483000, POLL_MS: 250, SCAN_MS: 100, TOKEN_TTL: r.ttl, MAX_ITEMS: 100 };
    const { allowed, playerOf, holds, evidenceOf, sameEvidence, connected } = r;
    const inl = { items: new Map(), active: null, timer: null, scanTimer: null, poll: null, observer: null, x: 0, y: 0, moved: false, watch: false, frame: null, pending: r.pending };

    // The eligible player under a point. Whatever lies above it must belong to its own card (.GifPreview or .TapTracker, else the Player itself; a
    // generic parent proves nothing): an unrelated dialog, menu or navigation layer over the player owns the point, and the hidden player behind it
    // is never selected. `occluded` tells such a player apart from an empty point
    function playerAt(x, y) {
      const stack = Array.from(document.elementsFromPoint(x, y)).slice(0, RG.MAX_STACK);
      for (let i = 0; i < stack.length; i++) {
        const player = playerOf(stack[i]);
        if (!player) continue;
        const card = player.owner.closest('.GifPreview') || player.owner.closest('.TapTracker') || player.owner;
        const owned = stack.slice(0, i).every((el) => typeof card.contains === 'function' && card.contains(el));
        return { player: owned ? player : null, occluded: !owned };
      }
      return { player: null, occluded: false };
    }

    // The refresh interval lives only while a control is visible or a player waits behind a layer
    function settle() {
      if (inl.active || inl.watch) return;
      if (inl.poll) { clearInterval(inl.poll); inl.poll = null; }
      if (inl.frame) { (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)(inl.frame); inl.frame = null; }
    }

    // Hidden = transparent and not hit-testable, still focusable
    function conceal(item) {
      item.shown = null;
      item.host.style.setProperty('opacity', '0');
      item.host.style.setProperty('pointer-events', 'none');
      if (inl.active === item) inl.active = null;
      settle();
    }

    function drop(item) {
      conceal(item);
      if (typeof item.host.remove === 'function') item.host.remove();
      inl.items.delete(item.owner);
    }

    // Upper-right corner of the visible part of the player (8 px inset, 32 px button), kept inside the player and the viewport while it scrolls or
    // resizes; false when the player is not visibly laid out or its visible part is smaller than the button
    function place(item) {
      const rect = typeof item.owner.getBoundingClientRect === 'function' ? item.owner.getBoundingClientRect() : null;
      if (!rect || !(rect.width >= 80 && rect.height >= 60) || rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
      const L = Math.max(rect.left, 0);
      const T = Math.max(rect.top, 0);
      const R = Math.min(rect.right, window.innerWidth);
      const B = Math.min(rect.bottom, window.innerHeight);
      if (R - L < RG.SIZE || B - T < RG.SIZE) return false; // the visible part of the player cannot contain the button
      // Local anchoring: the host is absolutely positioned inside the player, so a scroll the compositor performs carries the control with its player
      // instead of leaving it behind at the old viewport place. The wanted viewport place is converted by measurement, not by assuming which ancestor
      // is the containing block, and the result is proven: a control that does not lie inside the visible part of its player is not shown
      const host = item.host;
      host.style.setProperty('left', '0px');
      host.style.setProperty('top', '0px');
      const origin = host.getBoundingClientRect();
      host.style.setProperty('left', `${Math.max(R - RG.SIZE - RG.INSET, L) - origin.left}px`);
      host.style.setProperty('top', `${Math.max(Math.min(T + RG.INSET, B - RG.SIZE - RG.INSET), T) - origin.top}px`);
      const m = host.getBoundingClientRect();
      return !(m.width > 0 && (m.left < L - 2 || m.top < T - 2 || m.right > R + 2 || m.bottom > B + 2));
    }

    // The one bounded refresh (every 250 ms, only while a control is visible or a player waits behind a layer): a changed or moved player is dropped,
    // and the pointer's place is judged again, so a layer that appears, goes or changes visibility under a stationary pointer is noticed. The control
    // the keyboard is on is never taken away by the pointer
    function follow() {
      const item = inl.active;
      if (item && (document.hidden || !item.shown || !holds(item.shown) || !place(item))) conceal(item);
    }

    function tick() {
      follow();
      evaluate();
    }

    // A scroll or resize places the visible control again, at most once per frame, and only while one is visible or a player waits behind a layer
    function onViewport() {
      if ((!inl.active && !inl.watch) || inl.frame) return;
      const run = () => { inl.frame = null; follow(); };
      inl.frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
    }

    // Show the control of one player (hover or focus); at most one control is visible
    function reveal(item) {
      const player = playerOf(item.owner);
      if (!player) { drop(item); return; }
      if (inl.active && inl.active !== item) conceal(inl.active);
      // A selection generation is the player with the source and poster it shows now. A changed one (the same node recycled to another clip) is a
      // request of its own: fresh throttle and duplicate key. The same one, however often the control is hidden and shown, keeps both
      const evidence = evidenceOf(player.video);
      if (!(item.gen && item.gen.video === player.video && sameEvidence(item.gen.evidence, evidence))) {
        item.gen = { video: player.video, evidence };
        item.id = randomHex(8);
        item.busyAt = 0;
      }
      if (!(item.shown && item.shown.video === player.video && holds(item.shown))) {
        item.shown = { video: player.video, owner: item.owner, evidence, href: window.location.href };
      }
      if (!place(item)) { conceal(item); return; }
      inl.active = item;
      item.host.style.setProperty('opacity', '1');
      item.host.style.setProperty('pointer-events', 'auto');
      if (!inl.poll) inl.poll = setInterval(tick, RG.POLL_MS);
    }

    function mount(owner) {
      let item = inl.items.get(owner);
      if (item) return item;
      if (inl.items.size >= RG.MAX_ITEMS || !randomHex(1)) return null;
      const host = document.createElement('div');
      host.setAttribute('data-image-saver-inline', 'redgifs');
      for (const [k, v] of [['position', 'absolute'], ['z-index', String(RG.Z)], ['margin', '0'], ['padding', '0'], ['opacity', '0'], ['pointer-events', 'none']]) host.style.setProperty(k, v);
      const root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
      item = { owner, host, btn: null, id: randomHex(8), shown: null, focused: false, busyAt: 0, busyTimer: null };
      // the same download icon and single-button look as the other inline controls, as a 32 px round button
      const { btn, icon } = makeButton((e) => onClick(item, e), (e) => onButtonKey(item, e), false);
      item.btn = btn;
      isLabel(btn, 'aria-label', 'inline.saveClipAria', 'MediaLatch: Save this clip');
      isLabel(btn, 'title', 'inline.saveClipAria', 'MediaLatch: Save this clip');
      if (!icon) isLabel(btn, 'textContent', 'inline.save', 'Save');
      styleButton(btn, RG.SIZE, RG.SIZE, '2px', '0');
      // visible focus (the reset above removes the browser's ring), and the control follows the focus
      btn.addEventListener('focus', () => {
        item.focused = true;
        btn.style.setProperty('outline', '2px solid #fff');
        btn.style.setProperty('outline-offset', '2px');
        reveal(item);
      });
      btn.addEventListener('blur', () => {
        item.focused = false;
        btn.style.setProperty('outline', 'none');
        if (!inl.timer) inl.timer = setTimeout(hoverTimer, RG.HOVER_MS);
      });
      root.appendChild(btn);
      owner.appendChild(host);
      inl.items.set(owner, item);
      return item;
    }

    // Every eligible player has its control; a recycled, removed or no longer eligible player loses it
    function scan() {
      inl.scanTimer = null;
      try {
        if (!allowed()) return;
        for (const [owner, item] of Array.from(inl.items)) if (!connected(owner) || !playerOf(owner)) drop(item);
        for (const owner of Array.from(document.querySelectorAll('.Player')).slice(0, RG.MAX_ITEMS)) if (playerOf(owner)) mount(owner);
        // a page change under a resting pointer (a layer opening or closing, a recycled player) is judged against the pointer's last place
        if (inl.moved && (!inl.active || !inl.active.focused)) evaluate();
      } catch (_) {}
    }

    const scheduleScan = () => { if (!inl.scanTimer) inl.scanTimer = setTimeout(scan, RG.SCAN_MS); };

    function evaluate() {
      try {
        if (document.hidden || !allowed() || typeof document.elementsFromPoint !== 'function') {
          inl.watch = false;
          if (inl.active && !inl.active.focused) conceal(inl.active);
          return;
        }
        const at = playerAt(inl.x, inl.y);
        const item = at.player ? mount(at.player.owner) : null;
        inl.watch = at.occluded; // a player behind a layer is watched until the layer goes
        if (inl.active && inl.active.focused && inl.active !== item) return; // the control the keyboard is on stays
        if (item) reveal(item);
        else if (inl.active && !inl.active.focused) conceal(inl.active);
        if (inl.watch && !inl.poll) inl.poll = setInterval(tick, RG.POLL_MS);
      } catch (_) {
        inl.watch = false;
        if (inl.active && !inl.active.focused) conceal(inl.active);
      } finally {
        settle(); // every exit: early returns and exceptions included
      }
    }

    function hoverTimer() {
      inl.timer = null;
      evaluate();
    }

    function onMove(e) {
      if (!e || (e.pointerType && e.pointerType !== 'mouse') || !allowed()) return;
      inl.x = e.clientX;
      inl.y = e.clientY;
      inl.moved = true;
      if (!inl.timer) inl.timer = setTimeout(hoverTimer, RG.HOVER_MS);
    }

    // Escape hides the control and leaves it: the focus is released in place, so the next Tab continues from there
    function onButtonKey(item, e) {
      if (!e || e.key !== 'Escape') return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      conceal(item);
      if (typeof item.btn.blur === 'function') item.btn.blur();
    }

    function onClick(item, e) {
      if (e) {
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (typeof e.preventDefault === 'function') e.preventDefault();
      }
      // only a genuine mouse or keyboard activation of the control; a click the page dispatches sends nothing
      if (!e || e.isTrusted !== true) { DBG.log('redgifs.inline', 'click', 'refused', 'NOT_TRUSTED'); return; }
      const cid = DBG.cid();
      const s = item.shown;
      if (!s || !holds(s)) { DBG.log('redgifs.inline', 'click', 'refused', s ? 'OWNER_NOT_HELD' : 'NO_CONTROL', null, { cid }); conceal(item); return; }
      // a repeated activation of the SAME player inside the gap is one request; another player is a request of its own
      const now = Date.now();
      if (now - item.busyAt < RG.CLICK_GAP) { DBG.log('redgifs.inline', 'click', 'skipped', 'BUSY', null, { cid }); return; }
      const token = randomHex(16);
      if (!token) { DBG.log('redgifs.inline', 'click', 'failed', 'NO_RANDOM', null, { cid }); return; }
      DBG.log('redgifs.inline', 'click', 'start', undefined, null, { cid });
      item.busyAt = now;
      stash(inl.pending, token, { video: s.video, owner: s.owner, evidence: s.evidence, href: s.href, at: now, cid }, RG.TOKEN_TTL, RG.MAX_PENDING);
      dispatch('redgifs.inline', { action: 'REDGIFS_INLINE_SAVE', token, player: item.id }, token, inl.pending, item, [item.btn]);
    }

    function suspend() {
      if (inl.active) conceal(inl.active);
      inl.pending.clear();
      for (const k of ['timer', 'scanTimer']) if (inl[k]) { clearTimeout(inl[k]); inl[k] = null; }
      inl.watch = false;
      settle();
    }

    function teardown() {
      suspend();
      for (const item of Array.from(inl.items.values())) {
        if (item.busyTimer) { clearTimeout(item.busyTimer); item.busyTimer = null; }
        drop(item);
      }
      if (inl.observer) { try { inl.observer.disconnect(); } catch (_) {} inl.observer = null; }
    }

    // Own site, top document only: nothing at all is registered on a Reddit document or an embedded player
    try {
      if (allowed() && typeof window.addEventListener === 'function') {
        on(window, 'pointermove', onMove, { capture: true, passive: true });
        on(window, 'scroll', onViewport, { capture: true, passive: true }); // capture: a scroller inside the page counts too
        on(window, 'resize', onViewport, { passive: true });
        if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
          inl.observer = new MutationObserver(scheduleScan);
          inl.observer.observe(document.documentElement, { childList: true, subtree: true });
        }
        scheduleScan();
      }
    } catch (_) {}
    function resume() {
      if (document.hidden || !allowed()) return;
      // BFCache may retain keyboard focus without another focus event. Re-prove the live player before revealing it.
      for (const item of Array.from(inl.items.values())) if (item.focused) { reveal(item); break; }
      scan();
    }
    const ctl = { st: {}, suspend, resume, teardown, state: inl };
    controls.push(ctl);
    return ctl;
  }

  // ---- start only the handler of the page's own host (every handler is for the top frame) ----
  const api = { labels: isLabels, teardown() {} };
  function start() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    let host = '';
    try { host = new URL(location.href).hostname.toLowerCase(); } catch (_) {}
    if (SITE.x) api.x = xHandler(SITE.x);
    if (SITE.reddit) api.reddit = redditHandler(SITE.reddit);
    if (SITE.redgifs && SITE.redgifs.allowed()) api.redgifs = redgifsHandler(SITE.redgifs);
    if (host === 'www.pixiv.net') api.pixiv = pixivHandler();
    if (host === 'vk.ru' || host === 'vk.com') api.vk = vkHandler();
    if (!controls.length || typeof window.addEventListener !== 'function') return;
    on(window, 'pagehide', (e) => { if (e && e.persisted === true) controls.forEach((c) => c.suspend()); else api.teardown(); }, true);
    on(window, 'pageshow', (e) => { if (e && e.persisted === true) controls.forEach((c) => { c.suspend(); c.st.href = here(); c.resume?.(); }); }, true);
  }

  api.teardown = () => {
    for (const c of controls) c.teardown();
    for (const [target, type, fn, opts] of listeners) { try { target.removeEventListener(type, fn, opts); } catch (_) {} }
    listeners.length = 0;
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && typeof chrome.runtime.onMessage.removeListener === 'function') for (const fn of proofs) chrome.runtime.onMessage.removeListener(fn);
    proofs.length = 0;
    controls.length = 0;
    if (globalThis.__medialatchInline === api) delete globalThis.__medialatchInline;
  };
  globalThis.__medialatchInline = api;
  start();
})();
