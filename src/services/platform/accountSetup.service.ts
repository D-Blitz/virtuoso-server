import prisma from '../../prisma';
import { hashPassword } from '../../auth/password';
import { hashSetupToken } from './platform.service';

/**
 * The public half of a setup link: check a token, then let its owner
 * choose a password.
 *
 * Unauthenticated by nature — the token IS the proof. It is therefore
 * treated like a credential: looked up by hash, single-use, expiring,
 * and refused the moment any of those fail.
 *
 * Runs outside a request context, so the org-scoping extension injects
 * nothing — correct here, since the whole point is that we don't yet
 * know who the caller is.
 */

const MIN_PASSWORD_LENGTH = 8;

function invalidToken(): Error & { statusCode?: number } {
  // One message for expired / consumed / unknown alike. Distinguishing
  // them tells an attacker which guesses were real accounts.
  const err = new Error(
    'Ce lien n’est plus valide. Demandez-en un nouveau à votre administrateur.',
  ) as Error & { statusCode?: number };
  err.statusCode = 400;
  return err;
}

export type SetupTokenInfo = {
  email: string;
  organizationName: string;
  /** INVITE (first credentials) or RESET (forgotten password). */
  purpose: string;
};

export class AccountSetupService {
  /**
   * Describe a token so the page can greet the right person. Does NOT
   * consume it — the visitor may open the link and finish later.
   */
  async inspect(rawToken: string): Promise<SetupTokenInfo> {
    const row = await this.findUsable(rawToken);
    return {
      email: row.user.email,
      organizationName: row.user.organization.name,
      purpose: row.purpose,
    };
  }

  /** Set the password and burn the token. */
  async complete(rawToken: string, password: string): Promise<void> {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      const err = new Error(
        `Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`,
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const row = await this.findUsable(rawToken);
    const passwordHash = await hashPassword(password);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: row.userId },
        data: {
          passwordHash,
          // Setting a password reactivates a disabled account only if an
          // admin re-invited it; disabledAt is left alone here on purpose.
        },
      });
      await tx.userSetupToken.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
      // Any other outstanding link for this user is now void — a reset
      // shouldn't leave an older invite lying around that still works.
      await tx.userSetupToken.updateMany({
        where: { userId: row.userId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
    });
  }

  private async findUsable(rawToken: string) {
    if (typeof rawToken !== 'string' || rawToken.length < 20) {
      throw invalidToken();
    }
    const row = await prisma.userSetupToken.findUnique({
      where: { tokenHash: hashSetupToken(rawToken) },
      select: {
        id: true,
        userId: true,
        purpose: true,
        expiresAt: true,
        consumedAt: true,
        user: {
          select: {
            email: true,
            disabledAt: true,
            organization: { select: { name: true } },
          },
        },
      },
    });

    if (!row) throw invalidToken();
    if (row.consumedAt) throw invalidToken();
    if (row.expiresAt.getTime() < Date.now()) throw invalidToken();
    if (row.user.disabledAt) throw invalidToken();

    return row;
  }
}
