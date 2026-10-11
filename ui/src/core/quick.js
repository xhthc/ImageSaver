// Compact toolbar popup (UX-05) as a controller. Behavior is the one of the former popup/quick.js:
// - the gear opens the Saving settings of the full page in a new tab (explicit action, no extra permission) and closes
//   the popup only after the tab was created;
// - the recent-results list is shown only while history recording is enabled (`historyEnabled === true`); while it is off
//   a small invitation offers "Enable history" (explicit click, success only after the write) or a dismissal remembered
//   in `historyInviteDismissed`. Dismissing changes nothing else;
// - changes of either preference elsewhere apply while the popup is open (storage.onChanged);
// - nothing is shown until the preferences were read (no flash of the wrong view); a slower, older storage.get() response
//   never overwrites a value an event or a click set after the read began (`touched`);
// - `mount` identifies the current list mount: a superseded (hidden or disabled) mount is inert.
import { createStore } from './store.js';
import { pageUrl } from './nav.js';
import { uiLog } from './debuglog.js';

export const ENABLED_KEY = 'historyEnabled';
export const DISMISSED_KEY = 'historyInviteDismissed';

/**
 * @param {{ chrome: any, window?: any }} deps
 */
export function createQuick(deps) {
  const chromeApi = deps.chrome;
  const store = createStore({
    ready: false,
    enabled: false,
    dismissed: false,
    mount: 0,       // increments whenever the list is mounted or superseded
    mounted: false, // true while a list mount is current
    inviteError: '',
  });
  const touched = { [ENABLED_KEY]: false, [DISMISSED_KEY]: false };

  /** Re-derives the list mount from the preferences: a mount exists exactly while history is enabled and the page is ready. */
  function sync() {
    const s = store.getState();
    const showList = s.ready && s.enabled;
    const showInvite = s.ready && !s.enabled && !s.dismissed;
    const patch = {};
    if (showList && !s.mounted) { patch.mounted = true; patch.mount = s.mount + 1; }
    else if (!showList && s.mounted) { patch.mounted = false; patch.mount = s.mount + 1; } // supersedes any pending mount
    if (!showInvite && s.inviteError) patch.inviteError = '';
    if (Object.keys(patch).length) store.setState(patch);
  }

  /** The current list mount is still the active one (history enabled, not superseded). */
  const isActive = (mountId) => { const s = store.getState(); return s.mounted && s.mount === mountId && s.enabled; };

  async function openSettings(section = 'saving') {
    try {
      await chromeApi.tabs.create({ url: pageUrl(chromeApi, section) });
    } catch (_) {
      uiLog('popup', 'settings', 'failed', 'TAB_NOT_OPENED', { section });
      return; // the tab did not open: the popup stays open
    }
    uiLog('popup', 'settings', 'ok', undefined, { section });
    if (deps.window && typeof deps.window.close === 'function') deps.window.close();
  }

  async function enableHistory() {
    try {
      await chromeApi.storage.local.set({ [ENABLED_KEY]: true });
    } catch (_) {
      store.setState({ inviteError: 'quick.error.enable' }); // a catalogue key (lib/i18n.js)
      uiLog('popup', 'history', 'failed', 'STORAGE_WRITE');
      return; // history stays disabled
    }
    uiLog('popup', 'history', 'ok', undefined, { enabled: true });
    touched[ENABLED_KEY] = true;
    store.setState({ enabled: true });
    sync();
  }

  async function dismissInvite() {
    try {
      await chromeApi.storage.local.set({ [DISMISSED_KEY]: true });
    } catch (_) {
      store.setState({ inviteError: 'quick.error.dismiss' });
      uiLog('popup', 'invite', 'failed', 'STORAGE_WRITE');
      return; // the invitation stays visible; nothing else is touched
    }
    uiLog('popup', 'invite', 'ok', undefined, null);
    touched[DISMISSED_KEY] = true;
    store.setState({ dismissed: true });
    sync();
  }

  // Preferences changed elsewhere (full page, another popup) apply immediately.
  const onChanged = chromeApi.storage && chromeApi.storage.onChanged;
  if (onChanged && typeof onChanged.addListener === 'function') {
    onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;
      const patch = {};
      if (changes[ENABLED_KEY]) { touched[ENABLED_KEY] = true; patch.enabled = changes[ENABLED_KEY].newValue === true; }
      if (changes[DISMISSED_KEY]) { touched[DISMISSED_KEY] = true; patch.dismissed = changes[DISMISSED_KEY].newValue === true; }
      if (Object.keys(patch).length) { store.setState(patch); sync(); }
    });
  }

  const ready = (async () => {
    const patch = {};
    try {
      const prefs = await chromeApi.storage.local.get({ [ENABLED_KEY]: false, [DISMISSED_KEY]: false });
      // Apply only keys that nothing newer has set (an older response must not win over an event).
      if (!touched[ENABLED_KEY]) patch.enabled = prefs[ENABLED_KEY] === true;
      if (!touched[DISMISSED_KEY]) patch.dismissed = prefs[DISMISSED_KEY] === true;
    } catch (_) {
      if (!touched[ENABLED_KEY]) patch.enabled = false; // unreadable: disabled, invitation shown
      if (!touched[DISMISSED_KEY]) patch.dismissed = false;
    }
    store.setState({ ...patch, ready: true });
    sync();
  })();

  return { store, ready, isActive, openSettings, enableHistory, dismissInvite };
}
