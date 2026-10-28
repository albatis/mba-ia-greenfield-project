import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { clearTestBuckets, testStorageConfig } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingStatus, VideoPublicationStatus } from './video.enums';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration - DB + storage)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
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
      ],
      providers: [VideosService],
    }).compile();

    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
  }, 30000);

  afterAll(async () => {
    await clearTestBuckets();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearTestBuckets();

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
});
