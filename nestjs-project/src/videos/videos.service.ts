import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOn } from '../common/database/pg-errors';
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
import {
  StorageService,
  type MultipartLocation,
} from '../storage/storage.service';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import type { SignPartsDto } from './dto/sign-parts.dto';
import type { SignedPartsResponseDto } from './dto/signed-parts-response.dto';
import type { UploadPartsResponseDto } from './dto/upload-parts-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { Video } from './entities/video.entity';
import { generatePublicId, PUBLIC_ID_PATTERN } from './public-id.util';
import { VideoProcessingProducer } from './video-processing.producer';
import { toVideoResponse } from './video-response.mapper';
import { VideoFailureReason, VideoProcessingStatus } from './video.enums';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  PUBLIC_ID_MAX_ATTEMPTS,
} from './videos.constants';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly processingProducer: VideoProcessingProducer,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
    @Inject(storageConfig.KEY)
    private readonly storageSettings: ConfigType<typeof storageConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    if (dto.size > this.upload.maxSizeBytes) {
      throw new FileTooLargeException();
    }
    if (
      !(ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(dto.mimeType)
    ) {
      throw new UnsupportedVideoTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Every user gets a channel at registration
      throw new Error(`User ${userId} has no channel`);
    }

    // The internal id is fixed up front so the object key never changes,
    // even when the public ID is regenerated on a collision
    const id = randomUUID();
    const sourceKey = `videos/${id}/source`;
    const partSize = this.upload.partSizeBytes;
    const uploadId = await this.storage.createMultipartUpload({
      bucket: STORAGE_BUCKETS.VIDEOS,
      key: sourceKey,
      contentType: dto.mimeType,
    });

    let video: Video;
    try {
      video = await this.insertDraft({
        id,
        channel_id: channel.id,
        original_filename: dto.filename,
        mime_type: dto.mimeType,
        size_bytes: dto.size,
        source_key: sourceKey,
        upload_id: uploadId,
        part_size_bytes: partSize,
        part_count: Math.ceil(dto.size / partSize),
      });
    } catch (error) {
      // No row points at the multipart — abort it so storage doesn't keep it
      await this.storage.abortMultipartUpload({
        bucket: STORAGE_BUCKETS.VIDEOS,
        key: sourceKey,
        uploadId,
      });
      throw error;
    }

    return {
      videoId: video.public_id,
      uploadId,
      partSize: video.part_size_bytes,
      partCount: video.part_count,
      processingStatus: video.processing_status,
      publicationStatus: video.publication_status,
    };
  }

  /** Owner-only lookup: malformed, unknown and foreign IDs all answer VIDEO_NOT_FOUND */
  async findOwnedVideo(userId: string, publicId: string): Promise<Video> {
    if (!PUBLIC_ID_PATTERN.test(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async signUploadParts(
    userId: string,
    publicId: string,
    dto: SignPartsDto,
  ): Promise<SignedPartsResponseDto> {
    const video = await this.findOwnedVideo(userId, publicId);
    const location = this.pendingMultipart(video);
    if (dto.partNumbers.some((partNumber) => partNumber > video.part_count)) {
      throw new InvalidPartNumberException();
    }

    const expiresInSeconds = this.upload.partUrlTtlSeconds;
    const parts = await Promise.all(
      dto.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.presignUploadPart({
          ...location,
          partNumber,
          expiresInSeconds,
        }),
      })),
    );
    return { parts, expiresInSeconds };
  }

  async listUploadedParts(
    userId: string,
    publicId: string,
  ): Promise<UploadPartsResponseDto> {
    const video = await this.findOwnedVideo(userId, publicId);
    const location = this.pendingMultipart(video);

    return {
      uploadId: location.uploadId,
      partSize: video.part_size_bytes,
      partCount: video.part_count,
      uploadedParts: await this.storage.listParts(location),
    };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedVideo(userId, publicId);
    const location = this.pendingMultipart(video);
    const partNumbers = dto.parts.map((part) => part.partNumber);
    if (
      new Set(partNumbers).size !== partNumbers.length ||
      partNumbers.some((partNumber) => partNumber > video.part_count)
    ) {
      throw new InvalidUploadPartsException();
    }

    try {
      await this.storage.completeMultipartUpload({
        ...location,
        // S3 requires ascending part order
        parts: dto.parts
          .map(({ partNumber, etag }) => ({ partNumber, etag }))
          .sort((a, b) => a.partNumber - b.partNumber),
      });
    } catch (error) {
      if (error instanceof StoragePartsRejectedError) {
        throw new InvalidUploadPartsException();
      }
      throw error;
    }

    // The declared size is only a hint; the real object size is authoritative
    const source = { bucket: STORAGE_BUCKETS.VIDEOS, key: video.source_key };
    const object = await this.storage.headObject(source);
    if (!object) {
      throw new Error(`Completed upload ${video.source_key} has no object`);
    }
    if (object.contentLength > this.upload.maxSizeBytes) {
      await this.storage.deleteObject(source);
      await this.videoRepository.update(video.id, {
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: VideoFailureReason.FILE_TOO_LARGE,
        upload_id: null,
      });
      throw new FileTooLargeException();
    }

    const completed = {
      processing_status: VideoProcessingStatus.PROCESSING,
      size_bytes: object.contentLength,
      upload_completed_at: new Date(),
      upload_id: null,
    };
    // Conditional on 'uploading' so a concurrent complete cannot enqueue twice
    const { affected } = await this.videoRepository.update(
      { id: video.id, processing_status: VideoProcessingStatus.UPLOADING },
      completed,
    );
    if (!affected) {
      throw new UploadNotInProgressException();
    }

    // Enqueued only after the status change is committed (per TD-02/TD-06)
    await this.processingProducer.enqueueProcessing(video.id);

    return toVideoResponse(
      { ...video, ...completed },
      this.storageSettings.thumbnailsPublicBaseUrl,
    );
  }

  private pendingMultipart(video: Video): MultipartLocation {
    if (
      video.processing_status !== VideoProcessingStatus.UPLOADING ||
      !video.upload_id
    ) {
      throw new UploadNotInProgressException();
    }
    return {
      bucket: STORAGE_BUCKETS.VIDEOS,
      key: video.source_key,
      uploadId: video.upload_id,
    };
  }

  private async insertDraft(
    draft: Omit<Partial<Video>, 'public_id'>,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...draft,
            public_id: generatePublicId(),
          }),
        );
      } catch (error) {
        if (
          attempt >= PUBLIC_ID_MAX_ATTEMPTS ||
          !isUniqueViolationOn(error, 'public_id')
        ) {
          throw error;
        }
      }
    }
  }
}
