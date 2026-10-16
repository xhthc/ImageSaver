import type { DownloadBatch, DownloadRequest, DownloadResponse, DownloadState } from '../lib/download_contracts';
import { createDownloads } from '../ui/src/core/downloads.js';

declare const controller: ReturnType<typeof createDownloads>;
declare const reply: DownloadResponse;
if (reply.success) {
  const state: DownloadState | undefined = reply.jobs[0]?.state;
  void state;
  // @ts-expect-error Failed responses and success snapshots have different fields.
  void reply.error;
}
const pause: DownloadRequest = {action:'DOWNLOADS_COMMAND', command:'pause'};
void pause;
// @ts-expect-error Unknown worker commands must not enter the typed UI controller.
void controller.command('restartEverything');
// @ts-expect-error Job identifiers are strings, not native browser download IDs.
void controller.command('cancel', 42);
// @ts-expect-error Typos in terminal state names must be reported.
const wrongState: DownloadState = 'finished';
void wrongState;
const counts = { count: 2, saved: 1, failed: 0, cancelled: 0, skipped: 0, remaining: 1, createdAt: 1 };
const pixiv: DownloadBatch = { id: 'batch-1', site: 'pixiv', ...counts };
const partial: DownloadBatch = { id: 'batch-2', site: 'pawchive', partial: true, ...counts };
const vk: DownloadBatch = { id: 'batch-8', site: 'vk', ...counts };
void pixiv; void partial; void vk;
void controller.command('cancelBatch', 'batch-1');
const cancelling: DownloadBatch = { id: 'batch-5', site: 'reddit', cancelRequested: true, cancelling: true, ...counts };
void cancelling;
// @ts-expect-error The in-progress flag is a boolean.
const badCancelling: DownloadBatch = { id: 'batch-7', site: 'x', cancelling: 'yes', ...counts };
void badCancelling;
// @ts-expect-error The cancellation flag is a boolean.
const badFlag: DownloadBatch = { id: 'batch-6', site: 'x', cancelRequested: 'yes', ...counts };
void badFlag;
// @ts-expect-error Only X, Reddit, Pixiv, Pawchive and VK groups exist.
const otherSite: DownloadBatch = { id: 'batch-3', site: 'redgifs', ...counts };
void otherSite;
// @ts-expect-error The partial flag is a boolean: a count of missing files is never part of a group.
const missingCount: DownloadBatch = { id: 'batch-4', site: 'pawchive', partial: 2, ...counts };
void missingCount;
