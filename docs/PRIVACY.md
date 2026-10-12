# Privacy policy

Effective date: 2026-10-12. Product: MediaLatch. Maintainer: [xhthc/MediaLatch](https://github.com/xhthc/MediaLatch). Questions and issues: [GitHub Issues](https://github.com/xhthc/MediaLatch/issues).

## Purpose and access

MediaLatch processes page content and media addresses to identify the selected source, save accessible media and provide save feedback. Content scripts inspect selected targets, their owning post/player and relevant page metadata. Supported inline controls also inspect nearby post structures. This access is needed on HTTP/HTTPS sites and in relevant frames.

The extension has no analytics, advertising, telemetry endpoint or developer-operated media server. It does not upload save history or diagnostic reports automatically. It does not sell user data.

## Network requests

Resolving and downloading media contacts the source site, its declared CDN and, where supported, provider metadata APIs. Requests can include normal browser credentials where the existing provider path requires them. The receiving service can observe the request address, IP and normal network metadata under its own policies.

The RedGIFs path can request a temporary guest token from the provider for an admitted save. That token stays in the frame's lookup and is not returned as feedback, retained as history or logged.

Opening Updates can contact GitHub's public releases API at most daily; an explicit check bypasses the daily cache. The request omits credentials and referrer. It checks versions and links to a fixed repository; it does not execute remote code or install an update.

Copy-link settings may produce links to third-party preview services. Copying such a link does not itself request that service. Opening or sharing it is a separate user action.

## Local storage

- **Preferences and release-check cache:** local browser extension storage, until changed or the extension's data is removed. Preferences include the optional interface language (`en` or `ru`); it is read from the browser's language setting only when no choice is saved and is never sent anywhere.
- **Recent save feedback:** session storage, targeting 20 recent operations and a 24-hour retention window for finished operations. Active operations are retained while pending and can exceed that count. Browser session storage clears when the browser session ends.
- **Optional statistics:** off by default, preserving the previous recording preference. Private extension IndexedDB holds aggregate outcomes, output types and measured byte totals, plus compact per-operation contributions for duplicate prevention. There is no entry/time retention limit; browser storage capacity still applies. Statistics do not retain media addresses, filenames or paths. Available legacy history is imported once; already removed entries cannot be recovered. Legacy history metadata from older versions remains in local storage for compatibility; new saves do not append to it.
- **Optional Debug journal:** recording is off by default. Local extension storage retains at most 2,000 events, 1 MiB and 24 hours. Events include allowlisted action/error codes, timestamps, numerical/boolean details, hosts and validated post/media/job identifiers for correlating extension actions. Full URLs, queries, tokens, cookies, headers, raw errors/stacks, page or React data, page text, filenames, folders, local paths and clipboard contents are excluded. Turning recording off preserves the existing journal; Clear removes it. Retention is enforced when the journal is accessed or updated.
- **Active work:** memory and session bookkeeping can hold job/download IDs and local blob handles for lifecycle recovery. Media source URLs and binary data are processed as needed for an active save; the browser's own downloads system also maintains its normal download records.
- **Download manager:** private extension IndexedDB retains job state, intended/actual filenames, output size/type and owned browser download IDs. Pending or failed jobs also retain their exact source URLs, including signed queries, for explicit retry; these are not placed in shared extension storage, Debug events or reports. The extension's private disk storage (OPFS) holds received bytes until validation and browser export finish. Completed/cancelled jobs delete their temporary bytes and source/local-blob URLs; failed exports retain prepared bytes until retry or record removal. Removing a manager record does not delete your exported file. Records have no automatic time/count expiry; storage quota applies. Browser restart reconciles owned exports; interrupted acquisition is not silently resumed.

Statistics has recording and Clear statistics controls. Turning recording off preserves totals. Clear statistics removes its counters and duplicate-prevention ledger; pre-clear operations cannot restore them. It does not remove legacy history metadata or downloaded files. Removing extension storage/uninstalling removes extension-local data; browser downloads and saved files are managed separately.

Selecting a base folder grants local write access only after a browser picker action. Private extension IndexedDB retains directory handles and per-file export receipts (destination ID, relative filename, type, size and job/operation identifiers). Receipts are removed with the manager record; previously selected handles remain until extension data is cleared. Handles and destination paths never enter Debug reports. Direct writes do not create Chrome download-history entries. Optional X author folders use the selected post's username locally; no author data is uploaded.


## Reports and diagnostics

The current preview uses MediaLatch notices on the source web page instead of desktop notifications. They show bounded site/type/result text, without filenames, paths or source URLs, in a closed Shadow DOM. Delivery is limited to the original tab and origin. Session feedback holds a tab ID and origin for delivery/restart; legacy history, reports and Statistics exclude this route. Closing/navigating the tab or a restricted page can prevent a notice; the manager and failure badge remain. Page notices are UI inside the website, not a confidential system surface. The older v2.0.0.28 preview uses its original notification mechanism.

Bug reports are created and copied only when requested. The report builder allows bounded fields and removes addresses, paths and token-bearing data from its structured output. Diagnostic log copies redact known signed query parameters; the exact request URL is preserved for the actual transfer.

Review any text you choose to paste or share. Browser/developer logs and screenshots can contain context outside the generated report. The extension does not submit the report itself.

Debug events can be filtered, copied or exported only by user action. Exports contain the selected sanitized events and extension/report metadata; hosts and post/media identifiers can still reveal which media was involved. The extension does not upload these exports or send Debug events to the developer.

## Permissions

| Permission | Use |
|---|---|
| `contextMenus` | Native save action and supported link actions |
| `downloads` | Start and monitor extension-owned downloads, show actual saved filenames and eligible native resume |
| `storage` | Preferences, statistics, legacy metadata, release cache and session lifecycle records |
| `scripting` | Selected-frame provider discovery/recovery and content-script injection |
| `declarativeNetRequest` | Scoped provider request-header adjustments, including required image referrers |
| `offscreen` | Local binary processing, GIF encoding, supported HLS assembly and owned blob lifecycle |
| HTTP/HTTPS host access | Inspect supported media targets and contact their source/CDN across sites |

## Changes

Future features that change storage or network behavior must update this policy. Browser store disclosures must describe the actual submitted build, including local processing; this file does not replace the store's required form.
