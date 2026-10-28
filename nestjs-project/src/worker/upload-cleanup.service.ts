import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import uploadConfig from '../config/upload.config';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../videos/video.enums';

const MS_PER_HOUR = 60 * 60 * 1000;

@Injectable()
export class UploadCleanupService {
  private readonly logger = new Logger(UploadCleanupService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
  ) {}

  /**
   * Aborts the multipart upload of drafts stuck in 'uploading' beyond the
   * stale window and marks them failed. Idempotent: failed rows are no longer
   * selected and aborting a missing upload is a no-op.
   * @returns how many videos were marked failed
   */
  async cleanupAbandoned(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.upload.staleAfterHours * MS_PER_HOUR,
    );
    // Served by the (processing_status, created_at) index
    const stale = await this.videoRepository.findBy({
      processing_status: VideoProcessingStatus.UPLOADING,
      created_at: LessThan(cutoff),
    });

    let cleaned = 0;
    for (const video of stale) {
      try {
        if (await this.abandon(video, now)) {
          cleaned++;
        }
      } catch (error) {
        // One failing abort must not block the sweep; the row stays
        // 'uploading' and is retried on the next run
        this.logger.warn(
          `Could not clean up abandoned upload of video ${video.id}: ${String(error)}`,
        );
      }
    }
    return cleaned;
  }

  private async abandon(video: Video, now: Date): Promise<boolean> {
    if (video.upload_id) {
      await this.storage.abortMultipartUpload({
        bucket: STORAGE_BUCKETS.VIDEOS,
        key: video.source_key,
        uploadId: video.upload_id,
      });
    }
    // Conditional: an upload completed meanwhile has left 'uploading'
    const { affected } = await this.videoRepository.update(
      { id: video.id, processing_status: VideoProcessingStatus.UPLOADING },
      {
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: VideoFailureReason.UPLOAD_ABANDONED,
        upload_id: null,
        processed_at: now,
      },
    );
    return affected === 1;
  }
}
