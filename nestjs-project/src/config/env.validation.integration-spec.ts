import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_BUCKET: 'streamtube-videos',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

const validateWithout = (key: string): ValidationOutcome => {
  const env: Record<string, string> = { ...requiredEnv };
  delete env[key];
  return envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });
};

type ValidatedEnv = Record<string, string | number>;

interface ValidationOutcome {
  value: ValidatedEnv;
  error?: { message: string };
}

const validate = (env: Record<string, string>): ValidationOutcome =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

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

describe('envValidationSchema — storage keys (SI-03.1)', () => {
  it('should accept a complete Phase 03 storage env', () => {
    const { error } = validate({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
      PRESIGNED_URL_EXPIRATION_SECONDS: '900',
      S3_CORS_ALLOW_ORIGIN: 'http://localhost:3001',
    });
    expect(error).toBeUndefined();
  });

  it.each(['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])(
    'should reject an env missing %s',
    (key) => {
      const { error } = validateWithout(key);
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply storage defaults when the optional keys are absent', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
    expect(value.PRESIGNED_URL_EXPIRATION_SECONDS).toBe(900);
  });

  it('should reject S3_FORCE_PATH_STYLE with a non-boolean value', () => {
    const { error } = validate({ S3_FORCE_PATH_STYLE: 'maybe' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_FORCE_PATH_STYLE');
  });
});
