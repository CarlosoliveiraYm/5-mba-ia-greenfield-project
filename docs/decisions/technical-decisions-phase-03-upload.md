---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-02
scope_description: "Backend side of Phase 03 — object storage service, background job queue and video worker topology, resumable upload transport for files up to 10GB, draft pre-registration and processing state machine, FFmpeg metadata extraction and automatic thumbnail, unique public video URL, and streaming/download delivery. The upload UI (dropzone, progress bar, resume UX) is deferred to a `phase-03-upload-frontend` slice."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that owns every decision in this document: storage service, queue infrastructure, video worker container, tus upload endpoint, video entity/state machine, FFmpeg processing, and signed-URL delivery for streaming and download.
- `next-frontend/` — Frontend UI deferred to a `phase-03-upload-frontend` slice (upload screen, progress/resume UX, player wiring). This document still binds the frontend through five `Cross-layer` TDs (TD-03, TD-04, TD-09, TD-10, TD-11) that define the contract the future UI must consume — the network path of the upload, the tus client protocol, the status polling contract, the public video identifier, and the signed delivery URLs. No frontend-only decision is opened here.

**Inherited constraints (not reopened here):**

- `phase-01-configuracao-base/TD-01..TD-04` — `@nestjs/config` + Joi validation + namespaced `registerAs` configs. Every new env key in this phase follows that shape.
- `phase-02-auth/TD-02` (custom JWT guards), `TD-06` (class-validator DTOs), `TD-07` (custom domain exception filter — the error contract), `TD-08` (`@nestjs/throttler`).
- `openapi-docs-nestjs/TD-02` — `openapi.json` is exported from `nestjs-project` and consumed by the frontend.
- `next-frontend-config-base/TD-03` — Strict BFF: the browser never talks to `nestjs-api` directly; `API_URL` is server-only and `lib/env.ts` declares `client: {}`. TD-04 below is the one place this phase has to negotiate that constraint.
- `next-frontend-openapi-typing/TD-01` — `openapi-typescript` + `openapi-fetch` on the frontend side.
- Runtime baseline: Node 25.6 (`Dockerfile.dev`), NestJS 11, TypeScript 5.9.3 with `module: nodenext` in a **CommonJS** package (no `"type": "module"` in `nestjs-project/package.json`), TypeORM 0.3.28, PostgreSQL 17.

---

## TD-01: Object Storage Backend and Client SDK

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Phase 03 introduces the first binary artifacts in the project (video files up to 10GB and generated thumbnails). The C4 diagram already names the container "Object Storage (S3 or MinIO)", so the family is settled; what is open is which local dev implementation runs in Compose and which client library the API and the worker use to talk to it. This choice propagates into `compose.yaml`, the Joi env schema, `.env.example`, and every code path that writes or reads a video — and it constrains TD-03 (the tus store) and TD-11 (signed URLs).

**Options:**

### Option A: MinIO container + AWS SDK v3 (`@aws-sdk/client-s3`)
- MinIO runs as a Compose service exposing an S3-compatible API; the backend talks to it through the official AWS SDK v3 with `endpoint` and `forcePathStyle: true`. Moving to real S3 later is an env-var change, not a code change.
- **Pros:** The S3 API is the lingua franca — `@tus/s3-store` (TD-03), `@aws-sdk/lib-storage` (multipart uploads) and `@aws-sdk/s3-request-presigner` (TD-11) all assume this client. Modular packages keep the bundle small. Vendor-neutral: MinIO in dev, S3/R2/Backblaze in production with zero code change.
- **Cons:** AWS SDK v3 is verbose (command objects, middleware stack) and its typings are heavy. MinIO's community image has been trimming the built-in web console, so the operator UX in dev is weaker than it used to be (the `mc` CLI or a separate console image covers it).

### Option B: MinIO container + the official `minio` JS SDK
- MinIO publishes its own Node client (`minio@8`) with a smaller, more ergonomic API (`putObject`, `presignedGetObject`, `fPutObject`).
- **Pros:** Much simpler API surface than AWS SDK v3; built-in helpers for presigned URLs and bucket policies; smaller dependency footprint.
- **Cons:** Couples the codebase to MinIO's client. `@tus/s3-store` requires an `S3Client` from the AWS SDK anyway, so choosing this means running **two** storage clients side by side. Migrating to real S3 later becomes a rewrite, not a config change.

### Option C: Local filesystem volume behind a `StorageService` port
- Videos land on a Docker volume; a small `StorageService` interface hides the backend so S3 can be swapped in later.
- **Pros:** Zero new infrastructure; fastest possible local iteration; no signing, no CORS, no endpoint mismatch.
- **Cons:** Defers every hard problem (signed URLs, direct-to-storage delivery, multipart resumability) rather than solving it — exactly the problems Phase 03 exists to solve. The C4 diagram's `frontend → storage (streams)` edge becomes unimplementable. A 10GB file on a bind-mounted volume also punishes the dev machine.

**Recommendation:** **Option A** — the S3 API is a hard prerequisite for the resumable-upload store in TD-03 and the presigned delivery in TD-11, and it is the only option where "MinIO in dev, S3 in production" costs nothing. Option B's ergonomics do not pay for running two clients; Option C postpones the phase's actual difficulty.

**Decision:** A: MinIO container + AWS SDK v3

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-09-02 — Two `S3Client` instances instead of one: `client` on `S3_ENDPOINT` (internal) for reads
  and writes, `presignClient` on `S3_PUBLIC_ENDPOINT` for delivery URLs, plus a third access
  path `getInternalPresignedUrl` for server-side consumers. Rationale: SigV4 signs the `Host`
  header, so a URL signed for the browser-reachable host is invalid from inside the Docker
  network and vice-versa — the worker's ffprobe needs the internal variant.
- 2026-09-02 — Browser CORS is configured through MinIO's cluster-wide `MINIO_API_CORS_ALLOW_ORIGIN`
  (fed by a new `S3_CORS_ALLOW_ORIGIN` key), not per-bucket. Rationale: `mc cors set` is an
  AIStor (paid) feature; the open-source image exposes no per-bucket CORS. The corresponding
  con in TD-11 was corrected in the same pass.

---

## TD-02: Background Job Queue Infrastructure

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram leaves the queue explicitly "TBD". Video processing (ffprobe + thumbnail extraction, possibly a remux — see TD-07) is CPU-heavy and must not block the API request that finishes the upload. The workload profile matters: a handful of long-running jobs (seconds to minutes on large files), not thousands of jobs per second. The choice decides whether a new infrastructure container joins the stack and whether enqueueing can share a transaction with the draft-video insert from TD-09.

**Options:**

### Option A: `pg-boss` on the existing PostgreSQL
- `pg-boss@12` builds a job queue inside the project's Postgres using `SELECT ... FOR UPDATE SKIP LOCKED`, managing its own `pgboss` schema and migrations. Requires Node >= 22.12 (satisfied: Node 25.6). v12 exposes `retryLimit`/`retryBackoff`/`retryDelayMax`, `expireInSeconds`, `heartbeatSeconds` for long-running handlers, dead-letter queues, and `send()` accepting an existing connection.
- **Pros:** No new container, no new backup/monitoring surface. Enqueue can run in the **same transaction** as the draft-video `INSERT`, so a committed draft always has a job and a rolled-back draft never leaves an orphan one — directly serving the "pré-cadastro como rascunho" capability. `heartbeatSeconds` handles handlers that run for minutes. Jobs are inspectable with plain SQL.
- **Cons:** No official NestJS module — the DI wiring (module, `onModuleInit` worker registration, typed job payloads) is hand-rolled (~100 lines). `pg-boss` owns its own schema and runs its own migrations outside TypeORM's migration table, so two migration systems coexist in one database. Postgres is not a high-throughput broker and the `pgboss.job` table needs its retention settings tuned. `pg-boss@12` is also ESM-only (`"type": "module"`, no CJS export), so it carries the same CommonJS/Jest friction this document attributes only to `@tus/*` in TD-03 — that friction is therefore not a differentiator between this option and Option B.

### Option B: BullMQ + Redis (`@nestjs/bullmq`)
- Redis joins Compose; `@nestjs/bullmq@12` provides first-party `@Processor`/`@OnWorkerEvent` decorators, DI-injected queues, and a mature dashboard ecosystem (Bull Board).
- **Pros:** Official NestJS integration — the least amount of custom infrastructure code. Best-in-class feature set (priorities, flows, rate limiting, repeatable jobs, stalled-job recovery). Industry-standard choice for exactly this workload; the most transferable skill. Redis would also be reusable later for distributed throttling or view counters (Phases 05/06).
- **Cons:** Adds a container whose *only* current consumer is the queue, plus its own persistence/eviction configuration to get right (a misconfigured `maxmemory-policy` silently drops jobs). Enqueue cannot be transactional with the Postgres write, so the draft-insert/enqueue pair needs an outbox or a compensating reconciliation job.

### Option C: RabbitMQ + `@nestjs/microservices`
- A real broker with the Nest microservices transport; the worker becomes a Nest microservice consuming from a queue.
- **Pros:** Proper broker semantics (acks, DLX, prefetch), first-party Nest transport, the most faithful "message queue" of the three.
- **Cons:** The heaviest operational footprint of the three for the smallest payoff at this scale. The Nest microservices programming model is a different paradigm from the rest of the codebase. Retry/backoff needs manual DLX plumbing that both alternatives give for free.

**Recommendation:** **Option A (`pg-boss`)** — the transactional enqueue is a genuine correctness win for the draft-then-process flow, and at this workload (a few long jobs, never a burst) the throughput ceiling that motivates Redis is nowhere near. The cost is a hand-rolled Nest module, which is bounded and one-off; the cost of Option B is a permanent extra container for a single consumer. If Redis later enters the stack for other reasons, the queue port keeps the migration contained.

**Decision:** A (`pg-boss`)

**Libraries:** pg-boss

**Revisions:**
- 2026-09-02 — Recorded that `pg-boss@12` is ESM-only, matching `@tus/*`; both are loaded through async
  provider factories using a native dynamic import that bypasses Jest's CommonJS registry.
  Rationale: the option's cons omitted this, which overstated the ESM advantage of `pg-boss`
  over Option B (BullMQ). The choice stands on the transactional-enqueue argument alone.
- 2026-09-02 — The transactional enqueue is placed at the tus `onUploadFinish` hook (`status →
  processing` + `send()` in one transaction), not at draft creation. Rationale: under TD-09 the
  draft row is inserted at `onUploadCreate`, minutes before the upload ends, so the
  "draft INSERT + enqueue in one transaction" framing in this TD's pros does not describe the
  actual flow; the transaction that matters is the one at finish.
- 2026-09-02 — `send()`'s `db` option requires an adapter wrapping TypeORM: pg-boss expects
  `executeSql → { rows }` while `EntityManager.query()` returns the row array directly.

---

## TD-03: Large-File Upload Transport Protocol

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The project plan's Pontos de Atenção is explicit: the 10GB upload must not lock up the system **and must be resumable after a connection failure**. Resumability is a protocol-level property — it cannot be bolted on afterwards — so this is the single decision that shapes both the backend endpoint and the future upload UI. It also determines whether 10GB of bytes transit the Node process at all.

**Options:**

### Option A: tus resumable upload protocol (`@tus/server` + `@tus/s3-store`)
- The browser (`tus-js-client` or Uppy) speaks the tus 1.0 protocol against an endpoint mounted in the Nest app; `@tus/s3-store@2` streams incoming chunks straight into an S3 multipart upload (`partSize` >= 5MiB, part count auto-tuned against the 10,000-part limit — 10GB at 8MiB parts is ~1,280 parts, comfortably inside). Lifecycle hooks (`onUploadCreate`, `onIncomingRequest`, `onUploadFinish`) are where auth, draft creation and job enqueue attach.
- **Pros:** Resumability, chunking and offset negotiation come from an open standard with a maintained server and mature clients — no hand-rolled protocol. `onIncomingRequest` gives a natural place to enforce JWT ownership on every chunk. Bytes are streamed to S3, never buffered whole. Hooks map one-to-one onto TD-09's state machine.
- **Cons:** `@tus/server@2` and `@tus/s3-store@2` are **ESM-only** (`"type": "module"`), while `nestjs-project` is CommonJS. TypeScript 5.9 + `module: nodenext` and Node 25 do support `require()` of ESM, but Jest's CJS module registry does not — the test setup needs `transformIgnorePatterns`/ESM handling or a dynamic `await import()` inside the provider factory. The tus route must also be mounted **before** the body parser, or Nest will consume the chunk stream.

### Option B: S3 multipart upload with presigned part URLs
- The API creates the multipart upload and hands the client a batch of presigned `UploadPart` URLs; the browser PUTs parts directly to MinIO/S3 and calls back to the API to complete the upload.
- **Pros:** Bytes never touch the Node process — the flattest possible resource profile for the API. Resumability comes free (already-uploaded parts are simply not retried). Only the AWS SDK is needed; no ESM/CJS friction.
- **Cons:** The whole orchestration is hand-rolled: part splitting, ETag collection, retries, expiry of presigned URLs mid-upload for a slow 10GB transfer, and cleanup of abandoned multipart uploads. Requires CORS on the storage bucket and a browser-reachable storage endpoint, which is exactly the dev-environment mismatch described in TD-04. No standard client — the frontend slice writes the uploader from scratch.

### Option C: Single streamed `multipart/form-data` through the API
- One `POST` with the file; a streaming parser (busboy) pipes the body into `@aws-sdk/lib-storage`'s `Upload`, which does the S3 multipart internally.
- **Pros:** By far the simplest to build and to consume — a plain `<input type="file">` works. No new protocol, no new client library, no CORS.
- **Cons:** **Not resumable** — a dropped connection at 9.8GB restarts from zero, directly contradicting the project's stated requirement. Also fragile against proxy/body-size limits and gives no reliable progress semantics on retry.

**Recommendation:** **Option A (tus)** — resumability is a stated requirement, and tus is the only option that provides it as a maintained standard rather than as bespoke orchestration. The ESM/CJS friction is real but bounded (a dynamic `import()` in one provider factory plus a Jest transform setting), and it is a smaller ongoing cost than owning the multipart state machine of Option B. Option C fails the requirement outright.

**Decision:** A (tus)

**Libraries:** @tus/server, @tus/s3-store, tus-js-client

**Revisions:**
- 2026-09-02 — The S3 object key is decided by a `namingFunction` returning a flat `<uuid>.<ext>`, and
  `generateUrl` / `getFileIdFromRequest` stay at their defaults. Rationale: in `@tus/server` the
  upload id **is** the stored file name, and a key containing `/` would require overriding both
  of those callbacks; a flat key keeps the surface minimal. `partSize` is 8 MiB (~1,280 parts
  for a 10 GB file, inside the 10,000-part ceiling).

---

## TD-04: Upload Network Path Under the Strict BFF

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `next-frontend-config-base/TD-03` established a Strict BFF: `API_URL` is server-only, `lib/env.ts` declares `client: {}`, and the browser reaches the NestJS API only through Next.js Route Handlers. A 10GB upload cannot reasonably transit that hop — it would stream through the Next.js server process for the entire transfer. This TD decides where the upload bytes actually go and, consequently, whether Phase 03 introduces the project's first browser-visible non-Next origin. It depends on TD-03.

**Options:**

### Option A: Documented BFF exception — browser talks to the tus endpoint directly
- The tus path (e.g. `/uploads`) is exposed on a browser-reachable origin for the NestJS API; the frontend gets its first client-visible env key (e.g. `NEXT_PUBLIC_UPLOAD_URL`). Auth on that path uses a short-lived upload ticket minted by the BFF, not the session cookie. CORS is enabled for that path only.
- **Pros:** Bytes take the shortest path; Next.js stays out of the data plane entirely. tus's own auth hooks (`onIncomingRequest`) do the enforcement. The exception is narrow, explicit and documentable — one path, one env key, one token type.
- **Cons:** Breaks the "browser never sees the API origin" invariant, and adds CORS plus a second token type (the upload ticket) to reason about. Requires the API to be published on a host-reachable URL in dev (`http://localhost:3000`) while server-side code keeps using `http://nestjs-api:3000`.

### Option B: Full proxy — upload streams through a Next.js Route Handler
- The BFF exposes `/api/uploads/*` and forwards every tus request to the API, preserving the invariant.
- **Pros:** Zero architectural exception; the session cookie keeps working unchanged; no CORS, no new env key, no second token type.
- **Cons:** Every uploaded byte crosses two Node processes; the Next.js server becomes a throughput bottleneck and a memory risk on concurrent 10GB uploads. Route Handlers need explicit streaming (no body buffering) and their own timeout/limit tuning. Doubles the surface where a stalled stream can wedge.

### Option C: Direct-to-storage — browser uploads straight to MinIO/S3
- Only viable with TD-03 Option B: the browser PUTs presigned parts to the storage endpoint; neither Next.js nor Nest sees the bytes.
- **Pros:** Optimal data path; matches the C4 diagram's `frontend → storage` edge; both application processes stay idle during the transfer.
- **Cons:** Locks TD-03 into Option B with all its hand-rolled orchestration. In dev, the API signs URLs against `http://minio:9000` while the browser must reach `http://localhost:9000` — the host mismatch invalidates the SigV4 signature unless the storage endpoint is aliased identically inside and outside Compose. Bucket-level CORS must be configured.

**Recommendation:** **Option A** — a narrow, documented exception scoped to a single path is cheaper than making the BFF a 10GB data pipe (Option B) or than accepting Option C's coupling to a hand-rolled protocol and its dev-endpoint signature trap. Record it explicitly as a deviation from `next-frontend-config-base/TD-03`, with the upload ticket (not the session cookie) as the credential so the BFF stays the only holder of the session.

**Decision:** A: Documented BFF exception

**Revisions:**
- 2026-09-02 — The "short-lived upload ticket" named in Option A is specified as a JWT carrying
  `{ sub, scope: 'upload', jti }`, signed with the existing access-token secret and expiring in
  `UPLOAD_TICKET_EXPIRATION_HOURS` (2h), minted by `POST /videos/upload-ticket` and verified in
  the tus hooks. Rationale: the option named the credential but never defined it. It carries no
  `videoId` because the draft row is only created at `onUploadCreate`, after the ticket is
  issued; per-chunk ownership is instead resolved by joining `uploadId → video.channel → user`.

---

## TD-05: Video Worker Runtime Topology

**Scope:** Backend

**Capability:** Transversal — covers: `Serviço de processamento em segundo plano (filas)`, `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** The C4 diagram shows "Video Worker (FFmpeg)" as a container distinct from the API. FFmpeg is a CPU-saturating child process; where it runs determines whether a transcode can starve the API's event loop and whether the FFmpeg binary has to be baked into the API image. This decision also sets how much of the Nest DI graph (TypeORM repositories, config, storage service) the worker can reuse.

**Options:**

### Option A: Separate Compose service, same codebase, standalone Nest application context
- A `video-worker` service built from the same `nestjs-project` image runs a different entrypoint (`main.worker.ts`) that boots a `NestFactory.createApplicationContext()` with a `WorkerModule`, registers the pg-boss/BullMQ handlers, and exits the HTTP layer entirely.
- **Pros:** Matches the documented architecture. FFmpeg CPU pressure is isolated from the API container and independently scalable (`--scale video-worker=N`). Full reuse of entities, config, and the storage service through normal DI — no duplicated code, one `package.json`, one test suite. Only the worker image needs the FFmpeg binary.
- **Cons:** A second container and a second entrypoint to keep healthy; module boundaries must be kept honest so the worker does not transitively import HTTP controllers. Slightly more complex local startup and log aggregation.

### Option B: In-process worker inside the API container
- The API boots the queue handlers in the same process as the HTTP server.
- **Pros:** Simplest possible setup — one container, one entrypoint, nothing new in Compose.
- **Cons:** A long FFmpeg run competes with request handling for CPU and file descriptors; a worker crash takes the API down with it. Contradicts the architecture diagram. Scaling the API and the processing capacity becomes the same knob. FFmpeg must be installed in the API image.

### Option C: Standalone Node project (`video-worker/`) outside the Nest app
- A third subproject with its own `package.json`, consuming the queue and talking to Postgres/S3 directly.
- **Pros:** Maximum isolation; the worker can be a lean image with no Nest runtime; free to use ESM natively (which would neutralize TD-03's ESM/CJS friction for its own dependencies).
- **Cons:** Duplicates entity definitions, migrations awareness, config parsing and test infrastructure across two projects — or forces a shared `packages/*` workspace, a monorepo-tooling decision this phase does not need to open. Highest maintenance cost for a marginal isolation gain over Option A.

**Recommendation:** **Option A** — it delivers the isolation the architecture asks for while keeping a single codebase, a single dependency manifest and a single test suite. Option C's extra isolation does not justify duplicating the domain model; Option B trades away the one property (protecting the API from FFmpeg) the phase most needs.

**Decision:** A: Separate Compose service

---

## TD-06: FFmpeg/FFprobe Invocation and Binary Provisioning

**Scope:** Backend

**Capability:** Transversal — covers: `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** Metadata extraction and thumbnail generation both shell out to the FFmpeg toolchain. Two things need deciding together: how the Node code invokes it, and where the binary comes from in the worker image. The wrapper choice matters more than usual right now because the historical default has been retired.

**Options:**

### Option A: Direct `child_process.spawn` behind a thin typed service, binaries from the image (`apt install ffmpeg`)
- A small `FfmpegService` builds argument arrays and spawns `ffprobe -v quiet -print_format json -show_format -show_streams` / `ffmpeg -ss ... -frames:v 1 ...`, parsing ffprobe's JSON output into a typed result. The Debian-slim worker image installs `ffmpeg` via apt.
- **Pros:** No unmaintained dependency; full control over arguments, timeouts (`AbortSignal`), stderr capture and progress parsing. `ffprobe`'s JSON output is a stable, documented contract and maps cleanly onto a typed DTO. Argument arrays (never a shell string) make command injection from filenames a non-issue. The binary version is pinned by the image, identical in CI and dev.
- **Cons:** Roughly 100–150 lines of wrapper written by hand (spawn, timeout, exit-code handling, JSON parse). Image size grows by the FFmpeg apt tree (~100–200MB). Progress reporting requires parsing stderr if it is ever wanted.

### Option B: `fluent-ffmpeg`
- The long-standing fluent-API wrapper (`ffmpeg().input(...).screenshots(...)`).
- **Pros:** The most familiar API in the Node ecosystem, with abundant examples; `ffprobe()` returns a parsed metadata object out of the box.
- **Cons:** **The project was archived and phased out by its maintainers in 2025**; no releases in over a year and known incompatibilities with recent FFmpeg builds. Adopting a dead dependency at the foundation of a phase is a liability, and its callback-based API needs promisifying anyway.

### Option C: npm-provided binaries (`ffmpeg-static` + `@ffprobe-installer/ffprobe`) + `spawn`
- Same invocation strategy as Option A, but the binaries arrive as npm packages resolved at install time.
- **Pros:** No apt layer; binary version is pinned in the lockfile alongside the code; works identically on a developer's host outside Docker.
- **Cons:** Adds ~80MB of platform-specific binaries to `node_modules`, downloaded at install and re-downloaded in CI. Postinstall binary downloads are a supply-chain surface and a common CI failure mode behind proxies. Redundant when the runtime is already a controlled Docker image.

**Recommendation:** **Option A** — a hand-written `spawn` wrapper over apt-installed binaries is the only option that is both maintained and reproducible. Option B is archived; Option C's convenience is wasted when the worker always runs from a controlled image. The wrapper stays small because the phase needs exactly two commands: one ffprobe, one frame extraction.

**Decision:** A: Direct 

**Revisions:**
- 2026-09-02 — Detecting whether the `moov` atom precedes `mdat` is implemented as a pure MP4
  box-parsing helper (`hasFaststartLayout`), outside `FfmpegService`. Rationale: it is not an
  FFmpeg invocation, and this option's premise is a wrapper holding exactly the commands the
  phase needs — one ffprobe, one frame extraction, one stream-copy remux.

---

## TD-07: Post-Upload Normalization Policy

**Scope:** Backend

**Capability:** Transversal — covers: `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Reprodução via streaming (sem necessidade de download completo)`

**Context:** What the worker actually does to the uploaded bytes is a strategic trade-off between CPU cost, storage cost and playback compatibility. It is coupled to TD-11: progressive playback of an MP4 requires the `moov` atom at the head of the file, and many camera/editor exports place it at the end — such a file will not start playing until it is fully downloaded, which is precisely what the "streaming sem download completo" capability forbids. A 10GB source makes a full transcode a multi-hour, multi-gigabyte proposition.

**Options:**

### Option A: Metadata-only, with conditional faststart remux
- The worker runs ffprobe for duration/dimensions/codecs, and only when the container is MP4/MOV with a trailing `moov` atom does it run a stream-copy remux (`-c copy -movflags +faststart`). No re-encode ever.
- **Pros:** Remux is I/O-bound and near-instant relative to a transcode; a 10GB file is rewritten once at disk speed instead of being re-encoded for hours. Guarantees the progressive-playback precondition that TD-11 depends on. No quality loss, no second storage copy of a re-encoded rendition.
- **Cons:** Does nothing for codecs the browser cannot decode (e.g. an H.265 or ProRes source plays nowhere) — those uploads fail at playback time rather than at processing time. Still writes a full second copy to storage during the remux window.

### Option B: Always transcode to a normalized rendition (H.264/AAC MP4, capped at 720p)
- Every upload is re-encoded to one guaranteed-playable rendition; the original may be kept for the download capability.
- **Pros:** Playback works for every source format and codec. Predictable storage per video and dramatically smaller delivery files. This is what a real platform does.
- **Cons:** Hours of CPU for a large source, on a worker that has no GPU. Either doubles storage (original + rendition) or destroys the "download do vídeo" fidelity by discarding the original. Turns a minutes-long "processing" state into an hours-long one, which reshapes the whole UX of TD-09.

### Option C: No processing beyond metadata extraction
- ffprobe only; the uploaded bytes are served exactly as received.
- **Pros:** Cheapest and fastest possible pipeline; nothing to go wrong; storage is exactly the upload size.
- **Cons:** Leaves the trailing-`moov` case broken, so the streaming capability is satisfied only by luck of the source file. Silently produces videos that appear to hang before playback.

**Recommendation:** **Option A** — it buys the streaming guarantee (the phase's stated requirement) for near-zero CPU, and leaves transcoding as a later, well-scoped addition if incompatible codecs ever become a real problem. Option B's cost is disproportionate for a phase whose deliverable is "streaming funcionando", not adaptive bitrate; Option C leaves a requirement to chance. Pair it with a whitelist of accepted codecs at validation time (TD-12) so unplayable sources fail loudly and early.

**Decision:** A: Metadata-only

**Revisions:**
- 2026-09-02 — The faststart remux is promoted **onto the original storage key** (written to a
  temporary key, then copied over and the temporary deleted), so a video always has exactly one
  object and the download capability serves the same faststart file as streaming. Rationale: the
  option acknowledged "writes a full second copy" without saying where it lands; keeping two
  renditions would double storage for every remuxed upload with no consumer for the original.

---

## TD-08: Automatic Thumbnail Generation Policy

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The capability says "a partir de um frame" — one frame — but the frame-selection rule, the output format and how many artifacts are produced are open. Phase 04 later adds user-supplied custom thumbnails, so whatever is generated here must be an overridable default, not the only thumbnail a video can have. Format and dimensions become a stored contract consumed by every listing surface from Phase 04 onward.

**Options:**

### Option A: One frame at a fixed offset, one stored image
- Seek to a fixed percentage of the duration (e.g. 10%, avoiding black lead-in frames), extract one frame with `-frames:v 1`, encode to WebP (with a JPEG fallback if broad compatibility is wanted), store as `thumbnails/{videoId}/auto.webp`.
- **Pros:** Exactly what the capability asks for, in one FFmpeg invocation of a second or two thanks to input-side seeking. One artifact, one storage key, one column on the entity — trivial for Phase 04 to override. Deterministic and easy to assert in tests.
- **Cons:** A fixed offset occasionally lands on a poor frame (a transition, a black frame). The user has no choice until Phase 04 gives them the custom-upload path.

### Option B: N candidate frames, user picks one later
- Extract 3 frames (25%/50%/75%), store all, mark one as default; Phase 04's editing UI lets the user promote another.
- **Pros:** Materially better odds of at least one good frame; matches what real platforms offer; the extra CPU is negligible since seeking dominates.
- **Cons:** Triples the stored artifacts and turns a single column into a collection plus a "selected" pointer — a data-model cost paid in this phase for a UI that only arrives in Phase 04. Phase 04 already delivers custom upload, which subsumes most of the benefit.

### Option C: Scene-change detection picks the "best" frame
- Use FFmpeg's `select='gt(scene,0.4)'` filter to pick a representative keyframe.
- **Pros:** Usually produces the most visually meaningful thumbnail with no user involvement.
- **Cons:** Requires decoding a substantial portion of the file — on a 10GB source that is minutes of CPU, not seconds, and the cost scales with file size. Non-deterministic output makes tests awkward. Disproportionate for a default that Phase 04 lets the user replace anyway.

**Recommendation:** **Option A** — one frame at a fixed offset is literally the capability, costs a second of CPU with input-side seeking, and keeps the data model at one nullable column that Phase 04's custom thumbnail simply overwrites. Option B pre-pays a modeling cost for a picker that Phase 04 makes redundant; Option C's scan cost is unacceptable at 10GB.

**Decision:** A: One frame at a fixed offset

---

## TD-09: Video State Machine and Processing-Status Contract

**Scope:** Cross-layer

**Capability:** Transversal — covers: `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`, `Processamento automático do vídeo após upload (extração de duração e metadados)`

**Context:** The draft row is created when the upload *starts*, and processing finishes some time after the upload *ends* — so the video has a lifecycle that both the backend and the future upload UI must agree on. Two things are decided here: the set of states and their transitions, and how the client learns that processing finished. This is the contract that TD-03's tus hooks write into and that the frontend slice will poll; it also lands in `openapi.json` and therefore in the generated frontend types.

**Options:**

### Option A: `status` enum column + client polling on `GET /videos/:id`
- States: `draft` (row created at upload start) → `uploading` → `processing` (job enqueued at tus `onUploadFinish`) → `ready` | `failed`. The client polls the video resource every few seconds while the status is non-terminal. `failed` carries a machine-readable reason.
- **Pros:** No new transport, no new infrastructure; a plain REST resource already covered by the OpenAPI export and by MSW handlers on the frontend. Trivially testable end-to-end. Survives page reloads and works identically for a user who returns hours later. Terminal state is durable in the database, not dependent on a live connection.
- **Cons:** Polling latency (seconds) and wasted requests on long jobs. Needs a sensible backoff so a forgotten open tab does not hammer the API.

### Option B: `status` column + Server-Sent Events stream
- Same states, but the client subscribes to `GET /videos/:id/events` and the API pushes transitions.
- **Pros:** Near-instant feedback with no polling waste; SSE is plain HTTP and needs no new protocol on the client.
- **Cons:** Requires the API to learn about worker-side transitions — Postgres `LISTEN/NOTIFY` or a queue event fan-out — which is new infrastructure inside the API. Long-lived connections complicate the BFF hop (TD-04) and the throttler. Reconnect/resume logic still needs the polling fallback anyway, so it is additive complexity, not a replacement.

### Option C: `status` column + WebSocket gateway
- A `@nestjs/websockets` gateway pushes per-video updates.
- **Pros:** Bidirectional channel reusable for Phase 06's social features.
- **Cons:** The heaviest option: a new transport, a new auth path for the socket handshake, sticky-session concerns if the API ever scales, and a second protocol to mock in tests — all for a status change that happens once or twice per upload.

**Recommendation:** **Option A** — the phase has no realtime requirement, and a durable `status` column plus polling is the only option that costs nothing on either side of the contract while remaining correct across reloads and long absences. Keep the state names and the `failed` reason codes as the canonical contract; SSE can be layered on later without changing them.

**Decision:** A: `status` enum column

**Revisions:**
- 2026-09-02 — The polling endpoint (`GET /videos/:publicId`) carries `@SkipThrottle()`. Rationale:
  `phase-02-auth/TD-08`'s `ThrottlerGuard` is registered as an `APP_GUARD`, which is global
  regardless of the declaring module, so the 10 req/min window would otherwise apply — and this
  option's contract has the client polling every few seconds, which trips it mid-processing.
  Every other `videos` endpoint stays throttled.

---

## TD-10: Public Video Identity and Unique URL

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a short, collision-free public identifier that appears in the URL the user shares. The choice decides the entity's primary-key strategy, the shape of every video route in the API and in Next.js, and whether video IDs are enumerable by an attacker — which matters directly for the `unlisted` visibility that Phase 04 introduces. Note a stack constraint: `nanoid@6` is ESM-only and `nestjs-project` is CommonJS.

**Options:**

### Option A: Internal UUID primary key + separate public short-code column
- The entity keeps a `uuid` PK for relations; a unique, indexed `publicId` column holds an 11-character URL-safe code. Generated either with `nanoid@3` (last CommonJS line) or with three lines of `crypto.randomBytes(8).toString('base64url')` — no dependency at all.
- **Pros:** Short, opaque, unguessable URLs (~64 bits of entropy at 11 chars — collision risk is negligible and a unique index catches the impossible case). Public identifier is decoupled from the storage key, so it can be regenerated or re-shaped without touching foreign keys. Directly supports Phase 04's `unlisted` requirement, which depends on IDs being unguessable. The `crypto` variant sidesteps the nanoid ESM/CJS problem entirely.
- **Cons:** Two identifiers per video — every query path must be explicit about which one it takes, and the API must consistently expose only the public one. One extra unique index.

### Option B: UUID v7 as both primary key and public identifier
- A single time-ordered UUID serves as PK and URL segment (`/watch/0192f3a1-...`).
- **Pros:** One identifier, zero ambiguity. Time-ordered, so B-tree index locality is good on insert. Generated with `uuid@14`'s `v7()` or in the database.
- **Cons:** 36 characters in every shared URL — the opposite of the "URL curta e única" the project plan asks for. UUIDv7 embeds a millisecond timestamp, leaking creation time and making near-simultaneous uploads partially guessable, which weakens `unlisted` in Phase 04.

### Option C: Title slug + short disambiguating suffix
- `/watch/meu-video-de-ferias-a1b2c3`, derived from the title at publish time.
- **Pros:** Human-readable and SEO-friendly.
- **Cons:** The title is editable in Phase 04, so either the URL breaks or slugs are frozen and drift from the title. Requires normalization rules for accents/emoji/collisions. Readability actively harms `unlisted`, whose whole point is that the URL reveals nothing. Most complexity for the least benefit at this stage.

**Recommendation:** **Option A** — it is the only option that yields a short *and* opaque URL, and opacity is a prerequisite for the `unlisted` visibility already committed to in Phase 04. Prefer the dependency-free `crypto.randomBytes(...).toString("base64url")` generator over `nanoid@3` so the phase adds no ESM-constrained dependency for eleven characters.

**Decision:** A: Internal UUID primary key

---

## TD-11: Video Delivery — Streaming and Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: `Reprodução via streaming (sem necessidade de download completo)`, `Download do vídeo pelo usuário`

**Context:** Both capabilities are the same problem seen twice: how bytes get from storage to the browser, with the API deciding *who* is allowed and the transport deciding *how*. Authorization matters already in this phase — a video in `draft`/`processing` must not be playable — and matters more in Phase 04, where `unlisted` and visibility rules arrive. The C4 diagram draws `frontend → storage (streams)`, and TD-01 chose an S3-compatible backend, so signed URLs are available.

**Options:**

### Option A: Short-lived presigned GET URLs issued by the API, browser fetches storage directly
- `GET /videos/:publicId/playback` performs the authorization check and returns a presigned URL valid for minutes; `<video src>` points at storage, which serves HTTP Range requests natively. Download uses the same mechanism with `response-content-disposition=attachment` and the original filename, on a separately scoped endpoint.
- **Pros:** Byte traffic never touches Node — neither the API nor the BFF is in the data plane, which is what "sem impacto na performance" means at delivery time. Range requests, seeking and resumable downloads come free from the storage layer. Authorization stays server-side and re-checked on every URL issuance; short expiry bounds link leakage. Maps exactly onto the architecture diagram. One mechanism serves both capabilities via the disposition parameter.
- **Cons:** Introduces a browser-reachable storage origin with the same dev endpoint/signature mismatch described in TD-04 (`minio:9000` inside Compose vs `localhost:9000` from the host) — the endpoint must be aliased consistently or signed against the external host. A leaked URL is valid until it expires. The browser origin must be allowed by MinIO's cluster-wide `MINIO_API_CORS_ALLOW_ORIGIN` — per-bucket CORS (`mc cors set`) is an AIStor-only feature and is not available on the open-source image.

### Option B: API proxies the bytes with Range support
- `GET /videos/:publicId/stream` reads the object from storage and pipes it to the response, forwarding `Range` and returning `206 Partial Content`; download is the same handler with `Content-Disposition: attachment`.
- **Pros:** Authorization is enforced per byte-range request, not just at URL issuance, so revocation is immediate. No CORS, no presigned URLs, no dev endpoint mismatch — the storage stays entirely private. Simplest possible frontend integration under the Strict BFF.
- **Cons:** Every watching viewer occupies a Node stream for the duration of playback; concurrent viewers of large files are exactly the load profile Node handles worst. Correct `Range`/`206`/`Content-Range` handling is fiddly to implement and easy to get subtly wrong (Safari is unforgiving). Contradicts the architecture diagram.

### Option C: HLS — worker segments the video, player uses hls.js
- Processing produces an HLS ladder; delivery serves `.m3u8` + segments from storage.
- **Pros:** Adaptive bitrate, fast start, the actual industry standard for video at scale; segments are cache- and CDN-friendly.
- **Cons:** Requires the full transcode rejected in TD-07, multiplying CPU and storage. Needs a JS player library (`hls.js`) rather than a plain `<video>`, and per-segment authorization is a harder problem than one signed URL. Phase 05 specifies only basic controls (play/pause, volume, progress) — there is no adaptive-bitrate requirement anywhere in the plan.

**Recommendation:** **Option A** — it satisfies both capabilities with one mechanism, keeps 10GB files out of both Node processes, and is what the architecture diagram already prescribes. The dev endpoint mismatch is a one-time Compose/env fix (alias the storage host identically inside and outside the network) and is the same fix TD-04 may already require. Option B is the safer fallback if the endpoint aliasing proves painful; Option C is out of scope until adaptive bitrate is an actual requirement.

**Decision:** A: Short-lived presigned 

**Revisions:**
- 2026-09-02 — Authorization for this phase is owner-only: the caller must be authenticated, own the
  video's channel, and the video must be in `ready`. Rationale: the option's Context flagged that
  authorization matters but decided no rule; public and `unlisted` visibility only arrive in
  Phase 04 and anonymous watching in Phase 05, so nothing is reachable by a third party until
  those land.
- 2026-09-02 — Corrected the CORS clause in this option's cons: per-bucket CORS is AIStor-only, so the
  browser origin is allowed via MinIO's cluster-wide `MINIO_API_CORS_ALLOW_ORIGIN` (see TD-01).

---

## TD-12: Upload Limits, Accepted Formats and Abandoned-Upload Policy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** "Até 10GB" is a limit that has to be enforced somewhere, and a resumable protocol creates a second problem the non-resumable ones do not: uploads that are started and never finished, holding S3 multipart parts and draft rows indefinitely. The accepted-format whitelist is also load-bearing after TD-07 chose not to transcode — an unplayable codec must be rejected rather than silently stored. These values are a cross-component contract: they live in the Joi env schema, in the tus server config, in `.env.example`, and in the validation the future upload UI must mirror.

**Options:**

### Option A: Enforce at the tus layer on create, re-validate in the worker after upload
- `maxSize` and `onUploadCreate` metadata validation reject an over-limit or wrong-typed upload before a single byte is transferred (declared size and MIME type come in `Upload-Length`/`Upload-Metadata`); the worker then re-validates the *actual* container and codecs with ffprobe and moves the video to `failed` with a reason if the source lied. Abandoned uploads are swept by `expirationPeriodInMilliseconds` on the S3 store plus a scheduled job that expires stale drafts.
- **Pros:** Fails fast on the client's declared intent (no wasted transfer) while still trusting nothing — the ffprobe pass is the authoritative check, and it is free because the worker already runs ffprobe for TD-07. Cleanup is built into the store, not hand-rolled. Every value is a config key, so limits are tunable per environment without a deploy.
- **Cons:** Two validation points to keep consistent. The scheduled sweep is one more job to write and monitor. The declared-size check is advisory only — the real ceiling is still whatever storage accepts.

### Option B: Enforce only after the fact, in the worker
- Accept anything; ffprobe decides, and invalid uploads are marked `failed` and deleted.
- **Pros:** One validation point, zero duplication; the only check is the authoritative one.
- **Cons:** A user can transfer 40GB before being told no — the worst possible feedback loop and a trivial resource-exhaustion vector. No protection for storage costs.

### Option C: Enforce at the edge (reverse proxy / storage bucket policy)
- Body-size limits in a proxy in front of the API, plus bucket lifecycle rules for abandoned multipart uploads.
- **Pros:** Keeps limits out of application code; bucket lifecycle rules are the canonical way to reap abandoned multipart uploads.
- **Cons:** Chunked resumable uploads defeat a per-request body-size limit — each tus PATCH is small, so the proxy never sees the total. No proxy exists in the stack today. Error responses bypass the phase-02 error contract.

**Recommendation:** **Option A** — declared-value rejection at create plus authoritative ffprobe validation after the fact is the standard tus pattern, and the second check costs nothing because the worker already probes the file. Adopt the bucket lifecycle rule from Option C as a belt-and-braces backstop for abandoned multipart parts. Suggested starting values to confirm at decision time: `UPLOAD_MAX_SIZE_BYTES=10737418240` (10GiB), accepted containers MP4/MOV/WebM/MKV with H.264/VP9/AV1 video, abandoned-upload expiry 24h, one concurrent in-flight upload per user.

**Decision:** A: Enforce at the tus layer on create

**Revisions:**
- 2026-09-02 — The values this option left as "suggested starting values to confirm at decision time"
  are confirmed: `UPLOAD_MAX_SIZE_BYTES=10737418240` (10 GiB); accepted containers MP4/MOV/WebM/
  MKV; accepted video codecs H.264/VP9/AV1; abandoned-upload expiry 24h; one concurrent
  in-flight upload per user. All become config keys, tunable per environment.
- 2026-09-02 — The bucket-side backstop is an `AbortIncompleteMultipartUpload` lifecycle rule applied
  with `mc ilm import` (`DaysAfterInitiation: 1`). Rationale: the borrowed "Option C lifecycle
  rule" was not otherwise specified, and the nearest `mc ilm rule add` flag governs versioning
  delete markers, not abandoned multipart uploads.

---

## TD-13: Video Fixture Strategy for the Test Suite

**Scope:** Backend

**Capability:** Transversal — covers: `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** The project's Definition of Done requires the full suite to pass, and the existing integration tests run against real services from the Compose stack (real Postgres via `createTestDataSource`, real Mailpit via `src/test/mailpit.ts`) rather than mocks. Extending that pattern to video processing needs real video files with known duration and dimensions — and the naive answer, committing sample videos, puts binary blobs in a Git history that can never be shrunk.

**Options:**

### Option A: Generate fixtures at test setup with FFmpeg's synthetic sources
- A `src/test/video-fixtures.ts` helper builds files on demand: `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=10 -f lavfi -i sine -c:v libx264 ...`, plus a variant with a trailing `moov` atom to exercise TD-07's remux branch. Files are written to a temp dir and removed afterwards.
- **Pros:** Zero bytes in Git. Duration, resolution, codec and frame content are exact by construction, so assertions are precise instead of magic numbers copied from a file. Trivially parameterizable — an edge case is a new argument, not a new committed asset. FFmpeg is already in the worker image (TD-06), so there is no new dependency.
- **Cons:** A second or two of generation per fixture, so it must be memoized per test run. Ties the test suite to the FFmpeg binary being present wherever tests execute (true in the worker/CI image, not necessarily on a bare host).

### Option B: Commit small pre-made fixture files
- A handful of tiny `.mp4`/`.mkv` files under `src/test/fixtures/`.
- **Pros:** Dead simple, instant, no FFmpeg needed to run the tests; the exact bytes are reviewable and stable forever.
- **Cons:** Binary blobs enter Git history permanently, and every new edge case (trailing `moov`, unsupported codec, zero-duration file, corrupt header) adds another. Assertions become magic constants tied to opaque files. Tempting to grow into multi-MB assets.

### Option C: Mock the FFmpeg service entirely in tests
- Unit-test the wrapper against a stubbed `spawn`, and stub `FfmpegService` everywhere else.
- **Pros:** Fastest suite; no binaries anywhere; total determinism.
- **Cons:** Never exercises the actual command lines or ffprobe's real JSON shape — precisely where the bugs live in this phase, and precisely what the project's real-services testing convention exists to avoid. Would still need Option A or B for at least one end-to-end confidence test.

**Recommendation:** **Option A** — generated fixtures keep the repository clean while giving stronger assertions than committed files, and they extend the project's existing "test against the real thing" convention to video without importing its usual cost. Keep Option C's stubbed-`spawn` unit tests for the wrapper's error paths (non-zero exit, timeout, malformed JSON), where a real binary adds nothing.

**Decision:** A: Generate fixtures

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object storage backend and client SDK | A — MinIO container + AWS SDK v3 | A — MinIO + AWS SDK v3 |
| TD-02 | Backend | Background job queue infrastructure | A — `pg-boss` on the existing PostgreSQL | A — `pg-boss` |
| TD-03 | Cross-layer | Large-file upload transport protocol | A — tus (`@tus/server` + `@tus/s3-store`) | A — tus |
| TD-04 | Cross-layer | Upload network path under the Strict BFF | A — documented BFF exception, browser → tus endpoint | A — documented BFF exception |
| TD-05 | Backend | Video worker runtime topology | A — separate Compose service, same codebase | A — separate Compose service |
| TD-06 | Backend | FFmpeg/FFprobe invocation and binary provisioning | A — `spawn` wrapper + apt-installed binaries | A — direct `spawn` wrapper |
| TD-07 | Backend | Post-upload normalization policy | A — metadata-only + conditional faststart remux | A — metadata-only + conditional remux |
| TD-08 | Backend | Automatic thumbnail generation policy | A — one frame at a fixed offset | A — one frame at a fixed offset |
| TD-09 | Cross-layer | Video state machine and processing-status contract | A — `status` enum + client polling | A — `status` enum + polling |
| TD-10 | Cross-layer | Public video identity and unique URL | A — UUID PK + 11-char opaque public code | A — UUID PK + public short code |
| TD-11 | Cross-layer | Video delivery — streaming and download | A — short-lived presigned GET URLs | A — short-lived presigned GET |
| TD-12 | Backend | Upload limits, accepted formats, abandoned uploads | A — tus-level create checks + ffprobe re-validation | A — enforce at the tus layer on create |
| TD-13 | Backend | Video fixture strategy for the test suite | A — generate fixtures with FFmpeg at test setup | A — generate fixtures |
