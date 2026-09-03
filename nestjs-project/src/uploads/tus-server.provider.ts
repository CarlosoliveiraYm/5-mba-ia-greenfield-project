import { randomUUID } from 'node:crypto';
import type { Provider } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { nativeImport } from '../common/native-import';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { uploadObjectExtension } from '../storage/storage.keys';
import { UploadsService } from './uploads.service';
import {
  TUS_ALLOWED_HEADERS,
  TUS_EXPOSED_HEADERS,
  TUS_PATH,
  TUS_SERVER,
  TUS_STORE,
} from './uploads.constants';

/**
 * In `@tus/server` the upload id **is** the object key the store writes to (the
 * default is `crypto.randomBytes(16).toString('hex')`). So this function is what
 * decides the S3 key for every uploaded video. Keeping it free of `/` lets
 * `generateUrl` and `getFileIdFromRequest` stay at their defaults.
 *
 * The extension is only a hint here: whether it is actually acceptable is
 * decided by `onUploadCreate`, which runs after this and before a single byte
 * is written.
 */
export function buildUploadId(
  metadata: Record<string, string | null> | undefined,
): string {
  const declared = metadata?.filename ?? metadata?.filetype ?? '';

  let extension = 'bin';
  try {
    extension = uploadObjectExtension(declared);
  } catch {
    // Fall through: a filename with no extension is rejected later, with the
    // 415 the protocol calls for rather than a 500 out of this function.
  }

  return `${randomUUID()}.${extension}`;
}

/**
 * The tus 1.0 endpoint. CORS is configured here rather than through Nest's
 * `app.enableCors()`, which never sees a path served by raw Express middleware.
 */
export const tusServerProvider: Provider = {
  provide: TUS_SERVER,
  inject: [TUS_STORE, storageConfig.KEY, uploadConfig.KEY, UploadsService],
  useFactory: async (
    datastore: never,
    storage: ConfigType<typeof storageConfig>,
    upload: ConfigType<typeof uploadConfig>,
    uploads: UploadsService,
  ) => {
    // @tus/server is ESM-only — see `native-import.ts`.
    const { Server } =
      await nativeImport<typeof import('@tus/server')>('@tus/server');

    return new Server({
      datastore,
      path: TUS_PATH,
      maxSize: upload.maxSizeBytes,
      respectForwardedHeaders: true,
      allowedOrigins: [storage.corsAllowOrigin],
      allowedHeaders: [...TUS_ALLOWED_HEADERS],
      exposedHeaders: [...TUS_EXPOSED_HEADERS],
      allowedCredentials: false,
      namingFunction: (_req, metadata) => buildUploadId(metadata),
      // `runHook` translates domain exceptions into the `{ status_code, body }`
      // shape tus answers with — the global exception filter never sees this
      // path.
      onIncomingRequest: (req, uploadId) =>
        uploads.runHook(() => uploads.handleIncomingRequest(req, uploadId)),
      onUploadCreate: (req, uploadEntity) =>
        uploads.runHook(() => uploads.handleUploadCreate(req, uploadEntity)),
      onUploadFinish: (req, uploadEntity) =>
        uploads.runHook(() => uploads.handleUploadFinish(req, uploadEntity)),
    });
  },
};
