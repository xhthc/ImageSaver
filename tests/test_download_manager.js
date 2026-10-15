// Queue and production disk-transfer regressions; native byte/export evidence is recorded separately.
const assert=require('node:assert/strict');
require('../lib/media_sources.js');require('../lib/download_manager.js');require('../lib/staging.js');require('../lib/feedback.js');require('../lib/feedback_tracker.js');require('../lib/statistics.js');
const {sniffMediaMagicBytes,isMalformedMediaContainer}=require('../offscreen.js');
const {createManager}=MediaLatchDownloads,{createStaging}=MediaLatchStaging;
const wait=()=>new Promise(r=>setTimeout(r,5));
async function until(fn){for(let i=0;i<1000;i++){if(await fn())return;await wait();}throw Error('TEST_TIMEOUT');}
const png=require('node:fs').readFileSync('icons/128.png');
function disk(fetcher,quota=1e8){
  const files=new Map(), writes=[];let fetches=0,objects=[];
  const dir={getDirectoryHandle:async()=>dir,getFileHandle:async(id,{create}={})=>{
    if(!files.has(id)){if(!create)throw Object.assign(Error('missing'),{name:'NotFoundError'});files.set(id,new Blob());}
    return {createWritable:async()=>{let chunks=[];return {write:async x=>{writes.push(x.length);chunks.push(x)},close:async()=>files.set(id,new Blob(chunks)),abort:async()=>{}};},getFile:async()=>files.get(id)};
  },removeEntry:async id=>{files.delete(id)}};
  const s=createStaging({directory:async()=>dir,estimate:async()=>({quota,usage:0}),origin:'chrome-extension://test',fetch:async(...args)=>{fetches++;return fetcher(...args)},sniff:sniffMediaMagicBytes,malformed:isMalformedMediaContainer,url:file=>{objects.push(file);return 'blob:chrome-extension://test/local'},revoke:()=>{}});
  return {s,files,writes,objects,get fetches(){return fetches}};
}
function env(stored={jobs:[],paused:false}) {
  let data=structuredClone(stored),next=1,stages=0,exports=0,removed=[],failWrite=null,autoComplete=true;
  const native=new Map();
  const d={store:{get:async()=>structuredClone(data),set:async x=>{if(failWrite?.(x))throw Error('STORAGE_FAILED');data=structuredClone(x)}},
    id:()=>String(next++),sleep:async()=>wait(),stage:async(j,signal,p)=>{stages++;assert(!signal.aborted);await p({received:png.length,total:png.length,speed:5});return {size:png.length,mime:'image/png'};},
    verify:async()=>true,fileUrl:async id=>'blob:chrome-extension://test/'+id,remove:async id=>removed.push(id),abort:async()=>{},stop:async()=>{},
    export:async(url,filename)=>{exports++;const id=100+exports;native.set(id,{id,url,filename,state:'in_progress'});if(autoComplete)setTimeout(()=>native.get(id).state='complete',20);return id;},
    search:async(id,url)=>Number.isInteger(id)?native.get(id):[...native.values()].find(x=>x.url===url),cancelExport:async id=>{native.get(id).state='interrupted'},error:()=>{}};
  return {d,native,get stages(){return stages},get exports(){return exports},get data(){return data},removed,set failWrite(fn){failWrite=fn},set autoComplete(v){autoComplete=v}};
}
(async()=>{
  // Production streaming code: known/unknown lengths, typed local file, privacy and refusal before export.
  for(const known of [true,false]) {
    const x=disk(async()=>new Response(png,{headers:known?{'content-length':String(png.length)}:{}})),events=[];
    const j={id:'job-stream',source:'https://media.test/image.png?token=exact',expectedMime:'image/png'};
    const r=await x.s.stage(j,p=>events.push(p));assert.equal(r.mime,'image/png');assert.equal(r.size,png.length);
    assert.equal(events[0].total,known?png.length:null);assert(events.some(x=>x.state==='validating'));
    await x.s.fileUrl(j.id,r.mime);assert.equal(x.objects[0].type,'image/png');assert(Buffer.from(await x.objects[0].arrayBuffer()).equals(png));
    assert.equal(x.fetches,1);assert(await x.s.verify(j.id,png.length,'image/png'));await x.s.remove(j.id);assert.equal(x.files.size,0);
  }
  for(const [body,headers,expected] of [[Buffer.alloc(0),{},'EMPTY_BODY'],[png,{'content-length':String(png.length+1)},'INCOMPLETE_BODY'],[Buffer.from('<html>error</html>'),{},'INVALID_MEDIA'],[png.subarray(0,8),{},'INVALID_MEDIA'],[Buffer.from([255,216,255,0]),{},'INVALID_MEDIA']]) {
    const x=disk(async()=>new Response(body,{headers}));await assert.rejects(x.s.stage({id:'job-bad',source:'https://media.test/x',expectedMime:'image/png'},async()=>{}),new RegExp(expected));assert.equal(x.files.size,0);
  }
  const iso=Buffer.alloc(64);iso.writeUInt32BE(128,0);iso.write('ftypisom',4);
  const malformed=disk(async()=>new Response(iso));await assert.rejects(malformed.s.stage({id:'job-iso',source:'https://media.test/video'},async()=>{}),/INVALID_MEDIA/);
  const quota=disk(async()=>new Response(png,{headers:{'content-length':String(png.length)}}),100);await assert.rejects(quota.s.stage({id:'job-quota',source:'https://media.test/x'},async()=>{}),/STORAGE_QUOTA/);
  const binary=disk(async()=>new Response(png));assert.equal((await binary.s.stage({id:'job-binary',source:'https://media.test/x',expectedMime:'application/octet-stream'},async()=>{})).mime,'image/png');
  const cancelled=disk(async()=>new Response(png));await cancelled.s.abort('job-cancel','attempt-1');await assert.rejects(cancelled.s.stage({id:'job-cancel',attempt:'attempt-1',source:'https://media.test/x'},async()=>{}),/CANCELLED/);assert.equal(cancelled.fetches,0);
  // Independent exports overlap; ready is not synonymous with saved.
  const e=env();e.autoComplete=false;const m=createManager(e.d);await m.ready;
  const a=m.enqueue({url:'https://media.test/a?signature=preserve',filename:'folder/a.png'},{mime:'image/png'});
  const b=m.enqueue({url:'https://media.test/b',filename:'b.png'});await Promise.all([a,b]);assert.equal(e.stages,2);assert.equal((await m.list()).jobs.find(x=>x.filename==='a.png').state,'exporting');
  assert.deepEqual(m.output(101),{mime:'image/png',evidence:'verified_mime',type:'pic',sizeBytes:png.length,sizeKind:'measured'});
  assert(!JSON.stringify(await m.list()).includes('signature=') && !JSON.stringify(await m.list()).includes('folder/'));
  e.native.get(101).state='complete';await b;assert.equal(e.stages,2);e.native.get(102).state='complete';await m.drain();assert((await m.list()).jobs.every(x=>x.state==='complete'));
  // A stalled origin cannot monopolize all three slots; only two jobs from one origin run.
  {
  const parallel=env({jobs:[],paused:true}),holds=new Map(),started=[];
  parallel.d.stage=async(j,signal)=>{started.push(j.source);return new Promise((resolve,reject)=>{holds.set(j.id,()=>resolve({size:png.length,mime:'image/png'}));signal.addEventListener('abort',()=>reject(Error('CANCELLED')),{once:true});});};
  const pm3=createManager(parallel.d);await pm3.ready;
  const responses=['https://a.test/one','https://a.test/two','https://a.test/three','https://b.test/one','https://c.test/one'].map((url,i)=>pm3.enqueue({url,filename:'parallel-'+i+'.png'}).catch(e=>e.message));
  await until(async()=> (await pm3.list()).jobs.length===5);await pm3.command('pause');await until(()=>started.length===3);
  assert.deepEqual(started,['https://a.test/one','https://a.test/two','https://b.test/one']);
  const activeJobs=(await pm3.list()).jobs.filter(j=>j.state==='receiving');assert.equal(activeJobs.length,3);
  await pm3.command('pause');const bjob=activeJobs.find(j=>j.filename==='parallel-3.png');holds.get(bjob.id)();await until(async()=> (await pm3.list()).jobs.find(j=>j.id===bjob.id).state==='complete');
  assert.equal(started.length,3,'Pause keeps queued transfers waiting while active transfers complete');
  await pm3.command('cancel',activeJobs.find(j=>j.filename==='parallel-0.png').id);await until(async()=> (await pm3.list()).jobs.some(j=>j.state==='cancelled'));
  assert((await pm3.list()).jobs.some(j=>j.filename==='parallel-1.png' && j.state==='receiving'),'Cancelling one active transfer keeps its peer alive');
  await pm3.command('pause');await until(()=>started.length===5);for(const finish of holds.values())finish();await Promise.all(responses);await pm3.drain();
  assert.equal((await pm3.list()).jobs.filter(j=>j.state==='complete').length,4);
  // A 429 blocks that source origin while another origin can still finish.
  const limited=env({jobs:[],paused:true});let attempts=0;
  const fastStage=limited.d.stage;limited.d.stage=async(j,...args)=>{if(j.filename==='limit.png' && !attempts++)throw Object.assign(Error('RATE_LIMIT'),{retryAt:Date.now()+150});return fastStage(j,...args);};
  const lm=createManager(limited.d);await lm.ready;
  const waits=['https://limited.test/a','https://limited.test/b','https://other.test/c'].map((url,i)=>lm.enqueue({url,filename:i===0?'limit.png':i===1?'peer.png':'other.png'}));
  await until(async()=> (await lm.list()).jobs.length===3);await lm.command('pause');await until(async()=> (await lm.list()).jobs.some(j=>j.filename==='other.png' && j.state==='complete'));
  assert.equal((await lm.list()).jobs.find(j=>j.filename==='peer.png').state,'queued');await Promise.all(waits);await lm.drain();
  }
  // Local export failure retains full bytes. Explicit retry does not receive remotely again.
  {
    const fs=env({jobs:[],paused:true}),exports=new Map();let finish;
    fs.d.export=async(url,filename,j)=>{assert.equal(j.directoryId,'directory-chosen');const id='file:'+j.id;exports.set(id,{id,url,filename,state:'in_progress',fileSize:png.length});await new Promise(r=>finish=r);exports.get(id).state='complete';return id;};
    fs.d.search=async(id,url)=>exports.get(id) || [...exports.values()].find(x=>x.url===url);
    const manager=createManager(fs.d);await manager.ready;let settled=false;
    const result=manager.enqueue({url:'https://media.test/custom',filename:'folder/custom.png'},{directoryId:'directory-chosen'}).then(id=>{settled=true;return id;});
    await until(()=>fs.data.jobs.length===1);assert.equal(fs.data.jobs[0].directoryId,'directory-chosen');await manager.command('pause');await until(()=>Boolean(finish));
    assert(!settled,'Directory export does not signal success before atomic close');finish();assert.equal(await result,'file:job-1');await manager.drain();
    assert.equal((await manager.list()).jobs[0].state,'complete');assert.equal((await manager.list()).jobs[0].downloadId,null,'Directory receipt never becomes public Chrome ID');assert(fs.removed.includes('job-1'));
    const lostReply=env();let receipt,searches=0;lostReply.d.export=async(url,filename,j)=>{receipt={id:'file:'+j.id,url,filename:'actual (1).png',state:'complete'};return receipt.id;};lostReply.d.search=async()=>{if(++searches===1)throw Error('lookup reply lost');return receipt;};
    const committed=createManager(lostReply.d);await committed.ready;assert.equal(await committed.enqueue({url:'https://media.test/lost-reply',filename:'intended.png'},{directoryId:'directory-chosen'}),'file:job-1');await committed.drain();assert(lostReply.removed.includes('job-1'));assert(!(await committed.list()).jobs[0].ready && (await committed.list()).jobs[0].filename==='actual (1).png','Committed export after lost reply cleans staging and keeps actual name');
    const lost=env({jobs:[{id:'job-lost-file',state:'exporting',directoryId:'directory-chosen',filename:'a.png',downloadId:null,exportUrl:'blob:lost',prepared:true,total:png.length,mime:'image/png'}],paused:false});
    lost.d.search=async()=>({id:'file:job-lost-file',state:'unknown',error:'EXPORT_UNCERTAIN'});
    const restarted=createManager(lost.d);await restarted.ready;assert.equal((await restarted.list()).jobs[0].error,'EXPORT_UNCERTAIN');await assert.rejects(restarted.command('retry','job-lost-file'),/EXPORT_UNCERTAIN/);assert.equal(lost.exports,0,'Uncertain file export never retries blindly');
    exports.clear();const denied=env();let allow=false;denied.d.export=async(url,filename,j)=>{if(!allow)throw Error('DIRECTORY_ACCESS_REQUIRED');exports.set('file:'+j.id,{id:'file:'+j.id,url,filename,state:'complete'});return 'file:'+j.id;};denied.d.search=fs.d.search;
    const retry=createManager(denied.d);await retry.ready;await assert.rejects(retry.enqueue({url:'https://media.test/denied',filename:'denied.png'},{directoryId:'directory-chosen'}),/DIRECTORY_ACCESS_REQUIRED/);await retry.drain();assert((await retry.list()).jobs[0].ready);allow=true;await retry.command('retry',(await retry.list()).jobs[0].id);await retry.drain();assert.equal(denied.stages,1,'Restored access exports retained bytes');
  }
  const f=env();const exportFile=f.d.export;let fail=true;f.d.export=async(...args)=>{if(fail)throw Error('EXPORT_FAILED');return exportFile(...args)};
  const fm=createManager(f.d);await fm.ready;await assert.rejects(fm.enqueue({url:'https://media.test/retry',filename:'retry.png'}),/EXPORT_FAILED/);await fm.drain();
  let j=(await fm.list()).jobs[0];assert(j.ready && j.state==='failed');fail=false;await fm.command('retry',j.id);await fm.drain();assert.equal(f.stages,1);assert.equal((await fm.list()).jobs[0].state,'complete');
  // Accepted export + failed ID journal write + subsequent native interruption stays retryable and does not stop next job.
  const g=env();g.autoComplete=false;let failed=false;g.failWrite=x=>{if(!failed && x.jobs.some(j=>j.downloadId===101)){failed=true;return true}return false};
  const ge=g.d.export;g.d.export=async(...args)=>{const id=await ge(...args);setTimeout(()=>g.native.get(id).state=id===101?'interrupted':'complete',10);return id;};
  const gm=createManager(g.d);await gm.ready;const ga=gm.enqueue({url:'https://media.test/g',filename:'g.png'}),gb=gm.enqueue({url:'https://media.test/g2',filename:'g2.png'});await ga;await gb;await gm.drain();
  assert.equal((await gm.list()).jobs.find(x=>x.filename==='g.png').state,'failed');assert((await gm.list()).jobs.find(x=>x.filename==='g.png').ready);assert.equal((await gm.list()).jobs.find(x=>x.filename==='g2.png').state,'complete');assert.equal(g.exports,2);
  // A failed prepared flag does not authorize exporting lost or changed bytes.
  const lost=env({jobs:[{id:'job-lost',filename:'lost.png',state:'failed',prepared:true,source:'https://media.test/original',mime:'image/png',total:png.length}],paused:false});lost.d.verify=async()=>false;
  const lm=createManager(lost.d);await lm.ready;await assert.rejects(lm.command('retry','job-lost'),/PREPARED_FILE_MISSING/);assert.equal(lost.exports,0);assert(!(await lm.list()).jobs[0].ready);
  await lm.command('retry','job-lost');await lm.drain();assert.equal(lost.stages,1);assert.equal(lost.exports,1);
  // Crash after terminal journal commit still cleans the owned staging file on the next start; no new export.
  const h=env({jobs:[{id:'job-old',filename:'old.png',state:'complete',prepared:true,source:'https://media.test/x',exportUrl:'blob:old'}],paused:false});const hm=createManager(h.d);await hm.ready;assert.deepEqual(h.removed,['job-old']);assert.equal(h.exports,0);assert(!(await hm.list()).jobs[0].ready);
  // Exact persisted local export identity is recovered without a second export.
  const k=env({jobs:[{id:'job-recover',filename:'r.png',state:'exporting',prepared:true,mime:'image/png',total:png.length,exportUrl:'blob:owned',createdAt:Date.now()}],paused:false});k.native.set(123,{id:123,url:'blob:owned',state:'complete'});const km=createManager(k.d);await km.ready;assert.equal(k.exports,0);assert.equal((await km.list()).jobs[0].state,'complete');
  const missing=env({jobs:[{id:'job-missing',filename:'m.png',state:'exporting',prepared:true,exportUrl:'blob:missing',createdAt:Date.now()}],paused:false});missing.d.verify=async()=>false;missing.native.set(456,{id:456,url:'blob:missing',state:'complete'});
  const mm=createManager(missing.d);await mm.ready;assert.equal((await mm.list()).jobs[0].state,'complete');assert.equal(missing.exports,0);
  const paused=env({jobs:[{id:'job-paused',filename:'p.png',state:'exporting',prepared:true,exportUrl:'blob:paused',createdAt:Date.now()}],paused:true});paused.native.set(789,{id:789,url:'blob:paused',state:'in_progress'});
  const pm=createManager(paused.d);await pm.ready;await pm.command('cancel','job-paused');assert.equal((await pm.list()).jobs[0].state,'cancelled');assert.equal(paused.native.get(789).state,'interrupted');assert.equal(paused.exports,0);
  // A queued failed/missing feedback attempt gets a new owned attempt on recovery; explicit retries count actual new attempts.
  const session={};let seq=0;const idb=require('./helpers/idb.cjs')();
  const stats=MediaLatchStatistics.createStatistics({indexedDB:idb,legacy:async()=>null,isEnabled:async()=>true});
  const t=ImageSaverFeedbackTracker.createTracker({storage:{get:async key=>session[key],set:async(key,val)=>{session[key]=structuredClone(val)}},genId:()=>`op-manager-${++seq}`,getDownloadItem:async id=>q.native.get(id),onFinished:r=>stats.record(r)});
  const old=await t.begin({sourceUrl:'https://media.test/x'});await t.fail(old,{stage:'download',code:'NETWORK_ERROR'});
  const q=env();q.d.newAttempt=j=>t.begin({sourceUrl:j.source});q.d.attach=(j,id)=>t.attachDownload(j.op,id,{filename:j.filename,output:{type:'pic',mime:j.mime,evidence:'verified_mime',sizeBytes:j.total,sizeKind:'measured'}});q.d.complete=j=>t.downloadTerminal(j.downloadId,'complete');q.d.failed=j=>t.fail(j.op,{stage:'download',code:j.error});
  let once=true;const exp=q.d.export;q.d.export=async(...args)=>{if(once){once=false;throw Error('EXPORT_FAILED')}return exp(...args)};
  const qm=createManager(q.d);await qm.ready;await assert.rejects(qm.enqueue({url:'https://media.test/x',filename:'q.png'},{op:old}),/EXPORT_FAILED/);await qm.drain();await qm.command('retry',(await qm.list()).jobs[0].id);await qm.drain();await until(async()=> (await stats.list()).stats.success===1);
  assert.equal((await stats.list()).stats.failed,1);assert.equal((await stats.list()).stats.total,2);
  // Recover an accepted export before its ID attachment, including an old terminal feedback attempt.
  for(const sameWorker of [false,true]) {
    const storage={},native=env();native.autoComplete=false;let n=0;
    const aggregate=MediaLatchStatistics.createStatistics({indexedDB:require('./helpers/idb.cjs')(),legacy:async()=>null,isEnabled:async()=>true});
    const tracker=ImageSaverFeedbackTracker.createTracker({storage:{get:async key=>storage[key],set:async(key,val)=>{storage[key]=structuredClone(val)}},genId:()=>`op-recovery-${sameWorker}-${++n}`,getDownloadItem:async id=>native.native.get(id),onFinished:r=>aggregate.record(r)});
    const oldOp=await tracker.begin({sourceUrl:'https://media.test/original'});await tracker.fail(oldOp,{stage:'download',code:'WORKER_RESTARTED'});
    const job={id:'job-window',op:oldOp,filename:'window.png',state:'exporting',prepared:true,mime:'image/png',total:png.length,exportUrl:'blob:owned-window',source:'https://media.test/original',createdAt:Date.now()};
    native.d.store.get=async()=>({jobs:[job],paused:sameWorker});
    native.native.set(321,{id:321,url:job.exportUrl,filename:'window.png',state:'in_progress'});
    native.d.recoverAttempt=async j=>{const r=await tracker.get(j.op);return r && !ImageSaverFeedback.isTerminal(r.state)?j.op:tracker.begin({sourceUrl:j.source})};
    native.d.attach=(j,id)=>tracker.attachDownload(j.op,id,{filename:j.filename,output:{type:'pic',mime:j.mime,evidence:'verified_mime',sizeBytes:j.total,sizeKind:'measured'}});
    native.d.complete=j=>tracker.downloadTerminal(j.downloadId,'complete');
    const rm=createManager(native.d);await rm.ready;
    if(sameWorker) {
      const current=await tracker.get(job.op);await tracker.fail(current.id,{stage:'download',code:'NETWORK_ERROR',force:true});assert.equal((await tracker.get(current.id)).state,'failed');
      await rm.command('pause');
    }
    await until(async()=>{const current=(await rm.list()).jobs[0];const r=await tracker.get(current.op);return r?.state==='saving' && r.downloadId===321});
    native.native.get(321).state='complete';await rm.drain();await until(async()=> (await aggregate.list()).stats.success===1);
    assert.equal(native.exports,0);assert.equal((await rm.list()).jobs[0].state,'complete');assert.equal((await aggregate.list()).stats.success,1);
  }
  // MANAGER-RECOVERY-01 regressions:
  // 1. Interrupted reception: restart leaves op failed in hydrated tracker, 1 failed in statistics; explicit retry re-stages and succeeds (total 2).
  {
    const storage={}, native=env(); let n=0;
    const stats=MediaLatchStatistics.createStatistics({indexedDB:require('./helpers/idb.cjs')(),legacy:async()=>null,isEnabled:async()=>true});
    const tracker1=ImageSaverFeedbackTracker.createTracker({storage:{get:async key=>storage[key],set:async(key,val)=>{storage[key]=structuredClone(val)}},genId:()=>'op-interrupt-' + (++n),getDownloadItem:async id=>native.native.get(id),onFinished:r=>stats.record(r)});
    await tracker1.ready();
    const initOp=await tracker1.begin({sourceUrl:'https://media.test/interrupted'});
    const job={id:'job-interrupted',op:initOp,filename:'interrupted.png',source:'https://media.test/interrupted',state:'receiving',received:100,total:png.length,prepared:false,error:'',createdAt:Date.now()};
    native.d.store.get=async()=>({jobs:[job],paused:false});

    // Worker restarts: both feedbackTracker and downloadManager hydrate from durable storage
    const tracker2=ImageSaverFeedbackTracker.createTracker({storage:{get:async key=>storage[key],set:async(key,val)=>{storage[key]=structuredClone(val)}},genId:()=>'op-interrupt-' + (++n),getDownloadItem:async id=>native.native.get(id),onFinished:r=>stats.record(r)});
    await tracker2.ready();

    native.d.newAttempt=j=>tracker2.begin({sourceUrl:j.source});
    native.d.attach=(j,id)=>tracker2.attachDownload(j.op,id,{filename:j.filename,output:{type:'pic',mime:j.mime,evidence:'verified_mime',sizeBytes:j.total,sizeKind:'measured'}});
    native.d.complete=j=>tracker2.downloadTerminal(j.downloadId,'complete');

    const im=createManager(native.d);await im.ready;
    assert.equal((await im.list()).jobs[0].state,'failed');
    assert.equal((await im.list()).jobs[0].error,'WORKER_RESTARTED');
    assert.deepEqual(native.removed,['job-interrupted']);
    await until(async()=>(await stats.list()).stats.failed===1);
    assert.equal((await stats.list()).stats.failed,1);
    assert.equal((await stats.list()).stats.total,1);
    await im.command('retry','job-interrupted');await im.drain();
    assert.equal((await im.list()).jobs[0].state,'complete');
    assert.equal(native.stages,1);assert.equal(native.exports,1);
    await until(async()=>(await stats.list()).stats.success===1);
    assert.equal((await stats.list()).stats.failed,1);
    assert.equal((await stats.list()).stats.success,1);
    assert.equal((await stats.list()).stats.total,2);
  }
  // 2. Restart after preparation before native export: retains validated bytes, retry exports without second GET.
  {
    const native=env();let stages=0;
    const job={id:'job-prep-restart',filename:'prep.png',source:'https://media.test/prep',state:'ready',received:png.length,total:png.length,mime:'image/png',prepared:true,error:'',createdAt:Date.now()};
    native.d.store.get=async()=>({jobs:[job],paused:false});
    native.d.stage=async()=>{stages++;return {size:png.length,mime:'image/png'};};
    const pm=createManager(native.d);await pm.ready;
    assert.equal((await pm.list()).jobs[0].state,'failed');
    assert.equal((await pm.list()).jobs[0].ready,true);
    await pm.command('retry','job-prep-restart');await pm.drain();
    assert.equal((await pm.list()).jobs[0].state,'complete');
    assert.equal(stages,0);
    assert.equal(native.exports,1);
  }
  // 3. Prepared bytes corrupted or truncated before export: refuses corrupt export at run-time wasPrepared check (download_manager.js:93), marks PREPARED_FILE_MISSING, retry re-fetches.
  {
    let valid=true, stages=0;
    const native=env();
    native.d.verify=async()=>valid;
    native.d.stage=async()=>{stages++;valid=true;return {size:png.length,mime:'image/png'};};
    // Start with paused manager and queued prepared job
    const job={id:'job-trunc',filename:'trunc.png',source:'https://media.test/trunc',state:'queued',received:png.length,total:png.length,mime:'image/png',prepared:true,error:'',createdAt:Date.now()};
    native.d.store.get=async()=>({jobs:[job],paused:true});
    const tm=createManager(native.d);await tm.ready;
    // Passes ready hydration because valid is true
    assert.equal((await tm.list()).jobs[0].state,'queued');
    assert.equal((await tm.list()).jobs[0].ready,true);
    // Invalidate bytes on disk AFTER ready but BEFORE run(j) executes
    valid=false;
    // Unpause queue to trigger run(j)
    await tm.command('pause');await tm.drain();
    // On base 99e20412, run(j) lacked run-time verify check and exported corrupt file (native.exports === 1).
    // On fixed download_manager.js:93, wasPrepared check catches invalid bytes, throws PREPARED_FILE_MISSING, refuses export (native.exports === 0).
    assert.equal(native.exports,0);
    assert.equal((await tm.list()).jobs[0].state,'failed');
    assert.equal((await tm.list()).jobs[0].error,'PREPARED_FILE_MISSING');
    assert.equal((await tm.list()).jobs[0].ready,false);
    await tm.command('retry','job-trunc');await tm.drain();
    assert.equal((await tm.list()).jobs[0].state,'complete');
    assert.equal(stages,1);assert.equal(native.exports,1);
  }
  // 4. Injected storage-quota failure: partial bytes cleaned, no success increment, next job proceeds.
  {
    const storage={}, native=env(); let n=0;
    const stats=MediaLatchStatistics.createStatistics({indexedDB:require('./helpers/idb.cjs')(),legacy:async()=>null,isEnabled:async()=>true});
    const tracker=ImageSaverFeedbackTracker.createTracker({storage:{get:async key=>storage[key],set:async(key,val)=>{storage[key]=structuredClone(val)}},genId:()=>'op-quota-' + (++n),getDownloadItem:async id=>native.native.get(id),onFinished:r=>stats.record(r)});
    native.d.newAttempt=j=>tracker.begin({sourceUrl:j.source});
    native.d.attach=(j,id)=>tracker.attachDownload(j.op,id,{filename:j.filename,output:{type:'pic',mime:j.mime,evidence:'verified_mime',sizeBytes:j.total,sizeKind:'measured'}});
    native.d.complete=j=>tracker.downloadTerminal(j.downloadId,'complete');
    native.d.failed=j=>tracker.fail(j.op,{stage:j.prepared?'save':'download',code:j.error});
    let failQuota=true;
    const oldStage=native.d.stage;
    native.d.stage=async(j,signal,p)=>{if(failQuota && j.filename==='quota.png')throw Error('STORAGE_QUOTA');return oldStage(j,signal,p);};
    const qm=createManager(native.d);await qm.ready;
    const opA=await tracker.begin({sourceUrl:'https://media.test/quota'});
    const opB=await tracker.begin({sourceUrl:'https://media.test/next'});
    const qa=qm.enqueue({url:'https://media.test/quota',filename:'quota.png'},{op:opA});
    const qb=qm.enqueue({url:'https://media.test/next',filename:'next.png'},{op:opB});
    await assert.rejects(qa,/STORAGE_QUOTA/);
    await qb;await qm.drain();
    assert.equal((await qm.list()).jobs.find(j=>j.filename==='quota.png').state,'failed');
    assert.equal((await qm.list()).jobs.find(j=>j.filename==='next.png').state,'complete');
    assert(native.removed.some(id=>id==='job-1' || id.startsWith('job-')));
    await until(async()=>(await stats.list()).stats.success===1);
    assert.equal((await stats.list()).stats.failed,1);
    assert.equal((await stats.list()).stats.success,1);
    assert.equal((await stats.list()).stats.total,2);
  }
  // 5. Staging error preservation: secondary removeEntry rejection does not mask primary staging error (staging.js:79).
  {
    const s = createStaging({
      directory: async () => ({
        getDirectoryHandle: async () => ({
          getFileHandle: async () => { throw Error('STORAGE_QUOTA'); },
          removeEntry: async () => { throw Error('DISK_REMOVE_REJECTED'); }
        })
      }),
      fetch: async () => ({
        ok: true, status: 200, headers: new Map([['content-length', '100']]),
        body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(10) }), cancel: async () => {} }) }
      }),
      estimate: async () => ({ quota: 1000, usage: 0 }),
      origin: 'chrome-extension://test',
      sniff: () => 'image/png',
      malformed: () => false
    });
    // On base staging.js, removeEntry rejection masked STORAGE_QUOTA with DISK_REMOVE_REJECTED.
    // On fixed staging.js:79, primary STORAGE_QUOTA is preserved.
    await assert.rejects(s.stage({ id: 'job-stage-err', source: 'https://media.test/pic.png' }), /STORAGE_QUOTA/);
  }
  // 6. Manager secondary remove rejection: does not strand enqueue promise, reports failure, unblocks queue (download_manager.js:125).
  {
    const native = env();
    native.d.stage = async () => { throw Error('STORAGE_QUOTA'); };
    native.d.remove = async () => { throw Error('DISK_REMOVE_REJECTED'); };
    let failedReported = false;
    native.d.failed = async j => { if (j.error === 'STORAGE_QUOTA') failedReported = true; };
    const dm = createManager(native.d);
    await dm.ready;
    const p = dm.enqueue({ url: 'https://media.test/quota', filename: 'quota.png' });
    const race = Promise.race([
      p.then(() => 'resolved', err => err.message),
      new Promise(r => setTimeout(() => r('TIMEOUT_STRANDED'), 1000))
    ]);
    const outcome = await race;
    // On base download_manager.js, d.remove rejection bypassed settle(), stranding enqueue promise indefinitely (TIMEOUT_STRANDED).
    // On fixed download_manager.js:125, enqueue rejects with STORAGE_QUOTA, d.failed is called, and promise settles.
    assert.equal(outcome, 'STORAGE_QUOTA');
    assert.equal(failedReported, true);
    assert.equal((await dm.list()).jobs[0].state, 'failed');
  }
  // 6b. Post batches (MANAGER-BATCH-PROGRESS-01): one slot per proven item; only a finished export is saved; every event is idempotent.
  {
    const counts=b=>({saved:b.saved,failed:b.failed,cancelled:b.cancelled,skipped:b.skipped,remaining:b.remaining});
    const only=async m=>{const l=await m.list();assert.equal(l.batches.length,1);return l.batches[0];};
    const item=async(m,ref,op,url,name)=>{await m.bindSlot(ref,op);return m.enqueue({url,filename:name},{op,mime:'image/png'});};
    // mixed outcomes: saved, failed, cancelled (still queued), refused before any job, duplicate, and an item that never started
    {
      const e=env({jobs:[],paused:true});e.d.stage=async j=>{if(j.source.endsWith('/bad'))throw Error('INVALID_MEDIA');return {size:png.length,mime:'image/png'};};
      const m=createManager(e.d);await m.ready;
      const id=await m.openBatch('x',6);const ref=i=>({id,i});
      let b=await only(m);assert.deepEqual(counts(b),{saved:0,failed:0,cancelled:0,skipped:0,remaining:6},'every proven item starts as a remaining slot, none is saved by admission');
      assert.equal(b.count,6);assert.equal(b.site,'x');
      await m.bindSlot(ref(2),'op-q');const queued=m.enqueue({url:'https://media.test/q',filename:'q.png'},{op:'op-q'}).catch(x=>x.message);
      await until(async()=>(await m.list()).jobs.length===1);
      assert.deepEqual(counts(await only(m)),{saved:0,failed:0,cancelled:0,skipped:0,remaining:6},'a queued job is not saved');
      await m.command('cancel',(await m.list()).jobs[0].id);assert.equal(await queued,'CANCELLED');
      await m.settleSlot(ref(3),'failed');await m.settleSlot(ref(4),'skipped');
      await m.command('pause');
      await item(m,ref(0),'op-a','https://media.test/a','a.png');
      await m.bindSlot(ref(1),'op-b');await assert.rejects(m.enqueue({url:'https://media.test/bad',filename:'b.png'},{op:'op-b'}),/INVALID_MEDIA/);
      await m.drain();
      b=await only(m);assert.deepEqual(counts(b),{saved:1,failed:2,cancelled:1,skipped:1,remaining:1},'saved, failed (job and refusal), cancelled and skipped are distinct; slot 5 never started');
      assert.equal(b.saved+b.failed+b.cancelled+b.skipped+b.remaining,b.count,'every proven item is counted exactly once');
      await m.closeBatch(id);assert.deepEqual(counts(await only(m)),{saved:1,failed:2,cancelled:1,skipped:2,remaining:0},'a slot that never started ends as skipped, not as saved');
      const jobs=(await m.list()).jobs;assert.deepEqual(jobs.map(j=>j.state).sort(),['cancelled','complete','failed']);assert(jobs.every(j=>j.batch===id));
    }
    // saved needs the confirmed export; received bytes and a finished transfer are not saved
    {
      const e=env({jobs:[],paused:false});e.autoComplete=false;const m=createManager(e.d);await m.ready;
      const id=await m.openBatch('reddit',2);const first=item(m,{id,i:0},'op-1','https://media.test/1','1.png');await first;
      let b=await only(m);assert.deepEqual(counts(b),{saved:0,failed:0,cancelled:0,skipped:0,remaining:2},'bytes prepared and export accepted, but the browser has not finished the file: not saved');
      assert((await m.list()).jobs[0].state==='exporting');
      e.native.get(101).state='complete';await m.drain();
      b=await only(m);assert.deepEqual(counts(b),{saved:1,failed:0,cancelled:0,skipped:0,remaining:1},'the finished export is the only thing that counts as saved');
      // repeated events and repeated writes never count a slot twice
      await m.settleSlot({id,i:0},'failed');await m.settleSlot({id,i:0},'saved');await m.bindSlot({id,i:0},'op-other');await m.command('pause');await m.command('pause');
      assert.deepEqual(counts(await only(m)),{saved:1,failed:0,cancelled:0,skipped:0,remaining:1},'settle/bind/pause repeats cannot change a slot that a job decided');
      await m.settleSlot({id,i:1},'skipped');await m.settleSlot({id,i:1},'failed');await m.settleSlot({id:'batch-missing',i:0},'failed');await m.settleSlot({id,i:9},'failed');await assert.rejects(m.openBatch('x',101),/INVALID_BATCH/);await assert.rejects(m.openBatch('pixiv',2),/INVALID_BATCH/);
      assert.deepEqual(counts(await only(m)),{saved:1,failed:0,cancelled:0,skipped:1,remaining:0},'a settled slot is final; unknown batches and slots are ignored');
    }
    // retry updates the same slot: failed -> active -> saved, never a second success
    {
      const e=env({jobs:[],paused:false});let fail=true;const stage=e.d.stage;e.d.stage=async(...a)=>{if(fail)throw Error('NETWORK_FAILED');return stage(...a);};
      e.d.newAttempt=async()=>'op-retry';
      const m=createManager(e.d);await m.ready;const id=await m.openBatch('x',2);
      await assert.rejects(item(m,{id,i:0},'op-1','https://media.test/r','r.png'),/NETWORK_FAILED/);
      let b=await only(m);assert.deepEqual(counts(b),{saved:0,failed:1,cancelled:0,skipped:0,remaining:1});
      fail=false;const job=(await m.list()).jobs[0];await m.command('retry',job.id);
      await until(async()=>(await only(m)).saved===1);await m.drain();
      b=await only(m);assert.deepEqual(counts(b),{saved:1,failed:0,cancelled:0,skipped:0,remaining:1},'the retry saved the same slot once');
      assert.equal((await m.list()).jobs.length,1,'a retry is not another job');
    }
    // two batches stay separate
    {
      const e=env({jobs:[],paused:false});e.autoComplete=false;const m=createManager(e.d);await m.ready;
      const a=await m.openBatch('x',2),b2=await m.openBatch('reddit',3);
      await item(m,{id:a,i:0},'op-a0','https://media.test/a0','a0.png');await m.settleSlot({id:b2,i:0},'failed');await m.settleSlot({id:b2,i:1},'skipped');
      const l=await m.list();const A=l.batches.find(x=>x.id===a),B=l.batches.find(x=>x.id===b2);
      assert.deepEqual([counts(A),A.site],[{saved:0,failed:0,cancelled:0,skipped:0,remaining:2},'x']);assert.deepEqual([counts(B),B.site],[{saved:0,failed:1,cancelled:0,skipped:1,remaining:1},'reddit']);
      assert.deepEqual(l.jobs.map(j=>j.batch),[a],'a job names only its own batch');
      e.native.get(101).state='complete';await m.drain();
      assert.deepEqual(counts((await m.list()).batches.find(x=>x.id===b2)),{saved:0,failed:1,cancelled:0,skipped:1,remaining:1},'the other batch is untouched');
    }
    // reopen: a new manager over the same record shows the same batch; an older record without batches loads
    {
      const e=env({jobs:[],paused:false});const m=createManager(e.d);await m.ready;
      const id=await m.openBatch('x',3);await item(m,{id,i:0},'op-1','https://media.test/1','1.png');await m.drain();await m.settleSlot({id,i:1},'failed');
      const before=await m.list();assert.deepEqual(counts(before.batches[0]),{saved:1,failed:1,cancelled:0,skipped:0,remaining:1});
      assert(!JSON.stringify(e.data).includes('media.test'),'batch data holds no source address');
      const reopened=createManager({...e.d});await reopened.ready;
      const after=await reopened.list();assert.deepEqual(after.batches,before.batches.map(b=>({...b,remaining:0,skipped:1})),'after a restart the never-started slot is skipped, the rest is unchanged');
      assert.deepEqual(after.jobs,before.jobs);
      const legacy=env({jobs:[],paused:false});const lm=createManager(legacy.d);await lm.ready;assert.deepEqual((await lm.list()).batches,[]);
      await lm.enqueue({url:'https://media.test/old',filename:'old.png'});await lm.drain();assert.deepEqual((await lm.list()).batches,[]);assert.deepEqual(legacy.data.batches,[]);
      const junk=env({jobs:[],paused:false,batches:[null,{id:'x'},{id:'batch-ok',site:'pixiv',createdAt:1,slots:[{s:'pending'}]},{id:'b'.repeat(80),site:'x',createdAt:1,slots:[{s:'pending'}]},{id:'batch-big',site:'x',createdAt:1,slots:Array.from({length:101},()=>({s:'pending'}))},{id:'batch-good',site:'x',createdAt:5,slots:[{s:'weird',op:'op ok'},{s:'saved',op:'op-9'}]}]});
      const jm=createManager(junk.d);await jm.ready;const jl=(await jm.list()).batches;assert.equal(jl.length,1);assert.equal(jl[0].id,'batch-good');assert.equal(jl[0].failed,1,'an unknown slot state is not a success');assert.equal(jl[0].saved,1);
    }
    // worker restart: unfinished preparations end as failed, never-started slots as skipped, nothing is resumed or re-fetched
    {
      const stored={jobs:[{id:'job-live',op:'op-live',source:'https://media.test/live',filename:'live.png',createdAt:1,state:'receiving',received:5,total:10,speed:1,prepared:false,error:'',batch:{id:'batch-r',i:2}}],paused:false,
        batches:[{id:'batch-r',site:'reddit',createdAt:1,slots:[{s:'saved',op:'op-0'},{s:'active',op:'op-prep'},{s:'active',op:'op-live',job:'job-live'},{s:'pending'},{s:'pending'},{s:'failed',op:'op-5'}]}]};
      const e=env(stored);const m=createManager(e.d);await m.ready;await m.drain();
      const l=await m.list();assert.deepEqual(counts(l.batches[0]),{saved:1,failed:3,cancelled:0,skipped:2,remaining:0},'the preparation, the interrupted transfer and the failed slot are failed; the unstarted two are skipped');
      assert.equal(l.jobs[0].state,'failed');assert.equal(l.jobs[0].error,'WORKER_RESTARTED');assert.equal(e.stages,0,'nothing was resumed');assert.equal(e.exports,0);
    }
    // clear/removal: no orphan summary, no resurrected row
    {
      const e=env({jobs:[],paused:false});const m=createManager(e.d);await m.ready;
      const id=await m.openBatch('x',3);await item(m,{id,i:0},'op-1','https://media.test/1','1.png');await item(m,{id,i:1},'op-2','https://media.test/2','2.png');await m.bindSlot({id,i:2},'op-never');await m.settleSlot({id,i:2},'failed');await m.drain();
      assert.equal((await m.pruneBatches(new Set())).length,1,'rows still exist');
      const jobs=(await m.list()).jobs;assert.deepEqual(jobs.map(j=>j.batch),[id,id]);
      await m.command('remove',jobs[0].id);assert.equal((await m.pruneBatches(new Set())).length,1,'one member row remains');
      assert.equal((await m.list()).jobs.length,1);await m.command('remove',jobs[1].id);
      assert.equal((await m.pruneBatches(new Set(['op-never']))).length,1,'a listed failed-preparation row keeps the summary');
      assert.deepEqual(await m.pruneBatches(new Set()),[],'no row left: the summary is deleted');
      assert.deepEqual(e.data.batches,[],'and removed from the stored record');
      assert.deepEqual((await createManager(e.d).list()).batches,[]);
      const open=await m.openBatch('reddit',2);assert.equal((await m.pruneBatches(new Set())).length,1,'a batch with an unfinished slot is never pruned');void open;
      for(let i=0;i<25;i++){const b=await m.openBatch('x',1);await m.settleSlot({id:b,i:0},'skipped');}assert((await m.list()).batches.length<=21,'finished batches are bounded');
    }
    // a failed write leaves the previous state
    {
      const e=env({jobs:[],paused:false});const m=createManager(e.d);await m.ready;const id=await m.openBatch('x',2);
      e.failWrite=()=>true;await assert.rejects(m.settleSlot({id,i:0},'failed'),/STORAGE_FAILED/);await assert.rejects(m.openBatch('x',2),/STORAGE_FAILED/);e.failWrite=null;
      const b=(await m.list()).batches;assert.equal(b.length,1);assert.deepEqual(counts(b[0]),{saved:0,failed:0,cancelled:0,skipped:0,remaining:2},'a rejected write is not reported as a result');
    }
    // A rejected job patch must restore its batch slot as well as the row, both now and on the next successful write.
    for (const [action,state,slotState] of [['retry','failed','failed'],['cancel','queued','active']]) {
      const id='batch-rollback', jobId='job-rollback';
      const e=env({paused:true,jobs:[{id:jobId,op:'op-rollback',source:'https://media.test/rollback.png',filename:'rollback.png',state,received:0,total:null,speed:0,prepared:false,error:state==='failed'?'DOWNLOAD_FAILED':'',batch:{id,i:0}}],batches:[{id,site:'x',createdAt:1,slots:[{s:slotState,op:'op-rollback',job:jobId}]}]});
      e.d.newAttempt=async()=> 'op-retry';
      const m=createManager(e.d);await m.ready;const before=await m.list();
      e.failWrite=()=>true;await assert.rejects(m.command(action,jobId),/STORAGE_FAILED/);
      const rejected=await m.list();
      assert.equal(rejected.jobs[0].state,state,'a rejected '+action+' restores the file state');
      assert.equal(rejected.jobs[0].op,'op-rollback','a rejected retry restores the operation');
      assert.deepEqual(rejected.batches,before.batches,'a rejected '+action+' restores the summary');
      e.failWrite=null;await m.openBatch('reddit',1);
      assert.equal(e.data.jobs[0].state,state);
      assert.deepEqual(e.data.batches.find(b=>b.id===id).slots,[{s:slotState,op:'op-rollback',job:jobId}],'a later write must not persist a rejected '+action);
    }
    // Two batch item workers: failed binding replaces batches, then a failed enqueue must restore the live slot, not a stale object.
    {
      const e=env({jobs:[],paused:true}),m=createManager(e.d);await m.ready;const id=await m.openBatch('x',2);
      await m.bindSlot({id,i:0},'op-zero');let rejectWrites=2;e.failWrite=()=>rejectWrites-->0;
      const rejected=await Promise.allSettled([m.bindSlot({id,i:1},'op-one'),m.enqueue({url:'https://media.test/ghost.png',filename:'ghost.png'},{op:'op-zero'})]);
      assert(rejected.every(r=>r.status==='rejected' && r.reason.message==='STORAGE_FAILED'));
      e.failWrite=null;await m.settleSlot({id,i:0},'failed');await m.settleSlot({id,i:1},'failed');await m.closeBatch(id);
      const snapshot=await m.list();assert.deepEqual(snapshot.jobs,[]);
      assert.deepEqual(counts(snapshot.batches[0]),{saved:0,failed:2,cancelled:0,skipped:0,remaining:0},'failed concurrent writes cannot leave a nonexistent active job');
      assert(e.data.batches[0].slots.every(s=>!s.job),'the durable record must contain no ghost job');
      assert.deepEqual(await m.pruneBatches(new Set()),[],'the finished batch can be removed without restarting');
      assert.deepEqual(e.data.batches,[]);
    }
  }
  // 6c. Batch change announcements (MANAGER-BATCH-NOTICES-01): one call per saved change of a batch's canonical counts, nothing else.
  {
    const key=b=>[b.saved,b.failed,b.cancelled,b.skipped,b.remaining].join('/');
    const seen=[];const e=env({jobs:[],paused:false});e.d.batchChanged=b=>seen.push(key(b));e.d.newAttempt=async()=>'op-retry-1';
    let fail=true;const stage=e.d.stage;e.d.stage=async(...a)=>{if(fail)throw Error('NETWORK_FAILED');return stage(...a);};
    const m=createManager(e.d);await m.ready;assert.deepEqual(seen,[],'a manager with no batches announces nothing');
    const id=await m.openBatch('x',4);assert.deepEqual(seen,['0/0/0/0/4'],'a new batch is announced once with every slot remaining');
    await m.bindSlot({id,i:0},'op-0');assert.deepEqual(seen,['0/0/0/0/4'],'binding an operation does not change the counts: no announcement');
    await assert.rejects(m.enqueue({url:'https://media.test/0',filename:'0.png'},{op:'op-0'}),/NETWORK_FAILED/);
    assert.deepEqual(seen.slice(1),['0/1/0/0/3'],'a failed job is announced once (queued, receiving and failed saves around it do not repeat the same counts)');
    await m.settleSlot({id,i:1},'skipped');await m.settleSlot({id,i:1},'skipped');await m.settleSlot({id,i:1},'failed');
    assert.deepEqual(seen.slice(2),['0/1/0/1/2'],'a settled slot announces once; repeated or conflicting settles announce nothing');
    await m.command('pause');await m.command('pause');assert.equal(seen.length,3,'saves that do not change the counts announce nothing');
    const sum=await m.batchSummary(id);assert.deepEqual([key(sum),sum.ops],['0/1/0/1/2',['op-0']],'batchSummary is the canonical view: counts and the operations that have a result');
    assert.equal(await m.batchSummary('batch-missing'),null);
    // the retry gives the slot a newer operation: still the batch's, and the failure becomes active, then saved
    fail=false;const job=(await m.list()).jobs[0];await m.command('retry',job.id);await m.drain();
    assert.deepEqual(seen.slice(3),['0/0/0/1/3','1/0/0/1/2'],'the retry is announced as active again and then as saved, never as a second success');
    assert(m.isBatchOp('op-0') && m.isBatchOp('op-retry-1') && !m.isBatchOp('op-unrelated') && !m.isBatchOp(undefined),'an operation that served a slot stays a batch member after the slot got a newer one');
    // a failed write is not announced
    const before=seen.length;e.failWrite=()=>true;await assert.rejects(m.settleSlot({id,i:2},'failed'),/STORAGE_FAILED/);e.failWrite=null;assert.equal(seen.length,before,'a rejected write announces nothing');
    await m.settleSlot({id,i:2},'failed');await m.closeBatch(id);assert.deepEqual(seen.slice(before),['1/1/0/1/1','1/1/0/2/0'],'close ends the never-started slot as skipped, announced once');
    // a throwing hook never breaks the queue
    const bad=env({jobs:[],paused:false});bad.d.batchChanged=()=>{throw Error('HOOK');};const bm=createManager(bad.d);await bm.ready;await bm.openBatch('x',2);await bm.enqueue({url:'https://media.test/h',filename:'h.png'});await bm.drain();assert.equal((await bm.list()).jobs[0].state,'complete','a failing hook does not touch a save');
    // a new manager over the same record: unchanged batches are not announced again; a restart announces only what its reconciliation changed
    const again=[];const r=createManager({...e.d,batchChanged:b=>again.push(key(b))});await r.ready;assert.deepEqual(again,[],'reopening finished batches announces nothing');
    const stored={jobs:[],paused:false,batches:[{id:'batch-r1',site:'x',createdAt:1,slots:[{s:'saved',op:'op-a'},{s:'active',op:'op-b'},{s:'pending'}]},{id:'batch-r2',site:'reddit',createdAt:2,slots:[{s:'saved',op:'op-c'},{s:'skipped'}]}]};
    const restart=[];const rm=createManager({...env(stored).d,batchChanged:b=>restart.push([b.id,key(b)])});await rm.ready;
    assert.deepEqual(restart,[['batch-r1','1/1/0/1/0']],'a restart announces the batch it changed (the dead preparation failed, the unstarted slot skipped), not the finished one');
    assert(rm.isBatchOp('op-a') && rm.isBatchOp('op-b') && rm.isBatchOp('op-c'),'restored slot operations are batch members before any reconciliation can replace them');
  }
  // Notice snapshots and membership must describe committed batch state even while a write is pending or rejected.
  {
    const e=env({jobs:[],paused:true}),m=createManager(e.d);await m.ready;const id=await m.openBatch('x',2);
    e.failWrite=()=>true;await assert.rejects(m.bindSlot({id,i:0},'op-uncommitted'),/STORAGE_FAILED/);e.failWrite=null;
    assert.equal(m.batchOf('op-uncommitted'),undefined);
    assert.equal(m.isBatchOp('op-uncommitted'),false,'a rejected binding cannot suppress an ordinary operation notice');
    const store=e.d.store.set;let entered,release;const writing=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    e.d.store.set=async value=>{entered();await gate;throw Error('STORAGE_FAILED');};
    const change=m.settleSlot({id,i:0},'failed').catch(e=>e.message);await writing;
    let readFinished=false;const reading=Promise.resolve(m.batchSummary(id)).then(value=>{readFinished=true;return value;});
    await wait();const readBeforeCommit=readFinished;release();assert.equal(await change,'STORAGE_FAILED');
    const summary=await reading;
    assert.equal(readBeforeCommit,false,'a notification snapshot must wait for the pending write');
    assert.equal(summary.failed,0,'a rejected result cannot enter a notification');assert.equal(summary.remaining,2);
    e.d.store.set=store;
  }
  // 7. Background adapter expectedMime fallback: executes actual background.js adapter for newAttempt AND recoverAttempt (background.js:9411-9419).
  {
    const vm = require('node:vm');
    const bgCode = require('node:fs').readFileSync('background.js', 'utf8');
    let capturedAdapter = null;
    const listeners=[], commands=[], persisted={};
    let failSessionWrite=false;
    const area={get:async()=>structuredClone(persisted),set:async value=>{if(failSessionWrite)throw Error('STORAGE_FAILED');Object.assign(persisted,structuredClone(value));},remove:async key=>{delete persisted[key];}};
    const chrome = {
      runtime: { id: 'testid', lastError: null, getURL: p => 'chrome-extension://testid/' + p, getManifest: () => ({ version: '2.0.0' }), onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn) { listeners.push(fn); } }, getContexts: async () => [], sendMessage: async () => null },
      storage: { local: area, session: area },
      declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
      contextMenus: { removeAll: cb => cb && cb(), create() {}, update: (id, p, cb) => cb && cb(), refresh() {}, onClicked: { addListener() {} }, onShown: { addListener() {} } },
      tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} }, query: async () => [], sendMessage: async () => {} },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      notifications: { create: async () => '1', clear: () => {}, onClicked: { addListener() {} } },
      downloads: { search: async () => [], download: async () => 1, cancel: async () => {}, onChanged: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      offscreen: { createDocument: async () => {}, closeDocument: async () => {} }
    };
    const sandbox = {
      chrome, URL, indexedDB: {}, crypto: { randomUUID: () => 'uuid' }, console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, fetch: async () => ({ ok: true, status: 200, headers: new Map() }), importScripts: file => { if (/^lib\/(media_sources|media_format|download_paths|candidates|site_resolvers|booru_resolvers|page_selection|x_recovery|toolbar_badge|worker\/(offscreen|providers|pipeline|animation))\.js$/.test(file)) vm.runInContext(require('node:fs').readFileSync(file,'utf8'),sandbox); },
      ImageSaverFeedback: globalThis.ImageSaverFeedback,
      ImageSaverFeedbackTracker: globalThis.ImageSaverFeedbackTracker,
      MediaLatchDownloads: {
        createManager: adapter => { capturedAdapter = adapter; return { ready: Promise.resolve(), drain: async () => {}, command:async(...args)=>commands.push(args), list: async () => ({ jobs: [], paused: false }) }; },
        database: () => ({ get: async () => ({ jobs: [], paused: false }), set: async () => {} })
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(bgCode, sandbox);
    assert(capturedAdapter && typeof capturedAdapter.newAttempt === 'function');
    assert(capturedAdapter && typeof capturedAdapter.recoverAttempt === 'function');
    // Native admission context reaches delayed staging as an origin, never a full page address.
    const admitted=[];sandbox.captureEnqueue=(options,meta)=>{admitted.push({options,meta});return 123;};
    vm.runInContext('downloadManager.enqueue=async(options,meta)=>globalThis.captureEnqueue(options,meta)',sandbox);
    await sandbox.managedDownload({url:'http://192.168.1.2/selected.png',filename:'selected.png'},null,'image/png',0,'http://192.168.1.2/gallery?private=path');
    assert.equal(admitted[0].meta.selectedPage,'http://192.168.1.2');
    await assert.rejects(sandbox.managedDownload({url:'http://127.0.0.1/private.png',filename:'private.png'},null,'',0,'https://public.example/post'),/^Error: INVALID_SOURCE$/);
    assert.equal(admitted.length,1,'public page cannot enqueue literal local-network transfer');


    // The media-plan acknowledgment belongs to this export, never another queued transfer.
    let drainCalls=0;
    vm.runInContext('downloadManager.drain=async()=>{globalThis.fixtureDrain();}',sandbox);
    sandbox.fixtureDrain=()=>{drainCalls++;};
    const actualExecute=sandbox.executeMediaPlanImpl;
    sandbox.executeMediaPlanImpl=async()=>({success:true,downloadId:123});
    assert.equal((await sandbox.executeMediaPlan({})).downloadId,123);
    assert.equal(drainCalls,0,'unrelated queue drain is not awaited');
    sandbox.executeMediaPlanImpl=actualExecute;

    const origBegin = sandbox.feedbackTracker.begin.bind(sandbox.feedbackTracker);
    let beginCalls = [];
    sandbox.feedbackTracker.begin = async opts => { beginCalls.push(opts); return origBegin(opts); };

    // 7a. newAttempt: absent staged mime with expected video preserves video classification
    const opVid = await capturedAdapter.newAttempt({ id: 'job-vid', source: 'https://media.test/vid.mp4', expectedMime: 'video/mp4', mime: '' });
    assert.equal(beginCalls.at(-1).expectedType, 'video');

    // 7b. newAttempt: absent staged mime with expected GIF preserves GIF classification
    const opGif = await capturedAdapter.newAttempt({ id: 'job-gif', source: 'https://media.test/anim.gif', expectedMime: 'image/gif', mime: '' });
    assert.equal(beginCalls.at(-1).expectedType, 'gif');

    // 7c. recoverAttempt: retains existing active non-terminal operation
    const opActive = await sandbox.feedbackTracker.begin({ sourceUrl: 'https://media.test/active.mp4', expectedType: 'video' });
    const retained = await capturedAdapter.recoverAttempt({ id: 'job-active', op: opActive, source: 'https://media.test/active.mp4', expectedMime: 'video/mp4', mime: '' });
    assert.equal(retained, opActive);

    // 7d. recoverAttempt: terminal failed operation triggers re-attempt preserving video classification
    await sandbox.feedbackTracker.fail(opActive, { stage: 'download', code: 'NET_ERROR' });
    const recVid = await capturedAdapter.recoverAttempt({ id: 'job-failed-vid', op: opActive, source: 'https://media.test/active.mp4', expectedMime: 'video/mp4', mime: '' });
    assert.notEqual(recVid, opActive);
    assert.equal(beginCalls.at(-1).expectedType, 'video');

    // 7e. recoverAttempt: missing operation triggers re-attempt preserving GIF classification
    const recGif = await capturedAdapter.recoverAttempt({ id: 'job-missing-gif', op: 'op-missing-404', source: 'https://media.test/anim2.gif', expectedMime: 'image/gif', mime: '' });
    assert.equal(beginCalls.at(-1).expectedType, 'gif');

    // Feedback-only removal invokes the real authenticated worker handler and persisted tracker.
    const handler=listeners.find(fn=>fn.toString().includes("m?.action!=='DOWNLOADS_LIST'"));
    const sender={id:'testid',url:chrome.runtime.getURL('popup/popup.html')};
    for(const action of ['DOWNLOADS_LOCATION','DIRECTORY_NATIVE_LINK'])assert.equal(handler({action,id:'saved',directoryId:'directory-test'},sender,()=>{throw Error('Removed action must not run');}),false,'Retired location/link messages are no longer admitted');
    const command=(id,from=sender)=>new Promise(resolve=>handler({action:'DOWNLOADS_COMMAND',command:'remove',id},from,resolve));
    const failed=await sandbox.feedbackTracker.begin({sourceUrl:'https://media.test/failure.png'});
    await sandbox.feedbackTracker.fail(failed,{code:'NO_MEDIA'});await sandbox.feedbackTracker.flush();
    assert((await sandbox.downloadManagerSnapshot()).jobs.some(j=>j.id===failed && j.managed===false));
    const before=structuredClone(persisted);
    assert.equal((await command(failed,{id:'testid',url:'https://media.test/'})).error,'FORBIDDEN');
    assert.deepEqual(persisted,before,'untrusted sender does not mutate storage');
    assert.equal((await command(recVid)).error,'INVALID_STATE','active feedback cannot be dismissed');
    assert.equal((await command('missing-record')).error,'INVALID_STATE');
    failSessionWrite=true;
    assert.equal((await command(failed)).success,false,'failed removal remains visible');
    assert(await sandbox.feedbackTracker.get(failed));
    failSessionWrite=false;
    const result=await command(failed);
    assert.equal(result.success,true);assert(!result.jobs.some(j=>j.id===failed));
    assert.equal(await sandbox.feedbackTracker.get(failed),null);
    assert(!persisted[ImageSaverFeedbackTracker.STORAGE_KEY].ops.some(r=>r.id===failed),'removal persisted');
    assert.deepEqual(commands,[],'feedback dismissal never invokes managed transport');

    let closed=0;
    chrome.runtime.getContexts=async()=>[{contextType:'OFFSCREEN_DOCUMENT'}];
    chrome.offscreen.closeDocument=async()=>{closed++;};
    vm.runInContext('offscreenState.offscreenOwnershipKnown=true',sandbox);
    capturedAdapter.activity(true);
    await sandbox.closeOffscreenDocument();assert.equal(closed,0,'busy manager owns the document');
    capturedAdapter.activity(false);await wait();assert.equal(closed,1,'manager idle closes unused document');
    const owner=sandbox.acquireOffscreenTask('fixture-conversion');
    capturedAdapter.activity(false);await wait();assert.equal(closed,1,'active conversion survives idle callback');
    await sandbox.releaseOffscreenTask(owner);assert.equal(closed,2,'last conversion release closes document');
    vm.runInContext("activeProtectedBlobsByDownloadId.set(123,'blob:fixture')",sandbox);
    capturedAdapter.activity(false);await wait();assert.equal(closed,2,'protected download survives idle callback');
    vm.runInContext('activeProtectedBlobsByDownloadId.clear()',sandbox);
    let finishLookup;
    chrome.runtime.getContexts=()=>new Promise(resolve=>{finishLookup=resolve;});
    capturedAdapter.activity(false);await until(()=>Boolean(finishLookup));
    capturedAdapter.activity(true);finishLookup([{}]);await wait();
    assert.equal(closed,2,'new manager work during context lookup prevents closure');
    chrome.runtime.getContexts=async()=>[{}];
    for(const action of ['STAGING_VERIFY','STAGING_REMOVE']) {
      let finishRequest;
      sandbox.offscreenRequest=message=>{assert.equal(message.action,action);return new Promise(resolve=>{finishRequest=resolve;});};
      const work=action==='STAGING_VERIFY'?capturedAdapter.verify({id:'fixture-prepared',total:png.length,mime:'image/png'}):capturedAdapter.remove('fixture-prepared');
      await until(()=>Boolean(finishRequest));
      const beforeClose=closed;
      capturedAdapter.activity(false);await wait();
      assert.equal(closed,beforeClose,'pending '+action+' owns offscreen across pump idle');
      finishRequest({success:true,valid:true});
      const result=await work;
      if(action==='STAGING_VERIFY')assert.equal(result,true);
      assert.equal(closed,beforeClose+1,'completed '+action+' releases its last owner');
      assert.equal(vm.runInContext('offscreenState.activeOffscreenTasks',sandbox),0);
    }
  }
  console.log('PASS: production stream validation, byte identity, queue/export boundary, local retry, cancellation, journal failure, recovery and statistics');
})().catch(e=>{console.error(e);process.exitCode=1;});
