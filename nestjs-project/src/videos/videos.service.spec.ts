import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  UploadAlreadyInProgressException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { StorageService } from '../storage/storage.service';
import { UploadTicketService } from './upload-ticket.service';
import { Video } from './entities/video.entity';
import { VideoFailureReason } from './video-failure-reason.enum';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const UPLOAD_URL = 'http://localhost:3000/uploads';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: { countBy: jest.Mock; findOne: jest.Mock };
  let channelRepository: { findOneOrFail: jest.Mock };
  let uploadTicketService: { issue: jest.Mock };
  let storageService: { getPresignedUrl: jest.Mock };

  beforeEach(async () => {
    videoRepository = { countBy: jest.fn(), findOne: jest.fn() };
    channelRepository = { findOneOrFail: jest.fn() };
    uploadTicketService = { issue: jest.fn() };
    storageService = { getPresignedUrl: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: getRepositoryToken(Channel), useValue: channelRepository },
        { provide: UploadTicketService, useValue: uploadTicketService },
        { provide: StorageService, useValue: storageService },
        {
          provide: uploadConfig.KEY,
          useValue: { publicUrl: UPLOAD_URL },
        },
        {
          provide: storageConfig.KEY,
          useValue: { presignedUrlExpirationSeconds: 900 },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('requestUploadTicket', () => {
    it('should issue a ticket when nothing is in flight', async () => {
      channelRepository.findOneOrFail.mockResolvedValue({ id: 'channel-1' });
      videoRepository.countBy.mockResolvedValue(0);
      const expiresAt = new Date('2026-09-03T12:00:00.000Z');
      uploadTicketService.issue.mockReturnValue({
        ticket: 'the-ticket',
        expiresAt,
      });

      const result = await service.requestUploadTicket('user-1');

      expect(result).toEqual({
        ticket: 'the-ticket',
        upload_url: UPLOAD_URL,
        expires_at: expiresAt.toISOString(),
      });
      expect(uploadTicketService.issue).toHaveBeenCalledWith('user-1');
    });

    it('should throw when an upload is already in flight within its window', async () => {
      channelRepository.findOneOrFail.mockResolvedValue({ id: 'channel-1' });
      videoRepository.countBy.mockResolvedValue(1);

      await expect(service.requestUploadTicket('user-1')).rejects.toThrow(
        UploadAlreadyInProgressException,
      );
      expect(uploadTicketService.issue).not.toHaveBeenCalled();
    });

    it('should scope the in-flight check to the caller channel and a live deadline', async () => {
      channelRepository.findOneOrFail.mockResolvedValue({ id: 'channel-1' });
      videoRepository.countBy.mockResolvedValue(0);
      uploadTicketService.issue.mockReturnValue({
        ticket: 't',
        expiresAt: new Date(),
      });

      await service.requestUploadTicket('user-1');

      const calls = videoRepository.countBy.mock.calls as [
        { channel_id: string; upload_expires_at: unknown },
      ][];
      const criteria = calls[0][0];
      expect(criteria.channel_id).toBe('channel-1');
      expect(criteria.upload_expires_at).toBeDefined();
    });
  });

  describe('findByPublicIdForOwner', () => {
    it('should return the video when the caller owns its channel', async () => {
      const video = { id: 'v1', channel: { user_id: 'user-1' } };
      videoRepository.findOne.mockResolvedValue(video);

      await expect(
        service.findByPublicIdForOwner('abc', 'user-1'),
      ).resolves.toBe(video);
    });

    it('should throw VideoNotFoundException for an unknown public id', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findByPublicIdForOwner('abc', 'user-1'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw the same exception for a video owned by someone else', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'v1',
        channel: { user_id: 'another-user' },
      });

      // Identical to the unknown-id case on purpose: ownership must not be
      // probeable through the response.
      await expect(
        service.findByPublicIdForOwner('abc', 'user-1'),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('toResponseDto', () => {
    const entity = (overrides: Partial<Video> = {}): Video =>
      ({
        public_id: 'aBcDeFgHiJk',
        title: 'Holiday',
        description: null,
        status: VideoStatus.READY,
        failure_reason: null,
        duration_seconds: '3.005',
        width: 320,
        height: 240,
        original_filename: 'holiday.mp4',
        size_bytes: '10737418240',
        thumbnail_key: null,
        created_at: new Date('2026-09-01T10:00:00.000Z'),
        updated_at: new Date('2026-09-01T10:05:00.000Z'),
        ...overrides,
      }) as Video;

    it('should convert the string-valued bigint and numeric columns to numbers', async () => {
      const dto = await service.toResponseDto(entity());

      expect(dto.size_bytes).toBe(10_737_418_240);
      expect(dto.duration_seconds).toBe(3.005);
    });

    it('should keep null for absent numeric columns', async () => {
      const dto = await service.toResponseDto(
        entity({ size_bytes: null, duration_seconds: null }),
      );

      expect(dto.size_bytes).toBeNull();
      expect(dto.duration_seconds).toBeNull();
    });

    it('should presign the thumbnail only when a key exists', async () => {
      storageService.getPresignedUrl.mockResolvedValue('https://signed/thumb');

      const withThumb = await service.toResponseDto(
        entity({ thumbnail_key: 'thumbnails/v1/auto.webp' }),
      );
      expect(withThumb.thumbnail_url).toBe('https://signed/thumb');
      expect(storageService.getPresignedUrl).toHaveBeenCalledWith(
        'thumbnails/v1/auto.webp',
      );

      storageService.getPresignedUrl.mockClear();
      const without = await service.toResponseDto(entity());
      expect(without.thumbnail_url).toBeNull();
      expect(storageService.getPresignedUrl).not.toHaveBeenCalled();
    });

    it('should never expose internal identifiers', async () => {
      const dto = await service.toResponseDto(
        entity({
          id: 'internal-uuid',
          channel_id: 'channel-uuid',
          upload_id: 'upload-id.mp4',
          storage_key: 'upload-id.mp4',
        }),
      );

      expect(dto).not.toHaveProperty('id');
      expect(dto).not.toHaveProperty('channel_id');
      expect(dto).not.toHaveProperty('upload_id');
      expect(dto).not.toHaveProperty('storage_key');
    });

    it('should carry the failure reason alongside a failed status', async () => {
      const dto = await service.toResponseDto(
        entity({
          status: VideoStatus.FAILED,
          failure_reason: VideoFailureReason.UNSUPPORTED_VIDEO_CODEC,
        }),
      );

      expect(dto.status).toBe(VideoStatus.FAILED);
      expect(dto.failure_reason).toBe('UNSUPPORTED_VIDEO_CODEC');
    });
  });

  describe('delivery URLs', () => {
    const readyVideo = (overrides: Partial<Video> = {}) =>
      ({
        public_id: 'aBcDeFgHiJk',
        status: VideoStatus.READY,
        storage_key: 'ready-clip.mp4',
        original_filename: 'My Holiday.mp4',
        channel: { user_id: 'user-1' },
        ...overrides,
      }) as Video;

    it('should expire the playback URL after the configured presign window', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());
      storageService.getPresignedUrl.mockResolvedValue('https://signed/clip');
      const before = Date.now();

      const result = await service.getPlaybackUrl('aBcDeFgHiJk', 'user-1');

      expect(result.url).toBe('https://signed/clip');
      const seconds = (new Date(result.expires_at).getTime() - before) / 1000;
      expect(seconds).toBeGreaterThan(890);
      expect(seconds).toBeLessThanOrEqual(900);
    });

    it('should refuse a ready-looking video whose storage key is missing', async () => {
      videoRepository.findOne.mockResolvedValue(
        readyVideo({ storage_key: null }),
      );

      await expect(
        service.getPlaybackUrl('aBcDeFgHiJk', 'user-1'),
      ).rejects.toThrow(VideoNotReadyException);
    });

    it('should presign the download with the original filename', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());
      storageService.getPresignedUrl.mockResolvedValue('https://signed/dl');

      const result = await service.getDownloadUrl('aBcDeFgHiJk', 'user-1');

      expect(storageService.getPresignedUrl).toHaveBeenCalledWith(
        'ready-clip.mp4',
        { downloadFilename: 'My Holiday.mp4' },
      );
      expect(result.filename).toBe('My Holiday.mp4');
    });
  });
});
