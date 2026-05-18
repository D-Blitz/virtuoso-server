import { decode } from '@auth/core/jwt';

export type SessionTokenPayload = {
  sub?: string;
  email?: string;
  organizationId?: string;
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
