---
kind: phase
name: phase-03-upload-processing
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-upload-processing/context.md: "2026-10-27T19:07:24-03:00"
  docs/phases/phase-03-upload-processing/library-refs.md: "2026-10-27T19:07:10-03:00"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-10-27T19:05:30-03:00"
  docs/project-plan.md: "2026-10-25T16:05:06-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-25T16:05:06-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-25T16:05:06-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-25T16:05:06-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-25T16:05:06-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-25T16:05:06-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-25T16:05:06-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend and infrastructure for video upload and processing — S3-compatible file storage for videos and thumbnails, a background processing queue with a dedicated video worker, resumable direct-to-storage uploads of up to 10GB with automatic draft pre-registration at upload start, automatic processing after upload (duration/metadata extraction and thumbnail generation from a video frame), a unique short URL per video, streaming without full download, and video download by the user.

---

## Step Implementations

### SI-03.1 — Infra: dependências, serviços Compose (storage, Redis, worker) e namespaces de configuração

**Description:** Provisiona a infraestrutura da fase — storage S3-compatível (Garage), broker Redis, serviço do video worker com FFmpeg na imagem — e os namespaces de config + schema Joi que todos os SIs seguintes consomem.

**Technical actions:**

1. Instalar no container (`docker compose exec nestjs-api npm install ...`) `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage` (per `phase-03-upload-processing/TD-04`) e `@nestjs/bullmq`, `bullmq` (per `phase-03-upload-processing/TD-06`); adicionar `ffmpeg` ao `apt install` do `Dockerfile.dev`, imagem compartilhada pela API e pelo worker (per `phase-03-upload-processing/TD-07`, `phase-03-upload-processing/TD-08`).
2. Criar `docker/garage/garage.toml` (single-node, `replication_factor = 1`, `[s3_api] s3_region = "garage"` porta 3900, `[s3_web]` porta 3902 com `root_domain = ".web.garage.localhost"`) e `docker/garage/bootstrap.sh` idempotente, executado no host via `docker compose exec storage /garage ...`: layout single-node, import de chave dev fixa, buckets com alias global `videos`, `thumbnails`, `videos-test`, `thumbnails-test`, `bucket allow` para a chave e `bucket website --allow` apenas nos buckets de thumbnails (leitura pública, per `phase-03-upload-processing/TD-03`, `phase-03-upload-processing/TD-10`). Consultar a doc do Garage via context7 no momento da implementação (a imagem é `scratch`, sem shell).
3. Estender `compose.yaml`: serviço `storage` (`dxflrs/garage` com tag v2.x fixa, `garage.toml` montado, volume persistente, portas `3900` e `3902`), serviço `redis` (`redis:7-alpine`, healthcheck `redis-cli ping`), serviço `video-worker` (mesmo `build`/volume do `nestjs-api`, `depends_on` `db` healthy + `redis` healthy + `storage`); `nestjs-api` passa a depender de `redis` e `storage`. Hosts sempre pelo nome do serviço Compose (root `CLAUDE.md` § Docker Networking).
4. Criar `src/config/storage.config.ts` (`S3_ENDPOINT=http://storage:3900`, `S3_PUBLIC_ENDPOINT=http://localhost:3900`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_VIDEOS_BUCKET`, `S3_THUMBNAILS_BUCKET`, `THUMBNAILS_PUBLIC_BASE_URL=http://thumbnails.web.garage.localhost:3902`, `STORAGE_CORS_ALLOWED_ORIGINS`) (per `phase-03-upload-processing/TD-05`), `src/config/queue.config.ts` (`REDIS_HOST=redis`, `REDIS_PORT`, `VIDEO_WORKER_CONCURRENCY`) (per `phase-03-upload-processing/TD-06`) e `src/config/upload.config.ts` (`UPLOAD_MAX_SIZE_BYTES=10737418240`, `UPLOAD_PART_SIZE_BYTES=67108864`, `UPLOAD_PART_URL_TTL_SECONDS`, `VIDEO_URL_TTL_SECONDS`, `UPLOAD_STALE_AFTER_HOURS`, `UPLOAD_CLEANUP_INTERVAL_MS`) (per `phase-03-upload-processing/TD-12`) — todos via `registerAs` (per `phase-01-configuracao-base/TD-03`), carregados no `ConfigModule.forRoot` do `AppModule`.
5. Estender `src/config/env.validation.ts` com as chaves acima (per `phase-01-configuracao-base/TD-02`) — `UPLOAD_PART_SIZE_BYTES` ≥ 5 MiB e `UPLOAD_MAX_SIZE_BYTES / UPLOAD_PART_SIZE_BYTES` ≤ 10.000 partes (per `phase-03-upload-processing/TD-01`) — e documentá-las em `.env.example` e `.env`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: novas chaves obrigatórias rejeitadas quando ausentes; defaults aplicados; part size < 5 MiB rejeitado | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` lista `storage`, `redis` e `video-worker` como `running`, ao lado de `nestjs-api`, `db` e `mailpit`.
- `docker compose exec redis redis-cli ping` retorna `PONG`.
- Após `docker/garage/bootstrap.sh`, `docker compose exec storage /garage bucket list` mostra `videos`, `thumbnails`, `videos-test`, `thumbnails-test`; reexecutar o script não falha nem duplica buckets.
- Um objeto gravado no bucket `thumbnails` responde `200` em `GET http://thumbnails.web.garage.localhost:3902/{key}` a partir do host, sem credenciais; o mesmo GET anônimo em `videos` não é servido.
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec video-worker ffmpeg -version` saem com código 0.
- Subir a API com `UPLOAD_PART_SIZE_BYTES=1048576` aborta o boot com erro de validação de env.

---

### SI-03.2 — StorageModule com clientes S3 interno e de presign

**Description:** Encapsula todo acesso ao object storage em um `StorageModule` reutilizado pela API e pelo worker, com dois clientes S3 (interno para chamadas server-side, público só para assinar URLs consumidas pelo browser).

**Technical actions:**

1. Criar `src/storage/storage.constants.ts` (tokens `S3_CLIENT`, `S3_PRESIGN_CLIENT`) e `src/storage/storage.module.ts` com providers-factory que constroem `S3Client` a partir de `storageConfig` — `S3_CLIENT` usa `S3_ENDPOINT`, `S3_PRESIGN_CLIENT` usa `S3_PUBLIC_ENDPOINT`, ambos com `forcePathStyle`, `region` e `credentials` (per `phase-03-upload-processing/TD-04`, `phase-03-upload-processing/TD-05`); exporta `StorageService`.
2. Criar `src/storage/storage.service.ts` com as operações multipart — `createMultipartUpload`, `presignUploadPart` (via `S3_PRESIGN_CLIENT`), `listParts`, `completeMultipartUpload`, `abortMultipartUpload` (per `phase-03-upload-processing/TD-01`) — e de objeto — `headObject`, `deleteObject`, `putObject`, `uploadStream` (`@aws-sdk/lib-storage` `Upload`), `downloadToFile`, `presignGetObject({ disposition, contentType })` com `ResponseContentDisposition`/`ResponseContentType` (per `phase-03-upload-processing/TD-10`). Rejeições do S3 em `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) viram um erro tipado de camada de storage (`StoragePartsRejectedError`), sem exceção HTTP.
3. Criar `src/storage/scripts/apply-bucket-cors.ts` + npm script `storage:cors`, executado dentro do container: aplica `PutBucketCors` nos buckets de vídeo com `AllowedMethods [GET, PUT, HEAD]`, `AllowedHeaders ['*']`, `ExposeHeaders [ETag]` e `AllowedOrigins` = `STORAGE_CORS_ALLOWED_ORIGINS` (per `phase-03-upload-processing/TD-01`); `bootstrap.sh` (SI-03.1) passa a chamá-lo ao final.
4. Criar `src/test/storage.ts` — helper de testes que monta `StorageService` contra os buckets `videos-test`/`thumbnails-test` e esvazia ambos entre suítes (per `phase-03-upload-processing/TD-14`). Nos testes, o cliente de presign é configurado com o endpoint interno, porque a URL assinada precisa ser alcançável de dentro do container (a assinatura SigV4 inclui o `Host`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test (dois clientes resolvidos com config de teste) | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration (Garage real, per `phase-03-upload-processing/TD-14`): ciclo create → PUT de parte via URL presignada → `listParts` → complete → `headObject`; `abort` + `NoSuchUpload`; presigned GET com `Range` retorna `206`; `attachment` reflete em `Content-Disposition`; partes rejeitadas viram `StoragePartsRejectedError` | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — serviço `storage`, buckets e `storageConfig` precisam existir.

**Acceptance criteria:**

- Um upload multipart assinado pelo `StorageService` e enviado via `PUT` na URL presignada resulta, após complete, em um objeto cujo `ContentLength` no `HeadObject` é igual à soma das partes.
- URLs presignadas geradas fora do ambiente de teste têm o host de `S3_PUBLIC_ENDPOINT` (`localhost:3900`), nunca `storage:3900`.
- Um `GET` com `Range: bytes=0-99` em uma URL presignada de vídeo retorna `206` com exatamente 100 bytes.
- Um preflight `OPTIONS` vindo da origem do FE em uma URL de parte do bucket `videos` retorna os headers CORS com `ETag` exposto.
- Abortar um multipart inexistente não lança erro (`NoSuchUpload` é tratado como no-op).

---

### SI-03.3 — Entidade Video, migration e gerador de public ID

**Description:** Cria a entidade `Video` com o modelo de status ortogonal e o ID público curto e não adivinhável; é a base persistente de todo o fluxo de upload e processamento.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme `### Data Model → Video` (colunas, enums PostgreSQL `processing_status` e `publication_status`, transformer `bigint → number` em `size_bytes`, `@ManyToOne` → `Channel` com `onDelete: 'CASCADE'`) e os enums TS `VideoProcessingStatus`, `VideoPublicationStatus`, `VideoFailureReason` em `src/videos/video.enums.ts` (per `phase-03-upload-processing/TD-13`); adicionar o lado inverso `@OneToMany` `videos` em `Channel`.
2. Gerar a migration `CreateVideos` em `src/database/migrations/` — tipos enum, tabela `videos`, FK `channel_id` com `ON DELETE CASCADE`, índice único `(public_id)`, índices `(channel_id)` e `(processing_status, created_at)` (per `phase-03-upload-processing/TD-12`) — via `npm run migration:generate` dentro do container.
3. Criar `src/videos/public-id.util.ts` — `generatePublicId()` com `crypto.randomBytes` → base64url truncado em 11 caracteres (66 bits), sem dependência externa (per `phase-03-upload-processing/TD-11`).
4. Atualizar `cleanAllTables` em `src/test/create-test-data-source.ts` para apagar `videos` antes de `channels`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unicidade de `public_id`; defaults `'uploading'`/`'draft'`; FK obrigatória; cascade ao remover o channel; `size_bytes` > 2^31 volta como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: 11 caracteres no alfabeto `[A-Za-z0-9_-]`; amostra de 10.000 IDs sem repetição | `src/videos/public-id.util.spec.ts` |
| Migrations | Integration: `CreateVideos` sobe e reverte limpo após as migrations existentes | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade.
- Um vídeo inserido sem status explícitos é persistido com `processing_status = 'uploading'` e `publication_status = 'draft'`.
- Remover um channel remove seus vídeos.
- Um vídeo com `size_bytes = 10737418240` é lido de volta com o mesmo valor numérico.
- `npm run migration:run` seguido de `npm run migration:revert` deixa o schema sem a tabela `videos` e sem os tipos enum criados.

---

### SI-03.4 — Fundação de filas (BullMQ) e producer de processamento

**Description:** Conecta a aplicação ao Redis via `@nestjs/bullmq`, registra as filas `video-processing` e `video-maintenance` e cria o `VideosModule` com o producer que enfileira o job `process-video`.

**Technical actions:**

1. Criar `src/queue/queue.constants.ts` com os nomes `video-processing`, `process-video`, `video-maintenance`, `cleanup-abandoned-uploads` e o tipo `ProcessVideoJobData = { videoId: string }` (per `### Events/Messages`).
2. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory })` com `connection` vinda de `queueConfig` (host = serviço Compose `redis`) e `BullModule.registerQueue` das duas filas com `defaultJobOptions` (`attempts`, `backoff` exponencial, `removeOnComplete`/`removeOnFail` por idade) (per `phase-03-upload-processing/TD-06`); exporta `BullModule`.
3. Criar `src/videos/video-processing.producer.ts` — `enqueueProcessing(videoId)` faz `queue.add('process-video', { videoId }, { jobId: videoId })` para deduplicar reenfileiramentos (per `phase-03-upload-processing/TD-06`).
4. Criar `src/videos/videos.module.ts` — importa `TypeOrmModule.forFeature([Video])`, `QueueModule`, `StorageModule`, `ChannelsModule`; provê `VideoProcessingProducer`; registrar `VideosModule` no `AppModule`. Nenhum `@Processor` é registrado aqui — consumers vivem só no worker (per `phase-03-upload-processing/TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test com config de teste | `src/queue/queue.module.spec.ts` |
| `VideosModule` | Unit: compilation test (DI de storage, queue, channels) | `src/videos/videos.module.spec.ts` |
| `VideoProcessingProducer` | Integration (Redis real, per `phase-03-upload-processing/TD-14`): job `process-video` criado com `jobId` = `videoId` e payload correto; segundo enqueue do mesmo id não cria job duplicado | `src/videos/video-processing.producer.integration-spec.ts` |

**Dependencies:** SI-03.1 — `redis` e `queueConfig`; SI-03.2 — `StorageModule` importado pelo `VideosModule`; SI-03.3 — entidade `Video` em `forFeature`.

**Acceptance criteria:**

- Com a API rodando, `docker compose exec redis redis-cli --scan --pattern 'bull:video-processing:*'` mostra as chaves da fila.
- `enqueueProcessing(id)` chamado duas vezes com o mesmo id deixa exatamente um job `process-video` na fila `video-processing`.
- O boot da API não registra nenhum worker BullMQ (nenhum consumer ativo na fila a partir do processo `nestjs-api`).

---

### SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (cria rascunho no próprio channel) — per `### Authorization Matrix`

**Description:** Ao iniciar o upload, cria o vídeo como rascunho e o multipart upload no storage em uma única chamada, devolvendo o plano de partes ditado pelo servidor.

**Technical actions:**

1. Adicionar `findByUserId(userId)` ao `ChannelsService` (o lookup de channel pertence ao `ChannelsModule`, não ao `VideosModule`).
2. Adicionar a `src/common/exceptions/domain.exception.ts` as exceções `FileTooLargeException` (`FILE_TOO_LARGE`, 400) e `UnsupportedVideoTypeException` (`UNSUPPORTED_VIDEO_TYPE`, 400) (per `### Error Catalog`, `phase-02-auth/TD-07`).
3. Criar `src/videos/dto/create-video.dto.ts` (`filename`, `size`, `mimeType` — per `### API Contracts → POST /videos` e `#### Validation Rules — Videos`) e `src/videos/dto/initiate-upload-response.dto.ts` (`videoId`, `uploadId`, `partSize`, `partCount`, `processingStatus`, `publicationStatus`).
4. Criar `src/videos/videos.service.ts` com `initiateUpload(userId, dto)`: valida `size` ≤ `UPLOAD_MAX_SIZE_BYTES` e `mimeType` na allowlist (`video/mp4`, `video/webm`) (per `phase-03-upload-processing/TD-12`); calcula `partCount = ceil(size / UPLOAD_PART_SIZE_BYTES)`; gera `public_id` com até 3 tentativas em violação de unicidade (per `phase-03-upload-processing/TD-11`); chama `createMultipartUpload` e persiste o rascunho com `upload_id`, `source_key`, `part_size_bytes`, `part_count` (per `phase-03-upload-processing/TD-02`); se o insert falhar após criar o multipart, aborta o multipart antes de propagar o erro.
5. Criar `src/videos/videos.controller.ts` com `@Post()` → `201`, `@CurrentUser()` para o `sub`, e decoradores OpenAPI explícitos (`@ApiOperation`, `@ApiBearerAuth`, `@ApiResponse` por status com o envelope de erro) (per `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit (repo, `StorageService` e `ChannelsService` mockados): rejeição por tamanho e por MIME sem tocar o storage; cálculo de `partCount`; retry de `public_id` em violação de unicidade; abort do multipart quando o insert falha | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (DB + Garage reais): linha persistida em `'uploading'`/`'draft'` com `upload_id` que existe no storage (`listParts` vazio) | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o channel do usuário; `null` para usuário sem channel | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — `StorageService.createMultipartUpload`; SI-03.3 — entidade `Video` e `generatePublicId`; SI-03.4 — `VideosModule`.

**Acceptance criteria:**

- `POST /videos` autenticado com `{ filename: "a.mp4", size: 200000000, mimeType: "video/mp4" }` retorna `201` com `videoId` de 11 caracteres, `partSize: 67108864`, `partCount: 3`, `processingStatus: "uploading"`, `publicationStatus: "draft"`.
- `POST /videos` com `size: 10737418241` retorna `400` com `error: "FILE_TOO_LARGE"` e nenhuma linha é criada em `videos`.
- `POST /videos` com `mimeType: "video/quicktime"` retorna `400` com `error: "UNSUPPORTED_VIDEO_TYPE"`.
- `POST /videos` sem `filename` retorna `400` com `error: "VALIDATION_ERROR"`.
- `POST /videos` sem `Authorization` retorna `401`.
- Após um `201`, a linha em `videos` pertence ao channel do usuário autenticado e seu `upload_id` é igual ao `uploadId` retornado.

---

### SI-03.6 — Endpoints de partes: assinatura sob demanda e listagem para retomada

**Route:** POST /videos/:videoId/upload/parts, GET /videos/:videoId/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner — per `### Authorization Matrix` (não-dono recebe `404`)

**Description:** Assina URLs de `UploadPart` sob demanda e lista as partes já recebidas pelo storage, permitindo upload paralelo e retomada após falha de conexão sem que nenhum byte passe pela API.

**Technical actions:**

1. Adicionar ao `VideosService` o helper `findOwnedVideo(userId, publicId)` — `publicId` fora de `^[A-Za-z0-9_-]{11}$`, inexistente ou de outro channel lança `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404) (per `phase-03-upload-processing/TD-10` revisão 2026-10-27); será reutilizado por SI-03.7, SI-03.11 e SI-03.12.
2. Adicionar `VideoNotFoundException`, `UploadNotInProgressException` (`UPLOAD_NOT_IN_PROGRESS`, 409) e `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 400) a `domain.exception.ts` (per `### Error Catalog`).
3. Criar `src/videos/dto/sign-parts.dto.ts` (`partNumbers`), `src/videos/dto/signed-parts-response.dto.ts` (`parts: { partNumber, url }[]`, `expiresInSeconds`) e `src/videos/dto/upload-parts-response.dto.ts` (`uploadId`, `partSize`, `partCount`, `uploadedParts: { partNumber, etag, size }[]`) (per `### API Contracts`).
4. Implementar `VideosService.signUploadParts` (exige `'uploading'`; rejeita `partNumber > partCount`; assina com `presignUploadPart` e TTL `UPLOAD_PART_URL_TTL_SECONDS`) e `VideosService.listUploadedParts` (exige `'uploading'`; `listParts` ordenado por `partNumber`) (per `phase-03-upload-processing/TD-01`, `phase-03-upload-processing/TD-05`).
5. Adicionar ao `VideosController` `@Post(':videoId/upload/parts')` → `200` (`@HttpCode(200)`) e `@Get(':videoId/upload/parts')` → `200`, com decoradores OpenAPI explícitos (per `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedVideo` / `signUploadParts` / `listUploadedParts` | Unit (mocks): ID malformado, inexistente e de outro dono → `VideoNotFoundException`; status ≠ `'uploading'` → `UploadNotInProgressException`; `partNumber` > `partCount` → `InvalidPartNumberException` | `src/videos/videos.service.spec.ts` |
| `VideosService.signUploadParts` + `listUploadedParts` | Integration (DB + Garage): `PUT` em uma URL assinada é aceito pelo storage e a parte aparece em `listUploadedParts` com `etag` e `size` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — rascunho com `upload_id` e `VideosController`/`VideosService` existentes.

**Acceptance criteria:**

- `POST /videos/:videoId/upload/parts` do dono com `{ partNumbers: [1, 2] }` retorna `200` com duas URLs cujo host é o de `S3_PUBLIC_ENDPOINT` e `expiresInSeconds` igual a `UPLOAD_PART_URL_TTL_SECONDS`.
- `POST /videos/:videoId/upload/parts` com um part number maior que `partCount` retorna `400` com `error: "INVALID_PART_NUMBER"`.
- `GET /videos/:videoId/upload/parts` após enviar a parte 1 retorna `200` com `uploadedParts` contendo apenas `{ partNumber: 1, etag, size }`.
- Os dois endpoints chamados por outro usuário autenticado, ou com um `videoId` inexistente ou malformado, retornam `404` com `error: "VIDEO_NOT_FOUND"`.
- Os dois endpoints para um vídeo em `'processing'` retornam `409` com `error: "UPLOAD_NOT_IN_PROGRESS"`.
- `POST /videos/:videoId/upload/parts` com `partNumbers: []` retorna `400` com `error: "VALIDATION_ERROR"`.

---

### SI-03.7 — Endpoint POST /videos/:videoId/upload/complete (finalização + enfileiramento)

**Route:** POST /videos/:videoId/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner — per `### Authorization Matrix` (não-dono recebe `404`)

**Description:** Sinal explícito de fim de upload: fecha o multipart, verifica o tamanho real do objeto, move o vídeo para `'processing'` e enfileira o processamento depois do commit.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` (`parts: { partNumber, etag }[]` com `ValidateNested` + `@Type`, per `#### Validation Rules — Videos`) e adicionar `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, 400) a `domain.exception.ts`.
2. Criar `src/videos/dto/video-response.dto.ts` (`VideoResponseDto`, per `### API Contracts → Shared response schema`) e `src/videos/video-response.mapper.ts` — `toVideoResponse(video, thumbnailsPublicBaseUrl)`; `thumbnailUrl` é `THUMBNAILS_PUBLIC_BASE_URL/{thumbnail_key}` só quando `thumbnail_key` existe (per `phase-03-upload-processing/TD-10`).
3. Implementar `VideosService.completeUpload(userId, publicId, dto)`: `findOwnedVideo` + exige `'uploading'`; `partNumber` duplicado ou fora de `1..partCount` → `InvalidUploadPartsException`; `completeMultipartUpload` (mapeia `StoragePartsRejectedError` → `InvalidUploadPartsException`); `headObject` — se `ContentLength` > `UPLOAD_MAX_SIZE_BYTES`, `deleteObject` + `processing_status = 'failed'`, `failure_reason = 'FILE_TOO_LARGE'` e lança `FileTooLargeException` (per `phase-03-upload-processing/TD-12`).
4. No caminho feliz, persistir `processing_status = 'processing'`, `size_bytes` = `ContentLength` real, `upload_completed_at`, `upload_id = null` e só **após** o commit chamar `VideoProcessingProducer.enqueueProcessing(video.id)` (per `phase-03-upload-processing/TD-02`, `phase-03-upload-processing/TD-06`).
5. Adicionar ao `VideosController` `@Post(':videoId/upload/complete')` → `200` (`@HttpCode(200)`) retornando `VideoResponseDto`, com decoradores OpenAPI explícitos (per `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (mocks): duplicatas → `InvalidUploadPartsException` sem chamar o storage; rejeição do storage mapeada; oversize → delete + `'failed'` + `FileTooLargeException` sem enqueue; enqueue só depois do save bem-sucedido | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (DB + Garage + Redis reais): upload de 2 partes reais → complete → linha em `'processing'` com `size_bytes` real, `upload_id` nulo e job `process-video` com `jobId` = id interno | `src/videos/videos.service.integration-spec.ts` |
| `toVideoResponse` | Unit: `thumbnailUrl` nulo sem `thumbnail_key`; URL pública montada a partir da base configurada; campos snake_case → camelCase do contrato | `src/videos/video-response.mapper.spec.ts` |

**Dependencies:** SI-03.4 — `VideoProcessingProducer`; SI-03.6 — `findOwnedVideo` e partes enviáveis.

**Acceptance criteria:**

- `POST /videos/:videoId/upload/complete` do dono com todas as partes e ETags corretos retorna `200` com `processingStatus: "processing"` e `sizeBytes` igual ao tamanho real do objeto.
- Após esse `200`, a fila `video-processing` contém um job `process-video` cujo payload `videoId` é o UUID interno do vídeo.
- Repetir o complete no mesmo vídeo retorna `409` com `error: "UPLOAD_NOT_IN_PROGRESS"` e não cria um segundo job.
- Complete com um ETag errado retorna `400` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo continua `'uploading'` (retomável).
- Complete com `parts` contendo o mesmo `partNumber` duas vezes retorna `400` com `error: "INVALID_UPLOAD_PARTS"`.
- Complete de um objeto cujo tamanho real excede o limite retorna `400` com `error: "FILE_TOO_LARGE"`, o objeto deixa de existir no bucket e o vídeo fica `'failed'` com `failure_reason = 'FILE_TOO_LARGE'`.
- Complete chamado por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.8 — Wrapper tipado de FFprobe/FFmpeg e fixtures de vídeo

**Description:** Isola as chamadas ao FFmpeg do sistema em um `MediaModule` pequeno e tipado (probe, thumbnail, remux faststart), sem dependência npm não mantida, com fixtures minúsculas para os testes.

**Technical actions:**

1. Criar `src/media/ffprobe.service.ts` — `probe(filePath)` executa `ffprobe -v error -print_format json -show_format -show_streams` via `child_process.spawn` com array de argumentos e timeout; mapeia o JSON para um `ProbeResult` tipado (`durationSeconds`, `formatName`, `videoStream { codecName, width, height }`, `audioStream { codecName } | null`); exit code ≠ 0, timeout ou JSON inválido lançam `MediaCommandError` com stderr anexado (per `phase-03-upload-processing/TD-08`).
2. Criar `src/media/ffmpeg.service.ts` — `extractThumbnail(input, output, atSeconds)` (um frame JPEG) e `remuxFaststart(input, output)` (`-c copy -movflags +faststart`), ambos com argumentos explícitos, timeout e `MediaCommandError` (per `phase-03-upload-processing/TD-08`, `phase-03-upload-processing/TD-09`).
3. Criar `src/media/mp4-atoms.util.ts` — `needsFaststart(filePath)` lê apenas os cabeçalhos dos boxes de topo e retorna `true` quando `mdat` aparece antes de `moov` (per `phase-03-upload-processing/TD-09`).
4. Criar `src/media/media.module.ts` exportando `FfprobeService` e `FfmpegService`.
5. Criar `test/fixtures/videos/generate.sh` (gera com `ffmpeg -f lavfi testsrc/sine` arquivos de poucos KB) e commitar as fixtures: `h264-aac-moov-end.mp4`, `h264-aac-faststart.mp4`, `vp9-opus.webm`, `hevc.mp4` (codec fora da allowlist) e `not-a-video.mp4` (bytes aleatórios) (per `phase-03-upload-processing/TD-14`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfprobeService` | Integration (binário real, per `phase-03-upload-processing/TD-14`): metadados das fixtures MP4 e WebM; arquivo sem áudio → `audioStream: null`; `not-a-video.mp4` → `MediaCommandError` | `src/media/ffprobe.service.integration-spec.ts` |
| `FfmpegService` | Integration (binário real): thumbnail JPEG gerado e decodificável; remux de `h264-aac-moov-end.mp4` produz arquivo com `moov` antes de `mdat` | `src/media/ffmpeg.service.integration-spec.ts` |
| `needsFaststart` | Unit: `true` para `moov` no fim, `false` para faststart | `src/media/mp4-atoms.util.spec.ts` |

**Dependencies:** SI-03.1 — `ffmpeg`/`ffprobe` instalados na imagem.

**Acceptance criteria:**

- `probe` de `h264-aac-faststart.mp4` retorna `videoStream.codecName = "h264"`, `audioStream.codecName = "aac"`, largura/altura da fixture e `durationSeconds` > 0.
- `probe` de `not-a-video.mp4` falha com `MediaCommandError` cuja mensagem inclui o stderr do ffprobe.
- `remuxFaststart` sobre `h264-aac-moov-end.mp4` gera um arquivo para o qual `needsFaststart` retorna `false`, com a mesma duração do original.
- `extractThumbnail` gera um JPEG não vazio no caminho de saída.
- Um comando que excede o timeout configurado é finalizado e falha com `MediaCommandError`, sem deixar processo órfão.

---

### SI-03.9 — Video worker: entrypoint dedicado e processor `process-video`

**Description:** Sobe o processo do worker (sem HTTP) a partir do mesmo código e implementa o processamento automático pós-upload: extração de duração e metadados, validação de codec, remux faststart quando necessário e thumbnail a partir de um frame.

**Technical actions:**

1. Extrair as opções do `TypeOrmModule.forRootAsync` do `AppModule` para `src/database/typeorm-options.factory.ts` e reutilizá-las no `AppModule` e no worker, mantendo `databaseConfig` como fonte única dos parâmetros de conexão (per `phase-01-configuracao-base/TD-03`, convenção herdada da fase 01).
2. Criar `src/worker/worker.module.ts` (mesmo `ConfigModule.forRoot` com `load`/`validationSchema`, TypeORM compartilhado, `QueueModule`, `StorageModule`, `MediaModule`, `TypeOrmModule.forFeature([Video])`) e `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`; adicionar os npm scripts `start:worker` (`node dist/worker`) e `start:worker:dev` (`nest start --entryFile worker --watch`) (per `phase-03-upload-processing/TD-07`).
3. Criar `src/videos/video-codec-allowlist.ts` — MP4 → vídeo `h264` + áudio `aac` ou ausente; WebM → vídeo `vp9` + áudio `opus` ou ausente (per `phase-03-upload-processing/TD-09`).
4. Criar `src/worker/processors/video-processing.processor.ts` — `@Processor('video-processing')` + `extends WorkerHost`; concurrency vinda de `VIDEO_WORKER_CONCURRENCY`. Fluxo de `process-video`: carrega o vídeo e sai sem efeito se não estiver `'processing'` (idempotência); `downloadToFile` para diretório temporário; `probe` (falha → `'failed'` + `PROBE_FAILED`, sem relançar); codec fora da allowlist → `'failed'` + `UNSUPPORTED_CODEC`; MP4 com `needsFaststart` → `remuxFaststart` + `uploadStream` sobrescrevendo `source_key`; `extractThumbnail` em `min(1s, 10% da duração)` → `putObject` no bucket de thumbnails com chave determinística derivada do `public_id`; grava `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `thumbnail_key`, `processing_status = 'ready'`, `processed_at`; remove o diretório temporário em `finally` (per `phase-03-upload-processing/TD-08`, `phase-03-upload-processing/TD-09`, `phase-03-upload-processing/TD-10`, `phase-03-upload-processing/TD-13`).
5. Adicionar `@OnWorkerEvent('failed')` no processor: na última tentativa (`attemptsMade >= opts.attempts`), marca o vídeo `'failed'` com `failure_reason = 'PROCESSING_ERROR'` e `processed_at` (per `phase-03-upload-processing/TD-06`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit (`StorageService`, `FfprobeService`, `FfmpegService` e repo falsos): sai cedo se não estiver `'processing'`; `PROBE_FAILED` e `UNSUPPORTED_CODEC` não relançam; remux só quando `needsFaststart`; última tentativa falha → `PROCESSING_ERROR`; tentativa intermediária não altera status | `src/worker/processors/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration (DB + Garage + FFmpeg reais, per `phase-03-upload-processing/TD-14`): fixture enviada ao bucket de teste → `process(job)` → linha `'ready'` com metadados, objeto de thumbnail existente e fonte com `moov` antes de `mdat`; fixture HEVC → `'failed'`/`UNSUPPORTED_CODEC` | `src/worker/processors/video-processing.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilation test (DI de TypeORM, queue, storage, media e processor) | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`; SI-03.4 — `QueueModule` e nomes de fila; SI-03.8 — `MediaModule`.

**Acceptance criteria:**

- Com `docker compose exec video-worker npm run start:worker:dev` rodando, um upload completado via SI-03.7 leva o vídeo de `'processing'` a `'ready'` sem nenhuma ação adicional, com `duration_seconds`, `width`, `height`, `video_codec` e `thumbnail_key` preenchidos.
- O thumbnail de um vídeo `'ready'` é servido anonimamente em `THUMBNAILS_PUBLIC_BASE_URL/{thumbnail_key}` como `image/jpeg`.
- Um vídeo MP4 enviado com `moov` no fim é armazenado, ao final, com `moov` antes de `mdat` (reprodução progressiva sem download completo).
- Um vídeo HEVC termina `'failed'` com `failure_reason = 'UNSUPPORTED_CODEC'` e o job é concluído sem novas tentativas.
- Reprocessar um job de um vídeo já `'ready'` não altera a linha nem os objetos.
- O processo `nestjs-api` continua respondendo requisições HTTP enquanto o worker processa (o processamento não roda no processo da API).

---

### SI-03.10 — Job agendado de limpeza de uploads abandonados

**Description:** Fecha o ciclo do rascunho: uploads que ficaram em `'uploading'` além da janela configurada têm o multipart abortado no storage e o vídeo marcado como `'failed'`, mantendo storage e banco coerentes.

**Technical actions:**

1. Criar `src/worker/upload-cleanup.service.ts` — `cleanupAbandoned(now)`: busca vídeos com `processing_status = 'uploading'` e `created_at` < `now - UPLOAD_STALE_AFTER_HOURS` (usa o índice `(processing_status, created_at)`), chama `abortMultipartUpload` para cada `upload_id` (`NoSuchUpload` ignorado) e grava `processing_status = 'failed'`, `failure_reason = 'UPLOAD_ABANDONED'`, `upload_id = null`, `processed_at` (per `phase-03-upload-processing/TD-12`).
2. Criar `src/worker/processors/upload-cleanup.processor.ts` — `@Processor('video-maintenance')` + `extends WorkerHost`, delega ao `UploadCleanupService` (per `phase-03-upload-processing/TD-06`).
3. Criar `src/worker/maintenance.scheduler.ts` — em `onApplicationBootstrap`, `upsertJobScheduler('cleanup-abandoned-uploads', { every: UPLOAD_CLEANUP_INTERVAL_MS }, { name: 'cleanup-abandoned-uploads', data: {} })`, idempotente entre reinícios (per `phase-03-upload-processing/TD-12`, `### Events/Messages`).
4. Registrar `UploadCleanupService`, `UploadCleanupProcessor` e `MaintenanceScheduler` no `WorkerModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadCleanupService` | Integration (DB + Garage reais): rascunho antigo tem o multipart abortado e vira `'failed'`/`UPLOAD_ABANDONED`; rascunho recente e vídeos em `'processing'`/`'ready'` intactos; `upload_id` já inexistente no storage não interrompe a varredura | `src/worker/upload-cleanup.service.integration-spec.ts` |
| `MaintenanceScheduler` | Integration (Redis real): bootstrap executado duas vezes resulta em um único job scheduler `cleanup-abandoned-uploads` com o intervalo configurado | `src/worker/maintenance.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.9 — `WorkerModule` e entrypoint do worker.

**Acceptance criteria:**

- Um vídeo em `'uploading'` criado há mais de `UPLOAD_STALE_AFTER_HOURS` horas, após uma execução da limpeza, fica `'failed'` com `failure_reason = 'UPLOAD_ABANDONED'` e `upload_id = null`, e `ListParts` no seu antigo `UploadId` retorna `NoSuchUpload`.
- Um vídeo em `'uploading'` criado dentro da janela não é alterado pela limpeza.
- Reiniciar o worker não cria um segundo scheduler: `getJobSchedulers()` da fila `video-maintenance` retorna um único item.
- Executar a limpeza duas vezes seguidas produz o mesmo estado final que uma execução.

---

### SI-03.11 — Endpoint GET /videos/:videoId (detalhes e status do vídeo)

**Route:** GET /videos/:videoId
**Test Specs:** see `nestjs-project/specs/videos-details.plan.md`
**Authorization:** Owner — per `### Authorization Matrix` (não-dono recebe `404`)

**Description:** Expõe ao dono o estado do vídeo (status de processamento e publicação, metadados e URL pública do thumbnail), superfície de polling que o slice de frontend usa durante upload e processamento.

**Technical actions:**

1. Implementar `VideosService.getOwnedVideo(userId, publicId)` reutilizando `findOwnedVideo` e `toVideoResponse` (per `### API Contracts → GET /videos/:videoId`, `phase-03-upload-processing/TD-13`).
2. Adicionar ao `VideosController` `@Get(':videoId')` → `200` com `VideoResponseDto`, com decoradores OpenAPI explícitos (`@ApiOkResponse`, `@ApiNotFoundResponse` com o envelope de erro) (per `openapi-docs-nestjs/TD-01`).

**Tests:** _(empty — delegação a `findOwnedVideo` (SI-03.6) e `toVideoResponse` (SI-03.7), já testados; E2E em /plan-test-specs spec)_

**Dependencies:** SI-03.7 — `VideoResponseDto` e `toVideoResponse`.

**Acceptance criteria:**

- `GET /videos/:videoId` do dono logo após o `POST /videos` retorna `200` com `processingStatus: "uploading"`, `publicationStatus: "draft"`, `thumbnailUrl: null` e `durationSeconds: null`.
- `GET /videos/:videoId` do dono de um vídeo `'ready'` retorna `200` com `durationSeconds`, `width`, `height` preenchidos e `thumbnailUrl` começando com `THUMBNAILS_PUBLIC_BASE_URL`.
- `GET /videos/:videoId` de um vídeo `'failed'` retorna `200` com `processingStatus: "failed"` e o `failureReason` gravado.
- `GET /videos/:videoId` por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`; sem token retorna `401`.

---

### SI-03.12 — Endpoints de URL de streaming e de download

**Route:** GET /videos/:videoId/stream-url, GET /videos/:videoId/download-url
**Test Specs:** see `nestjs-project/specs/videos-media-urls.plan.md`
**Authorization:** Owner — per `### Authorization Matrix` (não-dono recebe `404`; regra para vídeos publicados fica para as fases 04/05)

**Description:** Entrega ao dono URLs presignadas de curta duração para reprodução inline (com Range servido direto pelo storage) e para download do arquivo original, sem que bytes de vídeo passem pela API ou pelo BFF.

**Technical actions:**

1. Criar `src/videos/content-disposition.util.ts` — monta `inline` e `attachment; filename="..."; filename*=UTF-8''...` (RFC 6266) a partir de `original_filename`, escapando aspas e removendo caracteres de controle.
2. Adicionar `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) a `domain.exception.ts` e criar `src/videos/dto/media-url-response.dto.ts` (`url`, `expiresInSeconds`) (per `### API Contracts`, `### Error Catalog`).
3. Implementar `VideosService.getStreamUrl` e `VideosService.getDownloadUrl`: `findOwnedVideo` + exige `'ready'`; `presignGetObject` com o cliente de presign público, `ResponseContentType` = `mime_type`, disposition `inline` ou `attachment` e TTL `VIDEO_URL_TTL_SECONDS` (per `phase-03-upload-processing/TD-05`, `phase-03-upload-processing/TD-09`, `phase-03-upload-processing/TD-10`).
4. Adicionar ao `VideosController` `@Get(':videoId/stream-url')` e `@Get(':videoId/download-url')` → `200`, com decoradores OpenAPI explícitos (per `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildContentDisposition` | Unit: nome ASCII simples; nome com aspas; nome não-ASCII gera `filename*` UTF-8; caracteres de controle removidos | `src/videos/content-disposition.util.spec.ts` |
| `VideosService.getStreamUrl` / `getDownloadUrl` | Unit (mocks): status ≠ `'ready'` → `VideoNotReadyException`; disposition `inline` vs `attachment`; TTL repassado ao presign | `src/videos/videos.service.spec.ts` |
| `VideosService.getDownloadUrl` | Integration (DB + Garage): a URL retornada, buscada com `GET`, responde `200` com `Content-Disposition: attachment` contendo o nome original | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — `presignGetObject`; SI-03.6 — `findOwnedVideo`.

**Acceptance criteria:**

- `GET /videos/:videoId/stream-url` do dono de um vídeo `'ready'` retorna `200` com `url` no host de `S3_PUBLIC_ENDPOINT` e `expiresInSeconds` igual a `VIDEO_URL_TTL_SECONDS`.
- Um `GET` com `Range: bytes=0-1023` na `url` de stream retorna `206` com `Content-Type` igual ao `mimeType` do vídeo.
- `GET /videos/:videoId/download-url` do dono retorna `200` com uma `url` cujo `GET` responde com `Content-Disposition: attachment` e o nome original do arquivo.
- Os dois endpoints para um vídeo em `'uploading'`, `'processing'` ou `'failed'` retornam `409` com `error: "VIDEO_NOT_READY"`.
- Os dois endpoints chamados por outro usuário retornam `404` com `error: "VIDEO_NOT_FOUND"`; sem token retornam `401`.

---

### SI-03.13 — Contrato OpenAPI, `api.http` e documentação do ambiente

**Description:** Publica o contrato dos novos endpoints no `openapi.json` versionado (insumo do slice de frontend) e documenta os novos serviços, comandos e checagens de prontidão do ambiente.

**Technical actions:**

1. Rodar `npm run openapi:export` dentro do container e versionar `nestjs-project/openapi.json` com os 7 endpoints de `### API Contracts`, incluindo os schemas de erro por status (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`). A cópia em `next-frontend/openapi.json` e os tipos gerados ficam com o slice de frontend da fase 03.
2. Acrescentar a `nestjs-project/api.http` o fluxo completo: `POST /videos` → `POST .../upload/parts` → `PUT` na URL presignada → `GET .../upload/parts` → `POST .../upload/complete` → `GET /videos/:videoId` → `GET .../stream-url` → `GET .../download-url`.
3. Atualizar `nestjs-project/CLAUDE.md`: serviços `storage`, `redis`, `video-worker` (portas e papel), checagens de prontidão (`redis-cli ping`, `/garage status`), `docker/garage/bootstrap.sh` + `npm run storage:cors` como passo de primeira subida, `npm run start:worker:dev` como processo de longa duração e a regra de que o worker, assim como o servidor da API, só sobe quando o usuário pedir.

**Tests:** _(empty — regeneração de contrato e documentação; `openapi-export.integration-spec.ts` existente cobre a exportação)_

**Dependencies:** SI-03.5, SI-03.6, SI-03.7, SI-03.11, SI-03.12 — todos os endpoints e decoradores OpenAPI precisam existir; SI-03.10 — o worker completo é documentado.

**Acceptance criteria:**

- `nestjs-project/openapi.json` contém `paths` para `/videos`, `/videos/{videoId}`, `/videos/{videoId}/upload/parts`, `/videos/{videoId}/upload/complete`, `/videos/{videoId}/stream-url` e `/videos/{videoId}/download-url`, cada um com respostas de erro documentadas.
- Rodar `npm run openapi:export` de novo, sem mudanças de código, não altera o `openapi.json` versionado.
- Seguindo apenas o `nestjs-project/CLAUDE.md`, um ambiente limpo sobe com `storage`, `redis` e `video-worker` prontos e com os buckets criados.

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier — never exposed in URLs (per `phase-03-upload-processing/TD-11`) |
| public_id | varchar(11) | unique, not null | Random 11-char base64url ID (`node:crypto`, 66 bits); regenerated on unique-violation retry. Exposed on the wire as `videoId` and used in every API path (per `phase-03-upload-processing/TD-11`) |
| channel_id | uuid | FK → channels.id, not null | Owning channel; ownership check is `channel.user_id = JWT sub` |
| processing_status | enum | not null, default `'uploading'`, values: `'uploading'`, `'processing'`, `'ready'`, `'failed'` | PostgreSQL enum type. Written by API (`uploading → processing`) and worker (`processing → ready | failed`). Exposed as `processingStatus` (per `phase-03-upload-processing/TD-13`) |
| publication_status | enum | not null, default `'draft'`, values: `'draft'` | PostgreSQL enum type. `'published'` is added in Phase 04 (user-driven); `visibility` arrives in Phase 04 as a third independent field. Exposed as `publicationStatus` (per `phase-03-upload-processing/TD-13`) |
| original_filename | varchar(255) | not null | Filename declared at initiate |
| mime_type | varchar(100) | not null | Declared MIME, checked against the allowlist at initiate (per `phase-03-upload-processing/TD-12`) |
| size_bytes | bigint | not null | Declared size at initiate; overwritten with the real `ContentLength` from `HeadObject` at complete (per `phase-03-upload-processing/TD-12`). Transformer to `number` (≤ 10GB is within `Number.MAX_SAFE_INTEGER`) |
| source_key | varchar(255) | not null | Object key of the original video in the private videos bucket |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId`; set at initiate, cleared to `null` after `CompleteMultipartUpload` or abort (per `phase-03-upload-processing/TD-01`) |
| part_size_bytes | integer | not null | Server-dictated part size at initiate (per `phase-03-upload-processing/TD-12`) |
| part_count | integer | not null | `ceil(size_bytes / part_size_bytes)`; ≤ 10,000 (per `phase-03-upload-processing/TD-01`) |
| duration_seconds | numeric(12,3) | nullable | Filled by worker from ffprobe `format.duration` (per `phase-03-upload-processing/TD-08`) |
| width | integer | nullable | Filled by worker from the first video stream |
| height | integer | nullable | Filled by worker from the first video stream |
| video_codec | varchar(50) | nullable | ffprobe `codec_name` of the first video stream |
| audio_codec | varchar(50) | nullable | ffprobe `codec_name` of the first audio stream; `null` when the file has no audio |
| thumbnail_key | varchar(255) | nullable | Object key in the public-read thumbnails bucket, keyed by unguessable ID (per `phase-03-upload-processing/TD-10`) |
| failure_reason | varchar(50) | nullable | Set when `processing_status = 'failed'`; one of `FILE_TOO_LARGE`, `UNSUPPORTED_CODEC`, `PROBE_FAILED`, `PROCESSING_ERROR`, `UPLOAD_ABANDONED` |
| upload_completed_at | timestamp | nullable | Set when `POST /videos/:videoId/upload/complete` succeeds |
| processed_at | timestamp | nullable | Set when the worker moves the video to `ready` or `failed` |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn`; also the reference for the abandoned-upload window (per `phase-03-upload-processing/TD-12`) |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`, `onDelete: 'CASCADE'`); Channel → Video (one-to-many, inverse side)
**Indexes:** `(public_id)` — unique; `(channel_id)` — FK; `(processing_status, created_at)` — composite for the abandoned-upload cleanup query (per `phase-03-upload-processing/TD-12`)
**Service-level invariants (per `phase-03-upload-processing/TD-13`):** each status field has one writer — the API never sets `ready`/`failed` except for the oversize rejection at complete (TD-12); the worker (processor + cleanup job) never touches `publication_status`. Invalid combinations (e.g., publishing while `failed`) are guarded in Phase 04's service, not by DB constraints.

### API Contracts

All endpoints below require `Authorization: Bearer <access_token>` (global `JwtAuthGuard`, per `phase-02-auth/TD-02`) and are owner-only (see Authorization Matrix). `:videoId` is always the 11-char public ID (`public_id`), never the internal UUID (per `phase-03-upload-processing/TD-11`). A video that does not exist **or** is not owned by the caller answers `404 VIDEO_NOT_FOUND` — drafts are never revealed to non-owners (per `phase-03-upload-processing/TD-10` revision 2026-10-27). Error bodies use the inherited `{ statusCode, error, message }` envelope (per `phase-02-auth/TD-07`). No video byte ever crosses the API: uploads go browser → storage through presigned part URLs and playback/download go storage → browser through presigned GET URLs (per `phase-03-upload-processing/TD-01`, `phase-03-upload-processing/TD-10`).

**Shared response schema — `VideoResponseDto`** (returned by `POST /videos/:videoId/upload/complete` and `GET /videos/:videoId`):
- videoId: string — 11-char base64url public ID
- processingStatus: `'uploading' | 'processing' | 'ready' | 'failed'`
- publicationStatus: `'draft'`
- originalFilename: string
- mimeType: string
- sizeBytes: number
- durationSeconds: number | null
- width: number | null
- height: number | null
- thumbnailUrl: string | null — stable public URL of the thumbnail (public-read, unguessable key); `null` until `ready` (per `phase-03-upload-processing/TD-10`)
- failureReason: string | null
- createdAt: string (ISO-8601)

---

#### POST /videos (SI-03.5)

Creates the draft video row **and** the S3 multipart upload in one call (per `phase-03-upload-processing/TD-02`). Part URLs are not returned here — they are signed on demand.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- filename: string, required — non-empty, max 255 characters
- size: number, required — integer ≥ 1 (bytes)
- mimeType: string, required — non-empty

**Response 201:**
- videoId: string — 11-char public ID
- uploadId: string — S3 multipart `UploadId`
- partSize: number — server-dictated part size in bytes (`UPLOAD_PART_SIZE_BYTES`)
- partCount: number — `ceil(size / partSize)`
- processingStatus: `'uploading'`
- publicationStatus: `'draft'`

**Error responses:**
- 400 FILE_TOO_LARGE: when the declared `size` exceeds `UPLOAD_MAX_SIZE_BYTES` (10GB)
- 400 UNSUPPORTED_VIDEO_TYPE: when `mimeType` is outside the allowlist (`video/mp4`, `video/webm`)
- 400 VALIDATION_ERROR: when the request body fails schema validation
- 401 Unauthorized: when the access token is missing or invalid

---

#### POST /videos/:videoId/upload/parts (SI-03.6)

Signs `UploadPart` URLs on demand against the **public** presigner client (per `phase-03-upload-processing/TD-05`). Also used to re-sign missing parts when resuming (per `phase-03-upload-processing/TD-01`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- partNumbers: number[], required — 1 to 100 unique integers, each within `1..partCount`

**Response 200:**
- parts: `{ partNumber: number, url: string }[]` — presigned `PUT` URLs, one per requested part
- expiresInSeconds: number — `UPLOAD_PART_URL_TTL_SECONDS`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller
- 409 UPLOAD_NOT_IN_PROGRESS: when `processingStatus` is not `'uploading'`
- 400 INVALID_PART_NUMBER: when any part number is greater than `partCount`
- 400 VALIDATION_ERROR: when the request body fails schema validation
- 401 Unauthorized: when the access token is missing or invalid

---

#### GET /videos/:videoId/upload/parts (SI-03.6)

Resume support: lists the parts storage already holds (`ListParts`), so the client re-signs and re-uploads only the missing ones (per `phase-03-upload-processing/TD-01`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- uploadId: string
- partSize: number
- partCount: number
- uploadedParts: `{ partNumber: number, etag: string, size: number }[]` — ordered by `partNumber`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller
- 409 UPLOAD_NOT_IN_PROGRESS: when `processingStatus` is not `'uploading'`
- 401 Unauthorized: when the access token is missing or invalid

---

#### POST /videos/:videoId/upload/complete (SI-03.7)

Explicit completion signal (per `phase-03-upload-processing/TD-02`): `CompleteMultipartUpload` → `HeadObject` size verification (per `phase-03-upload-processing/TD-12`) → `processingStatus: 'processing'` committed → `process-video` job enqueued after commit (per `phase-03-upload-processing/TD-06`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- parts: `{ partNumber: number, etag: string }[]`, required — 1 to 10,000 entries, unique `partNumber`, each within `1..partCount`; `etag` non-empty

**Response 200:** `VideoResponseDto` with `processingStatus: 'processing'`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller
- 409 UPLOAD_NOT_IN_PROGRESS: when `processingStatus` is not `'uploading'` (includes a repeated complete call)
- 400 INVALID_UPLOAD_PARTS: when storage rejects the part list (missing part, wrong ETag, part below the 5 MiB minimum except the last)
- 400 FILE_TOO_LARGE: when the real object size from `HeadObject` exceeds `UPLOAD_MAX_SIZE_BYTES`; the object is deleted and the video is set to `processingStatus: 'failed'`, `failureReason: 'FILE_TOO_LARGE'`
- 400 VALIDATION_ERROR: when the request body fails schema validation
- 401 Unauthorized: when the access token is missing or invalid

---

#### GET /videos/:videoId (SI-03.11)

Owner-only video details; the polling surface for upload/processing state in the FE slice (per `phase-03-upload-processing/TD-13`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:** `VideoResponseDto`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller
- 401 Unauthorized: when the access token is missing or invalid

---

#### GET /videos/:videoId/stream-url (SI-03.12)

Issues a presigned `GetObject` URL for inline playback (Range requests served by storage) — signed by the public presigner client, TTL sized to a viewing session; the client re-fetches on `403` from storage (per `phase-03-upload-processing/TD-09`, `phase-03-upload-processing/TD-10`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned GET URL with `response-content-disposition=inline` and `response-content-type` = stored `mimeType`
- expiresInSeconds: number — `VIDEO_URL_TTL_SECONDS`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller
- 409 VIDEO_NOT_READY: when `processingStatus` is not `'ready'`
- 401 Unauthorized: when the access token is missing or invalid

---

#### GET /videos/:videoId/download-url (SI-03.12)

Issues a presigned `GetObject` URL that forces a file download of the original (per `phase-03-upload-processing/TD-09`, `phase-03-upload-processing/TD-10`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned GET URL with `response-content-disposition=attachment; filename="<originalFilename>"` (RFC 6266 `filename*` for non-ASCII names)
- expiresInSeconds: number — `VIDEO_URL_TTL_SECONDS`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller
- 409 VIDEO_NOT_READY: when `processingStatus` is not `'ready'`
- 401 Unauthorized: when the access token is missing or invalid

---

#### Validation Rules — Videos

- `filename`: required, string, trimmed non-empty, max 255 characters
- `size`: required, integer, min 1; the 10GB ceiling is a domain rule (`FILE_TOO_LARGE`), not a DTO rule, so the FE receives a stable code
- `mimeType`: required, non-empty string; allowlist membership is a domain rule (`UNSUPPORTED_VIDEO_TYPE`)
- `partNumbers`: required array, `ArrayMinSize(1)`, `ArrayMaxSize(100)`, `ArrayUnique`, each integer ≥ 1; upper bound (`partCount`) is a domain rule (`INVALID_PART_NUMBER`)
- `parts`: required array, `ArrayMinSize(1)`, `ArrayMaxSize(10000)`, nested `ValidateNested` + `@Type`; `partNumber` integer ≥ 1, `etag` non-empty string; uniqueness by `partNumber` enforced in the service (`INVALID_UPLOAD_PARTS`)
- `:videoId` path param: exactly 11 chars matching `^[A-Za-z0-9_-]{11}$`; a malformed value answers `404 VIDEO_NOT_FOUND` (not 400) so the route never hints at ID shape

### Authorization Matrix

Every video is `publicationStatus: 'draft'` in Phase 03, so video bytes and video metadata are owner-only; the anonymous/authenticated rule for published videos is deferred to Phase 04/05 (per `phase-03-upload-processing/TD-10` revision 2026-10-27). "Owner" = the authenticated user whose channel owns the video (`channels.user_id = JWT sub`). Non-owners receive `404 VIDEO_NOT_FOUND`, not `403`.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ (401) | ✓ (creates own draft) | — |
| POST /videos/:videoId/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:videoId/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:videoId/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:videoId | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:videoId/stream-url | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:videoId/download-url | ✗ (401) | ✗ (404) | ✓ |
| Storage: presigned part PUT / video GET URLs | bearer capability while the signature is valid (TTL-bound) | same | same |
| Storage: thumbnail object (public-read bucket) | ✓ (unguessable key) | ✓ | ✓ |

### Error Catalog

Inherits the `{ statusCode, error, message }` envelope and the `VALIDATION_ERROR` (400) / Nest default `Unauthorized` (401) responses from Phase 02 (per `phase-02-auth/TD-07`). New domain codes are `DomainException` subclasses in `src/common/exceptions/domain.exception.ts`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| FILE_TOO_LARGE | 400 | Initiate with declared `size` > `UPLOAD_MAX_SIZE_BYTES`, or complete when `HeadObject` reports a real size above it (object deleted, video `failed`) |
| UNSUPPORTED_VIDEO_TYPE | 400 | Initiate with `mimeType` outside the allowlist (`video/mp4`, `video/webm`) |
| INVALID_PART_NUMBER | 400 | Part signing request with a part number greater than the video's `partCount` |
| INVALID_UPLOAD_PARTS | 400 | Complete with duplicate part numbers, or storage rejects `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) |
| VIDEO_NOT_FOUND | 404 | Any `:videoId` route when the public ID is malformed, unknown, or owned by another user's channel |
| UPLOAD_NOT_IN_PROGRESS | 409 | Part signing, part listing or complete when `processingStatus` ≠ `'uploading'` |
| VIDEO_NOT_READY | 409 | Stream/download URL request when `processingStatus` ≠ `'ready'` |

**Worker-side failure reasons** (persisted in `failure_reason`, surfaced as `failureReason`; never HTTP errors):

| failureReason | Set by | Trigger |
|---------------|--------|---------|
| FILE_TOO_LARGE | API (complete) | Real object size above the limit (per `phase-03-upload-processing/TD-12`) |
| UNSUPPORTED_CODEC | Worker | Container/codec outside the browser-playable allowlist: MP4 → H.264 video + AAC audio (or no audio); WebM → VP9 video + Opus audio (or no audio) (per `phase-03-upload-processing/TD-09`) |
| PROBE_FAILED | Worker | `ffprobe` exits non-zero, times out, or finds no video stream (per `phase-03-upload-processing/TD-08`) |
| PROCESSING_ERROR | Worker | Remux, thumbnail or storage step failed after the last BullMQ attempt (per `phase-03-upload-processing/TD-06`) |
| UPLOAD_ABANDONED | Cleanup job | Video left in `'uploading'` beyond `UPLOAD_STALE_AFTER_HOURS` (per `phase-03-upload-processing/TD-12`) |

### Events/Messages

Queue broker: BullMQ on Redis (`redis` Compose service), registered through `@nestjs/bullmq` `BullModule.forRootAsync` with the connection taken from the `queue` config namespace (per `phase-03-upload-processing/TD-06`). Producers live in the API process; processors live only in the video worker process (`src/worker.ts` → `WorkerModule`), never in `AppModule` (per `phase-03-upload-processing/TD-07`).

#### `video-processing` queue — job `process-video`

**Payload:**

```json
{ "videoId": "uuid (internal videos.id)" }
```

**Producer:** `VideoProcessingProducer` (wrapping `@InjectQueue('video-processing')`), called by `VideosService.completeUpload` **after** the `processing_status = 'processing'` update commits (per `phase-03-upload-processing/TD-02`, `phase-03-upload-processing/TD-06`)
**Consumer:** `VideoProcessingProcessor extends WorkerHost` in the video worker (per `phase-03-upload-processing/TD-07`): download source → `ffprobe` → codec allowlist check → MP4 faststart remux (`-c copy -movflags +faststart`) only when `moov` follows `mdat` → thumbnail frame extraction → upload thumbnail to the public-read bucket → persist metadata + `processing_status = 'ready'` (or `'failed'` + `failure_reason`) (per `phase-03-upload-processing/TD-08`, `phase-03-upload-processing/TD-09`, `phase-03-upload-processing/TD-10`)
**Trigger:** successful `POST /videos/:videoId/upload/complete`
**Delivery semantics:** at-least-once (per `phase-03-upload-processing/TD-06`). `jobId` = internal video UUID to dedupe repeated enqueues; the processor is idempotent — it exits early unless the row is still `'processing'`, and object writes overwrite deterministic keys. Bounded `attempts` with exponential `backoff`; non-retryable outcomes (`UNSUPPORTED_CODEC`, `PROBE_FAILED`) mark the video `failed` without throwing; on the final failed attempt the video becomes `failed` with `PROCESSING_ERROR`. Worker `concurrency` is configurable (`VIDEO_WORKER_CONCURRENCY`).

#### `video-maintenance` queue — job scheduler `cleanup-abandoned-uploads`

**Payload:**

```json
{}
```

**Producer:** job scheduler upserted at worker bootstrap via `Queue.upsertJobScheduler('cleanup-abandoned-uploads', { every: UPLOAD_CLEANUP_INTERVAL_MS })` — idempotent across restarts (per `phase-03-upload-processing/TD-06`, `phase-03-upload-processing/TD-12`)
**Consumer:** `UploadCleanupProcessor extends WorkerHost` in the video worker: selects videos with `processing_status = 'uploading'` and `created_at` older than `UPLOAD_STALE_AFTER_HOURS`, calls `AbortMultipartUpload` for each `upload_id` (ignoring `NoSuchUpload`), then sets `processing_status = 'failed'`, `failure_reason = 'UPLOAD_ABANDONED'`, `upload_id = null` (per `phase-03-upload-processing/TD-12`)
**Trigger:** fixed interval schedule
**Delivery semantics:** at-least-once; the cleanup is idempotent (aborting an already-aborted upload and re-failing an already-failed row are no-ops). Backend-only — not visible to the frontend except through the resulting `failureReason`.

---

## Dependency Map

```
SI-03.1 (root — infra: storage, redis, worker service, config)
├── SI-03.2 — depends on SI-03.1 (storage service + storageConfig)
│   ├── SI-03.4 — depends on SI-03.1, SI-03.2, SI-03.3 (redis + StorageModule + Video in forFeature)
│   │   └── SI-03.5 — depends on SI-03.2, SI-03.3, SI-03.4 (multipart + entity + VideosModule)
│   │       └── SI-03.6 — depends on SI-03.5 (draft with upload_id; findOwnedVideo introduced here)
│   │           ├── SI-03.7 — depends on SI-03.4, SI-03.6 (producer + uploadable parts)
│   │           │   └── SI-03.11 — depends on SI-03.7 (VideoResponseDto + mapper)
│   │           └── SI-03.12 — depends on SI-03.2, SI-03.6 (presignGetObject + findOwnedVideo)
│   └── SI-03.9 — depends on SI-03.2, SI-03.3, SI-03.4, SI-03.8 (storage + entity + queue + media)
│       └── SI-03.10 — depends on SI-03.9 (WorkerModule)
└── SI-03.8 — depends on SI-03.1 (ffmpeg/ffprobe in the image)
SI-03.3 (root, independent — Video entity + migration)
SI-03.13 — depends on SI-03.5, SI-03.6, SI-03.7, SI-03.10, SI-03.11, SI-03.12 (all endpoints + worker in place)
```

**Cross-slice edge (informative):** the upcoming Phase 03 frontend slice (upload UI, player, download button) inherits the Cross-layer TDs and consumes `nestjs-project/openapi.json` produced by SI-03.13.

---

## Deliverables

- [x] SI-03.1 — Infra: dependências, serviços Compose (storage, Redis, worker) e namespaces de configuração
- [x] SI-03.2 — StorageModule com clientes S3 interno e de presign
- [x] SI-03.3 — Entidade Video, migration e gerador de public ID
- [x] SI-03.4 — Fundação de filas (BullMQ) e producer de processamento
- [x] SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)
- [x] SI-03.6 — Endpoints de partes: assinatura sob demanda e listagem para retomada
- [ ] SI-03.7 — Endpoint POST /videos/:videoId/upload/complete (finalização + enfileiramento)
- [ ] SI-03.8 — Wrapper tipado de FFprobe/FFmpeg e fixtures de vídeo
- [ ] SI-03.9 — Video worker: entrypoint dedicado e processor `process-video`
- [ ] SI-03.10 — Job agendado de limpeza de uploads abandonados
- [ ] SI-03.11 — Endpoint GET /videos/:videoId (detalhes e status do vídeo)
- [ ] SI-03.12 — Endpoints de URL de streaming e de download
- [ ] SI-03.13 — Contrato OpenAPI, `api.http` e documentação do ambiente

**Full test suites:**

- [ ] Backend unit + integration tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully, including the worker entrypoint (`docker compose exec nestjs-api npm run build` → `dist/main.js` and `dist/worker.js`)
