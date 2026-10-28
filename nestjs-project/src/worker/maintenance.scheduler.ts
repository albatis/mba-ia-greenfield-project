import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import uploadConfig from '../config/upload.config';
import {
  CLEANUP_ABANDONED_UPLOADS_JOB,
  VIDEO_MAINTENANCE_QUEUE,
} from '../queue/queue.constants';

/** Registers the worker's recurring maintenance jobs */
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_MAINTENANCE_QUEUE)
    private readonly maintenanceQueue: Queue,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
  ) {}

  // Upserting by scheduler ID keeps a single scheduler across worker restarts
  async onApplicationBootstrap(): Promise<void> {
    await this.maintenanceQueue.upsertJobScheduler(
      CLEANUP_ABANDONED_UPLOADS_JOB,
      { every: this.upload.cleanupIntervalMs },
      { name: CLEANUP_ABANDONED_UPLOADS_JOB, data: {} },
    );
  }
}
