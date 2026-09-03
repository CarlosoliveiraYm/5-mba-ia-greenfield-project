import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  UploadAlreadyInProgressException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { UploadTicketService } from './upload-ticket.service';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let counter = 0;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [authConfig, databaseConfig, storageConfig, uploadConfig],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
          autoLoadEntities: false,
        }),
        TypeOrmModule.forFeature([Video, Channel, User]),
        JwtModule.register({ secret: 'videos-integration-secret' }),
        StorageModule,
      ],
      providers: [VideosService, UploadTicketService],
    }).compile();

    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));
    videoRepository = module.get(getRepositoryToken(Video));
  }, 60000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createOwner(): Promise<{ user: User; channel: Channel }> {
    const seq = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `vsvc_${seq}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${seq}`,
        nickname: `vsvcchan${seq}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  const hoursFromNow = (hours: number) =>
    new Date(Date.now() + hours * 60 * 60 * 1000);

  function saveVideo(channel: Channel, overrides: Partial<Video> = {}) {
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'A video',
        original_filename: 'a.mp4',
        ...overrides,
      }),
    );
  }

  describe('requestUploadTicket', () => {
    it('should issue a ticket for a user with no in-flight upload', async () => {
      const { user } = await createOwner();

      const result = await service.requestUploadTicket(user.id);

      expect(result.ticket).toEqual(expect.any(String));
      expect(result.upload_url).toContain('/uploads');
      expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it.each([VideoStatus.DRAFT, VideoStatus.UPLOADING])(
      'should throw when a %s video sits inside its expiry window',
      async (status) => {
        const { user, channel } = await createOwner();
        await saveVideo(channel, {
          status,
          upload_expires_at: hoursFromNow(24),
        });

        await expect(service.requestUploadTicket(user.id)).rejects.toThrow(
          UploadAlreadyInProgressException,
        );
      },
    );

    it('should issue again once the in-flight upload has expired', async () => {
      const { user, channel } = await createOwner();
      await saveVideo(channel, {
        status: VideoStatus.DRAFT,
        upload_expires_at: hoursFromNow(-1),
      });

      await expect(
        service.requestUploadTicket(user.id),
      ).resolves.toHaveProperty('ticket');
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should ignore a %s video when checking for an upload in flight',
      async (status) => {
        const { user, channel } = await createOwner();
        await saveVideo(channel, {
          status,
          upload_expires_at: hoursFromNow(24),
        });

        await expect(
          service.requestUploadTicket(user.id),
        ).resolves.toHaveProperty('ticket');
      },
    );

    it('should not be blocked by another user in-flight upload', async () => {
      const { channel: otherChannel } = await createOwner();
      await saveVideo(otherChannel, {
        status: VideoStatus.UPLOADING,
        upload_expires_at: hoursFromNow(24),
      });
      const { user } = await createOwner();

      await expect(
        service.requestUploadTicket(user.id),
      ).resolves.toHaveProperty('ticket');
    });
  });

  describe('findByPublicIdForOwner', () => {
    it('should return the owner video', async () => {
      const { user, channel } = await createOwner();
      const video = await saveVideo(channel);

      const found = await service.findByPublicIdForOwner(
        video.public_id,
        user.id,
      );

      expect(found.id).toBe(video.id);
    });

    it('should throw for an unknown public id', async () => {
      const { user } = await createOwner();

      await expect(
        service.findByPublicIdForOwner('nonexistent', user.id),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw the same exception for another user video', async () => {
      const { channel } = await createOwner();
      const video = await saveVideo(channel);
      const { user: stranger } = await createOwner();

      await expect(
        service.findByPublicIdForOwner(video.public_id, stranger.id),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('toResponseDto', () => {
    it('should convert size_bytes and duration_seconds off their string columns', async () => {
      const { channel } = await createOwner();
      const video = await saveVideo(channel, {
        size_bytes: '10737418240',
        duration_seconds: '3.005',
        width: 320,
        height: 240,
      });

      const dto = await service.toResponseDto(
        await videoRepository.findOneByOrFail({ id: video.id }),
      );

      expect(dto.size_bytes).toBe(10_737_418_240);
      expect(dto.duration_seconds).toBe(3.005);
      expect(dto.width).toBe(320);
    });

    it('should presign thumbnail_url only when a thumbnail key exists', async () => {
      const { channel } = await createOwner();
      const withoutThumb = await saveVideo(channel);
      const withThumb = await saveVideo(channel, {
        thumbnail_key: 'thumbnails/abc/auto.webp',
      });

      expect(
        (await service.toResponseDto(withoutThumb)).thumbnail_url,
      ).toBeNull();
      const signed = (await service.toResponseDto(withThumb)).thumbnail_url;
      expect(signed).toContain('thumbnails/abc/auto.webp');
      expect(signed).toContain('X-Amz-Signature');
    });

    it('should not leak internal identifiers', async () => {
      const { channel } = await createOwner();
      const video = await saveVideo(channel, {
        upload_id: 'u1.mp4',
        storage_key: 'u1.mp4',
      });

      const dto = await service.toResponseDto(video);

      expect(Object.keys(dto)).not.toEqual(
        expect.arrayContaining([
          'id',
          'channel_id',
          'upload_id',
          'storage_key',
        ]),
      );
    });
  });

  describe('getPlaybackUrl', () => {
    it('should return a presigned URL and expiry for a ready video', async () => {
      const { user, channel } = await createOwner();
      const video = await saveVideo(channel, {
        status: VideoStatus.READY,
        storage_key: 'ready-clip.mp4',
      });

      const result = await service.getPlaybackUrl(video.public_id, user.id);

      expect(result.url).toContain('ready-clip.mp4');
      expect(result.url).toContain('X-Amz-Signature');
      expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it.each([
      VideoStatus.DRAFT,
      VideoStatus.UPLOADING,
      VideoStatus.PROCESSING,
      VideoStatus.FAILED,
    ])('should throw VideoNotReadyException for a %s video', async (status) => {
      const { user, channel } = await createOwner();
      const video = await saveVideo(channel, {
        status,
        storage_key: 'not-ready.mp4',
      });

      await expect(
        service.getPlaybackUrl(video.public_id, user.id),
      ).rejects.toThrow(VideoNotReadyException);
    });

    it('should throw VideoNotFoundException for another user video', async () => {
      const { channel } = await createOwner();
      const video = await saveVideo(channel, {
        status: VideoStatus.READY,
        storage_key: 'ready-clip.mp4',
      });
      const { user: stranger } = await createOwner();

      await expect(
        service.getPlaybackUrl(video.public_id, stranger.id),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('getDownloadUrl', () => {
    it('should presign with the original filename as the attachment name', async () => {
      const { user, channel } = await createOwner();
      const video = await saveVideo(channel, {
        status: VideoStatus.READY,
        storage_key: 'ready-clip.mp4',
        original_filename: 'My Holiday.mp4',
      });

      const result = await service.getDownloadUrl(video.public_id, user.id);

      expect(result.filename).toBe('My Holiday.mp4');
      expect(decodeURIComponent(result.url)).toContain(
        'attachment; filename="My Holiday.mp4"',
      );
    });

    it('should refuse a video that is not ready', async () => {
      const { user, channel } = await createOwner();
      const video = await saveVideo(channel, {
        status: VideoStatus.PROCESSING,
        storage_key: 'processing.mp4',
      });

      await expect(
        service.getDownloadUrl(video.public_id, user.id),
      ).rejects.toThrow(VideoNotReadyException);
    });
  });
});
