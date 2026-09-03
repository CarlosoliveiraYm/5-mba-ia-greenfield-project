import { registerAs } from '@nestjs/config';

/**
 * Two endpoints, deliberately. `endpoint` is the in-network address the API and
 * the worker use for reads and writes; `publicEndpoint` is the browser-reachable
 * one used *only* to sign delivery URLs, because a SigV4 signature covers the
 * Host header — a URL signed for `minio:9000` fails when the browser fetches it
 * from `localhost:9000`, and vice-versa.
 */
export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  bucket: process.env.S3_BUCKET!,
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  presignedUrlExpirationSeconds: parseInt(
    process.env.PRESIGNED_URL_EXPIRATION_SECONDS || '900',
    10,
  ),
  corsAllowOrigin: process.env.S3_CORS_ALLOW_ORIGIN || 'http://localhost:3001',
}));
