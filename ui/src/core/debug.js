// The debug journal of the full settings page (DEBUG-MENU-01) as a controller.
// - Recording is off unless `debugEnabled === true` (chrome.storage.local); an unreadable preference is shown and treated as off.
//   Turning it off keeps the journal; "Clear journal" (DEBUG_CLEAR) is the only deletion and is reported only after it succeeded.
// - The journal is read only through DEBUG_LIST from the worker (the only page allowed is this one); every event is sanitized again
//   here with the shared allowlist before it is shown, copied or exported. The page is told of new events by DEBUG_CHANGED (one
//   coalesced reload) and of a preference change elsewhere by storage.onChanged. Its own list/refresh traffic is never recorded.
// - Copy and export state exactly what happened (a refused clipboard or a failed file is a visible failure, never a success).
import '../../../lib/debug_journal.js';
import { createStore } from './store.js';
import { watchStorage } from './keys.js';

export const DEBUG = globalThis.ImageSaverDebug;
export const ENABLED_KEY = DEBUG.ENABLED_KEY;
export const SOURCES = DEBUG.SOURCES;
export const LEVELS = DEBUG.LEVELS;
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

/** The searchable text of an event: its codes, ids, host and details (never more than what the journal kept). */
export function eventText(ev) {
  const d = ev.d ? Object.entries(ev.d).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  return [ev.src, ev.comp, ev.act, ev.out, ev.why || '', ev.cid || '', ev.op || '', ev.page || '', d].join(' ').toLowerCase();
}

/** Does an event pass the filters { source: 'all' | source, level: 'all' | minimum level, q: text }? */
export function matches(ev, filters) {
  const f = filters || {};
  if (f.source && f.source !== 'all' && ev.src !== f.source) return false;
  if (f.level && f.level !== 'all' && (LEVEL_RANK[ev.lvl] ?? 1) < (LEVEL_RANK[f.level] ?? 0)) return false;
  const q = String(f.q || '').trim().toLowerCase();
  return !q || q.split(/\s+/).every((w) => eventText(ev).includes(w));
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** Local time with milliseconds: HH:MM:SS.mmm */
export function clock(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** One readable line of an event. */
export function formatEvent(ev) {
  const ctx = [ev.tab !== undefined ? `tab ${ev.tab}` : '', ev.frame !== undefined ? `frame ${ev.frame}` : '', ev.page || ''].filter(Boolean).join(' ');
  const ids = [ev.cid ? `click ${ev.cid}` : '', ev.op ? `op ${ev.op}` : ''].filter(Boolean).join(' ');
  const d = ev.d ? Object.entries(ev.d).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  return [clock(ev.t), ev.lvl.toUpperCase(), ev.src, `${ev.comp}.${ev.act}`, ev.out + (ev.why ? ` ${ev.why}` : ''), ids, ctx, d].filter(Boolean).join(' | ');
}

/** The readable report: a header in the page language, then one line per event (oldest first). */
export function formatReport(events, t, meta) {
  const m = meta || {};
  const head = [
    t('debug.report.title'),
    `version: ${m.version || 'unknown'}`,
    `generated: ${new Date(m.now || Date.now()).toISOString()}`,
    t('debug.counts', { retained: m.retained ?? events.length, dropped: m.dropped ?? 0, expired: m.expired ?? 0 }),
    t('debug.shown', { n: events.length, total: m.retained ?? events.length }),
    ''
  ];
  return head.concat(events.map(formatEvent)).join('\n');
}

/** The JSON export: the shown events, each sanitized again, with the counters. */
export function exportJson(events, meta) {
  const m = meta || {};
  return JSON.stringify({
    kind: 'MediaLatch debug journal',
    version: m.version || 'unknown',
    exportedAt: new Date(m.now || Date.now()).toISOString(),
    retained: m.retained ?? events.length,
    dropped: m.dropped ?? 0,
    expired: m.expired ?? 0,
    events: events.map((e) => DEBUG.sanitizeEvent(e)).filter(Boolean)
  }, null, 2);
}

/**
 * @param {{ chrome: any, navigator?: any, document?: any, URL?: any }} deps
 */
export function createDebug(deps) {
  const { chrome: chromeApi } = deps;
  const store = createStore({
    enabled: false,
    prefReady: false,
    prefError: '',
    status: 'loading', // 'loading' | 'ready' | 'error'
    events: [],
    retained: 0,
    persisted: 0,
    dropped: 0,
    expired: 0,
    storageError: '',
    error: '',
    notice: '', // a catalogue message of the last copy/export/clear: '' | key | { key, vars }
    noticeType: '', // 'success' | 'error'
    clearing: false,
    filters: { source: 'all', level: 'all', q: '' },
  });
  let disposed = false;
  let unwatch = null;
  let onMessage = null;
  let syncing = false;
  let dirty = false;
  let touched = false;
  let generation = 0;

  const request = async (action) => {
    const res = await chromeApi.runtime.sendMessage({ action });
    if (!res || res.success !== true || !Array.isArray(res.events)) throw new Error(res && res.error ? String(res.error) : 'DEBUG_UNAVAILABLE');
    return {
      events: res.events.map((e) => DEBUG.sanitizeEvent(e)).filter(Boolean),
      retained: Number.isInteger(res.retained) ? res.retained : res.events.length,
      persisted: Number.isInteger(res.persisted) ? res.persisted : 0,
      dropped: Number.isInteger(res.dropped) ? res.dropped : 0,
      expired: Number.isInteger(res.expired) ? res.expired : 0,
      storageError: typeof res.storageError === 'string' ? res.storageError : '',
    };
  };

  /** One serialized load loop: a change during a request is coalesced into one more request after it. */
  async function sync(initial) {
    if (syncing || store.getState().clearing) { dirty = true; return null; }
    syncing = true;
    try {
      let first = initial;
      do {
        dirty = false;
        const requestedGeneration = generation;
        try {
          const listed = await request('DEBUG_LIST');
          if (disposed) return listed;
          if (requestedGeneration === generation) store.setState({ ...listed, status: 'ready', error: '' });
        } catch (_) {
          if (disposed) return null;
          if (requestedGeneration === generation) store.setState({ error: 'debug.error.load', ...(first || store.getState().status === 'loading' ? { status: 'error' } : {}) });
        }
        first = false;
      } while (dirty && !disposed && !store.getState().clearing);
      return store.getState();
    } finally {
      syncing = false;
    }
  }

  async function start() {
    if (!unwatch) {
      unwatch = watchStorage(chromeApi, (changes, area) => {
        if (area === 'local' && changes[ENABLED_KEY]) { touched = true; store.setState({ enabled: changes[ENABLED_KEY].newValue === true }); }
      });
    }
    if (!onMessage && chromeApi.runtime && chromeApi.runtime.onMessage && typeof chromeApi.runtime.onMessage.addListener === 'function') {
      onMessage = (message, sender) => {
        if (message && message.action === 'DEBUG_CHANGED' && sender && sender.id === chromeApi.runtime.id && !sender.tab) void sync(false);
      };
      chromeApi.runtime.onMessage.addListener(onMessage);
    }
    try {
      const prefs = await chromeApi.storage.local.get({ [ENABLED_KEY]: false });
      if (!touched) store.setState({ enabled: prefs[ENABLED_KEY] === true });
    } catch (_) {
      if (!touched) store.setState({ enabled: false, prefError: 'debug.error.prefRead' });
    }
    store.setState({ prefReady: true });
    return sync(true);
  }

  /** The user toggled recording: shown at once, saved, reverted with a message when the write fails. */
  async function setEnabled(wanted) {
    touched = true;
    const previous = store.getState().enabled;
    store.setState({ enabled: wanted });
    try {
      await chromeApi.storage.local.set({ [ENABLED_KEY]: wanted === true });
      store.setState({ prefError: '' });
    } catch (_) {
      store.setState({ enabled: previous, prefError: 'debug.error.prefSave' });
    }
  }

  async function clear() {
    if (store.getState().clearing) return false;
    generation++;
    store.setState({ clearing: true, notice: '', noticeType: '' });
    try {
      const listed = await request('DEBUG_CLEAR');
      if (!disposed) store.setState({ ...listed, status: 'ready', error: '', notice: 'debug.cleared', noticeType: 'success' });
      return true;
    } catch (_) {
      if (!disposed) store.setState({ notice: 'debug.error.clear', noticeType: 'error' });
      return false;
    } finally {
      if (!disposed) store.setState({ clearing: false });
      if (dirty && !disposed) void sync(false);
    }
  }

  function setFilters(patch) {
    store.setState({ filters: { ...store.getState().filters, ...(patch || {}) } });
  }

  /** The shown events, newest first. */
  function visible() {
    const s = store.getState();
    return s.events.filter((e) => matches(e, s.filters)).reverse();
  }

  function meta() {
    const s = store.getState();
    let version = '';
    try { version = chromeApi.runtime.getManifest().version; } catch (_) { version = ''; }
    return { version, retained: s.retained, dropped: s.dropped, expired: s.expired, now: Date.now() };
  }

  /** Copies the readable report of the shown events (oldest first); the result is reported truthfully. */
  async function copyReport(t) {
    const shown = visible().reverse();
    try {
      const clip = deps.navigator && deps.navigator.clipboard;
      if (!clip || typeof clip.writeText !== 'function') throw new Error('NO_CLIPBOARD');
      await clip.writeText(formatReport(shown, t, meta()));
      store.setState({ notice: { key: 'debug.copied', vars: { n: shown.length } }, noticeType: 'success' });
      return true;
    } catch (_) {
      store.setState({ notice: 'debug.copyFailed', noticeType: 'error' });
      return false;
    }
  }

  /** Offers the shown events as a JSON file (a local Blob; nothing leaves the device). */
  function downloadJson() {
    const shown = visible().reverse();
    try {
      const doc = deps.document;
      const U = deps.URL;
      if (!doc || !U || typeof U.createObjectURL !== 'function' || typeof Blob !== 'function') throw new Error('NO_DOWNLOAD');
      const href = U.createObjectURL(new Blob([exportJson(shown, meta())], { type: 'application/json' }));
      const a = doc.createElement('a');
      a.href = href;
      a.download = `medialatch-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { U.revokeObjectURL(href); } catch (_) { /* gone with the page */ } }, 60000);
      store.setState({ notice: { key: 'debug.exported', vars: { n: shown.length } }, noticeType: 'success' });
      return true;
    } catch (_) {
      store.setState({ notice: 'debug.exportFailed', noticeType: 'error' });
      return false;
    }
  }

  function dispose() {
    disposed = true;
    if (unwatch) { unwatch(); unwatch = null; }
    if (onMessage) { try { chromeApi.runtime.onMessage.removeListener(onMessage); } catch (_) { /* gone with the page */ } onMessage = null; }
  }

  return { store, start, sync, setEnabled, clear, setFilters, visible, copyReport, downloadJson, dispose };
}
