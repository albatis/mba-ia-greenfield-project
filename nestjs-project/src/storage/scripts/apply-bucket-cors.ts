import 'dotenv/config';
import { PutBucketCorsCommand } from '@aws-sdk/client-s3';
import storageConfig from '../../config/storage.config';
import { createS3Client } from '../storage.client';

// Browser uploads PUT parts straight to storage and must read each part's
// ETag, so the video buckets expose it to the frontend origin.
// Usage: npm run storage:cors [-- <bucket> ...] (defaults to S3_VIDEOS_BUCKET)
export async function applyBucketCors(buckets: string[]): Promise<void> {
  const storage = storageConfig();
  const s3 = createS3Client(storage, storage.endpoint);

  for (const bucket of buckets) {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: storage.corsAllowedOrigins,
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
            },
          ],
        },
      }),
    );
    console.log(`CORS applied to bucket ${bucket}`);
  }
  s3.destroy();
}

if (require.main === module) {
  const args = process.argv.slice(2);
  applyBucketCors(
    args.length > 0 ? args : [storageConfig().videosBucket],
  ).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
