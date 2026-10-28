import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { TEST_QUEUE_PREFIX, buildTestQueueConfig } from '../test/queue';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    })
      .overrideProvider(queueConfig.KEY)
      .useValue(buildTestQueueConfig())
      .compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('should resolve both queues', () => {
    expect(module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)).name).toBe(
      VIDEO_PROCESSING_QUEUE,
    );
    expect(module.get<Queue>(getQueueToken(VIDEO_MAINTENANCE_QUEUE)).name).toBe(
      VIDEO_MAINTENANCE_QUEUE,
    );
  });

  it('should take the Redis connection from the queue config namespace', () => {
    const { redisHost, redisPort } = queueConfig();
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue.opts.connection).toEqual(
      expect.objectContaining({ host: redisHost, port: redisPort }),
    );
  });

  it.each([VIDEO_PROCESSING_QUEUE, VIDEO_MAINTENANCE_QUEUE])(
    'should key %s under the configured prefix',
    (name) => {
      expect(module.get<Queue>(getQueueToken(name)).opts.prefix).toBe(
        TEST_QUEUE_PREFIX,
      );
    },
  );

  it.each([VIDEO_PROCESSING_QUEUE, VIDEO_MAINTENANCE_QUEUE])(
    'should give %s bounded retries with exponential backoff and age-based retention',
    (name) => {
      const { defaultJobOptions } = module.get<Queue>(getQueueToken(name));

      expect(defaultJobOptions.attempts).toBeGreaterThan(1);
      expect(defaultJobOptions.backoff).toEqual(
        expect.objectContaining({ type: 'exponential' }),
      );
      expect(defaultJobOptions.removeOnComplete).toHaveProperty('age');
      expect(defaultJobOptions.removeOnFail).toHaveProperty('age');
    },
  );
});
