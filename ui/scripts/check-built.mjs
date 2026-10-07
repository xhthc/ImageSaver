// Verifies that the committed popup/ output is exactly what `npm run build` produces from the current sources.
// Usage (from ui/): npm run check:built      Exit code 0 = identical, 1 = stale or different.
// The build runs into a temporary folder; the committed popup/ is only read.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"

const ui = path.resolve(import.meta.dirname, "..")
const committed = path.resolve(ui, "..", "popup")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-saver-ui-build-"))

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
const inventory = (dir) =>
  new Map(walk(dir).map((f) => [path.relative(dir, f).split(path.sep).join("/"), crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")]))

const build = spawnSync(process.execPath, [path.join(ui, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", tmp, "--emptyOutDir"], { cwd: ui, encoding: "utf8" })
if (build.status !== 0) {
  console.error("build failed:\n" + (build.stdout + build.stderr).slice(-1500))
  process.exit(1)
}
const a = inventory(committed)
const b = inventory(tmp)
fs.rmSync(tmp, { recursive: true, force: true })
const problems = []
for (const [file, hash] of b) {
  if (!a.has(file)) problems.push(`missing in popup/: ${file}`)
  else if (a.get(file) !== hash) problems.push(`differs: ${file}`)
}
for (const file of a.keys()) if (!b.has(file)) problems.push(`not produced by the build: ${file}`)
if (problems.length) {
  console.error(`popup/ is not the output of the current sources (${problems.length} problem(s)):\n` + problems.join("\n"))
  process.exit(1)
}
console.log(`popup/ matches the build: ${a.size} files, identical bytes.`)
