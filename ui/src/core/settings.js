// Settings of the full page as a controller. Remaining keys and defaults follow the former popup/popup.js and
// popup/app.js:
// - "Сохранение" (subfolder, folder organization) and "Embed" (four share hosts) are saved together by the
//   explicit "Сохранить настройки" action; nothing is written before it. Input is validated and normalized by the shared
//   folder rules (lib/folder_path.js, the same code the background uses); an over-long or too deep path is rejected, never
//   silently shortened. A share host outside its allow-list falls back to the original service.
// - The success-notification preference (`notifySuccess`, default on) is saved immediately; a failed write reverts it.
import { createStore } from './store.js';

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
    status: { text: '', type: '' }, // type: 'success' | 'error' | ''
    notify: { checked: true, error: '' },
  });
  let statusTimer = null;
  let disposed = false;

  function showMessage(text, type = 'success') {
    if (statusTimer) clearT(statusTimer);
    store.setState({ status: { text, type } });
    statusTimer = setT(() => { statusTimer = null; if (!disposed) store.setState({ status: { text: '', type: '' } }); }, STATUS_MS);
  }

  function describeRootError(error) {
    return error === 'too_deep'
      ? `Слишком много вложенных папок (максимум ${FolderPath.LIMITS.rootDepth})`
      : `Слишком длинный путь подпапки (максимум ${FolderPath.LIMITS.rootLength} символов)`;
  }

  /** The example path under the folder field, or the validation message of the current input. */
  function preview() {
    const s = store.getState();
    const { root: cleanFolder, error } = FolderPath.normalizeRoot(s.subfolder);
    if (error) return { text: describeRootError(error), error: true };
    const rootPart = cleanFolder ? `${cleanFolder}/` : '';
    return { text: s.folderOrganizationMode === 'by_site_and_type' ? `Загрузки/${rootPart}x/pic/photo.jpg` : `Загрузки/${rootPart}photo.jpg`, error: false };
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
        status: { text: '', type: '' },
      });
    } catch (error) {
      console.error('[Image Saver Popup] Ошибка загрузки настроек:', error);
      store.setState({ status: { text: 'Ошибка загрузки настроек. Перезагрузите страницу, чтобы повторить чтение.', type: 'error' } });
    }
    // The notification preference: unreadable storage keeps the documented default (on) and says so.
    try {
      const prefs = await chromeApi.storage.local.get({ notifySuccess: true });
      store.setState({ notify: { checked: prefs.notifySuccess !== false, error: '' } });
    } catch (_) {
      store.setState({ notify: { checked: true, error: 'Не удалось прочитать настройку уведомлений: показано значение по умолчанию (включено).' } });
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
      console.log('[Image Saver Popup] Настройки сохранены:', values);
      showMessage(folderChanged ? `✓ Сохранено. Папка исправлена: ${cleanFolder || 'Загрузки'}` : '✓ Настройки успешно сохранены!', 'success');
      return true;
    } catch (saveError) {
      console.error('[Image Saver Popup] Ошибка сохранения:', saveError);
      showMessage('Не удалось сохранить настройки', 'error');
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
      store.setState({ notify: { checked: !wanted, error: 'Не удалось сохранить настройку уведомлений.' } });
    }
  }

  function dispose() { disposed = true; if (statusTimer) clearT(statusTimer); }

  return { store, load, setField, save, preview, setNotifySuccess, describeRootError, dispose };
}
