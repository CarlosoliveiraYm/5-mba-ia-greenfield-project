/** Injection token for the `@tus/s3-store` instance. */
export const TUS_STORE = 'TUS_STORE';

/** Injection token for the `@tus/server` instance mounted at `/uploads`. */
export const TUS_SERVER = 'TUS_SERVER';

/** The path the tus endpoint is mounted at. Also the tus `Server`'s `path`. */
export const TUS_PATH = '/uploads';

/**
 * The suffix `@tus/s3-store` appends for an upload's metadata object
 * (`S3Store#infoKey`). The sweep has to delete it alongside the upload's own
 * object, so it is pinned here rather than assumed at the call site.
 */
export const TUS_INFO_SUFFIX = '.info';

/** Headers a tus client sends that CORS preflight has to allow. */
export const TUS_ALLOWED_HEADERS = [
  'Authorization',
  'Tus-Resumable',
  'Upload-Length',
  'Upload-Offset',
  'Upload-Metadata',
  'Upload-Defer-Length',
  'Upload-Concat',
] as const;

/** Headers the browser needs to read back off a tus response. */
export const TUS_EXPOSED_HEADERS = [
  'Upload-Offset',
  'Location',
  'Upload-Expires',
  'Upload-Length',
  'Tus-Version',
  'Tus-Resumable',
  'Tus-Extension',
  'Tus-Max-Size',
] as const;
