import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * Runs inside the `nestjs-api` container, which is what makes the
 * internal-vs-public endpoint split observable: `S3_ENDPOINT` (`minio:9000`)
 * resolves here, while `S3_PUBLIC_ENDPOINT` (`localhost:9000`) points at this
 * very container and therefore does not.
 */
describe('StorageService (integration)', () => {
  let storageService: StorageService;
  const createdKeys: string[] = [];

  const key = (suffix = '') => {
    const generated = `test/${randomUUID()}${suffix}`;
    createdKeys.push(generated);
    return generated;
  };

  const readStream = async (stream: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    return Buffer.concat(chunks);
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
  });

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((k) => storageService.deleteObject(k).catch(() => {})),
    );
  });

  describe('object round-trip', () => {
    it('should return byte-identical content from putObject through getObjectStream', async () => {
      const objectKey = key('.bin');
      const body = Buffer.from('the quick brown fox jumps over the lazy dog');

      await storageService.putObject(
        objectKey,
        body,
        'application/octet-stream',
      );
      const roundTripped = await readStream(
        await storageService.getObjectStream(objectKey),
      );

      expect(roundTripped.equals(body)).toBe(true);
    });

    it('should report the stored size and content type through headObject', async () => {
      const objectKey = key('.txt');
      const body = Buffer.alloc(1234, 0x61);

      await storageService.putObject(objectKey, body, 'text/plain');
      const head = await storageService.headObject(objectKey);

      expect(head.contentLength).toBe(1234);
      expect(head.contentType).toBe('text/plain');
    });

    it('should remove the key with deleteObject', async () => {
      const objectKey = key('.txt');
      await storageService.putObject(objectKey, Buffer.from('gone soon'));

      await storageService.deleteObject(objectKey);

      await expect(storageService.headObject(objectKey)).rejects.toThrow();
    });

    it('should duplicate content with copyObject', async () => {
      const source = key('-source.bin');
      const destination = key('-destination.bin');
      const body = Buffer.from('copy me verbatim');

      await storageService.putObject(source, body);
      await storageService.copyObject(source, destination);

      const copied = await readStream(
        await storageService.getObjectStream(destination),
      );
      expect(copied.equals(body)).toBe(true);
    });
  });

  describe('presigned URLs', () => {
    it('should sign public URLs against S3_PUBLIC_ENDPOINT and internal ones against S3_ENDPOINT', async () => {
      const objectKey = key('.bin');
      await storageService.putObject(objectKey, Buffer.from('hosts differ'));

      const publicUrl = await storageService.getPresignedUrl(objectKey);
      const internalUrl =
        await storageService.getInternalPresignedUrl(objectKey);

      expect(new URL(publicUrl).host).toBe(
        new URL(process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000').host,
      );
      expect(new URL(internalUrl).host).toBe(
        new URL(process.env.S3_ENDPOINT ?? 'http://minio:9000').host,
      );
      expect(new URL(publicUrl).host).not.toBe(new URL(internalUrl).host);
    });

    it('should serve the object over an internal presigned URL with no credentials', async () => {
      const objectKey = key('.bin');
      const body = Buffer.from('presigned reads need no credentials');
      await storageService.putObject(objectKey, body);

      const response = await fetch(
        await storageService.getInternalPresignedUrl(objectKey),
      );

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);
    });

    it('should honour an HTTP Range request on a presigned URL', async () => {
      const objectKey = key('.bin');
      await storageService.putObject(objectKey, Buffer.alloc(500, 0x7a));

      const response = await fetch(
        await storageService.getInternalPresignedUrl(objectKey),
        { headers: { Range: 'bytes=0-99' } },
      );

      expect(response.status).toBe(206);
      expect((await response.arrayBuffer()).byteLength).toBe(100);
    });

    it('should return Content-Disposition: attachment when downloadFilename is given', async () => {
      const objectKey = key('.bin');
      await storageService.putObject(objectKey, Buffer.from('download me'));

      const response = await fetch(
        await storageService.getInternalPresignedUrl(objectKey, {
          downloadFilename: 'My Holiday.mp4',
        }),
      );

      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="My Holiday.mp4"',
      );
    });

    it('should stop serving a presigned URL once it has expired', async () => {
      const objectKey = key('.bin');
      await storageService.putObject(objectKey, Buffer.from('short lived'));
      const url = await storageService.getInternalPresignedUrl(objectKey, {
        expiresIn: 1,
      });

      await new Promise((resolve) => setTimeout(resolve, 2500));

      expect((await fetch(url)).status).toBe(403);
    }, 15000);

    it('should not be reachable through the public endpoint from inside the container', async () => {
      const objectKey = key('.bin');
      await storageService.putObject(objectKey, Buffer.from('browser only'));
      const publicUrl = await storageService.getPresignedUrl(objectKey);

      await expect(
        fetch(publicUrl, { signal: AbortSignal.timeout(3000) }),
      ).rejects.toThrow();
    }, 15000);
  });
});
