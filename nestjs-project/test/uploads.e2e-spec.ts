import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import * as tus from 'tus-js-client';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { configureApp } from '../src/bootstrap';
import { QueueService } from '../src/queue/queue.service';
import { QUEUE_NAMES } from '../src/queue/queue.types';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { cleanupTestVideos, createTestVideo } from '../src/test/video-fixtures';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';

const TEN_GIB = 10_737_418_240;

/** tus metadata is `key base64(value)` pairs, comma separated. */
function tusMetadata(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',');
}

describe('Uploads — tus (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let queueService: QueueService;
  let throttlerStorage: ThrottlerStorageService;
  let baseUrl: string;
  let counter = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    // tus-js-client speaks real HTTP, so the app has to be listening.
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    queueService = moduleFixture.get(QueueService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 120000);

  afterAll(async () => {
    cleanupTestVideos();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await dataSource.query('DELETE FROM pgboss.job');
    // Each signInWithTicket() spends 4 of the global 10-per-minute budget, so
    // without this the later tests in the file take a 429 instead of what they
    // are asserting.
    throttlerStorage.storage.clear();
  });

  /** Registers, confirms, logs in, and mints an upload ticket. */
  async function signInWithTicket(): Promise<{
    accessToken: string;
    ticket: string;
    userId: string;
  }> {
    const email = `tus_e2e_${++counter}_${Date.now()}@example.com`;
    const password = 'password123';
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
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const accessToken = (login.body as { access_token: string }).access_token;

    const ticketResponse = await request(app.getHttpServer())
      .post('/videos/upload-ticket')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const user = await userRepository.findOneByOrFail({ email });

    return {
      accessToken,
      ticket: (ticketResponse.body as { ticket: string }).ticket,
      userId: user.id,
    };
  }

  const createUpload = (
    ticket: string | undefined,
    {
      length = '1024',
      filename = 'clip.mp4',
      filetype = 'video/mp4',
    }: { length?: string; filename?: string; filetype?: string } = {},
  ) => {
    const req = request(app.getHttpServer())
      .post('/uploads')
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', length)
      .set('Upload-Metadata', tusMetadata({ filename, filetype }));

    return ticket ? req.set('Authorization', `Bearer ${ticket}`) : req;
  };

  describe('OPTIONS /uploads', () => {
    it('should advertise the tus version and extensions without a ticket', async () => {
      const response = await request(app.getHttpServer())
        .options('/uploads')
        .set('Tus-Resumable', '1.0.0');

      expect(response.status).toBe(204);
      expect(response.headers['tus-resumable']).toBe('1.0.0');
      expect(response.headers['tus-version']).toContain('1.0.0');
      expect(response.headers['tus-extension']).toContain('creation');
      expect(response.headers['tus-max-size']).toBe(String(TEN_GIB));
    });
  });

  describe('POST /uploads — authentication', () => {
    it('should create the upload and a draft video with a valid ticket', async () => {
      const { ticket, userId } = await signInWithTicket();

      const response = await createUpload(ticket, {
        filename: 'My Holiday.mp4',
      });

      expect(response.status).toBe(201);
      expect(response.headers.location).toMatch(
        /\/uploads\/[0-9a-f-]{36}\.mp4$/,
      );

      const uploadId = response.headers.location.split('/').pop() as string;
      const video = await videoRepository.findOneOrFail({
        where: { upload_id: uploadId },
        relations: { channel: true },
      });
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.channel.user_id).toBe(userId);
      expect(video.title).toBe('My Holiday');
      expect(video.storage_key).toBe(uploadId);
      const hoursOut =
        (video.upload_expires_at!.getTime() - Date.now()) / (60 * 60 * 1000);
      expect(hoursOut).toBeGreaterThan(23);
      expect(hoursOut).toBeLessThan(25);
    }, 30000);

    it('should reject a creation request with no ticket and create no video', async () => {
      const response = await createUpload(undefined);

      expect(response.status).toBe(401);
      expect(response.text).toContain('INVALID_UPLOAD_TICKET');
      expect(await videoRepository.count()).toBe(0);
    }, 30000);

    it('should reject a plain access token, which lacks the upload scope', async () => {
      const { accessToken } = await signInWithTicket();

      const response = await createUpload(accessToken);

      expect(response.status).toBe(401);
      expect(await videoRepository.count()).toBe(0);
    }, 30000);

    it('should reject a tampered ticket', async () => {
      const { ticket } = await signInWithTicket();

      const response = await createUpload(`${ticket.slice(0, -3)}xyz`);

      expect(response.status).toBe(401);
    }, 30000);
  });

  describe('POST /uploads — validation', () => {
    it('should reject an Upload-Length above UPLOAD_MAX_SIZE_BYTES', async () => {
      const { ticket } = await signInWithTicket();

      const response = await createUpload(ticket, {
        length: String(TEN_GIB + 1),
      });

      // Rejected before a single byte is transferred.
      expect(response.status).toBe(413);
      expect(await videoRepository.count()).toBe(0);
    }, 30000);

    it('should reject an AVI, which is outside the accepted containers', async () => {
      const { ticket } = await signInWithTicket();

      const response = await createUpload(ticket, {
        filename: 'clip.avi',
        filetype: 'video/x-msvideo',
      });

      expect(response.status).toBe(415);
      expect(response.text).toContain('UNSUPPORTED_MEDIA_TYPE');
      expect(await videoRepository.count()).toBe(0);
    }, 30000);

    it('should reject a second upload while one is in flight', async () => {
      const { ticket } = await signInWithTicket();
      await createUpload(ticket).expect(201);

      const response = await createUpload(ticket);

      expect(response.status).toBe(409);
      expect(response.text).toContain('UPLOAD_ALREADY_IN_PROGRESS');
    }, 30000);
  });

  describe('chunk lifecycle', () => {
    async function uploadFile(
      ticket: string,
      filePath: string,
      { chunkSize = 5 * 1024 * 1024 } = {},
    ): Promise<string> {
      const size = statSync(filePath).size;

      const uploadUrl = await new Promise<string>((resolve, reject) => {
        const upload = new tus.Upload(createReadStream(filePath), {
          endpoint: `${baseUrl}/uploads`,
          uploadSize: size,
          chunkSize,
          headers: { Authorization: `Bearer ${ticket}` },
          metadata: { filename: basename(filePath), filetype: 'video/mp4' },
          onError: reject,
          onSuccess: () => resolve(upload.url as string),
        });
        upload.start();
      });

      return uploadUrl.split('/').pop() as string;
    }

    it('should complete a full round-trip and land the video in processing with exactly one job', async () => {
      const { ticket } = await signInWithTicket();
      const fixture = await createTestVideo({ durationSeconds: 1 });

      const uploadId = await uploadFile(ticket, fixture);

      const video = await videoRepository.findOneOrFail({
        where: { upload_id: uploadId },
      });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(Number(video.size_bytes)).toBe(statSync(fixture).size);

      // The status change and the job commit together, never one without the
      // other.
      const jobs = await queueService.findJobs(QUEUE_NAMES.VIDEO_PROCESS, {
        data: { videoId: video.id },
      });
      expect(jobs).toHaveLength(1);
    }, 120000);

    it('should promote the video to uploading on the first chunk', async () => {
      const { ticket } = await signInWithTicket();
      const created = await createUpload(ticket, { length: '1024' }).expect(
        201,
      );
      const uploadPath = new URL(created.headers.location).pathname;

      await request(app.getHttpServer())
        .patch(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .set('Authorization', `Bearer ${ticket}`)
        .send(Buffer.alloc(512))
        .expect(204);

      const uploadId = uploadPath.split('/').pop() as string;
      expect(
        (
          await videoRepository.findOneOrFail({
            where: { upload_id: uploadId },
          })
        ).status,
      ).toBe(VideoStatus.UPLOADING);
    }, 60000);

    it('should not rewrite the status on subsequent chunks', async () => {
      const { ticket } = await signInWithTicket();
      // 2048 declared but only 1024 sent, so neither chunk completes the
      // upload — otherwise onUploadFinish would write the row and mask what
      // this test is about.
      const created = await createUpload(ticket, { length: '2048' }).expect(
        201,
      );
      const uploadPath = new URL(created.headers.location).pathname;
      const uploadId = uploadPath.split('/').pop() as string;

      const sendChunk = (offset: number) =>
        request(app.getHttpServer())
          .patch(uploadPath)
          .set('Tus-Resumable', '1.0.0')
          .set('Upload-Offset', String(offset))
          .set('Content-Type', 'application/offset+octet-stream')
          .set('Authorization', `Bearer ${ticket}`)
          .send(Buffer.alloc(512));

      await sendChunk(0).expect(204);
      const afterFirst = await videoRepository.findOneOrFail({
        where: { upload_id: uploadId },
      });

      await sendChunk(512).expect(204);
      const afterSecond = await videoRepository.findOneOrFail({
        where: { upload_id: uploadId },
      });

      // The guarded UPDATE only matches a `draft` row, so the second chunk
      // matches nothing and is not a write at all.
      expect(afterFirst.status).toBe(VideoStatus.UPLOADING);
      expect(afterSecond.status).toBe(VideoStatus.UPLOADING);
      expect(afterSecond.updated_at.getTime()).toBe(
        afterFirst.updated_at.getTime(),
      );
    }, 60000);

    it("should return 403 for a chunk carrying another user's ticket", async () => {
      const owner = await signInWithTicket();
      const created = await createUpload(owner.ticket, {
        length: '1024',
      }).expect(201);
      const uploadPath = new URL(created.headers.location).pathname;
      const stranger = await signInWithTicket();

      const response = await request(app.getHttpServer())
        .patch(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .set('Authorization', `Bearer ${stranger.ticket}`)
        .send(Buffer.alloc(512));

      expect(response.status).toBe(403);
      const uploadId = uploadPath.split('/').pop() as string;
      const video = await videoRepository.findOneOrFail({
        where: { upload_id: uploadId },
      });
      // Not advanced: still a draft.
      expect(video.status).toBe(VideoStatus.DRAFT);
    }, 60000);

    it('should resume from the stored offset without re-sending earlier bytes', async () => {
      const { ticket } = await signInWithTicket();
      const created = await createUpload(ticket, { length: '1024' }).expect(
        201,
      );
      const uploadPath = new URL(created.headers.location).pathname;

      await request(app.getHttpServer())
        .patch(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .set('Authorization', `Bearer ${ticket}`)
        .send(Buffer.alloc(512, 0x41))
        .expect(204);

      // Interruption: the client comes back and asks where it left off.
      const head = await request(app.getHttpServer())
        .head(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .set('Authorization', `Bearer ${ticket}`)
        .expect(200);
      expect(head.headers['upload-offset']).toBe('512');

      const resumed = await request(app.getHttpServer())
        .patch(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', head.headers['upload-offset'])
        .set('Content-Type', 'application/offset+octet-stream')
        .set('Authorization', `Bearer ${ticket}`)
        .send(Buffer.alloc(512, 0x42))
        .expect(204);

      expect(resumed.headers['upload-offset']).toBe('1024');
    }, 60000);
  });

  describe('body-parser ordering', () => {
    it('should still parse a JSON body on a Nest route', async () => {
      // The regression `bodyParser: false` could have caused: mounting tus
      // ahead of express.json() must not leave other routes unparsed.
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'password123' });

      // 401, not 400 — the body was read and the credentials were checked.
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: 'INVALID_CREDENTIALS' });
    });

    it('should still run the ValidationPipe on a Nest route', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'not-an-email', password: 'x' });

      expect(response.status).toBe(400);
    });

    it('should still serve a plain GET route', async () => {
      await request(app.getHttpServer()).get('/').expect(200);
    });
  });
});
