import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StorageService } from '../storage/storage.service';
import { TUS_STORE } from '../uploads/uploads.constants';
import { Video } from '../videos/entities/video.entity';
import { VideoFailureReason } from '../videos/video-failure-reason.enum';
import { VideoStatus } from '../videos/video-status.enum';
import { UploadSweepHandler } from './upload-sweep.handler';

describe('UploadSweepHandler', () => {
  let handler: UploadSweepHandler;
  let videoRepository: { find: jest.Mock; update: jest.Mock };
  let store: { deleteExpired: jest.Mock };
  let storageService: { deleteObject: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    };
    store = { deleteExpired: jest.fn().mockResolvedValue(0) };
    storageService = { deleteObject: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        UploadSweepHandler,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: TUS_STORE, useValue: store },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    handler = module.get(UploadSweepHandler);
  });

  describe('store.deleteExpired', () => {
    it('should swallow a 501 from a store without the expiration extension', async () => {
      store.deleteExpired.mockRejectedValue({ status_code: 501 });

      await expect(handler.process()).resolves.toBeUndefined();
      // The rest of the sweep still ran.
      expect(videoRepository.find).toHaveBeenCalled();
    });

    it('should swallow a 501 reported as an S3 $metadata status', async () => {
      store.deleteExpired.mockRejectedValue({
        $metadata: { httpStatusCode: 501 },
      });

      await expect(handler.process()).resolves.toBeUndefined();
    });

    it('should propagate any other store error', async () => {
      store.deleteExpired.mockRejectedValue(new Error('storage unreachable'));

      await expect(handler.process()).rejects.toThrow('storage unreachable');
      // Nothing was swept on a broken store.
      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('stale draft selection', () => {
    it('should select only in-flight rows past their deadline', async () => {
      await handler.process();

      const criteria = (
        videoRepository.find.mock.calls as [
          { where: { status: unknown; upload_expires_at: unknown } },
        ][]
      )[0][0];
      expect(criteria.where.status).toBeDefined();
      expect(criteria.where.upload_expires_at).toBeDefined();
    });

    it('should write UPLOAD_ABANDONED on every row it transitions', async () => {
      videoRepository.find.mockResolvedValue([
        { id: 'v1', storage_key: 'a.mp4' },
        { id: 'v2', storage_key: 'b.mp4' },
      ]);

      await handler.process();

      expect(videoRepository.update).toHaveBeenCalledWith(expect.anything(), {
        status: VideoStatus.FAILED,
        failure_reason: VideoFailureReason.UPLOAD_ABANDONED,
      });
    });

    it('should write nothing when no row is stale', async () => {
      videoRepository.find.mockResolvedValue([]);

      await handler.process();

      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(storageService.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('storage reclamation', () => {
    it('should delete both the object and the store metadata object', async () => {
      videoRepository.find.mockResolvedValue([
        { id: 'v1', storage_key: 'abc.mp4' },
      ]);

      await handler.process();

      expect(storageService.deleteObject).toHaveBeenCalledWith('abc.mp4');
      // S3Store#infoKey — `${id}.info`, confirmed against the installed version.
      expect(storageService.deleteObject).toHaveBeenCalledWith('abc.mp4.info');
    });

    it('should skip a row with no storage key', async () => {
      videoRepository.find.mockResolvedValue([{ id: 'v1', storage_key: null }]);

      await handler.process();

      expect(storageService.deleteObject).not.toHaveBeenCalled();
    });

    it('should keep sweeping when one object cannot be deleted', async () => {
      videoRepository.find.mockResolvedValue([
        { id: 'v1', storage_key: 'a.mp4' },
        { id: 'v2', storage_key: 'b.mp4' },
      ]);
      storageService.deleteObject.mockRejectedValueOnce(new Error('gone'));

      await expect(handler.process()).resolves.toBeUndefined();
      expect(storageService.deleteObject).toHaveBeenCalledWith('b.mp4');
    });
  });
});
