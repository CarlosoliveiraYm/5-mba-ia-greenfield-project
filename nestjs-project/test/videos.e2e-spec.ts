import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { StorageService } from '../src/storage/storage.service';
import { configureApp } from '../src/bootstrap';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VideoFailureReason } from '../src/videos/video-failure-reason.enum';
import { VideoStatus } from '../src/videos/video-status.enum';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let throttlerStorage: ThrottlerStorageService;
  let storageService: StorageService;
  const uploadedKeys: string[] = [];
  let counter = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storageService = moduleFixture.get(StorageService);
  }, 60000);

  afterAll(async () => {
    await Promise.all(
      uploadedKeys.map((key) =>
        storageService.deleteObject(key).catch(() => {}),
      ),
    );
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  /** Registers, confirms and logs in, returning the access token. */
  async function signIn(): Promise<{ accessToken: string; userId: string }> {
    const email = `videos_e2e_${++counter}_${Date.now()}@example.com`;
    const password = 'password123';
    // The confirmation token only ever leaves the service through the mail
    // sender, so that is where it gets intercepted.
    const authService: {
      mailService: { sendConfirmationEmail: (...args: string[]) => unknown };
    } = app.get(AuthService);

    let confirmationToken = '';
    jest
      .spyOn(authService.mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        confirmationToken = t;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    // 204 No Content — the confirmation endpoint answers with an empty body.
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const user = await userRepository.findOneByOrFail({ email });

    return {
      accessToken: (login.body as { access_token: string }).access_token,
      userId: user.id,
    };
  }

  const hoursFromNow = (hours: number) =>
    new Date(Date.now() + hours * 60 * 60 * 1000);

  async function seedVideo(
    userId: string,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const channel = await channelRepository.findOneByOrFail({
      user_id: userId,
    });
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Seeded video',
        original_filename: 'seeded.mp4',
        ...overrides,
      }),
    );
  }

  describe('POST /videos/upload-ticket', () => {
    it('should return 200 with ticket, upload_url and expires_at', async () => {
      const { accessToken } = await signIn();

      const response = await request(app.getHttpServer())
        .post('/videos/upload-ticket')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toEqual({
        ticket: expect.any(String) as string,
        upload_url: expect.any(String) as string,
        expires_at: expect.any(String) as string,
      });
      const body = response.body as { ticket: string; upload_url: string };
      expect(body.upload_url).toContain('/uploads');
      // A JWT, not an opaque handle — the tus layer verifies it offline.
      expect(body.ticket.split('.')).toHaveLength(3);
    });

    it('should return 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload-ticket')
        .expect(401);
    });

    it('should return 401 for a malformed access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload-ticket')
        .set('Authorization', 'Bearer not-a-token')
        .expect(401);
    });

    it('should return 409 UPLOAD_ALREADY_IN_PROGRESS while one upload is in flight', async () => {
      const { accessToken, userId } = await signIn();
      await seedVideo(userId, {
        status: VideoStatus.UPLOADING,
        upload_expires_at: hoursFromNow(24),
      });

      const response = await request(app.getHttpServer())
        .post('/videos/upload-ticket')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);

      expect(response.body).toMatchObject({
        statusCode: 409,
        error: 'UPLOAD_ALREADY_IN_PROGRESS',
      });
    });

    it('should issue again once the previous upload has expired', async () => {
      const { accessToken, userId } = await signIn();
      await seedVideo(userId, {
        status: VideoStatus.DRAFT,
        upload_expires_at: hoursFromNow(-1),
      });

      await request(app.getHttpServer())
        .post('/videos/upload-ticket')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });
  });

  describe('GET /videos/:publicId', () => {
    it('should return 200 with the documented shape and no internal identifiers', async () => {
      const { accessToken, userId } = await signIn();
      const video = await seedVideo(userId, {
        status: VideoStatus.READY,
        duration_seconds: '3.005',
        width: 320,
        height: 240,
        size_bytes: '10737418240',
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const body = response.body as Record<string, unknown>;
      expect(body).toMatchObject({
        public_id: video.public_id,
        title: 'Seeded video',
        status: 'ready',
        duration_seconds: 3.005,
        width: 320,
        height: 240,
        size_bytes: 10737418240,
        original_filename: 'seeded.mp4',
        thumbnail_url: null,
      });
      expect(body).not.toHaveProperty('id');
      expect(body).not.toHaveProperty('channel_id');
      expect(body).not.toHaveProperty('upload_id');
      expect(body).not.toHaveProperty('storage_key');
    });

    it('should reflect the live status of the row', async () => {
      const { accessToken, userId } = await signIn();
      const video = await seedVideo(userId, { status: VideoStatus.PROCESSING });

      const first = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect((first.body as { status: string }).status).toBe('processing');

      await videoRepository.update(
        { id: video.id },
        { status: VideoStatus.READY },
      );

      const second = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect((second.body as { status: string }).status).toBe('ready');
    });

    it('should expose a machine-readable failure_reason for a failed video', async () => {
      const { accessToken, userId } = await signIn();
      const video = await seedVideo(userId, {
        status: VideoStatus.FAILED,
        failure_reason: VideoFailureReason.UNSUPPORTED_VIDEO_CODEC,
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'failed',
        failure_reason: 'UNSUPPORTED_VIDEO_CODEC',
      });
    });

    it('should return 404 for an unknown public id', async () => {
      const { accessToken } = await signIn();

      const response = await request(app.getHttpServer())
        .get('/videos/doesnotexist')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect(response.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    });

    it('should return the same 404 for another user video', async () => {
      const owner = await signIn();
      const video = await seedVideo(owner.userId);
      const stranger = await signIn();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(404);

      // Indistinguishable from an unknown id, so ownership cannot be probed.
      expect(response.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    });

    it('should return 401 without an access token', async () => {
      const { userId } = await signIn();
      const video = await seedVideo(userId);

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .expect(401);
    });
  });

  describe('rate limiting', () => {
    it('should let the status endpoint be polled past the global 10/min window', async () => {
      const { accessToken, userId } = await signIn();
      const video = await seedVideo(userId, { status: VideoStatus.PROCESSING });

      // TD-09 has the client polling every few seconds; at 3s that is 20/min,
      // which the global ThrottlerGuard would otherwise cut off with a 429.
      for (let i = 0; i < 15; i++) {
        await request(app.getHttpServer())
          .get(`/videos/${video.public_id}`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);
      }
    }, 60000);

    it('should still throttle POST /videos/upload-ticket on the 11th call in a minute', async () => {
      const { accessToken } = await signIn();

      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const response = await request(app.getHttpServer())
          .post('/videos/upload-ticket')
          .set('Authorization', `Bearer ${accessToken}`);
        statuses.push(response.status);
      }

      expect(statuses).toContain(429);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    }, 60000);
  });

  describe('GET /videos/:publicId/playback and /download', () => {
    /** A ready video whose object really exists in storage. */
    async function seedReadyVideo(userId: string): Promise<Video> {
      const key = `test-delivery/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.mp4`;
      uploadedKeys.push(key);
      await storageService.putObject(
        key,
        Buffer.alloc(2048, 0x5a),
        'video/mp4',
      );

      return seedVideo(userId, {
        status: VideoStatus.READY,
        storage_key: key,
        original_filename: 'My Holiday.mp4',
      });
    }

    it('should return a playback URL that streams with Range support', async () => {
      const { accessToken, userId } = await signIn();
      const video = await seedReadyVideo(userId);

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const body = response.body as { url: string; expires_at: string };
      expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());

      // Signed for the browser-reachable host — SigV4 covers Host, so a URL
      // signed for the internal one would fail from the browser.
      expect(new URL(body.url).host).toBe(
        new URL(process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000').host,
      );
      expect(body.url).toContain(video.storage_key!);

      // That host does not resolve from inside this container (it is this
      // container), so the Range behaviour is exercised against the same object
      // through the internal endpoint.
      const ranged = await fetch(
        await storageService.getInternalPresignedUrl(video.storage_key!),
        { headers: { Range: 'bytes=0-1023' } },
      );
      expect(ranged.status).toBe(206);
      expect((await ranged.arrayBuffer()).byteLength).toBe(1024);
    }, 60000);

    it('should return 409 VIDEO_NOT_READY while the video is processing', async () => {
      const { accessToken, userId } = await signIn();
      const video = await seedVideo(userId, {
        status: VideoStatus.PROCESSING,
        storage_key: 'processing.mp4',
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);

      expect(response.body).toMatchObject({ error: 'VIDEO_NOT_READY' });
    }, 60000);

    it("should return 404 for another user's video", async () => {
      const owner = await signIn();
      const video = await seedReadyVideo(owner.userId);
      const stranger = await signIn();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(404);

      expect(response.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    }, 60000);

    it('should return 401 without an access token', async () => {
      const { userId } = await signIn();
      const video = await seedReadyVideo(userId);

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback`)
        .expect(401);
    }, 60000);

    it('should return a download URL whose response is an attachment', async () => {
      const { accessToken, userId } = await signIn();
      const video = await seedReadyVideo(userId);

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const body = response.body as { url: string; filename: string };
      expect(body.filename).toBe('My Holiday.mp4');

      // The disposition the browser will receive is carried in the signed URL.
      expect(
        new URL(body.url).searchParams.get('response-content-disposition'),
      ).toBe('attachment; filename="My Holiday.mp4"');

      // And storage really honours it — asserted through the internal endpoint,
      // which is the one reachable from inside this container.
      const fetched = await fetch(
        await storageService.getInternalPresignedUrl(video.storage_key!, {
          downloadFilename: 'My Holiday.mp4',
        }),
      );
      expect(fetched.headers.get('content-disposition')).toBe(
        'attachment; filename="My Holiday.mp4"',
      );
    }, 60000);

    it('should return only JSON — the video bytes never transit the API', async () => {
      const { accessToken, userId } = await signIn();
      const video = await seedReadyVideo(userId);

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.headers['content-type']).toContain('application/json');
      // 2048 bytes of object, but a response measured in hundreds.
      expect(Number(response.headers['content-length'])).toBeLessThan(1024);
    }, 60000);
  });
});
