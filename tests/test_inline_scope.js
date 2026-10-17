'use strict';
// Inline download scope and context-menu attribution. Layout, trusted input, network and export are simulated.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),{createRequire}=require('module');
const ROOT=path.resolve(__dirname,'..'),{JSDOM}=createRequire(path.join(ROOT,'ui/package.json'))('jsdom');
const {createTestEnv}=require('./test_context_target_avatar');
const code=p=>fs.readFileSync(path.join(ROOT,p),'utf8'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}
function build({url='https://gallery.example/post/1',html='<article><img id="media" src="https://cdn.example/a.gif?signature=EXACT%2B"></article>'}={}) {
  const {bgSandbox:s}=createTestEnv(),dom=new JSDOM(html,{url,runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,d=w.document;
  const listeners=[],sent=[],rects=new WeakMap(),p={w,d,s,sent,fetched:[],exported:[],exports:[],proofs:0};
  for(const el of d.querySelectorAll('img,video')){
    rects.set(el,{left:100,top:100,width:400,height:300});
    Object.defineProperty(el,'currentSrc',{configurable:true,get(){return this.getAttribute('src') || '';}});
    if(el.tagName==='IMG'){Object.defineProperty(el,'complete',{value:true});Object.defineProperty(el,'naturalWidth',{value:800});}
  }
  w.Element.prototype.getBoundingClientRect=function(){const b=rects.get(this)||{left:0,top:0,width:0,height:0};return {...b,right:b.left+b.width,bottom:b.top+b.height};};
  const stack=(x,y)=>[...d.querySelectorAll('*')].filter(el=>{const b=el.getBoundingClientRect();return b.width && x>=b.left && x<=b.right && y>=b.top && y<=b.bottom;}).reverse();
  d.elementsFromPoint=stack;d.elementFromPoint=(x,y)=>stack(x,y)[0]||null;
  const wrappers=new WeakMap(),add=w.EventTarget.prototype.addEventListener,remove=w.EventTarget.prototype.removeEventListener;
  w.EventTarget.prototype.addEventListener=function(type,fn,opts){if(!wrappers.has(fn))wrappers.set(fn,e=>fn(new Proxy(e,{get:(t,k)=>k==='isTrusted'?t.testTrusted===true:typeof t[k]==='function'?t[k].bind(t):t[k]})));return add.call(this,type,wrappers.get(fn),opts);};
  w.EventTarget.prototype.removeEventListener=function(type,fn,opts){return remove.call(this,type,wrappers.get(fn)||fn,opts);};
  w.chrome={runtime:{id:s.chrome.runtime.id,onMessage:{addListener:fn=>listeners.push(fn),removeListener:fn=>{const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);}},sendMessage:async msg=>{
    sent.push(msg);for(const fn of s.chrome.runtime.onMessage._listeners)fn(msg,{id:s.chrome.runtime.id,tab:{id:1,url:w.location.href},frameId:0,documentId:'doc-scope',url:w.location.href},()=>{});
  }},storage:{local:{get:async()=>({uiLanguage:'en'})},onChanged:{addListener(){}}},i18n:{getUILanguage:()=> 'en'}};
  s.chrome.tabs.sendMessage=async(id,msg,opts)=>{
    p.proofs++;assert.equal(id,1);assert.equal(opts.frameId,0);if(opts.documentId)assert.equal(opts.documentId,'doc-scope');
    return new Promise(resolve=>{let answered=false;for(const fn of listeners)fn(msg,{id:s.chrome.runtime.id},v=>{answered=true;resolve(v);});if(!answered)resolve(undefined);});
  };
  s.chrome.storage.local.get=async keys=>({...((keys && typeof keys==='object' && !Array.isArray(keys))?keys:{}),instagramAuthorFolders:true,tiktokAuthorFolders:true,folderOrganizationMode:'by_site_and_type'});
  s.TextDecoder=TextDecoder;s.Buffer=Buffer;vm.runInContext('PAWCHIVE_POST_MEDIA_PACE_MS=0',s);
  s.chrome.tabs.get=async id=>({id,url:w.location.href});
  s.chrome.scripting.executeScript=async call=>{
    if(call.target.documentIds && !call.target.documentIds.includes('doc-scope'))throw Error('No document with id');
    return [{result:w.eval('('+call.func+')')(...(call.args||[])),documentId:'doc-scope',frameId:0}];
  };
  const png=fs.readFileSync(path.join(ROOT,'icons/128.png')),mp4=new Uint8Array([0,0,0,0x1c,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,2,0,0x69,0x73,0x6f,0x6d,0x69,0x73,0x6f,0x32,0x6d,0x70,0x34,0x31]);
  s.fetch=async(raw,o={})=>{p.fetched.push(raw);const video=/\.mp4(\?|$)/.test(raw);if(/^https:\/\/cdn\.example\//.test(raw))return new Response(o.method==='HEAD'?null:video?mp4:png,{headers:{'content-type':video?'video/mp4':'image/png','content-length':String(video?mp4.length:png.length)}});return new Response('missing',{status:404});};
  s.managedDownload=async options=>{const r=await s.fetch(options.url,{method:'GET'});if(!r.ok)throw Error('HTTP_ERROR');p.exported.push(options.url);p.exports.push(options);return s.chrome.downloads.download(options);};
  w.eval(code('lib/debug_journal.js'));w.eval(code('lib/i18n.js'));w.eval(code('lib/sites.js'));
  p.inject=()=>w.eval(code('content/content_inline.js'));p.inject();w.eval(code('content/content_context_target.js'));
  p.media=()=>d.getElementById('media');
  p.hover=async()=>{d.dispatchEvent(new w.MouseEvent('pointermove',{clientX:200,clientY:200,bubbles:true}));await sleep(100);};
  p.capture=()=>{for(const type of ['mousedown','contextmenu']){const e=new w.MouseEvent(type,{bubbles:true,cancelable:true,button:2,clientX:200,clientY:200});e.testTrusted=true;p.media().dispatchEvent(e);}};
  p.save=async()=>{
    p.capture();const info={menuItemId:'save-image-item',srcUrl:p.media().currentSrc,pageUrl:w.location.href,frameId:0,mediaType:p.media().tagName==='VIDEO'?'video':'image'},tab={id:1,url:w.location.href};
    await s.onContextMenuClicked(info,tab);
    for(let i=0;i<150 && !p.exported.length;i++)await sleep(10);
    const author=await s.selectedMediaAuthor(info,tab,info.srcUrl);
    return {author,path:p.exports.at(-1)?.filename || ''};
  };
  p.close=()=>{w.__medialatchInline?.teardown();w.close();};return p;
}
(async()=>{
  await test('manifest limits inline downloads to tested services, with metadata-only helpers for Instagram/TikTok',async()=>{
    const m=JSON.parse(code('manifest.json')),e=m.content_scripts.filter(e=>e.js.includes('content/content_inline.js'));
    assert.equal(e.length,1);assert.deepEqual(e[0].matches,[
      'https://x.com/*','https://twitter.com/*','https://www.pixiv.net/*','https://*.reddit.com/*','https://reddit.com/*',
      'https://www.redgifs.com/*','https://vk.ru/*','https://vk.com/*',
      'https://*.instagram.com/*','https://instagram.com/*','https://*.tiktok.com/*','https://tiktok.com/*'
    ]);assert(!e[0].all_frames);assert(!m.permissions.includes('nativeMessaging'));
    assert(m.content_scripts.some(e=>e.js.includes('content/content_context_target.js')&&e.matches.includes('https://*/*')),'ordinary context menu stays universal');
  });
  const pages=['https://gallery.example/','http://gallery.example/','https://www.instagram.com/','https://www.tiktok.com/','https://www.youtube.com/',
    'https://x.com.evil.example/','https://twitter.com.evil.example/','https://reddit.com.evil.example/','https://redgifs.com.evil.example/','https://pixiv.net.evil.example/','https://vk.ru.evil.example/'];
  for(const url of pages)await test('dynamic injection creates no download button on '+new URL(url).host,async()=>{
    const p=build({url});await p.hover();assert(!p.d.querySelector('[data-image-saver-inline]'));assert(!p.w.__medialatchInline.generic);assert.equal(p.sent.length,0);
    p.inject();await p.hover();assert(!p.d.querySelector('[data-image-saver-inline]'));p.close();
  });
  for(const url of ['https://gallery.example/','https://reddit.com.evil.example/','http://www.reddit.com/'])await test('Reddit fallback injection cannot enable controls on '+url,async()=>{
    const p=build({url,html:'<article id="t3_scope"><a href="https://www.reddit.com/comments/scope/">post</a><img id="media" src="https://i.redd.it/scope.jpg"></article>'});
    p.w.eval(code('content/content_reddit.js'));p.inject();await p.hover();
    assert(!p.w.__medialatchInline.reddit,'provider helpers do not grant inline host authority');
    assert(!p.d.querySelector('[data-image-saver-inline]'));p.close();
  });
  await test('X fallback injection cannot enable controls on an unrelated host',async()=>{
    const p=build();p.w.eval(code('content/content_copy_kit.js'));p.w.eval(code('content/content_x.js'));p.inject();await p.hover();
    assert(!p.w.__medialatchInline.x);assert(!p.d.querySelector('[data-image-saver-inline]'));p.close();
  });
  for(const [url,site,script] of [['https://x.com/','x','content/content_x.js'],['https://www.reddit.com/','reddit','content/content_reddit.js'],['https://www.redgifs.com/watch/scope','redgifs','content/content_redgifs.js']])await test('fallback injection in a child frame cannot enable '+site+' inline controls',async()=>{
    const dom=new JSDOM('<iframe src="'+url+'"></iframe>',{url:'https://embedder.example/',runScripts:'outside-only'}),w=dom.window.document.querySelector('iframe').contentWindow;
    const s=createTestEnv().bgSandbox;
    w.chrome={runtime:{id:s.chrome.runtime.id,onMessage:{addListener(){},removeListener(){}},sendMessage:async()=>{}},storage:{local:{get:async()=>({})},onChanged:{addListener(){}}},i18n:{getUILanguage:()=> 'en'}};
    try {
      w.eval(code('lib/debug_journal.js'));w.eval(code('lib/i18n.js'));w.eval(code('content/content_copy_kit.js'));w.eval(code(script));w.eval(code('content/content_inline.js'));
      assert(!w.__medialatchInline[site],'inline downloads belong only to the tested top-frame surface');
    } finally {w.__medialatchInline?.teardown();dom.window.close();}
  });
  for(const html of ['<video id="media" src="https://cdn.example/a.mp4"></video>','<video id="media"><source src="https://cdn.example/a.webm"></video>','<div id="media" style="background-image:url(https://cdn.example/a.png)"></div>'])await test('unrelated video/source/CSS pages have no inline control',async()=>{
    const p=build({html});await p.hover();assert(!p.d.querySelector('[data-image-saver-inline]'));assert.equal(p.sent.length,0);p.close();
  });
  await test('an old generic inline message cannot enter the save pipeline',async()=>{
    const p=build();let admitted=0;p.s.onContextMenuClicked=async()=>admitted++;
    p.s.chrome.tabs.sendMessage=async()=>{p.proofs++;return {ok:true,media:{kind:'image',url:'https://cdn.example/a.png'}};};
    await p.w.chrome.runtime.sendMessage({action:'GENERIC_INLINE_SAVE',token:'a'.repeat(32)});await sleep(100);
    assert.equal(admitted,0);assert.equal(p.proofs,0);assert.deepEqual(p.fetched,[]);assert.deepEqual(p.exported,[]);p.close();
  });
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
  const attributed=[
    ['an Instagram carousel page next to text comments','https://www.instagram.com/','<article><header><a href="/actualowner/">Owner</a><a href="/p/Post/">time</a></header><div><ul><li><img id="media" src="https://cdn.example/one.jpg"></li><li><img src="https://cdn.example/two.jpg"></li></ul></div><div role="comment"><span>Commenter</span> nice</div></article>'],
    ['the TikTok post video next to a plain-text reply','https://www.tiktok.com/','<article><a href="/@actualowner/video/123456">post</a><video id="media" src="https://cdn.example/post.mp4"></video><div data-e2e="comment-item"><span>Commenter</span> nice</div></article>']
  ];

  for(const [name,url,html] of unattributed)await test(name+' keeps ordinary folders through the real context-menu pipeline',async()=>{
    const p=build({url,html});assert.equal(p.w.__medialatchInline.authorSnapshot(p.media()),null);
    const result=await p.save();assert.equal(p.exported.length,1);assert.equal(result.author,null);assert(!/actualowner|commenter|replier|someoneelse/i.test(result.path),result.path);p.close();
  });
  for(const [name,url,html] of attributed)await test(name+' keeps its proven author without an inline button',async()=>{
    const p=build({url,html});assert.equal(p.w.__medialatchInline.authorSnapshot(p.media())?.author.id,'actualowner');
    const result=await p.save();assert.equal(p.exported.length,1);assert.equal(result.author.id,'actualowner');assert(result.path.includes('/actualowner/'),result.path);p.close();
  });
  for(const [kind,html,url] of [
    ['image','<img id="media" src="https://cdn.example/B.png?sig=EXACT%2B">','https://cdn.example/B.png?sig=EXACT%2B'],
    ['GIF','<img id="media" src="https://cdn.example/a.gif?signature=EXACT%2B">','https://cdn.example/a.gif?signature=EXACT%2B'],
    ['video','<video id="media" src="https://cdn.example/clip.mp4?sig=EXACT%2B"></video>','https://cdn.example/clip.mp4?sig=EXACT%2B']
  ])await test('ordinary context menu still saves the selected exact '+kind+' URL',async()=>{
    const p=build({html});await p.save();assert.deepEqual(p.exported,[url]);assert(p.fetched.includes(url));p.close();
  });
  await test('changed media after the right-click refuses before any request/export',async()=>{
    const p=build();p.capture();const src=p.media().currentSrc;p.media().src='https://cdn.example/replaced.png';
    await p.s.onContextMenuClicked({menuItemId:'save-image-item',srcUrl:src,pageUrl:p.w.location.href,frameId:0,mediaType:'image'},{id:1,url:p.w.location.href});
    assert.deepEqual(p.fetched,[]);assert.deepEqual(p.exported,[]);p.close();
  });
  console.log(passed+' inline-scope/context-menu checks passed; simulated layout/input/network/export only');
})().catch(e=>{console.error(e);process.exitCode=1;});
