// Actual admission / acquisition regressions; this does not claim DNS-rebinding protection.
const assert=require('node:assert/strict'), http=require('node:http');
const {allows}=require('../lib/media_sources');
require('../lib/staging');
const {createTestEnv}=require('./test_context_target_avatar');
const {sniffMediaMagicBytes,isMalformedMediaContainer}=require('../offscreen');
(async()=>{
  const page='https://gallery.example/post', exact='https://cdn.example/a.png?sig=EXACT%2Bsignature&order=2';
  const denied=['http://localhost/a.png','http://localhost./a.png','http://a.localhost/a.png','http://127.0.0.1/a.png','http://2130706433/a.png','http://0x7f000001/a.png','http://10.0.0.1/a.png','http://172.16.1.2/a.png','http://192.168.1.2/a.png','http://169.254.169.254/a.png','http://100.64.1.2/a.png','http://[::1]/a.png','http://[fc00::1]/a.png','http://[fe80::1]/a.png','http://[::ffff:127.0.0.1]/a.png','http://[::ffff:192.168.1.2]/a.png','https://name:secret@cdn.example/a.png','file:///a.png','ftp://cdn.example/a.png'];
  const env=createTestEnv(), s=env.bgSandbox; let requests=[];
  s.fetch=async(u,o)=>{requests.push([u,o]);assert.equal(o.redirect,'error');return new Response(null,{headers:{'content-type':'image/png','content-length':'10000'}});};
  for(const url of denied){
    assert.equal(allows(url,page),false,url);
    assert.equal(s.normalizeCandidateUrl(url,page,page),null);
    assert.equal(await s.probeCandidate({url}),false);
    assert.equal((await s.probeVideoUrlDetails(url,page)).ok,false);
    assert.equal((await s.verifyMp4ContainerBytes(url,page)).ok,false);
    assert.equal(await s.resolveOriginalMediaPlan({srcUrl:url,pageUrl:page}),null);
  }
  assert.equal(requests.length,0,'all refused URLs cause no privileged request');
  assert.equal(s.normalizeCandidateUrl(exact,page,page),exact,'signed public URL is unchanged');
  for(const link of ['javascript:void(0)','mailto:user@example.com','tel:123','http://127.0.0.1/action.png']){
    requests=[];
    const plan=await s.resolveOriginalMediaPlan({srcUrl:exact,pageUrl:page,linkUrl:link});
    assert.equal(plan.primaryUrl,exact,'incidental parent link keeps its selected image');
    assert(requests.every(([u])=>!denied.includes(u) && u!==link));
  }
  // A DOM-supplied base URL cannot grant local authority on the admitted public page.
  assert.equal(s.normalizeCandidateUrl('/private.png','http://127.0.0.1/',page),null);
  const lan='http://192.168.1.2/gallery';
  assert.equal(s.normalizeCandidateUrl('/selected.png',lan,lan),'http://192.168.1.2/selected.png');
  assert.equal(await s.probeCandidate({url:'http://192.168.1.2/selected.png',selectedPage:lan}),true);
  assert.equal(s.validateRedditCandidateUrl('https://v.redd.it/owned/DASH_720.mp4').valid,true);
  // Final staging refuses malformed/public-to-local sources before touching disk/network.
  let fetches=0, writes=0;
  const stage=MediaLatchStaging.createStaging({fetch:async()=>{fetches++;throw Error('unexpected fetch');},directory:async()=>{writes++;throw Error('unexpected disk');}});
  for(const url of denied)await assert.rejects(stage.stage({id:'job-refused',source:url,selectedPage:page}),/INVALID_SOURCE/);
  assert.equal(fetches,0);assert.equal(writes,0);
  require('../lib/download_manager'); const {createManager}=MediaLatchDownloads;
  // Acquisition context survives the durable private queue, but never appears in its public snapshot.
  let stored;
  const manager=createManager({store:{get:async()=>({jobs:[],paused:true}),set:async x=>stored=structuredClone(x)},id:()=> 'context',changed(){},sleep:async()=>{},remove:async()=>{}});
  await manager.ready; void manager.enqueue({url:'http://192.168.1.2/selected.png',filename:'selected.png'},{selectedPage:lan}).catch(()=>{});
  await new Promise(r=>setTimeout(r,0));
  assert.equal(stored.jobs[0].selectedPage,lan);
  assert.equal((await manager.list()).jobs[0].selectedPage,undefined);
  // A real Fetch redirect is refused before any second request, including a two-hop chain.
  let targetHits=0;
  const server=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'/second'});res.end();}else{targetHits++;res.writeHead(302,{location:'/private.png'});res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  try {
    s.fetch=fetch;
    assert.equal(await s.probeCandidate({url:origin+'/redirect',selectedPage:origin}),false);
    const real=MediaLatchStaging.createStaging({fetch,estimate:async()=>({quota:1e8,usage:0}),directory:async()=>{throw Error('unexpected disk');},origin:'chrome-extension://test',sniff:sniffMediaMagicBytes,malformed:isMalformedMediaContainer});
    await assert.rejects(real.stage({id:'job-redirect',source:origin+'/redirect',selectedPage:origin}),/fetch failed/);
    assert.equal(targetHits,0,'redirect target never requested');
  }finally{await new Promise(r=>server.close(r));}
  console.log('PASS literal local/credential/scheme admission, signed URLs, incidental links, LAN context persistence, zero-side-effect refusal and real redirect chain');
})().catch(e=>{console.error(e);process.exitCode=1;});
