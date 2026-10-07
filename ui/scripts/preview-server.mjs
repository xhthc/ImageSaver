// Local static server for ordinary-page previews of the built extension pages (development only, never shipped).
// Usage: node ui/scripts/preview-server.mjs [port] [root]   ->  http://localhost:<port>/popup/quick.html?scenario=mixed
// [root] defaults to the repository; pass another extracted tree (for example an older commit) to compare pages.
// It serves the repository root and injects ui/preview/mock-chrome.js into the two built pages; the pages themselves are the
// committed output in popup/. A preview is NOT an extension-popup test.
import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const repo = path.resolve(import.meta.dirname, "..", "..")
const root = path.resolve(process.argv[3] ?? repo)
const port = Number(process.argv[2] || 8777)
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" }

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)
    const pathname = decodeURIComponent(url.pathname)
    // Tools of the preview always come from this repository, whatever tree is being served.
    const tool = pathname.startsWith("/ui/preview/") || pathname.startsWith("/ui/scripts/")
    const base = tool ? repo : root
    const file = path.join(base, pathname)
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found")
      return
    }
    let body = fs.readFileSync(file)
    if (/^\/popup\/(quick|popup)\.html$/.test(url.pathname)) {
      body = Buffer.from(body.toString("utf8").replace("<head>", '<head><script src="/ui/preview/mock-chrome.js"></script>'))
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }).end(body)
  })
  .listen(port, "127.0.0.1", () => console.log(`preview http://localhost:${port}/popup/quick.html?scenario=mixed`))
