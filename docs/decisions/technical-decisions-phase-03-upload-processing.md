---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-27
scope_description: "Backend + infra slice of Phase 03 — object storage, background queue and video worker, large resumable upload protocol, draft pre-registration, FFmpeg processing (metadata + thumbnail), unique public video ID, streaming/download delivery, and the Cross-layer contracts the upcoming frontend slice will inherit."
covers_capabilities:
  - "Serviço de armazenamento de arquivos (vídeos e thumbnails)"
  - "Serviço de processamento em segundo plano (filas)"
  - "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"
  - "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"
  - "Processamento automático do vídeo após upload (extração de duração e metadados)"
  - "Geração automática de thumbnail a partir de um frame do vídeo"
  - "URL única por vídeo, sem conflito com outros vídeos"
  - "Reprodução via streaming (sem necessidade de download completo)"
  - "Download do vídeo pelo usuário"
depends_on_slices: []
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos (Backend + Infra)

_Subprojects in scope:_

- `nestjs-project/` — primary subproject. Owns the `VideosModule` (draft pre-registration, upload session endpoints, status model, public ID), a `StorageModule` (S3 client, presigning), the queue producer, and — per TD-07 — the video worker entrypoint and FFmpeg processing. Also owns `compose.yaml` additions (object storage, queue broker, worker service) and the Joi env schema.
- `next-frontend/` — **no Frontend-scoped TD in this slice** (user chose to slice Phase 03 like Phase 02; the FE upload screen, upload client library, player and download button go to a dedicated frontend slice). The FE is affected only through the **Cross-layer** TDs here (TD-01, TD-02, TD-05, TD-09, TD-10, TD-11, TD-13), which the frontend slice inherits and must not reopen.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Strict BFF — single server-only `API_URL`:** `next-frontend-config-base/TD-03`. Browser → NestJS direct is forbidden; JSON control calls go through `app/api/**` Route Handlers. That TD explicitly anticipated presigned object-storage URLs as the mechanism for large media.
> - **Route Handler POST + client `fetch` for mutations:** `phase-02-auth-frontend/TD-05`.
> - **Auth:** custom `@nestjs/jwt` guards, `Authorization: Bearer` (`phase-02-auth/TD-02`); upload endpoints reuse them.
> - **Validation / errors / rate limit:** class-validator (`phase-02-auth/TD-06`), domain exception filter + `{ statusCode, error, message }` envelope (`phase-02-auth/TD-07`), `@nestjs/throttler` (`phase-02-auth/TD-08`).
> - **Config:** `@nestjs/config` + Joi + namespaced `registerAs` (`phase-01-configuracao-base/TD-01..TD-04`). New keys from TD-05/TD-06/TD-12 extend the same schema.
> - **OpenAPI contract chain:** `openapi-docs-nestjs/TD-02` + `next-frontend-openapi-typing/*` — every new endpoint is documented and flows to `next-frontend/openapi.json`.
> - **Architecture constraint (C4 diagram):** the Video Worker is its own container, reads/writes Object Storage and updates the DB directly; the API publishes jobs to the queue. "Message Queue: TBD" and "S3 or MinIO" are resolved here (TD-06, TD-03).

---

## TD-01: Large File Upload Protocol (10GB, resumable)

**Scope:** Cross-layer

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** Uploads up to 10GB must not degrade the system and, per project-plan § Pontos de Atenção, must be resumable after a connection failure. Under strict BFF, any protocol that moves bytes through the API also moves them through the Next.js BFF first (browser → Next → Nest → storage) — two full proxies of 10GB. The handshake shape lives on both sides: backend issues/validates; frontend chunks, retries and resumes.

**Options:**

### Option A: S3 Multipart Upload with presigned part URLs (direct browser → object storage)
- API (via BFF) creates the multipart upload and returns presigned `UploadPart` URLs; the browser PUTs parts straight to storage, collects ETags, and asks the API to complete (TD-02). Resume = `ListParts` + re-sign the missing parts.
- **Pros:** zero video bytes through Next or Nest — API/BFF only handle tiny JSON; parallel parts; native resume; S3-standard (works on any S3-compatible server and on AWS later). Mature FE clients exist (`@uppy/aws-s3` multipart) for the FE slice. Already anticipated by `next-frontend-config-base/TD-03`.
- **Cons:** storage must be browser-reachable (TD-05) and have CORS with `ETag` exposed; size/type can only be fully verified after completion (TD-12); part ≥ 5 MiB and ≤ 10,000 parts constrain the part plan.

### Option B: tus resumable protocol (`@tus/server` + `@tus/s3-store`)
- A tus endpoint mounted in Nest receives PATCH chunks and forwards them to S3 multipart via `@tus/s3-store`; client uses `tus-js-client`/Uppy.
- **Pros:** open resumable protocol with excellent client tooling; offsets tracked by the server; size known up-front.
- **Cons:** under strict BFF the bytes must cross Next Route Handlers *and* Nest — the exact "impact on performance" the capability forbids; exposing tus directly to the browser would break `next-frontend-config-base/TD-03`. Adds a tus lock/state store.

### Option C: Custom chunked upload through BFF → API → storage
- Client slices the file and POSTs chunks to a BFF route that proxies to a Nest endpoint, which streams each chunk into an S3 multipart part.
- **Pros:** full server control over every chunk; no storage CORS or public endpoint.
- **Cons:** reinvents resumability; same double-proxy cost as B; long-lived request bodies on both Next and Nest.

**Recommendation:** **Option A** — it is the only option that keeps 10GB of bytes off both the Next.js BFF and the Nest API, which is precisely what "sem impacto na performance" plus strict BFF demand; it is S3-standard so it survives the storage choice (TD-03) and a future move to managed S3.

**Decision:** Option A

---

## TD-02: Draft Pre-registration & Upload Completion Signal

**Scope:** Cross-layer

**Capability:** "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** The video row must exist (as a draft) when the upload starts, and something must tell the system the upload finished so processing can be enqueued. This defines the endpoint sequence the FE slice implements. Depends on TD-01 (A assumed).

**Options:**

### Option A: Client-driven handshake — initiate creates the draft; explicit complete call enqueues
- `POST /videos` (filename, size, MIME) → creates draft row + `CreateMultipartUpload`, returns `videoId`, `uploadId`, part plan. Part URLs signed on demand. `POST /videos/:id/upload/complete` (ETags) → API calls `CompleteMultipartUpload`, `HeadObject` to verify, updates status, enqueues the processing job.
- **Pros:** single, explicit, testable flow owned by the API; no storage-server-specific features; ownership/auth checked at every step; the enqueue happens in the same request that changes status.
- **Cons:** if the browser closes after the last part but before "complete", the upload stays incomplete until resumed or cleaned (TD-12).

### Option B: Storage event notifications trigger processing
- Draft created on initiate as in A, but completion is detected by a bucket notification (webhook/queue) emitted by the storage server on `ObjectCreated`.
- **Pros:** completion is detected even if the client disappears after the final part.
- **Cons:** notification support varies across S3-compatible servers (TD-03) and differs from AWS (SNS/SQS/EventBridge); the client still has to call `CompleteMultipartUpload` (it is a signed request), so the gain is marginal; adds a second ingress path.

**Recommendation:** **Option A** — keeps the whole lifecycle inside one API-owned flow that works identically on any S3-compatible backend; the orphan case it leaves is handled by the cleanup policy in TD-12.

**Decision:** Option A

---

## TD-03: Object Storage Server for Dev/Test (MinIO replacement)

**Scope:** Repo-wide

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** The C4 diagram names "S3 or MinIO", but MinIO Community is archived and its images are gone from Docker Hub (Sep 2026). A self-hosted S3-compatible service is needed in `compose.yaml` for dev and integration tests; production targets managed S3 (Phase 07). Must support: multipart + presigned URLs, CORS (PUT + exposed `ETag`), Range GET, `response-content-disposition` override. Application code only speaks S3 API (TD-04), so the choice is swappable.

**Options:**

### Option A: Garage (Deuxfleurs, Rust, AGPLv3)
- Lightweight S3-compatible server (`dxflrs/garage`); single-node needs a one-time layout/bucket/key bootstrap (CLI), scriptable as an init service.
- **Pros:** in production use since ~2020; official S3 compatibility matrix lists presigned URLs, SigV4, full multipart (incl. `ListParts`), `PutBucketCors` and lifecycle `AbortIncompleteMultipartUpload` as implemented; tiny footprint.
- **Cons:** bootstrap is more manual than MinIO (layout + key creation); region must match its config (`garage`); some multipart edge cases stricter than AWS; no object versioning (not needed here).

### Option B: RustFS (Apache 2.0)
- MinIO-like single binary/container configured via env vars, with web console.
- **Pros:** closest dev UX to MinIO (env credentials, console, near drop-in); permissive license; claims full multipart/presigned/range support.
- **Cons:** 1.0 GA only reported in Sep 2026 (very young; alpha/beta through mid-2026); CORS behaviour not verified in the sources reviewed.

### Option C: SeaweedFS (`weed server -s3`, Apache 2.0)
- Distributed file store with an S3 gateway; single container for dev.
- **Pros:** mature, Apache 2.0, global CORS flag (`-s3.allowedOrigins`) plus bucket-level rules; presigned + multipart supported.
- **Cons:** S3 is a gateway over its own filer model — more moving parts and more S3-semantic quirks; credentials configured via config file / `weed shell`.

**Recommendation:** **Option A (Garage)** — the most proven S3-compatibility record among the replacements, with explicit `PutBucketCors` and multipart support, at the cost of a one-time scripted bootstrap; RustFS is the main alternative if dev ergonomics outweigh maturity. Because TD-04 keeps the code on the plain S3 API, switching later is a compose-only change.

**Decision:** Option A (Garage)

---

## TD-04: S3 Client Library

**Scope:** Backend

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** API (presign, multipart orchestration, head/delete) and worker (download source, upload thumbnail/derivatives) both need an S3 client.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage` for streamed uploads)
- Modular, typed official SDK; custom `endpoint` + `forcePathStyle` for self-hosted servers.
- **Pros:** reference implementation of the S3 API; first-class multipart and presigning; works unchanged against Garage/RustFS/SeaweedFS and AWS; actively released.
- **Cons:** verbose command API; large dependency tree.

### Option B: MinIO JS client (`minio` 8.x)
- Higher-level S3 client from MinIO.
- **Pros:** compact API (`presignedPutObject`, `fPutObject`).
- **Cons:** vendor has abandoned the open-source line — long-term maintenance risk; weaker presigned-multipart ergonomics.

**Recommendation:** **Option A** — the S3 contract is the stable abstraction in this design (TD-03 is swappable precisely because of it), and the official SDK is the safest carrier of that contract.

**Decision:** Option A
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage

**Revisions:**

- 2026-10-27 — Records the packages named by the chosen Option A in a `**Libraries:**` field (closes validation IC-1). _Rationale:_ Libraries implicit in the chosen option made explicit, so `/plan-resolve` can cache their docs in `library-refs.md`.

---

## TD-05: Storage Endpoint & Env-Key Contract (internal vs browser-reachable host)

**Scope:** Cross-layer

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** Inside Docker the API/worker must reach storage by Compose service name (root `CLAUDE.md` § Docker Networking), but presigned URLs are consumed by the **browser**, which cannot resolve service names. SigV4 signs the `Host`, so a URL signed for `storage:3900` cannot simply be rewritten to `localhost:3900`. The chosen key set appears in Joi schema + `compose.yaml` + `.env.example`, and the public host affects FE (CSP/`next/image` remote patterns in the FE slice).

**Options:**

### Option A: Dual endpoint keys — internal client + public presigner client
- `S3_ENDPOINT` (e.g., `http://storage:3900`) for server-side calls; `S3_PUBLIC_ENDPOINT` (e.g., `http://localhost:3900`) used only by a second S3 client dedicated to presigning. Plus `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, bucket names.
- **Pros:** respects the Docker-networking rule; maps 1:1 to production (internal VPC endpoint vs public/CDN host); explicit.
- **Cons:** two clients to configure; dev and prod values must be kept coherent.

### Option B: Single endpoint resolvable from both sides
- One `S3_ENDPOINT` using a hostname that works from containers and the host browser (e.g., `host.docker.internal` + host port, or a `/etc/hosts` alias).
- **Pros:** one client, one key.
- **Cons:** violates the "always service name" rule; relies on host-specific networking (Linux needs `host-gateway`); breaks the moment prod uses an internal endpoint.

### Option C: Same-origin storage proxy through Next.js (`/storage/*` rewrite)
- Browser talks to storage via the Next origin; Next rewrites to the storage service.
- **Pros:** no storage CORS; storage host never exposed.
- **Cons:** puts 10GB uploads and every streaming byte back through Next — reverses TD-01's main benefit; host-header preservation needed for signatures.

**Recommendation:** **Option A** — the only option that keeps both the Docker-networking rule and the direct-to-storage data path of TD-01; the second presigner client is a few lines of config.

**Decision:** Option A

---

## TD-06: Background Queue Technology

**Scope:** Backend

**Capability:** "Serviço de processamento em segundo plano (filas)"

**Context:** Resolves the C4 "Message Queue: TBD". Workload: low throughput (one job per upload), long-running jobs (minutes on multi-GB files), needs retries with backoff, concurrency control per worker, and later scheduled jobs (TD-12 cleanup). The testing guide already assumes a real broker in Docker for integration tests.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed queue with the official Nest integration (`BullModule`, `@Processor`/`WorkerHost`) documented on docs.nestjs.com.
- **Pros:** official Nest module and docs; lock renewal for long jobs, attempts/backoff, concurrency, job schedulers, events, mature dashboards; testing guide already sketches its setup.
- **Cons:** adds Redis to compose and to prod; enqueue is not transactional with the Postgres status update (dual write — mitigated by enqueue-after-commit + idempotent processor).

### Option B: pg-boss (PostgreSQL)
- Job queue stored in Postgres tables (`SKIP LOCKED`), v12.
- **Pros:** no new infrastructure; job insert can share the DB transaction with the status update (no dual write); retries, scheduling, expiration built-in.
- **Cons:** no official Nest module (community wrappers or a thin custom provider); long-job handling via expiration timeouts rather than lock renewal; adds polling load to the main DB.

### Option C: BullMQ 6 with its PostgreSQL backend
- Same BullMQ API, persisted in Postgres (`createPostgresBackend`, schema `bullmq`).
- **Pros:** BullMQ features without Redis.
- **Cons:** announced 2026-09-27 — weeks old; `@nestjs/bullmq` 12.0.0 has no backend-factory support yet (PR #2924 open), so Nest integration would be manual/global.

**Recommendation:** **Option A** — official Nest integration and proven long-job semantics fit a multi-minute FFmpeg workload; Redis is a small, standard compose addition. Option C becomes a near drop-in later if removing Redis matters once `@nestjs/bullmq` supports backends; Option B is the right call only if avoiding new infrastructure outweighs the missing Nest integration.

**Decision:** Option A
**Libraries:** @nestjs/bullmq, bullmq

**Revisions:**

- 2026-10-27 — Records the packages named by the chosen Option A in a `**Libraries:**` field (closes validation IC-1). _Rationale:_ Libraries implicit in the chosen option made explicit, so `/plan-resolve` can cache their docs in `library-refs.md`.

---

## TD-07: Video Worker Process Topology

**Scope:** Repo-wide

**Capability:** "Serviço de processamento em segundo plano (filas)"

**Context:** The C4 diagram has a separate "Video Worker (FFmpeg)" container that updates DB and storage directly. Where its code lives determines compose layout, image build (FFmpeg binaries), and whether entities/config are shared with the API.

**Options:**

### Option A: Same `nestjs-project` codebase, separate entrypoint and compose service
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP); compose adds a `video-worker` service from the same image (+ FFmpeg) running that entrypoint.
- **Pros:** reuses entities, TypeORM data source, config namespaces and storage module — no duplication; independent scaling and resource limits; matches the C4 container split.
- **Cons:** image carries FFmpeg for both services (or a multi-target Dockerfile); must keep worker-only modules out of the HTTP app.

### Option B: Processor runs inside the API process
- `@Processor` registered in the API's `AppModule`.
- **Pros:** zero extra service.
- **Cons:** FFmpeg CPU/IO competes with HTTP requests — contradicts "sem impacto na performance" and the C4 diagram.

### Option C: New standalone subproject (`video-worker/`)
- Separate package (Node or another language) with its own manifest and Docker image.
- **Pros:** fully isolated deploys and dependencies; free language choice.
- **Cons:** duplicates entities/config/status logic (drift risk); new tooling, lint, tests and CI per subproject.

**Recommendation:** **Option A** — honours the C4 container boundary and isolates FFmpeg load from the API while keeping a single source for entities and config, consistent with the repo's current two-subproject layout.

**Decision:** Option A

---

## TD-08: FFmpeg / FFprobe Integration

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker needs `ffprobe` (duration, codecs, resolution) and `ffmpeg` (thumbnail frame; possibly faststart remux per TD-09). The long-standard Node wrapper `fluent-ffmpeg` is now deprecated on npm.

**Options:**

### Option A: System FFmpeg in the image + thin typed `child_process.spawn` wrapper
- Install `ffmpeg` via the image's package manager; a small service runs `ffprobe -print_format json -show_format -show_streams` and explicit `ffmpeg` arg arrays.
- **Pros:** no unmaintained dependency; full control of args, timeouts, stderr and exit codes; JSON probe output maps directly to typed DTOs; easy to fake in unit tests.
- **Cons:** small amount of wrapper code to own; FFmpeg version follows the base image's distro.

### Option B: `fluent-ffmpeg`
- Fluent builder API over the CLI.
- **Pros:** familiar, concise.
- **Cons:** deprecated/unmaintained — rules it out for new code under the project's quality bar.

### Option C: npm-shipped binaries (`ffmpeg-static` / `ffprobe-static`) + spawn wrapper
- Same wrapper as A, binaries pulled from npm.
- **Pros:** pinned FFmpeg version independent of the base image.
- **Cons:** large postinstall downloads into the bind-mounted `node_modules`; binary/arch mismatches between host and container.

**Recommendation:** **Option A** — the CLI is the stable interface, the wrapper is small, and installing FFmpeg in the worker image matches TD-07.

**Decision:** Option A

---

## TD-09: Processing Scope & Streaming Format

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** The phase requires metadata extraction and streaming without full download — not transcoding. The format choice decides worker cost and the player stack in the FE (native `<video>` vs `hls.js`, Phase 05).

**Options:**

### Option A: Progressive MP4/WebM over HTTP Range — validate + faststart remux only, no transcode
- Accept a browser-playable allowlist (e.g., MP4/H.264|AAC, WebM/VP9|Opus); worker probes, rejects unsupported codecs as `failed`, and remuxes (`-c copy -movflags +faststart`) only when the `moov` atom is at the end.
- **Pros:** cheapest processing (no re-encode of 10GB); native `<video>` with Range requests already gives streaming + seeking; download = the original file.
- **Cons:** no adaptive bitrate; uploads outside the allowlist (e.g., some phone HEVC/MOV) are rejected rather than converted.

### Option B: Always transcode to a single H.264/AAC MP4 (faststart)
- Every upload is re-encoded to one universal rendition.
- **Pros:** plays everywhere; normalizes bitrate and size.
- **Cons:** hours of CPU for large files; worker sizing becomes a real cost; quality loss on re-encode.

### Option C: HLS adaptive streaming (multi-rendition ladder)
- Transcode into segmented renditions + playlists.
- **Pros:** YouTube-like ABR, best on poor networks.
- **Cons:** multiplies B's CPU and storage cost; FE needs `hls.js`; download needs a separate MP4 anyway — beyond this phase's capability bullets.

**Recommendation:** **Option A** — satisfies "streaming sem download completo" with Range requests at near-zero CPU cost, which is what makes a 10GB limit affordable; B/C remain an additive evolution (new rendition objects) without changing the upload contract.

**Decision:** Option A

---

## TD-10: Media Delivery (Streaming, Download, Thumbnails)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Under strict BFF the browser cannot stream from Nest, and proxying through Next defeats TD-01. Drafts and (Phase 04) unlisted videos must not be fetchable by listing or guessing. Thumbnails will appear in grids (Phases 04/07), where per-image signing hurts caching. Depends on TD-05 (public endpoint).

**Options:**

### Option A: Presigned GET URLs for everything
- API (via BFF) returns short-lived presigned URLs for video, download (`response-content-disposition=attachment`) and thumbnails.
- **Pros:** uniform access control; nothing public in storage.
- **Cons:** thumbnail URLs change on every render — poor browser/CDN caching and heavier grid responses; expiry must outlive playback because each Range/seek is a new signed request.

### Option B: Public-read buckets with stable URLs
- Objects served publicly at deterministic URLs.
- **Pros:** simplest; maximally cacheable.
- **Cons:** draft/unlisted video files reachable by anyone holding or leaking the URL; download control impossible.

### Option C: Hybrid — public-read thumbnails (unguessable keys), presigned video stream/download
- Thumbnails under a public prefix/bucket keyed by unguessable IDs; video objects private, delivered via presigned GET (inline for player, `attachment` for download), TTL sized to a viewing session with re-fetch on 403.
- **Pros:** cacheable thumbnails for grids; video access stays API-governed (drafts/unlisted/ownership); download is a signed attachment with no extra infra.
- **Cons:** two access policies to configure; long-ish video URL TTL is a bearer capability while valid.

**Recommendation:** **Option C** — matches the asymmetric sensitivity: thumbnails are low-risk, high-traffic; video bytes are high-value and must respect draft/unlisted rules, while still flowing storage → browser directly.

**Decision:** Option C

**Revisions:**

- 2026-10-27 — Phase 03 access rule for video bytes: the API issues presigned stream/download URLs only to the authenticated owner, because every video is `publicationStatus: draft` until Phase 04 adds publication and visibility. The download rule for published videos (anonymous vs. authenticated) is deferred to Phase 04/05 (closes validation AMB-1). _Rationale:_ Access scope clarified to match the draft-only state of this phase.

---

## TD-11: Unique Public Video ID (URL slug)

**Scope:** Cross-layer

**Capability:** "URL única por vídeo, sem conflito com outros vídeos"

**Context:** Each video needs a short URL that never conflicts (Pontos de Atenção: "URL curta e única"). The ID is part of the route contract (`/watch/{id}` or similar in FE) and of API paths; unguessability also protects unlisted videos (Phase 04/05).

**Options:**

### Option A: Random 11-char base64url ID (`node:crypto`) + unique index + retry on collision
- 66 bits of entropy, YouTube-like; internal UUID PK stays; `public_id` column with unique constraint, regenerate on the (astronomically rare) conflict.
- **Pros:** short, unguessable (protects unlisted), no dependency, uniqueness guaranteed by the DB.
- **Cons:** extra column/index; retry path to test.

### Option B: UUID (v4/v7) directly in the URL
- Use the PK as the public identifier.
- **Pros:** zero extra logic; v4 is unguessable.
- **Cons:** 36-char URLs — not "curta"; v7 leaks creation time; couples public URLs to the PK.

### Option C: Sqids/Hashids encoding of a sequential integer
- Reversible short encoding of an auto-increment ID.
- **Pros:** short, deterministic, collision-free by construction.
- **Cons:** obfuscation, not secrecy — decodable/enumerable, which undermines unlisted videos; requires a sequential key.

**Recommendation:** **Option A** — the only option that is simultaneously short and unguessable, which the unlisted-video rule in Phases 04/05 depends on; collisions are handled deterministically by the unique index.

**Decision:** Option A

---

## TD-12: Upload Limits, Validation & Abandoned-Upload Cleanup

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** With direct-to-storage uploads (TD-01 A) the API never sees the bytes, so limits must be enforced at the edges; and draft pre-registration (TD-02) creates rows + incomplete multipart uploads that may be abandoned. Values (max size, part size, URL TTLs, stale window) become env keys shared by schema + compose + FE part plan.

**Options:**

### Option A: Layered enforcement + application-scheduled cleanup
- Initiate rejects declared size > 10GB / MIME outside allowlist; server dictates part size (e.g., 64 MiB → ≤160 parts); complete verifies real size via `HeadObject` and deletes oversize objects; worker validates content via ffprobe. A queue job scheduler (TD-06) aborts multipart uploads and expires drafts left in `uploading` beyond a window.
- **Pros:** defence in depth; cleanup also fixes the DB rows (not just storage); portable across any S3 server.
- **Cons:** more code paths to test; cleanup depends on the worker being up.

### Option B: Layered enforcement + storage lifecycle rule (`AbortIncompleteMultipartUpload`)
- Same validation; orphan parts reclaimed by a bucket lifecycle rule.
- **Pros:** zero application code for storage reclamation.
- **Cons:** lifecycle support differs across S3-compatible servers (Garage supports only `AbortIncompleteMultipartUpload`/`Expiration`); leaves orphan draft rows in Postgres — still needs an app job for the DB side.

**Recommendation:** **Option A** — the DB draft rows need app-side cleanup regardless, so one scheduled job covering both storage and DB is simpler and backend-portable; a lifecycle rule can be added in production as a safety net.

**Decision:** Option A

---

## TD-13: Video Lifecycle Status Model

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video now exists from upload start, through processing, to ready/failed; Phase 04 adds draft → published and public/unlisted. The status shape is read by the FE (upload progress, "processing…" badges, management panel) and written by API and worker — a contract that is expensive to reshape later.

**Options:**

### Option A: Orthogonal fields — `processingStatus` + `publicationStatus`
- `processingStatus`: `uploading | processing | ready | failed` (API + worker); `publicationStatus`: `draft` now, `published` added in Phase 04 (user-driven); `visibility` arrives in Phase 04 as a third independent field.
- **Pros:** each field has one writer and one meaning (technical pipeline vs editorial state); Phase 04 extends without migrating values; FE can show "draft · processing" cleanly.
- **Cons:** invalid combinations (e.g., publish while `failed`) must be guarded in the service.

### Option B: Single linear status enum
- `uploading → processing → draft → published | failed`.
- **Pros:** one field, simple filters.
- **Cons:** conflates pipeline and editorial state — a user editing a draft while it is still processing has no representable state; Phase 04 would need to reshape the enum.

**Recommendation:** **Option A** — the worker and the user mutate different concerns; separating them avoids an enum migration in Phase 04 and keeps the FE contract stable.

**Decision:** Option A

---

## TD-14: Integration Testing Strategy for Storage, Queue and FFmpeg

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** `testing-guide-nestjs-project/references/external-systems.md` prescribes a local-filesystem storage adapter for dev/tests and S3 only in production. That cannot exercise presigned multipart (TD-01 A), CORS, or `HeadObject` verification — the riskiest paths of this phase. The queue section already prescribes a real broker in Docker.

**Options:**

### Option A: Real services in compose — S3-compatible storage (TD-03), Redis/queue (TD-06), FFmpeg in the image — with tiny committed fixture videos
- Integration/e2e tests hit the real storage service with a dedicated test bucket (emptied between suites), the real broker, and run ffprobe/ffmpeg on few-KB fixture files; unit tests fake the S3 client and FFmpeg wrapper.
- **Pros:** same philosophy as PostgreSQL/Mailpit in this repo (real, Dockerized); covers presign → upload part → complete → process end to end.
- **Cons:** slower suites; requires storage bootstrap (bucket/key) in test setup; guide must be updated.

### Option B: Keep the guide — local-filesystem storage adapter in tests, S3 in prod
- `StorageService` interface with `local` and `s3` drivers.
- **Pros:** fast, no extra container in tests.
- **Cons:** the S3/presign/multipart path ships untested until production; maintaining a second driver that production never uses.

### Option C: Mocked S3 at integration level (`aws-sdk-client-mock`), real queue + FFmpeg
- Storage calls stubbed at the SDK boundary.
- **Pros:** fast and deterministic.
- **Cons:** asserts command shapes, not behaviour — misses signature, CORS and endpoint (TD-05) bugs.

**Recommendation:** **Option A** — the project already standardises on real Dockerized dependencies for integration tests, and the S3 handshake is the core risk of this phase; the local-FS rule in the testing guide predates the upload-protocol decision and should be updated (separate task).

**Decision:** Option A

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Cross-layer | Large file upload protocol | A — S3 multipart with presigned part URLs (direct to storage) | A |
| TD-02 | Cross-layer | Draft pre-registration & completion signal | A — initiate creates draft; explicit complete enqueues | A |
| TD-03 | Repo-wide | Object storage server (dev/test) | A — Garage | A (Garage) |
| TD-04 | Backend | S3 client library | A — AWS SDK v3 | A |
| TD-05 | Cross-layer | Storage endpoint & env-key contract | A — internal + public presigner endpoints | A |
| TD-06 | Backend | Queue technology | A — BullMQ + Redis (`@nestjs/bullmq`) | A |
| TD-07 | Repo-wide | Worker topology | A — same codebase, separate entrypoint + compose service | A |
| TD-08 | Backend | FFmpeg integration | A — system FFmpeg + typed spawn wrapper | A |
| TD-09 | Cross-layer | Processing scope & streaming format | A — progressive MP4/WebM + Range, faststart remux, no transcode | A |
| TD-10 | Cross-layer | Media delivery | C — public thumbnails, presigned video stream/download | C |
| TD-11 | Cross-layer | Unique public video ID | A — random 11-char base64url + unique index | A |
| TD-12 | Backend | Upload limits, validation & cleanup | A — layered enforcement + scheduled cleanup job | A |
| TD-13 | Cross-layer | Video lifecycle status model | A — orthogonal `processingStatus` + `publicationStatus` | A |
| TD-14 | Backend | Integration testing for storage/queue/FFmpeg | A — real services in compose + fixture videos | A |

## Notes

- **Dependencies between TDs:** TD-02, TD-05, TD-10, TD-12 assume TD-01 A; TD-03 is swappable because of TD-04 A; TD-12 cleanup uses TD-06's scheduler; TD-14 A depends on TD-03/TD-06 services existing in compose.
- **Dropped as implementation details** (resolved by `implement` via skills/docs): thumbnail frame selection and image format/size, object key layout inside buckets, BullMQ retry counts/backoff values, entity columns for metadata, presign batch size, compose healthchecks.
- **Out-of-scope follow-ups (separate tasks):** update `testing-guide-nestjs-project/references/external-systems.md` per TD-14; update `docs/diagrams/software-arch.mermaid` ("S3 or MinIO", "Message Queue: TBD") per TD-03/TD-06; frontend slice research (upload UI + client lib, player, download button) inheriting the Cross-layer TDs above.
