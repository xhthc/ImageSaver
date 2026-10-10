# Release preparation

The GitHub build is an early public release. This document prepares a later Chrome Web Store submission; it is not a claim of store approval or complete browser acceptance.

## Build and package

1. Use the committed UI lockfile: `npm ci --prefix ui`.
2. If licences/dependencies changed, run `npm run notices --prefix ui` and inspect complete notices.
3. Run `npm run build --prefix ui`, then `node tools/verify.mjs --ui`.
4. Independently review the exact candidate, resolve blockers, and commit only product source/docs/tests/build assets.
5. Run `node tools/package.mjs <accepted-commit>`; inspect its ZIP, SHA-256 and per-file inventory. The manifest is at the ZIP root.
6. Publish that exact source commit and runtime asset together. Source ZIPs contain development files; the runtime ZIP does not.

Never package arbitrary working-folder contents. Local agent files, recovery archives, credentials, logs, dependencies and task notes are excluded. A numeric version alone does not identify a build; use the recorded source SHA and ZIP hash.

## Draft listing

**Name:** MediaLatch

**Single purpose:** Save accessible original media selected on a web page, with local save feedback and optional history.

**Short English description:** Save available original images, videos and GIFs from the context menu, with selected site support and local save history.

**English description:**

> Save available original images, videos and GIFs with MediaLatch: Save media. Supported paths include X, Reddit, RedGIFs and Pawchive, plus generic image discovery. Selected animations can be saved as genuine GIFs. Organize files within Downloads, inspect save results and optionally keep seven days of local history. There is no telemetry or extension backend. Site access rules and format limits apply; universal stream/DRM downloading is not supported. See the repository for current coverage and privacy details.

**Russian description:**

> Сохраняйте доступные оригинальные изображения, видео и GIF через MediaLatch: Save media. Поддерживаются отдельные сценарии X, Reddit, RedGIFs и Pawchive и универсальный поиск изображений. Подтверждённые анимации преобразуются в настоящий GIF. Доступны подпапка в «Загрузках», результаты сохранения и отключаемая локальная история за семь дней. Телеметрии и сервера расширения нет. Действуют ограничения форматов и доступа сайтов; DRM и универсальная загрузка потоков не поддерживаются.

Website: https://github.com/xhthc/MediaLatch

Privacy URL: https://github.com/xhthc/MediaLatch/blob/main/docs/PRIVACY.md

Support URL: https://github.com/xhthc/MediaLatch/issues

The v2.0.0.26 preview includes MediaLatch branding and an English / Русский interface choice with persistent preferences, translated notifications and inline labels. It remains an early preview; store submission and the broader browser/site matrix are separate gates.

## Permission and privacy disclosures

Use the permission justifications in [PRIVACY.md](PRIVACY.md). Explain broad host access as selected-media discovery across HTTP/HTTPS pages and fetching declared originals/CDNs. Do not claim that reading page content or retaining local URLs is no data processing. Review the actual build against the dashboard's current fields and [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

All executed JavaScript and binary-processing libraries are bundled locally. GitHub/provider responses are data. Maintain the [remote hosted code restrictions](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).

## Remaining store gates

- Load the exact runtime ZIP in a clean Chromium profile. Confirm installation, permissions, popup/settings/history, unchanged first-click Save media and actual saved files.
- Check both interface languages: English -> Russian -> English on the full page and the popup, close/reopen and browser restart, both page sizes, notifications, inline button labels and accessible names, and a failed language save. The native menu title must stay **MediaLatch: Save media**.
- Verify representative X, Reddit, RedGIFs and Pawchive image/video/GIF cases, including video audio where declared, reload/restart, missing files and rate-limit behavior. Existing ordinary acceptance does not establish every layout or browser.
- Test at least Chrome plus the main Helium environment; broader Chromium/Firefox acceptance remains separate.
- Capture real product screenshots using neutral, permitted media. Do not reuse private logs, account details or mature source-site previews in store imagery.
- Supply a small promotional image and screenshots. Current [image requirements](https://developer.chrome.com/docs/webstore/images): 128×128 PNG icon; 440×280 small promo; at least one 1280×800 or 640×400 full-bleed screenshot. Runtime icons are provided; listing promo/screenshots still need preparation.
- Complete current dashboard privacy declarations and publisher/contact requirements, then review listing and package before a separately authorized submission.

See the official [preparation guide](https://developer.chrome.com/docs/webstore/prepare). The extension currently checks releases without self-installing them. Store updates will use the store's distribution channel after publication, with their own review/release process.