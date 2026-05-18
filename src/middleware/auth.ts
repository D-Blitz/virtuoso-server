import { Request, Response, NextFunction } from 'express';
import { verifySessionToken } from '../auth/jwt';
import { requestContext, RequestContext } from '../auth/context';

const SESSION_COOKIE_NAMES = [
  'authjs.session-token',
  '__Secure-authjs.session-token',
];

function parseCookies(cookieHeader: string): Record<string, string> {
  return Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    }),
  );
}

function extractToken(req: Request): { token: string; cookieName?: string } | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return { token: authHeader.slice(7).trim() };
  }

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = parseCookies(cookieHeader);
  for (const name of SESSION_COOKIE_NAMES) {
    if (cookies[name]) return { token: cookies[name], cookieName: name };
  }
  return null;
}

function devBypassContext(): RequestContext | null {
  if (process.env.NODE_ENV === 'production') return null;
  if (process.env.DEV_AUTH_BYPASS !== 'true') return null;

  const organizationId = process.env.DEV_DEFAULT_ORG_ID;
  if (!organizationId) return null;

  return {
    userId: 'dev-bypass-user',
    organizationId,
    role: 'OWNER',
    email: 'dev@local',
  };
}

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const extracted = extractToken(req);

  let ctx: RequestContext | null = null;

  if (extracted) {
    // A token was sent. Trust it or reject — never fall through to dev bypass,
    // otherwise a bad/forged cookie would silently elevate to the bypass role.
    const payload = await verifySessionToken(extracted.token, extracted.cookieName);
    if (payload?.sub && payload?.organizationId) {
      ctx = {
        userId: payload.sub,
        organizationId: payload.organizationId,
        role: payload.role ?? 'STAFF',
        email: payload.email ?? '',
      };
    } else {
      res.status(401).json({ error: 'Invalid session token' });
      return;
    }
  } else {
    // No token at all. Optional dev bypass for unauthenticated local testing.
    ctx = devBypassContext();
  }

  if (!ctx) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  requestContext.run(ctx, () => next());
}
