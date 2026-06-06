import prisma from '../../prisma';
import { getOrganizationId } from '../../auth/context';
import { auditLog } from '../audit/audit.service';
import { invoiceService } from './invoice.service';
import { nextInvoiceNumber } from './invoiceNumber';
import { payoutRowToDto } from './facilitatorPayout.service';

/**
 * Phase D — teacher split.
 *
 * A lesson billed to a client can be shared with a freelance teacher who
 * emits their OWN invoice for their part. Two postures, configured per
 * teacher (Facilitator.billingMode):
 *
 *   BILLS_CLIENT  — the teacher invoices the CLIENT directly. Generating the
 *                   split MOVES the teacher's share off the school's invoice
 *                   onto a new teacher-issued invoice (billTo = CLIENT); the
 *                   client now pays both invoices.
 *   BILLS_SCHOOL  — the teacher invoices the SCHOOL. The client keeps paying
 *                   the school the full amount; a separate teacher-issued
 *                   invoice (billTo = SCHOOL) records what the school owes the
 *                   teacher. The school settles it by paying the teacher.
 *
 * How much of each line is the teacher's (Facilitator.splitRuleMode):
 *   PERCENTAGE        — splitRuleValue % of the line.
 *   FIXED_PER_SESSION — splitRuleValue cents × line quantity.
 *   MANUAL            — the whole tagged line is the teacher's share (the
 *                       admin pre-split by tagging the right lines/amounts).
 *
 * The companion concept is PaymentAllocation: when a payment settles an
 * invoice, it is divided across the school and any teachers whose lines it
 * carries (pro-rata by line TTC). That yields, per teacher, how much
 * collected money is held for them vs already paid out — see teacherBalances.
 */

function httpError(message: string, statusCode = 400): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/**
 * Integer pro-rata: split `amount` (cents) across `weights`, returning a
 * same-length array of non-negative integers that sums EXACTLY to `amount`.
 * Leftover cents from flooring go to the largest fractional parts first.
 */
export function allocateProRata(amount: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) {
    // Degenerate (all-zero weights): dump everything on the first bucket.
    return weights.map((_, i) => (i === 0 ? amount : 0));
  }
  const raw = weights.map((w) => (amount * w) / total);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = amount - floors.reduce((s, f) => s + f, 0);
  const byFrac = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (let k = 0; k < byFrac.length && remainder > 0; k++) {
    out[byFrac[k].i] += 1;
    remainder--;
  }
  return out;
}

/** Sentinel biller id for the school (the org's own SCHOOL identity). */
export const SCHOOL_BILLER = 'SCHOOL';

/**
 * A facilitator's cut of a bill's HT subtotal, clamped to [0, subtotal].
 * Pure (no DB) so both the invoice-first issuance (issueBilling.service) and
 * the payment-first split (payment.service) compute cuts identically.
 *   PERCENTAGE        — splitRuleValue % of the subtotal.
 *   FIXED_PER_SESSION — splitRuleValue cents × total quantity.
 *   MANUAL            — `taggedCents` (what the admin pre-allocated to them).
 */
export function facilitatorCutCents(
  rule: { splitRuleMode: string; splitRuleValue: number },
  subtotalCents: number,
  totalQuantity: number,
  taggedCents: number,
): number {
  let raw: number;
  switch (rule.splitRuleMode) {
    case 'PERCENTAGE': {
      const pct = Number.isFinite(rule.splitRuleValue) ? rule.splitRuleValue : 0;
      raw = Math.round((subtotalCents * pct) / 100);
      break;
    }
    case 'FIXED_PER_SESSION': {
      const per = Number.isFinite(rule.splitRuleValue) ? rule.splitRuleValue : 0;
      raw = per * totalQuantity;
      break;
    }
    case 'MANUAL':
    default:
      raw = taggedCents;
      break;
  }
  return Math.max(0, Math.min(subtotalCents, raw));
}

/** The teacher's cut of one source line, clamped to [0, line amount]. */
function teacherShareForLine(
  line: { amountCents: number; quantity: number },
  fac: { splitRuleMode: string; splitRuleValue: number },
): number {
  const amount = line.amountCents;
  switch (fac.splitRuleMode) {
    case 'PERCENTAGE': {
      const pct = Number.isFinite(fac.splitRuleValue) ? fac.splitRuleValue : 0;
      return Math.max(0, Math.min(amount, Math.round((amount * pct) / 100)));
    }
    case 'FIXED_PER_SESSION': {
      const per = Number.isFinite(fac.splitRuleValue) ? fac.splitRuleValue : 0;
      return Math.max(0, Math.min(amount, per * line.quantity));
    }
    case 'MANUAL':
    default:
      return amount;
  }
}

const SPLIT_MODES = new Set(['BILLS_CLIENT', 'BILLS_SCHOOL']);

// ── Loaded-source shapes (subset of the Prisma include below) ─────────────
type LoadedIdentity = {
  id: string;
  legalName: string;
  ownerType: string;
  invoicePrefix: string | null;
  vatExempt: boolean;
};
type LoadedFacilitator = {
  id: string;
  firstname: string;
  lastname: string;
  billingMode: string;
  splitRuleMode: string;
  splitRuleValue: number;
  billingIdentity: LoadedIdentity | null;
};
type LoadedLine = {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  vatRate: number | null;
  vatCents: number;
  facilitatorId: string | null;
  facilitator: LoadedFacilitator | null;
};
type LoadedInvoice = {
  id: string;
  number: string;
  organizationId: string;
  clientId: string;
  currency: string;
  status: string;
  vatRate: number;
  issueDate: Date | null;
  dueDate: Date | null;
  parentInvoiceId: string | null;
  lines: LoadedLine[];
  childInvoices: { id: string }[];
};

// ── Plan shapes (also the preview DTO) ────────────────────────────────────
export type SplitPlanLine = {
  sourceLineId: string;
  description: string;
  shareCents: number;
  vatRate: number | null; // child-line override (null = inherit child default)
  vatCents: number;
};
export type SplitPlanGroup = {
  facilitatorId: string;
  facilitatorName: string;
  billingMode: 'BILLS_CLIENT' | 'BILLS_SCHOOL';
  issuerId: string;
  issuerName: string;
  issuerPrefix: string | null;
  defaultVatRate: number;
  lines: SplitPlanLine[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
};
export type SplitPlan = {
  groups: SplitPlanGroup[];
  /** Facilitators that have a split posture but no BillingIdentity to issue. */
  missingIdentity: string[];
  /** BILLS_CLIENT only: source line id → remaining (school) amount; 0 = drop. */
  sourceReductions: Map<string, number>;
  schoolRemainderCents: number;
};

const SOURCE_INCLUDE = {
  lines: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      facilitator: {
        select: {
          id: true,
          firstname: true,
          lastname: true,
          billingMode: true,
          splitRuleMode: true,
          splitRuleValue: true,
          billingIdentity: {
            select: {
              id: true,
              legalName: true,
              ownerType: true,
              invoicePrefix: true,
              vatExempt: true,
            },
          },
        },
      },
    },
  },
  childInvoices: { select: { id: true } },
} as const;

export class InvoiceSplitService {
  private requireOrg(): string {
    const organizationId = getOrganizationId();
    if (!organizationId) throw httpError('Contexte organisation manquant.', 401);
    return organizationId;
  }

  /** Build the split plan for a source invoice (pure-ish; no writes). */
  private buildPlan(invoice: LoadedInvoice): SplitPlan {
    const groupsByFac = new Map<
      string,
      {
        fac: LoadedFacilitator;
        billingMode: 'BILLS_CLIENT' | 'BILLS_SCHOOL';
        lines: SplitPlanLine[];
      }
    >();
    const sourceReductions = new Map<string, number>();
    const missingIdentity = new Set<string>();

    for (const line of invoice.lines) {
      const fac = line.facilitator;
      if (!fac || !line.facilitatorId) continue;
      if (!SPLIT_MODES.has(fac.billingMode)) continue;

      const facName = `${fac.firstname} ${fac.lastname}`.trim();
      if (!fac.billingIdentity) {
        missingIdentity.add(facName);
        continue;
      }

      const shareCents = teacherShareForLine(line, fac);
      if (shareCents <= 0) continue;

      const billingMode = fac.billingMode as 'BILLS_CLIENT' | 'BILLS_SCHOOL';
      const vatExempt = fac.billingIdentity.vatExempt;
      const childDefault = vatExempt ? 0 : invoice.vatRate;
      const childOverride = vatExempt ? 0 : line.vatRate;
      const effectiveRate = childOverride ?? childDefault;
      const vatCents = Math.round((shareCents * effectiveRate) / 100);

      let group = groupsByFac.get(fac.id);
      if (!group) {
        group = { fac, billingMode, lines: [] };
        groupsByFac.set(fac.id, group);
      }
      group.lines.push({
        sourceLineId: line.id,
        description: line.description,
        shareCents,
        vatRate: childOverride,
        vatCents,
      });

      // BILLS_CLIENT moves the teacher's slice off the school invoice.
      if (billingMode === 'BILLS_CLIENT') {
        sourceReductions.set(line.id, line.amountCents - shareCents);
      }
    }

    const groups: SplitPlanGroup[] = [];
    for (const g of groupsByFac.values()) {
      const identity = g.fac.billingIdentity as LoadedIdentity;
      const subtotalCents = g.lines.reduce((s, l) => s + l.shareCents, 0);
      const vatCents = g.lines.reduce((s, l) => s + l.vatCents, 0);
      groups.push({
        facilitatorId: g.fac.id,
        facilitatorName: `${g.fac.firstname} ${g.fac.lastname}`.trim(),
        billingMode: g.billingMode,
        issuerId: identity.id,
        issuerName: identity.legalName,
        issuerPrefix: identity.invoicePrefix,
        defaultVatRate: identity.vatExempt ? 0 : invoice.vatRate,
        lines: g.lines,
        subtotalCents,
        vatCents,
        totalCents: subtotalCents + vatCents,
      });
    }
    groups.sort((a, b) => a.facilitatorName.localeCompare(b.facilitatorName));

    // What the school keeps after BILLS_CLIENT slices are moved out.
    let schoolRemainderCents = 0;
    for (const line of invoice.lines) {
      const reduced = sourceReductions.get(line.id);
      schoolRemainderCents += reduced !== undefined ? Math.max(0, reduced) : line.amountCents;
    }

    return {
      groups,
      missingIdentity: [...missingIdentity],
      sourceReductions,
      schoolRemainderCents,
    };
  }

  private async load(invoiceId: string, organizationId: string): Promise<LoadedInvoice> {
    const invoice = (await prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
      include: SOURCE_INCLUDE,
    })) as LoadedInvoice | null;
    if (!invoice) throw httpError('Facture introuvable.', 404);
    return invoice;
  }

  /** Read-only: what generateSplit WOULD produce. Drives the confirm UI. */
  async preview(invoiceId: string) {
    const organizationId = this.requireOrg();
    const invoice = await this.load(invoiceId, organizationId);
    const plan = this.buildPlan(invoice);
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      alreadySplit: invoice.childInvoices.length > 0,
      isChild: invoice.parentInvoiceId != null,
      schoolRemainderCents: plan.schoolRemainderCents,
      missingIdentity: plan.missingIdentity,
      groups: plan.groups.map((g) => ({
        facilitatorId: g.facilitatorId,
        facilitatorName: g.facilitatorName,
        billingMode: g.billingMode,
        issuerName: g.issuerName,
        subtotalCents: g.subtotalCents,
        vatCents: g.vatCents,
        totalCents: g.totalCents,
        lineCount: g.lines.length,
      })),
    };
  }

  /**
   * Generate the teacher split invoices for a source invoice. Allowed only
   * pre-settlement (no SUCCEEDED payments) and only on a non-split, non-child
   * invoice. Returns the refreshed source invoice (with childInvoices).
   */
  async generateSplit(invoiceId: string) {
    const organizationId = this.requireOrg();
    const invoice = await this.load(invoiceId, organizationId);

    if (invoice.status === 'VOID') {
      throw httpError('Une facture annulée ne peut pas être répartie.', 409);
    }
    if (invoice.parentInvoiceId) {
      throw httpError('Une facture issue d’une répartition ne peut pas être répartie à nouveau.', 409);
    }
    if (invoice.childInvoices.length > 0) {
      throw httpError('Cette facture a déjà été répartie.', 409);
    }
    const settled = await prisma.payment.aggregate({
      where: { organizationId, invoiceId, status: 'SUCCEEDED' },
      _sum: { amountCents: true },
    });
    if ((settled._sum.amountCents ?? 0) > 0) {
      throw httpError(
        'Impossible de répartir une facture déjà (partiellement) réglée.',
        409,
      );
    }

    const plan = this.buildPlan(invoice);
    if (plan.missingIdentity.length > 0) {
      throw httpError(
        `Identité de facturation manquante pour : ${plan.missingIdentity.join(', ')}. ` +
          'Créez leur identité de facturation avant de répartir.',
        409,
      );
    }
    if (plan.groups.length === 0) {
      throw httpError(
        'Aucune part intervenant à répartir (aucune ligne attribuée à un intervenant facturant).',
        400,
      );
    }

    const childStatus = invoice.status === 'DRAFT' ? 'DRAFT' : 'SENT';
    const childIssueDate =
      childStatus === 'SENT' ? invoice.issueDate ?? new Date() : null;

    const result = await prisma.$transaction(async (tx) => {
      const createdChildren: { id: string; number: string }[] = [];

      for (const group of plan.groups) {
        const number = await nextInvoiceNumber(tx, {
          organizationId,
          issuerId: group.issuerId,
          invoicePrefix: group.issuerPrefix,
        });
        const billToType = group.billingMode === 'BILLS_CLIENT' ? 'CLIENT' : 'SCHOOL';
        const child = await tx.invoice.create({
          data: {
            organizationId,
            clientId: invoice.clientId,
            issuerId: group.issuerId,
            parentInvoiceId: invoice.id,
            billToType,
            number,
            status: childStatus,
            currency: invoice.currency,
            subtotalCents: group.subtotalCents,
            vatRate: group.defaultVatRate,
            vatCents: group.vatCents,
            totalCents: group.totalCents,
            issueDate: childIssueDate,
            dueDate: invoice.dueDate,
            notes: `Part intervenant — issue de la facture ${invoice.number}`,
            lines: {
              create: group.lines.map((l) => ({
                description: l.description,
                quantity: 1,
                unitPriceCents: l.shareCents,
                amountCents: l.shareCents,
                vatRate: l.vatRate,
                vatCents: l.vatCents,
                facilitatorId: group.facilitatorId,
              })),
            },
          },
          select: { id: true, number: true },
        });
        createdChildren.push(child);
      }

      // BILLS_CLIENT: shrink (or drop) the moved lines on the source invoice.
      if (plan.sourceReductions.size > 0) {
        for (const line of invoice.lines) {
          const remaining = plan.sourceReductions.get(line.id);
          if (remaining === undefined) continue;
          if (remaining <= 0) {
            await tx.invoiceLine.delete({ where: { id: line.id } });
          } else {
            const rate = line.vatRate ?? invoice.vatRate;
            await tx.invoiceLine.update({
              where: { id: line.id },
              data: {
                quantity: 1,
                unitPriceCents: remaining,
                amountCents: remaining,
                vatCents: Math.round((remaining * rate) / 100),
                facilitatorId: null,
              },
            });
          }
        }

        // Recompute source totals from the post-reduction line set.
        let subtotal = 0;
        let vat = 0;
        for (const line of invoice.lines) {
          const remaining = plan.sourceReductions.get(line.id);
          if (remaining !== undefined) {
            if (remaining <= 0) continue;
            const rate = line.vatRate ?? invoice.vatRate;
            subtotal += remaining;
            vat += Math.round((remaining * rate) / 100);
          } else {
            subtotal += line.amountCents;
            vat += line.vatCents;
          }
        }
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { subtotalCents: subtotal, vatCents: vat, totalCents: subtotal + vat },
        });
      }

      return createdChildren;
    });

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Invoice',
      entityId: invoice.id,
      before: { status: invoice.status },
      after: {
        split: true,
        children: result.map((c) => c.number),
      },
    });

    // Totals may have shrunk (BILLS_CLIENT) → derived status can shift.
    await invoiceService.recomputeStatus(invoice.id);
    return invoiceService.get(invoice.id);
  }

  /**
   * Per-teacher money summary across the org's allocations:
   *   - heldBySchoolCents  collected from clients on the SCHOOL's invoices
   *                        that is owed to the teacher (BILLS_SCHOOL accrual)
   *   - paidOutCents       settled on teacher→school invoices (school paid out)
   *   - owedCents          held − paid
   *   - directIncomeCents  the teacher's direct income from client-billed
   *                        invoices they issued themselves (BILLS_CLIENT)
   */
  async teacherBalances() {
    const organizationId = this.requireOrg();
    const allocs = await prisma.paymentAllocation.findMany({
      where: { organizationId, beneficiaryType: 'FACILITATOR' },
      select: {
        facilitatorId: true,
        amountCents: true,
        facilitator: { select: { id: true, firstname: true, lastname: true } },
        invoice: {
          select: { billToType: true, issuer: { select: { ownerType: true } } },
        },
        // Settlement state of the underlying payment. A deposited-but-not-cashed
        // cheque is "en cours d'encaissement" (money in flight, not yet owed);
        // only a SUCCEEDED payment is recognised income.
        payment: { select: { status: true, method: true, chequeStatus: true } },
      },
    });

    const map = new Map<
      string,
      {
        facilitatorId: string;
        firstname: string;
        lastname: string;
        heldBySchoolCents: number;
        paidOutCents: number;
        directIncomeCents: number;
        pendingClearanceCents: number;
      }
    >();

    for (const a of allocs) {
      if (!a.facilitatorId || !a.facilitator) continue;
      let e = map.get(a.facilitatorId);
      if (!e) {
        e = {
          facilitatorId: a.facilitatorId,
          firstname: a.facilitator.firstname,
          lastname: a.facilitator.lastname,
          heldBySchoolCents: 0,
          paidOutCents: 0,
          directIncomeCents: 0,
          pendingClearanceCents: 0,
        };
        map.set(a.facilitatorId, e);
      }

      // Money in flight: a cheque that's been deposited but hasn't cleared yet.
      // Surface it as "en cours d'encaissement" without counting it as owed.
      const isDepositedCheque =
        a.payment?.method === 'CHECK' && a.payment?.chequeStatus === 'DEPOSITED';
      if (isDepositedCheque) {
        e.pendingClearanceCents += a.amountCents;
        continue;
      }
      // Not yet recognised income (uncashed cheque, failed, refunded): ignore.
      if (a.payment?.status !== 'SUCCEEDED') continue;

      const billTo = a.invoice?.billToType;
      const issuerType = a.invoice?.issuer?.ownerType;
      if (billTo === 'SCHOOL') {
        e.paidOutCents += a.amountCents; // school settling the teacher
      } else if (issuerType === 'SCHOOL' || !a.invoice) {
        // Collected for the teacher, not yet paid. An invoice-less allocation
        // ("encaissé pour le compte de") is always money the org now holds.
        e.heldBySchoolCents += a.amountCents;
      } else {
        e.directIncomeCents += a.amountCents; // teacher billed the client directly
      }
    }

    // Reversements (manual payouts) recorded against each facilitator settle
    // part of what's owed. Fold each facilitator's payout total into
    // paidOutCents so owed = held − (invoice settlements + payouts).
    const payoutSums = await prisma.facilitatorPayout.groupBy({
      by: ['facilitatorId'],
      where: { organizationId },
      _sum: { amountCents: true },
    });
    for (const p of payoutSums) {
      let e = map.get(p.facilitatorId);
      if (!e) {
        // A facilitator may have payouts but no allocations (e.g. paid in
        // advance, or all their allocations refunded). Fetch their name so
        // they still surface in the ledger with a negative balance.
        const fac = await prisma.facilitator.findFirst({
          where: { id: p.facilitatorId },
          select: { id: true, firstname: true, lastname: true },
        });
        if (!fac) continue;
        e = {
          facilitatorId: fac.id,
          firstname: fac.firstname,
          lastname: fac.lastname,
          heldBySchoolCents: 0,
          paidOutCents: 0,
          directIncomeCents: 0,
          pendingClearanceCents: 0,
        };
        map.set(p.facilitatorId, e);
      }
      e.paidOutCents += p._sum.amountCents ?? 0;
    }

    return [...map.values()]
      .map((e) => ({ ...e, owedCents: e.heldBySchoolCents - e.paidOutCents }))
      .sort((a, b) =>
        `${a.lastname} ${a.firstname}`.localeCompare(`${b.lastname} ${b.firstname}`),
      );
  }

  /**
   * Drill-down for ONE facilitator on /admin/soldes-intervenants: the same
   * money summary as teacherBalances(), plus the underlying allocations (each
   * tagged held/paidOut/direct/pending, with links to its payment and invoice)
   * and the list of reversements already paid. Lets the admin see exactly what
   * makes up "reste dû" and settle it.
   */
  async teacherBalanceDetail(facilitatorId: string) {
    const organizationId = this.requireOrg();
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

    const allocs = await prisma.paymentAllocation.findMany({
      where: { organizationId, beneficiaryType: 'FACILITATOR', facilitatorId },
      select: {
        id: true,
        amountCents: true,
        invoice: {
          select: {
            id: true,
            number: true,
            billToType: true,
            issuer: { select: { ownerType: true } },
          },
        },
        payment: {
          select: {
            id: true,
            method: true,
            status: true,
            chequeStatus: true,
            receivedAt: true,
            createdAt: true,
          },
        },
      },
    });

    let heldBySchoolCents = 0;
    let paidOutCents = 0;
    let directIncomeCents = 0;
    let pendingClearanceCents = 0;

    type AllocationDetail = {
      id: string;
      amountCents: number;
      kind: 'held' | 'paidOut' | 'direct' | 'pending';
      payment: {
        id: string;
        method: string;
        status: string;
        chequeStatus: string | null;
        receivedAt: string | null;
        createdAt: string;
      } | null;
      invoice: { id: string; number: string; billToType: string } | null;
    };

    const allocations: AllocationDetail[] = [];
    for (const a of allocs) {
      const isDepositedCheque =
        a.payment?.method === 'CHECK' && a.payment?.chequeStatus === 'DEPOSITED';
      let kind: AllocationDetail['kind'];
      if (isDepositedCheque) {
        kind = 'pending';
        pendingClearanceCents += a.amountCents;
      } else if (a.payment?.status !== 'SUCCEEDED') {
        // Refunded / failed after the allocation was created — not part of the
        // ledger maths, so leave it out (keeps the totals reconciling).
        continue;
      } else {
        const billTo = a.invoice?.billToType;
        const issuerType = a.invoice?.issuer?.ownerType;
        if (billTo === 'SCHOOL') {
          kind = 'paidOut';
          paidOutCents += a.amountCents;
        } else if (issuerType === 'SCHOOL' || !a.invoice) {
          kind = 'held';
          heldBySchoolCents += a.amountCents;
        } else {
          kind = 'direct';
          directIncomeCents += a.amountCents;
        }
      }
      allocations.push({
        id: a.id,
        amountCents: a.amountCents,
        kind,
        payment: a.payment
          ? {
              id: a.payment.id,
              method: a.payment.method,
              status: a.payment.status,
              chequeStatus: a.payment.chequeStatus ?? null,
              receivedAt: a.payment.receivedAt
                ? a.payment.receivedAt.toISOString()
                : null,
              createdAt:
                a.payment.createdAt instanceof Date
                  ? a.payment.createdAt.toISOString()
                  : a.payment.createdAt,
            }
          : null,
        invoice: a.invoice
          ? {
              id: a.invoice.id,
              number: a.invoice.number,
              billToType: a.invoice.billToType,
            }
          : null,
      });
    }

    const payoutRows = await prisma.facilitatorPayout.findMany({
      where: { organizationId, facilitatorId },
      orderBy: { paidAt: 'desc' },
    });
    const payouts = payoutRows.map(payoutRowToDto);
    // Manual reversements settle the held balance just like a teacher→school
    // invoice payment does.
    paidOutCents += payoutRows.reduce((s, p) => s + p.amountCents, 0);

    return {
      facilitatorId: fac.id,
      firstname: fac.firstname,
      lastname: fac.lastname,
      stripeAccountId: fac.billingIdentity?.stripeAccountId ?? null,
      heldBySchoolCents,
      paidOutCents,
      directIncomeCents,
      pendingClearanceCents,
      owedCents: heldBySchoolCents - paidOutCents,
      allocations,
      payouts,
    };
  }
}

export const invoiceSplitService = new InvoiceSplitService();

/**
 * Rebuild a payment's allocations from scratch. Called whenever a payment's
 * settlement state changes (manual record, cheque cashed). Self-contained:
 * it reads the payment's own organizationId, so it works outside request
 * context too. A non-SUCCEEDED or invoice-less payment ends up with none.
 */
export async function syncAllocationsForPayment(paymentId: string): Promise<void> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId },
    select: {
      id: true,
      organizationId: true,
      invoiceId: true,
      status: true,
      method: true,
      chequeStatus: true,
      amountCents: true,
    },
  });
  if (!payment) return;

  // Clean slate for the INVOICE-derived rows only — those are fully recomputed
  // from the invoice's lines every time. Direct allocations (invoiceId null,
  // "encaissé pour le compte de") are user-entered on the payment itself and
  // must survive a resync.
  await prisma.paymentAllocation.deleteMany({
    where: { paymentId, invoiceId: { not: null } },
  });

  // Recognise income once the payment is SUCCEEDED, OR once a cheque has been
  // deposited (the visible "en cours d'encaissement" intermediate state).
  const recognized =
    payment.status === 'SUCCEEDED' ||
    (payment.method === 'CHECK' && payment.chequeStatus === 'DEPOSITED');
  if (!recognized || !payment.invoiceId) return;

  const lines = await prisma.invoiceLine.findMany({
    where: { invoiceId: payment.invoiceId },
    select: {
      amountCents: true,
      vatCents: true,
      facilitatorId: true,
      facilitator: { select: { id: true } },
    },
  });

  type Bucket = { facilitatorId: string | null; ttc: number };
  const SCHOOL = '__school__';
  const buckets = new Map<string, Bucket>();
  for (const l of lines) {
    // Any line tagged to a (real) facilitator is that teacher's share; the
    // remainder is the school's. Attribution is tag-based — no longer gated on
    // a per-teacher billing mode (that posture has been retired).
    const isTeacher = !!l.facilitatorId && !!l.facilitator;
    const key = isTeacher ? l.facilitatorId! : SCHOOL;
    const facilitatorId = isTeacher ? l.facilitatorId! : null;
    const prev = buckets.get(key) ?? { facilitatorId, ttc: 0 };
    prev.ttc += l.amountCents + l.vatCents;
    buckets.set(key, prev);
  }

  const entries = [...buckets.values()];
  if (entries.length === 0) {
    await prisma.paymentAllocation.create({
      data: {
        organizationId: payment.organizationId,
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        beneficiaryType: 'SCHOOL',
        facilitatorId: null,
        amountCents: payment.amountCents,
      },
    });
    return;
  }

  const amounts = allocateProRata(
    payment.amountCents,
    entries.map((e) => e.ttc),
  );
  const rows = entries
    .map((e, i) => ({
      organizationId: payment.organizationId,
      paymentId: payment.id,
      invoiceId: payment.invoiceId!,
      beneficiaryType: e.facilitatorId ? 'FACILITATOR' : 'SCHOOL',
      facilitatorId: e.facilitatorId,
      amountCents: amounts[i],
    }))
    .filter((r) => r.amountCents > 0);

  if (rows.length > 0) {
    await prisma.paymentAllocation.createMany({ data: rows });
  }
}
