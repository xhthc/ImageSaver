# MediaLatch landing page

Standalone Russian landing page. Open `index.html` directly, or serve this directory with any static HTTP server. No build, framework, installation, analytics, remote fonts or API keys required.

For a local development preview using the existing workspace dependency:

```powershell
node ui/node_modules/vite/bin/vite.js website --host 127.0.0.1 --port 4173 --strictPort
```

Run from `D:\Projects\ImageSaver`. For deployment, upload this directory's HTML, CSS, JS and `assets/` to static hosting. Do not include the workspace, local notes or the extension candidate. Hosting/publication is not part of this local task.

The GitHub download CTA links to the known preview release, not a fabricated ZIP URL. Store buttons intentionally remain disabled until real Chrome Web Store and Firefox Add-ons listings are supplied and Firefox support is published. The visual save demo does not download a file or operate the extension. Clipboard denial has a manual-copy fallback. Product claims are based on published commit `f7590f8ae6387a73bd473e61ff3231a4474d06dc`; uncommitted multisite fixes are not advertised.

Design: restrained charcoal/lavender, existing MediaLatch mark, clear Cyrillic system typography, media-led composition. References: the three user-supplied design documents, [Geist typography](https://vercel.com/geist/typography), [Primer accessibility](https://primer.style/accessibility/) and [Linear's product demonstrations](https://linear.app/). The unrelated owner/ticket instructions in the attached CLAUDE.md were not adopted.

Project-owned source and the existing brand mark retain GPL-3.0-only. Alpine demo artwork was generated with the built-in ImageGen tool; its exact prompt and provenance are recorded in local-notes/checks/website-medialatch01/. It does not represent a real provider or a native-browser acceptance result.
