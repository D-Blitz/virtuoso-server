import prisma from '../prisma';
import { getOrganizationId } from '../auth/context';
import { auditLog } from './audit/audit.service';
import { invoiceService } from './invoice/invoice.service';
import {
  syncAllocationsForPayment,
  allocateProRata,
  facilitatorCutCents,
  SCHOOL_BILLER,
} from './invoice/invoiceSplit.service';
import { nextInvoiceNumber } from './invoice/invoiceNumber';

/**
 * Admin-side read of the Payment table, scoped to the requesting user's org
 * via the Prisma extension. Paginated; trimmed `include` shape (only what the
 * admin table actually renders).
 *
 * Stats are computed via a separate query so the dashboard's summary cards
 * reflect the entire filter-set rather than just the current page.
 *
 * Phase 1.9 adds the WRITE side: manual multi-tender recording (cheque /
 * cash / transfer) and the cheque clearance lifecycle. A manual payment
 * can settle an Invoice (see InvoiceService) — recording one, or cashing
 * a cheque, recomputes that invoice's derived status.
 */
export type ListPaymentsFilters = {
  status?: string;     // PENDING | SUCCEEDED | FAILED | REFUNDED
  purpose?: string;    // TRIAL_LESSON | ENROLLMENT_BALANCE
  method?: string;     // STRIPE | CHECK | CASH | BANK_TRANSFER | OTHER
  chequeStatus?: string; // PENDING_DEPOSIT | DEPOSITED | CASHED
  invoiceId?: string;
  clientId?: string;
  facilitatorId?: string;
  from?: Date;
  to?: Date;
};

export type ListPaymentsArgs = ListPaymentsFilters & {
  page?: number;     // 1-indexed
  pageSize?: number; // capped to MAX_PAGE_SIZE
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Tenders an admin records by hand (everything that isn't a Stripe webhook). */
const MANUAL_METHODS = new Set(['CHECK', 'CASH', 'BANK_TRANSFER', 'OTHER']);

const CHEQUE_STATUSES = ['PENDING_DEPOSIT', 'DEPOSITED', 'CASHED'] as const;
type ChequeStatus = (typeof CHEQUE_STATUSES)[number];
const CHEQUE_ORDER: Record<ChequeStatus, number> = {
  PENDING_DEPOSIT: 0,
  DEPOSITED: 1,
  CASHED: 2,
};

/** Trimmed client shape reused across the manual-payment includes. */
const paymentClientSelect = {
  id: true,
  firstname: true,
  lastname: true,
  email: true,
} as const;

/**
 * French tender labels, used only to auto-describe the line of an invoice
 * generated FROM a payment (the payment-first flow). Lower-cased so they read
 * naturally inside "Paiement <label> du <date>".
 */
const METHOD_LABELS_FR: Record<string, string> = {
  STRIPE: 'carte',
  CHECK: 'chèque',
  CASH: 'espèces',
  BANK_TRANSFER: 'virement',
  OTHER: 'autre',
};

function formatDateFr(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function httpError(message: string, statusCode = 400): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export type RecordManualPaymentInput = {
  clientId: string;
  invoiceId?: string | null;
  amountCents: number;
  method: 'CHECK' | 'CASH' | 'BANK_TRANSFER' | 'OTHER';
  currency?: string;
  purpose?: string;
  // "En attente de règlement" — record the tender as EXPECTED (status PENDING)
  // rather than settled. For an enrollment whose client hasn't paid yet: the
  // row shows in the ledger as pending and is settled later via markManualPaid.
  // Ignored for cheques (they're inherently PENDING until cashed).
  expected?: boolean;
  receivedAt?: Date | null;
  reference?: string | null;
  payerName?: string | null;
  note?: string | null;
  relatedEnrollmentId?: string | null;
  // "Encaissé pour le compte de" — split this payment toward one or more
  // facilitators WITHOUT generating an invoice (any tender). Each entry records
  // money the org collected on a teacher's behalf and now owes them. The sum
  // must not exceed the payment amount; the untracked remainder is the org's.
  allocations?: { facilitatorId: string; amountCents: number }[];
  // Cheque-specific (ignored for the other tenders).
  chequeNumber?: string | null;
  chequeBank?: string | null;
  chequeDrawerName?: string | null;
  expectedDepositDate?: Date | null;
};

export class PaymentService {
  private requireOrg(): string {
    const organizationId = getOrganizationId();
    if (!organizationId) throw httpError('Contexte organisation manquant.', 401);
    return organizationId;
  }

  /**
   * OR branches that match a payment "touching" a facilitator: a direct
   * allocation to them ("encaissé pour le compte de"), settling an invoice
   * with a line tagged to them (teacher split), or being tied to a scheduled
   * event they run. Shared by the payments list and the cheque tracker.
   */
  private facilitatorPaymentOr(facilitatorId: string) {
    return [
      { allocations: { some: { facilitatorId } } },
      {
        relatedScheduledEvent: {
          facilitators: { some: { id: facilitatorId } },
        },
      },
      { invoice: { lines: { some: { facilitatorId } } } },
    ];
  }

  private buildWhere(filters: ListPaymentsFilters) {
    return {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.purpose ? { purpose: filters.purpose } : {}),
      ...(filters.method ? { method: filters.method } : {}),
      ...(filters.chequeStatus ? { chequeStatus: filters.chequeStatus } : {}),
      ...(filters.invoiceId ? { invoiceId: filters.invoiceId } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.facilitatorId
        ? { OR: this.facilitatorPaymentOr(filters.facilitatorId) }
        : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    };
  }

  async list(
    args: ListPaymentsArgs = {},
  ): Promise<{ items: any[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)),
    );
    const where = this.buildWhere(args);

    // Run page + count in parallel — both hit the same indexed where clause.
    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          client: {
            select: { id: true, firstname: true, lastname: true, email: true },
          },
          relatedScheduledEvent: {
            select: {
              id: true,
              startTime: true,
              endTime: true,
              status: true,
              service: { select: { id: true, name: true } },
              facilitators: {
                select: { id: true, firstname: true, lastname: true },
              },
            },
          },
          // The invoice this payment settles (when any) — lets the payments
          // table link straight to it, and lets the UI know which rows are
          // still "standalone" (eligible for generate-invoice).
          invoice: { select: { id: true, number: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.payment.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /**
   * Aggregate stats for the dashboard summary cards. Independent of paging
   * so the cards reflect every row that matches the filters, not just the
   * page currently rendered.
   */
  async stats(filters: ListPaymentsFilters = {}): Promise<{
    succeededCents: number;
    succeededCount: number;
    pendingCount: number;
    failedCount: number;
    refundedCount: number;
    currency: string;
  }> {
    const baseWhere = this.buildWhere(filters);

    const [succeededAgg, byStatus, anyForCurrency] = await Promise.all([
      prisma.payment.aggregate({
        where: { ...baseWhere, status: 'SUCCEEDED' },
        _sum: { amountCents: true },
      }),
      prisma.payment.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
      // We don't store a per-org currency — sample any matching row to pick
      // a label. Fallback to EUR if there are no rows.
      prisma.payment.findFirst({
        where: baseWhere,
        select: { currency: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const countsByStatus = new Map<string, number>();
    for (const row of byStatus) {
      countsByStatus.set(row.status, row._count._all);
    }

    return {
      succeededCents: succeededAgg._sum.amountCents ?? 0,
      succeededCount: countsByStatus.get('SUCCEEDED') ?? 0,
      pendingCount: countsByStatus.get('PENDING') ?? 0,
      failedCount: countsByStatus.get('FAILED') ?? 0,
      refundedCount: countsByStatus.get('REFUNDED') ?? 0,
      currency: anyForCurrency?.currency ?? 'EUR',
    };
  }

  /**
   * Record a payment received outside Stripe (cheque / cash / transfer).
   *
   * Income semantics (the "cheque is income only when cleared" rule):
   *   - CASH / BANK_TRANSFER / OTHER → status SUCCEEDED immediately.
   *   - CHECK → status PENDING + chequeStatus PENDING_DEPOSIT. It only
   *     becomes SUCCEEDED once `setChequeStatus(..., 'CASHED')` runs, so
   *     uncashed cheques never count as income in stats or invoice balance.
   *
   * If linked to an invoice, the invoice's derived status is recomputed.
   */
  async recordManual(input: RecordManualPaymentInput) {
    const organizationId = this.requireOrg();

    if (!MANUAL_METHODS.has(input.method)) {
      throw httpError('Mode de paiement manuel invalide.', 400);
    }
    if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
      throw httpError('Le montant doit être un nombre positif.', 400);
    }

    const client = await prisma.client.findFirst({
      where: { id: input.clientId },
      select: { id: true },
    });
    if (!client) throw httpError('Client introuvable.', 404);

    let invoiceId: string | null = null;
    if (input.invoiceId) {
      const invoice = await prisma.invoice.findFirst({
        where: { id: input.invoiceId, organizationId },
        select: { id: true, clientId: true, status: true },
      });
      if (!invoice) throw httpError('Facture introuvable.', 404);
      if (invoice.status === 'VOID') throw httpError('Cette facture est annulée.', 409);
      if (invoice.clientId !== input.clientId) {
        throw httpError(
          'Le client du paiement ne correspond pas à celui de la facture.',
          400,
        );
      }
      invoiceId = invoice.id;
    }

    const isCheque = input.method === 'CHECK';
    // Expected (en attente de règlement): a non-cheque tender we know is coming
    // but haven't collected. Recorded PENDING and not yet "received" — settle it
    // later with markManualPaid. Cheques have their own PENDING lifecycle.
    const expected = !isCheque && input.expected === true;
    const amountCents = Math.round(input.amountCents);
    // Don't claim an expected payment was received; stamp the date on settle.
    const receivedAt = expected ? input.receivedAt ?? null : input.receivedAt ?? new Date();

    // Validate direct "encaissé pour le compte de" allocations BEFORE creating
    // the payment, so a bad split (unknown facilitator / over-allocation) can
    // never leave a recorded payment behind. Only applies when there's no
    // invoice — an invoiced payment derives its split from the invoice lines.
    const directAllocations =
      !invoiceId && input.allocations?.length
        ? await this.normalizeDirectAllocations(amountCents, input.allocations)
        : [];

    const created = await prisma.payment.create({
      data: {
        organizationId,
        clientId: input.clientId,
        amountCents,
        currency: input.currency ?? 'EUR',
        status: isCheque || expected ? 'PENDING' : 'SUCCEEDED',
        purpose: input.purpose ?? 'ENROLLMENT_BALANCE',
        method: input.method,
        invoiceId,
        receivedAt,
        reference: input.reference ?? null,
        payerName: input.payerName ?? null,
        note: input.note ?? null,
        chequeNumber: isCheque ? input.chequeNumber ?? null : null,
        chequeBank: isCheque ? input.chequeBank ?? null : null,
        chequeDrawerName: isCheque ? input.chequeDrawerName ?? null : null,
        expectedDepositDate: isCheque ? input.expectedDepositDate ?? null : null,
        chequeStatus: isCheque ? 'PENDING_DEPOSIT' : null,
        relatedEnrollmentId: input.relatedEnrollmentId ?? null,
      },
      include: {
        client: { select: paymentClientSelect },
        invoice: { select: { id: true, number: true } },
      },
    });

    if (invoiceId) {
      await invoiceService.recomputeStatus(invoiceId);
      // Phase D — divide this payment across the school + teacher beneficiaries
      // of the invoice it settles. No-op when the payment isn't SUCCEEDED yet
      // (e.g. an uncashed cheque stays PENDING and allocates nothing).
      await syncAllocationsForPayment(created.id);
    } else if (directAllocations.length > 0) {
      // No invoice → persist the pre-validated direct shares straight against
      // the payment (any tender). User-entered, so they live on their own —
      // teacherBalances reads them as money the org holds for the teacher.
      await prisma.paymentAllocation.createMany({
        data: directAllocations.map((a) => ({
          organizationId,
          paymentId: created.id,
          invoiceId: null,
          beneficiaryType: 'FACILITATOR' as const,
          facilitatorId: a.facilitatorId,
          amountCents: a.amountCents,
        })),
      });
    }

    void auditLog.record({
      action: 'CREATE',
      entityType: 'Payment',
      entityId: created.id,
      after: {
        method: created.method,
        amountCents: created.amountCents,
        status: created.status,
        chequeStatus: created.chequeStatus,
        invoiceId: created.invoiceId,
      },
    });

    return created;
  }

  /**
   * Validate + normalise direct "encaissé pour le compte de" allocations for an
   * invoice-less payment. Each entry is money the org collects on a
   * facilitator's behalf (any tender) and will owe them; the untracked
   * remainder stays the org's. Merges duplicate facilitators, drops non-positive
   * entries, asserts every facilitator belongs to the org, and rejects a sum
   * that exceeds the payment. Returns the rows to persist (invoiceId stays null,
   * so a later generated invoice can supersede them — see
   * generateInvoiceFromPayment). Throws before any payment row is created.
   */
  private async normalizeDirectAllocations(
    amountCents: number,
    allocations: { facilitatorId: string; amountCents: number }[],
  ): Promise<{ facilitatorId: string; amountCents: number }[]> {
    // Merge by facilitator, keeping only well-formed positive entries.
    const byFacilitator = new Map<string, number>();
    for (const a of allocations) {
      if (!a?.facilitatorId) continue;
      const cents = Math.round(a.amountCents);
      if (!Number.isFinite(cents) || cents <= 0) continue;
      byFacilitator.set(
        a.facilitatorId,
        (byFacilitator.get(a.facilitatorId) ?? 0) + cents,
      );
    }
    if (byFacilitator.size === 0) return [];

    const facilitatorIds = [...byFacilitator.keys()];
    const found = await prisma.facilitator.findMany({
      where: { id: { in: facilitatorIds } },
      select: { id: true },
    });
    if (found.length !== facilitatorIds.length) {
      throw httpError('Intervenant introuvable pour une répartition.', 404);
    }

    const total = [...byFacilitator.values()].reduce((s, n) => s + n, 0);
    if (total > amountCents) {
      throw httpError(
        'La somme des répartitions dépasse le montant du paiement.',
        400,
      );
    }

    return facilitatorIds.map((facilitatorId) => ({
      facilitatorId,
      amountCents: byFacilitator.get(facilitatorId)!,
    }));
  }

  /**
   * Settle an EXPECTED payment (en attente de règlement → réglé): flip a
   * PENDING non-cheque tender to SUCCEEDED, stamp receivedAt, and recompute any
   * linked invoice + rebuild its allocations (PENDING payments allocate nothing,
   * so settling is what books the income). Cheques are intentionally NOT settled
   * here — they clear through the cheque tracker (setChequeStatus → CASHED),
   * which stays the single source of truth for cheque income. Stripe rows settle
   * via their webhook, never by hand.
   */
  async markManualPaid(paymentId: string) {
    const organizationId = this.requireOrg();

    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
    });
    if (!payment) throw httpError('Paiement introuvable.', 404);
    if (payment.method === 'CHECK') {
      throw httpError(
        'Un chèque se règle via le suivi des chèques (« marquer encaissé »).',
        409,
      );
    }
    if (payment.method === 'STRIPE') {
      throw httpError('Un paiement par carte ne se règle pas manuellement.', 409);
    }
    if (payment.status === 'SUCCEEDED') return payment; // idempotent no-op
    if (payment.status !== 'PENDING') {
      throw httpError(
        'Seul un paiement en attente peut être marqué comme réglé.',
        409,
      );
    }

    const updated = await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'SUCCEEDED',
        receivedAt: payment.receivedAt ?? new Date(),
      },
      include: {
        client: { select: paymentClientSelect },
        invoice: { select: { id: true, number: true } },
      },
    });

    // Now recognised income: settle the linked invoice (if any) and (re)build
    // allocations — invoice-derived for an invoiced payment, or the direct
    // "encaissé pour le compte de" rows that were stored at record time.
    if (updated.invoiceId) {
      await invoiceService.recomputeStatus(updated.invoiceId);
    }
    await syncAllocationsForPayment(updated.id);

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Payment',
      entityId: paymentId,
      before: { status: payment.status },
      after: { status: updated.status },
    });

    return updated;
  }

  /**
   * Advance a cheque through its clearance lifecycle:
   * PENDING_DEPOSIT → DEPOSITED → CASHED (forward only). Reaching CASHED
   * is the moment the cheque becomes recognised income, so the payment's
   * status flips to SUCCEEDED and any linked invoice is recomputed.
   */
  async setChequeStatus(paymentId: string, next: string) {
    const organizationId = this.requireOrg();
    if (!CHEQUE_STATUSES.includes(next as ChequeStatus)) {
      throw httpError('Statut de chèque invalide.', 400);
    }
    const nextStatus = next as ChequeStatus;

    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, organizationId, method: 'CHECK' },
    });
    if (!payment) throw httpError('Chèque introuvable.', 404);

    const current = (payment.chequeStatus ?? 'PENDING_DEPOSIT') as ChequeStatus;
    if (current === nextStatus) return payment; // idempotent no-op
    if (current === 'CASHED') {
      throw httpError('Un chèque encaissé ne peut plus changer de statut.', 409);
    }
    if (CHEQUE_ORDER[nextStatus] < CHEQUE_ORDER[current]) {
      throw httpError('Un chèque ne peut pas revenir à un statut précédent.', 409);
    }

    const reachesCashed = nextStatus === 'CASHED';
    const reachesDeposited = nextStatus === 'DEPOSITED';
    const updated = await prisma.payment.update({
      where: { id: paymentId },
      data: {
        chequeStatus: nextStatus,
        ...(reachesCashed
          ? { status: 'SUCCEEDED', receivedAt: payment.receivedAt ?? new Date() }
          : {}),
      },
      include: {
        client: { select: paymentClientSelect },
        invoice: { select: { id: true, number: true } },
      },
    });

    // CASHED → recognised income (status is now SUCCEEDED). DEPOSITED → status
    // stays PENDING, but the cheque is "en cours d'encaissement": (re)build the
    // invoice-derived allocations so balances surface the in-flight amount, and
    // recompute the invoice (recomputeStatus counts SUCCEEDED only, so a
    // deposited-not-cashed cheque won't flip it to PAID — exactly the intent).
    if ((reachesCashed || reachesDeposited) && updated.invoiceId) {
      await invoiceService.recomputeStatus(updated.invoiceId);
      await syncAllocationsForPayment(updated.id);
    }

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Payment',
      entityId: paymentId,
      before: { chequeStatus: current, status: payment.status },
      after: { chequeStatus: updated.chequeStatus, status: updated.status },
    });

    return updated;
  }

  /**
   * Cheque tracker ("Chèques à déposer / en attente"). Defaults to cheques
   * still awaiting clearance (PENDING_DEPOSIT + DEPOSITED), ordered by the
   * date they're expected to be banked. Pass a specific `chequeStatus` to
   * filter, or `includeCashed` to see the full history.
   */
  async listCheques(
    filters: {
      chequeStatus?: string;
      includeCashed?: boolean;
      clientId?: string;
      facilitatorId?: string;
      from?: Date;
      to?: Date;
    } = {},
  ) {
    const organizationId = this.requireOrg();
    const where: Record<string, unknown> = { organizationId, method: 'CHECK' };

    if (
      filters.chequeStatus &&
      CHEQUE_STATUSES.includes(filters.chequeStatus as ChequeStatus)
    ) {
      where.chequeStatus = filters.chequeStatus;
    } else if (!filters.includeCashed) {
      where.chequeStatus = { in: ['PENDING_DEPOSIT', 'DEPOSITED'] };
    }

    // Shared ledger filters (client / intervenant / période). The facilitator
    // linkage mirrors the payments list — direct allocation, settled-invoice
    // line tag, or scheduled-event assignment.
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.facilitatorId) {
      where.OR = this.facilitatorPaymentOr(filters.facilitatorId);
    }
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }

    const items = await prisma.payment.findMany({
      where,
      include: {
        client: { select: paymentClientSelect },
        invoice: { select: { id: true, number: true } },
      },
      orderBy: [{ expectedDepositDate: 'asc' }, { createdAt: 'asc' }],
    });

    const pending = items.filter((p) => p.chequeStatus !== 'CASHED');
    return {
      items,
      summary: {
        count: items.length,
        pendingCount: pending.length,
        pendingCents: pending.reduce((sum, p) => sum + p.amountCents, 0),
      },
    };
  }

  /**
   * Payment-first billing — generate one or more Invoices FROM an existing
   * standalone payment (the reverse of the usual invoice-first flow). Used
   * when money arrived before any invoice existed (a walk-in cheque, a cash
   * payment, a Stripe charge) and the org now needs proper numbered invoices.
   *
   * `billers` selects who bills the client (mirrors the invoice-first flow):
   *   - omitted / ["SCHOOL"]      → a single invoice under the org's identity
   *     (the original behaviour).
   *   - ["SCHOOL", <facId>, …]    → the gross is SPLIT into one invoice per
   *     biller, each under its own identity.
   *
   * `shares` (optional, from the payment-first UI) pins how much each biller
   * invoices, in cents, keyed by biller id ("SCHOOL" / facilitatorId). When
   * given, the invoices use those exact amounts and must sum to the tender to
   * the cent; the org absorbs the remainder when its own share is omitted.
   * Without `shares`, the split falls back to each teacher's cut rule.
   *
   * `singleInvoice` switches the split posture:
   *   - false / omitted (default) → "plusieurs factures": one client invoice
   *     per biller, each under its own identity (a facilitator must therefore
   *     have a BillingIdentity to issue in their name).
   *   - true → "une facture (sous-traitance)": a SINGLE client invoice under
   *     the org's identity for the full amount; each facilitator's share is a
   *     tagged line recording what the ORG owes them (the org "encaisse pour le
   *     compte de" the teacher). This surfaces in teacherBalances as
   *     heldBySchool/owed and needs NO facilitator BillingIdentity.
   *
   * Every generated invoice:
   *   - bills the payment's client at VAT rate 0 so the invoices sum to the
   *     money already received to the cent (a PAID invoice's amounts can't be
   *     edited later, so a rounding gap is never acceptable here);
   *   - inherits the payment's enrollment link on the line (when present), so
   *     the enrollment ↔ invoice axis is wired up for free.
   *
   * The tender is then split across the invoices — one payment row per invoice,
   * summing to the original amount (D-Q2). A SUCCEEDED payment lands each
   * invoice on PAID immediately; an uncashed cheque (PENDING) leaves them SENT
   * until it clears. Returns { invoices: [...] }.
   */
  async generateInvoiceFromPayment(
    paymentId: string,
    billers?: string[],
    shares?: Record<string, number>,
    singleInvoice?: boolean,
  ) {
    const organizationId = this.requireOrg();

    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
    });
    if (!payment) throw httpError('Paiement introuvable.', 404);
    if (payment.invoiceId) {
      throw httpError('Ce paiement est déjà rattaché à une facture.', 409);
    }
    if (payment.status === 'REFUNDED' || payment.status === 'FAILED') {
      throw httpError(
        'Impossible de générer une facture pour un paiement échoué ou remboursé.',
        409,
      );
    }

    // A real invoice now governs the split: drop any prior direct ("encaissé
    // pour le compte de") allocations so the invoice-derived ones built below
    // don't double-count. syncAllocationsForPayment only rebuilds invoiceId rows.
    await prisma.paymentAllocation.deleteMany({
      where: { paymentId: payment.id, invoiceId: null },
    });

    // Build a meaningful line description: lead with the enrollment's service
    // name when the payment is tied to one, else fall back to tender + date.
    const when = payment.receivedAt ?? payment.createdAt;
    const methodLabel =
      METHOD_LABELS_FR[payment.method] ?? payment.method.toLowerCase();
    let baseDescription = `Paiement ${methodLabel} du ${formatDateFr(when)}`;
    if (payment.relatedEnrollmentId) {
      const enrollment = await prisma.enrollment.findFirst({
        where: { id: payment.relatedEnrollmentId, organizationId },
        select: { service: { select: { name: true } } },
      });
      if (enrollment?.service?.name) {
        baseDescription = `${enrollment.service.name} — paiement du ${formatDateFr(when)}`;
      }
    }

    const billerList = [...new Set((billers ?? []).filter(Boolean))];
    const selectedFacIds = billerList.filter((b) => b !== SCHOOL_BILLER);

    // ── Single SCHOOL invoice (default / backward-compatible path). ─────────
    if (selectedFacIds.length === 0) {
      // SCHOOL issuer, next number. VAT 0 → total == gross.
      const invoiceDto = await invoiceService.create({
        clientId: payment.clientId,
        currency: payment.currency,
        vatRate: 0,
        status: 'SENT',
        issueDate: new Date(),
        lines: [
          {
            description: baseDescription,
            quantity: 1,
            unitPriceCents: payment.amountCents,
            vatRate: 0,
            enrollmentId: payment.relatedEnrollmentId ?? null,
          },
        ],
      });

      // Attach the payment. Best-effort void on failure so a failed link never
      // leaves an orphan numbered invoice behind.
      try {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { invoiceId: invoiceDto.id },
        });
      } catch (err) {
        await invoiceService.voidInvoice(invoiceDto.id).catch(() => {});
        throw err;
      }

      await invoiceService.recomputeStatus(invoiceDto.id);
      await syncAllocationsForPayment(payment.id);

      void auditLog.record({
        action: 'CREATE',
        entityType: 'Invoice',
        entityId: invoiceDto.id,
        after: {
          number: invoiceDto.number,
          generatedFromPaymentId: payment.id,
          totalCents: invoiceDto.totalCents,
        },
      });

      return { invoices: [await invoiceService.get(invoiceDto.id)] };
    }

    // ── Multi-biller split (org + teacher(s)) from this payment. ────────────
    // VAT 0 throughout so the invoices sum to the tender to the cent.
    const gross = payment.amountCents;
    // In single-invoice (sous-traitance) mode the org is always the issuer and
    // soaks up the remainder, so it's implicitly part of the split.
    const includeSchool = billerList.includes(SCHOOL_BILLER) || !!singleInvoice;

    const facs = await prisma.facilitator.findMany({
      where: { id: { in: selectedFacIds } },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        splitRuleMode: true,
        splitRuleValue: true,
        billingIdentity: { select: { id: true, invoicePrefix: true } },
      },
    });
    const facById = new Map(facs.map((f) => [f.id, f]));
    const missing: string[] = [];
    for (const id of selectedFacIds) {
      const f = facById.get(id);
      if (!f) throw httpError('Intervenant introuvable.', 404);
      if (!f.billingIdentity) missing.push(`${f.firstname} ${f.lastname}`.trim());
    }
    // Mode 1 only: a facilitator issues their OWN invoice, so they must have a
    // BillingIdentity. Mode 2 (singleInvoice) issues under the org's identity,
    // so a facilitator with no identity is fine — their share is just internal
    // debt the org owes them.
    if (!singleInvoice && missing.length > 0) {
      throw httpError(
        `Identité de facturation manquante pour : ${missing.join(', ')}.`,
        409,
      );
    }

    type Target = {
      issuerId: string | null;
      issuerPrefix: string | null;
      facilitatorId: string | null;
      name: string;
      shareCents: number;
    };
    // Explicit per-biller shares from the payment-first UI win: the admin
    // decides how much each biller invoices (in cents). Without them we fall
    // back to the teacher's cut rule (legacy / API callers).
    const hasShares =
      !!shares && Object.values(shares).some((v) => Number.isFinite(v));
    const shareOf = (key: string): number | null => {
      const v = shares?.[key];
      return Number.isFinite(v) ? Math.round(v as number) : null;
    };

    const targets: Target[] = [];
    let allocated = 0;
    for (const facId of selectedFacIds) {
      const f = facById.get(facId)!;
      let cut: number;
      if (hasShares) {
        cut = shareOf(facId) ?? 0;
        if (cut < 0) throw httpError('Part de répartition invalide.', 400);
      } else {
        // No tagged lines in the payment-first flow → MANUAL falls back to 0.
        cut = Math.min(facilitatorCutCents(f, gross, 1, 0), gross - allocated);
      }
      allocated += cut;
      targets.push({
        // Mode 2 issues under the org's identity, so a facilitator's own
        // identity may be absent here (null) — it's only used in Mode 1.
        issuerId: f.billingIdentity?.id ?? null,
        issuerPrefix: f.billingIdentity?.invoicePrefix ?? null,
        facilitatorId: f.id,
        name: `${f.firstname} ${f.lastname}`.trim(),
        shareCents: cut,
      });
    }
    if (includeSchool) {
      const school = await prisma.billingIdentity.findFirst({
        where: { ownerType: 'SCHOOL' },
        select: { id: true, invoicePrefix: true },
      });
      // The org absorbs the remainder unless the admin pinned its own share.
      const explicitSchool = hasShares ? shareOf(SCHOOL_BILLER) : null;
      const schoolShare =
        explicitSchool !== null ? explicitSchool : Math.max(0, gross - allocated);
      if (schoolShare < 0) throw httpError('Part de répartition invalide.', 400);
      allocated += schoolShare;
      targets.push({
        issuerId: school?.id ?? null,
        issuerPrefix: school?.invoicePrefix ?? null,
        facilitatorId: null,
        name: 'organisation',
        shareCents: schoolShare,
      });
    } else if (!hasShares) {
      // No org bucket to soak up rounding → force the teacher shares exact.
      const exact = allocateProRata(gross, targets.map((t) => t.shareCents));
      targets.forEach((t, i) => (t.shareCents = exact[i]));
    }

    // With explicit shares the invoices must sum to the tender to the cent — a
    // PAID invoice's amounts can't be edited later, so a gap is never allowed.
    if (hasShares) {
      const sum = targets.reduce((s, t) => s + t.shareCents, 0);
      if (sum !== gross) {
        throw httpError(
          'La répartition doit être égale au montant du paiement.',
          400,
        );
      }
    }

    // ── Mode 2: ONE client invoice under the org's identity for the full
    // amount; each facilitator's share becomes a tagged line recording what
    // the ORG owes them (sous-traitance / "encaisse pour le compte de"). The
    // client pays the org once; teacherBalances surfaces the per-teacher debt
    // as heldBySchool/owed. No facilitator BillingIdentity required. ──────────
    if (singleInvoice) {
      const school = await prisma.billingIdentity.findFirst({
        where: { organizationId, ownerType: 'SCHOOL' },
        select: { id: true, invoicePrefix: true },
      });

      // One line per non-zero target: facilitator targets stay tagged (the
      // org's debt to them); the school remainder is the org's untagged line.
      // Descriptions are generic — the facilitator tag is internal only.
      let lineTargets = targets.filter((t) => t.shareCents > 0);
      if (lineTargets.length === 0) lineTargets = targets.slice(0, 1);

      const invoiceId = await prisma.$transaction(async (tx) => {
        const number = await nextInvoiceNumber(tx, {
          organizationId,
          issuerId: school?.id ?? null,
          invoicePrefix: school?.invoicePrefix ?? null,
        });
        const inv = await tx.invoice.create({
          data: {
            organizationId,
            clientId: payment.clientId,
            issuerId: school?.id ?? null,
            billToType: 'CLIENT',
            number,
            status: 'SENT',
            currency: payment.currency,
            subtotalCents: gross,
            vatRate: 0,
            vatCents: 0,
            totalCents: gross,
            issueDate: new Date(),
            lines: {
              create: lineTargets.map((t) => ({
                description: baseDescription,
                quantity: 1,
                unitPriceCents: t.shareCents,
                amountCents: t.shareCents,
                vatRate: 0,
                vatCents: 0,
                enrollmentId: payment.relatedEnrollmentId ?? null,
                facilitatorId: t.facilitatorId,
              })),
            },
          },
          select: { id: true },
        });
        return inv.id;
      });

      // Attach the existing tender to the single invoice. Best-effort void on
      // failure so a failed link never orphans a numbered invoice.
      try {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { invoiceId },
        });
      } catch (err) {
        await invoiceService.voidInvoice(invoiceId).catch(() => {});
        throw err;
      }

      await invoiceService.recomputeStatus(invoiceId);
      await syncAllocationsForPayment(payment.id);

      void auditLog.record({
        action: 'CREATE',
        entityType: 'Invoice',
        entityId: invoiceId,
        after: {
          generatedFromPaymentId: payment.id,
          totalCents: gross,
          singleInvoiceSplit: true,
        },
      });

      return { invoices: [await invoiceService.get(invoiceId)] };
    }

    let active = targets.filter((t) => t.shareCents > 0);
    if (active.length === 0) active = targets.slice(0, 1);

    // Create the invoices (VAT 0, single line each, enrollment-tagged).
    const created = await prisma.$transaction(async (tx) => {
      const out: {
        id: string;
        number: string;
        totalCents: number;
      }[] = [];
      for (const t of active) {
        const number = await nextInvoiceNumber(tx, {
          organizationId,
          issuerId: t.issuerId,
          invoicePrefix: t.issuerPrefix,
        });
        // Plain service description only — the facilitator tag is internal
        // (payout tracking) and must stay invisible to the client.
        const description = baseDescription;
        const inv = await tx.invoice.create({
          data: {
            organizationId,
            clientId: payment.clientId,
            issuerId: t.issuerId,
            billToType: 'CLIENT',
            number,
            status: 'SENT',
            currency: payment.currency,
            subtotalCents: t.shareCents,
            vatRate: 0,
            vatCents: 0,
            totalCents: t.shareCents,
            issueDate: new Date(),
            lines: {
              create: [
                {
                  description,
                  quantity: 1,
                  unitPriceCents: t.shareCents,
                  amountCents: t.shareCents,
                  vatRate: 0,
                  vatCents: 0,
                  enrollmentId: payment.relatedEnrollmentId ?? null,
                  facilitatorId: t.facilitatorId,
                },
              ],
            },
          },
          select: { id: true, number: true, totalCents: true },
        });
        out.push(inv);
      }
      return out;
    });

    // Split the EXISTING tender across the invoices (one payment row per
    // invoice, summing to the original amount). The original payment keeps its
    // id/method/status/cheque metadata and is re-pointed at the first invoice;
    // siblings are cloned for the rest. Best-effort void on failure.
    const parts = allocateProRata(payment.amountCents, created.map((c) => c.totalCents));
    try {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { invoiceId: created[0].id, amountCents: parts[0] },
        });
        for (let i = 1; i < created.length; i++) {
          await tx.payment.create({
            data: {
              organizationId,
              clientId: payment.clientId,
              amountCents: parts[i],
              currency: payment.currency,
              status: payment.status,
              purpose: payment.purpose,
              method: payment.method,
              invoiceId: created[i].id,
              receivedAt: payment.receivedAt,
              reference: payment.reference,
              payerName: payment.payerName,
              note: payment.note,
              chequeNumber: payment.chequeNumber,
              chequeBank: payment.chequeBank,
              chequeDrawerName: payment.chequeDrawerName,
              expectedDepositDate: payment.expectedDepositDate,
              chequeStatus: payment.chequeStatus,
              relatedEnrollmentId: payment.relatedEnrollmentId,
              relatedScheduledEventId: payment.relatedScheduledEventId,
            },
          });
        }
      });
    } catch (err) {
      for (const c of created) {
        await invoiceService.voidInvoice(c.id).catch(() => {});
      }
      throw err;
    }

    // Recompute status + rebuild allocations for every invoice/payment touched.
    const linkedPayments = await prisma.payment.findMany({
      where: { organizationId, invoiceId: { in: created.map((c) => c.id) } },
      select: { id: true },
    });
    for (const c of created) {
      await invoiceService.recomputeStatus(c.id);
    }
    for (const p of linkedPayments) {
      await syncAllocationsForPayment(p.id);
    }

    for (const c of created) {
      void auditLog.record({
        action: 'CREATE',
        entityType: 'Invoice',
        entityId: c.id,
        after: {
          number: c.number,
          generatedFromPaymentId: payment.id,
          totalCents: c.totalCents,
          multiBiller: true,
        },
      });
    }

    return { invoices: await Promise.all(created.map((c) => invoiceService.get(c.id))) };
  }
}
