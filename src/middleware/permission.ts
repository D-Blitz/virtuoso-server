import { Request, Response, NextFunction } from 'express';
import type { Permission } from '@prisma/client';
import prisma from '../prisma';
import { getContext } from '../auth/context';

/**
 * Phase 0.3 — per-route permission middleware.
 *
 * Replaces the four `guardAdminOnly` helpers and the blanket
 * `requireMutationRole(['OWNER','ADMIN'])` global gate. Each route
 * declares the Permission it needs; the middleware reads the
 * request's permission set (populated by `requireUser`) and
 * 403s if missing.
 *
 * Usage:
 *   router.post('/clients', requirePermission('CLIENT_MANAGE'), handler);
 *   router.get('/audit-log', requirePermission('AUDIT_LOG_VIEW'), handler);
 *
 * The factory shape (function returning a middleware) lets us
 * compose easily — e.g. `[requireUser, requirePermission('X'), handler]`.
 */
export function requirePermission(perm: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = getContext();
    if (!ctx) {
      // Should never happen if requireUser is wired correctly; defensive.
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (!ctx.permissions.has(perm)) {
      res.status(403).json({
        error: 'Forbidden: missing permission',
        permission: perm,
      });
      return;
    }
    next();
  };
}

/**
 * OR — pass if the user has any one of the listed permissions. Useful
 * for endpoints that have a "view OR manage" semantics where either
 * is enough to access (e.g. a Client detail page that anyone with
 * CLIENT_VIEW or CLIENT_MANAGE can hit).
 */
export function requireAnyPermission(perms: Permission[]) {
  const set = new Set(perms);
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = getContext();
    if (!ctx) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    for (const p of set) {
      if (ctx.permissions.has(p)) {
        next();
        return;
      }
    }
    res.status(403).json({
      error: 'Forbidden: missing any of permissions',
      permissions: perms,
    });
  };
}

/**
 * AND — every permission in the list is required. Use for endpoints
 * that perform multiple gated operations atomically (e.g. anonymize
 * needs both CLIENT_ANONYMIZE and TRASH_ACCESS to operate on the row).
 */
export function requireAllPermissions(perms: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = getContext();
    if (!ctx) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    for (const p of perms) {
      if (!ctx.permissions.has(p)) {
        res.status(403).json({
          error: 'Forbidden: missing permission',
          permission: p,
        });
        return;
      }
    }
    next();
  };
}

/**
 * Resource-scoped event manage gate. Used on POST/PUT/DELETE routes
 * for ScheduledEvent. The check is:
 *   1. If user has EVENT_MANAGE_ALL  → allow.
 *   2. Else if user has EVENT_MANAGE_SCOPED, look up the event's
 *      facilitator(s); if ANY of them appears in the user's
 *      UserPermissionScope (permission=EVENT_MANAGE_SCOPED,
 *      resourceType='Facilitator'), allow.
 *   3. Else 403.
 *
 * Reads the event id from `req.params.id`. Skipped on POST since the
 * created event's facilitators are in the body — the controller
 * does its own re-check via `assertEventManageable(facilitatorIds)`
 * after parsing the body. This keeps the middleware simple and the
 * permission check close to the data that drives it.
 */
export function requireEventManage() {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const ctx = getContext();
    if (!ctx) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (ctx.permissions.has('EVENT_MANAGE_ALL')) {
      next();
      return;
    }
    if (!ctx.permissions.has('EVENT_MANAGE_SCOPED')) {
      res.status(403).json({
        error: 'Forbidden: cannot manage events',
        permission: 'EVENT_MANAGE_ALL or EVENT_MANAGE_SCOPED',
      });
      return;
    }

    // SCOPED branch: derive the event's facilitator ids and verify at
    // least one of them is in the user's permission scope rows.
    const eventId = req.params.id;
    if (!eventId) {
      // POST routes hit this branch with no id — the controller's
      // post-body check is the authoritative gate. Allow through.
      next();
      return;
    }

    const event = await prisma.scheduledEvent.findFirst({
      where: { id: eventId },
      select: { facilitators: { select: { id: true } } },
    });
    if (!event) {
      // Defer NotFound handling to the controller (consistent 404 shape).
      next();
      return;
    }

    const facilitatorIds = event.facilitators.map((f) => f.id);
    if (facilitatorIds.length === 0) {
      res.status(403).json({
        error: 'Forbidden: event has no facilitator',
        permission: 'EVENT_MANAGE_SCOPED',
      });
      return;
    }

    const matchingScope = await prisma.userPermissionScope.findFirst({
      where: {
        userId: ctx.userId,
        permission: 'EVENT_MANAGE_SCOPED',
        resourceType: 'Facilitator',
        resourceId: { in: facilitatorIds },
      },
      select: { id: true },
    });
    if (!matchingScope) {
      res.status(403).json({
        error: 'Forbidden: facilitator outside scope',
        permission: 'EVENT_MANAGE_SCOPED',
      });
      return;
    }
    next();
  };
}

/**
 * Helper for controllers that need to assert event-manage after they've
 * parsed the body (POST routes, ALL-scope series-update branches). Throws
 * a structured error that sendError() can surface as a 403.
 */
export async function assertEventManageable(
  facilitatorIds: string[],
): Promise<void> {
  const ctx = getContext();
  if (!ctx) throw new Error('No request context');
  if (ctx.permissions.has('EVENT_MANAGE_ALL')) return;
  if (!ctx.permissions.has('EVENT_MANAGE_SCOPED')) {
    const err = new Error('Forbidden: cannot manage events') as Error & {
      statusCode?: number;
    };
    err.statusCode = 403;
    throw err;
  }
  if (facilitatorIds.length === 0) {
    const err = new Error('Forbidden: event has no facilitator') as Error & {
      statusCode?: number;
    };
    err.statusCode = 403;
    throw err;
  }
  const match = await prisma.userPermissionScope.findFirst({
    where: {
      userId: ctx.userId,
      permission: 'EVENT_MANAGE_SCOPED',
      resourceType: 'Facilitator',
      resourceId: { in: facilitatorIds },
    },
    select: { id: true },
  });
  if (!match) {
    const err = new Error('Forbidden: facilitator outside scope') as Error & {
      statusCode?: number;
    };
    err.statusCode = 403;
    throw err;
  }
}
