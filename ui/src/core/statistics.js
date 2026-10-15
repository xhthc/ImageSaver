import { createStore } from './store.js';
import { HISTORY_ENABLED_KEY, watchStorage } from './keys.js';
import '../../../lib/sites.js';

// Group only the view: the worker keeps its individual site counters and deduplication ledger.
const BOORU = new Set(globalThis.MediaLatchSites.SITES.filter(site => site.booru).map(site => site.id));
const sum = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, typeof a[k] === 'number' ? a[k] + b[k] : sum(a[k], b[k])]));
function bucketsOf(res) {
  const buckets = {};
  for (const [site, stats] of Object.entries(res?.sites && typeof res.sites === 'object' ? res.sites : {})) {
    if (!stats || !Number.isFinite(stats.total)) continue;
    const id = BOORU.has(site) ? 'booru' : site;
    buckets[id] = buckets[id] ? sum(buckets[id], stats) : stats;
  }
  return buckets;
}

export function createStatistics({ chrome }) {
  // `site` is only the view: 'all' or a key of `sites`. It is never persisted and no refresh, theme or language change resets it.
  const store = createStore({ enabled: false, prefReady: false, status: 'loading', stats: null, sites: {}, site: 'all', imported: 0, error: '', saving: false, clearing: false, cleared: false });
  let disposed = false, revision = 0, loading = false, dirty = false;
  const set = values => { if (!disposed) store.setState(values); };
  async function load() {
    if (disposed) return;
    if (loading) { dirty = true; return; }
    loading = true;
    do {
      dirty = false;
      try {
        const res = await chrome.runtime.sendMessage({ action: 'STATISTICS_LIST' });
        if (!res?.success || !res.stats || !Number.isFinite(res.stats.total)) throw new Error('STATS');
        set({ stats: res.stats, sites: bucketsOf(res), imported: res.imported || 0, status: 'ready', error: /^statistics[.]pref/.test(store.getState().error) || store.getState().error === 'statistics.clearFailed' ? store.getState().error : '' });
      } catch (_) { set({ status: store.getState().stats ? 'ready' : 'error', error: 'statistics.loadFailed' }); }
    } while (dirty && !disposed);
    loading = false;
  }
  const changed = message => { if (message?.action === 'STATISTICS_CHANGED') void load(); };
  chrome.runtime.onMessage?.addListener(changed);
  const unwatch = watchStorage(chrome, (changes, area) => {
    if (area === 'local' && changes[HISTORY_ENABLED_KEY]) { revision++; set({ enabled: changes[HISTORY_ENABLED_KEY].newValue === true, error: '' }); }
  });
  const ready = (async () => {
    const initial = revision;
    try { const prefs = await chrome.storage.local.get({ [HISTORY_ENABLED_KEY]: false }); if (initial === revision) set({ enabled: prefs[HISTORY_ENABLED_KEY] === true }); }
    catch (_) { if (initial === revision) set({ error: 'statistics.prefReadFailed' }); }
    set({ prefReady: true });
    await load();
  })();
  return {
    store, ready,
    selectSite(site) { if (!disposed && (site === 'all' || Object.hasOwn(store.getState().sites, site))) set({ site }); },
    async setEnabled(enabled) {
      const state = store.getState();
      if (!state.prefReady || state.saving || disposed) return;
      const before = revision;
      set({ saving: true, error: '' });
      try { await chrome.storage.local.set({ [HISTORY_ENABLED_KEY]: enabled }); if (revision === before) set({ enabled }); }
      catch (_) { set({ error: 'statistics.prefSaveFailed' }); }
      set({ saving: false });
    },
    async clear() {
      if (disposed || store.getState().clearing) return;
      set({ clearing: true, cleared: false, error: '' });
      try {
        const res = await chrome.runtime.sendMessage({ action: 'STATISTICS_CLEAR' });
        if (!res?.success || !res.stats) throw new Error('CLEAR');
        set({ stats: res.stats, sites: bucketsOf(res), imported: 0, status: 'ready', cleared: true });
      } catch (_) { set({ error: 'statistics.clearFailed' }); }
      set({ clearing: false });
      // A concurrent completion may have arrived while clear was waiting.
      await load();
    },
    dispose() { disposed = true; unwatch(); chrome.runtime.onMessage?.removeListener(changed); },
  };
}
