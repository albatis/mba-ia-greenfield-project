import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import type { DefaultJobOptions } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';

const ONE_DAY_SECONDS = 24 * 60 * 60;

// Retention is by age (seconds) so Redis stays bounded; failed jobs are kept
// longer for inspection. Removal is lazy (runs when the next job finishes).
const retention: Pick<DefaultJobOptions, 'removeOnComplete' | 'removeOnFail'> =
  {
    removeOnComplete: { age: ONE_DAY_SECONDS, count: 1000 },
    removeOnFail: { age: 7 * ONE_DAY_SECONDS },
  };

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        connection: { host: queue.redisHost, port: queue.redisPort },
      }),
    }),
    BullModule.registerQueue(
      {
        name: VIDEO_PROCESSING_QUEUE,
        defaultJobOptions: {
          // Retries cover transient storage/DB errors on long jobs
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          ...retention,
        },
      },
      {
        name: VIDEO_MAINTENANCE_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
          ...retention,
        },
      },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
