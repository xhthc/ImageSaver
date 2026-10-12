// Classic worker module; imported at the original initialization boundary.
// The shared animation policy (X tweet_video, Reddit GIF-as-MP4): a measured duration up to and including this many seconds becomes a
// genuine GIF; strictly above it the verified source MP4 is saved. Fixed: a caller option cannot move it.
const ANIMATION_GIF_MAX_SECONDS = 30;

// Only a complete fixed-limit decision without output bytes or a Blob authorizes the exact source MP4.
function parseAnimationLimitDecision(res) {
  if (res && res.exceedsSize !== undefined && res.exceedsSize !== false) {
    const threshold = res.sizeKind === 'input' ? 50 * 1024 * 1024 : res.sizeKind === 'gif' ? 15 * 1024 * 1024 : null;
    if (res.exceedsSize !== true || res.exceedsDuration || res.action !== 'SAVE_DIRECT_MP4' || res.blobUrl || res.bytes !== undefined ||
        threshold === null || res.thresholdBytes !== threshold || !Number.isSafeInteger(res.sizeBytes) || res.sizeBytes <= threshold) {
      throw new Error('INVALID_SIZE_DECISION');
    }
    return { exceedsSize: true };
  }
  if (!res || res.exceedsDuration === undefined || res.exceedsDuration === false) return null;
  const duration = res.duration;
  if (res.exceedsDuration !== true || res.action !== 'SAVE_DIRECT_MP4' || res.blobUrl || res.bytes !== undefined ||
      typeof duration !== 'number' || !Number.isFinite(duration) || duration <= ANIMATION_GIF_MAX_SECONDS || duration > 36000 ||
      res.threshold !== ANIMATION_GIF_MAX_SECONDS) {
    throw new Error('INVALID_DURATION_DECISION');
  }
  return { exceedsDuration: true, duration, threshold: ANIMATION_GIF_MAX_SECONDS };
}

// Provider-specific evidence and diagnostics stay unchanged; task lifetime is shared.
const X_ANIMATION = {
  conversion: 'x_tweet_video_gif', source: 'x_video', fallbackFilename: 'tweet_video.mp4',
  downloadError: '[MediaLatch] Ошибка вызова chrome.downloads.download для сконвертированного GIF:',
  conversionError: '[MediaLatch] Не удалось сконвертировать и скачать X tweet_video в GIF:'
};
const REDDIT_ANIMATION = {
  conversion: 'reddit_animation_gif', source: 'reddit_video', fallbackFilename: 'reddit_animation.mp4',
  downloadError: '[MediaLatch] Ошибка вызова chrome.downloads.download для сконвертированного Reddit GIF:',
  conversionError: '[MediaLatch] Не удалось сконвертировать и скачать Reddit анимацию в GIF:'
};
async function convertAnimationToGifBlob(videoUrl, options, prefix, action) {
  const taskKey = acquireOffscreenTask(prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  try {
    await ensureOffscreenDocument();
    const res = await offscreenRequest({
      action: action,
      url: videoUrl,
      jobId: taskKey,
      ...options
    });
    if (!res || !res.success) {
      throw new Error(res?.error || 'CONVERSION_FAILED');
    }
    const decision = parseAnimationLimitDecision(res);
    if (decision) {
      await releaseOffscreenTask(taskKey).catch(() => {});
      return { success: true, ...decision };
    }
    if (!res.blobUrl) {
      throw new Error(res?.error || 'CONVERSION_FAILED');
    }
    if (res.bytes !== undefined) {
      throw new Error('OVERSIZED_RESPONSE: Conversion response must not include raw byte buffer across messaging');
    }
    return {
      success: true,
      blobUrl: res.blobUrl,
      taskKey,
      size: res.size || 0,
      frames: res.frames || 0,
      duration: res.duration || 0
    };
  } catch (err) {
    await releaseOffscreenTask(taskKey).catch(() => {});
    throw err;
  }
}

async function executeAnimationGifDownload(videoUrl, settings, options, convert, provider) {
  let convResult = null;
  const feedbackOp = options?.feedbackOp || null;
  try {
    await setBadge('...', '#9333ea');
    // pageUrl is folder-routing context only; it must not travel to the offscreen document.
    const { pageUrl, feedbackOp: _feedbackOp, ...conversionOptions } = options || {};
    await fbStage(feedbackOp, 'converting', { conversion: provider.conversion, expectedType: 'gif', sourceUrl: videoUrl, site: fbSiteOf(pageUrl, videoUrl) });
    convResult = await convert(videoUrl, conversionOptions);
    if (convResult?.exceedsDuration || convResult?.exceedsSize) {
      const duration = convResult.duration;
      const threshold = convResult.threshold;
      const reason = convResult.exceedsSize ? 'animation_size_limit' : 'animation_duration_limit';
      await fbStage(feedbackOp, 'saving', {
        conversion: 'none',
        reason,
        durationSec: duration,
        thresholdSec: threshold,
        output: {
          type: 'video',
          ext: '.mp4',
          evidence: 'verified_mime',
          mime: 'video/mp4',
          durationSec: duration,
          reason,
          thresholdSec: threshold
        }
      });
      const mediaPlan = adaptCandidateToGroup({
        url: videoUrl,
        source: provider.source,
        tier: 'original',
        score: 90,
        contentType: 'video/mp4',
        mediaType: 'video',
        verified: true,
        metadata: {
          durationSec: duration,
          thresholdSec: threshold,
          reason
        }
      });
      return await executeMediaDownload({
        targetImageUrl: videoUrl,
        rawImageUrl: videoUrl,
        settings,
        mediaPlan,
        pageUrl: pageUrl || '',
        feedbackOp
      });
    }
    // Measured by the encoder: output size and frame count. Output dimensions are not reported by the converter.
    await fbStage(feedbackOp, 'saving', { output: { type: 'gif', ext: '.gif', evidence: 'converted_output', mime: 'image/gif', sizeBytes: convResult.size > 0 ? convResult.size : null, sizeKind: 'measured', frames: convResult.frames > 0 ? convResult.frames : null, durationSec: convResult.duration > 0 ? convResult.duration : null } });
    const baseName = getFilenameFromUrl(videoUrl) || provider.fallbackFilename;
    const filenameNoExt = baseName.replace(/\.[^/.]+$/, '');
    const filename = resolveDownloadPath({
      filename: `${filenameNoExt}.gif`,
      subfolder: getConfiguredRoot(settings),
      folderOrganizationMode: settings?.folderOrganizationMode,
      xAuthor: settings?.xAuthor,
      isConvertedGif: true,
      pageUrl,
      resolvedUrl: videoUrl
    });

    let downloadId = null;
    try {
      downloadId = await managedDownload({url:convResult.blobUrl,filename,saveAs:false}, feedbackOp, 'image/gif');
    } catch (dlErr) {
      console.error(provider.downloadError, dlErr);
      await fbFail(feedbackOp, { stage: 'save', code: dlErr?.message });
      await releaseOffscreenTask(convResult.taskKey, convResult.blobUrl).catch(() => {});
      await flashBadge('ERR', '#ef4444');
      return { success: false, error: dlErr?.message || String(dlErr) };
    }

    await fbAttach(feedbackOp, downloadId, { filename });
    await addTrackedDownloadId(downloadId);
    await setBadge('DL', '#9333ea');
    transferOffscreenTask(convResult.taskKey, 'protected_' + downloadId, convResult.blobUrl);
    await trackDownloadProtectedBlob(downloadId, convResult.blobUrl, 'protected_' + downloadId);
    await settleEarlyTerminalDownload(downloadId);
    return { success: true, downloadId };
  } catch (err) {
    console.error(provider.conversionError, err);
    await fbFail(feedbackOp, { stage: convResult ? 'save' : 'convert', code: err?.message });
    await flashBadge('ERR', '#ef4444');
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Converts a confirmed X tweet_video MP4 animation into genuine looping GIF bytes
 * via offscreen document and returns the Blob URL and task key.
 */
async function convertXTweetVideoToGifBlob(videoUrl, options = {}) {
  return convertAnimationToGifBlob(videoUrl, options, 'x_gif_', 'CONVERT_X_TWEET_VIDEO_TO_GIF');
}

/**
 * Executes one-click genuine GIF conversion and download for an X tweet_video.
 * Enforces atomic task transfer, download tracking, and fail-safe badge handling.
 */
async function executeXTweetVideoGifDownload(videoUrl, settings = {}, options = {}) {
  return executeAnimationGifDownload(videoUrl, settings, options, convertXTweetVideoToGifBlob, X_ANIMATION);
}

/**
 * Converts a confirmed Reddit MP4 animation into genuine looping GIF bytes
 * via offscreen document and returns the Blob URL and task key.
 */
async function convertRedditVideoToGifBlob(videoUrl, options = {}) {
  return convertAnimationToGifBlob(videoUrl, options, 'reddit_gif_', 'CONVERT_REDDIT_VIDEO_TO_GIF');
}

/**
 * Executes one-click genuine GIF conversion and download for a confirmed Reddit animation.
 * Enforces atomic task transfer, download tracking, and fail-safe badge handling.
 */
async function executeRedditGifDownload(videoUrl, settings = {}, options = {}) {
  return executeAnimationGifDownload(videoUrl, settings, options, convertRedditVideoToGifBlob, REDDIT_ANIMATION);
}

// ---- REDDIT-HLS-01: one complete MP4 (video + audio) from the HLS master a selected Reddit player declares ----------------------------------------------
// The offscreen document fetches the playlist-declared fMP4 resources and remuxes them with the pinned MP4Box (lib/reddit_hls.mjs); this worker only
// validates the address, runs one assembly at a time, and hands the resulting Blob to the same download/tracking/revocation path as the Reddit GIF.
const REDDIT_HLS_MASTER = /^https:\/\/v\.redd\.it\/([A-Za-z0-9_-]{1,64})\/HLSPlaylist\.m3u8(?:\?[^#]*)?$/;
function redditHlsMasterUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  const m = url.match(REDDIT_HLS_MASTER);
  if (!m) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'v.redd.it' && !u.username && !u.password && !u.port ? { url: u.href, assetId: m[1] } : null;
  } catch (_) {
    return null;
  }
}

let redditHlsActive = false;

// The feedback failure of an assembly that did not produce a file. Unsupported sources are one category; a busy worker, network and integrity problems are theirs.
function redditHlsFailure(res) {
  const code = String((res && res.error) || '');
  const status = res && Number.isInteger(res.status) ? res.status : null;
  if (/^UNSUPPORTED_/.test(code) || code === 'TOO_LARGE' || code === 'FOREIGN_SOURCE') return { stage: 'resolve', code: 'UNSUPPORTED_SOURCE' };
  if (code === 'BUSY') return { stage: 'resolve', code: 'RATE_LIMIT' };
  if (code === 'HTTP_ERROR') {
    if (status === 401 || status === 403) return { stage: 'download', code: 'AUTH_REQUIRED', status };
    if (status === 404 || status === 410) return { stage: 'download', code: 'NOT_FOUND', status };
    if (status === 429) return { stage: 'download', code: 'RATE_LIMIT', status };
    return { stage: 'download', code: 'NETWORK_ERROR', status };
  }
  if (code === 'TIMEOUT') return { stage: 'download', code: 'NETWORK_TIMEOUT' };
  if (code === 'NETWORK' || code === 'ABORTED') return { stage: 'download', code: 'NETWORK_ERROR' };
  if (code === 'INCOMPLETE' || code === 'INVALID_MEDIA') return { stage: 'verify', code: 'INVALID_MEDIA' };
  return { stage: 'resolve', code: 'ASSEMBLE_FAILED' };
}

async function executeRedditHlsDownload(masterUrl, settings = {}, options = {}) {
  const feedbackOp = options?.feedbackOp || null;
  const master = redditHlsMasterUrl(masterUrl);
  if (!master) {
    await fbFail(feedbackOp, { stage: 'resolve', code: 'UNSUPPORTED_SOURCE' });
    await flashBadge('ERR', '#ef4444');
    return { success: false, error: 'UNSUPPORTED_SOURCE' };
  }
  // one assembly at a time (memory is bounded for one); another request is a visible failure, never silence
  if (redditHlsActive) {
    await fbFail(feedbackOp, redditHlsFailure({ error: 'BUSY' }));
    await flashBadge('ERR', '#ef4444');
    return { success: false, error: 'BUSY' };
  }
  redditHlsActive = true;
  let taskKey = null;
  let blobUrl = null;
  try {
    await setBadge('...', '#9333ea');
    await fbStage(feedbackOp, 'converting', { conversion: 'none', expectedType: 'video', sourceUrl: master.url, site: fbSiteOf(options?.pageUrl, master.url) });
    taskKey = acquireOffscreenTask('reddit_hls_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    await ensureOffscreenDocument();
    const res = await offscreenRequest({ action: 'ASSEMBLE_REDDIT_HLS', url: master.url, jobId: taskKey });
    if (!res || res.success !== true || typeof res.blobUrl !== 'string' || !res.blobUrl.startsWith('blob:') || !(res.size > 0)) {
      const failure = redditHlsFailure(res);
      // the worker log keeps only a bounded code and status: never an address, its query or text a server sent
      const logCode = res && typeof res.error === 'string' && /^[A-Z][A-Z_]{1,31}$/.test(res.error) ? res.error : 'ASSEMBLE_FAILED';
      const logStatus = res && Number.isInteger(res.status) && res.status >= 100 && res.status <= 599 ? ` ${res.status}` : '';
      console.warn(`[MediaLatch] Reddit HLS assembly failed: ${logCode}${logStatus}`);
      await fbFail(feedbackOp, failure);
      await releaseOffscreenTask(taskKey).catch(() => {});
      taskKey = null;
      await flashBadge('ERR', '#ef4444');
      return { success: false, error: (res && res.error) || 'ASSEMBLE_FAILED' };
    }
    blobUrl = res.blobUrl;
    await fbStage(feedbackOp, 'saving', { output: { type: 'video', ext: '.mp4', evidence: 'converted_output', mime: 'video/mp4', sizeBytes: res.size, sizeKind: 'measured', durationSec: Number.isFinite(res.duration) ? res.duration : null } });
    const filename = resolveDownloadPath({
      filename: `${master.assetId}.mp4`,
      subfolder: getConfiguredRoot(settings),
      folderOrganizationMode: settings?.folderOrganizationMode,
      xAuthor: settings?.xAuthor,
      mediaType: 'video',
      pageUrl: options?.pageUrl || '',
      resolvedUrl: master.url,
      contentType: 'video/mp4'
    });
    let downloadId = null;
    try {
      downloadId = await managedDownload({url:blobUrl,filename,saveAs:false}, feedbackOp, 'video/mp4');
    } catch (dlErr) {
      console.error('[MediaLatch] Ошибка chrome.downloads.download для собранного Reddit HLS видео:', dlErr);
      await fbFail(feedbackOp, { stage: 'save', code: dlErr?.message });
      await releaseOffscreenTask(taskKey, blobUrl).catch(() => {});
      taskKey = null;
      await flashBadge('ERR', '#ef4444');
      return { success: false, error: dlErr?.message || String(dlErr) };
    }
    await fbAttach(feedbackOp, downloadId, { filename });
    await addTrackedDownloadId(downloadId);
    await setBadge('DL', '#9333ea');
    transferOffscreenTask(taskKey, 'protected_' + downloadId, blobUrl);
    taskKey = null;
    await trackDownloadProtectedBlob(downloadId, blobUrl, 'protected_' + downloadId);
    await settleEarlyTerminalDownload(downloadId);
    return { success: true, downloadId };
  } catch (err) {
    console.error('[MediaLatch] Не удалось собрать и скачать Reddit HLS видео:', err);
    await fbFail(feedbackOp, { stage: 'resolve', code: 'ASSEMBLE_FAILED' });
    if (taskKey) await releaseOffscreenTask(taskKey, blobUrl).catch(() => {});
    await flashBadge('ERR', '#ef4444');
    return { success: false, error: err?.message || String(err) };
  } finally {
    redditHlsActive = false;
  }
}

/**
 * Closes the offscreen document when no tasks or active protected downloads remain.
 */
