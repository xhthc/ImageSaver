<p align="center"><img src="docs/assets/banner.svg" alt="MediaLatch — save available originals" width="880"></p>

<p align="center"><a href="README.ru.md">Русский</a> · <a href="https://github.com/xhthc/MediaLatch/releases">Downloads</a> · <a href="docs/PRIVACY.md">Privacy</a> · <a href="LICENSE">GPL-3.0</a></p>

MediaLatch (formerly Image Saver) is a Chromium extension for saving accessible original images, videos and GIFs. Right-click media and choose **Save media**. Source discovery starts after you choose Save; the menu title stays fixed.

> **Current preview: [v2.0.0.28](https://github.com/xhthc/MediaLatch/releases/tag/v2.0.0.28).** Sankaku previews now save the selected post's declared original instead of the AVIF thumbnail. Slow post responses have a bounded 20-second deadline and explicit network diagnostics. Includes the earlier X/Reddit fixes, optional Debug journal and source MP4 fallback for oversized GIF conversions.

Tested primarily in Helium on Windows. Coverage is limited to the paths below; site layouts and access rules can change. Firefox and Chrome Web Store distribution are planned.

## Features

- Original discovery through site adapters, image links, `srcset`, media attributes and unambiguous CSS backgrounds or overlays.
- Native images/GIFs and accessible MP4/WebM videos. Exact declared URLs, including signatures, are preserved.
- Genuine looping GIFs from confirmed X and Reddit MP4 animations. Animations longer than 30 seconds or exceeding conversion size limits remain source MP4; other conversion failures are reported.
- Compact inline save controls on X, Reddit and RedGIFs, with bounded post batches on X and Reddit.
- All distinct declared original media from a Pawchive feed preview, including the original cover. Selecting an individual attachment saves that attachment.
- A Downloads subfolder, optional site/type organization, save results and copyable redacted error reports.
- Opt-in local history: up to 50 finished saves for seven days, with statistics for that retained history.
- Opt-in local Debug journal with filters, copy/export and clear controls: up to 2,000 events, 1 MiB and 24 hours. Full URLs, tokens, page text and local paths are excluded.
- Supported post-link copying on X, Instagram, TikTok and YouTube Shorts, with optional preview-link hosts.
- GitHub release checks manually or on opening Updates, at most daily. Downloaded extension code is not installed automatically.

## Site coverage

| Source | Current behavior |
|---|---|
| X / Twitter | Selected images/videos, confirmed MP4 animations, inline saving and post batches |
| Reddit | Originals, animations, inline saving; selected finite, unencrypted H.264/AAC Reddit HLS streams assembled into MP4 |
| RedGIFs | Selected clip and same-clip video renditions; inline saving; provider audio recovery where available |
| Pawchive | Declared post originals from previews or individual attachments; batches capped at 20, with spaced starts and a rate-limit stop |
| Sankaku | Selected preview/sample to declared same-post original via the context menu in feeds/opened posts; image/video smoke tests reported working in Helium, native GIF test pending |
| Other sites | Generic discovery plus existing rules, including Pixiv and selected booru paths; coverage varies |

Kemono is deferred while the site is unavailable. Broader booru compatibility needs separate integration and live validation. A thumbnail alone does not prove the original file. Ambiguous targets and inaccessible sources can be refused. Sankaku search/subscription limits are respected; this preview does not bypass them.

## Install

1. Download the **runtime ZIP** from [Releases](https://github.com/xhthc/MediaLatch/releases) and extract it. Choose `MediaLatch-2.0.0.28-*.zip` from the current preview; its filename includes the source commit. GitHub's automatic Source code ZIP contains the development repository.
2. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked** and choose the folder containing `manifest.json`.
3. After replacing a build, reload the extension **and refresh site tabs**.

Alternatively, clone and load the repository root:

```bash
git clone https://github.com/xhthc/MediaLatch.git
```

To update an unpacked installation, replace the files in its existing folder, then click **Reload** on the browser's extensions page and refresh site tabs. Keep the same folder to retain the extension's identity and settings.

The committed `popup/` pages are ready to use. Node/npm are needed only for development. Unpacked installs update manually; store updates will be a separate distribution path.

## Use and settings

Right-click an image, video or supported post preview and select **MediaLatch: Save media**. On X, Shift + right-click can open the browser menu when the site handles right-click itself.

The toolbar popup shows recent results. Its full page contains history, saving preferences, notifications, link settings and release checks. Files default to `Downloads/SavedImages/`. Site/type organization creates paths such as `SavedImages/x/pic/`, `video/` and `gif/`.

Choose **Language** at the top of the full page to switch between English and Russian. The saved choice applies immediately to extension pages, notifications and inline buttons. With no saved choice, a Russian browser uses Russian; other browsers use English. The menu title stays **MediaLatch: Save media** in both languages. Renaming preserves existing preferences and save folders.

To discover this preview in **Updates**, set **Update channel** to **Regular and beta releases**, or download it directly from Releases. Unpacked installations update manually.

For troubleshooting, enable recording in **Debug**, reproduce the problem, then copy or export the filtered events. Recording starts when enabled; turning it off preserves the journal until it is cleared or expires. Reports stay local unless you share them.

Paths are relative to the browser's Downloads directory. Arbitrary drive paths and author folders are planned. The browser owns ordinary transfers; eligible `NETWORK_FAILED` downloads get one native resume attempt.

## Limits and privacy

DRM, access bypass, arbitrary blob/MSE players and general HLS/DASH downloads are not supported. Separate audio tracks are assembled only within the supported Reddit HLS path. Missing files, rate limits and permission failures cannot be guaranteed away.

GIF conversion is bounded to 50 MiB input, 30 seconds, 150 frames, 640 px output, 15 MiB encoded output and 45 seconds of processing. Buffered Pixiv images have a 50 MiB ceiling. These are limits of specific processing paths, not every direct browser download.

There is no telemetry or extension backend. History and Debug recording are off by default; reports are copied or exported only on request. Sites/CDNs receive requests needed to resolve/save media, and GitHub receives release checks. See [Privacy](docs/PRIVACY.md).

## Roadmap

Plans below are **not implemented in this preview**. They describe direction, not promised dates or support for every layout. Reliability comes first; each capability needs a separate implementation and browser check.

| Area | Planned result | Status |
|---|---|---|
| Booru engines and generic media | Reuse proven original/ownership rules across evidenced engines; improve selected media and Yandex/Google image-result discovery | Next compatibility work |
| Controls and selection | Small universal inline controls and optional post/media multi-selection | Planned |
| Download manager | Persisted queue, truthful file/batch progress, cancellation, supported pause/resume, paced requests and 429 cooldowns | Planned |
| Complete-file staging | Disk-backed acquisition/validation before export, bounded memory and restart cleanup; no second remote download at export | Feasibility before implementation |
| Batch archives | Selected-post/page batches, ZIP first; 7z only if a practical bounded implementation is justified | Planned |
| Destination and naming | Proven-author folders starting with X, validated layout presets and an authorized directory picker where supported | Planned; arbitrary drive paths need feasibility checks |
| Kemono | Declared same-post originals and scoped feed behavior | Deferred until the site is usable |
| Optional publishing | Separate VK/Telegram composers, preview and explicit send, then scheduling and duplicate-safe reconciliation | Later; authorization, credentials and a durable scheduler need their own design |
| Browsers and distribution | Broader Chromium checks, Firefox port, Chrome Web Store and store-managed updates | Planned; security/privacy gates first |

The Telegram/VK roadmap concerns **publishing**.

## Security before store submission

RCE (remote code execution) is a vulnerability to prevent. Executable extension code is bundled locally; release checks read metadata and never install or run downloaded code. Manifest V3's default extension-page CSP applies.

Priorities before Chrome Web Store submission: packaged-code/CSP checks, complete sender/action/frame validation, URL and redirect restrictions including private-network targets, a minimum-permission review, and dependency/release integrity. Keep page/API data out of executable code and unsafe HTML rendering; test malformed media and resource exhaustion. These are planned gates, **not a completed security audit or store approval**. Current broad HTTP/HTTPS access needs particular review.

See [Security and store readiness](docs/SECURITY.md), [Privacy](docs/PRIVACY.md) and [Release preparation](docs/RELEASE.md).

Beyond RCE, review XSS, forged runtime messages, SSRF/private-network access, unsafe download paths, resource exhaustion, data leaks and dependency/publisher-account compromise. Add defenses where the boundary review demonstrates a need; existing safeguards and remaining gaps are documented separately.

## Development

Use Node.js 26, or another runtime compatible with the UI lockfile.

```bash
npm ci --prefix ui
npm run build --prefix ui
node tools/verify.mjs --ui
node tools/package.mjs HEAD
```

Edit `ui/`, then rebuild `popup/`. Verification covers offline regressions, UI typechecking/rendering and source/build parity. Native playback, audio and actual saved bytes need separate live checks. Packaging reads an accepted Git commit and writes a runtime ZIP plus source SHA, version and hash metadata under `local-notes/releases/`.

[Architecture](docs/ARCHITECTURE.md) · [Release preparation](docs/RELEASE.md) · [Changelog](CHANGELOG.md)

[Tests](test_suite.js): the main offline suite can also run directly with `node test_suite.js`.

## License

Project-owned code is **GPL-3.0-only**. Third-party code and icon glyphs retain their original notices: [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), [UI notices](popup/THIRD_PARTY_NOTICES.txt) and the [MP4Box license](lib/vendor/mp4box/2.4.1/LICENSE).
