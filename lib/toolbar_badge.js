// One serialized toolbar writer. Transient results must not erase another save's activity.
(function(root){
  function create({action,readState,readBusy=readState,setTimer=setTimeout,clearTimer=clearTimeout,log=()=>{}}){
    let revision=0,chain=Promise.resolve(),flashTimer=null,flashText='',idleTimer=null,hadDownload=false;
    let shownText=null,shownColor=null;
    const cancelIdle=()=>{if(idleTimer!==null){clearTimer(idleTimer);idleTimer=null;}};
    function write(text,color,token){
      chain=chain.catch(()=>{}).then(async()=>{
        if(token!==revision || !action?.setBadgeText)return;
        try{
          if(color && color!==shownColor && action.setBadgeBackgroundColor){await action.setBadgeBackgroundColor({color});shownColor=color;}
          if(token!==revision)return;
          // Query when supported so an external reset or API failure cannot make the cache lie.
          let actual=null;
          if(action.getBadgeText){try{actual=await action.getBadgeText({});}catch(_){}}
          if(token!==revision)return;
          if(text!==actual)await action.setBadgeText({text});
          shownText=text;
        }catch(error){shownText=null;shownColor=null;log(error);}
      });
      return chain;
    }
    async function refresh(immediate=false){
      if(flashTimer!==null)return chain;
      const token=++revision;
      try{
        const state=await readState();if(token!==revision || flashTimer!==null)return chain;
        if(state.downloads>0 || state.pending>0 || state.resolving>0){
          cancelIdle();hadDownload ||= state.downloads>0 || state.pending>0;
          return write(hadDownload?'DL':'...', '#9333ea',token);
        }
        if(state.failures>0){cancelIdle();hadDownload=false;return write('!','#f59e0b',token);}
        if(immediate || shownText===null || shownText===''){
          cancelIdle();hadDownload=false;return write('',null,token);
        }
        // Short gaps between queued items belong to one activity period, not repeated idle flashes.
        if(idleTimer===null)idleTimer=setTimer(()=>{idleTimer=null;void refresh(true);},700);
      }catch(error){log(error);}
    }
    async function set(text,color){
      if(text==='OK')return flash(text,color);
      if(text==='DL')hadDownload=true;
      if(text==='')hadDownload=false;
      if(flashTimer!==null && flashText!=='OK' && (text==='DL' || text==='...'))return chain;
      if(flashTimer!==null){clearTimer(flashTimer);flashTimer=null;}
      cancelIdle();const token=++revision;
      return write(text==='...' && hadDownload?'DL':text,color,token);
    }
    async function flash(text,color,duration=2500){
      const before=revision;
      if(text==='OK'){
        if(flashTimer!==null && flashText!=='OK')return chain;
        try{
          const snapshot=readBusy();
          const state=snapshot && typeof snapshot.then==='function' ? await snapshot : snapshot;
          if(before!==revision)return chain;
          if(state.downloads>0 || state.pending>0 || state.resolving>0)return refresh();
        }catch(error){log(error);return;}
      }
      const token=++revision;
      cancelIdle();
      if(flashTimer!==null)clearTimer(flashTimer);
      flashText=text;
      flashTimer=setTimer(()=>{flashTimer=null;void refresh();},duration);
      return write(text,color,token);
    }
    return {set,flash,refresh,get flashing(){return flashTimer!==null;}};
  }
  root.MediaLatchToolbarBadge={create};
})(globalThis);
