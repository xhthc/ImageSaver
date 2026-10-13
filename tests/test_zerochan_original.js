'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createTestEnv, createMockElement, simulateGesture } = require('./test_context_target_avatar');

const cases = [
  { id: '4731293', src: 'https://s3.zerochan.net/240/43/25/4731293.avif', full: 'https://static.zerochan.net/Izayoi.Nonomi.full.4731293.png', size: 2582528 },
  { id: '4730884', src: 'https://s3.zerochan.net/240/34/17/4730884.avif', full: 'https://static.zerochan.net/Silver.Wolf.LV.999.full.4730884.png', size: 14210048 }
];
function fixture(selected, unavailable = false) {
  const env = createTestEnv(), s = env.bgSandbox, calls = [];
  s.console.info = () => {};
  // the harness frame answers no script (createTestEnv's executeScript gives []): the unscriptable, never-admitted frame keeps the extension route
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
  f.s.resolveContextOwner=async()=>'proven';
  f.s.chrome.scripting.executeScript=async options=>options.func.name==='readZerochanOriginal'?[{result:{id:selected.id,url:selected.full,status:200}}]:[];
  assert.equal((await f.s.resolveOriginalMediaPlan({srcUrl:selected.src,pageUrl,linkUrl:post,tabId:1,frameId:0})).primaryUrl,selected.full,'Pinned page session recovers an original when extension metadata request is blocked');
  f.s.chrome.scripting.executeScript=async()=>[{result:{id:selected.id,url:selected.full.replace(selected.id,'9999999'),status:200}}];
  assert.equal((await f.s.resolveZerochanPageOriginal({srcUrl:selected.src,pageUrl,linkUrl:post,tabId:1})).error,'NO_MEDIA','A page reply cannot inject a neighboring original');
  const owner={href:post},image={src:selected.src,currentSrc:selected.src,isConnected:true,closest:()=>owner},calls=[];
  const context={URL,AbortController,TextDecoder,Uint8Array,setTimeout,clearTimeout,location:{href:pageUrl,origin:'https://www.zerochan.net'},document:{images:[image]},fetch:async(url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify({id:Number(selected.id),full:selected.full}),{headers:{'content-type':'application/json'}});}};
  vm.createContext(context);vm.runInContext('('+f.s.readZerochanOriginal.toString()+')',context);
  const read=vm.runInContext('('+f.s.readZerochanOriginal.toString()+')',context);
  assert.equal((await read(selected.src,post,pageUrl)).url,selected.full);assert.equal(calls[0].opts.credentials,'same-origin');assert.equal(calls[0].url,post+'?json');
  // UNIVERSAL-SELECTION-SNAPSHOT-01: the post id is fixed when the read starts; a recycled or unloaded image afterwards keeps the admitted post's
  // original, and a reply about any other post is still refused
  context.fetch=async()=>{image.currentSrc='https://example.com/other.png';image.isConnected=false;return new Response(JSON.stringify({id:Number(selected.id),full:selected.full}),{headers:{'content-type':'application/json'}});};
  assert.equal((await read(selected.src,post,pageUrl)).url,selected.full,'The image recycled during metadata lookup keeps the admitted original');
  context.fetch=async()=>{image.currentSrc='https://example.com/other.png';return new Response(JSON.stringify({id:9999999,full:selected.full.replace(selected.id,'9999999')}),{headers:{'content-type':'application/json'}});};
  assert.equal((await read(selected.src,post,pageUrl)).error,'NO_MEDIA','A reply about another post is refused');image.currentSrc=selected.src;image.isConnected=true;
  context.fetch=async()=>{context.location.href='https://www.zerochan.net/?p=2';return new Response(JSON.stringify({id:Number(selected.id),full:selected.full}),{headers:{'content-type':'application/json'}});};
  assert.equal((await read(selected.src,post,pageUrl)).error,'NO_MEDIA','A navigation during the lookup refuses the reply');context.location.href=pageUrl;
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
  let requests=0;calls.length=0;context.fetch=async(url,opts)=>{requests++;calls.push({url,opts});if(url.endsWith('?json')){image.currentSrc='changed';return new Response(null,{status:503});}return new Response(html,{headers:{'content-type':'text/html'}});};
  const recycled=await read(selected.src,post,pageUrl);assert.equal(recycled.url,selected.full);assert.equal(requests,2);assert.equal(calls[1].url,post,'A selection changed after its id was fixed asks only the admitted post');image.currentSrc=selected.src;
  context.fetch=async()=>new Response('Checking browser...',{status:503});const blocked=await read(selected.src,post,pageUrl);assert.equal(blocked.status,503);assert.equal(blocked.route,'post_html','A blocked HTML response stays a failure, never executes challenge HTML');
  for(const status of [401,403,429]){requests=0;context.fetch=async()=>{requests++;return new Response(null,{status});};assert.equal((await read(selected.src,post,pageUrl)).status,status);assert.equal(requests,1,'No HTML fallback after auth/rate failure');}
  f.s.chrome.scripting.executeScript=async()=>[{result:{status:503,route:'post_html'}}];
  const serverFailure=await f.s.resolveZerochanPageOriginal({srcUrl:selected.src,pageUrl,linkUrl:post,tabId:1});assert.equal(serverFailure.error,'NETWORK_ERROR');assert.equal(serverFailure._verificationStatus,503,'Observed server503 survives worker diagnostic');
  // UNIVERSAL-SELECTION-SNAPSHOT-01, production path: real gesture capture and verifyContextOwner, the real reader in the page VM and the handler's
  // export. The preview admitted before the page lookup may be removed or recycled during it; every unadmitted or contradicted case fetches/exports nothing.
  async function connected({ before, during, afterProof, reader, click = {}, reply = { id: Number(selected.id), full: selected.full } } = {}) {
    const env = createTestEnv(), s = env.bgSandbox, anchor = createMockElement('a', { href: post }), image = createMockElement('img', { parent: anchor, src: selected.src });
    image.closest = sel => (sel === 'a[href]' || sel === 'a' ? anchor : null);
    const doc = { images: [image], hidden: false, elementsFromPoint: () => (image.isConnected ? [image, anchor] : []), querySelectorAll: () => (image.isConnected ? [image, anchor] : []), querySelector: () => null };
    const { world } = simulateGesture(doc, image), page = { image, world, document: 'admitted', proofs: [], requests: [] };
    Object.assign(world, { URL, Response, AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout, location: { href: pageUrl, origin: 'https://www.zerochan.net' } });
    world.fetch = async url => { page.requests.push(url); during?.(page); return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } }); };
    s.console.info = () => {};
    // Chrome's documentIds target rejects a document that is gone; reader: 'reject' (frame lost during the read), 'absent' (no InjectionResult), 'empty' (no result)
    s.chrome.scripting.executeScript = async call => {
      if (page.unscriptable) return [];
      if (call.target.documentIds && !call.target.documentIds.includes(page.document)) throw Error('No document with id ' + call.target.documentIds[0]);
      const result = await vm.runInContext('(' + call.func + ')', world)(...(call.args || []));
      if (call.func.name === 'verifyContextOwner') { page.proofs.push(result); const documentId = page.document; afterProof?.(page); return [{ result, documentId }]; }
      if (call.func.name === 'readZerochanOriginal' && reader === 'reject') throw Error('Frame removed during lookup');
      if (call.func.name === 'readZerochanOriginal' && reader === 'absent') return [];
      return [{ result: call.func.name === 'readZerochanOriginal' && reader === 'empty' ? undefined : result, documentId: page.document }];
    };
    const probes = [];
    // the extension's own id-bound route answers too: a refused or unproven page route must not fall through to it
    s.fetch = async (url, options = {}) => { probes.push(url); if (url.endsWith('?json')) return new Response(JSON.stringify({ id: Number(selected.id), full: selected.full }), { headers: { 'content-type': 'application/json' } }); return url === selected.full ? new Response(null, { headers: { 'content-type': 'image/png', 'content-length': String(selected.size) } }) : new Response(null, { status: 404 }); };
    before?.(page);
    await s.onContextMenuClicked({ menuItemId: 'save-image-item', srcUrl: selected.src, pageUrl, linkUrl: post, mediaType: 'image', frameId: 0, ...click }, { id: 1, url: pageUrl });
    return { page, probes, exports: env.downloadedCalls.map(x => x.url) };
  }
  for (const [name, during] of Object.entries({ ordinary: null, removed: p => { p.image.isConnected = false; }, recycled: p => { p.image.src = p.image.currentSrc = 'https://s3.zerochan.net/240/43/25/9999999.avif'; } })) {
    const r = await connected({ during });
    assert.deepEqual(r.page.proofs, ['proven', 'proven'], name + ': entry admission, then admission before the page lookup only');
    assert.equal(r.page.requests.length, 1);assert.deepEqual(r.exports, [selected.full], name + ': the admitted post original reaches the export');
  }
  const negatives = {
    'changed before the click': { before: p => { p.image.isConnected = false; } },
    'recycled before the click': { before: p => { p.image.src = p.image.currentSrc = 'https://s3.zerochan.net/240/43/25/9999999.avif'; } },
    'no capture (unproven)': { before: p => { p.world.__imageSaverContextTarget = undefined; } },
    'forged source claim': { click: { srcUrl: 'https://s3.zerochan.net/240/43/25/9999999.avif', linkUrl: 'https://www.zerochan.net/9999999' } },
    'replaced document during lookup': { during: p => { p.image.isConnected = false; p.document = 'replaced'; }, requests: 1 },
    'navigation during lookup': { during: p => { p.image.isConnected = false; p.world.location.href = pageUrl + '?p=2'; }, requests: 1 },
    'other post reply': { reply: { id: 9999999, full: selected.full.replace(selected.id, '9999999') }, during: p => { p.image.isConnected = false; }, requests: 1 },
    'other original for this id': { reply: { id: Number(selected.id), full: selected.full.replace(selected.id, '9999999') }, requests: 1 },
    // after a proven admission a failed read is a refusal: the extension ?json route (ready to answer here) is never asked
    'admitted read rejected (document lost)': { during: p => { p.image.isConnected = false; p.document = 'replaced'; }, reader: 'reject', requests: 1 },
    'admitted read rejected, same document': { reader: 'reject', requests: 1 },
    'admitted read without InjectionResult': { reader: 'absent', requests: 1 },
    'admitted read with empty result': { reader: 'empty', requests: 1 },
    'document replaced after admission (pinned read)': { afterProof: p => { if (p.proofs.length === 2) p.document = 'replaced'; } }
  };
  for (const [name, c] of Object.entries(negatives)) {
    const r = await connected(c);
    assert.equal(r.page.requests.length, c.requests || 0, name + ': page metadata requests');
    assert(!r.probes.some(url => /static.zerochan.net/.test(url)), name + ': no original probe');assert.deepEqual(r.exports, [], name + ': no export');
    assert(!r.probes.some(url => url.endsWith('?json')), name + ': no extension metadata request');
  }
  // a frame that never answers a script (nothing admitted, no document) keeps the pre-existing id-bound extension route
  const legacy = await connected({ before: p => { p.unscriptable = true; } });
  assert.deepEqual(legacy.page.requests, []);assert.equal(legacy.probes.filter(url => url.endsWith('?json')).length, 1);
  assert.deepEqual(legacy.exports, [selected.full], 'Unscriptable frame before admission: the extension route still saves the original');
  console.log('PASS: Zerochan session-backed original PNG resolution/export, metadata failure refusal and genuine original AVIF');
})().catch(error => { console.error(error); process.exitCode = 1; });
