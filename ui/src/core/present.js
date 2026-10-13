// Presentation helpers shared by the popup list and the history: texts, row parts, statistics wording and clipboard
// access. Pure functions of an allow-listed record (ImageSaverFeedback.sanitizeRecord); no DOM, no chrome.
// UI-LOCALIZATION-01: every text function takes the interface language ('en' | 'ru', Russian by default for older callers) and
// translates through the shared catalogue (lib/i18n.js); records keep no text, so old records follow the selected language.
import { translator } from './i18n.js';

/** Short states shown as an icon in the row. */
export const PENDING_STATES = Object.freeze(['resolving', 'converting', 'saving']);

// Russian texts kept as constants for existing callers; the pages translate the keys 'report.retryHint', 'report.privacy' and 'stats.scope'.
export const RETRY_HINT = translator('ru').t('report.retryHint');
export const REPORT_PRIVACY = translator('ru').t('report.privacy');
export const STATS_SCOPE_NOTE = translator('ru').t('stats.scope');

// Failure texts (UI-COMPLETION-01). The shared taxonomy in lib/feedback.js (classifyFailure/categoryText) explains every category;
// these few manager/resolver codes have no category of their own there, so they get their own catalogue texts here.
const CODE_TEXT = Object.freeze({
  STORAGE_QUOTA: ['failure.storageQuota.title', 'failure.storageQuota.text', 'failure.storageQuota.next'],
  PREPARED_FILE_MISSING: ['failure.preparedMissing.title', 'failure.preparedMissing.text', 'failure.preparedMissing.next'],
  SOURCE_EXPIRED: ['failure.sourceExpired.title', 'failure.sourceExpired.text', 'failure.sourceExpired.next'],
  BATCH_LIMIT: ['failure.batchLimit.title', 'failure.batchLimit.text', 'failure.batchLimit.next'],
  DIRECTORY_ACCESS_REQUIRED: ['failure.directory.title', 'saving.directoryAccess', ''],
  DIRECTORY_WRITE_FAILED: ['failure.directory.title', 'saving.directoryWriteFailed', ''],
  EXPORT_UNCERTAIN: ['failure.uncertain.title', 'saving.exportUncertain', ''],
});
// Manager codes that name an existing category of the shared taxonomy.
const CODE_CATEGORY = Object.freeze({ HTTP_ERROR: 'server_error', INCOMPLETE_BODY: 'network', EXPORT_FAILED: 'download_interrupted' });

function codeText(code, lang) {
  const keys = CODE_TEXT[code];
  if (!keys) return null;
  const { t } = translator(lang);
  return { title: t(keys[0]), explanation: t(keys[1]), nextStep: keys[2] ? t(keys[2]) : '' };
}

/**
 * Localized { title, explanation, nextStep, code } for a download-manager error code. Chrome download interruption reasons
 * (FILE_*, NETWORK_*, SERVER_*, USER_*, CRASH) are classified as download errors; an unknown code is explained as undetermined
 * and kept visible as the code itself.
 */
export function jobFailure(FB, code, lang = 'ru') {
  const c = String(code || '');
  const own = codeText(c, lang);
  if (own) return { ...own, code: c };
  const http = /^HTTP_(\d{3})$/.exec(c);
  const status = http ? Number(http[1]) : null;
  const category = CODE_CATEGORY[c] || FB.classifyFailure(http ? { status } : /^(FILE|NETWORK|SERVER|USER)_|^CRASH$/.test(c) ? { downloadError: c } : { code: c });
  return { ...FB.categoryText(category, status, lang, c), code: c };
}

/**
 * FB.summarize, with the code texts above for a failed/interrupted record whose code has one, so the row and details say the
 * same as the manager card (a storage-quota failure is recorded under download_interrupted, for example). The structured
 * category, stage, status and code lines are left as recorded.
 */
export function summarize(FB, record, lang = 'ru') {
  const summary = FB.summarize(record, lang);
  const own = record.failure && hasReport(record) ? codeText(record.failure.code, lang) : null;
  return own ? { ...summary, ...own } : summary;
}

/**
 * Row texts shared by the popup list and the history: the saved basename is the main text; result, site, type and (for an
 * unconfirmed name) the naming caveat are secondary. Records without a name (older records, failures before naming) keep
 * the previous summary line as the main text. Original names and extensions are shown as they are; sites use display labels.
 */
export function rowParts(FB, record, lang = 'ru') {
  const { t } = translator(lang);
  const summary = summarize(FB, record, lang);
  const site = FB.siteLabel(record.site || record.sourceHost || t('row.siteUnknown'));
  const type = record.output.type !== 'unknown'
    ? ' · ' + t(record.output.type === 'pic' ? 'type.pic' : record.output.type === 'gif' ? 'type.gif' : 'type.video') + (record.output.ext ? ' ' + record.output.ext : '')
    : '';
  if (!record.filename) return { name: '', meta: '', legacy: `${summary.title} — ${site}${type}` };
  const caveat = record.filenameKind === 'actual' ? '' : ` · ${t('row.intended')}`;
  return { name: record.filename, meta: `${summary.title} — ${site}${type}${caveat}`, legacy: '' };
}

export function filenameLine(record, lang = 'ru') {
  if (!record.filename) return '';
  return translator(lang).t(record.filenameKind === 'actual' ? 'filename.actual' : 'filename.intended', { name: record.filename });
}

export function formatTime(ts, locale) {
  try {
    return new Date(ts).toLocaleTimeString(locale || 'ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

export function formatDateTime(ts, locale) {
  try {
    return new Date(ts).toLocaleString(locale || 'ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

/** Writes to the clipboard only on an explicit click; throws when no clipboard is available. */
export async function copyText(text, nav) {
  if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') throw new Error('CLIPBOARD_UNAVAILABLE');
  await nav.clipboard.writeText(text);
}

/** Whether a failed or interrupted result offers the retry hint and the bug report. */
export function hasReport(record) {
  return record.state === 'failed' || record.state === 'interrupted';
}

/** The bug-report text for a record (allow-listed fields only; notes are sanitized by the report builder). The report format is
 *  the same in every interface language. */
export function buildReportText(FB, record, notes, env, now) {
  return FB.buildReport(record, { notes: notes || '', env: { version: env.version, browser: env.browser }, ...(Number.isFinite(now) ? { now } : {}) });
}

/** The validated owning-post URL of a record, or ''. */
export function postUrlOf(FB, record) {
  return FB.safePostUrl(record.postUrl) || '';
}

/**
 * Statistics view over the retained history. state: 'loading' | 'error' | 'ok'. Unknown or estimated metadata is shown
 * as such: types are "verified" only with verified evidence, sizes are summed only from measured values and the
 * coverage is stated. Texts are in `lang`.
 */
export function statsView(FB, records, state, enabled, lang = 'ru') {
  const { t } = translator(lang);
  const view = { note: t('stats.scope'), disabledNote: '', state: 'ok', message: '', tiles: [], types: [], sizeText: '' };
  if (!enabled) view.disabledNote = t('stats.disabled');
  if (state === 'loading') { view.state = 'loading'; view.message = t('stats.loading'); return view; }
  if (state === 'error' || !records) { view.state = 'error'; view.message = t('stats.error'); return view; }
  const s = Array.isArray(records) ? FB.computeStats(records) : records;
  if (!s.total) {
    view.state = 'empty';
    view.message = t(enabled ? 'stats.emptyOn' : 'stats.emptyOff');
    return view;
  }
  view.tiles = [
    { key: 'total', label: t('stats.total'), value: s.total },
    { key: 'success', label: t('stats.success'), value: s.success },
    { key: 'failed', label: t('stats.failed'), value: s.failed },
    { key: 'cancelled', label: t('stats.cancelled'), value: s.cancelled },
    { key: 'unknown', label: t('stats.unknown'), value: s.unknown },
  ];
  const typeRow = (key, label, v) => ({ key, label, value: v.total, detail: t('stats.typeDetail', { verified: v.verified, hinted: v.hinted }) });
  view.types = [
    typeRow('pic', t('stats.type.pic'), s.types.pic),
    typeRow('video', t('stats.type.video'), s.types.video),
    typeRow('gif', t('stats.type.gif'), s.types.gif),
    { key: 'unknown', label: t('stats.type.unknown'), value: s.types.unknown, detail: '' },
  ];
  const covered = s.size.measuredCount;
  view.sizeText = t('stats.size.text', {
    size: covered ? t('stats.size.atLeast', { size: FB.formatSize(s.size.knownBytes, lang) }) : t('stats.size.unknown'),
    covered,
    success: s.success,
    estimated: s.size.estimatedCount ? t('stats.size.estimated', { n: s.size.estimatedCount }) : '',
    missing: s.size.missingCount ? t('stats.size.missing', { n: s.size.missingCount }) : '',
  });
  return view;
}
