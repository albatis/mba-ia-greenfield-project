# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (TBD) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos

Implemented in `nestjs-project/` (phase 03, backend only). Plan and decisions: `docs/phases/phase-03-upload-processing/`.

**Modules:**

- `VideosModule` (`src/videos/`): `Video` entity, the HTTP endpoints, and `VideoProcessingProducer`, which enqueues the processing job.
- `StorageModule` (`src/storage/`): S3 client, presigned URLs, and multipart uploads against Garage.
- `QueueModule` (`src/queue/`): BullMQ connection plus the queue names and job payloads.
- `MediaModule` (`src/media/`): typed wrappers around `ffprobe` and `ffmpeg`.
- `WorkerModule` (`src/worker/`): consumes the queues in the separate `video-worker` process (entry `src/worker.ts`). No processor runs inside the API.

**Video lifecycle (`processing_status`):** `uploading` → `processing` → `ready` | `failed`. `publication_status` only has `draft` for now; `published` arrives in phase 04. When a video fails, `failure_reason` holds one of:

- `FILE_TOO_LARGE`
- `UNSUPPORTED_CODEC`
- `PROBE_FAILED`
- `PROCESSING_ERROR`
- `UPLOAD_ABANDONED`

**Identifiers:**

- **Public ID:** the API only exposes `public_id`, 11 random base64url characters (`src/videos/public-id.util.ts`), which is the `:videoId` in every route. Malformed IDs answer 404.
- **Internal UUID:** `videos.id` stays inside the system. It is the `process-video` job payload, and the source object key uses it (`videos/{id}/source`).
- **Thumbnail key:** `{public_id}.jpg`.

**Upload flow:** resumable multipart upload that goes straight from the client to storage; the file bytes never pass through the API.

1. `POST /videos` validates the declared size and MIME type (`video/mp4`, `video/webm`; `UPLOAD_MAX_SIZE_BYTES`, default 10GB), creates the draft, and starts the multipart. It returns `partSize` / `partCount` (`UPLOAD_PART_SIZE_BYTES`, default 64MB).
2. `POST /videos/:videoId/upload/parts` signs PUT URLs on demand, up to 100 part numbers per request (`UPLOAD_PART_URL_TTL_SECONDS`).
3. `GET /videos/:videoId/upload/parts` lists the parts already in storage, for resuming.
4. `POST /videos/:videoId/upload/complete` takes `{ partNumber, etag }[]`, completes the multipart, and checks the real object size. It then moves the row to `processing` with a conditional `UPDATE` and only afterwards enqueues `process-video`, so concurrent completes never enqueue twice.

**Processing** (`video-processing` queue, job `process-video`, `src/worker/processors/video-processing.processor.ts`):

- **Probe and allowlist:** `ffprobe` reads the file. The declared MIME type selects the allowlist rule (`src/videos/video-codec-allowlist.ts`): MP4 = H.264 + AAC, WebM = VP9 + Opus, and audio is optional. Videos are served as uploaded, with no transcoding.
- **Faststart:** an MP4 whose `moov` atom sits after `mdat` is remuxed (stream copy) and stored under the same key.
- **Thumbnail and result:** a thumbnail frame is extracted and uploaded to the public `thumbnails` bucket, and the row becomes `ready` with duration, dimensions, and codecs.
- **Status writes:** the `ready` and `failed` updates only apply while the row is still `processing`, so a retried job is idempotent. When the last attempt fails, the row becomes `failed` / `PROCESSING_ERROR`.

**Abandoned uploads** (`video-maintenance` queue, scheduler `cleanup-abandoned-uploads`): every `UPLOAD_CLEANUP_INTERVAL_MS`, drafts still `uploading` after `UPLOAD_STALE_AFTER_HOURS` have their multipart aborted and become `failed` / `UPLOAD_ABANDONED`.

**Reading and playback:**

- `GET /videos/:videoId` returns details and status, with `thumbnailUrl` built from `THUMBNAILS_PUBLIC_BASE_URL`.
- `GET .../stream-url` (`inline`, Range supported) and `GET .../download-url` (`attachment` with the original filename) return presigned GET URLs valid for `VIDEO_URL_TTL_SECONDS`. Both require `ready` and otherwise answer `409 VIDEO_NOT_READY`.
- Storage serves the bytes; the API never proxies the video.

**Authorization:** every `/videos` endpoint requires the JWT and is owner-only. A video from another channel answers `404 VIDEO_NOT_FOUND`, the same as an unknown one. Anonymous watching of published videos arrives in later phases.

**Domain errors** (`src/common/exceptions/domain.exception.ts`):

| Status | Codes |
|---|---|
| `400` | `FILE_TOO_LARGE`, `UNSUPPORTED_VIDEO_TYPE`, `INVALID_PART_NUMBER`, `INVALID_UPLOAD_PARTS` |
| `404` | `VIDEO_NOT_FOUND` |
| `409` | `UPLOAD_NOT_IN_PROGRESS`, `VIDEO_NOT_READY` |

**Contract and manual testing:**

- The contract is in `nestjs-project/openapi.json` (regenerate with `npm run openapi:export`).
- `nestjs-project/api.http` has the full flow (steps 10–17).
- Environment setup (`storage`, `redis`, `video-worker`, the Garage bootstrap) is in `nestjs-project/CLAUDE.md`.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.