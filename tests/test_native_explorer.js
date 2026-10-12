const assert=require('node:assert/strict');
require('../lib/folder_path.js');require('../lib/export_directory.js');require('../lib/native_explorer.js');
function fixture(){
  const token='0123456789abcdef0123456789abcdef',files=new Map([['file.png','saved']]),sent=[],removed=[];let permission='granted',result={success:true},fail=false;
  const directory={name:'Destination',queryPermission:async()=>permission,getFileHandle:async(name,options={})=>{
    if(!files.has(name)){if(!options.create)throw Object.assign(Error(),{name:'NotFoundError'});files.set(name,'');}
    return {createWritable:async()=>({write:async value=>files.set(name,value),close:async()=>{},abort:async()=>{}})};
  },removeEntry:async name=>{removed.push(name);files.delete(name)}};
  const receipt={id:'file:job-one',state:'complete',directoryId:'directory-one',filename:'file.png'};
  const native=MediaLatchNativeExplorer.create({store:{get:async()=>directory,receipt:async()=>receipt},Directory:MediaLatchDirectory,FolderPath:ImageSaverFolderPath,nonce:()=>token,send:async message=>{sent.push(message);assert.equal(files.get('.medialatch-explorer-'+token+'.tmp'),token);if(fail)throw Error('MISSING_HOST');return result;}});
  return {native,files,sent,removed,receipt,token,set permission(v){permission=v},set result(v){result=v},set fail(v){fail=v}};
}
(async()=>{
 const f=fixture();await f.native.reveal('file:job-one');assert.equal(f.sent[0].action,'reveal');assert.equal(f.sent[0].filename,'file.png');assert.equal(f.files.size,1);assert.equal(f.files.get('file.png'),'saved');
 f.fail=true;await assert.rejects(f.native.reveal('file:job-one'),/NATIVE_HOST_REQUIRED/);assert.equal(f.files.size,1);
 f.fail=false;f.result={success:false,error:'DIRECTORY_LINK_REQUIRED'};await assert.rejects(f.native.reveal('file:job-one'),/DIRECTORY_LINK_REQUIRED/);assert.equal(f.files.size,1);
 f.result={success:false,error:'D:\\private\\path'};await assert.rejects(f.native.reveal('file:job-one'),/NATIVE_LOCATION_FAILED/);
 f.permission='denied';const count=f.sent.length;await assert.rejects(f.native.reveal('file:job-one'),/DIRECTORY_ACCESS_REQUIRED/);assert.equal(f.sent.length,count);
 f.permission='granted';f.receipt.state='writing';await assert.rejects(f.native.reveal('file:job-one'),/INVALID_STATE/);assert.equal(f.sent.length,count);
 f.receipt.state='complete';f.receipt.filename='../escape.png';await assert.rejects(f.native.reveal('file:job-one'),/INVALID_FILENAME/);assert.equal(f.sent.length,count);
 f.receipt.filename='file.png';f.result={success:true};await f.native.link('directory-one');assert.equal(f.sent.at(-1).action,'link');assert.equal(f.files.size,1);
 f.files.set('.medialatch-explorer-'+f.token+'.tmp','user data');await assert.rejects(f.native.reveal('file:job-one'),/NATIVE_PROOF_EXISTS/);assert.equal(f.files.get('.medialatch-explorer-'+f.token+'.tmp'),'user data');
 console.log('PASS native Explorer: complete receipt, grant/path validation, proof cleanup on success/error, localized-safe errors and existing-file preservation');
})().catch(e=>{console.error(e);process.exitCode=1;});
