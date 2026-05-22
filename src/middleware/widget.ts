import { Request, Response, NextFunction } from 'express';
import prisma from '../prisma';
import { requestContext } from '../auth/context';

/**
 * Resolves a publishable key (from the URL path or `?key=` query) to a
 * BookingWidget, checks the request's Origin against the widget's allowlist,
 * and attaches both the widget and a request-scoped org context for any
 * downstream prisma calls.
 *
 * Public endpoint guard — does NOT require an authenticated user.
 *
 * Origin policy:
 *   - If `allowedOrigins` is empty, any origin is accepted (dev convenience).
 *   - If non-empty, the request's `Origin` header must be in the list.
 *   - Same-origin requests (no Origin header) are accepted by default; tighten
 *     this once we add real Referer / fetch-mode checks in production.
 */
export async function requireWidget(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const keyParam = (req.params as Record<string, string>).publishableKey;
  const keyQuery = typeof req.query.key === 'string' ? req.query.key : undefined;
  const publishableKey = keyParam || keyQuery;

  if (!publishableKey) {
    res.status(400).json({ error: 'Missing publishable key' });
    return;
  }

  // Lookup runs without org scope (no ALS context yet); the extension passes
  // through and resolves by the globally-unique publishableKey.
  const widget = await prisma.bookingWidget.findUnique({
    where: { publishableKey },
  });

  if (!widget) {
    res.status(404).json({ error: 'Widget not found' });
    return;
  }

  // Origin check.
  if (widget.allowedOrigins.length > 0) {
    const origin = req.headers.origin;
    if (!origin || !widget.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
  }

  // Attach the widget so the controller can access it without a second lookup.
  (req as Request & { widget?: typeof widget }).widget = widget;

  // Run the rest of the chain inside an org-scoped context so any prisma
  // queries in the controller stay scoped to the widget's tenant. Public
  // widget requests are unauthenticated — no permissions, role is the
  // sentinel 'PUBLIC' so audit logging can distinguish widget activity.
  requestContext.run(
    {
      userId: 'public-widget',
      organizationId: widget.organizationId,
      email: '',
      roleId: null,
      roleName: 'Widget',
      permissions: new Set(),
      role: 'PUBLIC',
    },
    () => next(),
  );
}
