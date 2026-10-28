import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
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
import { Video } from '../videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../videos/video.enums';
import { UploadCleanupService } from './upload-cleanup.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const STALE_AFTER_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

describe('UploadCleanupService (integration - DB + storage)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let service: UploadCleanupService;
  let channelId: string;
  const now = new Date();

  /** Saves a video row created `ageHours` before `now`; drafts get a real multipart upload */
  async function seedVideo(
    status: VideoProcessingStatus,
    ageHours: number,
  ): Promise<Video> {
    const id = crypto.randomUUID();
    const sourceKey = `videos/${id}/source`;
    const uploadId =
      status === VideoProcessingStatus.UPLOADING
        ? await storage.createMultipartUpload({
            bucket: STORAGE_BUCKETS.VIDEOS,
            key: sourceKey,
            contentType: 'video/mp4',
          })
        : null;
    await videoRepository.save({
      id,
      public_id: `pid${id.slice(0, 8)}`,
      channel_id: channelId,
      processing_status: status,
      original_filename: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1024,
      source_key: sourceKey,
      upload_id: uploadId,
      part_size_bytes: 1024,
      part_count: 1,
    });
    // created_at is a CreateDateColumn: backdate it explicitly
    await dataSource.query('UPDATE videos SET created_at = $1 WHERE id = $2', [
      new Date(now.getTime() - ageHours * HOUR_MS),
      id,
    ]);
    return videoRepository.findOneByOrFail({ id });
  }

  const multipartOf = (video: Video) => ({
    bucket: STORAGE_BUCKETS.VIDEOS,
    key: video.source_key,
    uploadId: video.upload_id!,
  });

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
      ],
      providers: [UploadCleanupService],
    })
      .overrideProvider(uploadConfig.KEY)
      .useValue({ ...uploadConfig(), staleAfterHours: STALE_AFTER_HOURS })
      .compile();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = module.get(StorageService);
    service = module.get(UploadCleanupService);
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
    const channel = await dataSource
      .getRepository(Channel)
      .save({ user_id: user.id, nickname: 'uploader', name: 'Uploader' });
    channelId = channel.id;
  });

  it('should abort the multipart upload of a stale draft and mark it failed', async () => {
    const stale = await seedVideo(
      VideoProcessingStatus.UPLOADING,
      STALE_AFTER_HOURS + 1,
    );

    await expect(service.cleanupAbandoned(now)).resolves.toBe(1);

    const row = await videoRepository.findOneByOrFail({ id: stale.id });
    expect(row).toMatchObject({
      processing_status: VideoProcessingStatus.FAILED,
      failure_reason: VideoFailureReason.UPLOAD_ABANDONED,
      upload_id: null,
    });
    expect(row.processed_at).toBeInstanceOf(Date);
    await expect(storage.listParts(multipartOf(stale))).rejects.toMatchObject({
      name: 'NoSuchUpload',
    });
  });

  it('should leave recent drafts and processing/ready videos untouched', async () => {
    const recent = await seedVideo(
      VideoProcessingStatus.UPLOADING,
      STALE_AFTER_HOURS - 1,
    );
    const processing = await seedVideo(
      VideoProcessingStatus.PROCESSING,
      STALE_AFTER_HOURS * 2,
    );
    const ready = await seedVideo(
      VideoProcessingStatus.READY,
      STALE_AFTER_HOURS * 2,
    );

    await expect(service.cleanupAbandoned(now)).resolves.toBe(0);

    for (const video of [recent, processing, ready]) {
      await expect(
        videoRepository.findOneByOrFail({ id: video.id }),
      ).resolves.toEqual(video);
    }
    await expect(storage.listParts(multipartOf(recent))).resolves.toEqual([]);
  });

  it('should keep sweeping when a stale upload no longer exists in storage', async () => {
    const alreadyAborted = await seedVideo(
      VideoProcessingStatus.UPLOADING,
      STALE_AFTER_HOURS + 2,
    );
    const stale = await seedVideo(
      VideoProcessingStatus.UPLOADING,
      STALE_AFTER_HOURS + 1,
    );
    await storage.abortMultipartUpload(multipartOf(alreadyAborted));

    await expect(service.cleanupAbandoned(now)).resolves.toBe(2);

    const rows = await videoRepository.findBy([
      { id: alreadyAborted.id },
      { id: stale.id },
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: VideoFailureReason.UPLOAD_ABANDONED,
        upload_id: null,
      });
    }
  });

  it('should reach the same final state when run twice', async () => {
    const stale = await seedVideo(
      VideoProcessingStatus.UPLOADING,
      STALE_AFTER_HOURS + 1,
    );
    const recent = await seedVideo(
      VideoProcessingStatus.UPLOADING,
      STALE_AFTER_HOURS - 1,
    );

    await service.cleanupAbandoned(now);
    const afterFirst = await videoRepository.find({ order: { id: 'ASC' } });

    await expect(service.cleanupAbandoned(now)).resolves.toBe(0);
    await expect(
      videoRepository.find({ order: { id: 'ASC' } }),
    ).resolves.toEqual(afterFirst);
    expect(afterFirst.map((v) => v.id).sort()).toEqual(
      [stale.id, recent.id].sort(),
    );
  });
});
