import prisma from '../../prisma';
import { auditLog } from '../audit/audit.service';
import { getOrganizationId } from '../../auth/context';

/**
 * Phase 0.7 — organization service.
 *
 * Backs the `/admin/parametres` admin screen. Exposes the seven
 * annual-settings tunables + the core identity fields (name, locale,
 * timezone, currency). Read is gated by ADMIN_ACCESS on the route;
 * write is gated by ORG_MANAGE.
 *
 * Only the org the caller is logged into is reachable — there's no
 * cross-org lookup helper. The route reads the orgId from the
 * request context.
 */

export type OrganizationSettingsDto = {
  id: string;
  name: string;
  slug: string;
  locale: string;
  timezone: string;
  currency: string;

  // Annual settings (Phase 0.7)
  vatRate: number;
  membershipFee: number;
  membershipFeeEnabled: boolean;
  trialFee: number;
  trialFeeCreditsTerm1: boolean;
  outstandingReminderThreshold: number;
  holidayZone: string | null;
};

export type OrganizationSettingsInput = {
  name?: string;
  locale?: string;
  timezone?: string;
  currency?: string;
  vatRate?: number;
  membershipFee?: number;
  membershipFeeEnabled?: boolean;
  trialFee?: number;
  trialFeeCreditsTerm1?: boolean;
  outstandingReminderThreshold?: number;
  // null = explicit clear; undefined = leave unchanged
  holidayZone?: string | null;
};

const HOLIDAY_ZONES = new Set(['A', 'B', 'C']);

function rowToDto(row: any): OrganizationSettingsDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    locale: row.locale,
    timezone: row.timezone,
    currency: row.currency,
    vatRate: row.vatRate,
    membershipFee: row.membershipFee,
    membershipFeeEnabled: row.membershipFeeEnabled,
    trialFee: row.trialFee,
    trialFeeCreditsTerm1: row.trialFeeCreditsTerm1,
    outstandingReminderThreshold: row.outstandingReminderThreshold,
    holidayZone: row.holidayZone,
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
   *   - Money fields: must be >= 0 (no negative TVA, no negative
   *     membership). Stripe does the cent rounding downstream; we
   *     accept Float here for UX.
   *   - holidayZone: 'A' | 'B' | 'C' | null (the three French school
   *     zones; null = not configured / school not in France).
   *   - name: must trim to non-empty.
   *
   * Writes one audit entry with before/after snapshots of all the
   * settings columns (matches how every other mutating service in
   * the org records changes).
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

    // Money fields — reject negatives. NaN guards too (JSON.parse
    // would coerce "abc" to NaN; we want a clear 400 not a write).
    function assertPositive(label: string, v: unknown): number {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || n < 0) {
        const err = new Error(
          `${label} doit être un nombre positif ou nul.`,
        ) as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
      return n;
    }
    if (input.vatRate !== undefined) {
      data.vatRate = assertPositive('Le taux de TVA', input.vatRate);
    }
    if (input.membershipFee !== undefined) {
      data.membershipFee = assertPositive(
        "Le montant de la cotisation",
        input.membershipFee,
      );
    }
    if (input.trialFee !== undefined) {
      data.trialFee = assertPositive("Le tarif de l'essai", input.trialFee);
    }
    if (input.outstandingReminderThreshold !== undefined) {
      data.outstandingReminderThreshold = assertPositive(
        'Le seuil de relance',
        input.outstandingReminderThreshold,
      );
    }
    if (input.membershipFeeEnabled !== undefined) {
      data.membershipFeeEnabled = !!input.membershipFeeEnabled;
    }
    if (input.trialFeeCreditsTerm1 !== undefined) {
      data.trialFeeCreditsTerm1 = !!input.trialFeeCreditsTerm1;
    }
    if (input.holidayZone !== undefined) {
      if (input.holidayZone === null || input.holidayZone === '') {
        data.holidayZone = null;
      } else if (HOLIDAY_ZONES.has(input.holidayZone)) {
        data.holidayZone = input.holidayZone;
      } else {
        const err = new Error(
          "La zone de vacances scolaires doit être A, B, C ou vide.",
        ) as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
    }

    const row = await prisma.organization.update({
      where: { id: organizationId },
      data,
    });

    // Audit: snapshot only the settings columns (the relation arrays
    // would balloon the entry).
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
    membershipFee: row.membershipFee,
    membershipFeeEnabled: row.membershipFeeEnabled,
    trialFee: row.trialFee,
    trialFeeCreditsTerm1: row.trialFeeCreditsTerm1,
    outstandingReminderThreshold: row.outstandingReminderThreshold,
    holidayZone: row.holidayZone,
  };
}
