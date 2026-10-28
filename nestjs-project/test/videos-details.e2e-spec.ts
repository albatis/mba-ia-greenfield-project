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
import { cleanAllTables } from '../src/test/create-test-data-source';
import { buildTestStorageConfig, clearTestBuckets } from '../src/test/storage';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../src/videos/video.enums';

const PASSWORD = 'password123';
const DRAFT = { filename: 'a.mp4', size: 200000000, mimeType: 'video/mp4' };

interface VideoBody {
  videoId: string;
  processingStatus: string;
  publicationStatus: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  failureReason: string | null;
  createdAt: string;
}

describe('videos-details', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let strangerToken: string;
  let videoId: string;

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
      .send(DRAFT)
      .expect(201);
    videoId = (res.body as { videoId: string }).videoId;
  });

  const getVideo = (token: string) =>
    request(app.getHttpServer())
      .get(`/videos/${videoId}`)
      .set('Authorization', `Bearer ${token}`);

  const updateVideo = (changes: Partial<Video>) =>
    dataSource.getRepository(Video).update({ public_id: videoId }, changes);

  // 1. GET /videos/:videoId

  test('get-video-draft-uploading', async () => {
    const res = await getVideo(ownerToken).expect(200);

    const body = res.body as VideoBody;
    expect(body.videoId).toBe(videoId);
    expect(body.processingStatus).toBe('uploading');
    expect(body.publicationStatus).toBe('draft');
    expect(body.thumbnailUrl).toBeNull();
    expect(body.durationSeconds).toBeNull();
    expect(body.failureReason).toBeNull();
    expect(body.originalFilename).toBe(DRAFT.filename);
    expect(body.mimeType).toBe(DRAFT.mimeType);
    expect(body.sizeBytes).toBe(DRAFT.size);
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
  });

  test('get-video-ready', async () => {
    const thumbnailKey = `${videoId}.jpg`;
    await updateVideo({
      processing_status: VideoProcessingStatus.READY,
      duration_seconds: 12.5,
      width: 1280,
      height: 720,
      thumbnail_key: thumbnailKey,
    });

    const res = await getVideo(ownerToken).expect(200);

    const body = res.body as VideoBody;
    expect(body.processingStatus).toBe('ready');
    expect(body.durationSeconds).toBe(12.5);
    expect(body.width).toBe(1280);
    expect(body.height).toBe(720);
    expect(body.thumbnailUrl).not.toBeNull();
    expect(
      body.thumbnailUrl?.startsWith(
        buildTestStorageConfig().thumbnailsPublicBaseUrl,
      ),
    ).toBe(true);
    expect(body.thumbnailUrl?.endsWith(thumbnailKey)).toBe(true);
  });

  test('get-video-failed', async () => {
    await updateVideo({
      processing_status: VideoProcessingStatus.FAILED,
      failure_reason: VideoFailureReason.UNSUPPORTED_CODEC,
    });

    const res = await getVideo(ownerToken).expect(200);

    const body = res.body as VideoBody;
    expect(body.processingStatus).toBe('failed');
    expect(body.failureReason).toBe('UNSUPPORTED_CODEC');
    expect(body.thumbnailUrl).toBeNull();
  });

  test('get-video-not-owner-and-unauthenticated', async () => {
    const res = await getVideo(strangerToken).expect(404);
    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');

    await request(app.getHttpServer()).get(`/videos/${videoId}`).expect(401);
  });
});
