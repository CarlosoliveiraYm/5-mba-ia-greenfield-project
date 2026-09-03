---
kind: phase
name: phase-03-upload
sources_mtime:
  docs/project-plan.md: "2026-08-31T09:51:36-03:00"
  docs/decisions/technical-decisions-phase-03-upload.md: "2026-09-02T19:22:09-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-09-02T19:11:45-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver resumable uploads of video files up to 10GB straight into object storage, automatic
draft pre-registration and background processing (metadata extraction, faststart remux,
thumbnail), a short opaque public URL per video, and presigned streaming/download delivery —
without a single video byte transiting the Node processes for longer than a chunk.

---

## Step Implementations

### SI-03.1 — MinIO Service, Storage Config Namespace, and Env Schema

**Description:** Add MinIO to Docker Compose as the S3-compatible object storage backend,
create the `storage` config namespace following the `registerAs` pattern, and extend the Joi
env schema with all storage keys. Two endpoints are configured: an internal one for
server-to-storage traffic and a browser-reachable one used to sign delivery URLs.

**Technical actions:**

- Install production dependencies in nestjs-project: `@aws-sdk/client-s3@^3.x`,
  `@aws-sdk/s3-request-presigner@^3.x` (both CommonJS-compatible, no ESM friction)
- Add a `minio` service to `nestjs-project/compose.yaml` — image `minio/minio`, command
  `server /data --console-address ":9001"`, ports `9000:9000` and `9001:9001`, env
  `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, named volume `minio-data:/data`, and a healthcheck
  hitting `/minio/health/live`, plus `MINIO_API_CORS_ALLOW_ORIGIN` fed from
  `S3_CORS_ALLOW_ORIGIN` — bucket-level CORS (`mc cors set`) is an AIStor-only feature, so on
  the open-source image the cluster-wide env var is the only lever. Add a one-shot
  `minio-init` service on `minio/mc` that waits for the healthcheck and creates the
  `streamtube-videos` bucket. Make `nestjs-api` depend on `minio` being healthy
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT`
  (internal, default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (browser-reachable, default
  `http://localhost:9000`), `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (boolean, default `true`),
  `PRESIGNED_URL_EXPIRATION_SECONDS` (number, default `900`), `S3_CORS_ALLOW_ORIGIN`
  (default `http://localhost:3001`, the `next-frontend` origin)
- Update `src/config/env.validation.ts` — add every `S3_*` key to the Joi schema
  (`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` required; the rest with defaults).
  Register `storageConfig` in `ConfigModule.forRoot({ load: [...] })` in `src/app.module.ts`
- Update `nestjs-project/.env.example` with all storage keys and Compose-compatible defaults;
  also backfill the two keys currently missing there (`APP_URL`, `SWAGGER_ENABLED`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Integration | Schema accepts a complete Phase 03 env; rejects a env missing `S3_BUCKET`; applies defaults for `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `PRESIGNED_URL_EXPIRATION_SECONDS` |

Every later SI that introduces an env key extends this same spec with a required/default case
for it — the file is not re-listed per SI.

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `minio` reporting healthy, and the `streamtube-videos`
  bucket exists — verifiable with `docker compose exec minio-init mc ls local/`
- The MinIO console answers on `http://localhost:9001` and the S3 API on `http://localhost:9000`
- Starting the application without `S3_BUCKET` causes a Joi validation error at bootstrap —
  the app does not start
- Starting the application with only the required storage keys succeeds, and
  `configService.get('storage.endpoint')` resolves to `http://minio:9000`

---

### SI-03.2 — StorageService (S3 Port)

**Description:** Implement the single service through which the API and the worker touch
object storage. It holds two `S3Client` instances — one bound to the internal endpoint for
reads and writes, one bound to the public endpoint used exclusively to sign delivery URLs, so
SigV4 signatures match the host the browser will actually request.

**Technical actions:**

- Create `src/storage/storage.service.ts` — `StorageService` injecting
  `@Inject(storageConfig.KEY)`. Build two clients with `forcePathStyle` and static
  `credentials`: `client` (from `storage.endpoint`) and `presignClient` (from
  `storage.publicEndpoint`). Implement `putObject(key, body, contentType)`,
  `getObjectStream(key)`, `headObject(key)`, `deleteObject(key)`, and
  `copyObject(sourceKey, destinationKey)` using `PutObjectCommand`, `GetObjectCommand`,
  `HeadObjectCommand`, `DeleteObjectCommand` and `CopyObjectCommand`
- Implement `getPresignedUrl(key, options)` in `StorageService` using `getSignedUrl` from
  `@aws-sdk/s3-request-presigner` against `presignClient`, with `expiresIn` defaulting to
  `storage.presignedUrlExpirationSeconds`. When `options.downloadFilename` is present, set
  `ResponseContentDisposition` to `attachment; filename="<sanitized>"` on the
  `GetObjectCommand` so one mechanism serves both streaming and download
- Implement `getInternalPresignedUrl(key, options)` — identical to `getPresignedUrl` but
  signed against the internal `client`, for server-side consumers inside the Docker network
  (the worker's ffprobe). A URL signed for `S3_PUBLIC_ENDPOINT` carries `localhost:9000` in
  the signed `Host` header, which from inside a container resolves to that container itself,
  not to MinIO
- Create `src/storage/storage.keys.ts` — pure helpers `videoThumbnailKey(videoId)` →
  `thumbnails/{videoId}/auto.webp` and `uploadObjectExtension(filename)` → the normalized,
  lowercased extension. The video object's own key is **not** built here: it is the tus upload
  id, produced by the `namingFunction` in SI-03.6
- Create `src/storage/storage.module.ts` — `StorageModule` providing and exporting
  `StorageService`, importing `ConfigModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Round-trip put/head/get against real MinIO; `deleteObject` removes the key; `copyObject` duplicates content; presigned GET is fetchable and honours HTTP `Range`; presigned URL with `downloadFilename` returns `Content-Disposition: attachment`; `getInternalPresignedUrl` is fetchable from inside the Docker network while the public-endpoint URL is not |
| `src/storage/storage.keys.spec.ts` | Unit | `videoThumbnailKey` produces the documented layout; `uploadObjectExtension` lowercases, strips a leading dot, and rejects a filename with no extension |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with `ConfigModule` and exports `StorageService` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Uploading a buffer via `putObject` and reading it back via `getObjectStream` returns
  byte-identical content
- A URL returned by `getPresignedUrl` is fetchable from the host with no credentials and
  stops working after its expiry elapses
- A presigned URL requested with `Range: bytes=0-99` returns `206 Partial Content` with
  exactly 100 bytes — proving storage-side range support that streaming depends on
- A presigned URL built with `downloadFilename` returns a `Content-Disposition: attachment`
  header carrying that filename
- The presigned URL's host is `S3_PUBLIC_ENDPOINT`, not `S3_ENDPOINT` — a URL signed for the
  internal host would fail signature validation when fetched from the browser

---

### SI-03.3 — Background Job Queue Module (pg-boss)

**Description:** Wire `pg-boss` into the Nest DI graph as a hand-rolled module. Because
`pg-boss@12` ships as a pure ESM package while `nestjs-project` is CommonJS, it is loaded
through an async provider factory using a native dynamic import that bypasses Jest's CJS
module registry.

**Technical actions:**

- Install `pg-boss@^12.x` (ESM-only, requires Node >= 22.12 — satisfied by the Node 25.6
  base image)
- Create `src/common/native-import.ts` — export
  `nativeImport<T>(specifier: string): Promise<T>` implemented as
  `new Function('s', 'return import(s)')`, so the call survives ts-jest's CommonJS transform
  and resolves through Node's real ESM loader. Document why it exists in a file-header comment
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `QUEUE_SCHEMA`
  (default `pgboss`), `QUEUE_RETRY_LIMIT` (default `3`), `QUEUE_EXPIRE_IN_SECONDS`
  (default `3600`). Add the keys to `env.validation.ts`, `.env.example`, and
  `ConfigModule.forRoot({ load: [...] })`. There is deliberately no `QUEUE_SUPERVISE` key:
  API and worker read the same `.env`, so one env value cannot express "API send-only, worker
  supervises" — that flag is passed in code, per process, by each module's factory
- Create `src/queue/queue.module.ts` — a `@Global()`-free `QueueModule` exposing a
  `PG_BOSS` provider whose `useFactory` awaits `nativeImport('pg-boss')`, constructs the boss
  from the `database` config namespace plus `queue.schema`, and calls `start()`. The API side
  passes `supervise: false, schedule: false` (send-only); the worker side enables both. Both
  processes may call `start()` — pg-boss guards its own migrations with an advisory lock
- Create `src/queue/queue.service.ts` — `QueueService` wrapping the boss with typed methods
  `ensureQueue(name)` (via `createQueue`), `send(name, data, options)` accepting an optional
  `db` adapter so the enqueue can join an existing TypeORM transaction, and
  `schedule(name, cron)`. Define the job payload types in `src/queue/queue.types.ts`, plus the
  adapter `toPgBossDb(manager)` returning
  `{ executeSql: async (text, values) => ({ rows: await manager.query(text, values) }) }` —
  pg-boss's `Db` interface expects `{ rows }`, while TypeORM's `manager.query()` returns the
  row array directly, so passing the manager unwrapped makes the enqueue fail obscurely

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/queue.service.integration-spec.ts` | Integration | `ensureQueue` is idempotent; `send` persists a job readable via `findJobs`; `toPgBossDb` wraps TypeORM's row array into the `{ rows }` shape pg-boss expects; `send` with that adapter bound to a rolled-back transaction leaves no job behind, and a job committed with the transaction is present |
| `src/queue/queue.module.spec.ts` | Unit | Module compiles, the `PG_BOSS` provider resolves through the native-import factory, and `QueueService` is exported |
| `src/common/native-import.spec.ts` | Unit | `nativeImport` resolves an ESM-only specifier from inside a Jest CommonJS test |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- The application boots with `pg-boss` connected and its schema created in the `pgboss`
  Postgres schema — `SELECT * FROM pgboss.job` is queryable
- `nativeImport('pg-boss')` resolves inside a Jest test — proving the ESM/CJS escape hatch
  works in the test runner, not only at runtime
- A job sent inside a TypeORM transaction that is rolled back does not appear in
  `pgboss.job`; the same job sent in a committed transaction does
- `ensureQueue` called twice with the same name does not error

---

### SI-03.4 — Video Entity, Public ID Generator, and Migration

**Description:** Create the `Video` entity holding the full lifecycle of an upload — the
opaque public identifier, the processing state machine, the storage keys, and the metadata
that the worker fills in. Generate the migration and extend the shared test-cleanup helper.

**Technical actions:**

- Create `src/videos/public-id.util.ts` — export `generatePublicId(): string` returning
  `crypto.randomBytes(8).toString('base64url')` (11 URL-safe characters, ~64 bits of
  entropy). No dependency is added: this deliberately avoids `nanoid`, which is ESM-only
- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with the columns listed
  in the Data Model below. `status` is a PostgreSQL enum defaulting to `'draft'`;
  `public_id` and `upload_id` are unique; `size_bytes` is `bigint`. Define
  `@ManyToOne(() => Channel, { onDelete: 'CASCADE' })` with `@JoinColumn({ name: 'channel_id' })`.
  Set `public_id` in a `@BeforeInsert()` hook via `generatePublicId()` when unset. Alongside
  it, create `src/videos/video-status.enum.ts` and `src/videos/video-failure-reason.enum.ts`
  with the canonical `VideoStatus` (`draft`, `uploading`, `processing`, `ready`, `failed`) and
  `VideoFailureReason` values, exported for the worker, the DTOs and the OpenAPI schema
- Add the phase's four `DomainException` subclasses to
  `src/common/exceptions/domain.exception.ts`, following the existing constructor pattern
  `super(errorCode, httpStatus, message)`: `UploadAlreadyInProgressException` (409),
  `InvalidUploadTicketException` (401), `VideoNotFoundException` (404) and
  `VideoNotReadyException` (409). All four are created here, in one edit, and merely consumed
  by SI-03.5, SI-03.8 and SI-03.13. `UPLOAD_TOO_LARGE` (413) and `UNSUPPORTED_MEDIA_TYPE`
  (415) are deliberately **not** among them — they are born and answered inside the tus layer
  in `{ status_code, body }` form — and neither are `FfmpegCommandFailedException` /
  `ProbeFailedException`, which the worker raises with no HTTP layer to map them
- Generate the migration via
  `npm run migration:generate -- src/database/migrations/CreateVideos` and review the SQL for
  the enum type, the two unique indexes, the `(channel_id)` index, and the
  `(status, upload_expires_at)` composite index used by the abandoned-upload sweep
- Update `src/test/create-test-data-source.ts` — add `DELETE FROM "videos"` to
  `cleanAllTables`, ordered before `channels` so the FK is respected

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | `public_id` and `upload_id` unique constraints; `status` defaults to `draft` and rejects a value outside the enum; `channel` relation loads; deleting a channel cascades to its videos; `size_bytes` survives a value above 2^31 |
| `src/videos/public-id.util.spec.ts` | Unit | Output is 11 characters, URL-safe (`[A-Za-z0-9_-]` only), and 10,000 generations produce no duplicate |
| `src/database/migrations.integration-spec.ts` | Integration | `runMigrations` now applies three migrations and the `videos` table exists; `undoLastMigration` removes it |
| `src/common/filters/domain-exception.filter.spec.ts` | Unit | The four new subclasses each map to `{ statusCode, error, message }` with the codes and statuses in the Error Catalog |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, the `video_status`
  enum type, and every index in the Data Model
- Inserting two videos with the same `public_id` fails with a unique constraint violation
- A newly inserted video has `status = 'draft'` without the caller setting it
- Inserting a video with `status = 'transcoding'` is rejected by the enum constraint
- Deleting a channel deletes its videos — no orphaned video rows remain
- `size_bytes = 10737418240` round-trips without overflow

---

### SI-03.5 — Upload Ticket Endpoint

**Description:** Mint the short-lived credential the browser presents to the tus endpoint.
The Strict BFF (`next-frontend-config-base/TD-03`) forbids the browser from holding the
session, and the 15-minute access token is far too short for a 10GB transfer — so an
upload-scoped JWT is issued through the BFF, and the tus path accepts nothing else. This
endpoint also enforces the one-in-flight-upload-per-user rule from TD-12.

**Technical actions:**

- Create `src/config/upload.config.ts` — `registerAs('upload', ...)` reading
  `UPLOAD_MAX_SIZE_BYTES` (default `10737418240`), `UPLOAD_ACCEPTED_CONTAINERS`
  (comma-separated, default `mp4,mov,webm,mkv`), `UPLOAD_ACCEPTED_VIDEO_CODECS`
  (default `h264,vp9,av1`), `UPLOAD_ABANDONED_EXPIRATION_HOURS` (default `24`),
  `UPLOAD_TICKET_EXPIRATION_HOURS` (default `2`), `UPLOAD_PART_SIZE_BYTES`
  (default `8388608`), `UPLOAD_PUBLIC_URL` (default `http://localhost:3000/uploads`). Add all
  keys to `env.validation.ts`, `.env.example` and `ConfigModule.forRoot({ load: [...] })`
- Create `src/videos/upload-ticket.service.ts` — `UploadTicketService` injecting `JwtService`
  and `@Inject(uploadConfig.KEY)`. Implement `issue(userId)`: sign
  `{ sub: userId, scope: 'upload', jti: randomUUID() }` with the access-token secret and
  `expiresIn` from `upload.ticketExpirationHours`. Implement `verify(rawTicket)`: verify the
  signature and assert `scope === 'upload'`, throwing `InvalidUploadTicketException` on any
  failure — a plain access token must not be accepted here
- Create `src/videos/videos.service.ts` — `VideosService` injecting `Repository<Video>` and
  `Repository<Channel>`. Implement `requestUploadTicket(userId)`: resolve the user's channel,
  reject with `UploadAlreadyInProgressException` when a video for that channel is already in
  `draft` or `uploading` with `upload_expires_at > now()`, otherwise return the issued ticket
  plus the tus endpoint URL and the ticket expiry
- Create `src/videos/videos.controller.ts` (route prefix `videos`) and
  `src/videos/videos.module.ts`. Add `@Post('upload-ticket')` with `@HttpCode(200)`, reading
  the user from `@CurrentUser()` — no `@Public()`, so the global `JwtAuthGuard` protects it.
  Annotate with `@ApiTags('videos')` and response DTOs so the endpoint lands in `openapi.json`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/upload-ticket.service.spec.ts` | Unit | With a **real `JwtModule`** and a test secret — never a mocked `JwtService`, which would hide a wrong secret or expiry: `issue` produces a JWT with `sub`, `scope: 'upload'` and a `jti`; `verify` accepts it; `verify` rejects an expired ticket, a tampered signature, and a valid access token that lacks `scope: 'upload'` |
| `src/videos/videos.service.spec.ts` | Unit | Branch logic against a mocked repository: `requestUploadTicket` issues when nothing is in flight and throws `UploadAlreadyInProgressException` when a `draft`/`uploading` video sits inside its expiry window; `findByPublicIdForOwner` throws the same `VideoNotFoundException` for an unknown id and for another user's video |
| `src/videos/videos.service.integration-spec.ts` | Integration | `requestUploadTicket` succeeds for a user with no in-flight upload; throws when a `draft` or `uploading` video exists; succeeds again once that video's `upload_expires_at` has passed |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `QueueModule` and `JwtModule` wiring |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/upload-ticket` returns 200 with `{ ticket, upload_url, expires_at }`; 401 without an access token; 409 `UPLOAD_ALREADY_IN_PROGRESS` on a second call while one upload is in flight |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- `POST /videos/upload-ticket` with a valid access token returns 200 with
  `{ ticket, upload_url, expires_at }`, where `upload_url` is the browser-reachable tus
  endpoint
- `POST /videos/upload-ticket` without an `Authorization` header returns 401
- `POST /videos/upload-ticket` while the caller already has a video in `draft` or `uploading`
  returns 409 with `UPLOAD_ALREADY_IN_PROGRESS`
- The issued ticket is a JWT carrying `scope: 'upload'` and expires in
  `UPLOAD_TICKET_EXPIRATION_HOURS` — a regular access token presented to the tus endpoint is
  rejected, so the session credential never leaves the BFF
- Once the previous upload reaches a terminal state or its `upload_expires_at` passes, a new
  ticket is issued successfully

---

### SI-03.6 — tus Server Wiring and Route Mounting

**Description:** Stand up the tus 1.0 endpoint backed by an S3 multipart store, and mount it
into the Express instance ahead of the JSON body parser so Nest never consumes the chunk
stream. Like `pg-boss`, `@tus/server` and `@tus/s3-store` are ESM-only and enter through the
native-import factory. This SI delivers the transport; the lifecycle hooks are SI-03.7.

**Technical actions:**

- Install `@tus/server@^2.x` and `@tus/s3-store@^2.x` (both ESM-only, Node >= 20.19 —
  satisfied)
- Create `src/uploads/tus-store.module.ts` and `src/uploads/tus-server.provider.ts` — a
  standalone `TusStoreModule` exposing a `TUS_STORE` async provider whose factory awaits
  `nativeImport('@tus/s3-store')` and builds an `S3Store` with `partSize` from
  `upload.partSizeBytes` (8MiB → ~1,280 parts for a 10GB file, well inside the 10,000-part
  ceiling), `expirationPeriodInMilliseconds` from `upload.abandonedExpirationHours`, and
  `s3ClientConfig` mirroring the internal-endpoint settings from `storage.config.ts`; plus a
  `TUS_SERVER` provider that awaits `nativeImport('@tus/server')` and constructs a `Server`
  over the injected store with `path: '/uploads'`, `maxSize` from `upload.maxSizeBytes`,
  `respectForwardedHeaders: true`, and a `namingFunction` returning
  `${randomUUID()}.${ext}` — `ext` derived from the `filename` in `Upload-Metadata` and
  normalized against `UPLOAD_ACCEPTED_CONTAINERS`. In `@tus/server` the upload id **is** the
  object key (the default is `crypto.randomBytes(16).toString('hex')`), so this function is
  what decides the S3 key; keeping it free of `/` lets `generateUrl` and
  `getFileIdFromRequest` stay at their defaults. `TusStoreModule` depends only on
  `ConfigModule`, so the worker can import the store for the sweep (SI-03.14) without dragging
  in any HTTP artifact
- Create `src/uploads/uploads.module.ts` — `UploadsModule` importing `ConfigModule`,
  `TusStoreModule`, `StorageModule`, `QueueModule`, `TypeOrmModule.forFeature([Video])` and
  `VideosModule`, providing `TUS_SERVER` and `UploadsService`, exporting `TUS_SERVER`
- Update `src/main.ts` — create the app with `NestFactory.create(AppModule, { bodyParser: false })`;
  resolve `TUS_SERVER` from the container and mount it with
  `app.use('/uploads', (req, res) => tusServer.handle(req, res))`; only then apply
  `express.json()` and `express.urlencoded({ extended: true })` so every other route keeps its
  parsed body. CORS for this path is configured through the tus `Server`'s own options —
  `allowedOrigins` from `S3_CORS_ALLOW_ORIGIN`, `allowedHeaders` with the protocol headers
  (`Tus-Resumable`, `Upload-Length`, `Upload-Offset`, `Upload-Metadata`, `Authorization`),
  `exposedHeaders` with `Upload-Offset`, `Location` and `Upload-Expires` — not through Nest's
  `app.enableCors()`, which never sees a path served by raw Express middleware
- Document in `nestjs-project/CLAUDE.md` that `/uploads` is raw Express middleware: the global
  `JwtAuthGuard` and the domain exception filter do not apply to it, it speaks tus-protocol
  errors rather than the `{ statusCode, error, message }` envelope, and it does not appear in
  `openapi.json`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/uploads/uploads.module.spec.ts` | Unit | `TusStoreModule` compiles on its own (no HTTP dependency) and `UploadsModule` compiles with both `TUS_STORE` and `TUS_SERVER` resolving through the native-import factories |
| `test/uploads.e2e-spec.ts` | E2E | `OPTIONS /uploads` advertises the tus version and extensions; a `POST /uploads` carrying `Tus-Resumable: 1.0.0` and a valid ticket returns 201 with a `Location` header; `POST /uploads` with `Upload-Length` above `UPLOAD_MAX_SIZE_BYTES` is rejected; a JSON `POST /auth/login` still parses correctly, proving body-parser ordering |

**Dependencies:** SI-03.1, SI-03.5

**Acceptance criteria:**

- `OPTIONS /uploads` returns 204 with `Tus-Resumable`, `Tus-Version` and `Tus-Extension`
  headers — a standard tus client can negotiate against the endpoint
- A tus `POST /uploads` creation request returns 201 with a `Location` header pointing at the
  new upload resource
- A creation request declaring `Upload-Length` greater than `UPLOAD_MAX_SIZE_BYTES` is
  rejected before any byte is transferred
- Existing JSON endpoints (`POST /auth/login`, `POST /auth/register`) keep parsing their
  bodies and returning the Phase 02 error envelope — the `bodyParser: false` change breaks
  nothing
- Uploaded parts land in the `streamtube-videos` bucket as an S3 multipart upload, not
  buffered in the Node process — verifiable via `mc ls --incomplete`

---

### SI-03.7 — Upload Lifecycle Hooks: Draft Creation, Ownership, and Enqueue

**Description:** Attach the domain to the tus lifecycle. `onUploadCreate` authenticates the
ticket, validates declared size and container, and pre-registers the draft video row.
`onIncomingRequest` re-verifies ownership on every chunk. `onUploadFinish` flips the video to
`processing` and enqueues the processing job in the same transaction, so a committed status
change always has a job and a rolled-back one never leaves an orphan.

**Technical actions:**

- Create `src/uploads/uploads.service.ts` — `UploadsService` injecting `UploadTicketService`,
  `Repository<Video>`, `Repository<Channel>`, `QueueService` and `DataSource`. Implement
  `handleUploadCreate(req, upload)`: verify the ticket from the `Authorization` header,
  re-check the one-in-flight rule, validate `upload.size` against `upload.maxSizeBytes` and
  the `filetype`/`filename` metadata extension against `upload.acceptedContainers`, then
  insert a `Video` with `status: 'draft'`, `upload_id: upload.id`,
  `storage_key: upload.id` (the id the `namingFunction` produced **is** the S3 key, and it is
  already known here — `namingFunction` runs before this hook), `original_filename`,
  `mime_type`, `size_bytes`, `title` derived from the filename basename (trimmed to 100
  chars, falling back to `'Untitled video'`), and
  `upload_expires_at = now + UPLOAD_ABANDONED_EXPIRATION_HOURS`
- Implement `handleIncomingRequest(req, uploadId)` in `UploadsService` — verify the ticket,
  load the video by `upload_id` joined to its channel, and reject with a tus `403` when the
  ticket's `sub` does not own that channel. On the first `PATCH`, promote the row with
  `UPDATE videos SET status = 'uploading' WHERE upload_id = $1 AND status = 'draft'` so the
  transition is a single guarded statement rather than a write per chunk
- Implement `handleUploadFinish(req, upload)` in `UploadsService` — open a
  `dataSource.transaction()` that sets `status = 'processing'`, writes the final
  `size_bytes` (`storage_key` was already written at create), and calls
  `queueService.send('video.process', { videoId })` with `db: toPgBossDb(manager)` bound to
  that transaction's `EntityManager`, so the status change and the job commit or roll back
  together
- Wire the three handlers into the `TUS_SERVER` factory from SI-03.6 as `onUploadCreate`,
  `onIncomingRequest` and `onUploadFinish`, translating domain exceptions into tus error
  shapes (`{ status_code, body }`) — the tus path cannot use the global exception filter
- Register the `video.process` queue at worker startup via `queueService.ensureQueue`, with
  `retryLimit`, `retryBackoff: true` and `expireInSeconds` from `queue.config.ts`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/uploads/uploads.service.spec.ts` | Unit | `handleUploadCreate` rejects a missing/expired/wrong-scope ticket, an oversized declared length, and an unaccepted container; derives the title from the filename; `handleIncomingRequest` rejects a ticket whose `sub` does not own the upload |
| `src/uploads/uploads.service.integration-spec.ts` | Integration | `handleUploadCreate` persists a `draft` video bound to the caller's channel with `upload_expires_at` set; first `PATCH` promotes it to `uploading` and a second leaves it unchanged; `handleUploadFinish` commits `processing` + the queued job atomically, and a failed enqueue leaves the status untouched |
| `test/uploads.e2e-spec.ts` | E2E | Full tus round-trip with `tus-js-client` against a generated fixture: creation → chunked `PATCH` → completion; the video reaches `processing`; an interrupted upload resumed via `HEAD` + offset completes without re-sending earlier bytes; another user's ticket on the same upload URL returns 403 |

**Dependencies:** SI-03.3, SI-03.6

**Acceptance criteria:**

- A tus creation request with a valid ticket persists a `Video` row in `draft` linked to the
  caller's channel, with `title` derived from the uploaded filename and `upload_expires_at`
  24 hours in the future
- A tus creation request with a missing, expired, or non-`upload`-scoped ticket is rejected
  with 401 and no video row is created
- A tus creation request declaring `filetype: video/x-msvideo` (AVI) is rejected before any
  byte transfers — the accepted-container list is enforced on the declared value
- Sending the first chunk moves the video from `draft` to `uploading`; subsequent chunks do
  not rewrite the status
- Sending a chunk with a ticket belonging to a different user returns 403 and the upload is
  not advanced
- Completing the upload leaves the video in `processing` **and** exactly one
  `video.process` job in `pgboss.job` carrying that `videoId` — never one without the other
- Interrupting an upload and resuming it with the same upload URL continues from the stored
  offset; the resulting object is byte-identical to the source file

---

### SI-03.8 — Video Status Resource

**Description:** Expose the polling contract of TD-09 — a plain REST resource the client
reads every few seconds while the status is non-terminal, and which survives page reloads and
long absences because the state lives in the database, not in a connection.

**Technical actions:**

- Create `src/videos/dto/video-response.dto.ts` — the public representation:
  `public_id`, `title`, `description`, `status`, `failure_reason`, `duration_seconds`,
  `width`, `height`, `original_filename`, `size_bytes`, `thumbnail_url`, `created_at`,
  `updated_at`. Never expose `id`, `channel_id`, `upload_id` or `storage_key`. Annotate with
  `@ApiProperty` so the enum values reach `openapi.json` and, downstream, the generated
  frontend types
- Implement `findByPublicIdForOwner(publicId, userId)` in `VideosService` — load the video
  joined to its channel and throw `VideoNotFoundException` when it does not exist **or** the
  requester does not own it, so a probe cannot distinguish the two cases
- Implement `toResponseDto(video)` in `VideosService` — map the entity to the DTO, converting
  the `bigint` `size_bytes` (returned as a string by the driver) to a number and building
  `thumbnail_url` as a presigned GET on `thumbnail_key` when one exists
- Add `@Get(':publicId')` to `VideosController` — authenticated, resolves the caller via
  `@CurrentUser()`, returns 200 with the DTO. Annotate with `@ApiOkResponse` and
  `@ApiNotFoundResponse`
- Apply `@SkipThrottle()` to this endpoint **only**. The `ThrottlerGuard` registered as
  `APP_GUARD` in `AuthModule` is global across the whole app — `APP_GUARD` providers are not
  scoped to their declaring module — so every route inherits the 10-requests-per-minute
  window from Phase 02. TD-09's contract has the client polling "every few seconds" while the
  status is non-terminal, which at a 3-second interval is 20 req/min and would take a `429`
  mid-processing. Every other `videos` endpoint stays throttled

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.integration-spec.ts` | Integration | `findByPublicIdForOwner` returns the owner's video; throws for an unknown `publicId`; throws with the same exception for a video owned by someone else; `toResponseDto` converts `size_bytes` and presigns `thumbnail_url` only when a thumbnail key exists |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId` returns 200 with the documented shape; 404 for an unknown id; 404 for another user's video; 401 without a token; the `status` field reflects the row's live state; 15 consecutive polls inside one minute all return 200 while an 11th `POST /videos/upload-ticket` returns 429 |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- `GET /videos/:publicId` with the owner's access token returns 200 with `status` reflecting
  the current state and, once processing has finished, `duration_seconds`, `width`, `height`
  and a fetchable `thumbnail_url`
- `GET /videos/:publicId` for a video owned by another user returns 404 with
  `VIDEO_NOT_FOUND` — the same response as an id that does not exist, so ownership cannot be
  probed
- `GET /videos/:publicId` without an access token returns 401
- The response body never contains `id`, `channel_id`, `upload_id` or `storage_key`
- A video that failed processing returns `status: "failed"` together with a machine-readable
  `failure_reason` from the documented set
- Polling `GET /videos/:publicId` every 3 seconds through a full processing cycle never
  returns 429 — the status endpoint is exempt from the global rate limit, while
  `POST /videos/upload-ticket` still returns 429 on the 11th call within a minute

---

### SI-03.9 — FFmpeg Provisioning and Generated Video Fixtures

**Description:** Install the FFmpeg toolchain into the shared dev image and add the test
helper that builds real video files on demand from FFmpeg's synthetic sources — so the suite
asserts against exact, known durations and dimensions without committing a single binary blob
to Git.

**Technical actions:**

- Update `nestjs-project/Dockerfile.dev` — add `ffmpeg` to the existing
  `apt install -y procps curl` layer, which already runs as root before `USER node`. Both
  `nestjs-api` and the worker build from this file, which is what TD-13 requires: the fixture
  generator runs wherever tests run, not only in the worker
- Create `src/test/video-fixtures.ts` — export
  `createTestVideo(options): Promise<string>` spawning
  `ffmpeg -f lavfi -i testsrc=duration=<d>:size=<w>x<h>:rate=10 -f lavfi -i sine -c:v libx264 -c:a aac -shortest <out>`
  into a per-run temp directory under `os.tmpdir()`, returning the path. Default to a 3s
  320x240 clip
- Add `createTrailingMoovVideo()` to `src/test/video-fixtures.ts` — same source encoded
  **without** `-movflags +faststart`, then verified to carry a trailing `moov` atom, to
  exercise the conditional remux branch of TD-07. Add `createUnsupportedCodecVideo()`
  producing an MPEG-4 Part 2 (`-c:v mpeg4`) clip that must be rejected by the codec whitelist
- Memoize generated fixtures per Jest worker in a module-level map keyed by the option set,
  and expose `cleanupTestVideos()` removing the temp directory — generation costs a second or
  two and must not be repeated per test
- Document the helper in `nestjs-project/CLAUDE.md` under a short "Video fixtures" note: no
  binaries in Git, assertions come from the generation parameters

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/test/video-fixtures.integration-spec.ts` | Integration | `createTestVideo` produces a playable file whose ffprobe duration and dimensions match the requested parameters; `createTrailingMoovVideo` produces a file whose `moov` atom is not at the head; `createUnsupportedCodecVideo` reports `mpeg4`; repeated calls with identical options return the same memoized path |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose exec nestjs-api ffmpeg -version` and `ffprobe -version` both succeed —
  the toolchain is present in the image the tests run in
- `createTestVideo({ durationSeconds: 3, width: 320, height: 240 })` yields a file that
  ffprobe reports as 3 seconds at 320x240 with an H.264 video stream and an AAC audio stream
- `createTrailingMoovVideo()` yields an MP4 whose `moov` atom is located after `mdat`
- No fixture file is written inside the repository working tree — `git status` stays clean
  after a full test run

---

### SI-03.10 — FfmpegService (spawn Wrapper)

**Description:** Implement the thin typed service the worker uses for its three FFmpeg
operations: probing metadata, extracting one thumbnail frame, and stream-copy remuxing to
faststart. Arguments are always passed as arrays — never a shell string — so a hostile
filename cannot inject a command.

**Technical actions:**

- Create `src/ffmpeg/ffmpeg.service.ts`, `src/ffmpeg/ffmpeg.module.ts` and
  `src/ffmpeg/ffmpeg.types.ts` — the service holds a private `run(bin, args, timeoutMs)`
  helper built on `child_process.spawn` with an `AbortSignal` timeout from
  `FFMPEG_TIMEOUT_SECONDS` (registered, default `3600`, in `upload.config.ts`,
  `env.validation.ts` and `.env.example`), capturing stdout/stderr and rejecting with
  `FfmpegCommandFailedException` carrying the exit code and the tail of stderr
- Implement `probe(input: string): Promise<ProbeResult>` — run
  `ffprobe -v quiet -print_format json -show_format -show_streams <input>`, parse the JSON,
  and map it onto a typed `ProbeResult` (`durationSeconds`, `width`, `height`, `videoCodec`,
  `audioCodec`, `containerFormats`, `sizeBytes`). Reject with `ProbeFailedException` on
  malformed JSON or a missing video stream
- Implement `extractFrame(input, outputPath, atSeconds)` — run
  `ffmpeg -ss <atSeconds> -i <input> -frames:v 1 -c:v libwebp -y <outputPath>` with
  input-side seeking so the seek costs a second regardless of file size
- Implement `remuxFaststart(input, outputPath)` — run
  `ffmpeg -i <input> -c copy -movflags +faststart -y <outputPath>`. `FfmpegService` keeps
  exactly these three commands and nothing else
- Create `src/ffmpeg/moov.util.ts` — the pure function
  `hasFaststartLayout(headBytes: Buffer): boolean`, walking the top-level MP4 box sequence and
  reporting whether `moov` precedes `mdat`; the caller supplies the first N bytes via a range
  read. This is box parsing, not an FFmpeg invocation, so it stays out of the service that
  TD-06 scoped to shelling out

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/ffmpeg/ffmpeg.service.spec.ts` | Unit | Error paths against a stubbed `spawn`: non-zero exit rejects with the captured stderr; a timeout aborts the child; malformed ffprobe JSON rejects with `ProbeFailedException`; arguments are passed as an array and a filename containing `;` and spaces is never interpolated into a shell string |
| `src/ffmpeg/ffmpeg.service.integration-spec.ts` | Integration | Against generated fixtures: `probe` reports the exact duration/dimensions/codecs; `extractFrame` writes a valid WebP; `remuxFaststart` produces a head-`moov` file with identical duration and codecs |
| `src/ffmpeg/moov.util.spec.ts` | Unit | `hasFaststartLayout` is `true` for the faststart fixture's head bytes, `false` for the trailing-`moov` one, and rejects a buffer that is not an MP4 |
| `src/ffmpeg/ffmpeg.module.spec.ts` | Unit | Module compiles and exports `FfmpegService` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `probe` on a 3s 320x240 fixture returns `durationSeconds ≈ 3`, `width: 320`,
  `height: 240`, `videoCodec: 'h264'`
- `probe` on a file with no video stream rejects with `ProbeFailedException`
- `extractFrame` at 10% of a 3s clip writes a WebP that ffprobe identifies as a single-frame
  image
- `remuxFaststart` on the trailing-`moov` fixture produces a file whose `moov` atom precedes
  `mdat`, with the same duration and codecs and no re-encode
- `hasFaststartLayout` reports `false` for the trailing-`moov` fixture and `true` once it has
  been remuxed, reading only the file's leading bytes
- A command that exceeds `FFMPEG_TIMEOUT_SECONDS` is killed and rejects rather than hanging
- A file path containing spaces and a `;` is processed correctly and executes nothing beyond
  FFmpeg

---

### SI-03.11 — Video Worker Runtime Topology

**Description:** Boot the worker as a separate Compose service running a second entrypoint
against a standalone Nest application context, so FFmpeg's CPU pressure never competes with
the API's event loop and the two scale independently — while sharing one codebase, one
dependency manifest and one test suite.

**Technical actions:**

- Create `src/worker/worker.module.ts` — a `WorkerModule` importing `ConfigModule.forRoot`
  (same `load` array and Joi schema as `AppModule`), `TypeOrmModule.forRootAsync` (identical
  factory), `TypeOrmModule.forFeature([Video])`, `StorageModule`, `QueueModule`,
  `FfmpegModule` and `TusStoreModule` (the store alone — never `UploadsModule`, which carries
  the HTTP server). It must not import `AppModule`, `AuthModule` or any controller — the
  boundary is what keeps the worker HTTP-free
- Create `src/main.worker.ts` — bootstrap via
  `NestFactory.createApplicationContext(WorkerModule)`, call `enableShutdownHooks()`, and
  register the queue handlers on `onModuleInit`. On `SIGTERM`/`SIGINT`, stop the boss and
  close the context so in-flight jobs finish or are returned to the queue
- Add a `video-worker` service to `nestjs-project/compose.yaml` — same `build` context and
  `Dockerfile.dev` as `nestjs-api`, same bind mount, no published ports, `depends_on` `db`
  (healthy) and `minio` (healthy), plus a named volume `worker-scratch` mounted at
  `WORKER_SCRATCH_DIR` for the remux working files
- Add `WORKER_SCRATCH_DIR` (default `/tmp/streamtube`) and `WORKER_CONCURRENCY`
  (default `1`) to `queue.config.ts`, `env.validation.ts` and `.env.example`. Add
  `start:worker` (`nest start --watch --entryFile main.worker`) and `start:worker:prod`
  (`node dist/main.worker`) scripts to `package.json`
- Document the worker in `nestjs-project/CLAUDE.md`: it is infrastructure and starts with the
  stack, its logs are read with `docker compose logs video-worker`, and it deliberately has
  no HTTP surface

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/worker.module.spec.ts` | Unit | `WorkerModule` compiles standalone; `StorageService`, `QueueService`, `FfmpegService` and `Repository<Video>` all resolve; no controller is registered in the context |

**Dependencies:** SI-03.3, SI-03.6, SI-03.10

**Acceptance criteria:**

- `docker compose up -d` starts `video-worker` and it stays running; `docker compose logs
  video-worker` shows the queue handlers registered and no HTTP listener bound
- `WorkerModule` compiles through `NestFactory.createApplicationContext` without pulling in
  any controller — the standalone context exposes no routes
- Killing `video-worker` leaves the API fully functional: uploads still complete and reach
  `processing`, jobs simply accumulate in `pgboss.job` until the worker returns
- `docker compose up -d --scale video-worker=2` runs two workers and no job is processed twice
- The scratch volume is writable by the `node` user at `WORKER_SCRATCH_DIR`

---

### SI-03.12 — Video Processing Job Handler

**Description:** The heart of the phase: consume `video.process`, authoritatively re-validate
the uploaded bytes with ffprobe, persist the extracted metadata, conditionally remux to
faststart so progressive playback is guaranteed, generate the default thumbnail, and drive the
video to `ready` or `failed` with a machine-readable reason.

**Technical actions:**

- Create `src/worker/video-processing.handler.ts` — `VideoProcessingHandler` injecting
  `Repository<Video>`, `StorageService`, `FfmpegService` and `@Inject(uploadConfig.KEY)`.
  Implement `process({ videoId })`: load the video, call
  `getInternalPresignedUrl(storage_key)` and run `ffprobe` against that URL. It must be the
  **internal** presign: a URL signed for `S3_PUBLIC_ENDPOINT` carries `localhost:9000` in its
  signed `Host`, which inside the worker container points at the worker itself. ffprobe reads
  only the header/index via range requests, so a 10GB source is never downloaded here
- Validate the probe result against `upload.acceptedContainers` and
  `upload.acceptedVideoCodecs` — the authoritative check TD-12 defers to the worker. On
  mismatch, set `status: 'failed'` with `failure_reason` `UNSUPPORTED_CONTAINER`,
  `UNSUPPORTED_VIDEO_CODEC` or `NO_VIDEO_STREAM` and stop; the declared metadata from the tus
  layer is treated as a hint, never as truth
- Persist the probe output onto the video row: `duration_seconds`, `width`, `height`,
  `video_codec`, `audio_codec`, `container`, and the authoritative `size_bytes` and
  `mime_type`
- Range-read the object's leading bytes and pass them to `hasFaststartLayout`; when the
  container is MP4/MOV and the layout is not faststart, download the object into
  `WORKER_SCRATCH_DIR`, run `remuxFaststart`, upload the result to a temporary key, promote it
  onto the original `storage_key` via `copyObject` + `deleteObject`, and remove the scratch
  files in a `finally` block. The promotion touches only `storage_key` — the adjacent
  metadata object the `S3Store` keeps for that upload must not be overwritten. The video keeps
  exactly one `storage_key`, so streaming and download serve the same faststart file
- Extract the thumbnail at `THUMBNAIL_OFFSET_PERCENT` (default `10`) of the duration into
  `thumbnails/{videoId}/auto.webp`, set `thumbnail_key`, then set `status: 'ready'`. Wrap the
  whole handler so any unexpected throw lands the video in `failed` with
  `PROCESSING_FAILED` once pg-boss exhausts `retryLimit`. Register the handler in
  `main.worker.ts` with `batchSize: WORKER_CONCURRENCY`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/video-processing.handler.spec.ts` | Unit | Branch coverage with mocked collaborators: unsupported container → `UNSUPPORTED_CONTAINER`; unsupported codec → `UNSUPPORTED_VIDEO_CODEC`; no video stream → `NO_VIDEO_STREAM`; a faststart layout skips the remux entirely; an ffprobe rejection sets `PROBE_FAILED`; scratch files are removed even when the remux throws |
| `src/worker/video-processing.handler.integration-spec.ts` | Integration | End to end against real MinIO, real Postgres and real FFmpeg using generated fixtures: a faststart MP4 reaches `ready` with exact duration/dimensions and a fetchable thumbnail; a trailing-`moov` fixture is remuxed in place and the stored object gains a head `moov`; an `mpeg4` fixture reaches `failed` with the codec reason and no thumbnail |

**Dependencies:** SI-03.7, SI-03.11

**Acceptance criteria:**

- Completing an upload of a supported 3s fixture drives the video from `processing` to
  `ready` with `duration_seconds ≈ 3`, `width: 320`, `height: 240` and a `thumbnail_key` whose
  object is a fetchable WebP image
- Uploading a source whose declared container passed the tus check but whose real codec is
  `mpeg4` ends in `failed` with `failure_reason: UNSUPPORTED_VIDEO_CODEC` — the ffprobe pass
  overrules the client's declaration
- A trailing-`moov` MP4 is rewritten in place: after processing, the object at `storage_key`
  has its `moov` atom before `mdat`, identical duration and codecs, and no second object
  remains
- A faststart MP4 and a WebM are left byte-identical — no remux runs when it is not needed
- ffprobe reaches the object through the internal storage endpoint — a URL signed for
  `S3_PUBLIC_ENDPOINT` is unreachable from inside the worker container
- Scratch files under `WORKER_SCRATCH_DIR` are removed after every job, success or failure
- A job that throws unexpectedly is retried per `QUEUE_RETRY_LIMIT` with backoff; after the
  final attempt the video is `failed` with `PROCESSING_FAILED`

---

### SI-03.13 — Playback and Download Delivery

**Description:** Serve both delivery capabilities with one mechanism — a short-lived presigned
GET issued after an authorization check, so bytes flow from storage straight to the browser
and neither Node process is in the data plane. Range requests, seeking and resumable
downloads come from the storage layer for free.

**Technical actions:**

- Implement `getPlaybackUrl(publicId, userId)` in `VideosService` — resolve via
  `findByPublicIdForOwner`, reject with `VideoNotReadyException` when `status !== 'ready'`, and
  return `{ url, expires_at }` from `storageService.getPresignedUrl(video.storage_key)` with
  `expiresIn` from `storage.presignedUrlExpirationSeconds`
- Implement `getDownloadUrl(publicId, userId)` in `VideosService` — same authorization path,
  but presign with `downloadFilename: video.original_filename` so storage returns
  `Content-Disposition: attachment`. Return `{ url, expires_at, filename }`
- Add `@Get(':publicId/playback')` and `@Get(':publicId/download')` to `VideosController` —
  both authenticated, both returning 200 with the URL payload. Annotate with
  `@ApiOkResponse`/`@ApiNotFoundResponse`/`@ApiConflictResponse` so they reach `openapi.json`
- Create `src/videos/dto/signed-url-response.dto.ts` for both responses, and record in
  `nestjs-project/CLAUDE.md` that these endpoints return a URL rather than the bytes, and that
  authorization is re-evaluated on every issuance while a leaked URL stays valid until it
  expires

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.integration-spec.ts` | Integration | `getPlaybackUrl` returns a presigned URL for a `ready` video; throws `VideoNotReadyException` for `processing`/`draft`/`failed`; throws `VideoNotFoundException` for another user's video; `getDownloadUrl` sets the disposition filename from `original_filename` |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId/playback` 200 for the owner of a `ready` video and the URL streams with `Range` support; 409 `VIDEO_NOT_READY` while processing; 404 for another user; 401 without a token; `GET /videos/:publicId/download` returns a URL that responds with `Content-Disposition: attachment` |

**Dependencies:** SI-03.8, SI-03.12

**Acceptance criteria:**

- `GET /videos/:publicId/playback` for the owner of a `ready` video returns 200 with
  `{ url, expires_at }`, and fetching that URL with `Range: bytes=0-1023` returns
  `206 Partial Content` — playback starts without downloading the whole file
- `GET /videos/:publicId/playback` for a video in `draft`, `uploading`, `processing` or
  `failed` returns 409 with `VIDEO_NOT_READY` — an unprocessed video is never playable
- `GET /videos/:publicId/playback` for another user's video returns 404 with
  `VIDEO_NOT_FOUND`, indistinguishable from an unknown id
- `GET /videos/:publicId/download` returns a URL whose response carries
  `Content-Disposition: attachment` with the original uploaded filename
- A presigned URL stops working after `PRESIGNED_URL_EXPIRATION_SECONDS` elapses
- The video bytes never transit the NestJS process — the endpoints return only JSON

---

### SI-03.14 — Abandoned Upload and Stale Draft Sweeper

**Description:** Close the loop a resumable protocol opens: uploads that start and never
finish, holding S3 multipart parts and draft rows indefinitely. A scheduled pg-boss job reaps
both sides, backed by a bucket lifecycle rule as a belt-and-braces backstop.

**Technical actions:**

- Create `src/worker/upload-sweep.handler.ts` — `UploadSweepHandler` injecting
  `Repository<Video>`, `@Inject(TUS_STORE)` and `StorageService` — the store, not the tus
  `Server`, so the worker context stays free of any HTTP artifact. Implement `process()`:
  call `store.deleteExpired()` to drop expired S3 multipart uploads, tolerating the `501`
  raised when a store does not implement the expiration extension
- In the same handler, mark stale drafts: `UPDATE videos SET status = 'failed',
  failure_reason = 'UPLOAD_ABANDONED' WHERE status IN ('draft','uploading') AND
  upload_expires_at < now()`, and for each row it transitioned delete both the orphaned object
  at `storage_key` and the adjacent metadata object the `S3Store` writes beside it — **confirm
  the store's actual suffix during implementation rather than assuming it**. Log the count of
  each action
- Register the schedule in `main.worker.ts` — `queueService.ensureQueue('upload.sweep')`
  followed by `queueService.schedule('upload.sweep', UPLOAD_SWEEP_CRON)`, default `0 * * * *`
  (hourly). Add `UPLOAD_SWEEP_CRON` to `queue.config.ts`, `env.validation.ts` and
  `.env.example`
- Extend the `minio-init` service from SI-03.1 with `mc ilm import streamtube-videos` fed a
  lifecycle JSON carrying an `AbortIncompleteMultipartUpload` rule with
  `DaysAfterInitiation: 1`. (`mc ilm rule add --expire-delete-marker` governs versioning
  delete markers and would do nothing here.) This is only the backstop — the primary reaper is
  the tus store's own `deleteExpired()` above

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/upload-sweep.handler.spec.ts` | Unit | A `501` from `store.deleteExpired()` is swallowed, any other error propagates; only rows past `upload_expires_at` are selected; a `processing`/`ready` row is never touched |
| `src/worker/upload-sweep.handler.integration-spec.ts` | Integration | A `draft` row with `upload_expires_at` in the past becomes `failed` with `UPLOAD_ABANDONED` and its object is deleted; a `draft` row still within its window is untouched; a `ready` row is untouched |

**Dependencies:** SI-03.6, SI-03.11, SI-03.12

**Acceptance criteria:**

- A video left in `draft` or `uploading` past `upload_expires_at` becomes `failed` with
  `failure_reason: UPLOAD_ABANDONED` after the sweep runs
- A video still inside its 24-hour window is left untouched by the sweep
- Videos in `processing`, `ready` or already `failed` are never modified by the sweep
- After a swept video is failed, neither the object at its `storage_key` nor the store's
  adjacent metadata object remains in the bucket
- The sweep is registered as a pg-boss cron schedule and appears in `pgboss.schedule`
- Once a user's abandoned upload is swept, `POST /videos/upload-ticket` succeeds again for
  that user

---

### SI-03.15 — OpenAPI Artifact Refresh

**Description:** Regenerate the committed `nestjs-project/openapi.json` so the phase's three
`videos` endpoints and the video enums are in the published contract. Per
`openapi-docs-nestjs/TD-02` the spec is an exported, committed artifact — not a side effect of
running the app — so refreshing it is owned work with its own verification.

**Technical actions:**

- Run `npm run openapi:export` inside the `nestjs-api` container and commit the regenerated
  `nestjs-project/openapi.json`
- Verify the regenerated spec carries `POST /videos/upload-ticket`, `GET /videos/{publicId}`,
  `GET /videos/{publicId}/playback` and `GET /videos/{publicId}/download`, plus the
  `VideoStatus` and `VideoFailureReason` enum schemas that the frontend's generated types will
  depend on
- Record in this phase document — and in `nestjs-project/CLAUDE.md` — that `/uploads` is
  deliberately absent from `openapi.json`: it is raw Express middleware, not a Nest
  controller, so the Swagger plugin cannot see it and the frontend slice must reach it through
  `NEXT_PUBLIC_UPLOAD_URL` rather than through generated types

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/openapi-export.integration-spec.ts` | Integration | The exported document contains the four `videos` paths, the `VideoStatus`/`VideoFailureReason` schemas, and no `/uploads` path |

**Dependencies:** SI-03.13

**Acceptance criteria:**

- `npm run openapi:export` produces an `openapi.json` containing all four `videos` paths with
  their documented response shapes and error statuses
- The exported document exposes `VideoStatus` and `VideoFailureReason` as enum schemas, so a
  consumer generating types gets the literal union rather than a bare `string`
- The exported document contains no `/uploads` path — the tus endpoint's absence is
  intentional and documented, not an oversight
- Re-running the export twice in a row produces no diff — the artifact is deterministic and
  safe for a CI freshness check

_Scope note: syncing the spec into `next-frontend/` (`scripts/sync-openapi.sh`) and
regenerating `lib/api/types.gen.ts` belong to the deferred `phase-03-upload-frontend` slice,
matching this phase's backend-only scope._

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; never exposed over HTTP |
| public_id | varchar(16) | unique, not null | 11-char URL-safe code from `crypto.randomBytes(8).toString('base64url')`; the only identifier in public URLs |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE CASCADE` | Owning side |
| title | varchar(100) | not null | Derived from the uploaded filename at draft creation; editable in Phase 04 |
| description | text | nullable | Filled in Phase 04 |
| status | enum `video_status` | not null, default `'draft'` | `draft`, `uploading`, `processing`, `ready`, `failed` |
| failure_reason | varchar(64) | nullable | Set only with `status = 'failed'`; values from the Failure Reasons table |
| upload_id | varchar(255) | unique, nullable | tus upload identifier; the join key from a tus request back to its video |
| original_filename | varchar(255) | not null | Used for `Content-Disposition` on download |
| storage_key | varchar(512) | nullable | The tus upload id, which **is** the S3 object key (`<uuid>.<ext>`, produced by `namingFunction`); written at `onUploadCreate`; the faststart remux is promoted onto it, so there is only ever one key |
| thumbnail_key | varchar(512) | nullable | `thumbnails/{id}/auto.webp`; overwritten by Phase 04's custom thumbnail |
| mime_type | varchar(100) | nullable | Declared at create, corrected by ffprobe |
| size_bytes | bigint | nullable | Declared at create, authoritative after processing; the driver returns it as a string |
| duration_seconds | numeric(10,3) | nullable | From ffprobe |
| width | integer | nullable | From ffprobe |
| height | integer | nullable | From ffprobe |
| video_codec | varchar(32) | nullable | From ffprobe |
| audio_codec | varchar(32) | nullable | From ffprobe; null when the source has no audio stream |
| container | varchar(32) | nullable | ffprobe `format_name` |
| upload_expires_at | timestamp | nullable | `now + UPLOAD_ABANDONED_EXPIRATION_HOURS` at draft creation; drives the sweep |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`)
**Indexes:** `(public_id)` — unique, `(upload_id)` — unique, `(channel_id)` — FK,
`(status, upload_expires_at)` — composite, for the abandoned-upload sweep

#### Video State Machine

```
draft ──first PATCH──▶ uploading ──onUploadFinish──▶ processing ──▶ ready
  │                        │                            │
  └────────────────────────┴──── sweep ────▶ failed ◀───┘
```

`draft` is written at tus `onUploadCreate`; `uploading` on the first received chunk (a single
guarded `UPDATE`, not one write per chunk); `processing` and the queued job commit together at
`onUploadFinish`; `ready` and `failed` are terminal and written by the worker, except
`UPLOAD_ABANDONED`, which the sweep writes.

#### Failure Reasons

| Value | Written by | Meaning |
|-------|-----------|---------|
| NO_VIDEO_STREAM | Worker | ffprobe found no video stream in the uploaded file |
| UNSUPPORTED_CONTAINER | Worker | Real container is outside `UPLOAD_ACCEPTED_CONTAINERS` |
| UNSUPPORTED_VIDEO_CODEC | Worker | Real video codec is outside `UPLOAD_ACCEPTED_VIDEO_CODECS` |
| PROBE_FAILED | Worker | ffprobe exited non-zero or returned unparsable JSON |
| PROCESSING_FAILED | Worker | Unexpected failure after pg-boss exhausted `QUEUE_RETRY_LIMIT` |
| UPLOAD_ABANDONED | Sweep | Upload never completed before `upload_expires_at` |

---

### API Contracts

#### POST /videos/upload-ticket (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- ticket: string (JWT) — presented in the `Authorization` header of every tus request
- upload_url: string — the browser-reachable tus endpoint (`UPLOAD_PUBLIC_URL`)
- expires_at: string (ISO 8601)

**Error responses:**
- 401: when the access token is missing or invalid
- 409 UPLOAD_ALREADY_IN_PROGRESS: when the caller already has a video in `draft` or `uploading` within its expiry window

---

#### tus endpoint — /uploads (SI-03.6, SI-03.7)

Not a Nest controller: raw Express middleware mounted ahead of the body parser, speaking tus
1.0. It is therefore **outside** `openapi.json`, outside the global `JwtAuthGuard`, and
outside the `{ statusCode, error, message }` error envelope — it returns tus-protocol errors.
The frontend slice consumes it through `NEXT_PUBLIC_UPLOAD_URL`, the one documented exception
to the Strict BFF (`next-frontend-config-base/TD-03`, negotiated in TD-04).

**Methods:** `OPTIONS /uploads`, `POST /uploads`, `HEAD /uploads/:id`, `PATCH /uploads/:id`,
`DELETE /uploads/:id`

**Request headers (all methods):**
- Authorization: Bearer <upload_ticket>
- Tus-Resumable: 1.0.0

**Creation (`POST`) headers:**
- Upload-Length: number — declared total size; must be ≤ `UPLOAD_MAX_SIZE_BYTES`
- Upload-Metadata: base64 key/value pairs — must include `filename` and `filetype`

**Response 201 (creation):** no body; `Location` header points at the upload resource,
`Upload-Expires` carries the abandonment deadline.

**Error responses:**
- 401 INVALID_UPLOAD_TICKET: ticket missing, expired, tampered with, or lacking `scope: 'upload'`
- 403: the ticket's subject does not own the video bound to this upload
- 409 UPLOAD_ALREADY_IN_PROGRESS: the caller already has an upload in flight
- 413 UPLOAD_TOO_LARGE: `Upload-Length` exceeds `UPLOAD_MAX_SIZE_BYTES`
- 415 UNSUPPORTED_MEDIA_TYPE: the declared `filetype`/extension is outside `UPLOAD_ACCEPTED_CONTAINERS`

---

#### GET /videos/:publicId (SI-03.8)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- public_id: string
- title: string
- description: string | null
- status: enum — `draft` | `uploading` | `processing` | `ready` | `failed`
- failure_reason: string | null
- duration_seconds: number | null
- width: number | null
- height: number | null
- original_filename: string
- size_bytes: number | null
- thumbnail_url: string | null — presigned GET, null until processing finishes
- created_at: string (ISO 8601)
- updated_at: string (ISO 8601)

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: unknown `publicId` **or** a video the caller does not own (same response for both)

---

#### GET /videos/:publicId/playback (SI-03.13)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned GET valid for `PRESIGNED_URL_EXPIRATION_SECONDS`; serves HTTP Range
- expires_at: string (ISO 8601)

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller
- 409 VIDEO_NOT_READY: the video's status is not `ready`

---

#### GET /videos/:publicId/download (SI-03.13)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned GET with `response-content-disposition=attachment`
- filename: string — the original uploaded filename
- expires_at: string (ISO 8601)

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller
- 409 VIDEO_NOT_READY: the video's status is not `ready`

#### Validation Rules — Upload Creation (enforced at the tus layer)

| Field | Rule | Rejection |
|-------|------|-----------|
| Authorization | Valid JWT with `scope: 'upload'`, not expired | 401 INVALID_UPLOAD_TICKET |
| Upload-Length | Present and ≤ `UPLOAD_MAX_SIZE_BYTES` (10 GiB) | 413 UPLOAD_TOO_LARGE |
| Upload-Metadata `filename` | Present, non-empty, extension within `UPLOAD_ACCEPTED_CONTAINERS` | 415 UNSUPPORTED_MEDIA_TYPE |
| Upload-Metadata `filetype` | Present, a `video/*` MIME mapping to an accepted container | 415 UNSUPPORTED_MEDIA_TYPE |
| Caller concurrency | No other video in `draft`/`uploading` within its expiry window | 409 UPLOAD_ALREADY_IN_PROGRESS |

The declared values above are advisory — a client can lie. The authoritative check is the
worker's ffprobe pass (SI-03.12), which fails the video with a codec/container reason.

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Role |
|----------|--------|---------------|------|
| POST /videos/upload-ticket | | ✓ | |
| OPTIONS /uploads | ✓ | | tus protocol negotiation only; no upload is addressed |
| POST /uploads | | ✓ | Upload ticket, not access token |
| HEAD/PATCH/DELETE /uploads/:id | | | OWNER of the video bound to the upload, via the ticket's `sub` |
| GET /videos/:publicId | | | OWNER |
| GET /videos/:publicId/playback | | | OWNER, and only when `status = 'ready'` |
| GET /videos/:publicId/download | | | OWNER, and only when `status = 'ready'` |

Every video endpoint is owner-scoped in this phase. Public and `unlisted` visibility arrives
in Phase 04; anonymous watching arrives in Phase 05. Until then, nothing a user uploads is
reachable by anyone else.

**Rate limiting.** Phase 02's `ThrottlerGuard` is registered as an `APP_GUARD`, which is
global regardless of the module declaring it, so every endpoint above inherits the
10-requests-per-minute-per-IP window — **except** `GET /videos/:publicId`, which carries
`@SkipThrottle()` because TD-09's polling contract would otherwise trip it mid-processing
(SI-03.8). The `/uploads` path is unaffected either way: no Nest guard runs on raw Express
middleware.

---

### Error Catalog

The error response format is inherited from `phase-02-auth` and not redefined here. New rows:

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| UPLOAD_ALREADY_IN_PROGRESS | 409 | An upload is already in progress | POST /videos/upload-ticket, or tus creation, when the caller has a video in `draft`/`uploading` within its expiry window |
| INVALID_UPLOAD_TICKET | 401 | Invalid or expired upload ticket | Any tus request with a ticket that is missing, expired, tampered with, or lacking `scope: 'upload'` |
| UPLOAD_TOO_LARGE | 413 | Upload exceeds the maximum allowed size | tus creation with `Upload-Length` above `UPLOAD_MAX_SIZE_BYTES` |
| UNSUPPORTED_MEDIA_TYPE | 415 | Unsupported video format | tus creation whose declared `filename` extension or `filetype` is outside `UPLOAD_ACCEPTED_CONTAINERS` |
| VIDEO_NOT_FOUND | 404 | Video not found | GET /videos/:publicId, /playback or /download with an unknown `publicId` or one owned by another user |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | GET /videos/:publicId/playback or /download when `status !== 'ready'` |

The three tus-layer codes (`INVALID_UPLOAD_TICKET`, `UPLOAD_TOO_LARGE`,
`UNSUPPORTED_MEDIA_TYPE`) are emitted inside tus's own error body rather than the Phase 02
envelope, because the tus path is raw Express middleware outside the global exception filter.
This is an accepted, documented deviation of `phase-02-auth/TD-07`.

---

### Events/Messages

| Event | Payload | Publisher | Consumer | Delivery |
|-------|---------|-----------|----------|----------|
| video.process | `{ videoId: string }` | `UploadsService` (tus `onUploadFinish`), in the same transaction as the `status → processing` update | `VideoProcessingHandler` (video-worker) | ack-required — `retryLimit` `QUEUE_RETRY_LIMIT` (3), `retryBackoff: true`, `expireInSeconds` `QUEUE_EXPIRE_IN_SECONDS` (3600) |
| upload.sweep | `{}` | pg-boss cron schedule (`UPLOAD_SWEEP_CRON`, hourly) | `UploadSweepHandler` (video-worker) | ack-required — `retryLimit` 1, no backoff; a missed run is covered by the next tick |

---

### Environment Variables

| Key | Default | Introduced by |
|-----|---------|---------------|
| S3_ENDPOINT | `http://minio:9000` | SI-03.1 |
| S3_PUBLIC_ENDPOINT | `http://localhost:9000` | SI-03.1 |
| S3_REGION | `us-east-1` | SI-03.1 |
| S3_BUCKET | *(required)* | SI-03.1 |
| S3_ACCESS_KEY_ID | *(required)* | SI-03.1 |
| S3_SECRET_ACCESS_KEY | *(required)* | SI-03.1 |
| S3_FORCE_PATH_STYLE | `true` | SI-03.1 |
| PRESIGNED_URL_EXPIRATION_SECONDS | `900` | SI-03.1 |
| S3_CORS_ALLOW_ORIGIN | `http://localhost:3001` | SI-03.1 |
| QUEUE_SCHEMA | `pgboss` | SI-03.3 |
| QUEUE_RETRY_LIMIT | `3` | SI-03.3 |
| QUEUE_EXPIRE_IN_SECONDS | `3600` | SI-03.3 |
| UPLOAD_MAX_SIZE_BYTES | `10737418240` | SI-03.5 |
| UPLOAD_ACCEPTED_CONTAINERS | `mp4,mov,webm,mkv` | SI-03.5 |
| UPLOAD_ACCEPTED_VIDEO_CODECS | `h264,vp9,av1` | SI-03.5 |
| UPLOAD_ABANDONED_EXPIRATION_HOURS | `24` | SI-03.5 |
| UPLOAD_TICKET_EXPIRATION_HOURS | `2` | SI-03.5 |
| UPLOAD_PART_SIZE_BYTES | `8388608` | SI-03.5 |
| UPLOAD_PUBLIC_URL | `http://localhost:3000/uploads` | SI-03.5 |
| FFMPEG_TIMEOUT_SECONDS | `3600` | SI-03.10 |
| THUMBNAIL_OFFSET_PERCENT | `10` | SI-03.12 |
| WORKER_SCRATCH_DIR | `/tmp/streamtube` | SI-03.11 |
| WORKER_CONCURRENCY | `1` | SI-03.11 |
| UPLOAD_SWEEP_CRON | `0 * * * *` | SI-03.14 |

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
├── SI-03.3
│   └── (with SI-03.6) SI-03.7
├── SI-03.4
│   ├── SI-03.5
│   │   ├── SI-03.6
│   │   │   └── SI-03.7
│   │   └── SI-03.8
│   └── SI-03.8
└── SI-03.6

SI-03.9 (no deps)
└── SI-03.10
    └── SI-03.11  (also needs SI-03.3 and SI-03.6 — WorkerModule imports TusStoreModule)
        └── SI-03.12  (also needs SI-03.7)
            ├── SI-03.13  (also needs SI-03.8)
            │   └── SI-03.15
            └── SI-03.14  (also needs SI-03.6 and SI-03.11)
```

Linearized implementation order:
SI-03.1 → SI-03.2, SI-03.3, SI-03.4, SI-03.9 (parallel) → SI-03.5, SI-03.10 (parallel) →
SI-03.6, SI-03.8 (parallel) → SI-03.7, SI-03.11 (parallel) → SI-03.12 → SI-03.13, SI-03.14
(parallel) → SI-03.15

SI-03.9 and SI-03.10 (FFmpeg toolchain and wrapper) are independent of the upload chain and
can be built in parallel with SI-03.2–SI-03.8 by a second track.

## Deliverables

- [ ] MinIO service in Docker Compose with the `streamtube-videos` bucket, CORS rule and
      abort-incomplete-multipart lifecycle rule created at startup
- [ ] `StorageService` abstracting S3 put/get/head/copy/delete plus presigned GET, with the
      internal/public endpoint split that makes signatures valid from the browser
- [ ] `pg-boss` queue module with transactional enqueue and an ESM-safe provider factory
- [ ] `Video` entity, migration, 11-character opaque `public_id`, and the five-state
      processing machine with machine-readable failure reasons
- [ ] `POST /videos/upload-ticket` issuing a short-lived upload-scoped JWT and enforcing one
      in-flight upload per user
- [ ] tus 1.0 endpoint at `/uploads` backed by S3 multipart, mounted ahead of the body parser,
      accepting resumable uploads up to 10 GiB
- [ ] Draft video pre-registered at upload start; ownership re-verified on every chunk;
      `processing` + `video.process` job committed atomically at upload finish
- [ ] `video-worker` as a separate Compose service on a standalone Nest application context
      with FFmpeg and a scratch volume
- [ ] Automatic processing: ffprobe metadata extraction, authoritative container/codec
      validation, conditional faststart remux promoted onto the original key
- [ ] Automatic thumbnail from a single frame at 10% of the duration, stored as WebP
- [ ] `GET /videos/:publicId` polling contract exposing the live processing status
- [ ] `GET /videos/:publicId/playback` and `/download` returning short-lived presigned URLs —
      Range-capable streaming and attachment download without bytes crossing Node
- [ ] Hourly sweep failing abandoned uploads and reclaiming their storage
- [ ] Status endpoint exempt from Phase 02's global 10 req/min throttle so TD-09's polling
      contract works; every other `videos` endpoint stays limited
- [ ] `nestjs-project/openapi.json` re-exported and committed with the four `videos` paths and
      the video enum schemas (`docker compose exec nestjs-api npm run openapi:export`)
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e -- --runInBand`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
