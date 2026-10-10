// Package committed runtime files only. Review and accept the commit before invoking this command.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fixed = new Set(['manifest.json', 'background.js', 'offscreen.js', 'offscreen.html', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']);
const runtimeFile = file => fixed.has(file) || /^content_[a-z_]+\.js$/.test(file) ||
  /^lib\/.+\.(?:js|mjs)$/.test(file) || /^lib\/vendor\/.+\/(?:LICENSE|PROVENANCE\.json)$/.test(file) ||
  /^popup\/(?:[^/]+\.html|THIRD_PARTY_NOTICES\.txt|assets\/[^/]+\.(?:js|css|png|svg|woff2?))$/.test(file) ||
  /^icons\/[^/]+\.png$/.test(file);

try {
  assert(process.argv.length <= 3, 'Usage: node tools/package.mjs [accepted-commit]');
  const source = git('rev-parse', '--verify', '--end-of-options', `${process.argv[2] || 'HEAD'}^{commit}`).toString().trim();
  const entries = git('ls-tree', '-rz', '--full-tree', source).toString().split('\0').filter(Boolean).map(row => {
    const [meta, file] = row.split('\t');
    const [mode, type, blob] = meta.split(' ');
    return { file, mode, type, blob };
  }).filter(entry => runtimeFile(entry.file));
  const files = new Map();
  for (const entry of entries) {
    assert(entry.type === 'blob' && /^100(?:644|755)$/.test(entry.mode), `Runtime must be a regular file: ${entry.file}`);
    files.set(entry.file, git('cat-file', 'blob', entry.blob));
  }
  for (const file of fixed) assert(files.has(file), `Missing runtime file: ${file}`);
  const manifest = JSON.parse(files.get('manifest.json').toString());
  assert(manifest.manifest_version === 3, 'Manifest V3 required');
  assert(typeof manifest.version === 'string' && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(manifest.version) &&
    manifest.version.split('.').every(p => Number(p) <= 65535 && (p === '0' || p[0] !== '0')), 'Invalid manifest version');
  const references = [manifest.background?.service_worker, manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap(item => [...(item.js || []), ...(item.css || [])])];
  for (const file of references) assert(typeof file === 'string' && files.has(file), `Missing manifest reference: ${file}`);
  for (const file of ['lib/gifenc.js', 'popup/THIRD_PARTY_NOTICES.txt']) assert(files.has(file), `Missing bundled dependency/notice: ${file}`);
  for (const [file, bytes] of files) {
    if (file.endsWith('.html')) {
      for (const match of bytes.toString().matchAll(/(?:src|href)="([^"]+)"/g)) {
        const ref = match[1];
        if (/^(?:https?:|#)/.test(ref)) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), ref.split(/[?#]/)[0]));
        assert(files.has(target), `Missing page reference: ${file} -> ${ref}`);
      }
    }
  }
  const name = `ImageSaver-${manifest.version}-${source.slice(0, 12)}`;
  const directory = path.join(root, 'local-notes', 'releases');
  fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, name + '.zip');
  const names = [...files.keys()].sort();
  git('archive', '--format=zip', '--output=' + archive, source, '--', ...names);
  const archiveHash = hash(fs.readFileSync(archive));
  const metadata = {
    source_commit: source, manifest_version: manifest.version, archive: path.basename(archive), sha256: archiveHash,
    browser_acceptance: 'not-established-by-packaging',
    files: names.map(file => ({ path: file, bytes: files.get(file).length, sha256: hash(files.get(file)) })),
  };
  fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(metadata, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, name + '.sha256'), `${archiveHash}  ${path.basename(archive)}\n`);
  console.log(JSON.stringify({ archive, source_commit: source, manifest_version: manifest.version, sha256: archiveHash, files: names.length }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
