// Queue and production disk-transfer regressions; native byte/export evidence is recorded separately.
const assert=require('node:assert/strict');
require('./lib/download_manager.js');require('./lib/staging.js');require('./lib/feedback.js');require('./lib/feedback_tracker.js');require('./lib/statistics.js');
const {sniffMediaMagicBytes,isMalformedMediaContainer}=require('./offscreen.js');
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
  // One acquisition/export at a time; ready is not synonymous with saved.
  const e=env();e.autoComplete=false;const m=createManager(e.d);await m.ready;
  const a=m.enqueue({url:'https://media.test/a?signature=preserve',filename:'folder/a.png'},{mime:'image/png'});
  const b=m.enqueue({url:'https://media.test/b',filename:'b.png'});await a;assert.equal(e.stages,1);assert.equal((await m.list()).jobs.find(x=>x.filename==='a.png').state,'exporting');
  assert.deepEqual(m.output(101),{mime:'image/png',evidence:'verified_mime',type:'pic',sizeBytes:png.length,sizeKind:'measured'});
  assert(!JSON.stringify(await m.list()).includes('signature=') && !JSON.stringify(await m.list()).includes('folder/'));
  e.native.get(101).state='complete';await b;assert.equal(e.stages,2);e.native.get(102).state='complete';await m.drain();assert((await m.list()).jobs.every(x=>x.state==='complete'));
  // Local export failure retains full bytes. Explicit retry does not receive remotely again.
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
  const session={};let seq=0;const idb=require('./tests/helpers/idb.cjs')();
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
    const aggregate=MediaLatchStatistics.createStatistics({indexedDB:require('./tests/helpers/idb.cjs')(),legacy:async()=>null,isEnabled:async()=>true});
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
  console.log('PASS: production stream validation, byte identity, queue/export boundary, local retry, cancellation, journal failure, recovery and statistics');
})().catch(e=>{console.error(e);process.exitCode=1;});
