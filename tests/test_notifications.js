// Production page renderer in jsdom; actual Chrome delivery/layout is separately exercised in native fixtures.
const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const {JSDOM}=createRequire(path.join(REPO_ROOT,'ui/package.json'))('jsdom');
const source=fs.readFileSync(path.join(REPO_ROOT,'content/content_notifications.js'),'utf8');
const dom=new JSDOM('<button id="page-button">Page</button>',{url:'https://example.com/gallery',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,roots=[],listeners=[],storage=[],sent=[],timers=new Map();let seq=0,clock=1000,hidden=false,openOK=false,openGate=null;
const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(o){const r=attach.call(this,o);roots.push(r);return r;};
Object.defineProperty(w.document,'hidden',{get:()=>hidden});w.Date.now=()=>clock;
w.setTimeout=(fn,delay)=>{const id=++seq;timers.set(id,{fn,time:clock+delay});return id;};w.clearTimeout=id=>timers.delete(id);
w.chrome={runtime:{id:'testid',onMessage:{addListener:f=>listeners.push(f)},sendMessage:async m=>{sent.push(m);if(openGate)await openGate;return {success:openOK};}},storage:{onChanged:{addListener:f=>storage.push(f)}}};
w.eval(source);w.eval(source);assert.equal(listeners.length,1,'Reinjection stays idempotent');
const n=(id,kind='success')=>({id,kind,origin:'https://example.com',theme:'violet',title:'example.com: saved',message:'Result: image .png',actionLabel:'Open manager',dismissLabel:'Dismiss notification',successEnabled:true,summaryTitle:'Download results',savedLabel:'Saved',failedLabel:'Failed'});
const show=(notice,sender={id:'testid'})=>{let result;listeners[0]({action:'MEDIALATCH_NOTICE',notice},sender,r=>result=r);return result;};
const root=()=>roots[0],cards=()=>[...root().querySelectorAll('.notice')];
const advance=ms=>{clock+=ms;for(const [id,t]of [...timers])if(t.time<=clock){timers.delete(id);t.fn();}};
const event=(el,type)=>el.dispatchEvent(new w.MouseEvent(type,{bubbles:false}));
const visibility=value=>{hidden=value;w.document.dispatchEvent(new w.Event('visibilitychange'));};
(async()=>{
  assert.equal(show(n('op-000001'),{id:'foreign'}).success,false);
  assert.equal(show(n('op-000001'),{id:'testid',tab:{id:7}}).success,false);
  assert.equal(show({...n('op-000001'),origin:'https://other.example'}).success,false);
  assert.equal(show({...n('op-000001'),id:123456}).success,false);
  assert.equal(show({...n('op-000001'),message:'x'.repeat(241)}).success,false);
  assert.equal(show({...n('op-000001'),summaryTitle:'x'.repeat(241)}).success,false);
  assert.equal(show({...n('op-000001'),successEnabled:undefined}).success,false);
  assert.equal(roots.length,0,'Invalid/unrelated notices never mount');
  const page=w.document.querySelector('#page-button');page.focus();
  assert.equal(show({...n('op-000001'),message:'<img src=x onerror=alert(1)>'}).success,true);
  assert.equal(w.document.activeElement,page,'Arrival does not steal focus');
  assert.equal(root().host.shadowRoot,null,'Page cannot inspect closed notice root');
  assert.equal(root().querySelector('img'),null,'Message renders as text, not markup');
  assert.equal(cards()[0].querySelector('[role=status]').getAttribute('aria-atomic'),'true');
  event(cards()[0],'mouseenter');advance(20000);assert.equal(cards().length,1,'Reading under pointer pauses expiry');
  event(cards()[0],'mouseleave');advance(6000);assert.equal(cards().length,0,'Leaving resumes remaining lifetime');
  hidden=true;show(n('op-000002','error'));advance(20000);assert.equal(cards().length,1,'Hidden source tab retains notice');
  hidden=false;w.document.dispatchEvent(new w.Event('visibilitychange'));advance(11999);assert.equal(cards().length,1);advance(1);assert.equal(cards().length,0);
  for(let i=3;i<7;i++)show(n('op-00000'+i,'error'));
  const stable=cards()[0];advance(500);
  assert.equal(cards().length,1,'Burst errors share one card');assert(!root().textContent.includes('undefined'));
  assert.equal(stable.querySelector('.message').textContent,'Saved: 0 · Failed: 4');
  assert.equal(stable.querySelector('[role=status]').getAttribute('aria-atomic'),'true','Grouped errors use one polite region');
  show(n('op-000006','error'));advance(500);assert.equal(stable.querySelector('.message').textContent,'Saved: 0 · Failed: 4','Repeated IDs never inflate counts');
  for(let i=100;i<150;i++)show(n('op-000'+i));
  assert.equal(cards()[0],stable,'A large burst never remounts the card');
  assert.equal(stable.querySelector('.message').textContent,'Saved: 0 · Failed: 4','Text updates are coalesced');advance(500);
  assert.equal(stable.querySelector('.message').textContent,'Saved: 50 · Failed: 4');assert(stable.classList.contains('error'));
  const close=stable.querySelector('.close');close.focus();advance(20000);assert.equal(cards()[0],stable,'Keyboard reading pauses expiry');
  show(n('op-000150'));advance(500);assert.equal(cards()[0],stable);assert.equal(root().activeElement,close,'Arrivals after idle cannot replace a focused card');
  close.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(cards().length,0,'Escape dismisses the whole series');
  show(n('op-000151'));advance(500);assert.equal(cards().length,0,'Dismissed series does not reopen for following results');
  advance(9499);show(n('op-000152'));assert.equal(cards().length,0,'Suppression follows the continuing series');advance(10000);
  page.focus();show(n('op-000007'));const button=cards()[0].querySelector('.open');button.focus();button.click();await new Promise(r=>setImmediate(r));
  assert.equal(cards().length,1,'Failed manager opening retains actionable notice');assert.equal(button.disabled,false);
  assert.equal(sent[0].action,'MEDIALATCH_NOTICE_OPEN');assert.equal(sent[0].id,'op-000007');
  show(n('op-000009'));advance(500);assert.equal(cards()[0].querySelector('.open'),button);assert.equal(root().activeElement,button,'Updates preserve action and focus');
  openOK=true;button.click();await new Promise(r=>setImmediate(r));assert.equal(cards().length,0);assert.equal(w.document.activeElement,page,'Last dismissal restores previous page focus');
  assert.equal(sent.at(-1).id,'op-000009','Manager opens the latest retained operation');
  visibility(true);visibility(false);assert.equal(cards().length,0,'Returning never resurrects an old card');
  show(n('op-000040'));assert.equal(cards().length,1,'Returning from manager permits new notices without an idle wait');
  const returned=cards()[0];for(let i=41;i<45;i++)show(n('op-0000'+i));advance(500);
  assert.equal(cards()[0],returned);assert.equal(cards().length,1,'New results after manager opening still share one stable card');
  const summary=returned.querySelector('.message').textContent;show(n('op-000040'));advance(500);assert.equal(returned.querySelector('.message').textContent,summary,'Already delivered IDs remain deduplicated after manager navigation');
  cards()[0].querySelector('.close').click();visibility(true);visibility(false);show(n('op-000049'));assert.equal(cards().length,0,'Tab return preserves explicit close suppression');
  advance(10000);show(n('op-000050'));let finishOpen;openGate=new Promise(resolve=>finishOpen=resolve);
  cards()[0].querySelector('.open').click();visibility(true);visibility(false);finishOpen();await new Promise(r=>setImmediate(r));openGate=null;
  assert.equal(cards().length,0,'Late successful manager reply retires its old card');
  show(n('op-000051'));assert.equal(cards().length,1,'Return before the manager reply cannot reinstate suppression');
  openGate=new Promise(resolve=>finishOpen=resolve);cards()[0].querySelector('.open').click();cards()[0].querySelector('.close').click();finishOpen();await new Promise(r=>setImmediate(r));openGate=null;
  show(n('op-000052'));assert.equal(cards().length,0,'Late successful manager reply preserves an explicit close while opening');
  advance(10000);page.focus();show({...n('op-000010','error'),successEnabled:false});show({...n('op-000011','error'),successEnabled:false});advance(500);
  assert.equal(cards()[0].querySelector('.message').textContent,'Failed: 2','Disabled successes do not imply zero successful saves');
  storage[0]({uiTheme:{newValue:'light'}},'local');assert.equal(root().host.style.getPropertyValue('--ml-bg'),'#ffffff');
  cards()[0].querySelector('.close').focus();cards()[0].querySelector('.close').click();assert.equal(w.document.activeElement,page);advance(10000);
  const ru=id=>({...n(id),summaryTitle:'Результаты загрузок',savedLabel:'Сохранено',failedLabel:'Ошибок',actionLabel:'Открыть менеджер',dismissLabel:'Закрыть'});
  show(ru('op-000030'));show(ru('op-000031'));advance(500);assert.equal(cards()[0].querySelector('.title').textContent,'Результаты загрузок');assert.equal(cards()[0].querySelector('.message').textContent,'Сохранено: 2 · Ошибок: 0');cards()[0].querySelector('.close').click();advance(10000);
  let finishExit,exitOptions;
  w.Element.prototype.animate=function(frames,options){exitOptions=options;return {finished:new Promise(r=>finishExit=r)};};
  page.focus();show(n('op-000012'));cards()[0].querySelector('.close').focus();cards()[0].querySelector('.close').click();
  assert.equal(cards()[0].inert,true);assert.equal(cards()[0].getAttribute('aria-hidden'),'true');assert.equal(exitOptions.duration,120);assert.equal(w.document.activeElement,page,'Visual exit never delays focus return');
  finishExit();await new Promise(r=>setImmediate(r));assert.equal(cards().length,0,'Finished exit removes the visual card');advance(10000);
  show(n('op-000013'));cards()[0].querySelector('.close').click();const retired=finishExit;
  advance(10000);for(let i=14;i<17;i++)show(n('op-0000'+i));assert.equal(cards().length,1,'A fresh series retires old exit ghosts');
  retired();await new Promise(r=>setImmediate(r));assert.equal(cards().length,1,'Late exit completion cannot remove the new card');
  w.matchMedia=()=>({matches:true});cards()[0].querySelector('.close').click();assert.equal(cards().length,0,'Reduced motion dismisses immediately');
  // MANAGER-BATCH-NOTICES-01: one card per post batch, named by the worker; ordinary notices keep their own grouped card.
  {
    const b=(batch,op,message,over={})=>({...n(op),batch,final:false,title:'x.com post',message,...over});
    const BA='batch-aaaaaa-01',BB='batch-bbbbbb-02',BC='batch-cccccc-03',BD='batch-dddddd-04';
    const msg=card=>card.querySelector('.message').textContent;
    advance(10000);page.focus(); // a new ordinary series: the one before was dismissed
    // arrival: one card, text, no focus theft, never an alert
    assert.equal(show(b(BA,'op-100001','Saved 1 of 8 · 7 remaining')).success,true);
    assert.equal(cards().length,1);const a=cards()[0],aOpen=a.querySelector('.open'),aResult=a.querySelector('[role=status]');
    assert.equal(a.querySelector('.title').textContent,'x.com post');assert.equal(msg(a),'Saved 1 of 8 · 7 remaining');assert.equal(a.getAttribute('data-closing'),null);
    assert.equal(w.document.activeElement,page,'A batch card does not take focus');assert(!root().querySelector('[role=alert]'),'A batch card is a polite status, never an alert');
    // results arriving: coalesced, the same card, the same Open manager button and its focus
    aOpen.focus();show(b(BA,'op-100002','Saved 2 of 8 · 6 remaining'));show(b(BA,'op-100003','Saved 3 of 8 · 5 remaining'));
    assert.equal(msg(a),'Saved 1 of 8 · 7 remaining','Burst updates are coalesced');advance(500);
    assert.equal(cards().length,1);assert.equal(cards()[0],a);assert.equal(msg(a),'Saved 3 of 8 · 5 remaining');assert.equal(a.querySelector('.open'),aOpen);assert.equal(root().activeElement,aOpen,'Updates keep the card, its action and focus');
    assert.equal(aResult.getAttribute('aria-live'),'off','Counts changing in the middle of a batch are not announced');
    // an unrelated single save and a second post are separate cards; neither merges into the batch
    show(n('op-200001'));show(b(BB,'op-100101','Saved 1 of 2 · 1 remaining'));advance(500);
    const all=cards();assert.equal(all.length,3,'Batch A, the ordinary grouped card and batch B');
    assert.equal(msg(a),'Saved 3 of 8 · 5 remaining');assert.deepEqual(all.map(msg).sort(),['Result: image .png','Saved 1 of 2 · 1 remaining','Saved 3 of 8 · 5 remaining'].sort());
    show(n('op-200002','error'));advance(500);assert.equal(cards().length,3,'Another ordinary result joins the ordinary card, not a batch');assert.equal(msg(a),'Saved 3 of 8 · 5 remaining');
    // an active batch is kept while results keep arriving (30 s idle), then it is dismissed like any card
    page.focus();advance(29999);assert(cards().includes(a),'An active batch card is kept while work is in progress');
    // a finished batch: final text, one polite announcement, the usual lifetime (success 6 s, with failures 12 s)
    show(b(BA,'op-100009','All 8 files saved',{final:true}));assert.equal(aResult.getAttribute('aria-live'),'polite');advance(500);
    assert.equal(msg(a),'All 8 files saved');assert.equal(cards()[0]===a||cards().includes(a),true);advance(5499);assert(cards().includes(a));advance(1);assert(!cards().includes(a),'A finished all-saved batch card expires after the usual time');
    // a mixed result stays longer, is an error card and lists what did not save
    show(b(BB,'op-100102','Saved 1 of 2 · 1 failed',{final:true,kind:'error'}));advance(500);
    const bb=cards().find(c=>msg(c).startsWith('Saved 1 of 2'));assert(bb.classList.contains('error'));assert.equal(bb.querySelector('.status').textContent,'!');assert.equal(bb.querySelector('[role=status]').getAttribute('role'),'status');
    advance(11499);assert(cards().includes(bb));advance(1);assert(!cards().includes(bb));
    // Close mutes that batch on this page; another batch and ordinary notices stay eligible
    show(b(BC,'op-100201','Saved 1 of 3 · 2 remaining'));show(b(BD,'op-100301','Saved 1 of 4 · 3 remaining'));advance(500);
    const c=cards().find(x=>msg(x).includes('of 3')),d=cards().find(x=>msg(x).includes('of 4'));
    c.querySelector('.close').click();assert(!cards().includes(c));
    show(b(BC,'op-100202','Saved 2 of 3 · 1 remaining'));advance(500);assert(!cards().some(x=>msg(x).includes('of 3')),'A closed batch does not reopen for its later results');
    show(b(BD,'op-100302','Saved 2 of 4 · 2 remaining'));advance(500);assert.equal(msg(d),'Saved 2 of 4 · 2 remaining','Other batches are still updated');
    show(n('op-200003'));advance(500);assert(cards().some(x=>msg(x)==='Saved: 1 · Failed: 0'||msg(x).startsWith('Result')||msg(x).startsWith('Saved: ')),'Ordinary notices still appear');
    // Escape also mutes the batch
    d.querySelector('.close').focus();d.querySelector('.close').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(!cards().includes(d));
    show(b(BD,'op-100303','Saved 3 of 4 · 1 remaining'));advance(500);assert(!cards().some(x=>msg(x).includes('of 4')),'Escape mutes the batch');
    // expiry or Open manager does not mute; the latest operation is the one named
    const E='batch-eeeeee-05';openOK=false;sent.length=0;
    show(b(E,'op-100401','Saved 1 of 2 · 1 remaining'));const e=cards().find(x=>msg(x).includes('of 2'));const eOpen=e.querySelector('.open');
    show(b(E,'op-100402','Saved 2 of 2 · 0 remaining'));advance(500);eOpen.click();await new Promise(r=>setImmediate(r));
    assert.equal(sent.at(-1).action,'MEDIALATCH_NOTICE_OPEN');assert.equal(sent.at(-1).id,'op-100402','Open manager names the latest operation of the batch, never the batch id');assert(cards().includes(e),'A refused opening keeps the card');
    openOK=true;eOpen.click();await new Promise(r=>setImmediate(r));assert(!cards().includes(e),'A successful opening retires the card');
    show(b(E,'op-100403','All 2 files saved',{final:true}));advance(500);assert(cards().some(x=>msg(x)==='All 2 files saved'),'Opening the manager does not mute the batch');advance(6000);
    // only the worker's well-formed batch notices are accepted
    for(const x of cards())x.querySelector('.close').click();
    for(const bad of [{batch:'BAD ID'},{batch:'a b c d e f'},{batch:'BATCH-UPPER-1'},{batch:'batch'},{batch:'x'.repeat(65)},{batch:123456},{batch:'batch-ffffff-06',final:'yes'},{batch:'batch-ffffff-06',final:undefined}])assert.equal(show({...b(BA,'op-100501','x'),...bad}).success,false,'Malformed batch notice: '+JSON.stringify(bad));
    assert.equal(show({...b('batch-ffffff-06','op-100501','x'),origin:'https://other.example'}).success,false);assert.equal(show(b('batch-ffffff-06','op-100501','x'),{id:'testid',tab:{id:7}}).success,false);assert.equal(show(b('batch-ffffff-06','op-100501','x'),{id:'foreign'}).success,false);assert.equal(cards().length,0,'Rejected notices never mount a card');
    // text is text; the theme follows the notice
    show(b('batch-gggggg-07','op-100601','<img src=x onerror=alert(1)>',{theme:'light'}));assert.equal(root().querySelector('img'),null);assert.equal(root().host.style.getPropertyValue('--ml-bg'),'#ffffff');advance(500);
    show(b('batch-gggggg-07','op-100602','Saved 2',{theme:'blue'}));advance(500);assert.equal(root().host.style.getPropertyValue('--ml-bg'),'#121b2e','A later update follows the current theme');
    // A fifth batch must not evict the card the user is reading with keyboard or pointer.
    for(const x of cards())x.querySelector('.close').click();
    for(let i=0;i<4;i++)show(b('batch-focus-'+i,'op-80000'+i,'Focus batch '+i));
    const focusedCard=cards()[0],focusedOpen=focusedCard.querySelector('.open');focusedOpen.focus();
    show(b('batch-focus-4','op-800004','Focus batch 4'));
    assert(cards().includes(focusedCard),'a new batch cannot remove the focused card');
    assert.equal(root().activeElement,focusedOpen,'a new batch cannot move keyboard focus');
    for(const x of cards())x.querySelector('.close').click();
    // memory is bounded: at most four batch cards, and the oldest muted batches are forgotten
    for(const id of ['batch-hhhhhh-08','batch-iiiiii-09','batch-jjjjjj-10','batch-kkkkkk-11','batch-llllll-12'])show(b(id,'op-1007'+id.slice(-2),'Saved 1 of 9'));
    assert.equal(cards().filter(x=>msg(x)==='Saved 1 of 9').length,4,'At most four batch cards are shown at once');
    for(const x of cards())x.querySelector('.close').click();advance(500);
    const muted=[];for(let i=0;i<34;i++){const id='batch-m'+String(i).padStart(5,'0')+'-x';muted.push(id);show(b(id,'op-9'+String(i).padStart(5,'0'),'Saved 1 of 3'));cards().find(x=>msg(x)==='Saved 1 of 3').querySelector('.close').click();}
    show(b(muted[0],'op-900990','Saved 2 of 3'));advance(500);assert(cards().some(x=>msg(x)==='Saved 2 of 3'),'The oldest muted batch is forgotten once the bounded list is full');
    for(const x of cards())x.querySelector('.close').click();
    show(b(muted.at(-1),'op-900991','Saved 3 of 3'));advance(500);assert(!cards().some(x=>msg(x)==='Saved 3 of 3'),'Recent muted batches stay muted');
    advance(60000);
  }
  const sb={URL};vm.createContext(sb);vm.runInContext(fs.readFileSync('lib/feedback.js','utf8'),sb);
  const raw={id:'op-000009',createdAt:clock,state:'complete',noticeTarget:{tabId:7,origin:'https://example.com'}};
  assert.deepEqual(JSON.parse(JSON.stringify(sb.ImageSaverFeedback.sanitizeRecord(raw).noticeTarget)),raw.noticeTarget);
  for(const target of [{tabId:-1,origin:'https://example.com'},{tabId:7,origin:'https://example.com/?secret=1'},{tabId:7,origin:'javascript:alert(1)'},{tabId:7,origin:'https://name:pass@example.com'}])assert(!sb.ImageSaverFeedback.sanitizeRecord({...raw,noticeTarget:target}).noticeTarget,'Unsafe route stripped');
  assert(!sb.ImageSaverFeedback.buildReport(raw).includes('noticeTarget'),'Report does not include routing metadata');
  // With success notices disabled, resolving an error retires its old card without showing a success card.
  vm.runInContext(fs.readFileSync('lib/feedback_tracker.js','utf8'),sb);
  const notifier=sb.ImageSaverFeedbackTracker.createNotifier({lang:'en',getPrefs:async()=>({notifySuccess:false}),deliver:async(record,opts)=>show({...opts,id:record.id,origin:'https://example.com',theme:'violet'}).success});
  const batch={id:'batch-retry-disabled',site:'x',count:2,saved:1,failed:1,cancelled:0,skipped:0,remaining:0};
  const record={id:'op-810000',state:'complete'};
  await notifier.batch(batch,record);const oldError=cards().find(x=>x.querySelector('.message').textContent==='1 failed');assert(oldError);oldError.querySelector('.open').focus();
  await notifier.batch({...batch,failed:0,remaining:1},record);advance(500);
  assert(!cards().includes(oldError),'a retry that clears the last failure cannot leave its old error visible');
  await notifier.batch({...batch,saved:2,failed:0},record);advance(500);
  assert(!cards().some(x=>/All 2|Saved 2/.test(x.querySelector('.message').textContent)),'success opt-out still prevents a new success card');
  // Retrying the only failed member leaves no terminal slot: update an existing card, but never create an initial progress card.
  for(const enabled of [true,false]) {
    for(const card of cards())card.querySelector('.close').click();
    const notify=sb.ImageSaverFeedbackTracker.createNotifier({lang:'en',getPrefs:async()=>({notifySuccess:enabled}),deliver:async(record,opts)=>show({...opts,id:record.id,origin:'https://example.com',theme:'violet'}).success});
    const pending={id:'batch-retry-empty-'+enabled,site:'x',count:2,saved:0,failed:0,cancelled:0,skipped:0,remaining:2};
    const rec={id:'op-820000',state:'failed'};
    await notify.batch(pending,rec);
    assert.equal(cards().length,0,'no card before the first terminal result');
    await notify.batch({...pending,failed:1,remaining:1},rec);
    const error=cards()[0];error.querySelector('.open').focus();
    await notify.batch(pending,rec);advance(500);
    if(enabled)assert.equal(error.querySelector('.message').textContent,'Saved 0 of 2 · 2 remaining','retrying the only failed member clears the old error and updates progress');
    else assert(!cards().includes(error),'retrying the only failed member retires the error even with zero settled slots');
  }

  // A page card outlives a service worker: a fresh notifier must still remove its stale error after retry succeeds.
  for(const card of cards())card.querySelector('.close').click();
  const freshNotifier=()=>sb.ImageSaverFeedbackTracker.createNotifier({lang:'en',getPrefs:async()=>({notifySuccess:false}),deliver:async(record,opts)=>show({...opts,id:record.id,origin:'https://example.com',theme:'violet'}).success});
  await freshNotifier().batch(batch,record);
  const stale=cards()[0];stale.querySelector('.open').focus();
  await freshNotifier().batch({...batch,saved:2,failed:0},record);
  assert(!cards().includes(stale),'a fresh worker removes the previous error without creating a success notice');

  console.log('PASS grouped and batch notices: trusted routing/text, stable burst card, counts/coalescing/dedup/suppression, opt-out, locale/focus/timers/motion and session-only targets');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>dom.window.close());
