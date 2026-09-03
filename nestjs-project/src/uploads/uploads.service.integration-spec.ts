import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { QueueModule } from '../queue/queue.module';
import { QueueService } from '../queue/queue.service';
import { QUEUE_NAMES } from '../queue/queue.types';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { UploadTicketService } from '../videos/upload-ticket.service';
import { VideoStatus } from '../videos/video-status.enum';
import { VideosModule } from '../videos/videos.module';
import { TusError, UploadsService } from './uploads.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/** The web Request shape @tus/server@2 hands its hooks. */
const tusRequest = (ticket: string, method = 'POST'): Request =>
  new Request('http://localhost:3000/uploads', {
    method,
    headers: { authorization: `Bearer ${ticket}` },
  });

describe('UploadsService (integration)', () => {
  let module: TestingModule;
  let service: UploadsService;
  let queueService: QueueService;
  let uploadTicketService: UploadTicketService;
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
          load: [
            authConfig,
            databaseConfig,
            queueConfig,
            storageConfig,
            uploadConfig,
          ],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
          autoLoadEntities: false,
        }),
        TypeOrmModule.forFeature([Video, Channel, User]),
        QueueModule.register(),
        VideosModule,
      ],
      providers: [UploadsService],
    }).compile();

    service = module.get(UploadsService);
    queueService = module.get(QueueService);
    uploadTicketService = module.get(UploadTicketService);
    dataSource = module.get(DataSource);
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));
    videoRepository = module.get(getRepositoryToken(Video));

    await queueService.ensureQueue(QUEUE_NAMES.VIDEO_PROCESS);
  }, 120000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await dataSource.query('DELETE FROM pgboss.job');
  });

  /** A real user, channel, and a ticket signed by the real service. */
  async function createOwner(): Promise<{
    userId: string;
    channelId: string;
    ticket: string;
  }> {
    const seq = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `upl_${seq}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${seq}`,
        nickname: `uplchan${seq}x${Date.now() % 100000}`,
        user_id: user.id,
      }),
    );

    return {
      userId: user.id,
      channelId: channel.id,
      ticket: uploadTicketService.issue(user.id).ticket,
    };
  }

  const upload = (id: string, size = 1024) => ({
    id,
    size,
    metadata: { filename: 'My Holiday.mp4', filetype: 'video/mp4' },
  });

  const countJobs = async (videoId: string) =>
    (
      await queueService.findJobs(QUEUE_NAMES.VIDEO_PROCESS, {
        data: { videoId },
      })
    ).length;

  describe('handleUploadCreate', () => {
    it('should persist a draft video bound to the caller channel', async () => {
      const { channelId, ticket } = await createOwner();

      await service.handleUploadCreate(tusRequest(ticket), upload('u1.mp4'));

      const video = await videoRepository.findOneOrFail({
        where: { upload_id: 'u1.mp4' },
      });
      expect(video.channel_id).toBe(channelId);
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.storage_key).toBe('u1.mp4');
      expect(video.title).toBe('My Holiday');
      expect(video.original_filename).toBe('My Holiday.mp4');
      expect(video.upload_expires_at).not.toBeNull();
    });

    it('should set upload_expires_at 24 hours out', async () => {
      const { ticket } = await createOwner();

      await service.handleUploadCreate(tusRequest(ticket), upload('u2.mp4'));

      const video = await videoRepository.findOneOrFail({
        where: { upload_id: 'u2.mp4' },
      });
      const hours =
        (video.upload_expires_at!.getTime() - Date.now()) / (60 * 60 * 1000);
      expect(hours).toBeGreaterThan(23.5);
      expect(hours).toBeLessThan(24.5);
    });

    it('should reject a second create while one upload is in flight', async () => {
      const { ticket } = await createOwner();
      await service.handleUploadCreate(tusRequest(ticket), upload('u3.mp4'));

      await expect(
        service.runHook(() =>
          service.handleUploadCreate(tusRequest(ticket), upload('u4.mp4')),
        ),
      ).rejects.toMatchObject({ status_code: 409 });
      expect(await videoRepository.count()).toBe(1);
    });
  });

  describe('handleIncomingRequest', () => {
    it('should promote the first PATCH to uploading and leave the second alone', async () => {
      const { ticket } = await createOwner();
      await service.handleUploadCreate(tusRequest(ticket), upload('u5.mp4'));

      await service.handleIncomingRequest(
        tusRequest(ticket, 'PATCH'),
        'u5.mp4',
      );
      const afterFirst = await videoRepository.findOneOrFail({
        where: { upload_id: 'u5.mp4' },
      });
      expect(afterFirst.status).toBe(VideoStatus.UPLOADING);

      await service.handleIncomingRequest(
        tusRequest(ticket, 'PATCH'),
        'u5.mp4',
      );
      const afterSecond = await videoRepository.findOneOrFail({
        where: { upload_id: 'u5.mp4' },
      });
      // The guarded UPDATE matches only a `draft` row, so this was not a write.
      expect(afterSecond.updated_at.getTime()).toBe(
        afterFirst.updated_at.getTime(),
      );
    });

    it('should reject a ticket that does not own the upload', async () => {
      const owner = await createOwner();
      await service.handleUploadCreate(
        tusRequest(owner.ticket),
        upload('u6.mp4'),
      );
      const stranger = await createOwner();

      await expect(
        service.runHook(() =>
          service.handleIncomingRequest(
            tusRequest(stranger.ticket, 'PATCH'),
            'u6.mp4',
          ),
        ),
      ).rejects.toMatchObject({ status_code: 403 });

      expect(
        (
          await videoRepository.findOneOrFail({
            where: { upload_id: 'u6.mp4' },
          })
        ).status,
      ).toBe(VideoStatus.DRAFT);
    });
  });

  describe('handleUploadFinish', () => {
    it('should commit processing and the queued job together', async () => {
      const { ticket } = await createOwner();
      await service.handleUploadCreate(tusRequest(ticket), upload('u7.mp4'));

      await service.handleUploadFinish(tusRequest(ticket), {
        id: 'u7.mp4',
        size: 4096,
      });

      const video = await videoRepository.findOneOrFail({
        where: { upload_id: 'u7.mp4' },
      });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.size_bytes).toBe('4096');
      expect(await countJobs(video.id)).toBe(1);
    });

    it('should leave the status untouched when the enqueue fails', async () => {
      const { ticket } = await createOwner();
      await service.handleUploadCreate(tusRequest(ticket), upload('u8.mp4'));
      const before = await videoRepository.findOneOrFail({
        where: { upload_id: 'u8.mp4' },
      });
      jest
        .spyOn(queueService, 'send')
        .mockRejectedValueOnce(new Error('queue is down'));

      await expect(
        service.handleUploadFinish(tusRequest(ticket), { id: 'u8.mp4' }),
      ).rejects.toThrow('queue is down');

      const after = await videoRepository.findOneOrFail({
        where: { upload_id: 'u8.mp4' },
      });
      // Both sides rolled back: no `processing` without a job.
      expect(after.status).toBe(before.status);
      expect(await countJobs(before.id)).toBe(0);
    });
  });

  describe('runHook', () => {
    it('should surface a domain exception as its tus status code', async () => {
      const error: TusError = await service
        .runHook(() =>
          service.handleUploadCreate(
            tusRequest('not-a-ticket'),
            upload('u9.mp4'),
          ),
        )
        .then(
          () => {
            throw new Error('expected a rejection');
          },
          (e: TusError) => e,
        );

      expect(error.status_code).toBe(401);
      expect(error.body).toContain('INVALID_UPLOAD_TICKET');
    });
  });
});
