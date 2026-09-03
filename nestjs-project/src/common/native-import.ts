import { createRequire } from 'node:module';

/**
 * Imports an ESM-only package from this CommonJS codebase.
 *
 * `nestjs-project` compiles to CommonJS, so a plain `await import('pg-boss')`
 * is rewritten by TypeScript into `require('pg-boss')` — resolved by whichever
 * module registry happens to be active, which under ts-jest is Jest's.
 *
 * Two strategies, in order:
 *
 * 1. A require built with `node:module`'s `createRequire`, which is the real
 *    Node resolver rather than the ambient (possibly Jest-patched) one. Node
 *    22.12+ loads ESM through `require` as long as the module has no top-level
 *    await, and the Node 25 base image is well past that.
 * 2. A dynamic `import()` compiled at runtime by `new Function`, so neither
 *    TypeScript nor ts-jest can rewrite it. This is the fallback for a package
 *    with top-level await, where strategy 1 throws `ERR_REQUIRE_ASYNC_MODULE`.
 *
 * Strategy 2 alone is not enough: inside Jest it needs
 * `--experimental-vm-modules`, and the namespace it produces is bound to the
 * test environment that first loaded it, so a second test file importing the
 * same specifier crashes in jest-runtime. Strategy 1 has no such coupling.
 *
 * Remove this whole file once the project emits `"module": "nodenext"`.
 */
export async function nativeImport<T = unknown>(specifier: string): Promise<T> {
  const nodeRequire = createRequire(__filename);

  try {
    return nodeRequire(specifier) as T;
  } catch (error) {
    if (!isAsyncModuleError(error)) {
      throw error;
    }
  }

  // Intentional: the whole point is to compile the `import()` at runtime so
  // neither TypeScript nor ts-jest can rewrite it into a `require`. The
  // specifier is a build-time constant supplied by our own modules, never user
  // input.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const dynamicImport = new Function('s', 'return import(s)') as (
    s: string,
  ) => Promise<T>;

  return dynamicImport(specifier);
}

function isAsyncModuleError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ERR_REQUIRE_ASYNC_MODULE'
  );
}
