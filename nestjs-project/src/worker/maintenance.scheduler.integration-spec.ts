import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import uploadConfig from '../config/upload.config';
import {
  CLEANUP_ABANDONED_UPLOADS_JOB,
  VIDEO_MAINTENANCE_QUEUE,
} from '../queue/queue.constants';
import { clearTestQueue, testBullRootModule } from '../test/queue';
import { MaintenanceScheduler } from './maintenance.scheduler';

// Distinct from the default so the assertion proves the config is applied
const CLEANUP_INTERVAL_MS = 123_000;

describe('MaintenanceScheduler (integration - Redis)', () => {
  const compileWorker = (): Promise<TestingModule> =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [uploadConfig] }),
        testBullRootModule(),
        BullModule.registerQueue({ name: VIDEO_MAINTENANCE_QUEUE }),
      ],
      providers: [MaintenanceScheduler],
    })
      .overrideProvider(uploadConfig.KEY)
      .useValue({ ...uploadConfig(), cleanupIntervalMs: CLEANUP_INTERVAL_MS })
      .compile();

  /** A worker boot: compile + lifecycle hooks (onApplicationBootstrap) */
  async function bootWorker(): Promise<TestingModule> {
    const module = await compileWorker();
    await module.init();
    return module;
  }

  const queueOf = (module: TestingModule): Queue =>
    module.get<Queue>(getQueueToken(VIDEO_MAINTENANCE_QUEUE));

  let module: TestingModule | undefined;

  beforeEach(async () => {
    // compile() alone runs no hooks: start from an empty queue
    const fresh = await compileWorker();
    await clearTestQueue(queueOf(fresh));
    await fresh.close();
  });

  afterEach(async () => {
    if (module) {
      await clearTestQueue(queueOf(module));
      await module.close();
      module = undefined;
    }
  });

  it('should keep a single cleanup scheduler with the configured interval across restarts', async () => {
    const first = await bootWorker();
    await first.close();
    module = await bootWorker();

    const schedulers = await queueOf(module).getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: CLEANUP_ABANDONED_UPLOADS_JOB,
      name: CLEANUP_ABANDONED_UPLOADS_JOB,
      every: CLEANUP_INTERVAL_MS,
    });
  });
});
