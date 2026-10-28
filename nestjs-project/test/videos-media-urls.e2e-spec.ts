import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import { STORAGE_BUCKETS } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { buildTestStorageConfig, clearTestBuckets } from '../src/test/storage';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VideoProcessingStatus } from '../src/videos/video.enums';

const PASSWORD = 'password123';
const FIXTURE = resolve(__dirname, 'fixtures/videos/h264-aac-faststart.mp4');
const FILENAME = 'meu vídeo.mp4';
const NOT_READY_STATUSES = [
  VideoProcessingStatus.UPLOADING,
  VideoProcessingStatus.PROCESSING,
  VideoProcessingStatus.FAILED,
];

interface MediaUrlBody {
  url: string;
  expiresInSeconds: number;
}

describe('videos-media-urls', () => {
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

  // The worker does not run in e2e: store the processed file and flip the row
  const seedReadyVideo = async (): Promise<string> => {
    const fixture = await readFile(FIXTURE);
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ filename: FILENAME, size: fixture.length, mimeType: 'video/mp4' })
      .expect(201);
    const { videoId: id } = res.body as { videoId: string };

    const videos = dataSource.getRepository(Video);
    const video = await videos.findOneByOrFail({ public_id: id });
    await app.get(StorageService).putObject({
      bucket: STORAGE_BUCKETS.VIDEOS,
      key: video.source_key,
      body: fixture,
      contentType: 'video/mp4',
    });
    await videos.update(video.id, {
      processing_status: VideoProcessingStatus.READY,
    });
    return id;
  };

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearTestBuckets();
    throttlerStorage.storage.clear();

    ownerToken = await seedUser('owner@example.com');
    strangerToken = await seedUser('stranger@example.com');
    videoId = await seedReadyVideo();
  });

  const getMediaUrl = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(`/videos/${videoId}/${path}`)
      .set('Authorization', `Bearer ${token}`);

  const setStatus = (status: VideoProcessingStatus) =>
    dataSource
      .getRepository(Video)
      .update({ public_id: videoId }, { processing_status: status });

  // 1. GET /videos/:videoId/stream-url

  test('stream-url-ready', async () => {
    const res = await getMediaUrl('stream-url', ownerToken).expect(200);

    const body = res.body as MediaUrlBody;
    const url = new URL(body.url);
    expect(url.host).toBe(
      new URL(buildTestStorageConfig().publicEndpoint).host,
    );
    expect(body.expiresInSeconds).toBe(uploadConfig().videoUrlTtlSeconds);
    expect(url.searchParams.get('response-content-disposition')).toBe('inline');
    expect(url.searchParams.get('response-content-type')).toBe('video/mp4');
  });

  test('stream-url-range-request', async () => {
    const res = await getMediaUrl('stream-url', ownerToken).expect(200);

    const media = await fetch((res.body as MediaUrlBody).url, {
      headers: { Range: 'bytes=0-1023' },
    });

    expect(media.status).toBe(206);
    expect(media.headers.get('content-type')).toBe('video/mp4');
    expect(media.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
    expect((await media.arrayBuffer()).byteLength).toBe(1024);
  });

  test('stream-url-not-ready', async () => {
    for (const status of NOT_READY_STATUSES) {
      await setStatus(status);

      const res = await getMediaUrl('stream-url', ownerToken).expect(409);
      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
    }
  });

  test('stream-url-not-owner-and-unauthenticated', async () => {
    const res = await getMediaUrl('stream-url', strangerToken).expect(404);
    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');

    await request(app.getHttpServer())
      .get(`/videos/${videoId}/stream-url`)
      .expect(401);
  });

  // 2. GET /videos/:videoId/download-url

  test('download-url-attachment', async () => {
    const res = await getMediaUrl('download-url', ownerToken).expect(200);

    const body = res.body as MediaUrlBody;
    expect(typeof body.url).toBe('string');
    expect(body.expiresInSeconds).toBe(uploadConfig().videoUrlTtlSeconds);

    const media = await fetch(body.url);
    expect(media.status).toBe(200);
    const disposition = media.headers.get('content-disposition');
    expect(disposition?.startsWith('attachment')).toBe(true);
    expect(disposition).toContain("filename*=UTF-8''meu%20v%C3%ADdeo.mp4");
  });

  test('download-url-not-ready', async () => {
    for (const status of NOT_READY_STATUSES) {
      await setStatus(status);

      const res = await getMediaUrl('download-url', ownerToken).expect(409);
      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
    }
  });

  test('download-url-not-owner-and-unauthenticated', async () => {
    const res = await getMediaUrl('download-url', strangerToken).expect(404);
    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');

    await request(app.getHttpServer())
      .get(`/videos/${videoId}/download-url`)
      .expect(401);
  });
});
