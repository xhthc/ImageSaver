// Classic worker module; imported at the original initialization boundary.

// PIXIV-SAVING-POLISH-01: Pixiv originals are acquired by the download manager like any other file: its offscreen staging streams the
// exact declared URL to disk (the DNR Referer rule 1001 covers that request), shows receiving progress, ends a stalled transfer with
// NETWORK_TIMEOUT, and accepts the bytes only when their signature equals the expected image type and the declared length. The
// former in-worker data URL had one 20-second deadline for the whole body, so a slow large original was aborted and reported as an
// opaque HTTP 500. A declared size above the former 50 MiB Pixiv limit is still refused before any transfer.
const PIXIV_MAX_BYTES = 50 * 1024 * 1024;
const PIXIV_IMAGE_MIME = Object.freeze({ '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' });

/** The image type a Pixiv original must turn out to be: the probed image MIME, else its file extension; '' when neither says. */
function pixivExpectedMime(group, url) {
  const probed = String(group?.metadata?.contentType || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
  return probed.startsWith('image/') ? probed : (PIXIV_IMAGE_MIME[getSafeUrlExtension(url)] || '');
}

// ============================================================================
// 10. Context menu click handling & media download execution
// ============================================================================

/**
 * Resolves canonical numeric HTTP status code with strict structured precedence.
 * Only falls back to narrow textual status parsing when structured status is absent/0.
 * Rejects incidental numbers in diagnostic text (e.g. durations, IDs, reference numbers).
 */
function resolveCandidateHttpStatus(rawStatus, errorText) {
  if (typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus > 0) {
    return rawStatus;
  }
  if (typeof errorText === 'string' && errorText) {
    const match = errorText.match(/\b(?:HTTP(?:\s+status|\s+error)?|status(?:\s*code)?)\s*[:=]?\s*(\d{3})\b/i);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (parsed >= 100 && parsed <= 599) {
        return parsed;
      }
    }
  }
  return 0;
}

/**
 * Checks whether two candidate URLs positively reference the same underlying media resource.
 * Matches identical URLs or identical origin and pathname.
 */
function isSameMediaCandidateUrl(urlA, urlB) {
  if (!urlA || !urlB || typeof urlA !== 'string' || typeof urlB !== 'string') return false;
  if (urlA === urlB) return true;
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    if (a.origin === b.origin && a.pathname.toLowerCase() === b.pathname.toLowerCase()) {
      return true;
    }
  } catch (e) {}
  return false;
}

if (typeof globalThis !== 'undefined') {
  globalThis.resolveCandidateHttpStatus = resolveCandidateHttpStatus;
  globalThis.isSameMediaCandidateUrl = isSameMediaCandidateUrl;
}

/**
 * A download can reach a terminal state before the handler that started it has registered it: chrome.downloads.onChanged then only
 * recorded the state in earlyTerminalDownloadStates. Every save path calls this right after it registered the download, so such a
 * download is settled exactly as its event would have settled a registered one (untracked, badge, Blob owner released) instead of
 * staying tracked and shown as running, because no later event will ever arrive for it.
 */
async function settleEarlyTerminalDownload(downloadId) {
  if(isFileExport(downloadId)){await restoreOrClearBadge();return;}
  const earlyTerminal = earlyTerminalDownloadStates.get(downloadId);
  if (!earlyTerminal) return false;
  earlyTerminalDownloadStates.delete(downloadId);
  await untrackDownloadProtectedBlob(downloadId);
  await removeTrackedDownloadId(downloadId);
  activeDownloadsMetadata.delete(downloadId);
  if (earlyTerminal.state === 'complete') {
    console.log(`[MediaLatch] Загрузка ${downloadId} успешно завершена (early)`);
    await flashBadge('OK', '#22c55e');
  } else if (earlyTerminal.errorCode === 'USER_CANCELED') {
    await restoreOrClearBadge();
  } else {
    await flashBadge('ERR', '#ef4444');
  }
  if (offscreenState.activeOffscreenTasks === 0 && !hasActiveProtectedDownloads()) {
    await closeOffscreenDocument().catch(() => {});
  }
  return true;
}

/**
 * Generic executor for candidate group resolution plans.
 * Iterates through variants according to group's variantPolicy.
 * Employs structured validation result and canonical MIME filename generation.
 */
// A protected variant's terminal HTTP failure: the toolbar signal and the plan result the save ends with.
async function variantRefusal(status, errMsg) {
  if (status === 401 || status === 403) {
    await flashBadge('AUTH', '#f59e0b');
    return { success: false, error: 'AUTH_REQUIRED', status: status || 403 };
  }
  if (status === 429) {
    await flashBadge('RATE', '#f59e0b');
    return { success: false, error: 'RATE_LIMIT', status: 429 };
  }
  await flashBadge('ERR', '#ef4444');
  return { success: false, error: errMsg, status: status || 500 };
}

async function executeMediaPlanImpl(plan, settings = {}, rawImageUrl = '', options = {}) {
  const group = plan?.isCandidateGroup ? plan : adaptCandidateToGroup(plan);
  if (!group || !Array.isArray(group.variants) || group.variants.length === 0) {
    console.warn('[MediaLatch] executeMediaPlan: Недопустимый план или отсутствуют варианты:', plan);
    await flashBadge('ERR', '#ef4444');
    return { success: false, error: 'INVALID_PLAN', status: 400 };
  }

  const primaryUrl = group.primaryUrl;
  if (!rawImageUrl) {
    rawImageUrl = primaryUrl;
  }

  // Guard: Never download a web page as an image/media file (e.g. artwork page)
  const isHtmlPage = (function(url) {
    if (!url) return true;
    try {
      const u = new URL(url);
      const p = u.pathname.toLowerCase();
      const h = u.hostname.toLowerCase();
      if (isSameOrSubdomain(h, 'pixiv.net') && (p.includes('/artworks/') || p.includes('/illust'))) return true;
      if (/\.(html?|xhtml|php|asp|aspx)$/i.test(p) && !p.includes('image') && !p.includes('download')) return true;
    } catch (e) {}
    return false;
  })(primaryUrl);

  if (isHtmlPage) {
    console.warn('[MediaLatch] Отмена: целевой URL является веб-страницей (HTML), а не файлом медиа:', primaryUrl);
    await flashBadge('ERR', '#ef4444');
    return { success: false, error: 'HTML_PAGE', status: 400 };
  }

  const variantPolicy = group.variantPolicy || {};
  const advanceOnCodes = new Set(variantPolicy.advanceOn || [404, 410]);

  let structuredResult = null;
  let protectedBlobUrl = null;
  let protectedOwnerKey = null;

  // Positive association validation for reused protected Blob:
  let validReusedBlob = null;
  if (group.transport === 'protectedBlob') {
    const candidateReusedBlob = options?.verifiedBlob || group.verifiedBlob || plan?.verifiedBlob;
    if (candidateReusedBlob && candidateReusedBlob.blobUrl) {
      const blobUrlIdentity = typeof candidateReusedBlob.url === 'string' ? candidateReusedBlob.url.trim() : '';
      const matchingVariantIndex = blobUrlIdentity
        ? group.variants.findIndex(v => isSameMediaCandidateUrl(v.url, blobUrlIdentity))
        : -1;

      if (matchingVariantIndex !== -1) {
        validReusedBlob = candidateReusedBlob;
        validReusedBlob._matchingIndex = matchingVariantIndex;
      } else {
        // Missing or mismatching identity: strictly reject foreign or unassociated Blob and clean up its resources safely.
        console.warn('[MediaLatch] Отклонение verifiedBlob из-за отсутствия положительной связи с вариантами плана:', sanitizeUrlForLog(blobUrlIdentity || '(empty)'));
        if (candidateReusedBlob.probeTaskKey || candidateReusedBlob.blobUrl) {
          await releaseOffscreenTask(candidateReusedBlob.probeTaskKey, candidateReusedBlob.blobUrl).catch(() => {});
          delete candidateReusedBlob.probeTaskKey;
          delete candidateReusedBlob.blobUrl;
        }
      }
    }
  }

  for (let i = 0; i < group.variants.length; i++) {
    const variant = group.variants[i];
    const targetUrl = variant.url;
    if (!targetUrl.startsWith('blob:') && !targetUrl.startsWith('data:') && !MediaLatchSources.allows(targetUrl, options.pageUrl)) throw Error('INVALID_SOURCE');
    console.log(`[MediaLatch] Выполнение варианта [${i + 1}/${group.variants.length}] (${group.transport}):`, sanitizeUrlForLog(targetUrl));

    if (group.transport === 'protectedBlob') {
      if (validReusedBlob) {
        if (i !== validReusedBlob._matchingIndex) {
          continue; // Skip earlier variants to reach the positively associated variant
        }

        const normalizedMime = (validReusedBlob.contentType || group.metadata?.contentType || '').split(';')[0].trim().toLowerCase();
        const resolvedExtension = resolveCanonicalExtension(normalizedMime, variant.expectedExtension || targetUrl);

        structuredResult = {
          success: true,
          blobUrl: validReusedBlob.blobUrl,
          resolvedUrl: targetUrl,
          normalizedMime,
          resolvedExtension,
          size: validReusedBlob.size || 0,
          status: 200
        };
        protectedBlobUrl = validReusedBlob.blobUrl;
        protectedOwnerKey = validReusedBlob.probeTaskKey;
        offscreenState.activeOffscreenOwners.set(protectedOwnerKey, protectedBlobUrl);
        delete validReusedBlob.probeTaskKey;
        delete validReusedBlob.blobUrl;
        break; // Reused verified blob without duplicate fetch!
      }

      const variantKey = acquireOffscreenTask(`variant_${i}_${targetUrl}`);
      try {
        await ensureOffscreenDocument();
        const hostInfo = getProtectedHostInfo(targetUrl);
        const isGelbooru = hostInfo?.type === 'gelbooru';
        const action = isGelbooru ? 'FETCH_GELBOORU_BLOB' : 'FETCH_PROTECTED_BLOB';

        const fetchResult = await offscreenRequest({
          action,
          url: targetUrl
        });

        if (fetchResult && fetchResult.success && fetchResult.blobUrl) {
          const rawContentType = fetchResult.contentType || '';
          const normalizedMime = rawContentType.split(';')[0].trim().toLowerCase();
          const resolvedExtension = resolveCanonicalExtension(normalizedMime, variant.expectedExtension || targetUrl);

          structuredResult = {
            success: true,
            blobUrl: fetchResult.blobUrl,
            resolvedUrl: targetUrl,
            normalizedMime,
            resolvedExtension,
            size: fetchResult.size || 0,
            status: fetchResult.status || 200
          };
          protectedBlobUrl = fetchResult.blobUrl;
          protectedOwnerKey = variantKey;
          offscreenState.activeOffscreenOwners.set(variantKey, protectedBlobUrl);
          break; // First successful variant!
        }

        // Failed variant attempt
        await releaseOffscreenTask(variantKey);
        const status = resolveCandidateHttpStatus(fetchResult?.status, fetchResult?.error);
        const errMsg = fetchResult?.error || (status ? `HTTP ${status}` : 'Protected fetch failed');

        // Check if advanceable (404, 410)
        if (advanceOnCodes.has(status)) {
          console.warn(`[MediaLatch] Вариант вернул HTTP ${status}, переход к следующему варианту:`, sanitizeUrlForLog(targetUrl));
          continue;
        }

        // Non-advanceable error! Stop entire operation!
        console.error(`[MediaLatch] Критическая ошибка варианта (status: ${status}):`, errMsg);
        return await variantRefusal(status, errMsg);
      } catch (err) {
        await releaseOffscreenTask(variantKey);
        console.error('[MediaLatch] Исключение при выполнении варианта:', err);
        const status = resolveCandidateHttpStatus(err?.status, err?.message);
        const errMsg = err?.message || 'VARIANT_ERROR';
        if (advanceOnCodes.has(status)) {
          console.warn(`[MediaLatch] Исключение варианта с переходящим статусом HTTP ${status}, переход к следующему варианту:`, sanitizeUrlForLog(targetUrl));
          continue;
        }
        return await variantRefusal(status, errMsg);
      }
    } else if (group.transport === 'pixiv') {
      // The manager acquires the exact URL; nothing is fetched here. The expected image type is what staging must find in the bytes.
      const normalizedMime = pixivExpectedMime(group, targetUrl);
      if (!normalizedMime) {
        await flashBadge('ERR', '#ef4444');
        return { success: false, error: 'MIME_NOT_VERIFIED' };
      }
      if (Number(group.metadata?.contentLength) > PIXIV_MAX_BYTES) {
        await flashBadge('ERR', '#ef4444');
        return { success: false, error: 'SIZE_EXCEEDED' };
      }
      structuredResult = {
        success: true,
        blobUrl: null,
        resolvedUrl: targetUrl,
        normalizedMime,
        resolvedExtension: resolveCanonicalExtension(normalizedMime, variant.expectedExtension || targetUrl),
        size: Number(group.metadata?.contentLength) || 0,
        status: 200
      };
      break;
    } else {
      // Direct transport: central canonical filename policy
      const normalizedMime = (group.metadata?.contentType || '').split(';')[0].trim().toLowerCase();
      let resolvedExtension = resolveCanonicalExtension(normalizedMime, variant.expectedExtension || targetUrl);
      if (normalizedMime.startsWith('video/') && resolvedExtension === '.gif') {
        resolvedExtension = resolveCanonicalExtension(normalizedMime, targetUrl) || '.mp4';
      }

      structuredResult = {
        success: true,
        blobUrl: null,
        resolvedUrl: targetUrl,
        normalizedMime,
        resolvedExtension,
        size: group.metadata?.contentLength || 0,
        status: 200
      };
      break;
    }
  }

  // If no variant succeeded:
  if (!structuredResult || !structuredResult.success) {
    if (offscreenState.activeOffscreenTasks === 0) {
      await closeOffscreenDocument().catch(() => {});
    }
    console.warn('[MediaLatch] Все варианты логической группы отклонены (404/410 NOT_FOUND):', sanitizeGroupIdForLog(group.id));
    await flashBadge('ERR', '#ef4444');
    return {
      success: false,
      error: 'NOT_FOUND',
      status: 404
    };
  }

  // Canonical filename built using actual resolved variant and MIME
  const subfolder = getConfiguredRoot(settings);
  const finalPath = buildFinalFilename(
    structuredResult.resolvedUrl,
    structuredResult.resolvedExtension,
    subfolder,
    {
      folderOrganizationMode: settings.folderOrganizationMode,
      xAuthor: settings.xAuthor,
      author: settings.author,
      pageUrl: options?.pageUrl || group?.pageUrl || '',
      group,
      structuredResult
    }
  );

  const downloadSourceUrl = structuredResult.blobUrl || structuredResult.dataUrl || structuredResult.resolvedUrl;

  console.log('[MediaLatch] Запуск основного скачивания целевого медиа:', sanitizeUrlForLog({
    url: structuredResult.resolvedUrl,
    downloadSourceUrl: structuredResult.blobUrl ? '(blob URL)' : structuredResult.resolvedUrl,
    filename: finalPath,
    saveAs: false
  }));

  let downloadStarted = false;
  let downloadId = null;
  try {
    const downloadOptions = {
      url: downloadSourceUrl,
      filename: finalPath,
      saveAs: false
    };
    delete downloadOptions.headers;

    if (typeof options?.checkCancelled === 'function' && (await options.checkCancelled())) {
      throw new Error('JOB_CANCELLED_OR_EXPIRED');
    }

    downloadId = await managedDownload(downloadOptions, options?.feedbackOp, structuredResult.normalizedMime, group?.transport === 'pixiv' ? PIXIV_MAX_BYTES : 0, options.pageUrl);

    downloadStarted = true;
    if(Number.isInteger(downloadId))activeDownloadsMetadata.set(downloadId, {
      url: structuredResult.resolvedUrl,
      rawUrl: rawImageUrl || structuredResult.resolvedUrl,
      plan: group
    });
    await fbAttach(options?.feedbackOp, downloadId, { filename: finalPath, output: buildFeedbackOutput({ finalPath, structuredResult, group }) });

    if (protectedBlobUrl) {
      const newOwnerKey = `protected_${downloadId}`;
      if (protectedOwnerKey && protectedOwnerKey !== newOwnerKey) {
        transferOffscreenTask(protectedOwnerKey, newOwnerKey, protectedBlobUrl);
      }
      await trackDownloadProtectedBlob(downloadId, protectedBlobUrl, newOwnerKey);
    }

    await addTrackedDownloadId(downloadId);
    await setBadge('DL', '#9333ea');

    await settleEarlyTerminalDownload(downloadId);

    return {
      ...structuredResult,
      downloadId,
      filename: finalPath
    };
  } catch (primaryDownloadError) {
    if (protectedBlobUrl && !downloadStarted) {
      await releaseOffscreenTask(protectedOwnerKey || (downloadId ? `protected_${downloadId}` : null), protectedBlobUrl);
    }

    if (primaryDownloadError?.message?.includes('User cancelled') || primaryDownloadError?.message?.includes('user cancelled')) {
      console.log('[MediaLatch] Пользователь отменил выбор файла в системном диалоге сохранения');
      return { success: false, cancelled: true };
    }

    const isVideo = Boolean(
      (structuredResult?.normalizedMime && structuredResult.normalizedMime.startsWith('video/')) ||
      /\.(mp4|webm)($|\?)/i.test(structuredResult?.resolvedUrl || '') ||
      Boolean(group?.allowVideo) ||
      Boolean(plan?.allowVideo) ||
      Boolean(group?.metadata?.isVideo)
    );

    const isRawThumbnail = Boolean(
      isThumbnailUrl(rawImageUrl) ||
      /\/+(180x180|preview|thumbnails?|samples?|thumb)\/+/i.test(rawImageUrl)
    );

    const isAuthoritativeOriginal = Boolean(
      group?.tier === 'original' ||
      group?.isBooruCandidate ||
      group?.source === 'specialized_provider' ||
      group?.verified
    );

    // A Pixiv batch stops its remaining items after a final rate limit of the manager (its own Retry-After retries are exhausted).
    if (group?.transport === 'pixiv' && primaryDownloadError?.message === 'RATE_LIMIT') group._rateLimited = true;

    const disallowEmergencyFallback = Boolean(
      downloadManager ||
      options?.disallowFallback ||
      protectedBlobUrl ||
      isVideo ||
      (isAuthoritativeOriginal && isRawThumbnail) ||
      (group?.tier === 'original' && group?.source !== 'initial_src')
    );

    if (disallowEmergencyFallback) {
      console.warn('[MediaLatch] Сбой загрузки оригинального медиа, аварийный fallback запрещен:', primaryDownloadError);
      throw primaryDownloadError;
    }

    // Emergency fallback for direct URLs
    if (structuredResult.resolvedUrl !== rawImageUrl) {
      const fallbackFilename = getFilenameFromUrl(rawImageUrl);
      // Route by the fallback file itself (its name hint); the abandoned primary group's metadata
      // (e.g. image/gif) does not describe it, so no group is passed.
      const fallbackPath = resolveDownloadPath({
        filename: fallbackFilename,
        subfolder,
        folderOrganizationMode: settings.folderOrganizationMode,
      xAuthor: settings.xAuthor,
      author: settings.author,
        pageUrl: options?.pageUrl || group?.pageUrl || '',
        resolvedUrl: rawImageUrl,
        resolvedExtension: (fallbackFilename.match(/\.[^./]+$/) || [''])[0]
      });
      const fallbackSourceUrl = rawImageUrl;
      const fallbackOptions = {
        url: fallbackSourceUrl,
        filename: fallbackPath,
        saveAs: false
      };
      delete fallbackOptions.headers;

      const fallbackDownloadId = await managedDownload(fallbackOptions, options?.feedbackOp, '', 0, options.pageUrl);

      if(Number.isInteger(fallbackDownloadId))activeDownloadsMetadata.set(fallbackDownloadId, { url: fallbackSourceUrl, rawUrl: rawImageUrl });
      // The abandoned primary failure is recoverable: the operation continues with the fallback download.
      await fbAttach(options?.feedbackOp, fallbackDownloadId, {
        fallback: true,
        filename: fallbackPath,
        output: buildFeedbackOutput({ finalPath: fallbackPath, structuredResult: null, group: null, isFallback: true })
      });
      await addTrackedDownloadId(fallbackDownloadId);
      await setBadge('DL', '#9333ea');
      await settleEarlyTerminalDownload(fallbackDownloadId);
      return {
        success: true,
        downloadId: fallbackDownloadId,
        filename: fallbackPath,
        resolvedUrl: fallbackSourceUrl
      };
    } else {
      throw primaryDownloadError;
    }
  }
}

/**
 * Executes the download of resolved media (image or direct tweet-video MP4).
 * Backwards-compatible facade adapting single URL or candidate into a media plan.
 */
async function executeMediaDownload({ targetImageUrl, rawImageUrl, settings = {}, mediaPlan = null, disallowFallback = false, checkCancelled = null, pageUrl = '', feedbackOp = null }) {
  if (targetImageUrl && targetImageUrl.startsWith('blob:')) {
    console.warn('[MediaLatch] Попытка скачать blob URL напрямую отклонена (UNRESOLVED_BLOB_MEDIA):', sanitizeUrlForLog(targetImageUrl));
    await fbFail(feedbackOp, { stage: 'resolve', code: 'UNRESOLVED_BLOB_MEDIA' });
    await flashBadge('ERR', '#ef4444');
    return {
      success: false,
      error: 'UNRESOLVED_BLOB_MEDIA',
      status: 404
    };
  }
  let plan = mediaPlan;
  if (!plan && targetImageUrl) {
    const animeInfo = parseAnimePicturesCdnUrl(targetImageUrl);
    if (animeInfo) {
      plan = createAnimePicturesOriginalGroup(animeInfo.dir, animeInfo.md5);
    } else {
      plan = adaptCandidateToGroup({ url: targetImageUrl, source: 'unknown' });
    }
  }
  let result;
  try {
    result = await executeMediaPlan(plan, settings, rawImageUrl || targetImageUrl, { disallowFallback, checkCancelled, pageUrl: pageUrl || mediaPlan?.pageUrl, feedbackOp });
  } catch (err) {
    // the manager's staging reports RATE_LIMIT only for an observed HTTP 429; other codes carry no status here
    await fbFail(feedbackOp, { stage: 'save', code: err?.message, status: err?.message === 'RATE_LIMIT' ? 429 : null });
    throw err;
  }
  await fbSettleFromResult(feedbackOp, result);
  return result;
}

/**
 * Verifies final media MIME before chooser eligibility.
 * Does not trust URL pathname extension or query hints.
 * For direct video/image, probes via network.
 * For protected transport, uses protected fetch/probe when eligible and reuses Blob.
 * Returns verified MIME string or null if verification is unavailable.
 */
async function verifyFinalMediaMimeImpl(targetUrl, mediaPlan, isVideoContext, selectedPage = '') {
  if (!targetUrl || typeof targetUrl !== 'string') return null;

  const hostInfo = getProtectedHostInfo(targetUrl);
  const isProtected = mediaPlan?.transport === 'protected' || mediaPlan?.transport === 'protectedBlob' || Boolean(hostInfo);

  // 1. If candidate was already verified during candidate probing for this exact URL with HTTP evidence:
  // For protected hosts, candidate is only truly verified if verifiedBlob is already present!
  const meta = mediaPlan?.metadata;
  const isEvidenceHttp = meta?.mimeEvidence === MIME_EVIDENCE.HTTP_RESPONSE ||
                         meta?.mimeEvidence === MIME_EVIDENCE.PROTECTED_FETCH;
  const isUrlMatch = !meta?.verifiedUrl || meta?.verifiedUrl === targetUrl;
  const isCandidateVerified = Boolean(meta?.verified && isEvidenceHttp && isUrlMatch);

  const planMime = (meta?.contentType || mediaPlan?.variants?.[0]?.contentType || '').split(';')[0].trim().toLowerCase();
  if (isCandidateVerified && planMime && (planMime.startsWith('video/') || planMime.startsWith('image/'))) {
    if (!isProtected || mediaPlan?.verifiedBlob?.blobUrl) {
      return planMime;
    }
  }

  // 2. If protected transport (Anime-Pictures, Gelbooru, etc.), use protected fetch:
  if (isProtected) {
    const variantPolicy = mediaPlan?.variantPolicy || {};
    const advanceOnCodes = new Set(variantPolicy.advanceOn || [404, 410]);
    const variants = (mediaPlan?.isCandidateGroup && Array.isArray(mediaPlan.variants) && mediaPlan.variants.length > 0)
      ? mediaPlan.variants
      : [{ url: targetUrl }];

    let startIndex = variants.findIndex(v => v.url === targetUrl);
    if (startIndex === -1) startIndex = 0;

    for (let i = startIndex; i < variants.length; i++) {
      const currentVariant = variants[i];
      const currentUrl = currentVariant.url;
      const currentHostInfo = getProtectedHostInfo(currentUrl);

      const probeTaskKey = acquireOffscreenTask('mime_probe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      let transferredTask = false;
      let probeRes = null;
      try {
        const tOffscreenDocStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        await ensureOffscreenDocument();
        const tOffscreenDocReady = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        console.log(`[Chooser Profiler] 3a. offscreen document ready (duration: ${(tOffscreenDocReady - tOffscreenDocStart).toFixed(1)}ms)`);
        const action = currentHostInfo?.type === 'gelbooru' ? 'FETCH_GELBOORU_BLOB' : 'FETCH_PROTECTED_BLOB';
        console.log(`[Chooser Profiler] 3b. offscreen probe task dispatched (${action}) for variant [${i + 1}/${variants.length}]: ${sanitizeUrlForLog(currentUrl)}`);
        const tProbeStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        try {
          probeRes = await offscreenRequest({
            action,
            url: currentUrl
          });
        } catch (sendErr) {
          const errStr = (sendErr?.message || String(sendErr)).toLowerCase();
          const isConnLoss = errStr.includes('message channel closed') ||
                             errStr.includes('message port closed') ||
                             errStr.includes('could not establish connection') ||
                             errStr.includes('receiving end does not exist');
          if (isConnLoss) {
            console.warn('[MediaLatch] Message channel closed during protected probe, retrying once:', sendErr.message);
            await ensureOffscreenDocument();
            probeRes = await offscreenRequest({
              action,
              url: currentUrl
            });
          } else {
            throw sendErr;
          }
        }
        const tProbeEnd = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        console.log(`[Chooser Profiler] 3c. offscreen probe task completed (duration: ${(tProbeEnd - tProbeStart).toFixed(1)}ms, status: ${probeRes?.success ? 'success' : 'failed'}, size: ${probeRes?.size || 0} bytes)`);

        if (probeRes && probeRes.success && probeRes.blobUrl) {
          const verifiedContentType = (probeRes.contentType || '').split(';')[0].trim().toLowerCase();
          if (verifiedContentType && (verifiedContentType.startsWith('image/') || verifiedContentType.startsWith('video/'))) {
            if (mediaPlan?.metadata) {
              mediaPlan.metadata.contentType = verifiedContentType;
              mediaPlan.metadata.verified = true;
              mediaPlan.metadata.mimeEvidence = MIME_EVIDENCE.PROTECTED_FETCH;
              mediaPlan.metadata.verifiedUrl = currentUrl;
              if (probeRes.isAnimated !== undefined) {
                mediaPlan.metadata.isAnimated = probeRes.isAnimated;
              }
            }
            if (probeRes.isAnimated !== undefined && mediaPlan?.metadata) {
              mediaPlan.metadata.isAnimated = probeRes.isAnimated;
            }
            // Retain verified Blob URL for reuse in download execution, avoiding duplicate full download!
            mediaPlan.verifiedBlob = {
              blobUrl: probeRes.blobUrl,
              contentType: verifiedContentType,
              probeTaskKey: probeTaskKey,
              size: probeRes.size || 0,
              url: currentUrl
            };
            transferredTask = true;
            return verifiedContentType;
          }
          console.warn('[MediaLatch] Protected probe returned invalid/non-media MIME:', verifiedContentType);
          return null;
        }

        const status = resolveCandidateHttpStatus(probeRes?.status, probeRes?.error);
        const errMsg = probeRes?.error || (status ? `HTTP ${status}` : 'Protected probe failed');

        if (status === 429) {
          console.warn('[MediaLatch] HTTP 429 received during protected probe:', sanitizeUrlForLog(currentUrl));
          if (mediaPlan) {
            mediaPlan._rateLimited = true;
            mediaPlan._verificationStatus = 429;
            mediaPlan.error = 'RATE_LIMIT';
          }
          await flashBadge('RATE', '#f59e0b');
          return null;
        }

        if (status === 403 || status === 401) {
          console.warn('[MediaLatch] HTTP 403/401 received during protected probe:', sanitizeUrlForLog(currentUrl));
          if (mediaPlan) {
            mediaPlan._verificationStatus = status;
            mediaPlan.error = 'AUTH_REQUIRED';
          }
          await flashBadge('AUTH', '#f59e0b');
          return null;
        }

        if (advanceOnCodes.has(status)) {
          console.warn(`[MediaLatch] Вариант вернул HTTP ${status}, переход к следующему варианту:`, sanitizeUrlForLog(currentUrl));
          continue;
        }

        console.warn(`[MediaLatch] Защищенный зонд завершился с непереходной ошибкой (status: ${status}):`, errMsg);
        return null;
      } catch (e) {
        console.warn('[MediaLatch] Protected probe failed for MIME verification:', e);
        const status = resolveCandidateHttpStatus(e?.status, e?.message);
        if (status === 429) {
          if (mediaPlan) {
            mediaPlan._rateLimited = true;
            mediaPlan._verificationStatus = 429;
            mediaPlan.error = 'RATE_LIMIT';
          }
          await flashBadge('RATE', '#f59e0b');
          return null;
        } else if (status === 403 || status === 401) {
          if (mediaPlan) {
            mediaPlan._verificationStatus = status;
            mediaPlan.error = 'AUTH_REQUIRED';
          }
          await flashBadge('AUTH', '#f59e0b');
          return null;
        } else if (advanceOnCodes.has(status)) {
          console.warn(`[MediaLatch] Исключение зонда с переходящим статусом HTTP ${status}, переход к следующему варианту:`, sanitizeUrlForLog(currentUrl));
          continue;
        }
        return null;
      } finally {
        if (!transferredTask) {
          await releaseOffscreenTask(probeTaskKey, probeRes?.blobUrl).catch(() => {});
        }
      }
    }
    return null;
  }

  // 3. For direct/unprotected video URLs (including Reddit, RedGIFs frame-resolved, direct CDN):
  if (isVideoContext || isDirectVideoUrl(targetUrl)) {
    const variantPolicy = mediaPlan?.variantPolicy || {};
    const advanceOnCodes = new Set(variantPolicy.advanceOn || [404, 410]);
    const variants = (mediaPlan?.isCandidateGroup && Array.isArray(mediaPlan.variants) && mediaPlan.variants.length > 0)
      ? mediaPlan.variants
      : [{ url: targetUrl }];
    let startIndex = variants.findIndex(v => v.url === targetUrl);
    if (startIndex === -1) startIndex = 0;

    for (let i = startIndex; i < variants.length; i++) {
      const currentUrl = variants[i].url;
      const probe = await probeVideoUrlDetails(currentUrl, selectedPage);
      if (probe && (probe.status === 429 || probe.error === 'RATE_LIMIT')) {
        console.warn('[MediaLatch] HTTP 429 received during video probe:', sanitizeUrlForLog(currentUrl));
        if (mediaPlan) {
          mediaPlan._rateLimited = true;
          mediaPlan._verificationStatus = 429;
        }
        await flashBadge('RATE', '#f59e0b');
        return null;
      }
      if (probe && (probe.status === 401 || probe.status === 403 || probe.requiresAuth)) {
        console.warn(`[MediaLatch] HTTP ${probe.status} received during video probe:`, sanitizeUrlForLog(currentUrl));
        if (mediaPlan) {
          mediaPlan._verificationStatus = probe.status;
          mediaPlan.error = 'AUTH_REQUIRED';
        }
        await flashBadge('AUTH', '#f59e0b');
        return null;
      }
      if (probe && probe.ok && probe.contentType) {
        const verifiedType = probe.contentType.split(';')[0].trim().toLowerCase();
        if (verifiedType.startsWith('video/')) {
          if (mediaPlan?.metadata) {
            mediaPlan.metadata.contentType = verifiedType;
            mediaPlan.metadata.verified = true;
            mediaPlan.metadata.mimeEvidence = MIME_EVIDENCE.HTTP_RESPONSE;
            mediaPlan.metadata.verifiedUrl = currentUrl;
          }
          // The verified member becomes the plan's first variant (as resolveOriginalMediaPlan does for a probed group): primaryUrl is a getter over
          // variants[0], and the direct executor starts there, so the URL that downloads is the URL whose MIME was just recorded. Members only, none added.
          if (i > 0 && mediaPlan?.isCandidateGroup && mediaPlan.variants === variants) {
            variants.unshift(variants.splice(i, 1)[0]);
          }
          return verifiedType;
        }
      }
      const status = probe?.status || (probe?.error === 'NOT_FOUND' ? 404 : (probe?.error === 'GONE' ? 410 : 0));
      if (advanceOnCodes.has(status)) {
        console.warn(`[MediaLatch] Direct video variant returned HTTP ${status}, advancing to next variant:`, sanitizeUrlForLog(currentUrl));
        continue;
      }
      if (mediaPlan) {
        mediaPlan._verificationStatus = status || 500;
        mediaPlan._verificationStatusObserved = Boolean(status);
        mediaPlan._probeFailed = true;
      }
      return null;
    }
    return null;
  }

  // 4. Direct image probe:
  const probeTarget = {
    url: targetUrl,
    selectedPage,
    source: 'final_verification',
    finalScore: 0,
    baseScore: 0,
    verified: false,
    contentLength: 0,
    contentType: ''
  };
  const isOk = await probeCandidate(probeTarget);
  if (probeTarget.status === 429) {
    console.warn('[MediaLatch] HTTP 429 received during image probe:', sanitizeUrlForLog(targetUrl));
    if (mediaPlan) {
      mediaPlan._rateLimited = true;
      mediaPlan._verificationStatus = 429;
      mediaPlan.error = 'RATE_LIMIT';
    }
    await flashBadge('RATE', '#f59e0b');
    return null;
  }
  if (probeTarget.status === 403 || probeTarget.status === 401) {
    console.warn(`[MediaLatch] HTTP ${probeTarget.status} received during image probe:`, sanitizeUrlForLog(targetUrl));
    if (mediaPlan) {
      mediaPlan._verificationStatus = probeTarget.status;
      mediaPlan.error = 'AUTH_REQUIRED';
    }
    await flashBadge('AUTH', '#f59e0b');
    return null;
  }
  if (isOk && probeTarget.contentType) {
    const verifiedType = probeTarget.contentType.split(';')[0].trim().toLowerCase();
    if (verifiedType.startsWith('image/')) {
      if (mediaPlan?.metadata) {
        mediaPlan.metadata.contentType = verifiedType;
        mediaPlan.metadata.verified = true;
        mediaPlan.metadata.mimeEvidence = MIME_EVIDENCE.HTTP_RESPONSE;
        mediaPlan.metadata.verifiedUrl = targetUrl;
      }
      return verifiedType;
    }
  }

  // PIXIV-SAVING-POLISH-01: a Pixiv probe that got no answer at all (its 3.5 s deadline on a busy link, or a network failure) says
  // nothing about the file. The manager's staging verifies the actual bytes against this expected image type before any export, so
  // the save continues with that check instead of failing here. An answered probe (status, size, MIME) still decides above.
  if (!isOk && mediaPlan?.transport === 'pixiv' && !probeTarget.status && probeTarget.networkError) {
    const expected = pixivExpectedMime(mediaPlan, targetUrl);
    if (expected) {
      console.warn(`[MediaLatch] Pixiv probe got no answer (${probeTarget.networkError}); bytes are verified by staging:`, sanitizeUrlForLog(targetUrl));
      return expected;
    }
  }

  if (!isOk) {
    console.warn(`[MediaLatch] Финальная проверка изображения не подтвердила тип (HTTP: ${probeTarget.status || 'не наблюдался'}):`, sanitizeUrlForLog(targetUrl));
    if (mediaPlan) {
      mediaPlan._verificationStatus = probeTarget.status || 500;
      mediaPlan._verificationStatusObserved = Boolean(probeTarget.status);
      mediaPlan._probeFailed = true;
      mediaPlan._probeNetworkError = probeTarget.networkError || '';
    }
  }

  return null;
}
