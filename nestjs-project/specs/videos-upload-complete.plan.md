---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:videoId/upload/complete Test Plan

## Application Overview

`POST /videos/:videoId/upload/complete` é o sinal explícito de fim de upload: o dono envia a lista `{ partNumber, etag }` das partes, a API executa `CompleteMultipartUpload`, verifica o tamanho real do objeto com `HeadObject`, move o vídeo para `'processing'` (gravando `size_bytes` real, `upload_completed_at` e `upload_id = null`) e, só depois do commit, enfileira o job `process-video` na fila `video-processing` com o UUID interno do vídeo. Duplicatas de `partNumber` ou partes rejeitadas pelo storage respondem `400 INVALID_UPLOAD_PARTS` e mantêm o vídeo retomável; objeto real acima de `UPLOAD_MAX_SIZE_BYTES` é apagado e o vídeo vira `'failed'` (`FILE_TOO_LARGE`); repetir o complete responde `409 UPLOAD_NOT_IN_PROGRESS`; não-dono recebe `404 VIDEO_NOT_FOUND`. A resposta de sucesso é o `VideoResponseDto`.

## Test Scenarios

### 1. POST /videos/:videoId/upload/complete

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); obtém a `Queue` de `video-processing` via `getQueueToken('video-processing')`; `afterAll(() => app.close())`. `beforeEach`: `cleanAllTables(dataSource)`, esvaziar os buckets `videos-test`/`thumbnails-test` via helper `src/test/storage.ts`, `obliterate({ force: true })` na fila `video-processing`, limpar o storage do throttler, semear dono e não-dono (confirmados, com channel) com `access_token` via `POST /auth/login`. Helper de upload real: `POST /videos` com `size` que gere `partCount` = `2` (ex.: `UPLOAD_PART_SIZE_BYTES + 1024`), assinar as partes via `POST .../upload/parts` e fazer `PUT` de um buffer de 5 MiB na parte 1 e de alguns KB na parte 2, guardando os `ETag`s.

#### 1.1. complete-upload-success-enqueues-job

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Executar o helper de upload real (2 partes enviadas)
  2. POST /videos/:videoId/upload/complete como dono com `{ "parts": [{ "partNumber": 1, "etag": <etag1> }, { "partNumber": 2, "etag": <etag2> }] }`
    - expect: status `200`
    - expect: body no shape `VideoResponseDto` com `videoId` igual ao do rascunho, `processingStatus` = `"processing"`, `publicationStatus` = `"draft"`
    - expect: `sizeBytes` = soma dos bytes realmente enviados (não o `size` declarado)
  3. Consultar a linha em `videos`
    - expect: `processing_status = 'processing'`, `upload_id` nulo, `upload_completed_at` preenchido
  4. Listar os jobs da fila `video-processing`
    - expect: exatamente 1 job de nome `process-video` cujo `data.videoId` é o UUID interno (`videos.id`), não o `public_id`

#### 1.2. complete-upload-repeated-conflict

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Executar o helper de upload real e completar com sucesso (`200`)
  2. Repetir POST /videos/:videoId/upload/complete como dono com o mesmo body
    - expect: status `409`
    - expect: `error` = `"UPLOAD_NOT_IN_PROGRESS"`
  3. Listar os jobs da fila `video-processing`
    - expect: continua havendo exatamente 1 job `process-video`

#### 1.3. complete-upload-wrong-etag

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Executar o helper de upload real
  2. POST /videos/:videoId/upload/complete como dono com o `etag` da parte 2 substituído por um valor errado
    - expect: status `400`
    - expect: `error` = `"INVALID_UPLOAD_PARTS"`
  3. Consultar a linha em `videos` e chamar GET /videos/:videoId/upload/parts como dono
    - expect: `processing_status` continua `'uploading'` e `upload_id` continua preenchido
    - expect: a listagem de partes responde `200` com as 2 partes (upload retomável)
  4. Listar os jobs da fila `video-processing`
    - expect: nenhum job

#### 1.4. complete-upload-duplicate-part-number

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Executar o helper de upload real
  2. POST /videos/:videoId/upload/complete como dono com `parts` contendo `partNumber: 1` duas vezes
    - expect: status `400`
    - expect: `error` = `"INVALID_UPLOAD_PARTS"`
  3. Consultar a linha em `videos`
    - expect: `processing_status` continua `'uploading'`

#### 1.5. complete-upload-real-size-too-large

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Em uma instância dedicada da app com o namespace `upload` sobrescrito para um `UPLOAD_MAX_SIZE_BYTES` pequeno (ex.: 6 MiB), criar via `POST /videos` um rascunho declarando `size` = limite (1 parte) e fazer `PUT` de um buffer maior que o limite (ex.: 7 MiB) na parte 1
  2. POST /videos/:videoId/upload/complete como dono com a parte enviada
    - expect: status `400`
    - expect: `error` = `"FILE_TOO_LARGE"`
  3. Verificar o objeto `source_key` no bucket `videos-test` (`HeadObject`)
    - expect: o objeto não existe
  4. Consultar a linha em `videos`
    - expect: `processing_status = 'failed'` e `failure_reason = 'FILE_TOO_LARGE'`
  5. Listar os jobs da fila `video-processing`
    - expect: nenhum job

#### 1.6. complete-upload-not-owner

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Executar o helper de upload real como dono
  2. POST /videos/:videoId/upload/complete autenticado como não-dono com as partes corretas
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`
  3. Consultar a linha em `videos`
    - expect: `processing_status` continua `'uploading'`
