// feedback_tracker.js - bounded operation tracker + notifier for UX-02 / UX-04.
// Chrome APIs are injected (deps), so the same code runs in the service worker and in Node tests.
//
// Ownership: only operations created through begin() and downloads attached through attachDownload()
// are tracked. Unknown download IDs are ignored; unrelated user downloads are never searched or stored.
(function (root) {
  const FB = root.ImageSaverFeedback;
  const STORAGE_KEY = 'imageSaverFeedbackV1';

  function createTracker(deps) {
    const now = deps.now || Date.now;
    const log = deps.log || (() => {});
    let ops = [];                       // newest last
    let loaded = false;                 // the stored list was read; until then nothing is written over it
    let deferred = false;               // a write was skipped while the store was unreadable: due after the first successful read
    let chain = Promise.resolve();      // serializes every mutation (concurrent-safe read-modify-write)
    const pendingNotifications = new Set();

    function locked(fn) {
      const run = chain.then(fn, fn);
      chain = run.then(() => undefined, () => undefined);
      return run;
    }

    const find = (id) => ops.find((o) => o.id === id) || null;
    const findByDownload = (downloadId) => ops.find((o) => o.downloadId === downloadId && !FB.isTerminal(o.state)) ||
      ops.find((o) => o.downloadId === downloadId) || null;

    function evict() {
      const before = ops.length;
      const cutoff = now() - FB.LIMITS.retentionMs;
      ops = ops.filter((o) => !(FB.isTerminal(o.state) && o.updatedAt < cutoff));
      while (ops.length > FB.LIMITS.maxOps) {
        const idx = ops.findIndex((o) => FB.isTerminal(o.state));
        if (idx === -1) break;
        ops.splice(idx, 1);
      }
      return ops.length !== before;
    }

    async function persist() {
      evict();
      // A store that could not be read is never overwritten by the partial in-memory list (it holds operations of this session).
      if (!loaded) { deferred = true; try { if (deps.onChange) deps.onChange(); } catch (_) {} return; }
      try {
        await deps.storage.set(STORAGE_KEY, { v: FB.SCHEMA_VERSION, ops });
        deferred = false;
      } catch (err) {
        log('persist failed', err && err.message);
      }
      try { if (deps.onChange) deps.onChange(); } catch (_) {}
    }

    function emitNotification(record) {
      if (!deps.notify) return;
      record.notified = true;
      const copy = JSON.parse(JSON.stringify(record));
      const p = Promise.resolve().then(() => deps.notify(copy)).catch((err) => log('notify failed', err && err.message));
      pendingNotifications.add(p);
      p.then(() => pendingNotifications.delete(p));
    }

    function finish(record, state, failure) {
      record.state = state;
      record.updatedAt = now();
      record.failure = failure || null;
      if (state === 'failed' || state === 'interrupted') record.seen = false;
      if (!record.notified) emitNotification(record);
      emitFinished(record);
    }

    const inFlightHistory = new Set();
    // UX-03: every terminal record is offered to the history store (deduplicated there by operation id).
    function emitFinished(record) {
      if (!deps.onFinished || !record || inFlightHistory.has(record.id)) return;
      inFlightHistory.add(record.id);
      const copy = JSON.parse(JSON.stringify(record));
      const p = Promise.resolve()
        .then(() => deps.onFinished(copy))
        .then(() => locked(async () => {
          await ready;
          const current = find(record.id);
          if (!current) return;
          if (current.historyPending) {
            delete current.historyPending;
            await persist();
          }
        }))
        .catch((err) => {
          log('history failed', err && err.message);
          return locked(async () => {
            await ready;
            const current = find(record.id);
            if (!current) return;
            if (!current.historyPending) {
              current.historyPending = true;
              await persist();
            }
          });
        })
        .finally(() => {
          inFlightHistory.delete(record.id);
        });
      pendingNotifications.add(p);
      p.then(() => pendingNotifications.delete(p));
    }

    function recoverPendingHistory() {
      if (!deps.onFinished) return;
      for (const rec of ops) {
        if (rec.historyPending === true && FB.isTerminal(rec.state)) {
          emitFinished(rec);
        }
      }
    }

    function failureFrom(info, fallbackStage) {
      const stage = FB.STAGES.includes(info && info.stage) ? info.stage : fallbackStage;
      const input = { stage, code: info && info.code, status: info && info.status, downloadError: info && info.downloadError };
      return {
        stage,
        category: FB.classifyFailure(input),
        code: FB.normalizeCode(input.code),
        status: FB.normalizeStatus(input.status),
        downloadError: FB.normalizeCode(input.downloadError)
      };
    }

    // Policy metadata of a patch: only an allowlisted reason and finite bounded numbers are kept; anything else is ignored.
    function applyPolicy(record, patch) {
      const reason = FB.normalizeReason(patch.reason);
      if (reason) record.reason = reason;
      const duration = FB.normalizeSeconds(patch.durationSec);
      if (duration !== null) record.durationSec = duration;
      const threshold = FB.normalizeSeconds(patch.thresholdSec);
      if (threshold !== null) record.thresholdSec = threshold;
    }

    function applyOutput(record, patch) {
      if (!patch || typeof patch !== 'object') return;
      const merged = Object.assign({}, record.output, patch);
      record.output = FB.sanitizeRecord(Object.assign({}, record, { output: merged })).output;
    }

    // ---- hydration + restart reconciliation -------------------------------------------------

    // Reads the stored list. A rejected read is retried before the next tracker call; operations created meanwhile are kept after the
    // stored ones, and only the stored ones are reconciled as left over from an earlier worker.
    async function hydrate() {
      let restored;
      let pruned = false;
      const cutoff = now() - FB.LIMITS.retentionMs;
      try {
        const stored = await deps.storage.get(STORAGE_KEY);
        const list = stored && Array.isArray(stored.ops) ? stored.ops : [];
        const current = new Set(ops.map((o) => o.id));
        restored = list.map(FB.sanitizeRecord).filter((r) => r && !current.has(r.id) && !(FB.isTerminal(r.state) && r.updatedAt < cutoff));
        if (list.length !== restored.length) pruned = true;
      } catch (err) {
        log('hydrate failed', err && err.message);
        return;
      }
      ops = restored.concat(ops);
      if (evict()) pruned = true;
      loaded = true;
      await reconcile(restored.filter((r) => ops.includes(r)));
      // operations of this worker kept only in memory while the store was unreadable: the merged list is written now, not on some later change
      if (deferred || pruned) await persist();
      recoverPendingHistory();
    }

    // Uses the existing download ID where one is known; never re-downloads.
    async function reconcile(records) {
      let changed = false;
      for (const rec of records) {
        if (FB.isTerminal(rec.state)) continue;
        if (rec.downloadId === null) {
          finish(rec, 'failed', failureFrom({ stage: rec.state === 'converting' ? 'convert' : 'resolve', code: 'WORKER_RESTARTED' }, 'resolve'));
          changed = true;
          continue;
        }
        let item;
        try {
          item = await deps.getDownloadItem(rec.downloadId);
        } catch (_) {
          item = undefined;
        }
        if (item === undefined) continue; // lookup unavailable: leave as saving, events may still arrive
        if (item === null) {
          finish(rec, 'failed', failureFrom({ stage: 'download', code: 'DOWNLOAD_OUTCOME_UNKNOWN' }, 'download'));
        } else if (item.state === 'complete') {
          setMeasuredSize(rec, item);
          applyName(rec, item.filename, 'actual');
          finish(rec, 'complete', null);
        } else if (item.state === 'interrupted') {
          finishInterrupted(rec, item.error);
        }
        changed = true;
      }
      if (changed) await persist();
    }

    // Filename: the actual name comes only from the extension-owned DownloadItem (Chrome may rename on
    // collision or Save As); a requested name is "intended" and never overrides an actual one. Basename only.
    function applyName(rec, name, kind) {
      const clean = FB.safeBasename(name);
      if (!clean) return;
      if (kind === 'actual') { rec.filename = clean; rec.filenameKind = 'actual'; }
      else if (rec.filenameKind !== 'actual') { rec.filename = clean; rec.filenameKind = 'intended'; }
    }

    function setMeasuredSize(rec, item) {
      const size = [item && item.fileSize, item && item.totalBytes, item && item.bytesReceived].find((n) => Number.isFinite(n) && n > 0);
      if (size) applyOutput(rec, { sizeBytes: size, sizeKind: 'measured' });
    }

    function finishInterrupted(rec, errorCode) {
      const code = FB.normalizeCode(typeof errorCode === 'string' ? errorCode : '');
      const failure = failureFrom({ stage: 'download', downloadError: code }, 'download');
      if (failure.category === 'cancelled') finish(rec, 'cancelled', failure);
      else finish(rec, 'interrupted', failure);
    }

    const ready = hydrate();
    const gate = (fn) => locked(async () => { await ready; if (!loaded) await hydrate(); return fn(); });

    // ---- public API -----------------------------------------------------------------------------

    return {
      STORAGE_KEY,
      ready: () => ready,

      /** Creates an operation in state 'resolving'. Returns its correlation ID. */
      begin(info) {
        return gate(async () => {
          const i = info || {};
          const src = FB.safeUrlParts(i.sourceUrl);
          const t = now();
          const record = FB.sanitizeRecord({
            id: String(deps.genId()),
            createdAt: t,
            updatedAt: t,
            state: 'resolving',
            site: i.site,
            sourceHost: src.host,
            sourceExt: src.ext,
            pageHost: FB.safeHost(i.pageUrl),
            expectedType: i.expectedType,
            conversion: i.conversion
          });
          if (!record) return null;
          ops.push(record);
          await persist();
          return record.id;
        });
      },

      /** Moves a non-terminal operation between resolving/converting/saving and merges safe facts. */
      stage(id, state, patch) {
        return gate(async () => {
          const rec = find(id);
          if (!rec || FB.isTerminal(rec.state)) return false;
          if (['resolving', 'converting', 'saving'].includes(state)) rec.state = state;
          const p = patch || {};
          if (p.conversion && FB.sanitizeRecord(Object.assign({}, rec, { conversion: p.conversion })).conversion === p.conversion) rec.conversion = p.conversion;
          if (p.expectedType) rec.expectedType = FB.sanitizeRecord(Object.assign({}, rec, { expectedType: p.expectedType })).expectedType;
          if (p.site) rec.site = FB.sanitizeRecord(Object.assign({}, rec, { site: p.site })).site || rec.site;
          if (p.sourceUrl) {
            const s = FB.safeUrlParts(p.sourceUrl);
            rec.sourceHost = s.host || rec.sourceHost;
            rec.sourceExt = s.ext || rec.sourceExt;
          }
          applyPolicy(rec, p);
          applyOutput(rec, p.output);
          rec.updatedAt = now();
          await persist();
          return true;
        });
      },

      /**
       * Associates the extension's download ID with the operation and applies a terminal state that
       * already arrived (early event) or is already recorded by Chrome. Idempotent for repeated calls.
       */
      attachDownload(id, downloadId, patch) {
        return gate(async () => {
          const rec = find(id);
          if (!rec || FB.isTerminal(rec.state) || !Number.isInteger(downloadId)) return false;
          const owner = findByDownload(downloadId);
          if (owner && owner !== rec && !FB.isTerminal(owner.state)) return false;
          const p = patch || {};
          rec.downloadId = downloadId;
          rec.state = 'saving';
          if (p.fallback === true) {
            rec.fallback = true;
            rec.output = FB.sanitizeRecord(Object.assign({}, rec, { output: {} })).output; // fallback: never inherit primary evidence
            rec.filename = ''; // ... nor the primary file name
            rec.filenameKind = '';
          }
          applyName(rec, p.filename, 'intended');
          applyPolicy(rec, p);
          applyOutput(rec, p.output);
          rec.updatedAt = now();
          const early = deps.peekEarlyTerminal ? deps.peekEarlyTerminal(downloadId) : null;
          if (early && (early.state === 'complete' || early.state === 'interrupted')) {
            await terminal(rec, early.state, early.errorCode);
          } else {
            // The terminal event may have been forwarded before this ID was attached without reaching the
            // early cache (listener still awaiting storage). Ask Chrome about this owned ID only.
            let item;
            try { item = await deps.getDownloadItem(downloadId); } catch (_) { item = undefined; }
            if (item && item.state === 'complete') {
              setMeasuredSize(rec, item);
              applyName(rec, item.filename, 'actual');
              finish(rec, 'complete', null);
            } else if (item && item.state === 'interrupted') {
              finishInterrupted(rec, item.error);
            }
          }
          await persist();
          return true;
        });
      },

      /** Stores the verified owning-post link (known providers only; anything else is ignored, never guessed). */
      setPost(id, url) {
        return gate(async () => {
          const rec = find(id);
          const post = FB.safePostUrl(url);
          if (!rec || FB.isTerminal(rec.state) || !post) return false;
          rec.postUrl = post;
          await persist();
          return true;
        });
      },

      /** Records a failure observed by the pipeline. Ignored once the operation is terminal or a download is accepted. */
      fail(id, info) {
        return gate(async () => {
          const rec = find(id);
          if (!rec || FB.isTerminal(rec.state)) return false;
          if (rec.downloadId !== null && !(info && info.force)) return false; // outcome is decided by download events
          const failure = failureFrom(info, rec.state === 'converting' ? 'convert' : 'resolve');
          finish(rec, failure.category === 'cancelled' ? 'cancelled' : 'failed', failure);
          await persist();
          return true;
        });
      },

      /** Removes a not-yet-downloaded operation that turned out to be a duplicate request. */
      discard(id) {
        return gate(async () => {
          const rec = find(id);
          if (!rec || FB.isTerminal(rec.state) || rec.downloadId !== null) return false;
          ops = ops.filter((o) => o !== rec);
          await persist();
          return true;
        });
      },

      cancel(id) {
        return gate(async () => {
          const rec = find(id);
          if (!rec || FB.isTerminal(rec.state) || rec.downloadId !== null) return false;
          finish(rec, 'cancelled', failureFrom({ stage: 'save', code: 'USER_CANCELED' }, 'save'));
          await persist();
          return true;
        });
      },

      /** chrome.downloads.onChanged terminal state. Unknown, repeated and stale events are ignored. */
      downloadTerminal(downloadId, state, errorCode) {
        return gate(async () => {
          if (!Number.isInteger(downloadId)) return false;
          const rec = ops.find((o) => o.downloadId === downloadId && !FB.isTerminal(o.state));
          if (!rec) return false;
          await terminal(rec, state, errorCode);
          await persist();
          return true;
        });
      },

      markSeen(ids) {
        return gate(async () => {
          if (!Array.isArray(ids) && !(ids instanceof Set)) return false;
          const idList = Array.isArray(ids) ? ids : Array.from(ids);
          const maxOps = FB.LIMITS?.maxOps || 50;
          const idSet = new Set();
          for (const id of idList) {
            if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
              idSet.add(id);
              if (idSet.size >= maxOps) break;
            }
          }
          if (idSet.size === 0) return false;
          let changed = false;
          for (const rec of ops) {
            if (idSet.has(rec.id) && !rec.seen && (rec.state === 'failed' || rec.state === 'interrupted')) {
              rec.seen = true;
              changed = true;
            }
          }
          if (changed) await persist();
          return changed;
        });
      },

      clearFinished() {
        return gate(async () => {
          ops = ops.filter((o) => !FB.isTerminal(o.state));
          await persist();
        });
      },

      list() {
        return gate(async () => {
          if (evict()) await persist();
          recoverPendingHistory();
          return JSON.parse(JSON.stringify(ops)).reverse();
        });
      },

      get(id) {
        return gate(async () => {
          if (evict()) await persist();
          const r = find(id);
          return r ? JSON.parse(JSON.stringify(r)) : null;
        });
      },

      /** Synchronous, from memory (0 until hydrated). Used for the toolbar badge. */
      unseenFailureCount() {
        const cutoff = now() - FB.LIMITS.retentionMs;
        return ops.filter((o) => (o.state === 'failed' || o.state === 'interrupted') && !o.seen && o.updatedAt >= cutoff).length;
      },

      /** Test helper: waits for queued mutations and in-flight notifications. */
      async flush() {
        await ready;
        await chain;
        while (pendingNotifications.size) await Promise.all([...pendingNotifications]);
      }
    };

    async function terminal(rec, state, errorCode) {
      if (state === 'complete') {
        let item = null;
        try { item = await deps.getDownloadItem(rec.downloadId); } catch (_) {}
        if (item) { setMeasuredSize(rec, item); applyName(rec, item.filename, 'actual'); }
        finish(rec, 'complete', null);
      } else if (state === 'interrupted') {
        finishInterrupted(rec, typeof errorCode === 'string' ? errorCode : '');
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Notifier: at most one notification per finished operation; failures always attempted.
  // ---------------------------------------------------------------------------------------------

  const NOTIFY_PREFIX = 'imgsaver:';

  function createNotifier(deps) {
    const now = deps.now || Date.now;
    const log = deps.log || (() => {});
    const recentSuccesses = [];

    async function successesEnabled() {
      try {
        const prefs = await deps.getPrefs();
        return !prefs || prefs.notifySuccess !== false;
      } catch (_) {
        return true; // storage failure: keep the documented default
      }
    }

    return async function notify(record) {
      if (!record || !deps.notifications || typeof deps.notifications.create !== 'function') return false;
      if (record.state === 'cancelled') return false; // the user's own action: no toast
      const isSuccess = record.state === 'complete';
      if (isSuccess) {
        if (!(await successesEnabled())) return false;
        const t = now();
        while (recentSuccesses.length && t - recentSuccesses[0] > 10000) recentSuccesses.shift();
        if (recentSuccesses.length >= 4) return false; // burst guard: still listed in the popup
        recentSuccesses.push(t);
      }
      // the special notice needs the validated policy explanation of the record itself (reason, measured duration above the fixed threshold)
      const isDurationLimitNotice = isSuccess && FB.durationLimitOf(record) !== null;
      const isEn = Boolean(deps.lang === 'en' || record.lang === 'en' || (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage && chrome.i18n.getUILanguage().toLowerCase().startsWith('en')));
      const s = FB.summarize(record);
      const message = isDurationLimitNotice
        ? (isEn ? 'This animation exceeds the 30-second GIF limit. The source video was saved as MP4.' : 'Длительность анимации превышает 30 секунд. Исходное видео сохранено как MP4.')
        : (isSuccess
          ? s.lines.filter((l) => !l.startsWith('Ресурс:')).slice(0, 3).join(' · ')
          : [s.explanation, s.nextStep].filter(Boolean).join(' '));
      const title = isDurationLimitNotice
        ? (isEn ? 'MP4 saved without conversion' : 'MP4 сохранён без конвертации')
        : (isSuccess ? `${record.site || record.sourceHost || 'Image Saver'}: сохранено` : `Image Saver: ${s.title}`);
      const options = {
        type: 'basic',
        iconUrl: deps.iconUrl,
        title: FB.sanitizeText(title, 80),
        message: FB.sanitizeText(message || s.stateLabel, 200),
        contextMessage: isSuccess ? undefined : 'Нажмите, чтобы открыть подробности',
        priority: isSuccess ? 0 : 1,
        silent: isSuccess,
        requireInteraction: false
      };
      if (options.contextMessage === undefined) delete options.contextMessage;
      try {
        const out = deps.notifications.create(NOTIFY_PREFIX + record.id, options);
        if (out && typeof out.then === 'function') await out;
      } catch (err) {
        log('notifications.create failed', err && err.message); // OS-blocked or API error: popup list remains
        return false;
      }
      if (isSuccess && deps.autoClearMs && deps.notifications.clear) {
        const clearLater = deps.setTimeout || setTimeout;
        clearLater(() => { try { deps.notifications.clear(NOTIFY_PREFIX + record.id); } catch (_) {} }, deps.autoClearMs);
      }
      return true;
    };
  }

  root.ImageSaverFeedbackTracker = Object.freeze({ STORAGE_KEY, NOTIFY_PREFIX, createTracker, createNotifier });
})(typeof globalThis !== 'undefined' ? globalThis : self);
