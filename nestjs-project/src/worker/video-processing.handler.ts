import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import uploadConfig from '../config/upload.config';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import type { ProbeResult } from '../ffmpeg/ffmpeg.types';
import { hasFaststartLayout } from '../ffmpeg/moov.util';
import { StorageService } from '../storage/storage.service';
import { videoThumbnailKey } from '../storage/storage.keys';
import { Video } from '../videos/entities/video.entity';
import { VideoFailureReason } from '../videos/video-failure-reason.enum';
import { VideoStatus } from '../videos/video-status.enum';
import type { VideoProcessJobData } from '../queue/queue.types';

/** Containers whose `moov` position matters. WebM/MKV have no such atom. */
const FASTSTART_CONTAINERS = ['mp4', 'mov'];

/**
 * ffprobe's `format_name` is a list of demuxer aliases, and it does not use the
 * names the accepted-container list is written in: an MKV and a WebM both report
 * `matroska,webm`. Mapped explicitly so an MKV is accepted as `mkv` rather than
 * slipping through as `webm`.
 */
const FORMAT_ALIASES: Record<string, string[]> = {
  matroska: ['mkv', 'webm'],
  webm: ['webm'],
  mp4: ['mp4'],
  mov: ['mov'],
};

/** The accepted-container names a probe result could satisfy. */
function candidateContainers(containerFormats: string[]): string[] {
  return containerFormats.flatMap(
    (format) => FORMAT_ALIASES[format] ?? [format],
  );
}

/**
 * How many leading bytes to range-read when deciding whether a file is already
 * faststart. Generous enough that a head `moov` is fully visible, and a trailing
 * one is detected as soon as `mdat` appears — a 10 GB source is never
 * downloaded to answer the question.
 */
const MOOV_PROBE_BYTES = 512 * 1024;

/** Raised to abort processing with a specific, machine-readable reason. */
class VideoRejected extends Error {
  constructor(readonly reason: VideoFailureReason) {
    super(reason);
    this.name = 'VideoRejected';
  }
}

@Injectable()
export class VideoProcessingHandler {
  private readonly logger = new Logger(VideoProcessingHandler.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(uploadConfig.KEY)
    private readonly uploadCfg: ConfigType<typeof uploadConfig>,
    @Inject(queueConfig.KEY)
    private readonly queueCfg: ConfigType<typeof queueConfig>,
  ) {}

  /**
   * `attempt` is pg-boss's `retryCount` and `maxAttempts` its `retryLimit`: an
   * unexpected failure is rethrown so pg-boss retries it, and only the last
   * attempt writes `PROCESSING_FAILED`.
   */
  async process(
    { videoId }: VideoProcessJobData,
    {
      attempt = 0,
      maxAttempts = 0,
    }: { attempt?: number; maxAttempts?: number } = {},
  ): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video?.storage_key) {
      this.logger.warn(
        `Skipping ${videoId}: no video row, or no storage key on it`,
      );
      return;
    }

    try {
      await this.runPipeline(video, video.storage_key);
    } catch (error) {
      if (error instanceof VideoRejected) {
        await this.fail(videoId, error.reason);
        return;
      }

      this.logger.error(
        `Processing ${videoId} failed unexpectedly (attempt ${attempt + 1} of ${maxAttempts + 1})`,
        error as Error,
      );

      if (attempt >= maxAttempts) {
        await this.fail(videoId, VideoFailureReason.PROCESSING_FAILED);
        return;
      }

      // Rethrow so pg-boss schedules the retry with its backoff.
      throw error;
    }
  }

  private async runPipeline(video: Video, storageKey: string): Promise<void> {
    // ffprobe reads only the header and index through range requests, so a
    // 10 GB source is never downloaded here. It must be the **internal**
    // presign: a URL signed for S3_PUBLIC_ENDPOINT carries `localhost:9000` in
    // its signed Host, which inside this container points at the worker itself.
    const sourceUrl =
      await this.storageService.getInternalPresignedUrl(storageKey);

    const probe = await this.probeOrReject(sourceUrl);
    this.assertSupported(probe);

    await this.videoRepository.update(
      { id: video.id },
      {
        duration_seconds: probe.durationSeconds.toFixed(3),
        width: probe.width,
        height: probe.height,
        video_codec: probe.videoCodec,
        audio_codec: probe.audioCodec,
        container: probe.containerFormats[0] ?? null,
        size_bytes: String(probe.sizeBytes),
        mime_type: mimeTypeFor(probe.containerFormats),
      },
    );

    await this.remuxToFaststartIfNeeded(video.id, storageKey, probe);
    await this.generateThumbnail(video.id, storageKey, probe);

    await this.videoRepository.update(
      { id: video.id },
      { status: VideoStatus.READY, failure_reason: null },
    );
  }

  private async probeOrReject(sourceUrl: string): Promise<ProbeResult> {
    try {
      return await this.ffmpegService.probe(sourceUrl);
    } catch (error) {
      const message = (error as Error).message ?? '';
      throw new VideoRejected(
        message.includes('no video stream')
          ? VideoFailureReason.NO_VIDEO_STREAM
          : VideoFailureReason.PROBE_FAILED,
      );
    }
  }

  /**
   * The authoritative check. What the client declared at the tus layer was a
   * hint; this is what the bytes actually are.
   */
  private assertSupported(probe: ProbeResult): void {
    const containerAccepted = candidateContainers(probe.containerFormats).some(
      (format) => this.uploadCfg.acceptedContainers.includes(format),
    );
    if (!containerAccepted) {
      throw new VideoRejected(VideoFailureReason.UNSUPPORTED_CONTAINER);
    }

    if (
      !this.uploadCfg.acceptedVideoCodecs.includes(
        probe.videoCodec.toLowerCase(),
      )
    ) {
      throw new VideoRejected(VideoFailureReason.UNSUPPORTED_VIDEO_CODEC);
    }
  }

  /**
   * Rewrites the object in place when its `moov` atom trails `mdat`, so
   * progressive playback works. The promotion touches only `storage_key` — the
   * adjacent `.info` metadata object the S3Store keeps must not be overwritten.
   */
  private async remuxToFaststartIfNeeded(
    videoId: string,
    storageKey: string,
    probe: ProbeResult,
  ): Promise<void> {
    const needsCheck = probe.containerFormats.some((format) =>
      FASTSTART_CONTAINERS.includes(format),
    );
    if (!needsCheck) {
      return;
    }

    const head = await this.readRange(storageKey, MOOV_PROBE_BYTES);
    if (hasFaststartLayout(head)) {
      return;
    }

    const scratch = join(this.queueCfg.workerScratchDir, videoId);
    // Extensions matter: ffmpeg picks the muxer from the output path.
    const localSource = join(scratch, 'source.mp4');
    const localOutput = join(scratch, 'faststart.mp4');
    const temporaryKey = `${storageKey}.faststart`;

    try {
      await mkdir(scratch, { recursive: true });
      await this.download(storageKey, localSource);
      await this.ffmpegService.remuxFaststart(localSource, localOutput);

      await this.storageService.putObject(
        temporaryKey,
        createReadStream(localOutput),
        undefined,
        (await stat(localOutput)).size,
      );
      // Promote onto the original key, so streaming and download keep serving
      // the one key the video has ever had.
      await this.storageService.copyObject(temporaryKey, storageKey);
      await this.storageService.deleteObject(temporaryKey);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async generateThumbnail(
    videoId: string,
    storageKey: string,
    probe: ProbeResult,
  ): Promise<void> {
    const scratch = join(this.queueCfg.workerScratchDir, `${videoId}-thumb`);
    const localThumbnail = join(scratch, 'auto.webp');
    const atSeconds =
      (probe.durationSeconds * this.uploadCfg.thumbnailOffsetPercent) / 100;

    try {
      await mkdir(scratch, { recursive: true });
      const sourceUrl =
        await this.storageService.getInternalPresignedUrl(storageKey);
      await this.ffmpegService.extractFrame(
        sourceUrl,
        localThumbnail,
        atSeconds,
      );

      const key = videoThumbnailKey(videoId);
      await this.storageService.putObject(
        key,
        createReadStream(localThumbnail),
        'image/webp',
        (await stat(localThumbnail)).size,
      );
      await this.videoRepository.update(
        { id: videoId },
        { thumbnail_key: key },
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Marks the video failed. Called on a rejection, and on the final retry. */
  async fail(videoId: string, reason: VideoFailureReason): Promise<void> {
    await this.videoRepository.update(
      { id: videoId },
      { status: VideoStatus.FAILED, failure_reason: reason },
    );
    this.logger.warn(`Video ${videoId} failed: ${reason}`);
  }

  private async readRange(key: string, bytes: number): Promise<Buffer> {
    const stream = await this.storageService.getObjectStream(
      key,
      `bytes=0-${bytes - 1}`,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Buffer));
    }

    return Buffer.concat(chunks);
  }

  private async download(key: string, destination: string): Promise<void> {
    const stream = await this.storageService.getObjectStream(key);
    await pipeline(stream, createWriteStream(destination));
  }
}

/** ffprobe reports a list of format names; map it onto a single MIME type. */
function mimeTypeFor(containerFormats: string[]): string | null {
  if (containerFormats.includes('mp4')) return 'video/mp4';
  if (containerFormats.includes('mov')) return 'video/quicktime';
  if (containerFormats.includes('webm')) return 'video/webm';
  if (containerFormats.includes('matroska')) return 'video/x-matroska';

  return null;
}
