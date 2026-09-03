import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Real video files, generated on demand from FFmpeg's synthetic sources.
 *
 * No binary blob is committed to Git: every assertion in the suite comes from
 * the generation parameters, so a fixture's duration and dimensions are known
 * exactly rather than being read off a file someone once produced.
 *
 * Generation costs a second or two, so results are memoized per Jest worker.
 */

export interface TestVideoOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** Container extension. Anything FFmpeg can mux from H.264 + AAC. */
  container?: string;
}

const DEFAULTS: Required<TestVideoOptions> = {
  durationSeconds: 3,
  width: 320,
  height: 240,
  container: 'mp4',
};

const generated = new Map<string, string>();
let fixtureDir: string | null = null;

function directory(): string {
  fixtureDir ??= mkdtempSync(join(tmpdir(), 'streamtube-fixtures-'));
  return fixtureDir;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `ffmpeg exited ${code}: ${stderr.slice(-1500)}\nargs: ${args.join(' ')}`,
        ),
      );
    });
  });
}

async function memoize(
  key: string,
  produce: (outputPath: string) => Promise<void>,
  extension: string,
): Promise<string> {
  const cached = generated.get(key);
  if (cached) {
    return cached;
  }

  const outputPath = join(
    directory(),
    `${key.replace(/[^a-z0-9]+/gi, '_')}.${extension}`,
  );
  await produce(outputPath);
  generated.set(key, outputPath);

  return outputPath;
}

function sourceArgs(options: Required<TestVideoOptions>): string[] {
  const { durationSeconds, width, height } = options;

  return [
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=10`,
    '-f',
    'lavfi',
    '-i',
    'sine',
    '-shortest',
  ];
}

/** A playable clip whose duration and dimensions are exactly what was asked for. */
export function createTestVideo(
  options: TestVideoOptions = {},
): Promise<string> {
  const resolved = { ...DEFAULTS, ...options };
  const key = `video-${resolved.durationSeconds}s-${resolved.width}x${resolved.height}-${resolved.container}`;

  return memoize(
    key,
    (outputPath) =>
      runFfmpeg([
        ...sourceArgs(resolved),
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        '-y',
        outputPath,
      ]),
    resolved.container,
  );
}

/**
 * An MP4 whose `moov` atom sits *after* `mdat` — the layout that forces the
 * worker's conditional faststart remux. FFmpeg writes this by default; the
 * point is the absence of `-movflags +faststart`.
 */
export function createTrailingMoovVideo(
  options: TestVideoOptions = {},
): Promise<string> {
  const resolved = { ...DEFAULTS, ...options, container: 'mp4' };
  const key = `trailing-moov-${resolved.durationSeconds}s-${resolved.width}x${resolved.height}`;

  return memoize(
    key,
    async (outputPath) => {
      await runFfmpeg([
        ...sourceArgs(resolved),
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-y',
        outputPath,
      ]);

      if (moovPrecedesMdat(outputPath)) {
        throw new Error(
          'Expected a trailing moov atom, but ffmpeg wrote it at the head',
        );
      }
    },
    'mp4',
  );
}

/**
 * A clip encoded with MPEG-4 Part 2 — a codec outside
 * `UPLOAD_ACCEPTED_VIDEO_CODECS`, so the worker must reject it.
 */
export function createUnsupportedCodecVideo(
  options: TestVideoOptions = {},
): Promise<string> {
  const resolved = { ...DEFAULTS, ...options, container: 'mp4' };
  const key = `mpeg4-${resolved.durationSeconds}s-${resolved.width}x${resolved.height}`;

  return memoize(
    key,
    (outputPath) =>
      runFfmpeg([
        ...sourceArgs(resolved),
        '-c:v',
        'mpeg4',
        '-c:a',
        'aac',
        '-y',
        outputPath,
      ]),
    'mp4',
  );
}

/** Removes every generated fixture. Safe to call when nothing was generated. */
export function cleanupTestVideos(): void {
  if (fixtureDir) {
    rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = null;
  }
  generated.clear();
}

/**
 * Walks the top-level MP4 box sequence in the file's leading bytes and reports
 * whether `moov` comes before `mdat`. Used here only to assert the fixture is
 * what it claims to be; the production version lives in `ffmpeg/moov.util.ts`.
 */
function moovPrecedesMdat(path: string): boolean {
  const head = readFileSync(path);
  let offset = 0;

  while (offset + 8 <= head.length) {
    const size = head.readUInt32BE(offset);
    const type = head.toString('ascii', offset + 4, offset + 8);

    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    if (size < 8) return false;

    offset += size === 1 ? Number(head.readBigUInt64BE(offset + 8)) : size;
  }

  return false;
}
