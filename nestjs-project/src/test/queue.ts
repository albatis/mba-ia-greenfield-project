import { BullModule } from '@nestjs/bullmq';
import type { DynamicModule } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';

/**
 * Key prefix for test queues: suites share the dev Redis, so a dedicated
 * prefix keeps them away from the API's `bull:*` keys.
 */
export const TEST_QUEUE_PREFIX = 'bull-test';

/** queueConfig pointed at the test prefix; e2e suites override `queueConfig.KEY` with it. */
export const buildTestQueueConfig = (): ConfigType<typeof queueConfig> => ({
  ...queueConfig(),
  prefix: TEST_QUEUE_PREFIX,
});

/** BullMQ root connection for tests — same Redis as dev, isolated by prefix. */
export function testBullRootModule(): DynamicModule {
  const { redisHost, redisPort, prefix } = buildTestQueueConfig();
  return BullModule.forRoot({
    connection: { host: redisHost, port: redisPort },
    prefix,
  });
}

/** Removes every job (including active/locked ones) and the queue's keys. */
export async function clearTestQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}
