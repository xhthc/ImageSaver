// Offscreen lifetime owns its state; worker dependencies are supplied explicitly.
(function (root) {
    function create({ chrome, offscreenRequest, isFileExport, activeProtectedBlobsByDownloadId, earlyTerminalDownloadStates, addTrackedDownloadId, isManagerBusy }) {
        const offscreenState = {
            activeOffscreenTasks: 0, offscreenRecoveryPromise: null, offscreenCloseDeferred: false,
            offscreenOwnershipKnown: false, offscreenCreationPromise: null, offscreenClosingPromise: null,
            activeOffscreenOwners: new Map(), activeRevokedBlobs: new Set()
        };
        /**
         * Ensures that an offscreen document exists with reasons ['BLOBS'].
         * Uses single-flight shared creation promise so concurrent callers create at most one document.
         */
        async function ensureOffscreenDocument() {
            if (!chrome.offscreen) {
                throw new Error('chrome.offscreen API is not available in this environment');
            }
            if (offscreenState.offscreenClosingPromise) {
                await offscreenState.offscreenClosingPromise.catch(() => { });
            }
            if (chrome.runtime?.getContexts) {
                const existing = await chrome.runtime.getContexts({
                    contextTypes: ['OFFSCREEN_DOCUMENT']
                });
                if (existing && existing.length > 0) {
                    return;
                }
            }
            if (offscreenState.offscreenCreationPromise) {
                return offscreenState.offscreenCreationPromise;
            }
            offscreenState.offscreenCreationPromise = (async () => {
                try {
                    await chrome.offscreen.createDocument({
                        url: 'offscreen.html',
                        reasons: ['BLOBS'],
                        justification: 'Fetch and manage protected media BLOBS in offscreen document'
                    });
                }
                catch (err) {
                    if (!err?.message?.includes('Only a single offscreen document may be created')) {
                        throw err;
                    }
                }
                finally {
                    offscreenState.offscreenCreationPromise = null;
                }
            })();
            return offscreenState.offscreenCreationPromise;
        }
        /**
         * Tracks an active offscreen task with an owner key and optional associated blobUrl.
         * Increments offscreenState.activeOffscreenTasks and records ownership.
         */
        function acquireOffscreenTask(ownerKey = null, blobUrl = null) {
            const key = ownerKey || (blobUrl ? `blob_${blobUrl}` : `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
            offscreenState.activeOffscreenOwners.set(key, blobUrl || null);
            offscreenState.activeOffscreenTasks = offscreenState.activeOffscreenOwners.size;
            return key;
        }
        /**
         * Transfers offscreen task ownership directly from oldOwnerKey to newOwnerKey
         * without revoking the underlying Blob URL or changing active task count.
         */
        function transferOffscreenTask(oldOwnerKey, newOwnerKey, blobUrl) {
            if (oldOwnerKey && offscreenState.activeOffscreenOwners.has(oldOwnerKey)) {
                offscreenState.activeOffscreenOwners.delete(oldOwnerKey);
            }
            if (newOwnerKey) {
                offscreenState.activeOffscreenOwners.set(newOwnerKey, blobUrl || null);
            }
            offscreenState.activeOffscreenTasks = offscreenState.activeOffscreenOwners.size;
        }
        /**
         * Checks whether any protected Blob downloads are currently active in memory or session storage.
         */
        function hasActiveProtectedDownloads() {
            return activeProtectedBlobsByDownloadId.size > 0;
        }
        async function closeOffscreenDocument() {
            if (isManagerBusy())
                return;
            if (offscreenState.activeOffscreenTasks > 0 || hasActiveProtectedDownloads())
                return;
            // Persisted live downloads are not recovered yet (recovery pending, or its initial storage read failed): the owners are not restored, so an
            // empty owner set proves nothing and nothing may be closed. The request is remembered and runs once ownership is known. A request while the
            // ownership is unknown and no recovery runs makes one fresh attempt to learn it (no timer, no loop: only a request starts it).
            if (!offscreenState.offscreenOwnershipKnown) {
                offscreenState.offscreenCloseDeferred = true;
                if (!offscreenState.offscreenRecoveryPromise)
                    reconcileActiveOffscreenDownloads().catch(() => { });
                return;
            }
            if (offscreenState.offscreenRecoveryPromise) {
                offscreenState.offscreenCloseDeferred = true;
                return;
            }
            if (!chrome.offscreen?.closeDocument)
                return;
            if (offscreenState.offscreenClosingPromise)
                return offscreenState.offscreenClosingPromise;
            offscreenState.offscreenClosingPromise = (async () => {
                try {
                    if (chrome.runtime?.getContexts) {
                        const existing = await chrome.runtime.getContexts({
                            contextTypes: ['OFFSCREEN_DOCUMENT']
                        });
                        if (existing.length === 0)
                            return;
                    }
                    if (isManagerBusy() || offscreenState.activeOffscreenTasks > 0 || hasActiveProtectedDownloads())
                        return;
                    await chrome.offscreen.closeDocument();
                }
                catch (err) {
                    console.warn('[MediaLatch] Не удалось закрыть offscreen document:', err);
                }
                finally {
                    offscreenState.offscreenClosingPromise = null;
                }
            })();
            return offscreenState.offscreenClosingPromise;
        }
        /**
         * Truly single-release offscreen task and Blob cleanup.
         * Idempotent: duplicate calls for the same owner key or blobUrl NEVER decrement
         * another task or close another job's offscreen document.
         */
        async function releaseOffscreenTask(ownerOrBlob = null, blobToRevoke = null) {
            let targetBlob = blobToRevoke;
            let targetKey = null;
            if (ownerOrBlob) {
                if (offscreenState.activeOffscreenOwners.has(ownerOrBlob)) {
                    targetKey = ownerOrBlob;
                    targetBlob = offscreenState.activeOffscreenOwners.get(ownerOrBlob) || blobToRevoke;
                }
                else {
                    for (const [k, v] of offscreenState.activeOffscreenOwners.entries()) {
                        if (v === ownerOrBlob) {
                            targetKey = k;
                            targetBlob = ownerOrBlob;
                            break;
                        }
                    }
                    if (!targetKey && (typeof ownerOrBlob === 'string' && ownerOrBlob.startsWith('blob:'))) {
                        targetBlob = ownerOrBlob;
                    }
                }
            }
            // Idempotency & validity check: if this key was already released, or was never an active task/blob, immediate NO-OP
            // A late cleanup from the old task must not revoke a Blob transferred to a live download.
            if (!targetKey && targetBlob) {
                for (const ownedBlob of offscreenState.activeOffscreenOwners.values()) {
                    if (ownedBlob === targetBlob)
                        return;
                }
            }
            const isBlobRevoked = targetBlob && offscreenState.activeRevokedBlobs.has(targetBlob);
            const isUnacquiredKey = ownerOrBlob && !targetKey && !targetBlob;
            if (isBlobRevoked || isUnacquiredKey) {
                return;
            }
            if (targetKey) {
                offscreenState.activeOffscreenOwners.delete(targetKey);
            }
            if (targetBlob && !offscreenState.activeRevokedBlobs.has(targetBlob)) {
                offscreenState.activeRevokedBlobs.add(targetBlob);
                try {
                    await offscreenRequest({ action: 'REVOKE_BLOB_URL', blobUrl: targetBlob });
                }
                catch (_) { }
                setTimeout(() => offscreenState.activeRevokedBlobs.delete(targetBlob), 60000);
            }
            // Strictly synchronize offscreenState.activeOffscreenTasks with remaining active owners
            offscreenState.activeOffscreenTasks = offscreenState.activeOffscreenOwners.size;
            if (offscreenState.activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
                await closeOffscreenDocument().catch(() => { });
            }
        }
        /**
         * Persists download-to-Blob mapping in chrome.storage.session and acquires offscreen task.
         * Safe against early terminal events arriving before, during, or after registration.
         */
        async function trackDownloadProtectedBlob(downloadId, blobUrl, ownerKey = null) {
            if (isFileExport(downloadId)) {
                await releaseOffscreenTask(ownerKey || `protected_${downloadId}`, blobUrl);
                return;
            }
            if (!downloadId)
                return;
            const owner = ownerKey || `protected_${downloadId}`;
            const key = `active_dl_blob_${downloadId}`;
            // 1. Early terminal state arrived before registration: immediately clean up and exit
            const earlyTerminal = earlyTerminalDownloadStates.get(downloadId);
            if (earlyTerminal) {
                activeProtectedBlobsByDownloadId.delete(downloadId);
                await releaseOffscreenTask(owner, blobUrl);
                if (chrome.storage?.session) {
                    await chrome.storage.session.remove(key).catch(() => { });
                }
                if (offscreenState.activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
                    await closeOffscreenDocument().catch(() => { });
                }
                return;
            }
            activeProtectedBlobsByDownloadId.set(downloadId, blobUrl);
            acquireOffscreenTask(owner, blobUrl);
            if (chrome.storage?.session) {
                try {
                    await chrome.storage.session.set({
                        [key]: {
                            downloadId,
                            blobUrl,
                            ownerKey: owner,
                            timestamp: Date.now()
                        }
                    });
                }
                catch (_) { }
            }
            // 2. Reconciliation check: did a terminal state arrive while awaiting session storage?
            if (earlyTerminalDownloadStates.has(downloadId) || !activeProtectedBlobsByDownloadId.has(downloadId)) {
                activeProtectedBlobsByDownloadId.delete(downloadId);
                if (chrome.storage?.session) {
                    await chrome.storage.session.remove(key).catch(() => { });
                }
                await releaseOffscreenTask(owner, blobUrl);
                if (offscreenState.activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
                    await closeOffscreenDocument().catch(() => { });
                }
            }
        }
        /**
         * Removes download-to-Blob mapping from memory and chrome.storage.session, releasing offscreen task.
         * Idempotent and safe across multiple invocations.
         */
        async function untrackDownloadProtectedBlob(downloadId) {
            if (!downloadId)
                return;
            const key = `active_dl_blob_${downloadId}`;
            const hasInMemory = activeProtectedBlobsByDownloadId.has(downloadId);
            let blobUrl = activeProtectedBlobsByDownloadId.get(downloadId) || null;
            let ownerKey = hasInMemory ? `protected_${downloadId}` : null;
            activeProtectedBlobsByDownloadId.delete(downloadId);
            let hasInSession = false;
            if (chrome.storage?.session) {
                try {
                    const data = await chrome.storage.session.get(key);
                    if (data && data[key]) {
                        hasInSession = true;
                        if (!blobUrl)
                            blobUrl = data[key].blobUrl;
                        if (data[key].ownerKey)
                            ownerKey = data[key].ownerKey;
                    }
                    await chrome.storage.session.remove(key);
                }
                catch (_) { }
            }
            if (!ownerKey && offscreenState.activeOffscreenOwners.has(`protected_${downloadId}`)) {
                ownerKey = `protected_${downloadId}`;
            }
            // Only release offscreen task if this downloadId was actually tracked as a protected blob
            if (hasInMemory || hasInSession || blobUrl || ownerKey) {
                await releaseOffscreenTask(ownerKey || `protected_${downloadId}`, blobUrl);
            }
        }
        /**
         * The state of ONE owned download, asked by its own id: { known: true, item } (item null = Chrome has no such download any more) or
         * { known: false } when the answer is unavailable (no API, lastError, a failed or throwing call). Never a global query.
         */
        function lookupOwnedDownload(downloadId) {
            return new Promise((resolve) => {
                if (typeof chrome === 'undefined' || typeof chrome.downloads?.search !== 'function') {
                    resolve({ known: false });
                    return;
                }
                let settled = false;
                const done = (value) => { if (!settled) {
                    settled = true;
                    resolve(value);
                } };
                const take = (results) => {
                    if (!Array.isArray(results)) {
                        done({ known: false });
                        return;
                    }
                    done({ known: true, item: results.find((d) => d && d.id === downloadId) || null });
                };
                try {
                    const returned = chrome.downloads.search({ id: downloadId }, (results) => {
                        if (chrome.runtime?.lastError)
                            done({ known: false });
                        else
                            take(results);
                    });
                    if (returned && typeof returned.then === 'function')
                        returned.then(take, () => done({ known: false }));
                }
                catch (_) {
                    done({ known: false });
                }
            });
        }
        /**
         * Reconciles active offscreen downloads from chrome.storage.session across service worker restarts.
         * One recovery at a time (repeated calls share it). Order: every stored record is looked up by its own download id first; the records of live
         * downloads and of unknown ones (lookup unavailable: no revoke, no close, no guess) get their ownership back BEFORE any destructive cleanup;
         * only then are terminal and confirmed-absent records cleaned (Blob revoked, task released, document closed when nothing is owned).
         */
        function reconcileActiveOffscreenDownloads() {
            if (offscreenState.offscreenRecoveryPromise)
                return offscreenState.offscreenRecoveryPromise;
            const run = (async () => {
                // nothing is persisted without session storage: nothing to learn
                if (!chrome.storage?.session) {
                    offscreenState.offscreenOwnershipKnown = true;
                    return;
                }
                try {
                    const all = await chrome.storage.session.get(null);
                    const entries = [];
                    for (const [k, v] of Object.entries(all || {})) {
                        if (k.startsWith('active_dl_blob_') && v && v.downloadId) {
                            entries.push(v);
                        }
                    }
                    if (entries.length === 0) {
                        offscreenState.offscreenOwnershipKnown = true;
                        return;
                    }
                    const looked = [];
                    for (const entry of entries)
                        looked.push({ entry, found: await lookupOwnedDownload(entry.downloadId) });
                    const cleanup = [];
                    for (const { entry, found } of looked) {
                        const live = found.known && found.item && found.item.state === 'in_progress';
                        if (found.known && !live) {
                            cleanup.push(entry);
                            continue;
                        }
                        // a terminal event handled while the lookup was pending already removed the stored record: it must not be owned again
                        const key = `active_dl_blob_${entry.downloadId}`;
                        let stillStored = true;
                        try {
                            stillStored = Boolean((await chrome.storage.session.get(key))?.[key]);
                        }
                        catch (_) { }
                        if (!stillStored)
                            continue;
                        activeProtectedBlobsByDownloadId.set(entry.downloadId, entry.blobUrl);
                        acquireOffscreenTask(entry.ownerKey || `protected_${entry.downloadId}`, entry.blobUrl);
                        if (live)
                            await addTrackedDownloadId(entry.downloadId);
                    }
                    for (const entry of cleanup)
                        await untrackDownloadProtectedBlob(entry.downloadId);
                    offscreenState.offscreenOwnershipKnown = true;
                }
                catch (err) {
                    console.warn('[MediaLatch] Ошибка сверки active offscreen downloads при запуске:', err);
                }
            })();
            offscreenState.offscreenRecoveryPromise = run.finally(async () => {
                offscreenState.offscreenRecoveryPromise = null;
                // a failed recovery leaves the ownership unknown: the remembered close stays pending instead of running
                if (offscreenState.offscreenCloseDeferred && offscreenState.offscreenOwnershipKnown) {
                    offscreenState.offscreenCloseDeferred = false;
                    await closeOffscreenDocument().catch(() => { });
                }
            });
            return offscreenState.offscreenRecoveryPromise;
        }
        return { state: offscreenState, ensureOffscreenDocument, acquireOffscreenTask, transferOffscreenTask, hasActiveProtectedDownloads, closeOffscreenDocument, releaseOffscreenTask, trackDownloadProtectedBlob, untrackDownloadProtectedBlob, lookupOwnedDownload, reconcileActiveOffscreenDownloads };
    }
    root.MediaLatchOffscreen = { create };
})(globalThis);
