// The journal producer of the extension pages (DEBUG-MENU-01): user actions and their results as codes only. The shared client sends
// nothing unless recording is on and never throws; the worker takes the page kind from the sender, not from here.
import '../../../lib/debug_journal.js';

/** uiLog(comp, act, out, why?, details?) */
export function uiLog(comp, act, out, why, details) {
  try {
    const D = globalThis.ImageSaverDebug;
    if (!D || !globalThis.chrome || !globalThis.chrome.runtime) return;
    const path = String((globalThis.location && globalThis.location.pathname) || '');
    D.client(path.endsWith('/quick.html') ? 'popup' : 'settings').log(comp, act, out, why, details);
  } catch (_) { /* a debug failure never reaches the page */ }
}
