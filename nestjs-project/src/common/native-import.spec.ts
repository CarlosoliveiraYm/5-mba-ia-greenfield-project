import { nativeImport } from './native-import';

describe('nativeImport', () => {
  it('should resolve an ESM-only package from inside a Jest CommonJS test', async () => {
    const mod = await nativeImport<{ PgBoss: unknown }>('pg-boss');

    expect(typeof mod.PgBoss).toBe('function');
  });

  it('should resolve through the real ESM loader, not Jest module registry', async () => {
    const { PgBoss } = await nativeImport<{
      PgBoss: new (...args: any[]) => unknown;
    }>('pg-boss');

    // A constructor, not the interop wrapper object a failed resolution yields.
    expect(new PgBoss({ connectionString: 'postgres://x/y' })).toBeInstanceOf(
      PgBoss,
    );
  });

  it('should reject for a specifier that does not resolve', async () => {
    await expect(nativeImport('no-such-package-anywhere')).rejects.toThrow();
  });
});
