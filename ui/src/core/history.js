// Bounded local save history (UX-03) as a controller: the explicit opt-in preference, the retained records, the
// statistics inputs and the durable clear. Behavior is the one of the former popup/history.js.
//
// - Recording is off unless `historyEnabled === true`; an unreadable preference is shown (and treated) as off.
// - Turning recording off never deletes records; "Clear history" (HISTORY_CLEAR) is the only deletion.
// - Failures are shown as text and never thrown; messages are catalogue keys (lib/i18n.js), translated when rendered.
// - UX-06: while the page is open a change of the history store's key (an operation finished, a clear elsewhere) triggers a new
//   HISTORY_LIST request, and a change of the recording preference elsewhere updates the switch. One storage subscription, removed
//   by dispose(); no timer and no polling; a change during a request is coalesced into one more request.
import { createStore } from './store.js';
import { HISTORY_ENABLED_KEY, HISTORY_KEY, watchStorage } from './keys.js';
import { uiLog } from './debuglog.js';

export const ENABLED_KEY = HISTORY_ENABLED_KEY;

/**
 * @param {{ chrome: any, FB: any }} deps
 */
export function createHistory(deps) {
  const { chrome: chromeApi, FB } = deps;
  const store = createStore({
    enabled: false,
    prefReady: false,
    prefError: '',
    status: 'loading', // 'loading' | 'ready' | 'error'
    records: null,
    error: '',
    clearStatus: '',
    clearing: false,
  });
  let disposed = false;
  let unwatch = null;
  let syncing = false;
  let dirty = false;
  // `touched` records a preference changed by the user after the initial read began: an older read must not win.
  let touched = false;

  const load = async (action) => {
    try {
      const res = await chromeApi.runtime.sendMessage({ action });
      if (!res || res.success !== true || !Array.isArray(res.records)) throw new Error('HISTORY_UNAVAILABLE');
      store.setState({ error: res.pruneFailed ? 'history.error.prune' : '' });
      return res.records.map(FB.sanitizeRecord).filter(Boolean);
    } catch (_) {
      store.setState({ error: action === 'HISTORY_CLEAR' ? 'history.error.clear' : 'history.error.load' });
      return null;
    }
  };

  /** One serialized load loop: a change during a request is coalesced into one more request after it. */
  async function sync(initial) {
    if (syncing) { dirty = true; return null; }
    syncing = true;
    let result = null;
    try {
      let first = initial;
      do {
        dirty = false;
        const records = await load('HISTORY_LIST');
        if (disposed) return { records };
        if (records) store.setState({ records, status: 'ready' });
        else if (first || store.getState().status === 'loading') store.setState({ records: null, status: 'error' });
        result = { records };
        first = false;
      } while (dirty && !disposed);
      return result;
    } finally {
      syncing = false;
    }
  }

  async function start() {
    if (!unwatch) {
      unwatch = watchStorage(chromeApi, (changes, area) => {
        if (area !== 'local') return;
        if (changes[HISTORY_KEY]) void sync(false);
        if (changes[ENABLED_KEY]) { touched = true; store.setState({ enabled: changes[ENABLED_KEY].newValue === true }); }
      });
    }
    try {
      const prefs = await chromeApi.storage.local.get({ [ENABLED_KEY]: false });
      if (!touched) store.setState({ enabled: prefs[ENABLED_KEY] === true });
    } catch (_) {
      if (!touched) store.setState({ enabled: false, prefError: 'history.error.prefRead' });
    }
    store.setState({ prefReady: true });
    return sync(true);
  }

  /** The user toggled the preference: shown at once, saved, reverted with a message when the write fails. */
  async function setEnabled(wanted) {
    touched = true;
    const previous = store.getState().enabled;
    store.setState({ enabled: wanted });
    try {
      await chromeApi.storage.local.set({ [ENABLED_KEY]: wanted });
      store.setState({ prefError: '' });
      uiLog('history', 'switch', 'ok', undefined, { enabled: wanted === true });
    } catch (_) {
      store.setState({ enabled: previous, prefError: 'history.error.prefSave' });
      uiLog('history', 'switch', 'failed', 'STORAGE_WRITE');
    }
  }

  async function clear() {
    store.setState({ clearStatus: '', clearing: true });
    const after = await load('HISTORY_CLEAR');
    uiLog('history', 'clear', after ? 'ok' : 'failed', after ? undefined : 'HISTORY_UNAVAILABLE');
    if (after && !disposed) store.setState({ records: after, status: 'ready', clearStatus: 'history.cleared' });
    store.setState({ clearing: false });
    return after;
  }

  /** Statistics over the retained history, or null when it was not loaded. */
  function stats() {
    const { records } = store.getState();
    return Array.isArray(records) ? FB.computeStats(records) : null;
  }

  function dispose() {
    disposed = true;
    if (unwatch) { unwatch(); unwatch = null; }
  }

  return { store, start, setEnabled, clear, stats, dispose };
}
