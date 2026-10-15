// Storage keys the pages watch. FEEDBACK_KEY is the tracker's persistence key (worker/feedback_tracker.js STORAGE_KEY, session storage
// with a local fallback); its change means "the list on this page is out of date" and the page re-asks the background through
// FEEDBACK_LIST, so the sender validation, the sanitizing and the retention rules stay in one place. HISTORY_ENABLED_KEY is the
// recording preference of the statistics switch that the worker reads (background.js statistics). test_ux_ui.js asserts both.
export const FEEDBACK_KEY = 'imageSaverFeedbackV1';
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
