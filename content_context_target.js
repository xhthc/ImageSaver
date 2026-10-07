'use strict';
// Passive generic capture of the element of the latest real context-menu gesture in this frame.
// The native menu takes the pointer away from the page, so :hover is gone when the extension's menu item is clicked;
// this keeps the one element the user actually pressed on. It inspects the selected tree (hit tests and scoped videos),
// keeps no copy of page data and sends small hint messages (one per gesture, plus bounded ones while the pointer rests: see
// `notify` / `evaluate`); background.js reads it through chrome.scripting.executeScript in the same isolated world and the same
// frame, and accepts it only while fresh, connected, an <img> and still showing the clicked source.
// A site may reuse the same <img> for another card before the menu item is chosen (same src, new parent and
// original). The record therefore also carries what identified the owner at the gesture (the sources, the owner
// attributes the extraction reads and the ancestor chain) and `unchanged(el)` to prove it is still the same owner.
// A CSS background or a simple overlay has no <img> context in the native menu. For a gesture on a non-media
// element the record may carry `media`: the one http(s) asset that is unambiguously the pressed element's own
// background, or the one image/video/background directly under a covering overlay inside the overlay's parent,
// found from the gesture point with a bounded hit test, including a video inside its covering player wrapper.
// Ancestor/decorative backgrounds, several assets and
// anything unclear give no `media`. `media.check()` recomputes and re-proves it when the save runs.
(() => {
  const KEY = '__imageSaverContextTarget';
  if (globalThis[KEY] !== undefined) return;
  globalThis[KEY] = null;

  const OWNER_ATTRS = [
    'srcset', 'data-original', 'data-src', 'data-full', 'data-full-image', 'data-original-src', 'data-image',
    'data-zoom-src', 'data-highres', 'data-large', 'data-raw', 'data-super-full-img', 'data-orig-file',
    'data-ou', 'data-orig-url'
  ];
  const DEPTH = 8; // the ancestor depth the extraction reads for CSS backgrounds
  const MAX_STACK = 32; // hit-test elements examined under the gesture point
  const PROBES = [[0.5, 0.5], [0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95]]; // overlay-relative extra hit-test points
  const attrsOf = (el) => OWNER_ATTRS.map((name) => (typeof el.getAttribute === 'function' ? el.getAttribute(name) : null));
  const sameChain = (el, parents) => {
    let p = el.parentElement;
    for (let i = 0; i < parents.length; i++, p = p && p.parentElement) {
      if (!p || parents[i].deref() !== p) return false;
    }
    // A chain shorter than DEPTH ended at the root: the element must not have gained a longer one.
    return parents.length === DEPTH || !p;
  };

  // Snapshot of who owns `el` now; the returned check holds a WeakRef only, never the node.
  const snapshot = (el) => {
    const parents = [];
    for (let p = el.parentElement; p && parents.length < DEPTH; p = p.parentElement) parents.push(new WeakRef(p));
    const attrs = JSON.stringify(attrsOf(el));
    const ref = new WeakRef(el);
    return (cur) => cur === ref.deref() && sameChain(cur, parents) && JSON.stringify(attrsOf(cur)) === attrs;
  };

  const httpUrl = (value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch (e) {
      return null;
    }
  };

  // The one http(s) asset an element itself is: an <img>/<video> source, or exactly one http(s) url() in its own
  // computed background (data:/blob: and gradients are not assets). 'multi' = several http(s) backgrounds.
  const mediaOf = (el) => {
    if (el.tagName === 'IMG') {
      const url = httpUrl(el.currentSrc || el.src);
      return url ? { url, kind: 'img' } : null;
    }
    if (el.tagName === 'VIDEO') {
      // A blob:/MSE/not-yet-loaded player is still the selected player: it has no ready HTTP URL, and an existing
      // provider recovery may resolve it, so it is a (URL-less) target rather than no target.
      const url = httpUrl(el.currentSrc || el.src);
      return url ? { url, kind: 'video' } : { url: null, kind: 'player' };
    }
    const value = window.getComputedStyle(el).backgroundImage;
    if (!value || value === 'none') return null;
    const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
    const web = [];
    let m;
    while ((m = re.exec(value))) {
      const url = httpUrl(m[1] ?? m[2] ?? m[3] ?? '');
      if (url) web.push(url);
    }
    if (web.length > 1) return 'multi';
    return web.length === 1 ? { url: web[0], kind: 'css' } : null;
  };

  // The hit test of the pressed element's own tree: inside an open shadow root the document only reports the host.
  const hitList = (target, px, py) => {
    const root = typeof target.getRootNode === 'function' ? target.getRootNode() : null;
    const src = root && root !== document && typeof root.elementsFromPoint === 'function' ? root : document;
    return src.elementsFromPoint(px, py).slice(0, MAX_STACK);
  };
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const overlap = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return Math.max(0, w) * Math.max(0, h);
  };

  // Media candidates under one point, only inside the target's parent container, never the
  // container itself or its ancestors. Contained media may be absent from the hit stack (pointer-events:none);
  // include images only when the pressed target itself is a link. null = ambiguous or oversized candidates.
  const candidatesAt = (target, scope, px, py) => {
    const out = [];
    const isLinkTarget = target.tagName === 'A' || (typeof target.getAttribute === 'function' && target.getAttribute('role') === 'link');
    const descendants = typeof target.querySelectorAll === 'function' ? target.querySelectorAll(isLinkTarget ? 'video,img' : 'video') : [];
    if (descendants.length > 24) return null; // Never infer uniqueness from a truncated subtree list.
    for (const e of descendants) {
      if ((e.tagName !== 'VIDEO' && !(isLinkTarget && e.tagName === 'IMG')) || !target.contains(e) || e.isConnected === false || !holds(e, px, py)) continue;
      if (e.tagName === 'IMG') {
        const style = window.getComputedStyle(e);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      }
      const m = mediaOf(e);
      if (m) out.push({ el: e, url: m.url, kind: m.kind });
    }
    for (const e of hitList(target, px, py)) {
      if (e === target || e === scope || !scope.contains(e) || out.some((c) => c.el === e)) continue;
      if (target.contains(e) && !isLinkTarget) continue;
      const m = mediaOf(e);
      if (m === 'multi') return null;
      if (m) out.push({ el: e, url: m.url, kind: m.kind });
    }
    if (out.length > 1) {
      const imgs = out.filter((c) => c.kind === 'img');
      if (imgs.length === 1 && out.every((c) => c === imgs[0] || (c.kind === 'css' && c.url === imgs[0].url))) {
        return [imgs[0]];
      }
    }
    return out;
  };

  // Hit test at the gesture point plus five overlay points; inspect at most 24 videos (and linked images).
  // The overlap check below excludes broad post/layout wrappers, including their blank padding.
  const detect = (target, x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || typeof document.elementsFromPoint !== 'function') return null;
    // A page-level background is decoration, not the pressed element's media.
    if (target.tagName === 'HTML' || target.tagName === 'BODY') return null;
    // The target must still be what is under the gesture point (not moved away, covered or removed).
    if (!hitList(target, x, y).includes(target)) return null;
    const own = mediaOf(target);
    if (own === 'multi') return null;
    const root = typeof target.getRootNode === 'function' ? target.getRootNode() : null;
    const scope = target.parentElement || (root && root !== document && root.host ? root : null);
    if (!scope) return null;
    const found = candidatesAt(target, scope, x, y);
    if (!found) return null;
    if (own) return found.length === 0 ? { el: target, url: own.url, kind: own.kind } : null;
    if (found.length !== 1) return null;
    const media = found[0];
    const t = target.getBoundingClientRect();
    // A simple overlay lies over its one media (it may be a little larger or smaller): a layer that reaches beyond
    // that media (a large layer over a small thumbnail, one layer over two side-by-side images) is not one.
    if (!(area(t) > 0) || overlap(t, media.el.getBoundingClientRect()) < 0.9 * area(t)) return null;
    // Other points of the overlay must not reveal a second asset under it.
    for (const [fx, fy] of PROBES) {
      const other = candidatesAt(target, scope, t.left + fx * t.width, t.top + fy * t.height);
      if (!other || other.some((c) => c.el !== media.el)) return null;
    }
    return media;
  };

  const holds = (el, x, y) => {
    const r = el.getBoundingClientRect();
    return area(r) > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const parentOf = (el) => el.parentElement || (typeof el.getRootNode === 'function' && el.getRootNode().host) || null;
  // Chrome offers its media contexts only on these elements; anything else pressed is not media by itself.
  const MEDIA_TAGS = 'img,video,audio,picture,canvas,svg,object,embed,input[type=image]';
  // A hint for the menu, never the proof: is there anything media-like at the pressed point that a provider adapter
  // (a layer over a player, a shadow-DOM player) could legitimately own? Bounded: four ancestors, 24 media each.
  // Descendant images never count; contained player videos are admitted only by detect()'s overlay proof.
  // A shadow host qualifies only through real media inside its own shadow tree: a custom element that merely has a shadow root
  // (an empty container, a layout wrapper) is not media, so blank space around it offers nothing.
  const shadowHoldsMedia = (host, target, x, y) => {
    const sr = host.shadowRoot;
    if (!sr || typeof sr.querySelectorAll !== 'function') return false;
    return Array.from(sr.querySelectorAll('img,video')).slice(0, 24).some((m) => !target.contains(m) && holds(m, x, y));
  };
  const mediaBoxAround = (target, x, y) => {
    let p = parentOf(target);
    const isLinkTarget = target.tagName === 'A' || (typeof target.getAttribute === 'function' && target.getAttribute('role') === 'link');
    for (let depth = 0; p && depth < 4; depth++, p = parentOf(p)) {
      if (p.shadowRoot && shadowHoldsMedia(p, target, x, y)) return true;
      const list = typeof p.querySelectorAll === 'function' ? Array.from(p.querySelectorAll('img,video')).slice(0, 24) : [];
      if (list.some((m) => (!target.contains(m) || isLinkTarget) && holds(m, x, y))) return true;
    }
    return false;
  };

  // What the selected element itself is, for the menu label only: an <img> (its address), a <video> (its address, or a URL-less
  // player), or a layer/CSS media found under the gesture. Never a neighbour, never page-wide data; null = not known.
  const evidenceOf = (kind, url) => ({ kind, url: typeof url === 'string' && url.length <= 2048 ? url : null });
  const ownEvidence = (target) => {
    if (target.tagName === 'IMG') return evidenceOf('img', httpUrl(target.currentSrc || target.src));
    if (target.tagName === 'VIDEO') {
      const url = httpUrl(target.currentSrc || target.src);
      return evidenceOf(url ? 'video' : 'player', url);
    }
    return null;
  };
  const foundEvidence = (found) => evidenceOf(found.kind === 'img' ? 'img' : found.kind === 'video' ? 'video' : found.kind === 'player' ? 'player' : 'css', found.url);

  // The hint for the pressed or pointed element: media-like, plus its anchor address and what the selected media is. `found`
  // is the detect() result when the caller already has it (the gesture); undefined makes the hover path run detect() itself,
  // after the cheaper checks.
  const hintFor = (target, x, y, found) => {
    let linkHref = null;
    let selectable = false;
    let media = null;
    try {
      const a = typeof target.closest === 'function' ? target.closest('a') : null;
      const href = a && typeof a.href === 'string' ? httpUrl(a.href) : null;
      if (href && href.length <= 2048) linkHref = href;
      const own = ownEvidence(target);
      if (own) {
        selectable = true;
        media = own;
      } else if (typeof target.closest === 'function' && target.closest(MEDIA_TAGS)) {
        selectable = true;
      } else {
        const f = found !== undefined ? found : (target.tagName !== 'HTML' && target.tagName !== 'BODY' ? detect(target, x, y) : null);
        if (f) {
          selectable = true;
          media = foundEvidence(f);
        } else {
          selectable = mediaBoxAround(target, x, y);
        }
      }
    } catch (e) {}
    return { selectable, linkHref, media };
  };

  const record = (target, x, y) => {
    const srcs = target.tagName === 'IMG' ? [...new Set([target.currentSrc, target.src].filter(Boolean))] : [];
    // A WeakRef does not keep a removed node alive; nothing below may close over `target` itself.
    const ref = new WeakRef(target);
    const same = snapshot(target);
    let media = null;
    if (target.tagName === 'IMG') {
      const own = mediaOf(target);
      if (own && own.url) {
        const mref = ref;
        const msame = same;
        media = {
          url: own.url,
          kind: 'img',
          ref: mref,
          check: () => {
            const t = mref.deref();
            if (!t || t.isConnected === false || !msame(t)) return false;
            const now = mediaOf(t);
            return Boolean(now) && now.url === own.url && now.kind === 'img';
          }
        };
      }
    } else if (target.tagName !== 'VIDEO') {
      const found = detect(target, x, y);
      if (found) {
        const url = found.url;
        const kind = found.kind;
        const playerSrc = kind === 'player' ? found.el.currentSrc || found.el.src || '' : null;
        const mref = new WeakRef(found.el);
        const msame = snapshot(found.el);
        media = {
          url,
          kind,
          ref: mref,
          check: () => {
            const t = ref.deref();
            const m = mref.deref();
            if (!t || !m || t.isConnected === false || m.isConnected === false || !same(t) || !msame(m)) return false;
            if (kind === 'player' && (m.currentSrc || m.src || '') !== playerSrc) return false;
            const now = detect(t, x, y);
            return Boolean(now) && now.el === m && now.url === url;
          }
        };
      }
    }
    const hint = hintFor(target, x, y, media);
    return {
      ref,
      at: Date.now(),
      srcs,
      unchanged: same,
      media,
      selectable: hint.selectable,
      linkHref: hint.linkHref,
      evidence: hint.media
    };
  };

  // ---- the hint for the menu (GEN-01-CURSOR) ----
  // Chrome has no event before the native menu opens, so the page tells background.js, ahead of time, whether the item
  // should be available at the pointer: (a) at every real gesture (right-press, contextmenu, the keyboard menu key),
  // always, and (b) while the pointer is merely resting somewhere, only after it stopped (IDLE_MS), at most once per
  // MIN_GAP_MS, and only when the answer changed. Pointer motion itself costs O(1): it stores two numbers and re-arms
  // one timer; no element is kept, nothing is observed, scanned or sent per pointer event. It is only a hint: the
  // gesture record above is what a Save click re-proves.
  const IDLE_MS = 120;
  const MIN_GAP_MS = 250;
  let px = NaN;
  let py = NaN;
  let idleTimer = null;
  let lastEval = 0;
  let lastSent = null; // { selectable, linkHref, mediaKey } the background was last told by this document; null = unknown
  const mediaKeyOf = (media) => (media ? `${media.kind}|${media.url || ''}` : '');
  let torn = false;
  const listeners = [];
  const cancel = () => {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
  };
  const teardown = () => {
    // Extension context gone (reloaded or updated): stop every timer and listener this document still has.
    torn = true;
    cancel();
    if (typeof window.removeEventListener === 'function') for (const [type, fn, opts] of listeners) window.removeEventListener(type, fn, opts);
    listeners.length = 0;
    try { chrome.runtime.onMessage.removeListener(onReset); } catch (e) {}
  };
  // phase: 'down' (right-press: a new click begins), 'menu' (the contextmenu event of that click), 'key' (keyboard menu key),
  // 'rest' (the pointer rests). media: what the selected element is, for the menu label (see evidenceOf). at: the timeStamp of
  // the trusted event that started the gesture; the provider scripts of this frame report the same value for the same event, so
  // the background can tell this gesture's descriptors from an earlier gesture's.
  const send = (selectable, linkHref, source, phase, media, at) => {
    try {
      if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.id) { teardown(); return false; }
      const sent = chrome.runtime.sendMessage({ action: 'CONTEXT_TARGET_STATE', selectable: selectable === true, linkHref, source, phase, media: media || null, gestureAt: Number.isFinite(at) ? at : undefined });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
      lastSent = { selectable: selectable === true, linkHref, mediaKey: mediaKeyOf(media) };
      return true;
    } catch (e) {
      teardown();
      return false;
    }
  };
  const notify = (rec, phase, at) => {
    if (!rec) return;
    cancel(); // the gesture's own answer is authoritative; a pending rest evaluation would only repeat it
    send(rec.selectable === true, rec.linkHref, 'gesture', phase, rec.evidence, at);
  };

  const deepElementAt = (x, y) => {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; i < 4 && el && el.shadowRoot && typeof el.shadowRoot.elementFromPoint === 'function'; i++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const evaluate = () => {
    idleTimer = null;
    if (torn || !Number.isFinite(px) || !Number.isFinite(py) || document.hidden) return;
    const wait = lastEval + MIN_GAP_MS - Date.now();
    if (wait > 0) { idleTimer = setTimeout(evaluate, wait); return; }
    lastEval = Date.now();
    let selectable = false;
    let linkHref = null;
    let media = null;
    try {
      const el = deepElementAt(px, py);
      if (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) { lastSent = null; return; } // the frame's own script answers
      if (el && el !== document.documentElement && el !== document.body) {
        const hint = hintFor(el, px, py);
        selectable = hint.selectable;
        linkHref = hint.linkHref;
        media = hint.media;
      }
    } catch (e) {
      return;
    }
    if (lastSent && lastSent.selectable === selectable && lastSent.linkHref === linkHref && lastSent.mediaKey === mediaKeyOf(media)) return;
    send(selectable, linkHref, 'pointer', 'rest', media);
  };
  const schedule = () => {
    cancel();
    idleTimer = setTimeout(evaluate, IDLE_MS);
  };
  const onMove = (e) => {
    if (!e || !e.isTrusted || (e.pointerType && e.pointerType !== 'mouse')) return;
    px = e.clientX;
    py = e.clientY;
    schedule();
  };
  // Scrolling, wheel and resizing move content under a still pointer: evaluate once the content settles.
  const onSettle = () => { if (Number.isFinite(px)) schedule(); };
  // The pointer left this document (to the browser, another window, or out of a frame): forget the point and the answer.
  const onOut = (e) => {
    if (e && e.relatedTarget) return;
    cancel();
    px = NaN;
    py = NaN;
    lastSent = null;
  };
  const onHide = () => {
    if (document.hidden) { cancel(); lastSent = null; }
  };
  // The page is leaving (navigation, bfcache): end the pending work whatever document.hidden says. A page restored from the
  // cache starts again from the next pointer move, with no remembered answer.
  const onGone = () => {
    cancel();
    px = NaN;
    py = NaN;
    lastSent = null;
  };
  // The background resets the shared menu state when window focus moves (windows.onFocusChanged), also while this page stays
  // visible. Forget what was sent, so the next rest repeats the answer even when it did not change. Sends nothing by itself.
  const onFocusEdge = () => { lastSent = null; };
  // Leaving the window: a rest evaluation still pending would speak for a window that no longer owns the menu.
  const onBlur = () => { cancel(); lastSent = null; };
  // The reset can come after this page already answered (focus, rest, then the background's reset). The background says so:
  // forget the answer and, if the pointer is known, answer once for it.
  const onReset = (m, sender) => {
    try {
      if (torn || !m || m.action !== 'CONTEXT_HINT_RESET' || !sender || sender.id !== chrome.runtime.id) return;
    } catch (e) { return; }
    lastSent = null;
    if (Number.isFinite(px) && !document.hidden) schedule();
  };
  // The keyboard context menu opens at the focused element, not at the pointer.
  const onKey = (e) => {
    if (!e || !e.isTrusted || !(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    try {
      const a = document.activeElement;
      if (!a || a === document.body || a === document.documentElement || typeof a.getBoundingClientRect !== 'function') return;
      const r = a.getBoundingClientRect();
      const hint = hintFor(a, r.left + r.width / 2, r.top + r.height / 2);
      cancel();
      send(hint.selectable, hint.linkHref, 'gesture', 'key', hint.media, e.timeStamp);
    } catch (err) {}
  };

  const capture = (event) => {
    // Only real user gestures: a page can dispatch synthetic events, but they are never trusted.
    if (!event || !event.isTrusted) return;
    if (event.type === 'mousedown' && event.button !== 2) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const target = path[0] || event.target;
    try {
      globalThis[KEY] = target && target.nodeType === 1 ? record(target, event.clientX, event.clientY) : null;
    } catch (e) {
      globalThis[KEY] = null;
    }
    notify(globalThis[KEY], event.type === 'mousedown' ? 'down' : 'menu', event.timeStamp);
  };

  window.addEventListener('mousedown', capture, true);
  window.addEventListener('contextmenu', capture, true);
  for (const [type, fn] of [['pointermove', onMove], ['scroll', onSettle], ['wheel', onSettle], ['resize', onSettle], ['mouseout', onOut], ['visibilitychange', onHide], ['pagehide', onGone], ['blur', onBlur], ['focus', onFocusEdge], ['keydown', onKey]]) {
    const opts = { capture: true, passive: true };
    window.addEventListener(type, fn, opts);
    listeners.push([type, fn, opts]);
  }
  try { if (chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === 'function') chrome.runtime.onMessage.addListener(onReset); } catch (e) {}
})();
