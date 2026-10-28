import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { VIDEO_MAINTENANCE_QUEUE } from '../../queue/queue.constants';
import { UploadCleanupService } from '../upload-cleanup.service';

/** Consumes the `cleanup-abandoned-uploads` jobs produced by MaintenanceScheduler */
@Processor(VIDEO_MAINTENANCE_QUEUE)
export class UploadCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(UploadCleanupProcessor.name);

  constructor(private readonly uploadCleanup: UploadCleanupService) {
    super();
  }

  async process(job: Job): Promise<void> {
    const cleaned = await this.uploadCleanup.cleanupAbandoned(new Date());
    if (cleaned > 0) {
      this.logger.log(`${job.name}: ${cleaned} abandoned upload(s) failed`);
    }
  }
}
