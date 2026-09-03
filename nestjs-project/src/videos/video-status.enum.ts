/**
 * The processing state machine. `draft` is written when a tus upload is
 * created, `uploading` on the first chunk, `processing` when the upload
 * finishes, and `ready`/`failed` are terminal and written by the worker (or, for
 * `UPLOAD_ABANDONED`, by the sweep).
 */
export enum VideoStatus {
  DRAFT = 'draft',
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/** States an upload can still be resumed from — used by the one-in-flight rule. */
export const IN_FLIGHT_UPLOAD_STATUSES = [
  VideoStatus.DRAFT,
  VideoStatus.UPLOADING,
] as const;
