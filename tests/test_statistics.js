const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const root = { structuredClone, console };
vm.createContext(root);
for (const p of ['lib/feedback.js', 'lib/statistics.js']) vm.runInContext(fs.readFileSync(p, 'utf8'), root);
const FB = root.ImageSaverFeedback;
function memory(initial = {}) {
  let state = initial.state, ops = new Map(initial.ops || []), deny = false;
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
  const idb = require('./helpers/idb.cjs')();
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
  // ---- STATISTICS-BY-SITE-01: site buckets ----
  const { SITES, siteOf, add } = root.MediaLatchStatistics;
  const at = (id, site, createdAt = 10, state = 'complete') => FB.sanitizeRecord({ ...rec(id, createdAt, state), site });
  const reconciled = (state, label) => {
    let sum = FB.computeStats([]);
    for (const id of SITES) sum = add(sum, state.sites[id]);
    same(sum, state.stats, label + ': overall equals the sum of the site buckets for every metric');
    same(Object.keys(state.sites), [...SITES], label + ': every category has a bucket, in the shared order');
  };
  const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
  const total = (state, id) => state.sites[id].total;
  assert.equal(siteOf({site:'danbooru'}),'danbooru','supported boards must have their own bucket');
  assert.equal(siteOf({site:'zerochan'}),'zerochan','supported galleries must have their own bucket');
  assert.equal(siteOf({site:'tenor'}),'tenor','supported GIF services must have their own bucket');
  assert.equal(siteOf({site:'pawchive.pw'}),'pawchive','the admitted Pawchive owner has its own bucket');
  const refused = async () => { throw Error('LEGACY_MUST_NOT_BE_READ'); };
  const make2 = (store, extra = {}) => root.MediaLatchStatistics.createStatistics({ storage: store, now: () => clock, legacy: refused, isEnabled: async () => enabled, ...extra });
  enabled = true;
  {
    // Earlier store: no buckets, bare per-operation contributions. Migration keeps every count whole as unattributed.
    const old = [rec('mig-op-1'), rec('mig-op-2', 10, 'failed'), rec('mig-op-3', 10, 'cancelled')];
    const store = memory({ state: { stats: FB.computeStats(old), clearedAt: 5, imported: 3 }, ops: old.map(r => [r.id, FB.computeStats([r])]) });
    const m = make2(store);
    let snap = await m.list();
    same(snap.stats, FB.computeStats(old), 'migration keeps the overall totals exactly');
    same(snap.sites.unattributed, snap.stats, 'the whole earlier count is unattributed, nothing is guessed');
    assert(SITES.filter(id => id !== 'unattributed').every(id => total(snap, id) === 0));
    assert.equal(snap.clearedAt, 5); assert.equal(snap.imported, 3); reconciled(snap, 'migrated');
    await m.list(); same((await m.list()).sites, snap.sites, 'migration is idempotent');
    await m.record(at('mig-op-1', 'x')); snap = await m.list();
    assert.equal(snap.stats.total, 3, 'replaying an old-format operation does not count it twice');
    assert.equal(total(snap, 'x'), 1); assert.equal(total(snap, 'unattributed'), 2, 'the old contribution left its old bucket'); reconciled(snap, 'old op attributed');
    await m.record(at('mig-op-1', 'x')); same((await m.list()).sites, snap.sites, 'a second replay changes nothing');
    await m.record(at('mig-op-1', 'x', 10, 'failed')); snap = await m.list();
    assert.equal(snap.stats.success, 0); assert.equal(snap.stats.failed, 2); assert.equal(snap.sites.x.failed, 1, 'a correction replaces the contribution inside its bucket'); reconciled(snap, 'corrected');
    await m.record(at('mig-op-1', '', 10, 'complete')); snap = await m.list();
    assert.equal(snap.sites.x.success, 1); assert.equal(total(snap, 'unattributed'), 2, 'a replay without a site never downgrades a known one'); reconciled(snap, 'not downgraded');
    await m.record(at('mig-op-1', 'reddit')); snap = await m.list();
    assert.equal(total(snap, 'x'), 0); assert.equal(total(snap, 'reddit'), 1, 'a corrected site moves the contribution'); reconciled(snap, 'moved');
    await m.record(at('mig-op-2', '', 10, 'cancelled')); snap = await m.list();
    assert.equal(snap.sites.unattributed.failed, 0); assert.equal(snap.sites.unattributed.cancelled, 2, 'an old unattributed operation is replaced in the unattributed bucket'); reconciled(snap, 'old unattributed corrected');
    assert.equal(snap.clearedAt, 5);
    const stored = store.data().ops.get('mig-op-1');
    same(Object.keys(stored).sort(), ['site', 'stats'], 'the ledger keeps only the category and the compact counts');
  }
  {
    // Categories: aliases, groups, generic hosts and unknown stay distinct; only finite categories are stored.
    const expected = { x: 'x', reddit: 'reddit', pixiv: 'pixiv', redgifs: 'redgifs', danbooru: 'danbooru', 'yande.re': 'yande.re', zerochan: 'zerochan', tenor: 'tenor', 'pawchive.pw': 'pawchive', wikimedia: 'wikimedia', 'example.com': 'other', 'cdn.example.net': 'other', constructor: 'other', 'unknown-site': 'unattributed', '': 'unattributed' };
    for (const [site, id] of Object.entries(expected)) assert.equal(siteOf({ site }), id, 'siteOf ' + (site || '(none)'));
    const store = memory(); const m = make2(store, { legacy: async () => null });
    let n = 0; for (const site of Object.keys(expected)) await m.record(at('cat-op-' + ++n, site));
    const snap = await m.list(); reconciled(snap, 'categories');
    assert.equal(total(snap, 'other'), 3); assert.equal(total(snap, 'unattributed'), 2); assert.equal(total(snap, 'danbooru'), 1); assert.equal(total(snap, 'yande.re'), 1); assert.equal(total(snap, 'pawchive'), 1); assert.equal(snap.stats.total, 15);
    const persisted = JSON.stringify([store.data().state, [...store.data().ops]]);
    assert(!/example|constructor|private\.jpg|cdn\./.test(persisted), 'no host, filename or page data is persisted, only categories');
    // a second site reaches its own bucket without touching the first
    const before = structuredClone(snap.sites.reddit); await m.record(at('cat-new', 'x')); same((await m.list()).sites.reddit, before);
    // recording off keeps every bucket
    const kept0 = structuredClone((await m.list()).sites);
    enabled = false; await m.record(at('off-site', 'pixiv')); same((await m.list()).sites, kept0, 'disabled recording preserves every bucket'); enabled = true;
    // a global clear empties every bucket, hidden and legacy ones included; a pre-clear replay never returns
    clock += 1000; const cleared = await m.clear(); reconciled(cleared, 'cleared'); assert.equal(cleared.stats.total, 0);
    assert(SITES.every(id => total(cleared, id) === 0), 'clear empties every site bucket');
    await m.record(at('cat-op-1', 'reddit', 10)); assert.equal((await m.list()).stats.total, 0, 'a pre-clear completion is not counted in any bucket');
    await m.record(at('late-op', 'reddit', clock + 1)); assert.equal(total(await m.list(), 'reddit'), 1);
    store.fail(true); await assert.rejects(m.clear()); store.fail(false);
    const kept = await m.list(); assert.equal(kept.stats.total, 1); assert.equal(total(kept, 'reddit'), 1, 'a failed clear keeps every bucket'); reconciled(kept, 'failed clear');
  }
  {
    // Legacy seed: retained owning-site metadata attributes a record; one without it stays unattributed.
    const legacy = { entries: [at('seed-a', 'x'), at('seed-b', ''), at('seed-c', 'unknown-site')], clearedAt: 0 };
    const m = make2(memory(), { legacy: async () => legacy });
    const snap = await m.list(); reconciled(snap, 'seeded');
    assert.equal(total(snap, 'x'), 1); assert.equal(total(snap, 'unattributed'), 2); assert.equal(snap.imported, 3);
  }
  {
    const idb2 = require('./helpers/idb.cjs')(); const m = make2(root.MediaLatchStatistics.database(idb2), { legacy: async () => null });
    await m.record(at('tx-op-1', 'x')); idb2.fail = true;
    await assert.rejects(m.record(at('tx-op-2', 'reddit')), /IDB_ABORT/);
    idb2.fail = true; await assert.rejects(m.record(at('tx-op-1', 'reddit', 10, 'failed')), /IDB_ABORT/);
    const snap = await m.list(); reconciled(snap, 'aborted');
    assert.equal(snap.stats.total, 1); assert.equal(total(snap, 'x'), 1); assert.equal(total(snap, 'reddit'), 0, 'an aborted transaction changes neither the overall nor any bucket');
    await m.record(at('tx-op-2', 'reddit')); assert.equal(total(await m.list(), 'reddit'), 1, 'the retry after an abort counts exactly once');
  }
  {
    // The category list covers every supported owning site that lib/download_paths.js knows, and RedGIFs inside Reddit is Reddit.
    const ctx = { console, URL }; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync('lib/folder_path.js', 'utf8'), ctx);
    vm.runInContext('const FolderPath = globalThis.ImageSaverFolderPath; function isSameOrSubdomain(h, d) { return h === d || h.endsWith("." + d); }' + fs.readFileSync('lib/download_paths.js', 'utf8') + ';globalThis.__rules = FOLDER_SITE_RULES; globalThis.__owner = determineOwningWebsite;', ctx);
    for (const [site] of ctx.__rules) if (site !== 'google' && site !== 'yandex') assert.notEqual(siteOf({ site }), 'other', 'the supported site ' + site + ' has a statistics category');
    const owner = (pageUrl, resolvedUrl = '') => siteOf({ site: ctx.__owner({ pageUrl, resolvedUrl }) });
    assert.equal(owner('https://www.reddit.com/r/gifs/comments/abc/', 'https://thumbs2.redgifs.com/clip.mp4'), 'reddit', 'Reddit-embedded RedGIFs belongs to Reddit');
    assert.equal(owner('https://www.redgifs.com/watch/clip'), 'redgifs');
    assert.equal(owner('https://twitter.com/a/status/1'), 'x'); assert.equal(owner('https://mobile.twitter.com/a/status/1'), 'x'); assert.equal(owner('https://sh.reddit.com/r/a/'), 'reddit');
    assert.equal(owner('https://some.generic.example/post/1', 'https://pbs.twimg.com/a.jpg'), 'other', 'an embedded media host never gives the site');
    assert.equal(owner('', ''), 'unattributed');
  }
  {
    // A user may have loaded the grouped candidate: splitting its buckets cannot discard already counted data.
    const groups={booru:FB.computeStats([at('group-board','danbooru')]),galleries:FB.computeStats([at('group-gallery','zerochan')]),gifs:FB.computeStats([at('group-gif','tenor')])};
    const all=Object.values(groups).reduce((sum,part)=>add(sum,part),FB.computeStats([]));
    const store=memory({state:{stats:all,clearedAt:0,imported:0,sites:groups},ops:Object.entries(groups).map(([site,stats])=>['group-'+site,{site,stats}])});
    const m=make2(store);let snap=await m.list();
    same(snap.stats,all,'splitting grouped counters keeps overall totals');
    same(snap.sites.unattributed,all,'past grouped counts cannot be guessed into individual sites');reconciled(snap,'split groups');
    await m.record(at('group-booru','danbooru'));snap=await m.list();
    assert.equal(snap.stats.total,3);assert.equal(snap.sites.danbooru.total,1);assert.equal(snap.sites.unattributed.total,2);reconciled(snap,'group replay');
    await m.record(at('group-booru','danbooru'));same((await m.list()).stats,snap.stats,'grouped replay stays idempotent');
  }
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
  {
    // Site view: a local selection that survives refreshes, refresh failures and a clear; a missing bucket is never filled from the overall figures.
    const bucket = (success, failed = 0) => FB.computeStats([...Array.from({ length: success }, (_, i) => rec('ui-ok-' + i)), ...Array.from({ length: failed }, (_, i) => rec('ui-bad-' + i, 10, 'failed'))]);
    const snap = (reddit, x) => ({ success: true, imported: 0, stats: add(reddit, x), sites: Object.fromEntries(SITES.map(id => [id, id === 'reddit' ? reddit : id === 'x' ? x : FB.computeStats([])])) });
    let reply = snap(bucket(2), bucket(1, 1)), fail = false, failClear = false, listener, calls = [];
    const chromeSites = {
      storage: { local: { get: async () => ({ historyEnabled: true }), set: async () => {} }, onChanged: { addListener() {}, removeListener() {} } },
      runtime: { sendMessage: async m => { calls.push(m.action); if (m.action === 'STATISTICS_CLEAR') return failClear ? { success: false } : { ...snap(FB.computeStats([]), FB.computeStats([])), stats: FB.computeStats([]) }; if (fail) throw Error('LOST'); return reply; }, onMessage: { addListener: fn => { listener = fn; }, removeListener() {} } },
    };
    const sc = createUi({ chrome: chromeSites }); await sc.ready;
    let st = sc.store.getState();
    assert.equal(st.site, 'all'); assert.equal(Object.keys(st.sites).length, 14, 'board buckets share a single presentation category'); assert('booru' in st.sites && !('danbooru' in st.sites));
    sc.selectSite('nope'); assert.equal(sc.store.getState().site, 'all', 'an unknown site cannot be selected');
    sc.selectSite('reddit'); assert.equal(sc.store.getState().site, 'reddit'); assert.equal(sc.store.getState().sites.reddit.total, 2);
    reply = snap(bucket(3), bucket(1, 1)); listener({ action: 'STATISTICS_CHANGED' }); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    st = sc.store.getState(); assert.equal(st.site, 'reddit', 'a refresh keeps the selected site'); assert.equal(st.sites.reddit.total, 3); assert.equal(st.stats.total, 5);
    fail = true; listener({ action: 'STATISTICS_CHANGED' }); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    st = sc.store.getState(); assert.equal(st.site, 'reddit'); assert.equal(st.error, 'statistics.loadFailed'); assert.equal(st.sites.reddit.total, 3, 'a failed refresh keeps the last good bucket'); assert.equal(st.status, 'ready');
    fail = false; reply = snap(bucket(4), bucket(1, 1)); listener({ action: 'STATISTICS_CHANGED' }); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    st = sc.store.getState(); assert.equal(st.error, ''); assert.equal(st.site, 'reddit'); assert.equal(st.sites.reddit.total, 4, 'recovery restores the figures under the same selection');
    failClear = true; await sc.clear(); failClear = false; st = sc.store.getState(); assert.equal(st.error, 'statistics.clearFailed'); assert.equal(st.sites.reddit.total, 4, 'a failed clear is an error, never a fabricated zero'); assert.equal(st.site, 'reddit');
    fail = false; reply = snap(FB.computeStats([]), FB.computeStats([])); await sc.clear(); st = sc.store.getState();
    assert.equal(st.cleared, true); assert.equal(st.site, 'reddit', 'clear is global and keeps the view'); assert(Object.values(st.sites).every(s => s.total === 0) && st.stats.total === 0, 'clear empties every view');
    assert.equal(calls.filter(a => a === 'STATISTICS_CLEAR').length, 2); sc.dispose();
    // Group every board metric for display without rewriting the worker's detailed snapshot.
    const boards = [at('board-a', 'danbooru'), at('board-b', 'gelbooru', 10, 'failed'), at('board-c', 'e621')];
    reply = { success: true, stats: FB.computeStats(boards), sites: Object.fromEntries(SITES.map(id => [id, FB.computeStats(boards.filter(r => r.site === id))])) };
    const untouched = JSON.stringify(reply);
    const grouped = createUi({ chrome: chromeSites }); await grouped.ready;
    same(grouped.store.getState().sites.booru, reply.stats, 'Booru combines every metric across board sites');
    assert.equal(grouped.store.getState().sites.booru.total, 3); assert.equal(grouped.store.getState().sites.booru.failed, 1);
    grouped.selectSite('booru'); assert.equal(grouped.store.getState().site, 'booru');
    assert.equal(JSON.stringify(reply), untouched, 'presentation grouping never mutates individual stored counters'); grouped.dispose();
    // a snapshot without buckets (or with broken ones) leaves only the all-sites view
    reply = { success: true, stats: bucket(2), sites: { reddit: { total: 'x' }, x: null } };
    const bare = createUi({ chrome: chromeSites }); await bare.ready;
    assert.deepEqual(Object.keys(bare.store.getState().sites), [], 'malformed buckets are dropped'); bare.selectSite('reddit'); assert.equal(bare.store.getState().site, 'all'); assert.equal(bare.store.getState().stats.total, 2); bare.dispose();
  }
  console.log('Statistics: migration, unlimited counters, restart dedup, correction, opt-out, atomic failures, clear boundary, privacy and concurrency PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
