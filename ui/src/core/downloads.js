// @ts-check
import { createStore } from './store.js';
/** @param {{chrome: import('../../../lib/download_contracts').DownloadsChrome}} dependencies */
export function createDownloads({ chrome }) {
    const store = createStore(/** @type {import('../../../lib/download_contracts').DownloadsViewState} */ ({ jobs: [], batches: [], paused: false, status: 'loading', error: '', busy: false, pendingBatch: '', removingIds: [], dismissedIds: [] }));
    let disposed = false;
    /** @type {Promise<void> | null} */
    let current = null;
    /** @type {Promise<void> | null} */
    let next = null;
    /** @type {import('../../../lib/download_contracts').DownloadJob[]} */
    let lastJobs = [];
    /** @type {Set<string>} */
    const removed = new Set();
    /** Reads the list once more. A call during a read queues one more read (shared by all such callers) and resolves when that
     * read has finished, so a caller always awaits a result that started after its call.
     * @returns {Promise<void>} */
    function load() {
        if (disposed)
            return Promise.resolve();
        if (!current) {
            current = read().finally(() => { current = null; });
            return current;
        }
        if (!next)
            next = current.then(() => { next = null; return load(); });
        return next;
    }
    async function read() {
        try {
            const r = await chrome.runtime.sendMessage({ action: 'DOWNLOADS_LIST' });
            if (!r?.success)
                throw Error();
            lastJobs = r.jobs;
            for (const id of removed)
                if (!r.jobs.some(j => j.id === id))
                    removed.delete(id);
            if (!disposed)
                store.setState({ jobs: r.jobs.filter(j => !removed.has(j.id) && !store.getState().removingIds.includes(j.id)), paused: r.paused, batches: Array.isArray(r.batches) ? r.batches : [], status: 'ready', error: store.getState().error === 'downloads.unavailable' ? '' : store.getState().error });
        }
        catch (_) {
            if (!disposed)
                store.setState({ status: 'error', error: store.getState().error === 'downloads.commandFailed' ? 'downloads.commandFailed' : 'downloads.unavailable' });
        }
    }
    /** @param {import('../../../lib/download_contracts').DownloadNotice} m */
    const changed = m => { if (m?.action === 'DOWNLOADS_CHANGED')
        void load(); };
    chrome.runtime.onMessage?.addListener(changed);
    /** @param {import('../../../lib/download_contracts').DownloadCommand | 'clearFinished'} command
     * @param {string} [id] */
    async function command(command, id) {
        if (disposed || store.getState().busy)
            return;
        const selectedJobs = store.getState().jobs.slice();
        const ids = command === 'clearFinished' ? store.getState().jobs.filter(j => ['complete', 'failed', 'cancelled'].includes(j.state)).map(j => j.id) : [id];
        store.setState({ busy: true, error: '', ...(command === 'cancelBatch' ? { pendingBatch: String(id) } : {}), ...(command === 'clearFinished' ? { removingIds: store.getState().jobs.filter(j => ids.includes(j.id)).flatMap(j => [j.id, j.op].filter(Boolean)), jobs: store.getState().jobs.filter(j => !ids.includes(j.id)) } : {}) });
        try {
            for (const selected of ids) {
                const r = await chrome.runtime.sendMessage({ action: 'DOWNLOADS_COMMAND', command: command === 'clearFinished' ? 'remove' : command, id: selected });
                if (!r?.success)
                    throw Error();
                if (command === 'clearFinished') {
                    // clearFinished enumerates existing job IDs; other commands may omit the ID (pause).
                    const cleared = /** @type {string} */ (selected);
                    removed.add(cleared);
                    if (!disposed)
                        store.setState({ dismissedIds: [...store.getState().dismissedIds, selectedJobs.find(j => j.id === cleared)?.op || cleared] });
                }
            }
            if (command !== 'clearFinished')
                await load();
        }
        catch (_) {
            if (!disposed)
                store.setState({ error: command === 'cancelBatch' ? 'downloads.batchCancelFailed' : 'downloads.commandFailed' });
            // a refused click may already have stored the intent (a later write failed): show the committed state, so the action stays accurate and can be repeated
            if (command === 'cancelBatch')
                await load();
        }
        finally {
            if (command === 'clearFinished') {
                if (!disposed)
                    store.setState({ removingIds: [], jobs: lastJobs.filter(j => !removed.has(j.id)) });
                await load();
            }
            if (!disposed)
                store.setState({ busy: false, pendingBatch: '' });
        }
    }
    return { store, load, command, dispose() { disposed = true; chrome.runtime.onMessage?.removeListener(changed); } };
}
