import { randomBytes } from 'crypto';

/**
 * Generates a URL-safe opaque token for single-use links (enrollment invites,
 * password resets, etc.). 32 bytes of entropy → 43-character base64url string,
 * collision-free in practice.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}
