import { Request, Response, NextFunction } from 'express';

import prisma from '../prisma';
import { getContext } from '../auth/context';

/**
 * Gate for the platform surface — creating and administering
 * organizations across the whole install.
 *
 * Reads `User.isPlatformAdmin` from the database on every call rather
 * than trusting anything in the session. That's the point of the column:
 * per-org Permissions are granted by tenant admins, so a permission
 * could be self-granted, and a JWT claim would be a stale snapshot of
 * something we never want stale. One indexed lookup on a surface used
 * a handful of times a week is a fine price.
 *
 * Mount AFTER `requireUser`, which establishes the request context.
 */
export async function requirePlatformAdmin(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ctx = getContext();
  if (!ctx) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { isPlatformAdmin: true, disabledAt: true },
  });

  if (!user || user.disabledAt || !user.isPlatformAdmin) {
    // Same 403 either way — don't confirm to a tenant admin that a
    // platform surface exists at this path.
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  next();
}
