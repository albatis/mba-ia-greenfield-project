---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.12
target_file: test/videos-media-urls.e2e-spec.ts
---

# Stream & Download URL Endpoints Test Plan

## Application Overview

`GET /videos/:videoId/stream-url` e `GET /videos/:videoId/download-url` entregam ao dono URLs presignadas de `GetObject` de curta duração (TTL `VIDEO_URL_TTL_SECONDS`), assinadas pelo cliente de presign público, para que bytes de vídeo nunca passem pela API nem pelo BFF. A URL de stream força `response-content-disposition=inline` e `response-content-type` = `mime_type` armazenado, com Range servido direto pelo storage; a de download força `attachment` com o nome original (RFC 6266, `filename*` UTF-8 para nomes não-ASCII). Só vídeos `'ready'` têm URL (`409 VIDEO_NOT_READY` caso contrário); não-dono recebe `404 VIDEO_NOT_FOUND` e requisição sem token recebe `401`.

## Test Scenarios

### 1. GET /videos/:videoId/stream-url

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); `afterAll(() => app.close())`. `beforeEach`: `cleanAllTables(dataSource)`, esvaziar os buckets `videos-test`/`thumbnails-test` via helper `src/test/storage.ts`, limpar o storage do throttler, semear dono e não-dono (confirmados, com channel) com `access_token` via `POST /auth/login`. Vídeo `'ready'`: criar o rascunho via `POST /videos` (`filename` = `"meu vídeo.mp4"`, `mimeType` = `"video/mp4"`), gravar a fixture `test/fixtures/videos/h264-aac-faststart.mp4` no `source_key` do bucket `videos-test` e atualizar a linha para `processing_status = 'ready'` via repositório. As URLs presignadas são buscadas de dentro do container (o presign de teste usa o endpoint interno do storage).

#### 1.1. stream-url-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. GET /videos/:videoId/stream-url como dono de um vídeo `'ready'`
    - expect: status `200`
    - expect: o host de `url` é o host de `S3_PUBLIC_ENDPOINT` configurado no ambiente de teste
    - expect: `expiresInSeconds` = `VIDEO_URL_TTL_SECONDS` configurado
    - expect: a query de `url` contém `response-content-disposition=inline` e `response-content-type=video/mp4`

#### 1.2. stream-url-range-request

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. GET /videos/:videoId/stream-url como dono de um vídeo `'ready'`
  2. `GET` direto na `url` retornada com header `Range: bytes=0-1023`
    - expect: status `206`
    - expect: `Content-Type` = `"video/mp4"` (o `mimeType` do vídeo)
    - expect: corpo com 1024 bytes e `Content-Range` começando com `bytes 0-1023/`

#### 1.3. stream-url-not-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Para cada `processing_status` em `'uploading'`, `'processing'` e `'failed'` (atualizado via repositório), GET /videos/:videoId/stream-url como dono
    - expect: status `409`
    - expect: `error` = `"VIDEO_NOT_READY"`

#### 1.4. stream-url-not-owner-and-unauthenticated

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. GET /videos/:videoId/stream-url de um vídeo `'ready'` do dono, autenticado como não-dono
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`
  2. GET /videos/:videoId/stream-url sem header `Authorization`
    - expect: status `401`

### 2. GET /videos/:videoId/download-url

**Setup:** mesmo bootstrap e `beforeEach` do grupo 1 (vídeo `'ready'` do dono com a fixture gravada no `source_key`).

#### 2.1. download-url-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. GET /videos/:videoId/download-url como dono de um vídeo `'ready'`
    - expect: status `200`
    - expect: `url` string e `expiresInSeconds` = `VIDEO_URL_TTL_SECONDS` configurado
  2. `GET` direto na `url` retornada
    - expect: status `200`
    - expect: header `Content-Disposition` começa com `attachment` e contém o nome original (`filename*=UTF-8''meu%20v%C3%ADdeo.mp4` para o nome não-ASCII)

#### 2.2. download-url-not-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Para cada `processing_status` em `'uploading'`, `'processing'` e `'failed'` (atualizado via repositório), GET /videos/:videoId/download-url como dono
    - expect: status `409`
    - expect: `error` = `"VIDEO_NOT_READY"`

#### 2.3. download-url-not-owner-and-unauthenticated

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. GET /videos/:videoId/download-url de um vídeo `'ready'` do dono, autenticado como não-dono
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`
  2. GET /videos/:videoId/download-url sem header `Authorization`
    - expect: status `401`
