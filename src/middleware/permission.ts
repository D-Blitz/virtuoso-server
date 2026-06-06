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
 *
 *   1. If user has EVENT_MANAGE_ALL → allow.
 *   2. Else if user has EVENT_MANAGE_SCOPED, group their
 *      UserPermissionScope rows (for that permission) by resourceType
 *      and apply an AND-across-dimensions check:
 *        - For each dimension the user has rows in (Facilitator /
 *          Location / Room), the event's matching field must be in
 *          the user's allowlist for that dimension.
 *        - Within a dimension, multiple rows are OR (any match).
 *        - Dimensions the user has zero rows in impose no constraint.
 *      Example: scope {Fac: A,B; Room: X,Y} edits event {Fac: C, Room: X}
 *      → fails because facilitator dimension doesn't match.
 *   3. If the user has EVENT_MANAGE_SCOPED but ZERO scope rows total,
 *      they can't manage anything (the scope grant must be configured
 *      per-user explicitly). → 403.
 *   4. Else 403.
 *
 * Reads the event id from `req.params.id`. POST has no id — the
 * controller does its own re-check via `assertEventManageable({...})`
 * after parsing the body. This keeps the middleware simple and the
 * permission check close to the data that drives it.
 */

type EventDimensions = {
  facilitatorIds: string[];
  roomId: string | null;
  locationId: string | null;
};

type ScopeCheckResult =
  | { ok: true }
  | { ok: false; reason: 'no-scope-rows' | 'dimension-mismatch'; dim?: string };

/**
 * Shared scope-matching logic for the middleware AND the controller
 * helper. Pure data-in / data-out — easy to unit-test, easy to keep
 * the two enforcement points behaviorally identical.
 */
async function matchesEventScope(
  userId: string,
  event: EventDimensions,
): Promise<ScopeCheckResult> {
  const scopes = await prisma.userPermissionScope.findMany({
    where: { userId, permission: 'EVENT_MANAGE_SCOPED' },
    select: { resourceType: true, resourceId: true },
  });

  if (scopes.length === 0) {
    // No scope rows at all = nothing manageable. Explicit denial so the
    // admin gets a clear error (vs. the silent "no dimensions configured"
    // bug if we collapsed this into the loop below).
    return { ok: false, reason: 'no-scope-rows' };
  }

  // Group by resourceType.
  const byType = new Map<string, Set<string>>();
  for (const s of scopes) {
    if (!byType.has(s.resourceType)) byType.set(s.resourceType, new Set());
    byType.get(s.resourceType)!.add(s.resourceId);
  }

  // AND across non-empty dimensions.
  if (byType.has('Facilitator')) {
    const allowed = byType.get('Facilitator')!;
    if (!event.facilitatorIds.some((id) => allowed.has(id))) {
      return { ok: false, reason: 'dimension-mismatch', dim: 'Facilitator' };
    }
  }
  if (byType.has('Location')) {
    const allowed = byType.get('Location')!;
    if (!event.locationId || !allowed.has(event.locationId)) {
      return { ok: false, reason: 'dimension-mismatch', dim: 'Location' };
    }
  }
  if (byType.has('Room')) {
    const allowed = byType.get('Room')!;
    if (!event.roomId || !allowed.has(event.roomId)) {
      return { ok: false, reason: 'dimension-mismatch', dim: 'Room' };
    }
  }

  return { ok: true };
}

function scopeErrorMessage(result: ScopeCheckResult & { ok: false }): string {
  if (result.reason === 'no-scope-rows') {
    return "Forbidden: aucune ressource n'a été assignée à cet utilisateur.";
  }
  // dimension-mismatch
  const label =
    result.dim === 'Facilitator'
      ? 'intervenant'
      : result.dim === 'Location'
        ? 'établissement'
        : result.dim === 'Room'
          ? 'salle'
          : 'ressource';
  return `Forbidden: ${label} hors du périmètre de l'utilisateur.`;
}

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

    const eventId = req.params.id;
    if (!eventId) {
      // POST routes hit this branch with no id — the controller's
      // post-body check is the authoritative gate. Allow through.
      next();
      return;
    }

    const event = await prisma.scheduledEvent.findFirst({
      where: { id: eventId },
      select: {
        facilitators: { select: { id: true } },
        roomId: true,
        locationId: true,
      },
    });
    if (!event) {
      // Defer NotFound handling to the controller (consistent 404 shape).
      next();
      return;
    }

    const result = await matchesEventScope(ctx.userId, {
      facilitatorIds: event.facilitators.map((f) => f.id),
      roomId: event.roomId,
      locationId: event.locationId,
    });
    if (!result.ok) {
      res.status(403).json({
        error: scopeErrorMessage(result),
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
 *
 * Dimensions match the middleware's check: Facilitator + Location + Room.
 * Callers pass whatever is in the request body; pass null for dimensions
 * the event doesn't have.
 */
export async function assertEventManageable(args: {
  facilitatorIds: string[];
  roomId: string | null;
  locationId: string | null;
}): Promise<void> {
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

  const result = await matchesEventScope(ctx.userId, args);
  if (!result.ok) {
    const err = new Error(scopeErrorMessage(result)) as Error & {
      statusCode?: number;
    };
    err.statusCode = 403;
    throw err;
  }
}

/**
 * Resolve the facilitator allowlist that constrains which invoices the current
 * user may read. Mirrors the event-scope model but collapses to a single
 * dimension (Facilitator). Returns:
 *
 *   - `null`     → unrestricted. Granted by INVOICE_VIEW_ALL, or by the legacy
 *                  PAYMENT_VIEW grant invoices originally shipped under (so
 *                  existing roles keep full access with no re-seeding).
 *   - `string[]` → restricted to invoices that touch one of these facilitators
 *                  (a line tagged to them, or the issuer's own facilitator).
 *                  The list is the union of the user's INVOICE_VIEW_SCOPED
 *                  scope rows AND their own linked facilitator — so a
 *                  facilitator-user always sees at least their own invoices.
 *                  An empty array means "nothing" (deny-all).
 *
 * The route guards admission (requireAnyPermission); this resolves the data
 * filter the controller applies on top.
 */
export async function resolveInvoiceFacilitatorScope(): Promise<string[] | null> {
  const ctx = getContext();
  if (!ctx) {
    const err = new Error('No request context') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  if (
    ctx.permissions.has('INVOICE_VIEW_ALL') ||
    ctx.permissions.has('PAYMENT_VIEW')
  ) {
    return null; // full access
  }

  const allowed = new Set<string>();
  const scopes = await prisma.userPermissionScope.findMany({
    where: {
      userId: ctx.userId,
      permission: 'INVOICE_VIEW_SCOPED',
      resourceType: 'Facilitator',
    },
    select: { resourceId: true },
  });
  for (const s of scopes) allowed.add(s.resourceId);

  // A facilitator-linked user always sees their own invoices.
  const user = await prisma.user.findFirst({
    where: { id: ctx.userId },
    select: { facilitatorId: true },
  });
  if (user?.facilitatorId) allowed.add(user.facilitatorId);

  return [...allowed];
}
