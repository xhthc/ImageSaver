# Image Saver

[Manifest V3](manifest.json) · [Tests](test_suite.js) · [Русская версия](README.ru.md)

Image Saver is a Chromium extension that finds, verifies, and saves accessible images, videos, and animations from the selected media item. It prefers full-size sources when they can be identified and verified.

## Features

- One contextual save action for images, native GIFs, and accessible direct MP4/WebM videos.
- Provider rules plus generic discovery from image links, `srcset`, original-source attributes, and CSS backgrounds.
- Genuine looping GIF output for confirmed X `tweet_video` and Reddit GIF-as-MP4 animations.
- Post/video copy-link buttons on X, Instagram, TikTok, and YouTube Shorts, with independently selectable preview-link hosts.
- A custom download subfolder with single-folder or site/type organization.
- Save feedback: a notification and a popup list report completed saves and visible failures (site, actual type/extension, conversion status, measured or estimated size) with a copyable, redacted bug report.
- Results and history show the saved file name (basename only) as the main text of each row, so saves are distinguishable; the name is the actual Chrome file name once the download completes and is labelled "intended" until then.
- Local save history: the history section of the full page keeps, only after you turn it on (default off), the last 50 finished saves (7 days, this device only) with an owning-post link where it is reliably known, copy-link, per-entry bug report, an on/off switch and a Clear history button.
- Local processing with no telemetry or extension backend.

Implemented resolver coverage and live-browser acceptance are different. Provider paths below describe supported mechanisms, not a guarantee for every layout.

## Installation

1. Download an available source archive or clone the repository:

   ```bash
   git clone https://github.com/xhthc/image-saver-extension.git
   ```

2. Open `chrome://extensions` in your Chromium browser.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the folder containing `manifest.json`.
5. After an update, reload the extension and refresh affected site tabs so their content scripts match the loaded version.

No build step, Node or npm is needed to load or use the extension: the interface pages in `popup/` are committed, ready-to-load files.

## Usage

The extension registers one save action directly in the native context menu for images, video, animations and supported CSS/overlay targets. It does not create an Image Saver submenu. Native Chromium verification of this menu correction is pending.

Right-click the selected image, link, video, or animation and use the Image Saver save action. If a site intercepts the menu, try **Shift + right-click**.

| Selected media | Result |
|---|---|
| Static image | Best verified accessible image source |
| Native animated GIF | Original GIF bytes |
| Ordinary direct MP4/WebM video | Verified native video file; existing source audio retained |
| Confirmed X `tweet_video` animation | Genuine looping `.gif` |
| Confirmed Reddit `preview.redd.it/*.gif?format=mp4` animation | Genuine looping `.gif` |
| RedGIFs video | Native video; no automatic GIF conversion |

Depending on the target, the menu displays **Image Saver: Save image**, **Image Saver: Save video**, or **Image Saver: Save GIF animation**. Generic GIFs can use the image action. A failed conversion does not save a renamed MP4 or a poster.

### CSS backgrounds and simple overlays

Status: implemented in draft PR #11 (branch `claude/gen-01-css-overlay`) and not part of `main`. The user's native Chromium confirmation is still pending, so it is not yet verified in a real browser.

- Right-click a card whose picture is a CSS `background-image`, or a transparent layer lying over one image, video, or background. On http(s) pages Chrome then offers the shared save action; its label follows the selected media, or says "Save media under cursor" when the original type is unknown. X uses the same entry with its existing selected-player path. A blank-area hint hides the action; if the hint arrives late, choosing Save refuses without a download.
- Exactly one http(s) asset must belong to the pressed element or lie directly under the overlay, which must cover it, in the same container, with no second asset. The ordinary image, link, and video actions are unchanged.
- It refuses (ERR badge, no file, no request) for several backgrounds in one element, a background owned by an ancestor (a caption inside a card), `html`/`body` backgrounds, an overlay spanning two assets, non-http(s) sources, and a target that changed, moved, or was replaced between the click and the choice.
- Not covered: blob/MSE/HLS/DASH, `about:blank`/`srcdoc` frames, and real AVIF coverage.

### Which target is selected

The same rule applies on every http(s) site; there is no site list. The selected target is the image, GIF, video, direct media link, CSS background or unambiguous overlay under the right-click, proven again when you choose Save. Empty space, text, a caption, an ordinary navigation link or a container that merely holds an image is not a target: Chrome offers no event before its menu opens, so the page reports ahead of time (when the pointer rests, at each right-press and for the keyboard menu key) whether a target is under it, and the one save item is absent from the menu where it reports none (shown or hidden, never greyed out; best effort: the very first menu after a fast move may still show the previous state) and a click that still reaches it is refused (ERR) without saving or probing anything. The item's wording follows only the selected target of the current click: "Save image", "Save GIF" (a GIF file), "Save GIF animation" (a confirmed animation), "Save video", or the neutral "Save media under cursor" when the type of the original is not known (a background card, or a booru preview whose original may be a GIF or a video until the item's own metadata says so); an earlier click's wording never survives. A removed, changed or reused element is never replaced by other media (a neighbouring card, another player, a slide, a frame or the previous click). A selected blob player stays a valid target for the existing provider recovery. Implemented in draft PR #11; the user's native Chromium confirmation is still pending.

Acceptance check: from the checkout of this branch run `node tools/gen01-frame-acceptance-server.js 8765`, reload the unpacked extension from the same folder, and refresh `http://localhost:8765/css.html`. The page lists the expected file for CSS1–CSS14 (CSS10b included). For CSS8, CSS9, and CSS14, wait at least one second after the right-click, then choose Save.

For post links, click the chain icon near the selected item's action controls on X, Instagram, TikTok, or YouTube Shorts. The button copies the item's canonical link using the configured host. It does not publish the post or download the video.

### Toolbar badges

| Badge | Meaning |
|---|---|
| `...` | Finding and verifying media |
| `DL` | Download in progress |
| `OK` | Download completed |
| `RATE` | Server rate limit |
| `AUTH` | Authorization required or denied |
| `ERR` | Media unavailable or operation failed |

## Settings

The toolbar popup is compact: the five most recent results (file name, status, site, type, time) and a gear button in the top-right corner of the header that opens the **Сохранение** settings of the full extension page in a new tab (the popup closes only after the tab opened). The recent-results list appears only while history recording is on (default off); until then the popup shows a small invitation, "Включить историю" (enables recording only after your click and a successful settings write) with a dismiss button (remembered in a separate preference; dismissing changes nothing else), and after dismissal only the header and the gear. History can always be enabled on the full page. Errors, notifications and the error badge do not depend on this. History and statistics are reached on the full page, or by expanding a result and pressing "Открыть на странице истории". The full page has five sections: **Статистика и история** (history switch and Clear button, statistics over the retained history, recent results, bug reports), **Сохранение** (root folder, single-folder vs site/type organization), **Уведомления** (success notifications; failures always stay visible) and **Embed** (independent link hosts for X, Instagram, TikTok and YouTube Shorts; they change only the links the copy buttons produce). The **Обновления** section checks GitHub releases and explains manual installation. Sections can be opened directly with `popup.html#history|saving|notifications|embed|updates`. The extension saves into the configured Downloads subfolder without requesting a Save As dialog, including for Save all; the former ask-every-time preference is ignored. The **Сохранить настройки** button (Saving and Embed sections) saves those two sections; the history and notification switches apply immediately. Statistics describe the retained history only (at most 50 operations within 7 days), not lifetime totals; the known total size sums only measured sizes of successful saves and states how many saves it covers.

| Setting | Behavior |
|---|---|
| Save subfolder | Relative path inside Downloads; default `SavedImages`. Limits: 120 characters and 8 nested levels (the popup rejects longer input); `.`/`..` levels are dropped, internal dots are kept, reserved Windows names (`CON`, `NUL.txt`) get a `_` suffix; an empty value saves directly into Downloads |
| Download organization | Save into single folder (`single`, default) or categorize into site and media-type subfolders (`by_site_and_type`, e.g. `<subfolder>/<site>/<pic|video|gif>/`). The site is the HTTP(S) page that owns the media, not its CDN; unmapped sites use their host name |
| Save history | Keep a local history of finished saves (**default off**; recording happens only while the setting is explicitly on, an unreadable setting counts as off). Turning it off stops recording but keeps existing entries until you press Clear history |
| Success notifications | Notify when a save completes (default on; saved immediately in the Notifications section). Failures are always listed in the popup and notified |
| X post-link host | `x.com` by default; optional `fixupx.com`, `cunnyx.com` |
| Instagram post-link host | `instagram.com` by default; optional `oginstagram.com`, `kirkstagram.com` |
| TikTok video-link host | `tiktok.com` by default; optional `tnktok.com`, `d.tnktok.com` |
| YouTube Shorts link host | `youtube.com` by default; optional `yfxtube.com`, `koutube.com` |

Each host preference is independent. Alternate hosts provide third-party messenger previews; `d.tnktok.com` is a direct media embed link, not an MP4 download command. The extension constructs these links locally. Availability and preview rendering depend on the service, post, and receiving client.

## Updates (manual installation)

Open **Updates** on the full extension page (`popup.html#updates`). Activating that tab checks published GitHub Releases at most once every 24 hours; **Check now** checks immediately. There are no background checks while the tab is closed. Stable releases are checked by default; **Standard and beta releases** includes prereleases. API errors are shown explicitly; the displayed date reflects the last successful check.

Automatic checks require a **public repository**. Releases of a private project cannot be accessed anonymously: the checker reports this without asking for a token. Before public publication, open GitHub manually through your browser account.

The checker inspects up to four numeric version components, ignores drafts and unsupported version tags, and looks at the first 100 releases. Release tags must match `manifest.version`, optionally prefixed with `v` (such as `v2.0.0.21`); mark betas as prereleases on GitHub. A lone tag or draft PR is not a published release.

To install an update, open the release and download the extension ZIP from **Assets**. Wait for running saves to finish, extract the archive, replace the files in the **same extension directory**, and click **Reload** on the browser extensions page. Do not remove the installed extension. The checker does not download or install updates and executes no remote code.

The extension sends only an anonymous request to the project's public GitHub Releases API: no cookies, tokens, media URLs, or save history. GitHub receives an ordinary web request, including your IP address. The selected channel and a small release cache stay in local extension storage. No new permissions are used.

## Provider coverage

The following describes implemented paths, not a guarantee for every layout or protected file.

| Provider | Implemented path |
|---|---|
| X / Twitter | Original-photo candidates, accessible direct/post-linked MP4 with source audio, confirmed animation-to-GIF conversion, post-link copying; a small Save button is attached to the tile of a post's own photo, video or GIF while the pointer is on its visible area (a horizontally clipped neighbouring photo keeps two compact controls inside the carousel; vertically clipped, covered or offscreen tiles show no control); a post with several media offers `Save this` (only the hovered item) and `Save all (N)` on every one of its tiles (icon-only on a narrow tile; an explicit click, only that post's own media, at most 12; a quote, reply or nested card is a separate owner with its own list; each item is proven again just before it is saved); the context menu stays as the fallback; to download an avatar, right-click its proven image on the matching profile photo link or in the opened photo view (`/username/photo`); feed avatars, post-author avatars on profile timelines, and unresolved profile links have no Image Saver menu entry; inline controls exclude avatars, emoji, link cards, advertisements and sidebar images |
| Reddit | Original-image recovery, verified direct video, native GIFs and confirmed GIF-as-MP4 conversion, selected-player/slide handling; inline Save on a RedGIFs embed whose clip matches its owning post, with frame/document-bound resolution. Missing or ambiguous evidence is refused; live layout acceptance remains pending |
| RedGIFs | Direct/frame-derived video candidates, including Reddit embeds. When a selected rendition is silent, an admitted save performs a conditional save-time lookup against the provider API (temporary guest session and clip metadata, credentials omitted, no hover requests, no new permissions). Frame/node continuity is strictly enforced, and audio candidate probing advances to same-clip SD on HD 404/410 while failing closed on 401/403 or network failure; absence fallback to silent applies only when all audio renditions are proven absent. Native saved-audio playback verification remains pending |
| Instagram / TikTok / YouTube | Per-item post/video/Short link copying; media downloading is not promised by these buttons |
| Google Images / Yandex Images | Original-source extraction from supported result metadata |
| Pixiv | Original artwork resolution and required request handling |
| Wikimedia / Wikipedia | Thumbnail-to-original resolution for supported raster/SVG sources |
| Tenor / GIPHY | Original-GIF candidate recovery |
| e-shuushuu | Artwork resolution through existing API/CDN rules |
| Anime-Pictures | Original-image variants with same-asset verification |
| Zerochan | Original artwork recovery via post API/CDN rules and thumbnail substitution prevention |
| Danbooru / Gelbooru / other Booru engines | Provider-specific master-media candidates and protected fetch paths where implemented; verification differs by provider |
| Other websites | Generic link, responsive-image, original-attribute, and CSS-background discovery |

## Limits

- Direct-video saving requires a reachable, verified media source. HLS/DASH assembly, separate audio/video muxing, DRM, and protection bypasses are outside the current download contract. RedGIFs provider audio recovery checks provider clip declarations without separate audio stream muxing; native browser listening verification of saved audio output remains pending.
- Blob-backed players work only when the selected item's supported resolver can recover an accessible source. Arbitrary memory blobs and canvas content are not generally supported.
- GIF encoding has bounded duration, frame count, dimensions, output size, and execution time. Current bounds are documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); conversion is not a lossless copy of MP4.
- Folders are created by Chromium only when a file is saved. The whole relative path is capped at 240 characters (only the file name is shortened). The type folder follows the verified content type of the saved file; without such evidence it follows the file-name extension, otherwise `unknown-type`.
- A save is reported as complete only after Chrome reports the download complete. Sizes are measured from the saved file; before that they are labelled as header estimates. The converter does not report output dimensions, so GIF dimensions are shown as unknown. HTTP status appears only when the pipeline observed it ("not observed" otherwise). Failures stay listed in the popup (and as a "!" badge until viewed) even when notifications are blocked or routine success notifications are off. The popup and the full page follow the saves while they stay open: a save that starts, completes, fails or is cancelled appears or changes in place, driven by the extension's own storage change events (no polling, one subscription per list, released when the page closes); a failure is marked "new" and acknowledged only while the list is visible, and history is refreshed only when you have enabled it. Manual retry is not automated: use the context menu again on the same media; stale signed links are never reused.
- An authoritative video failure does not silently become a thumbnail download. Authorization, rate limits, missing media, and unsupported content can prevent saving.
- Dynamic feeds, galleries, embeds, and third-party previews need checks for the relevant layout and sample. Verify downloading and playback on the actual page and browser build.
- Firefox adaptation and Telegram publishing are planned features.

## Privacy and permissions

Media processing and settings stay in the browser. The extension uses website/CDN requests and existing provider APIs to resolve and fetch selected media; it collects no telemetry and requires no extension-owned server or account. A source site may still require an active login.

The manifest declares download, context-menu, storage, scripting, DNR, offscreen, and notification capabilities with broad HTTP/HTTPS host access for cross-site media resolution. See [manifest.json](manifest.json) for the exact permission set.

Save feedback keeps at most the 20 latest operations for up to 24 hours in the browser's session storage (cleared when the browser closes). A record holds only the site name, source host and extension, the saved file **basename** (never a directory or full path; taken from the extension-owned Chrome download once it completes), type/size facts, state and a failure code: no full URLs, paths, query strings, cookies, Blob URLs or media. File names are not shown in desktop notifications or copied bug reports. The `notifications` permission is used only to show save results. A bug report is built from those fields, shown for review, and copied only when you press the button; nothing is sent anywhere.

Save history (full page) is stored in `chrome.storage.local`: at most 50 finished operations for 7 days (expired entries are removed from storage when the service worker starts and whenever the history is opened or written; nothing runs while the browser is closed), each with the same allowlisted fields plus, when known, a canonical post link (currently X status pages only; query and fragment are dropped, and an unverifiable post stays "unknown"). It never holds source/media URLs, Blob URLs, signed parameters, paths or media, and it records only saves made through this extension. Clear history stores a clear boundary: an operation that started before the clear is never added afterwards (not even by restart reconciliation of an in-flight download), and a clear that could not be persisted reports failure.

Optional preview-link hosts are contacted by the browser or receiving app when those links are opened or rendered, not by the extension when copying. Planned Telegram delivery will be a separate opt-in integration and is not present in this build.

## Development

The service worker, content scripts and offscreen document are plain JavaScript with no bundler or npm runtime dependency. Reload the unpacked extension after edits.

```bash
node test_suite.js
```

The two interface pages (`popup/quick.html`, `popup/popup.html`) are the committed output of a UI-only build in [`ui/`](ui/) (React, Tailwind CSS, [shadcn/ui](https://ui.shadcn.com) components and two free [Skiper UI](https://skiper-ui.com) components, used with attribution). Edit `ui/src`, then rebuild; a normal user never needs this:

```bash
npm ci --prefix ui
npm run build --prefix ui         # writes popup/
npm run check:built --prefix ui   # fails when popup/ is not the output of the current sources
node test_ux_ui.js && node test_ui_render.js
```

Third-party licences of the interface bundle are in `popup/THIRD_PARTY_NOTICES.txt`.

The suite is an offline Node harness. Real Chromium checks remain necessary for browser-dependent claims. Component boundaries and implemented limits are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
