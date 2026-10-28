import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { createS3Client } from './storage.client';
import { S3_CLIENT, S3_PRESIGN_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

@Module({
  providers: [
    {
      // Server-side calls over the Compose network (storage:3900)
      provide: S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (storage: ConfigType<typeof storageConfig>) =>
        createS3Client(storage, storage.endpoint),
    },
    {
      // Signs URLs consumed by the browser — the signature embeds this host
      provide: S3_PRESIGN_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (storage: ConfigType<typeof storageConfig>) =>
        createS3Client(storage, storage.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
