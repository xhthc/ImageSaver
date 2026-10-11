// Private all-time counters. Compact per-operation contributions make terminal replay idempotent;
// no media addresses, filenames, paths or owning-post links are kept here.
(function (root) {
  const FB = root.ImageSaverFeedback;
  const empty = () => FB.computeStats([]);
  function add(a, b, sign = 1) {
    const out = structuredClone(a);
    for (const k of Object.keys(b)) {
      if (typeof b[k] === 'number') out[k] += sign * b[k];
      else out[k] = add(out[k], b[k], sign);
    }
    return out;
  }
  function database(idb) {
    let opening;
    const open = () => opening || (opening = new Promise((resolve, reject) => {
      const req = idb.open('medialatch-statistics', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('totals'); req.result.createObjectStore('operations'); };
      req.onerror = () => { opening = null; reject(req.error); };
      let blocked = false;
      req.onblocked = () => { blocked = true; opening = null; reject(new Error('STATISTICS_BLOCKED')); };
      req.onsuccess = () => { const db = req.result; if (blocked) { db.close(); return; } db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
    }));
    return {
      async update(fn) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(['totals', 'operations'], 'readwrite');
          const totals = tx.objectStore('totals'), ops = tx.objectStore('operations');
          let result, failure;
          const req = totals.get('current');
          req.onsuccess = () => {
            try { fn(req.result, {
              get: (id, cb) => { const r = ops.get(id); r.onsuccess = () => { try { cb(r.result); } catch (e) { failure = e; tx.abort(); } }; },
              put: (id, value) => ops.put(value, id),
              clear: () => ops.clear(),
              save: (value) => { result = value; totals.put(value, 'current'); },
            }); } catch (e) { failure = e; tx.abort(); }
          };
          tx.oncomplete = () => resolve(result);
          tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('STATISTICS_STORAGE'));
        });
      },
    };
  }
  function createStatistics(deps) {
    const storage = deps.storage || database(deps.indexedDB || root.indexedDB);
    const now = deps.now || Date.now;
    let chain = Promise.resolve();
    const locked = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
    async function update(fn) {
      // Read legacy data only while migration is pending. A failed read must never mark it imported.
      let legacy;
      return storage.update((raw, tx) => {
        if (!raw) throw new Error('STATISTICS_NEEDS_SEED');
        fn(raw, tx);
      }).catch(async err => {
        if (err.message !== 'STATISTICS_NEEDS_SEED') throw err;
        legacy = await deps.legacy();
        return storage.update((raw, tx) => {
          const state = raw || { stats: empty(), clearedAt: legacy?.clearedAt || 0, imported: 0 };
          if (!raw) {
            const unique = new Map();
            for (const rec of legacy?.entries || []) {
              const r = FB.sanitizeRecord(rec);
              if (r && FB.isTerminal(r.state) && r.createdAt > state.clearedAt) unique.set(r.id, r);
            }
            for (const [id, r] of unique) { const contribution = FB.computeStats([r]); state.stats = add(state.stats, contribution); tx.put(id, contribution); }
            state.imported = unique.size;
          }
          fn(state, tx);
        });
      });
    }
    return {
      list: () => locked(() => update((s, tx) => tx.save(s))),
      record: rec => locked(async () => {
        const r = FB.sanitizeRecord(rec);
        if (!r || !FB.isTerminal(r.state) || !await deps.isEnabled()) return false;
        await update((s, tx) => {
          if (r.createdAt <= s.clearedAt) { tx.save(s); return; }
          tx.get(r.id, old => { const contribution = FB.computeStats([r]); s.stats = add(old ? add(s.stats, old, -1) : s.stats, contribution); tx.put(r.id, contribution); tx.save(s); });
        });
        deps.changed?.();
        return true;
      }),
      clear: () => locked(async () => {
        const result = await update((s, tx) => { tx.clear(); tx.save({ stats: empty(), clearedAt: Math.max(now(), s.clearedAt + 1), imported: 0 }); });
        deps.changed?.();
        return result;
      }),
    };
  }
  root.MediaLatchStatistics = Object.freeze({ createStatistics, add, database });
})(globalThis);
