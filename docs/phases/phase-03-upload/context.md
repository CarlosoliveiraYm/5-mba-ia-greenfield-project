---
kind: phase
name: phase-03-upload
sources_mtime:
  docs/project-plan.md: "2026-08-31T09:51:36-03:00"
  docs/decisions/technical-decisions-phase-03-upload.md: "2026-09-03T10:41:40-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-31T09:51:36-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-31T09:51:36-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-31T09:51:36-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-31T09:51:36-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-31T09:51:36-03:00"
---

# phase-03-upload — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._ (the upload UI — dropzone, progress bar, resume UX — is explicitly deferred to a `phase-03-upload-frontend` slice, per `docs/decisions/technical-decisions-phase-03-upload.md` `scope_description`.)

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` — owns every decision in this phase's decisions doc (storage service, queue infrastructure, video worker container, tus upload endpoint, video entity/state machine, FFmpeg processing, signed-URL delivery).

**Deferred subprojects:** `next-frontend/` — upload UI deferred to a `phase-03-upload-frontend` slice. This phase still binds the frontend through five `Cross-layer` TDs (TD-03, TD-04, TD-09, TD-10, TD-11) that define the contract the future UI must consume.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — depende de: Fase 01.
- **Phase 04:** Gerenciamento de Vídeos e Canal — depende de: Fase 02, Fase 03.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-upload/TD-01 | phase | Backend | Object Storage Backend and Client SDK | decided | A: MinIO container + AWS SDK v3 | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-upload/TD-02 | phase | Backend | Background Job Queue Infrastructure | decided | A (`pg-boss`) | pg-boss |
| phase-03-upload/TD-03 | phase | Cross-layer | Large-File Upload Transport Protocol | decided | A (tus) | @tus/server, @tus/s3-store, tus-js-client |
| phase-03-upload/TD-04 | phase | Cross-layer | Upload Network Path Under the Strict BFF | decided | A: Documented BFF exception | — |
| phase-03-upload/TD-05 | phase | Backend | Video Worker Runtime Topology | decided | A: Separate Compose service | — |
| phase-03-upload/TD-06 | phase | Backend | FFmpeg/FFprobe Invocation and Binary Provisioning | decided | A: Direct `spawn` wrapper | — |
| phase-03-upload/TD-07 | phase | Backend | Post-Upload Normalization Policy | decided | A: Metadata-only + conditional faststart remux | — |
| phase-03-upload/TD-08 | phase | Backend | Automatic Thumbnail Generation Policy | decided | A: One frame at a fixed offset | — |
| phase-03-upload/TD-09 | phase | Cross-layer | Video State Machine and Processing-Status Contract | decided | A: `status` enum column + polling | — |
| phase-03-upload/TD-10 | phase | Cross-layer | Public Video Identity and Unique URL | decided | A: Internal UUID PK + public short code | — |
| phase-03-upload/TD-11 | phase | Cross-layer | Video Delivery — Streaming and Download | decided | A: Short-lived presigned GET URLs | — |
| phase-03-upload/TD-12 | phase | Backend | Upload Limits, Accepted Formats and Abandoned-Upload Policy | decided | A: Enforce at the tus layer on create | — |
| phase-03-upload/TD-13 | phase | Backend | Video Fixture Strategy for the Test Suite | decided | A: Generate fixtures with FFmpeg | — |

_Source files:_

- phase-03-upload — `docs/decisions/technical-decisions-phase-03-upload.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-upload/TD-01 |
| Serviço de processamento em segundo plano (filas) | phase-03-upload/TD-02, phase-03-upload/TD-05 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-upload/TD-03, phase-03-upload/TD-04, phase-03-upload/TD-12 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-upload/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-upload/TD-05, phase-03-upload/TD-06, phase-03-upload/TD-07, phase-03-upload/TD-09, phase-03-upload/TD-13 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-upload/TD-05, phase-03-upload/TD-06, phase-03-upload/TD-08, phase-03-upload/TD-13 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-upload/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-upload/TD-07, phase-03-upload/TD-11 |
| Download do vídeo pelo usuário | phase-03-upload/TD-11 |

## Decisions Detail

### phase-03-upload/TD-01

**Recommendation:** the S3 API is a hard prerequisite for the resumable-upload store in TD-03 and the presigned delivery in TD-11, and it is the only option where "MinIO in dev, S3 in production" costs nothing. Option B's ergonomics do not pay for running two clients; Option C postpones the phase's actual difficulty.
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

### phase-03-upload/TD-02

**Recommendation:** the transactional enqueue is a genuine correctness win for the draft-then-process flow, and at this workload (a few long jobs, never a burst) the throughput ceiling that motivates Redis is nowhere near. The cost is a hand-rolled Nest module, which is bounded and one-off; the cost of Option B is a permanent extra container for a single consumer. If Redis later enters the stack for other reasons, the queue port keeps the migration contained.
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

### phase-03-upload/TD-03

**Recommendation:** resumability is a stated requirement, and tus is the only option that provides it as a maintained standard rather than as bespoke orchestration. The ESM/CJS friction is real but bounded (a dynamic `import()` in one provider factory plus a Jest transform setting), and it is a smaller ongoing cost than owning the multipart state machine of Option B. Option C fails the requirement outright.
**Libraries:** @tus/server, @tus/s3-store, tus-js-client

**Revisions:**
- 2026-09-02 — The S3 object key is decided by a `namingFunction` returning a flat `<uuid>.<ext>`, and
  `generateUrl` / `getFileIdFromRequest` stay at their defaults. Rationale: in `@tus/server` the
  upload id **is** the stored file name, and a key containing `/` would require overriding both
  of those callbacks; a flat key keeps the surface minimal. `partSize` is 8 MiB (~1,280 parts
  for a 10 GB file, inside the 10,000-part ceiling).

### phase-03-upload/TD-04

**Recommendation:** a narrow, documented exception scoped to a single path is cheaper than making the BFF a 10GB data pipe (Option B) or than accepting Option C's coupling to a hand-rolled protocol and its dev-endpoint signature trap. Record it explicitly as a deviation from `next-frontend-config-base/TD-03`, with the upload ticket (not the session cookie) as the credential so the BFF stays the only holder of the session.
**Libraries:** —

**Revisions:**
- 2026-09-02 — The "short-lived upload ticket" named in Option A is specified as a JWT carrying
  `{ sub, scope: 'upload', jti }`, signed with the existing access-token secret and expiring in
  `UPLOAD_TICKET_EXPIRATION_HOURS` (2h), minted by `POST /videos/upload-ticket` and verified in
  the tus hooks. Rationale: the option named the credential but never defined it. It carries no
  `videoId` because the draft row is only created at `onUploadCreate`, after the ticket is
  issued; per-chunk ownership is instead resolved by joining `uploadId → video.channel → user`.

### phase-03-upload/TD-05

**Recommendation:** it delivers the isolation the architecture asks for while keeping a single codebase, a single dependency manifest and a single test suite. Option C's extra isolation does not justify duplicating the domain model; Option B trades away the one property (protecting the API from FFmpeg) the phase most needs.
**Libraries:** —

### phase-03-upload/TD-06

**Recommendation:** a hand-written `spawn` wrapper over apt-installed binaries is the only option that is both maintained and reproducible. Option B is archived; Option C's convenience is wasted when the worker always runs from a controlled image. The wrapper stays small because the phase needs exactly two commands: one ffprobe, one frame extraction.
**Libraries:** —

**Revisions:**
- 2026-09-02 — Detecting whether the `moov` atom precedes `mdat` is implemented as a pure MP4
  box-parsing helper (`hasFaststartLayout`), outside `FfmpegService`. Rationale: it is not an
  FFmpeg invocation, and this option's premise is a wrapper holding exactly the commands the
  phase needs — one ffprobe, one frame extraction, one stream-copy remux.

### phase-03-upload/TD-07

**Recommendation:** it buys the streaming guarantee (the phase's stated requirement) for near-zero CPU, and leaves transcoding as a later, well-scoped addition if incompatible codecs ever become a real problem. Option B's cost is disproportionate for a phase whose deliverable is "streaming funcionando", not adaptive bitrate; Option C leaves a requirement to chance. Pair it with a whitelist of accepted codecs at validation time (TD-12) so unplayable sources fail loudly and early.
**Libraries:** —

**Revisions:**
- 2026-09-02 — The faststart remux is promoted **onto the original storage key** (written to a
  temporary key, then copied over and the temporary deleted), so a video always has exactly one
  object and the download capability serves the same faststart file as streaming. Rationale: the
  option acknowledged "writes a full second copy" without saying where it lands; keeping two
  renditions would double storage for every remuxed upload with no consumer for the original.

### phase-03-upload/TD-08

**Recommendation:** one frame at a fixed offset is literally the capability, costs a second of CPU with input-side seeking, and keeps the data model at one nullable column that Phase 04's custom thumbnail simply overwrites. Option B pre-pays a modeling cost for a picker that Phase 04 makes redundant; Option C's scan cost is unacceptable at 10GB.
**Libraries:** —

### phase-03-upload/TD-09

**Recommendation:** the phase has no realtime requirement, and a durable `status` column plus polling is the only option that costs nothing on either side of the contract while remaining correct across reloads and long absences. Keep the state names and the `failed` reason codes as the canonical contract; SSE can be layered on later without changing them.
**Libraries:** —

**Revisions:**
- 2026-09-02 — The polling endpoint (`GET /videos/:publicId`) carries `@SkipThrottle()`. Rationale:
  `phase-02-auth/TD-08`'s `ThrottlerGuard` is registered as an `APP_GUARD`, which is global
  regardless of the declaring module, so the 10 req/min window would otherwise apply — and this
  option's contract has the client polling every few seconds, which trips it mid-processing.
  Every other `videos` endpoint stays throttled.

### phase-03-upload/TD-10

**Recommendation:** it is the only option that yields a short *and* opaque URL, and opacity is a prerequisite for the `unlisted` visibility already committed to in Phase 04. Prefer the dependency-free `crypto.randomBytes(...).toString("base64url")` generator over `nanoid@3` so the phase adds no ESM-constrained dependency for eleven characters.
**Libraries:** —

### phase-03-upload/TD-11

**Recommendation:** it satisfies both capabilities with one mechanism, keeps 10GB files out of both Node processes, and is what the architecture diagram already prescribes. The dev endpoint mismatch is a one-time Compose/env fix (alias the storage host identically inside and outside the network) and is the same fix TD-04 may already require. Option B is the safer fallback if the endpoint aliasing proves painful; Option C is out of scope until adaptive bitrate is an actual requirement.
**Libraries:** —

**Revisions:**
- 2026-09-02 — Authorization for this phase is owner-only: the caller must be authenticated, own the
  video's channel, and the video must be in `ready`. Rationale: the option's Context flagged that
  authorization matters but decided no rule; public and `unlisted` visibility only arrive in
  Phase 04 and anonymous watching in Phase 05, so nothing is reachable by a third party until
  those land.
- 2026-09-02 — Corrected the CORS clause in this option's cons: per-bucket CORS is AIStor-only, so the
  browser origin is allowed via MinIO's cluster-wide `MINIO_API_CORS_ALLOW_ORIGIN` (see TD-01).

### phase-03-upload/TD-12

**Recommendation:** declared-value rejection at create plus authoritative ffprobe validation after the fact is the standard tus pattern, and the second check costs nothing because the worker already probes the file. Adopt the bucket lifecycle rule from Option C as a belt-and-braces backstop for abandoned multipart parts. Suggested starting values to confirm at decision time: `UPLOAD_MAX_SIZE_BYTES=10737418240` (10GiB), accepted containers MP4/MOV/WebM/MKV with H.264/VP9/AV1 video, abandoned-upload expiry 24h, one concurrent in-flight upload per user.
**Libraries:** —

**Revisions:**
- 2026-09-02 — The values this option left as "suggested starting values to confirm at decision time"
  are confirmed: `UPLOAD_MAX_SIZE_BYTES=10737418240` (10 GiB); accepted containers MP4/MOV/WebM/
  MKV; accepted video codecs H.264/VP9/AV1; abandoned-upload expiry 24h; one concurrent
  in-flight upload per user. All become config keys, tunable per environment.
- 2026-09-02 — The bucket-side backstop is an `AbortIncompleteMultipartUpload` lifecycle rule applied
  with `mc ilm import` (`DaysAfterInitiation: 1`). Rationale: the borrowed "Option C lifecycle
  rule" was not otherwise specified, and the nearest `mc ilm rule add` flag governs versioning
  delete markers, not abandoned multipart uploads.

### phase-03-upload/TD-13

**Recommendation:** generated fixtures keep the repository clean while giving stronger assertions than committed files, and they extend the project's existing "test against the real thing" convention to video without importing its usual cost. Keep Option C's stubbed-`spawn` unit tests for the wrapper's error paths (non-zero exit, timeout, malformed JSON), where a real binary adds nothing.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| "Telas de frontend" | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Not covered by the guide's fixed artifact-type table, per this phase's own TD-13: video fixtures for tests are generated at setup with FFmpeg's synthetic sources (`src/test/video-fixtures.ts`), extending the project's "real services, not mocks" convention to video processing. The FFmpeg wrapper (`FfmpegService`, TD-06) itself follows the Service row above (unit tests for error paths — non-zero exit, timeout, malformed JSON — via a stubbed `spawn`; integration/E2E exercise the real binary through the generated fixtures)._
