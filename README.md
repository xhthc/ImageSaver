<div align="center">
  <img src="icons/128.png" width="120" height="120" alt="MediaLatch">
  <h1>MediaLatch</h1>
  <p><i>"Save available originals directly from your browser — images, videos and GIFs, organized your way."</i></p>
  <p>
    <a href="https://github.com/xhthc/MediaLatch/releases/tag/v2.0.0.31"><img src="https://img.shields.io/badge/preview-v2.0.0.31-22d3ee?style=flat&amp;logo=github&amp;logoColor=white" alt="Preview v2.0.0.31"></a>
    <img src="https://img.shields.io/badge/Platform-Chromium-a855f7?style=flat" alt="Platform: Chromium">
    <img src="https://img.shields.io/badge/Extension-Manifest_V3-f97316?style=flat" alt="Extension: Manifest V3">
    <img src="https://img.shields.io/badge/UI-React_%2B_TypeScript-6366f1?style=flat" alt="UI: React + TypeScript">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL--3.0--only-22c55e?style=flat" alt="License: GPL-3.0-only"></a>
  </p>
  <p>
    <a href="https://github.com/xhthc/MediaLatch/releases/tag/v2.0.0.31"><img src="docs/assets/download-github.svg" height="44" alt="Download preview on GitHub"></a>
    <img src="docs/assets/store-chrome-planned.svg" height="44" alt="Chrome Web Store distribution planned; not yet available">
    <img src="docs/assets/store-firefox-planned.svg" height="44" alt="Firefox support and distribution planned; not yet available">
  </p>
  <p><a href="README.ru.md">Русский</a> · <a href="#quick-start">Quick start</a> · <a href="#install">Installation</a> · <a href="#roadmap">Roadmap</a> · <a href="docs/PRIVACY.md">Privacy</a></p>
</div>

MediaLatch (formerly Image Saver) is a Chromium extension for saving accessible original images, videos and GIFs. Right-click media and choose **Save media**, track parallel downloads and choose where files go — including **a folder for each x.com author**.

> **Current preview: [v2.0.0.31](https://github.com/xhthc/MediaLatch/releases/tag/v2.0.0.31).** Notices keep working after returning from the manager. Chosen-folder location buttons can open Windows Explorer through the optional companion. Violet interface, parallel saves and English/Russian settings.

The runtime ZIP includes the current worker refactoring and interface changes. Actual Windows Explorer launch/external-folder proof, toolbar-popup lifetime and broader manual regression checks remain pending.

Tested primarily in Helium on Windows. Coverage is limited to the paths below; site layouts and access rules can change. Firefox and Chrome Web Store distribution are planned.

---

## Interface

<table>
  <tr>
    <td width="50%"><img src="docs/assets/settings-saving.png" alt="Violet Saving settings: destination, organization and example path"><br><strong>Choose where files go</strong><br>Destination, optional subfolder, author folders and a live path example.</td>
    <td width="50%"><img src="docs/assets/settings-links.png" alt="Link previews: one domain selector per platform"><br><strong>Choose how links are shared</strong><br>One selector per platform; service details stay expandable.</td>
  </tr>
</table>

Current interface with demonstration settings. Violet by default, English/Russian localization and short transitions that respect reduced motion.

---

## Quick start

1. Install the runtime ZIP using the instructions below.
2. Right-click an image, video or supported preview and choose **MediaLatch: Save media**. On X, try **Shift + right-click** if the site intercepts the menu.
3. Track downloads in the popup. **Open download manager** leads to details, cancellation and retrying export from prepared bytes. MediaLatch notices appear on the original page.
4. Open **Saving**, choose a destination and organization, then press **Save settings**. Files default to `Downloads/SavedImages/`.

An automatic first-run introduction is planned; this quick guide is available now.

---

## Install

1. Download the **runtime ZIP** from [Releases](https://github.com/xhthc/MediaLatch/releases) and extract it. Choose `MediaLatch-2.0.0.31-*.zip` from the current preview; its filename includes the source commit. GitHub's automatic Source code ZIP contains the development repository.
2. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked** and choose the folder containing `manifest.json`.
3. After replacing a build, reload the extension **and refresh site tabs**.

For the **folder button on chosen-directory files in Windows**, also extract `MediaLatch-Explorer-Windows-2.0.0.31-*.zip` and follow the [companion installation guide](native/windows/README.md). Install for your actual extension ID, then use **Link folder to Explorer** in Saving. The companion is optional for saving files; ordinary browser Downloads reveal without it.

Alternatively, clone and load the repository root:

```bash
git clone https://github.com/xhthc/MediaLatch.git
```

To update an unpacked installation, replace the files in its existing folder, then click **Reload** on the browser's extensions page and refresh site tabs. Keep the same folder to retain the extension's identity and settings.

The committed `popup/` pages are ready to use. Node/npm are needed only for development. Unpacked installs update manually; store updates will be a separate distribution path.

---

## Features

The packaged preview includes these features. Ordinary downloads, themes, Statistics, chosen-folder routing and Pixiv batches were checked in Helium; the user confirmed notices after manager return. Isolated Windows host communication passed; actual Explorer launch/external-folder proof/toolbar lifetime, native crash/restart, quota stress and broader codec/audio checks remain pending.

### Save the selected media

- Original discovery through site adapters, image links, `srcset`, media attributes and unambiguous CSS backgrounds or overlays.
- Native images/GIFs and accessible MP4/WebM videos. Exact declared URLs, including signatures, are preserved.
- Genuine looping GIFs from confirmed X and Reddit MP4 animations. Animations longer than 30 seconds or exceeding conversion size limits remain source MP4; other conversion failures are reported.
- Compact inline save controls on X, Reddit and RedGIFs, with bounded post batches on X and Reddit.
- All distinct declared original media from a Pawchive feed preview, including the original cover. Selecting an individual attachment saves that attachment.

### Manage files

- Choose a writable base folder, an optional subfolder and site/type organization. X can also use folders named after the selected post author. Save results and redacted error reports stay in the manager.
- Download manager with received/total bytes, speed and approximate remaining time when measurable. Complete files are staged locally before browser export; failed export can retry from retained bytes without another source download.
- Folder icons on completed files: browser downloads reveal the file in the OS manager; chosen-folder saves open Windows Explorer through the optional installed companion and linked destination. Missing helper, binding or file retains the card with recovery instructions.

### Settings and diagnostics

- Own MediaLatch notices on the source page, grouping bulk saves into one card with success/error counts, dismiss/manager buttons and synchronized themes. Closed or navigated tabs cannot display them; results and the failure badge remain in the extension. Success notices can be switched off independently.
- Violet interface theme by default, with optional Blue, Dark and Light themes. Saved choices apply across the popup and settings page; existing preferences are preserved. Brief interface animations respect reduced motion.
- Opt-in local statistics without an entry count or time limit, with recording and clear controls. Available old history is imported once; expired or removed records cannot be reconstructed.
- Opt-in local Debug journal with filters, copy/export and clear controls: up to 2,000 events, 1 MiB and 24 hours. Full URLs, tokens, page text and local paths are excluded.
- Supported post-link copying on X, Instagram, TikTok and YouTube Shorts, with optional preview-link hosts.
- GitHub release checks manually or on opening Updates, at most daily. Downloaded extension code is not installed automatically.

---

## Site coverage

| Source | Current behavior |
|---|---|
| X / Twitter | Selected images/videos, confirmed MP4 animations, inline saving and post batches |
| Reddit | Originals, animations, inline saving; selected finite, unencrypted H.264/AAC Reddit HLS streams assembled into MP4 |
| RedGIFs | Selected clip and same-clip video renditions; inline saving; provider audio recovery where available |
| Pawchive | Declared post originals from previews or individual attachments; common 100-file batch limit, with spaced starts and a rate-limit stop |
| Sankaku | Selected preview/sample to declared same-post original via the context menu in feeds/opened posts; image/video smoke tests reported working in Helium, native GIF test pending |
| Pixiv | Feed previews save the post's declared original pages (up to 100); an image selected inside an opened artwork remains single |
| Other sites | Generic discovery plus existing rules, including selected booru paths; coverage varies |

Kemono is deferred while the site is unavailable. Broader booru compatibility needs separate integration and live validation. A thumbnail alone does not prove the original file. Ambiguous targets and inaccessible sources can be refused. Sankaku search/subscription limits are respected; this preview does not bypass them.

Existing post batches on X, Reddit, Pixiv and Pawchive share a limit of 100 owned items. Completeness and per-item ownership checks remain; a larger limit does not turn a whole feed into a download batch. Source preparation stays bounded and HTTP 429 stops further admission where supported.

---

## Use and settings

Right-click an image, video or supported post preview and select **MediaLatch: Save media**. On X, Shift + right-click can open the browser menu when the site handles right-click itself.

The toolbar popup shows downloads and source-discovery/processing states. Its full page contains statistics and Downloads, saving preferences, notifications, link settings and release checks. Files default to `Downloads/SavedImages/`. Site/type organization creates paths such as `SavedImages/x/pic/`, `video/` and `gif/`.

Choose **Language** at the top of the full page to switch between English and Russian. The saved choice applies immediately to extension pages, notifications and inline buttons. With no saved choice, a Russian browser uses Russian; other browsers use English. The menu title stays **MediaLatch: Save media** in both languages. Renaming preserves existing preferences and save folders.

To discover this preview in **Updates**, set **Update channel** to **Regular and beta releases**, or download it directly from Releases. Unpacked installations update manually.

For troubleshooting, enable recording in **Debug**, reproduce the problem, then copy or export the filtered events. Recording starts when enabled; turning it off preserves the journal until it is cleared or expires. Reports stay local unless you share them.

In **Saving**, choose a writable base folder and press **Save settings**. Subfolders are created inside it. Without a selected folder, files use the browser's Downloads directory. The optional **X: create a folder for each author** setting uses the selected post's username, in lowercase: `SavedImages/username/file.jpg`, or `SavedImages/x/username/pic/file.jpg` with site/type organization. Quotes use their own author; an unproven author keeps the usual layout. Other sites keep their existing layout.

Directory selection requires a browser supporting the File System Access API. Selected-folder files are written directly and appear in MediaLatch's manager rather than Chrome's download history. Existing files are preserved with numbered names on collisions. Browser restart may require selecting the same folder again and saving settings to restore write access; prepared files can then be retried. Changing destination affects newly queued files. Cancellation before writing finishes can leave an empty placeholder. The extension receives files into private disk storage and validates them before export. The byte-transfer queue runs up to three files concurrently, at most two per source origin; Pause queue stops new transfers, not source discovery or an active transfer. Unknown totals have no invented percentage or ETA. Processing keeps the existing GIF/HLS resource limits.

Failed exports retain prepared bytes for explicit retry; removing a record deletes its temporary file, not your saved download. Interrupted remote acquisition restarts from the exact source on explicit retry; partial transfer resume is not promised. Recovery reconciles owned browser exports instead of launching duplicate saves. A lost selection or expired source can require a fresh click on the site. Details and reports remain on the full Downloads page.

---

## Limits and privacy

DRM, access bypass, arbitrary blob/MSE players and general HLS/DASH downloads are not supported. Separate audio tracks are assembled only within the supported Reddit HLS path. Missing files, rate limits and permission failures cannot be guaranteed away.

GIF conversion is bounded to 50 MiB input, 30 seconds, 150 frames, 640 px output, 15 MiB encoded output and 45 seconds of processing. Buffered Pixiv images have a 50 MiB ceiling. These are limits of specific processing paths, not every direct browser download.

There is no telemetry or extension backend. Statistics and Debug recording are off by default; reports are copied or exported only on request. Sites/CDNs receive requests needed to resolve/save media, and GitHub receives release checks. See [Privacy](docs/PRIVACY.md).

---

## Roadmap

Statuses distinguish implemented features from future work. They describe direction, not promised dates or support for every layout. Reliability comes first; each capability needs a separate implementation and browser check.

| Area | Planned result | Status |
|---|---|---|
| Booru engines and generic media | Reuse proven original/ownership rules across evidenced engines; improve selected media and Yandex/Google image-result discovery | Next compatibility work |
| Controls and selection | Small universal inline controls and optional post/media multi-selection | Planned |
| Download manager | Extend the implemented file queue to paced post resolution, batch totals and proven transfer resume | File queue in preview; remaining work planned |
| Complete-file staging | Disk-backed acquisition/validation before export and local retry; broaden native restart, quota and media checks | Included in preview; ordinary Helium checks passed, stress checks pending |
| Batch archives | Selected-post/page batches, ZIP first; 7z only if a practical bounded implementation is justified | Planned |
| Destination and naming | Writable base-directory selection and optional selected X author folders | User-confirmed external folder and X author saves in Helium; browser-restart permission recovery and broader layouts remain untested |
| Kemono | Declared same-post originals and scoped feed behavior | Deferred until the site is usable |
| Optional publishing | Separate VK/Telegram composers, preview and explicit send, then scheduling and duplicate-safe reconciliation | Later; authorization, credentials and a durable scheduler need their own design |
| Browsers and distribution | Broader Chromium checks, Firefox port, Chrome Web Store and store-managed updates | Planned; security/privacy gates first |
| Settings and documentation | Compact settings groups, visual quick start and EN/RU README | Included in preview; user visual acceptance pending |
| First-run setup | Short introduction: choose a destination, learn context-menu/inline saving, open the manager and start a first download; skip or reopen the guide | Planned; separate task |

The Telegram/VK roadmap concerns **publishing**.

---

## Security before store submission

Before submission: packaged-code/CSP checks, sender/action/frame validation, URL/redirect and private-network boundaries, minimum permissions, dependency/release integrity, malformed-media and resource-exhaustion checks. Broad HTTP/HTTPS access needs particular review. This is **a readiness plan, not a completed security audit or store approval**. Executable code is bundled locally; release checks read metadata and never install code.

See [Security](docs/SECURITY.md), [Privacy](docs/PRIVACY.md) and [Release preparation](docs/RELEASE.md).

---

## Development

Project layout: `content/` holds site scripts; `lib/` shared and worker modules; `ui/` interface source; `popup/` its committed build; `tests/` offline checks; `tools/` verification and packaging. `background.js` remains the worker entry point. Add new behavior to the relevant module.


Use Node.js 26, or another runtime compatible with the UI lockfile.

```bash
npm ci --prefix ui
npm run build --prefix ui
node tools/verify.mjs --ui
node tools/package.mjs HEAD
```

Edit `ui/`, then rebuild `popup/`. Verification covers offline regressions, UI typechecking/rendering and source/build parity. Native playback, audio and actual saved bytes need separate live checks. Packaging reads an accepted Git commit and writes a runtime ZIP plus source SHA, version and hash metadata under `local-notes/releases/`.

[Architecture](docs/ARCHITECTURE.md) · [Release preparation](docs/RELEASE.md) · [Changelog](CHANGELOG.md)

[Tests](tests/test_suite.js): the main offline suite can also run directly with `node tests/test_suite.js`.

---

## License

Project-owned code is **GPL-3.0-only**. Third-party code and icon glyphs retain their original notices: [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), [UI notices](popup/THIRD_PARTY_NOTICES.txt) and the [MP4Box license](lib/vendor/mp4box/2.4.1/LICENSE).
