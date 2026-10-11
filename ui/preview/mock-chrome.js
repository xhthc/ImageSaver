// Page-preview mock of the extension APIs the UI uses. NOT part of the extension and never shipped: ui/scripts/preview-server.mjs
// injects it into popup/quick.html and popup/popup.html for ordinary-page previews (screenshots, layout checks). A page
// preview is not an extension-popup test: there is no background worker, no real storage and no real notifications.
// Scenario: ?scenario=mixed|empty|invite|dismissed|error|long|failures|history-off  (default: mixed)
(function () {
  var params = new URLSearchParams(location.search);
  var scenario = params.get('scenario') || 'mixed';
  var NOW = Date.now();
  var seq = 0;

  function rec(over) {
    seq++;
    var base = {
      id: 'op-prev-' + String(seq).padStart(4, '0'),
      createdAt: NOW - (20 - seq) * 61000,
      updatedAt: NOW - (20 - seq) * 61000 + 2500,
      state: 'complete',
      site: 'example.com',
      sourceHost: 'cdn.example.com',
      filename: 'picture-' + seq + '.jpg',
      filenameKind: 'actual',
      postUrl: 'https://x.com/someone/status/' + (1000000000 + seq),
      output: { type: 'pic', ext: '.jpg', evidence: 'verified_mime', mime: 'image/jpeg', sizeBytes: 184320 + seq * 1000, sizeKind: 'measured' },
      seen: true
    };
    for (var k in over) base[k] = over[k];
    return base;
  }
  var failure = function (stage, category, extra) { return Object.assign({ stage: stage, category: category, code: '', status: null, downloadError: '' }, extra || {}); };

  var records = [];
  if (scenario === 'mixed' || scenario === 'failures' || scenario === 'history-off' || scenario === 'long') {
    records = [
      rec({ filename: 'sunset-over-the-bay.jpg', site: 'pixiv.net' }),
      rec({ state: 'complete', filename: 'loop-animation.gif', site: 'x.com', conversion: 'x_tweet_video_gif', output: { type: 'gif', ext: '.gif', evidence: 'converted_output', mime: 'image/gif', sizeBytes: 2457600, sizeKind: 'measured', frames: 48 } }),
      rec({ state: 'complete', filename: 'clip.mp4', site: 'reddit.com', output: { type: 'video', ext: '.mp4', evidence: 'verified_mime', mime: 'video/mp4', sizeBytes: 9437184, sizeKind: 'measured' } }),
      rec({ state: 'failed', filename: '', site: 'zerochan.net', seen: scenario !== 'failures', output: { type: 'unknown' }, failure: failure('verify', 'invalid_content', { status: 200 }) }),
      rec({ state: 'interrupted', filename: 'partial-download.webm', filenameKind: 'intended', site: 'example.com', seen: scenario !== 'failures', output: { type: 'video', ext: '.webm', evidence: 'filename_hint' }, failure: failure('download', 'download_interrupted', { downloadError: 'NETWORK_FAILED' }) }),
      rec({ state: 'cancelled', filename: 'cancelled-by-user.png', output: { type: 'pic', ext: '.png', evidence: 'filename_hint' }, failure: failure('download', 'cancelled') }),
      rec({ state: 'saving', filename: 'in-progress.jpg', filenameKind: 'intended', output: { type: 'unknown' } })
    ];
  }
  records.reverse();
  if (scenario === 'long') records.unshift(rec({ filename: 'this-is-an-extremely-long-file-name-that-keeps-going-and-going-for-the-sake-of-the-layout-test-0123456789-0123456789-0123456789.jpg', site: 'a-very-long-subdomain.example-gallery-site.com' }));

  var local = { historyEnabled: scenario !== 'history-off' && scenario !== 'invite' && scenario !== 'dismissed', historyInviteDismissed: scenario === 'dismissed' };
  var listeners = [];
  var tabs = [];

  var stats = null;
  function reply(action) {
    if (scenario === 'error') throw new Error('MESSAGING_DOWN');
    if (action === 'DOWNLOADS_LIST' || action === 'DOWNLOADS_COMMAND') return {success:true,paused:false,jobs:records.map(function(r){return {id:r.id,filename:r.filename || 'media',state:r.state==='saving'?'receiving':r.state==='interrupted'?'failed':r.state,received:r.output.sizeBytes || 0,total:r.state==='saving'?null:r.output.sizeBytes || null,speed:0,error:r.failure?.code || '',ready:false};})};
    if (action === 'FEEDBACK_LIST' || action === 'FEEDBACK_MARK_SEEN' || action === 'FEEDBACK_CLEAR' || action === 'HISTORY_LIST' || action === 'HISTORY_CLEAR') {
      if (action === 'FEEDBACK_MARK_SEEN') records.forEach(function (r) { r.seen = true; });
      return { success: true, records: records.slice() };
    }
    if (action === 'STATISTICS_LIST' || action === 'STATISTICS_CLEAR') { if (!stats || action === 'STATISTICS_CLEAR') stats = window.ImageSaverFeedback.computeStats(action === 'STATISTICS_CLEAR' ? [] : records); return {success:true, stats:stats, imported:0}; }
    return undefined;
  }

  window.chrome = {
    runtime: {
      id: 'preview',
      getManifest: function () { return { version: 'preview' }; },
      getURL: function (p) { return location.origin + '/' + p; },
      sendMessage: function (m) { try { return Promise.resolve(reply(m.action)); } catch (e) { return Promise.reject(e); } }
    },
    storage: {
      local: {
        get: function (defaults) { return Promise.resolve(Object.assign({}, defaults || {}, local)); },
        set: function (v) {
          var changes = {};
          Object.keys(v).forEach(function (k) { changes[k] = { oldValue: local[k], newValue: v[k] }; });
          Object.assign(local, v);
          listeners.forEach(function (cb) { cb(changes, 'local'); });
          return Promise.resolve();
        }
      },
      onChanged: { addListener: function (cb) { listeners.push(cb); } }
    },
    tabs: { create: function (o) { tabs.push(o.url); console.log('[preview] tabs.create ' + o.url); return Promise.resolve({ id: 1 }); } }
  };
  // Timing hook for ui/preview/measure.html: the moment the first result row (old or new markup) exists.
  new MutationObserver(function (_, observer) {
    if (document.querySelector('.fb-head, [data-slot="result-item"]')) { window.__listShownAt = performance.now(); observer.disconnect(); }
  }).observe(document, { childList: true, subtree: true });
  // Handles for driving a preview by hand (never used by the extension itself).
  window.__preview = { scenario: scenario, records: records, local: local, tabs: tabs, rec: rec };
})();
