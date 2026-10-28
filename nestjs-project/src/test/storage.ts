import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule, registerAs, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { createS3Client } from '../storage/storage.client';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';

export const TEST_VIDEOS_BUCKET = 'videos-test';
export const TEST_THUMBNAILS_BUCKET = 'thumbnails-test';

/**
 * storageConfig pointed at the *-test buckets. The presign client uses the
 * internal endpoint: SigV4 signs the Host, so URLs fetched from inside the
 * container must be signed for storage:3900, not localhost:3900.
 */
export const buildTestStorageConfig = (): ConfigType<typeof storageConfig> => {
  const base = storageConfig();
  return {
    ...base,
    publicEndpoint: base.endpoint,
    videosBucket: TEST_VIDEOS_BUCKET,
    thumbnailsBucket: TEST_THUMBNAILS_BUCKET,
  };
};

export const testStorageConfig = registerAs('storage', buildTestStorageConfig);

export async function createTestStorage(): Promise<{
  module: TestingModule;
  storage: StorageService;
}> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [testStorageConfig] }),
      StorageModule,
    ],
  }).compile();

  return { module, storage: module.get(StorageService) };
}

export function createTestS3Client(): S3Client {
  const config = buildTestStorageConfig();
  return createS3Client(config, config.endpoint);
}

/** Removes every object and aborts every pending multipart upload. */
export async function clearTestBuckets(): Promise<void> {
  const s3 = createTestS3Client();
  try {
    for (const bucket of [TEST_VIDEOS_BUCKET, TEST_THUMBNAILS_BUCKET]) {
      await emptyBucket(s3, bucket);
    }
  } finally {
    s3.destroy();
  }
}

async function emptyBucket(s3: S3Client, bucket: string): Promise<void> {
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    const objects = (page.Contents ?? []).map(({ Key }) => ({ Key }));
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        }),
      );
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  const { Uploads } = await s3.send(
    new ListMultipartUploadsCommand({ Bucket: bucket }),
  );
  for (const upload of Uploads ?? []) {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.Key,
        UploadId: upload.UploadId,
      }),
    );
  }
}
