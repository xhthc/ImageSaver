import { createStore } from './store.js';
import { watchStorage } from './keys.js';

export const THEME_KEY = 'uiTheme';
export const THEMES = Object.freeze(['violet', 'blue', 'dark', 'light']);
const DEFAULT_THEME = 'violet';
const clean = value => THEMES.includes(value) ? value : DEFAULT_THEME;

/** The preference changes only after a successful write; newer storage events win over older reads/writes. */
export function createTheme({ chrome: chromeApi, document }) {
  const store = createStore({ theme: DEFAULT_THEME, ready: false, saving: false, error: '' });
  let revision = 0;
  let disposed = false;
  function apply(theme) {
    if (disposed) return;
    const value = clean(theme);
    if (document?.documentElement) {
      document.documentElement.dataset.theme = value;
      document.documentElement.classList.toggle('dark', value !== 'light');
    }
    store.setState({ theme: value });
  }
  apply(DEFAULT_THEME);
  const unwatch = watchStorage(chromeApi, (changes, area) => {
    if (disposed || area !== 'local' || !changes[THEME_KEY]) return;
    revision++;
    apply(changes[THEME_KEY].newValue);
    store.setState({ error: '' });
  });
  const ready = (async () => {
    const started = revision;
    try {
      const saved = await chromeApi.storage.local.get({ [THEME_KEY]: DEFAULT_THEME });
      if (revision === started) apply(saved[THEME_KEY]);
    } catch (_) {
      if (!disposed && revision === started) store.setState({ error: 'theme.readFailed' });
    }
    if (!disposed) store.setState({ ready: true });
  })();
  async function setTheme(value) {
    if (disposed || !store.getState().ready || store.getState().saving || !THEMES.includes(value)) return false;
    const started = revision;
    store.setState({ saving: true });
    try {
      await chromeApi.storage.local.set({ [THEME_KEY]: value });
      if (revision === started) { revision++; apply(value); }
      if (!disposed) store.setState({ saving: false, error: '' });
      return true;
    } catch (_) {
      if (!disposed) store.setState({ saving: false, error: 'theme.saveFailed' });
      return false;
    }
  }
  return { store, ready, setTheme, dispose() { disposed = true; unwatch(); } };
}
