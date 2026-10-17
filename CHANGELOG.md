# Changelog

## 2.5.9 — TikTok/Reels controls, author folders and staging reliability

- TikTok and Instagram Reels: optional author folders now use the posting username from the exact item that supplies the selected video file, for inline and browser-menu saves. Both existing folder layouts and saved folder preferences apply; an unknown or invalid username keeps the ordinary layout. Download cards retain the proven account.

- Instagram Reels (Reels feed and opened Reel): Copy link above Download in the upper-right corner of the selected Reel's video, shown on hover over that video, hidden on exit, reachable by keyboard and always visible without hover; they replace the earlier Reel Copy above Like (ordinary posts unchanged). Download saves the Reel in view through the existing selected-video resolver and manager only when the player's own item matches the Reel's proven shortcode; covered, neighbouring, recycled or separate-track-only Reels are refused visibly, and a double press makes one job.

- TikTok: reveal Copy link and Download only while the pointer is over their video, and hide them on exit. Keyboard focus keeps both actions visible; devices without hover keep them available.

- TikTok: separate Copy link and Download buttons directly below the video's native More (⋯) icon. Their local media anchor follows scrolling, resizing and card replacement without altering TikTok's menu or avatar/action rail. It saves the card's own video through the existing proven-player resolver and download manager (exact signed address); a covered, offscreen, recycled or ambiguous player is refused visibly, and a quick double press makes one job.
- TikTok: Copy link no longer appears inside TikTok's right-click menu or at an unproven player/container location, and an extra copy placed by an earlier version is removed. Cause: a selector list picked the player section before the action rail, every container of a card was injected separately, and the Share scan matched the menu's Share item.
- TikTok right-click: a plain right-click keeps TikTok's own menu; Shift+right-click on the player now reliably opens the browser menu with MediaLatch: Save media. Cause of the earlier instability: the press lands on TikTok's overlay outside the player wrapper, where the previous rule did not apply.

- Harden disk-backed staging cancellation during validation/commit, same-job replacement file identity and full-versus-unknown quota handling; failed transfers release their source.
- User checks confirm TikTok/Reels controls, saved audio, embed links and username folders. Broader feed/layout, separate-track streams and crash/full-disk coverage remain limited.
- Update EN/RU documentation and privacy disclosures, and separate implemented extraction/MV3 safeguards from future universal-media work in [the architecture roadmap](docs/ROADMAP.md). No new permission, dependency or storage schema.

## 2.5.8 — tested inline scope and experimental social videos

- Limit inline download controls to tested X/Twitter, Reddit, Pixiv, RedGIFs and VK surfaces. Remove the generic control and worker route that caused false positives on unrelated pages. Preserve browser context-menu saving, Instagram/TikTok author-folder proofs and copy/embed actions.

- Replace the paperclip-like share glyph with the existing Lucide Copy icon across X, Instagram, TikTok and YouTube Shorts. One shared outline glyph keeps its full viewport and inherits the button color; copied links, selected embed hosts and action placement are unchanged.

- Add experimental selected-video saving for TikTok and Instagram Reels/video posts through the browser context menu. Bind the progressive file to the gesture-selected player and its own item metadata, preserve exact signed URLs, and use the existing manager. TikTok's header rule is limited to the extension's own CDN requests. Separate DASH tracks remain unsupported; full feed and audible-playback acceptance remain pending.
- Reject underlying TikTok/Instagram players when the pressed login/modal/consent surface does not contain that player. Retain legitimate player viewing dialogs; cover both cases with no-request and exact-file regressions.

The user confirmed that unrelated-page inline false positives are gone. Existing tested-site photo and download-manager acceptance is retained. TikTok/Instagram video support is experimental: recorded native Instagram export and separate TikTok acquisition evidence do not establish every live selection/feed layout or audible playback. No new permission, dependency or storage schema; this is a GitHub pre-release, with Chrome Web Store publication separate.

## 2.5.7 — generic inline saves and Show in folder

- Show in folder in the popup and the full Downloads manager reveals the exact saved file of a finished browser download (also a renamed "photo (1).jpg") through `chrome.downloads.show`; a refusal stays on that card. Chosen-folder exports have no browser download record and show no icon.
- The three header rules for Pixiv, anime-pictures and Gelbooru CDNs now apply only to MediaLatch's own requests to those exact domains; normal browsing and lookalike domains are untouched.
- Generic Save this control on other http(s) sites for individual, directly declared image/video files. Posting-account labels and optional author folders also cover VK, RedGIFs, Instagram and TikTok; an account is given only when the media is evidently the post's own attachment, so comments, replies, quotes (also without a profile link), header avatars and profile-linked media do not get the post's account.
- One shared list each for author-folder services and for hosts with their own inline controls; one inline route registry and one sender check in the worker; one proof listener per page. No permission or dependency added.

- Organize import provenance under `docs/history/` and browser diagnostics under `tools/diagnostics/`; refresh both READMEs and current architecture/release guidance. Runtime entry points stay at the extension root.

Independent source/UI checks passed 87/87 on the reviewed runtime candidate. The user confirmed Embed and Explorer file selection in Helium. Expanded live account attribution, original-photo quality, general VK videos/clips and broader browser support remain unclaimed. This is a GitHub pre-release; Chrome Web Store publication is separate.

## 2.5.6 — VK photo carousels and collages

- Keep VK inline controls at a constant offset from the media’s own upper-left corner, moving with the media rather than following the viewport. Preserve safe hiding for offscreen or covered targets.
- Recover selected carousel photos beneath navigation layers and zero-size links; support 90px collage thumbnails without losing either Save this or Save all.
- Offer Save all for the exact complete, intrinsically owned carousel or grid; exclude neighboring posts, comments, nested reposts and hidden +N remainders. Count declared offscreen photo sources without requiring every slide to decode first.
- Preserve every mixed-post slot. For linked video tiles already included in an admitted post, resolve matching first-party progressive metadata, verify MP4 bytes and use the existing save pipeline; retain cancellation and duplicate guards. This is limited mixed-post handling, not general VK video support.
- Refresh EN/RU coverage and roadmap. Standalone VK videos and clips are deferred to a separate planned increment; GIF is not required. Permissions, dependencies and UI assets are unchanged.

The user confirmed that VK carousels and collages save correctly. Recorded native checks include selected photos, observed complete photo lists and a seven-item mixed post (five JPEGs, two MP4s with structurally present audio tracks). Original-photo quality, broad video/clip coverage and audible playback are not established. This remains a GitHub pre-release; the Chrome Web Store listing is unchanged.


## 2.5.5 — author labels and experimental VK inline

- Show proven X/Reddit/Pixiv authors in page notices, popup and full Downloads; preserve attribution through batches and retries. Unknown authors and older records omit the label.
- Balance the popup's left/right download gutters while retaining its translucent custom scrollbar.
- Add experimental vk.ru/vk.com inline controls for a loaded selected photo or an opened direct HTTPS video/clip file. Freeze the selected source; never substitute a poster or rediscover a neighboring target.
- Place VK controls at the visible upper-left corner, retain the selected media while scrolling and clear a full-width fixed/sticky header. Hide safely for changed, removed, offscreen or covered targets.
- Offer VK Save all only when intrinsic post identity and one complete attachment list are proven, up to 100 files; never claim a rendered subset is the whole post. Add the VK service label/category without inventing historical attribution or authors.
- Redact known short and long signed query values in diagnostic logs, including duplicate-download and provider fallback paths.
- Refresh English/Russian coverage, roadmap, privacy and release instructions; keep screenshot version provenance. Allow 180 seconds for the existing UI render suite after a measured 142-second run exceeded its prior 120-second harness limit. Assertions are unchanged.

This is a GitHub pre-release. The user confirmed VK button appearance after hard reload; placement has isolated headless Helium fixture evidence. Live VK inline export, original-photo parity, complete-post layouts and video/clip/audio coverage remain unverified. The requested full VK increment is unfinished. Earlier X/Reddit/Pixiv/RedGIFs, author-label and Downloads user acceptance is retained. Chrome Web Store 2.5.2 was reportedly approved/published and then accidentally unpublished; this preview does not republish the listing.


## 2.5.4 — shared inline controls and compact downloads

- Add Pixiv inline Save this / Save all for proven artwork pages and supported feed cards; retain original selection and the 100-item batch cap. Fix page-count detection so numeric author names are not mistaken for media counts.
- Consolidate X, Reddit, Pixiv and RedGIFs inline controls into one shared module, organize runtime modules and strengthen hostname boundary checks without adding site support automatically.
- Add Cancel remaining for a post batch in popup and full Downloads; completed exports and unrelated jobs are preserved.
- Group all single and batch downloads by site, promote the site only for a new request, and separate compact Individual files and post subgroups. Finished subgroups start folded; notification links reveal their exact file. Original request time and source ordering survive queue recovery.
- Use the same bounded, translucent custom scrollbar in popup and settings, with fixed popup header/footer.
- Replace in-flow Embed help with themed floating bubbles, keep keyboard/tap access, and fix stale bubbles after rapid pointer exit. Limit Theme/Language hover highlighting to the select trigger.
- Refresh EN/RU release documentation, roadmap status and neutral Downloads/Embed captures. Permissions, dependencies and storage schema remain unchanged.

This remains a pre-release. Accepted changes have independent reviews, automated/isolated browser checks and bounded user confirmation of the four inline sites, Downloads and settings help. Exact committed runtime packaging is checked separately. Exhaustive live-provider/audio, other-browser, crash/quota and store-approval claims remain outside this release; the submitted Chrome Web Store 2.5.2 archive is unchanged.

## 2.5.3 — post-batch progress and site statistics

- Show one durable post summary in both managers for X/Reddit Save all, multi-page Pixiv artworks and multi-original Pawchive posts. Saved, failed, cancelled, skipped and remaining counts stay distinct; retries update the existing item.
- Keep one updating notice per post using committed manager counts. Partial Pawchive imports retain their unavailable-original diagnostic and never claim all post files were saved.
- Add compact local site statistics: populated services only, one Booru view, preserved all-time totals and conservative legacy attribution. Recording and clear remain global.
- Preserve known owning-service attribution through queued retries and worker recovery, including prepared outputs after recent feedback expires.
- Remove the repeated download-row tooltip/hover overlay and move terminal record removal into the full manager's expanded details.
- Refresh EN/RU release documentation, roadmap status and neutral downloads/statistics captures. Permissions, dependencies and provider admission rules are unchanged.

This remains a pre-release. The accepted feature code passed 77 GitHub checks, independent source reviews, isolated native byte/restart checks and bounded user Helium acceptance for X/Reddit batches, statistics and live Pixiv/Pawchive results. These do not establish exhaustive provider/audio, Google Chrome, quota or crash coverage. The submitted Chrome Web Store 2.5.2 package is a separate, unchanged build.

## 2.5.2 — media request guards and project cleanup

- Include the reviewed interface cleanup and project file organization while preserving download workflows and stored preferences.
- Restore the original seven-item sidebar without category captions or collapse controls.
- Add `kkclip.com` as an optional Instagram link-preview host; keep existing hosts and explicit Save settings.
- Publish the reviewed runtime as a GitHub pre-release; keep Chrome Web Store artwork and upload materials outside the repository and release assets.
- Remove the unused documentation banner; retain runtime code, build sources, fixtures, licences and product screenshots.
- Restrict privileged offscreen commands to the worker and reject synthetic converter IPC fields.
- Refuse literal local-network media from public pages and unchecked redirects; preserve deliberately selected local-page media. Hostname DNS changes remain outside this guard.
- Bound Zerochan metadata to 2 MiB with cancellation throughout its deadline.

Store submission and approval are separate states. User-reported X, Reddit and RedGIFs checks were performed in Helium; this does not establish Google Chrome, all-provider or audio acceptance.

## 2.5.1 — redesigned interface and violet gradient branding

- Redesign the manager, popup, settings, statistics and diagnostics with grouped navigation and consistent panels across Violet, Blue, Dark and Light themes. Preserve English/Russian localization and existing preferences.
- Make link-preview settings a responsive two-column grid with help for each platform; preserve explicit Save settings and all existing preview hosts.
- Align notification/Debug switches with their panels; retain popup wheel/keyboard scrolling and the global finished-record clear action.
- Refresh the recognizable M/download icon with a violet three-stop gradient and subtle edge; synchronize UI, toolbar theme variants and notification assets.
- Replace EN/RU README screenshots with actual isolated-browser captures; update current privacy details and prepare neutral Chrome Web Store screenshots and promotional art.

This remains a pre-release. Download providers, privileged boundaries, storage keys, permissions and dependencies are unchanged. Existing provider smoke evidence is retained; independent source review, UI verification and exact-package browser/export checks are recorded for this preview. No store approval, exhaustive live-provider/audio or performance/leak result is claimed.

## 2.5.0 — version update

- Repackage the accepted 2.0.0.33 runtime as version 2.5.0; extension behavior, permissions, dependencies and stored data are unchanged.
- Update current release links and installation archive names in the EN/RU README.

This remains a pre-release. Prior source and browser validation applies to the unchanged runtime; packaging and version/update checks are repeated for the new archive.

## 2.0.0.33 — author folders, selected-media continuity and refactor

- Add a separate first-install welcome with one Continue action to Saving; keep it dismissed after updates and restarts.
- Add one Author folders menu for x.com, Reddit and Pixiv. Preserve the previous X preference; Pixiv folders use author name plus user ID. Keep flat and site/type organization choices.
- Improve original Pixiv preview acquisition through staged downloads with progress and a durable 50 MiB cap. Preserve the selected post, author and batch when feed nodes scroll away or are recycled; keep document/navigation and ownership refusals.
- Strengthen declared-original ownership for booru engines and Zerochan; preserve existing rate/access, MIME and file-identity checks.
- Match interface and toolbar icons to Violet, Blue, Dark and Light themes. Keep popup wheel scrolling with hidden rails and one global clear action; per-file removal remains in the full manager.
- Split worker candidates, booru adapters, selected-frame reads and X recovery into focused modules. Remove unreachable legacy history/UI/helpers and fold equivalent repeated branches without changing stored preferences or statistics migration.
- Refresh EN/RU README and interface screenshots for this preview.

Validation: reviewed refactor72/72 checks and seven-file UI build parity, independent source review, isolated Chromium startup/UI/legacy-statistics/restart checks, and limited user-reported Helium saves/interface smoke tests. This prerelease does not establish exhaustive audio/byte, crash/quota or performance/leak coverage. Rapid RedGIFs inline saves can hit the existing four-active admission limit; the current RATE_LIMIT label also covers remote HTTP429.

## 2.0.0.32 — remove Explorer integration

- Remove the Windows Explorer companion, native messaging permission and destination-link setup. Saving to custom folders and per-author subfolders remains available without companion software.
- Remove file-location folder icons from both download managers and retire their worker/controller actions. Existing downloads, saved files, preferences and manager-return notices are retained.
- Withdraw the v2.0.0.31 companion release assets. Earlier runtime archives remain historical builds; use v2.0.0.32 for the rollback.

This is a preview. Automated checks do not establish broad live-site or installed-popup acceptance.

## 2.0.0.31 — manager-return notices and Windows Explorer

- Keep page notices working after opening the download manager and returning to the source page. Opening the manager retires the current card; later results still share one activity card. Explicit close/Escape retains series suppression.
- Replace the chosen-folder file picker with an optional Windows Explorer companion for both download managers. Link a saved destination once; verify the exact extension origin, fresh directory proof and completed relative file before opening its parent. Ordinary browser Downloads keep their existing reveal action.
- Provide the Windows companion as a separate release ZIP with installation instructions. Missing helper/binding keeps download cards and gives localized recovery. The extension now declares `nativeMessaging`.

The user confirmed the manager-return notification fix. Automated68/68 checks and isolated native manager navigation/host communication passed. Actual Explorer/external-folder proof/toolbar lifetime and broader site/audio/crash/quota checks remain pending; this is a preview. Earlier release tags and assets stay unchanged.

## 2.0.0.30 — grouped notices and file locations

- Separate worker provider, pipeline, animation and offscreen lifetime modules; share checked download contracts with the UI while preserving media guards and existing save behavior.
- Group bulk-save page notices into one stable activity card with localized outcome counts and dismissal suppression.
- Keep the toolbar badge stable through parallel/queued downloads; preserve readable errors and guard stale asynchronous updates.
- Add file-location buttons to completed download cards. Browser downloads reveal through the OS file manager; chosen-directory writes use a browser picker at the stored file's actual parent. Preserve cards on failure and keep picker cancellation silent.

Automated regressions, source/build parity and isolated extension fixtures passed. Real Windows file-location dialogs, actual toolbar-popup lifetime and broader manual regression gates remain pending. This preview includes these changes; earlier release assets and tags are unchanged.

## 2.0.0.29 — organized source and current interface

- Organize site scripts in `content/` and offline checks in `tests/`; extract existing worker format, destination/naming and dedicated-site resolver modules without changing their behavior. Update runtime injection and commit-based packaging paths.
- Make Violet the default theme, refresh saving/link settings and the EN/RU visual README. Add destination-folder selection and optional x.com author folders.
- Receive files concurrently, support declared post batches up to 100 files, and clear the manager list immediately. Preserve selected-original and truthful format validation.
- Replace desktop notifications with bounded MediaLatch page notices. Add short menu/disclosure/notice transitions and smooth committed language changes, respecting reduced motion and mounted drafts. Display x.com consistently.

- Add persistent Blue, Dark and Light themes across extension pages.
- Replace retained-history totals with configurable, clearable aggregate Statistics; import only legacy records still available locally.
- Stage and validate complete files in private disk-backed browser storage before exporting prepared bytes. Show stages, received/total, speed and approximate time when measurable, queue pause, cancellation and explicit retry.
- Merge progress, controls and result/report details into one download card; fix long Russian tab labels and keyboard visibility on narrow windows.
- Preserve pending statistics and refuse unpersisted record removal; keep signed source addresses out of public snapshots and reports.

User-confirmed ordinary Helium checks and isolated native transfer/UI fixtures passed. Native crash/restart, quota stress and broad codec/audio acceptance remain pending. These changes ship in v2.0.0.29 preview; this is not complete browser or store acceptance.

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
