// The interface language of the extension pages (UI-LOCALIZATION-01) as a controller.
// - A valid saved preference (chrome.storage.local `uiLanguage`: 'en' | 'ru') wins; with none (missing or invalid) the page uses
//   Russian for a Russian browser UI and English otherwise. An invalid stored value is ignored, never rewritten.
// - An unreadable preference shows the browser language and says so; nothing is written because of a failed read.
// - setLanguage() switches only after the write succeeded; a failed write keeps the previous language and reports it, so a
//   successful state is never shown for a value that was not saved.
// - A change made on another extension page (storage.onChanged) applies at once. Other page state (for example unsaved settings
//   edits) lives in its own controller and is not touched by a language change.
import { createStore } from './store.js';
import { watchStorage } from './keys.js';
import { I18n } from './i18n.js';
import { uiLog } from './debuglog.js';

export const LANGUAGE_KEY = I18n.PREF_KEY;

/**
 * @param {{ chrome: any, navigator?: any }} deps
 */
export function createLanguage(deps) {
  const chromeApi = deps.chrome;
  const ui = I18n.uiLanguage(chromeApi, deps.navigator);
  const store = createStore({
    lang: I18n.browserDefault(ui),
    ready: false,
    saving: false,
    error: '', // a message key: 'lang.readFailed' | 'lang.saveFailed'
  });
  let touched = false; // a newer value (event or successful write) arrived after the initial read began
  let changeRevision = 0;
  let disposed = false;

  const unwatch = watchStorage(chromeApi, (changes, area) => {
    if (area !== 'local' || !changes[LANGUAGE_KEY]) return;
    touched = true;
    changeRevision++;
    store.setState({ lang: I18n.resolve(changes[LANGUAGE_KEY].newValue, ui), error: '' });
  });

  const ready = (async () => {
    const local = chromeApi && chromeApi.storage && chromeApi.storage.local;
    const result = local ? await I18n.read(local, ui) : { lang: I18n.browserDefault(ui), error: true };
    if (disposed) return;
    if (!touched) store.setState({ lang: result.lang, error: result.error ? 'lang.readFailed' : '' });
    store.setState({ ready: true });
  })();

  /** Saves and applies a language; returns true only when the write succeeded. */
  async function setLanguage(lang) {
    if (!I18n.valid(lang) || store.getState().saving) return false;
    store.setState({ saving: true });
    const startedRevision = changeRevision;
    try {
      await chromeApi.storage.local.set({ [LANGUAGE_KEY]: lang });
    } catch (_) {
      if (!disposed) store.setState({ saving: false, error: 'lang.saveFailed' });
      uiLog('language', 'set', 'failed', 'STORAGE_WRITE', { lang });
      return false;
    }
    touched = true;
    uiLog('language', 'set', 'ok', undefined, { lang });
    // Storage events already applied the latest committed choice, possibly from another page.
    if (!disposed) store.setState({ ...(changeRevision === startedRevision ? { lang } : {}), saving: false, error: '' });
    return true;
  }

  function dispose() { disposed = true; unwatch(); }

  return { store, ready, setLanguage, dispose };
}
