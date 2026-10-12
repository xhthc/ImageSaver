'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createTestEnv } = require('./test_context_target_avatar');

const cases = [
  { id: '4731293', src: 'https://s3.zerochan.net/240/43/25/4731293.avif', full: 'https://static.zerochan.net/Izayoi.Nonomi.full.4731293.png', size: 2582528 },
  { id: '4730884', src: 'https://s3.zerochan.net/240/34/17/4730884.avif', full: 'https://static.zerochan.net/Silver.Wolf.LV.999.full.4730884.png', size: 14210048 }
];
function fixture(selected, unavailable = false) {
  const env = createTestEnv(), s = env.bgSandbox, calls = [];
  s.console.info = () => {};
  s.resolveContextOwner = async () => 'proven';
  s.fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url.endsWith('?json')) {
      if (unavailable || options.credentials !== 'include') return new Response('Checking browser...', { status: 503 });
      return new Response(JSON.stringify({ id: Number(selected.id), full: selected.full }), { headers: { 'content-type': 'application/json' } });
    }
    if (url === selected.full) return new Response(null, { headers: { 'content-type': selected.full.endsWith('.avif') ? 'image/avif' : 'image/png', 'content-length': String(selected.size) } });
    if (url === selected.src) return new Response(null, { headers: { 'content-type': 'image/avif', 'content-length': '10240' } });
    return new Response(null, { status: 404 });
  };
  return { env, s, calls };
}
(async () => {
  for (const selected of cases) {
    const f = fixture(selected), args = { srcUrl: selected.src, pageUrl: 'https://www.zerochan.net/', linkUrl: 'https://www.zerochan.net/' + selected.id };
    const plan = await f.s.resolveOriginalMediaPlan(args);
    assert.equal(plan.primaryUrl, selected.full, 'Numbered preview resolves the declared PNG using the active site session');
    assert.equal(plan.metadata.contentType, 'image/png');
    assert.equal(plan.metadata.contentLength, selected.size);
    assert.equal(f.calls.filter(x => x.url.endsWith('?json')).length, 1);
    assert.equal(f.calls.find(x => x.url.endsWith('?json')).credentials, 'include');
    await f.s.onContextMenuClicked({ menuItemId: 'save-image-item', ...args, mediaType: 'image', frameId: 0 }, { id: 1, url: args.pageUrl });
    assert.equal(f.env.downloadedCalls.length, 1);
    assert.equal(f.env.downloadedCalls[0].url, selected.full, 'The production handler exports the original URL, never the AVIF preview');
    assert(f.env.downloadedCalls[0].filename.endsWith('.png'));

    const failed = fixture(selected, true);
    assert.equal(await failed.s.resolveOriginalMediaPlan(args), null, 'Unavailable metadata cannot report a preview as a successful original');
    await failed.s.onContextMenuClicked({ menuItemId: 'save-image-item', ...args, frameId: 0 }, { id: 1, url: args.pageUrl });
    assert.equal(failed.env.downloadedCalls.length, 0);
  }
  const original = { ...cases[0], full: 'https://static.zerochan.net/OriginalArt.full.4731293.avif' };
  const genuine = fixture(original, true);
  const plan = await genuine.s.resolveOriginalMediaPlan({ srcUrl: original.full, pageUrl: 'https://www.zerochan.net/4731293' });
  assert.equal(plan.primaryUrl, original.full, 'Genuine original AVIF remains supported');
  assert.equal(plan.metadata.contentType, 'image/avif');
  const selected=cases[0],f=fixture(selected,true),post='https://www.zerochan.net/'+selected.id,pageUrl='https://www.zerochan.net/';
  f.s.chrome.scripting.executeScript=async options=>options.func.name==='readZerochanOriginal'?[{result:{id:selected.id,url:selected.full,status:200}}]:[];
  assert.equal((await f.s.resolveOriginalMediaPlan({srcUrl:selected.src,pageUrl,linkUrl:post,tabId:1,frameId:0})).primaryUrl,selected.full,'Pinned page session recovers an original when extension metadata request is blocked');
  f.s.chrome.scripting.executeScript=async()=>[{result:{id:selected.id,url:selected.full.replace(selected.id,'9999999'),status:200}}];
  assert.equal((await f.s.resolveZerochanPageOriginal({srcUrl:selected.src,pageUrl,linkUrl:post,tabId:1})).error,'NO_MEDIA','A page reply cannot inject a neighboring original');
  const owner={href:post},image={src:selected.src,currentSrc:selected.src,isConnected:true,closest:()=>owner},calls=[];
  const context={URL,AbortController,TextDecoder,Uint8Array,setTimeout,clearTimeout,location:{href:pageUrl,origin:'https://www.zerochan.net'},document:{images:[image]},fetch:async(url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify({id:Number(selected.id),full:selected.full}),{headers:{'content-type':'application/json'}});}};
  vm.createContext(context);vm.runInContext('('+f.s.readZerochanOriginal.toString()+')',context);
  const read=vm.runInContext('('+f.s.readZerochanOriginal.toString()+')',context);
  assert.equal((await read(selected.src,post,pageUrl)).url,selected.full);assert.equal(calls[0].opts.credentials,'same-origin');assert.equal(calls[0].url,post+'?json');
  context.fetch=async()=>{image.currentSrc='https://example.com/other.png';return new Response('{}',{headers:{'content-type':'application/json'}});};
  assert.equal((await read(selected.src,post,pageUrl)).error,'NO_MEDIA','Changing the selected image during metadata lookup refuses the reply');image.currentSrc=selected.src;
  context.fetch=async()=>new Response('oversized',{headers:{'content-type':'application/json','content-length':String(3*1024*1024)}});
  assert.equal((await read(selected.src,post,pageUrl)).error,'NO_MEDIA','Oversized page metadata is refused before reading');
  context.fetch=async()=>new Response(null,{status:429});assert.equal((await read(selected.src,post,pageUrl)).status,429,'Page rate-limit status survives');
  let canonical=post,fulls=[selected.full],parsedText='';
  context.DOMParser=class{parseFromString(text,type){assert.equal(type,'text/html');parsedText=text;return {querySelector:()=>({getAttribute:()=>canonical}),querySelectorAll:()=>fulls.map(full=>({getAttribute:()=>full}))};}};
  const html='<link rel="canonical" href="'+post+'"><div id="large"><a class="preview" href="'+selected.full+'"></a></div>';
  calls.length=0;context.fetch=async(url,opts)=>{calls.push({url,opts});return url.endsWith('?json')?new Response('Checking browser...',{status:503}):new Response(html,{headers:{'content-type':'text/html'}});};
  const fallback=await read(selected.src,post,pageUrl);assert.equal(fallback.url,selected.full);assert.equal(fallback.route,'post_html');assert.equal(parsedText,html);
  assert.equal(calls.length,2);assert.equal(calls[1].url,post);assert.equal(calls[1].opts.credentials,'same-origin');assert.equal(calls[0].opts.signal,calls[1].opts.signal,'JSON and HTML share one deadline');
  canonical='https://www.zerochan.net/9999999';assert.equal((await read(selected.src,post,pageUrl)).error,'NO_MEDIA','Neighbor HTML canonical refuses original');canonical=post;
  fulls=[selected.full,selected.full];assert.equal((await read(selected.src,post,pageUrl)).error,'NO_MEDIA','Ambiguous full links refuse selection');fulls=[selected.full];
  let requests=0;context.fetch=async url=>{requests++;if(url.endsWith('?json')){image.currentSrc='changed';return new Response(null,{status:503});}throw Error('Must not request stale post');};
  assert.equal((await read(selected.src,post,pageUrl)).error,'NO_MEDIA');assert.equal(requests,1,'Changed selection stops before HTML request');image.currentSrc=selected.src;
  context.fetch=async()=>new Response('Checking browser...',{status:503});const blocked=await read(selected.src,post,pageUrl);assert.equal(blocked.status,503);assert.equal(blocked.route,'post_html','A blocked HTML response stays a failure, never executes challenge HTML');
  for(const status of [401,403,429]){requests=0;context.fetch=async()=>{requests++;return new Response(null,{status});};assert.equal((await read(selected.src,post,pageUrl)).status,status);assert.equal(requests,1,'No HTML fallback after auth/rate failure');}
  f.s.chrome.scripting.executeScript=async()=>[{result:{status:503,route:'post_html'}}];
  const serverFailure=await f.s.resolveZerochanPageOriginal({srcUrl:selected.src,pageUrl,linkUrl:post,tabId:1});assert.equal(serverFailure.error,'NETWORK_ERROR');assert.equal(serverFailure._verificationStatus,503,'Observed server503 survives worker diagnostic');
  console.log('PASS: Zerochan session-backed original PNG resolution/export, metadata failure refusal and genuine original AVIF');
})().catch(error => { console.error(error); process.exitCode = 1; });
