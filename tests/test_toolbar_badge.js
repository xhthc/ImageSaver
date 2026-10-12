const assert=require('node:assert/strict');
require('../lib/toolbar_badge.js');
function fixture(){
  const state={downloads:0,pending:0,resolving:0,failures:0},writes=[],timers=new Map();
  let text='',color='',clock=0,seq=0,read=async()=>({...state});
  const badge=globalThis.MediaLatchToolbarBadge.create({
    action:{getBadgeText:async()=>text,setBadgeText:async v=>{text=v.text;writes.push(text);},setBadgeBackgroundColor:async v=>{color=v.color;}},
    readState:()=>read(),setTimer:(fn,delay)=>{const id=++seq;timers.set(id,{fn,time:clock+delay});return id;},clearTimer:id=>timers.delete(id)
  });
  return {state,badge,writes,get text(){return text;},get color(){return color;},read:fn=>{read=fn;},advance:async ms=>{clock+=ms;for(const[id,t]of [...timers])if(t.time<=clock){timers.delete(id);t.fn();}for(let i=0;i<12;i++)await Promise.resolve();}};
}
(async()=>{
  const f=fixture();f.state.downloads=2;await f.badge.set('DL','#9333ea');
  f.state.downloads=1;await f.badge.flash('OK','#22c55e');await f.badge.refresh();
  assert.deepEqual(f.writes,['DL'],'A peer completion cannot flash OK over active downloads');
  f.state.resolving=1;await f.badge.set('...','#9333ea');assert.equal(f.text,'DL','Activity cannot regress to resolving between items');
  f.state.downloads=0;f.state.resolving=0;await f.badge.refresh();await f.advance(699);assert.equal(f.text,'DL','Short idle gaps do not clear the indicator');
  f.state.pending=1;await f.badge.refresh();await f.advance(1);assert.equal(f.text,'DL','A queued acquisition cancels the stale idle clear');
  f.state.pending=0;await f.badge.flash('OK','#22c55e');assert.equal(f.text,'OK');
  await f.badge.refresh();await f.advance(2499);assert.equal(f.text,'OK','A refresh cannot cancel the result lifetime');
  await f.advance(1);await f.advance(700);assert.equal(f.text,'','The completed series clears once after its result interval');
  const e=fixture();await e.badge.flash('AUTH','#f59e0b');e.state.failures=1;
  await e.badge.refresh();await e.advance(2499);assert.equal(e.text,'AUTH');await e.advance(1);assert.equal(e.text,'!','Unseen failure survives flash expiry');
  const mixed=fixture();await mixed.badge.flash('ERR','#ef4444');mixed.state.downloads=1;
  await mixed.badge.set('DL','#9333ea');await mixed.badge.flash('OK','#22c55e');
  assert.equal(mixed.text,'ERR','Peer progress and completion preserve a readable error');
  mixed.state.downloads=0;await mixed.badge.flash('OK','#22c55e');
  assert.equal(mixed.text,'ERR','The last successful peer cannot shorten the error interval');
  mixed.state.downloads=1;
  await mixed.advance(2500);assert.equal(mixed.text,'DL','Busy state returns after the error interval');
  const race=fixture();let resolve;race.read(()=>new Promise(r=>{resolve=r;}));
  const old=race.badge.refresh();await Promise.resolve();await race.badge.set('DL','#9333ea');resolve({downloads:0,pending:0,resolving:0,failures:0});await old;
  assert.equal(race.text,'DL','A delayed idle snapshot cannot overwrite newer activity');
  const repeat=fixture();repeat.state.pending=1;await repeat.badge.refresh();for(let i=0;i<30;i++)await repeat.badge.refresh();assert.deepEqual(repeat.writes,['DL'],'Identical refreshes do not rewrite browser text');
  console.log('PASS toolbar badge: peer completion, stable busy phase, idle grace, result lifetime, persistent failure, stale snapshots and deduplicated API writes');
})().catch(error=>{console.error(error);process.exitCode=1;});
