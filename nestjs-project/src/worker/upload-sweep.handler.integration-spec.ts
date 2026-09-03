import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { TusStoreModule } from '../uploads/tus-store.module';
import { TUS_INFO_SUFFIX } from '../uploads/uploads.constants';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoFailureReason } from '../videos/video-failure-reason.enum';
import { VideoStatus } from '../videos/video-status.enum';
import { UploadSweepHandler } from './upload-sweep.handler';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('UploadSweepHandler (integration)', () => {
  let module: TestingModule;
  let handler: UploadSweepHandler;
  let storageService: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let counter = 0;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig, storageConfig, uploadConfig],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
          autoLoadEntities: false,
        }),
        TypeOrmModule.forFeature([Video, Channel, User]),
        StorageModule,
        TusStoreModule,
      ],
      providers: [UploadSweepHandler],
    }).compile();

    handler = module.get(UploadSweepHandler);
    storageService = module.get(StorageService);
    dataSource = module.get(DataSource);
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));
    videoRepository = module.get(getRepositoryToken(Video));
  }, 120000);

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        storageService.deleteObject(key).catch(() => {}),
      ),
    );
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  const hoursFromNow = (hours: number) =>
    new Date(Date.now() + hours * 60 * 60 * 1000);

  /** A video row plus the two objects the tus store would have written. */
  async function seedVideoWithObjects(
    overrides: Partial<Video>,
  ): Promise<Video> {
    const seq = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `sweep_${seq}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${seq}`,
        nickname: `swchan${seq}x${Date.now() % 100000}`,
        user_id: user.id,
      }),
    );

    const storageKey = `test-sweep/${seq}-${Date.now()}.mp4`;
    createdKeys.push(storageKey, `${storageKey}${TUS_INFO_SUFFIX}`);
    await storageService.putObject(storageKey, Buffer.from('video bytes'));
    await storageService.putObject(
      `${storageKey}${TUS_INFO_SUFFIX}`,
      Buffer.from('{"upload-id":"x"}'),
    );

    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Sweep me',
        original_filename: 'clip.mp4',
        upload_id: storageKey,
        storage_key: storageKey,
        ...overrides,
      }),
    );
  }

  const reload = (id: string) => videoRepository.findOneByOrFail({ id });

  const objectExists = async (key: string): Promise<boolean> => {
    try {
      await storageService.headObject(key);
      return true;
    } catch {
      return false;
    }
  };

  it.each([VideoStatus.DRAFT, VideoStatus.UPLOADING])(
    'should fail a %s row past its deadline and reclaim its storage',
    async (status) => {
      const video = await seedVideoWithObjects({
        status,
        upload_expires_at: hoursFromNow(-1),
      });

      await handler.process();

      const swept = await reload(video.id);
      expect(swept.status).toBe(VideoStatus.FAILED);
      expect(swept.failure_reason).toBe(VideoFailureReason.UPLOAD_ABANDONED);
      expect(await objectExists(video.storage_key!)).toBe(false);
      // The store's adjacent metadata object goes too.
      expect(
        await objectExists(`${video.storage_key!}${TUS_INFO_SUFFIX}`),
      ).toBe(false);
    },
    120000,
  );

  it('should leave a draft still inside its window untouched', async () => {
    const video = await seedVideoWithObjects({
      status: VideoStatus.DRAFT,
      upload_expires_at: hoursFromNow(23),
    });

    await handler.process();

    const untouched = await reload(video.id);
    expect(untouched.status).toBe(VideoStatus.DRAFT);
    expect(untouched.failure_reason).toBeNull();
    expect(await objectExists(video.storage_key!)).toBe(true);
  }, 120000);

  it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
    'should never touch a %s row, even with a past deadline',
    async (status) => {
      const video = await seedVideoWithObjects({
        status,
        upload_expires_at: hoursFromNow(-48),
      });

      await handler.process();

      const untouched = await reload(video.id);
      expect(untouched.status).toBe(status);
      expect(await objectExists(video.storage_key!)).toBe(true);
    },
    120000,
  );

  it('should let the owner request a new ticket once their abandoned upload is swept', async () => {
    const video = await seedVideoWithObjects({
      status: VideoStatus.UPLOADING,
      upload_expires_at: hoursFromNow(-1),
    });

    await handler.process();

    // The one-in-flight rule counts draft/uploading rows inside their window;
    // after the sweep this row is `failed`, so nothing blocks a new upload.
    const stillInFlight = await videoRepository.count({
      where: {
        channel_id: video.channel_id,
        status: VideoStatus.UPLOADING,
      },
    });
    expect(stillInFlight).toBe(0);
  }, 120000);
});
