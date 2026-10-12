# Architecture

This document describes the current development source, not a list of planned capabilities. Themes, all-time Statistics and staged downloads are not in the packaged v2.0.0.28 preview. Repository history records provenance; `SOURCE_BASELINE.json` describes the initial import, not the current release.

## Runtime layout

| Area | Responsibility |
|---|---|
| `manifest.json` | Manifest V3 permissions, classic service worker and content scripts |
| `background.js` | Selected-target admission, provider/generic resolution, probes, naming, downloads, feedback and offscreen ownership |
| `content_context_target.js` | Capture the pressed media/CSS/overlay target; re-prove ownership at save time |
| `content_x.js`, `content_reddit.js`, `content_redgifs.js` | Provider evidence, selected-player recovery and inline controls |
| Other `content_*.js` | Scoped site/link helpers; each script's messages define its contract |
| `offscreen.js`, `offscreen.html` | Protected buffered fetches, genuine GIF encoding and Reddit HLS assembly |
| `lib/download_manager.js`, `lib/staging.js` | Private persistent byte queue, streamed OPFS acquisition/validation, local Blob export and recovery |
| `lib/statistics.js` | Private aggregate counters and compact per-operation deduplication, without media addresses or names |
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
5. Prepare supported converted/assembled output if needed, then enqueue the resolved source. Up to three jobs (two per source origin) acquire complete files into offscreen OPFS storage and validate their measured bytes and media signature/container before export.
6. Persist export intent, give the browser a typed local Blob backed by that prepared file, and attach the browser download ID to feedback. Keep the offscreen owner alive until the native terminal result; completed/cancelled jobs release their temporary files and private source addresses.

There is no hover-based media-title network prefetch. The save item has a fixed title. Context availability remains best effort; save-time ownership checks are authoritative.

A Pawchive feed-preview save reads the owning post and saves all distinct declared supported originals, including the original cover. An individual attachment remains a single target. Post batches stop at 20 items, space starts by one second and stop on rate limits. This is a bounded adapter, not general page downloading.

## Verification and formats

Ownership precedes quality ranking. Candidate probes use headers and provider evidence; queued acquisition additionally validates the actual payload before export. The measured size and verified MIME from staging override earlier filename/header estimates. Protected Pixiv bodies, converted GIFs and supported HLS paths retain their existing transport-specific bounds.

Native GIFs remain GIF. Only positively identified X/Reddit animations are converted from MP4. Ordinary videos and RedGIFs remain video. Above the 30-second animation threshold, save the original MP4; conversion errors do not create a renamed MP4 or a poster.

GIF processing: 50 MiB input, 30 seconds duration, 150 frames, 640 px maximum dimension, 15 MiB encoded output and 45 seconds total. Pixiv image fetches: 50 MiB, 20 seconds covering headers/body, image MIME/container agreement. RedGIFs provider JSON: two requests within eight seconds, each capped at 256 KiB while reading; guest tokens stay in the frame.

Reddit HLS accepts only the supported finite, unencrypted same-asset Reddit H.264/AAC path, including selected fMP4/byte-range cases. Input is capped at 128 MiB and output at 160 MiB. This is not a generic HLS/DASH or DRM implementation.

Eligible owned `NETWORK_FAILED` exports can resume once through the browser's existing download ID. The manager retains prepared bytes after export failure for explicit local retry without a second source GET. It respects an observed Retry-After deadline and bounded explicit retry admission; it never silently refreshes a source or blindly duplicates an uncertain export.

Queue pause stops admission of the next byte-transfer job; the active job continues. Source/owner resolution starts immediately to preserve gesture and DOM evidence. Deferred post-resolution admission, batch totals and proven source-range resume remain separate work. Metadata is in private IndexedDB; pending jobs retain exact signed source URLs there, never in shared diagnostics. Storage quota and browser eviction can still interrupt acquisition.

## Storage and UI

The MediaLatch rename preserves existing internal message/DOM identifiers and storage keys, including the `SavedImages` default folder. No migration or reinstallation is needed. `SOURCE_BASELINE.json` retains the original import identity.

Settings use `chrome.storage.local`. A failed settings read keeps the form disabled and prevents saving defaults over unread preferences. Relative paths are validated by the same folder helper in UI/runtime.

Session diagnostics use `chrome.storage.session` with the existing bounded retention. Legacy history APIs remain for compatibility/import; new Statistics use private IndexedDB aggregate counters without the old entry/time cap. Recording is configurable and clearable. A clear boundary excludes old operations from replay; only retained legacy data can be imported. See [Privacy](PRIVACY.md) for exact scope.

Blue, Dark and Light themes persist and synchronize between pages. The toolbar popup shows byte-transfer controls; the full Downloads page merges progress, controls and expandable result/report details into one card per job. Retained notification deep links can still open old diagnostics. Removing a card first durably clears its terminal diagnostic, then removes the queue record/file; unreadable storage, active records or pending statistics delivery refuse deletion. Aggregate Statistics are not cleared by deleting download cards. Long localized tab names use a scrollable row with keyboard focus visibility.

The UI build targets Chromium 120 and emits local scripts/styles with no remote runtime code. `npm run build --prefix ui` regenerates `popup/`; the parity check rebuilds into a temporary folder and compares bytes. Notices are generated separately after dependencies or their licences change.

GitHub checks use the fixed `xhthc/MediaLatch` releases endpoint. The old repository cache is ignored. No release-supplied HTML or navigation URL is trusted, and no extension code is installed by this controller.

## Release and validation

Run `node tools/verify.mjs --ui` after building. It includes syntax, offline regressions, UI typecheck/render and source/build parity. Packaging reads only committed allow-listed runtime files and includes licence notices. Archive metadata records source commit, version, per-file hashes and ZIP hash.

Offline mocks and render tests do not prove native browser behavior, actual downloaded bytes or audio. Live acceptance is recorded separately. The large background/test files are existing integration boundaries; split them only under a specific behavior-preserving task, rather than rewriting during release preparation.
