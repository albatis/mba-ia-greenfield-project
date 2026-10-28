import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { configModuleOptions } from '../config/config-module.options';
import { typeOrmAsyncOptions } from '../database/typeorm-options.factory';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { UploadCleanupProcessor } from './processors/upload-cleanup.processor';
import { VideoProcessingProcessor } from './processors/video-processing.processor';
import { UploadCleanupService } from './upload-cleanup.service';

/** Root of the video worker process (src/worker.ts): queue consumers, no HTTP */
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmAsyncOptions),
    // Channel and User only complete the metadata of Video's relations
    // (autoLoadEntities); the worker reads and writes videos alone
    TypeOrmModule.forFeature([Video, Channel, User]),
    QueueModule,
    StorageModule,
    MediaModule,
  ],
  providers: [
    VideoProcessingProcessor,
    UploadCleanupService,
    UploadCleanupProcessor,
    MaintenanceScheduler,
  ],
})
export class WorkerModule {}
