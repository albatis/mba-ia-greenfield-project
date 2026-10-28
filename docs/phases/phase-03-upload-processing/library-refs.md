---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1158.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-27T19:06:19-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1158.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-27T19:06:19-03:00"
  "@aws-sdk/lib-storage":
    version: "^3.1158.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-27T19:06:19-03:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-27T19:06:19-03:00"
  "bullmq":
    version: "^6.5.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-27T19:06:19-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-10-27T19:05:30-03:00"
---

# Library References — phase-03-upload-processing

_Version notes:_ the versions are the npm `latest` on 2026-10-27, because none of these packages is installed in `nestjs-project/` yet. Context7 indexes `/aws/aws-sdk-js-v3` up to v3.1153.0 and `/taskforcesh/bullmq` up to v6.3.11, slightly behind npm (3.1158.0 / 6.5.0). The APIs below are stable across those minor versions. `@nestjs/bullmq@12.0.0` declares the peers `bullmq ^3 || ^4 || ^5 || ^6` and `@nestjs/core ^10 || ^11 || ^12`, so it is compatible with the project's NestJS 11.

### @aws-sdk/client-s3

Used by TD-04 (API + worker), TD-05 (internal vs. browser-reachable endpoint), TD-12 (`HeadObject` size check, multipart abort) and TD-14 (real S3-compatible server in tests).

- **Self-hosted endpoint (Garage, TD-03):** set `endpoint` and `forcePathStyle: true` so the bucket goes in the path (`host/bucket/key`), not in a subdomain. `region` and `credentials` are still required.
  ```ts
  new S3Client({
    endpoint: 'http://storage:3900', // Compose service name, never localhost (CLAUDE.md)
    forcePathStyle: true,
    region: 'garage',
    credentials: { accessKeyId, secretAccessKey },
  });
  ```
- **Two clients (TD-05):** one points at the internal Compose host and is used for server-side calls. The other points at the browser-reachable host and is used only to presign. A presigned URL embeds the host it was signed for.
- **Multipart lifecycle (TD-01/TD-02):** `CreateMultipartUploadCommand` → `UploadPartCommand` per part (returns `ETag`) → `CompleteMultipartUploadCommand` with `{ Parts: [{ PartNumber, ETag }] }`. Use `AbortMultipartUploadCommand` for cleanup (TD-12) and `ListPartsCommand` to resume.
- **Verification (TD-12):** `HeadObjectCommand` returns `ContentLength` for the real-size check after completion. Delete oversize objects with `DeleteObjectCommand`.
- **CORS (browser uploads):** the bucket CORS must expose `ETag`, or the browser cannot read the part ETags. Example rule: `AllowedMethods: [GET, PUT, POST, DELETE, HEAD]`, `ExposeHeaders: [ETag, Date]`, `AllowedHeaders: ['*']`, with `AllowedOrigins` restricted to the FE origin.

### @aws-sdk/s3-request-presigner

Used by TD-01 (presigned part uploads), TD-10 (presigned GET for stream and download).

- `getSignedUrl(client, command, { expiresIn })`: `expiresIn` is in seconds and defaults to `900`.
  ```ts
  import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
  const url = await getSignedUrl(
    presignClient,
    new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
    { expiresIn },
  );
  ```
- **Download as attachment (TD-10):** `new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="…"' })`. Response-header overrides only work on signed requests, which presigned GET satisfies. For inline streaming, omit the override, because Range requests are served natively by S3.
- **Signed headers:** non-`x-amz-*` headers to enforce go in `signableHeaders`. `x-amz-*` headers such as checksums go in `unhoistableHeaders`.

### @aws-sdk/lib-storage

Used by the TD-04 worker to upload generated objects (thumbnails/derivatives) from a stream.

- `new Upload({ client, params: { Bucket, Key, Body, ContentType }, queueSize = 4, partSize ≥ 5 MiB, leavePartsOnError = false })`, then `await upload.done()`. Handles bodies of unknown length via multipart and emits `httpUploadProgress`.
- With `leavePartsOnError: false` (the default) it calls `AbortMultipartUpload` on failure. It throws if a part response has no `ETag`, which usually means missing CORS `ExposeHeaders` when used from a browser.
- For small single-shot objects, a plain `PutObjectCommand` is enough. Reserve `Upload` for stream bodies.

### @nestjs/bullmq

Used by TD-06 (queue), TD-07 (worker process consumes jobs), TD-12 (scheduled cleanup).

- **Root connection via config (matches the `registerAs` convention):**
  ```ts
  BullModule.forRootAsync({
    imports: [ConfigModule],
    inject: [queueConfig.KEY],
    useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
      connection: { host: cfg.host, port: cfg.port }, // host = Compose service name
    }),
  });
  ```
  `forRootAsync` returns a global module and accepts `useFactory | useClass | useExisting`, `inject`, `imports` and `extraOptions`.
- **Queue registration:** `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts, backoff } })`. The producer injects it with `@InjectQueue('video-processing') queue: Queue` and calls `queue.add(name, data, opts)`.
- **Consumer (worker process, TD-07):**
  ```ts
  @Processor('video-processing', { concurrency: 1 })
  export class VideoProcessor extends WorkerHost {
    async process(job: Job<ProcessVideoJob>): Promise<void> { … }

    @OnWorkerEvent('failed')
    onFailed(job: Job, err: Error) { … }
  }
  ```
  The second argument is raw BullMQ `WorkerOptions` (`concurrency`, `limiter`, `lockDuration`, …), with `connection` taken from the root config. `@OnWorkerEvent` requires the class to be a `@Processor`. The events are `active`, `completed`, `failed`, `error`, `progress`, `stalled` and `drained`.
- **Testing:** queues are exposed under `getQueueToken(name)` for `overrideProvider` in unit tests. Integration tests use the real Redis (TD-14).

### bullmq

Used by TD-06 (job semantics), TD-12 (cleanup scheduler).

- **Retries:** `queue.add('process', data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } })` retries after `2^(attempt-1) * delay` ms.
- **Idempotency:** pass a deterministic `jobId` (e.g. the video ID) so that re-enqueueing after a commit retry does not duplicate work. The processor must also be idempotent (TD-06 dual-write mitigation).
- **Long jobs:** `lockDuration` in the worker options sets how long a job is locked before lock renewal. The worker auto-renews while it is alive, and a dead worker causes a `stalled` event and a retry.
- **Scheduled cleanup (TD-12), v6 Job Schedulers API:**
  ```ts
  await queue.upsertJobScheduler(
    'abandoned-upload-cleanup',
    { every: 15 * 60_000 }, // or { pattern: '0 */15 * * * *' }
    { name: 'cleanup', data: {}, opts: { attempts: 3, backoff: 3000 } },
  );
  ```
  `upsertJobScheduler` is idempotent by scheduler ID, so it is safe to call on every boot. The v5 `repeat` options map onto it (`repeat.every` → `{ every }`, `repeat.pattern` → `{ pattern }`).
- **Retention:** `removeOnComplete: { age, count }` and `removeOnFail: { age }` (age in seconds) on the worker or job keep Redis bounded. Removal is lazy and runs when the next job completes or fails.
