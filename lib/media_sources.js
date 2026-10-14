// Privileged requests: literal local destinations require a deliberately selected local page.
(function(root) {
  function httpUrl(value) {
    try { const u=new URL(value); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password ? u : null; } catch (_) { return null; }
  }
  function localHost(host) {
    const h=host.toLowerCase().replace(/\.$/,'');
    if(h==='localhost' || h.endsWith('.localhost') || h.endsWith('.local') || (!h.includes('.') && !h.includes(':')))return true;
    if(/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const [a,b]=h.split('.').map(Number);
      return a===0 || a===10 || a===127 || a===169 && b===254 || a===172 && b>=16 && b<=31 || a===192 && b===168 || a===100 && b>=64 && b<=127 || a===198 && (b===18 || b===19) || a>=224;
    }
    if(h.startsWith('[')) {
      const v=h.slice(1,-1);
      if(v==='::' || v==='::1' || /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]|ff[0-9a-f]{2}):/.test(v))return true;
      const mapped=v.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if(mapped) { const a=parseInt(mapped[1],16), b=parseInt(mapped[2],16); return localHost([a>>>8,a&255,b>>>8,b&255].join('.')); }
    }
    return false;
  }
  function allows(source, selectedPage='') {
    const u=httpUrl(source); if(!u)return false;
    if(!localHost(u.hostname))return true;
    // Native context-menu / authenticated sender URL; never a DOM base, descriptor or candidate.
    const page=httpUrl(selectedPage); return !!page && localHost(page.hostname);
  }
  root.MediaLatchSources={allows,localHost};
  if(typeof module!=='undefined' && module.exports)module.exports=root.MediaLatchSources;
})(typeof globalThis!=='undefined'?globalThis:this);
