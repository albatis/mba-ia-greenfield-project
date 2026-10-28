import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

// No @Processor here — queue consumers live in the video worker (WorkerModule)
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    QueueModule,
    StorageModule,
    ChannelsModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoProcessingProducer],
})
export class VideosModule {}
