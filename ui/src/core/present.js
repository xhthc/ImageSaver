// Presentation helpers shared by the popup list and the history: texts, row parts, statistics wording and clipboard
// access. Pure functions of an allow-listed record (ImageSaverFeedback.sanitizeRecord); no DOM, no chrome.

export const RETRY_HINT = 'Повторное сохранение вручную: щёлкните правой кнопкой по тому же медиа и снова выберите «Сохранить». ' +
  'Автоматический повтор не выполняется: расширение не использует повторно устаревшие подписанные ссылки и не обходит ограничения сайта.';

export const REPORT_PRIVACY = 'Отчёт не отправляется автоматически: он копируется только по нажатию кнопки и не содержит ссылок, путей и токенов.';

/** Short states shown as an icon in the row. */
export const PENDING_STATES = Object.freeze(['resolving', 'converting', 'saving']);

/**
 * Row texts shared by the popup list and the history: the saved basename is the main text; result, site, type and (for an
 * unconfirmed name) the naming caveat are secondary. Records without a name (older records, failures before naming) keep
 * the previous summary line as the main text.
 */
export function rowParts(FB, record) {
  const summary = FB.summarize(record);
  const site = record.site || record.sourceHost || 'сайт неизвестен';
  const type = record.output.type !== 'unknown'
    ? ' · ' + (record.output.type === 'pic' ? 'изображение' : record.output.type === 'gif' ? 'GIF' : 'видео') + (record.output.ext ? ' ' + record.output.ext : '')
    : '';
  if (!record.filename) return { name: '', meta: '', legacy: `${summary.title} — ${site}${type}` };
  const caveat = record.filenameKind === 'actual' ? '' : ' · имя запланировано, не подтверждено';
  return { name: record.filename, meta: `${summary.title} — ${site}${type}${caveat}`, legacy: '' };
}

export function filenameLine(record) {
  if (!record.filename) return '';
  return record.filenameKind === 'actual'
    ? `Имя файла: ${record.filename} (фактическое, по данным Chrome)`
    : `Имя файла: ${record.filename} (запланированное, не подтверждено)`;
}

export function formatTime(ts, locale) {
  try {
    return new Date(ts).toLocaleTimeString(locale || 'ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

export function formatDateTime(ts) {
  try {
    return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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

/** The bug-report text for a record (allow-listed fields only; notes are sanitized by the report builder). */
export function buildReportText(FB, record, notes, env, now) {
  return FB.buildReport(record, { notes: notes || '', env: { version: env.version, browser: env.browser }, ...(Number.isFinite(now) ? { now } : {}) });
}

/** The validated owning-post URL of a record, or ''. */
export function postUrlOf(FB, record) {
  return FB.safePostUrl(record.postUrl) || '';
}

export const STATS_SCOPE_NOTE = 'Статистика описывает только сохранённую историю: не более 50 операций за последние 7 дней. Это не итоги за всё время и не обязательно все загрузки за этот период.';

/**
 * Statistics view over the retained history. state: 'loading' | 'error' | 'ok'. Unknown or estimated metadata is shown
 * as such: types are "подтверждён" only with verified evidence, sizes are summed only from measured values and the
 * coverage is stated.
 */
export function statsView(FB, records, state, enabled) {
  const view = { note: STATS_SCOPE_NOTE, disabledNote: '', state: 'ok', message: '', tiles: [], types: [], sizeText: '' };
  if (!enabled) view.disabledNote = 'Запись истории выключена: уже сохранённые записи остаются, новые операции не добавляются.';
  if (state === 'loading') { view.state = 'loading'; view.message = 'Загрузка статистики…'; return view; }
  if (state === 'error' || !Array.isArray(records)) { view.state = 'error'; view.message = 'Статистика недоступна: история не загружена.'; return view; }
  const s = FB.computeStats(records);
  if (!s.total) {
    view.state = 'empty';
    view.message = enabled ? 'В истории пока нет записей.' : 'В истории нет записей. Включите запись истории, чтобы новые операции учитывались.';
    return view;
  }
  view.tiles = [
    { key: 'total', label: 'Операций в истории', value: s.total },
    { key: 'success', label: 'Успешно сохранено', value: s.success },
    { key: 'failed', label: 'Ошибки и прерывания', value: s.failed },
    { key: 'cancelled', label: 'Отменено', value: s.cancelled },
    { key: 'unknown', label: 'Результат неизвестен (Chrome не сохранил запись о загрузке)', value: s.unknown },
  ];
  const typeRow = (key, label, t) => ({ key, label, value: t.total, detail: `тип подтверждён: ${t.verified}; определён по расширению файла: ${t.hinted}` });
  view.types = [
    typeRow('pic', 'Изображения', s.types.pic),
    typeRow('video', 'Видео', s.types.video),
    typeRow('gif', 'GIF', s.types.gif),
    { key: 'unknown', label: 'Тип не определён', value: s.types.unknown, detail: '' },
  ];
  const covered = s.size.measuredCount;
  const sizeText = covered ? `не менее ${FB.formatSize(s.size.knownBytes)}` : 'неизвестен';
  view.sizeText = `Известный суммарный размер: ${sizeText}. Размер измерен у ${covered} из ${s.success} успешных сохранений${s.size.estimatedCount ? `; оценки по заголовкам (${s.size.estimatedCount}) не суммируются` : ''}${s.size.missingCount ? `; размер неизвестен у ${s.size.missingCount}` : ''}.`;
  return view;
}
