import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { DomainException } from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import { QueueService } from '../queue/queue.service';
import { QUEUE_NAMES, toPgBossDb } from '../queue/queue.types';
import { uploadObjectExtension } from '../storage/storage.keys';
import { Video } from '../videos/entities/video.entity';
import { UploadTicketService } from '../videos/upload-ticket.service';
import { VideoStatus } from '../videos/video-status.enum';
import { VideosService } from '../videos/videos.service';

const MAX_TITLE_LENGTH = 100;
const FALLBACK_TITLE = 'Untitled video';

/**
 * The error shape `@tus/server` answers with: it reads `status_code` and `body`
 * off whatever is thrown. Modelled as an `Error` subclass rather than a plain
 * object so a stack trace survives — the properties are what tus reads either
 * way.
 */
export class TusError extends Error {
  constructor(
    readonly status_code: number,
    readonly body: string,
  ) {
    super(body.trim());
    this.name = 'TusError';
  }
}

function tusError(
  status_code: number,
  code: string,
  message: string,
): TusError {
  return new TusError(status_code, `${code}: ${message}\n`);
}

/** Domain exceptions carry the status and code; anything else is a 500. */
function toTusError(error: unknown): TusError {
  if (error instanceof DomainException) {
    return tusError(error.httpStatus, error.errorCode, error.message);
  }

  return tusError(500, 'UPLOAD_FAILED', 'Upload could not be processed');
}

/**
 * The domain half of the tus lifecycle.
 *
 * The hooks receive a **web** `Request` (`@tus/server@2` runs on srvx), so
 * headers are read with `req.headers.get()`, not `req.headers[...]`.
 */
@Injectable()
export class UploadsService implements OnModuleInit {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly uploadTicketService: UploadTicketService,
    private readonly videosService: VideosService,
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly queueService: QueueService,
    private readonly dataSource: DataSource,
    @Inject(uploadConfig.KEY)
    private readonly config: ConfigType<typeof uploadConfig>,
  ) {}

  /**
   * Declared by the publisher, not only by the worker: `boss.send` on a queue
   * that does not exist resolves to `null` instead of throwing, so an API that
   * starts before the worker would silently drop jobs. `createQueue` is
   * idempotent, so the worker declaring it too costs nothing.
   */
  async onModuleInit(): Promise<void> {
    await this.queueService.ensureQueue(QUEUE_NAMES.VIDEO_PROCESS, {
      retryBackoff: true,
    });
  }

  /**
   * Authenticates the ticket, validates the *declared* size and container, and
   * pre-registers the draft video. Everything checked here is a client claim —
   * the authoritative check is the worker's ffprobe pass.
   */
  async handleUploadCreate(
    req: Request,
    upload: {
      id: string;
      size?: number;
      metadata?: Record<string, string | null>;
    },
  ): Promise<{ metadata?: Record<string, string | null> }> {
    const userId = this.authenticate(req);
    const channel = await this.channelRepository.findOneOrFail({
      where: { user_id: userId },
    });

    await this.videosService.assertNoUploadInFlight(channel.id);

    if (upload.size !== undefined && upload.size > this.config.maxSizeBytes) {
      throw tusError(
        413,
        'UPLOAD_TOO_LARGE',
        'Upload exceeds the maximum allowed size',
      );
    }

    const filename = upload.metadata?.filename ?? '';
    const filetype = upload.metadata?.filetype ?? '';
    this.assertAcceptedContainer(filename, filetype);

    await this.videoRepository.save(
      this.videoRepository.create({
        channel_id: channel.id,
        title: titleFromFilename(filename),
        status: VideoStatus.DRAFT,
        upload_id: upload.id,
        // The id the namingFunction produced **is** the S3 key, and it is
        // already known here — namingFunction runs before this hook.
        storage_key: upload.id,
        original_filename: filename || upload.id,
        mime_type: filetype || null,
        size_bytes: upload.size !== undefined ? String(upload.size) : null,
        upload_expires_at: new Date(
          Date.now() + this.config.abandonedExpirationHours * 60 * 60 * 1000,
        ),
      }),
    );

    return {};
  }

  /**
   * Runs on every tus request, including the creation POST — where the id has no
   * video row yet, which is not an error.
   *
   * On the first PATCH the row is promoted to `uploading` with a single guarded
   * UPDATE, rather than one write per chunk.
   */
  async handleIncomingRequest(req: Request, uploadId: string): Promise<void> {
    const userId = this.authenticate(req);

    const video = await this.videoRepository.findOne({
      where: { upload_id: uploadId },
      relations: { channel: true },
    });

    if (!video) {
      // A creation request: the row is written by handleUploadCreate, next.
      return;
    }

    if (video.channel?.user_id !== userId) {
      throw tusError(
        403,
        'FORBIDDEN',
        'This upload belongs to a different user',
      );
    }

    if (req.method === 'PATCH') {
      await this.videoRepository.update(
        { upload_id: uploadId, status: VideoStatus.DRAFT },
        { status: VideoStatus.UPLOADING },
      );
    }
  }

  /**
   * Flips the video to `processing` and enqueues the job **in one transaction**,
   * so a committed status change always has a job and a rolled-back one never
   * leaves an orphan.
   */
  async handleUploadFinish(
    _req: Request,
    upload: { id: string; size?: number },
  ): Promise<Record<string, never>> {
    await this.dataSource.transaction(async (manager) => {
      const video = await manager.findOneOrFail(Video, {
        where: { upload_id: upload.id },
      });

      await manager.update(
        Video,
        { id: video.id },
        {
          status: VideoStatus.PROCESSING,
          ...(upload.size !== undefined && {
            size_bytes: String(upload.size),
          }),
        },
      );

      await this.queueService.send(
        QUEUE_NAMES.VIDEO_PROCESS,
        { videoId: video.id },
        { db: toPgBossDb(manager) },
      );
    });

    return {};
  }

  /** Every hook goes through here, so no tus request is ever unauthenticated. */
  private authenticate(req: Request): string {
    const raw = this.uploadTicketService.extractBearer(
      req.headers.get('authorization') ?? undefined,
    );

    return this.uploadTicketService.verify(raw).sub;
  }

  private assertAcceptedContainer(filename: string, filetype: string): void {
    const accepted = this.config.acceptedContainers;

    let extension: string | null = null;
    try {
      extension = uploadObjectExtension(filename);
    } catch {
      extension = null;
    }

    // The MIME subtype is the fallback when the filename carries no usable
    // extension (`video/mp4` → `mp4`).
    const fromMime = filetype.toLowerCase().startsWith('video/')
      ? filetype.slice('video/'.length).toLowerCase()
      : null;

    if (extension && accepted.includes(extension)) {
      return;
    }
    if (!extension && fromMime && accepted.includes(fromMime)) {
      return;
    }

    throw tusError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      `Unsupported video format. Accepted containers: ${accepted.join(', ')}`,
    );
  }

  /** Wraps a hook so a domain exception leaves as a tus-protocol error. */
  async runHook<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isTusError(error)) {
        throw error;
      }

      const mapped = toTusError(error);
      if (mapped.status_code >= 500) {
        this.logger.error('Unexpected error in a tus hook', error as Error);
      }
      throw mapped;
    }
  }
}

function isTusError(error: unknown): error is TusError {
  return error instanceof TusError;
}

/** The uploaded filename's basename, trimmed to the column's width. */
export function titleFromFilename(filename: string): string {
  const base = (filename.split(/[\\/]/).pop() ?? '').trim();
  const withoutExtension = base.replace(/\.[^.]+$/, '').trim();

  return withoutExtension.slice(0, MAX_TITLE_LENGTH) || FALLBACK_TITLE;
}
