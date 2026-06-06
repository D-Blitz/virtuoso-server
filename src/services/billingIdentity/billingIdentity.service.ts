import { Prisma } from '@prisma/client';

import prisma from '../../prisma';
import { getOrganizationId } from '../../auth/context';
import { auditLog } from '../audit/audit.service';
import {
  resolvePdfTheme,
  normalizePdfThemeForStorage,
  type InvoicePdfTheme,
} from '../invoice/invoicePdfTheme';

/**
 * Phase A — Billing identities.
 *
 * A BillingIdentity is the legal/fiscal "who issues / who bills" entity
 * printed on an invoice header: legal name, address, SIRET, TVA number,
 * bank details (IBAN/BIC), logo and legal mentions. Two flavours:
 *
 *   - SCHOOL: a per-org singleton — the school itself as an invoicing
 *     party. Edited from /admin/parametres (ORG_MANAGE).
 *   - FACILITATOR: one optional identity per teacher, for freelancers who
 *     emit their own invoices for their share of a lesson (the teacher
 *     split — Phase D). Edited from the facilitator form (FACILITATOR_MANAGE).
 *
 * Both are managed with upsert semantics (a PUT that creates-or-updates)
 * because each is a singleton in its scope: one SCHOOL row per org, one
 * identity per facilitator (enforced by the @unique facilitatorId column).
 * The SCHOOL singleton has no DB-level uniqueness (facilitatorId is null),
 * so it is enforced here by find-then-create — a settings screen never
 * races itself.
 *
 * Org scoping is explicit in every query AND enforced by the tenant-scope
 * Prisma extension (BillingIdentity is registered in TENANT_SCOPED_MODELS).
 *
 * Phase C will reference these from Invoice.issuerId (per-issuer
 * numbering); Phase E reads the theme fields when rendering the PDF.
 */

export type BillingIdentityOwnerType = 'SCHOOL' | 'FACILITATOR';

export type BillingIdentityDto = {
  id: string;
  ownerType: BillingIdentityOwnerType;
  facilitatorId: string | null;
  legalName: string;
  legalForm: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  siret: string | null;
  vatNumber: string | null;
  rcs: string | null;
  iban: string | null;
  bic: string | null;
  stripeAccountId: string | null;
  invoicePrefix: string | null;
  logoUrl: string | null;
  vatExempt: boolean;
  vatExemptMention: string | null;
  legalMentions: string | null;
  // Phase E — the per-issuer PDF theme, always returned RESOLVED (house
  // default merged in) so the editor and the renderer share one ready-to-use
  // shape. `pdfThemeCustomized` reports whether a custom blob is actually
  // stored (vs. falling back to the house default), so the UI can badge it.
  pdfTheme: InvoicePdfTheme;
  pdfThemeCustomized: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BillingIdentityInput = {
  legalName?: string;
  legalForm?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  siret?: string | null;
  vatNumber?: string | null;
  rcs?: string | null;
  iban?: string | null;
  bic?: string | null;
  stripeAccountId?: string | null;
  invoicePrefix?: string | null;
  logoUrl?: string | null;
  vatExempt?: boolean;
  vatExemptMention?: string | null;
  legalMentions?: string | null;
  // Phase E — PDF theme. A (partial) theme object is validated + normalized
  // before storage; `null` clears it back to the house default. Omitting the
  // key leaves any existing theme untouched (partial-update semantics).
  pdfTheme?: unknown;
};

function httpError(message: string, statusCode = 400): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** Trim a free-text field; empty string collapses to null. */
function nstr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// Nullable free-text columns. Omitted-from-input keys are left untouched
// (partial update) and, on create, fall back to the DB default where one
// exists (country = 'France', vatExemptMention = the art. 293 B mention).
const STRING_FIELDS = [
  'legalForm',
  'email',
  'phone',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'city',
  'country',
  'siret',
  'vatNumber',
  'rcs',
  'iban',
  'bic',
  'stripeAccountId',
  'invoicePrefix',
  'logoUrl',
  'vatExemptMention',
  'legalMentions',
] as const;

/**
 * Map an input to a Prisma `data` object. Only keys present in `input`
 * are written, so the same builder serves both create and update. The
 * caller is responsible for ensuring `legalName` ends up set on create.
 */
function buildWritableData(input: BillingIdentityInput): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (input.legalName !== undefined) {
    const v = String(input.legalName).trim();
    if (!v) throw httpError('La raison sociale (nom légal) est requise.');
    data.legalName = v;
  }
  for (const f of STRING_FIELDS) {
    if (input[f] !== undefined) data[f] = nstr(input[f]);
  }
  if (input.vatExempt !== undefined) data.vatExempt = Boolean(input.vatExempt);
  // PDF theme: present-and-null clears the column (house default); a present
  // object is validated/normalized; omitted leaves it untouched. DbNull is the
  // Prisma sentinel for "set this nullable Json column to SQL NULL".
  if ('pdfTheme' in input) {
    const normalized = normalizePdfThemeForStorage(input.pdfTheme);
    data.pdfTheme = normalized === null ? Prisma.DbNull : normalized;
  }
  return data;
}

function rowToDto(row: any): BillingIdentityDto {
  return {
    id: row.id,
    ownerType: row.ownerType,
    facilitatorId: row.facilitatorId ?? null,
    legalName: row.legalName,
    legalForm: row.legalForm ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    addressLine1: row.addressLine1 ?? null,
    addressLine2: row.addressLine2 ?? null,
    postalCode: row.postalCode ?? null,
    city: row.city ?? null,
    country: row.country ?? null,
    siret: row.siret ?? null,
    vatNumber: row.vatNumber ?? null,
    rcs: row.rcs ?? null,
    iban: row.iban ?? null,
    bic: row.bic ?? null,
    stripeAccountId: row.stripeAccountId ?? null,
    invoicePrefix: row.invoicePrefix ?? null,
    logoUrl: row.logoUrl ?? null,
    vatExempt: !!row.vatExempt,
    vatExemptMention: row.vatExemptMention ?? null,
    legalMentions: row.legalMentions ?? null,
    pdfTheme: resolvePdfTheme(row.pdfTheme ?? null),
    pdfThemeCustomized: row.pdfTheme != null,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

/** Concise before/after snapshot for the audit trail. */
function snapshot(row: any): object {
  return {
    ownerType: row.ownerType,
    legalName: row.legalName,
    siret: row.siret ?? null,
    vatNumber: row.vatNumber ?? null,
    vatExempt: !!row.vatExempt,
  };
}

export class BillingIdentityService {
  private requireOrg(): string {
    const organizationId = getOrganizationId();
    if (!organizationId) throw httpError('Contexte organisation manquant.', 401);
    return organizationId;
  }

  /** Facilitator must exist in this org (tenant + soft-delete scoped). */
  private async assertFacilitator(facilitatorId: string): Promise<void> {
    const f = await prisma.facilitator.findFirst({
      where: { id: facilitatorId },
      select: { id: true },
    });
    if (!f) throw httpError('Intervenant introuvable.', 404);
  }

  /** All identities for the org (school + every facilitator). */
  async list(): Promise<BillingIdentityDto[]> {
    const organizationId = this.requireOrg();
    const rows = await prisma.billingIdentity.findMany({
      where: { organizationId },
      orderBy: [{ ownerType: 'asc' }, { legalName: 'asc' }],
    });
    return rows.map(rowToDto);
  }

  /** The SCHOOL singleton, or null if it has never been filled in. */
  async getSchool(): Promise<BillingIdentityDto | null> {
    const organizationId = this.requireOrg();
    const row = await prisma.billingIdentity.findFirst({
      where: { organizationId, ownerType: 'SCHOOL' },
    });
    return row ? rowToDto(row) : null;
  }

  /** Create-or-update the SCHOOL singleton for the org. */
  async upsertSchool(input: BillingIdentityInput): Promise<BillingIdentityDto> {
    const organizationId = this.requireOrg();
    const existing = await prisma.billingIdentity.findFirst({
      where: { organizationId, ownerType: 'SCHOOL' },
    });
    const data = buildWritableData(input);

    if (!existing) {
      if (!data.legalName) {
        throw httpError('La raison sociale (nom légal) est requise.');
      }
      const created = await prisma.billingIdentity.create({
        data: {
          ...data,
          legalName: data.legalName as string,
          organizationId,
          ownerType: 'SCHOOL',
          facilitatorId: null,
        },
      });
      void auditLog.record({
        action: 'CREATE',
        entityType: 'BillingIdentity',
        entityId: created.id,
        after: snapshot(created),
      });
      return rowToDto(created);
    }

    const updated = await prisma.billingIdentity.update({
      where: { id: existing.id },
      data,
    });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'BillingIdentity',
      entityId: updated.id,
      before: snapshot(existing),
      after: snapshot(updated),
    });
    return rowToDto(updated);
  }

  /** A facilitator's identity, or null if none has been created yet. */
  async getForFacilitator(facilitatorId: string): Promise<BillingIdentityDto | null> {
    const organizationId = this.requireOrg();
    await this.assertFacilitator(facilitatorId);
    const row = await prisma.billingIdentity.findFirst({
      where: { organizationId, ownerType: 'FACILITATOR', facilitatorId },
    });
    return row ? rowToDto(row) : null;
  }

  /** Create-or-update a facilitator's identity. */
  async upsertForFacilitator(
    facilitatorId: string,
    input: BillingIdentityInput,
  ): Promise<BillingIdentityDto> {
    const organizationId = this.requireOrg();
    await this.assertFacilitator(facilitatorId);
    const existing = await prisma.billingIdentity.findFirst({
      where: { organizationId, ownerType: 'FACILITATOR', facilitatorId },
    });
    const data = buildWritableData(input);

    if (!existing) {
      if (!data.legalName) {
        throw httpError('La raison sociale (nom légal) est requise.');
      }
      const created = await prisma.billingIdentity.create({
        data: {
          ...data,
          legalName: data.legalName as string,
          organizationId,
          ownerType: 'FACILITATOR',
          facilitatorId,
        },
      });
      void auditLog.record({
        action: 'CREATE',
        entityType: 'BillingIdentity',
        entityId: created.id,
        after: snapshot(created),
      });
      return rowToDto(created);
    }

    const updated = await prisma.billingIdentity.update({
      where: { id: existing.id },
      data,
    });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'BillingIdentity',
      entityId: updated.id,
      before: snapshot(existing),
      after: snapshot(updated),
    });
    return rowToDto(updated);
  }
}

export const billingIdentityService = new BillingIdentityService();
