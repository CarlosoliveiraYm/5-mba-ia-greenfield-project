import { spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ProbeFailedException } from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import {
  cleanupTestVideos,
  createTestVideo,
  createTrailingMoovVideo,
  createUnsupportedCodecVideo,
} from '../test/video-fixtures';
import { FfmpegModule } from './ffmpeg.module';
import { FfmpegService } from './ffmpeg.service';
import { hasFaststartLayout } from './moov.util';

describe('FfmpegService (integration)', () => {
  let service: FfmpegService;
  let scratch: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [uploadConfig] }),
        FfmpegModule,
      ],
    }).compile();

    service = module.get(FfmpegService);
    scratch = mkdtempSync(join(tmpdir(), 'ffmpeg-integration-'));
  }, 60000);

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    cleanupTestVideos();
  });

  describe('probe', () => {
    it('should report the exact duration, dimensions and codecs of a fixture', async () => {
      const input = await createTestVideo({
        durationSeconds: 3,
        width: 320,
        height: 240,
      });

      const result = await service.probe(input);

      expect(result.durationSeconds).toBeCloseTo(3, 0);
      expect(result.width).toBe(320);
      expect(result.height).toBe(240);
      expect(result.videoCodec).toBe('h264');
      expect(result.audioCodec).toBe('aac');
      expect(result.containerFormats).toContain('mp4');
      expect(result.sizeBytes).toBe(statSync(input).size);
    }, 60000);

    it('should report mpeg4 for the unsupported-codec fixture', async () => {
      const result = await service.probe(await createUnsupportedCodecVideo());

      expect(result.videoCodec).toBe('mpeg4');
    }, 60000);

    it('should reject a file with no video stream', async () => {
      const audioOnly = join(scratch, 'audio-only.m4a');
      await extractAudioOnly(
        await createTestVideo({ durationSeconds: 1 }),
        audioOnly,
      );

      await expect(service.probe(audioOnly)).rejects.toThrow(
        ProbeFailedException,
      );
    }, 60000);

    it('should reject a file that is not media at all', async () => {
      const notMedia = join(scratch, 'not-media.mp4');
      writeFileSync(notMedia, 'definitely not a video');

      await expect(service.probe(notMedia)).rejects.toThrow();
    }, 60000);
  });

  describe('extractFrame', () => {
    it('should write a single-frame WebP at 10% of the duration', async () => {
      const input = await createTestVideo({
        durationSeconds: 3,
        width: 320,
        height: 240,
      });
      const output = join(scratch, 'thumb.webp');

      await service.extractFrame(input, output, 0.3);

      const probed = await service.probe(output);
      expect(probed.videoCodec).toBe('webp');
      expect(probed.width).toBe(320);
      expect(probed.height).toBe(240);
      expect(statSync(output).size).toBeGreaterThan(0);
    }, 60000);
  });

  describe('remuxFaststart', () => {
    it('should move moov ahead of mdat without touching the streams', async () => {
      const input = await createTrailingMoovVideo({
        durationSeconds: 3,
        width: 320,
        height: 240,
      });
      const before = await service.probe(input);
      expect(hasFaststartLayout(readFileSync(input))).toBe(false);
      const output = join(scratch, 'faststart.mp4');

      await service.remuxFaststart(input, output);

      expect(hasFaststartLayout(readFileSync(output))).toBe(true);
      const after = await service.probe(output);
      expect(after.videoCodec).toBe(before.videoCodec);
      expect(after.audioCodec).toBe(before.audioCodec);
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);
      expect(after.durationSeconds).toBeCloseTo(before.durationSeconds, 1);
    }, 60000);
  });

  describe('hostile filenames', () => {
    it('should process a path containing spaces and a semicolon', async () => {
      const source = await createTestVideo({ durationSeconds: 1 });
      const hostile = join(scratch, 'my clip; echo pwned.mp4');
      copyFileSync(source, hostile);

      const result = await service.probe(hostile);

      expect(result.videoCodec).toBe('h264');
    }, 60000);
  });
});

/** Strips the video stream, producing a file `probe` must reject. */
function extractAudioOnly(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-i',
      input,
      '-vn',
      '-c:a',
      'copy',
      '-y',
      output,
    ]);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
    );
  });
}
