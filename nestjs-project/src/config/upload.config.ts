import { registerAs } from '@nestjs/config';

const csv = (value: string | undefined, fallback: string): string[] =>
  (value ?? fallback)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

export default registerAs('upload', () => ({
  maxSizeBytes: parseInt(
    process.env.UPLOAD_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  acceptedContainers: csv(
    process.env.UPLOAD_ACCEPTED_CONTAINERS,
    'mp4,mov,webm,mkv',
  ),
  acceptedVideoCodecs: csv(
    process.env.UPLOAD_ACCEPTED_VIDEO_CODECS,
    'h264,vp9,av1',
  ),
  abandonedExpirationHours: parseInt(
    process.env.UPLOAD_ABANDONED_EXPIRATION_HOURS || '24',
    10,
  ),
  ticketExpirationHours: parseInt(
    process.env.UPLOAD_TICKET_EXPIRATION_HOURS || '2',
    10,
  ),
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES || '8388608', 10),
  /** The browser-reachable tus endpoint handed back with every upload ticket. */
  publicUrl: process.env.UPLOAD_PUBLIC_URL || 'http://localhost:3000/uploads',
  /** Wall-clock ceiling for a single ffmpeg/ffprobe invocation. */
  ffmpegTimeoutSeconds: parseInt(
    process.env.FFMPEG_TIMEOUT_SECONDS || '3600',
    10,
  ),
  /** Where in the clip the automatic thumbnail frame is taken from. */
  thumbnailOffsetPercent: parseInt(
    process.env.THUMBNAIL_OFFSET_PERCENT || '10',
    10,
  ),
}));
