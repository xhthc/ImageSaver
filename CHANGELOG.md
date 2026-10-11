# Changelog

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
