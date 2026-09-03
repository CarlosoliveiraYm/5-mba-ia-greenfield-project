import { randomBytes } from 'node:crypto';

/**
 * The only identifier a video exposes over HTTP. 8 random bytes in base64url is
 * 11 URL-safe characters and ~64 bits of entropy — short enough for a share
 * link, wide enough that enumeration is not a threat.
 *
 * Deliberately not `nanoid`: that package is ESM-only, and Node's own crypto
 * covers this without adding another dependency behind the native-import
 * escape hatch.
 */
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}
