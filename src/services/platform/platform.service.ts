import { createHash } from 'crypto';

import prisma from '../../prisma';
import { generateOpaqueToken } from '../../auth/tokens';
import { seedOrgRoles } from '../role/seedOrgRoles';
import { EmailService } from '../email.service';

/**
 * Platform surface — onboarding a new tenant.
 *
 * Creating an organization and its first owner is one action on purpose:
 * an org with no roles has nobody who can log in, and an org with no
 * owner is unusable. Doing them separately just invents a broken
 * intermediate state for someone to land in.
 *
 * The owner is created WITHOUT a password and handed a single-use setup
 * link instead, so the operator never chooses — or knows — a client's
 * credentials. AuthService.login already refuses users with a null
 * passwordHash, so a pending account simply can't sign in yet; that
 * branch existed and was unused.
 */

const emailService = new EmailService();

/** Invite links are long-lived — onboarding often waits on a human. */
const INVITE_TTL_DAYS = 7;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

function badRequest(message: string): Error & { statusCode?: number } {
  const err = new Error(message) as Error & { statusCode?: number };
  err.statusCode = 400;
  return err;
}

/** Only the hash is stored; the raw token lives in the emailed link. */
export function hashSetupToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export type OrganizationSummary = {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  userCount: number;
  /** Owner accounts still waiting to set a password. */
  pendingInvites: number;
};

export type CreateOrganizationResult = {
  organization: OrganizationSummary;
  ownerEmail: string;
  /**
   * The raw setup link. Returned ONCE, at creation, and never
   * retrievable afterwards — only its hash is kept. Surfaced so the
   * operator can hand it over directly when email delivery fails, which
   * it will, and onboarding shouldn't be hostage to a mail provider.
   */
  setupUrl: string;
  emailSent: boolean;
};

export class PlatformService {
  async listOrganizations(): Promise<OrganizationSummary[]> {
    const rows = await prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        slug: true,
        name: true,
        createdAt: true,
        _count: { select: { users: true } },
        users: {
          where: { passwordHash: null, disabledAt: null },
          select: { id: true },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      createdAt: r.createdAt.toISOString(),
      userCount: r._count.users,
      pendingInvites: r.users.length,
    }));
  }

  /**
   * Create an organization, seed its roles, and invite its owner —
   * atomically. A failure part-way through would otherwise leave an org
   * nobody can enter and whose slug is taken.
   */
  async createOrganization(input: {
    slug: string;
    name: string;
    ownerEmail: string;
    /** Base URL of the admin app, for building the setup link. */
    appBaseUrl: string;
  }): Promise<CreateOrganizationResult> {
    const slug = input.slug.trim().toLowerCase();
    const name = input.name.trim();
    const ownerEmail = input.ownerEmail.trim().toLowerCase();

    if (!SLUG_RE.test(slug)) {
      throw badRequest(
        'Le slug doit faire 3 à 50 caractères, en minuscules, chiffres ou tirets, et ne pas commencer ni finir par un tiret.',
      );
    }
    if (!name) throw badRequest("Le nom de l'organisation est requis.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      throw badRequest("L'email du propriétaire n'est pas valide.");
    }

    const clash = await prisma.organization.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (clash) throw badRequest(`Le slug « ${slug} » est déjà utilisé.`);

    const rawToken = generateOpaqueToken();
    const expiresAt = new Date(
      Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const created = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { slug, name },
        select: { id: true, slug: true, name: true, createdAt: true },
      });

      // Transaction-aware so the org can't survive without its roles.
      await seedOrgRoles(org.id, tx);

      const ownerRole = await tx.role.findFirstOrThrow({
        where: { organizationId: org.id, name: 'Propriétaire' },
        select: { id: true },
      });

      const owner = await tx.user.create({
        data: {
          organizationId: org.id,
          email: ownerEmail,
          // No password: the invite link is the only way in.
          passwordHash: null,
          roleId: ownerRole.id,
        },
        select: { id: true, email: true },
      });

      await tx.userSetupToken.create({
        data: {
          userId: owner.id,
          tokenHash: hashSetupToken(rawToken),
          purpose: 'INVITE',
          expiresAt,
        },
      });

      return { org, owner };
    });

    const setupUrl = `${input.appBaseUrl.replace(/\/$/, '')}/definir-mot-de-passe?token=${rawToken}`;

    let emailSent = false;
    try {
      await emailService.sendCustomEmail({
        to: ownerEmail,
        subject: `Votre espace ${name} est prêt`,
        bodyHtml: [
          `<p>Bonjour,</p>`,
          `<p>Votre espace <strong>${escapeHtml(name)}</strong> a été créé.</p>`,
          `<p>Cliquez sur le lien ci-dessous pour choisir votre mot de passe et accéder à votre tableau de bord :</p>`,
          `<p><a href="${setupUrl}">Définir mon mot de passe</a></p>`,
          `<p>Ce lien est valable ${INVITE_TTL_DAYS} jours et ne peut être utilisé qu'une seule fois.</p>`,
        ].join('\n'),
      });
      emailSent = true;
    } catch (err) {
      // Never fail the creation on a mail problem — the org exists and
      // the operator still has the link in the response.
      console.error('[platform] owner invite email failed', err);
    }

    return {
      organization: {
        id: created.org.id,
        slug: created.org.slug,
        name: created.org.name,
        createdAt: created.org.createdAt.toISOString(),
        userCount: 1,
        pendingInvites: 1,
      },
      ownerEmail: created.owner.email,
      setupUrl,
      emailSent,
    };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
