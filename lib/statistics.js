// Private all-time counters. Compact per-operation contributions make terminal replay idempotent;
// no media addresses, filenames, paths or owning-post links are kept here. Every count also sits in exactly one site bucket
// (a finite service category), so the overall totals always equal the sum of the buckets.
(function (root) {
  const FB = root.ImageSaverFeedback;
  const empty = () => FB.computeStats([]);
  // One finite owning-site list for worker and page; generic browsing hosts never get their own bucket.
  const SITES = Object.freeze(['x', 'reddit', 'pixiv', 'redgifs', 'pawchive', 'zerochan', 'anime-pictures', 'danbooru', 'rule34', 'safebooru', 'gelbooru', 'realbooru', 'xbooru', 'hypnohub', 'tbib', 'curveybooru', 'inkbooru', 'mspabooru', 'scatbooru', 'yakui', 'e621', 'yande.re', 'konachan', 'e-shuushuu', 'sankaku', 'tenor', 'giphy', 'wikimedia', 'other', 'unattributed']);
  const KNOWN = new Set(SITES.filter(id => id !== 'other' && id !== 'unattributed'));
  const siteOf = r => {
    const site = r.site === 'pawchive.pw' ? 'pawchive' : r.site;
    return KNOWN.has(site) ? site : (site && site !== 'unknown-site' ? 'other' : 'unattributed');
  };
  function add(a, b, sign = 1) {
    const out = structuredClone(a);
    for (const k of Object.keys(b)) {
      if (typeof b[k] === 'number') out[k] += sign * b[k];
      else out[k] = add(out[k], b[k], sign);
    }
    return out;
  }
  // Buckets exist for every category. A state from before the buckets keeps its whole count as unattributed: nothing is guessed.
  function sited(s) {
    const previous = s.sites;
    s.sites = Object.fromEntries(SITES.map(id => [id, previous?.[id] || empty()]));
    if (!previous) s.sites.unattributed = structuredClone(s.stats);
    // A removed/grouped bucket cannot be split retrospectively; preserve its counts and ledger replays as unattributed.
    else for (const [id, stats] of Object.entries(previous)) if (!SITES.includes(id)) s.sites.unattributed = add(s.sites.unattributed, stats);
    return s;
  }
  const fresh = (clearedAt, imported = 0) => sited({ stats: empty(), clearedAt, imported });
  // A stored contribution is { site, stats }; the earlier format was the bare stats, counted inside the unattributed bucket.
  function entry(v) {
    if (!v) return null;
    if (typeof v.total === 'number') return { site: 'unattributed', stats: v };
    return v.stats ? { site: SITES.includes(v.site) ? v.site : 'unattributed', stats: v.stats } : null;
  }
  function apply(s, e, sign) { s.stats = add(s.stats, e.stats, sign); s.sites[e.site] = add(s.sites[e.site], e.stats, sign); }
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
        fn(sited(raw), tx);
      }).catch(async err => {
        if (err.message !== 'STATISTICS_NEEDS_SEED') throw err;
        legacy = await deps.legacy();
        return storage.update((raw, tx) => {
          const state = sited(raw || fresh(legacy?.clearedAt || 0));
          if (!raw) {
            const unique = new Map();
            for (const rec of legacy?.entries || []) {
              const r = FB.sanitizeRecord(rec);
              if (r && FB.isTerminal(r.state) && r.createdAt > state.clearedAt) unique.set(r.id, r);
            }
            for (const [id, r] of unique) { const e = { site: siteOf(r), stats: FB.computeStats([r]) }; apply(state, e, 1); tx.put(id, e); }
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
          tx.get(r.id, prev => {
            // Replace the earlier contribution in its own bucket; a known site is never downgraded by a replay that lacks it.
            const old = entry(prev), site = siteOf(r), next = { site: site === 'unattributed' && old ? old.site : site, stats: FB.computeStats([r]) };
            if (old) apply(s, old, -1);
            apply(s, next, 1); tx.put(r.id, next); tx.save(s);
          });
        });
        deps.changed?.();
        return true;
      }),
      clear: () => locked(async () => {
        const result = await update((s, tx) => { tx.clear(); tx.save(fresh(Math.max(now(), s.clearedAt + 1))); });
        deps.changed?.();
        return result;
      }),
    };
  }
  root.MediaLatchStatistics = Object.freeze({ createStatistics, add, database, siteOf, SITES });
})(globalThis);
