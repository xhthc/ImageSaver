// Settings of the full page as a controller. Remaining keys and defaults follow the former popup/popup.js and
// popup/app.js:
// - "Saving" (subfolder, folder organization) and "Embed" (four share hosts) are saved together by the
//   explicit "Save settings" action; nothing is written before it. Input is validated and normalized by the shared
//   folder rules (lib/folder_path.js, the same code the background uses); an over-long or too deep path is rejected, never
//   silently shortened. A share host outside its allow-list falls back to the original service.
// - The success-notification preference (`notifySuccess`, default on) is saved immediately; a failed write reverts it.
// - Messages are stored as catalogue keys (lib/i18n.js: '' | key | { key, vars }) and translated when rendered, so a language
//   change also re-renders a message that is already shown.
import { createStore } from './store.js';
import { translator } from './i18n.js';

export const ALLOWED_HOSTS = Object.freeze({
  xShareHost: Object.freeze(['x.com', 'fixupx.com', 'cunnyx.com']),
  igShareHost: Object.freeze(['instagram.com', 'oginstagram.com', 'kirkstagram.com']),
  ttShareHost: Object.freeze(['tiktok.com', 'tnktok.com', 'd.tnktok.com']),
  youtubeShareHost: Object.freeze(['youtube.com', 'yfxtube.com', 'koutube.com']),
});

export const DEFAULTS = Object.freeze({
  subfolder: 'SavedImages',
  folderOrganizationMode: 'single',
  xShareHost: 'x.com',
  igShareHost: 'instagram.com',
  ttShareHost: 'tiktok.com',
  youtubeShareHost: 'youtube.com',
});

export const STATUS_MS = 2500;

/** A stored/selected host inside its allow-list, otherwise the default (original service). */
export function cleanHost(key, value) {
  return ALLOWED_HOSTS[key].includes(value) ? value : DEFAULTS[key];
}

/**
 * @param {{ chrome: any, FolderPath: any, setTimeout?: any, clearTimeout?: any }} deps
 */
export function createSettings(deps) {
  const { chrome: chromeApi, FolderPath } = deps;
  const setT = deps.setTimeout || globalThis.setTimeout;
  const clearT = deps.clearTimeout || globalThis.clearTimeout;
  const store = createStore({
    loaded: false,
    ...DEFAULTS,
    saving: false,
    status: { message: '', type: '' }, // message: catalogue key or { key, vars }; type: 'success' | 'error' | ''
    notify: { checked: true, error: '' }, // error: catalogue key
  });
  let statusTimer = null;
  let disposed = false;

  function showMessage(message, type = 'success') {
    if (statusTimer) clearT(statusTimer);
    store.setState({ status: { message, type } });
    statusTimer = setT(() => { statusTimer = null; if (!disposed) store.setState({ status: { message: '', type: '' } }); }, STATUS_MS);
  }

  /** The validation message of a rejected folder input, as a catalogue message. */
  function describeRootError(error) {
    return error === 'too_deep'
      ? { key: 'settings.error.tooDeep', vars: { max: FolderPath.LIMITS.rootDepth } }
      : { key: 'settings.error.tooLong', vars: { max: FolderPath.LIMITS.rootLength } };
  }

  /** The example path under the folder field, or the validation message of the current input, in `lang` (Russian by default). */
  function preview(lang = 'ru') {
    const tr = translator(lang);
    const s = store.getState();
    const { root: cleanFolder, error } = FolderPath.normalizeRoot(s.subfolder);
    if (error) return { text: tr.msg(describeRootError(error)), error: true };
    const rootPart = cleanFolder ? `${cleanFolder}/` : '';
    const downloads = tr.t('saving.downloads');
    return { text: s.folderOrganizationMode === 'by_site_and_type' ? `${downloads}/${rootPart}x/pic/photo.jpg` : `${downloads}/${rootPart}photo.jpg`, error: false };
  }

  async function load() {
    store.setState({ loaded: false });
    try {
      const data = await chromeApi.storage.local.get(DEFAULTS);
      store.setState({
        subfolder: typeof data.subfolder === 'string' ? data.subfolder : DEFAULTS.subfolder,
        folderOrganizationMode: data.folderOrganizationMode === 'by_site_and_type' ? 'by_site_and_type' : 'single',
        xShareHost: cleanHost('xShareHost', data.xShareHost),
        igShareHost: cleanHost('igShareHost', data.igShareHost),
        ttShareHost: cleanHost('ttShareHost', data.ttShareHost),
        youtubeShareHost: cleanHost('youtubeShareHost', data.youtubeShareHost),
        loaded: true,
        status: { message: '', type: '' },
      });
    } catch (error) {
      console.error('[MediaLatch Popup] Settings could not be loaded:', error);
      store.setState({ status: { message: 'settings.error.load', type: 'error' } });
    }
    // The notification preference: unreadable storage keeps the documented default (on) and says so.
    try {
      const prefs = await chromeApi.storage.local.get({ notifySuccess: true });
      store.setState({ notify: { checked: prefs.notifySuccess !== false, error: '' } });
    } catch (_) {
      store.setState({ notify: { checked: true, error: 'notify.error.read' } });
    }
  }

  /** Edits the form only; nothing is persisted before save(). */
  function setField(key, value) {
    if (!(key in DEFAULTS)) return;
    store.setState({ [key]: value });
  }

  async function save() {
    const s = store.getState();
    if (!s.loaded || s.saving) return false;
    const { root: cleanFolder, changed: folderChanged, error: folderError } = FolderPath.normalizeRoot(s.subfolder);
    if (folderError) {
      // Excessive input is rejected explicitly: nothing is saved and nothing is silently shortened.
      showMessage(describeRootError(folderError), 'error');
      return false;
    }
    const values = {
      subfolder: cleanFolder,
      folderOrganizationMode: s.folderOrganizationMode === 'by_site_and_type' ? 'by_site_and_type' : 'single',
      xShareHost: cleanHost('xShareHost', s.xShareHost),
      igShareHost: cleanHost('igShareHost', s.igShareHost),
      ttShareHost: cleanHost('ttShareHost', s.ttShareHost),
      youtubeShareHost: cleanHost('youtubeShareHost', s.youtubeShareHost),
    };
    store.setState({ ...values, saving: true }); // the fields show the sanitized values
    try {
      await chromeApi.storage.local.set(values);
      console.log('[MediaLatch Popup] Settings saved:', values);
      showMessage(folderChanged
        ? (cleanFolder ? { key: 'settings.savedCorrected', vars: { folder: cleanFolder } } : 'settings.savedCorrectedRoot')
        : 'settings.saved', 'success');
      return true;
    } catch (saveError) {
      console.error('[MediaLatch Popup] Settings could not be saved:', saveError);
      showMessage('settings.saveFailed', 'error');
      return false;
    } finally {
      store.setState({ saving: false });
    }
  }

  /** Immediate preference: shown at once, saved, reverted with a message when the write fails. */
  async function setNotifySuccess(wanted) {
    store.setState({ notify: { checked: wanted, error: '' } });
    try {
      await chromeApi.storage.local.set({ notifySuccess: wanted });
      store.setState({ notify: { checked: wanted, error: '' } });
    } catch (_) {
      store.setState({ notify: { checked: !wanted, error: 'notify.error.save' } });
    }
  }

  function dispose() { disposed = true; if (statusTimer) clearT(statusTimer); }

  return { store, load, setField, save, preview, setNotifySuccess, describeRootError, dispose };
}
