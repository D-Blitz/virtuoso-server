import { Request, Response, NextFunction } from 'express';
import type { Permission } from '@prisma/client';
import { verifySessionToken } from '../auth/jwt';
import { requestContext, RequestContext } from '../auth/context';
import prisma from '../prisma';

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

/**
 * Loads the Role row for a given roleId, returning its permission set
 * and name. Returns empty + null on miss (deactivated user, deleted role).
 *
 * One indexed lookup per request — acceptable for a single-school
 * multi-tenant app. If we ever scale to thousands of requests/sec we'll
 * cache by roleId behind a short TTL.
 */
async function loadRolePermissions(
  roleId: string | null,
): Promise<{ permissions: Set<Permission>; roleName: string | null }> {
  if (!roleId) return { permissions: new Set(), roleName: null };
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    select: { name: true, permissions: true },
  });
  if (!role) return { permissions: new Set(), roleName: null };
  return { permissions: new Set(role.permissions), roleName: role.name };
}

/**
 * Dev bypass: skips JWT verification for local testing when both
 * NODE_ENV != 'production' and DEV_AUTH_BYPASS=true. The bypass grants
 * EVERY permission so unauthenticated curl-against-localhost works.
 * Set DEV_DEFAULT_ORG_ID to point the bypass at a real org row.
 */
function devBypassContext(): RequestContext | null {
  if (process.env.NODE_ENV === 'production') return null;
  if (process.env.DEV_AUTH_BYPASS !== 'true') return null;

  const organizationId = process.env.DEV_DEFAULT_ORG_ID;
  if (!organizationId) return null;

  // All permissions — keeps dev bypass at the "Propriétaire" privilege level.
  const allPerms: Permission[] = [
    'ADMIN_ACCESS', 'ORG_MANAGE', 'USER_MANAGE', 'ROLE_MANAGE',
    'CLIENT_VIEW', 'CLIENT_MANAGE', 'CLIENT_ANONYMIZE',
    'FACILITATOR_VIEW', 'FACILITATOR_MANAGE',
    'SERVICE_MANAGE', 'SERVICE_CATEGORY_MANAGE',
    'LOCATION_MANAGE', 'ROOM_MANAGE', 'TAG_MANAGE',
    'TERM_MANAGE', 'CLOSURE_MANAGE',
    'EVENT_VIEW', 'EVENT_MANAGE_ALL', 'EVENT_MANAGE_SCOPED',
    'SERIES_MANAGE', 'ENROLLMENT_MANAGE',
    'PAYMENT_VIEW', 'PAYMENT_MANAGE', 'REFUND_ISSUE',
    'ARCHIVE_ACCESS', 'TRASH_ACCESS', 'PURGE_PERMANENTLY', 'AUDIT_LOG_VIEW',
    'WIDGET_MANAGE',
  ];
  const permissions = new Set(allPerms);

  return {
    userId: 'dev-bypass-user',
    organizationId,
    email: 'dev@local',
    roleId: null,
    roleName: 'DevBypass',
    permissions,
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
      // Prefer the new roleId; fall back to looking up the role row by the
      // legacy role string isn't possible (different shapes), so a legacy
      // token simply gets empty permissions and a STAFF-derived role until
      // the user re-logs in.
      const { permissions, roleName } = await loadRolePermissions(
        payload.roleId ?? null,
      );

      ctx = {
        userId: payload.sub,
        organizationId: payload.organizationId,
        email: payload.email ?? '',
        roleId: payload.roleId ?? null,
        roleName: payload.roleName ?? roleName,
        permissions,
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
