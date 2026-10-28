import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import { MediaModule } from '../../media/media.module';
import { needsFaststart } from '../../media/mp4-atoms.util';
import type { ProcessVideoJobData } from '../../queue/queue.constants';
import { STORAGE_BUCKETS } from '../../storage/storage.constants';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { clearTestBuckets, testStorageConfig } from '../../test/storage';
import { User } from '../../users/entities/user.entity';
import { Video } from '../../videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../../videos/video.enums';
import { VideoProcessingProcessor } from './video-processing.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURES = resolve(__dirname, '../../../test/fixtures/videos');
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('VideoProcessingProcessor (integration - DB + storage + ffmpeg)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let processor: VideoProcessingProcessor;
  let channelId: string;
  let workDir: string;

  /** Uploads a fixture as the source object of a 'processing' video row */
  async function seedProcessingVideo(
    fixture: string,
    mimeType: string,
  ): Promise<Video> {
    const id = crypto.randomUUID();
    const sourceKey = `videos/${id}/source`;
    const body = await readFile(join(FIXTURES, fixture));
    await storage.putObject({
      bucket: STORAGE_BUCKETS.VIDEOS,
      key: sourceKey,
      body,
      contentType: mimeType,
    });
    return videoRepository.save({
      id,
      public_id: `pid${id.slice(0, 8)}`,
      channel_id: channelId,
      processing_status: VideoProcessingStatus.PROCESSING,
      original_filename: fixture,
      mime_type: mimeType,
      size_bytes: body.length,
      source_key: sourceKey,
      upload_id: null,
      part_size_bytes: body.length,
      part_count: 1,
      upload_completed_at: new Date(),
    });
  }

  const jobFor = (video: Video): Job<ProcessVideoJobData> =>
    ({ data: { videoId: video.id } }) as Job<ProcessVideoJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [testStorageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        MediaModule,
      ],
      // No BullModule: process() is called directly, no worker consumes jobs
      providers: [VideoProcessingProcessor],
    }).compile();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = module.get(StorageService);
    processor = module.get(VideoProcessingProcessor);
  }, 30000);

  afterAll(async () => {
    await clearTestBuckets();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearTestBuckets();
    workDir = await mkdtemp(join(tmpdir(), 'processor-spec-'));

    const user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ user_id: user.id, nickname: 'uploader', name: 'Uploader' });
    channelId = channel.id;
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('marks an MP4 ready with its metadata and a public JPEG thumbnail', async () => {
    const video = await seedProcessingVideo(
      'h264-aac-faststart.mp4',
      'video/mp4',
    );

    await processor.process(jobFor(video));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      processing_status: VideoProcessingStatus.READY,
      width: 160,
      height: 120,
      video_codec: 'h264',
      audio_codec: 'aac',
      thumbnail_key: `${video.public_id}.jpg`,
      failure_reason: null,
    });
    expect(row.duration_seconds).toBeGreaterThan(0);
    expect(row.processed_at).toBeInstanceOf(Date);

    const thumbnail = await storage.headObject({
      bucket: STORAGE_BUCKETS.THUMBNAILS,
      key: `${video.public_id}.jpg`,
    });
    expect(thumbnail?.contentType).toBe('image/jpeg');

    const thumbnailPath = join(workDir, 'thumbnail.jpg');
    await storage.downloadToFile({
      bucket: STORAGE_BUCKETS.THUMBNAILS,
      key: `${video.public_id}.jpg`,
      filePath: thumbnailPath,
    });
    const jpeg = await readFile(thumbnailPath);
    expect(jpeg.subarray(0, 3)).toEqual(JPEG_MAGIC);
  });

  it('rewrites an MP4 with moov at the end so the stored source is faststart', async () => {
    const video = await seedProcessingVideo(
      'h264-aac-moov-end.mp4',
      'video/mp4',
    );

    await processor.process(jobFor(video));

    const sourcePath = join(workDir, 'source.mp4');
    await storage.downloadToFile({
      bucket: STORAGE_BUCKETS.VIDEOS,
      key: video.source_key,
      filePath: sourcePath,
    });
    expect(await needsFaststart(sourcePath)).toBe(false);
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.READY);
  });

  it('marks a VP9/Opus WebM ready', async () => {
    const video = await seedProcessingVideo('vp9-opus.webm', 'video/webm');

    await processor.process(jobFor(video));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      processing_status: VideoProcessingStatus.READY,
      video_codec: 'vp9',
      audio_codec: 'opus',
    });
  });

  it('marks an HEVC video failed with UNSUPPORTED_CODEC and stores no thumbnail', async () => {
    const video = await seedProcessingVideo('hevc.mp4', 'video/mp4');

    await processor.process(jobFor(video));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      processing_status: VideoProcessingStatus.FAILED,
      failure_reason: VideoFailureReason.UNSUPPORTED_CODEC,
      thumbnail_key: null,
    });
    expect(row.processed_at).toBeInstanceOf(Date);
    expect(
      await storage.headObject({
        bucket: STORAGE_BUCKETS.THUMBNAILS,
        key: `${video.public_id}.jpg`,
      }),
    ).toBeNull();
  });

  it('marks a non-video file failed with PROBE_FAILED', async () => {
    const video = await seedProcessingVideo('not-a-video.mp4', 'video/mp4');

    await processor.process(jobFor(video));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      processing_status: VideoProcessingStatus.FAILED,
      failure_reason: VideoFailureReason.PROBE_FAILED,
    });
  });

  it('leaves a ready video untouched when its job is processed again', async () => {
    const video = await seedProcessingVideo(
      'h264-aac-moov-end.mp4',
      'video/mp4',
    );
    await processor.process(jobFor(video));
    const before = await videoRepository.findOneByOrFail({ id: video.id });
    const sourceBefore = await storage.headObject({
      bucket: STORAGE_BUCKETS.VIDEOS,
      key: video.source_key,
    });

    await processor.process(jobFor(video));

    const after = await videoRepository.findOneByOrFail({ id: video.id });
    expect(after).toEqual(before);
    expect(
      await storage.headObject({
        bucket: STORAGE_BUCKETS.VIDEOS,
        key: video.source_key,
      }),
    ).toEqual(sourceBefore);
  });
});
