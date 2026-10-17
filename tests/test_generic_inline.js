'use strict';
// Production inline control -> authenticated worker route. Layout/trusted input are simulated; no live-site claim.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),{createRequire}=require('module');
const ROOT=path.resolve(__dirname,'..'),{JSDOM}=createRequire(path.join(ROOT,'ui/package.json'))('jsdom');
const {createTestEnv}=require('./test_context_target_avatar');
const code=p=>fs.readFileSync(path.join(ROOT,p),'utf8'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
let passed=0;
function build({url='https://gallery.example/post/1',html='<article><img id="media" src="https://cdn.example/a.gif?signature=EXACT%2B"></article>',real=false}={}) {
  const env=createTestEnv(),s=env.bgSandbox,dom=new JSDOM(html,{url,runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,d=w.document;
  const listeners=[],sent=[],saved=[],shadows=new WeakMap(),rects=new WeakMap();
  const p={w,d,s,sent,saved,listeners,hook:null,sender:null};
  for(const el of d.querySelectorAll('img,video')){
    rects.set(el,{left:100,top:100,width:400,height:300});
    Object.defineProperty(el,'currentSrc',{configurable:true,get(){return this.getAttribute('src') || '';}});
    if(el.tagName==='IMG'){Object.defineProperty(el,'complete',{value:true});Object.defineProperty(el,'naturalWidth',{value:800});}
  }
  w.Element.prototype.getBoundingClientRect=function(){const b=this.hasAttribute('data-image-saver-inline')?{left:parseFloat(this.style.left),top:parseFloat(this.style.top),width:parseFloat(this.style.width),height:parseFloat(this.style.height)}:rects.get(this) || {left:0,top:0,width:0,height:0};return {...b,right:b.left+b.width,bottom:b.top+b.height};};
  const stack=(x,y)=>[...d.querySelectorAll('*')].filter(el=>{const b=el.getBoundingClientRect();return b.width && x>=b.left && x<=b.right && y>=b.top && y<=b.bottom;}).reverse();
  d.elementsFromPoint=stack;d.elementFromPoint=(x,y)=>stack(x,y)[0] || null;
  const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(init){const root=attach.call(this,init);shadows.set(this,root);return root;};
  const wrappers=new WeakMap(),add=w.EventTarget.prototype.addEventListener,remove=w.EventTarget.prototype.removeEventListener;
  w.EventTarget.prototype.addEventListener=function(type,fn,opts){if(!wrappers.has(fn))wrappers.set(fn,e=>fn(new Proxy(e,{get:(t,k)=>k==='isTrusted'?t.testTrusted===true:typeof t[k]==='function'?t[k].bind(t):t[k]})));return add.call(this,type,wrappers.get(fn),opts);};
  w.EventTarget.prototype.removeEventListener=function(type,fn,opts){return remove.call(this,type,wrappers.get(fn)||fn,opts);};
  w.chrome={runtime:{id:s.chrome.runtime.id,onMessage:{addListener:fn=>listeners.push(fn),removeListener:fn=>{const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);}},sendMessage:async msg=>{sent.push(msg);const sender={id:s.chrome.runtime.id,tab:{id:1,active:true,url:w.location.href},frameId:0,documentId:'doc-generic',url:w.location.href,...p.sender};for(const fn of s.chrome.runtime.onMessage._listeners)fn(msg,sender,()=>{});}},storage:{local:{get:async()=>({uiLanguage:'en'})},onChanged:{addListener(){}}},i18n:{getUILanguage:()=> 'en'}};
  s.chrome.tabs.sendMessage=async(id,msg,opts)=>{
    assert.equal(id,1);if(opts.frameId!==0 || opts.documentId!=='doc-generic')throw Error('Could not establish connection. Receiving end does not exist.');if(p.hook)p.hook(msg);
    return new Promise(resolve=>{let answered=false;for(const fn of listeners)fn(msg,{id:s.chrome.runtime.id},v=>{answered=true;resolve(v);});if(!answered)resolve(undefined);});
  };
  if(real){
    // REFACTOR-CHROME-API-01 (audit finding 5): the REAL resolution/admission pipeline; only the network and the export are stand-ins
    const png=fs.readFileSync(path.join(ROOT,'icons/128.png')),mp4=new Uint8Array([0,0,0,0x1c,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,2,0,0x69,0x73,0x6f,0x6d,0x69,0x73,0x6f,0x32,0x6d,0x70,0x34,0x31]);
    Object.assign(p,{fetched:[],exported:[],infos:[],ownerChecks:0});
    s.TextDecoder=TextDecoder;s.Buffer=Buffer;vm.runInContext('PAWCHIVE_POST_MEDIA_PACE_MS=0',s);
    s.chrome.tabs.get=async id=>({id,url:w.location.href});
    s.chrome.scripting.executeScript=async call=>{if(call.target.documentIds && !call.target.documentIds.includes('doc-generic'))throw Error('No document with id');return [{result:w.eval('('+call.func+')')(...(call.args||[])),documentId:'doc-generic'}];};
    s.resolveContextOwner=async()=>{p.ownerChecks++;return 'refused';}; // a context-menu capture must never decide an inline save
    s.fetch=async(raw,o={})=>{p.fetched.push(raw);if(/\.mp4(\?|$)/.test(raw))return new Response(o.method==='HEAD'?null:mp4,{headers:{'content-type':'video/mp4','content-length':String(mp4.length)}});if(/^https:\/\/cdn\.example\//.test(raw))return new Response(o.method==='HEAD'?null:png,{headers:{'content-type':'image/png','content-length':String(png.length)}});return new Response('missing',{status:404});};
    s.managedDownload=async options=>{const r=await s.fetch(options.url,{method:'GET'});if(!r.ok)throw Error('HTTP_ERROR');p.exported.push(options.url);return s.chrome.downloads.download(options);};
    const actual=s.onContextMenuClicked;s.onContextMenuClicked=async(info,tab)=>{p.infos.push(info);return actual(info,tab);};
  } else s.onContextMenuClicked=async(info,tab)=>{s.selectedInfo=info;assert.equal(vm.runInContext("viaInline(selectedInfo, 'generic')",s),true);const author=await s.selectedMediaAuthor(info,tab,info.srcUrl);saved.push({info,author,path:s.resolveDownloadPath({filename:'file.jpg',pageUrl:info.pageUrl,folderOrganizationMode:'by_site_and_type',author:author?s.authorFolder(author.site,author.name,author.id):null})});};
  w.eval(code('lib/i18n.js'));w.eval(code('lib/sites.js'));p.inject=()=>w.eval(code('content/content_inline.js'));p.inject();
  p.media=()=>d.getElementById('media');p.host=()=>d.querySelector('[data-image-saver-inline="generic"]');p.button=()=>shadows.get(p.host())?.querySelector('button');p.rects=rects;
  p.hover=async()=>{d.dispatchEvent(new w.MouseEvent('pointermove',{clientX:200,clientY:200,bubbles:true}));await sleep(90);};
  p.click=(trusted=true)=>{const e=new w.MouseEvent('click',{bubbles:true,cancelable:true});e.testTrusted=trusted;p.button().dispatchEvent(e);};
  p.close=()=>{w.__medialatchInline?.teardown();w.close();};
  return p;
}
async function test(name,run){await run();passed++;console.log('PASS '+name);}
(async()=>{
  await test('all http(s) sites use one shared top-frame script with existing permissions',async()=>{const m=JSON.parse(code('manifest.json')),e=m.content_scripts.filter(e=>e.js.includes('content/content_inline.js'));assert.equal(e.length,1);assert(e[0].matches.includes('http://*/*') && e[0].matches.includes('https://*/*'));assert(!e[0].all_frames);assert(!m.permissions.includes('nativeMessaging'));});
  for(const [kind,html,expected] of [['GIF','<article><img id="media" src="https://cdn.example/a.gif?sig=EXACT%2B"></article>','image'],['video','<article><video id="media" src="https://cdn.example/a.mp4?sig=EXACT%2B"></video></article>','video'],['source','<article><video id="media"><source src="https://cdn.example/a.webm?sig=EXACT%2B"></video></article>','video']])await test(kind+' first trusted click preserves exact source and uses the private admitted route',async()=>{const p=build({html});await p.hover();assert(p.button());assert.equal(p.sent.length,0);p.click(false);await sleep(20);assert.equal(p.sent.length,0);p.click();await sleep(80);assert.equal(p.saved.length,1);assert.equal(p.saved[0].info.mediaType,expected);assert(p.saved[0].info.srcUrl.endsWith('?sig=EXACT%2B'));assert.equal(p.saved[0].author,null);p.close();});
  for(const [name,change] of [['source',p=>p.media().src='https://cdn.example/replaced.jpg'],['detached',p=>p.media().remove()],['reparented',p=>p.d.body.append(p.media())],['navigated',p=>p.w.history.pushState(null,'','/post/2')]])await test(name+' between click and proof refuses before pipeline admission',async()=>{const p=build();await p.hover();p.hook=()=>change(p);p.click();await sleep(80);assert.equal(p.saved.length,0);p.close();});
  await test('proof token is consumed once',async()=>{const p=build();await p.hover();p.click();await sleep(80);const token=p.sent[0].token;let reply;for(const fn of p.listeners)fn({action:'GENERIC_INLINE_OWNER',token},{id:p.s.chrome.runtime.id},r=>reply=r);assert.equal(reply.ok,false);assert.equal(p.saved.length,1);p.close();});
  for(const url of ['https://www.instagram.com/p/PageA/','https://www.tiktok.com/@page/video/123456'])await test('author belongs to selected '+new URL(url).hostname+' card, never the page account',async()=>{const instagram=url.includes('instagram');const html=instagram?'<article><header><a href="/ActualOwner/">Owner</a></header><a href="/p/SelectedB/">post</a><img id="media" src="https://cdn.example/photo.jpg"></article>':'<article><a href="/@ActualOwner/video/654321">post</a><a href="/@commenter">commenter</a><video id="media" src="https://cdn.example/video.mp4"></video></article>';const p=build({url,html});await p.hover();p.click();await sleep(80);assert.equal(p.saved[0].author.id,'actualowner');assert(p.saved[0].path.includes('/actualowner/'));p.close();});
  await test('ambiguous Instagram accounts use normal layout',async()=>{const p=build({url:'https://www.instagram.com/',html:'<article><header><a href="/one/">one</a><a href="/two/">two</a></header><a href="/p/Unique/">post</a><img id="media" src="https://cdn.example/photo.jpg"></article>'});await p.hover();p.click();await sleep(80);assert.equal(p.saved[0].author,null);p.close();});
  for(const src of ['blob:https://gallery.example/id','https://cdn.example/list.m3u8?sig=exact','https://cdn.example/list.MPD'])await test(src.split(':')[0]+' non-direct player is not offered as a generic file',async()=>{const p=build({html:'<video id="media" src="'+src+'"></video>'});await p.hover();assert(!p.host());p.close();});
  for(const url of ['https://x.com/','https://www.reddit.com/','https://www.redgifs.com/ifr/clip','https://www.pixiv.net/','https://vk.ru/'])await test('generic fallback does not replace '+new URL(url).hostname+' ownership',async()=>{const p=build({url});assert(!p.w.__medialatchInline.generic);p.close();});
  await test('tiny/decorative media is skipped',async()=>{const p=build();p.rects.set(p.media(),{left:100,top:100,width:48,height:48});await p.hover();assert(!p.host());p.close();});
  // REFACTOR-CHROME-API-01 (audit finding 2): a post's account never reaches media that is not the post's own. The media is still saved, with the ordinary layout.
  const unattributed=[
    ['an Instagram comment image','https://www.instagram.com/p/Post/','<article><header><a href="/actualowner/">Owner</a><a href="/p/Post/">time</a></header><ul><li><a href="/commenter/">commenter</a><img id="media" src="https://cdn.example/comment.jpg"></li></ul></article>'],
    ['the Instagram header avatar','https://www.instagram.com/','<article><header><a href="/actualowner/"><img id="media" src="https://cdn.example/avatar.jpg"></a><a href="/p/Post/">time</a></header></article>'],
    ['profile-linked media inside an Instagram post','https://www.instagram.com/','<article><header><a href="/actualowner/">Owner</a></header><a href="/p/Post/">time</a><a href="/someoneelse/"><img id="media" src="https://cdn.example/tagged.jpg"></a></article>'],
    ['a TikTok reply image','https://www.tiktok.com/@actualowner/video/123456','<article><a href="/@actualowner/video/123456">post</a><div data-e2e="comment-item"><a href="/@replier">replier</a><img id="media" src="https://cdn.example/reply.jpg"></div></article>'],
    ['a TikTok avatar link','https://www.tiktok.com/','<article><a href="/@actualowner/video/123456">post</a><a href="/@actualowner"><img id="media" src="https://cdn.example/avatar.jpg"></a></article>'],
    // independent review P2: no profile link is needed to be someone else's comment, reply or quote
    ['an Instagram comment naming its writer in plain text','https://www.instagram.com/p/Main/','<article><header><a href="/actualowner/">owner</a></header><a href="/p/Main/">post</a><div role="comment"><span>Commenter</span><img id="media" src="https://cdn.example/comment.jpg"></div></article>'],
    ['a TikTok reply naming its writer in plain text','https://www.tiktok.com/@actualowner/video/123456','<article><a href="/@actualowner/video/123456">post</a><div data-e2e="comment-item"><span>Commenter</span><img id="media" src="https://cdn.example/reply.jpg"></div></article>'],
    ['an image quoted inside an Instagram post','https://www.instagram.com/p/Main/','<article><header><a href="/actualowner/">owner</a></header><a href="/p/Main/">post</a><blockquote><span>quoted card</span><img id="media" src="https://cdn.example/quoted.jpg"></blockquote></article>'],
    ['an Instagram block in unknown markup that names another writer in plain text','https://www.instagram.com/p/Main/','<article><header><a href="/actualowner/">owner</a></header><a href="/p/Main/">post</a><div><span>Commenter</span><img id="media" src="https://cdn.example/comment.jpg"></div></article>'],
    ['an Instagram block whose writer is named only by an avatar link','https://www.instagram.com/p/Main/','<article><header><a href="/actualowner/">owner</a></header><a href="/p/Main/">post</a><div><a href="/commenter/"><img src="https://cdn.example/avatar.jpg"></a><img id="media" src="https://cdn.example/comment.jpg"></div></article>'],
    ['an Instagram comment without any text or profile link','https://www.instagram.com/p/Main/','<article><header><a href="/actualowner/">owner</a></header><a href="/p/Main/">post</a><div role="comment"><img id="media" src="https://cdn.example/comment.jpg"></div></article>'],
    ['a card nested inside an Instagram post, even without any text','https://www.instagram.com/p/Main/','<article><header><a href="/actualowner/">owner</a></header><a href="/p/Main/">post</a><article><img id="media" src="https://cdn.example/card.jpg"></article></article>'],
    ['a TikTok image that is not the post\'s own video','https://www.tiktok.com/@actualowner/video/123456','<article><a href="/@actualowner/video/123456">post</a><video src="https://cdn.example/post.mp4"></video><div><img id="media" src="https://cdn.example/sticker.jpg"></div></article>']
  ];
  for(const [name,url,html] of unattributed)await test(name+' is saved without the post account (ordinary layout)',async()=>{
    const p=build({url,html});await p.hover();assert(p.host(),'the media itself can still be saved');p.click();await sleep(80);
    assert.equal(p.saved.length,1);assert.equal(p.saved[0].author,null,'no inherited account');assert(!/actualowner|commenter|replier|someoneelse/i.test(p.saved[0].path),p.saved[0].path);p.close();
  });
  await test('the post media of the same Instagram post keeps its account (positive control for the refusals above)',async()=>{
    const p=build({url:'https://www.instagram.com/',html:'<article><header><a href="/actualowner/">Owner</a><a href="/p/Post/">time</a></header><div><img id="media" src="https://cdn.example/post.jpg"></div><ul><li><a href="/commenter/">commenter</a>nice</li></ul></article>'});
    await p.hover();p.click();await sleep(80);assert.equal(p.saved[0].author.id,'actualowner');assert(p.saved[0].path.includes('/actualowner/'),p.saved[0].path);p.close();
  });
  await test('the context-menu capture uses the same refusal: a comment image has no post account',async()=>{
    const p=build({url:'https://www.instagram.com/p/Post/',html:'<article><header><a href="/actualowner/">Owner</a><a href="/p/Post/">time</a></header><ul><li><a href="/commenter/">c</a><img id="media" src="https://cdn.example/comment.jpg"></li></ul></article>'});
    assert.equal(p.w.__medialatchInline.authorSnapshot(p.media()),null);p.close();
  });
  // positive controls for the boundaries above: the post's own attachments keep the account
  const attributed=[
    ['an Instagram carousel page next to text comments','https://www.instagram.com/','<article><header><a href="/actualowner/">Owner</a><a href="/p/Post/">time</a></header><div><ul><li><img id="media" src="https://cdn.example/one.jpg"></li><li><img src="https://cdn.example/two.jpg"></li></ul></div><div role="comment"><span>Commenter</span> nice</div></article>'],
    ['the TikTok post video next to a plain-text reply','https://www.tiktok.com/','<article><a href="/@actualowner/video/123456">post</a><video id="media" src="https://cdn.example/post.mp4"></video><div data-e2e="comment-item"><span>Commenter</span> nice</div></article>']
  ];
  for(const [name,url,html] of attributed)await test(name+' keeps the post account, in the inline save and in the context-menu capture',async()=>{
    const p=build({url,html});assert.equal(p.w.__medialatchInline.authorSnapshot(p.media())?.author.id,'actualowner','context-menu capture');
    await p.hover();p.click();await sleep(80);assert.equal(p.saved[0].author.id,'actualowner');assert(p.saved[0].path.includes('/actualowner/'),p.saved[0].path);p.close();
  });
  await test('the context-menu capture refuses a plain-text comment exactly like the inline save',async()=>{
    const p=build({url:'https://www.instagram.com/p/Main/',html:'<article><header><a href="/actualowner/">owner</a></header><a href="/p/Main/">post</a><div role="comment"><span>Commenter</span><img id="media" src="https://cdn.example/comment.jpg"></div></article>'});
    assert.equal(p.w.__medialatchInline.authorSnapshot(p.media()),null);p.close();
  });
  // ---- the real pipeline (only network and export stubbed) ----
  await test('real pipeline: a stale context-menu capture on image A never redirects the inline save of selected image B (exact signed address, no lookup of A)',async()=>{
    const p=build({real:true,html:'<article><img id="old" src="https://cdn.example/A.png?sig=OLD%2B"><img id="media" src="https://cdn.example/B.png?sig=EXACT%2B"></article>'});
    p.rects.set(p.d.getElementById('old'),{left:600,top:100,width:400,height:300});
    p.w.eval(code('lib/debug_journal.js'));p.w.eval(code('content/content_context_target.js'));
    p.d.getElementById('old').dispatchEvent(new p.w.MouseEvent('contextmenu',{bubbles:true,clientX:700,clientY:200})); // the earlier right-click on A
    await p.hover();p.click();for(let i=0;i<200 && !p.exported.length;i++)await sleep(10);await sleep(60);
    assert.deepEqual(p.exported,['https://cdn.example/B.png?sig=EXACT%2B'],'exactly B, its signed address untouched');
    assert(!p.fetched.some(u=>u.includes('/A.png')),'A was never requested');assert.equal(p.ownerChecks,0,'the context-menu owner gate was not consulted');
    assert.equal(p.infos.length,1);assert.equal(p.infos[0].mediaType,'image');p.close();
  });
  await test('real pipeline: a <video> saves the source the element actually selects, as a video (its own declared file, not another <source>)',async()=>{
    const p=build({real:true,html:'<article><video id="media"><source src="https://cdn.example/clip.webm?sig=SKIP" type="video/webm"><source src="https://cdn.example/clip.mp4?sig=EXACT%2B"></video></article>'});
    await p.hover();p.click();for(let i=0;i<200 && !p.exported.length;i++)await sleep(10);await sleep(60);
    assert.deepEqual(p.exported,['https://cdn.example/clip.mp4?sig=EXACT%2B'],'the source jsdom can play (canPlayType refuses video/webm here)');
    assert.equal(p.infos[0].mediaType,'video');assert(!p.fetched.some(u=>u.includes('clip.webm')));p.close();
  });
  await test('real pipeline: a proof asked of another document, a replayed token and a changed source save nothing and request nothing',async()=>{
    let p=build({real:true});p.sender={documentId:'doc-other'};await p.hover();p.click();await sleep(150);
    assert.deepEqual(p.exported,[]);assert.deepEqual(p.fetched,[]);assert.equal(p.infos.length,0,'a foreign document never reaches the pipeline');p.close();
    p=build({real:true});await p.hover();p.click();for(let i=0;i<200 && !p.exported.length;i++)await sleep(10);
    const token=p.sent[0].token;p.w.chrome.runtime.sendMessage({action:'GENERIC_INLINE_SAVE',token});await sleep(150);
    assert.equal(p.exported.length,1,'a replayed token saves nothing more');p.close();
    p=build({real:true});await p.hover();p.hook=()=>{p.media().src='https://cdn.example/replaced.gif';};p.click();await sleep(150);
    assert.deepEqual(p.exported,[]);assert(!p.fetched.some(u=>u.includes('replaced')));p.close();
  });
  await test('real pipeline: the admitted source is frozen, so a recycled node that now advertises another original is never consulted or fetched',async()=>{
    const p=build({real:true});const run=p.s.chrome.scripting.executeScript;let discovered=false;
    p.s.chrome.scripting.executeScript=async call=>{if(call.func.name==='extractDomImageMetadata'){discovered=true;const old=p.media(),twin=p.d.createElement('img');twin.src=old.getAttribute('src');twin.setAttribute('data-original','https://cdn.example/OTHER.png');old.replaceWith(twin);}return run(call);};
    await p.hover();p.click();for(let i=0;i<200 && !p.exported.length;i++)await sleep(10);await sleep(60);
    assert.deepEqual(p.exported,['https://cdn.example/a.gif?signature=EXACT%2B']);assert.equal(discovered,false,'no late URL-based DOM rediscovery after admission');assert(!p.fetched.some(u=>u.includes('OTHER')));p.close();
  });
  console.log(passed+' generic inline checks passed; simulated layout/input only');
})().catch(e=>{console.error(e);process.exitCode=1;});