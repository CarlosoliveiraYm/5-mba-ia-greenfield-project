import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import {
  FfmpegCommandFailedException,
  ProbeFailedException,
} from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import { FfmpegService } from './ffmpeg.service';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require('node:child_process') as { spawn: jest.Mock };

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
}

/** A child process stub that emits the given output and then closes. */
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  return child;
}

function settle(
  child: FakeChild,
  { stdout = '', stderr = '', code = 0 } = {},
): void {
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
}

describe('FfmpegService', () => {
  let service: FfmpegService;

  beforeEach(async () => {
    spawn.mockReset();

    const module = await Test.createTestingModule({
      providers: [
        FfmpegService,
        { provide: uploadConfig.KEY, useValue: { ffmpegTimeoutSeconds: 30 } },
      ],
    }).compile();

    service = module.get(FfmpegService);
  });

  const lastCall = () =>
    spawn.mock.calls[spawn.mock.calls.length - 1] as [
      string,
      string[],
      { signal: AbortSignal },
    ];

  describe('argument safety', () => {
    it('should pass arguments as an array, never a shell string', async () => {
      const child = fakeChild();
      spawn.mockReturnValue(child);
      settle(child, {
        stdout: JSON.stringify({
          format: { duration: '3', format_name: 'mov,mp4', size: '100' },
          streams: [{ codec_type: 'video', codec_name: 'h264' }],
        }),
      });

      await service.probe('/tmp/clip.mp4');

      const [bin, args] = lastCall();
      expect(bin).toBe('ffprobe');
      expect(Array.isArray(args)).toBe(true);
      expect(args).toContain('/tmp/clip.mp4');
    });

    it('should keep a hostile filename as a single argv entry', async () => {
      const hostile = '/tmp/my clip; rm -rf $HOME.mp4';
      const child = fakeChild();
      spawn.mockReturnValue(child);
      settle(child);

      await service.remuxFaststart(hostile, '/tmp/out.mp4');

      const [bin, args] = lastCall();
      expect(bin).toBe('ffmpeg');
      // One entry, verbatim — never interpolated into a string a shell parses.
      expect(args.filter((a) => a === hostile)).toHaveLength(1);
      expect(args.some((a) => a.includes('rm -rf $HOME.mp4 '))).toBe(false);
    });

    it('should never enable a shell', async () => {
      const child = fakeChild();
      spawn.mockReturnValue(child);
      settle(child);

      await service.remuxFaststart('/tmp/in.mp4', '/tmp/out.mp4');

      const options = lastCall()[2] as { shell?: boolean };
      expect(options.shell).toBeUndefined();
    });
  });

  describe('failure handling', () => {
    it('should reject with the captured stderr on a non-zero exit', async () => {
      const child = fakeChild();
      spawn.mockReturnValue(child);
      settle(child, {
        stderr: 'Invalid data found when processing input',
        code: 1,
      });

      await expect(
        service.remuxFaststart('/tmp/in.mp4', '/tmp/out.mp4'),
      ).rejects.toThrow(FfmpegCommandFailedException);
    });

    it('should carry the exit code and stderr tail on the exception', async () => {
      const child = fakeChild();
      spawn.mockReturnValue(child);
      settle(child, { stderr: 'boom', code: 69 });

      await expect(
        service.remuxFaststart('/tmp/in.mp4', '/tmp/out.mp4'),
      ).rejects.toMatchObject({ exitCode: 69, stderrTail: 'boom' });
    });

    it('should reject with a timeout message once the signal aborts', async () => {
      jest.useFakeTimers();
      const child = fakeChild();
      spawn.mockImplementation(
        (_bin: string, _args: string[], options: { signal: AbortSignal }) => {
          options.signal.addEventListener('abort', () =>
            child.emit('error', new Error('The operation was aborted')),
          );
          return child;
        },
      );

      const promise = service.extractFrame('/tmp/in.mp4', '/tmp/o.webp', 1);
      const assertion = expect(promise).rejects.toMatchObject({
        stderrTail: expect.stringContaining('timed out after 30s') as string,
      });

      jest.advanceTimersByTime(30_000);
      await assertion;
      jest.useRealTimers();
    });
  });

  describe('probe', () => {
    const probeWith = (stdout: string) => {
      const child = fakeChild();
      spawn.mockReturnValue(child);
      settle(child, { stdout });
      return service.probe('/tmp/clip.mp4');
    };

    it('should map ffprobe JSON onto a typed result', async () => {
      const result = await probeWith(
        JSON.stringify({
          format: {
            duration: '3.005',
            format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
            size: '54321',
          },
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 320,
              height: 240,
            },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
        }),
      );

      expect(result).toEqual({
        durationSeconds: 3.005,
        width: 320,
        height: 240,
        videoCodec: 'h264',
        audioCodec: 'aac',
        containerFormats: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
        sizeBytes: 54321,
      });
    });

    it('should report a null audio codec when there is no audio stream', async () => {
      const result = await probeWith(
        JSON.stringify({
          format: { duration: '1', format_name: 'matroska,webm', size: '10' },
          streams: [{ codec_type: 'video', codec_name: 'vp9' }],
        }),
      );

      expect(result.audioCodec).toBeNull();
    });

    it('should reject with ProbeFailedException on malformed JSON', async () => {
      await expect(probeWith('not json at all')).rejects.toThrow(
        ProbeFailedException,
      );
    });

    it('should reject with ProbeFailedException when there is no video stream', async () => {
      await expect(
        probeWith(
          JSON.stringify({
            format: { duration: '1', format_name: 'mp3', size: '10' },
            streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
          }),
        ),
      ).rejects.toThrow(ProbeFailedException);
    });
  });

  describe('command shapes', () => {
    it('should seek before the input in extractFrame', async () => {
      const child = fakeChild();
      spawn.mockReturnValue(child);
      settle(child);

      await service.extractFrame('/tmp/in.mp4', '/tmp/out.webp', 0.3);

      const args = lastCall()[1];
      // Input-side seeking: `-ss` must come before `-i`, else FFmpeg decodes
      // forward from the start and the cost scales with the file.
      expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
      expect(args).toEqual(expect.arrayContaining(['-c:v', 'libwebp']));
    });

    it('should stream-copy in remuxFaststart', async () => {
      const child = fakeChild();
      spawn.mockReturnValue(child);
      settle(child);

      await service.remuxFaststart('/tmp/in.mp4', '/tmp/out.mp4');

      expect(lastCall()[1]).toEqual(
        expect.arrayContaining(['-c', 'copy', '-movflags', '+faststart']),
      );
    });
  });
});
