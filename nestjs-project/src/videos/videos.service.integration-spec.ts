import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
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
});
