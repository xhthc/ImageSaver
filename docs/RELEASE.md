# Release preparation

The current GitHub pre-release is v2.5.8. It removes generic inline download controls and their worker route; explicit HTTPS/tested-host/top-frame checks also apply after fallback injection. Tested X/Twitter, Reddit, Pixiv, RedGIFs and VK controls remain. The user confirmed the unrelated-page false positives are gone. Copy/embed actions now share the installed Lucide Copy icon.

TikTok/Instagram selected-video saving through the browser context menu is experimental. Progressive sources must belong to the gesture-selected player and declared item; exact signed URLs and the existing download manager are retained. A login/modal/consent surface cannot select a player outside that surface. Real user-profile feed selection and audible playback remain unverified; later separate DASH tracks are unsupported. Recorded native Instagram export and separate TikTok acquisition evidence do not establish full live coverage. YouTube downloads and general VK video/clips remain out of scope.

Release assets contain only the accepted commit's runtime ZIP, SHA-256 and per-file provenance JSON. The repository stays private; the unauthenticated update checker gets 404, so use an authorized GitHub account to download manually. Previous release assets/tags stay intact. Store submission and approval remain separate.

## Build and package

1. Use the committed UI lockfile: `npm ci --prefix ui`.
2. If licences/dependencies changed, run `npm run notices --prefix ui` and inspect complete notices.
3. Run `npm run build --prefix ui`, then `node tools/verify.mjs --ui`.
4. Independently review the exact candidate, resolve blockers, and commit only product source/docs/tests/build assets.
5. Run `node tools/package.mjs <accepted-commit>`; inspect its ZIP, SHA-256 and per-file inventory. The manifest is at the ZIP root.
6. For an authorized GitHub release, publish the accepted tag as a pre-release with only the runtime ZIP, SHA-256 and provenance JSON; verify downloaded asset hashes. For a separately authorized store submission, upload that verified runtime ZIP to the existing Chrome Web Store draft. Do not upload the WebStore-Materials ZIP as extension code. Source ZIPs contain development files; the runtime ZIP does not.

Never package arbitrary working-folder contents. Local agent files, recovery archives, credentials, logs, dependencies and task notes are excluded. A numeric version alone does not identify a build; use the recorded source SHA and ZIP hash.

## Draft listing

**Name:** MediaLatch

**Single purpose:** Save accessible original media selected on a web page, organized locally with download feedback and optional statistics.

**Short English description:** Save available original images, videos and GIFs, with parallel downloads, custom folders and local statistics.

**English description:**

> Save available original images, videos and GIFs with MediaLatch: Save media. Supported paths include x.com, Reddit, RedGIFs, Pawchive and selected Sankaku originals, plus generic image discovery. Selected animations can be saved as genuine GIFs. Track parallel downloads, choose a writable destination or organize files within Downloads, inspect save results and optionally collect local aggregate statistics. There is no telemetry or extension backend. Site access rules and format limits apply; universal stream/DRM downloading is not supported. See the repository for current coverage and privacy details.

**Russian description:**

> Сохраняйте доступные оригинальные изображения, видео и GIF через MediaLatch: Save media. Поддерживаются отдельные сценарии x.com, Reddit, RedGIFs, Pawchive, оригиналы выбранных постов Sankaku и универсальный поиск изображений. Подтверждённые анимации преобразуются в настоящий GIF. Доступны параллельные загрузки, выбор папки, результаты сохранения и отключаемая локальная статистика. Телеметрии и сервера расширения нет. Действуют ограничения форматов и доступа сайтов; DRM и универсальная загрузка потоков не поддерживаются.

Website: https://github.com/xhthc/MediaLatch

Privacy URL: https://github.com/xhthc/MediaLatch/blob/main/docs/PRIVACY.md

Support URL: https://github.com/xhthc/MediaLatch/issues

The v2.5.8 preview uses `chrome.downloads.show(downloadId)` for finished, extension-owned browser downloads. Direct File System Access exports have no DownloadItem and show no folder icon. No companion, native-messaging permission, new permission or dependency is added. Inline download controls run only on the tested HTTPS/top-frame service surfaces. Instagram/TikTok load shared account helpers without download controls. Posting-account labels/folders cover X, Reddit, Pixiv, VK, RedGIFs, Instagram and TikTok only when the selected media has positive ownership evidence. The four DNR header rules apply only to the extension's requests to their admitted domains. Dashboard privacy declarations and listing text still need review before a separate store submission.

Publishing stays manual and separately authorized. If store automation is authorized later, the documented publisher interface is Chrome Web Store API v2 (`chromewebstore.googleapis.com`, `publishers/*/items/*`: `upload`, `fetchStatus`, `publish`, `cancelSubmission`, `setPublishedDeployPercentage`); upload, status, review and publication are distinct steps. The review-skip path covers only updates that change safe static rules in `rule_resources` files; this candidate changes code and dynamic rules and needs standard review.

## Permission and privacy disclosures

Use the permission justifications in [PRIVACY.md](PRIVACY.md). Explain broad host access as selected-media discovery across HTTP/HTTPS pages and fetching declared originals/CDNs. Do not claim that reading page content or retaining local URLs is no data processing. Review the actual build against the dashboard's current fields and [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

All executed JavaScript and binary-processing libraries are bundled locally. GitHub/provider responses are data. Maintain the [remote hosted code restrictions](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).

## Validation and remaining store gates

Accepted changes have independent reviews and bounded user Helium confirmation for X/Reddit/Pixiv/RedGIFs inline saves, Downloads, floating settings help, author labels and now VK photo/carousel/collage saves. Recorded live VK checks cover selected photos and complete observed lists; a mixed seven-item post exported five JPEGs and two MP4s with structurally verified audio tracks. No audible listening or original-photo quality acceptance is implied. Standalone videos/clips are deferred; private/access-key, general blob/MSE/HLS/DASH and other-browser coverage remain unclaimed. Offline/UI and isolated native checks are recorded separately from live user acceptance. Release-specific checks bind the version, committed runtime bytes, ZIP inventory, native startup/export and published assets. Earlier checks remain historical evidence; this is not full security, crash or quota certification.

The user reports that Chrome Web Store 2.5.2 was approved and publicly published, then accidentally unpublished. This GitHub 2.5.8 preview does not restore or update that store listing. Store republication and review remain a separate task. GitHub releases contain only the runtime ZIP, SHA-256 and source/per-file provenance JSON.

- Inspect final-package code/CSP, all privileged message/job boundaries, URL/redirect/private-network admission, resource limits, minimum permissions and dependencies/supply-chain integrity. The scoped release review is not a complete security audit.
- Load the exact runtime ZIP in a clean Chromium profile. Confirm installation, permissions, popup/settings/history, unchanged first-click Save media and actual saved files.
- Check both interface languages: English -> Russian -> English on the full page and the popup, close/reopen and browser restart, both page sizes, notifications, inline button labels and accessible names, and a failed language save. The native menu title must stay **MediaLatch: Save media**.
- Verify representative X, Reddit, RedGIFs, Pawchive and Sankaku image/video/GIF cases, including video audio where declared, reload/restart, missing files and rate-limit behavior. Existing ordinary acceptance does not establish every layout or browser.
- Test at least Chrome plus the main Helium environment; broader Chromium/Firefox acceptance remains separate.
- Capture real product screenshots using neutral, permitted media. Do not reuse private logs, account details or mature source-site previews in store imagery.
- Supply a small promotional image and screenshots. Current [image requirements](https://developer.chrome.com/docs/webstore/images): 128×128 PNG icon; 440×280 small promo; at least one 1280×800 or 640×400 full-bleed screenshot. Prepare store graphics separately for manual upload; keep them outside GitHub release assets and select five screenshots from one language.
- Complete current dashboard privacy declarations and publisher/contact requirements, then review listing and package before a separately authorized submission.

See the official [preparation guide](https://developer.chrome.com/docs/webstore/prepare). The extension currently checks releases without self-installing them. Store updates will use the store's distribution channel after publication, with their own review/release process.
