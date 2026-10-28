import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const validate = (
  env: Record<string, string>,
): { error?: ValidationError; value: Record<string, unknown> } => {
  const result = envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );
  return {
    error: result.error,
    value: result.value as Record<string, unknown>,
  };
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and upload keys', () => {
  it.each(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])(
    'should reject the env when %s is missing',
    (key) => {
      const env: Record<string, string> = { ...requiredEnv };
      delete env[key];

      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply the storage, queue and upload defaults', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://storage:3900',
      S3_PUBLIC_ENDPOINT: 'http://localhost:3900',
      S3_REGION: 'garage',
      S3_FORCE_PATH_STYLE: 'true',
      S3_VIDEOS_BUCKET: 'videos',
      S3_THUMBNAILS_BUCKET: 'thumbnails',
      THUMBNAILS_PUBLIC_BASE_URL: 'http://thumbnails.web.garage.localhost:3902',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      UPLOAD_MAX_SIZE_BYTES: 10737418240,
      UPLOAD_PART_SIZE_BYTES: 67108864,
    });
  });

  it('should reject UPLOAD_PART_SIZE_BYTES below 5 MiB', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '1048576' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should accept UPLOAD_PART_SIZE_BYTES of exactly 5 MiB', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '5242880' });

    expect(error).toBeUndefined();
  });

  it('should reject a max size that needs more than 10,000 parts', () => {
    const { error } = validate({
      UPLOAD_MAX_SIZE_BYTES: String(10_001 * 5242880),
      UPLOAD_PART_SIZE_BYTES: '5242880',
    });

    expect(error).toBeDefined();
    expect(error!.message).toContain('10000 parts');
  });

  it('should accept a max size that needs exactly 10,000 parts', () => {
    const { error } = validate({
      UPLOAD_MAX_SIZE_BYTES: String(10_000 * 5242880),
      UPLOAD_PART_SIZE_BYTES: '5242880',
    });

    expect(error).toBeUndefined();
  });
});
