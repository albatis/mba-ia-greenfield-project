import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import type storageConfig from '../config/storage.config';

export const createS3Client = (
  storage: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client =>
  new S3Client({
    endpoint,
    region: storage.region,
    forcePathStyle: storage.forcePathStyle,
    // The SDK default (WHEN_SUPPORTED) bakes a CRC32 of the *empty* body into
    // presigned part URLs, so the browser's real part fails with InvalidDigest.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
    },
  });
