// Own page notices only; no media lookup, page event bridge or desktop notification API.
(function () {
  if (window.top !== window || globalThis.__mediaLatchNotices || !chrome.runtime?.onMessage) return;
  globalThis.__mediaLatchNotices = true;
  let host, shadow, stack, returnFocus, theme = 'violet';
  const notices = new Map();
  const GROUP_IDLE_MS = 10000;
  const UPDATE_MS = 500;
  let group = null;
  const palettes = {
    violet: ['#19131f','#faf7ff','#bfb1cf','#44334f','#c084fc','#faf7ff','#141019','#f87171'],
    blue: ['#131c31','#f1f5f9','#94a3b8','#334155','#60a5fa','#2563eb','#ffffff','#f87171'],
    dark: ['#1b1b1f','#f4f4f5','#a1a1aa','#414149','#93c5fd','#2563eb','#ffffff','#f87171'],
    light: ['#f8fafc','#172033','#475569','#b1bac7','#1d4ed8','#1d4ed8','#ffffff','#b91c1c']
  };

  function applyTheme(value) {
    theme = Object.hasOwn(palettes, value) ? value : 'violet';
    if (!host) return;
    ['bg','fg','muted','border','ring','primary','on-primary','danger'].forEach((name,i)=>host.style.setProperty('--ml-'+name,palettes[theme][i]));
    host.style.setProperty('color-scheme', theme === 'light' ? 'light' : 'dark');
  }

  function mount() {
    if (host?.isConnected) return;
    returnFocus = document.activeElement;
    if (host) { document.documentElement.append(host); return; }
    host = document.createElement('div');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:auto 16px 16px auto!important;width:min(360px,calc(100vw - 32px))!important;max-height:calc(100vh - 32px)!important;z-index:2147483647!important;pointer-events:none!important;';
    shadow = host.attachShadow({mode:'closed'});
    const style = document.createElement('style');
    style.textContent = `
      :host{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;color:var(--ml-fg)}
      *{box-sizing:border-box} .stack{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;display:flex;flex-direction:column;gap:10px;max-height:calc(100vh - 32px);overflow:auto;padding:4px}
      .notice{background:var(--ml-bg);color:var(--ml-fg);border:1px solid var(--ml-border);border-radius:14px;padding:14px;box-shadow:0 8px 30px #0005;pointer-events:auto;animation:enter .18s cubic-bezier(.16,1,.3,1)}
      .notice[data-closing]{pointer-events:none}
      .head{display:flex;align-items:center;gap:8px} .brand{font-size:12px;font-weight:600;flex:1;color:var(--ml-muted)}
      .status{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;border:1px solid var(--ml-ring);color:var(--ml-ring);font-weight:700}
      .error .status{border-color:var(--ml-danger);color:var(--ml-danger)}
      .title{margin:8px 0 4px;font-size:14px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}
      .message{margin:0;color:var(--ml-muted);font-size:13px;line-height:1.5;overflow-wrap:anywhere}
      button{font:inherit;cursor:pointer;border-radius:7px;border:0;min-height:32px;transition:opacity .12s cubic-bezier(.16,1,.3,1)}
      button:hover{opacity:.85} button:focus-visible{outline:2px solid var(--ml-ring);outline-offset:2px}
      .close{width:32px;background:transparent;color:var(--ml-muted);font-size:22px;line-height:1;flex-shrink:0}
      .open{margin-top:12px;padding:6px 12px;background:var(--ml-primary);color:var(--ml-on-primary);font-weight:600}
      button:disabled{opacity:.6;cursor:wait}
      @keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      @media(prefers-reduced-motion:reduce){.notice{animation:none}button{transition:none}}
    `;
    stack = document.createElement('div'); stack.className = 'stack';
    shadow.append(style, stack); document.documentElement.append(host); applyTheme(theme);
  }

  function pause(entry) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; entry.remaining = Math.max(0, entry.remaining - (Date.now()-entry.started)); }
  }
  function resume(entry) {
    if (entry.timer || document.hidden || entry.hover || entry.node.contains(shadow.activeElement)) return;
    entry.started = Date.now(); entry.timer = setTimeout(()=>remove(entry.id),entry.remaining);
  }
  function remove(id, animate = true, suppress = false) {
    const entry = notices.get(id); if (!entry) return;
    pause(entry);
    if (entry.updateTimer) clearTimeout(entry.updateTimer);
    if (group?.entry === entry) { group.entry = null; if (suppress) group.suppressed = true; }
    const focused = entry.node.contains(shadow.activeElement);
    notices.delete(id); entry.node.inert = true; entry.node.setAttribute('aria-hidden','true'); entry.node.setAttribute('data-closing','');
    if (focused) {
      const next = notices.values().next().value;
      if (next) next.node.querySelector('.close').focus();
      else if (returnFocus?.isConnected) returnFocus.focus();
    }
    const done=()=>{entry.node.remove();if(!stack.childElementCount)host.remove();};
    if(animate && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches && typeof entry.node.animate==='function') {
      try {entry.node.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(4px)'}],{duration:120,easing:'cubic-bezier(.4,0,1,1)'}).finished.then(done,done);return;}catch(_){}
    }
    done();
  }

  function showCard(notice) {
    mount(); applyTheme(notice.theme); remove(notice.id,false); mount();
    // A new series retires fading cards before mounting its single result card.
    stack.querySelectorAll('[data-closing]').forEach(node=>node.remove());
    const node=document.createElement('section'); node.className='notice '+notice.kind;
    const head=document.createElement('div'); head.className='head';
    const status=document.createElement('span'); status.className='status'; status.textContent=notice.kind==='error'?'!':'✓';status.setAttribute('aria-hidden','true');
    const brand=document.createElement('span'); brand.className='brand'; brand.textContent='MediaLatch';
    const close=document.createElement('button'); close.type='button';close.className='close';close.textContent='×';close.setAttribute('aria-label',notice.dismissLabel);close.addEventListener('click',()=>remove(notice.id,true,true));
    head.append(status,brand,close);
    const result=document.createElement('div');result.setAttribute('role',notice.grouped?'status':notice.kind==='error'?'alert':'status');result.setAttribute('aria-atomic','true');
    const title=document.createElement('p');title.className='title';title.textContent=notice.title;
    const message=document.createElement('p');message.className='message';message.textContent=notice.message;
    result.append(title,message);
    const open=document.createElement('button');open.type='button';open.className='open';open.textContent=notice.actionLabel;
    open.addEventListener('click',async()=>{
      open.disabled=true;
      // Opening details retires this card; only an explicit dismissal mutes the series.
      try { if ((await chrome.runtime.sendMessage({action:'MEDIALATCH_NOTICE_OPEN',id:entry.latestId}))?.success) {if(notices.get(entry.id)===entry)remove(entry.id,true);return;} } catch (_) {}
      if(notices.get(entry.id)!==entry)return;
      open.disabled=false;open.focus();
    });
    node.append(head,result,open);stack.append(node);
    const entry={id:notice.id,latestId:notice.id,node,result,title,message,status,close,open,remaining:notice.kind==='error'?12000:6000,timer:null,updateTimer:null,started:0,hover:false};notices.set(notice.id,entry);
    node.addEventListener('mouseenter',()=>{entry.hover=true;pause(entry);});node.addEventListener('mouseleave',()=>{entry.hover=false;resume(entry);});
    node.addEventListener('focusin',e=>{if(e.relatedTarget && e.relatedTarget!==host && !stack.contains(e.relatedTarget))returnFocus=e.relatedTarget;pause(entry);});node.addEventListener('focusout',()=>queueMicrotask(()=>{if(notices.has(entry.id))resume(entry);}));
    node.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();remove(entry.id,true,true);}});
    resume(entry);
    return entry;
  }

  function show(notice) {
    const now=Date.now();
    if(!group || (now-group.lastAt>=GROUP_IDLE_MS && !group.entry?.hover && !group.entry?.node.contains(shadow?.activeElement))) {
      if(group?.entry)remove(group.entry.id,false);
      group={lastAt:now,saved:0,failed:0,seen:new Set(),entry:null,suppressed:false,omittedSuccesses:false};
    }
    if(group.seen.has(notice.id))return true;
    group.seen.add(notice.id);
    if(group.seen.size>256)group.seen.delete(group.seen.values().next().value);
    group.lastAt=now;
    if(notice.kind==='error')group.failed++;else group.saved++;
    if(!notice.successEnabled)group.omittedSuccesses=true;
    if(group.suppressed)return true;
    const multiple=group.saved+group.failed>1;
    const display=multiple?{...notice,grouped:true,kind:group.failed?'error':'success',title:notice.summaryTitle,
      message:(group.omittedSuccesses?[]:[`${notice.savedLabel}: ${group.saved}`]).concat(`${notice.failedLabel}: ${group.failed}`).join(' · ')}:notice;
    const created=!group.entry;
    if(created)group.entry=showCard(display);
    const entry=group.entry;
    entry.latestId=notice.id;
    pause(entry);entry.remaining=group.failed?12000:multiple?GROUP_IDLE_MS:6000;resume(entry);
    applyTheme(notice.theme);
    entry.display=display;
    if(!created && !entry.updateTimer)entry.updateTimer=setTimeout(()=>{
      entry.updateTimer=null;
      if(notices.get(entry.id)!==entry)return;
      const n=entry.display;
      entry.node.className='notice '+n.kind;entry.status.textContent=n.kind==='error'?'!':'✓';
      // A series updates one polite live region instead of announcing every file as a new alert.
      entry.result.setAttribute('role',n.grouped?'status':n.kind==='error'?'alert':'status');
      entry.title.textContent=n.title;entry.message.textContent=n.message;
      entry.close.setAttribute('aria-label',n.dismissLabel);entry.open.textContent=n.actionLabel;
    },UPDATE_MS);
    return true;
  }

  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(message?.action!=='MEDIALATCH_NOTICE')return false;
    const n=message.notice;
    if(sender?.id!==chrome.runtime.id || sender.tab || !n || n.origin!==location.origin || typeof n.id!=='string' || !/^[a-z0-9-]{6,48}$/.test(n.id) || !['success','error'].includes(n.kind) || typeof n.successEnabled!=='boolean' || !['title','message','actionLabel','dismissLabel','summaryTitle','savedLabel','failedLabel'].every(k=>typeof n[k]==='string' && n[k].length>0 && n[k].length<=240)) {respond({success:false});return false;}
    try {respond({success:show(n)});}catch(_){respond({success:false});}
    return false;
  });
  document.addEventListener('visibilitychange',()=>notices.forEach(e=>document.hidden?pause(e):resume(e)));
  chrome.storage?.onChanged?.addListener((changes,area)=>{if(area==='local' && changes.uiTheme)applyTheme(changes.uiTheme.newValue);});
})();
