import { Request, Response, NextFunction } from 'express';
import { getContext } from '../auth/context';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Gates mutation requests (POST/PUT/PATCH/DELETE) to a set of allowed roles.
 * Reads safely pass through to any authenticated user.
 *
 * Assumes `requireUser` has already run and populated the AsyncLocalStorage context.
 */
export function requireMutationRole(allowedRoles: string[]) {
  const allowed = new Set(allowedRoles);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const role = getContext()?.role;
    if (!role || !allowed.has(role)) {
      res.status(403).json({ error: 'Forbidden: insufficient role' });
      return;
    }
    next();
  };
}
