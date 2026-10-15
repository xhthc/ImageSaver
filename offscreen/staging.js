// Offscreen disk-backed staging: a bounded chunk is written before the next is read.
(function(root) {
  function createStaging(d) {
    const active = new Map(), urls = new Map(), cancelled = new Set();
    const valid = id => {if(typeof id !== 'string' || !/^job-[a-zA-Z0-9-]{1,80}$/.test(id)) throw Error('INVALID_JOB');return id;};
    const directory = async () => (await d.directory()).getDirectoryHandle('medialatch-downloads',{create:true});
    const claim=m=>({ 'image/jpg':'image/jpeg','video/x-m4v':'video/mp4','image/vnd.microsoft.icon':'image/x-icon' }[m] || (/^(image|video|audio)\//.test(m)?m:''));
    const sniff=p=>p[0]===66 && p[1]===77?'image/bmp':p[0]===0 && p[1]===0 && p[2]===1 && p[3]===0?'image/x-icon':String.fromCharCode(...p.subarray(0,4))==='OggS'?'application/ogg':String.fromCharCode(...p.subarray(4,12))==='ftypqt  '?'video/quicktime':d.sniff(p);
    const intact=(prefix,size,mime)=>size>=({ 'image/jpeg':32,'image/png':45,'image/gif':14,'image/webp':20,'video/webm':12,'video/mp4':32,'video/quicktime':32,'image/svg+xml':4,'image/avif':32,'image/bmp':26,'image/x-icon':22,'application/ogg':28 }[mime]||64) && !d.malformed(prefix,size);
    async function remove(id) {
      valid(id); const url=urls.get(id); if(url){d.revoke(url);urls.delete(id);}
      try{await (await directory()).removeEntry(id);}catch(e){if(e.name !== 'NotFoundError')throw e;}
    }
    async function fileUrl(id,mime) {
      valid(id); if(urls.has(id))return urls.get(id);
      const file=await (await (await directory()).getFileHandle(id)).getFile();
      if(!file.size)throw Error('EMPTY_BODY');
      const url=d.url(new Blob([file],{type:mime}));urls.set(id,url);return url;
    }
    async function stage(job, progress) {
      valid(job.id);
      if(active.has(job.id))throw Error('STAGING_BUSY');
      if(cancelled.has(job.attempt))throw Error('CANCELLED');
      const source=new URL(job.source), local=source.protocol==='blob:' || source.protocol==='data:';
      if(!local && !['http:','https:'].includes(source.protocol))throw Error('INVALID_SOURCE');
      if(source.username || source.password || !local && !root.MediaLatchSources.allows(job.source, job.selectedPage))throw Error('INVALID_SOURCE');
      if(source.protocol==='blob:' && source.origin !== d.origin)throw Error('FOREIGN_BLOB');
      if(source.protocol==='data:' && !/^data:(image|video)\//.test(job.source))throw Error('INVALID_SOURCE');
      const controller=new AbortController();let stopped;const done=new Promise(r=>stopped=r);active.set(job.id,{controller,done});
      let writer, reader, received=0, prefix=new Uint8Array(0), timer, saved=false, timedOut=false;
      // An optional per-job body cap (Pixiv: 50 MiB) bounds the bytes actually received, whatever the headers say.
      const max=Number.isSafeInteger(job.maxBytes) && job.maxBytes>0 ? job.maxBytes : 0;
      const resetTimeout=()=>{clearTimeout(timer);timer=setTimeout(()=>{timedOut=true;controller.abort();},60000);};
      try {
        resetTimeout();
        const response=await d.fetch(job.source,{credentials:'include',redirect:'error',signal:controller.signal});
        if(response.status===429) {
          const retry=response.headers.get('retry-after');
          const delay=/^\d+$/.test(retry||'')?Number(retry)*1000:Date.parse(retry||'')-Date.now();
          throw Object.assign(Error('RATE_LIMIT'), {retryAt:Number.isFinite(delay) && delay>=0?Date.now()+Math.min(delay,86400000):null});
        }
        if(!response.ok || response.status===206)throw Error(response.status===403 || response.status===401?'AUTH_REQUIRED':'HTTP_ERROR');
        const length=Number(response.headers.get('content-length'));
        const total= !response.headers.get('content-encoding') && Number.isSafeInteger(length) && length>0 ? length : null;
        const estimate=await d.estimate();
        const available=Math.max(0,(estimate.quota||0)-(estimate.usage||0));
        if(max && total && total>max)throw Error('SIZE_EXCEEDED');
        if(total && available && total>available)throw Error('STORAGE_QUOTA');
        writer=await (await (await directory()).getFileHandle(job.id,{create:true})).createWritable();
        reader=response.body?.getReader();if(!reader)throw Error('EMPTY_BODY');
        const started=Date.now();let notified=0;
        while(true) {
          resetTimeout();const {done,value}=await reader.read();if(done)break;
        if(controller.signal.aborted)throw Error(timedOut?'NETWORK_TIMEOUT':'CANCELLED');
          received+=value.byteLength;
          if(max && received>max)throw Error('SIZE_EXCEEDED');
          if((total && received>total) || (available && received>available))throw Error(total && received>total?'INCOMPLETE_BODY':'STORAGE_QUOTA');
          if(prefix.length<4096){const n=value.subarray(0,4096-prefix.length), p=new Uint8Array(prefix.length+n.length);p.set(prefix);p.set(n,prefix.length);prefix=p;}
          await writer.write(value);
          if(Date.now()-notified>=250){notified=Date.now();await progress({state:'receiving',received,total,speed:Math.round(received*1000/Math.max(1,Date.now()-started))});}
        }
        clearTimeout(timer);
        if(controller.signal.aborted)throw Error(timedOut?'NETWORK_TIMEOUT':'CANCELLED');
        if(!received)throw Error('EMPTY_BODY');
        if(total && total!==received)throw Error('INCOMPLETE_BODY');
        await progress({state:'validating',received,total,speed:0});
        const detected=sniff(prefix), expected=claim(job.expectedMime||'');
        const mime=detected==='application/ogg' && /^(audio|video)\/ogg$/.test(expected)?expected:detected;
        if(!mime || !intact(prefix,received,detected) || (expected && mime!==expected))throw Error('INVALID_MEDIA');
        await writer.close();writer=null;
        const file=await (await (await directory()).getFileHandle(job.id)).getFile();
        if(file.size!==received)throw Error('INCOMPLETE_BODY');
        saved=true;return {size:received,mime};
      }catch(e){
        if(e.name==='QuotaExceededError')throw Error('STORAGE_QUOTA');
        if(controller.signal.aborted)throw Error(timedOut?'NETWORK_TIMEOUT':'CANCELLED');
        throw e;
      }finally{
        clearTimeout(timer);
        try {
          if(reader)await reader.cancel().catch(()=>{});
          if(writer)await writer.abort().catch(()=>{});
          if(!saved)await remove(job.id).catch(()=>{});
        }finally{active.delete(job.id);stopped();}
      }
    }
    return {stage,fileUrl,remove,async verify(id,size,mime){
      valid(id);const file=await (await (await directory()).getFileHandle(id)).getFile();
      const prefix=new Uint8Array(await file.slice(0,4096).arrayBuffer());
      const detected=sniff(prefix);
      return file.size===size && intact(prefix,size,detected) && (detected===mime || detected==='application/ogg' && /^(audio|video)\/ogg$/.test(mime));
    },async abort(id,attempt){
      valid(id);if(attempt){cancelled.add(attempt);if(cancelled.size>200)cancelled.delete(cancelled.values().next().value);}
      const entry=active.get(id);entry?.controller.abort();await entry?.done;
    }};
  }
  root.MediaLatchStaging={createStaging};
})(globalThis);
