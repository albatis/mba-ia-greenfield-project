import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import {
  PROCESS_VIDEO_JOB,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { clearTestQueue, testBullRootModule } from '../test/queue';
import { clearTestBuckets, testStorageConfig } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideoProcessingStatus, VideoPublicationStatus } from './video.enums';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration - DB + storage)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let queue: Queue<ProcessVideoJobData>;
  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [testStorageConfig, uploadConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        ChannelsModule,
        testBullRootModule(),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideosService, VideoProcessingProducer],
    }).compile();

    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 30000);

  afterAll(async () => {
    await clearTestBuckets();
    await clearTestQueue(queue);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearTestBuckets();
    await clearTestQueue(queue);

    const user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    const channel = await module
      .get(ChannelsService)
      .createChannel(user.id, user.email);
    userId = user.id;
    channelId = channel.id;
  });

  describe('initiateUpload', () => {
    it('persists an uploading draft whose multipart upload exists in storage', async () => {
      const result = await service.initiateUpload(userId, {
        filename: 'clip.mp4',
        size: 200_000_000,
        mimeType: 'video/mp4',
      });

      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: result.videoId });
      expect(video).toEqual(
        expect.objectContaining({
          channel_id: channelId,
          processing_status: VideoProcessingStatus.UPLOADING,
          publication_status: VideoPublicationStatus.DRAFT,
          original_filename: 'clip.mp4',
          mime_type: 'video/mp4',
          size_bytes: 200_000_000,
          upload_id: result.uploadId,
          part_size_bytes: result.partSize,
          part_count: result.partCount,
        }),
      );

      const parts = await storage.listParts({
        bucket: STORAGE_BUCKETS.VIDEOS,
        key: video.source_key,
        uploadId: result.uploadId,
      });
      expect(parts).toEqual([]);
    });
  });

  describe('signUploadParts + listUploadedParts', () => {
    const PART_BYTES = 5 * 1024 * 1024;

    it('lists a part PUT through a signed URL with its etag and size', async () => {
      const { videoId } = await service.initiateUpload(userId, {
        filename: 'clip.mp4',
        size: 200_000_000,
        mimeType: 'video/mp4',
      });

      const { parts } = await service.signUploadParts(userId, videoId, {
        partNumbers: [1],
      });
      const res = await fetch(parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(PART_BYTES),
      });
      expect(res.status).toBe(200);

      const { uploadedParts } = await service.listUploadedParts(
        userId,
        videoId,
      );
      expect(uploadedParts).toEqual([
        { partNumber: 1, etag: res.headers.get('etag'), size: PART_BYTES },
      ]);
    });

    it("hides another user's video", async () => {
      const { videoId } = await service.initiateUpload(userId, {
        filename: 'clip.mp4',
        size: 1_000,
        mimeType: 'video/mp4',
      });
      const stranger = await dataSource
        .getRepository(User)
        .save({ email: 'stranger@example.com', password: 'hashed' });

      await expect(
        service.listUploadedParts(stranger.id, videoId),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('completeUpload', () => {
    const putPart = async (url: string, bytes: number): Promise<string> => {
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
      });
      expect(res.status).toBe(200);
      return res.headers.get('etag')!;
    };

    it('completes 2 real parts, records the real size and enqueues process-video by internal id', async () => {
      const firstPart = 5 * 1024 * 1024;
      const lastPart = 4 * 1024;
      const { videoId, partSize } = await service.initiateUpload(userId, {
        filename: 'clip.mp4',
        size: uploadConfig().partSizeBytes + 1024,
        mimeType: 'video/mp4',
      });
      expect(partSize).toBe(uploadConfig().partSizeBytes);
      const { parts } = await service.signUploadParts(userId, videoId, {
        partNumbers: [1, 2],
      });
      const etags = [
        await putPart(parts[0].url, firstPart),
        await putPart(parts[1].url, lastPart),
      ];

      const result = await service.completeUpload(userId, videoId, {
        parts: [
          { partNumber: 1, etag: etags[0] },
          { partNumber: 2, etag: etags[1] },
        ],
      });

      expect(result.processingStatus).toBe(VideoProcessingStatus.PROCESSING);
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: videoId });
      expect(video).toEqual(
        expect.objectContaining({
          processing_status: VideoProcessingStatus.PROCESSING,
          size_bytes: firstPart + lastPart,
          upload_id: null,
          upload_completed_at: expect.any(Date) as Date,
        }),
      );
      const object = await storage.headObject({
        bucket: STORAGE_BUCKETS.VIDEOS,
        key: video.source_key,
      });
      expect(object?.contentLength).toBe(firstPart + lastPart);

      const job = await queue.getJob(video.id);
      expect(job?.name).toBe(PROCESS_VIDEO_JOB);
      expect(job?.data).toEqual({ videoId: video.id });
    });
  });
});
