/** Existing worker/UI protocol. Types do not replace worker sender or media validation. */
export type DownloadState =
  | 'resolving' | 'converting' | 'queued' | 'receiving' | 'ready' | 'exporting'
  | 'complete' | 'failed' | 'cancelled';

export interface DownloadJob {
  id: string;
  op?: string | null;
  managed?: boolean;
  filename: string;
  state: DownloadState;
  received: number;
  total: number | null;
  speed: number;
  error: string;
  createdAt: number;
  downloadId?: number | null;
  ready?: boolean;
  /** Post batch this job belongs to (a "Save all" list of an X or Reddit post, a multi-file Pixiv artwork or Pawchive post), when it has one. */
  batch?: string;
  /** Original zero-based post position; independent of enqueue/completion time. */
  batchIndex?: number;
  /** Existing service label for independent saves, without a source URL. */
  site?: string;
}

/** Progress of one post batch: every proven item is in exactly one count. Only `saved` is confirmed by the browser or the chosen folder. */
export interface DownloadBatch {
  id: string;
  site: 'x' | 'reddit' | 'pixiv' | 'pawchive';
  count: number;
  saved: number;
  failed: number;
  cancelled: number;
  skipped: number;
  /** Not finished yet: proven but not started, resolving, receiving, checking or exporting. */
  remaining: number;
  /** "Cancel remaining" was accepted for this batch: its unstarted items are cancelled and its running ones stop cooperatively (counts stay the committed outcomes). */
  cancelRequested?: boolean;
  /** Work covered by an accepted cancellation is still unfinished (a file the user retried afterwards is not). Only this says "Cancelling"; the action stays available to repeat it. */
  cancelling?: boolean;
  /** Pawchive only: the post declares originals the site has not imported. `count` is still only the downloadable items; the number missing is not known here. */
  partial?: boolean;
  createdAt: number;
}

export interface DownloadSnapshot { jobs: DownloadJob[]; paused: boolean; batches?: DownloadBatch[] }
export type DownloadCommand = 'pause' | 'cancel' | 'retry' | 'remove' | 'cancelBatch';
export type DownloadRequest =
  | { action: 'DOWNLOADS_LIST' }
  | { action: 'DOWNLOADS_COMMAND'; command: DownloadCommand; id?: string };
export type DownloadResponse =
  | ({ success: true } & DownloadSnapshot)
  | { success: false; error?: string };
export interface DownloadNotice { action?: string }
export interface DownloadsChrome {
  runtime: {
    sendMessage(message: DownloadRequest): Promise<DownloadResponse | undefined>;
    onMessage?: {
      addListener(listener: (message: DownloadNotice) => void): void;
      removeListener(listener: (message: DownloadNotice) => void): void;
    };
  };
}

export interface DownloadsViewState extends DownloadSnapshot {
  batches: DownloadBatch[];
  status: 'loading' | 'ready' | 'error';
  error: '' | 'downloads.unavailable' | 'downloads.commandFailed' | 'downloads.batchCancelFailed';
  busy: boolean;
  /** The batch whose "Cancel remaining" is waiting for the worker. */
  pendingBatch: string;
  removingIds: string[];
  dismissedIds: string[];
}
