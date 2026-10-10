// Offline packaging regression: committed bytes, manifest references and exclusion of local/development material.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-saver-package-test-'));
const write = (file, body) => { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, body); };
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
const sha = body => crypto.createHash('sha256').update(body).digest('hex');
try {
  git('init', '-q');
  write('tools/package.mjs', fs.readFileSync(path.join(__dirname, 'tools/package.mjs')));
  const manifest = { manifest_version: 3, version: '2.0.0.25', background: { service_worker: 'background.js' },
    action: { default_popup: 'popup/quick.html' }, icons: { 128: 'icons/128.png' }, content_scripts: [{ js: ['content_x.js'] }] };
  write('manifest.json', JSON.stringify(manifest));
  for (const file of ['background.js', 'content_x.js', 'offscreen.js', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'lib/gifenc.js',
    'popup/THIRD_PARTY_NOTICES.txt', 'popup/assets/app.js', 'icons/128.png']) write(file, 'committed');
  write('offscreen.html', '<script src="offscreen.js"></script>');
  write('popup/quick.html', '<script src="./assets/app.js"></script>');
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'local-notes/secret.txt', 'recovery/old.js', 'ui/src/dev.tsx', 'test_example.js']) write(file, 'local/development');
  git('add', '.');
  git('-c', 'user.name=Package test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Fixture');
  const source = git('rev-parse', 'HEAD');
  write('background.js', 'dirty working bytes');
  write('icons/private.png', 'uncommitted');
  const run = () => spawnSync(process.execPath, ['tools/package.mjs', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const ok = run(); assert.equal(ok.status, 0, ok.stderr);
  const output = JSON.parse(ok.stdout);
  const metadata = JSON.parse(fs.readFileSync(output.archive.replace(/\.zip$/, '.json')));
  assert.equal(metadata.source_commit, source);
  assert.equal(metadata.sha256, sha(fs.readFileSync(output.archive)));
  const entries = metadata.files.map(f => f.path);
  assert(entries.includes('manifest.json') && entries.includes('lib/gifenc.js'));
  assert(!entries.some(f => /AGENTS|CLAUDE|GEMINI|local-notes|recovery|^ui\/|^test_|private\.png/.test(f)));
  assert.equal(metadata.files.find(f => f.path === 'background.js').sha256, sha('committed'));
  // A manifest reference absent from the admitted commit must fail before producing a package.
  manifest.icons[128] = 'icons/missing.png'; write('manifest.json', JSON.stringify(manifest));
  git('add', 'manifest.json'); git('-c', 'user.name=Package test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Missing icon');
  const bad = run(); assert.equal(bad.status, 1); assert.match(bad.stderr, /Missing manifest reference: icons\/missing.png/);
  console.log('PASS package uses committed bytes, verifies hashes/references and excludes local material');
} finally {
  // The only removed directory is the fixture created above under the system temporary directory.
  assert(path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('image-saver-package-test-'));
  fs.rmSync(root, { recursive: true, force: true });
}
