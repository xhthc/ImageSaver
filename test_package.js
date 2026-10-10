// Offline packaging regression: committed bytes, manifest references and exclusion of local/development material.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const { execFileSync, spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-saver-package-test-'));
const write = (file, body) => { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, body); };
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
const sha = body => crypto.createHash('sha256').update(body).digest('hex');
function zipFile(bytes, filename) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(end >= 0, 'ZIP directory is present');
  let cursor = bytes.readUInt32LE(end + 16);
  while (bytes.readUInt32LE(cursor) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    if (name === filename) {
      const local = bytes.readUInt32LE(cursor + 42);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const body = bytes.subarray(start, start + bytes.readUInt32LE(cursor + 20));
      const method = bytes.readUInt16LE(cursor + 10);
      assert(method === 0 || method === 8, 'ZIP compression is supported');
      return method === 8 ? inflateRawSync(body) : body;
    }
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  assert.fail('Missing ZIP entry: ' + filename);
}
try {
  git('init', '-q');
  write('tools/package.mjs', fs.readFileSync(path.join(__dirname, 'tools/package.mjs')));
  const manifest = { manifest_version: 3, version: '2.0.0.25', background: { service_worker: 'background.js' },
    action: { default_popup: 'popup/quick.html' }, icons: { 128: 'icons/128.png' }, content_scripts: [{ js: ['content_x.js'] }] };
  write('manifest.json', JSON.stringify(manifest));
  for (const file of ['background.js', 'content_x.js', 'offscreen.js', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'lib/gifenc.js',
    'popup/THIRD_PARTY_NOTICES.txt', 'popup/assets/app.js', 'icons/128.png']) write(file, 'committed');
  write('background.js', 'committed\nsecond line\n');
  write('offscreen.html', '<script src="offscreen.js"></script>');
  write('popup/quick.html', '<script src="./assets/app.js"></script>');
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'local-notes/secret.txt', 'recovery/old.js', 'ui/src/dev.tsx', 'test_example.js']) write(file, 'local/development');
  git('add', '.');
  git('-c', 'user.name=Package test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Fixture');
  const source = git('rev-parse', 'HEAD');
  git('config', 'core.autocrlf', 'true');
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
  const zip = fs.readFileSync(output.archive);
  for (const entry of metadata.files) {
    const committed = execFileSync('git', ['cat-file', 'blob', source + ':' + entry.path], { cwd: root });
    const packaged = zipFile(zip, entry.path);
    assert.deepEqual(packaged, committed, entry.path + ': archive preserves committed bytes under autocrlf=true');
    assert.equal(entry.sha256, sha(packaged));
    assert.equal(entry.bytes, packaged.length);
  }
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
