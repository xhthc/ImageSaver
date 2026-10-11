import {createStore} from './store.js';
export function createDownloads({chrome}) {
  const store=createStore({jobs:[],paused:false,status:'loading',error:'',busy:false});
  let disposed=false, loading=false, again=false;
  async function load() {
    if(disposed)return;
    if(loading){again=true;return;}loading=true;
    try {
      const r=await chrome.runtime.sendMessage({action:'DOWNLOADS_LIST'});
      if(!r?.success)throw Error();
      if(!disposed)store.setState({jobs:r.jobs,paused:r.paused,status:'ready',error:store.getState().error==='downloads.unavailable'?'':store.getState().error});
    }catch(_){if(!disposed)store.setState({status:'error',error:store.getState().error==='downloads.commandFailed'?'downloads.commandFailed':'downloads.unavailable'});}
    finally{loading=false;if(again){again=false;void load();}}
  }
  const changed=m=>{if(m?.action==='DOWNLOADS_CHANGED')void load();};
  chrome.runtime.onMessage?.addListener(changed);
  async function command(command,id) {
    if(disposed || store.getState().busy)return;
    store.setState({busy:true,error:''});
    try{const r=await chrome.runtime.sendMessage({action:'DOWNLOADS_COMMAND',command,id});if(!r?.success)throw Error();await load();}
    catch(_){if(!disposed)store.setState({error:'downloads.commandFailed'});}
    finally{if(!disposed)store.setState({busy:false});}
  }
  return {store,load,command,dispose(){disposed=true;chrome.runtime.onMessage?.removeListener(changed);}};
}
