import { decode } from '@auth/core/jwt';

/**
 * Shape of the Auth.js session JWT this server consumes. The frontend
 * (`artcetera_admin/src/auth.ts`) writes these fields on every login;
 * any extra fields Auth.js adds (`iat`, `exp`, `jti`) are ignored here.
 *
 * Note: this server never *signs* a JWT — the frontend's Auth.js handlers
 * do that. We only `decode` to authenticate inbound requests.
 *
 * Phase 0.3: `role` (string) is kept for backward compat with old
 * sessions that haven't refreshed yet. New logins write `roleId` +
 * `roleName`; the middleware prefers those.
 */
export type SessionTokenPayload = {
  sub?: string;
  email?: string;
  organizationId?: string;

  // New (0.3) — the permission middleware loads Role.permissions by id
  roleId?: string;
  roleName?: string;

  // Legacy — present in tokens issued before the 0.3 migration
  role?: string;
};

const COOKIE_NAMES = [
  'authjs.session-token',
  '__Secure-authjs.session-token',
];

function getSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error('AUTH_SECRET env var is required');
  return s;
}

/**
 * Decrypts a session JWT issued by Auth.js (default JWE format).
 * Tries each known cookie name as the salt — Auth.js uses the cookie name as
 * salt when deriving the encryption key.
 */
export async function verifySessionToken(
  token: string,
  cookieName?: string,
): Promise<SessionTokenPayload | null> {
  const secret = getSecret();
  const saltsToTry = cookieName ? [cookieName] : COOKIE_NAMES;

  for (const salt of saltsToTry) {
    try {
      const payload = await decode({ token, secret, salt });
      if (payload) return payload as SessionTokenPayload;
    } catch {
      // try next salt
    }
  }
  return null;
}
