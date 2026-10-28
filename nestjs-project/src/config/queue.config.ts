import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  // Redis key prefix shared by every queue producer and worker
  prefix: process.env.QUEUE_PREFIX || 'bull',
  videoWorkerConcurrency: parseInt(
    process.env.VIDEO_WORKER_CONCURRENCY || '2',
    10,
  ),
}));
