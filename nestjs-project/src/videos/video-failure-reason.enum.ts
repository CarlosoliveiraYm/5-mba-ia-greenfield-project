/** Machine-readable reason accompanying `VideoStatus.FAILED`. */
export enum VideoFailureReason {
  /** ffprobe found no video stream in the uploaded file. */
  NO_VIDEO_STREAM = 'NO_VIDEO_STREAM',
  /** Real container is outside `UPLOAD_ACCEPTED_CONTAINERS`. */
  UNSUPPORTED_CONTAINER = 'UNSUPPORTED_CONTAINER',
  /** Real video codec is outside `UPLOAD_ACCEPTED_VIDEO_CODECS`. */
  UNSUPPORTED_VIDEO_CODEC = 'UNSUPPORTED_VIDEO_CODEC',
  /** ffprobe exited non-zero or returned unparsable JSON. */
  PROBE_FAILED = 'PROBE_FAILED',
  /** Unexpected failure after pg-boss exhausted `QUEUE_RETRY_LIMIT`. */
  PROCESSING_FAILED = 'PROCESSING_FAILED',
  /** Upload never completed before `upload_expires_at`. */
  UPLOAD_ABANDONED = 'UPLOAD_ABANDONED',
}
