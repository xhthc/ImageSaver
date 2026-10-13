// Settings of the full page as a controller. Remaining keys and defaults follow the former popup/popup.js and
// popup/app.js:
// - "Saving" (subfolder, folder organization) and "Embed" (four share hosts) are saved together by the
//   explicit "Save settings" action; nothing is written before it. Input is validated and normalized by the shared
//   folder rules (lib/folder_path.js, the same code the background uses); an over-long or too deep path is rejected, never
//   silently shortened. A share host outside its allow-list falls back to the configured preview default.
//   `dirty` compares these draft fields with the last successfully loaded/saved values; a selected directory handle that is not
//   yet written also counts. A failed save keeps the draft dirty and its error visible until the next attempt.
// - The success-notification preference (`notifySuccess`, default on) is saved immediately; a failed write reverts it.
// - Messages are stored as catalogue keys (lib/i18n.js: '' | key | { key, vars }) and translated when rendered, so a language
//   change also re-renders a message that is already shown.
import { createStore } from './store.js';
import { translator } from './i18n.js';
import { uiLog } from './debuglog.js';

export const ALLOWED_HOSTS = Object.freeze({
  xShareHost: Object.freeze(['x.com', 'fixupx.com', 'cunnyx.com']),
  igShareHost: Object.freeze(['instagram.com', 'oginstagram.com', 'kirkstagram.com']),
  ttShareHost: Object.freeze(['tiktok.com', 'tnktok.com', 'd.tnktok.com']),
  youtubeShareHost: Object.freeze(['youtube.com', 'yfxtube.com', 'koutube.com']),
});

export const DEFAULTS = Object.freeze({
  subfolder: 'SavedImages',
  folderOrganizationMode: 'single',
  saveDirectoryId: '',
  xAuthorFolders: false,
  redditAuthorFolders: false,
  pixivAuthorFolders: false,
  xShareHost: 'fixupx.com',
  igShareHost: 'oginstagram.com',
  ttShareHost: 'tnktok.com',
  youtubeShareHost: 'koutube.com',
});

export const STATUS_MS = 2500;

/** A stored/selected host inside its allow-list, otherwise the preview default. */
export function cleanHost(key, value) {
  return ALLOWED_HOSTS[key].includes(value) ? value : DEFAULTS[key];
}

/**
 * @param {{ chrome: any, FolderPath: any, setTimeout?: any, clearTimeout?: any }} deps
 */
export function createSettings(deps) {
  const { chrome: chromeApi, FolderPath } = deps;
  const directory=deps.directory || (globalThis.indexedDB && globalThis.MediaLatchDirectory?globalThis.MediaLatchDirectory.database(globalThis.indexedDB):null);
  const chooseDirectory=deps.chooseDirectory || (()=>globalThis.showDirectoryPicker({id:'medialatch-media',mode:'readwrite',startIn:'downloads'}));
  let pendingHandle=null;
  const setT = deps.setTimeout || globalThis.setTimeout;
  const clearT = deps.clearTimeout || globalThis.clearTimeout;
  const store = createStore({
    loaded: false,
    ...DEFAULTS,
    saving: false,
    dirty: false,
    directoryName:'',picking:false,directoryError:'',
    status: { message: '', type: '' }, // message: catalogue key or { key, vars }; type: 'success' | 'error' | ''
    notify: { checked: true, error: '' }, // error: catalogue key
  });
  let statusTimer = null;
  let disposed = false;
  let stored = null; // the draft fields as last loaded or saved
  const isDirty = s => !!pendingHandle || (stored !== null && Object.keys(DEFAULTS).some(k => s[k] !== stored[k]));
  /** Applies a draft change and recomputes `dirty` in the same update. */
  const edit = patch => store.setState(s => ({ ...patch, dirty: isDirty({ ...s, ...patch }) }));

  /** Success messages clear themselves; errors stay until the next attempt. */
  function showMessage(message, type = 'success') {
    if (statusTimer) clearT(statusTimer);
    statusTimer = null;
    store.setState({ status: { message, type } });
    if (type === 'success') statusTimer = setT(() => { statusTimer = null; if (!disposed) store.setState({ status: { message: '', type: '' } }); }, STATUS_MS);
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
    const downloads = s.saveDirectoryId?s.directoryName || tr.t('saving.selectedFolder'):tr.t('saving.downloads');
    // the example follows the first selected author service (x.com, Reddit, Pixiv); with none, the plain x.com layout
    const site = s.xAuthorFolders ? 'x' : s.redditAuthorFolders ? 'reddit' : s.pixivAuthorFolders ? 'pixiv' : 'x';
    const author = s.xAuthorFolders || s.redditAuthorFolders ? 'username/' : s.pixivAuthorFolders ? `${tr.t('saving.pixivAuthorExample')}/` : '';
    return { text: s.folderOrganizationMode === 'by_site_and_type' ? `${downloads}/${rootPart}${site}/${author}pic/photo.jpg` : `${downloads}/${rootPart}${author}photo.jpg`, error: false };
  }

  /** Reads the stored settings. Never runs over a loaded draft with unsaved changes (the retry is offered only before loading). */
  async function load() {
    if (store.getState().loaded && store.getState().dirty) return;
    store.setState({ loaded: false, status: { message: '', type: '' } });
    try {
      const data = await chromeApi.storage.local.get(DEFAULTS);
      const directoryId=/^directory-[a-zA-Z0-9-]{1,80}$/.test(data.saveDirectoryId)?data.saveDirectoryId:'';
      const handle=directoryId && directory?await directory.get(directoryId):null;
      const values = {
        subfolder: typeof data.subfolder === 'string' ? data.subfolder : DEFAULTS.subfolder,
        folderOrganizationMode: data.folderOrganizationMode === 'by_site_and_type' ? 'by_site_and_type' : 'single',
        saveDirectoryId:directoryId,xAuthorFolders:data.xAuthorFolders===true,redditAuthorFolders:data.redditAuthorFolders===true,pixivAuthorFolders:data.pixivAuthorFolders===true,
        xShareHost: cleanHost('xShareHost', data.xShareHost),
        igShareHost: cleanHost('igShareHost', data.igShareHost),
        ttShareHost: cleanHost('ttShareHost', data.ttShareHost),
        youtubeShareHost: cleanHost('youtubeShareHost', data.youtubeShareHost),
      };
      const directoryError=directoryId && (!handle || await handle.queryPermission({mode:'readwrite'})!=='granted')?'saving.directoryAccess':'';
      stored = values; pendingHandle = null;
      store.setState({ ...values, directoryName:handle?.name || '', directoryError, loaded: true, dirty: false, status: { message: '', type: '' } });
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
    edit({ [key]: value });
  }

  async function save() {
    const s = store.getState();
    if (!s.loaded || s.saving || s.picking) return false;
    const { root: cleanFolder, changed: folderChanged, error: folderError } = FolderPath.normalizeRoot(s.subfolder);
    if (folderError) {
      // Excessive input is rejected explicitly: nothing is saved and nothing is silently shortened.
      showMessage(describeRootError(folderError), 'error');
      uiLog('settings', 'save', 'refused', folderError === 'too_deep' ? 'FOLDER_TOO_DEEP' : 'FOLDER_TOO_LONG');
      return false;
    }
    const values = {
      subfolder: cleanFolder,
      folderOrganizationMode: s.folderOrganizationMode === 'by_site_and_type' ? 'by_site_and_type' : 'single',
      saveDirectoryId:/^directory-[a-zA-Z0-9-]{1,80}$/.test(s.saveDirectoryId)?s.saveDirectoryId:'',xAuthorFolders:s.xAuthorFolders===true,redditAuthorFolders:s.redditAuthorFolders===true,pixivAuthorFolders:s.pixivAuthorFolders===true,
      xShareHost: cleanHost('xShareHost', s.xShareHost),
      igShareHost: cleanHost('igShareHost', s.igShareHost),
      ttShareHost: cleanHost('ttShareHost', s.ttShareHost),
      youtubeShareHost: cleanHost('youtubeShareHost', s.youtubeShareHost),
    };
    if (statusTimer) clearT(statusTimer);
    statusTimer = null;
    edit({ ...values, saving: true, status: { message: '', type: '' } }); // the fields show the sanitized values
    try {
      const handle = pendingHandle;
      if(handle && values.saveDirectoryId)await directory.set(values.saveDirectoryId,handle);
      await chromeApi.storage.local.set(values);
      stored = values;
      if (pendingHandle === handle) pendingHandle = null;
      edit({}); // edits made while the write was awaited stay unsaved
      console.log('[MediaLatch Popup] Settings saved:', values);
      uiLog('settings', 'save', 'ok', undefined, { mode: values.folderOrganizationMode, fallback: Boolean(folderChanged) });
      showMessage(folderChanged
        ? (cleanFolder ? { key: 'settings.savedCorrected', vars: { folder: cleanFolder } } : 'settings.savedCorrectedRoot')
        : 'settings.saved', 'success');
      return true;
    } catch (saveError) {
      console.error('[MediaLatch Popup] Settings could not be saved:', saveError);
      showMessage('settings.saveFailed', 'error');
      uiLog('settings', 'save', 'failed', 'STORAGE_WRITE');
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
      uiLog('settings', 'notify', 'ok', undefined, { enabled: wanted === true });
    } catch (_) {
      store.setState({ notify: { checked: !wanted, error: 'notify.error.save' } });
      uiLog('settings', 'notify', 'failed', 'STORAGE_WRITE');
    }
  }

  function dispose() { disposed = true; if (statusTimer) clearT(statusTimer); }

  async function pickDirectory(){
    const s=store.getState();if(!s.loaded || s.saving || s.picking)return false;
    store.setState({picking:true,directoryError:''});
    try{
      if(!directory)throw Error('UNSUPPORTED');
      const handle=await chooseDirectory();
      if(await handle.queryPermission({mode:'readwrite'})!=='granted')throw Error('PERMISSION');
      const old=s.saveDirectoryId?await directory.get(s.saveDirectoryId):null;
      const id=old && await handle.isSameEntry(old)?s.saveDirectoryId:'directory-'+(deps.id?deps.id():crypto.randomUUID());
      pendingHandle=handle;edit({saveDirectoryId:id,directoryName:handle.name});return true;
    }catch(e){if(e.name!=='AbortError')store.setState({directoryError:'saving.directoryPickFailed'});return false;}
    finally{store.setState({picking:false});}
  }
  function resetDirectory(){pendingHandle=null;edit({saveDirectoryId:'',directoryName:'',directoryError:''});}

  return { store, load, setField, save, preview, setNotifySuccess, describeRootError, pickDirectory, resetDirectory, dispose };
}
