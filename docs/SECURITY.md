# Security and store readiness

MediaLatch is an early preview. This document records current boundaries and planned checks, not a security certification, penetration test or Chrome Web Store approval. Report a reproducible problem through [repository issues](https://github.com/xhthc/MediaLatch/issues), with a redacted report; do not publish credentials or private media links. A private security-reporting channel has not been configured.

## RCE and remote hosted code

Remote code execution (RCE) is a vulnerability: untrusted input gains execution privileges. Remote hosted code (RHC) is a separate store-policy restriction on executing code obtained outside the submitted package. Passing one check does not prove the other safe.

Current JavaScript, UI and media-processing libraries are bundled locally. Release checks read data from the fixed GitHub repository and construct release links; they do not fetch and execute an update or install one automatically. The manifest uses Manifest V3's default extension-page CSP. Fixed, packaged functions injected into a page read site metadata; page/API responses remain untrusted data.

Before store submission, inspect the **built runtime ZIP**, including transitive dependencies, for remote scripts, dynamic imports, fetched executable code/WASM, `eval` and `new Function`. Keep updates in the intended distribution channel. Consider an explicit stricter CSP after checking compatibility; do not relax it to permit remote execution. See Chrome's [RHC guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) and [extension CSP reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).

## Existing safeguards

- Save paths use selected-media and frame/document ownership checks; ambiguous or stale targets are refused in the supported guarded paths.
- Processing paths have size/time bounds. This release also keeps the generic MD5 metadata deadline active through streaming/parsing, with a 1 MiB byte ceiling and cancellation. Sankaku post HTML has a 20-second deadline and 1 MiB ceiling.
- UI uses React rendering; history, feedback and Debug exports sanitize diagnostic fields. Debug excludes full URLs, tokens, page text and local paths. History and Debug recording are opt-in.
- Buffered media validates expected format/container evidence within the supported processing paths. These checks are not a complete decoder sandbox or full-file validation of every direct browser download.
- Packaging uses an accepted commit, an allowlist of runtime files, per-file hashes, licence/provenance checks and an archive hash. Local logs, agent materials and credentials are excluded.

A scoped static review found no confirmed RCE path and found the generic metadata resource-limit defect fixed in this release. It does not establish the absence of other vulnerabilities, dependency CVEs or browser defects.

## Planned security gates

| Priority | Boundary | Work and acceptance evidence |
|---|---|---|
| Before store submission | Runtime messages and jobs | Review every privileged action's sender ID, allowed origin, tab/frame/document, payload and current gesture/owner. Restrict offscreen jobs to the intended worker and remove synthetic frame/dimension test payloads from production IPC. Negative cases must produce no privileged fetch, export or job. |
| Before store submission | URLs, redirects and private networks | Review selected/provider URL admission, credentials in URLs, unsupported schemes, redirects and local/private-network destinations. Define deliberate restrictions compatible with legitimate selected media; test redirect chains and hostname/DNS changes. Do not turn runtime messages into an arbitrary privileged fetch proxy. |
| Before store submission | Untrusted page/API data | Keep data out of execution and unsafe HTML sinks; validate structure and ownership before using it. Test malformed metadata and malicious captions/filenames in UI, logs and export. |
| Before store submission | Resource exhaustion | Review remaining readers for header-and-body deadlines, byte ceilings and cancellation. Bound input complexity, image dimensions, allocation, conversion jobs and batch concurrency; test overflow, stalls, abort and repeated failures. |
| Before store submission | Permissions and privacy | Justify each permission and the current broad HTTP/HTTPS host access. Assess `activeTab`/optional host permissions without silently breaking feed buttons and frame recovery. Match the shipped build, privacy policy and store dashboard declarations. |
| Before store submission | Dependencies and release integrity | Review lockfile/vendor changes and advisories, preserve licences, and test updates. Pin CI actions to reviewed commit SHAs; review workflow write permissions and tag/release protection. Verify published ZIP bytes against the reviewed commit and exclude secrets. |
| Before store submission | Native acceptance | Load the exact archive in a clean Chromium profile; check permissions, restart, supported first-click saves, actual files, diagnostics and refusal cases. Offline suites alone do not prove downloaded bytes or native security behavior. |
| Before new capabilities | New authority | VK/Telegram publishing, authentication, scheduling, directory access and disk staging need separate threat models. Keep credentials outside content scripts, URLs and Debug exports; use explicit user approval for send/publish actions. |

The message/URL/permission review covers the whole extension, not only X, Reddit or RedGIFs. The items above are planned gates; no new permission, server, native helper or broad policy rewrite is introduced by this document.

Chrome advises treating content-script inputs as untrusted and minimizing privileges: [security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure), [permission policy](https://developer.chrome.com/docs/webstore/program-policies/permissions). Operational limits and disclosures are in [Privacy](PRIVACY.md); packaging and submission gates are in [Release preparation](RELEASE.md).
