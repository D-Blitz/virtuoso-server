import prisma from '../prisma';
import { verifyPassword } from '../auth/password';

/**
 * Identity embedded in the session JWT. `roleId` is what the auth
 * middleware uses on every subsequent request to load the user's
 * Role row + permission set (Phase 0.3). `roleName` is included
 * so the frontend can display the role badge without an extra fetch.
 */
export type AuthenticatedUser = {
  id: string;
  email: string;
  organizationId: string;
  roleId: string | null;
  roleName: string | null;
  /**
   * Whether this user's role carries ADMIN_ACCESS — the permission whose
   * stated job is to gate the /admin surface.
   *
   * Sent so the frontend middleware can decide by CAPABILITY instead of
   * by role NAME. It used to match against a hardcoded list
   * (Propriétaire / Administrateur / Intervenant), which locked out any
   * org that renamed a starter role or created a custom one — and
   * renaming those roles is explicitly supported (see seedOrgRoles).
   *
   * This is a fast-path surface filter only. Real authorization is
   * re-derived from the Role row on every API request by the auth
   * middleware, so a stale token can at worst show an empty admin shell.
   */
  hasAdminAccess: boolean;
};

export class AuthService {
  /**
   * Verifies credentials and returns the user identity to embed in a session token.
   * Returns null on any failure (bad email, bad password, no password set).
   * Runs outside org scope (User isn't a tenant-scoped model).
   */
  async login(email: string, password: string): Promise<AuthenticatedUser | null> {
    const user = await prisma.user.findFirst({
      where: { email },
      include: {
        roleRef: { select: { id: true, name: true, permissions: true } },
      },
    });
    if (!user || !user.passwordHash) return null;
    // Phase 0.3: disabled users can't log in. Returned as bad creds
    // rather than a specific "disabled" message — same response shape
    // as wrong password, doesn't leak account state to an attacker.
    if (user.disabledAt) return null;

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return null;

    return {
      id: user.id,
      email: user.email,
      organizationId: user.organizationId,
      roleId: user.roleRef?.id ?? null,
      roleName: user.roleRef?.name ?? null,
      hasAdminAccess: user.roleRef?.permissions.includes('ADMIN_ACCESS') ?? false,
    };
  }
}
