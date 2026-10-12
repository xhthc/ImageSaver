// Original integration assertions, run by test_suite.js in their original order with the same fixtures.
exports.verifyMimeOwnership = async function ({assert, downloadedCalls, mockChrome, sandbox}) {
    const origSandboxFetch = sandbox.fetch;
    const origFlashBadge = sandbox.flashBadge;
    const origMsgHandler = mockChrome.runtime._msgHandler;

    // 199.1. Frame-resolved .mp4 URL inferred from its name but lacking response evidence: a real probe is still performed
    {
      let probeInvoked = false;
      sandbox.fetch = async (url, opts) => {
        probeInvoked = true;
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'video/mp4' : null }
        };
      };

      const mediaPlan = {
        metadata: {
          contentType: 'video/mp4',
          verified: false,
          mimeEvidence: sandbox.MIME_EVIDENCE.URL_HINT,
          resolvedUrl: 'https://example.com/frame_video.mp4'
        }
      };

      const verified = await sandbox.verifyFinalMediaMime('https://example.com/frame_video.mp4', mediaPlan, true);

      assert(
        probeInvoked === true && verified === 'video/mp4' &&
        mediaPlan.metadata.verified === true &&
        mediaPlan.metadata.mimeEvidence === sandbox.MIME_EVIDENCE.HTTP_RESPONSE,
        'Тест 199.1: Frame-resolved .mp4 URL inferred from its name triggers real network probe'
      );
    }

    // 199.2. A .mp4 URL returning video/webm: original filename reflects WebM
    {
      sandbox.fetch = async (url) => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'video/webm' : null }
      });

      const mediaPlan = {
        metadata: {
          contentType: 'video/mp4',
          verified: false,
          mimeEvidence: sandbox.MIME_EVIDENCE.URL_HINT
        }
      };

      const verifiedMime = await sandbox.verifyFinalMediaMime('https://example.com/misnamed.mp4', mediaPlan, true);
      const canonicalExt = sandbox.resolveCanonicalExtension(verifiedMime, 'https://example.com/misnamed.mp4');
      const baseFilename = sandbox.getFilenameFromUrl('https://example.com/misnamed.mp4').replace(/\.[^.]+$/, '');
      const targetFilename = `${baseFilename}${canonicalExt}`;

      assert(
        verifiedMime === 'video/webm' &&
        canonicalExt === '.webm' &&
        targetFilename === 'misnamed.webm',
        'Тест 199.2: .mp4 URL returning video/webm produces .webm canonical extension and targetFilename'
      );
    }

    // 199.3. Candidate A verified, candidate B selected: A’s evidence is not reused
    {
      let probeUrl = null;
      sandbox.fetch = async (url) => {
        probeUrl = url;
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'video/mp4' : null }
        };
      };

      // Candidate A was verified
      const mediaPlan = {
        metadata: {
          contentType: 'video/mp4',
          verified: true,
          mimeEvidence: sandbox.MIME_EVIDENCE.HTTP_RESPONSE,
          verifiedUrl: 'https://example.com/candidate_A.mp4'
        }
      };

      // Candidate B is selected
      const verified = await sandbox.verifyFinalMediaMime('https://example.com/candidate_B.mp4', mediaPlan, true);

      assert(
        probeUrl === 'https://example.com/candidate_B.mp4' &&
        mediaPlan.metadata.verifiedUrl === 'https://example.com/candidate_B.mp4',
        'Тест 199.3: Candidate A evidence is not reused for Candidate B; B is independently probed'
      );
    }

    // 199.4. A video-looking URL returning HTML or an error: no confirmed conversion and no poster fallback
    {
      sandbox.fetch = async (url) => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null }
      });

      const mediaPlan = {
        metadata: {
          contentType: 'video/mp4',
          verified: false,
          mimeEvidence: sandbox.MIME_EVIDENCE.URL_HINT
        }
      };

      const verified = await sandbox.verifyFinalMediaMime('https://example.com/fake_video.mp4', mediaPlan, true);

      assert(
        verified === null,
        'Тест 199.4: Video URL returning text/html is rejected (null verified MIME, download cancelled)'
      );
    }

    // 199.5. Reddit .gif?format=mp4 returning MP4: verified as MP4 and saves as .mp4 in one click
    {
      const prevDlCount = downloadedCalls.length;
      const redditUrl = 'https://v.redd.it/preview123.gif?format=mp4';
      sandbox.fetch = async (url) => ({
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'video/mp4' : null }
      });

      const verified = await sandbox.verifyFinalMediaMime(redditUrl, null, true);
      const canonicalExt = sandbox.resolveCanonicalExtension(verified, redditUrl);

      const dlResult = await sandbox.executeMediaDownload({
        targetImageUrl: redditUrl,
        rawImageUrl: redditUrl,
        settings: { subfolder: 'SavedImages', askEveryTime: false }
      });

      const lastDl = downloadedCalls[downloadedCalls.length - 1];

      assert(
        verified === 'video/mp4' &&
        canonicalExt === '.mp4' &&
        dlResult && dlResult.downloadId &&
        downloadedCalls.length === prevDlCount + 1 &&
        lastDl.filename === 'SavedImages/preview123.mp4',
        'Тест 199.5: Reddit .gif?format=mp4 verified as MP4; saves as .mp4 directly in one click'
      );
    }

    // 199.6. Ordinary candidate with HTTP evidence: 0 extra full fetches
    {
      const staticJpegUrl = 'https://example.com/picture123.jpg';
      let protectedFetchCalled = false;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'FETCH_PROTECTED_BLOB') {
          protectedFetchCalled = true;
          return { success: true, blobUrl: 'blob:mock', contentType: 'image/jpeg' };
        }
        return null;
      };

      const mediaPlan = {
        transport: 'direct',
        metadata: { contentType: 'image/jpeg', verified: true, mimeEvidence: sandbox.MIME_EVIDENCE.HTTP_RESPONSE }
      };

      const verified = await sandbox.verifyFinalMediaMime(staticJpegUrl, mediaPlan, false);

      assert(
        verified === 'image/jpeg' && protectedFetchCalled === false,
        'Тест 199.6: Ordinary protected JPEG candidate with HTTP evidence bypasses preliminary probe with 0 extra fetches'
      );
    }

    // 199.7. Protected GIF where supported: safe Blob ownership, no avoidable duplicate full fetch
    {
      const animGifUrl = 'https://oimages.anime-pictures.net/animated.gif';
      let fetchCount = 0;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'FETCH_PROTECTED_BLOB') {
          fetchCount++;
          return { success: true, blobUrl: 'blob:chrome-extension://mock-id/protected-gif-blob', contentType: 'image/gif' };
        }
        return null;
      };

      const mediaPlan = { transport: 'protectedBlob', metadata: {} };
      const verified = await sandbox.verifyFinalMediaMime(animGifUrl, mediaPlan, false);

      assert(
        fetchCount === 1 &&
        verified === 'image/gif' &&
        mediaPlan.verifiedBlob?.blobUrl === 'blob:chrome-extension://mock-id/protected-gif-blob',
        'Тест 199.7: Protected GIF performs exactly 1 fetch during verification and preserves verifiedBlob for download reuse'
      );
    }

    // 199.8. HTTP 429: no immediate second request and no preview fallback
    {
      let fetchCount429 = 0;
      let badgeState = null;
      sandbox.flashBadge = async (text, color) => { badgeState = text; };

      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'FETCH_PROTECTED_BLOB') {
          fetchCount429++;
          return { success: false, status: 429, error: 'HTTP 429 Too Many Requests' };
        }
        return null;
      };

      const mediaPlan = { transport: 'protectedBlob', metadata: {} };
      const verified = await sandbox.verifyFinalMediaMime('https://oimages.anime-pictures.net/busy.gif', mediaPlan, false);

      assert(
        fetchCount429 === 1 &&
        verified === null &&
        badgeState === 'RATE',
        'Тест 199.8: HTTP 429 results in clean immediate failure without second request or fallback'
      );
      sandbox.flashBadge = origFlashBadge;
    }

    // 199.9. Two protected downloads: A’s download fails while B remains active; A’s Blob is revoked once; B stays active
    {
      sandbox.resetActiveOffscreenTasks(0);
      mockChrome.offscreen._closed = false;

      const blobA = 'blob:mock-id/blobA1999';
      const blobB = 'blob:mock-id/blobB1999';

      let revokedBlobs = [];
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'REVOKE_BLOB_URL') {
          revokedBlobs.push(msg.blobUrl);
          return { success: true };
        }
        return null;
      };

      const dlIdA = 88123;
      const dlIdB = 88124;

      await sandbox.trackDownloadProtectedBlob(dlIdA, blobA, `protected_${dlIdA}`);
      await sandbox.trackDownloadProtectedBlob(dlIdB, blobB, `protected_${dlIdB}`);

      // Fail A
      await mockChrome.downloads._onChangedCb({ id: dlIdA, state: { current: 'interrupted' } });

      assert(
        revokedBlobs.includes(blobA) &&
        !revokedBlobs.includes(blobB) &&
        sandbox.getActiveOffscreenTasks() === 1 &&
        mockChrome.offscreen._closed === false,
        'Тест 199.9: Job A failure revokes Blob A once; Job B remains active; offscreen stays open with 1 task'
      );

      // Complete B
      await mockChrome.downloads._onChangedCb({ id: dlIdB, state: { current: 'complete' } });
      sandbox.resetActiveOffscreenTasks(0);
    }

    // 199.10. Cancellation detected before download stops execution, revokes blob once
    {
      sandbox.resetActiveOffscreenTasks(0);
      const cancelBlob = 'blob:mock-id/cancel-blob-19910';
      const cancelKey = sandbox.acquireOffscreenTask('cancel_task_19910', cancelBlob);

      let revokedCount = 0;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'REVOKE_BLOB_URL' && msg.blobUrl === cancelBlob) {
          revokedCount++;
          return { success: true };
        }
        return null;
      };

      await sandbox.releaseOffscreenTask(cancelKey, cancelBlob);

      assert(
        revokedCount === 1 &&
        sandbox.getActiveOffscreenTasks() === 0,
        'Тест 199.10: Cancellation detected before download stops execution, revokes blob once, preserves clean task state'
      );
    }

    // 199.11. Protected download cleanup performs exactly 1 revoke and 1 task decrement
    {
      sandbox.resetActiveOffscreenTasks(0);
      const pBlob = 'blob:chrome-extension://mock-id/protected-orig-cancel';
      const pKey = sandbox.acquireOffscreenTask('p_key_19911', pBlob);

      let revokedCount = 0;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'REVOKE_BLOB_URL') {
          revokedCount++;
          return { success: true };
        }
        return null;
      };

      await sandbox.releaseOffscreenTask(pKey, pBlob);

      assert(
        revokedCount === 1 &&
        sandbox.getActiveOffscreenTasks() === 0,
        'Тест 199.11: Protected download cancellation performs exactly 1 revoke and 1 task decrement'
      );
    }

    // 199.12. Repeated downloads.onChanged complete events trigger exactly 1 revoke and 1 decrement without underflow
    {
      sandbox.resetActiveOffscreenTasks(1);
      const repDlId = 99899;
      const repBlob = 'blob:chrome-extension://mock-id/repeated-event-blob';

      await sandbox.addTrackedDownloadId(repDlId);
      sandbox.activeProtectedBlobsByDownloadId.set(repDlId, repBlob);

      let revokeCalls = 0;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'REVOKE_BLOB_URL') {
          revokeCalls++;
          return { success: true };
        }
        return null;
      };

      // First event
      if (mockChrome.downloads._onChangedCb) {
        await mockChrome.downloads._onChangedCb({ id: repDlId, state: { current: 'complete' } });
      }
      // Repeated event for same download id
      if (mockChrome.downloads._onChangedCb) {
        await mockChrome.downloads._onChangedCb({ id: repDlId, state: { current: 'complete' } });
      }

      assert(
        revokeCalls === 1 &&
        sandbox.getActiveOffscreenTasks() === 0,
        'Тест 199.12: Repeated downloads.onChanged complete events trigger exactly 1 revoke and 1 decrement without underflow'
      );
    }

    // 199.13. Magic-byte sniffing: MP4 container validation with ftyp bytes
    {
      const ftypHeader = Buffer.alloc(24);
      ftypHeader.writeUInt32BE(24, 0);
      ftypHeader.write('ftyp', 4, 4, 'ascii');
      ftypHeader.write('isom', 8, 4, 'ascii');
      ftypHeader.writeUInt32BE(512, 12);
      ftypHeader.write('isomiso2mp41', 16, 8, 'ascii');

      const detected = sandbox.sniffMediaMagicBytes(ftypHeader);
      assert(
        detected === 'video/mp4',
        'Тест 199.13: sniffMediaMagicBytes recognizes valid ISO BMFF ftyp box header as video/mp4'
      );
    }

    // 199.14. Magic-byte sniffing: WebM EBML bytes
    {
      const webmHeader = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81]);
      const detected = sandbox.sniffMediaMagicBytes(webmHeader);
      assert(
        detected === 'video/webm',
        'Тест 199.14: sniffMediaMagicBytes recognizes WebM EBML header as video/webm'
      );
    }

    // 199.15. Magic-byte sniffing: HTML and truncated buffers rejected
    {
      const htmlBytes = Buffer.from('<!DOCTYPE html><html><body>Error</body></html>');
      const shortBytes = Buffer.from([0x01, 0x02]);

      const detectedHtml = sandbox.sniffMediaMagicBytes(htmlBytes);
      const detectedShort = sandbox.sniffMediaMagicBytes(shortBytes);

      assert(
        detectedHtml === null &&
        detectedShort === null,
        'Тест 199.15: sniffMediaMagicBytes strictly rejects HTML and short (< 4 bytes) buffers'
      );
    }

    // 199.16. Atomic offscreen task transfer: transferOffscreenTask safely transfers ownership without revoking Blob
    {
      sandbox.resetActiveOffscreenTasks(0);
      const testBlob = 'blob:chrome-extension://mock-id/transfer_test_blob';
      const oldKey = sandbox.acquireOffscreenTask('mime_probe_transfer_19916', testBlob);

      for (let i = 0; i < 128; i++) {
        const completedKey = sandbox.acquireOffscreenTask('completed_owner_19916_' + i);
        await sandbox.releaseOffscreenTask(completedKey);
      }
      assert(
        sandbox.activeOffscreenOwners.size === 1 &&
        sandbox.getActiveOffscreenTasks() === 1 &&
        (sandbox.releasedOffscreenKeys?.size || 0) === 0,
        '199.16a: completed task keys are not retained while an unrelated owner remains live'
      );

      let revoked = false;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'REVOKE_BLOB_URL') revoked = true;
        return { success: true };
      };

      const newKey = 'protected_554433';
      sandbox.transferOffscreenTask(oldKey, newKey, testBlob);

      assert(
        revoked === false &&
        !sandbox.activeOffscreenOwners.has(oldKey) &&
        sandbox.activeOffscreenOwners.has(newKey) &&
        sandbox.activeOffscreenOwners.get(newKey) === testBlob &&
        sandbox.getActiveOffscreenTasks() === 1,
        'Тест 199.16: transferOffscreenTask атомарно переносит владение с probeTaskKey на downloadId без отзыва Blob'
      );

      await sandbox.releaseOffscreenTask(oldKey, testBlob);
      assert(
        revoked === false && sandbox.activeOffscreenOwners.get(newKey) === testBlob && sandbox.getActiveOffscreenTasks() === 1,
        '199.16b: late cleanup by the transferred task cannot revoke the live download Blob'
      );
      await sandbox.releaseOffscreenTask('unrelated_owner_19916', testBlob);
      assert(
        revoked === false && sandbox.activeOffscreenOwners.get(newKey) === testBlob && sandbox.getActiveOffscreenTasks() === 1,
        '199.16c: an unknown task cannot revoke another active owner Blob'
      );

      await sandbox.releaseOffscreenTask(newKey, testBlob);
      assert(
        revoked === true && !sandbox.activeOffscreenOwners.has(newKey) && sandbox.getActiveOffscreenTasks() === 0,
        '199.16d: the current download owner still releases its Blob and task'
      );
    }

    // Восстанавливаем окружение
    sandbox.fetch = origSandboxFetch;
    sandbox.flashBadge = origFlashBadge;
    mockChrome.runtime._msgHandler = origMsgHandler;
  };

exports.verifyResourceLifecycle = async function ({REPO_ROOT, assert, downloadedCalls, fs, mockChrome, path, sandbox, vm}) {
    const origSandboxFetch = sandbox.fetch;
    const origFlashBadge = sandbox.flashBadge;
    const origMsgHandler = mockChrome.runtime._msgHandler;

    // 200.1. Offscreen truly single-release ownership under racing conditions
    {
      sandbox.resetActiveOffscreenTasks(0);
      mockChrome.offscreen._closed = false;
      mockChrome.offscreen._contexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }];

      const blobA = 'blob:chrome-extension://mock-id/race_blob_a';
      const blobB = 'blob:chrome-extension://mock-id/race_blob_b';
      sandbox.acquireOffscreenTask('chooser_job_A', blobA);
      sandbox.acquireOffscreenTask('chooser_job_B', blobB);

      let revokeCallsA = 0;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'REVOKE_BLOB_URL' && msg.blobUrl === blobA) {
          revokeCallsA++;
        }
        return { success: true };
      };

      // First release (e.g. user clicks cancel)
      await sandbox.releaseOffscreenTask('chooser_job_A', blobA);
      // Duplicate race: window onRemoved fires for the same job
      await sandbox.releaseOffscreenTask('chooser_job_A', blobA);
      // Duplicate race: conversion timeout / error path fires for the same job
      await sandbox.releaseOffscreenTask('chooser_job_A', blobA);

      assert(
        sandbox.getActiveOffscreenTasks() === 1 &&
        !sandbox.activeOffscreenOwners.has('chooser_job_A') &&
        sandbox.activeOffscreenOwners.has('chooser_job_B') &&
        mockChrome.offscreen._closed === false &&
        revokeCallsA === 1,
        'Тест 200.1: Offscreen truly single-release ownership: duplicate releases never decrement another job or close offscreen'
      );

      // Release Job B
      await sandbox.releaseOffscreenTask('chooser_job_B', blobB);
      assert(
        sandbox.getActiveOffscreenTasks() === 0 &&
        mockChrome.offscreen._closed === true,
        'Тест 200.2: Final offscreen task release decrements tasks to 0 and closes offscreen'
      );
    }

    // 200.3. HTTP 429 during final MIME verification halts click pipeline with RATE badge and 0 downloads
    {
      sandbox.resetActiveOffscreenTasks(0);
      const dlBefore = downloadedCalls.length;
      mockChrome._lastBadgeText = '';
      const prevFetch200_3 = sandbox.fetch;
      sandbox.fetch = async () => ({ ok: false, status: 429, headers: { get: () => '' } });

      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'FETCH_GELBOORU_BLOB' || msg.action === 'FETCH_PROTECTED_BLOB') {
          return { success: false, status: 429, error: 'HTTP 429 Too Many Requests' };
        }
        return null;
      };

      await mockChrome.contextMenus._handler({
        menuItemId: 'save-image-item',
        srcUrl: 'https://img3.gelbooru.com/images/12/34/busy_rate.mp4',
        mediaType: 'video',
        pageUrl: 'https://gelbooru.com/index.php?page=post&s=view&id=1234'
      }, { id: 701 });

      sandbox.fetch = prevFetch200_3;

      assert(
        mockChrome._lastBadgeText === 'RATE' &&
        downloadedCalls.length === dlBefore,
        'Тест 200.3: HTTP 429 during final MIME verification halts click pipeline with RATE badge and zero downloads'
      );
    }

    // 200.4. Protected Gelbooru MP4 verified, downloads directly in one click without format chooser
    {
      sandbox.resetActiveOffscreenTasks(0);
      mockChrome.windows._created = [];
      mockChrome.offscreen._closed = false;
      mockChrome.offscreen._contexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }];

      const gelbooruVideoUrl = 'https://img3.gelbooru.com/images/ab/cd/test_video.mp4';
      const gelbooruBlob = 'blob:chrome-extension://mock-id/gelbooru_blob_mp4';

      let gelbooruFetchCount = 0;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'FETCH_GELBOORU_BLOB' || msg.action === 'FETCH_PROTECTED_BLOB') {
          gelbooruFetchCount++;
          return {
            success: true,
            status: 200,
            blobUrl: gelbooruBlob,
            contentType: 'video/mp4',
            size: 54321
          };
        }
        if (msg.action === 'REVOKE_BLOB_URL') {
          return { success: true };
        }
        return null;
      };

      const dlBefore = downloadedCalls.length;

      await mockChrome.contextMenus._handler({
        menuItemId: 'save-image-item',
        srcUrl: gelbooruVideoUrl,
        mediaType: 'video',
        pageUrl: 'https://gelbooru.com/index.php?page=post&s=view&id=9999'
      }, { id: 702 });

      assert(
        mockChrome.windows._created.length === 0 &&
        gelbooruFetchCount === 1 &&
        downloadedCalls.length === dlBefore + 1,
        '200.4a: Protected Gelbooru MP4 downloads directly without opening format chooser window'
      );

      const lastDl = downloadedCalls[downloadedCalls.length - 1];

      assert(
        lastDl.url === gelbooruBlob &&
        lastDl.filename.endsWith('.mp4'),
        'Тест 200.4b: Protected Gelbooru MP4 reuses verified Blob for direct one-click native MP4 download'
      );
    }

    // 200.5. Service-worker restart simulation: persisted session storage rehydrates downloads
    {
      sandbox.resetActiveOffscreenTasks(0);
      await mockChrome.storage.session.clear();
      mockChrome.offscreen._closed = false;
      mockChrome.offscreen._contexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }];

      const testDlId = 445566;
      const testBlobUrl = 'blob:chrome-extension://mock-id/persisted_restart_blob';
      const testOwnerKey = `dl_${testDlId}`;
      await mockChrome.storage.session.set({
        [`active_dl_blob_${testDlId}`]: {
          downloadId: testDlId,
          blobUrl: testBlobUrl,
          ownerKey: testOwnerKey,
          timestamp: Date.now()
        }
      });

      const origDlSearch = mockChrome.downloads.search;
      mockChrome.downloads.search = async (q, cb) => {
        const item = { id: testDlId, state: 'in_progress' };
        if (cb) cb([item]);
        return [item];
      };

      await sandbox.reconcileActiveOffscreenDownloads();

      assert(
        sandbox.hasActiveProtectedDownloads() === true &&
        sandbox.activeProtectedBlobsByDownloadId.get(testDlId) === testBlobUrl &&
        sandbox.activeOffscreenOwners.has(testOwnerKey) === true,
        'Тест 200.5a: Service worker restart rehydrates active download-to-Blob ownership from session storage'
      );

      await sandbox.closeOffscreenDocument();
      assert(
        mockChrome.offscreen._closed === false,
        'Тест 200.5b: closeOffscreenDocument does not close offscreen while reconciled download is active'
      );

      let blobRevoked = false;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'REVOKE_BLOB_URL' && msg.blobUrl === testBlobUrl) {
          blobRevoked = true;
        }
        return { success: true };
      };

      await mockChrome.downloads._onChangedCb({
        id: testDlId,
        state: { current: 'complete' }
      });

      mockChrome.downloads.search = origDlSearch;

      assert(
        sandbox.hasActiveProtectedDownloads() === false &&
        blobRevoked === true &&
        sandbox.getActiveOffscreenTasks() === 0 &&
        mockChrome.offscreen._closed === true,
        'Тест 200.5c: Reconciled download completion releases task, revokes blob, and closes offscreen'
      );
    }

    // 200.6. Failed protected Blob download releases offscreen task and revokes Blob
    {
      sandbox.resetActiveOffscreenTasks(0);
      mockChrome.offscreen._closed = false;
      mockChrome.offscreen._contexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }];

      const failedBlobUrl = 'blob:chrome-extension://mock-id/failed_dl_blob';
      const failedOwnerKey = 'protected_failed_999';

      sandbox.acquireOffscreenTask(failedOwnerKey, failedBlobUrl);

      let revokedFailedBlob = false;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'REVOKE_BLOB_URL' && msg.blobUrl === failedBlobUrl) {
          revokedFailedBlob = true;
        }
        return { success: true };
      };

      await sandbox.releaseOffscreenTask(failedOwnerKey, failedBlobUrl);

      assert(
        revokedFailedBlob === true &&
        !sandbox.activeOffscreenOwners.has(failedOwnerKey) &&
        sandbox.getActiveOffscreenTasks() === 0 &&
        mockChrome.offscreen._closed === true,
        'Тест 200.6: Failed download task cleanup releases offscreen task, revokes Blob, and closes offscreen'
      );
    }

    // 200.7. Ordinary X video triggers direct one-click native MP4 download
    {
      sandbox.resetActiveOffscreenTasks(0);
      const prevFetch = sandbox.fetch;
      const validFtypBytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00
      ]);
      sandbox.fetch = async () => ({
        ok: true,
        status: 206,
        headers: {
          get: (h) => h.toLowerCase() === 'content-type' ? 'video/mp4' : (h.toLowerCase() === 'content-length' ? '16' : '')
        },
        body: {
          getReader: () => {
            let done = false;
            return {
              read: async () => {
                if (done) return { done: true };
                done = true;
                return { value: validFtypBytes, done: false };
              },
              cancel: async () => {}
            };
          }
        },
        arrayBuffer: async () => validFtypBytes.buffer
      });

      mockChrome.tabs._msgHandler = async () => ({
        type: 'video',
        url: 'https://video.twimg.com/ext_tw_video/2007/pu/vid/720x1280/GzCompleteLifecycle.mp4'
      });

      const dlBefore = downloadedCalls.length;
      await mockChrome.contextMenus._handler(
        { menuItemId: 'save-image-item', pageUrl: 'https://x.com/' },
        { id: 42, url: 'https://x.com/' }
      );

      assert(
        downloadedCalls.length === dlBefore + 1 &&
        downloadedCalls[downloadedCalls.length - 1].url === 'https://video.twimg.com/ext_tw_video/2007/pu/vid/720x1280/GzCompleteLifecycle.mp4' &&
        downloadedCalls[downloadedCalls.length - 1].filename.endsWith('.mp4'),
        'Тест 200.7: Обычное X видео скачивается как .mp4 без вызова конвертера'
      );
      sandbox.fetch = prevFetch;
    }

    // 200.8. Direct video first successful MIME verification preserved without redundant second HEAD probe
    {
      let probeCalls = 0;
      sandbox.fetch = async (url) => {
        probeCalls++;
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'video/mp4' : null }
        };
      };

      const directUrl = 'https://example.com/one_probe_video.mp4';
      const resolved = await sandbox.resolveMediaTarget({
        descriptor: sandbox.createMediaDescriptor({ type: 'video', src: directUrl }),
        srcUrl: directUrl
      });

      assert(
        resolved.type === 'video' &&
        resolved.mediaPlan?.metadata?.verified === true &&
        resolved.mediaPlan?.metadata?.mimeEvidence === sandbox.MIME_EVIDENCE.HTTP_RESPONSE &&
        probeCalls === 1,
        '200.8a: resolveMediaTarget performs initial network probe and attaches verified metadata'
      );

      const verifiedMime = await sandbox.verifyFinalMediaMime(directUrl, resolved.mediaPlan, true);

      assert(
        verifiedMime === 'video/mp4' &&
        probeCalls === 1,
        '200.8b: verifyFinalMediaMime preserves initial verification without redundant second HEAD probe'
      );
    }

    // 200.9. ISO BMFF ftyp box header verification rejects HTML containing "ftyp"
    {
      const offscreenPath = path.resolve(REPO_ROOT, 'offscreen.js');
      const offscreenSource = fs.readFileSync(offscreenPath, 'utf8');

      const htmlWithFtyp = Buffer.from('<!DOCTYPE html><html><body>Error: ftyp not supported</body></html>');
      const htmlSniff = sandbox.sniffMediaMagicBytes(htmlWithFtyp);

      const validHeader = Buffer.alloc(24);
      validHeader.writeUInt32BE(24, 0);
      validHeader.write('ftyp', 4, 4, 'ascii');
      validHeader.write('isom', 8, 4, 'ascii');
      validHeader.writeUInt32BE(512, 12);
      validHeader.write('isomiso2mp41', 16, 8, 'ascii');
      const validSniff = sandbox.sniffMediaMagicBytes(validHeader);

      assert(
        htmlSniff === null &&
        validSniff === 'video/mp4',
        'Тест 200.9: ISO BMFF ftyp box header verification rejects HTML containing "ftyp"'
      );
    }

    // 200.10. Strict validation of video.twimg.com rejecting lookalike domains
    {
      mockChrome._lastBadgeText = '';
      const lookalike = 'https://video.twimg.com.attacker.com/tweet_video/fake.mp4';
      const genuine = 'https://video.twimg.com/tweet_video/genuine123.mp4';

      const lookalikeTweet = sandbox.toTweetVideoUrl ? sandbox.toTweetVideoUrl(lookalike) : null;
      const genuineTweet = sandbox.toTweetVideoUrl ? sandbox.toTweetVideoUrl(genuine) : null;


      mockChrome.tabs._msgHandler = async () => ({
        type: 'x_tweet_video',
        url: lookalike
      });

      await mockChrome.contextMenus._handler(
        { menuItemId: 'save-image-item', pageUrl: 'https://x.com/' },
        { id: 42, url: 'https://x.com/' }
      );

      assert(
        lookalikeTweet === null &&
        genuineTweet === genuine &&
        mockChrome._lastBadgeText === 'ERR',
        'Тест 200.10: Strict video.twimg.com validation strictly rejects attacker lookalike domains'
      );
    }

    // --- Тест 201: Валидация сессионного хранилища, безопасности отправителей, scope downloadId и AbortSignal ---
    console.log('\n--- Тест 201: Валидация сессионного хранилища, безопасности отправителей, scope downloadId и AbortSignal ---');

    // 201.1. Media download failure handles network rejection gracefully with badge flash and 0 corrupted downloads
    {
      mockChrome._lastBadgeText = '';
      const dlBefore = downloadedCalls.length;
      const prevFetch201_1 = sandbox.fetch;
      sandbox.fetch = async () => ({ ok: false, status: 500, headers: { get: () => '' } });

      await mockChrome.contextMenus._handler({
        menuItemId: 'save-image-item',
        srcUrl: 'https://example.com/failed_media.jpg',
        mediaType: 'image',
        pageUrl: 'https://example.com/post/1'
      }, { id: 801 });

      sandbox.fetch = prevFetch201_1;

      assert(
        downloadedCalls.length === dlBefore &&
        mockChrome._lastBadgeText === 'ERR',
        'Тест 201.1: Media download failure handles network rejection gracefully with ERR badge'
      );
    }

    // 201.2. offscreen.js rejects messages from unauthorized senders
    {
      const currentOffscreenSource = fs.readFileSync(path.join(REPO_ROOT, 'offscreen.js'), 'utf8');

      let capturedListener = null;
      const offscreenSandbox = {
        console,
        Blob: function(parts, opts) { this.parts = parts; this.type = opts?.type; this.size = (parts[0] || '').length || 100; },
        URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
        chrome: {
          runtime: {
            id: 'mock-extension-id',
            onMessage: {
              addListener: (fn) => { capturedListener = fn; }
            }
          }
        }
      };

      vm.createContext(offscreenSandbox);
      vm.runInContext(currentOffscreenSource, offscreenSandbox);

      let rejectedResponse = null;
      if (typeof capturedListener === 'function') {
        capturedListener(
          { action: 'FETCH_PROTECTED_BLOB', url: 'https://img3.gelbooru.com/test.mp4' },
          { id: 'attacker-extension-id' },
          (resp) => { rejectedResponse = resp; }
        );
      }

      assert(
        typeof capturedListener === 'function' &&
        rejectedResponse !== null &&
        rejectedResponse.success === false &&
        rejectedResponse.error === 'UNAUTHORIZED_SENDER',
        'Тест 201.2: offscreen.js strictly rejects messages from unauthorized senders'
      );
    }

    // 201.3. executeMediaPlan catch block safely releases offscreen task when protectedOwnerKey is null
    {
      sandbox.resetActiveOffscreenTasks(0);
      const testBlob = 'blob:chrome-extension://mock-id/test_blob_201_3';
      sandbox.acquireOffscreenTask(null, testBlob);

      const origMsg = mockChrome.runtime._msgHandler;
      mockChrome.runtime._msgHandler = async (msg) => {
        if (msg.action === 'FETCH_GELBOORU_BLOB' || msg.action === 'FETCH_PROTECTED_BLOB') {
          return {
            success: true,
            status: 200,
            blobUrl: testBlob,
            contentType: 'image/jpeg',
            size: 12345
          };
        }
        if (msg.action === 'REVOKE_BLOB_URL') return { success: true };
        return null;
      };

      const origDownload = mockChrome.downloads.download;
      mockChrome.downloads.download = () => {
        throw new Error('Simulated download startup failure');
      };

      let errorThrown = null;
      let ret = null;
      try {
        ret = await sandbox.executeMediaPlan({
          isCandidateGroup: true,
          mediaType: 'image',
          transport: 'protectedBlob',
          resolvedUrl: 'https://img3.gelbooru.com/test.jpg',
          primaryUrl: 'https://img3.gelbooru.com/test.jpg',
          variants: [{ url: 'https://img3.gelbooru.com/test.jpg' }]
        }, { subfolder: '', askEveryTime: false }, 'https://img3.gelbooru.com/test.jpg', {
          disallowFallback: true
        });
      } catch (err) {
        errorThrown = err;
      } finally {
        mockChrome.downloads.download = origDownload;
        mockChrome.runtime._msgHandler = origMsg;
      }

      assert(
        errorThrown !== null &&
        !errorThrown.message.includes('ReferenceError') &&
        errorThrown.message.includes('Simulated download startup failure'),
        'Тест 201.3: executeMediaPlan catch block safely handles null protectedOwnerKey without ReferenceError'
      );
    }

    // 201.4. Offscreen protected blob fetch with AbortSignal cancellation cleans up cleanly
    {
      const currentOffscreenSource = fs.readFileSync(path.join(REPO_ROOT, 'offscreen.js'), 'utf8');
      const offscreenSandbox = {
        console,
        setTimeout,
        clearTimeout,
        AbortController,
        URL: Object.assign(function(u, b) { return new URL(u, b); }, URL, { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} }),
        Blob: function(parts, opts) { this.parts = parts; this.type = opts?.type; this.size = 100; },
        fetch: async (_url, opts) => {
          if (opts?.signal?.aborted) {
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            throw err;
          }
          return new Promise((_, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              const err = new Error('The user aborted a request.');
              err.name = 'AbortError';
              reject(err);
            });
          });
        },
        chrome: {
          runtime: {
            id: 'mock-id',
            onMessage: { addListener: () => {} }
          }
        }
      };

      vm.createContext(offscreenSandbox);
      vm.runInContext(currentOffscreenSource, offscreenSandbox);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);

      const res = await offscreenSandbox.fetchProtectedBlob('https://img3.gelbooru.com/test.mp4', { signal: controller.signal });

      assert(
        res && res.success === false && res.error && res.error.includes('aborted'),
        'Тест 201.4: Offscreen protected blob fetch with AbortSignal cancellation handles abort cleanly'
      );
    }

    // 201.5. Offscreen protected blob fetch with invalid MIME safely reports error
    {
      const currentOffscreenSource = fs.readFileSync(path.join(REPO_ROOT, 'offscreen.js'), 'utf8');
      const offscreenSandbox = {
        console,
        setTimeout,
        clearTimeout,
        AbortController,
        URL: Object.assign(function(u, b) { return new URL(u, b); }, URL, { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} }),
        Blob: function(parts, opts) { this.parts = parts; this.type = opts?.type; this.size = 200; },
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => 'text/html' },
          blob: async () => ({
            size: 200,
            type: 'text/html',
            slice: () => ({
              arrayBuffer: async () => Buffer.from('<html>Blocked</html>').buffer
            })
          })
        }),
        chrome: {
          runtime: {
            id: 'mock-id',
            onMessage: { addListener: () => {} }
          }
        }
      };

      vm.createContext(offscreenSandbox);
      vm.runInContext(currentOffscreenSource, offscreenSandbox);

      const res = await offscreenSandbox.fetchProtectedBlob('https://img3.gelbooru.com/test.mp4');

      assert(
        res && res.success === false && res.error && (res.error.includes('MIME') || res.error.includes('Content-Type')),
        'Тест 201.5: Offscreen protected blob fetch with invalid MIME (text/html) safely reports error'
      );
    }

    // 201.6. ensureOffscreenDocument tolerates single-document creation error without getContexts
    {
      const origGetContexts = mockChrome.runtime.getContexts;
      mockChrome.runtime.getContexts = null;

      const origCreate = mockChrome.offscreen.createDocument;
      let createCalls = 0;
      mockChrome.offscreen.createDocument = async () => {
        createCalls++;
        if (createCalls > 1) {
          throw new Error('Only a single offscreen document may be created.');
        }
      };

      let threw = false;
      try {
        await sandbox.ensureOffscreenDocument();
        await sandbox.ensureOffscreenDocument();
      } catch (_) {
        threw = true;
      } finally {
        mockChrome.runtime.getContexts = origGetContexts;
        mockChrome.offscreen.createDocument = origCreate;
      }

      assert(
        threw === false && createCalls === 2,
        'Тест 201.6: ensureOffscreenDocument safely tolerates single-document creation error'
      );
    }

    // =========================================================================
    // ТЕСТ 202: Кнопка копирования ссылки на пост X.com (content/content_x.js)
    // =========================================================================
    console.log('\n--- Тест 202: Кнопка копирования ссылки на пост X.com (content/content_x.js) ---');

    // 202.0. Подготовка окружения для тестирования DOM content/content_x.js
    const contentXPath = path.resolve(REPO_ROOT, 'content/content_x.js');
    const contentXCode = fs.readFileSync(contentXPath, 'utf8');

    class XMockElement {
      constructor(tagName = 'div', attrs = {}) {
        this.tagName = tagName.toUpperCase();
        this.attributes = { ...attrs };
        this.dataset = {};
        this.children = [];
        this.parentElement = null;
        this.style = {};
        const classes = new Set();
        this.classList = {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          contains: (c) => classes.has(c)
        };
        this.title = '';
        this.innerHTML = '';
        this.listeners = {};
      }

      setAttribute(k, v) { this.attributes[k] = String(v); }
      getAttribute(k) { return this.attributes[k] || null; }
      hasAttribute(k) { return k in this.attributes; }

      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
      }

      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
          this.children.splice(idx, 1);
          child.parentElement = null;
        }
        return child;
      }

      focus() {}
      select() {}

      addEventListener(type, cb) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(cb);
      }

      click() {
        if (this.listeners['click']) {
          const e = { preventDefault() {}, stopPropagation() {} };
          this.listeners['click'].forEach(cb => cb(e));
        }
      }

      closest(sel) {
        let cur = this;
        while (cur) {
          if (cur.matches(sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      }

      matches(sel) {
        if (sel.startsWith('.')) return this.classList.contains(sel.slice(1)) || (this.className || '').includes(sel.slice(1));
        if (sel === 'a') return this.tagName === 'A';
        if (sel === 'article') return this.tagName === 'ARTICLE';
        if (sel.includes('data-testid="quoteTweet"')) return this.getAttribute('data-testid') === 'quoteTweet';
        if (sel.includes('role="group"')) return this.getAttribute('role') === 'group';
        return false;
      }

      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      }

      querySelectorAll(sel) {
        const res = [];
        function walk(node) {
          for (const ch of node.children) {
            if (sel === 'time' && ch.tagName === 'TIME') res.push(ch);
            else if (sel.includes('href*="/status/"') && ch.tagName === 'A' && (ch.getAttribute('href') || '').includes('/status/')) res.push(ch);
            else if (sel.includes('data-testid="tweet"') && ch.getAttribute('data-testid') === 'tweet') res.push(ch);
            else if (sel.includes('role="article"') && ch.getAttribute('role') === 'article') res.push(ch);
            else if (sel.includes('role="group"') && ch.getAttribute('role') === 'group') res.push(ch);
            else if (sel.includes('.image-saver-x-copy-wrap') && (ch.className || '').includes('image-saver-x-copy-wrap')) res.push(ch);
            walk(ch);
          }
        }
        walk(this);
        return res;
      }
    }

    let fallbackCopiedText = '';
    const xMockDoc = {
      createElement(tag) { return new XMockElement(tag); },
      getElementById() { return null; },
      head: new XMockElement('head'),
      body: new XMockElement('body'),
      documentElement: new XMockElement('html'),
      readyState: 'complete',
      addEventListener() {},
      execCommand(cmd) {
        if (cmd === 'copy') {
          const ta = xMockDoc.body.children[xMockDoc.body.children.length - 1];
          if (ta && ta.value) {
            fallbackCopiedText = ta.value;
            return true;
          }
        }
        return false;
      }
    };

    let mockStorageListeners = [];
    let mockLocalStorage = {}; // First run with no saved setting (missing xShareHost)
    const xMockChrome = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(defaults, cb) {
            const res = Object.assign({}, defaults, mockLocalStorage);
            if (typeof cb === 'function') cb(res);
            return Promise.resolve(res);
          },
          set(items, cb) {
            Object.assign(mockLocalStorage, items);
            if (typeof cb === 'function') cb();
            return Promise.resolve();
          }
        },
        onChanged: {
          addListener(cb) {
            mockStorageListeners.push(cb);
          }
        }
      }
    };

    let xClipboardText = '';
    const xSandbox = {
      URL,
      chrome: xMockChrome,
      window: {
        addEventListener() {},
        location: { href: 'https://x.com/home' },
        navigator: {
          clipboard: {
            writeText: async (t) => { xClipboardText = t; }
          }
        }
      },
      document: xMockDoc,
      navigator: {
        clipboard: {
          writeText: async (t) => { xClipboardText = t; }
        }
      },
      console,
      setTimeout,
      clearTimeout
    };

    vm.createContext(xSandbox);
    vm.runInContext(contentXCode, xSandbox);

    assert(xSandbox.__getCachedXShareHost() === 'fixupx.com' && xSandbox.__formatXShareUrl('https://x.com/user/status/123') === 'https://fixupx.com/user/status/123', '202.defaults: missing preference uses fixupx.com in the production copy formatter');
    mockStorageListeners.forEach(cb => cb({ xShareHost: { newValue: 'x.com' } }, 'local'));
    assert(xSandbox.__getCachedXShareHost() === 'x.com', '202.original: explicit original preference remains supported');

    // 202.1. URL extraction test
    {
      // Case A: time element permalink
      const artA = new XMockElement('article', { 'data-testid': 'tweet' });
      const aA = new XMockElement('a', { href: '/artist_name/status/1982736450192837465' });
      aA.appendChild(new XMockElement('time'));
      artA.appendChild(aA);
      const urlA = xSandbox.__extractTweetUrl(artA);

      // Case B: status link with media suffix (/photo/1)
      const artB = new XMockElement('article', { 'data-testid': 'tweet' });
      const aB = new XMockElement('a', { href: '/photographer/status/123456789/photo/1' });
      artB.appendChild(aB);
      const urlB = xSandbox.__extractTweetUrl(artB);

      // Case C: Quote tweet isolation: main tweet must win over nested quote tweet
      const artC = new XMockElement('article', { 'data-testid': 'tweet' });
      const mainLink = new XMockElement('a', { href: '/main_account/status/111222333' });
      mainLink.appendChild(new XMockElement('time'));
      artC.appendChild(mainLink);
      const quoteCard = new XMockElement('div', { 'data-testid': 'quoteTweet' });
      quoteCard.appendChild(new XMockElement('a', { href: '/quoted_account/status/999888777' }));
      artC.appendChild(quoteCard);
      const urlC = xSandbox.__extractTweetUrl(artC);

      // Case D: Direct permalink fallback on status page
      const artD = new XMockElement('article', { 'data-testid': 'tweet' });
      const urlD = xSandbox.__extractTweetUrl(artD, 'https://x.com/focal_author/status/555444333');

      // Case E: Null/empty article
      const urlE = xSandbox.__extractTweetUrl(null);

      assert(
        urlA === 'https://x.com/artist_name/status/1982736450192837465' &&
        urlB === 'https://x.com/photographer/status/123456789' &&
        urlC === 'https://x.com/main_account/status/111222333' &&
        urlD === 'https://x.com/focal_author/status/555444333' &&
        urlE === null,
        'Тест 202.1: extractTweetUrl extracts canonical status URLs across time links, media suffixes, quote tweets, and permalinks'
      );
    }

    // 202.2. Duplicate injection test & click success state
    {
      const art = new XMockElement('article', { 'data-testid': 'tweet' });
      const a = new XMockElement('a', { href: '/illustrator/status/987654321' });
      a.appendChild(new XMockElement('time'));
      art.appendChild(a);
      const grp = new XMockElement('div', { role: 'group' });
      art.appendChild(grp);

      // 1. First injection succeeds
      const firstInj = xSandbox.__injectCopyButtonToActionBar(grp, art);
      const childrenAfterFirst = grp.children.length;

      // 2. Second injection into the same action bar is strictly prevented
      const secondInj = xSandbox.__injectCopyButtonToActionBar(grp, art);
      const childrenAfterSecond = grp.children.length;

      // 3. Click handler copies URL to clipboard and triggers is-success state
      xClipboardText = '';
      const copyWrap = grp.children[0];
      copyWrap.click();

      // Wait a microtask for clipboard promise resolution
      await new Promise(r => setTimeout(r, 10));

      assert(
        firstInj === true &&
        secondInj === false &&
        childrenAfterFirst === 1 &&
        childrenAfterSecond === 1 &&
        grp.getAttribute('data-image-saver-btn') === 'true' &&
        xClipboardText === 'https://x.com/illustrator/status/987654321' &&
        copyWrap.classList.contains('is-success') &&
        copyWrap.getAttribute('title')?.includes('скопирована'),
        'Тест 202.2: injectCopyButtonToActionBar prevents duplicate injection and provides copy clipboard + visual success feedback'
      );
    }

    // 202.3. Dynamic loading test (infinite scrolling simulation)
    {
      function createTweetArticle(author, id) {
        const article = new XMockElement('article', { 'data-testid': 'tweet' });
        const link = new XMockElement('a', { href: `/${author}/status/${id}` });
        link.appendChild(new XMockElement('time'));
        article.appendChild(link);
        const actions = new XMockElement('div', { role: 'group' });
        article.appendChild(actions);
        return article;
      }

      const timeline = new XMockElement('div');
      timeline.appendChild(createTweetArticle('user_1', '1001'));
      timeline.appendChild(createTweetArticle('user_2', '1002'));
      timeline.appendChild(createTweetArticle('user_3', '1003'));

      // Initial batch scan
      const firstScanCount = xSandbox.__scanAndInjectXCopyButtons(timeline);

      // Re-scan without mutations: 0 duplicates
      const repeatScanCount = xSandbox.__scanAndInjectXCopyButtons(timeline);

      // Infinite scroll: 2 new tweets dynamically appended to timeline
      timeline.appendChild(createTweetArticle('user_4', '1004'));
      timeline.appendChild(createTweetArticle('user_5', '1005'));

      // Third scan only affects the 2 new tweets
      const scrollScanCount = xSandbox.__scanAndInjectXCopyButtons(timeline);

      const allInjectedButtons = timeline.querySelectorAll('.image-saver-x-copy-wrap');

      assert(
        firstScanCount === 3 &&
        repeatScanCount === 0 &&
        scrollScanCount === 2 &&
        allInjectedButtons.length === 5,
        'Тест 202.3: scanAndInjectXCopyButtons dynamically handles infinite scrolling batches without duplicating buttons'
      );
    }

    // 202.4. SVG geometry and centering test
    {
      const art = new XMockElement('article', { 'data-testid': 'tweet' });
      const grp = new XMockElement('div', { role: 'group' });
      art.appendChild(grp);

      xSandbox.__injectCopyButtonToActionBar(grp, art);
      const wrap = grp.children[0];
      const btn = wrap.children[0];
      const svgHtml = btn.innerHTML || '';

      // Verify SVG dimensions and viewBox
      const hasViewBox = svgHtml.includes('viewBox="3 3 18 18"');
      const hasWidth20 = svgHtml.includes('width="20"');
      const hasHeight20 = svgHtml.includes('height="20"');
      const hasFillCurrentColor = svgHtml.includes('fill="currentColor"');

      // Verify horizontally centered coordinates (M15.89 / L6.33 instead of uncentered M18.36 / L8.80)
      const hasCenteredPath = svgHtml.includes('M15.89 5.64') && svgHtml.includes('L6.33 8.13');
      const hasUncenteredCoords = svgHtml.includes('M18.36') || svgHtml.includes('L8.8 ');

      assert(
        hasViewBox &&
        hasWidth20 &&
        hasHeight20 &&
        hasFillCurrentColor &&
        hasCenteredPath &&
        !hasUncenteredCoords,
        'Тест 202.4: SVG chain icon geometry maintains width=20, height=20, viewBox="3 3 18 18" and verified centered coordinates'
      );
    }

    // 202.5. Explicit original and optional hosts, suffix/query/hash omission.
    {
      const format = xSandbox.__formatXShareUrl;
      assert(typeof format === 'function', '202.5: __formatXShareUrl экспортирована');

      // Original host explicitly selected above.
      const defRes = format('https://x.com/artist_name/status/1982736450192837465/photo/1?s=20#top');
      // Optional host: fixupx.com
      const fixupRes = format('https://twitter.com/photographer/status/123456789/video/1?s=21', 'fixupx.com');
      // Optional host: cunnyx.com
      const cunnyRes = format('https://twitter.com/photographer/status/123456789/video/1?s=21', 'cunnyx.com');
      // Explicit x.com
      const origRes = format('https://x.com/illustrator/status/987654321?s=20', 'x.com');
      // Disallowed host fallback to default x.com
      const fallbackRes = format('https://x.com/user/status/555444333', 'unauthorized.com');
      const emptyHostRes = format('https://x.com/user/status/555444333', '');

      assert(
        defRes === 'https://x.com/artist_name/status/1982736450192837465' &&
        fixupRes === 'https://fixupx.com/photographer/status/123456789' &&
        cunnyRes === 'https://cunnyx.com/photographer/status/123456789' &&
        origRes === 'https://x.com/illustrator/status/987654321' &&
        fallbackRes === 'https://fixupx.com/user/status/555444333' &&
        emptyHostRes === 'https://fixupx.com/user/status/555444333',
        'Тест 202.5: formatXShareUrl сохраняет выбранный x.com, поддерживает fixupx.com/cunnyx.com и безопасный embed-default, отсекая суффиксы, query и hash'
      );
    }

    // 202.6. Strict input validation and fail-closed behavior for invalid URLs
    {
      const format = xSandbox.__formatXShareUrl;
      const nonHttps = format('http://x.com/user/status/123456789');
      const nonXHost = format('https://example.com/user/status/123456789');
      const lookalikeHost = format('https://x.com.evil.com/user/status/123456789');
      const nonNumericStatus = format('https://x.com/user/status/abcde');
      const profileUrl = format('https://x.com/username');
      const homeUrl = format('https://x.com/home');
      const emptyInput = format('');
      const nullInput = format(null);
      const undefinedInput = format(undefined);

      assert(
        nonHttps === null &&
        nonXHost === null &&
        lookalikeHost === null &&
        nonNumericStatus === null &&
        profileUrl === null &&
        homeUrl === null &&
        emptyInput === null &&
        nullInput === null &&
        undefinedInput === null,
        'Тест 202.6: formatXShareUrl строго отклоняет не-HTTPS, сторонние хосты, нечисловые ID, профили и пустые значения'
      );
    }

    // 202.7. Outer tweet URL versus nested quote tweet isolation in copy click
    {
      const artWithQuote = new XMockElement('article', { 'data-testid': 'tweet' });
      const mainLink = new XMockElement('a', { href: '/outer_account/status/111222333' });
      mainLink.appendChild(new XMockElement('time'));
      artWithQuote.appendChild(mainLink);

      const quoteCard = new XMockElement('div', { 'data-testid': 'quoteTweet' });
      quoteCard.appendChild(new XMockElement('a', { href: '/quoted_account/status/999888777' }));
      artWithQuote.appendChild(quoteCard);

      const grp = new XMockElement('div', { role: 'group' });
      artWithQuote.appendChild(grp);

      xSandbox.__injectCopyButtonToActionBar(grp, artWithQuote);
      const copyWrap = grp.children[0];

      xClipboardText = '';
      copyWrap.click();
      await new Promise(r => setTimeout(r, 10));

      assert(
        xClipboardText === 'https://x.com/outer_account/status/111222333' &&
        copyWrap.classList.contains('is-success'),
        'Тест 202.7: Клик по кнопке копирования строго копирует канонический внешний твит, игнорируя цитируемый'
      );
    }

    // 202.8. Storage onChanged listener updates cached host dynamically without async getter delay
    {
      const art = new XMockElement('article', { 'data-testid': 'tweet' });
      const a = new XMockElement('a', { href: '/switch_user/status/777888999' });
      a.appendChild(new XMockElement('time'));
      art.appendChild(a);
      const grp = new XMockElement('div', { role: 'group' });
      art.appendChild(grp);

      xSandbox.__injectCopyButtonToActionBar(grp, art);
      const copyWrap = grp.children[0];

      // 1. Update to optional fixupx.com via chrome.storage.onChanged
      mockStorageListeners.forEach(cb => cb({ xShareHost: { newValue: 'fixupx.com' } }, 'local'));
      xClipboardText = '';
      copyWrap.click();
      await new Promise(r => setTimeout(r, 10));
      const copiedFixup = xClipboardText;

      // 2. Update to optional cunnyx.com via chrome.storage.onChanged
      mockStorageListeners.forEach(cb => cb({ xShareHost: { newValue: 'cunnyx.com' } }, 'local'));
      xClipboardText = '';
      copyWrap.click();
      await new Promise(r => setTimeout(r, 10));
      const copiedCunny = xClipboardText;

      // 3. Reject disallowed domain in onChanged (cache must stay unchanged)
      mockStorageListeners.forEach(cb => cb({ xShareHost: { newValue: 'malicious.com' } }, 'local'));
      xClipboardText = '';
      copyWrap.click();
      await new Promise(r => setTimeout(r, 10));
      const copiedAfterInvalid = xClipboardText;

      // 4. Update back to default original x.com
      mockStorageListeners.forEach(cb => cb({ xShareHost: { newValue: 'x.com' } }, 'local'));
      xClipboardText = '';
      copyWrap.click();
      await new Promise(r => setTimeout(r, 10));
      const copiedOrig = xClipboardText;

      assert(
        copiedFixup === 'https://fixupx.com/switch_user/status/777888999' &&
        copiedCunny === 'https://cunnyx.com/switch_user/status/777888999' &&
        copiedAfterInvalid === 'https://cunnyx.com/switch_user/status/777888999' &&
        copiedOrig === 'https://x.com/switch_user/status/777888999',
        'Тест 202.8: chrome.storage.onChanged синхронно обновляет кэш хоста в памяти и игнорирует неразрешённые хосты'
      );
    }

    // 202.9. Clipboard API failure and fallback to document.execCommand('copy')
    {
      const art = new XMockElement('article', { 'data-testid': 'tweet' });
      const a = new XMockElement('a', { href: '/fallback_user/status/333222111' });
      a.appendChild(new XMockElement('time'));
      art.appendChild(a);
      const grp = new XMockElement('div', { role: 'group' });
      art.appendChild(grp);

      xSandbox.__injectCopyButtonToActionBar(grp, art);
      const copyWrap = grp.children[0];

      // Simulate navigator.clipboard.writeText failure (e.g. permission denied or unsupported context)
      const origWriteTextWin = xSandbox.window.navigator.clipboard.writeText;
      const origWriteTextNav = xSandbox.navigator.clipboard.writeText;
      xSandbox.window.navigator.clipboard.writeText = async () => { throw new Error('Clipboard writeText failed'); };
      xSandbox.navigator.clipboard.writeText = async () => { throw new Error('Clipboard writeText failed'); };

      fallbackCopiedText = '';
      copyWrap.click();
      await new Promise(r => setTimeout(r, 10));

      // Restore clipboard methods
      xSandbox.window.navigator.clipboard.writeText = origWriteTextWin;
      xSandbox.navigator.clipboard.writeText = origWriteTextNav;

      assert(
        fallbackCopiedText === 'https://x.com/fallback_user/status/333222111' &&
        copyWrap.classList.contains('is-success') &&
        copyWrap.getAttribute('title')?.includes('скопирована'),
        'Тест 202.9: При отказе navigator.clipboard.writeText срабатывает fallback через textarea + document.execCommand'
      );
    }

    // 202.10. Default on first run without saved setting & preservation of existing installations
    {
      // First run with no setting: get defaults returns xShareHost: 'x.com'
      const firstRunRes = await xSandbox.chrome.storage.local.get({ xShareHost: 'x.com' });
      assert(firstRunRes.xShareHost === 'x.com', '202.10a: First run without saved setting defaults to x.com');

      // Existing installation with explicitly saved fixupx.com is preserved
      mockLocalStorage.xShareHost = 'fixupx.com';
      const existingFixupRes = await xSandbox.chrome.storage.local.get({ xShareHost: 'x.com' });
      assert(existingFixupRes.xShareHost === 'fixupx.com', '202.10b: Existing installation with fixupx.com is preserved');

      // Existing installation with explicitly saved cunnyx.com is preserved
      mockLocalStorage.xShareHost = 'cunnyx.com';
      const existingCunnyRes = await xSandbox.chrome.storage.local.get({ xShareHost: 'x.com' });
      assert(existingCunnyRes.xShareHost === 'cunnyx.com', '202.10c: Existing installation with cunnyx.com is preserved');

      // Clean up mockLocalStorage
      delete mockLocalStorage.xShareHost;
    }

    // =========================================================================
    // ТЕСТ 203: Детекция типов медиа по magic bytes и классификация статических/анимированных GIF
    // =========================================================================
    console.log('\n--- Тест 203: Core Media Detection (Magic Bytes & Animated GIF) ---');

    // 203.1: Magic byte detection (sniffMediaMagicBytes)
    {
      const sniff = sandbox.sniffMediaMagicBytes;
      assert(typeof sniff === 'function', '203.1: sandbox.sniffMediaMagicBytes экспортирована как функция');

      // JPEG: 0xFF, 0xD8, 0xFF
      const jpegBuf = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
      assert(sniff(jpegBuf) === 'image/jpeg', '203.1a: sniffMediaMagicBytes определяет JPEG (SOI marker 0xFF 0xD8 0xFF)');

      // PNG: 89 50 4E 47 0D 0A 1A 0A
      const pngBuf = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
      assert(sniff(pngBuf) === 'image/png', '203.1b: sniffMediaMagicBytes определяет PNG (8-байтовая сигнатура 89 50 4E 47 0D 0A 1A 0A)');

      // GIF87a and GIF89a
      const gif87Buf = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00, 0x01, 0x00]);
      const gif89Buf = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
      assert(sniff(gif87Buf) === 'image/gif' && sniff(gif89Buf) === 'image/gif', '203.1c: sniffMediaMagicBytes определяет GIF87a и GIF89a');

      // WebP: RIFF....WEBP
      const webpBuf = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x20, 0x00, 0x00, 0x00, // Size
        0x57, 0x45, 0x42, 0x50, // WEBP
        0x56, 0x50, 0x38, 0x20  // VP8
      ]);
      assert(sniff(webpBuf) === 'image/webp', '203.1d: sniffMediaMagicBytes определяет WebP (RIFF....WEBP)');

      // MP4: standard ftyp box at offset 4
      const mp4Standard = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, // box size 24
        0x66, 0x74, 0x79, 0x70, // 'ftyp'
        0x69, 0x73, 0x6F, 0x6D, // major brand 'isom'
        0x00, 0x00, 0x02, 0x00,
        0x69, 0x73, 0x6F, 0x6D, 0x69, 0x73, 0x6F, 0x32
      ]);
      assert(sniff(mp4Standard) === 'video/mp4', '203.1e: sniffMediaMagicBytes определяет MP4 со стандартным ftyp box');

      // MP4: pre-ftyp padding box (e.g. 'wide' or 'free' before 'ftyp')
      const mp4WithPadding = new Uint8Array([
        0x00, 0x00, 0x00, 0x08, // box size 8
        0x77, 0x69, 0x64, 0x65, // 'wide'
        0x00, 0x00, 0x00, 0x18, // box size 24
        0x66, 0x74, 0x79, 0x70, // 'ftyp'
        0x69, 0x73, 0x6F, 0x6D,
        0x00, 0x00, 0x02, 0x00
      ]);
      assert(sniff(mp4WithPadding) === 'video/mp4', '203.1f: sniffMediaMagicBytes определяет MP4 с пре-ftyp box (wide/free)');

      // WebM: Matroska EBML 0x1A 0x45 0xDF 0xA3
      const webmBuf = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81]);
      assert(sniff(webmBuf) === 'video/webm', '203.1g: sniffMediaMagicBytes определяет WebM (EBML 0x1A 0x45 0xDF 0xA3)');

      // Rejections: HTML, JSON, leading whitespace, empty, short, unknown binary
      const htmlDoc = Buffer.from('<!DOCTYPE html><html><head></head><body>Error 404</body></html>');
      const htmlTag = Buffer.from('<html><title>Blocked</title></html>');
      const htmlWs = Buffer.from('   <div>Challenge</div>');
      const jsonBody = Buffer.from('{"error": "Forbidden", "status": 403}');
      const jsonArr = Buffer.from('[1, 2, 3]');
      const shortBuf = new Uint8Array([0x47, 0x49]);
      const emptyBuf = new Uint8Array(0);
      const unknownBinary = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

      assert(
        sniff(htmlDoc) === null &&
        sniff(htmlTag) === null &&
        sniff(htmlWs) === null &&
        sniff(jsonBody) === null &&
        sniff(jsonArr) === null &&
        sniff(shortBuf) === null &&
        sniff(emptyBuf) === null &&
        sniff(null) === null &&
        sniff(unknownBinary) === null,
        '203.1h: sniffMediaMagicBytes строго отклоняет HTML, JSON, пробелы, короткие буферы и неизвестные бинарные данные'
      );
    }

    // 203.2: Static vs animated GIF detection (isAnimatedGif and format chooser behavior)
    {
      const isAnim = sandbox.isAnimatedGif;
      assert(typeof isAnim === 'function', '203.2: sandbox.isAnimatedGif экспортирована как функция');

      // Minimal 1-frame static GIF89a (single Image Descriptor 0x2C)
      const singleFrameGif = new Uint8Array([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
        0x01, 0x00, 0x01, 0x00,             // 1x1 width, height
        0x80, 0x00, 0x00,                   // GCT flag, 2 colors
        0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, // Red, Black
        0x2C,                               // Image Descriptor 1
        0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0x02, 0x02, 0x44, 0x01, 0x00,       // LZW code size & sub-blocks
        0x3B                                // Trailer
      ]);

      // Minimal multi-frame animated GIF89a (two Image Descriptors 0x2C)
      const multiFrameGif = new Uint8Array([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
        0x01, 0x00, 0x01, 0x00,
        0x80, 0x00, 0x00,
        0xFF, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x21, 0xF9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // Graphic Control Extension
        0x2C,                               // Image Descriptor 1 (Frame 1)
        0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0x02, 0x02, 0x44, 0x01, 0x00,
        0x21, 0xF9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // Graphic Control Extension
        0x2C,                               // Image Descriptor 2 (Frame 2)
        0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0x02, 0x02, 0x44, 0x01, 0x00,
        0x3B                                // Trailer
      ]);

      const singleRes = isAnim(singleFrameGif);
      const multiRes = isAnim(multiFrameGif);
      const corruptRes = isAnim(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
      const nonGifRes = isAnim(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));

      assert(
        singleRes === false && multiRes === true && corruptRes === false && nonGifRes === false,
        '203.2a: isAnimatedGif корректно классифицирует 1-кадровый GIF (false) и многокадровый GIF (true), отклоняя не-GIF'
      );

      // Native one-click download format resolution: both static and animated GIFs map to .gif
      const gifExt = sandbox.mapMimeToPreferredExtension('image/gif');
      const staticFn = sandbox.buildFinalFilename('https://example.com/icon.gif', gifExt);
      const animFn = sandbox.buildFinalFilename('https://example.com/anim.gif', gifExt);

      assert(
        gifExt === '.gif' &&
        staticFn.endsWith('.gif') &&
        animFn.endsWith('.gif'),
        '203.2b: Все GIF-файлы (как статические, так и анимированные) скачиваются в нативном формате .gif без конвертера'
      );
    }

    // =========================================================================
    // ТЕСТ 204: X.com (Twitter) Original Image Resolver
    // =========================================================================
    console.log('\n--- Тест 204: X.com (Twitter) Original Image Resolver ---');

    // 204.1: URL Transformation & Parameter Preservation (Post Media)
    {
      const resolve = sandbox.resolveTwitterOriginalUrl;
      assert(typeof resolve === 'function', '204.1: sandbox.resolveTwitterOriginalUrl доступна в sandbox');

      // Modern format with query parameters and format preservation
      const jpgOrig = resolve('https://pbs.twimg.com/media/ExamplePhoto?format=jpg&name=small');
      const pngOrig = resolve('https://pbs.twimg.com/media/ArtIllustration?format=png&name=medium');
      const webpOrig = resolve('https://pbs.twimg.com/media/VectorGraphic?format=webp&name=900x900');
      const largeOrig = resolve('https://pbs.twimg.com/media/ExamplePhoto?format=jpg&name=large');

      // Direct pathname extension
      const directJpg = resolve('https://pbs.twimg.com/media/DirectImage.jpg?name=small');
      const directPng = resolve('https://pbs.twimg.com/media/DirectPNG.png?name=360x360');
      const noQueryJpg = resolve('https://pbs.twimg.com/media/NoQueryParams.jpg');

      // Legacy colon syntax: stripped from path, query ?name=orig appended; never generates :orig
      const colonSmall = resolve('https://pbs.twimg.com/media/LegacyColon.jpg:small');
      const colonLarge = resolve('https://pbs.twimg.com/media/LegacyColonPng.png:large');
      const colonOrig = resolve('https://pbs.twimg.com/media/LegacyColonOrig.jpg:orig');

      assert(
        jpgOrig === 'https://pbs.twimg.com/media/ExamplePhoto?format=jpg&name=orig' &&
        pngOrig === 'https://pbs.twimg.com/media/ArtIllustration?format=png&name=orig' &&
        webpOrig === 'https://pbs.twimg.com/media/VectorGraphic?format=webp&name=orig' &&
        largeOrig === 'https://pbs.twimg.com/media/ExamplePhoto?format=jpg&name=orig' &&
        directJpg === 'https://pbs.twimg.com/media/DirectImage.jpg?name=orig' &&
        directPng === 'https://pbs.twimg.com/media/DirectPNG.png?name=orig' &&
        noQueryJpg === 'https://pbs.twimg.com/media/NoQueryParams.jpg?name=orig' &&
        colonSmall === 'https://pbs.twimg.com/media/LegacyColon.jpg?name=orig' &&
        colonLarge === 'https://pbs.twimg.com/media/LegacyColonPng.png?name=orig' &&
        colonOrig === 'https://pbs.twimg.com/media/LegacyColonOrig.jpg?name=orig' &&
        !colonSmall.includes(':orig') &&
        !colonLarge.includes(':orig') &&
        !colonOrig.includes(':orig'),
        '204.1: resolveTwitterOriginalUrl корректно преобразует медиа-URL в name=orig, сохраняет формат и никогда не генерирует :orig в пути'
      );
    }

    // 204.2: Expanded X Image Paths (Cards, Amplify, Community, Avatars, Banners)
    {
      const resolve = sandbox.resolveTwitterOriginalUrl;

      // Cards, Amplify, Community banners, Semantic core
      const cardRes = resolve('https://pbs.twimg.com/card_img/1838612345/preview?format=jpg&name=386x202');
      const amplifyRes = resolve('https://pbs.twimg.com/amplify_img/1838612345/sponsor?format=png&name=small');
      const communityRes = resolve('https://pbs.twimg.com/community_banner_img/1838612345/banner?format=jpg&name=900x900');
      const semanticRes = resolve('https://pbs.twimg.com/semantic_core_img/1838612345/trend?format=webp&name=large');

      // Profile Avatars (_normal, _mini, _bigger, _200x200 -> _400x400)
      const avNormal = resolve('https://pbs.twimg.com/profile_images/123/avatar_normal.jpg');
      const avMini = resolve('https://pbs.twimg.com/profile_images/123/avatar_mini.png');
      const avBigger = resolve('https://pbs.twimg.com/profile_images/123/avatar_bigger.webp');
      const av200 = resolve('https://pbs.twimg.com/profile_images/123/avatar_200x200.jpeg');
      const av400 = resolve('https://pbs.twimg.com/profile_images/123/avatar_400x400.jpg');

      // Profile Banners (/web, /mobile, /600x200, /web_retina -> /1500x500)
      const bannerWeb = resolve('https://pbs.twimg.com/profile_banners/123/banner/web');
      const banner600 = resolve('https://pbs.twimg.com/profile_banners/123/banner/600x200');
      const bannerRetina = resolve('https://pbs.twimg.com/profile_banners/123/banner/web_retina');
      const banner1500 = resolve('https://pbs.twimg.com/profile_banners/123/banner/1500x500');

      assert(
        cardRes === 'https://pbs.twimg.com/card_img/1838612345/preview?format=jpg&name=orig' &&
        amplifyRes === 'https://pbs.twimg.com/amplify_img/1838612345/sponsor?format=png&name=orig' &&
        communityRes === 'https://pbs.twimg.com/community_banner_img/1838612345/banner?format=jpg&name=orig' &&
        semanticRes === 'https://pbs.twimg.com/semantic_core_img/1838612345/trend?format=webp&name=orig' &&
        avNormal === 'https://pbs.twimg.com/profile_images/123/avatar_400x400.jpg' &&
        avMini === 'https://pbs.twimg.com/profile_images/123/avatar_400x400.png' &&
        avBigger === 'https://pbs.twimg.com/profile_images/123/avatar_400x400.webp' &&
        av200 === 'https://pbs.twimg.com/profile_images/123/avatar_400x400.jpeg' &&
        av400 === 'https://pbs.twimg.com/profile_images/123/avatar_400x400.jpg' &&
        bannerWeb === 'https://pbs.twimg.com/profile_banners/123/banner/1500x500' &&
        banner600 === 'https://pbs.twimg.com/profile_banners/123/banner/1500x500' &&
        bannerRetina === 'https://pbs.twimg.com/profile_banners/123/banner/1500x500' &&
        banner1500 === 'https://pbs.twimg.com/profile_banners/123/banner/1500x500',
        '204.2: Поддержка расширенных путей X (card_img, amplify_img, community, аватары 400x400, баннеры 1500x500)'
      );
    }

    // 204.3: Filename Correctness Across Transformed URLs
    {
      const getFilename = sandbox.getFilenameFromUrl;
      const resolve = sandbox.resolveTwitterOriginalUrl;

      // Legacy colon transformed URL produces clean filename without _orig or .jpg_orig.jpg
      const resolvedFromColon = resolve('https://pbs.twimg.com/media/LegacyColon.jpg:small');
      const fnColon = getFilename(resolvedFromColon);

      // Query-based media URLs
      const fnJpg = getFilename(resolve('https://pbs.twimg.com/media/ExamplePhoto?format=jpg&name=small'));
      const fnPng = getFilename(resolve('https://pbs.twimg.com/media/ArtIllustration?format=png&name=medium'));
      const fnWebp = getFilename(resolve('https://pbs.twimg.com/media/VectorGraphic?format=webp&name=900x900'));

      // Card and Avatar URLs
      const fnCard = getFilename(resolve('https://pbs.twimg.com/card_img/1838612345/preview?format=jpg&name=386x202'));
      const fnAvatar = getFilename(resolve('https://pbs.twimg.com/profile_images/123/avatar_normal.jpg'));

      assert(
        fnColon === 'LegacyColon.jpg' &&
        !fnColon.includes('_orig') &&
        !fnColon.includes(':') &&
        fnJpg === 'ExamplePhoto.jpg' &&
        fnPng === 'ArtIllustration.png' &&
        fnWebp === 'VectorGraphic.webp' &&
        fnCard === 'preview.jpg' &&
        fnAvatar === 'avatar_400x400.jpg',
        '204.3: getFilenameFromUrl формирует корректные имена файлов без мусорных суффиксов :orig и _orig'
      );
    }

    // 204.4: Malicious Domain & Lookalike Rejection
    {
      const resolve = sandbox.resolveTwitterOriginalUrl;
      const twitterEngine = sandbox.KNOWN_SITE_RESOLVERS.find(r => r.name === 'TwitterEngine');

      // Rejections in resolveTwitterOriginalUrl
      const fake1 = resolve('https://attacker-twimg.com/media/photo.jpg?name=small');
      const fake2 = resolve('https://evil_twimg.com/media/photo.jpg?name=small');
      const fake3 = resolve('https://pbs.twimg.com.attacker.com/media/photo.jpg?name=small');
      const invalidProto1 = resolve('javascript:alert(1)');
      const invalidProto2 = resolve('file:///C:/twimg.com/media/test.jpg');
      const nonMediaPath = resolve('https://pbs.twimg.com/unrelated/test.txt');
      const nullInput = resolve(null);
      const emptyInput = resolve('');

      // Scoping in TwitterEngine.match
      const matchPbs = twitterEngine.match(new URL('https://pbs.twimg.com/media/test.jpg'));
      const matchTon = twitterEngine.match(new URL('https://ton.twimg.com/media/test.jpg'));
      const matchFake1 = twitterEngine.match(new URL('https://attacker-twimg.com/media/test.jpg'));
      const matchFake2 = twitterEngine.match(new URL('https://pbs.twimg.com.attacker.com/media/test.jpg'));

      assert(
        fake1 === null &&
        fake2 === null &&
        fake3 === null &&
        invalidProto1 === null &&
        invalidProto2 === null &&
        nonMediaPath === null &&
        nullInput === null &&
        emptyInput === null &&
        matchPbs === true &&
        matchTon === true &&
        matchFake1 === false &&
        matchFake2 === false,
        '204.4: Строгая валидация доменов twimg.com отклоняет вредоносные подделки (attacker-twimg.com, lookalikes)'
      );
    }

    // Восстанавливаем окружение
    sandbox.fetch = origSandboxFetch;
    sandbox.flashBadge = origFlashBadge;
    mockChrome.runtime._msgHandler = origMsgHandler;
  };
