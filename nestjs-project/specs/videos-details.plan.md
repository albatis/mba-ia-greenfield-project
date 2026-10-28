---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.11
target_file: test/videos-details.e2e-spec.ts
---

# GET /videos/:videoId Test Plan

## Application Overview

`GET /videos/:videoId` expõe ao dono o estado do vídeo no shape `VideoResponseDto` — status de processamento e de publicação, metadados técnicos (`durationSeconds`, `width`, `height`) preenchidos pelo worker, `failureReason` quando falhou e `thumbnailUrl` público (base `THUMBNAILS_PUBLIC_BASE_URL` + `thumbnail_key`) apenas quando há thumbnail. É a superfície de polling que o slice de frontend usa durante upload e processamento. Owner-only: não-dono recebe `404 VIDEO_NOT_FOUND` (rascunhos nunca são revelados) e requisição sem token recebe `401`.

## Test Scenarios

### 1. GET /videos/:videoId

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); `afterAll(() => app.close())`. `beforeEach`: `cleanAllTables(dataSource)`, esvaziar os buckets `videos-test`/`thumbnails-test` via helper `src/test/storage.ts`, limpar o storage do throttler, semear dono e não-dono (confirmados, com channel) com `access_token` via `POST /auth/login`, e criar um rascunho do dono via `POST /videos`. Estados `'ready'` e `'failed'` são produzidos atualizando a linha via repositório (o worker não roda no E2E).

#### 1.1. get-video-draft-uploading

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. GET /videos/:videoId como dono logo após o `POST /videos`
    - expect: status `200`
    - expect: `videoId` igual ao retornado pelo `POST /videos`, `processingStatus` = `"uploading"`, `publicationStatus` = `"draft"`
    - expect: `thumbnailUrl` = `null`, `durationSeconds` = `null`, `failureReason` = `null`
    - expect: `originalFilename`, `mimeType` e `sizeBytes` iguais aos declarados; `createdAt` é ISO-8601

#### 1.2. get-video-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Atualizar a linha para `processing_status = 'ready'` com `duration_seconds`, `width`, `height` e `thumbnail_key` preenchidos via repositório
  2. GET /videos/:videoId como dono
    - expect: status `200`, `processingStatus` = `"ready"`
    - expect: `durationSeconds`, `width` e `height` são números iguais aos gravados (`durationSeconds` como number, não string)
    - expect: `thumbnailUrl` começa com `THUMBNAILS_PUBLIC_BASE_URL` configurado e termina com o `thumbnail_key`

#### 1.3. get-video-failed

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. Atualizar a linha para `processing_status = 'failed'` e `failure_reason = 'UNSUPPORTED_CODEC'` via repositório
  2. GET /videos/:videoId como dono
    - expect: status `200`
    - expect: `processingStatus` = `"failed"` e `failureReason` = `"UNSUPPORTED_CODEC"`
    - expect: `thumbnailUrl` = `null`

#### 1.4. get-video-not-owner-and-unauthenticated

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-28T00:14:10Z

**Steps:**
  1. GET /videos/:videoId com o `videoId` do dono, autenticado como não-dono
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`
  2. GET /videos/:videoId sem header `Authorization`
    - expect: status `401`
