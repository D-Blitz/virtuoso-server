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
      include: { roleRef: { select: { id: true, name: true } } },
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
    };
  }
}
