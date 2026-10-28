import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

// Video worker process: same codebase as the API, no HTTP server (per TD-07)
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Lets BullMQ close its workers (finishing active jobs) on SIGTERM
  app.enableShutdownHooks();
}
void bootstrap();
