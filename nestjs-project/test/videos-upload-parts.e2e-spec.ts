import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import * as argon2 from 'argon2';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ChannelsService } from '../src/channels/channels.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import uploadConfig from '../src/config/upload.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { buildTestStorageConfig, clearTestBuckets } from '../src/test/storage';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VideoProcessingStatus } from '../src/videos/video.enums';

const PASSWORD = 'password123';
const PART_BYTES = 5 * 1024 * 1024;
const UNKNOWN_VIDEO_ID = 'AAAAAAAAAAA';
const MALFORMED_VIDEO_ID = 'abc';

interface InitiateUploadBody {
  videoId: string;
  uploadId: string;
  partSize: number;
  partCount: number;
}

interface SignedPartsBody {
  parts: { partNumber: number; url: string }[];
  expiresInSeconds: number;
}

describe('videos-upload-parts', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let strangerToken: string;
  let draft: InitiateUploadBody;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(buildTestStorageConfig())
      .compile();

    app = moduleFixture.createNestApplication();
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

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await clearTestBuckets();
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
    throttlerStorage.storage.clear();

    ownerToken = await seedUser('owner@example.com');
    strangerToken = await seedUser('stranger@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ filename: 'a.mp4', size: 200000000, mimeType: 'video/mp4' })
      .expect(201);
    draft = res.body as InitiateUploadBody;
  });

  const signParts = (videoId: string, token: string, partNumbers: number[]) =>
    request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers });

  const listParts = (videoId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${token}`);

  const markDraftProcessing = () =>
    dataSource
      .getRepository(Video)
      .update(
        { public_id: draft.videoId },
        { processing_status: VideoProcessingStatus.PROCESSING },
      );

  // 1. POST /videos/:videoId/upload/parts

  test('sign-parts-success', async () => {
    const res = await signParts(draft.videoId, ownerToken, [1, 2]).expect(200);

    const body = res.body as SignedPartsBody;
    expect(body.parts.map((part) => part.partNumber)).toEqual([1, 2]);
    const publicHost = new URL(buildTestStorageConfig().publicEndpoint).host;
    for (const part of body.parts) {
      expect(typeof part.url).toBe('string');
      expect(new URL(part.url).host).toBe(publicHost);
    }
    expect(body.expiresInSeconds).toBe(uploadConfig().partUrlTtlSeconds);
  });

  test('sign-parts-invalid-part-number', async () => {
    const res = await signParts(draft.videoId, ownerToken, [4]).expect(400);

    expect(res.body).toEqual(
      expect.objectContaining({ error: 'INVALID_PART_NUMBER' }),
    );
  });

  test('sign-parts-validation-error', async () => {
    const res = await signParts(draft.videoId, ownerToken, []).expect(400);

    expect(res.body).toEqual(
      expect.objectContaining({ error: 'VALIDATION_ERROR' }),
    );
  });

  test('sign-parts-video-not-found', async () => {
    for (const [videoId, token] of [
      [draft.videoId, strangerToken],
      [UNKNOWN_VIDEO_ID, ownerToken],
      [MALFORMED_VIDEO_ID, ownerToken],
    ]) {
      const res = await signParts(videoId, token, [1]).expect(404);

      expect(res.body).toEqual(
        expect.objectContaining({ error: 'VIDEO_NOT_FOUND' }),
      );
    }
  });

  test('sign-parts-upload-not-in-progress', async () => {
    await markDraftProcessing();

    const res = await signParts(draft.videoId, ownerToken, [1]).expect(409);

    expect(res.body).toEqual(
      expect.objectContaining({ error: 'UPLOAD_NOT_IN_PROGRESS' }),
    );
  });

  // 2. GET /videos/:videoId/upload/parts

  test('list-parts-after-part-upload', async () => {
    const signed = await signParts(draft.videoId, ownerToken, [1]).expect(200);
    const [part] = (signed.body as SignedPartsBody).parts;
    const put = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(PART_BYTES),
    });
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag');
    expect(etag).toBeTruthy();

    const res = await listParts(draft.videoId, ownerToken).expect(200);

    expect(res.body).toEqual({
      uploadId: draft.uploadId,
      partSize: draft.partSize,
      partCount: draft.partCount,
      uploadedParts: [{ partNumber: 1, etag, size: PART_BYTES }],
    });
  });

  test('list-parts-video-not-found', async () => {
    for (const [videoId, token] of [
      [draft.videoId, strangerToken],
      [UNKNOWN_VIDEO_ID, ownerToken],
      [MALFORMED_VIDEO_ID, ownerToken],
    ]) {
      const res = await listParts(videoId, token).expect(404);

      expect(res.body).toEqual(
        expect.objectContaining({ error: 'VIDEO_NOT_FOUND' }),
      );
    }
  });

  test('list-parts-upload-not-in-progress', async () => {
    await markDraftProcessing();

    const res = await listParts(draft.videoId, ownerToken).expect(409);

    expect(res.body).toEqual(
      expect.objectContaining({ error: 'UPLOAD_NOT_IN_PROGRESS' }),
    );
  });
});
