<p align="center"><img src="docs/assets/banner.svg" alt="MediaLatch — save available originals" width="880"></p>

<p align="center"><a href="README.ru.md">Русский</a> · <a href="https://github.com/xhthc/MediaLatch/releases">Downloads</a> · <a href="docs/PRIVACY.md">Privacy</a> · <a href="LICENSE">GPL-3.0</a></p>

MediaLatch (formerly Image Saver) is a Chromium extension for saving accessible original images, videos and GIFs. Right-click media and choose **Save media**. Source discovery starts after you choose Save; the menu title stays fixed.

> **Preview status:** the published **v2.0.0.25** download still uses the **Image Saver** name and Russian interface. MediaLatch branding and the English / Русский language selector are prepared for the next release.

Tested primarily in Helium on Windows. Coverage is limited to the paths below; site layouts and access rules can change. Firefox and Chrome Web Store distribution are planned.

## Features

- Original discovery through site adapters, image links, `srcset`, media attributes and unambiguous CSS backgrounds or overlays.
- Native images/GIFs and accessible MP4/WebM videos. Exact declared URLs, including signatures, are preserved.
- Genuine looping GIFs from confirmed X and Reddit MP4 animations. Animations longer than 30 seconds remain MP4; failed conversions are reported.
- Compact inline save controls on X, Reddit and RedGIFs, with bounded post batches on X and Reddit.
- All distinct declared original media from a Pawchive feed preview, including the original cover. Selecting an individual attachment saves that attachment.
- A Downloads subfolder, optional site/type organization, save results and copyable redacted error reports.
- Opt-in local history: up to 50 finished saves for seven days, with statistics for that retained history.
- Supported post-link copying on X, Instagram, TikTok and YouTube Shorts, with optional preview-link hosts.
- GitHub release checks manually or on opening Updates, at most daily. Downloaded extension code is not installed automatically.

## Site coverage

| Source | Current behavior |
|---|---|
| X / Twitter | Selected images/videos, confirmed MP4 animations, inline saving and post batches |
| Reddit | Originals, animations, inline saving; selected finite, unencrypted H.264/AAC Reddit HLS streams assembled into MP4 |
| RedGIFs | Selected clip and same-clip video renditions; inline saving; provider audio recovery where available |
| Pawchive | Declared post originals from previews or individual attachments; batches capped at 20, with spaced starts and a rate-limit stop |
| Other sites | Generic discovery plus existing rules, including Pixiv and selected booru paths; coverage varies |

Kemono, Sankaku and broader booru compatibility need further integration and live validation. A thumbnail alone does not prove the original file. Ambiguous targets and inaccessible sources can be refused.

## Install

1. Download the **runtime ZIP** from [Releases](https://github.com/xhthc/MediaLatch/releases) and extract it. The current preview is `ImageSaver-2.0.0.25-98bca837dbd4.zip`; future renamed packages use `MediaLatch-*.zip`. GitHub's automatic Source code ZIP contains the development repository.
2. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked** and choose the folder containing `manifest.json`.
3. After replacing a build, reload the extension **and refresh site tabs**.

Alternatively, clone and load the repository root:

```bash
git clone https://github.com/xhthc/MediaLatch.git
```

The committed `popup/` pages are ready to use. Node/npm are needed only for development. Unpacked installs update manually; store updates will be a separate distribution path.

## Use and settings

Right-click an image, video or supported post preview and select **Save media** from the extension's context-menu item: **Image Saver: Save media** in the current preview, **MediaLatch: Save media** in the renamed build. On X, Shift + right-click can open the browser menu when the site handles right-click itself.

The toolbar popup shows recent results. Its full page contains history, saving preferences, notifications, link settings and release checks. Files default to `Downloads/SavedImages/`. Site/type organization creates paths such as `SavedImages/x/pic/`, `video/` and `gif/`.

**In the next release:** choose **Language** at the top of the full page to switch between English and Russian. The saved choice applies immediately to extension pages, notifications and inline buttons. With no saved choice, a Russian browser uses Russian; other browsers use English. The menu title stays **MediaLatch: Save media** in both languages. Renaming preserves existing preferences and save folders.

Paths are relative to the browser's Downloads directory. Arbitrary drive paths and author folders are planned. The browser owns ordinary transfers; eligible `NETWORK_FAILED` downloads get one native resume attempt.

## Limits and privacy

DRM, access bypass, arbitrary blob/MSE players and general HLS/DASH downloads are not supported. Separate audio tracks are assembled only within the supported Reddit HLS path. Missing files, rate limits and permission failures cannot be guaranteed away.

GIF conversion is bounded to 50 MiB input, 30 seconds, 150 frames, 640 px output, 15 MiB encoded output and 45 seconds of processing. Buffered Pixiv images have a 50 MiB ceiling. These are limits of specific processing paths, not every direct browser download.

There is no telemetry or extension backend. History is off by default; reports are copied only on request. Sites/CDNs receive requests needed to resolve/save media, and GitHub receives release checks. See [Privacy](docs/PRIVACY.md).

## Roadmap

These capabilities are planned and are **not in the published preview**:

- Integrate Kemono originals; expand Sankaku, booru and generic resolver coverage.
- Tiny universal inline controls and optional post/media multi-selection.
- A download manager with queue, progress, pause/resume and pacing; stage complete files before handing them to the PC where supported.
- Selected-post/page batches, investigating ZIP first and 7z later if practical.
- Folder selection and author-based organization, starting with X.
- Firefox portability, other-browser validation and store distribution.

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
