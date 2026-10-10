# Architecture

This document describes the shipped source, not a list of planned capabilities. Repository history records provenance; `SOURCE_BASELINE.json` describes the initial import, not the current release.

## Runtime layout

| Area | Responsibility |
|---|---|
| `manifest.json` | Manifest V3 permissions, classic service worker and content scripts |
| `background.js` | Selected-target admission, provider/generic resolution, probes, naming, downloads, feedback and offscreen ownership |
| `content_context_target.js` | Capture the pressed media/CSS/overlay target; re-prove ownership at save time |
| `content_x.js`, `content_reddit.js`, `content_redgifs.js` | Provider evidence, selected-player recovery and inline controls |
| Other `content_*.js` | Scoped site/link helpers; each script's messages define its contract |
| `offscreen.js`, `offscreen.html` | Protected buffered fetches, genuine GIF encoding and Reddit HLS assembly |
| `lib/feedback*.js`, `lib/folder_path.js` | Allow-listed records, bounded history/tracking and portable relative paths |
| `lib/reddit_hls.mjs`, `lib/vendor/mp4box/` | Restricted Reddit HLS input and locally bundled MP4 muxing |
| `lib/gifenc.js` | Bundled GIF encoder; preserve its MIT notice |
| `ui/src/core/` | Framework-neutral page controllers, including settings and release checks |
| `ui/src/components/` | React rendering with Radix, shadcn/ui and Lucide |
| `popup/` | Committed Vite output, loaded without a developer toolchain |
| `tools/`, `test_*.js` | Offline checks, fixtures, build parity and commit-based packaging |

## Save flow

1. A gesture captures one media target and its frame/document/owner evidence.
2. Choosing **MediaLatch: Save media** revalidates that evidence. Removed, changed or ambiguous owners are refused; another post's media is never substituted.
3. Provider or generic discovery produces candidates. Preserve declared signed URLs exactly; diagnostic redaction changes only log copies.
4. Probe candidates and choose an admitted plan. A confirmed original's failure is reported rather than silently becoming a preview.
5. Save a direct URL, or acquire an owned offscreen task for buffered/converted/assembled output.
6. Attach the browser download ID to feedback. Terminal events release owned blobs/tasks and record the result.

There is no hover-based media-title network prefetch. The save item has a fixed title. Context availability remains best effort; save-time ownership checks are authoritative.

A Pawchive feed-preview save reads the owning post and saves all distinct declared supported originals, including the original cover. An individual attachment remains a single target. Post batches stop at 20 items, space starts by one second and stop on rate limits. This is a bounded adapter, not general page downloading.

## Verification and formats

Ownership precedes quality ranking. Ordinary direct images are generally admitted using headers and candidate evidence; that is not a full payload-byte inspection. X video, buffered Pixiv images, protected bodies, converted GIFs and supported HLS paths add container/byte validation appropriate to their transport.

Native GIFs remain GIF. Only positively identified X/Reddit animations are converted from MP4. Ordinary videos and RedGIFs remain video. Above the 30-second animation threshold, save the original MP4; conversion errors do not create a renamed MP4 or a poster.

GIF processing: 50 MiB input, 30 seconds duration, 150 frames, 640 px maximum dimension, 15 MiB encoded output and 45 seconds total. Pixiv image fetches: 50 MiB, 20 seconds covering headers/body, image MIME/container agreement. RedGIFs provider JSON: two requests within eight seconds, each capped at 256 KiB while reading; guest tokens stay in the frame.

Reddit HLS accepts only the supported finite, unencrypted same-asset Reddit H.264/AAC path, including selected fMP4/byte-range cases. Input is capped at 128 MiB and output at 160 MiB. This is not a generic HLS/DASH or DRM implementation.

Eligible owned `NETWORK_FAILED` downloads can resume once through the browser's existing download ID. Other failures remain visible. No unlimited retries, background source refresh or generic download manager exists.

## Storage and UI

The MediaLatch rename preserves existing internal message/DOM identifiers and storage keys, including the `SavedImages` default folder. No migration or reinstallation is needed. `SOURCE_BASELINE.json` retains the original import identity.

Settings use `chrome.storage.local`. A failed settings read keeps the form disabled and prevents saving defaults over unread preferences. Relative paths are validated by the same folder helper in UI/runtime.

Session feedback uses `chrome.storage.session`; history is opt-in local storage, with 50 finished records/seven days. See [Privacy](PRIVACY.md) for exact scope. Page controllers and runtime APIs remain separate from rendering.

The UI build targets Chromium 120 and emits local scripts/styles with no remote runtime code. `npm run build --prefix ui` regenerates `popup/`; the parity check rebuilds into a temporary folder and compares bytes. Notices are generated separately after dependencies or their licences change.

GitHub checks use the fixed `xhthc/MediaLatch` releases endpoint. The old repository cache is ignored. No release-supplied HTML or navigation URL is trusted, and no extension code is installed by this controller.

## Release and validation

Run `node tools/verify.mjs --ui` after building. It includes syntax, offline regressions, UI typecheck/render and source/build parity. Packaging reads only committed allow-listed runtime files and includes licence notices. Archive metadata records source commit, version, per-file hashes and ZIP hash.

Offline mocks and render tests do not prove native browser behavior, actual downloaded bytes or audio. Live acceptance is recorded separately. The large background/test files are existing integration boundaries; split them only under a specific behavior-preserving task, rather than rewriting during release preparation.