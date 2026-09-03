import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  UploadAlreadyInProgressException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { StorageService } from '../storage/storage.service';
import type {
  DownloadUrlResponseDto,
  SignedUrlResponseDto,
} from './dto/signed-url-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video } from './entities/video.entity';
import { UploadTicketService } from './upload-ticket.service';
import { IN_FLIGHT_UPLOAD_STATUSES, VideoStatus } from './video-status.enum';

export interface UploadTicketResponse {
  ticket: string;
  upload_url: string;
  expires_at: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly uploadTicketService: UploadTicketService,
    private readonly storageService: StorageService,
    @Inject(uploadConfig.KEY)
    private readonly config: ConfigType<typeof uploadConfig>,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  async requestUploadTicket(userId: string): Promise<UploadTicketResponse> {
    const channel = await this.channelRepository.findOneOrFail({
      where: { user_id: userId },
    });

    await this.assertNoUploadInFlight(channel.id);

    const { ticket, expiresAt } = this.uploadTicketService.issue(userId);

    return {
      ticket,
      upload_url: this.config.publicUrl,
      expires_at: expiresAt.toISOString(),
    };
  }

  /**
   * TD-12's one-in-flight rule. An upload past `upload_expires_at` no longer
   * counts — otherwise a single abandoned upload would lock the user out until
   * the sweep runs.
   */
  async assertNoUploadInFlight(channelId: string): Promise<void> {
    const inFlight = await this.videoRepository.countBy({
      channel_id: channelId,
      status: In(IN_FLIGHT_UPLOAD_STATUSES),
      upload_expires_at: MoreThan(new Date()),
    });

    if (inFlight > 0) {
      throw new UploadAlreadyInProgressException();
    }
  }

  /**
   * An unknown `publicId` and someone else's video answer identically, so
   * ownership cannot be probed.
   */
  async findByPublicIdForOwner(
    publicId: string,
    userId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });

    if (!video || video.channel?.user_id !== userId) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  /**
   * A short-lived presigned GET for streaming. The bytes go from storage
   * straight to the browser — neither Node process is in the data plane, and
   * Range requests, seeking and resumable downloads come from the storage layer
   * for free.
   */
  async getPlaybackUrl(
    publicId: string,
    userId: string,
  ): Promise<SignedUrlResponseDto> {
    const video = await this.findReadyForOwner(publicId, userId);

    return {
      url: await this.storageService.getPresignedUrl(video.storage_key!),
      expires_at: this.presignedExpiry(),
    };
  }

  /** The same mechanism, with the disposition that makes it a download. */
  async getDownloadUrl(
    publicId: string,
    userId: string,
  ): Promise<DownloadUrlResponseDto> {
    const video = await this.findReadyForOwner(publicId, userId);

    return {
      url: await this.storageService.getPresignedUrl(video.storage_key!, {
        downloadFilename: video.original_filename,
      }),
      filename: video.original_filename,
      expires_at: this.presignedExpiry(),
    };
  }

  private async findReadyForOwner(
    publicId: string,
    userId: string,
  ): Promise<Video> {
    const video = await this.findByPublicIdForOwner(publicId, userId);

    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotReadyException();
    }

    return video;
  }

  private presignedExpiry(): string {
    return new Date(
      Date.now() + this.storageCfg.presignedUrlExpirationSeconds * 1000,
    ).toISOString();
  }

  /**
   * Entity → public DTO. Two conversions matter here: `bigint` and `numeric`
   * columns come back from the driver as strings, and the thumbnail is exposed
   * as a presigned URL rather than a storage key.
   */
  async toResponseDto(video: Video): Promise<VideoResponseDto> {
    return {
      public_id: video.public_id,
      title: video.title,
      description: video.description,
      status: video.status,
      failure_reason: video.failure_reason,
      duration_seconds: toNumberOrNull(video.duration_seconds),
      width: video.width,
      height: video.height,
      original_filename: video.original_filename,
      size_bytes: toNumberOrNull(video.size_bytes),
      thumbnail_url: video.thumbnail_key
        ? await this.storageService.getPresignedUrl(video.thumbnail_key)
        : null,
      created_at: video.created_at.toISOString(),
      updated_at: video.updated_at.toISOString(),
    };
  }
}

function toNumberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}
