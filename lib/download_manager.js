// Private, durable acquisition queue. Only completely validated local files reach the browser exporter.
// Post batches (MANAGER-BATCH-PROGRESS-01) live in the same private record: { jobs, paused, batches }. A batch is one proven "Save all"
// list of an X or Reddit post: a bounded array of slots, one per proven item, each with exactly one state:
//   pending (proven, not started) | active (operation begun or job in progress) | saved | failed | cancelled | skipped
// A slot with a job takes its state from that job, written by save() on every job change, so repeated events, retries and restarts
// cannot count it twice: only a job in 'complete' (the browser finished the file, or the chosen folder confirmed the write) is saved.
// A slot without a job is settled by the worker (preparation failure, refusal, duplicate). Batch data never authorizes a fetch.
(function (root) {
  const terminal = new Set(['complete', 'cancelled', 'failed']);
  const SLOT_STATES = new Set(['pending', 'active', 'saved', 'failed', 'cancelled', 'skipped']);
  const open = s => s === 'pending' || s === 'active';
  const MAX_SLOTS = 100, MAX_BATCHES = 20;
  const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
  const cleanBatches = list => (Array.isArray(list) ? list : []).filter(b => b && typeof b.id === 'string' && ID.test(b.id) && ['x', 'reddit'].includes(b.site) && Number.isFinite(b.createdAt) && Array.isArray(b.slots) && b.slots.length >= 1 && b.slots.length <= MAX_SLOTS)
    .map(b => ({id: b.id, site: b.site, createdAt: b.createdAt, slots: b.slots.map(s => ({s: SLOT_STATES.has(s?.s) ? s.s : 'failed', ...(typeof s?.op === 'string' && ID.test(s.op) ? {op: s.op} : {}), ...(typeof s?.job === 'string' && ID.test(s.job) ? {job: s.job} : {})}))}));
  const slotOfJob = j => j.state === 'complete' ? 'saved' : j.state === 'failed' ? 'failed' : j.state === 'cancelled' ? 'cancelled' : 'active';
  const publicBatch = b => { const n = {saved: 0, failed: 0, cancelled: 0, skipped: 0, remaining: 0}; for (const s of b.slots) n[open(s.s) ? 'remaining' : s.s]++; return {id: b.id, site: b.site, count: b.slots.length, ...n, createdAt: b.createdAt}; };
  function database(idb) {
    let opening;
    const open = () => opening || (opening = new Promise((resolve, reject) => {
      const r = idb.open('medialatch-downloads', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('jobs');
      let blocked=false;
      r.onblocked = () => {blocked=true;opening=null;reject(Error('STORAGE_BLOCKED'));};
      r.onerror = () => { opening = null; reject(r.error); };
      r.onsuccess = () => {if(blocked){r.result.close();return;}r.result.onversionchange = () => { r.result.close(); opening = null; }; resolve(r.result); };
    }));
    const run = (mode, value) => open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction('jobs', mode), s = tx.objectStore('jobs');
      const r = mode === 'readonly' ? s.get('current') : s.put(value, 'current');
      tx.oncomplete = () => resolve(r.result);
      tx.onabort = tx.onerror = () => reject(tx.error || Error('STORAGE_FAILED'));
    }));
    return { get: () => run('readonly'), set: value => run('readwrite', value) };
  }
  function createManager(d) {
    let jobs = [], batches = [], chain = Promise.resolve(), running = false, paused = false;
    const waiting = new Map(), controllers = new Map();
    const progress = new Map();
    const lock = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
    // Every operation that ever served a batch slot, for as long as this worker lives (seeded from the restored record): a notice of one of
    // them belongs to its batch's card even after a restart or a retry gave the slot a newer operation (MANAGER-BATCH-NOTICES-01).
    const memberOps = new Set();
    const remember = op => { if (!op) return; memberOps.add(op); if (memberOps.size > 2000) memberOps.delete(memberOps.values().next().value); };
    // A job decides its slot; everything is written in one record so a slot and its job can never disagree on disk.
    const syncBatches = () => { for (const j of jobs) { const s = j.batch && batches.find(b => b.id === j.batch.id)?.slots[j.batch.i]; if (s) { s.s = slotOfJob(j); s.job = j.id; if (j.op) s.op = j.op; } } };
    // d.batchChanged(summary): once per saved change of a batch's slot counts (MANAGER-BATCH-NOTICES-01), never for a write that failed.
    // The counts are the canonical slot counts; the last announced counts per batch also seed from a restored record, so a restart
    // announces only what its reconciliation changed.
    const announced = new Map();
    const countKey = p => [p.saved, p.failed, p.cancelled, p.skipped, p.remaining].join('/');
    const announce = () => {
      for (const id of [...announced.keys()]) if (!batches.some(b => b.id === id)) announced.delete(id);
      for (const b of batches) { const p = publicBatch(b), key = countKey(p); if (announced.get(b.id) === key) continue; announced.set(b.id, key); try { d.batchChanged?.(p); } catch (_) {} }
    };
    const save = async () => { syncBatches(); await d.store.set({jobs, paused, batches}); for (const b of batches) for (const s of b.slots) remember(s.op); d.changed?.(); announce(); };
    const slotAt = (id, i) => batches.find(b => b.id === id)?.slots[i];
    const edit = fn => lock(async () => { const old = JSON.stringify(batches); if (!fn()) return false; try { await save(); } catch (e) { batches = JSON.parse(old); throw e; } return true; });
    const patch = (j, p) => lock(async () => { const old = {...j}; Object.assign(j, p, {updatedAt: Date.now()}); try { await save(); } catch(e) { Object.assign(j, old); syncBatches(); throw e; } });
    const publicJob = j => ({id:j.id, op:j.op, filename:(j.actualFilename || j.filename).split(/[\\/]/).pop(), state:j.state, received:j.received, total:j.total, speed:j.speed, error:j.error, downloadId:Number.isInteger(j.downloadId)?j.downloadId:null, createdAt:j.createdAt, ready:!!j.prepared, ...(j.batch ? {batch:j.batch.id} : {})});
    const settle = (j, error) => { const w = waiting.get(j.id); if(w) { waiting.delete(j.id); error ? w.reject(error) : w.resolve(j.downloadId); } };
    const ready = (async () => {
      const stored = await d.store.get(); jobs = stored?.jobs || []; paused = stored?.paused === true; batches = cleanBatches(stored?.batches);
      for (const b of batches) { announced.set(b.id, countKey(publicBatch(b))); for (const s of b.slots) remember(s.op); }
      for (const j of jobs) {
        if (j.state==='complete' || j.state==='cancelled') {
          if(j.prepared || j.source || j.exportUrl)await d.remove(j.id);j.prepared=false;j.source='';j.exportUrl='';continue;
        }
        if (j.state==='failed')continue;
        if(j.state==='queued' && d.recoverAttempt)j.op=await d.recoverAttempt(j);
        if (j.state === 'exporting') {
          // An export intent is persisted before the API call: reconcile its exact local URL, never blindly export twice.
          const item = await d.search(j.downloadId, j.exportUrl);
          if (item) { j.downloadId = item.id; j.state = item.state === 'complete' ? 'complete' : ['interrupted','unknown'].includes(item.state) ? 'failed' : 'exporting'; j.error = item.error || ''; }
          else { j.state = 'failed'; j.error = 'EXPORT_UNCERTAIN'; }
        } else {
          if(j.prepared && !(await d.verify(j).catch(()=>false))) {j.prepared=false;j.state='failed';j.error='PREPARED_FILE_MISSING';}
          if(j.state!=='queued' && j.state!=='failed') { await d.stop?.(j.id); j.state = 'failed'; j.error = 'WORKER_RESTARTED'; }
        }
        if(!j.prepared && j.state==='failed')await d.remove(j.id);
        if(j.state === 'complete') { await d.remove(j.id); j.prepared = false; }
        if(j.downloadId) {
          if(d.recoverAttempt)j.op=await d.recoverAttempt(j);
          await d.attach?.(j,j.downloadId); if(j.state === 'complete') await d.complete?.(j,await d.search(j.downloadId,j.exportUrl));
        }
        if(j.state==='complete'){j.source='';j.exportUrl='';}
      }
      // A restart ends every unfinished preparation of the previous worker: nothing resumes a post resolution against a new page.
      syncBatches();
      for (const b of batches) for (const s of b.slots) if (open(s.s) && !jobs.some(j => j.id === s.job)) s.s = s.s === 'pending' ? 'skipped' : 'failed';
      await save(); void pump();
    })();
    async function finishExport(j, signal) {
      while(true) {
        const item = await d.search(j.downloadId, j.exportUrl);
        if (!item) throw Error('EXPORT_UNCERTAIN');
        if(item.state === 'complete') {
          await patch(j, {state:'complete', error:'', received:j.total, speed:0, actualFilename:item.filename});
          await d.complete?.(j, item);
          await d.remove(j.id); await patch(j, {prepared:false, source:'', exportUrl:''});
          return;
        }
        if(item.state === 'interrupted') throw Error(item.error || 'EXPORT_FAILED');
        if(item.state === 'unknown') throw Error('EXPORT_UNCERTAIN');
        if(signal.aborted) { await d.cancelExport(j.downloadId); throw Error('CANCELLED'); }
        await d.sleep(500);
      }
    }
    async function run(j) {
      const controller = new AbortController(); controllers.set(j.id, controller);
      let acceptedId=null;
      try {
        if(j.state==='exporting') {
          const item=await d.search(j.downloadId,j.exportUrl);if(!item)throw Error('EXPORT_UNCERTAIN');
          const op=d.recoverAttempt?await d.recoverAttempt(j):j.op;
          await patch(j,{downloadId:item.id,op});await d.attach?.(j,item.id);settle(j);
        }
        if(j.state !== 'exporting') {
          const wasPrepared = j.prepared;
          if(!j.prepared) {
            await patch(j, {state:'receiving', received:0, total:null, speed:0, error:''});
            progress.set(j.id, p => patch(j, p));
            const staged = await d.stage(j, controller.signal, p => patch(j, p));
            progress.delete(j.id);
            if(controller.signal.aborted) throw Error('CANCELLED');
            await patch(j, {prepared:true, state:'ready', received:staged.size, total:staged.size, mime:staged.mime, speed:0});
          }
          if(wasPrepared && !(await d.verify(j).catch(()=>false))) throw Error('PREPARED_FILE_MISSING');
          const url = await d.fileUrl(j.id,j.mime);
          await patch(j, {state:'exporting', exportUrl:url});
          if(controller.signal.aborted) throw Error('CANCELLED');
          try {
            acceptedId = await d.export(url, j.filename, j);
            await patch(j, {downloadId:acceptedId});
          }catch(e){
            const item=await d.search(acceptedId,j.exportUrl);
            if(!item)throw Error(acceptedId!==null?'EXPORT_UNCERTAIN':e.message);
            acceptedId=item.id;await patch(j,{downloadId:item.id});
          }
          await d.attach?.(j, acceptedId);
          if(!j.directoryId)settle(j);
        }
        await finishExport(j, controller.signal);
        settle(j);
      } catch(e) {
        let cancelled = controller.signal.aborted || e.message === 'CANCELLED';
        if(j.state==='complete'){settle(j);d.error?.(e);return;}
        if(j.state==='exporting' && (acceptedId!==null || j.downloadId!==undefined)) {
          const item=await d.search(acceptedId ?? j.downloadId,j.exportUrl);
          if(item?.state==='complete') {await patch(j,{downloadId:item.id});await d.attach?.(j,item.id);await finishExport(j,controller.signal);settle(j);return;}
          if(item?.state==='in_progress') {if(!cancelled)throw e;await d.cancelExport(item.id);}
          if(item?.state==='unknown'){e=Error('EXPORT_UNCERTAIN');cancelled=false;}
          if(!item && acceptedId!==null)throw Error('EXPORT_UNCERTAIN');
        }
        if(!cancelled && !j.prepared && e.message==='RATE_LIMIT') {
          const retries=(j.retries||0)+1;
          const retryAt=Number.isFinite(e.retryAt)?Math.max(Date.now(),e.retryAt):Date.now()+Math.min(60000,5000*2**(retries-1));
          if(retries<=3){await patch(j,{state:'queued',retries,retryAt,error:'RATE_LIMIT',speed:0});return;}
          paused=true;
        }
        await patch(j, {state:cancelled ? 'cancelled' : 'failed', error:cancelled ? 'CANCELLED' : (/^[A-Z][A-Z0-9_]{1,47}$/.test(e.message) ? e.message : 'DOWNLOAD_FAILED'), speed:0});
        if(cancelled || !j.prepared || e.message==='PREPARED_FILE_MISSING') { await d.remove(j.id).catch(()=>{}); await patch(j,{prepared:false,...cancelled?{source:'',exportUrl:''}:{}}); }
        settle(j, Error(j.error));
        await d.failed?.(j);
      } finally { controllers.delete(j.id); progress.delete(j.id); }
    }
    async function pump() {
      if(running) return;
      running = true;
      d.activity?.(true);
      const work = new Map();
      const origin = j => {try{return new URL(j.source).origin;}catch(_){return j.id;}};
      try {
        while(!paused || work.size) {
          const pending=jobs.filter(j=>!controllers.has(j.id) && (j.state==='queued' || j.state==='exporting'));
          const active=jobs.filter(j=>controllers.has(j.id));
          const j=!paused && active.length<3 ? pending.find(j=>
            !(j.retryAt>Date.now()) && active.filter(a=>origin(a)===origin(j)).length<2 &&
            !pending.some(a=>origin(a)===origin(j) && a.retryAt>Date.now())) : null;
          if(j){
            work.set(j.id,run(j).catch(e=>{settle(j,e);paused=true;void save().catch(()=>{});d.error?.(e);}).finally(()=>work.delete(j.id)));
            await d.sleep(1000);
            continue;
          }
          if(!work.size && (paused || !pending.length))break;
          await Promise.race([...work.values(),d.sleep(1000)]);
        }
      } catch(e) {
        const current=jobs.find(j=>j.state==='exporting' || j.state==='receiving' || j.state==='validating');
        if(current)settle(current,e);
        paused=true;await save().catch(()=>{});d.error?.(e);
      }
      finally { await Promise.allSettled(work.values()); running = false; d.activity?.(controllers.size>0 || jobs.some(j=>j.state==='exporting')); }
    }
    async function enqueue(options, meta = {}) {
      await ready;
      const j = {id:'job-'+d.id(), op:meta.op || null, source:options.url, selectedPage:meta.selectedPage || '', filename:options.filename, expectedMime:meta.mime || '', ...(Number.isSafeInteger(meta.maxBytes) && meta.maxBytes>0 ? {maxBytes:meta.maxBytes} : {}), directoryId:meta.directoryId || '', createdAt:Date.now(), state:'queued', received:0, total:null, speed:0, prepared:false, error:''};
      let resolve, reject; const result = new Promise((a,b) => {resolve=a;reject=b;});
      await lock(async()=> {
        // Resolve the live slot under the lock: a failed batch edit can replace the slot objects before enqueue runs.
        const slot = meta.op && batches.flatMap(b => b.slots.map((s, i) => ({b, s, i}))).find(x => x.s.op === meta.op && !x.s.job && open(x.s.s));
        if (slot) j.batch = {id:slot.b.id, i:slot.i};
        jobs.push(j); try {await save();}catch(e){jobs.pop();if(slot){delete slot.s.job;slot.s.s='active';}throw e;} waiting.set(j.id,{resolve,reject});
      });
      void pump(); return result;
    }
    async function command(action, id) {
      await ready;
      if(action === 'pause') { await lock(async()=> {const old=paused;paused=!paused;try{await save();}catch(e){paused=old;throw e;}}); if(!paused) void pump(); return; }
      const j = jobs.find(j=>j.id===id); if(!j) throw Error('JOB_NOT_FOUND');
      if(action === 'cancel') {
        const c=controllers.get(id); if(c) {c.abort();await d.abort?.(id);return;}
        if(j.state==='exporting') {
          const wasRunning=running;running=true;d.activity?.(true);
          try{const work=run(j);controllers.get(id).abort();await work;}
          finally{if(!wasRunning)running=false;d.activity?.(running || controllers.size>0 || jobs.some(j=>j.state==='exporting'));if(!paused)void pump();}
          return;
        }
        if(j.state !== 'queued') throw Error('INVALID_STATE');
        await patch(j,{state:'cancelled',error:'CANCELLED',source:'',exportUrl:''}); settle(j,Error('CANCELLED')); await d.remove(id);await d.failed?.(j);
      } else if(action === 'retry') {
        if(j.state !== 'failed') throw Error('INVALID_STATE');
        if(j.exportUrl) {
          const item=await d.search(j.downloadId,j.exportUrl);
          if(item?.state==='unknown')throw Error('EXPORT_UNCERTAIN');
          if(item && item.state!=='interrupted') {await patch(j,{state:'exporting',downloadId:item.id,error:''});void pump();return;}
          if(!item && j.error==='EXPORT_UNCERTAIN')throw Error('EXPORT_UNCERTAIN');
        }
        if(j.prepared && !(await d.verify(j).catch(()=>false))) {
          await d.remove(j.id).catch(()=>{});await patch(j,{prepared:false,error:'PREPARED_FILE_MISSING',exportUrl:''});
          await d.failed?.(j);
          throw Error('PREPARED_FILE_MISSING');
        }
        if(!j.prepared && !/^https?:/.test(j.source)) throw Error('SOURCE_EXPIRED');
        const op=await d.newAttempt?.(j);
        await patch(j,{state:'queued',error:'',downloadId:null,exportUrl:'',retryAt:0,retries:0,op:op || j.op}); void pump();
      } else if(action === 'remove') {
        if(!terminal.has(j.state)) throw Error('INVALID_STATE');
        await d.remove(id); await lock(async()=>{ const old=jobs; jobs=jobs.filter(x=>x!==j); try{await save();}catch(e){jobs=old;throw e;} });await d.forget?.(j);
      } else throw Error('INVALID_COMMAND');
    }
    // Batch API (worker only). openBatch: after the document proved the whole list. bindSlot: the operation that serves a slot.
    // settleSlot: the result of a slot that never had a job. closeBatch: nothing proven stays unstarted after the loop ended.
    async function openBatch(site, count) {
      await ready;
      if (!['x', 'reddit'].includes(site) || !Number.isSafeInteger(count) || count < 1 || count > MAX_SLOTS) throw Error('INVALID_BATCH');
      const b = {id: 'batch-' + d.id(), site, createdAt: Date.now(), slots: Array.from({length: count}, () => ({s: 'pending'}))};
      await edit(() => { batches.push(b); while (batches.length > MAX_BATCHES) { const k = batches.findIndex(x => !x.slots.some(s => open(s.s))); if (k < 0) break; batches.splice(k, 1); } return true; });
      return b.id;
    }
    const bindSlot = async ({id, i}, op) => { await ready; await edit(() => { const s = slotAt(id, i); if (!s || !open(s.s) || s.job || !ID.test(String(op))) return false; s.op = op; s.s = 'active'; return true; }); };
    const settleSlot = async ({id, i}, state) => { await ready; await edit(() => { const s = slotAt(id, i); if (!s || !open(s.s) || s.job || !['saved', 'failed', 'cancelled', 'skipped'].includes(state)) return false; s.s = state; return true; }); };
    const closeBatch = async id => { await ready; await edit(() => { let any = false; for (const s of batches.find(b => b.id === id)?.slots || []) if (s.s === 'pending') { s.s = 'skipped'; any = true; } return any; }); };
    // A notice reads committed counts after pending writes and their rollback, never tentative slot changes.
    const batchSummary = async id => { await ready; return lock(() => { const b = batches.find(x => x.id === id); return b ? {...publicBatch(b), ops: b.slots.filter(s => !open(s.s) && s.op).map(s => s.op)} : null; }); };
    const slotInfo = ({id, i}) => { const s = slotAt(id, i); return s ? {state: s.s, op: s.op, job: s.job} : null; };
    // A batch is shown while a slot is unfinished or one of its rows (a job, or the operation row of a failed preparation) still exists.
    const pruneBatches = async (rowOps = new Set()) => { await ready; await lock(async () => {
      const keep = b => b.slots.some(s => open(s.s) || (s.job && jobs.some(j => j.id === s.job)) || (s.op && rowOps.has(s.op)));
      const next = batches.filter(keep); if (next.length === batches.length) return;
      const old = batches; batches = next; try { await save(); } catch (e) { batches = old; throw e; }
    }); return batches.map(publicBatch); };
    return {ready, enqueue, command, openBatch, bindSlot, settleSlot, closeBatch, slotInfo, batchSummary, isBatchOp: op => memberOps.has(op), pruneBatches, batchOf(op) { return batches.find(b => b.slots.some(s => s.op === op))?.id; }, activityCount(){return jobs.filter(j=>!terminal.has(j.state)).length;}, output(id){
      const j=jobs.find(j=>j.downloadId===id);if(!j?.mime)return null;
      return {mime:j.mime,evidence:'verified_mime',type:j.mime.startsWith('video/')?'video':j.mime==='image/gif'?'gif':'pic',sizeBytes:j.total,sizeKind:'measured'};
    },async drain(){await ready;while(running)await d.sleep(100);}, async progress(id,p){await progress.get(id)?.(p);}, async list(){await ready;await chain;return {jobs:jobs.map(publicJob).reverse(),paused,batches:batches.map(publicBatch)};}};
  }
  root.MediaLatchDownloads = {database, createManager};
})(globalThis);
