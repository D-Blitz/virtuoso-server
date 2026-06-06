import prisma from '../../prisma';
import { getOrganizationId } from '../../auth/context';
import { auditLog } from '../audit/audit.service';
import { StripeService } from '../stripe.service';

/**
 * Phase D bis — facilitator payouts ("reversements").
 *
 * A FacilitatorPayout records money the org pays OUT to a freelance
 * intervenant to settle what it collected on their behalf (the "reste dû"
 * shown on /admin/soldes-intervenants). It is deliberately decoupled from the
 * invoice/payment loop: recording a payout does NOT require a teacher→school
 * invoice. teacherBalances() simply sums payouts into `paidOutCents`, so a
 * payout immediately reduces what the org still owes.
 *
 * `method` mirrors the manual payment tenders plus STRIPE. A STRIPE payout is
 * a Stripe Connect transfer to the facilitator's connected account
 * (BillingIdentity.stripeAccountId); we record the resulting transfer id.
 * Every other method is a bookkeeping entry only (the admin actually moved the
 * money out-of-band — cash handed over, cheque written, manual virement).
 */

const stripeService = new StripeService();

export type PayoutMethod = 'CASH' | 'CHECK' | 'BANK_TRANSFER' | 'STRIPE' | 'OTHER';

const PAYOUT_METHODS = new Set<PayoutMethod>([
  'CASH',
  'CHECK',
  'BANK_TRANSFER',
  'STRIPE',
  'OTHER',
]);

export type FacilitatorPayoutDto = {
  id: string;
  facilitatorId: string;
  amountCents: number;
  currency: string;
  method: PayoutMethod;
  reference: string | null;
  note: string | null;
  paidAt: string;
  stripeTransferId: string | null;
  createdAt: string;
};

export type RecordPayoutInput = {
  amountCents: number;
  method: PayoutMethod;
  currency?: string;
  reference?: string | null;
  note?: string | null;
  paidAt?: string | null;
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

export function payoutRowToDto(row: any): FacilitatorPayoutDto {
  return {
    id: row.id,
    facilitatorId: row.facilitatorId,
    amountCents: row.amountCents,
    currency: row.currency,
    method: row.method,
    reference: row.reference ?? null,
    note: row.note ?? null,
    paidAt: row.paidAt instanceof Date ? row.paidAt.toISOString() : row.paidAt,
    stripeTransferId: row.stripeTransferId ?? null,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export class FacilitatorPayoutService {
  private requireOrg(): string {
    const organizationId = getOrganizationId();
    if (!organizationId) throw httpError('Contexte organisation manquant.', 401);
    return organizationId;
  }

  /**
   * Load the facilitator (tenant + soft-delete scoped) along with the Stripe
   * connected-account id from their billing identity, needed to decide whether
   * a STRIPE payout is possible.
   */
  private async loadFacilitator(facilitatorId: string) {
    const fac = await prisma.facilitator.findFirst({
      where: { id: facilitatorId },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        billingIdentity: { select: { stripeAccountId: true } },
      },
    });
    if (!fac) throw httpError('Intervenant introuvable.', 404);
    return fac;
  }

  /** Every payout recorded for a facilitator, most recent first. */
  async listForFacilitator(facilitatorId: string): Promise<FacilitatorPayoutDto[]> {
    const organizationId = this.requireOrg();
    await this.loadFacilitator(facilitatorId);
    const rows = await prisma.facilitatorPayout.findMany({
      where: { organizationId, facilitatorId },
      orderBy: { paidAt: 'desc' },
    });
    return rows.map(payoutRowToDto);
  }

  /**
   * Record a reversement. For STRIPE, performs the Connect transfer first and
   * only persists the row once Stripe confirms (the transfer id is stored). For
   * every other method, it is a pure bookkeeping insert.
   */
  async record(
    facilitatorId: string,
    input: RecordPayoutInput,
  ): Promise<FacilitatorPayoutDto> {
    const organizationId = this.requireOrg();
    const fac = await this.loadFacilitator(facilitatorId);

    const amountCents = Math.round(Number(input.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw httpError('Le montant du reversement doit être supérieur à zéro.');
    }
    const method = String(input.method ?? '').toUpperCase() as PayoutMethod;
    if (!PAYOUT_METHODS.has(method)) {
      throw httpError('Méthode de reversement invalide.');
    }
    const currency = (input.currency ?? 'EUR').toUpperCase();
    const reference = nstr(input.reference);
    const note = nstr(input.note);
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      throw httpError('Date de reversement invalide.');
    }

    let stripeTransferId: string | null = null;
    if (method === 'STRIPE') {
      const destination = fac.billingIdentity?.stripeAccountId ?? null;
      if (!destination) {
        throw httpError(
          "Cet intervenant n'a pas de compte Stripe connecté.",
          400,
        );
      }
      try {
        const transfer = await stripeService.createTransfer({
          amountCents,
          currency,
          destination,
          metadata: {
            organizationId,
            facilitatorId,
            kind: 'facilitator_payout',
          },
        });
        stripeTransferId = transfer.id;
      } catch (err: any) {
        throw httpError(
          `Échec du virement Stripe : ${err?.message ?? 'erreur inconnue'}`,
          502,
        );
      }
    }

    const created = await prisma.facilitatorPayout.create({
      data: {
        organizationId,
        facilitatorId,
        amountCents,
        currency,
        method,
        reference,
        note,
        paidAt,
        stripeTransferId,
      },
    });

    void auditLog.record({
      action: 'CREATE',
      entityType: 'FacilitatorPayout',
      entityId: created.id,
      after: {
        facilitatorId,
        facilitatorName: `${fac.firstname} ${fac.lastname}`.trim(),
        amountCents,
        currency,
        method,
        stripeTransferId,
      },
    });

    return payoutRowToDto(created);
  }
}

export const facilitatorPayoutService = new FacilitatorPayoutService();
