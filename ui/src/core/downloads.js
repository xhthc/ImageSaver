// @ts-check
import { createStore } from './store.js';
import '../../../lib/sites.js';
const SITES = /** @type {readonly {id:string,domains?:readonly string[]}[]} */ (Reflect.get(globalThis,'MediaLatchSites').SITES);
/** @param {{chrome: import('../../../lib/download_contracts').DownloadsChrome}} dependencies */
export function createDownloads({ chrome }) {
    const store = createStore(/** @type {import('../../../lib/download_contracts').DownloadsViewState} */ ({ jobs: [], batches: [], paused: false, status: 'loading', error: '', errorJob: '', busy: false, pendingBatch: '', removingIds: [], dismissedIds: [] }));
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
        store.setState({ busy: true, error: '', errorJob: '', ...(command === 'cancelBatch' ? { pendingBatch: String(id) } : {}), ...(command === 'clearFinished' ? { removingIds: store.getState().jobs.filter(j => ids.includes(j.id)).flatMap(j => [j.id, j.op].filter(Boolean)), jobs: store.getState().jobs.filter(j => !ids.includes(j.id)) } : {}) });
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
                store.setState(command === 'showInFolder' ? { error: 'downloads.revealFailed', errorJob: String(id) } : { error: command === 'cancelBatch' ? 'downloads.batchCancelFailed' : 'downloads.commandFailed' });
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

/** The row actions a job has, in display order; the popup and the full manager render the same list.
 * Show in folder exists only for a finished browser download this manager tracks by its numeric DownloadItem id (a chosen-folder export has a
 * receipt instead, a preparation has no file): a dead icon is never shown.
 * @param {import('../../../lib/download_contracts').DownloadJob & {managed?: boolean, ready?: boolean}} job
 * @returns {('showInFolder'|'cancel'|'retry')[]} */
export function jobActions(job) {
    const managed = job.managed !== false;
    /** @type {('showInFolder'|'cancel'|'retry')[]} */
    const out = [];
    if (managed && job.state === 'complete' && Number.isSafeInteger(job.downloadId) && Number(job.downloadId) >= 0) out.push('showInFolder');
    if (managed && !['complete', 'failed', 'cancelled'].includes(job.state)) out.push('cancel');
    if (managed && job.state === 'failed' && job.error !== 'EXPORT_UNCERTAIN') out.push('retry');
    return out;
}
/** Existing service IDs and domain aliases share one Downloads group. No media URL or filename is used.
 * @param {unknown} value */
export function downloadSite(value) {
    const raw = typeof value === 'string' ? value.toLowerCase().replace(/^www\./, '') : '';
    if (!raw || raw === 'unknown-site' || !/^[a-z0-9.-]{1,100}$/.test(raw)) return 'unknown-site';
    const site = raw === 'pawchive.pw' ? 'pawchive' : raw;
    return SITES.find(s => s.id === site || s.domains?.some(domain => site === domain || site.endsWith('.' + domain)))?.id || site;
}
/** @typedef {import('../../../lib/download_contracts').DownloadJob} Job */
/** @typedef {import('../../../lib/download_contracts').DownloadBatch} Batch */
/** @typedef {{id:string,createdAt:number,site:string,batch?:Batch,jobs:Job[],remaining:number}} Entry */
/** @typedef {{site:string,createdAt:number,entries:Entry[],jobs:Job[],remaining:number,failed:number}} SiteGroup */
/** One group per owning site, promoted only by a new download request (not progress or a late batch member).
 * @param {Job[]} jobs @param {Batch[]} batches @returns {SiteGroup[]} */
export function groupDownloads(jobs, batches) {
    const terminal = new Set(['complete', 'failed', 'cancelled']);
    const shown = new Map(batches.filter(b => b.remaining > 0 || jobs.some(j => j.batch === b.id)).map(b => [b.id, b]));
    const ordinal = (/** @type {Job} */ j) => typeof j.batchIndex === 'number' && Number.isSafeInteger(j.batchIndex) && j.batchIndex >= 0 ? j.batchIndex : Number.MAX_SAFE_INTEGER;
    /** @type {Entry[]} */
    const entries = [...shown.values()].map(batch => ({id:'batch-' + batch.id,createdAt:batch.createdAt,site:downloadSite(batch.site),batch,
        jobs:jobs.filter(j => j.batch === batch.id).sort((a,b) => ordinal(a)-ordinal(b) || (a.createdAt || 0)-(b.createdAt || 0) || a.id.localeCompare(b.id)),remaining:batch.remaining}));
    for (const job of jobs) if (!job.batch || !shown.has(job.batch)) entries.push({id:'job-' + job.id,createdAt:job.createdAt || 0,site:downloadSite(job.site),jobs:[job],remaining:terminal.has(job.state)?0:1});
    /** @type {Map<string,SiteGroup>} */
    const groups = new Map();
    for (const entry of entries) {
        let group = groups.get(entry.site);
        if (!group) { group = {site:entry.site,createdAt:entry.createdAt,entries:[],jobs:[],remaining:0,failed:0}; groups.set(entry.site,group); }
        group.createdAt = Math.max(group.createdAt,entry.createdAt);
        group.entries.push(entry);group.jobs.push(...entry.jobs);group.remaining += entry.remaining;
        group.failed += entry.batch ? entry.batch.failed : entry.jobs.filter(j => j.state === 'failed').length;
    }
    for (const group of groups.values()) group.entries.sort((a,b) => b.createdAt-a.createdAt);
    return [...groups.values()].sort((a,b) => b.createdAt-a.createdAt || a.site.localeCompare(b.site));
}
