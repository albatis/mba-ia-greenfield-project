import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { clearTestQueue, testBullRootModule } from '../test/queue';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration - Redis)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        testBullRootModule(),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();

    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  beforeEach(async () => {
    await clearTestQueue(queue);
  });

  afterAll(async () => {
    await clearTestQueue(queue);
    await module.close();
  });

  it('should add a process-video job keyed by the video id', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
  });

  it('should not create a second job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);
    await producer.enqueueProcessing(videoId);

    const jobs = await queue.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(videoId);
  });

  it('should keep jobs of different videos apart', async () => {
    const [first, second] = [randomUUID(), randomUUID()];

    await producer.enqueueProcessing(first);
    await producer.enqueueProcessing(second);

    const jobs = await queue.getJobs(['waiting']);
    expect(jobs.map((job) => job.id).sort()).toEqual([first, second].sort());
  });
});
