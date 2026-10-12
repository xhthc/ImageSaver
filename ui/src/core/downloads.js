import {createStore} from './store.js';
export function createDownloads({chrome}) {
  const store=createStore({jobs:[],paused:false,status:'loading',error:'',busy:false,removingIds:[],dismissedIds:[]});
  let disposed=false, loading=false, again=false;
  let lastJobs=[];
  const removed=new Set();
  async function load() {
    if(disposed)return;
    if(loading){again=true;return;}loading=true;
    try {
      const r=await chrome.runtime.sendMessage({action:'DOWNLOADS_LIST'});
      if(!r?.success)throw Error();
      lastJobs=r.jobs;
      for(const id of removed)if(!r.jobs.some(j=>j.id===id))removed.delete(id);
      if(!disposed)store.setState({jobs:r.jobs.filter(j=>!removed.has(j.id) && !store.getState().removingIds.includes(j.id)),paused:r.paused,status:'ready',error:store.getState().error==='downloads.unavailable'?'':store.getState().error});
    }catch(_){if(!disposed)store.setState({status:'error',error:store.getState().error==='downloads.commandFailed'?'downloads.commandFailed':'downloads.unavailable'});}
    finally{loading=false;if(again){again=false;void load();}}
  }
  const changed=m=>{if(m?.action==='DOWNLOADS_CHANGED')void load();};
  chrome.runtime.onMessage?.addListener(changed);
  async function command(command,id) {
    if(disposed || store.getState().busy)return;
    const selectedJobs=store.getState().jobs.slice();
    const ids=command==='clearFinished'?store.getState().jobs.filter(j=>['complete','failed','cancelled'].includes(j.state)).map(j=>j.id):[id];
    store.setState({busy:true,error:'',...(command==='clearFinished'?{removingIds:store.getState().jobs.filter(j=>ids.includes(j.id)).flatMap(j=>[j.id,j.op].filter(Boolean)),jobs:store.getState().jobs.filter(j=>!ids.includes(j.id))}:{})});
    try{
      for(const selected of ids){const r=await chrome.runtime.sendMessage({action:'DOWNLOADS_COMMAND',command:command==='clearFinished'?'remove':command,id:selected});if(!r?.success)throw Error();if(command==='clearFinished'){removed.add(selected);if(!disposed)store.setState({dismissedIds:[...store.getState().dismissedIds,selectedJobs.find(j=>j.id===selected)?.op || selected]});}}
      if(command!=='clearFinished')await load();
    }
    catch(_){if(!disposed)store.setState({error:'downloads.commandFailed'});}
    finally{if(command==='clearFinished'){if(!disposed)store.setState({removingIds:[],jobs:lastJobs.filter(j=>!removed.has(j.id))});await load();}if(!disposed)store.setState({busy:false});}
  }
  return {store,load,command,dispose(){disposed=true;chrome.runtime.onMessage?.removeListener(changed);}};
}
