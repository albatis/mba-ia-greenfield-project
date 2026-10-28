import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOn } from '../common/database/pg-errors';
import {
  FileTooLargeException,
  UnsupportedVideoTypeException,
} from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
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
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
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
