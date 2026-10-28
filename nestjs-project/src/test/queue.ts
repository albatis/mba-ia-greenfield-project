import { BullModule } from '@nestjs/bullmq';
import type { DynamicModule } from '@nestjs/common';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';

/**
 * Key prefix for test queues: suites share the dev Redis, so a dedicated
 * prefix keeps them away from the API's `bull:*` keys.
 */
export const TEST_QUEUE_PREFIX = 'bull-test';

/** BullMQ root connection for tests — same Redis as dev, isolated by prefix. */
export function testBullRootModule(): DynamicModule {
  const { redisHost, redisPort } = queueConfig();
  return BullModule.forRoot({
    connection: { host: redisHost, port: redisPort },
    prefix: TEST_QUEUE_PREFIX,
  });
}

/** Removes every job (including active/locked ones) and the queue's keys. */
export async function clearTestQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}
