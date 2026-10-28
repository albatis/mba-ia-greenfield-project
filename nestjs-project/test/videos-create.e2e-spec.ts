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

const PASSWORD = 'password123';

describe('videos-create', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let accessToken: string;
  let channelId: string;

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

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearTestBuckets();
    throttlerStorage.storage.clear();

    const email = 'uploader@example.com';
    const user = await dataSource.getRepository(User).save({
      email,
      password: await argon2.hash(PASSWORD),
      is_confirmed: true,
    });
    const channel = await app
      .get(ChannelsService)
      .createChannel(user.id, email);
    channelId = channel.id;

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    accessToken = (login.body as { access_token: string }).access_token;
  });

  const countVideos = (): Promise<number> =>
    dataSource.getRepository(Video).count();

  // 1. POST /videos

  test('initiate-upload-success', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'a.mp4', size: 200000000, mimeType: 'video/mp4' })
      .expect(201);

    const body = res.body as {
      videoId: string;
      uploadId: string;
      partSize: number;
      partCount: number;
      processingStatus: string;
      publicationStatus: string;
    };
    expect(body.videoId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(typeof body.uploadId).toBe('string');
    expect(body.uploadId).not.toHaveLength(0);
    expect(body).toEqual(
      expect.objectContaining({
        partSize: 67108864,
        partCount: 3,
        processingStatus: 'uploading',
        publicationStatus: 'draft',
      }),
    );

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: body.videoId });
    expect(video.channel_id).toBe(channelId);
    expect(video.upload_id).toBe(body.uploadId);
    expect(video.original_filename).toBe('a.mp4');
    expect(video.mime_type).toBe('video/mp4');
    expect(video.part_count).toBe(3);
  });

  test('initiate-upload-file-too-large', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'big.mp4', size: 10737418241, mimeType: 'video/mp4' })
      .expect(400);

    expect(res.body).toEqual({
      statusCode: 400,
      error: 'FILE_TOO_LARGE',
      message: expect.any(String) as string,
    });
    expect(await countVideos()).toBe(0);
  });

  test('initiate-upload-unsupported-type', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'a.mov', size: 1000, mimeType: 'video/quicktime' })
      .expect(400);

    expect((res.body as { error: string }).error).toBe(
      'UNSUPPORTED_VIDEO_TYPE',
    );
    expect(await countVideos()).toBe(0);
  });

  test('initiate-upload-validation-error', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ size: 1000, mimeType: 'video/mp4' })
      .expect(400);

    expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
  });

  test('initiate-upload-unauthenticated', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send({ filename: 'a.mp4', size: 1000, mimeType: 'video/mp4' })
      .expect(401);

    expect(await countVideos()).toBe(0);
  });
});
