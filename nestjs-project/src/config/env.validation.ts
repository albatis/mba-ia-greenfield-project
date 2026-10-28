import * as Joi from 'joi';

// S3 multipart limits: every part except the last must be >= 5 MiB, and an
// upload may have at most 10,000 parts.
const S3_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const S3_MAX_PARTS = 10_000;

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  S3_ENDPOINT: Joi.string().uri().default('http://storage:3900'),
  S3_PUBLIC_ENDPOINT: Joi.string().uri().default('http://localhost:3900'),
  S3_REGION: Joi.string().default('garage'),
  S3_ACCESS_KEY_ID: Joi.string().required(),
  S3_SECRET_ACCESS_KEY: Joi.string().required(),
  S3_FORCE_PATH_STYLE: Joi.string().valid('true', 'false').default('true'),
  S3_VIDEOS_BUCKET: Joi.string().default('videos'),
  S3_THUMBNAILS_BUCKET: Joi.string().default('thumbnails'),
  THUMBNAILS_PUBLIC_BASE_URL: Joi.string()
    .uri()
    .default('http://thumbnails.web.garage.localhost:3902'),
  STORAGE_CORS_ALLOWED_ORIGINS: Joi.string().default('http://localhost:3001'),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  QUEUE_PREFIX: Joi.string().default('bull'),
  VIDEO_WORKER_CONCURRENCY: Joi.number().integer().min(1).default(2),
  UPLOAD_MAX_SIZE_BYTES: Joi.number().integer().positive().default(10737418240),
  UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(S3_MIN_PART_SIZE_BYTES)
    .default(67108864),
  UPLOAD_PART_URL_TTL_SECONDS: Joi.number().integer().positive().default(3600),
  VIDEO_URL_TTL_SECONDS: Joi.number().integer().positive().default(14400),
  UPLOAD_STALE_AFTER_HOURS: Joi.number().integer().positive().default(24),
  UPLOAD_CLEANUP_INTERVAL_MS: Joi.number()
    .integer()
    .positive()
    .default(3600000),
}).custom((env: Record<string, number>, helpers) => {
  const parts = Math.ceil(
    env.UPLOAD_MAX_SIZE_BYTES / env.UPLOAD_PART_SIZE_BYTES,
  );
  if (parts > S3_MAX_PARTS) {
    return helpers.message({
      custom: `UPLOAD_MAX_SIZE_BYTES / UPLOAD_PART_SIZE_BYTES must not exceed ${S3_MAX_PARTS} parts (got ${parts})`,
    });
  }
  return env;
});
