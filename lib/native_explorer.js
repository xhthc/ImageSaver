// Worker-owned folder reveal. A temporary proof ties a native path to the existing browser grant.
(function(root){
  function create({store,Directory,FolderPath,send,nonce}){
    const exporter=Directory.createExporter({store,FolderPath});
    async function run(action,directoryId,filename){
      const base=await exporter.directory(directoryId),token=nonce();
      if(!/^[a-f0-9]{32}$/.test(token))throw Error('NATIVE_PROTOCOL_ERROR');
      const name='.medialatch-explorer-'+token+'.tmp';let created=false;
      try{
        try{await base.getFileHandle(name);throw Error('NATIVE_PROOF_EXISTS');}catch(e){if(e.name!=='NotFoundError')throw e;}
        const handle=await base.getFileHandle(name,{create:true});created=true;
        const writer=await handle.createWritable();
        try{await writer.write(token);await writer.close();}catch(e){await writer.abort().catch(()=>{});throw e;}
        let result;
        try{result=await send({action,directoryId,directoryName:base.name,filename,nonce:token});}
        catch(_){throw Error('NATIVE_HOST_REQUIRED');}
        if(!result?.success)throw Error(['DIRECTORY_LINK_REQUIRED','FILE_NOT_FOUND','INVALID_PATH','NATIVE_CANCELLED'].includes(result?.error)?result.error:'NATIVE_LOCATION_FAILED');
      }finally{if(created)await base.removeEntry(name).catch(()=>{});}
    }
    return {async reveal(id){
      await exporter.location(id);
      const r=await store.receipt(id);
      if(!r || r.id!==id || r.state!=='complete')throw Error('INVALID_STATE');
      await run('reveal',r.directoryId,r.filename);
    },link:directoryId=>run('link',directoryId)};
  }
  root.MediaLatchNativeExplorer={create};
})(globalThis);
