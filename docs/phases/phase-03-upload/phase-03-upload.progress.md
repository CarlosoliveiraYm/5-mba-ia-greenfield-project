# Phase 03 — Upload e Processamento de Vídeos — Progress

**Status:** in_progress
**SIs:** 15/15 completed

### SI-03.1 — MinIO Service, Storage Config Namespace, and Env Schema
- **Status:** completed
- **Tests:** `src/config/env.validation.integration-spec.ts` — 10 passed
- **Observations:** O healthcheck do MinIO usa `mc ready local` (o `mc` vem na imagem `minio/minio`) em vez de `curl /minio/health/live`, porque a imagem não traz `curl`. A regra de lifecycle `AbortIncompleteMultipartUpload` no `minio-init` fica para SI-03.14, conforme o plano.

### SI-03.2 — StorageService (S3 Port)
- **Status:** completed
- **Tests:** `storage.service.integration-spec.ts`, `storage.keys.spec.ts`, `storage.module.spec.ts` — 18 passed
- **Observations:** `sanitizeDownloadFilename` foi adicionado ao `storage.service.ts` (não previsto explicitamente no plano) para impedir que um filename hostil escape do parâmetro `filename="..."` do `Content-Disposition`. `ConfigType` precisa de `import type` (regra `typescript-strict.md`) — o ts-jest não pega isso, só `tsc`/`ts-node`.

### SI-03.3 — Background Job Queue Module (pg-boss)
- **Status:** completed
- **Tests:** `queue.service.integration-spec.ts`, `queue.module.spec.ts`, `native-import.spec.ts` — 11 passed
- **Observations:** Três desvios do plano, todos forçados pela realidade da lib/runtime:
  (1) pg-boss@12 exporta `PgBoss` **nomeado**, não `default` — o plano assumia `default`;
  (2) `new Function('return import(s)')` sozinho não sobrevive a dois arquivos de teste no
  mesmo run (o namespace ESM fica preso ao environment do primeiro), então `nativeImport`
  tenta primeiro `createRequire(__filename)` e só cai no `import()` dinâmico em
  `ERR_REQUIRE_ASYNC_MODULE`; isso exigiu `NODE_OPTIONS=--experimental-vm-modules` nos
  scripts de teste do `package.json` (Jest ≥ Node 24.9 requer a flag para `require(esm)`);
  (3) o Nest cria uma instância de módulo por chamada de `QueueModule.register()`, então o
  `PgBoss` é cacheado por papel em escopo de processo — sem isso cada feature module que
  importa a fila abriria seu próprio pool e seus próprios timers. `QueueService.onModuleDestroy`
  para o boss; sem isso o Jest não encerra e o processo morre com `ERR_UNHANDLED_ERROR`.

### SI-03.4 — Video Entity, Public ID Generator, and Migration
- **Status:** completed
- **Tests:** `video.entity.integration-spec.ts`, `public-id.util.spec.ts`, `migrations.integration-spec.ts`, `domain-exception.filter.spec.ts` — 38 passed (com os specs vizinhos de `src/config`)
- **Observations:** (1) `migrations.integration-spec.ts` derrubava as tabelas com `Promise.all`;
  com a FK `videos → channels` isso passou a dar `deadlock detected`, então os `DROP TABLE`
  viraram sequenciais. (2) `npm run lint` **já falha no repositório antes desta fase**:
  baseline de 190 problemas / 150 erros na branch, quase todos `no-unsafe-*` em arquivos de
  teste da fase 02. Após a fase 03 até aqui: 189/149 (saldo -1). O item "Lint passes" dos
  Deliverables não vai poder ser cumprido sem uma limpeza fora do escopo desta fase.

### SI-03.5 — Upload Ticket Endpoint
- **Status:** completed
- **Tests:** `upload-ticket.service.spec.ts` (13), `videos.service.spec.ts`, `videos.service.integration-spec.ts`, `videos.module.spec.ts` — 42 passed em `src/videos`; `test/videos.e2e-spec.ts` — 5 passed
- **Observations:** `VideosModule` registra o `JwtModule` localmente em vez de importar o
  `AuthModule` — importar o AuthModule re-registraria seus providers `APP_GUARD`. O segredo
  é o mesmo do access token de propósito: o ticket é o mesmo domínio de confiança,
  distinguido pela claim `scope`, não por outra chave.

### SI-03.6 — tus Server Wiring and Route Mounting
- **Status:** completed
- **Tests:** `uploads.module.spec.ts` — 6 passed; `test/uploads.e2e-spec.ts` — 9 passed; suíte E2E completa — 66 passed
- **Observations:** (1) `@tus/server@2` entrega hooks com `Request`/`Response` **web** (via
  `srvx`), não `IncomingMessage` — o SI-03.7 tem de ler headers com `req.headers.get()`.
  (2) A configuração global de `main.ts` foi extraída para `src/bootstrap.ts#configureApp` e os
  4 arquivos E2E passaram a usá-la: sem isso os testes rodariam contra um app sem o mount do
  tus e com ordem de body-parser diferente da produção. (3) Confirmado no MinIO que o objeto
  de metadados do `S3Store` tem sufixo `.info` (`${id}.info`) — o plano pedia para confirmar
  em vez de assumir; fixado em `TUS_INFO_SUFFIX` para o SI-03.14. (4) Ordem real dos hooks no
  `PostHandler`: `namingFunction` → checagem de `maxSize` (413) → `onIncomingRequest` →
  `onUploadCreate` → `store.create`; ou seja, `onIncomingRequest` também roda no POST, com um
  id que ainda não tem linha em `videos`.

### SI-03.7 — Upload Lifecycle Hooks: Draft Creation, Ownership, and Enqueue
- **Status:** completed
- **Tests:** `uploads.service.spec.ts` + `uploads.service.integration-spec.ts` — 47 passed em `src/uploads` + `src/queue`; `test/uploads.e2e-spec.ts` — 16 passed; suíte E2E completa — 81 passed
- **Observations:** (1) O plano manda registrar a fila `video.process` no startup do worker;
  como `boss.send` numa fila inexistente resolve `null` em vez de lançar, a API (que é a
  publisher) também declara a fila no `onModuleInit` do `UploadsService` — `createQueue` é
  idempotente, então o worker declarar de novo não custa nada. Sem isso, subir a API antes do
  worker descartaria jobs em silêncio. (2) Segunda instância compartilhada em `QueueModule`:
  além do `PgBoss`, agora o próprio `QueueService` é cacheado por papel — dois módulos
  importando a fila tinham dois services sobre um boss, e um stub aplicado a um não valia
  para o outro (foi assim que o teste de rollback do enqueue falhou primeiro).
  (3) `TusError` virou subclasse de `Error` em vez de objeto plano: o `@tus/server` lê
  `status_code`/`body` por acesso a propriedade de qualquer coisa lançada, e a subclasse
  preserva stack trace e satisfaz `only-throw-error`. (4) `tus-js-client` adicionado como
  devDependency para o round-trip completo no E2E.

### SI-03.8 — Video Status Resource
- **Status:** completed
- **Tests:** `videos.service.spec.ts` + `videos.service.integration-spec.ts` — 50 passed em `src/videos`; `test/videos.e2e-spec.ts` — 13 passed; suíte E2E completa — 74 passed
- **Observations:** `@SkipThrottle()` confirmado na prática: 15 polls consecutivos em
  `GET /videos/:publicId` retornam 200 enquanto `POST /videos/upload-ticket` toma 429 na 11ª
  chamada do mesmo minuto. `duration_seconds` é `numeric` e o driver devolve string, então
  `toResponseDto` converte tanto ele quanto `size_bytes` (o plano só citava `size_bytes`).

### SI-03.9 — FFmpeg Provisioning and Generated Video Fixtures
- **Status:** completed
- **Tests:** `video-fixtures.integration-spec.ts` — 9 passed
- **Observations:** FFmpeg 5.1.9 (Debian 12) na imagem. `createTrailingMoovVideo` verifica o
  próprio resultado (falha alto se o ffmpeg escrever `moov` na cabeça), para o fixture não
  mentir sobre o layout que ele existe para exercitar.

### SI-03.10 — FfmpegService (spawn Wrapper)
- **Status:** completed
- **Tests:** `ffmpeg.service.spec.ts`, `ffmpeg.service.integration-spec.ts`, `moov.util.spec.ts`, `ffmpeg.module.spec.ts` — 28 passed
- **Observations:** `FfmpegCommandFailedException` e `ProbeFailedException` foram adicionadas
  a `domain.exception.ts` (o plano dizia explicitamente que elas *não* entram no catálogo
  HTTP; ficam lá só por herdarem o construtor, e o handler do worker as traduz em
  `failure_reason`). `hasFaststartLayout` exige o box `ftyp` na cabeça, então um buffer que
  não é MP4 é rejeitado em vez de ser varrido byte a byte.

### SI-03.11 — Video Worker Runtime Topology
- **Status:** completed
- **Tests:** `worker.module.spec.ts` — 4 passed
- **Observations:** (1) `WorkerModule` precisa importar `ChannelsModule` e `UsersModule`: o
  `Video.channel` é uma relação e o `autoLoadEntities` só registra o que algum módulo declara
  em `forFeature`, então sem eles o TypeORM falha com
  `Entity metadata for Video#channel was not found`. Nenhum dos dois tem controller, então a
  fronteira HTTP-free continua de pé. (2) O volume nomeado `worker-scratch` nascia root-owned
  e o processo roda como `node`; o diretório passou a ser criado **na imagem** com
  `chown node:node`, porque o Docker semeia um volume novo a partir do diretório da imagem,
  inclusive o dono. (3) O AC "com `--scale video-worker=2` nenhum job é processado duas
  vezes" só é observável com o handler do SI-03.12 — verificado lá; aqui ficou confirmado que
  duas instâncias sobem e permanecem de pé.

### SI-03.12 — Video Processing Job Handler
- **Status:** completed
- **Tests:** `video-processing.handler.spec.ts` (16) + `video-processing.handler.integration-spec.ts` (5) — 52 passed em `src/worker` + `src/queue` + `src/storage`
- **Observations:** (1) O `format_name` do ffprobe não usa os nomes da lista de containers
  aceitos: MKV e WebM reportam ambos `matroska,webm`. Foi preciso um mapa de aliases, senão
  um MKV passaria como `webm` por acidente. (2) `StorageService.putObject` ganhou um
  `contentLength` opcional: sem ele o SDK usa `aws-chunked` para corpos de stream e o MinIO
  rejeita num PUT simples. (3) Os arquivos de scratch precisam de extensão (`source.mp4`,
  `faststart.mp4`) — o ffmpeg escolhe o muxer pelo caminho de saída. (4) `QueueService.work`
  não pode receber type argument explícito: o overload do pg-boss só estreita o handler para
  a variante com metadata quando infere seu `const O` do literal, e passar qualquer type
  argument faz o TS usar os defaults. Verificado ponta a ponta com o worker real (upload tus →
  `ready` em ~3s, com duração/dimensões/codec/thumbnail corretos) e com `--scale=2`:
  4 jobs, 4 `completed`, zero duplicados.

### SI-03.13 — Playback and Download Delivery
- **Status:** completed
- **Tests:** `videos.service.spec.ts` + `videos.service.integration-spec.ts` — 61 passed em `src/videos`; `test/videos.e2e-spec.ts` — 19 passed
- **Observations:** Um teste E2E que reescrevia a origem da URL presignada (de
  `localhost:9000` para `minio:9000`) tomava 403: o SigV4 assina o header `Host`. O E2E passou
  a afirmar o contrato do endpoint (host público, expiry, `response-content-disposition` na
  query) e a exercitar o comportamento de storage por uma URL assinada internamente. Os ACs
  que só são observáveis do navegador foram verificados do host com `curl`: playback = 200 com
  4096 bytes sem credenciais, `Range: bytes=0-1023` = 206 com 1024 bytes, e download com
  `Content-Disposition: attachment; filename="My Holiday.mp4"`.

### SI-03.14 — Abandoned Upload and Stale Draft Sweeper
- **Status:** completed (com uma ressalva — ver abaixo)
- **Tests:** `upload-sweep.handler.spec.ts` (12) + `upload-sweep.handler.integration-spec.ts` (4) — 41 passed em `src/worker`
- **Observations:** ⚠️ **A regra de lifecycle `AbortIncompleteMultipartUpload` não pôde ser
  instalada.** O MinIO `RELEASE.2025-09-07T16-13-09Z` a rejeita por dois caminhos
  independentes: `mc ilm import` responde *"The XML you provided was not well-formed or did
  not validate against our published schema"*, e a API S3 `PutBucketLifecycleConfiguration`
  (AWS SDK v3, direto) responde exatamente o mesmo `InvalidArgument`. Uma regra que combina
  `Expiration` com `AbortIncompleteMultipartUpload` é aceita, mas o `mc ilm export` mostra
  que a ação de abort é **descartada em silêncio**. Como é limitação do servidor, o passo no
  `minio-init` ficou deliberadamente não-fatal (loga um WARNING e segue), para o bucket
  continuar sendo criado e para um MinIO futuro que suporte a regra pegá-la sem mudança.
  Isso não afeta a fase: o plano define essa regra como *belt-and-braces backstop* — o
  reaper primário é o `store.deleteExpired()` do tus, que o worker roda de hora em hora, e
  esse está implementado e testado. Sufixo `.info` do `S3Store` confirmado na versão
  instalada e fixado em `TUS_INFO_SUFFIX`.

### SI-03.15 — OpenAPI Artifact Refresh
- **Status:** completed
- **Tests:** `openapi-export.integration-spec.ts` — 22 passed
- **Observations:** `openapi.json` regenerado (+405 linhas) com as quatro paths de `videos`,
  `VideoStatus` e `VideoFailureReason` como enum schemas nomeados, e sem nenhuma path
  `/uploads`. Determinismo confirmado de duas formas: um teste que exporta duas vezes e compara
  byte a byte, e um re-export em cima do arquivo commitado (`diff -q` sem diferença), o que
  torna o artefato seguro para o gate de freshness em CI.
