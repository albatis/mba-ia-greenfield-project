import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://storage:3900',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:3900',
  region: process.env.S3_REGION || 'garage',
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  videosBucket: process.env.S3_VIDEOS_BUCKET || 'videos',
  thumbnailsBucket: process.env.S3_THUMBNAILS_BUCKET || 'thumbnails',
  thumbnailsPublicBaseUrl:
    process.env.THUMBNAILS_PUBLIC_BASE_URL ||
    'http://thumbnails.web.garage.localhost:3902',
  corsAllowedOrigins: (
    process.env.STORAGE_CORS_ALLOWED_ORIGINS || 'http://localhost:3001'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
}));
