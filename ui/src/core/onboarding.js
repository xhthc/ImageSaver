import { createStore } from './store.js';
import { watchStorage } from './keys.js';

// FIRST-RUN-SETUP-01: the install welcome of the full page.
// The worker opens popup.html?welcome=1 only for a fresh install (background.js); that URL is the whole "unfinished install" state, so an
// update, a startup or an old profile never shows the welcome. The one stored value is the marker written by an explicit Continue.
// It is never written on load, and the welcome never changes any other preference. There is no manual reopen.
export const ONBOARDING_KEY = 'firstRunGuideDismissed';
export const WELCOME_PARAM = 'welcome';

export function welcomeFromLocation(loc) {
  try { return new URLSearchParams((loc && loc.search) || '').get(WELCOME_PARAM) === '1'; } catch (_) { return false; }
}

/** open = shown now: on the install URL, once the marker is read, until it is set. */
const derive = s => ({ open: s.welcome && s.ready && !s.dismissed });

/** The marker changes only after a successful write; a newer storage event wins over an older read/write. Failures stay visible and retryable. */
export function createOnboarding({ chrome: chromeApi, location }) {
  const store = createStore({ welcome: welcomeFromLocation(location), dismissed: false, ready: false, saving: false, error: '', open: false });
  let revision = 0;
  let disposed = false;
  const set = patch => store.setState(s => { const next = { ...s, ...patch }; return { ...patch, ...derive(next) }; });
  const unwatch = watchStorage(chromeApi, (changes, area) => {
    if (disposed || area !== 'local' || !changes[ONBOARDING_KEY]) return;
    revision++;
    set({ dismissed: changes[ONBOARDING_KEY].newValue === true, error: '' });
  });
  const ready = (async () => {
    const started = revision;
    try {
      const saved = await chromeApi.storage.local.get({ [ONBOARDING_KEY]: false });
      if (!disposed && revision === started) set({ dismissed: saved[ONBOARDING_KEY] === true });
    } catch (_) {
      if (!disposed && revision === started) set({ error: 'onboarding.readFailed' });
    }
    if (!disposed) set({ ready: true });
  })();
  /** Continue. Resolves true once the marker is written and the welcome closed; on a failed write it stays open with an error. */
  async function dismiss() {
    const s = store.getState();
    if (disposed || s.saving || !s.open) return false;
    const started = revision;
    set({ saving: true });
    try {
      await chromeApi.storage.local.set({ [ONBOARDING_KEY]: true });
      if (revision === started) revision++;
      if (!disposed) set({ dismissed: true, saving: false, error: '' });
      return true;
    } catch (_) {
      if (!disposed) set({ saving: false, error: 'onboarding.saveFailed' });
      return false;
    }
  }
  return { store, ready, dismiss, dispose() { disposed = true; unwatch(); } };
}
