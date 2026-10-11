import {pageUrl} from './nav.js';
import {uiLog} from './debuglog.js';
// Downloads are operational state; viewing them does not depend on opt-in statistics.
export function createQuick({chrome,window}) {
  return {ready:Promise.resolve(),async openSettings(section='saving') {
    try{await chrome.tabs.create({url:pageUrl(chrome,section)});}
    catch(_){uiLog('popup','settings','failed','TAB_NOT_OPENED',{section});return;}
    uiLog('popup','settings','ok',undefined,{section});window?.close?.();
  }};
}
