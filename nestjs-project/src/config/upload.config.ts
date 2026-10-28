import { registerAs } from '@nestjs/config';

export default registerAs('upload', () => ({
  maxSizeBytes: parseInt(
    process.env.UPLOAD_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES || '67108864', 10),
  partUrlTtlSeconds: parseInt(
    process.env.UPLOAD_PART_URL_TTL_SECONDS || '3600',
    10,
  ),
  videoUrlTtlSeconds: parseInt(
    process.env.VIDEO_URL_TTL_SECONDS || '14400',
    10,
  ),
  staleAfterHours: parseInt(process.env.UPLOAD_STALE_AFTER_HOURS || '24', 10),
  cleanupIntervalMs: parseInt(
    process.env.UPLOAD_CLEANUP_INTERVAL_MS || '3600000',
    10,
  ),
}));
