// Event-driven IndexedDB double for transaction acknowledgement/abort regressions, not native acceptance.
module.exports = function idbDouble() {
  const databases = new Map(), schemas = new Map();
  const fake = { hold: false, fail: false, commits: [], open(name) {
    const req = {};
    setImmediate(() => {
      const fresh = !databases.has(name);
      const data = databases.get(name) || new Map(); databases.set(name, data);
      const schema=schemas.get(name) || new Map();schemas.set(name,schema);
      req.result = {
        close() {}, createObjectStore(name,options={}) {data.set(name,new Map());const meta={keyPath:options.keyPath,indexes:new Map()};schema.set(name,meta);return {createIndex:(index,key)=>meta.indexes.set(index,key)};},
        transaction(names) {
          const copy = new Map([...databases.get(name)].map(([k, v]) => [k, new Map(v)]));
          let pending = 0, aborted = false, timer;
          const tx = { error: null, abort() { if (aborted) return; aborted = true; tx.onabort?.(); }, objectStore(name) {
            const run = action => {
              const r = {}; pending++; clearImmediate(timer);
              setImmediate(() => {
                if (aborted) return;
                try { r.result = action(copy.get(name)); r.onsuccess?.(); }
                catch (e) { tx.error = e; tx.abort(); return; }
                if (!--pending) timer = setImmediate(() => {
                  if (aborted || pending) return;
                  const commit = () => { if (aborted) return; if (fake.fail || fake.failAll) { fake.fail = false; tx.error = Error('IDB_ABORT'); tx.abort(); } else { databases.set(nameOfDb, copy); tx.oncomplete?.(); } };
                  if (fake.hold) fake.commits.push(commit); else commit();
                });
              });
              return r;
            };
            return { get: key => run(s => structuredClone(s.get(key))), put: (value, key) => run(s => s.set(key ?? value[schema.get(name)?.keyPath], structuredClone(value))), delete:key=>run(s=>s.delete(key)), index:index=>({get:key=>run(s=>structuredClone([...s.values()].find(value=>value[schema.get(name)?.indexes.get(index)]===key)))}), clear: () => run(s => s.clear()) };
          } };
          const nameOfDb = name;
          return tx;
        },
      };
      if (fresh) req.onupgradeneeded?.(); req.onsuccess?.();
    });
    return req;
  } };
  return fake;
};
