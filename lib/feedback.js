// feedback.js - pure helpers for download feedback and bug reports (UX-02 / UX-04).
// Loaded by background.js (importScripts), the popup and the details page. No Chrome APIs here:
// everything is a deterministic function of its input so it can be tested and reused safely.
//
// Privacy model: an operation record is an ALLOWLISTED schema. Source and page URLs are reduced
// to a validated hostname plus a media extension at the moment they are recorded; paths, queries,
// fragments, signed parameters, Blob/data contents and local file paths are never stored.
(function (root) {
  const SCHEMA_VERSION = 1;

  const STATES = Object.freeze(['resolving', 'converting', 'saving', 'complete', 'interrupted', 'cancelled', 'failed']);
  const TERMINAL_STATES = Object.freeze(['complete', 'interrupted', 'cancelled', 'failed']);
  const STAGES = Object.freeze(['resolve', 'verify', 'convert', 'save', 'download']);
  const EXPECTED_TYPES = Object.freeze(['image', 'video', 'gif', 'unknown']);
  const OUTPUT_TYPES = Object.freeze(['pic', 'video', 'gif', 'unknown']);
  const EVIDENCE = Object.freeze(['verified_mime', 'converted_output', 'filename_hint', 'unknown']);
  const CONVERSIONS = Object.freeze(['none', 'x_tweet_video_gif', 'reddit_animation_gif']);
  // Why the extension chose an output other than the converted GIF. Allowlisted: arbitrary text, URLs and tokens are never a reason.
  const REASONS = Object.freeze(['animation_duration_limit', 'animation_size_limit']);
  // The fixed shared policy: a positively identified animation measured above this many seconds is saved as its verified MP4.
  const ANIMATION_GIF_LIMIT_SEC = 30;
  const SAFE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg', '.mp4', '.webm', '.mov', '.m4v', '.ogv']);

  const LIMITS = Object.freeze({
    maxOps: 20,                       // records kept (terminal first evicted)
    retentionMs: 24 * 60 * 60 * 1000, // terminal records older than this are dropped
    text: 160,                        // any single free-text field
    host: 100,
    filename: 120,                    // saved basename (never a path)
    notes: 500,                       // user reproduction notes
    report: 3500                      // whole report
  });

  // Record texts in the two interface languages (UI-LOCALIZATION-01). Every display function takes `lang` ('en' | 'ru'); anything
  // else, including no argument, keeps the original Russian text. The persisted record never stores text, so an old record is
  // shown in the language selected now.
  const textLang = (lang) => (lang === 'en' ? 'en' : 'ru');

  const CATEGORY_TEXT_EN = Object.freeze({
    not_found: ['File not found', 'No suitable media was found.', 'Open the post again: the media may have been removed or the link may be outdated.'],
    server_error: ['Server error', 'The server answered the file request with an error.', 'Try saving again later.'],
    auth: ['Access required', 'The server refused access (sign-in or permissions).', 'Sign in to the site in this browser and save again.'],
    rate_limited: ['Too many requests', 'The site temporarily limited requests.', 'Wait a little and save again.'],
    network: ['Network error', 'The connection was interrupted or timed out.', 'Check the connection and save again.'],
    invalid_content: ['Invalid content', 'The answer does not look like a verified image or video.', 'Open the media on the page and save it from there.'],
    ambiguous_ownership: ['Media could not be identified unambiguously', 'The selected element cannot be reliably linked to a post or player.', 'Right-click directly on the media you want.'],
    conversion_failed: ['Could not convert to GIF', 'The animation conversion did not finish.', 'Save again; if the error repeats, copy the report.'],
    download_interrupted: ['Download interrupted', 'Chrome stopped downloading the file.', 'Check the disk space and folder permissions, then save again.'],
    unsupported_source: ['Source not supported', 'There is no direct file available for this media (for example, only an HLS stream).', 'Saving this kind of source is not supported.'],
    not_archived: ['Original not imported', 'Some original files of this post have not been imported by the site. Those files are unavailable for download.', 'The preview was not saved in their place. Try again after the site imports the post.'],
    unresolved: ['Media could not be determined', 'No available source was found for the selected element.', 'Right-click directly on the image or video.'],
    worker_restarted: ['Interrupted by a restart', 'The extension’s background process restarted before the file was saved.', 'Save again.'],
    outcome_unknown: ['Outcome unknown', 'Chrome no longer keeps the record of this download, so the result is not confirmed.', 'Check the downloads folder; save again if needed.'],
    cancelled: ['Save cancelled', 'The download was cancelled by the user.', ''],
    unknown: ['Reason not determined', 'The extension did not receive enough information about the cause of the error.', 'Save again; if the error repeats, copy the report.']
  });

  const CATEGORY_TEXT = Object.freeze({
    not_found: ['Файл не найден', 'Подходящее медиа не найдено.', 'Откройте пост заново: возможно, медиа удалено или ссылка устарела.'],
    server_error: ['Ошибка сервера', 'Сервер ответил ошибкой на запрос файла.', 'Повторите сохранение позже.'],
    auth: ['Нужен доступ', 'Сервер отказал в доступе (авторизация или права).', 'Войдите в аккаунт на сайте в этом браузере и повторите сохранение.'],
    rate_limited: ['Слишком много запросов', 'Сайт временно ограничил запросы.', 'Подождите немного и повторите сохранение.'],
    network: ['Сетевая ошибка', 'Соединение прервано или превышено время ожидания.', 'Проверьте подключение и повторите сохранение.'],
    invalid_content: ['Недопустимое содержимое', 'Ответ не похож на проверенное изображение или видео.', 'Откройте медиа на странице и сохраните его оттуда.'],
    ambiguous_ownership: ['Не удалось однозначно определить медиа', 'Выбранный элемент нельзя надёжно связать с постом или плеером.', 'Щёлкните правой кнопкой прямо по нужному медиа.'],
    conversion_failed: ['Не удалось конвертировать в GIF', 'Конвертация анимации не завершилась.', 'Повторите сохранение; если ошибка повторяется, скопируйте отчёт.'],
    download_interrupted: ['Загрузка прервана', 'Chrome остановил загрузку файла.', 'Проверьте место на диске и права на папку, затем повторите сохранение.'],
    unsupported_source: ['Источник не поддерживается', 'Для этого медиа нет доступного прямого файла (например, только HLS-поток).', 'Сохранение такого источника не поддерживается.'],
    not_archived: ['Оригинал не импортирован', 'Некоторые оригинальные файлы этого поста ещё не импортированы сайтом. Эти файлы недоступны для скачивания.', 'Превью вместо них не сохранялось. Повторите после того, как сайт импортирует пост.'],
    unresolved: ['Не удалось определить медиа', 'Для выбранного элемента не найден доступный источник.', 'Щёлкните правой кнопкой прямо по картинке или видео.'],
    worker_restarted: ['Операция прервана перезапуском', 'Фоновый процесс расширения был перезапущен до сохранения файла.', 'Повторите сохранение.'],
    outcome_unknown: ['Итог неизвестен', 'Chrome больше не хранит запись об этой загрузке, поэтому результат не подтверждён.', 'Проверьте папку загрузок; при необходимости повторите сохранение.'],
    cancelled: ['Сохранение отменено', 'Загрузка отменена пользователем.', ''],
    unknown: ['Причина не определена', 'Расширение не получило достаточно данных о причине ошибки.', 'Повторите сохранение; если ошибка повторяется, скопируйте отчёт.']
  });

  // ---------------------------------------------------------------------------
  // Text / URL sanitization
  // ---------------------------------------------------------------------------

  // Control, line-separator and bidi-override characters (built from code points, not literals).
const UNSAFE_TEXT_CHARS = new RegExp("[" + [[0, 31], [127, 159], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]
    .map(([lo, hi]) => String.fromCharCode(lo) + "-" + String.fromCharCode(hi)).join("") + "]", "g");

  /** Masks URLs, local paths and secret-looking tokens; strips control/bidi characters; bounds length. */
  function sanitizeText(value, max = LIMITS.text) {
    if (value === null || value === undefined) return '';
    let s = String(value);
    s = s.replace(UNSAFE_TEXT_CHARS, ' ');
    s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi, '[url]');
    s = s.replace(/\b(?:blob|data|file|javascript):[^\s"'<>]*/gi, '[url]');
    s = s.replace(/\b[a-z]:[\\/][^"'<>|?*\r\n]*/gi, '[path]');
    s = s.replace(/\\\\[^"'<>|?*\r\n]+/g, '[path]');
    s = s.replace(/(^|[\s(=:,;'"])\/[\w.\-~%@+]+(?:\/[\w.\-~%@+]*)+/g, '$1[path]');
    s = s.replace(/\b(?:bearer|basic)\s+[a-z0-9._~+\/=-]{8,}/gi, '[redacted]');
    s = s.replace(/\b(?:token|key|secret|password|passwd|auth|authorization|cookie|session|sig|signature|jwt)\s*[=:]\s*\S+/gi, '[redacted]');
    s = s.replace(/[A-Za-z0-9_\-+\/=%.]{32,}/g, '[redacted]');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, Math.max(0, max - 1)).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '…';
    return s;
  }

  /** Reduces a URL to { scheme, host, ext } - the only parts ever retained. */
  function safeUrlParts(url) {
    const empty = { scheme: '', host: '', ext: '' };
    if (typeof url !== 'string' || !url) return empty;
    if (/^blob:/i.test(url)) return { scheme: 'blob', host: '', ext: '' };
    if (/^data:/i.test(url)) return { scheme: 'data', host: '', ext: '' };
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return empty;
      const host = u.hostname.toLowerCase().replace(/\.$/, '');
      const extMatch = /\.[a-z0-9]{2,5}$/.exec(u.pathname.toLowerCase());
      const ext = extMatch && SAFE_EXTENSIONS.includes(extMatch[0]) ? extMatch[0] : '';
      return { scheme: u.protocol.slice(0, -1), host: /^[a-z0-9.-]{1,100}$/.test(host) ? host : '', ext };
    } catch (_) {
      return empty;
    }
  }

  /**
   * Canonical owning-post link, only for providers whose post URL shape is known (X status pages).
   * Anything else returns '' (unknown is never guessed); query, fragment and extra path are dropped.
   */
  function safePostUrl(url) {
    if (typeof url !== 'string' || url.length > 300) return '';
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
      const host = u.hostname.toLowerCase();
      if (host !== 'x.com' && host !== 'www.x.com' && host !== 'twitter.com' && host !== 'www.twitter.com' && host !== 'mobile.twitter.com') return '';
      const m = /^\/([A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status\/(\d{1,25})(?:\/|$)/.exec(u.pathname);
      return m ? `https://x.com/${m[1]}/status/${m[2]}` : '';
    } catch (_) {
      return '';
    }
  }

  function safeHost(url) {
    return safeUrlParts(url).host;
  }

  // Any scheme:// form, plus blob:/data:/javascript:/about:/filesystem:/view-source:. Windows drive paths
  // (C:\dir, C:/dir), UNC and POSIX paths do not match.
  const URL_LIKE = /^(?:[a-z][a-z0-9+.-]+:\/\/|(?:blob|data|javascript|about|filesystem|view-source):)/i;

  /**
   * Reduces a path or name to a bounded, display-safe BASENAME. Handles Windows and POSIX separators,
   * strips control/bidi characters and never returns a directory, drive or URL. Ordinary Unicode and the
   * extension are preserved (an over-long name keeps its extension). Returns '' when nothing usable remains.
   */
  function safeBasename(value) {
    if (typeof value !== 'string' || !value) return '';
    // URL-like input is rejected whole, BEFORE truncation or segment extraction (the prefix would be lost and
    // the last segment, query and fragment would look like a file name). A URL is never turned into a name.
    if (URL_LIKE.test(value.replace(UNSAFE_TEXT_CHARS, ' ').trimStart().slice(0, 64))) return '';
    let s = value.slice(-1024).replace(UNSAFE_TEXT_CHARS, '_');
    s = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1).trim();
    if (!s || s === '.' || s === '..') return '';
    const max = LIMITS.filename;
    if (s.length > max) {
      const ext = (/\.[^.\s]{1,10}$/.exec(s) || [''])[0];
      const stem = s.slice(0, Math.max(1, max - ext.length - 1)).replace(/[\uD800-\uDBFF]$/, '');
      s = stem + '…' + ext;
    }
    return s;
  }

  function extensionOf(filename) {
    const m = /\.[a-z0-9]{2,5}$/.exec(String(filename || '').toLowerCase());
    return m && SAFE_EXTENSIONS.includes(m[0]) ? m[0] : '';
  }

  /** Allows only a leading machine-code token (NOT_FOUND, or "CODE: detail"); any other text is dropped. */
  function normalizeCode(value) {
    if (typeof value !== 'string') return '';
    const m = /^\s*([A-Z][A-Z0-9_]{2,47})(?=$|:)/.exec(value);
    if (!m || /^(HTTP|HTTPS|ERROR|FAIL|FAILED|WARN|WARNING|NULL|UNDEFINED|TRUE|FALSE|NAN)$/.test(m[1])) return '';
    return m[1];
  }

  function normalizeStatus(value) {
    return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
  }

  function pick(list, value, fallback) {
    return list.includes(value) ? value : fallback;
  }

  function finiteNumber(value, min, max) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
  }

  function normalizeReason(value) {
    return REASONS.includes(value) ? value : '';
  }

  /** A measured or configured number of seconds: finite and bounded, else null. */
  function normalizeSeconds(value) {
    return finiteNumber(value, 0, 36000);
  }

  /**
   * The policy explanation of a record, or null: an allowlisted reason, a finite measured duration strictly above the fixed
   * threshold and the fixed threshold itself. Anything else (unknown reason, invalid or inconsistent numbers) explains nothing.
   */
  function durationLimitOf(record) {
    const r = record && typeof record === 'object' ? record : {};
    const o = r.output && typeof r.output === 'object' ? r.output : {};
    const reason = normalizeReason(r.reason) || normalizeReason(o.reason);
    const d1 = normalizeSeconds(r.durationSec);
    const t1 = normalizeSeconds(r.thresholdSec);
    const duration = d1 !== null ? d1 : normalizeSeconds(o.durationSec);
    const threshold = t1 !== null ? t1 : normalizeSeconds(o.thresholdSec);
    return reason === 'animation_duration_limit' && duration !== null && threshold === ANIMATION_GIF_LIMIT_SEC && duration > threshold
      ? { reason, durationSec: duration, thresholdSec: threshold } : null;
  }

  // ---------------------------------------------------------------------------
  // Records (allowlisted schema)
  // ---------------------------------------------------------------------------

  function sanitizeOutput(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const evidence = pick(EVIDENCE, o.evidence, 'unknown');
    const sizeBytes = finiteNumber(o.sizeBytes, 0, 4e9);
    const mime = typeof o.mime === 'string' && /^(image|video)\/[a-z0-9.+-]{1,40}$/.test(o.mime) &&
      (evidence === 'verified_mime' || evidence === 'converted_output') ? o.mime : '';
    return {
      type: pick(OUTPUT_TYPES, o.type, 'unknown'),
      ext: SAFE_EXTENSIONS.includes(o.ext) ? o.ext : '',
      evidence,
      mime,
      sizeBytes,
      sizeKind: sizeBytes === null ? null : pick(['measured', 'estimated'], o.sizeKind, 'estimated'),
      frames: finiteNumber(o.frames, 0, 100000),
      durationSec: finiteNumber(o.durationSec, 0, 36000),
      reason: normalizeReason(o.reason),
      thresholdSec: finiteNumber(o.thresholdSec, 0, 36000)
    };
  }

  function sanitizeFailure(raw) {
    const f = raw && typeof raw === 'object' ? raw : null;
    if (!f) return null;
    return {
      stage: pick(STAGES, f.stage, 'resolve'),
      category: Object.prototype.hasOwnProperty.call(CATEGORY_TEXT, f.category) ? f.category : 'unknown',
      code: normalizeCode(f.code),
      status: normalizeStatus(f.status),
      downloadError: normalizeCode(f.downloadError)
    };
  }

  /** Returns a clean allowlisted copy of untrusted input (storage contents, messages), or null. */
  function sanitizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !/^[a-z0-9-]{6,48}$/.test(raw.id)) return null;
    const createdAt = finiteNumber(raw.createdAt, 1, 1e15);
    if (createdAt === null) return null;
    let noticeTarget = null;
    try {
      const target = raw.noticeTarget;
      const url = new URL(target?.origin);
      if (Number.isSafeInteger(target.tabId) && target.tabId >= 0 && /^https?:$/.test(url.protocol) && url.origin === target.origin && target.origin.length <= 200) noticeTarget = { tabId: target.tabId, origin: url.origin };
    } catch (_) { /* Old records have no notification route. */ }
    return {
      v: SCHEMA_VERSION,
      id: raw.id,
      createdAt,
      updatedAt: finiteNumber(raw.updatedAt, 1, 1e15) || createdAt,
      state: pick(STATES, raw.state, 'failed'),
      attempt: 1,
      site: /^[a-z0-9.-]{1,50}$/.test(raw.site || '') ? raw.site : '',
      sourceHost: /^[a-z0-9.-]{1,100}$/.test(raw.sourceHost || '') ? raw.sourceHost : '',
      sourceExt: SAFE_EXTENSIONS.includes(raw.sourceExt) ? raw.sourceExt : '',
      pageHost: /^[a-z0-9.-]{1,100}$/.test(raw.pageHost || '') ? raw.pageHost : '',
      postUrl: safePostUrl(raw.postUrl),
      filename: safeBasename(raw.filename),
      filenameKind: safeBasename(raw.filename) ? pick(['actual', 'intended'], raw.filenameKind, 'intended') : '',
      expectedType: pick(EXPECTED_TYPES, raw.expectedType, 'unknown'),
      conversion: pick(CONVERSIONS, raw.conversion, 'none'),
      reason: normalizeReason(raw.reason),
      durationSec: finiteNumber(raw.durationSec, 0, 36000),
      thresholdSec: finiteNumber(raw.thresholdSec, 0, 36000),
      fallback: raw.fallback === true,
      downloadId: Number.isInteger(raw.downloadId) && raw.downloadId >= 0 ? raw.downloadId : null,
      output: sanitizeOutput(raw.output),
      failure: sanitizeFailure(raw.failure),
      notified: raw.notified === true,
      seen: raw.seen === true,
      ...(noticeTarget ? { noticeTarget } : {}),
      ...(raw.historyPending === true ? { historyPending: true } : {})
    };
  }

  function isTerminal(state) {
    return TERMINAL_STATES.includes(state);
  }

  // ---------------------------------------------------------------------------
  // Failure classification (plain language, evidence-bound)
  // ---------------------------------------------------------------------------

  /**
   * Maps observed evidence to a category. `status` must be a numeric status the pipeline actually
   * observed; it is never parsed out of message text. Missing evidence stays 'unknown'.
   */
  function classifyFailure({ stage, code, status, downloadError } = {}) {
    const st = normalizeStatus(status);
    const c = normalizeCode(code);
    const d = normalizeCode(downloadError);

    if (d === 'USER_CANCELED' || c === 'USER_CANCELED' || c === 'JOB_CANCELLED_OR_EXPIRED') return 'cancelled';
    if (c === 'WORKER_RESTARTED') return 'worker_restarted';
    if (c === 'DOWNLOAD_OUTCOME_UNKNOWN') return 'outcome_unknown';
    // NOT_FOUND without a status is "the pipeline found nothing", not an HTTP claim; a contradicting status wins.
    if (st === 404 || st === 410 || (c === 'NOT_FOUND' && st === null)) return 'not_found';
    if (st === 401 || st === 403 || c === 'AUTH_REQUIRED' || d === 'SERVER_FORBIDDEN' || d === 'SERVER_UNAUTHORIZED') return 'auth';
    if (st === 429 || c === 'RATE_LIMIT') return 'rate_limited';
    if (st !== null && st >= 500) return 'server_error';
    // the site itself states that it has not imported the originals (BUGFIX-MULTISITE-01): neither a guessed HTTP 404 nor an unresolved click (an observed status still wins)
    if (/^NOT_ARCHIVED(?:_P\d{1,3}_V\d{1,3})?$/.test(c)) return 'not_archived';
    if (/^(AMBIGUOUS|OWNERSHIP)/.test(c)) return 'ambiguous_ownership';
    if (stage === 'convert') return 'conversion_failed';
    if (['HLS_ONLY', 'UNSUPPORTED_SOURCE', 'UNSUPPORTED_MEDIA'].includes(c)) return 'unsupported_source';
    if (c === 'UNRESOLVED_BLOB_MEDIA' || c === 'NO_MEDIA' || c === 'INVALID_PLAN') return 'unresolved';
    if (['NON_IMAGE', 'EMPTY_BODY', 'HTML_PAGE', 'MIME_NOT_VERIFIED', 'INVALID_MEDIA', 'INVALID_CONTAINER'].includes(c) || d === 'SERVER_BAD_CONTENT') return 'invalid_content';
    if (/^NETWORK|TIMEOUT/.test(c) || /^NETWORK/.test(d) || /TIMEOUT/.test(d)) return 'network';
    if (stage === 'download' || d) return 'download_interrupted';
    return 'unknown';
  }

  // The counts a NOT_ARCHIVED_P<n>_V<n> code carries (the site's own missing-files line), else null.
  function missingCounts(code) {
    const m = /^NOT_ARCHIVED_P(\d{1,3})_V(\d{1,3})$/.exec(normalizeCode(code));
    return m ? { photos: Number(m[1]), videos: Number(m[2]) } : null;
  }

  function categoryText(category, status, lang, code) {
    const en = textLang(lang) === 'en';
    const table = en ? CATEGORY_TEXT_EN : CATEGORY_TEXT;
    const t = table[category] || table.unknown;
    let explanation = t[1];
    const counts = category === 'not_archived' ? missingCounts(code) : null;
    if (counts && counts.photos + counts.videos > 0) {
      const ruPhotos = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'изображение' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'изображения' : 'изображений');
      const parts = [];
      if (counts.photos) parts.push(en ? `${counts.photos} full-resolution image${counts.photos === 1 ? '' : 's'}` : `${counts.photos} ${ruPhotos(counts.photos)} в полном размере`);
      if (counts.videos) parts.push(en ? `${counts.videos} video${counts.videos === 1 ? '' : 's'}` : `${counts.videos} видео`);
      explanation += en ? ` The site reports missing: ${parts.join(', ')}.` : ` Сайт сообщает, что отсутствуют: ${parts.join(', ')}.`;
    }
    // The HTTP claim is made only from an observed status, never from the category alone.
    if (category === 'not_found') {
      explanation = status === 404 || status === 410
        ? (en ? `The server answered HTTP ${status}: the file is missing.` : `Сервер ответил HTTP ${status}: файл отсутствует.`)
        : (en ? 'No suitable media was found; no HTTP status was observed.' : 'Подходящее медиа не найдено; HTTP-статус не наблюдался.');
    } else if (category === 'server_error' && Number.isInteger(status)) {
      explanation = en ? `The server answered the file request with HTTP error ${status}.` : `Сервер ответил ошибкой HTTP ${status} на запрос файла.`;
    }
    return { title: t[0], explanation, nextStep: t[2] };
  }

  // ---------------------------------------------------------------------------
  // Display
  // ---------------------------------------------------------------------------

  const DISPLAY = Object.freeze({
    ru: Object.freeze({
      states: Object.freeze({ resolving: 'Определяется источник', converting: 'Конвертация', saving: 'Сохранение', complete: 'Сохранено', interrupted: 'Загрузка прервана', cancelled: 'Отменено', failed: 'Не удалось сохранить' }),
      types: Object.freeze({ pic: 'изображение', video: 'видео', gif: 'GIF', unknown: 'тип неизвестен' }),
      expected: Object.freeze({ image: 'изображение', video: 'видео', gif: 'GIF', unknown: 'неизвестно' }),
      stages: Object.freeze({ resolve: 'определение источника', verify: 'проверка содержимого', convert: 'конвертация', save: 'запуск сохранения', download: 'загрузка файла' }),
      units: ['Б', 'КБ', 'МБ'], decimal: ',',
      typeUnknown: 'тип неизвестен', converted: 'получен конвертацией, формат подтверждён', verified: 'тип подтверждён', hinted: 'по имени файла, тип не подтверждён',
      sizeUnknown: 'размер неизвестен', measured: 'измерено', estimated: 'оценка по заголовкам', stageUnknown: 'неизвестен', siteUnknown: 'сайт неизвестен',
      resource: 'Ресурс', result: 'Результат', expectedLine: (x) => `Ожидался: ${x} (не подтверждено)`,
      conversionDone: 'Конвертация: MP4 → GIF выполнена', conversion: 'Конвертация: MP4 → GIF',
      durationLimit: (d, l) => `Конвертация: не выполнена — длительность анимации ${d} с больше лимита GIF (${l} с); сохранено исходное видео MP4`,
      sizeLimit: 'Конвертация: превышен лимит размера для GIF; сохранено исходное видео MP4',
      fallback: 'Сохранён резервный файл по исходной ссылке: не проверен, не оригинал', size: 'Размер', frames: (n) => `Кадров в GIF: ${n} (измерено при кодировании)`,
      stage: 'Этап', httpStatus: 'HTTP-статус', notObserved: 'не наблюдался', code: 'Код', chromeCode: 'Код Chrome'
    }),
    en: Object.freeze({
      states: Object.freeze({ resolving: 'Finding the source', converting: 'Converting', saving: 'Saving', complete: 'Saved', interrupted: 'Download interrupted', cancelled: 'Cancelled', failed: 'Could not save' }),
      types: Object.freeze({ pic: 'image', video: 'video', gif: 'GIF', unknown: 'type unknown' }),
      expected: Object.freeze({ image: 'image', video: 'video', gif: 'GIF', unknown: 'unknown' }),
      stages: Object.freeze({ resolve: 'finding the source', verify: 'checking the content', convert: 'conversion', save: 'starting the save', download: 'downloading the file' }),
      units: ['B', 'KB', 'MB'], decimal: '.',
      typeUnknown: 'type unknown', converted: 'produced by conversion, format verified', verified: 'type verified', hinted: 'from the file name, type not verified',
      sizeUnknown: 'size unknown', measured: 'measured', estimated: 'estimate from headers', stageUnknown: 'unknown', siteUnknown: 'unknown site',
      resource: 'Resource', result: 'Result', expectedLine: (x) => `Expected: ${x} (not confirmed)`,
      conversionDone: 'Conversion: MP4 → GIF done', conversion: 'Conversion: MP4 → GIF',
      durationLimit: (d, l) => `Conversion: not done — the animation lasts ${d} s, above the GIF limit (${l} s); the source MP4 video was saved`,
      sizeLimit: 'Conversion: the size limit for GIF was exceeded; the source MP4 video was saved',
      fallback: 'A fallback file from the source link was saved: not verified, not the original', size: 'Size', frames: (n) => `GIF frames: ${n} (measured while encoding)`,
      stage: 'Stage', httpStatus: 'HTTP status', notObserved: 'not observed', code: 'Code', chromeCode: 'Chrome code'
    })
  });

  function formatSize(bytes, lang) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
    const d = DISPLAY[textLang(lang)];
    if (bytes < 1024) return `${Math.round(bytes)} ${d.units[0]}`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} ${d.units[1]}`.replace('.', d.decimal);
    return `${(bytes / (1024 * 1024)).toFixed(1)} ${d.units[2]}`.replace('.', d.decimal);
  }

  function describeType(output, lang) {
    const d = DISPLAY[textLang(lang)];
    const type = d.types[output.type] || d.types.unknown;
    const ext = output.ext ? ` ${output.ext}` : '';
    if (output.type === 'unknown') return d.typeUnknown;
    if (output.evidence === 'converted_output') return `${type}${ext} (${d.converted})`;
    if (output.evidence === 'verified_mime') return `${type}${ext} (${d.verified}${output.mime ? ': ' + output.mime : ''})`;
    return `${type}${ext} (${d.hinted})`;
  }

  function describeSize(output, lang) {
    const d = DISPLAY[textLang(lang)];
    if (output.sizeBytes === null) return d.sizeUnknown;
    const label = formatSize(output.sizeBytes, lang);
    return output.sizeKind === 'measured' ? `${label} (${d.measured})` : `≈ ${label} (${d.estimated})`;
  }

  function stageLabel(stage, lang) {
    const d = DISPLAY[textLang(lang)];
    return d.stages[stage] || d.stageUnknown;
  }

  function siteLabel(site) {
    return site === 'x' ? 'x.com' : site;
  }

  /** Human-readable summary of a record for notifications and the UI, in `lang` ('en' | 'ru'; Russian by default). Unknown stays unknown. */
  function summarize(record, lang) {
    const r = record;
    const d = DISPLAY[textLang(lang)];
    const lines = [];
    const site = siteLabel(r.site || r.sourceHost || r.pageHost || d.siteUnknown);
    lines.push(`${d.resource}: ${site}`);
    if (r.state === 'complete' || r.state === 'saving' || r.output.type !== 'unknown') {
      lines.push(`${d.result}: ${describeType(r.output, lang)}`);
    } else {
      lines.push(d.expectedLine(d.expected[r.expectedType]));
    }
    if (r.conversion !== 'none') {
      lines.push(r.state === 'complete' ? d.conversionDone : d.conversion);
    }
    const limit = r.state === 'complete' || r.state === 'saving' ? durationLimitOf(r) : null;
    if (limit) {
      const fmt = (n) => String(Number.isInteger(n) ? n : Math.round(n * 10) / 10).replace('.', d.decimal);
      lines.push(d.durationLimit(fmt(limit.durationSec), fmt(limit.thresholdSec)));
    }
    if ((r.state === 'complete' || r.state === 'saving') && r.conversion === 'none' &&
        r.reason === 'animation_size_limit' && r.output.type === 'video' && r.output.mime === 'video/mp4' && r.output.evidence === 'verified_mime') {
      lines.push(d.sizeLimit);
    }
    if (r.fallback) lines.push(d.fallback);
    if (r.state === 'complete') {
      lines.push(`${d.size}: ${describeSize(r.output, lang)}`);
      if (r.output.frames !== null) lines.push(d.frames(r.output.frames));
    }
    const label = d.states[r.state] || r.state;
    const out = { state: r.state, stateLabel: label, filename: r.filename, filenameKind: r.filenameKind, lines, category: null, title: label, explanation: '', nextStep: '' };
    if (r.failure && (r.state === 'failed' || r.state === 'interrupted' || r.state === 'cancelled')) {
      const text = categoryText(r.failure.category, r.failure.status, lang, r.failure.code);
      out.category = r.failure.category;
      out.title = r.state === 'interrupted' && r.failure.category === 'download_interrupted' ? d.states.interrupted : text.title;
      out.explanation = text.explanation;
      out.nextStep = text.nextStep;
      lines.push(`${d.stage}: ${stageLabel(r.failure.stage, lang)}`);
      lines.push(`${d.httpStatus}: ${r.failure.status === null ? d.notObserved : r.failure.status}`);
      if (r.failure.code) lines.push(`${d.code}: ${r.failure.code}`);
      if (r.failure.downloadError) lines.push(`${d.chromeCode}: ${r.failure.downloadError}`);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Bug report
  // ---------------------------------------------------------------------------

  function expectedActual(r) {
    const expected = r.conversion !== 'none'
      ? 'Animation converted to a genuine GIF and saved'
      : `Selected ${r.expectedType === 'unknown' ? 'media' : r.expectedType} saved in its verified format`;
    let actual;
    if (r.state === 'complete') actual = 'Saved (download completed)';
    else if (r.state === 'cancelled') actual = 'Cancelled by the user';
    else if (r.failure) actual = `Not saved: ${r.failure.category} at stage ${r.failure.stage}`;
    else actual = `Unfinished (${r.state})`;
    return { expected, actual };
  }

  /**
   * Builds the copyable report from an allowlisted record only. `env` = { version, browser } where
   * browser is included only when the caller could read it reliably. `notes` is sanitized user text.
   */
  function buildReport(record, { notes = '', env = {}, now = Date.now() } = {}) {
    const r = sanitizeRecord(record);
    if (!r) return '';
    const f = r.failure;
    const ea = expectedActual(r);
    const line = (k, v) => `${k}: ${v === '' || v === null || v === undefined ? 'unknown' : v}`;
    const version = /^[0-9][0-9A-Za-z.\-+]{0,30}$/.test(env.version || '') ? env.version : 'unknown';
    const out = [
      'MediaLatch bug report',
      line('extension_version', version)
    ];
    if (typeof env.browser === 'string' && /^[A-Za-z][A-Za-z ._-]{0,30} [0-9][0-9.]{0,20}$/.test(env.browser)) out.push(line('browser', env.browser));
    out.push(
      line('timestamp', new Date(finiteNumber(now, 1, 1e15) || Date.now()).toISOString()),
      line('operation_created', new Date(r.createdAt).toISOString()),
      line('correlation_id', r.id),
      line('resource_site', r.site),
      line('source_host', r.sourceHost),
      line('source_extension', r.sourceExt),
      line('page_host', r.pageHost),
      line('expected_type', `${r.expectedType} (unverified)`),
      line('conversion', r.conversion),
      line('fallback_saved', r.fallback ? 'yes (unverified source URL)' : 'no'),
      line('final_state', r.state),
      line('failing_stage', f ? f.stage : (r.state === 'complete' ? 'none' : 'unknown')),
      line('category', f ? f.category : 'none'),
      line('http_status', f ? (f.status === null ? 'not observed' : f.status) : 'not applicable'),
      line('error_code', f ? f.code : ''),
      line('download_error', f ? (f.downloadError || 'not observed') : 'not applicable'),
      line('output_type', r.output.type),
      line('output_extension', r.output.ext),
      line('type_evidence', r.output.evidence),
      line('verified_mime', r.output.mime),
      line('output_size', r.output.sizeBytes === null ? '' : `${r.output.sizeBytes} bytes (${r.output.sizeKind})`),
      line('expected_outcome', ea.expected),
      line('actual_outcome', ea.actual)
    );
    const cleanNotes = sanitizeText(notes, LIMITS.notes);
    out.push(line('user_notes', cleanNotes));
    let text = out.join('\n');
    if (text.length > LIMITS.report) text = text.slice(0, LIMITS.report - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
    return text;
  }

  // ---------------------------------------------------------------------------
  // Statistics over a list of retained (terminal) records - never lifetime totals
  // ---------------------------------------------------------------------------

  /**
   * Counts outcomes, media types and measured size for the given records only. Honest by construction:
   * - outcome "unknown" = Chrome lost the download record (category outcome_unknown), not a guess;
   * - a type counts as verified only with verified_mime / converted_output evidence; a filename hint is
   *   reported separately and a missing type stays "unknown";
   * - only successful saves with a MEASURED size are summed; estimated and missing sizes are counted apart.
   */
  function computeStats(records) {
    const list = (Array.isArray(records) ? records : []).map(sanitizeRecord).filter((r) => r && isTerminal(r.state));
    const mk = () => ({ total: 0, verified: 0, hinted: 0 });
    const s = {
      total: list.length, success: 0, failed: 0, cancelled: 0, unknown: 0,
      types: { pic: mk(), video: mk(), gif: mk(), unknown: 0 },
      size: { knownBytes: 0, measuredCount: 0, estimatedCount: 0, missingCount: 0 }
    };
    for (const r of list) {
      if (r.state === 'complete') {
        s.success++;
        const t = s.types[r.output.type];
        if (t && typeof t === 'object') {
          t.total++;
          if (r.output.evidence === 'verified_mime' || r.output.evidence === 'converted_output') t.verified++;
          else if (r.output.evidence === 'filename_hint') t.hinted++;
        } else {
          s.types.unknown++;
        }
        if (r.output.sizeBytes !== null && r.output.sizeKind === 'measured') { s.size.knownBytes += r.output.sizeBytes; s.size.measuredCount++; }
        else if (r.output.sizeBytes !== null) s.size.estimatedCount++;
        else s.size.missingCount++;
      } else if (r.state === 'cancelled') {
        s.cancelled++;
      } else if (r.failure && r.failure.category === 'outcome_unknown') {
        s.unknown++;
      } else {
        s.failed++;
      }
    }
    return s;
  }

  root.ImageSaverFeedback = Object.freeze({
    SCHEMA_VERSION, STATES, TERMINAL_STATES, STAGES, LIMITS, SAFE_EXTENSIONS,
    REASONS, ANIMATION_GIF_LIMIT_SEC, normalizeReason, normalizeSeconds, durationLimitOf,
    sanitizeText, safeUrlParts, safeHost, safePostUrl, safeBasename, extensionOf, normalizeCode, normalizeStatus,
    sanitizeRecord, isTerminal, classifyFailure, categoryText, siteLabel, summarize, formatSize, buildReport, computeStats
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
