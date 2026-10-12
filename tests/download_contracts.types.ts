import type { DownloadRequest, DownloadResponse, DownloadState } from '../lib/download_contracts';
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
