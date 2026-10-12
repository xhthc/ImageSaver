# Architecture

This document describes development `main`, including further worker refactoring, grouped notices, toolbar badge stabilization and file-location actions. The published v2.0.0.29 ZIP includes the earlier staged-download interface and individual page notices; its immutable assets/tag do not contain these newer changes. Windows file-location dialogs, actual toolbar-popup lifetime and broader manual regression gates remain pending. Repository history records provenance; `SOURCE_BASELINE.json` describes the initial import, not the current release.

## Runtime layout

| Area | Responsibility |
|---|---|
| `manifest.json` | Manifest V3 permissions, classic service worker and content scripts |
| `background.js` | Selected-target admission, provider/generic resolution, probes, naming, downloads, feedback and offscreen ownership |
| `content/content_context_target.js` | Capture the pressed media/CSS/overlay target; re-prove ownership at save time |
| `content/content_notifications.js` | Top-frame bounded page notices in closed Shadow DOM; original-origin delivery, dismiss/manager actions and paused timers |
| `content/content_x.js`, `content/content_reddit.js`, `content/content_redgifs.js` | Provider evidence, selected-player recovery and inline controls |
| Other `content_*.js` | Scoped site/link helpers; each script's messages define its contract |
| `offscreen.js`, `offscreen.html` | Protected buffered fetches, genuine GIF encoding and Reddit HLS assembly |
| `lib/download_manager.js`, `lib/staging.js` | Private persistent byte queue, streamed OPFS acquisition/validation, local Blob export and recovery |
| `lib/export_directory.js` | Private IndexedDB directory grants/receipts and streaming validated-file writes to a selected base directory |
| `lib/statistics.js` | Private aggregate counters and compact per-operation deduplication, without media addresses or names |
| `lib/feedback*.js`, `lib/folder_path.js` | Allow-listed records, bounded history/tracking and portable relative paths |
| `lib/reddit_hls.mjs`, `lib/vendor/mp4box/` | Restricted Reddit HLS input and locally bundled MP4 muxing |
| `lib/gifenc.js` | Bundled GIF encoder; preserve its MIT notice |
| `ui/src/core/` | Framework-neutral page controllers, including settings and release checks |
| `ui/src/components/` | React rendering with Radix, shadcn/ui and Lucide |
| `popup/` | Committed Vite output, loaded without a developer toolchain |
| `tools/`, `tests/` | Offline checks, fixtures, build parity and commit-based packaging |

## Save flow

1. A gesture captures one media target and its frame/document/owner evidence.
2. Choosing **MediaLatch: Save media** revalidates that evidence. Removed, changed or ambiguous owners are refused; another post's media is never substituted.
3. Provider or generic discovery produces candidates. Preserve declared signed URLs exactly; diagnostic redaction changes only log copies.
4. Probe candidates and choose an admitted plan. A confirmed original's failure is reported rather than silently becoming a preview.
5. Prepare supported converted/assembled output if needed, then enqueue the resolved source. Up to three jobs (two per source origin) acquire complete files into offscreen OPFS storage and validate their measured bytes and media signature/container before export.
6. Persist export intent, then export the prepared file through browser downloads or write it to the user-selected directory. Browser exports attach the real Chrome ID; direct writes use a private receipt, never a fabricated Chrome ID. Direct writes report success after atomic close and size confirmation. Restart reconciles an interrupted receipt against exact staged bytes; uncertain outcomes refuse automatic retry. Known aborted pre-close failures retain prepared bytes for retry. Completed/cancelled jobs release temporary files and source addresses.

Saving controls are drafts until explicit Save. Private IndexedDB stores structured-cloned directory handles; local preferences store only a directory ID. Each queued job snapshots its destination. Grants are checked in the offscreen writer; unavailable access never falls back to Downloads. Numbered collision names preserve existing files. A cancelled pre-close write can leave an empty placeholder. Permission renewal requires choosing the same directory in settings; the handle's identity retains queued destinations. The user confirmed external-folder and X author saves in Helium on 2026-10-12. Permission lifetime across browser restart and explicit recovery remain untested.

Completed queue cards provide a file-location action in both download surfaces. The authenticated popup message selects an owned completed job, never an arbitrary browser download ID. Native downloads are checked against Chrome ownership, completion and existence before `downloads.show`. Direct-directory exports resolve their private completed receipt, strict relative path and existing parent/file with a read grant, then start the browser file picker in that parent. The File System Access API supplies no Explorer reveal operation; no native helper or guessed absolute path is used. Closing the picker is silent; missing files/access failures retain the card and show a localized recovery message.

Optional X author folders derive a strict username from the exact selected media owner's post permalink, not the page URL, reposter or quoted post's outer owner. Unknown author preserves the existing layout. The same relative path builder covers photos, videos, converted GIFs and MP4 fallback; platform-reserved usernames use the shared portable normalization. Author folders on other providers are not inferred.

There is no hover-based media-title network prefetch. The save item has a fixed title. Context availability remains best effort; save-time ownership checks are authoritative.

A Pawchive feed-preview save reads the owning post and saves all distinct declared supported originals, including the original cover. An individual attachment remains a single target. Post batches stop at 100 items, space starts by one second and stop on rate limits. This is a bounded adapter, not general page downloading.

## Verification and formats

Ownership precedes quality ranking. Candidate probes use headers and provider evidence; queued acquisition additionally validates the actual payload before export. The measured size and verified MIME from staging override earlier filename/header estimates. Protected Pixiv bodies, converted GIFs and supported HLS paths retain their existing transport-specific bounds.

Native GIFs remain GIF. Only positively identified X/Reddit animations are converted from MP4. Ordinary videos and RedGIFs remain video. Above the 30-second animation threshold, save the original MP4; conversion errors do not create a renamed MP4 or a poster.

GIF processing: 50 MiB input, 30 seconds duration, 150 frames, 640 px maximum dimension, 15 MiB encoded output and 45 seconds total. Pixiv image fetches: 50 MiB, 20 seconds covering headers/body, image MIME/container agreement. RedGIFs provider JSON: two requests within eight seconds, each capped at 256 KiB while reading; guest tokens stay in the frame.

Reddit HLS accepts only the supported finite, unencrypted same-asset Reddit H.264/AAC path, including selected fMP4/byte-range cases. Input is capped at 128 MiB and output at 160 MiB. This is not a generic HLS/DASH or DRM implementation.

Eligible owned `NETWORK_FAILED` exports can resume once through the browser's existing download ID. The manager retains prepared bytes after export failure for explicit local retry without a second source GET. It respects an observed Retry-After deadline and bounded explicit retry admission; it never silently refreshes a source or blindly duplicates an uncertain export.

Queue pause stops admission of new byte-transfer jobs; active jobs continue. Source/owner resolution starts immediately to preserve gesture and DOM evidence. Deferred post-resolution admission, batch totals and proven source-range resume remain separate work. Metadata is in private IndexedDB; pending jobs retain exact signed source URLs there, never in shared diagnostics. Storage quota and browser eviction can still interrupt acquisition.

## Storage and UI

The MediaLatch rename preserves existing internal message/DOM identifiers and storage keys, including the `SavedImages` default folder. No migration or reinstallation is needed. `SOURCE_BASELINE.json` retains the original import identity.

Settings use `chrome.storage.local`. A failed settings read keeps the form disabled and prevents saving defaults over unread preferences. Relative paths are validated by the same folder helper in UI/runtime.

Session diagnostics use `chrome.storage.session` with the existing bounded retention. Legacy history APIs remain for compatibility/import; new Statistics use private IndexedDB aggregate counters without the old entry/time cap. Recording is configurable and clearable. A clear boundary excludes old operations from replay; only retained legacy data can be imported. See [Privacy](PRIVACY.md) for exact scope.

Page notices use the originating tab's top frame and captured HTTP(S) origin, never the active unrelated tab or desktop notification API. The session record retains this route through worker restart; history, reports and statistics omit it. Closed, navigated or restricted tabs leave the outcome in Downloads and the failure badge. Success opt-out, terminal outcome timing and cancellation silence remain intact.

The current closed Shadow DOM renderer keeps one stable card for a series of results on the page. Single results retain their explanation; subsequent results update localized success/error counts, coalesced at most every 500ms, without remounting the card. All eligible successes reach the renderer instead of being dropped by a worker burst cap. If success notices are disabled during the series, the summary shows only errors. Ten seconds without a result starts a new series; a hovered or keyboard-focused card remains in place. Dismissal or opening the manager suppresses new cards from a continuing series until that idle break. Recent duplicate IDs are bounded to 256; worker notification idempotence remains authoritative. Expiry pauses while hidden, hovered or keyboard-focused. Manager actions use the latest notified operation and validate its originating tab/origin and stored terminal record again. Themes, keyboard focus and reduced motion remain supported. Published v2.0.0.29 still uses the earlier individual-notice stack.

Blue, Dark and Light themes persist and synchronize between pages. The toolbar popup shows byte-transfer controls; the full Downloads page merges progress, controls and expandable result/report details into one card per job. Retained notification deep links can still open old diagnostics. Removing a card first durably clears its terminal diagnostic, then removes the queue record/file; unreadable storage, active records or pending statistics delivery refuse deletion. Aggregate Statistics are not cleared by deleting download cards. Long localized tab names use a scrollable row with keyboard focus visibility.

The UI build targets Chromium 120 and emits local scripts/styles with no remote runtime code. `npm run build --prefix ui` regenerates `popup/`; the parity check rebuilds into a temporary folder and compares bytes. Notices are generated separately after dependencies or their licences change.

UI motion uses shared 120ms feedback/exit and 180ms entry/disclosure timings with consistent easing. CSS animates Radix menus/tooltips through their existing mount/unmount lifecycle; disclosure padding stays inside the measured wrapper to avoid a closing jump. Panels remain mounted, and byte progress and bulk removal are not delayed by animation. Page-notice dismissal releases focus/actions immediately while its visual card fades for 120ms; new arrivals retire fading cards before admission to preserve the three-card bound. Reduced motion removes effects, including notice exits, without changing the outcome or controls. Native browser popup windows and context menus retain browser-controlled behavior.

Committed language changes animate the existing page from 65% to full opacity for 180ms. Initial preference hydration and failed writes do not animate; a new change, page unmount or reduced-motion preference cancels the effect. Translations, document language and title update together without remounting controls or delaying persistence. Human-facing X platform labels use `x.com`; stored site identifiers, diagnostic fields and actual folder paths remain unchanged.

GitHub checks use the fixed `xhthc/MediaLatch` releases endpoint. The old repository cache is ignored. No release-supplied HTML or navigation URL is trusted, and no extension code is installed by this controller.

## Release and validation

The worker now groups provider discovery in `lib/worker_providers.js`, plan execution in `lib/worker_pipeline.js` and shared X/Reddit animation lifetime in `lib/worker_animation.js`. They remain classic worker scripts imported at their original initialization boundaries; selected-owner proofs, signed addresses, MIME validation and transport policy stay unchanged. This grouping does not yet remove every shared worker dependency.

`lib/worker_offscreen.js` creates a controller with explicit browser, messaging, download maps, tracking and manager-busy dependencies. Its ownership, creation/close single-flight and recovery state belong to that controller. A worker bridge preserves existing call order and interfaces. Unknown persisted ownership and unavailable download lookups still block destructive cleanup.

`lib/download_contracts.d.ts` describes the existing download snapshot, commands and UI state. The downloads controller is checked with `@ts-check`; its React view infers the store type. Worker sender checks and runtime validation remain mandatory: the declarations do not validate message contents. Compile-only negative cases check misspelled commands/states and numeric job IDs. The original MIME/resource integration cases now run from `tests/cases/media_lifecycle.cjs` in their original order with the same shared fixtures; `tests/test_worker_offscreen.js` also checks the controller directly.

Run `node tools/verify.mjs --ui` after building. It includes syntax, offline regressions, UI typecheck/render and source/build parity. Packaging reads only committed allow-listed runtime files and includes licence notices. Archive metadata records source commit, version, per-file hashes and ZIP hash.

Offline mocks and render tests do not prove native browser behavior, actual downloaded bytes or audio. Live acceptance is recorded separately. The large background/test files are existing integration boundaries; split them only under a specific behavior-preserving task, rather than rewriting during release preparation.

Pixiv feed previews with an explicit matching artwork link read the bounded pages API once and save only its declared same-artwork originals (up to 100). Opened-artwork media remains a single selection. Re-prove the selected owner after metadata lookup before admitting any batch item. Internal WeakSet provenance carries each declared plan; caller-supplied plan fields have no authority. Protected page acquisition is capped at two in-flight handlers per batch to bound buffered image preparation. An observed HTTP 429 stops further admission in that batch and records skipped pages as rate-limited; already admitted pages may finish.

All existing post-batch providers (Pixiv, Pawchive, X and Reddit) use the same 100-item ceiling. Content controls and worker validation agree. X/Reddit DOM enumeration is bounded at 400 media nodes and refuses truncated lists. Pawchive refuses an oversized post before probing any item instead of silently saving a prefix. The acquisition manager retains its three global/two per-origin slots; the larger count does not increase network concurrency or authorize whole-page collection.

X/Reddit batch ownership proofs retain their existing three-minute lifetime. A long-running batch can refuse later items after expiry or a changed owner/list; increasing the count does not extend stale proof validity. Progressive proof renewal and batch progress belong to a separate task.

Zerochan feed metadata is read in the pinned selected page session, with a bounded same-origin JSON request and unchanged source/anchor/document checks. The worker validates the declared same-post HTTPS original and re-proves ownership before normal MIME probing. Opened-post selection retains the DOM original-link route; previews cannot become successful original saves when lookup fails.

## Source organization

Site content scripts live in `content/`; their manifest matching, injection order and frame scope are unchanged. Offline checks live in `tests/` and resolve fixtures from the repository root. The classic worker imports `lib/media_format.js` (signature/MIME/extension policy), `lib/download_paths.js` (destination and filename routing) and `lib/site_resolvers.js` (dedicated site adapters) once at their original initialization positions. These modules share the worker global scope; declarations are not duplicated in the entry point. Keep serialized `executeScript` functions self-contained. UI source and generated popup continue to use the existing React/Vite build.
