import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  cleanupTestVideos,
  createTestVideo,
  createTrailingMoovVideo,
  createUnsupportedCodecVideo,
} from './video-fixtures';

interface ProbedStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
}

interface Probed {
  format: { duration: string; format_name: string };
  streams: ProbedStream[];
}

function ffprobe(path: string): Promise<Probed> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      path,
    ]);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(JSON.parse(stdout) as Probed)
        : reject(new Error(`ffprobe exited ${code}`)),
    );
  });
}

/** Whether the file's first top-level box of interest is `moov` or `mdat`. */
function firstTopLevelBox(path: string): 'moov' | 'mdat' | 'none' {
  const head = readFileSync(path);
  let offset = 0;

  while (offset + 8 <= head.length) {
    const size = head.readUInt32BE(offset);
    const type = head.toString('ascii', offset + 4, offset + 8);
    if (type === 'moov') return 'moov';
    if (type === 'mdat') return 'mdat';
    if (size < 8) return 'none';
    offset += size;
  }

  return 'none';
}

describe('video fixtures (integration)', () => {
  afterAll(() => {
    cleanupTestVideos();
  });

  describe('createTestVideo', () => {
    it('should produce a playable file matching the requested duration and size', async () => {
      const path = await createTestVideo({
        durationSeconds: 3,
        width: 320,
        height: 240,
      });

      const probed = await ffprobe(path);
      const video = probed.streams.find((s) => s.codec_type === 'video');
      const audio = probed.streams.find((s) => s.codec_type === 'audio');

      expect(Number(probed.format.duration)).toBeCloseTo(3, 0);
      expect(video?.codec_name).toBe('h264');
      expect(video?.width).toBe(320);
      expect(video?.height).toBe(240);
      expect(audio?.codec_name).toBe('aac');
    }, 60000);

    it('should honour non-default dimensions', async () => {
      const path = await createTestVideo({
        durationSeconds: 1,
        width: 160,
        height: 120,
      });

      const video = (await ffprobe(path)).streams.find(
        (s) => s.codec_type === 'video',
      );

      expect(video?.width).toBe(160);
      expect(video?.height).toBe(120);
    }, 60000);

    it('should return the same memoized path for identical options', async () => {
      const first = await createTestVideo({ durationSeconds: 2 });
      const second = await createTestVideo({ durationSeconds: 2 });

      expect(second).toBe(first);
    }, 60000);

    it('should return different paths for different options', async () => {
      const three = await createTestVideo({ durationSeconds: 3 });
      const one = await createTestVideo({ durationSeconds: 1 });

      expect(one).not.toBe(three);
    }, 60000);
  });

  describe('createTrailingMoovVideo', () => {
    it('should place the moov atom after mdat', async () => {
      const path = await createTrailingMoovVideo();

      expect(firstTopLevelBox(path)).toBe('mdat');
    }, 60000);

    it('should still be a valid h264 clip', async () => {
      const probed = await ffprobe(await createTrailingMoovVideo());

      expect(
        probed.streams.find((s) => s.codec_type === 'video')?.codec_name,
      ).toBe('h264');
    }, 60000);
  });

  describe('createTestVideo faststart layout', () => {
    it('should place the moov atom before mdat', async () => {
      const path = await createTestVideo();

      expect(firstTopLevelBox(path)).toBe('moov');
    }, 60000);
  });

  describe('createUnsupportedCodecVideo', () => {
    it('should report mpeg4 as its video codec', async () => {
      const probed = await ffprobe(await createUnsupportedCodecVideo());

      expect(
        probed.streams.find((s) => s.codec_type === 'video')?.codec_name,
      ).toBe('mpeg4');
    }, 60000);
  });

  describe('cleanupTestVideos', () => {
    it('should remove every generated file', async () => {
      const path = await createTestVideo({
        durationSeconds: 1,
        width: 64,
        height: 64,
      });
      expect(existsSync(path)).toBe(true);

      cleanupTestVideos();

      expect(existsSync(path)).toBe(false);
    }, 60000);
  });
});
