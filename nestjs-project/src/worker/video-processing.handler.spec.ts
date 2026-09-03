import { existsSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import uploadConfig from '../config/upload.config';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import type { ProbeResult } from '../ffmpeg/ffmpeg.types';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoFailureReason } from '../videos/video-failure-reason.enum';
import { VideoStatus } from '../videos/video-status.enum';
import { VideoProcessingHandler } from './video-processing.handler';

const VIDEO_ID = '11111111-2222-3333-4444-555555555555';
const STORAGE_KEY = 'abc-123.mp4';

const UPLOAD_CONFIG = {
  acceptedContainers: ['mp4', 'mov', 'webm', 'mkv'],
  acceptedVideoCodecs: ['h264', 'vp9', 'av1'],
  thumbnailOffsetPercent: 10,
};
const QUEUE_CONFIG = { workerScratchDir: '/tmp/streamtube-test' };

const probeResult = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  durationSeconds: 3,
  width: 320,
  height: 240,
  videoCodec: 'h264',
  audioCodec: 'aac',
  containerFormats: ['mov', 'mp4', 'm4a'],
  sizeBytes: 54321,
  ...overrides,
});

/** An MP4 head whose first top-level box after `ftyp` is the given type. */
function mp4Head(first: 'moov' | 'mdat'): Buffer {
  const box = (type: string, payload = 16) => {
    const buffer = Buffer.alloc(8 + payload);
    buffer.writeUInt32BE(8 + payload, 0);
    buffer.write(type, 4, 4, 'ascii');
    return buffer;
  };
  return Buffer.concat([box('ftyp'), box(first, 64)]);
}

describe('VideoProcessingHandler', () => {
  let handler: VideoProcessingHandler;
  let videoRepository: { findOne: jest.Mock; update: jest.Mock };
  let storageService: {
    getInternalPresignedUrl: jest.Mock;
    getObjectStream: jest.Mock;
    putObject: jest.Mock;
    copyObject: jest.Mock;
    deleteObject: jest.Mock;
  };
  let ffmpegService: {
    probe: jest.Mock;
    extractFrame: jest.Mock;
    remuxFaststart: jest.Mock;
  };

  beforeEach(async () => {
    videoRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: VIDEO_ID, storage_key: STORAGE_KEY }),
      update: jest.fn(),
    };
    storageService = {
      getInternalPresignedUrl: jest
        .fn()
        .mockResolvedValue('http://minio:9000/signed'),
      getObjectStream: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(Readable.from([mp4Head('moov')])),
        ),
      putObject: jest.fn(),
      copyObject: jest.fn(),
      deleteObject: jest.fn(),
    };
    // The stubs write their output file, because the real commands do and the
    // handler reads it back to size the upload.
    const writesItsOutput = (outputArgIndex: number) =>
      jest.fn((...args: string[]) => {
        writeFileSync(args[outputArgIndex], 'stub output');
        return Promise.resolve();
      });

    ffmpegService = {
      probe: jest.fn().mockResolvedValue(probeResult()),
      extractFrame: writesItsOutput(1),
      remuxFaststart: writesItsOutput(1),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingHandler,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: FfmpegService, useValue: ffmpegService },
        { provide: uploadConfig.KEY, useValue: UPLOAD_CONFIG },
        { provide: queueConfig.KEY, useValue: QUEUE_CONFIG },
      ],
    }).compile();

    handler = module.get(VideoProcessingHandler);
  });

  /** The status/failure_reason written by the last `update` that set one. */
  const lastStatusWrite = () => {
    const calls = videoRepository.update.mock.calls as [
      unknown,
      { status?: VideoStatus; failure_reason?: VideoFailureReason },
    ][];
    return [...calls].reverse().find(([, patch]) => patch.status)?.[1];
  };

  describe('validation against the probe result', () => {
    it('should fail with UNSUPPORTED_CONTAINER for a container outside the list', async () => {
      ffmpegService.probe.mockResolvedValue(
        probeResult({ containerFormats: ['avi'] }),
      );

      await handler.process({ videoId: VIDEO_ID });

      expect(lastStatusWrite()).toEqual({
        status: VideoStatus.FAILED,
        failure_reason: VideoFailureReason.UNSUPPORTED_CONTAINER,
      });
    });

    it('should fail with UNSUPPORTED_VIDEO_CODEC for a codec outside the list', async () => {
      ffmpegService.probe.mockResolvedValue(
        probeResult({ videoCodec: 'mpeg4' }),
      );

      await handler.process({ videoId: VIDEO_ID });

      expect(lastStatusWrite()).toEqual({
        status: VideoStatus.FAILED,
        failure_reason: VideoFailureReason.UNSUPPORTED_VIDEO_CODEC,
      });
      expect(ffmpegService.extractFrame).not.toHaveBeenCalled();
    });

    it('should fail with NO_VIDEO_STREAM when ffprobe reports no video stream', async () => {
      ffmpegService.probe.mockRejectedValue(
        new Error('Could not probe the media file: no video stream found'),
      );

      await handler.process({ videoId: VIDEO_ID });

      expect(lastStatusWrite()).toEqual({
        status: VideoStatus.FAILED,
        failure_reason: VideoFailureReason.NO_VIDEO_STREAM,
      });
    });

    it('should fail with PROBE_FAILED on any other ffprobe rejection', async () => {
      ffmpegService.probe.mockRejectedValue(
        new Error('ffprobe returned unparsable JSON'),
      );

      await handler.process({ videoId: VIDEO_ID });

      expect(lastStatusWrite()).toEqual({
        status: VideoStatus.FAILED,
        failure_reason: VideoFailureReason.PROBE_FAILED,
      });
    });

    it('should accept an MKV, which ffprobe reports as matroska', async () => {
      ffmpegService.probe.mockResolvedValue(
        probeResult({ containerFormats: ['matroska', 'webm'] }),
      );

      await handler.process({ videoId: VIDEO_ID });

      expect(lastStatusWrite()).toEqual({
        status: VideoStatus.READY,
        failure_reason: null,
      });
    });
  });

  describe('metadata persistence', () => {
    it('should persist the probe output onto the row', async () => {
      await handler.process({ videoId: VIDEO_ID });

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        expect.objectContaining({
          duration_seconds: '3.000',
          width: 320,
          height: 240,
          video_codec: 'h264',
          audio_codec: 'aac',
          size_bytes: '54321',
          mime_type: 'video/mp4',
        }),
      );
    });

    it('should read the source through the internal endpoint, never the public one', async () => {
      await handler.process({ videoId: VIDEO_ID });

      // A URL signed for S3_PUBLIC_ENDPOINT carries localhost:9000 in its signed
      // Host, which inside the worker container points at the worker itself.
      expect(storageService.getInternalPresignedUrl).toHaveBeenCalledWith(
        STORAGE_KEY,
      );
      expect(ffmpegService.probe).toHaveBeenCalledWith(
        'http://minio:9000/signed',
      );
    });
  });

  describe('conditional faststart remux', () => {
    it('should skip the remux entirely when the layout is already faststart', async () => {
      storageService.getObjectStream.mockResolvedValue(
        Readable.from([mp4Head('moov')]),
      );

      await handler.process({ videoId: VIDEO_ID });

      expect(ffmpegService.remuxFaststart).not.toHaveBeenCalled();
      expect(storageService.copyObject).not.toHaveBeenCalled();
    });

    it('should skip the remux for a container with no moov atom', async () => {
      ffmpegService.probe.mockResolvedValue(
        probeResult({ containerFormats: ['matroska', 'webm'] }),
      );

      await handler.process({ videoId: VIDEO_ID });

      expect(ffmpegService.remuxFaststart).not.toHaveBeenCalled();
    });

    it('should promote the remuxed object onto the original key and clean up', async () => {
      storageService.getObjectStream.mockImplementation(
        (_key, range?: string) =>
          Promise.resolve(
            range
              ? Readable.from([mp4Head('mdat')])
              : Readable.from([Buffer.from('the whole file')]),
          ),
      );

      await handler.process({ videoId: VIDEO_ID });

      expect(ffmpegService.remuxFaststart).toHaveBeenCalled();
      expect(storageService.copyObject).toHaveBeenCalledWith(
        `${STORAGE_KEY}.faststart`,
        STORAGE_KEY,
      );
      // The temporary key goes; the adjacent `.info` metadata object is never
      // touched.
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        `${STORAGE_KEY}.faststart`,
      );
      expect(storageService.deleteObject).not.toHaveBeenCalledWith(
        `${STORAGE_KEY}.info`,
      );
    });

    it('should still remove the scratch directory when the remux throws', async () => {
      storageService.getObjectStream.mockImplementation(
        (_key, range?: string) =>
          Promise.resolve(
            range
              ? Readable.from([mp4Head('mdat')])
              : Readable.from([Buffer.from('the whole file')]),
          ),
      );
      ffmpegService.remuxFaststart.mockRejectedValue(
        new Error('remux blew up'),
      );

      await handler.process(
        { videoId: VIDEO_ID },
        { attempt: 0, maxAttempts: 0 },
      );

      expect(existsSync(`${QUEUE_CONFIG.workerScratchDir}/${VIDEO_ID}`)).toBe(
        false,
      );
    });
  });

  describe('thumbnail', () => {
    it('should extract the frame at the configured percentage of the duration', async () => {
      ffmpegService.probe.mockResolvedValue(
        probeResult({ durationSeconds: 20 }),
      );

      await handler.process({ videoId: VIDEO_ID });

      // 10% of 20s.
      expect(ffmpegService.extractFrame).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('auto.webp'),
        2,
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        { thumbnail_key: `thumbnails/${VIDEO_ID}/auto.webp` },
      );
    });
  });

  describe('retries', () => {
    it('should rethrow an unexpected failure while retries remain', async () => {
      ffmpegService.extractFrame.mockRejectedValue(new Error('transient'));

      await expect(
        handler.process({ videoId: VIDEO_ID }, { attempt: 0, maxAttempts: 3 }),
      ).rejects.toThrow('transient');
      expect(lastStatusWrite()).toBeUndefined();
    });

    it('should write PROCESSING_FAILED on the final attempt', async () => {
      ffmpegService.extractFrame.mockRejectedValue(new Error('still broken'));

      await handler.process(
        { videoId: VIDEO_ID },
        { attempt: 3, maxAttempts: 3 },
      );

      expect(lastStatusWrite()).toEqual({
        status: VideoStatus.FAILED,
        failure_reason: VideoFailureReason.PROCESSING_FAILED,
      });
    });
  });

  describe('missing input', () => {
    it('should do nothing when the video row is gone', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await handler.process({ videoId: VIDEO_ID });

      expect(ffmpegService.probe).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should do nothing when the row has no storage key', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: VIDEO_ID,
        storage_key: null,
      });

      await handler.process({ videoId: VIDEO_ID });

      expect(ffmpegService.probe).not.toHaveBeenCalled();
    });
  });
});
