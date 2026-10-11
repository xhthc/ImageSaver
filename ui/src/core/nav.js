// Section navigation of the full extension page. Deep links: popup.html#<section>, popup.html?section=<section>,
// popup.html?op=<operation id> (opens the history section; the results list expands that operation).

export const SECTIONS = Object.freeze(['history', 'saving', 'notifications', 'embed', 'updates', 'debug', 'downloads']);
// Sections served by the explicit "Save settings" button; the others apply immediately.
export const SETTINGS_SECTIONS = Object.freeze(['saving', 'embed']);
export const DEFAULT_SECTION = 'history';

/**
 * Chooses the section from a URL (query ?op= wins, then ?section=, then #hash). Unknown values fall back.
 * @returns {string}
 */
export function sectionFromLocation(loc) {
  try {
    const params = new URLSearchParams((loc && loc.search) || '');
    if (params.get('op')) return 'downloads';
    const q = String(params.get('section'));
    if (SECTIONS.includes(q)) return q;
    const h = String((loc && loc.hash) || '').replace(/^#/, '');
    if (SECTIONS.includes(h)) return h;
  } catch (_) { /* fall through to the default */ }
  return DEFAULT_SECTION;
}

/** The operation id of a ?op= deep link, or ''. */
export function focusIdFromLocation(loc) {
  try { return new URLSearchParams((loc && loc.search) || '').get('op') || ''; } catch (_) { return ''; }
}

const KNOWN_FOR_LINKS = SECTIONS;

/** URL of a section of the full page; an unknown section opens the default one. */
export function pageUrl(chromeApi, section) {
  return chromeApi.runtime.getURL(`popup/popup.html#${KNOWN_FOR_LINKS.includes(section) ? section : 'history'}`);
}

/** Deep link to one operation in the history section. */
export function operationUrl(chromeApi, id) {
  return chromeApi.runtime.getURL(`popup/popup.html?op=${encodeURIComponent(id)}#history`);
}
