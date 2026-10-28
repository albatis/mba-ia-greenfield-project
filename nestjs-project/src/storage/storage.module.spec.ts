import type { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PRESIGN_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const testEnv = {
  S3_ENDPOINT: 'http://storage:3900',
  S3_PUBLIC_ENDPOINT: 'http://localhost:3900',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
};

describe('StorageModule', () => {
  let module: TestingModule;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, testEnv);
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    process.env = originalEnv;
    await module.close();
  });

  it('should compile and resolve StorageService', () => {
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
  });

  it('should point the internal client at S3_ENDPOINT and the presign client at S3_PUBLIC_ENDPOINT', async () => {
    const internal = module.get<S3Client>(S3_CLIENT);
    const presign = module.get<S3Client>(S3_PRESIGN_CLIENT);

    const internalEndpoint = await internal.config.endpoint!();
    const presignEndpoint = await presign.config.endpoint!();

    expect(internalEndpoint.hostname).toBe('storage');
    expect(presignEndpoint.hostname).toBe('localhost');
    expect(presignEndpoint.port).toBe(3900);
  });

  it('should sign part URLs for the public host, never the Compose host', async () => {
    const storage = module.get(StorageService);

    const url = new URL(
      await storage.presignUploadPart({
        bucket: 'videos',
        key: 'videos/abc/source',
        uploadId: 'upload-1',
        partNumber: 1,
        expiresInSeconds: 60,
      }),
    );

    expect(url.host).toBe('localhost:3900');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  });
});
