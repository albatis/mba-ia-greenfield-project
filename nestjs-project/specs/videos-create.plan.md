---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.5
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo: em uma única chamada autenticada cria a linha do rascunho em `videos` (`processing_status = 'uploading'`, `publication_status = 'draft'`) no channel do usuário e o multipart upload no storage S3-compatível, devolvendo o `videoId` público de 11 caracteres, o `uploadId` e o plano de partes ditado pelo servidor (`partSize` = `UPLOAD_PART_SIZE_BYTES`, `partCount = ceil(size / partSize)`). Tamanho declarado acima de `UPLOAD_MAX_SIZE_BYTES` e MIME fora da allowlist (`video/mp4`, `video/webm`) são regras de domínio com códigos estáveis (`FILE_TOO_LARGE`, `UNSUPPORTED_VIDEO_TYPE`) e não tocam o storage; o shape do body é validado pelo `ValidationPipe` global (`VALIDATION_ERROR`).

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); `afterAll(() => app.close())`. `beforeEach`: `cleanAllTables(dataSource)`, esvaziar os buckets `videos-test`/`thumbnails-test` via helper `src/test/storage.ts`, limpar o storage do throttler e semear um usuário confirmado com channel, obtendo o `access_token` via `POST /auth/login`.

#### 1.1. initiate-upload-success

**Covers AC:** #1, #6
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ "filename": "a.mp4", "size": 200000000, "mimeType": "video/mp4" }`
    - expect: status `201`
    - expect: `videoId` é uma string de 11 caracteres casando `^[A-Za-z0-9_-]{11}$`
    - expect: `uploadId` é uma string não vazia
    - expect: `partSize` = `67108864`, `partCount` = `3`, `processingStatus` = `"uploading"`, `publicationStatus` = `"draft"`
  2. Consultar a linha em `videos` com `public_id` = `videoId`
    - expect: `channel_id` é o id do channel do usuário autenticado
    - expect: `upload_id` é igual ao `uploadId` retornado
    - expect: `original_filename` = `"a.mp4"`, `mime_type` = `"video/mp4"`, `part_count` = `3`

#### 1.2. initiate-upload-file-too-large

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "big.mp4", "size": 10737418241, "mimeType": "video/mp4" }`
    - expect: status `400`
    - expect: body `{ statusCode: 400, error: "FILE_TOO_LARGE", message }`
  2. Contar linhas em `videos`
    - expect: `0` linhas

#### 1.3. initiate-upload-unsupported-type

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "a.mov", "size": 1000, "mimeType": "video/quicktime" }`
    - expect: status `400`
    - expect: `error` = `"UNSUPPORTED_VIDEO_TYPE"`
  2. Contar linhas em `videos`
    - expect: `0` linhas

#### 1.4. initiate-upload-validation-error

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. POST /videos autenticado com `{ "size": 1000, "mimeType": "video/mp4" }` (sem `filename`)
    - expect: status `400`
    - expect: `error` = `"VALIDATION_ERROR"` (prova que o `ValidationPipe` está ligado ao endpoint)

#### 1.5. initiate-upload-unauthenticated

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. POST /videos sem header `Authorization` com body válido
    - expect: status `401`
  2. Contar linhas em `videos`
    - expect: `0` linhas
