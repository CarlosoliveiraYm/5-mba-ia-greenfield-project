import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  describe('videos endpoints (Phase 03)', () => {
    const videoPaths = [
      ['/videos/upload-ticket', 'post'],
      ['/videos/{publicId}', 'get'],
      ['/videos/{publicId}/playback', 'get'],
      ['/videos/{publicId}/download', 'get'],
    ] as const;

    const paths = () =>
      document.paths as Record<string, Record<string, Record<string, unknown>>>;

    it.each(videoPaths)('documents %s %s', (path, method) => {
      expect(paths()[path]?.[method]).toBeDefined();
    });

    it.each(videoPaths)(
      'requires the access token on %s %s',
      (path, method) => {
        const security = paths()[path][method].security as Record<
          string,
          unknown
        >[];

        expect(security.some((req) => 'access-token' in req)).toBe(true);
      },
    );

    it('documents every predictable error status of the delivery endpoints', () => {
      for (const path of [
        '/videos/{publicId}/playback',
        '/videos/{publicId}/download',
      ]) {
        const responses = paths()[path].get.responses as Record<
          string,
          unknown
        >;
        expect(Object.keys(responses).sort()).toEqual(
          expect.arrayContaining(['200', '401', '404', '409']),
        );
      }
    });

    it('exposes VideoStatus and VideoFailureReason as enum schemas', () => {
      const schemas = (document.components as Record<string, unknown>)
        .schemas as Record<string, Record<string, unknown>>;

      // Named enums, so a consumer generating types gets the literal union
      // rather than a bare `string`.
      expect(schemas.VideoStatus).toMatchObject({
        type: 'string',
        enum: ['draft', 'uploading', 'processing', 'ready', 'failed'],
      });
      expect(schemas.VideoFailureReason).toMatchObject({ type: 'string' });
      expect(schemas.VideoFailureReason.enum).toEqual(
        expect.arrayContaining([
          'NO_VIDEO_STREAM',
          'UNSUPPORTED_CONTAINER',
          'UNSUPPORTED_VIDEO_CODEC',
          'PROBE_FAILED',
          'PROCESSING_FAILED',
          'UPLOAD_ABANDONED',
        ]),
      );
    });

    it('never exposes an internal identifier through VideoResponseDto', () => {
      const schemas = (document.components as Record<string, unknown>)
        .schemas as Record<string, Record<string, unknown>>;
      const properties = Object.keys(
        schemas.VideoResponseDto.properties as Record<string, unknown>,
      );

      expect(properties).not.toEqual(
        expect.arrayContaining([
          'id',
          'channel_id',
          'upload_id',
          'storage_key',
        ]),
      );
    });

    it('contains no /uploads path — the tus endpoint is raw Express middleware', () => {
      // Deliberate and documented, not an oversight: the Swagger plugin only
      // sees Nest controllers, so the frontend reaches tus through
      // NEXT_PUBLIC_UPLOAD_URL rather than generated types.
      expect(
        Object.keys(paths()).filter((path) => path.startsWith('/uploads')),
      ).toEqual([]);
    });
  });

  describe('determinism', () => {
    it('produces a byte-identical document on a second export', async () => {
      const secondPath = join(tmpdir(), `openapi-test-2-${Date.now()}.json`);
      await exportSpec(secondPath);

      // The committed artifact is safe for a CI freshness check only if the
      // export has no run-to-run variation.
      expect(readFileSync(secondPath, 'utf-8')).toBe(
        readFileSync(outputPath, 'utf-8'),
      );
    }, 30_000);
  });
});
