import type { NextFunction, Request, Response } from 'express';
import prisma from '../prisma';
import { requestContext } from '../auth/context';

/**
 * Phase 2.0 Commit 3 — public guard for the workflow engine.
 *
 * Resolves `WidgetFlow` by `:publishableKey` URL param, ensures the
 * flow is published + VISITOR kind, attaches it to the request, and
 * wraps the rest of the chain in an org-scoped requestContext so any
 * downstream prisma calls are tenant-scoped automatically.
 *
 * Distinct from `requireWidget` (which resolves legacy BookingWidget
 * by publishableKey) — the two coexist because they serve different
 * surfaces. requireWidget gates the existing trial-booking widget;
 * requireWidgetFlow gates the new no-code engine flows.
 *
 * Origin check: NOT enforced in this commit. WidgetFlow doesn't yet
 * have an `allowedOrigins` column — adding that is a follow-up. For
 * now, any origin can hit a published flow (matches the legacy
 * BookingWidget behavior when `allowedOrigins` is empty).
 *
 * Identity attached for downstream consumers:
 *   userId         = 'public-widget-flow'  (distinguishes from legacy widget)
 *   organizationId = flow.organizationId   (resolved from publishableKey)
 *   roleName       = 'WidgetFlow'          (audit-log label)
 *   permissions    = empty set             (no admin powers via this surface)
 */
export async function requireWidgetFlow(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const publishableKey = (req.params as Record<string, string>).publishableKey;
  if (!publishableKey) {
    res.status(400).json({ error: 'Missing publishable key' });
    return;
  }

  // No org scope yet — resolve globally by the unique publishableKey.
  const flow = await prisma.widgetFlow.findUnique({
    where: { publishableKey },
    select: {
      id: true,
      organizationId: true,
      name: true,
      kind: true,
      isPublished: true,
      publishableKey: true,
    },
  });

  if (!flow) {
    res.status(404).json({ error: 'Flow not found' });
    return;
  }
  if (!flow.isPublished) {
    res.status(404).json({ error: 'Flow not published' });
    return;
  }
  if (flow.kind !== 'VISITOR') {
    // EVENT_REACTION flows have no public surface — they fire on bus
    // events. Returning 404 (vs 403) so we don't leak existence.
    res.status(404).json({ error: 'Flow not found' });
    return;
  }

  (req as Request & { widgetFlow?: typeof flow }).widgetFlow = flow;

  requestContext.run(
    {
      userId: 'public-widget-flow',
      organizationId: flow.organizationId,
      email: '',
      roleId: null,
      roleName: 'WidgetFlow',
      permissions: new Set(),
    },
    () => next(),
  );
}
