import prisma from '../prisma';
import { verifyPassword } from '../auth/password';

export type AuthenticatedUser = {
  id: string;
  email: string;
  organizationId: string;
  role: string;
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
    });
    if (!user || !user.passwordHash) return null;

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return null;

    return {
      id: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: user.role,
    };
  }
}
