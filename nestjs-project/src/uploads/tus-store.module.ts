import { Module, type Provider } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { nativeImport } from '../common/native-import';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { TUS_STORE } from './uploads.constants';

/**
 * One `S3Store` per process, for the same reason the queue caches its boss:
 * Nest builds a module instance per import site, and each store would otherwise
 * open its own S3 client and metadata cache.
 */
let storePromise: Promise<unknown> | null = null;

function resolveStore(
  storage: ConfigType<typeof storageConfig>,
  upload: ConfigType<typeof uploadConfig>,
): Promise<unknown> {
  storePromise ??= (async () => {
    // @tus/s3-store is ESM-only — see `native-import.ts`.
    const { S3Store } =
      await nativeImport<typeof import('@tus/s3-store')>('@tus/s3-store');

    return new S3Store({
      // 8 MiB parts put a 10 GiB upload at ~1,280 parts, well inside S3's
      // 10,000-part ceiling.
      partSize: upload.partSizeBytes,
      expirationPeriodInMilliseconds:
        upload.abandonedExpirationHours * 60 * 60 * 1000,
      s3ClientConfig: {
        bucket: storage.bucket,
        endpoint: storage.endpoint,
        region: storage.region,
        forcePathStyle: storage.forcePathStyle,
        credentials: {
          accessKeyId: storage.accessKeyId,
          secretAccessKey: storage.secretAccessKey,
        },
      },
    });
  })();

  return storePromise;
}

const tusStoreProvider: Provider = {
  provide: TUS_STORE,
  inject: [storageConfig.KEY, uploadConfig.KEY],
  useFactory: resolveStore,
};

/**
 * The store on its own, with no HTTP artifact anywhere in its graph. That is
 * what lets the worker import it for the abandoned-upload sweep without
 * dragging in the tus `Server`.
 */
@Module({
  imports: [ConfigModule],
  providers: [tusStoreProvider],
  exports: [TUS_STORE],
})
export class TusStoreModule {}
