import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { VideoProcessingStatus, VideoPublicationStatus } from '../video.enums';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Video Channel',
        nickname: `video_channel_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      public_id: generatePublicId(),
      channel_id: channelId,
      original_filename: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 200_000_000,
      source_key: `videos/${randomUUID()}/source`,
      upload_id: 'upload-1',
      part_size_bytes: 67_108_864,
      part_count: 3,
      ...overrides,
    });
  }

  it('should reject two videos with the same public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      buildVideo(channel.id, { public_id: 'abcdefghijk' }),
    );

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { public_id: 'abcdefghijk' }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('should default to uploading / draft when no status is given', async () => {
    const channel = await createChannel();

    const { id } = await videoRepository.save(buildVideo(channel.id));
    const stored = await videoRepository.findOneByOrFail({ id });

    expect(stored.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    expect(stored.publication_status).toBe(VideoPublicationStatus.DRAFT);
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videoRepository.save(buildVideo(randomUUID())),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('should delete the videos of a removed channel', async () => {
    const channel = await createChannel();
    await videoRepository.save([
      buildVideo(channel.id),
      buildVideo(channel.id),
    ]);

    await channelRepository.delete({ id: channel.id });

    await expect(
      videoRepository.countBy({ channel_id: channel.id }),
    ).resolves.toBe(0);
  });

  it('should read size_bytes above 2^31 back as the same number', async () => {
    const channel = await createChannel();
    const tenGigabytes = 10_737_418_240;

    const { id } = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: tenGigabytes }),
    );
    const stored = await videoRepository.findOneByOrFail({ id });

    expect(stored.size_bytes).toBe(tenGigabytes);
  });

  it('should read duration_seconds back as a number', async () => {
    const channel = await createChannel();

    const { id } = await videoRepository.save(
      buildVideo(channel.id, { duration_seconds: 12.345 }),
    );
    const stored = await videoRepository.findOneByOrFail({ id });

    expect(stored.duration_seconds).toBe(12.345);
  });
});
