// Private directory grants and export receipts. No handles or paths enter public diagnostics.
(function(root){
  const validId=id=>typeof id==='string' && /^directory-[a-zA-Z0-9-]{1,80}$/.test(id);
  const isExportId=id=>typeof id==='string' && /^file:job-[a-zA-Z0-9-]{1,80}$/.test(id);
  function database(idb){
    let opening;
    const open=()=>opening || (opening=new Promise((resolve,reject)=>{
      const r=idb.open('medialatch-destinations',1);
      r.onupgradeneeded=()=>{r.result.createObjectStore('handles');const s=r.result.createObjectStore('exports',{keyPath:'id'});s.createIndex('url','exportUrl');s.createIndex('op','op');};
      let blocked=false;r.onblocked=()=>{blocked=true;opening=null;reject(Error('STORAGE_BLOCKED'));};
      r.onerror=()=>{opening=null;reject(r.error);};
      r.onsuccess=()=>{if(blocked){r.result.close();return;}r.result.onversionchange=()=>{r.result.close();opening=null;};resolve(r.result);};
    }));
    const run=(store,mode,action)=>open().then(db=>new Promise((resolve,reject)=>{const tx=db.transaction(store,mode),r=action(tx.objectStore(store));tx.oncomplete=()=>resolve(r.result);tx.onabort=tx.onerror=()=>reject(tx.error || Error('STORAGE_FAILED'));}));
    return {get:id=>run('handles','readonly',s=>s.get(id)),set:(id,h)=>run('handles','readwrite',s=>s.put(h,id)),receipt:id=>run('exports','readonly',s=>s.get(id)),put:r=>run('exports','readwrite',s=>s.put(r)),byUrl:url=>run('exports','readonly',s=>s.index('url').get(url)),byOp:op=>run('exports','readonly',s=>s.index('op').get(op)),forget:id=>run('exports','readwrite',s=>s.delete(id))};
  }
  function createExporter(d){
    const active=new Map();let chain=Promise.resolve();
    const item=r=>({id:r.id,state:r.state==='complete'?'complete':r.state==='cancelled'?'interrupted':'unknown',error:r.state==='complete'?'':r.state==='cancelled'?'CANCELLED':'EXPORT_UNCERTAIN',filename:r.filename,fileSize:r.size,bytesReceived:r.size});
    async function directory(id,mode='readwrite'){if(!validId(id))throw Error('DIRECTORY_ACCESS_REQUIRED');const h=await d.store.get(id);if(!h || await h.queryPermission({mode})!=='granted')throw Error('DIRECTORY_ACCESS_REQUIRED');return h;}
    function parts(filename){if(typeof filename!=='string' || !filename || filename.length>d.FolderPath.LIMITS.relativePath)throw Error('INVALID_FILENAME');const p=filename.split('/');if(p.some(s=>!s || d.FolderPath.normalizeSegment(s)!==s))throw Error('INVALID_FILENAME');return p;}
    async function parent(h,p,create){for(const name of p.slice(0,-1))h=await h.getDirectoryHandle(name,{create});return h;}
    async function equal(a,b){if(a.size!==b.size)return false;for(let n=0;n<a.size;n+=65536){const x=new Uint8Array(await a.slice(n,n+65536).arrayBuffer()),y=new Uint8Array(await b.slice(n,n+65536).arrayBuffer());if(x.some((v,i)=>v!==y[i]))return false;}return true;}
    async function search(id,url){
      const r=isExportId(id)?await d.store.receipt(id):await d.store.byUrl(url);if(!r)return null;
      if(r.state==='complete' || r.state==='cancelled')return item(r);
      if(active.has(r.id))return {...item(r),state:'in_progress'};
      try{const p=parts(r.filename),h=await parent(await directory(r.directoryId),p,false),f=await (await h.getFileHandle(p.at(-1))).getFile(),staged=await d.file(r.jobId);
        if(!await equal(f,staged))return item(r);
        r.state='complete';await d.store.put(r);return item(r);
      }catch(_){return item(r);}
    }
    async function location(id){
      if(!isExportId(id))throw Error('INVALID_JOB');
      const r=await d.store.receipt(id);
      if(!r || r.state!=='complete' || r.id!==id)throw Error('INVALID_STATE');
      const p=parts(r.filename),h=await parent(await directory(r.directoryId,'read'),p,false);
      await h.getFileHandle(p.at(-1));
      return h;
    }
    async function write(job,url,control){
      const id='file:'+job.id;if(!isExportId(id))throw Error('INVALID_JOB');
      const old=await d.store.receipt(id);if(old){const found=await search(id,url);if(found?.state==='complete')return id;throw Error('EXPORT_UNCERTAIN');}
      let writer,receipt,closing=false;
      try{
        const base=await directory(job.directoryId),p=parts(job.filename),h=await parent(base,p,true),source=await d.file(job.id);
        if(source.size!==job.total || source.size<=0)throw Error('PREPARED_FILE_MISSING');
        const name=p.at(-1),dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):'';
        let filename=name,free=false;
        for(let n=0;n<1000;n++){const suffix=` (${n})${ext}`,budget=d.FolderPath.LIMITS.relativePath-p.slice(0,-1).join('/').length-(p.length>1?1:0)-suffix.length;filename=n?`${d.FolderPath.normalizeSegment(stem.slice(0,budget).replace(/[\uD800-\uDBFF]$/,'')) || 'file'}${suffix}`:name;try{await h.getFileHandle(filename);}catch(e){if(e.name!=='NotFoundError')throw e;free=true;break;}}
        if(!free)throw Error('FILENAME_CONFLICT');
        p[p.length-1]=filename;
        receipt={id,op:job.op,directoryId:job.directoryId,jobId:job.id,filename:p.join('/'),exportUrl:url,size:source.size,mime:job.mime,state:'writing'};
        await d.store.put(receipt);
        if(control.signal.aborted)throw Error('CANCELLED');
        const target=await h.getFileHandle(filename,{create:true});if((await target.getFile()).size)throw Error('FILENAME_CONFLICT');
        writer=await target.createWritable({mode:'exclusive'});
        await source.stream().pipeTo(writer,{signal:control.signal,preventClose:true});
        if(control.signal.aborted)throw Error('CANCELLED');
        closing=true;await writer.close();writer=null;
        if((await target.getFile()).size!==source.size)throw Error('INCOMPLETE_BODY');
        receipt.state='complete';await d.store.put(receipt);return id;
      }catch(e){
        // Once close starts, only exact-byte reconciliation can establish whether the file committed.
        if(closing)throw Error('EXPORT_UNCERTAIN');
        if(writer){try{await writer.abort();writer=null;}catch(_){throw Error('EXPORT_UNCERTAIN');}}
        if(control.signal.aborted){if(receipt){receipt.state='cancelled';await d.store.put(receipt);}throw Error('CANCELLED');}
        if(receipt)await d.store.forget(id);
        throw Error(['NotAllowedError','SecurityError'].includes(e.name)?'DIRECTORY_ACCESS_REQUIRED':/^[A-Z][A-Z0-9_]{1,47}$/.test(e.message)?e.message:'DIRECTORY_WRITE_FAILED');
      }finally{if(writer)await writer.abort().catch(()=>{});}
    }
    return {directory,search,location,write(job,url){const id='file:'+job.id;if(active.has(id))return Promise.reject(Error('EXPORT_BUSY'));const control=new AbortController();let stopped;const done=new Promise(r=>stopped=r);active.set(id,{control,done});const p=chain.then(()=>{if(control.signal.aborted)throw Error('CANCELLED');return write(job,url,control);}).finally(()=>{active.delete(id);stopped();});chain=p.catch(()=>{});return p;},async abort(jobId){const e=active.get('file:'+jobId);e?.control.abort();await e?.done;}};
  }
  root.MediaLatchDirectory={validId,isExportId,database,createExporter};
})(globalThis);
