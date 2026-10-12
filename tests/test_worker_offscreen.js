const assert = require('node:assert/strict');
require('../lib/worker_offscreen.js');

function fixture({unreadable = false, records = {}} = {}) {
  const calls = {created:0, closed:0, revoked:[], tracked:[]};
  const state = {unreadable, records, contexts:[], releaseCreate:null, managerBusy:false, searchUnavailable:false};
  const blobs = new Map(), early = new Map();
  const chrome = {
    runtime: {getContexts:async()=>state.contexts},
    offscreen: {
      createDocument:async()=>{calls.created++; if(state.releaseCreate)await state.releaseCreate; state.contexts=[{}];},
      closeDocument:async()=>{calls.closed++; state.contexts=[];}
    },
    storage: {session:{
      get:async key=>{if(state.unreadable)throw Error('STORAGE_FAILED');return key?{[key]:state.records[key]}:{...state.records};},
      set:async values=>Object.assign(state.records,values),
      remove:async key=>{delete state.records[key];}
    }},
    downloads:{search:(_query, callback)=>{if(state.searchUnavailable)throw Error('SEARCH_FAILED');callback([]);}}
  };
  const controller=globalThis.MediaLatchOffscreen.create({chrome,
    offscreenRequest:async message=>{calls.revoked.push(message.blobUrl);return {success:true};},
    isFileExport:()=>false, activeProtectedBlobsByDownloadId:blobs, earlyTerminalDownloadStates:early,
    addTrackedDownloadId:async id=>calls.tracked.push(id), isManagerBusy:()=>state.managerBusy
  });
  return {controller,calls,state,blobs,early};
}

(async()=>{
  const a=fixture(),b=fixture();
  await a.controller.reconcileActiveOffscreenDownloads();
  const key=a.controller.acquireOffscreenTask('old','blob:owned');
  assert.equal(b.controller.state.activeOffscreenOwners.size,0,'Instances must not share ownership');
  a.controller.transferOffscreenTask(key,'new','blob:owned');
  await a.controller.releaseOffscreenTask(key,'blob:owned');
  assert.equal(a.calls.revoked.length,0,'A stale release must not revoke the transferred Blob');
  assert.equal(a.controller.state.activeOffscreenTasks,1);
  a.state.contexts=[{}];
  await a.controller.releaseOffscreenTask('new','blob:owned');
  await a.controller.releaseOffscreenTask('new','blob:owned');
  assert.deepEqual(a.calls.revoked,['blob:owned']);
  assert.equal(a.calls.closed,1,'Only the final owner permits closing');

  const blocked=fixture({unreadable:true});blocked.state.contexts=[{}];
  await blocked.controller.closeOffscreenDocument();
  await blocked.controller.state.offscreenRecoveryPromise;
  assert.equal(blocked.calls.closed,0,'Unreadable persisted ownership must block closing');
  blocked.state.unreadable=false;
  await blocked.controller.reconcileActiveOffscreenDownloads();
  assert.equal(blocked.calls.closed,1,'A deferred close resumes only after ownership is known');

  const concurrent=fixture();let release;
  concurrent.state.releaseCreate=new Promise(resolve=>{release=resolve;});
  const creating=Promise.all([concurrent.controller.ensureOffscreenDocument(),concurrent.controller.ensureOffscreenDocument()]);
  await Promise.resolve();await Promise.resolve();
  assert.equal(concurrent.calls.created,1,'Concurrent acquisition creates one document');
  release();await creating;

  const unknown=fixture({records:{active_dl_blob_7:{downloadId:7,ownerKey:'protected_7',blobUrl:'blob:restart'}}});
  unknown.state.searchUnavailable=true;unknown.state.contexts=[{}];
  await unknown.controller.reconcileActiveOffscreenDownloads();
  await unknown.controller.closeOffscreenDocument();
  assert.equal(unknown.blobs.get(7),'blob:restart');
  assert.equal(unknown.calls.closed,0,'An unavailable browser lookup must preserve the recovered owner');
  assert.equal(unknown.calls.revoked.length,0);

  const terminal=fixture();await terminal.controller.reconcileActiveOffscreenDownloads();
  terminal.early.set(8,'complete');terminal.controller.acquireOffscreenTask('protected_8','blob:early');
  await terminal.controller.trackDownloadProtectedBlob(8,'blob:early');
  assert.equal(terminal.blobs.size,0);assert.equal(terminal.controller.state.activeOffscreenTasks,0);
  assert.deepEqual(terminal.calls.revoked,['blob:early'],'A terminal event before registration releases only its own Blob');
  console.log('PASS explicit offscreen dependencies: isolation, transfer, recovery, creation and early terminal ownership');
})().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
