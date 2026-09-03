import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { TUS_INFO_SUFFIX, TUS_STORE } from '../uploads/uploads.constants';
import { Video } from '../videos/entities/video.entity';
import { VideoFailureReason } from '../videos/video-failure-reason.enum';
import {
  IN_FLIGHT_UPLOAD_STATUSES,
  VideoStatus,
} from '../videos/video-status.enum';

/** A store without the expiration extension answers `deleteExpired` with a 501. */
const NOT_IMPLEMENTED = 501;

interface ExpiringStore {
  deleteExpired(): Promise<number>;
}

/**
 * Closes the loop a resumable protocol opens: uploads that start and never
 * finish, holding S3 multipart parts and draft rows indefinitely.
 *
 * It injects the tus **store**, not the tus `Server` — so the worker context
 * stays free of any HTTP artifact.
 */
@Injectable()
export class UploadSweepHandler {
  private readonly logger = new Logger(UploadSweepHandler.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @Inject(TUS_STORE) private readonly store: ExpiringStore,
    private readonly storageService: StorageService,
  ) {}

  async process(): Promise<void> {
    const expiredUploads = await this.dropExpiredMultipartUploads();
    const failed = await this.failStaleDrafts();

    this.logger.log(
      `Sweep done: ${expiredUploads} expired multipart uploads dropped, ` +
        `${failed} stale drafts failed`,
    );
  }

  /** The primary reaper. The bucket lifecycle rule is only the backstop. */
  private async dropExpiredMultipartUploads(): Promise<number> {
    try {
      return await this.store.deleteExpired();
    } catch (error) {
      if (isNotImplemented(error)) {
        // Some stores do not implement the expiration extension; that is not a
        // failure of the sweep.
        this.logger.debug('Store does not implement expiration; skipping');
        return 0;
      }
      throw error;
    }
  }

  private async failStaleDrafts(): Promise<number> {
    const stale = await this.videoRepository.find({
      where: {
        status: In([...IN_FLIGHT_UPLOAD_STATUSES]),
        upload_expires_at: LessThan(new Date()),
      },
    });

    if (stale.length === 0) {
      return 0;
    }

    await this.videoRepository.update(
      { id: In(stale.map((video) => video.id)) },
      {
        status: VideoStatus.FAILED,
        failure_reason: VideoFailureReason.UPLOAD_ABANDONED,
      },
    );

    for (const video of stale) {
      await this.reclaimStorage(video);
    }

    return stale.length;
  }

  /**
   * Removes the orphaned object and the metadata object the `S3Store` writes
   * beside it (`S3Store#infoKey` — `${id}.info`, confirmed against the
   * installed version rather than assumed).
   */
  private async reclaimStorage(video: Video): Promise<void> {
    if (!video.storage_key) {
      return;
    }

    for (const key of [
      video.storage_key,
      `${video.storage_key}${TUS_INFO_SUFFIX}`,
    ]) {
      try {
        await this.storageService.deleteObject(key);
      } catch (error) {
        // A scheduled job must not die on one unreachable object; the bucket
        // lifecycle rule is the backstop.
        this.logger.warn(
          `Could not delete ${key} while sweeping ${video.id}: ${
            (error as Error).message
          }`,
        );
      }
    }
  }
}

function isNotImplemented(error: unknown): boolean {
  const candidate = error as {
    status_code?: number;
    statusCode?: number;
    $metadata?: { httpStatusCode?: number };
  } | null;

  return (
    candidate?.status_code === NOT_IMPLEMENTED ||
    candidate?.statusCode === NOT_IMPLEMENTED ||
    candidate?.$metadata?.httpStatusCode === NOT_IMPLEMENTED
  );
}
