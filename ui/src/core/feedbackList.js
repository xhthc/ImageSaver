// Recent save results (UX-02 / UX-04 / UX-06) as a controller: loading, sanitizing, unread failures and their acknowledgement,
// clearing completed results, the deep link to the full page and the live refresh while the page stays open.
//
// - Records come from the background (FEEDBACK_LIST) and pass through ImageSaverFeedback.sanitizeRecord again.
// - Failures are acknowledged (FEEDBACK_MARK_SEEN) only while the list is current (not superseded or disposed) AND
//   visible (setVisible(true), e.g. the History panel of the full page is displayed). A list rendered while hidden keeps
//   its unread failures pending until it becomes visible.
// - UX-06: while the page is open a change of the tracker's storage key (a state transition, a completion, a failure, a
//   cancellation, a clear elsewhere) triggers a new FEEDBACK_LIST request. One storage subscription per controller, removed by
//   dispose(); no timer and no polling. Changes that arrive while a request runs are coalesced into one more request, so the
//   newest answer always wins and nothing is requested in parallel. A superseded or disposed mount neither renders nor acknowledges.
// - Storage/messaging failures are shown as text and never thrown.
import { createStore } from './store.js';
import { operationUrl } from './nav.js';
import { FEEDBACK_KEY, watchStorage } from './keys.js';

/** Chromium brand and major version for the bug report (never the full user agent). */
export function browserLabel(nav) {
  try {
    const brands = (nav && nav.userAgentData && nav.userAgentData.brands) || [];
    const b = brands.find((x) => x.brand === 'Chromium') || brands.find((x) => x.brand === 'Google Chrome');
    return b && /^[0-9]{1,4}$/.test(String(b.version)) ? `${b.brand} ${b.version}` : '';
  } catch (_) {
    return '';
  }
}

const UNAVAILABLE = 'results.error'; // a catalogue key (lib/i18n.js), translated when rendered

/**
 * @param {{ chrome: any, FB: any, navigator?: any }} deps
 * @param {{ limit?: number, focusId?: string, openFull?: boolean, isActive?: () => boolean, visible?: boolean }} [options]
 */
export function createFeedbackList(deps, options = {}) {
  const { chrome: chromeApi, FB } = deps;
  const env = {
    version: (() => { try { return chromeApi.runtime.getManifest().version; } catch (_) { return ''; } })(),
    browser: browserLabel(deps.navigator),
    navigator: deps.navigator,
  };
  const limit = options.limit || FB.LIMITS.maxOps;
  const store = createStore({
    status: 'loading', // 'loading' | 'ready' | 'error'
    records: [],
    unreadIds: [],
    focusId: options.focusId || '',
    error: '',
    clearing: false,
  });

  let disposed = false;
  let visible = options.visible !== false;
  let pendingAck = false;
  let pendingAckIds = [];
  let acking = false;
  let unwatch = null;
  let syncing = false; // a FEEDBACK_LIST request is running
  let dirty = false;   // the storage changed while it ran
  const active = () => !disposed && (typeof options.isActive !== 'function' || options.isActive() !== false);

  const load = async (action, extra = {}) => {
    try {
      const res = await chromeApi.runtime.sendMessage({ action, ...extra });
      if (!res || res.success !== true || !Array.isArray(res.records)) throw new Error('FEEDBACK_UNAVAILABLE');
      store.setState({ error: '' });
      return res.records.map(FB.sanitizeRecord).filter(Boolean);
    } catch (_) {
      store.setState({ error: UNAVAILABLE });
      return null;
    }
  };

  async function acknowledge() {
    if (!pendingAck || pendingAckIds.length === 0 || acking || !active() || !visible) return;
    acking = true;
    try {
      while (pendingAck && active() && visible) {
        const displayedIds = new Set(store.getState().records.map((r) => r.id));
        const idsToAck = pendingAckIds.filter((id) => displayedIds.has(id));
        if (idsToAck.length === 0) {
          pendingAck = false;
          pendingAckIds = [];
          break;
        }
        const ok = await load('FEEDBACK_MARK_SEEN', { ids: idsToAck });
        if (!ok) break;
        pendingAckIds = pendingAckIds.filter((id) => !idsToAck.includes(id));
        pendingAck = pendingAckIds.some((id) => displayedIds.has(id));
      }
    } finally {
      acking = false;
    }
  }

  /** Shows a fresh answer. Failures that were unread stay marked "new" while the page lives; fresh unseen ones are acknowledged
   *  only when the list is visible and current. */
  async function apply(records) {
    const prev = store.getState();
    const displayed = records.slice(0, limit);
    const displayedIdSet = new Set(displayed.map((r) => r.id));
    const displayedUnreadNow = displayed.filter((r) => (r.state === 'failed' || r.state === 'interrupted') && !r.seen).map((r) => r.id);
    const unreadNow = records.filter((r) => (r.state === 'failed' || r.state === 'interrupted') && !r.seen).map((r) => r.id);
    const known = new Set(records.map((r) => r.id));
    const unreadIds = Array.from(new Set([...prev.unreadIds, ...unreadNow])).filter((id) => known.has(id));
    store.setState({ status: 'ready', records: displayed, unreadIds });
    pendingAckIds = Array.from(new Set([...pendingAckIds.filter((id) => displayedIdSet.has(id)), ...displayedUnreadNow]));
    pendingAck = pendingAckIds.length > 0;
    if (pendingAck) await acknowledge(); // viewing the (visible, current) list acknowledges failures
  }

  /** One serialized load loop: a change during a request is coalesced into one more request after it. */
  async function sync(initial) {
    if (syncing) { dirty = true; return null; }
    syncing = true;
    let result = null;
    try {
      let first = initial;
      do {
        dirty = false;
        const records = await load('FEEDBACK_LIST');
        if (!active()) return { records: null, cancelled: true };
        if (records) await apply(records);
        else if (first && store.getState().status === 'loading') store.setState({ status: 'error' });
        result = { records };
        first = false;
      } while (dirty && active());
      return result;
    } finally {
      syncing = false;
    }
  }

  async function start() {
    // Subscribe before the first request, so a change during it is not lost.
    if (!unwatch) {
      unwatch = watchStorage(chromeApi, (changes, area) => {
        if ((area === 'session' || area === 'local') && changes[FEEDBACK_KEY]) { void sync(false); }
      });
    }
    return sync(true);
  }

  /** The list became visible or hidden. Becoming visible acknowledges failures that were rendered while hidden. */
  function setVisible(value) {
    visible = value !== false;
    if (visible && pendingAck) acknowledge().catch(() => {});
  }

  async function clear() {
    store.setState({ clearing: true });
    const after = await load('FEEDBACK_CLEAR');
    if (after && !disposed) store.setState({ status: 'ready', records: after.slice(0, limit), unreadIds: [], focusId: '' });
    store.setState({ clearing: false });
    return after;
  }

  /** Explicit user action only: opens the full page at this operation (history section). */
  async function openFull(record) {
    try { await chromeApi.tabs.create({ url: operationUrl(chromeApi, record.id) }); } catch (_) { /* the tab did not open */ }
  }

  function dispose() {
    disposed = true;
    pendingAck = false;
    pendingAckIds = [];
    if (unwatch) { unwatch(); unwatch = null; }
  }

  return { store, env, start, acknowledge, setVisible, clear, openFull, dispose, canOpenFull: Boolean(options.openFull) };
}
