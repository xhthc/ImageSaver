// Private, durable acquisition queue. Only completely validated local files reach the browser exporter.
// Post batches (MANAGER-BATCH-PROGRESS-01/02) live in the same private record: { jobs, paused, batches }. A batch is one proven "Save all"
// list of an X or Reddit post, or the proven multi-file list of a Pixiv artwork or a Pawchive post: a bounded array of slots, one per
// proven downloadable item, each with exactly one state:
//   pending (proven, not started) | active (operation begun or job in progress) | saved | failed | cancelled | skipped
// A slot with a job takes its state from that job, written by save() on every job change, so repeated events, retries and restarts
// cannot count it twice: only a job in 'complete' (the browser finished the file, or the chosen folder confirmed the write) is saved.
// A slot without a job is settled by the worker (preparation failure, refusal, duplicate). Batch data never authorizes a fetch.
// MANAGER-BATCH-CANCEL-01: "Cancel remaining" persists `cancel` (a timestamp) on the batch BEFORE anything is stopped. From then on its unstarted slots are
// cancelled, no operation can bind to it and a late enqueue of an operation that was already preparing is refused (the operation ends cancelled, no
// job, no export); its own queued/receiving/exporting jobs are cancelled through the per-job path, where a confirmed completed export still wins.
(function (root) {
  const terminal = new Set(['complete', 'cancelled', 'failed']);
  const SLOT_STATES = new Set(['pending', 'active', 'saved', 'failed', 'cancelled', 'skipped']);
  const open = s => s === 'pending' || s === 'active';
  const MAX_SLOTS = 100, MAX_BATCHES = 20;
  // The finite set of services a batch can belong to (also the type DownloadBatch.site and the labels downloads.batch.site.*).
  const BATCH_SITES = ['x', 'reddit', 'pixiv', 'pawchive'];
  const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
  const cleanBatches = list => (Array.isArray(list) ? list : []).filter(b => b && typeof b.id === 'string' && ID.test(b.id) && BATCH_SITES.includes(b.site) && Number.isFinite(b.createdAt) && Array.isArray(b.slots) && b.slots.length >= 1 && b.slots.length <= MAX_SLOTS)
    .map(b => ({id: b.id, site: b.site, createdAt: b.createdAt, ...(b.partial === true ? {partial: true} : {}), ...(Number.isFinite(b.cancel) && b.cancel > 0 ? {cancel: b.cancel} : {}), slots: b.slots.map(s => ({s: SLOT_STATES.has(s?.s) ? s.s : 'failed', ...(typeof s?.op === 'string' && ID.test(s.op) ? {op: s.op} : {}), ...(typeof s?.job === 'string' && ID.test(s.job) ? {job: s.job} : {})}))}));
  const slotOfJob = j => j.state === 'complete' ? 'saved' : j.state === 'failed' ? 'failed' : j.state === 'cancelled' ? 'cancelled' : 'active';
  const publicBatch = b => { const n = {saved: 0, failed: 0, cancelled: 0, skipped: 0, remaining: 0}; for (const s of b.slots) n[open(s.s) ? 'remaining' : s.s]++; return {id: b.id, site: b.site, count: b.slots.length, ...n, ...(b.partial ? {partial: true} : {}), ...(b.cancel ? {cancelRequested: true} : {}), createdAt: b.createdAt}; };
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
    // Operations that tried to bind to a batch whose cancellation was already accepted: their late enqueue is refused as well (this worker only; a restart ends every preparation).
    const fenced = new Set();
    const fence = op => { fenced.add(op); if (fenced.size > 500) fenced.delete(fenced.values().next().value); };
    // A queued job that the accepted cancellation of its batch covers, unless the user retried it after that (an explicit new intent).
    const covered = j => { const b = j.batch && batches.find(x => x.id === j.batch.id); return Boolean(b && b.cancel && !(j.retriedAt >= b.cancel)); };
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
    // `keep` is the one step that survives a refused write (bindSlot): it is re-applied in the same lock turn as the rollback, before anything queued behind this write can run.
    const edit = (fn, keep) => lock(async () => { const old = JSON.stringify(batches); if (!fn()) return false; try { await save(); } catch (e) { batches = JSON.parse(old); keep?.(); throw e; } return true; });
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
        if (j.state==='queued' && covered(j)) {
          // an accepted cancellation is honoured at startup: nothing of a cancelled batch is revived
          j.state='cancelled';j.error='CANCELLED';j.prepared=false;j.source='';j.exportUrl='';
          await d.remove(j.id).catch(()=>{});try{await d.failed?.(j);}catch(_){}continue;
        }
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
      for (const b of batches) for (const s of b.slots) if (open(s.s) && !jobs.some(j => j.id === s.job)) s.s = s.s === 'pending' ? (b.cancel ? 'cancelled' : 'skipped') : 'failed';
      await save(); void pump();
      // exports that the previous worker had accepted before the cancellation are reconciled above; a still-open one of a cancelled batch is cancelled by the per-job path
      for (const j of jobs) if (!terminal.has(j.state) && covered(j)) await cancelJob(j).catch(() => {});
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
      let stopped=false;
      try {
        while(true) {
          // One lock turn decides: it sees committed state only (a pending write, e.g. a cancellation intent, and its possible rollback finish first, so a rejected write never
          // hides eligible work, and a queued job that an accepted cancellation covers is never claimed). Stopping clears 'running' in the same turn, so work enqueued right
          // after it starts a new pump instead of finding this one about to exit.
          const step=await lock(()=>{
            const pending=jobs.filter(j=>!controllers.has(j.id) && ((j.state==='queued' && !covered(j)) || j.state==='exporting'));
            const active=jobs.filter(j=>controllers.has(j.id));
            const j=!paused && active.length<3 ? pending.find(j=>
              !(j.retryAt>Date.now()) && active.filter(a=>origin(a)===origin(j)).length<2 &&
              !pending.some(a=>origin(a)===origin(j) && a.retryAt>Date.now())) : null;
            if(j){
              work.set(j.id,run(j).catch(e=>{settle(j,e);paused=true;void save().catch(()=>{});d.error?.(e);}).finally(()=>work.delete(j.id)));
              return 'start';
            }
            if(!work.size && (paused || !pending.length)){stopped=true;running=false;d.activity?.(controllers.size>0 || jobs.some(j=>j.state==='exporting'));return 'stop';}
            return 'wait';
          });
          if(step==='stop')break;
          await (step==='start' ? d.sleep(1000) : Promise.race([...work.values(),d.sleep(1000)]));
        }
      } catch(e) {
        const current=jobs.find(j=>j.state==='exporting' || j.state==='receiving' || j.state==='validating');
        if(current)settle(current,e);
        paused=true;await save().catch(()=>{});d.error?.(e);
      }
      finally { await Promise.allSettled(work.values()); if(!stopped){running = false; d.activity?.(controllers.size>0 || jobs.some(j=>j.state==='exporting'));} }
    }
    async function enqueue(options, meta = {}) {
      await ready;
      const j = {id:'job-'+d.id(), op:meta.op || null, site:/^[a-z0-9.-]{1,50}$/.test(meta.site || '') ? meta.site : '', source:options.url, selectedPage:meta.selectedPage || '', filename:options.filename, expectedMime:meta.mime || '', ...(Number.isSafeInteger(meta.maxBytes) && meta.maxBytes>0 ? {maxBytes:meta.maxBytes} : {}), directoryId:meta.directoryId || '', createdAt:Date.now(), state:'queued', received:0, total:null, speed:0, prepared:false, error:''};
      let resolve, reject; const result = new Promise((a,b) => {resolve=a;reject=b;});
      await lock(async()=> {
        // Resolve the live slot under the lock: a failed batch edit can replace the slot objects before enqueue runs.
        const slot = meta.op && batches.flatMap(b => b.slots.map((s, i) => ({b, s, i}))).find(x => x.s.op === meta.op && !x.s.job && open(x.s.s));
        // a preparation that finished after "Cancel remaining" was accepted never becomes a job: its operation ends cancelled
        if (meta.op && (fenced.has(meta.op) || (slot && slot.b.cancel))) { try { await d.failed?.({op:meta.op,state:'cancelled'}); } catch (_) {} throw Error('CANCELLED'); }
        if (slot) j.batch = {id:slot.b.id, i:slot.i};
        jobs.push(j); try {await save();}catch(e){jobs.pop();if(slot){delete slot.s.job;slot.s.s='active';}throw e;} waiting.set(j.id,{resolve,reject});
      });
      void pump(); return result;
    }
    // The per-job cancellation, shared by the row action and by "Cancel remaining": a running transfer is aborted cooperatively, a queued job is cancelled at
    // once, an export is reconciled (a file the browser already finished stays saved; an uncertain one is reported as such).
    async function cancelJob(j) {
      const id = j.id;
      const c=controllers.get(id); if(c) {c.abort();await d.abort?.(id);return;}
      if(j.state==='exporting') {
        const wasRunning=running;running=true;d.activity?.(true);
        try{const work=run(j);controllers.get(id).abort();await work;}
        finally{if(!wasRunning)running=false;d.activity?.(running || controllers.size>0 || jobs.some(j=>j.state==='exporting'));if(!paused)void pump();}
        return;
      }
      if(j.state !== 'queued') throw Error('INVALID_STATE');
      await patch(j,{state:'cancelled',error:'CANCELLED',source:'',exportUrl:''}); settle(j,Error('CANCELLED')); await d.remove(id);await d.failed?.(j);
    }
    async function cancelBatch(id) {
      if (typeof id !== 'string' || !ID.test(id)) throw Error('BATCH_NOT_FOUND');
      let stamp = 0;
      // the intent is persisted (and the unstarted slots settled) in one write before any job is touched; a refused write leaves everything as it was.
      // A batch with nothing left to cancel (it finished while the click was on its way) is not an error: its committed counts already say what happened.
      const applied = await edit(() => {
        const b = batches.find(x => x.id === id);
        if (!b) throw Error('BATCH_NOT_FOUND');
        if (!b.slots.some(s => open(s.s))) return false;
        // every accepted click renews the intent: it covers whatever is unfinished now, including a file the user retried after an earlier click
        b.cancel = Math.max(Date.now(), (b.cancel || 0) + 1);
        stamp = b.cancel;
        for (const s of b.slots) if (s.s === 'pending') s.s = 'cancelled';
        return true;
      });
      if (!applied) return;
      let failure = null;
      const targets = jobs.filter(x => x.batch?.id === id && !terminal.has(x.state) && !(x.retriedAt >= stamp));
      // all running work is signalled at once (a slow reply of one cleanup must not delay the others), queued jobs are cancelled next, the cleanups of running work last
      for (const j of targets) controllers.get(j.id)?.abort();
      for (const j of [...targets.filter(x => x.state === 'queued' && !controllers.has(x.id)), ...targets.filter(x => !(x.state === 'queued' && !controllers.has(x.id)))]) {
        try { await cancelJob(j); } catch (e) { if (e.message !== 'INVALID_STATE') failure = failure || e; }
      }
      if (failure) throw failure;
    }
    async function command(action, id) {
      await ready;
      if(action === 'cancelBatch') return cancelBatch(id);
      if(action === 'pause') { await lock(async()=> {const old=paused;paused=!paused;try{await save();}catch(e){paused=old;throw e;}}); if(!paused) void pump(); return; }
      const j = jobs.find(j=>j.id===id); if(!j) throw Error('JOB_NOT_FOUND');
      if(action === 'cancel') {
        await cancelJob(j);
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
        await patch(j,{state:'queued',error:'',downloadId:null,exportUrl:'',retryAt:0,retries:0,retriedAt:Date.now(),op:op || j.op}); void pump();
      } else if(action === 'remove') {
        if(!terminal.has(j.state)) throw Error('INVALID_STATE');
        await d.remove(id); await lock(async()=>{ const old=jobs; jobs=jobs.filter(x=>x!==j); try{await save();}catch(e){jobs=old;throw e;} });await d.forget?.(j);
      } else throw Error('INVALID_COMMAND');
    }
    // Batch API (worker only). openBatch: after the document proved the whole list; `partial` (Pawchive) only says that the post declares
    // originals the site has not imported: the count stays the proven downloadable items, never a guessed number of missing files.
    // bindSlot: the operation that serves a slot.
    // settleSlot: the result of a slot that never had a job. closeBatch: nothing proven stays unstarted after the loop ended.
    async function openBatch(site, count, partial = false) {
      await ready;
      if (!BATCH_SITES.includes(site) || !Number.isSafeInteger(count) || count < 1 || count > MAX_SLOTS) throw Error('INVALID_BATCH');
      const b = {id: 'batch-' + d.id(), site, createdAt: Date.now(), ...(partial === true ? {partial: true} : {}), slots: Array.from({length: count}, () => ({s: 'pending'}))};
      await edit(() => { batches.push(b); while (batches.length > MAX_BATCHES) { const k = batches.findIndex(x => !x.slots.some(s => open(s.s))); if (k < 0) break; batches.splice(k, 1); } return true; });
      return b.id;
    }
    const bindStep = ({id, i}, op) => () => { if (batches.find(b => b.id === id)?.cancel) { if (ID.test(String(op))) fence(op); return false; } const s = slotAt(id, i); if (!s || !open(s.s) || s.job || !ID.test(String(op))) return false; s.op = op; s.s = 'active'; return true; };
    // A running preparation never loses its batch because the write of its binding was refused: the binding stays in memory (a later save stores it) and the caller still sees the
    // error. The preparation stays in the batch through pruning, its late enqueue is refused or joins its slot, and a failure before the queue settles that slot instead of
    // becoming an unrelated save. keepSlot is the same step for a caller whose bindSlot call failed for any other reason.
    const keepStep = (ref, op) => () => { if (bindStep(ref, op)()) remember(op); };
    const bindSlot = async (ref, op) => { await ready; await edit(bindStep(ref, op), keepStep(ref, op)); };
    const keepSlot = async (ref, op) => { await ready; await lock(keepStep(ref, op)); };
    const settleSlot = async ({id, i}, state) => { await ready; await edit(() => { const s = slotAt(id, i); if (!s || !open(s.s) || s.job || !['saved', 'failed', 'cancelled', 'skipped'].includes(state)) return false; s.s = state; return true; }); };
    const closeBatch = async id => { await ready; await edit(() => { let any = false; const b = batches.find(x => x.id === id); for (const s of b?.slots || []) if (s.s === 'pending') { s.s = b.cancel ? 'cancelled' : 'skipped'; any = true; } return any; }); };
    // Committed read for the producers: has "Cancel remaining" been accepted for this batch? (After pending writes and their rollback.)
    const stopped = async ref => { await ready; return lock(() => Boolean(batches.find(b => b.id === ref?.id)?.cancel)); };
    // A notice reads committed counts after pending writes and their rollback, never tentative slot changes.
    const batchSummary = async id => { await ready; return lock(() => { const b = batches.find(x => x.id === id); return b ? {...publicBatch(b), ops: b.slots.filter(s => !open(s.s) && s.op).map(s => s.op)} : null; }); };
    const slotInfo = ({id, i}) => { const s = slotAt(id, i); return s ? {state: s.s, op: s.op, job: s.job} : null; };
    // A batch is shown while a slot is unfinished or one of its rows (a job, or the operation row of a failed preparation) still exists.
    // `cancelRequested` is the historical intent; `cancelling` says that work it covers is still unfinished (a preparation, or a job the user did not retry since).
    const cancelling = b => Boolean(b.cancel) && b.slots.some(s => open(s.s) && (!s.job || (() => { const j = jobs.find(x => x.id === s.job); return Boolean(j) && !terminal.has(j.state) && covered(j); })()));
    const view = b => (cancelling(b) ? {...publicBatch(b), cancelling: true} : publicBatch(b));
    const pruneBatches = async (rowOps = new Set()) => { await ready; await lock(async () => {
      const keep = b => b.slots.some(s => open(s.s) || (s.job && jobs.some(j => j.id === s.job)) || (s.op && rowOps.has(s.op)));
      const next = batches.filter(keep); if (next.length === batches.length) return;
      const old = batches; batches = next; try { await save(); } catch (e) { batches = old; throw e; }
    }); return batches.map(view); };
    return {ready, enqueue, command, openBatch, bindSlot, keepSlot, settleSlot, closeBatch, stopped, slotInfo, batchSummary, isBatchOp: op => memberOps.has(op), pruneBatches, batchOf(op) { return batches.find(b => b.slots.some(s => s.op === op))?.id; }, activityCount(){return jobs.filter(j=>!terminal.has(j.state)).length;}, output(id){
      const j=jobs.find(j=>j.downloadId===id);if(!j?.mime)return null;
      return {mime:j.mime,evidence:'verified_mime',type:j.mime.startsWith('video/')?'video':j.mime==='image/gif'?'gif':'pic',sizeBytes:j.total,sizeKind:'measured'};
    },async drain(){await ready;while(running)await d.sleep(100);}, async progress(id,p){await progress.get(id)?.(p);}, async list(){await ready;await chain;return {jobs:jobs.map(publicJob).reverse(),paused,batches:batches.map(view)};}};
  }
  root.MediaLatchDownloads = {database, createManager};
})(globalThis);
