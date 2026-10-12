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
}

export interface DownloadSnapshot { jobs: DownloadJob[]; paused: boolean }
export type DownloadCommand = 'pause' | 'cancel' | 'retry' | 'remove';
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
  status: 'loading' | 'ready' | 'error';
  error: '' | 'downloads.unavailable' | 'downloads.commandFailed';
  busy: boolean;
  removingIds: string[];
  dismissedIds: string[];
}
