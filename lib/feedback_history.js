// feedback_history.js - bounded local history of finished save operations (UX-03).
// Chrome storage is injected (deps), so the same code runs in the service worker and in Node tests.
//
// Entries are the allowlisted UX-02 records (lib/feedback.js sanitizeRecord) of operations that reached a
// terminal state, plus the verified owning-post link when the provider exposed one. No media bytes, Blob
// URLs, signed/source URLs, cookies or paths are stored. Unrelated downloads are never recorded: only
// operations created by the extension's own save handlers reach this store.
//
// Opt-in: recording requires `historyEnabled === true` (chrome.storage.local). Missing, malformed or
// unreadable preferences never authorize recording.
//
// Clear boundary: clear() persists `clearedAt` next to the entries. An operation created at or before that
// moment is never recorded afterwards (it was in flight, or is replayed by restart reconciliation of a stale
// session record); operations created later are recorded normally.
//
// Retention: entries older than RETENTION_MS or beyond MAX_ENTRIES are removed from storage by prune(), which
// runs at service-worker start, on every list() and on every record(). It cannot run while the browser is closed.
(function (root) {
  const FB = root.ImageSaverFeedback;
  const STORAGE_KEY = 'imageSaverHistoryV1';
  const ENABLED_KEY = 'historyEnabled';          // chrome.storage.local, default OFF
  const MAX_ENTRIES = 50;
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

  function createHistory(deps) {
    const now = deps.now || Date.now;
    const log = deps.log || (() => {});
    let chain = Promise.resolve(); // serializes read-modify-write so concurrent operations cannot lose updates

    const locked = (fn) => {
      const run = chain.then(fn, fn);
      chain = run.then(() => undefined, () => undefined);
      return run;
    };

    /** Reads the document and returns the clean state plus whether storage differs from it. */
    async function load() {
      const stored = await deps.storage.get(STORAGE_KEY);
      const rawList = stored && Array.isArray(stored.entries) ? stored.entries : [];
      const clearedAt = Number.isFinite(stored && stored.clearedAt) && stored.clearedAt > 0 ? stored.clearedAt : 0;
      const cutoff = now() - RETENTION_MS;
      const entries = rawList
        .map(FB.sanitizeRecord)
        .filter((r) => r && FB.isTerminal(r.state) && r.updatedAt >= cutoff && r.createdAt > clearedAt)
        .slice(-MAX_ENTRIES);
      // Dirty also when re-sanitizing changed an entry (e.g. a previously stored URL-derived name): storage
      // is rewritten so the cleaned form replaces it. Entries are written from sanitizeRecord, so key order is stable.
      const dirty = entries.length !== rawList.length || JSON.stringify(entries) !== JSON.stringify(rawList);
      return { entries, clearedAt, dirty };
    }

    async function write(entries, clearedAt) {
      await deps.storage.set(STORAGE_KEY, { v: 1, entries: entries.slice(-MAX_ENTRIES), clearedAt });
    }

    async function enabled() {
      try { return (await deps.isEnabled()) === true; } catch (_) { return false; }
    }

    // Persistent pruning. Returns { entries, pruneFailed }; a failed write never hides the readable entries.
    async function pruneNow() {
      const state = await load();
      if (!state.dirty) return { entries: state.entries, pruneFailed: false };
      try {
        await write(state.entries, state.clearedAt);
        return { entries: state.entries, pruneFailed: false };
      } catch (err) {
        log('history prune failed', err && err.message);
        return { entries: state.entries, pruneFailed: true };
      }
    }

    return {
      STORAGE_KEY,
      MAX_ENTRIES,
      RETENTION_MS,

      /** Upserts a finished operation (same operation id never produces a second entry). Never throws. */
      record(rec) {
        return locked(async () => {
          try {
            const entry = FB.sanitizeRecord(rec);
            if (!entry || !FB.isTerminal(entry.state)) return false;
            if (!(await enabled())) return false;
            const state = await load();
            if (entry.createdAt <= state.clearedAt) return false; // pre-clear operation: never resurrected
            const entries = state.entries;
            const i = entries.findIndex((e) => e.id === entry.id);
            if (i >= 0) entries[i] = entry; else entries.push(entry);
            await write(entries, state.clearedAt);
            return true;
          } catch (err) {
            log('history record failed', err && err.message);
            return false;
          }
        });
      },

      /** Prunes persistent storage (service-worker start / explicit). Never throws. */
      prune() {
        return locked(async () => {
          try { return (await pruneNow()).pruneFailed === false; } catch (_) { return false; }
        });
      },

      /** Newest first, after persistent pruning. Throws only if storage is unreadable. */
      list() {
        return locked(async () => {
          const res = await pruneNow();
          return { entries: res.entries.slice().reverse(), pruneFailed: res.pruneFailed };
        });
      },

      /**
       * Empties the store and persists the clear boundary in ONE write. Resolves only after that write
       * succeeded; if it fails the promise rejects and nothing may be reported as cleared.
       */
      clear() {
        return locked(async () => {
          const state = await load().catch(() => ({ clearedAt: 0 }));
          await write([], Math.max(now(), state.clearedAt + 1));
          return true;
        });
      }
    };
  }

  root.ImageSaverFeedbackHistory = Object.freeze({ createHistory, STORAGE_KEY, ENABLED_KEY, MAX_ENTRIES, RETENTION_MS });
})(typeof globalThis !== 'undefined' ? globalThis : self);
