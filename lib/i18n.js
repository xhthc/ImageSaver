// i18n.js - the extension's English / Russian interface text (UI-LOCALIZATION-01).
// One small catalogue shared by the extension pages (bundled through ui/src/core/i18n.js), the service worker (importScripts:
// notifications) and the content scripts that draw inline buttons (manifest). No Chrome API is required to translate; the
// language helpers only read what they are given.
//
// Language rule: a valid saved preference (`uiLanguage`: 'en' | 'ru' in chrome.storage.local) wins; otherwise Russian for a
// Russian browser UI and English for every other one. An invalid stored value is ignored (never rewritten). Texts are plain
// strings: callers render them as text, never as HTML. Placeholders are {name}; the substituted values are inserted as given.
// Record texts (states, failure explanations, sizes) live with the record schema in lib/feedback.js (summarize(record, lang)).
(function (root) {
  const PREF_KEY = 'uiLanguage';
  const LANGS = Object.freeze(['en', 'ru']);
  // The fixed native context-menu title; identical in both languages (CORE-MEDIA-MENU-01).
  const MENU_TITLE = 'MediaLatch: Save media';

  const STRINGS = {
    en: {
      // full page shell
      'app.title': 'MediaLatch: downloads and settings',
      'app.subtitle': 'Downloads, statistics and settings',
      "tab.downloads": "Downloads",
      "statistics.total": "Operations",
      "statistics.scope": "Totals since recording began or the last clear. No entry or time limit. Stored only on this device; recording does not keep media addresses, filenames or paths.",
      "statistics.disabled": "Recording is off. Existing totals are kept.",
      "statistics.empty": "No recorded operations yet.",
      "statistics.record": "Record statistics",
      "statistics.clear": "Clear statistics for all sites",
      "statistics.cleared": "Statistics cleared for all sites.",
      "statistics.imported": "Imported {n} available old records. Previously expired or removed records cannot be recovered.",
      "statistics.loadFailed": "Could not load statistics.",
      "statistics.prefReadFailed": "Could not read the recording setting; recording is treated as off.",
      "statistics.prefSaveFailed": "Could not save the recording setting.",
      "statistics.clearFailed": "Could not clear statistics; totals were kept.",
      "statistics.site": "Site",
      "statistics.site.all": "All sites",
      "statistics.site.booru": "Booru",
      "statistics.site.x": "X",
      "statistics.site.reddit": "Reddit",
      "statistics.site.pixiv": "Pixiv",
      "statistics.site.redgifs": "RedGIFs",
      "statistics.site.pawchive": "Pawchive",
      "statistics.site.zerochan": "Zerochan",
      "statistics.site.anime-pictures": "Anime-Pictures",
      "statistics.site.danbooru": "Danbooru",
      "statistics.site.rule34": "Rule34",
      "statistics.site.safebooru": "Safebooru",
      "statistics.site.gelbooru": "Gelbooru",
      "statistics.site.realbooru": "Realbooru",
      "statistics.site.xbooru": "Xbooru",
      "statistics.site.hypnohub": "Hypnohub",
      "statistics.site.tbib": "TBIB",
      "statistics.site.curveybooru": "Curveybooru",
      "statistics.site.inkbooru": "Inkbooru",
      "statistics.site.mspabooru": "MSPAbooru",
      "statistics.site.scatbooru": "Scatbooru",
      "statistics.site.yakui": "Yakui",
      "statistics.site.e621": "e621",
      "statistics.site.yande.re": "yande.re",
      "statistics.site.konachan": "Konachan",
      "statistics.site.e-shuushuu": "e-shuushuu",
      "statistics.site.sankaku": "Sankaku",
      "statistics.site.tenor": "Tenor",
      "statistics.site.giphy": "GIPHY",
      "statistics.site.wikimedia": "Wikimedia",
      "statistics.site.vk": "VK",
      "statistics.site.other": "Other sites",
      "statistics.site.unattributed": "Legacy / unattributed",
      "statistics.emptySite": "No recorded operations for this site yet.",
      'app.sections': 'Sections',
      'section.downloads': 'Current and recent saves. Cancel, retry or remove a record from its row.',
      'section.saving': 'Where new files are saved and how their folders are named. Changes apply after Save settings.',
      'section.notifications': 'A notice on the source page once files are saved.',
      'section.updates': 'Check GitHub for a newer release. Installing it stays a manual step.',
      'section.debug': 'An opt-in journal of what the extension did, kept on this device.',
      'tab.history': 'Statistics',
      'tab.saving': 'Saving',
      'tab.notifications': 'Notifications',
      'tab.embed': 'Embed',
      'tab.updates': 'Updates',
      'app.howto.label': 'How to use:',
      'app.howto.text': 'right-click an image, video or post preview and choose',
      'app.howto.menu': '“{title}”',
      // first-run quick start guide (FIRST-RUN-SETUP-01)
      'onboarding.title': 'Quick start',
      'onboarding.intro': 'Three steps to save your first media.',
      'onboarding.steps': 'Quick start steps',
      'onboarding.step1.title': 'Save media',
      'onboarding.step1.text': 'Right-click an image, video or post preview and choose “{title}”. Some supported sites also show a Save button on the media. On x.com, press Shift while right-clicking if the site hides the browser menu. Not every site or file is supported.',
      'onboarding.step2.title': 'Choose where files go',
      'onboarding.step2.text': 'Files go to your browser’s Downloads folder unless you choose another one. A change applies only after you press Save settings.',
      'onboarding.step3.title': 'Follow progress',
      'onboarding.step3.text': 'A notice appears on the page when a save finishes or fails. Open the download manager to see progress, retry or cancel.',
      'onboarding.continue': 'Continue',
      'onboarding.loading': 'Loading…',
      'onboarding.readFailed': 'Could not check whether this guide was already closed. It stays open; Continue will try to remember your choice.',
      'onboarding.saveFailed': 'Could not remember that the guide is closed. It stays open; press Continue again.',
      'app.credits.label': 'Interface:',
      'app.credits.and': 'and',
      'app.credits.licenses': 'Licenses:',
      // language preference
      'lang.label': 'Language',
      'theme.label': 'Theme',
      'theme.blue': 'Blue',
      'theme.dark': 'Dark',
      'theme.light': 'Light',
      'theme.violet': 'Violet',
      'theme.readFailed': 'Could not read the theme. Violet is shown.',
      'theme.saveFailed': 'Could not save the theme. The previous choice is kept.',
      'lang.saving': 'Saving the language…',
      'lang.saveFailed': 'Could not save the language: the previous choice is kept.',
      'lang.readFailed': 'Could not read the saved language: the browser language is shown.',
      // quick popup
      'downloads.heading':'Downloads', 'downloads.open':'Open download manager', 'downloads.pause':'Pause queue', 'downloads.resume':'Continue queue', 'downloads.clearFinished':'Clear finished records (files and statistics stay)',
      'downloads.pendingName':'Selected media', 'downloads.resolving':'Finding source', 'downloads.converting':'Processing media', 'downloads.preparingHint':'Transfer controls become available after preparation.',
      'downloads.loading':'Loading downloads…', 'downloads.empty':'No downloads yet.', 'downloads.unavailable':'Downloads could not be loaded.',
      'downloads.commandFailed':'The action could not be completed.', 'downloads.queued':'Queued', 'downloads.receiving':'Receiving', 'downloads.validating':'Checking file',
      'downloads.ready':'Ready to save', 'downloads.exporting':'Saving prepared file', 'downloads.complete':'Saved', 'downloads.failed':'Failed', 'downloads.cancelled':'Cancelled',
      'downloads.cancel':'Cancel download', 'downloads.retry':'Retry download', 'downloads.exportAgain':'Save prepared file again', 'downloads.remove':'Remove record and temporary file', 'downloads.removeRecord':'Remove record',
      'downloads.progress':'File progress', 'downloads.unknown':'size unknown', 'downloads.remaining':'about {seconds} s remaining', 'downloads.kept':'Prepared file retained for retry',
      'downloads.retryList': 'Try again',
      // post batch summary (X / Reddit "Save all", multi-file Pixiv and Pawchive posts)
      'downloads.batch.title': '{site} post', 'downloads.batch.allSaved': 'All {count} files saved', 'downloads.batch.saved': 'Saved {saved} of {count}',
      'downloads.batch.failed': '{n} failed', 'downloads.batch.cancelled': '{n} cancelled', 'downloads.batch.skipped': '{n} skipped', 'downloads.batch.remaining': '{n} in progress', 'notice.batchRemaining': '{n} remaining',
      'downloads.batch.partial': 'some originals not imported',
      'downloads.site.files': 'Files: {n}', 'downloads.singles': 'Individual files',
      'downloads.batch.showFiles': 'Show files', 'downloads.batch.hideFiles': 'Hide files',
      'downloads.batch.cancel': 'Cancel remaining', 'downloads.batch.cancelling': 'Cancelling…', 'downloads.batchCancelFailed': 'Could not cancel the remaining files. Try again.',
      'downloads.batch.site.x': 'x.com', 'downloads.batch.site.reddit': 'Reddit', 'downloads.batch.site.pixiv': 'Pixiv', 'downloads.batch.site.pawchive': 'Pawchive', 'downloads.batch.site.vk': 'VK',
      'failure.code': 'Code: {code}',
      'failure.storageQuota.title': 'Local storage is full',
      'failure.storageQuota.text': 'The browser has no room left for the extension’s temporary copy of this file.',
      'failure.storageQuota.next': 'Free some disk space, then retry.',
      'failure.preparedMissing.title': 'Prepared file is gone',
      'failure.preparedMissing.text': 'The temporary copy of this file is no longer available.',
      'failure.preparedMissing.next': 'Save the media again from its page.',
      'failure.sourceExpired.title': 'Source no longer available',
      'failure.sourceExpired.text': 'The original address of this file can no longer be used for a retry.',
      'failure.sourceExpired.next': 'Open the post again and save the media from there.',
      'failure.batchLimit.title': 'Too many media in one post',
      'failure.batchLimit.text': 'The post has more files than one save supports.',
      'failure.batchLimit.next': 'Save the files you need one by one.',
      'failure.directory.title': 'Folder unavailable',
      'failure.uncertain.title': 'Save not confirmed',
      'quick.settings': 'Settings',
      // results list and rows
      'results.error': 'Could not load the save results.',
      'row.new': 'new',
      'row.siteUnknown': 'unknown site',
      'row.intended': 'planned name, not confirmed',
      'type.pic': 'image',
      'type.video': 'video',
      'type.gif': 'GIF',
      'filename.actual': 'File name: {name} (actual)',
      'filename.intended': 'File name: {name} (planned, not confirmed)',
      // details, report, post link
      'details.openFull': 'Open on the history page',
      'report.retryHint': 'To save again manually, right-click the same media and choose “Save” again. For NETWORK_FAILED the browser may make one attempt to resume the current download. The source is not searched again automatically; site restrictions still apply.',
      'report.privacy': 'The report is never sent automatically: it is copied only when you click the button and contains no links, paths or tokens.',
      'report.notes': 'What were you doing (optional)',
      'report.preview': 'Report preview',
      'report.copy': 'Copy report',
      'report.copied': 'Report copied to the clipboard.',
      'report.copyFailed': 'Could not copy automatically. Select the report text and press Ctrl+C.',
      'post.unknown': 'Post link: unknown (the owning post could not be determined reliably).',
      'post.label': 'Post:',
      'post.copy': 'Copy post link',
      'post.copied': 'Link copied to the clipboard.',
      'post.copyFailed': 'Could not copy the link automatically. Open it and copy it from the address bar.',
      // statistics
      'stats.loading': 'Loading statistics…',
      'stats.success': 'Saved successfully',
      'stats.failed': 'Errors and interruptions',
      'stats.cancelled': 'Cancelled',
      'stats.unknown': 'Outcome unknown (Chrome did not keep the download record)',
      'stats.type.pic': 'Images',
      'stats.type.video': 'Videos',
      'stats.type.gif': 'GIF',
      'stats.type.unknown': 'Type not determined',
      'stats.typeDetail': 'type verified: {verified}; inferred from the file extension: {hinted}',
      'stats.size.atLeast': 'at least {size}',
      'stats.size.unknown': 'unknown',
      'stats.size.text': 'Known total size: {size}. Size measured for {covered} of {success} successful saves{estimated}{missing}.',
      'stats.size.estimated': '; header estimates ({n}) are not added',
      'stats.size.missing': '; size unknown for {n}',
      // history
      // saving settings
      'saving.folderLabel': 'Save subfolder:',
      'saving.baseFolder': 'Destination folder',
      'saving.browserFolder': 'Browser Downloads folder',
      'saving.selectedFolder': 'Selected folder',
      'saving.chooseFolder': 'Choose folder',
      'saving.useBrowserFolder': 'Use Downloads',
      'saving.baseFolderHint': 'Choose a base folder, then save settings. Subfolders are created inside it. If access expires, select the same folder again.',
      'saving.directoryAccess': 'Folder access is unavailable. Select the same folder again to restore access, or choose another destination for new downloads.',
      'saving.directoryPickFailed': 'Could not select a writable folder. Try again and allow write access; your saved destination is unchanged.',
      'saving.directoryWriteFailed': 'Could not write to the selected folder. Check access and free disk space, then retry the prepared file.',
      'saving.exportUncertain': 'Could not confirm the saved file. Check the destination folder before saving again to avoid a duplicate.',
      'saving.authorFolders': 'Author folders',
      'saving.authorFoldersHint': 'A folder per author of the selected post: the username on x.com and Reddit, the name and user ID on Pixiv. If the author cannot be determined, the usual layout is used. Applies after Save settings.',
      'saving.authorFoldersNone': 'Off',
      'saving.pixivAuthorExample': 'Artist (12345678)',
      'saving.downloads': 'Downloads',
      'saving.folderHint': 'Optional subfolder inside the destination. Leave empty to save directly there.',
      'saving.modeLabel': 'Download organization:',
      'saving.modeSingle': 'One folder (default)',
      'saving.modeBySite': 'By site and media type',
      'saving.example': 'Example path:',
      'saving.modeHint': 'Site and type folders are created automatically only when matching media is first saved.',
      'settings.error.tooDeep': 'Too many nested folders (maximum {max})',
      'settings.error.tooLong': 'Subfolder path is too long (maximum {max} characters)',
      'settings.error.load': 'Could not load the settings. Nothing was changed.',
      'settings.retryLoad': 'Try again',
      'settings.loading': 'Loading settings…',
      'settings.saving': 'Saving settings…',
      'settings.unsaved': 'Unsaved changes',
      'settings.saved': '✓ Settings saved.',
      'settings.savedCorrected': '✓ Saved. Folder corrected: {folder}',
      'settings.savedCorrectedRoot': '✓ Saved. Folder corrected: Downloads',
      'settings.saveFailed': 'Could not save the settings',
      'savebar.hint': 'Changes on the Saving and Embed tabs apply after saving.',
      'savebar.save': 'Save settings',
      // notifications settings
      'notify.switch': 'Notify about successful saves',
      'notify.hint': 'Applies immediately. MediaLatch groups results from a series into one notice on the source page after files are saved; Windows notifications are not used.',
      'notify.hintErrors': 'Save errors always stay visible in the download manager and as a “!” badge, even when success notices are off. If the source tab is closed, navigates to another site or cannot show a notice, open the manager from the extension icon.',
      'notify.error.read': 'Could not read the notification setting: the default (on) is shown.',
      'notify.error.save': 'Could not save the notification setting.',
      // embed settings
      'embed.title': 'Link previews',
      'embed.desc': 'Choose the domain used by “Copy link” for each platform.',
      'embed.help': 'About preview links',
      'embed.services': 'Links are built locally. Alternative domains are third-party preview services and may not work for every post. Media downloads are unchanged.',
      'embed.original': '{host} (original)',
      'embed.primary': '{host} (default)',
      'embed.backup': '{host} (backup)',
      'embed.x.label': 'x.com',
      'embed.x.hint': 'Choose the address copied by the button on a post. x.com is the original; fixupx.com and cunnyx.com are extra options for Embed previews in messengers.',
      'embed.ig.label': 'Instagram',
      'embed.ig.hint': 'Choose the address copied by the button on a post or Reel. instagram.com is the original; oginstagram.com, kirkstagram.com and kkclip.com are third-party services for Embed previews in messengers (they do not work for every post).',
      'embed.tt.label': 'TikTok',
      'embed.tt.hint': 'Choose the address copied by the button on a video. The alternative domains are third-party services for previews in messengers; d.tnktok.com produces a direct media embed (not an MP4 download).',
      'embed.yt.label': 'YouTube Shorts',
      'embed.yt.hint': 'Choose the address copied by the button on a YouTube Short. youtube.com is the original; yfxtube.com and koutube.com are extra options for Embed previews in messengers.',
      // updates
      'updates.installed': 'Installed version: {version}',
      'updates.channel': 'Update channel',
      'updates.stable': 'Regular releases',
      'updates.beta': 'Regular and beta releases',
      'updates.betaHint': 'Beta versions may contain errors. The channel applies immediately.',
      'updates.checking': 'Checking releases on GitHub…',
      'updates.notChecked': 'Not checked yet.',
      'updates.available': 'Version {version} is available. Install it manually.',
      'updates.availableBeta': 'Version {version} (beta) is available. Install it manually.',
      'updates.none': 'No newer version in this channel.',
      'updates.noReleases': 'There are no published releases with a version number in this channel yet.',
      'updates.lastCheck': 'Last successful check: {time}',
      'updates.checkNow': 'Check now',
      'updates.openRelease': 'Open the release on GitHub',
      'updates.openReleases': 'Open releases on GitHub',
      'updates.cadence': 'Opening this tab checks GitHub at most once a day. The button checks immediately. No background checks run while the tab is closed.',
      'updates.howTo': 'How to update the unpacked extension',
      'updates.step1': 'Open the release and download the ready extension ZIP from Assets.',
      'updates.step2': 'Wait until saves have finished. Unzip it and replace the files in the same folder the extension was installed from.',
      'updates.step3': 'On the browser’s extensions page click “Reload” for MediaLatch. Do not remove the installed extension.',
      'updates.noAuto': 'The extension never downloads or installs updates automatically.',
      'updates.error.network': 'Could not reach GitHub. Check the connection and try again.',
      'updates.error.timeout': 'GitHub did not answer within 10 seconds. Try again later.',
      'updates.error.limit': 'GitHub limited the requests. Try again later.',
      'updates.error.unavailable': 'The repository or its releases are unavailable. If the project is private, checking works once it is published.',
      'updates.error.invalid': 'GitHub returned an unsupported answer. Open the releases page manually.',
      'updates.notice.read': 'Could not read the update settings. A manual check is available.',
      'updates.notice.cache': 'Could not save the check result. The check may run again next time.',
      'updates.notice.channel': 'Could not save the update channel.',
      // notifications (service worker)
      'notice.saved': '{site}: saved',
      'notice.details': 'Click to open the details',
      'notice.openManager': 'Open manager',
      'notice.dismiss': 'Dismiss notification',
      'notice.summaryTitle': 'Download results',
      'notice.savedCount': 'Saved',
      'notice.failedCount': 'Failed',
      'notice.durationTitle': 'MP4 saved without conversion',
      'notice.durationMessage': 'This animation exceeds the 30-second GIF limit. The source video was saved as MP4.',
      // inline buttons (content scripts)
      'inline.copyPost': 'MediaLatch: Copy post link',
      'inline.copyPostAria': 'Copy post link',
      'inline.copyShortAria': 'Copy Short link',
      'inline.copyVideoAria': 'Copy video link',
      'inline.copyShort': 'MediaLatch: Copy Short link',
      'inline.copyVideo': 'MediaLatch: Copy video link',
      'inline.postUnknown': 'MediaLatch: Could not determine the post link',
      'inline.shortUnknown': 'MediaLatch: Could not determine the Short link',
      'inline.videoUnavailable': 'MediaLatch: Video link unavailable',
      'inline.copied': '✓ Link copied!',
      'inline.clipboardFailed': 'MediaLatch: Could not copy to the clipboard',
      'inline.saveThisAria': 'MediaLatch: Save this media',
      'inline.saveThis': 'Save this',
      'inline.saveAll': 'Save all ({n})',
      'inline.saveAllAria': 'MediaLatch: Save all {n} media in this post',
      'inline.saveClipAria': 'MediaLatch: Save this clip',
      'inline.save': 'Save',
      // debug journal (DEBUG-MENU-01)
      'tab.debug': 'Debug',
      'debug.title': 'Debug journal',
      'debug.desc': 'Records what the extension does — clicks, checks, requests, downloads and their reasons — as codes, hosts and numbers, on this device only. Never full links, file names, cookies, page text or clipboard contents. At most 2000 events, 1 MiB and 24 hours.',
      'debug.switch': 'Record debug events (off by default; turning it off keeps the journal)',
      'debug.recording': 'Recording',
      'debug.notRecording': 'Not recording',
      'debug.counts': '{retained} kept · {dropped} dropped · {expired} expired',
      'debug.unsaved': '{n} not yet written to storage',
      'debug.filter.source': 'Source',
      'debug.filter.level': 'Level',
      'debug.filter.all': 'All',
      'debug.search': 'Search actions, reasons, hosts, IDs',
      'debug.source.worker': 'Background',
      'debug.source.content': 'Page',
      'debug.source.frame': 'Embedded frame',
      'debug.source.offscreen': 'Offscreen',
      'debug.source.settings': 'Settings page',
      'debug.source.popup': 'Toolbar popup',
      'debug.level.debug': 'Debug',
      'debug.level.info': 'Info',
      'debug.level.warn': 'Warning',
      'debug.level.error': 'Error',
      'debug.empty': 'No events recorded.',
      'debug.noMatch': 'No events match the filters.',
      'debug.shown': 'Showing {n} of {total}',
      'debug.details': 'Details',
      'debug.refresh': 'Refresh',
      'debug.copy': 'Copy report',
      'debug.export': 'Download JSON',
      'debug.clear': 'Clear journal',
      'debug.copied': 'Report copied ({n} events).',
      'debug.copyFailed': 'Could not copy: the clipboard is not available.',
      'debug.exported': 'JSON file with {n} events prepared for download.',
      'debug.exportFailed': 'Could not prepare the JSON file.',
      'debug.cleared': 'Debug journal cleared.',
      'debug.error.clear': 'Could not clear the journal: nothing was deleted.',
      'debug.error.load': 'Could not load the journal.',
      'debug.error.storage': 'The newest events could not be written to storage; they are kept only while the extension stays loaded.',
      'debug.error.prefRead': 'Could not read the debug setting: it is treated as off.',
      'debug.error.prefSave': 'Could not save the debug setting.',
      'debug.report.title': 'MediaLatch debug report'
    },
    ru: {
      'app.title': 'MediaLatch: загрузки и настройки',
      'app.subtitle': 'Загрузки, статистика и настройки',
      "tab.downloads": "Загрузки",
      "statistics.total": "Операций",
      "statistics.scope": "Итоги с начала учёта или последней очистки. Без ограничения по числу записей и сроку. Хранятся только на этом устройстве; учёт не сохраняет адреса медиа, имена файлов или пути.",
      "statistics.disabled": "Учёт выключен. Уже накопленные итоги сохраняются.",
      "statistics.empty": "Учтённых операций пока нет.",
      "statistics.record": "Вести статистику",
      "statistics.clear": "Очистить статистику всех сайтов",
      "statistics.cleared": "Статистика очищена для всех сайтов.",
      "statistics.imported": "Перенесено доступных старых записей: {n}. Ранее удалённые и истёкшие записи восстановить нельзя.",
      "statistics.loadFailed": "Не удалось загрузить статистику.",
      "statistics.prefReadFailed": "Не удалось прочитать настройку учёта; он считается выключенным.",
      "statistics.prefSaveFailed": "Не удалось сохранить настройку учёта.",
      "statistics.clearFailed": "Не удалось очистить статистику; итоги сохранены.",
      "statistics.site": "Сайт",
      "statistics.site.all": "Все сайты",
      "statistics.site.booru": "Booru-сайты",
      "statistics.site.x": "X",
      "statistics.site.reddit": "Reddit",
      "statistics.site.pixiv": "Pixiv",
      "statistics.site.redgifs": "RedGIFs",
      "statistics.site.pawchive": "Pawchive",
      "statistics.site.zerochan": "Zerochan",
      "statistics.site.anime-pictures": "Anime-Pictures",
      "statistics.site.danbooru": "Danbooru",
      "statistics.site.rule34": "Rule34",
      "statistics.site.safebooru": "Safebooru",
      "statistics.site.gelbooru": "Gelbooru",
      "statistics.site.realbooru": "Realbooru",
      "statistics.site.xbooru": "Xbooru",
      "statistics.site.hypnohub": "Hypnohub",
      "statistics.site.tbib": "TBIB",
      "statistics.site.curveybooru": "Curveybooru",
      "statistics.site.inkbooru": "Inkbooru",
      "statistics.site.mspabooru": "MSPAbooru",
      "statistics.site.scatbooru": "Scatbooru",
      "statistics.site.yakui": "Yakui",
      "statistics.site.e621": "e621",
      "statistics.site.yande.re": "yande.re",
      "statistics.site.konachan": "Konachan",
      "statistics.site.e-shuushuu": "e-shuushuu",
      "statistics.site.sankaku": "Sankaku",
      "statistics.site.tenor": "Tenor",
      "statistics.site.giphy": "GIPHY",
      "statistics.site.wikimedia": "Wikimedia",
      "statistics.site.vk": "VK",
      "statistics.site.other": "Прочие сайты",
      "statistics.site.unattributed": "Прежние / без сайта",
      "statistics.emptySite": "Для этого сайта учтённых операций пока нет.",
      'app.sections': 'Разделы',
      'section.downloads': 'Текущие и недавние сохранения. Отменить, повторить или убрать запись можно в её строке.',
      'section.saving': 'Куда сохраняются новые файлы и как называются папки. Изменения применяются после «Сохранить настройки».',
      'section.notifications': 'Уведомление на исходной странице после сохранения файлов.',
      'section.updates': 'Проверка новой версии на GitHub. Установка остаётся ручной.',
      'section.debug': 'Журнал действий расширения по вашему включению; хранится только на этом устройстве.',
      'tab.history': 'Статистика',
      'tab.saving': 'Сохранение',
      'tab.notifications': 'Уведомления',
      'tab.embed': 'Embed',
      'tab.updates': 'Обновления',
      'app.howto.label': 'Как пользоваться:',
      'app.howto.text': 'нажмите правой кнопкой мыши по изображению, видео или превью поста и выберите',
      'app.howto.menu': '«{title}»',
      // first-run quick start guide (FIRST-RUN-SETUP-01)
      'onboarding.title': 'Быстрый старт',
      'onboarding.intro': 'Три шага, чтобы сохранить первое медиа.',
      'onboarding.steps': 'Шаги быстрого старта',
      'onboarding.step1.title': 'Сохраните медиа',
      'onboarding.step1.text': 'Нажмите правой кнопкой мыши по изображению, видео или превью поста и выберите «{title}». На некоторых поддерживаемых сайтах на медиа также есть кнопка «Сохранить». На x.com нажмите Shift вместе с правой кнопкой, если сайт скрывает меню браузера. Поддерживаются не все сайты и файлы.',
      'onboarding.step2.title': 'Выберите, куда сохранять',
      'onboarding.step2.text': 'Файлы попадают в папку загрузок браузера, пока вы не выберете другую. Изменение применяется только после нажатия «Сохранить настройки».',
      'onboarding.step3.title': 'Следите за ходом',
      'onboarding.step3.text': 'Когда сохранение завершится или не удастся, на странице появится уведомление. В менеджере загрузок видны прогресс, повтор и отмена.',
      'onboarding.continue': 'Продолжить',
      'onboarding.loading': 'Загрузка…',
      'onboarding.readFailed': 'Не удалось проверить, закрывали ли вы это руководство. Оно остаётся открытым; «Продолжить» попробует запомнить выбор.',
      'onboarding.saveFailed': 'Не удалось запомнить, что руководство закрыто. Оно остаётся открытым; нажмите «Продолжить» ещё раз.',
      'app.credits.label': 'Интерфейс:',
      'app.credits.and': 'и',
      'app.credits.licenses': 'Лицензии —',
      'lang.label': 'Язык',
      'theme.label': 'Тема',
      'theme.blue': 'Синяя',
      'theme.dark': 'Тёмная',
      'theme.light': 'Светлая',
      'theme.violet': 'Фиолетовая',
      'theme.readFailed': 'Не удалось прочитать тему. Показана фиолетовая.',
      'theme.saveFailed': 'Не удалось сохранить тему. Прежний выбор сохранён.',
      'lang.saving': 'Сохраняем язык…',
      'lang.saveFailed': 'Не удалось сохранить язык: оставлен прежний выбор.',
      'lang.readFailed': 'Не удалось прочитать сохранённый язык: показан язык браузера.',
      'downloads.heading':'Загрузки', 'downloads.open':'Открыть менеджер загрузок', 'downloads.pause':'Приостановить очередь', 'downloads.resume':'Продолжить очередь', 'downloads.clearFinished':'Очистить завершённые записи (файлы и статистика останутся)',
      'downloads.pendingName':'Выбранное медиа', 'downloads.resolving':'Поиск источника', 'downloads.converting':'Обработка медиа', 'downloads.preparingHint':'Управление загрузкой станет доступно после подготовки.',
      'downloads.loading':'Загрузка списка…', 'downloads.empty':'Загрузок пока нет.', 'downloads.unavailable':'Не удалось загрузить список.',
      'downloads.commandFailed':'Не удалось выполнить действие.', 'downloads.queued':'В очереди', 'downloads.receiving':'Получение файла', 'downloads.validating':'Проверка файла',
      'downloads.ready':'Готов к сохранению', 'downloads.exporting':'Сохранение готового файла', 'downloads.complete':'Сохранено', 'downloads.failed':'Ошибка', 'downloads.cancelled':'Отменено',
      'downloads.cancel':'Отменить загрузку', 'downloads.retry':'Повторить загрузку', 'downloads.exportAgain':'Сохранить готовый файл снова', 'downloads.remove':'Удалить запись и временный файл', 'downloads.removeRecord':'Удалить запись',
      'downloads.progress':'Прогресс файла', 'downloads.unknown':'размер неизвестен', 'downloads.remaining':'осталось примерно {seconds} с', 'downloads.kept':'Готовый файл сохранён для повтора',
      'downloads.retryList': 'Повторить',
      // сводка по пакету поста (X / Reddit «Save all», многофайловые посты Pixiv и Pawchive)
      'downloads.batch.title': 'Пост {site}', 'downloads.batch.allSaved': 'Все файлы сохранены ({count})', 'downloads.batch.saved': 'Сохранено {saved} из {count}',
      'downloads.batch.failed': 'ошибок: {n}', 'downloads.batch.cancelled': 'отменено: {n}', 'downloads.batch.skipped': 'пропущено: {n}', 'downloads.batch.remaining': 'в работе: {n}', 'notice.batchRemaining': 'осталось: {n}',
      'downloads.batch.partial': 'часть оригиналов не импортирована',
      'downloads.site.files': 'Файлов: {n}', 'downloads.singles': 'Отдельные файлы',
      'downloads.batch.showFiles': 'Показать файлы', 'downloads.batch.hideFiles': 'Скрыть файлы',
      'downloads.batch.cancel': 'Отменить оставшиеся', 'downloads.batch.cancelling': 'Отмена…', 'downloads.batchCancelFailed': 'Не удалось отменить оставшиеся файлы. Повторите попытку.',
      'downloads.batch.site.x': 'x.com', 'downloads.batch.site.reddit': 'Reddit', 'downloads.batch.site.pixiv': 'Pixiv', 'downloads.batch.site.pawchive': 'Pawchive', 'downloads.batch.site.vk': 'VK',
      'failure.code': 'Код: {code}',
      'failure.storageQuota.title': 'Локальное хранилище заполнено',
      'failure.storageQuota.text': 'В браузере не осталось места для временной копии этого файла.',
      'failure.storageQuota.next': 'Освободите место на диске и повторите.',
      'failure.preparedMissing.title': 'Готовый файл недоступен',
      'failure.preparedMissing.text': 'Временная копия этого файла больше недоступна.',
      'failure.preparedMissing.next': 'Сохраните медиа заново со страницы.',
      'failure.sourceExpired.title': 'Источник больше недоступен',
      'failure.sourceExpired.text': 'Исходный адрес этого файла больше нельзя использовать для повтора.',
      'failure.sourceExpired.next': 'Откройте пост заново и сохраните медиа оттуда.',
      'failure.batchLimit.title': 'Слишком много медиа в посте',
      'failure.batchLimit.text': 'В посте больше файлов, чем поддерживает одно сохранение.',
      'failure.batchLimit.next': 'Сохраните нужные файлы по одному.',
      'failure.directory.title': 'Папка недоступна',
      'failure.uncertain.title': 'Сохранение не подтверждено',
      'quick.settings': 'Настройки',
      'results.error': 'Не удалось загрузить результаты сохранения.',
      'row.new': 'новое',
      'row.siteUnknown': 'сайт неизвестен',
      'row.intended': 'имя запланировано, не подтверждено',
      'type.pic': 'изображение',
      'type.video': 'видео',
      'type.gif': 'GIF',
      'filename.actual': 'Имя файла: {name} (фактическое)',
      'filename.intended': 'Имя файла: {name} (запланированное, не подтверждено)',
      'details.openFull': 'Открыть на странице истории',
      'report.retryHint': 'Повторное сохранение вручную: щёлкните правой кнопкой по тому же медиа и снова выберите «Сохранить». При NETWORK_FAILED возможна одна попытка возобновить текущую загрузку средствами браузера. Повторный поиск источника автоматически не выполняется; ограничения сайта сохраняются.',
      'report.privacy': 'Отчёт не отправляется автоматически: он копируется только по нажатию кнопки и не содержит ссылок, путей и токенов.',
      'report.notes': 'Что вы делали (необязательно)',
      'report.preview': 'Предпросмотр отчёта',
      'report.copy': 'Копировать отчёт',
      'report.copied': 'Отчёт скопирован в буфер обмена.',
      'report.copyFailed': 'Не удалось скопировать автоматически. Выделите текст отчёта и нажмите Ctrl+C.',
      'post.unknown': 'Ссылка на пост: неизвестна (не удалось надёжно определить пост-владелец).',
      'post.label': 'Пост:',
      'post.copy': 'Копировать ссылку на пост',
      'post.copied': 'Ссылка скопирована в буфер обмена.',
      'post.copyFailed': 'Не удалось скопировать ссылку автоматически. Откройте её и скопируйте из адресной строки.',
      'stats.loading': 'Загрузка статистики…',
      'stats.success': 'Успешно сохранено',
      'stats.failed': 'Ошибки и прерывания',
      'stats.cancelled': 'Отменено',
      'stats.unknown': 'Результат неизвестен (Chrome не сохранил запись о загрузке)',
      'stats.type.pic': 'Изображения',
      'stats.type.video': 'Видео',
      'stats.type.gif': 'GIF',
      'stats.type.unknown': 'Тип не определён',
      'stats.typeDetail': 'тип подтверждён: {verified}; определён по расширению файла: {hinted}',
      'stats.size.atLeast': 'не менее {size}',
      'stats.size.unknown': 'неизвестен',
      'stats.size.text': 'Известный суммарный размер: {size}. Размер измерен у {covered} из {success} успешных сохранений{estimated}{missing}.',
      'stats.size.estimated': '; оценки по заголовкам ({n}) не суммируются',
      'stats.size.missing': '; размер неизвестен у {n}',
      'saving.folderLabel': 'Подпапка для сохранения:',
      'saving.baseFolder': 'Папка назначения',
      'saving.browserFolder': 'Папка загрузок браузера',
      'saving.selectedFolder': 'Выбранная папка',
      'saving.chooseFolder': 'Выбрать папку',
      'saving.useBrowserFolder': 'Использовать «Загрузки»',
      'saving.baseFolderHint': 'Выберите базовую папку и сохраните настройки. Подпапки создаются внутри неё. Если доступ истечёт, выберите ту же папку снова.',
      'saving.directoryAccess': 'Нет доступа к папке. Выберите её снова, чтобы вернуть доступ, или задайте другую папку для новых загрузок.',
      'saving.directoryPickFailed': 'Не удалось выбрать папку с правом записи. Повторите выбор и разрешите запись; сохранённая папка не изменена.',
      'saving.directoryWriteFailed': 'Не удалось записать файл в выбранную папку. Проверьте доступ и свободное место, затем повторите сохранение готового файла.',
      'saving.exportUncertain': 'Не удалось подтвердить запись файла. Проверьте папку назначения перед новым сохранением, чтобы избежать дубликата.',
      'saving.authorFolders': 'Папки авторов',
      'saving.authorFoldersHint': 'Папка для автора выбранного поста: имя пользователя на x.com и Reddit, имя и ID пользователя на Pixiv. Если автор не определён, используется обычная структура папок. Применяется после «Сохранить настройки».',
      'saving.authorFoldersNone': 'Выкл.',
      'saving.pixivAuthorExample': 'Автор (12345678)',
      'saving.downloads': 'Загрузки',
      'saving.folderHint': 'Необязательная подпапка внутри папки назначения. Оставьте поле пустым, чтобы сохранять прямо в неё.',
      'saving.modeLabel': 'Организация скачиваний:',
      'saving.modeSingle': 'В одну папку (по умолчанию)',
      'saving.modeBySite': 'По сайтам и типам медиа',
      'saving.example': 'Пример пути:',
      'saving.modeHint': 'Папки сайтов и типов создаются автоматически только при первом сохранении соответствующего медиа.',
      'settings.error.tooDeep': 'Слишком много вложенных папок (максимум {max})',
      'settings.error.tooLong': 'Слишком длинный путь подпапки (максимум {max} символов)',
      'settings.error.load': 'Ошибка загрузки настроек. Ничего не изменено.',
      'settings.retryLoad': 'Повторить',
      'settings.loading': 'Загрузка настроек…',
      'settings.saving': 'Сохранение настроек…',
      'settings.unsaved': 'Есть несохранённые изменения',
      'settings.saved': '✓ Настройки успешно сохранены!',
      'settings.savedCorrected': '✓ Сохранено. Папка исправлена: {folder}',
      'settings.savedCorrectedRoot': '✓ Сохранено. Папка исправлена: Загрузки',
      'settings.saveFailed': 'Не удалось сохранить настройки',
      'savebar.hint': 'Изменения во вкладках «Сохранение» и «Embed» применяются после сохранения.',
      'savebar.save': 'Сохранить настройки',
      'notify.switch': 'Уведомлять об успешных сохранениях',
      'notify.hint': 'Настройка применяется сразу. MediaLatch объединяет результаты серии загрузок в одно уведомление на исходной странице после сохранения файлов; уведомления Windows не используются.',
      'notify.hintErrors': 'Ошибки сохранения остаются видимыми всегда: в менеджере загрузок и значком «!» на иконке, даже если уведомления об успехе выключены. Если исходная вкладка закрыта, перешла на другой сайт или не может показать уведомление, откройте менеджер через иконку расширения.',
      'notify.error.read': 'Не удалось прочитать настройку уведомлений: показано значение по умолчанию (включено).',
      'notify.error.save': 'Не удалось сохранить настройку уведомлений.',
      'embed.title': 'Превью ссылок',
      'embed.desc': 'Выберите домен для кнопки «Копировать ссылку» на каждой платформе.',
      'embed.help': 'О ссылках и сервисах',
      'embed.services': 'Ссылки собираются локально. Альтернативные домены — сторонние сервисы превью, которые могут работать не для всех публикаций. Скачивание медиа не меняется.',
      'embed.original': '{host} (оригинал)',
      'embed.primary': '{host} (по умолчанию)',
      'embed.backup': '{host} (резерв)',
      'embed.x.label': 'x.com',
      'embed.x.hint': 'Выберите адрес, который копирует кнопка у поста. x.com — оригинал; fixupx.com и cunnyx.com — дополнительные варианты для Embed-превью в мессенджерах.',
      'embed.ig.label': 'Instagram',
      'embed.ig.hint': 'Выберите адрес, который копирует кнопка у поста или Reel. instagram.com — оригинал; oginstagram.com, kirkstagram.com и kkclip.com — сторонние сервисы для Embed-превью в мессенджерах (работают не для всех публикаций).',
      'embed.tt.label': 'TikTok',
      'embed.tt.hint': 'Выберите адрес, который копирует кнопка у видео. Альтернативные домены — пользовательские сторонние сервисы для превью в мессенджерах; d.tnktok.com формирует direct media embed (не скачивание MP4).',
      'embed.yt.label': 'YouTube Shorts',
      'embed.yt.hint': 'Выберите адрес, который копирует кнопка у YouTube Short. youtube.com — оригинал; yfxtube.com и koutube.com — дополнительные варианты для Embed-превью в мессенджерах.',
      'updates.installed': 'Установленная версия: {version}',
      'updates.channel': 'Канал обновлений',
      'updates.stable': 'Обычные релизы',
      'updates.beta': 'Обычные и beta-релизы',
      'updates.betaHint': 'Beta-версии могут содержать ошибки. Канал применяется сразу.',
      'updates.checking': 'Проверяем релизы на GitHub…',
      'updates.notChecked': 'Проверка ещё не выполнена.',
      'updates.available': 'Доступна версия {version}. Установите её вручную.',
      'updates.availableBeta': 'Доступна версия {version} (beta). Установите её вручную.',
      'updates.none': 'Новых версий в этом канале нет.',
      'updates.noReleases': 'Опубликованных релизов с номером версии в этом канале пока нет.',
      'updates.lastCheck': 'Последняя успешная проверка: {time}',
      'updates.checkNow': 'Проверить сейчас',
      'updates.openRelease': 'Открыть релиз на GitHub',
      'updates.openReleases': 'Открыть релизы на GitHub',
      'updates.cadence': 'При открытии этой вкладки проверяем GitHub не чаще раза в сутки. Кнопка запускает проверку сразу. Пока вкладка закрыта, фоновых проверок нет.',
      'updates.howTo': 'Как обновить распакованное расширение',
      'updates.step1': 'Откройте релиз и скачайте готовый ZIP расширения из раздела Assets.',
      'updates.step2': 'Дождитесь завершения сохранений. Распакуйте ZIP и замените файлы в той же папке, из которой установлено расширение.',
      'updates.step3': 'На странице расширений браузера нажмите «Перезагрузить» у MediaLatch. Не удаляйте установленное расширение.',
      'updates.noAuto': 'Расширение не скачивает и не устанавливает обновления автоматически.',
      'updates.error.network': 'Не удалось связаться с GitHub. Проверьте подключение и повторите проверку.',
      'updates.error.timeout': 'GitHub не ответил за 10 секунд. Повторите проверку позже.',
      'updates.error.limit': 'GitHub ограничил запросы. Повторите проверку позже.',
      'updates.error.unavailable': 'Репозиторий или релизы недоступны. Если проект закрыт, проверка заработает после его публичной публикации.',
      'updates.error.invalid': 'GitHub вернул неподдерживаемый ответ. Откройте страницу релизов вручную.',
      'updates.notice.read': 'Не удалось прочитать настройки обновлений. Доступна ручная проверка.',
      'updates.notice.cache': 'Не удалось сохранить результат проверки. При следующем открытии проверка может повториться.',
      'updates.notice.channel': 'Не удалось сохранить канал обновлений.',
      'notice.saved': '{site}: сохранено',
      'notice.details': 'Нажмите, чтобы открыть подробности',
      'notice.openManager': 'Открыть менеджер',
      'notice.dismiss': 'Закрыть уведомление',
      'notice.summaryTitle': 'Результаты загрузок',
      'notice.savedCount': 'Сохранено',
      'notice.failedCount': 'Ошибок',
      'notice.durationTitle': 'MP4 сохранён без конвертации',
      'notice.durationMessage': 'Длительность анимации превышает 30 секунд. Исходное видео сохранено как MP4.',
      'inline.copyPost': 'MediaLatch: Скопировать ссылку на пост',
      'inline.copyPostAria': 'Скопировать ссылку на пост',
      'inline.copyShortAria': 'Скопировать ссылку на Short',
      'inline.copyVideoAria': 'Скопировать ссылку на видео',
      'inline.copyShort': 'MediaLatch: Скопировать ссылку на Short',
      'inline.copyVideo': 'MediaLatch: Скопировать ссылку на видео',
      'inline.postUnknown': 'MediaLatch: Не удалось определить ссылку на пост',
      'inline.shortUnknown': 'MediaLatch: Не удалось определить ссылку на Short',
      'inline.videoUnavailable': 'MediaLatch: Ссылка на видео недоступна',
      'inline.copied': '✓ Ссылка скопирована!',
      'inline.clipboardFailed': 'MediaLatch: Не удалось скопировать в буфер обмена',
      'inline.saveThisAria': 'MediaLatch: Сохранить это медиа',
      'inline.saveThis': 'Сохранить',
      'inline.saveAll': 'Все ({n})',
      'inline.saveAllAria': 'MediaLatch: Сохранить все медиа этого поста ({n})',
      'inline.saveClipAria': 'MediaLatch: Сохранить этот клип',
      'inline.save': 'Сохранить',
      // журнал отладки (DEBUG-MENU-01)
      'tab.debug': 'Отладка',
      'debug.title': 'Журнал отладки',
      'debug.desc': 'Записывает действия расширения — клики, проверки, запросы, загрузки и их причины — в виде кодов, хостов и чисел, только на этом устройстве. Никогда не полные ссылки, имена файлов, cookies, текст страниц или содержимое буфера обмена. Не более 2000 событий, 1 МиБ и 24 часов.',
      'debug.switch': 'Записывать события отладки (по умолчанию выключено; выключение не удаляет журнал)',
      'debug.recording': 'Запись идёт',
      'debug.notRecording': 'Запись выключена',
      'debug.counts': 'хранится {retained} · отброшено {dropped} · устарело {expired}',
      'debug.unsaved': 'ещё не записано в хранилище: {n}',
      'debug.filter.source': 'Источник',
      'debug.filter.level': 'Уровень',
      'debug.filter.all': 'Все',
      'debug.search': 'Поиск по действиям, причинам, хостам, ID',
      'debug.source.worker': 'Фоновый процесс',
      'debug.source.content': 'Страница',
      'debug.source.frame': 'Встроенный кадр',
      'debug.source.offscreen': 'Offscreen-документ',
      'debug.source.settings': 'Страница настроек',
      'debug.source.popup': 'Всплывающее окно',
      'debug.level.debug': 'Отладка',
      'debug.level.info': 'Инфо',
      'debug.level.warn': 'Предупреждение',
      'debug.level.error': 'Ошибка',
      'debug.empty': 'Событий нет.',
      'debug.noMatch': 'Нет событий, подходящих под фильтры.',
      'debug.shown': 'Показано {n} из {total}',
      'debug.details': 'Подробности',
      'debug.refresh': 'Обновить',
      'debug.copy': 'Скопировать отчёт',
      'debug.export': 'Скачать JSON',
      'debug.clear': 'Очистить журнал',
      'debug.copied': 'Отчёт скопирован (событий: {n}).',
      'debug.copyFailed': 'Не удалось скопировать: буфер обмена недоступен.',
      'debug.exported': 'Файл JSON (событий: {n}) подготовлен к скачиванию.',
      'debug.exportFailed': 'Не удалось подготовить файл JSON.',
      'debug.cleared': 'Журнал отладки очищен.',
      'debug.error.clear': 'Не удалось очистить журнал: ничего не удалено.',
      'debug.error.load': 'Не удалось загрузить журнал.',
      'debug.error.storage': 'Последние события не удалось записать в хранилище; они хранятся только пока расширение загружено.',
      'debug.error.prefRead': 'Не удалось прочитать настройку отладки: считается выключенной.',
      'debug.error.prefSave': 'Не удалось сохранить настройку отладки.',
      'debug.report.title': 'Отчёт отладки MediaLatch'
    }
  };
  for (const lang of LANGS) Object.freeze(STRINGS[lang]);
  Object.freeze(STRINGS);

  const valid = (value) => value === 'en' || value === 'ru';

  /** The language for a browser UI language when nothing valid is saved: Russian for a Russian browser, English otherwise. */
  function browserDefault(uiLanguage) {
    return /^ru(?:[-_]|$)/i.test(String(uiLanguage || '')) ? 'ru' : 'en';
  }

  /** A valid saved preference wins; anything else (missing, invalid, unreadable) falls back to the browser language. */
  function resolve(stored, uiLanguage) {
    return valid(stored) ? stored : browserDefault(uiLanguage);
  }

  /** The browser UI language as Chrome reports it (extension pages, worker, content scripts), else navigator.language. */
  function uiLanguage(chromeApi, nav) {
    try {
      if (chromeApi && chromeApi.i18n && typeof chromeApi.i18n.getUILanguage === 'function') return String(chromeApi.i18n.getUILanguage() || '');
    } catch (_) { /* fall back to the navigator */ }
    try { return String((nav && nav.language) || ''); } catch (_) { return ''; }
  }

  /** BCP 47 tag for dates and numbers of a language. */
  function locale(lang) {
    return lang === 'ru' ? 'ru-RU' : 'en-US';
  }

  /** Text of a key in a language: a missing key falls back to English, then to the key itself. {name} placeholders are substituted. */
  function t(lang, key, vars) {
    const table = STRINGS[valid(lang) ? lang : 'en'];
    let text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : (Object.prototype.hasOwnProperty.call(STRINGS.en, key) ? STRINGS.en[key] : String(key));
    if (vars && typeof vars === 'object') {
      text = text.replace(/\{([A-Za-z0-9_]+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : all));
    }
    return text;
  }

  /** A stored message: '' (none), a key, or { key, vars }. Controllers keep messages in this form so a language change re-renders them. */
  function message(lang, msg) {
    if (!msg) return '';
    if (typeof msg === 'string') return t(lang, msg);
    return typeof msg.key === 'string' ? t(lang, msg.key, msg.vars) : '';
  }

  /**
   * Reads the saved preference from a storage area ({ get }) and resolves the language. Never writes. A failed read reports
   * `error: true` and uses the browser language; an invalid value is reported as `stored: null`.
   */
  async function read(area, uiLang) {
    try {
      const data = await area.get({ [PREF_KEY]: null });
      const stored = data ? data[PREF_KEY] : null;
      return { lang: resolve(stored, uiLang), stored: valid(stored) ? stored : null, error: false };
    } catch (_) {
      return { lang: browserDefault(uiLang), stored: null, error: true };
    }
  }

  /**
   * Follows the language for a script that has no page controller (content scripts): calls `onChange(lang)` with the browser
   * default at once, then with the saved preference, then on every change of it in chrome.storage.local. `label()` updates
   * existing text/attributes too, including closed-shadow controls; a null key clears that binding for a hidden/compact action.
   */
  function follow(chromeApi, nav, onChange) {
    const ui = uiLanguage(chromeApi, nav);
    let lang = browserDefault(ui);
    let touched = false;
    // Weak references keep removed feed cards out of the language subscriber's lifetime.
    const elements = new Set();
    const labels = new WeakMap();
    const cleanup = new FinalizationRegistry((ref) => elements.delete(ref));
    const render = (element, field, binding) => {
      const value = t(lang, binding.key, binding.vars);
      if (field === 'textContent') element.textContent = value;
      else element.setAttribute(field, value);
    };
    const set = (next) => {
      if (next === lang) return;
      lang = next;
      try { onChange(lang); } catch (_) { /* a label refresh is best effort */ }
      for (const ref of elements) {
        const element = ref.deref();
        if (!element) { elements.delete(ref); continue; }
        for (const [field, binding] of labels.get(element)) render(element, field, binding);
      }
    };
    function label(element, field, key, vars, fallback = '') {
      let bindings = labels.get(element);
      if (!bindings && key) {
        bindings = new Map();
        labels.set(element, bindings);
        const ref = new WeakRef(element);
        elements.add(ref);
        cleanup.register(element, ref);
      }
      if (key) {
        const binding = { key, vars };
        bindings.set(field, binding);
        render(element, field, binding);
      } else {
        if (bindings) bindings.delete(field);
        if (field === 'textContent') element.textContent = fallback;
        else if (fallback === null) element.removeAttribute(field);
        else element.setAttribute(field, fallback);
      }
    }
    try { onChange(lang); } catch (_) { /* best effort */ }
    try {
      const onChanged = chromeApi && chromeApi.storage && chromeApi.storage.onChanged;
      if (onChanged && typeof onChanged.addListener === 'function') {
        onChanged.addListener((changes, area) => {
          if (area !== 'local' || !changes || !changes[PREF_KEY]) return;
          touched = true;
          set(resolve(changes[PREF_KEY].newValue, ui));
        });
      }
      const local = chromeApi && chromeApi.storage && chromeApi.storage.local;
      if (local && typeof local.get === 'function') {
        read(local, ui).then((r) => { if (!touched) set(r.lang); }, () => {});
      }
    } catch (_) { /* storage unavailable: the browser language stays */ }
    return { current: () => lang, label };
  }

  root.ImageSaverI18n = Object.freeze({ PREF_KEY, LANGS, MENU_TITLE, STRINGS, valid, browserDefault, resolve, uiLanguage, locale, t, message, read, follow });
})(typeof globalThis !== 'undefined' ? globalThis : self);
