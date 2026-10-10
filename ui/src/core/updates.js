import { createStore } from './store.js';

export const RELEASES_URL = 'https://github.com/xhthc/MediaLatch/releases';
export const RELEASES_API = 'https://api.github.com/repos/xhthc/MediaLatch/releases?per_page=100';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = 'imageSaverReleaseCheckV3'; // Old endpoint failures must not suppress checks after the repository rename.
const CHANNEL_KEY = 'imageSaverReleaseChannel';
// Error codes of a check and their catalogue keys (lib/i18n.js); the store keeps the key, the page translates it.
const ERRORS = {
  network: 'updates.error.network',
  timeout: 'updates.error.timeout',
  limit: 'updates.error.limit',
  unavailable: 'updates.error.unavailable',
  invalid: 'updates.error.invalid',
};

// Chrome manifest versions have one to four numeric components. Release tags must match the manifest, optionally with v.
export function versionParts(value) {
  if (typeof value !== 'string' || !/^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(value)) return null;
  const parts = value.split('.');
  if (parts.some((p) => Number(p) > 65535 || (p.length > 1 && p[0] === '0'))) return null;
  return Array.from({ length: 4 }, (_, i) => Number(parts[i] || 0));
}

export function isNewer(version, current) {
  const a = versionParts(version), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function cleanRelease(raw, channel) {
  if (!raw || raw.draft !== false || typeof raw.prerelease !== 'boolean' || (channel === 'stable' && raw.prerelease)) return null;
  const tag = raw.tag_name;
  const version = typeof tag === 'string' ? tag.replace(/^v/, '') : '';
  if (!versionParts(version)) return null;
  // Never trust a response-supplied navigation/download URL or render remote Markdown/HTML.
  return { tag_name: tag, version, draft: false, prerelease: raw.prerelease, url: `${RELEASES_URL}/tag/${encodeURIComponent(tag)}` };
}

export function selectRelease(releases, channel) {
  if (!Array.isArray(releases)) throw new Error('invalid');
  let best = null;
  // ponytail: inspect the first 100 published releases; paginate only if the project outgrows that window.
  for (const raw of releases.slice(0, 100)) {
    const next = cleanRelease(raw, channel);
    if (next && (!best || isNewer(next.version, best.version) || (!isNewer(best.version, next.version) && best.prerelease && !next.prerelease))) best = next;
  }
  return best;
}

/** Page-local controller. Opening the Updates tab checks at most daily; a click explicitly bypasses the cache. */
export function createUpdates(deps) {
  const { chrome } = deps;
  const fetchRelease = deps.fetch || globalThis.fetch?.bind(globalThis);
  const now = deps.now || Date.now;
  const setT = deps.setTimeout || globalThis.setTimeout;
  const clearT = deps.clearTimeout || globalThis.clearTimeout;
  const currentVersion = chrome.runtime.getManifest().version;
  const store = createStore({ loaded: false, checking: false, channel: 'stable', currentVersion, release: null, checkedAt: 0, attemptedAt: 0, error: '', notice: '' });
  let pending = null, loading = null, disposed = false, controller = null;

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const data = await chrome.storage.local.get({ [CHANNEL_KEY]: 'stable', [CACHE_KEY]: null });
        const channel = data[CHANNEL_KEY] === 'beta' ? 'beta' : 'stable';
        const cache = data[CACHE_KEY];
        const validTime = (t) => Number.isFinite(t) && t > 0 && t <= now();
        const valid = cache?.channel === channel && validTime(cache.attemptedAt);
        if (!disposed) store.setState({ channel, ...(valid ? {
          release: cleanRelease(cache.release, channel),
          checkedAt: validTime(cache.checkedAt) ? cache.checkedAt : 0,
          attemptedAt: cache.attemptedAt,
          error: Object.hasOwn(ERRORS, cache.error) ? ERRORS[cache.error] : '',
        } : {}) });
      } catch (_) {
        if (!disposed) store.setState({ notice: 'updates.notice.read' });
      }
      if (!disposed) store.setState({ loaded: true });
    })();
    return loading;
  }

  async function check(force = false) {
    await load();
    if (disposed) return;
    if (pending) return pending;
    const state = store.getState();
    if (state.checking) return;
    if (!force && (state.notice || (state.attemptedAt && now() - state.attemptedAt < CHECK_INTERVAL_MS))) return;
    store.setState({ checking: true, error: '', notice: '' });
    controller = new AbortController();
    const signal = controller.signal;
    const timer = setT(() => controller?.abort(), 10000);
    pending = (async () => {
      let release = state.release, checkedAt = state.checkedAt, error = '';
      try {
        const response = await fetchRelease(RELEASES_API, {
          headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal,
        });
        if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'limit' : 'unavailable');
        let releases;
        try { releases = await response.json(); } catch (_) { throw new Error('invalid'); }
        release = selectRelease(releases, state.channel);
        checkedAt = now();
      } catch (e) {
        error = signal.aborted ? 'timeout' : (Object.hasOwn(ERRORS, e?.message) ? e.message : 'network');
      } finally { clearT(timer); }
      if (disposed) return;
      const cache = { channel: state.channel, attemptedAt: now(), checkedAt, release, error };
      let notice = '';
      try { await chrome.storage.local.set({ [CACHE_KEY]: cache }); } catch (_) { notice = 'updates.notice.cache'; }
      if (!disposed) store.setState({ ...cache, error: ERRORS[error] || '', notice, checking: false });
    })();
    try { await pending; } finally { pending = null; controller = null; }
  }

  async function setChannel(channel) {
    if (disposed || pending || store.getState().checking || !['stable', 'beta'].includes(channel) || channel === store.getState().channel) return;
    store.setState({ checking: true });
    try { await chrome.storage.local.set({ [CHANNEL_KEY]: channel }); } catch (_) {
      if (!disposed) store.setState({ checking: false, notice: 'updates.notice.channel' });
      return;
    }
    if (disposed) return;
    store.setState({ channel, release: null, checkedAt: 0, attemptedAt: 0, error: '', notice: '', checking: false });
    await check(true);
  }

  return { store, load, check, setChannel, dispose() { disposed = true; controller?.abort(); } };
}
