import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
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
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { hasFaststartLayout } from '../ffmpeg/moov.util';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  cleanupTestVideos,
  createTestVideo,
  createTrailingMoovVideo,
  createUnsupportedCodecVideo,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoFailureReason } from '../videos/video-failure-reason.enum';
import { VideoStatus } from '../videos/video-status.enum';
import { VideoProcessingHandler } from './video-processing.handler';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingHandler (integration)', () => {
  let module: TestingModule;
  let handler: VideoProcessingHandler;
  let storageService: StorageService;
  let ffmpegService: FfmpegService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let scratchDir: string;
  let counter = 0;
  const uploadedKeys: string[] = [];

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
        FfmpegModule,
      ],
      providers: [VideoProcessingHandler],
    }).compile();

    handler = module.get(VideoProcessingHandler);
    storageService = module.get(StorageService);
    ffmpegService = module.get(FfmpegService);
    dataSource = module.get(DataSource);
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));
    videoRepository = module.get(getRepositoryToken(Video));
    scratchDir = process.env.WORKER_SCRATCH_DIR ?? '/tmp/streamtube';
  }, 120000);

  afterAll(async () => {
    await Promise.all(
      uploadedKeys.map((key) =>
        storageService.deleteObject(key).catch(() => {}),
      ),
    );
    cleanupTestVideos();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  /** Uploads a fixture and returns the video row waiting to be processed. */
  async function seedProcessingVideo(fixturePath: string): Promise<Video> {
    const seq = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `vph_${seq}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${seq}`,
        nickname: `vphchan${seq}x${Date.now() % 100000}`,
        user_id: user.id,
      }),
    );

    const storageKey = `test-processing/${seq}-${Date.now()}.mp4`;
    uploadedKeys.push(storageKey);
    await storageService.putObject(
      storageKey,
      createReadStream(fixturePath),
      'video/mp4',
      (await stat(fixturePath)).size,
    );

    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Processing me',
        original_filename: 'clip.mp4',
        status: VideoStatus.PROCESSING,
        upload_id: storageKey,
        storage_key: storageKey,
      }),
    );
  }

  const reload = (id: string) => videoRepository.findOneByOrFail({ id });

  const scratchEntries = async (): Promise<string[]> => {
    try {
      return await readdir(scratchDir);
    } catch {
      return [];
    }
  };

  it('should drive a faststart MP4 to ready with exact metadata and a fetchable thumbnail', async () => {
    const fixture = await createTestVideo({
      durationSeconds: 3,
      width: 320,
      height: 240,
    });
    const seeded = await seedProcessingVideo(fixture);

    await handler.process({ videoId: seeded.id });

    const video = await reload(seeded.id);
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.failure_reason).toBeNull();
    expect(Number(video.duration_seconds)).toBeCloseTo(3, 0);
    expect(video.width).toBe(320);
    expect(video.height).toBe(240);
    expect(video.video_codec).toBe('h264');
    expect(video.audio_codec).toBe('aac');
    expect(video.thumbnail_key).toBe(`thumbnails/${seeded.id}/auto.webp`);

    uploadedKeys.push(video.thumbnail_key!);
    const thumbnailUrl = await storageService.getInternalPresignedUrl(
      video.thumbnail_key!,
    );
    const response = await fetch(thumbnailUrl);
    expect(response.status).toBe(200);
    // A real WebP, not an empty object.
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
  }, 180000);

  it('should remux a trailing-moov MP4 in place, leaving no second object', async () => {
    const fixture = await createTrailingMoovVideo({
      durationSeconds: 3,
      width: 320,
      height: 240,
    });
    const seeded = await seedProcessingVideo(fixture);
    const before = await ffmpegService.probe(
      await storageService.getInternalPresignedUrl(seeded.storage_key!),
    );

    await handler.process({ videoId: seeded.id });

    const video = await reload(seeded.id);
    expect(video.status).toBe(VideoStatus.READY);
    if (video.thumbnail_key) uploadedKeys.push(video.thumbnail_key);

    // The object at the original key now has its moov at the head.
    const stream = await storageService.getObjectStream(
      seeded.storage_key!,
      'bytes=0-524287',
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(hasFaststartLayout(Buffer.concat(chunks))).toBe(true);

    // Same streams, no re-encode.
    const after = await ffmpegService.probe(
      await storageService.getInternalPresignedUrl(seeded.storage_key!),
    );
    expect(after.videoCodec).toBe(before.videoCodec);
    expect(after.audioCodec).toBe(before.audioCodec);
    expect(after.durationSeconds).toBeCloseTo(before.durationSeconds, 1);

    // The temporary promotion key is gone.
    await expect(
      storageService.headObject(`${seeded.storage_key!}.faststart`),
    ).rejects.toThrow();
  }, 180000);

  it('should leave a faststart MP4 byte-identical — no remux runs when it is not needed', async () => {
    const fixture = await createTestVideo({ durationSeconds: 2 });
    const seeded = await seedProcessingVideo(fixture);
    const sizeBefore = (await storageService.headObject(seeded.storage_key!))
      .contentLength;
    const etagBefore = (await storageService.headObject(seeded.storage_key!))
      .etag;

    await handler.process({ videoId: seeded.id });

    const after = await storageService.headObject(seeded.storage_key!);
    expect(after.contentLength).toBe(sizeBefore);
    expect(after.etag).toBe(etagBefore);
    const video = await reload(seeded.id);
    if (video.thumbnail_key) uploadedKeys.push(video.thumbnail_key);
  }, 180000);

  it('should fail an mpeg4 source with the codec reason and no thumbnail', async () => {
    const fixture = await createUnsupportedCodecVideo({ durationSeconds: 2 });
    const seeded = await seedProcessingVideo(fixture);

    await handler.process({ videoId: seeded.id });

    const video = await reload(seeded.id);
    expect(video.status).toBe(VideoStatus.FAILED);
    expect(video.failure_reason).toBe(
      VideoFailureReason.UNSUPPORTED_VIDEO_CODEC,
    );
    expect(video.thumbnail_key).toBeNull();
  }, 180000);

  it('should leave no scratch files behind after a successful job', async () => {
    const fixture = await createTrailingMoovVideo({ durationSeconds: 2 });
    const seeded = await seedProcessingVideo(fixture);

    await handler.process({ videoId: seeded.id });

    const video = await reload(seeded.id);
    if (video.thumbnail_key) uploadedKeys.push(video.thumbnail_key);
    const entries = await scratchEntries();
    expect(entries.filter((e) => e.startsWith(seeded.id))).toEqual([]);
  }, 180000);
});
