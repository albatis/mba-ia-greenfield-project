import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { FfmpegService } from '../media/ffmpeg.service';
import { FfprobeService } from '../media/ffprobe.service';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { buildTestQueueConfig } from '../test/queue';
import { buildTestStorageConfig } from '../test/storage';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from './processors/video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    // compile() runs no lifecycle hooks, so no BullMQ worker starts consuming
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(queueConfig.KEY)
      .useValue(buildTestQueueConfig())
      .overrideProvider(storageConfig.KEY)
      .useValue(buildTestStorageConfig())
      .compile();
  }, 30000);

  afterAll(async () => {
    await module.close();
  });

  it('compiles with TypeORM, queue, storage, media and the processor wired in', () => {
    expect(module.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(FfprobeService)).toBeInstanceOf(FfprobeService);
    expect(module.get(FfmpegService)).toBeInstanceOf(FfmpegService);
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
  });
});
