import prisma from '../../prisma';
import { auditLog } from '../audit/audit.service';
import { getOrganizationId } from '../../auth/context';

/**
 * Phase 0.7 — organization service.
 *
 * Backs the `/admin/parametres` admin screen. Exposes the truly
 * universal org settings: identity fields (name, locale, timezone,
 * currency) + tax rate. Read is gated by ADMIN_ACCESS on the route;
 * write is gated by ORG_MANAGE.
 *
 * Only the org the caller is logged into is reachable — there's no
 * cross-org lookup helper. The route reads the orgId from the
 * request context.
 *
 * Anything billing-flavored (trial pricing, recurring fees, dunning
 * thresholds) was deliberately kept out of this surface: each one
 * belongs to a more specific concept (a Service the user creates,
 * a future subscription model, a per-service dunning policy) and
 * doesn't generalize across verticals. See BACKLOG 0.7.
 */

export type OrganizationSettingsDto = {
  id: string;
  name: string;
  slug: string;
  locale: string;
  timezone: string;
  currency: string;
  vatRate: number;
};

export type OrganizationSettingsInput = {
  name?: string;
  locale?: string;
  timezone?: string;
  currency?: string;
  vatRate?: number;
};

function rowToDto(row: any): OrganizationSettingsDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    locale: row.locale,
    timezone: row.timezone,
    currency: row.currency,
    vatRate: row.vatRate,
  };
}

export class OrganizationService {
  /** Fetch the current request's organization settings. */
  async getSettings(): Promise<OrganizationSettingsDto> {
    const organizationId = getOrganizationId();
    if (!organizationId) throw new Error('No organization context');
    const row = await prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!row) {
      const err = new Error('Organisation introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    return rowToDto(row);
  }

  /**
   * Update org settings. Partial — only fields present in `input` are
   * touched. Validation:
   *   - name: must trim to non-empty.
   *   - vatRate: must be >= 0 and finite. Stripe handles cent rounding
   *     downstream; we accept Float here for UX.
   *
   * Writes one audit entry with before/after snapshots (matches how
   * every other mutating service in the org records changes).
   */
  async updateSettings(
    input: OrganizationSettingsInput,
  ): Promise<OrganizationSettingsDto> {
    const organizationId = getOrganizationId();
    if (!organizationId) throw new Error('No organization context');

    const before = await prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!before) {
      const err = new Error('Organisation introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }

    const data: Record<string, any> = {};

    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) {
        const err = new Error("Le nom de l'organisation est requis.") as Error & {
          statusCode?: number;
        };
        err.statusCode = 400;
        throw err;
      }
      data.name = trimmed;
    }
    if (input.locale !== undefined) data.locale = input.locale.trim();
    if (input.timezone !== undefined) data.timezone = input.timezone.trim();
    if (input.currency !== undefined) data.currency = input.currency.trim();

    if (input.vatRate !== undefined) {
      const n =
        typeof input.vatRate === 'number'
          ? input.vatRate
          : Number(input.vatRate);
      if (!Number.isFinite(n) || n < 0) {
        const err = new Error(
          'Le taux de TVA doit être un nombre positif ou nul.',
        ) as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
      data.vatRate = n;
    }

    const row = await prisma.organization.update({
      where: { id: organizationId },
      data,
    });

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Organization',
      entityId: organizationId,
      before: snapshotOrg(before),
      after: snapshotOrg(row),
    });

    return rowToDto(row);
  }
}

function snapshotOrg(row: any): object {
  return {
    name: row.name,
    locale: row.locale,
    timezone: row.timezone,
    currency: row.currency,
    vatRate: row.vatRate,
  };
}
