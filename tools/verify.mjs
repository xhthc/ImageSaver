// A bounded entry point for the existing checks. No npm installation is implicit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withUi = process.argv.includes('--ui');
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice('--only='.length);
const logDir = path.join(root, 'local-notes', 'checks');
fs.mkdirSync(logDir, { recursive: true });
const results = [];
function run(name, args, { cwd = root, timeout = 30000 } = {}) {
  const start = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
  });
  const output = (result.stdout || '') + (result.stderr || '') + (result.error ? `\n${result.error.message}\n` : '');
  fs.writeFileSync(path.join(logDir, `${name}.log`), output);
  const passed = result.status === 0 && !result.error;
  results.push({ name, passed, exit: result.status, signal: result.signal, duration_ms: Date.now() - start, error: result.error?.message });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name} (${Date.now() - start} ms)`);
  if (!passed) console.log(output.slice(-1800));
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const syntaxFiles = new Set([
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap(entry => entry.js),
  'offscreen.js',
  ...fs.readdirSync(path.join(root, 'lib')).filter(file => file.endsWith('.js') || file.endsWith('.mjs')).map(file => `lib/${file}`),
  'tools/verify.mjs',
  'tools/package.mjs',
]);
if (!only) for (const file of syntaxFiles) run(`syntax-${file.replaceAll('/', '-')}`, ['--check', file]);

const tests = [
  'test_download_manager.js',
  'test_statistics.js',
  'test_sankaku_original.js',
  'test_post_media.js',
  'test_zerochan_original.js',
  'test_suite.js', 'test_animation_duration_policy.js', 'test_context_target_avatar.js', 'test_debug_journal.js',
  'test_resolver_metadata.js', 'test_generic_context_boundary.js', 'test_offscreen_resources.js', 'test_reddit_frame_lifecycle.js',
  'test_reddit_inline_diagnostic.js', 'test_reddit_inline.js', 'test_redgifs_reinjection.js', 'test_redgifs_selected_target.js', 'test_redgifs_inline.js', 'test_reddit_hls.js',
  'test_release_check.js', 'test_release_runtime.js', 'test_package.js', 'test_ux_feedback.js', 'test_ux_ui.js', 'test_youtube_sharing.js',
];
if (only && (!tests.includes(only) || withUi)) {
  console.error('--only must name an existing offline test from the list and cannot be combined with --ui.');
  process.exit(2);
}
for (const file of tests.filter(file => !only || file === only)) {
  // The inline suite has many real timing waits; 30 s reaches its last case before the deadline.
  run(file.slice(0, -3), [file], { timeout: file === 'test_reddit_inline.js' ? 45000 : 30000 });
}
if (withUi) {
  const ui = path.join(root, 'ui');
  run('ui-typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: ui });
  run('ui-render', ['test_ui_render.js'], { timeout: 120000 });
  run('ui-built', ['scripts/check-built.mjs'], { cwd: ui, timeout: 120000 });
} else {
  console.log('UI typecheck, render and build parity: NOT RUN (use --ui after npm ci --prefix ui).');
}
fs.writeFileSync(path.join(logDir, only ? `summary-${only}.json` : 'summary.json'), JSON.stringify({
  checked_at: new Date().toISOString(), manifest_version: manifest.version,
  ui_requested: withUi, selected_test: only ?? null, browser_acceptance: 'not-run', results,
}, null, 2) + '\n');
console.log(`${results.filter(r => r.passed).length}/${results.length} checks passed; logs: local-notes/checks/`);
process.exitCode = results.every(r => r.passed) ? 0 : 1;
