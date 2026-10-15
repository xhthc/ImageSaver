# Changelog

## 2.5.3 — post-batch progress and site statistics

- Show one durable post summary in both managers for X/Reddit Save all, multi-page Pixiv artworks and multi-original Pawchive posts. Saved, failed, cancelled, skipped and remaining counts stay distinct; retries update the existing item.
- Keep one updating notice per post using committed manager counts. Partial Pawchive imports retain their unavailable-original diagnostic and never claim all post files were saved.
- Add compact local site statistics: populated services only, one Booru view, preserved all-time totals and conservative legacy attribution. Recording and clear remain global.
- Preserve known owning-service attribution through queued retries and worker recovery, including prepared outputs after recent feedback expires.
- Remove the repeated download-row tooltip/hover overlay and move terminal record removal into the full manager's expanded details.
- Refresh EN/RU release documentation, roadmap status and neutral downloads/statistics captures. Permissions, dependencies and provider admission rules are unchanged.

This remains a pre-release. The accepted feature code passed 77 GitHub checks, independent source reviews, isolated native byte/restart checks and bounded user Helium acceptance for X/Reddit batches, statistics and live Pixiv/Pawchive results. These do not establish exhaustive provider/audio, Google Chrome, quota or crash coverage. The submitted Chrome Web Store 2.5.2 package is a separate, unchanged build.

## 2.5.2 — media request guards and project cleanup

- Include the reviewed interface cleanup and project file organization while preserving download workflows and stored preferences.
- Restore the original seven-item sidebar without category captions or collapse controls.
- Add `kkclip.com` as an optional Instagram link-preview host; keep existing hosts and explicit Save settings.
- Publish the reviewed runtime as a GitHub pre-release; keep Chrome Web Store artwork and upload materials outside the repository and release assets.
- Remove the unused documentation banner; retain runtime code, build sources, fixtures, licences and product screenshots.
- Restrict privileged offscreen commands to the worker and reject synthetic converter IPC fields.
- Refuse literal local-network media from public pages and unchecked redirects; preserve deliberately selected local-page media. Hostname DNS changes remain outside this guard.
- Bound Zerochan metadata to 2 MiB with cancellation throughout its deadline.

Store submission and approval are separate states. User-reported X, Reddit and RedGIFs checks were performed in Helium; this does not establish Google Chrome, all-provider or audio acceptance.

## 2.5.1 — redesigned interface and violet gradient branding

- Redesign the manager, popup, settings, statistics and diagnostics with grouped navigation and consistent panels across Violet, Blue, Dark and Light themes. Preserve English/Russian localization and existing preferences.
- Make link-preview settings a responsive two-column grid with help for each platform; preserve explicit Save settings and all existing preview hosts.
- Align notification/Debug switches with their panels; retain popup wheel/keyboard scrolling and the global finished-record clear action.
- Refresh the recognizable M/download icon with a violet three-stop gradient and subtle edge; synchronize UI, toolbar theme variants and notification assets.
- Replace EN/RU README screenshots with actual isolated-browser captures; update current privacy details and prepare neutral Chrome Web Store screenshots and promotional art.

This remains a pre-release. Download providers, privileged boundaries, storage keys, permissions and dependencies are unchanged. Existing provider smoke evidence is retained; independent source review, UI verification and exact-package browser/export checks are recorded for this preview. No store approval, exhaustive live-provider/audio or performance/leak result is claimed.

## 2.5.0 — version update

- Repackage the accepted 2.0.0.33 runtime as version 2.5.0; extension behavior, permissions, dependencies and stored data are unchanged.
- Update current release links and installation archive names in the EN/RU README.

This remains a pre-release. Prior source and browser validation applies to the unchanged runtime; packaging and version/update checks are repeated for the new archive.

## 2.0.0.33 — author folders, selected-media continuity and refactor

- Add a separate first-install welcome with one Continue action to Saving; keep it dismissed after updates and restarts.
- Add one Author folders menu for x.com, Reddit and Pixiv. Preserve the previous X preference; Pixiv folders use author name plus user ID. Keep flat and site/type organization choices.
- Improve original Pixiv preview acquisition through staged downloads with progress and a durable 50 MiB cap. Preserve the selected post, author and batch when feed nodes scroll away or are recycled; keep document/navigation and ownership refusals.
- Strengthen declared-original ownership for booru engines and Zerochan; preserve existing rate/access, MIME and file-identity checks.
- Match interface and toolbar icons to Violet, Blue, Dark and Light themes. Keep popup wheel scrolling with hidden rails and one global clear action; per-file removal remains in the full manager.
- Split worker candidates, booru adapters, selected-frame reads and X recovery into focused modules. Remove unreachable legacy history/UI/helpers and fold equivalent repeated branches without changing stored preferences or statistics migration.
- Refresh EN/RU README and interface screenshots for this preview.

Validation: reviewed refactor72/72 checks and seven-file UI build parity, independent source review, isolated Chromium startup/UI/legacy-statistics/restart checks, and limited user-reported Helium saves/interface smoke tests. This prerelease does not establish exhaustive audio/byte, crash/quota or performance/leak coverage. Rapid RedGIFs inline saves can hit the existing four-active admission limit; the current RATE_LIMIT label also covers remote HTTP429.

## 2.0.0.32 — remove Explorer integration

- Remove the Windows Explorer companion, native messaging permission and destination-link setup. Saving to custom folders and per-author subfolders remains available without companion software.
- Remove file-location folder icons from both download managers and retire their worker/controller actions. Existing downloads, saved files, preferences and manager-return notices are retained.
- Withdraw the v2.0.0.31 companion release assets. Earlier runtime archives remain historical builds; use v2.0.0.32 for the rollback.

This is a preview. Automated checks do not establish broad live-site or installed-popup acceptance.

## 2.0.0.31 — manager-return notices and Windows Explorer

- Keep page notices working after opening the download manager and returning to the source page. Opening the manager retires the current card; later results still share one activity card. Explicit close/Escape retains series suppression.
- Replace the chosen-folder file picker with an optional Windows Explorer companion for both download managers. Link a saved destination once; verify the exact extension origin, fresh directory proof and completed relative file before opening its parent. Ordinary browser Downloads keep their existing reveal action.
- Provide the Windows companion as a separate release ZIP with installation instructions. Missing helper/binding keeps download cards and gives localized recovery. The extension now declares `nativeMessaging`.

The user confirmed the manager-return notification fix. Automated68/68 checks and isolated native manager navigation/host communication passed. Actual Explorer/external-folder proof/toolbar lifetime and broader site/audio/crash/quota checks remain pending; this is a preview. Earlier release tags and assets stay unchanged.

## 2.0.0.30 — grouped notices and file locations

- Separate worker provider, pipeline, animation and offscreen lifetime modules; share checked download contracts with the UI while preserving media guards and existing save behavior.
- Group bulk-save page notices into one stable activity card with localized outcome counts and dismissal suppression.
- Keep the toolbar badge stable through parallel/queued downloads; preserve readable errors and guard stale asynchronous updates.
- Add file-location buttons to completed download cards. Browser downloads reveal through the OS file manager; chosen-directory writes use a browser picker at the stored file's actual parent. Preserve cards on failure and keep picker cancellation silent.

Automated regressions, source/build parity and isolated extension fixtures passed. Real Windows file-location dialogs, actual toolbar-popup lifetime and broader manual regression gates remain pending. This preview includes these changes; earlier release assets and tags are unchanged.

## 2.0.0.29 — organized source and current interface

- Organize site scripts in `content/` and offline checks in `tests/`; extract existing worker format, destination/naming and dedicated-site resolver modules without changing their behavior. Update runtime injection and commit-based packaging paths.
- Make Violet the default theme, refresh saving/link settings and the EN/RU visual README. Add destination-folder selection and optional x.com author folders.
- Receive files concurrently, support declared post batches up to 100 files, and clear the manager list immediately. Preserve selected-original and truthful format validation.
- Replace desktop notifications with bounded MediaLatch page notices. Add short menu/disclosure/notice transitions and smooth committed language changes, respecting reduced motion and mounted drafts. Display x.com consistently.

- Add persistent Blue, Dark and Light themes across extension pages.
- Replace retained-history totals with configurable, clearable aggregate Statistics; import only legacy records still available locally.
- Stage and validate complete files in private disk-backed browser storage before exporting prepared bytes. Show stages, received/total, speed and approximate time when measurable, queue pause, cancellation and explicit retry.
- Merge progress, controls and result/report details into one download card; fix long Russian tab labels and keyboard visibility on narrow windows.
- Preserve pending statistics and refuse unpersisted record removal; keep signed source addresses out of public snapshots and reports.

User-confirmed ordinary Helium checks and isolated native transfer/UI fixtures passed. Native crash/restart, quota stress and broad codec/audio acceptance remain pending. These changes ship in v2.0.0.29 preview; this is not complete browser or store acceptance.

## 2.0.0.28 — Sankaku originals and bounded metadata

- Resolve selected Sankaku preview/sample media to the same post's declared original, preserving its exact signed URL and real format instead of saving an AVIF thumbnail. Refuse ambiguous or inaccessible originals.
- Allow one bounded authenticated same-origin post-page lookup when the original is not in the current DOM: 20-second deadline through headers/body, 1 MiB HTML limit, selected-node continuity and specific network diagnostics.
- Bound generic MD5 metadata reads to 3 seconds through headers/body and 1 MiB of streamed bytes; cancel refused, failed and completed transfers. A stalled or oversized response no longer holds up this lookup indefinitely.
- Update English/Russian README coverage and roadmap. Add a security/store-readiness plan; Kemono remains deferred.

Preview validation: independent source review, production-path offline regressions and UI parity checks. The user reports working Sankaku image/video smoke tests in Helium. Native Sankaku GIF testing is pending because search was unavailable under the site's reported rate/subscription limits. This is not a completed security audit or Chrome Web Store approval.

## 2.0.0.27 — save fixes and optional debugging

- Add an opt-in local Debug panel with correlated content/frame/worker/UI events, filters, copy/export and clear controls. Bound the journal to 2,000 events, 1 MiB and 24 hours; omit full URLs, tokens, page text and local paths.
- Correct selected X quote owners, lazy media lookup before playback and multi-video Save all batches.
- Restore inline controls and first-click saves after feed scrolling and frame changes, including Reddit/RedGIFs. Start runtime injections immediately in loading frames.
- Preserve supported Reddit HLS audio and playback seeking; report Pawchive originals that the site has not imported.
- Save the verified source MP4 when X/Reddit animation conversion exceeds input or encoded GIF size limits. Keep existing limits and unrelated error handling; describe the MP4 result in save feedback.
- Preserve machine-readable conversion failure codes in Debug reports.

Preview validation: 42/42 automated checks on the accepted implementation and user-confirmed reported X, Reddit and RedGIFs cases in Helium. Other layouts, browsers and oversized-input native behavior remain outside that acceptance.

## 2.0.0.26 — MediaLatch and English / Russian

- Rename the product and repository to MediaLatch with a new M/download mark; keep existing preferences and save folders compatible. Runtime assets use the MediaLatch prefix.
- Add a persistent English / Russian interface choice across extension pages, notifications and inline labels.
- Keep the context-menu action fixed as MediaLatch: Save media; original discovery still starts after choosing it.

- Fix stale inline translations, language-change write races and repeated RedGIFs subscriptions; keep compact Russian save-all labels within their existing width.
- Update release checks and current project links after the repository rename.

The first public preview below retains its original Image Saver name and asset names.

## 2.0.0.25 — first public preview

### Release preparation

- Publish current product source, ready-built UI, tests and clean commit-based runtime packaging.
- Add English/Russian documentation, privacy details, store preparation notes and extension icons.
- License project-owned code as GPL-3.0-only; restore complete bundled notices.
- Point release checks at xhthc/ImageSaver and discard the old repository's cache.

### Fixes

- Prevent unreadable saving settings from being overwritten with defaults.
- Bound and validate buffered Pixiv images; keep the request deadline active while reading.
- Cap GIF conversion input and RedGIFs metadata before full buffering.
- Redact Reddit/CDN signatures in diagnostic copies without changing actual URLs.
- Replace two UI components with a small Radix tooltip and CSS fade for clear redistribution terms.

### Included earlier work

- Constant Image Saver: Save media menu title; discovery after choosing Save.
- All declared Pawchive post originals from feed previews, including covers and numbered CDN sources.
- Provider-selected inline saves and restricted Reddit HLS assembly.
- One eligible browser-native resume attempt on NETWORK_FAILED.

Kemono integration, a general download manager, universal selection, ZIP batches, arbitrary drive paths and Firefox support remain planned. Native acceptance of this preview's hardening changes and Chrome Web Store submission remain separate steps.
