---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.6
target_file: test/videos-upload-parts.e2e-spec.ts
---

# Upload Parts Endpoints Test Plan

## Application Overview

Os endpoints de partes permitem upload paralelo e retomável sem que nenhum byte de vídeo passe pela API. `POST /videos/:videoId/upload/parts` assina sob demanda URLs presignadas de `UploadPart` (TTL `UPLOAD_PART_URL_TTL_SECONDS`) com o cliente de presign público; `GET /videos/:videoId/upload/parts` lista (`ListParts`) as partes que o storage já recebeu, ordenadas por `partNumber`, para que o cliente reenvie só as que faltam. Ambos são owner-only: vídeo inexistente, de outro channel ou com `videoId` malformado responde `404 VIDEO_NOT_FOUND`; fora de `'uploading'` responde `409 UPLOAD_NOT_IN_PROGRESS`. Part number acima de `partCount` é regra de domínio (`INVALID_PART_NUMBER`); o shape do body é validado pelo `ValidationPipe` (`VALIDATION_ERROR`).

## Test Scenarios

### 1. POST /videos/:videoId/upload/parts

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); `afterAll(() => app.close())`. `beforeEach`: `cleanAllTables(dataSource)`, esvaziar os buckets `videos-test`/`thumbnails-test` via helper `src/test/storage.ts`, limpar o storage do throttler, semear dois usuários confirmados com channel (dono e não-dono) com `access_token` via `POST /auth/login`, e criar um rascunho do dono via `POST /videos` (ex.: `size` = `200000000` → `partCount` = `3`).

#### 1.1. sign-parts-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. POST /videos/:videoId/upload/parts como dono com `{ "partNumbers": [1, 2] }`
    - expect: status `200`
    - expect: `parts` tem 2 itens com `partNumber` `1` e `2`, cada um com `url` string
    - expect: o host de cada `url` é o host de `S3_PUBLIC_ENDPOINT` configurado no ambiente de teste
    - expect: `expiresInSeconds` = `UPLOAD_PART_URL_TTL_SECONDS` configurado

#### 1.2. sign-parts-invalid-part-number

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. POST /videos/:videoId/upload/parts como dono com `{ "partNumbers": [4] }` (`partCount` = `3`)
    - expect: status `400`
    - expect: `error` = `"INVALID_PART_NUMBER"`

#### 1.3. sign-parts-validation-error

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. POST /videos/:videoId/upload/parts como dono com `{ "partNumbers": [] }`
    - expect: status `400`
    - expect: `error` = `"VALIDATION_ERROR"`

#### 1.4. sign-parts-video-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. POST /videos/:videoId/upload/parts com o `videoId` do dono, autenticado como não-dono, body `{ "partNumbers": [1] }`
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`
  2. Mesma chamada como dono com um `videoId` bem-formado inexistente (11 caracteres válidos)
    - expect: status `404`, `error` = `"VIDEO_NOT_FOUND"`
  3. Mesma chamada como dono com um `videoId` malformado (ex.: `"abc"`)
    - expect: status `404`, `error` = `"VIDEO_NOT_FOUND"` (nunca `400`)

#### 1.5. sign-parts-upload-not-in-progress

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Atualizar a linha do vídeo para `processing_status = 'processing'` via repositório
  2. POST /videos/:videoId/upload/parts como dono com `{ "partNumbers": [1] }`
    - expect: status `409`
    - expect: `error` = `"UPLOAD_NOT_IN_PROGRESS"`

### 2. GET /videos/:videoId/upload/parts

**Setup:** mesmo bootstrap e `beforeEach` do grupo 1 (dono, não-dono e rascunho do dono criados via `POST /videos`).

#### 2.1. list-parts-after-part-upload

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. POST /videos/:videoId/upload/parts como dono com `{ "partNumbers": [1] }` e fazer `PUT` de um buffer de ≥ 5 MiB na `url` retornada
    - expect: o storage responde `200` ao `PUT` com header `ETag`
  2. GET /videos/:videoId/upload/parts como dono
    - expect: status `200`
    - expect: `uploadId`, `partSize` e `partCount` iguais aos devolvidos pelo `POST /videos`
    - expect: `uploadedParts` tem exatamente 1 item `{ partNumber: 1, etag, size }`, com `etag` igual ao `ETag` do `PUT` e `size` igual ao tamanho do buffer enviado

#### 2.2. list-parts-video-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. GET /videos/:videoId/upload/parts com o `videoId` do dono, autenticado como não-dono
    - expect: status `404`, `error` = `"VIDEO_NOT_FOUND"`
  2. GET como dono com um `videoId` bem-formado inexistente e com um `videoId` malformado
    - expect: ambos `404`, `error` = `"VIDEO_NOT_FOUND"`

#### 2.3. list-parts-upload-not-in-progress

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Atualizar a linha do vídeo para `processing_status = 'processing'` via repositório
  2. GET /videos/:videoId/upload/parts como dono
    - expect: status `409`
    - expect: `error` = `"UPLOAD_NOT_IN_PROGRESS"`
