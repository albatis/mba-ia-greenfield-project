import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  UnsupportedVideoTypeException,
} from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideoProcessingStatus, VideoPublicationStatus } from './video.enums';
import { VideosService } from './videos.service';

const MAX_SIZE = 1_000;
const PART_SIZE = 300;
const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const UPLOAD_ID = 'upload-1';

function uniqueViolation(column: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT INTO "videos"',
    [],
    Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: `Key (${column})=(abc) already exists.`,
    }),
  );
}

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((data: Partial<Video>) => data),
    save: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
  };

  const validDto = (
    overrides: Partial<CreateVideoDto> = {},
  ): CreateVideoDto => ({
    filename: 'clip.mp4',
    size: 700,
    mimeType: 'video/mp4',
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    channelsService.findByUserId.mockResolvedValue({ id: CHANNEL_ID });
    storage.createMultipartUpload.mockResolvedValue(UPLOAD_ID);
    videoRepository.save.mockImplementation((video: Partial<Video>) =>
      Promise.resolve({
        ...video,
        processing_status: VideoProcessingStatus.UPLOADING,
        publication_status: VideoPublicationStatus.DRAFT,
      }),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
        {
          provide: uploadConfig.KEY,
          useValue: { maxSizeBytes: MAX_SIZE, partSizeBytes: PART_SIZE },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('rejects a declared size above the limit without touching storage', async () => {
      await expect(
        service.initiateUpload(USER_ID, validDto({ size: MAX_SIZE + 1 })),
      ).rejects.toBeInstanceOf(FileTooLargeException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('accepts a declared size exactly at the limit', async () => {
      await expect(
        service.initiateUpload(USER_ID, validDto({ size: MAX_SIZE })),
      ).resolves.toEqual(expect.objectContaining({ partCount: 4 }));
    });

    it('rejects a MIME type outside the allowlist without touching storage', async () => {
      await expect(
        service.initiateUpload(
          USER_ID,
          validDto({ mimeType: 'video/quicktime' }),
        ),
      ).rejects.toBeInstanceOf(UnsupportedVideoTypeException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('accepts video/webm', async () => {
      await service.initiateUpload(
        USER_ID,
        validDto({ mimeType: 'video/webm' }),
      );

      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'video/webm' }),
      );
    });

    it.each([
      [1, 1],
      [PART_SIZE, 1],
      [PART_SIZE + 1, 2],
      [700, 3],
    ])('splits %i bytes into %i part(s)', async (size, expectedParts) => {
      const result = await service.initiateUpload(USER_ID, validDto({ size }));

      expect(result.partSize).toBe(PART_SIZE);
      expect(result.partCount).toBe(expectedParts);
    });

    it("persists the draft in the user's channel with the multipart upload", async () => {
      const result = await service.initiateUpload(USER_ID, validDto());

      expect(channelsService.findByUserId).toHaveBeenCalledWith(USER_ID);
      const [saved] = videoRepository.save.mock.calls[0] as [Partial<Video>];
      const [multipart] = storage.createMultipartUpload.mock.calls[0] as [
        { key: string },
      ];
      expect(saved).toEqual(
        expect.objectContaining({
          channel_id: CHANNEL_ID,
          upload_id: UPLOAD_ID,
          source_key: multipart.key,
          part_size_bytes: PART_SIZE,
          part_count: 3,
        }),
      );
      expect(result).toEqual({
        videoId: saved.public_id,
        uploadId: UPLOAD_ID,
        partSize: PART_SIZE,
        partCount: 3,
        processingStatus: VideoProcessingStatus.UPLOADING,
        publicationStatus: VideoPublicationStatus.DRAFT,
      });
    });

    it('retries with a new public ID on a public_id unique violation', async () => {
      const defaultSave = videoRepository.save.getMockImplementation()!;
      videoRepository.save
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockImplementationOnce(defaultSave);

      await service.initiateUpload(USER_ID, validDto());

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const [first] = videoRepository.save.mock.calls[0] as [Partial<Video>];
      const [second] = videoRepository.save.mock.calls[1] as [Partial<Video>];
      expect(second.public_id).not.toBe(first.public_id);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload after 3 public_id collisions', async () => {
      const collision = uniqueViolation('public_id');
      videoRepository.save.mockRejectedValue(collision);

      await expect(service.initiateUpload(USER_ID, validDto())).rejects.toBe(
        collision,
      );

      expect(videoRepository.save).toHaveBeenCalledTimes(3);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.objectContaining({ uploadId: UPLOAD_ID }),
      );
    });

    it('aborts the multipart upload without retrying when the insert fails for another reason', async () => {
      const failure = uniqueViolation('channel_id');
      videoRepository.save.mockRejectedValueOnce(failure);

      await expect(service.initiateUpload(USER_ID, validDto())).rejects.toBe(
        failure,
      );

      expect(videoRepository.save).toHaveBeenCalledTimes(1);
      const [multipart] = storage.createMultipartUpload.mock.calls[0] as [
        { bucket: string; key: string },
      ];
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith({
        bucket: multipart.bucket,
        key: multipart.key,
        uploadId: UPLOAD_ID,
      });
    });
  });
});
