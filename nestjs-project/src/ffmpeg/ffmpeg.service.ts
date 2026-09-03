import { spawn } from 'node:child_process';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  FfmpegCommandFailedException,
  ProbeFailedException,
} from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import type { FfprobeOutput, ProbeResult } from './ffmpeg.types';

const STDERR_TAIL_LENGTH = 2000;

/**
 * The worker's three FFmpeg operations, and nothing else.
 *
 * Arguments are always an array handed straight to `spawn` — never a shell
 * string — so a filename containing `;`, spaces or quotes is one argv entry and
 * cannot become a second command.
 */
@Injectable()
export class FfmpegService {
  constructor(
    @Inject(uploadConfig.KEY)
    private readonly config: ConfigType<typeof uploadConfig>,
  ) {}

  /** Metadata for an input, which may be a local path or an HTTP(S) URL. */
  async probe(input: string): Promise<ProbeResult> {
    const { stdout } = await this.run('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      input,
    ]);

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch {
      throw new ProbeFailedException('ffprobe returned unparsable JSON');
    }

    const video = parsed.streams?.find((s) => s.codec_type === 'video');
    if (!video?.codec_name) {
      throw new ProbeFailedException('no video stream found');
    }

    const audio = parsed.streams?.find((s) => s.codec_type === 'audio');
    const duration = parsed.format?.duration ?? video.duration;

    return {
      durationSeconds: duration ? Number(duration) : 0,
      width: video.width ?? 0,
      height: video.height ?? 0,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name ?? null,
      containerFormats: (parsed.format?.format_name ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
      sizeBytes: parsed.format?.size ? Number(parsed.format.size) : 0,
    };
  }

  /**
   * A single frame as WebP. The `-ss` goes *before* `-i` so FFmpeg seeks by
   * index rather than decoding forward — a constant cost regardless of file
   * size.
   */
  async extractFrame(
    input: string,
    outputPath: string,
    atSeconds: number,
  ): Promise<void> {
    await this.run('ffmpeg', [
      '-ss',
      atSeconds.toString(),
      '-i',
      input,
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-y',
      outputPath,
    ]);
  }

  /** Stream copy, no re-encode — only the box order changes. */
  async remuxFaststart(input: string, outputPath: string): Promise<void> {
    await this.run('ffmpeg', [
      '-i',
      input,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    ]);
  }

  private run(
    bin: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const timeoutMs = this.config.ffmpegTimeoutSeconds * 1000;

    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const child = spawn(bin, args, { signal: controller.signal });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new FfmpegCommandFailedException(
            bin,
            null,
            controller.signal.aborted
              ? `timed out after ${this.config.ffmpegTimeoutSeconds}s`
              : error.message,
          ),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        reject(
          new FfmpegCommandFailedException(
            bin,
            code,
            stderr.slice(-STDERR_TAIL_LENGTH),
          ),
        );
      });
    });
  }
}
