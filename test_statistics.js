const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const root = { structuredClone, console };
vm.createContext(root);
for (const p of ['lib/feedback.js', 'lib/statistics.js']) vm.runInContext(fs.readFileSync(p, 'utf8'), root);
const FB = root.ImageSaverFeedback;
function memory() {
  let state, ops = new Map(), deny = false;
  return {
    async update(fn) {
      if (deny) throw Error('WRITE_FAILED');
      const next = new Map(ops); let value;
      fn(state && structuredClone(state), { get: (id, cb) => cb(next.get(id)), put: (id, v) => next.set(id, v), clear: () => next.clear(), save: v => { value = v; } });
      state = structuredClone(value); ops = next; return structuredClone(state);
    },
    fail: v => { deny = v; },
    data: () => ({ state, ops }),
  };
}
const rec = (id, createdAt = 10, state = 'complete') => FB.sanitizeRecord({ id, createdAt, updatedAt: createdAt, state, site: 'reddit', filename: 'private.jpg', output: { type: 'pic', ext: '.jpg', mime: 'image/jpeg', evidence: 'verified_mime', sizeBytes: 30, sizeKind: 'measured' } });
(async () => {
  const storage = memory(); let enabled = true, clock = 1e6, legacyReads = 0;
  const deps = { storage, now: () => clock, legacy: async () => { legacyReads++; return { entries: [rec('old-op'), rec('old-op')], clearedAt: 0 }; }, isEnabled: async () => enabled };
  const make = () => root.MediaLatchStatistics.createStatistics(deps);
  let s = make();
  assert.equal((await s.list()).stats.total, 1); assert.equal(legacyReads, 1);
  for (let i = 0; i < 80; i++) await s.record(rec('new-op-' + i));
  assert.equal((await s.list()).stats.total, 81, 'no old 50-entry limit');
  clock += 30 * 86400000; assert.equal((await s.list()).stats.total, 81, 'no seven-day expiration');
  s = make(); await s.record(rec('new-op-2')); assert.equal((await s.list()).stats.total, 81, 'restart replay once');
  await s.record(rec('new-op-2', 10, 'failed')); const updated = (await s.list()).stats;
  assert.equal(updated.total, 81); assert.equal(updated.success, 80); assert.equal(updated.failed, 1);
  enabled = false; await s.record(rec('off-op')); assert.equal((await s.list()).stats.total, 81);
  storage.fail(true); await assert.rejects(s.clear()); storage.fail(false); assert.equal((await s.list()).stats.total, 81);
  await s.clear(); enabled = true; await s.record(rec('new-op-2')); assert.equal((await s.list()).stats.total, 0, 'pre-clear replay never resurrects');
  await s.record(rec('after-clear', clock + 1)); assert.equal((await s.list()).stats.total, 1);
  assert.equal(legacyReads, 1, 'clear/restart do not import old data again');
  assert(!JSON.stringify([...storage.data().ops]).includes('private.jpg'), 'compact dedup ledger has no filename');
  const concurrent = Array.from({ length: 20 }, (_, i) => s.record(rec('concurrent-' + i, clock + 2)));
  await Promise.all(concurrent); assert.equal((await s.list()).stats.total, 21, 'serialized completions do not lose totals');
  const bad = root.MediaLatchStatistics.createStatistics({ ...deps, storage: memory(), legacy: async () => { throw Error('READ_FAILED'); } });
  await assert.rejects(bad.list(), /READ_FAILED/);
  const idb = require('./tests/helpers/idb.cjs')();
  const nativeAdapter = root.MediaLatchStatistics.database(idb);
  const durable = root.MediaLatchStatistics.createStatistics({ ...deps, storage: nativeAdapter, legacy: async () => null });
  await durable.list();
  idb.hold = true;
  let acknowledged = false;
  const commit = durable.record(rec('tx-operation', clock + 3)).then(() => { acknowledged = true; });
  while (!idb.commits.length) await new Promise(r => setImmediate(r));
  assert.equal(acknowledged, false, 'request success is not transaction acknowledgement');
  idb.hold = false; idb.commits.shift()(); await commit;
  idb.fail = true; await assert.rejects(durable.record(rec('aborted-op', clock + 4)), /IDB_ABORT/);
  assert.equal((await durable.list()).stats.total, 1, 'abort commits neither ledger nor counters');
  const resumed = root.MediaLatchStatistics.createStatistics({ ...deps, storage: root.MediaLatchStatistics.database(idb), legacy: async () => null });
  await resumed.record(rec('tx-operation', clock + 3)); assert.equal((await resumed.list()).stats.total, 1, 'IDB adapter survives a fresh service instance');
  const { createStatistics: createUi } = await import(require('node:url').pathToFileURL(require('node:path').resolve('ui/src/core/statistics.js')).href);
  let rejectRead, preferenceEvent, messageEvent;
  const chrome = {
    storage: { local: { get: () => new Promise((_, reject) => { rejectRead = reject; }), set: async () => {} }, onChanged: { addListener: fn => { preferenceEvent = fn; }, removeListener() {} } },
    runtime: { sendMessage: async () => ({ success: true, stats: FB.computeStats([]) }), onMessage: { addListener: fn => { messageEvent = fn; }, removeListener: fn => { if (messageEvent === fn) messageEvent = null; } } },
  };
  const ui = createUi({ chrome });
  preferenceEvent({ historyEnabled: { newValue: true } }, 'local'); rejectRead(Error('OLD_READ'));
  await ui.ready;
  assert.equal(ui.store.getState().enabled, true); assert.equal(ui.store.getState().error, '', 'stale failed read cannot contradict the newer preference');
  ui.dispose(); assert.equal(messageEvent, null, 'page close removes live statistics subscription');
  console.log('Statistics: migration, unlimited counters, restart dedup, correction, opt-out, atomic failures, clear boundary, privacy and concurrency PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
