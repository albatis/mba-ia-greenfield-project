import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UnsupportedVideoTypeException,
  UploadNotInProgressException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import { StoragePartsRejectedError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  VideoFailureReason,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './video.enums';
import { VideosService } from './videos.service';

const MAX_SIZE = 1_000;
const PART_SIZE = 300;
const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const UPLOAD_ID = 'upload-1';
const PART_URL_TTL = 900;
const PUBLIC_ID = 'Ab3_dE-fGh1';
const SOURCE_KEY = 'videos/video-1/source';
const THUMBNAILS_BASE_URL = 'http://thumbnails.example.test';

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
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const processingProducer = { enqueueProcessing: jest.fn() };

  const uploadingVideo = (overrides: Partial<Video> = {}): Partial<Video> => ({
    id: 'video-1',
    public_id: PUBLIC_ID,
    processing_status: VideoProcessingStatus.UPLOADING,
    source_key: SOURCE_KEY,
    upload_id: UPLOAD_ID,
    part_size_bytes: PART_SIZE,
    part_count: 3,
    publication_status: VideoPublicationStatus.DRAFT,
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: 700,
    duration_seconds: null,
    width: null,
    height: null,
    thumbnail_key: null,
    failure_reason: null,
    created_at: new Date('2026-10-28T10:00:00.000Z'),
    ...overrides,
  });

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
        { provide: VideoProcessingProducer, useValue: processingProducer },
        {
          provide: storageConfig.KEY,
          useValue: { thumbnailsPublicBaseUrl: THUMBNAILS_BASE_URL },
        },
        {
          provide: uploadConfig.KEY,
          useValue: {
            maxSizeBytes: MAX_SIZE,
            partSizeBytes: PART_SIZE,
            partUrlTtlSeconds: PART_URL_TTL,
          },
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

  describe('findOwnedVideo', () => {
    it.each(['abc', 'Ab3_dE-fGh12', 'Ab3_dE.fGh1'])(
      'rejects the malformed public ID %p without querying the database',
      async (publicId) => {
        await expect(
          service.findOwnedVideo(USER_ID, publicId),
        ).rejects.toBeInstanceOf(VideoNotFoundException);

        expect(videoRepository.findOne).not.toHaveBeenCalled();
      },
    );

    it('rejects an ID with no video owned by the user', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOwnedVideo(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it("scopes the lookup to the user's channel", async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());

      await service.findOwnedVideo(USER_ID, PUBLIC_ID);

      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { public_id: PUBLIC_ID, channel: { user_id: USER_ID } },
      });
    });
  });

  describe('signUploadParts', () => {
    it('rejects an unknown video without signing', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.signUploadParts(USER_ID, PUBLIC_ID, { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it.each([
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.READY,
      VideoProcessingStatus.FAILED,
    ])('rejects a %s video without signing', async (status) => {
      videoRepository.findOne.mockResolvedValue(
        uploadingVideo({ processing_status: status }),
      );

      await expect(
        service.signUploadParts(USER_ID, PUBLIC_ID, { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);

      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('rejects a part number above the part count without signing any part', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());

      await expect(
        service.signUploadParts(USER_ID, PUBLIC_ID, { partNumbers: [1, 4] }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);

      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('signs every requested part, including the last one, with the configured TTL', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());
      storage.presignUploadPart.mockImplementation(
        ({ partNumber }: { partNumber: number }) =>
          Promise.resolve(`https://storage/part-${partNumber}`),
      );

      const result = await service.signUploadParts(USER_ID, PUBLIC_ID, {
        partNumbers: [3, 1],
      });

      expect(result).toEqual({
        parts: [
          { partNumber: 3, url: 'https://storage/part-3' },
          { partNumber: 1, url: 'https://storage/part-1' },
        ],
        expiresInSeconds: PART_URL_TTL,
      });
      expect(storage.presignUploadPart).toHaveBeenCalledWith({
        bucket: STORAGE_BUCKETS.VIDEOS,
        key: SOURCE_KEY,
        uploadId: UPLOAD_ID,
        partNumber: 3,
        expiresInSeconds: PART_URL_TTL,
      });
    });
  });

  describe('listUploadedParts', () => {
    it('rejects a video that is no longer uploading without listing', async () => {
      videoRepository.findOne.mockResolvedValue(
        uploadingVideo({
          processing_status: VideoProcessingStatus.PROCESSING,
          upload_id: null,
        }),
      );

      await expect(
        service.listUploadedParts(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);

      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('returns the upload plan with the parts storage holds', async () => {
      const uploaded = [{ partNumber: 1, etag: '"etag-1"', size: PART_SIZE }];
      videoRepository.findOne.mockResolvedValue(uploadingVideo());
      storage.listParts.mockResolvedValue(uploaded);

      const result = await service.listUploadedParts(USER_ID, PUBLIC_ID);

      expect(result).toEqual({
        uploadId: UPLOAD_ID,
        partSize: PART_SIZE,
        partCount: 3,
        uploadedParts: uploaded,
      });
      expect(storage.listParts).toHaveBeenCalledWith({
        bucket: STORAGE_BUCKETS.VIDEOS,
        key: SOURCE_KEY,
        uploadId: UPLOAD_ID,
      });
    });
  });

  describe('completeUpload', () => {
    const allParts = [
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 3, etag: '"etag-3"' },
    ];
    const REAL_SIZE = 650;

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());
      storage.completeMultipartUpload.mockResolvedValue(undefined);
      storage.headObject.mockResolvedValue({
        contentLength: REAL_SIZE,
        contentType: 'video/mp4',
      });
      videoRepository.update.mockResolvedValue({ affected: 1 });
    });

    it('rejects a video that is no longer uploading without touching storage', async () => {
      videoRepository.findOne.mockResolvedValue(
        uploadingVideo({
          processing_status: VideoProcessingStatus.PROCESSING,
          upload_id: null,
        }),
      );

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: allParts }),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a duplicated part number',
        [
          { partNumber: 1, etag: '"a"' },
          { partNumber: 1, etag: '"b"' },
        ],
      ],
      ['a part number above the part count', [{ partNumber: 4, etag: '"a"' }]],
    ])('rejects %s without calling storage', async (_case, parts) => {
      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts }),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('maps a storage rejection of the part list to INVALID_UPLOAD_PARTS and keeps the upload resumable', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new StoragePartsRejectedError('InvalidPart', 'bad etag'),
      );

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: allParts }),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);

      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(processingProducer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('propagates unexpected storage errors unchanged', async () => {
      const failure = new Error('storage down');
      storage.completeMultipartUpload.mockRejectedValue(failure);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: allParts }),
      ).rejects.toBe(failure);
    });

    it('sends the parts to storage in ascending order', async () => {
      await service.completeUpload(USER_ID, PUBLIC_ID, { parts: allParts });

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith({
        bucket: STORAGE_BUCKETS.VIDEOS,
        key: SOURCE_KEY,
        uploadId: UPLOAD_ID,
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
          { partNumber: 3, etag: '"etag-3"' },
        ],
      });
    });

    it('deletes an object above the limit and fails the video without enqueueing', async () => {
      storage.headObject.mockResolvedValue({
        contentLength: MAX_SIZE + 1,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: allParts }),
      ).rejects.toBeInstanceOf(FileTooLargeException);

      expect(storage.deleteObject).toHaveBeenCalledWith({
        bucket: STORAGE_BUCKETS.VIDEOS,
        key: SOURCE_KEY,
      });
      expect(videoRepository.update).toHaveBeenCalledWith('video-1', {
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: VideoFailureReason.FILE_TOO_LARGE,
        upload_id: null,
      });
      expect(processingProducer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('moves the video to processing with the real size, then enqueues it by internal id', async () => {
      const result = await service.completeUpload(USER_ID, PUBLIC_ID, {
        parts: allParts,
      });

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', processing_status: VideoProcessingStatus.UPLOADING },
        expect.objectContaining({
          processing_status: VideoProcessingStatus.PROCESSING,
          size_bytes: REAL_SIZE,
          upload_id: null,
          upload_completed_at: expect.any(Date) as Date,
        }),
      );
      expect(processingProducer.enqueueProcessing).toHaveBeenCalledWith(
        'video-1',
      );
      expect(videoRepository.update.mock.invocationCallOrder[0]).toBeLessThan(
        processingProducer.enqueueProcessing.mock.invocationCallOrder[0],
      );
      expect(result).toEqual(
        expect.objectContaining({
          videoId: PUBLIC_ID,
          processingStatus: VideoProcessingStatus.PROCESSING,
          sizeBytes: REAL_SIZE,
          thumbnailUrl: null,
        }),
      );
    });

    it('does not enqueue when the status update fails', async () => {
      videoRepository.update.mockRejectedValue(new Error('db down'));

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: allParts }),
      ).rejects.toThrow('db down');

      expect(processingProducer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('does not enqueue when a concurrent complete already moved the video on', async () => {
      videoRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, { parts: allParts }),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);

      expect(processingProducer.enqueueProcessing).not.toHaveBeenCalled();
    });
  });
});
