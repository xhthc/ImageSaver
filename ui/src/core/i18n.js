// The interface catalogue of the extension pages. The pages bundle the same classic script that the service worker
// (notifications) and the content scripts (inline buttons) load, so there is one list of texts for the whole extension.
import '../../../lib/i18n.js';

/** ImageSaverI18n: PREF_KEY, valid, resolve, uiLanguage, locale, t, message, read (see lib/i18n.js). */
export const I18n = globalThis.ImageSaverI18n;

/** `t(key, vars)` and the locale of one language; `msg(m)` renders a stored message ('' | key | { key, vars }). */
export function translator(lang) {
  const l = I18n.valid(lang) ? lang : 'en';
  return {
    lang: l,
    locale: I18n.locale(l),
    t: (key, vars) => I18n.t(l, key, vars),
    msg: (m) => I18n.message(l, m),
  };
}
