# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 7/13 completed

### SI-03.1 — Infra: dependências, serviços Compose (storage, Redis, worker) e namespaces de configuração
- **Status:** completed
- **Tests:** 11 passing (`src/config/env.validation.integration-spec.ts` — 4 pre-existing + 7 new)
- **Observations:**
  - **Garage:** pinned `dxflrs/garage:v2.4.1` (latest v2.x per context7). Bind addresses use `0.0.0.0` instead of the docs' `[::]` — the container has no IPv6 and Garage panicked with `Address family not supported by protocol`.
  - **Garage bootstrap:** buckets get `--read --write --owner` for the dev key; `--owner` is needed for `PutBucketCors` (SI-03.2 `storage:cors`). Dev key/secret and `rpc_secret` are fixed dev-only values committed in `bootstrap.sh` / `garage.toml` / `.env.example`.
  - **Defaults not specified by plan/TDs** (chosen here, adjustable via env): `UPLOAD_PART_URL_TTL_SECONDS=3600`, `VIDEO_URL_TTL_SECONDS=14400` (4h, "viewing session" per TD-10), `UPLOAD_STALE_AFTER_HOURS=24`, `UPLOAD_CLEANUP_INTERVAL_MS=3600000`, `VIDEO_WORKER_CONCURRENCY=2`, `REDIS_PORT=6379`, `STORAGE_CORS_ALLOWED_ORIGINS=http://localhost:3001` (next-frontend host port). Required (no default): `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
  - `video-worker` keeps the image's default `CMD` (`tail -f /dev/null`) until the worker entrypoint exists (SI-03.9).
  - **Out of scope:** `.env.example` line `MAIL_FROM="StreamTube" <noreply@streamtube.com>` breaks `docker compose` `.env` parsing (only the display name is quoted). The new `.env` uses `MAIL_FROM='"StreamTube" <noreply@streamtube.com>'`; fixing `.env.example` is a separate task.
  - **Lint:** the pre-existing `SWAGGER_ENABLED` tests in `env.validation.integration-spec.ts` already failed `no-unsafe-*` (Joi's `ValidationResult` error branch types `value` as `any`). The shared `validate` helper now returns a narrowed `value: Record<string, unknown>`, which fixes both old and new cases.
  - **Git:** `dev` and `feature/phase-03-upload-processing` pushed to `origin` (SI-03.1 commit `6d244d7`).

### SI-03.2 — StorageModule com clientes S3 interno e de presign
- **Status:** completed
- **Tests:** 15 passing (`storage.module.spec.ts` 3 + `storage.service.integration-spec.ts` 12)
- **Observations:**
  - **Checksum fix (1 fix attempt):** AWS SDK v3's default `requestChecksumCalculation: 'WHEN_SUPPORTED'` bakes `x-amz-checksum-crc32` of the empty body into presigned `UploadPart` URLs, so Garage rejected real parts with `400 InvalidDigest`. `createS3Client` sets `requestChecksumCalculation` / `responseChecksumValidation` to `'WHEN_REQUIRED'` (per SDK CLIENTS.md, issue #6810). Relevant for production S3 too: browser part PUTs would hit the same mismatch.
  - **API shape:** methods take a logical bucket (`STORAGE_BUCKETS.VIDEOS | THUMBNAILS`) mapped to physical names via `storageConfig`, so the test helper swaps in `videos-test` / `thumbnails-test` by config alone. TTL (`expiresInSeconds`) and the full `ResponseContentDisposition` value are passed in by callers (SI-03.6 / SI-03.12 own those values).
  - **Extra files beyond the plan's list:** `src/storage/storage.client.ts` (`createS3Client`, shared by `StorageModule` and the `storage:cors` script) and `src/storage/storage.errors.ts` (`StoragePartsRejectedError`, with `reason` = S3 error name).
  - `headObject` returns `null` on `NotFound` (valid "absent" result for the TD-12 size check); `abortMultipartUpload` treats `NoSuchUpload` as a no-op.
  - `storage:cors` takes optional bucket args (default `S3_VIDEOS_BUCKET`); `bootstrap.sh` applies it to `videos` and `videos-test`. Verified a host-side `OPTIONS` preflight on `videos` returns `Access-Control-Expose-Headers: ETag`.
  - `src/test/storage.ts` exports `testStorageConfig` (same `storage` namespace, so later suites can `load` it or `overrideProvider(storageConfig.KEY)`), `createTestStorage()`, and `clearTestBuckets()` (deletes objects and aborts pending multipart uploads).

### SI-03.3 — Entidade Video, migration e gerador de public ID
- **Status:** completed
- **Tests:** 74 passing across 13 suites — SI files (`video.entity.integration-spec.ts` 6, `public-id.util.spec.ts` 2, `migrations.integration-spec.ts` 3) + 10 pre-existing suites touched by the `Channel#videos` relation; green on two consecutive runs
- **Observations:**
  - **Transient break until SI-03.4:** `Channel` now has `@OneToMany` → `Video`, but no module registers `Video` in `forFeature` until `VideosModule` (SI-03.4). Under `autoLoadEntities`, `AppModule` fails with `Entity metadata for Channel#videos was not found` — API boot and every e2e suite are broken between SI-03.3 and SI-03.4. Not pulled forward (plan boundary); SI-03.4 resolves it.
  - **Test DataSources:** `Video` added to `ALL_ENTITIES` in the 10 existing specs that list `Channel` (required by the new inverse relation).
  - **Migrations spec fixes (2 fix attempts):** (1) `beforeAll` dropped tables via parallel `Promise.all`; with the new `videos → channels` FK this hit `deadlock detected`, leaving a half-dropped schema → now one `DROP TABLE … CASCADE` statement. (2) Enum types survive `DROP TABLE` and synchronize-based suites recreate them (`verification_tokens_type_enum` already exists) → `beforeAll` drops every `public` enum type. `afterAll` now wraps `runMigrations` in `try/finally` so `destroy()` always runs; a failing re-migrate previously left Jest hanging on an open handle.
  - **Entity:** explicit enum type names `video_processing_status_enum` / `video_publication_status_enum`. The `bigint → number` transformer is also applied to `duration_seconds` (`numeric` also comes back as a string from pg); covered by an extra test.
  - **AC manual check:** `migration:revert` of `CreateVideos` removes the `videos` table and both enum types; re-applied afterwards (dev DB is fully migrated).
  - **Pre-existing lint debt (out of scope, affects final verification):** `npm run lint` already reports errors in untouched files (e.g. `auth.service.integration-spec.ts` `no-unsafe-*`, `require-await`, `no-unused-vars`; `create-test-data-source.ts` `no-unsafe-function-type`). New and edited code in this SI lints clean.

### SI-03.4 — Fundação de filas (BullMQ) e producer de processamento
- **Status:** completed
- **Tests:** 8 passing (`queue.module.spec.ts` 4 + `videos.module.spec.ts` 1 + `video-processing.producer.integration-spec.ts` 3)
- **Observations:**
  - **Dependency change (user-approved):** `@nestjs/bullmq` downgraded `^12.0.0` → `^11.0.5`. 12.0.0 ships ESM-only (`"type": "module"`, also `@nestjs/bull-shared` 12) and the project's CommonJS Jest/ts-jest setup can't load it (`SyntaxError: Unexpected token 'export'`). 11.0.5 is CommonJS, supports NestJS 11 and `bullmq ^6`; same API surface.
  - **Dependency added (user-approved):** `ioredis ^5.11.1`. In bullmq 6 `ioredis` is an optional peer dependency; without it the API fails at boot with `BullMQ could not load the optional 'ioredis' package`.
  - **Defaults not specified by plan/TDs** (TD-06 leaves them to implement): `video-processing` → `attempts: 3`, exponential backoff `30s`; `video-maintenance` → `attempts: 3`, exponential backoff `10s`; both → `removeOnComplete: { age: 1d, count: 1000 }`, `removeOnFail: { age: 7d }`.
  - **Extra file beyond the plan's list:** `src/test/queue.ts` (`testBullRootModule()` with key prefix `bull-test`, `clearTestQueue()` via `obliterate({ force: true })`), mirroring the `*-test` bucket isolation of `src/test/storage.ts` so suites never touch the dev `bull:*` keys. Later queue suites (SI-03.7, SI-03.9, SI-03.10) can reuse it.
  - **SI-03.3 transient break resolved:** `VideosModule` registers `Video` in `forFeature`, so `AppModule` boots again.
  - **AC manual check:** booted an `AppModule` application context (no HTTP server) inside the container: `redis-cli --scan --pattern 'bull:video-processing:*'` shows `meta`/`id`/`events`/`marker`; two `enqueueProcessing` calls with the same id → 1 job; `getWorkers()` = 0 on both queues. Check job removed afterwards.
  - `videos.module.spec.ts` logs a pg `DeprecationWarning` (`client.query()` while already executing a query), raised by TypeORM `synchronize` on the test DataSource; tests pass. Not addressed here.

### SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)
- **Status:** completed
- **Tests:** 24 passing — `videos.service.spec.ts` 12, `videos.service.integration-spec.ts` 1, `channels.service.integration-spec.ts` 5 (3 pre-existing + 2 new), `videos.module.spec.ts` 1 (updated: `uploadConfig` + `VideosService`), `test/videos-create.e2e-spec.ts` 5 (spec-derived)
- **Observations:**
  - **Key layout (not fixed by plan):** the internal UUID is generated in the service (`randomUUID()`) before the multipart starts, and `source_key = videos/{id}/source`. The key stays the same when `public_id` is regenerated on a collision, and it never exposes the public ID.
  - **Extra files beyond the plan's list:** `src/videos/videos.constants.ts` (`ALLOWED_VIDEO_MIME_TYPES`, `PUBLIC_ID_MAX_ATTEMPTS = 3`) and `src/common/database/pg-errors.ts` (`isUniqueViolationOn(error, column)`, typed via `QueryFailedError.driverError`).
  - **Out of scope:** `ChannelsService` keeps its own untyped `isPgUniqueViolationOnColumn` helper, which already fails `npm run lint` (6 `no-unsafe-*` errors, lines 12–16, pre-existing). It could switch to `isUniqueViolationOn` in a separate task.
  - A user without a channel makes `initiateUpload` throw a plain `Error` (500). Every user gets a channel at registration, so this is an invariant violation, not a domain error.
  - `filename` is trimmed via `@Transform` before `@IsNotEmpty` / `@MaxLength(255)` ("trimmed non-empty" rule).
  - E2E overrides `storageConfig.KEY` with `buildTestStorageConfig()` so `AppModule` writes to `videos-test`; the user is seeded directly (argon2 hash, `is_confirmed: true`) and logs in via `POST /auth/login`.
  - `openapi.json` / `src/metadata.ts` not regenerated here (SI-03.13 owns the contract export).

### SI-03.6 — Endpoints de partes: assinatura sob demanda e listagem para retomada
- **Status:** completed
- **Tests:** 36 passing — `videos.service.spec.ts` 25 (12 pre-existing + 13 new), `videos.service.integration-spec.ts` 3 (1 pre-existing + 2 new), `test/videos-upload-parts.e2e-spec.ts` 8 (spec-derived)
- **Observations:**
  - **Ownership query:** `findOwnedVideo` filters by `public_id` and `channel.user_id` in one `findOne` (nested relation `where`), so a foreign video is indistinguishable from an unknown one. A malformed ID short-circuits before any query. An extra integration test checks that another user's video answers `VideoNotFoundException` against the real DB.
  - **"In progress" check:** the private `pendingMultipart(video)` helper treats `processing_status !== 'uploading'` **or** a null `upload_id` as `UPLOAD_NOT_IN_PROGRESS`, and returns the `MultipartLocation` that both methods use. SI-03.7 can reuse it.
  - **Validation order:** ownership → status → part numbers. A request mixing a valid and an out-of-range part number signs nothing.
  - **Extra items beyond the plan's list:** `PUBLIC_ID_PATTERN` in `public-id.util.ts` and `SIGN_PARTS_MAX = 100` in `videos.constants.ts` (DTO `@ArrayMaxSize`). Nested response DTOs `SignedPartDto` / `UploadedPartDto` live in the same files as their parent DTOs.
  - **Test environment:** `S3_PUBLIC_ENDPOINT` in tests is the overridden `buildTestStorageConfig().publicEndpoint` (`storage:3900`), so the e2e host check compares against that value.

### SI-03.7 — Endpoint POST /videos/:videoId/upload/complete (finalização + enfileiramento)
- **Status:** completed
- **Tests:** 49 passing — `videos.service.spec.ts` 35 (25 pre-existing + 10 new), `videos.service.integration-spec.ts` 4 (3 pre-existing + 1 new), `video-response.mapper.spec.ts` 3, `videos.module.spec.ts` 1 (unchanged, re-run: `VideosService` now injects `storageConfig` + `VideoProcessingProducer`), `test/videos-upload-complete.e2e-spec.ts` 6 (spec-derived)
- **Observations:**
  - **Atomic transition:** the move to `'processing'` is a conditional `UPDATE … WHERE id = ? AND processing_status = 'uploading'`. With `affected = 0`, the call throws `UPLOAD_NOT_IN_PROGRESS` and enqueues nothing, so two concurrent completes cannot create two jobs. The job is enqueued only after this update succeeds; a unit test checks the call order.
  - **Part order:** the service sorts `parts` by `partNumber` before `CompleteMultipartUpload` (S3 requires ascending order), so a client sending them unsorted does not get `InvalidPartOrder`.
  - **FILE_TOO_LARGE path:** besides `failed` + `FILE_TOO_LARGE`, it also sets `upload_id = null` (the multipart no longer exists after complete). A missing object after a successful complete throws a plain `Error` (500): storage invariant violation, not a domain error.
  - **Extra items beyond the plan's list:** `COMPLETE_PARTS_MAX = 10_000` in `videos.constants.ts`; nested `CompletedPartDto` in `complete-upload.dto.ts`. `VideosService` now injects `storageConfig` (for `thumbnailsPublicBaseUrl`). The mapper strips a trailing `/` from the base URL.
  - **Known gap:** two concurrent completes where the second reaches storage after the first has finished get `NoSuchUpload` from S3, which `StorageService.completeMultipartUpload` does not map → 500 instead of 409. Only reachable in a true race; mapping `NoSuchUpload` belongs to `StorageService` (SI-03.2 scope).
  - **Out of scope — e2e queue isolation:** `AppModule`'s `BullModule.forRootAsync` has no configurable key prefix, so `videos-upload-complete.e2e-spec.ts` (per its spec) uses and obliterates the dev `bull:video-processing` queue instead of a `bull-test` one. Harmless today (the worker has no processor until SI-03.9), but once the dev `video-worker` runs, it could consume e2e jobs and wipe dev jobs. Suggested follow-up: a `QUEUE_PREFIX` in `queueConfig`, overridden to `bull-test` in e2e suites. **Scheduled (user decision, 2026-10-28):** do it as a separate task with its own commit on this branch, after SI-03.8 and **before SI-03.9**.

### SI-03.8 — Wrapper tipado de FFprobe/FFmpeg e fixtures de vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Video worker: entrypoint dedicado e processor `process-video`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Job agendado de limpeza de uploads abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Endpoint GET /videos/:videoId (detalhes e status do vídeo)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Endpoints de URL de streaming e de download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Contrato OpenAPI, `api.http` e documentação do ambiente
- **Status:** pending
- **Tests:** —
- **Observations:** none
