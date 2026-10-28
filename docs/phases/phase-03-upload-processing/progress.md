# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 2/13 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Fundação de filas (BullMQ) e producer de processamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoints de partes: assinatura sob demanda e listagem para retomada
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoint POST /videos/:videoId/upload/complete (finalização + enfileiramento)
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
