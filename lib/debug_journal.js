// debug_journal.js - the opt-in debug journal (DEBUG-MENU-01): one allowlisted event schema, the bounded journal the service worker
// writes, and the producer client of content scripts and extension pages. Classic script, idempotent (a reinjected document keeps
// the first copy), no Chrome API at load time: storage and messaging are reached only through the client or injected deps.
//
// Privacy: an event is reduced to codes, numbers, booleans, a validated host and validated post/media ids. Full URLs, queries,
// hashes, signed parameters, cookies, headers, raw errors/stacks/messages, DOM or React data, filenames, folders, local paths,
// post text and clipboard contents never pass sanitizeEvent(): unknown keys are dropped and every value is checked by type.
//
// Retention: at most MAX_EVENTS events, MAX_BYTES serialized and RETENTION_MS old; what pruning removes is counted (dropped /
// expired). Recording is off unless `debugEnabled === true` in chrome.storage.local; turning it off keeps the journal; clear()
// removes only the journal and persists a clear boundary, so an event created before the clear is never stored afterwards.
(function (root) {
  if (root.ImageSaverDebug) return;

  const ENABLED_KEY = 'debugEnabled';
  const STORAGE_KEY = 'imageSaverDebugV1';
  const MAX_EVENTS = 2000;
  const MAX_BYTES = 1024 * 1024;
  const RETENTION_MS = 24 * 60 * 60 * 1000;
  const MAX_PENDING = 500;
  const FLUSH_MS = 400;
  const FLUSH_AT = 100;

  const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
  const SOURCES = Object.freeze(['worker', 'content', 'frame', 'offscreen', 'settings', 'popup']);
  const OUTCOMES = Object.freeze(['start', 'ok', 'refused', 'failed', 'skipped', 'timeout', 'info']);

  const NAME = /^[a-z][a-z0-9_.-]{0,31}$/;
  const REASON = /^[A-Z][A-Z0-9_]{1,47}$/;
  const CODE = /^[A-Za-z0-9_.-]{1,48}$/;
  const CID = /^[a-f0-9]{8,16}$/;
  const OP = /^[a-z0-9-]{6,48}$/;
  const POST_ID = /^(?:\d{1,25}|t3_[a-z0-9]{1,12})$/;
  const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const JOB = /^[a-z0-9_-]{1,40}$/;
  const MIME = /^[a-z]+\/[a-z0-9.+-]{1,60}$/;
  const HOST = /^[a-z0-9.-]{1,253}$/;

  const CODE_KEYS = new Set(['provider', 'kind', 'stage', 'mode', 'phase', 'menu', 'type', 'route', 'state', 'gate', 'which', 'action',
    'entry', 'error', 'source', 'tier', 'transport', 'plan', 'result', 'evidence', 'conversion', 'site', 'layout', 'owner', 'reason', 'detail',
    'how', 'point', 'sel', 'id', 'outcome', 'lang', 'section', 'channel', 'target']);
  const NUM_KEYS = new Set(['n', 'count', 'index', 'items', 'started', 'refused', 'duplicate', 'ms', 'bytes', 'size', 'attempt', 'depth',
    'fibers', 'verified', 'skipped', 'score', 'downloadId', 'total', 'frames', 'width', 'height', 'variants', 'mp4', 'seen', 'media', 'tab',
    'frame', 'rateLimited', 'quote', 'req', 'foreign', 'edge', 'retry', 'remaining', 'failed', 'complete', 'dropped', 'duration']);
  const BOOL_KEYS = new Set(['ok', 'trusted', 'enabled', 'blob', 'hls', 'held', 'compact', 'audio', 'fallback', 'cached', 'visible', 'busy',
    'batch', 'inline', 'gesture', 'linked', 'hasSrc', 'hasLink', 'resumable', 'fresh', 'animated', 'isQuote', 'partial', 'answered']);
  const HOST_KEYS = new Set(['host', 'srcHost', 'linkHost', 'pageHost', 'frameHost']);
  const ID_KEYS = { postId: POST_ID, ownerId: POST_ID, mediaId: MEDIA_ID, clipId: MEDIA_ID, job: JOB, batch: CID, item: CID };
  const MAX_DETAIL_KEYS = 24;

  /** The host of an address (http/https only; blob:/data: become 'blob'/'data'), or a validated bare host; else ''. */
  function hostOf(value) {
    if (typeof value !== 'string' || !value || value.length > 4096) return '';
    if (/^blob:/i.test(value)) return 'blob';
    if (/^data:/i.test(value)) return 'data';
    if (value.includes('/') || value.includes(':')) {
      try {
        const u = new URL(value);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        const h = u.hostname.toLowerCase().replace(/\.$/, '');
        return HOST.test(h) ? h : '';
      } catch (_) {
        return '';
      }
    }
    const h = value.toLowerCase();
    return HOST.test(h) && h.includes('.') ? h : '';
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12 ? Math.round(v * 1000) / 1000 : undefined);

  /** Allowlisted details: every key is known and every value checked by its type; anything else is dropped. */
  function sanitizeDetails(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    let n = 0;
    for (const key of Object.keys(raw)) {
      if (n >= MAX_DETAIL_KEYS) break;
      const v = raw[key];
      let clean;
      // a code is a short word, never a token-like hex string (one-shot tokens, signatures, hashes)
      if (CODE_KEYS.has(key)) clean = typeof v === 'string' && CODE.test(v) && !/^[A-Fa-f0-9]{16,}$/.test(v) ? v : undefined;
      else if (NUM_KEYS.has(key)) clean = num(v);
      else if (BOOL_KEYS.has(key)) clean = typeof v === 'boolean' ? v : undefined;
      else if (HOST_KEYS.has(key)) clean = hostOf(v) || undefined;
      else if (key === 'mime') clean = typeof v === 'string' && MIME.test(v.split(';')[0].trim().toLowerCase()) ? v.split(';')[0].trim().toLowerCase() : undefined;
      else if (key === 'http') clean = Number.isInteger(v) && v >= 100 && v <= 599 ? v : undefined;
      else if (Object.prototype.hasOwnProperty.call(ID_KEYS, key)) clean = typeof v === 'string' && ID_KEYS[key].test(v) ? v : undefined;
      if (clean === undefined) continue;
      out[key] = clean;
      n++;
    }
    return n ? out : null;
  }

  /**
   * One clean event, or null. `ctx` (set by the worker from the sender, never by the producer) wins over the raw source and
   * frame context. Used at ingestion and again on every read/export.
   */
  function sanitizeEvent(raw, ctx) {
    if (!raw || typeof raw !== 'object') return null;
    const c = ctx && typeof ctx === 'object' ? ctx : raw;
    const t = typeof raw.t === 'number' && Number.isFinite(raw.t) ? raw.t : NaN;
    if (!(t > 1e12 && t < 1e13)) return null; // epoch milliseconds
    if (typeof raw.comp !== 'string' || !NAME.test(raw.comp) || typeof raw.act !== 'string' || !NAME.test(raw.act)) return null;
    const src = SOURCES.includes(c.src) ? c.src : null;
    if (!src) return null;
    const ev = {
      t: Math.round(t),
      lvl: LEVELS.includes(raw.lvl) ? raw.lvl : 'info',
      src,
      comp: raw.comp,
      act: raw.act,
      out: OUTCOMES.includes(raw.out) ? raw.out : 'info'
    };
    if (typeof raw.why === 'string' && REASON.test(raw.why)) ev.why = raw.why;
    if (typeof raw.cid === 'string' && CID.test(raw.cid)) ev.cid = raw.cid;
    if (typeof raw.op === 'string' && OP.test(raw.op)) ev.op = raw.op;
    if (Number.isInteger(c.tab) && c.tab >= 0 && c.tab < 1e10) ev.tab = c.tab;
    if (Number.isInteger(c.frame) && c.frame >= 0 && c.frame < 1e10) ev.frame = c.frame;
    if (typeof c.doc === 'string' && /^[A-Fa-f0-9]{6,8}$/.test(c.doc)) ev.doc = c.doc.toUpperCase();
    const page = hostOf(c.page);
    if (page) ev.page = page;
    if (Number.isInteger(raw.seq) && raw.seq > 0) ev.seq = raw.seq;
    const d = sanitizeDetails(raw.d);
    if (d) ev.d = d;
    return ev;
  }

  const sizeOf = (ev) => JSON.stringify(ev).length + 1;

  /**
   * Retention over events ordered oldest first: older than RETENTION_MS (expired), then beyond MAX_EVENTS or MAX_BYTES (dropped).
   * -> { events, expired, dropped }
   */
  function prune(events, now, limits) {
    const lim = { maxEvents: MAX_EVENTS, maxBytes: MAX_BYTES, retentionMs: RETENTION_MS, ...(limits || {}) };
    const cutoff = now - lim.retentionMs;
    let list = events.filter((e) => e.t >= cutoff);
    const expired = events.length - list.length;
    let dropped = 0;
    if (list.length > lim.maxEvents) { dropped += list.length - lim.maxEvents; list = list.slice(-lim.maxEvents); }
    let bytes = list.reduce((a, e) => a + sizeOf(e), 2);
    let cut = 0;
    while (bytes > lim.maxBytes && cut < list.length) { bytes -= sizeOf(list[cut]); cut++; }
    if (cut) { dropped += cut; list = list.slice(cut); }
    return { events: list, expired, dropped, bytes };
  }

  /**
   * The journal of the service worker (its only writer). deps: { storage: { get(key), set(key, value) }, now?, setTimer?, clearTimer?,
   * limits? }. Hydration, appends, flushes and clear are serialized; the memory copy is authoritative after hydration, so a late
   * read can never bring back a cleared or older journal. A failed write keeps the events in memory as not persisted.
   */
  function createJournal(deps) {
    const now = deps.now || Date.now;
    const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer || ((id) => clearTimeout(id));
    let chain = Promise.resolve();
    const locked = (fn) => {
      const run = chain.then(fn, fn);
      chain = run.then(() => undefined, () => undefined);
      return run;
    };
    let loaded = false;
    let events = [];
    let pending = [];
    let dropped = 0;
    let expired = 0;
    let clearedAt = 0;
    let seq = 0;
    let persistedSeq = 0;
    let storageError = '';
    let dirty = false;
    let timer = null;

    async function hydrate() {
      if (loaded) return true;
      let stored = null;
      try {
        stored = await deps.storage.get(STORAGE_KEY);
      } catch (_) {
        storageError = 'STORAGE_READ';
        return false; // unread records must not be replaced by a fresh journal
      }
      const raw = stored && Array.isArray(stored.events) ? stored.events : [];
      clearedAt = stored && Number.isFinite(stored.clearedAt) && stored.clearedAt > 0 ? stored.clearedAt : 0;
      dropped += stored && Number.isInteger(stored.dropped) && stored.dropped >= 0 ? stored.dropped : 0;
      expired += stored && Number.isInteger(stored.expired) && stored.expired >= 0 ? stored.expired : 0;
      const clean = raw.map((e) => sanitizeEvent(e)).filter((e) => e && e.seq && e.t > clearedAt).sort((a, b) => a.seq - b.seq);
      seq = clean.reduce((m, e) => Math.max(m, e.seq), 0);
      persistedSeq = seq;
      // a newer in-memory state (events appended before hydration) is merged after the stored ones, never replaced by them
      events = clean;
      loaded = true;
      storageError = '';
      return true;
    }

    async function write() {
      try {
        await deps.storage.set(STORAGE_KEY, { v: 1, events, dropped, expired, clearedAt });
        persistedSeq = seq;
        dirty = false;
        storageError = '';
        return true;
      } catch (_) {
        storageError = 'STORAGE_WRITE';
        return false;
      }
    }

    function schedule() {
      if (timer !== null) return;
      timer = setTimer(() => { timer = null; void flush(); }, pending.length >= FLUSH_AT ? 0 : FLUSH_MS);
    }

    function flush() {
      return locked(async () => {
        if (!await hydrate()) return false;
        if (!pending.length && !dirty) return true;
        const batch = pending.filter((e) => e.t > clearedAt);
        pending = [];
        for (const e of batch) { e.seq = ++seq; events.push(e); }
        const p = prune(events, now(), deps.limits);
        events = p.events;
        dropped += p.dropped;
        expired += p.expired;
        dirty = true;
        return write();
      });
    }

    return {
      STORAGE_KEY,
      /** Queues one event (sanitized against `ctx`); a bounded batch is written shortly after. Never throws. */
      append(raw, ctx) {
        try {
          const ev = sanitizeEvent(raw, ctx);
          if (!ev) return false;
          delete ev.seq;
          if (pending.length >= MAX_PENDING) { pending.shift(); dropped++; }
          pending.push(ev);
          schedule();
          return true;
        } catch (_) {
          return false;
        }
      },
      flush,
      /** Every retained event (sanitized again), oldest first, with the counters. Pending events are written first. */
      list() {
        return flush().then(() => locked(async () => {
          const p = prune(loaded ? events : pending, now(), deps.limits);
          if (p.dropped || p.expired) {
            dropped += p.dropped;
            expired += p.expired;
            if (loaded) {
              events = p.events;
              dirty = true;
              await write();
            } else pending = p.events;
          }
          const out = p.events.map((e) => sanitizeEvent(e)).filter(Boolean);
          return {
            events: out,
            retained: out.length,
            persisted: out.filter((e) => e.seq <= persistedSeq).length,
            dropped,
            expired,
            bytes: p.bytes,
            storageError
          };
        }));
      },
      /** Removes only the journal; resolves after the empty journal and its clear boundary are written, else rejects. */
      clear() {
        if (timer !== null) { clearTimer(timer); timer = null; }
        return locked(async () => {
          if (!await hydrate()) throw new Error('STORAGE_READ');
          const boundary = Math.max(now(), clearedAt + 1);
          await deps.storage.set(STORAGE_KEY, { v: 1, events: [], dropped: 0, expired: 0, clearedAt: boundary });
          clearedAt = boundary;
          events = [];
          pending = pending.filter((e) => e.t > boundary);
          dropped = 0;
          expired = 0;
          persistedSeq = seq;
          dirty = false;
          storageError = '';
          return true;
        });
      }
    };
  }

  // ---- the producer client (content scripts, extension pages) -------------------------------------------------------------------
  let clientInstance = null;
  const EARLY_MAX = 50;

  /**
   * The one producer of this document. Off by default; follows `debugEnabled` live (chrome.storage.local), so turning recording off
   * stops sending at once in every open document. Until the preference is read, at most EARLY_MAX events wait; they are sent only if
   * recording turns out to be on. log() never throws and builds details only while recording (a function is called lazily).
   */
  function client(src) {
    if (clientInstance) return clientInstance;
    const api = root.chrome;
    let state = 'unknown';
    let touched = false;
    let early = [];
    const send = (ev) => {
      try {
        const p = api.runtime.sendMessage({ action: 'DEBUG_EVENT', ev });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {
        state = 'off'; // the extension context is gone (reloaded): nothing can be sent from this document any more
      }
    };
    const apply = (on) => {
      state = on ? 'on' : 'off';
      const queued = early;
      early = [];
      if (on) for (const ev of queued) send(ev);
    };
    try {
      if (api.storage.onChanged && typeof api.storage.onChanged.addListener === 'function') {
        api.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes && changes[ENABLED_KEY]) { touched = true; apply(changes[ENABLED_KEY].newValue === true); }
        });
      }
      const got = api && api.storage && api.storage.local && api.storage.local.get(ENABLED_KEY);
      if (got && typeof got.then === 'function') got.then((r) => { if (!touched) apply(Boolean(r) && r[ENABLED_KEY] === true); }, () => { if (!touched) apply(false); });
      else if (!touched) apply(false);
    } catch (_) {
      if (!touched) state = 'off';
    }
    const rand = () => {
      try {
        const b = new Uint8Array(4);
        root.crypto.getRandomValues(b);
        return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      } catch (_) {
        return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
      }
    };
    clientInstance = Object.freeze({
      enabled: () => state === 'on',
      cid: () => (state === 'on' ? rand() : ''), // a correlation id only while recording: an unrecorded click sends nothing extra
      /** log(comp, act, out, why?, details?, extra? { lvl, cid, op }) */
      log(comp, act, out, why, details, extra) {
        if (state === 'off') return;
        try {
          const x = extra || {};
          const ev = sanitizeEvent({
            t: Date.now(), lvl: x.lvl || (out === 'failed' ? 'warn' : 'info'), comp, act, out, why: why || undefined, cid: x.cid, op: x.op,
            d: typeof details === 'function' ? details() : details
          }, { src });
          if (!ev) return;
          if (state === 'unknown') { if (early.length < EARLY_MAX) early.push(ev); return; }
          send(ev);
        } catch (_) { /* a debug failure never reaches the caller */ }
      }
    });
    return clientInstance;
  }

  root.ImageSaverDebug = Object.freeze({
    ENABLED_KEY, STORAGE_KEY, MAX_EVENTS, MAX_BYTES, RETENTION_MS, LEVELS, SOURCES, OUTCOMES,
    hostOf, sanitizeDetails, sanitizeEvent, prune, createJournal, client
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
