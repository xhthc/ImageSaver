# Privacy policy

Effective date: 2026-10-10. Product: Image Saver. Maintainer: [xhthc/ImageSaver](https://github.com/xhthc/ImageSaver). Questions and issues: [GitHub Issues](https://github.com/xhthc/ImageSaver/issues).

## Purpose and access

Image Saver processes page content and media addresses to identify the selected source, save accessible media and provide save feedback. Content scripts inspect selected targets, their owning post/player and relevant page metadata. Supported inline controls also inspect nearby post structures. This access is needed on HTTP/HTTPS sites and in relevant frames.

The extension has no analytics, advertising, telemetry endpoint or developer-operated media server. It does not upload save history or diagnostic reports automatically. It does not sell user data.

## Network requests

Resolving and downloading media contacts the source site, its declared CDN and, where supported, provider metadata APIs. Requests can include normal browser credentials where the existing provider path requires them. The receiving service can observe the request address, IP and normal network metadata under its own policies.

The RedGIFs path can request a temporary guest token from the provider for an admitted save. That token stays in the frame's lookup and is not returned as feedback, retained as history or logged.

Opening Updates can contact GitHub's public releases API at most daily; an explicit check bypasses the daily cache. The request omits credentials and referrer. It checks versions and links to a fixed repository; it does not execute remote code or install an update.

Copy-link settings may produce links to third-party preview services. Copying such a link does not itself request that service. Opening or sharing it is a separate user action.

## Local storage

- **Preferences and release-check cache:** local browser extension storage, until changed or the extension's data is removed. Preferences include the optional interface language (`en` or `ru`); it is read from the browser's language setting only when no choice is saved and is never sent anywhere.
- **Recent save feedback:** session storage, targeting 20 recent operations and a 24-hour retention window for finished operations. Active operations are retained while pending and can exceed that count. Browser session storage clears when the browser session ends.
- **Optional history:** off by default. When enabled, retains up to 50 finished saves for seven days on this device. Records contain bounded metadata such as site/host, output type/size, timestamps, state, filename basename and a validated owning-post link where supported (currently X). This is not general browsing history.
- **Active work:** memory and session bookkeeping can hold job/download IDs and local blob handles for lifecycle recovery. Media source URLs and binary data are processed as needed for an active save; the browser's own downloads system also maintains its normal download records.

History has explicit off and Clear history controls. These controls do not delete downloaded files. Removing extension storage/uninstalling removes extension-local data; browser downloads and saved files are managed separately.

## Reports and diagnostics

Bug reports are created and copied only when requested. The report builder allows bounded fields and removes addresses, paths and token-bearing data from its structured output. Diagnostic log copies redact known signed query parameters; the exact request URL is preserved for the actual transfer.

Review any text you choose to paste or share. Browser/developer logs and screenshots can contain context outside the generated report. The extension does not submit the report itself.

## Permissions

| Permission | Use |
|---|---|
| `contextMenus` | Native save action and supported link actions |
| `downloads` | Start and monitor extension-owned downloads, show actual saved filenames and eligible native resume |
| `storage` | Preferences, optional history, release cache and session lifecycle records |
| `scripting` | Selected-frame provider discovery/recovery and content-script injection |
| `declarativeNetRequest` | Scoped provider request-header adjustments, including required image referrers |
| `offscreen` | Local binary processing, GIF encoding, supported HLS assembly and owned blob lifecycle |
| `notifications` | Save feedback; success notifications can be disabled |
| HTTP/HTTPS host access | Inspect supported media targets and contact their source/CDN across sites |

## Changes

Future features that change storage or network behavior must update this policy. Browser store disclosures must describe the actual submitted build, including local processing; this file does not replace the store's required form.