// Storage keys whose change means "the list on this page is out of date". They are the persistence keys of the tracker
// (lib/feedback_tracker.js STORAGE_KEY, session storage with a local fallback) and of the history store
// (lib/feedback_history.js STORAGE_KEY, local storage); test_ux_ui.js asserts that they stay equal. A change is only a
// trigger: the pages re-ask the background through the existing FEEDBACK_LIST / HISTORY_LIST messages, so the sender
// validation, the sanitizing and the retention rules stay in one place and no page reads these keys itself.
export const FEEDBACK_KEY = 'imageSaverFeedbackV1';
export const HISTORY_KEY = 'imageSaverHistoryV1';
export const HISTORY_ENABLED_KEY = 'historyEnabled';

/**
 * Subscribes once to chrome.storage.onChanged and returns the function that removes the subscription (a no-op when the API is
 * unavailable). `handler(changes, area)` runs for every change event; filtering is the caller's.
 */
export function watchStorage(chromeApi, handler) {
  const onChanged = chromeApi && chromeApi.storage && chromeApi.storage.onChanged;
  if (!onChanged || typeof onChanged.addListener !== 'function') return () => {};
  const listener = (changes, area) => { if (changes && typeof changes === 'object') handler(changes, area); };
  onChanged.addListener(listener);
  return () => { try { if (typeof onChanged.removeListener === 'function') onChanged.removeListener(listener); } catch (_) { /* gone with the page */ } };
}
