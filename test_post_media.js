'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {createTestEnv}=require('./test_context_target_avatar');
const png=fs.readFileSync('icons/128.png'),id='149989236';
const src=`https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/10/12/00/00/00/${id}_p0_square1200.jpg`;
const post=`https://www.pixiv.net/artworks/${id}`,feed='https://www.pixiv.net/';
const items=Array.from({length:4},(_,i)=>`https://i.pximg.net/img-original/img/2026/10/12/00/00/00/${id}_p${i}.png?sig=EXACT%2B&order=${i}`);
function fixture(body=items.map(original=>({urls:{original}}))){
 const e=createTestEnv(),s=e.bgSandbox,calls=[];s.TextDecoder=TextDecoder;s.Buffer=Buffer;s.console.info=()=>{};
 s.fetch=async(raw,options={})=>{calls.push({url:raw,method:options.method||'GET'});return String(raw).endsWith('/pages')?new Response(JSON.stringify({error:false,body}),{headers:{'content-type':'application/json'}}):items.includes(raw)?new Response(options.method==='HEAD'?null:png,{headers:{'content-type':'image/png','content-length':String(png.length)}}):new Response('not found',{status:404});};
 s.resolveContextOwner=async()=> 'proven';
 vm.runInContext('PAWCHIVE_POST_MEDIA_PACE_MS=0',s);
 return {e,s,calls};
}
(async()=>{
 const good=fixture();const plan=await good.s.resolveOriginalMediaPlan({srcUrl:src,pageUrl:feed,linkUrl:post,allowPostMedia:true});
 assert.deepEqual(Array.from(plan.pixivPostMedia.items),items,'Exact declared originals, all four pages in order');
 assert.equal(good.calls.length,1,'One bounded metadata request, no guessed originals');
 await good.s.onContextMenuClicked({menuItemId:'save-image-item',srcUrl:src,pageUrl:feed,linkUrl:post,mediaType:'image',frameId:0},{id:1,url:feed});
 assert.equal(good.e.downloadedCalls.length,4,'One export per declared attachment');
 assert(good.e.downloadedCalls.every(x=>x.url==='data:image/png;base64,'+png.toString('base64')),'Production protected Pixiv fetch preserves actual bytes');
 assert.equal(new Set(good.e.downloadedCalls.map(x=>x.filename)).size,4,'Distinct page filenames');
 const one=fixture([{urls:{original:items[0]}}]);const onePlan=await one.s.resolvePixivPostMedia({srcUrl:src,pageUrl:feed,linkUrl:post});assert.equal(onePlan.primaryUrl,items[0],'A one-page artwork retains the existing single-image pipeline');assert(!onePlan.pixivPostMedia);
 const single=fixture();const selected=await single.s.resolveOriginalMediaPlan({srcUrl:src,pageUrl:post,linkUrl:post,allowPostMedia:true});
 assert(!selected?.pixivPostMedia,'Opened post keeps selected-media scope');
 const optedOut=fixture();await optedOut.s.resolveOriginalMediaPlan({srcUrl:src,pageUrl:feed,linkUrl:post,allowPostMedia:false});assert(!optedOut.calls.some(x=>x.method==='GET' && items.slice(1).includes(x.url)),'Single-media resolver does not acquire other pages');
 for(const original of ['https://evil.example/'+id+'_p1.png',items[1].replace(id,'999999999'),items[1].replace('_p1','_p0'),items[1].replace('https:','http:'),' '+items[1]]){
  const f=fixture([{urls:{original:items[0]}},{urls:{original}}]);const bad=await f.s.resolvePixivPostMedia({srcUrl:src,pageUrl:feed,linkUrl:post});assert.equal(bad.error,'POST_MEDIA_MISMATCH');assert.equal(f.e.downloadedCalls.length,0);
 }
 const empty=fixture([]);assert.equal((await empty.s.resolvePixivPostMedia({srcUrl:src,pageUrl:feed,linkUrl:post})).error,'POST_MEDIA_UNAVAILABLE');
 const pages28=Array.from({length:28},(_,i)=>({urls:{original:items[0].replace('_p0','_p'+i)}})),album=fixture(pages28);
 assert.equal((await album.s.resolvePixivPostMedia({srcUrl:src,pageUrl:feed,linkUrl:post})).pixivPostMedia.items.length,28,'An owned 28-page post is saved as a complete batch');
 const capped=fixture(Array.from({length:101},()=>({urls:{original:items[0]}})));assert.equal((await capped.s.resolvePixivPostMedia({srcUrl:src,pageUrl:feed,linkUrl:post})).error,'BATCH_LIMIT');
 const mismatch=fixture();assert.equal((await mismatch.s.resolvePixivPostMedia({srcUrl:src,pageUrl:feed,linkUrl:post.replace(id,'999999999')})).error,'POST_MEDIA_MISMATCH');assert.equal(mismatch.calls.length,0);
 const stale=fixture();let proofs=0;stale.s.resolveContextOwner=async()=>++proofs===1?'proven':'refused';await stale.s.onContextMenuClicked({menuItemId:'save-image-item',srcUrl:src,pageUrl:feed,linkUrl:post,mediaType:'image',frameId:0},{id:1,url:feed});assert.equal(stale.e.downloadedCalls.length,0,'Owner changing during API request prevents every batch export');
 const refused=fixture();refused.s.resolveContextOwner=async()=> 'refused';await refused.s.onContextMenuClicked({menuItemId:'save-image-item',srcUrl:src,pageUrl:feed,linkUrl:post,mediaType:'image',frameId:0},{id:1,url:feed});assert.equal(refused.calls.length,0,'Refused gesture makes zero metadata requests');
 const forged=fixture();await forged.s.onContextMenuClicked({menuItemId:'save-image-item',srcUrl:src,pageUrl:feed,linkUrl:post,postMediaPlan:{primaryUrl:items[3]},frameId:0},{id:1,url:feed});assert.equal(forged.e.downloadedCalls.length,4,'External plan field cannot replace internal batch provenance');
 const click={menuItemId:'save-image-item',srcUrl:src,pageUrl:feed,linkUrl:post,mediaType:'image',frameId:0},tab={id:1,url:feed};
 for(const method of ['HEAD','GET']){
  const f=fixture(),fetch=f.s.fetch,fail=f.s.fbFail,failures=[];
  f.s.fbFail=async(op,failure)=>{failures.push(failure);return fail(op,failure);};
  vm.runInContext('PAWCHIVE_POST_MEDIA_PACE_MS=30',f.s);
  f.s.fetch=async(url,opts={})=>url===items[0] && (opts.method||'GET')===method ? (f.calls.push({url,method}),new Response(null,{status:429})) : fetch(url,opts);
  await f.s.onContextMenuClicked(click,tab);
  assert.equal(f.e.downloadedCalls.length,0,`${method}429 does not export`);
  assert(!f.calls.some(x=>items.slice(1).includes(x.url)),`${method}429 stops remaining media requests after pacing`);
  assert.equal(failures.filter(x=>x.code==='RATE_LIMIT' && x.status===429).length,4,'Every skipped attachment has a visible rate-limit failure');
 }
 const overlap=fixture(),fetch=overlap.s.fetch;let active=0,peak=0;const held=[];
 overlap.s.fetch=async(url,opts={})=>{
  if(items.includes(url) && (opts.method||'GET')==='GET'){
   active++;peak=Math.max(peak,active);await new Promise(resolve=>held.push(resolve));active--;
  }
  return fetch(url,opts);
 };
 const running=overlap.s.onContextMenuClicked(click,tab);
 async function waitFor(predicate){for(let n=0;n<200;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Timed out waiting for Pixiv acquisition');}
 await waitFor(()=>held.length===2);assert.equal(active,2,'Two actual protected fetches overlap');
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(held.length,2,'Third page waits for a handler slot');
 held.splice(0).forEach(resolve=>resolve());await waitFor(()=>held.length===2);held.splice(0).forEach(resolve=>resolve());await running;
 assert.equal(peak,2,'Protected acquisition is capped at two per batch');assert.equal(overlap.e.downloadedCalls.length,4);
 console.log('PASS: Pixiv scope, exact exports, metadata/ownership bounds, HEAD/GET429 stop and two-handler concurrency');
})().catch(e=>{console.error(e);process.exitCode=1});
