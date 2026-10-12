'use strict';
const assert=require('node:assert/strict');
require('../lib/folder_path');require('../lib/export_directory');require('../lib/download_manager');require('../lib/feedback');require('../lib/feedback_tracker');
const {createExporter}=MediaLatchDirectory;
function fixture(){
 const receipts=new Map(),handles=new Map();let permission='granted',hold=null,aborts=0,writeError=null,closeError=false;
 class Handle{constructor(name){this.name=name;this.bytes=Buffer.alloc(0);}async getFile(){return new File([this.bytes],this.name);}async createWritable(){let chunks=[];return new WritableStream({write:async b=>{if(hold)await hold;if(writeError)throw writeError;chunks.push(Buffer.from(b));},close:()=>{this.bytes=Buffer.concat(chunks);if(closeError)throw Error('close reply lost');},abort:()=>{aborts++;}});}}
 class Directory{constructor(name){this.name=name;this.entries=new Map();}async queryPermission(){return permission;}async getDirectoryHandle(name,o={}){if(!this.entries.has(name)){if(!o.create)throw Object.assign(Error(),{name:'NotFoundError'});this.entries.set(name,new Directory(name));}return this.entries.get(name);}async getFileHandle(name,o={}){if(!this.entries.has(name)){if(!o.create)throw Object.assign(Error(),{name:'NotFoundError'});this.entries.set(name,new Handle(name));}return this.entries.get(name);}}
 const dir=new Directory('Chosen'),source=new File([Buffer.alloc(140001,83)],'staged');handles.set('directory-selected',dir);
 const store={get:async id=>handles.get(id),receipt:async id=>receipts.get(id),put:async r=>receipts.set(r.id,structuredClone(r)),forget:async id=>receipts.delete(id),byUrl:async url=>[...receipts.values()].find(r=>r.exportUrl===url),byOp:async op=>[...receipts.values()].find(r=>r.op===op)};
 const deps={store,FolderPath:ImageSaverFolderPath,file:async()=>source};
 return {dir,source,store,receipts,deps,exporter:createExporter(deps),set permission(v){permission=v;},set writeError(e){writeError=e;},set closeError(v){closeError=v;},hold(){let release;hold=new Promise(r=>release=r);return ()=>{hold=null;release();};},get aborts(){return aborts;}};
}
const job=(id='one')=>({id:'job-'+id,op:'op-'+id,directoryId:'directory-selected',filename:'SavedImages/author/photo.png',total:140001,mime:'image/png'});
const until=async fn=>{for(let n=0;n<100;n++){if(await fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('fixture timed out');};
(async()=>{
 const f=fixture(),j=job(),id=await f.exporter.write(j,'blob:prepared');assert.equal(id,'file:job-one');
 const parent=f.dir.entries.get('SavedImages').entries.get('author'),file=await parent.entries.get('photo.png').getFile();assert.deepEqual(Buffer.from(await file.arrayBuffer()),Buffer.from(await f.source.arrayBuffer()));assert.equal((await f.exporter.search(id)).state,'complete');
 assert.equal(await f.exporter.location(id),parent,'Location resolves the actual existing nested parent');
 await assert.rejects(f.exporter.location('file:job-foreign'),/INVALID_STATE/);
 f.permission='denied';await assert.rejects(f.exporter.location(id),/DIRECTORY_ACCESS_REQUIRED/);f.permission='granted';
 const oldReceipt=structuredClone(f.receipts.get(id));
 for(const filename of ['../escape.png','a//file.png','C:\\outside.png']){f.receipts.set(id,{...oldReceipt,filename});await assert.rejects(f.exporter.location(id),/INVALID_FILENAME/);}
 f.receipts.set(id,{...oldReceipt,state:'writing'});await assert.rejects(f.exporter.location(id),/INVALID_STATE/);
 f.receipts.set(id,oldReceipt);const savedHandle=parent.entries.get('photo.png');parent.entries.delete('photo.png');await assert.rejects(f.exporter.location(id));parent.entries.set('photo.png',savedHandle);
 await f.exporter.write(job('two'),'blob:second');assert(parent.entries.has('photo (1).png'));assert.equal(parent.entries.get('photo.png').bytes.length,140001,'Existing file remains intact');
 const unicode=fixture(),longName='a'+'😀'.repeat(117)+'.png';await unicode.exporter.write({...job('unicode'),filename:longName},'blob:u');await unicode.exporter.write({...job('unicode2'),filename:longName},'blob:u2');const renamed=unicode.receipts.get('file:job-unicode2').filename;assert(renamed.length<=240 && !/[\uD800-\uDBFF] \(1\)/.test(renamed),'Collision truncation keeps surrogate pairs intact');
 const reopened=createExporter(f.deps);assert.equal((await reopened.search(id)).state,'complete','Receipt survives exporter restart');
 const r=f.receipts.get(id);r.state='writing';f.receipts.set(id,r);assert.equal((await createExporter(f.deps).search(id)).state,'complete','Crash after close reconciles exact staged bytes');
 r.state='writing';f.receipts.set(id,r);parent.entries.get('photo.png').bytes[0]=0;assert.equal((await createExporter(f.deps).search(id)).state,'unknown','Changed destination refuses uncertain duplicate');await assert.rejects(createExporter(f.deps).write(j,'blob:prepared'),/EXPORT_UNCERTAIN/);
 const denied=fixture();denied.permission='denied';await assert.rejects(denied.exporter.write(job(),'blob:denied'),/DIRECTORY_ACCESS_REQUIRED/);assert.equal(denied.dir.entries.size,0);assert.equal(denied.receipts.size,0);
 const diskFull=fixture();diskFull.writeError=Object.assign(Error('disk full'),{name:'QuotaExceededError'});await assert.rejects(diskFull.exporter.write(job(),'blob:full'),/DIRECTORY_WRITE_FAILED/);assert.equal(diskFull.receipts.size,0,'Failed before close is retryable');diskFull.writeError=null;await diskFull.exporter.write(job(),'blob:retry');assert.equal((await diskFull.exporter.search('file:job-one')).state,'complete');
 const closeLost=fixture();closeLost.closeError=true;await assert.rejects(closeLost.exporter.write(job(),'blob:lost'),/EXPORT_UNCERTAIN/);assert.equal((await closeLost.exporter.search('file:job-one')).state,'complete','Lost close reply reconciles bytes rather than duplicating file');
 for(const filename of ['../escape.png','a//file.png','a/CON/photo.png','C:\\outside.png'])await assert.rejects(f.exporter.write({...job('invalid'),filename},'blob:invalid'),/INVALID_FILENAME/);
 const cancelled=fixture(),release=cancelled.hold(),pending=cancelled.exporter.write(job(),'blob:cancel');pending.catch(()=>{});await until(()=>cancelled.receipts.size===1);const abort=cancelled.exporter.abort('job-one');release();await assert.rejects(pending,/CANCELLED/);await abort;assert.equal((await cancelled.exporter.search('file:job-one')).state,'interrupted');
 const queued=fixture(),releaseFirst=queued.hold(),first=queued.exporter.write(job('first'),'blob:first'),second=queued.exporter.write(job('second'),'blob:second');second.catch(()=>{});await until(()=>queued.receipts.size===1);const stopSecond=queued.exporter.abort('job-second');releaseFirst();await first;await assert.rejects(second,/CANCELLED/);await stopSecond;assert(!queued.receipts.has('file:job-second'),'Cancelled queued writer does not create destination');
 let stored={},completed=0;const makeTracker=()=>ImageSaverFeedbackTracker.createTracker({storage:{get:async()=>stored,set:async(k,v)=>stored=structuredClone(v)},genId:()=> 'op-file',getDownloadItem:async()=>null,getFileExportItem:async()=>({state:'complete',filename:'real (1).png',fileSize:140001,output:{mime:'image/png',type:'pic',evidence:'verified_mime'}}),onFinished:()=>completed++,now:()=>Date.now()});
 const tracker=makeTracker();await tracker.ready();const op=await tracker.begin({sourceUrl:'https://example.test/a.png'});await tracker.stage(op,'saving');
 const recovered=makeTracker();await recovered.ready();assert.equal((await recovered.get(op)).state,'complete');assert.equal((await recovered.get(op)).filename,'real (1).png');assert.equal(completed,1);assert.equal(await recovered.completeFile(op,{state:'complete',fileSize:140001},{}),false,'No repeated success/statistics');
 console.log('PASS: directory streaming, collision safety, permission refusal, cancellation, uncertain export and feedback restart');
})().catch(e=>{console.error(e);process.exitCode=1;});
