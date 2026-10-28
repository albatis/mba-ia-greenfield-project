import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import * as argon2 from 'argon2';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ChannelsService } from '../src/channels/channels.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import uploadConfig from '../src/config/upload.config';
import {
  PROCESS_VIDEO_JOB,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../src/queue/queue.constants';
import { STORAGE_BUCKETS } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { clearTestQueue } from '../src/test/queue';
import { buildTestStorageConfig, clearTestBuckets } from '../src/test/storage';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';

const PASSWORD = 'password123';
const MIB = 1024 * 1024;
const FIRST_PART_BYTES = 5 * MIB;
const LAST_PART_BYTES = 4 * 1024;

interface UploadedDraft {
  videoId: string;
  parts: { partNumber: number; etag: string }[];
}

async function createApp(
  upload?: Partial<ConfigType<typeof uploadConfig>>,
): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(storageConfig.KEY)
    .useValue(buildTestStorageConfig());
  if (upload) {
    builder = builder
      .overrideProvider(uploadConfig.KEY)
      .useValue({ ...uploadConfig(), ...upload });
  }
  const moduleFixture = await builder.compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return app;
}

async function putPart(url: string, bytes: number): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(bytes) });
  expect(res.status).toBe(200);
  return res.headers.get('etag')!;
}

describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue<ProcessVideoJobData>;
  let ownerToken: string;
  let strangerToken: string;

  beforeAll(async () => {
    app = await createApp();
    dataSource = app.get(DataSource);
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = app.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await clearTestBuckets();
    await clearTestQueue(queue);
    await app.close();
  });

  const seedUser = async (email: string): Promise<string> => {
    const user = await dataSource.getRepository(User).save({
      email,
      password: await argon2.hash(PASSWORD),
      is_confirmed: true,
    });
    await app.get(ChannelsService).createChannel(user.id, email);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (login.body as { access_token: string }).access_token;
  };

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearTestBuckets();
    await clearTestQueue(queue);
    throttlerStorage.storage.clear();

    ownerToken = await seedUser('owner@example.com');
    strangerToken = await seedUser('stranger@example.com');
  });

  /** POST /videos → sign parts → PUT each part; returns the parts' ETags */
  const uploadDraft = async (
    target: INestApplication<App>,
    size: number,
    partBytes: number[],
  ): Promise<UploadedDraft> => {
    const created = await request(target.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ filename: 'a.mp4', size, mimeType: 'video/mp4' })
      .expect(201);
    const { videoId, partCount } = created.body as {
      videoId: string;
      partCount: number;
    };
    expect(partCount).toBe(partBytes.length);

    const signed = await request(target.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ partNumbers: partBytes.map((_, index) => index + 1) })
      .expect(200);
    const urls = (signed.body as { parts: { url: string }[] }).parts;

    const parts: UploadedDraft['parts'] = [];
    for (const [index, bytes] of partBytes.entries()) {
      parts.push({
        partNumber: index + 1,
        etag: await putPart(urls[index].url, bytes),
      });
    }
    return { videoId, parts };
  };

  const uploadTwoParts = (): Promise<UploadedDraft> =>
    uploadDraft(app, uploadConfig().partSizeBytes + 1024, [
      FIRST_PART_BYTES,
      LAST_PART_BYTES,
    ]);

  const complete = (
    target: INestApplication<App>,
    videoId: string,
    token: string,
    parts: UploadedDraft['parts'],
  ) =>
    request(target.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts });

  const findVideo = (videoId: string): Promise<Video> =>
    dataSource.getRepository(Video).findOneByOrFail({ public_id: videoId });

  // 1. POST /videos/:videoId/upload/complete

  test('complete-upload-success-enqueues-job', async () => {
    const draft = await uploadTwoParts();

    const res = await complete(
      app,
      draft.videoId,
      ownerToken,
      draft.parts,
    ).expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        videoId: draft.videoId,
        processingStatus: 'processing',
        publicationStatus: 'draft',
        sizeBytes: FIRST_PART_BYTES + LAST_PART_BYTES,
        thumbnailUrl: null,
        failureReason: null,
      }),
    );

    const video = await findVideo(draft.videoId);
    expect(video.processing_status).toBe('processing');
    expect(video.upload_id).toBeNull();
    expect(video.upload_completed_at).toBeInstanceOf(Date);

    const jobs = await queue.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(jobs[0].data).toEqual({ videoId: video.id });
  });

  test('complete-upload-repeated-conflict', async () => {
    const draft = await uploadTwoParts();
    await complete(app, draft.videoId, ownerToken, draft.parts).expect(200);

    const res = await complete(
      app,
      draft.videoId,
      ownerToken,
      draft.parts,
    ).expect(409);

    expect(res.body).toEqual(
      expect.objectContaining({ error: 'UPLOAD_NOT_IN_PROGRESS' }),
    );
    expect(await queue.getJobs()).toHaveLength(1);
  });

  test('complete-upload-wrong-etag', async () => {
    const draft = await uploadTwoParts();
    const parts = [draft.parts[0], { partNumber: 2, etag: '"wrong-etag"' }];

    const res = await complete(app, draft.videoId, ownerToken, parts).expect(
      400,
    );

    expect(res.body).toEqual(
      expect.objectContaining({ error: 'INVALID_UPLOAD_PARTS' }),
    );
    const video = await findVideo(draft.videoId);
    expect(video.processing_status).toBe('uploading');
    expect(video.upload_id).not.toBeNull();
    const listed = await request(app.getHttpServer())
      .get(`/videos/${draft.videoId}/upload/parts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(
      (listed.body as { uploadedParts: unknown[] }).uploadedParts,
    ).toHaveLength(2);
    expect(await queue.getJobs()).toHaveLength(0);
  });

  test('complete-upload-duplicate-part-number', async () => {
    const draft = await uploadTwoParts();
    const parts = [draft.parts[0], { ...draft.parts[0] }];

    const res = await complete(app, draft.videoId, ownerToken, parts).expect(
      400,
    );

    expect(res.body).toEqual(
      expect.objectContaining({ error: 'INVALID_UPLOAD_PARTS' }),
    );
    expect((await findVideo(draft.videoId)).processing_status).toBe(
      'uploading',
    );
  });

  test('complete-upload-real-size-too-large', async () => {
    const limit = 6 * MIB;
    const smallLimitApp = await createApp({ maxSizeBytes: limit });
    try {
      const draft = await uploadDraft(smallLimitApp, limit, [7 * MIB]);

      const res = await complete(
        smallLimitApp,
        draft.videoId,
        ownerToken,
        draft.parts,
      ).expect(400);

      expect(res.body).toEqual(
        expect.objectContaining({ error: 'FILE_TOO_LARGE' }),
      );
      const video = await findVideo(draft.videoId);
      const object = await app.get(StorageService).headObject({
        bucket: STORAGE_BUCKETS.VIDEOS,
        key: video.source_key,
      });
      expect(object).toBeNull();
      expect(video.processing_status).toBe('failed');
      expect(video.failure_reason).toBe('FILE_TOO_LARGE');
      expect(await queue.getJobs()).toHaveLength(0);
    } finally {
      await smallLimitApp.close();
    }
  });

  test('complete-upload-not-owner', async () => {
    const draft = await uploadTwoParts();

    const res = await complete(
      app,
      draft.videoId,
      strangerToken,
      draft.parts,
    ).expect(404);

    expect(res.body).toEqual(
      expect.objectContaining({ error: 'VIDEO_NOT_FOUND' }),
    );
    expect((await findVideo(draft.videoId)).processing_status).toBe(
      'uploading',
    );
  });
});
