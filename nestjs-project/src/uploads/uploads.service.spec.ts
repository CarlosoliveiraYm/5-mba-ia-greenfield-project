import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidUploadTicketException,
  UploadAlreadyInProgressException,
} from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import { QueueService } from '../queue/queue.service';
import { Video } from '../videos/entities/video.entity';
import { UploadTicketService } from '../videos/upload-ticket.service';
import { VideoStatus } from '../videos/video-status.enum';
import { VideosService } from '../videos/videos.service';
import { TusError, UploadsService, titleFromFilename } from './uploads.service';

const CONFIG = {
  maxSizeBytes: 10_737_418_240,
  acceptedContainers: ['mp4', 'mov', 'webm', 'mkv'],
  abandonedExpirationHours: 24,
};

/** A minimal web Request, which is what @tus/server@2 hands its hooks. */
function tusRequest(
  {
    authorization,
    method = 'POST',
  }: { authorization?: string; method?: string } = {
    authorization: 'Bearer valid-ticket',
  },
): Request {
  return new Request('http://localhost:3000/uploads', {
    method,
    headers: authorization ? { authorization } : {},
  });
}

describe('UploadsService', () => {
  let service: UploadsService;
  let uploadTicketService: { verify: jest.Mock; extractBearer: jest.Mock };
  let videosService: { assertNoUploadInFlight: jest.Mock };
  let videoRepository: {
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let channelRepository: { findOneOrFail: jest.Mock };
  let queueService: { send: jest.Mock; ensureQueue: jest.Mock };
  let manager: {
    findOneOrFail: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  const capture = async (
    operation: () => Promise<unknown>,
  ): Promise<TusError> => {
    try {
      await operation();
    } catch (error) {
      return error as TusError;
    }
    throw new Error('expected the hook to reject');
  };

  /** The first argument of the nth call to a jest mock, typed. */
  const firstArgOf = <T>(mock: jest.Mock, call = 0): T =>
    (mock.mock.calls as unknown[][])[call][0] as T;

  beforeEach(async () => {
    uploadTicketService = {
      verify: jest.fn().mockReturnValue({ sub: 'user-1' }),
      extractBearer: jest.fn(
        (header?: string) => header?.split(' ')[1] ?? null,
      ),
    };
    videosService = { assertNoUploadInFlight: jest.fn() };
    videoRepository = {
      save: jest.fn((v: unknown) => Promise.resolve(v)),
      create: jest.fn((v: unknown) => v),
      findOne: jest.fn(),
      update: jest.fn(),
    };
    channelRepository = {
      findOneOrFail: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };
    queueService = { send: jest.fn(), ensureQueue: jest.fn() };
    manager = {
      findOneOrFail: jest.fn().mockResolvedValue({ id: 'video-1' }),
      update: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };

    const module = await Test.createTestingModule({
      providers: [
        UploadsService,
        { provide: UploadTicketService, useValue: uploadTicketService },
        { provide: VideosService, useValue: videosService },
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: getRepositoryToken(Channel), useValue: channelRepository },
        { provide: QueueService, useValue: queueService },
        { provide: DataSource, useValue: dataSource },
        { provide: uploadConfig.KEY, useValue: CONFIG },
      ],
    }).compile();

    service = module.get(UploadsService);
  });

  const upload = (overrides: Record<string, unknown> = {}) => ({
    id: 'abc-123.mp4',
    size: 1024,
    metadata: { filename: 'holiday.mp4', filetype: 'video/mp4' },
    ...overrides,
  });

  describe('handleUploadCreate — authentication', () => {
    it('should reject a request with no Authorization header', async () => {
      uploadTicketService.verify.mockImplementation(() => {
        throw new InvalidUploadTicketException();
      });

      const error = await capture(() =>
        service.runHook(() =>
          service.handleUploadCreate(
            tusRequest({ authorization: undefined }),
            upload(),
          ),
        ),
      );

      expect(error.status_code).toBe(401);
      expect(error.body).toContain('INVALID_UPLOAD_TICKET');
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('should reject an expired or wrong-scope ticket with 401', async () => {
      uploadTicketService.verify.mockImplementation(() => {
        throw new InvalidUploadTicketException();
      });

      const error = await capture(() =>
        service.runHook(() =>
          service.handleUploadCreate(tusRequest(), upload()),
        ),
      );

      expect(error.status_code).toBe(401);
      expect(videoRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('handleUploadCreate — validation', () => {
    it('should reject a declared size above the maximum with 413', async () => {
      const error = await capture(() =>
        service.runHook(() =>
          service.handleUploadCreate(
            tusRequest(),
            upload({ size: CONFIG.maxSizeBytes + 1 }),
          ),
        ),
      );

      expect(error.status_code).toBe(413);
      expect(error.body).toContain('UPLOAD_TOO_LARGE');
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('should reject an unaccepted container with 415', async () => {
      const error = await capture(() =>
        service.runHook(() =>
          service.handleUploadCreate(
            tusRequest(),
            upload({
              metadata: { filename: 'clip.avi', filetype: 'video/x-msvideo' },
            }),
          ),
        ),
      );

      expect(error.status_code).toBe(415);
      expect(error.body).toContain('UNSUPPORTED_MEDIA_TYPE');
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it.each(['mp4', 'mov', 'webm', 'mkv'])(
      'should accept the %s container',
      async (extension) => {
        await service.handleUploadCreate(
          tusRequest(),
          upload({
            id: `abc.${extension}`,
            metadata: { filename: `clip.${extension}`, filetype: 'video/x' },
          }),
        );

        expect(videoRepository.save).toHaveBeenCalled();
      },
    );

    it('should propagate the one-in-flight rule as 409', async () => {
      videosService.assertNoUploadInFlight.mockRejectedValue(
        new UploadAlreadyInProgressException(),
      );

      const error = await capture(() =>
        service.runHook(() =>
          service.handleUploadCreate(tusRequest(), upload()),
        ),
      );

      expect(error.status_code).toBe(409);
      expect(error.body).toContain('UPLOAD_ALREADY_IN_PROGRESS');
    });
  });

  describe('handleUploadCreate — persistence', () => {
    it('should pre-register a draft bound to the caller channel', async () => {
      await service.handleUploadCreate(tusRequest(), upload());

      const saved = firstArgOf<Record<string, unknown>>(videoRepository.create);
      expect(saved).toMatchObject({
        channel_id: 'channel-1',
        status: VideoStatus.DRAFT,
        upload_id: 'abc-123.mp4',
        // The tus upload id **is** the S3 key.
        storage_key: 'abc-123.mp4',
        original_filename: 'holiday.mp4',
        mime_type: 'video/mp4',
        size_bytes: '1024',
      });
    });

    it('should set upload_expires_at 24 hours out', async () => {
      const before = Date.now();

      await service.handleUploadCreate(tusRequest(), upload());

      const saved = firstArgOf<{ upload_expires_at: Date }>(
        videoRepository.create,
      );
      const hours =
        (saved.upload_expires_at.getTime() - before) / (60 * 60 * 1000);
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThan(24.1);
    });

    it('should derive the title from the filename', async () => {
      await service.handleUploadCreate(
        tusRequest(),
        upload({
          metadata: { filename: 'My Holiday 2026.mp4', filetype: 'video/mp4' },
        }),
      );

      const saved = firstArgOf<{ title: string }>(videoRepository.create);
      expect(saved.title).toBe('My Holiday 2026');
    });
  });

  describe('handleIncomingRequest', () => {
    it('should reject a ticket whose subject does not own the upload', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        channel: { user_id: 'someone-else' },
      });

      const error = await capture(() =>
        service.runHook(() =>
          service.handleIncomingRequest(tusRequest(), 'abc-123.mp4'),
        ),
      );

      expect(error.status_code).toBe(403);
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should promote the row to uploading on a PATCH, guarded on draft', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        channel: { user_id: 'user-1' },
      });

      await service.handleIncomingRequest(
        tusRequest({ authorization: 'Bearer t', method: 'PATCH' }),
        'abc-123.mp4',
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { upload_id: 'abc-123.mp4', status: VideoStatus.DRAFT },
        { status: VideoStatus.UPLOADING },
      );
    });

    it('should not write the status on a non-PATCH request', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        channel: { user_id: 'user-1' },
      });

      await service.handleIncomingRequest(
        tusRequest({ authorization: 'Bearer t', method: 'HEAD' }),
        'abc-123.mp4',
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should tolerate a creation request whose row does not exist yet', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.handleIncomingRequest(tusRequest(), 'brand-new.mp4'),
      ).resolves.toBeUndefined();
    });

    it('should still require a valid ticket', async () => {
      uploadTicketService.verify.mockImplementation(() => {
        throw new InvalidUploadTicketException();
      });

      const error = await capture(() =>
        service.runHook(() =>
          service.handleIncomingRequest(tusRequest(), 'abc-123.mp4'),
        ),
      );

      expect(error.status_code).toBe(401);
    });
  });

  describe('handleUploadFinish', () => {
    it('should update the status and enqueue inside one transaction', async () => {
      await service.handleUploadFinish(tusRequest(), {
        id: 'abc-123.mp4',
        size: 2048,
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledWith(
        Video,
        { id: 'video-1' },
        { status: VideoStatus.PROCESSING, size_bytes: '2048' },
      );
      // The enqueue rides the same transaction, via the pg-boss Db adapter.
      expect(queueService.send).toHaveBeenCalledWith(
        'video.process',
        { videoId: 'video-1' },
        expect.objectContaining({ db: expect.anything() as unknown }),
      );
    });

    it('should propagate a failed enqueue so the transaction rolls back', async () => {
      queueService.send.mockRejectedValue(new Error('queue is down'));

      await expect(
        service.handleUploadFinish(tusRequest(), { id: 'abc-123.mp4' }),
      ).rejects.toThrow('queue is down');
    });
  });

  describe('runHook', () => {
    it('should map an unexpected error to a 500 tus error', async () => {
      const error = await capture(() =>
        service.runHook(() => Promise.reject(new Error('boom'))),
      );

      expect(error.status_code).toBe(500);
      expect(error.body).toContain('UPLOAD_FAILED');
    });

    it('should pass an already-tus-shaped error through untouched', async () => {
      const original = new TusError(418, 'teapot\n');

      const error = await capture(() =>
        service.runHook(() => Promise.reject(original)),
      );

      expect(error).toBe(original);
    });
  });
});

describe('titleFromFilename', () => {
  it('should drop the extension and any directory component', () => {
    expect(titleFromFilename('/tmp/videos/My Holiday.mp4')).toBe('My Holiday');
  });

  it('should trim to 100 characters', () => {
    const title = titleFromFilename(`${'a'.repeat(150)}.mp4`);

    expect(title).toHaveLength(100);
  });

  it('should fall back to "Untitled video" for an empty or extension-only name', () => {
    expect(titleFromFilename('')).toBe('Untitled video');
    expect(titleFromFilename('.mp4')).toBe('Untitled video');
    expect(titleFromFilename('   ')).toBe('Untitled video');
  });
});
