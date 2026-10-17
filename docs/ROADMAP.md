# Architecture roadmap

Reviewed against the 2.5.9 source on 2026-10-17. The supplied universal-extraction proposal describes 2.5.6 and is a source of ideas, not an implementation contract. This roadmap separates existing behavior from proposed work; it makes no percentage-of-websites guarantee or delivery-date promise. [Current architecture](ARCHITECTURE.md) and [privacy](PRIVACY.md) describe shipped behavior.

## Keep these contracts

- A save belongs to the selected media, post, frame and document. A nearby network request, page preview, thumbnail or profile is not sufficient ownership evidence.
- Preserve exact declared signed URLs. Reject ambiguous targets and unsupported streams visibly. Keep existing provider adapters ahead of any new generic fallback.
- Inline controls stay limited to tested services and surfaces; broader context-menu extraction does not authorize buttons on arbitrary sites. YouTube downloading stays deferred.
- Native browser downloads and chosen-directory writes retain their existing identities, paths and recovery behavior. Keep privileged commands, credentials and durable state private to the extension.
- Introduce each capability as a bounded change with production-path regressions, independent review and separate actual-browser/file evidence.

## Existing foundation

| Proposal area | Current source and evidence | Remaining work |
|---|---|---|
| Offscreen singleton and cleanup | `worker/offscreen.js` already uses single-flight creation, live owners, guarded close, Blob cleanup and session-based native-download reconciliation | Extend race/restart/native evidence; do not replace owner-aware close with a blind timer |
| Complete-file staging | `offscreen/staging.js` streams to OPFS; the manager persists jobs in private IndexedDB. 2.5.9 hardens cancellation, replacement file URLs, quota handling and failed-fetch release | Actual storage pressure, eviction and broader termination/export tests |
| DOM and metadata discovery | `content_context_target.js` already uses point hit tests and bounded open-shadow inspection; `worker/page_selection.js` handles selected-image metadata, `srcset` and site fallbacks | Add demonstrably missing cases without weakening selection refusal |
| Protected acquisition | Existing provider/DNR rules, staging and native/FSA exporters serve admitted sources; exact URLs and download IDs are preserved | Add evidence for a specific failing provider before extending header/fetch scope |
| Site controls and accounts | TikTok/Reels have dedicated hover controls and item-bound usernames; X/Reddit/Pixiv/RedGIFs/VK keep tested handlers | Broader feed/layout coverage, bounded SPA performance measurements and lifecycle cases |

Existing tests and controlled native faults are not proof of every crash, real full-disk condition or site layout.

## Proposed sequence

1. **MV3 and storage acceptance.** Reuse existing lifecycle owners and durable jobs. Exercise worker/offscreen termination during receiving, validation, export and cleanup; reconcile native completion and retain retryable bytes. Measure memory and storage. A keep-alive message alone is not recovery: Chrome documents worker termination and recommends persistent state rather than globals. [Official lifecycle contract](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
2. **Selected DOM and metadata gaps.** Test deep open-shadow targets and overlays, with bounded traversal and explicit ownership. JSON-LD/OpenGraph can supplement an admitted target; a blank-page click must not become the page's first video. `embedUrl` is a page reference and `thumbnailUrl` is a preview, not a direct original file. Canvas export needs separate origin/readability and size/error handling. Iframe URLs require the owning frame/provider route.
3. **Original-quality and protected-provider increments.** Add exact-host, evidence-based CDN adapters only. A successful HEAD/range request does not establish that a rewritten URL is the same asset or its original; signatures and transformation paths must remain valid. Extend credentialed fetch/header rules only for the admitted request, with domain/initiator scope, cleanup and refusal tests.
4. **Scoped stream discovery and assembly.** First prove which player owns a playlist. A per-tab cache of recent requests alone cannot distinguish ads, background players or neighbours. Any future `webRequest` observer needs a separate permission/privacy decision: Chrome requires `webRequest` and relevant host access. Start with a named provider and explicit playlist/codec limits, separate audio, cancellation, bounded storage and native playback tests; reuse proven Reddit assembly where compatible. [Official request API](https://developer.chrome.com/docs/extensions/reference/api/webRequest).
5. **Measured SPA hygiene.** Profile observer cost before replacing it. Delegate suitable interactions, batch scans and tear down registrations. Keep removal, reinjection, resize, keyboard, hover and recycled-node coverage; a permanently processed WeakSet can miss a reused card.

## Proposals requiring redesign

A universal MAIN-world `URL.createObjectURL` hook is deferred. Blob metadata cannot by itself recover the media that an MSE player assembled. A DOM-event bridge is page-controlled input, never authority for privileged fetch or arbitrary byte transfer. Prefer the existing targeted item reads; require a concrete missing case before introducing a global hook.

Large files should use the existing disk-backed staging and small control messages. Chrome messaging uses JSON serialization and documents a 64 MiB limit; a proposed 2 MiB cutoff is a design choice, not an API rule. Passing a Blob directly through Chrome messaging is not a binary transport. A local Blob URL is also not durable across destruction of its owning document. [Official messaging contract](https://developer.chrome.com/docs/extensions/develop/concepts/messaging).

Offscreen access has its own API restrictions and document lifetime. Preserve the existing owner checks and reconstruction paths rather than assuming that an open document or periodic message guarantees completion. [Official offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen).

This document plans future work. Version 2.5.9 adds no network sniffer, universal HLS/DASH adapter, global MAIN hook, universal inline controls or new permission. VK standalone video/clips, author archives, Firefox and separate store publication remain in the README roadmap.
