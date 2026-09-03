# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP sink on `1025`, web UI on http://localhost:8025

**Shared network.** This Compose project owns the `streamtube` network
(`networks.default.name: streamtube`); `next-frontend/compose.yaml` joins it as
`external: true`. Consequences:

- Start **this** stack before `next-frontend`, or its `docker compose up` fails
  with a missing-network error.
- The frontend reaches the API as `http://nestjs-api:3000` — service name, never
  `localhost` or `host.docker.internal`.
- `docker compose down` here also tries to remove the network. With
  `next-frontend` still up that removal fails harmlessly
  (`Network streamtube  Resource is still in use`) and the network survives.
- Once both stacks are down the network can linger unused — `docker network rm
  streamtube` clears it. Starting `next-frontend` without it fails loudly with
  `network streamtube declared as external, but could not be found`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment (bring next-frontend down first — see
# "Shared network" above). Database survives: it lives in the `db-data` named
# volume, so migrations do NOT need to be re-run on the next startup.
docker compose down

# Tear down AND wipe the database (drops the `db-data` volume). After this the
# next startup needs `npm run migration:run` again.
docker compose down -v
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Delivery Endpoints Return URLs, Not Bytes

`GET /videos/:publicId/playback` and `/download` return **JSON carrying a
presigned URL**, never the video stream. The bytes go from object storage
straight to the browser, so neither Node process is ever in the data plane, and
HTTP Range, seeking and resumable downloads come from the storage layer for
free.

Two consequences to keep in mind when changing them:

- Authorization is re-evaluated on **every issuance**, but a URL that has already
  been issued stays valid until `PRESIGNED_URL_EXPIRATION_SECONDS` elapses. A
  leaked URL cannot be revoked; shorten the window instead.
- The URL is signed against `S3_PUBLIC_ENDPOINT`, because SigV4 covers the Host
  header. Rewriting its origin invalidates the signature — a test running inside
  a container cannot fetch a browser-signed URL, and must sign its own through
  `StorageService.getInternalPresignedUrl`.

## The `video-worker` Service

`video-worker` is infrastructure and starts with the stack (`docker compose up -d`).
It runs `src/main.worker.ts` against `WorkerModule` on a **standalone Nest
application context** — `NestFactory.createApplicationContext`, no HTTP adapter,
no published ports, no routes.

- Read its logs with `docker compose logs video-worker` — it has no endpoint to
  curl and no Swagger page.
- `WorkerModule` must never import `AppModule`, `AuthModule`, `UploadsModule`, or
  any controller. That boundary is the whole point: FFmpeg's CPU pressure must
  not compete with the API's event loop. It imports `TusStoreModule` for the
  store alone, never the tus `Server`.
- It is the **only** process that supervises jobs and runs the pg-boss cron
  scheduler (`QueueModule.register({ supervise: true, schedule: true })`); the
  API is send-only.
- Killing it leaves the API fully functional — uploads still complete and reach
  `processing`, and jobs simply accumulate in `pgboss.job` until it returns.
- `WORKER_SCRATCH_DIR` (`/tmp/streamtube`) is a named volume for remux working
  files. The directory is created **in the image**, owned by `node`, because
  Docker seeds a fresh named volume from the image's directory: without that the
  volume is root-owned and the unprivileged process cannot write to it.
- Scale it with `docker compose up -d --scale video-worker=2`; pg-boss hands each
  job to exactly one worker.

## The `/uploads` tus Endpoint

`/uploads` is **raw Express middleware**, not a Nest controller. `src/bootstrap.ts`
mounts it before `express.json()`, because the tus server has to read the raw
chunk stream — which is also why the app is created with `{ bodyParser: false }`.

Consequences, all deliberate:

- The global `JwtAuthGuard` does **not** run on it. It authenticates with its own
  upload ticket (`POST /videos/upload-ticket`), verified inside the tus hooks.
- The `DomainExceptionFilter` does **not** run on it. It answers with
  tus-protocol errors (`{ status_code, body }`), not the
  `{ statusCode, error, message }` envelope the rest of the API uses.
- It does **not** appear in `openapi.json` — the Swagger plugin only sees Nest
  controllers. The frontend must reach it through `NEXT_PUBLIC_UPLOAD_URL`
  rather than generated types.
- Its CORS is configured through the tus `Server`'s own `allowedOrigins` /
  `allowedHeaders` / `exposedHeaders` options, never `app.enableCors()`, which
  never sees a path served by raw middleware.

**E2E tests must use `configureApp(app)` from `src/bootstrap.ts`** rather than
applying pipes and filters by hand: `Test.createTestingModule()` does not run
`main.ts`, and the tus mount plus the body-parser ordering have to be identical
in both.

## Video Fixtures

Tests that need a real video file generate one with `src/test/video-fixtures.ts`
rather than reading a committed binary. **No media blob belongs in Git.**

- `createTestVideo({ durationSeconds, width, height })` — H.264 + AAC, faststart
- `createTrailingMoovVideo()` — MP4 with `moov` after `mdat`, to exercise the remux branch
- `createUnsupportedCodecVideo()` — MPEG-4 Part 2, which the codec whitelist must reject
- `cleanupTestVideos()` — removes the temp directory; call it in `afterAll`

Assertions come from the **generation parameters**, so a fixture's duration and
dimensions are known exactly. Files are written under `os.tmpdir()` and memoized
per Jest worker, so `git status` stays clean after a full run and the one-to-two
second encode is not repeated per test. `ffmpeg`/`ffprobe` are installed in
`Dockerfile.dev`, which both `nestjs-api` and the worker build from — the
generator has to run wherever tests run, not only in the worker.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
