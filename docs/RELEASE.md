# Release preparation

The current GitHub pre-release is v2.5.5. It adds proven X/Reddit/Pixiv author labels to notices and both managers, balanced popup gutters, signed-query log redaction and experimental VK inline controls. VK buttons use the visible upper-left corner and follow scrolling below a fixed/sticky header. Existing site/post groups and inline paths are retained. Existing organization, preview hosts, statistics and request guards remain. Release assets contain only the runtime ZIP, SHA-256 and per-file provenance JSON. Store preparation, submission and approval remain separate states; this document does not claim store approval or exhaustive browser coverage.

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

The v2.5.5 preview keeps the Explorer companion, folder-location controls and native messaging permission removed. It retains four themes, first-install welcome, author folders, selected-media continuity and local statistics. Shared inline/runtime refactoring preserves validated ownership and acquisition boundaries. Downloads and Embed changes were user-checked in popup/settings and isolated fixtures. Package the exact accepted commit, including reorganized worker/offscreen imports; no companion archive is produced.

## Permission and privacy disclosures

Use the permission justifications in [PRIVACY.md](PRIVACY.md). Explain broad host access as selected-media discovery across HTTP/HTTPS pages and fetching declared originals/CDNs. Do not claim that reading page content or retaining local URLs is no data processing. Review the actual build against the dashboard's current fields and [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

All executed JavaScript and binary-processing libraries are bundled locally. GitHub/provider responses are data. Maintain the [remote hosted code restrictions](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).

## Validation and remaining store gates

Accepted changes have independent reviews and bounded user Helium confirmation for X/Reddit/Pixiv/RedGIFs inline saves, Downloads grouping and floating settings help. Automated offline/UI and disposable browser checks cover batch cancellation/recovery, metadata chronology, hover/focus, localized layouts and stored settings. Release-specific checks must bind the version, committed runtime bytes, ZIP inventory, native startup/export and published assets. Author labels were user-confirmed on X/Reddit/Pixiv. For VK, the user confirmed button appearance after a hard reload; top-left scroll behavior has source/mock and isolated headless Helium fixture evidence. Live inline export, original-photo parity, complete-post lists, videos/clips and audio are not accepted; full first-increment VK scope remains unfinished. Earlier version checks remain historical evidence. Broad audio/codec, quota/crash, Google Chrome, DNS rebinding and full security certification remain unclaimed.

The user reports that Chrome Web Store 2.5.2 was approved and publicly published, then accidentally unpublished. This GitHub 2.5.5 preview does not restore or update that store listing. Store republication and review remain a separate task. GitHub releases contain only the runtime ZIP, SHA-256 and source/per-file provenance JSON.

- Inspect final-package code/CSP, all privileged message/job boundaries, URL/redirect/private-network admission, resource limits, minimum permissions and dependencies/supply-chain integrity. The scoped release review is not a complete security audit.
- Load the exact runtime ZIP in a clean Chromium profile. Confirm installation, permissions, popup/settings/history, unchanged first-click Save media and actual saved files.
- Check both interface languages: English -> Russian -> English on the full page and the popup, close/reopen and browser restart, both page sizes, notifications, inline button labels and accessible names, and a failed language save. The native menu title must stay **MediaLatch: Save media**.
- Verify representative X, Reddit, RedGIFs, Pawchive and Sankaku image/video/GIF cases, including video audio where declared, reload/restart, missing files and rate-limit behavior. Existing ordinary acceptance does not establish every layout or browser.
- Test at least Chrome plus the main Helium environment; broader Chromium/Firefox acceptance remains separate.
- Capture real product screenshots using neutral, permitted media. Do not reuse private logs, account details or mature source-site previews in store imagery.
- Supply a small promotional image and screenshots. Current [image requirements](https://developer.chrome.com/docs/webstore/images): 128×128 PNG icon; 440×280 small promo; at least one 1280×800 or 640×400 full-bleed screenshot. Prepare store graphics separately for manual upload; keep them outside GitHub release assets and select five screenshots from one language.
- Complete current dashboard privacy declarations and publisher/contact requirements, then review listing and package before a separately authorized submission.

See the official [preparation guide](https://developer.chrome.com/docs/webstore/prepare). The extension currently checks releases without self-installing them. Store updates will use the store's distribution channel after publication, with their own review/release process.
