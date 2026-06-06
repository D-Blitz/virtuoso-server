import prisma from '../../prisma';
import { getOrganizationId } from '../../auth/context';
import { auditLog } from '../audit/audit.service';
import { invoiceService } from './invoice.service';
import { nextInvoiceNumber } from './invoiceNumber';
import {
  allocateProRata,
  facilitatorCutCents,
  SCHOOL_BILLER,
} from './invoiceSplit.service';
import { PaymentService } from '../payment.service';

/**
 * Multi-biller invoice issuance — the "who bills the client?" flow.
 *
 * The admin picks one or more billers for a client bill:
 *   - SCHOOL only            → one invoice, the org's identity, full amount.
 *   - one facilitator only   → one invoice under THAT teacher's identity.
 *   - SCHOOL + teacher(s)     → the bill is SPLIT: one invoice per biller, each
 *     for its cut. The teacher's cut comes from their split rule
 *     (Facilitator.splitRuleMode/Value); the school keeps the remainder.
 *
 * A facilitator that bills the SCHOOL (not the client) is never a biller here —
 * that arrangement produces no client invoice and is tracked via
 * PaymentAllocation / teacherBalances instead.
 *
 * Cut rules (mirror invoiceSplit's teacherShareForLine, applied to the whole
 * bill's HT subtotal):
 *   PERCENTAGE        — splitRuleValue % of the subtotal.
 *   FIXED_PER_SESSION — splitRuleValue cents × total line quantity.
 *   MANUAL            — the sum of the lines the admin tagged to this teacher.
 *
 * Cent-exactness: when the school is NOT a biller, the full subtotal is
 * re-apportioned across the selected teachers with allocateProRata so the
 * issued invoices always sum to the original bill to the cent.
 *
 * Linking (D-Q1: not strict — a bill may be issued before any money arrives):
 *   - every line carries the enrollmentId (when billing an enrollment), so the
 *     enrollment ↔ invoice axis is wired up;
 *   - an optional `payment` is recorded and apportioned across the issued
 *     invoices (one payment row per invoice, summing to the tender), wiring the
 *     invoice ↔ payment axis. Omit it to issue now and collect later.
 */

function httpError(message: string, statusCode = 400): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** Tenders an admin can attach inline (everything that isn't a Stripe webhook). */
const MANUAL_METHODS = new Set(['CHECK', 'CASH', 'BANK_TRANSFER', 'OTHER']);

export type IssueBillingLineInput = {
  description: string;
  quantity?: number;
  unitPriceCents: number;
  /** Phase D — line tagged to a teacher (drives MANUAL cuts + allocations). */
  facilitatorId?: string | null;
  enrollmentId?: string | null;
};

export type IssueBillingPaymentInput = {
  method: 'CHECK' | 'CASH' | 'BANK_TRANSFER' | 'OTHER';
  /** Defaults to the full issued total (sum of every invoice's TTC). */
  amountCents?: number | null;
  receivedAt?: Date | null;
  reference?: string | null;
  payerName?: string | null;
  note?: string | null;
  chequeNumber?: string | null;
  chequeBank?: string | null;
  chequeDrawerName?: string | null;
  expectedDepositDate?: Date | null;
};

export type IssueBillingInput = {
  clientId: string;
  lines: IssueBillingLineInput[];
  /** Who bills the client: ['SCHOOL'] and/or facilitator ids. */
  billers: string[];
  /** Invoice default VAT rate (%). Defaults to the org rate. */
  vatRate?: number;
  currency?: string;
  status?: 'DRAFT' | 'SENT';
  issueDate?: Date | null;
  dueDate?: Date | null;
  notes?: string | null;
  /** When billing an enrollment, tag every line + payment with it. */
  enrollmentId?: string | null;
  /** Optional money to record now and split across the issued invoices. */
  payment?: IssueBillingPaymentInput | null;
};

type NormalizedLine = {
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  facilitatorId: string | null;
  enrollmentId: string | null;
};

type LoadedFac = {
  id: string;
  firstname: string;
  lastname: string;
  billingMode: string;
  splitRuleMode: string;
  splitRuleValue: number;
  billingIdentity:
    | { id: string; legalName: string; invoicePrefix: string | null; vatExempt: boolean }
    | null;
};

/** One invoice to create, after the cut has been resolved. */
type IssueTarget = {
  issuerId: string | null;
  issuerPrefix: string | null;
  vatExempt: boolean;
  facilitatorId: string | null; // null = the school's invoice
  name: string; // for the share-line label
  shareCents: number; // HT
};

export class IssueBillingService {
  private requireOrg(): string {
    const organizationId = getOrganizationId();
    if (!organizationId) throw httpError('Contexte organisation manquant.', 401);
    return organizationId;
  }

  private normalizeLines(lines: IssueBillingLineInput[] | undefined): NormalizedLine[] {
    if (!lines || lines.length === 0) {
      throw httpError('Une facture doit comporter au moins une ligne.');
    }
    return lines.map((l, i) => {
      const description = (l.description ?? '').trim();
      if (!description) throw httpError(`La ligne ${i + 1} doit avoir une description.`);
      const quantity = l.quantity ?? 1;
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw httpError(`La quantité de la ligne ${i + 1} doit être un entier positif.`);
      }
      if (!Number.isFinite(l.unitPriceCents)) {
        throw httpError(`Le prix unitaire de la ligne ${i + 1} est invalide.`);
      }
      const unitPriceCents = Math.round(l.unitPriceCents);
      return {
        description,
        quantity: Math.round(quantity),
        unitPriceCents,
        amountCents: Math.round(quantity) * unitPriceCents,
        facilitatorId: l.facilitatorId ?? null,
        enrollmentId: l.enrollmentId ?? null,
      };
    });
  }

  /** A facilitator's cut of the bill's HT subtotal, clamped to [0, subtotal]. */
  private cutForFacilitator(
    fac: LoadedFac,
    subtotalCents: number,
    totalQuantity: number,
    lines: NormalizedLine[],
  ): number {
    const taggedCents = lines
      .filter((l) => l.facilitatorId === fac.id)
      .reduce((s, l) => s + l.amountCents, 0);
    return facilitatorCutCents(fac, subtotalCents, totalQuantity, taggedCents);
  }

  /**
   * Issue 1..N invoices for a client according to the biller selection.
   * Returns the created invoices (detail DTOs).
   */
  async issue(input: IssueBillingInput) {
    const organizationId = this.requireOrg();

    const client = await prisma.client.findFirst({
      where: { id: input.clientId },
      select: { id: true },
    });
    if (!client) throw httpError('Client introuvable.', 404);

    const lines = this.normalizeLines(input.lines);
    const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
    const totalQuantity = lines.reduce((s, l) => s + l.quantity, 0);

    const billers = [...new Set(input.billers ?? [])];
    if (billers.length === 0) {
      throw httpError('Sélectionnez au moins un émetteur (qui facture le client).', 400);
    }
    const selectedFacIds = billers.filter((b) => b !== SCHOOL_BILLER);
    const includeSchool = billers.includes(SCHOOL_BILLER);

    // Resolve the selected facilitators + their billing identities.
    const facs: LoadedFac[] = selectedFacIds.length
      ? await prisma.facilitator.findMany({
          where: { id: { in: selectedFacIds } },
          select: {
            id: true,
            firstname: true,
            lastname: true,
            billingMode: true,
            splitRuleMode: true,
            splitRuleValue: true,
            billingIdentity: {
              select: { id: true, legalName: true, invoicePrefix: true, vatExempt: true },
            },
          },
        })
      : [];
    const facById = new Map(facs.map((f) => [f.id, f]));
    const missingIdentity: string[] = [];
    for (const id of selectedFacIds) {
      const f = facById.get(id);
      if (!f) throw httpError('Intervenant introuvable.', 404);
      if (!f.billingIdentity) {
        missingIdentity.push(`${f.firstname} ${f.lastname}`.trim());
      }
    }
    if (missingIdentity.length > 0) {
      throw httpError(
        `Identité de facturation manquante pour : ${missingIdentity.join(', ')}. ` +
          'Créez leur identité de facturation avant de facturer en leur nom.',
        409,
      );
    }

    // Org default VAT rate (snapshotted), unless the caller overrode it.
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { vatRate: true },
    });
    const vatRate = input.vatRate !== undefined ? input.vatRate : org?.vatRate ?? 0;
    if (!Number.isFinite(vatRate) || vatRate < 0) {
      throw httpError('Le taux de TVA doit être un nombre positif ou nul.', 400);
    }

    const enrollmentId = input.enrollmentId ?? lines[0].enrollmentId ?? null;
    const status = input.status === 'DRAFT' ? 'DRAFT' : 'SENT';
    const issueDate =
      status === 'SENT' ? input.issueDate ?? new Date() : input.issueDate ?? null;

    // ── Single biller — preserve the full line detail. ──────────────────────
    if (billers.length === 1) {
      const facId = selectedFacIds[0];
      const fac = facId ? facById.get(facId)! : null;
      let issuerId: string | null = null;
      let vatExempt = false;
      if (fac) {
        issuerId = fac.billingIdentity!.id;
        vatExempt = fac.billingIdentity!.vatExempt;
      } else {
        const school = await prisma.billingIdentity.findFirst({
          where: { ownerType: 'SCHOOL' },
          select: { id: true, vatExempt: true },
        });
        issuerId = school?.id ?? null;
        vatExempt = school?.vatExempt ?? false;
      }

      const created = await invoiceService.create({
        clientId: input.clientId,
        currency: input.currency,
        vatRate: vatExempt ? 0 : vatRate,
        status,
        issueDate,
        dueDate: input.dueDate ?? null,
        notes: input.notes ?? null,
        issuerId,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          vatRate: vatExempt ? 0 : null,
          enrollmentId: l.enrollmentId ?? enrollmentId,
          // A teacher-issued single invoice tags its lines to that teacher so
          // payment allocations attribute the income correctly.
          facilitatorId: fac ? fac.id : l.facilitatorId,
        })),
      });

      await this.attachPayment(input, enrollmentId, [
        { id: created.id, totalCents: created.totalCents },
      ]);
      return this.loadAll([created.id]);
    }

    // ── Multiple billers — split the bill into one invoice per biller. ──────
    const targets: IssueTarget[] = [];
    let allocated = 0;
    for (const facId of selectedFacIds) {
      const fac = facById.get(facId)!;
      const cut = Math.min(
        this.cutForFacilitator(fac, subtotalCents, totalQuantity, lines),
        subtotalCents - allocated,
      );
      allocated += cut;
      targets.push({
        issuerId: fac.billingIdentity!.id,
        issuerPrefix: fac.billingIdentity!.invoicePrefix,
        vatExempt: fac.billingIdentity!.vatExempt,
        facilitatorId: fac.id,
        name: `${fac.firstname} ${fac.lastname}`.trim(),
        shareCents: cut,
      });
    }

    if (includeSchool) {
      const school = await prisma.billingIdentity.findFirst({
        where: { ownerType: 'SCHOOL' },
        select: { id: true, invoicePrefix: true, vatExempt: true },
      });
      targets.push({
        issuerId: school?.id ?? null,
        issuerPrefix: school?.invoicePrefix ?? null,
        vatExempt: school?.vatExempt ?? false,
        facilitatorId: null,
        name: 'organisation',
        shareCents: Math.max(0, subtotalCents - allocated),
      });
    } else {
      // No school biller — re-apportion the FULL subtotal across the teachers
      // so the issued invoices always sum back to the original bill.
      const exact = allocateProRata(
        subtotalCents,
        targets.map((t) => t.shareCents),
      );
      targets.forEach((t, i) => (t.shareCents = exact[i]));
    }

    // Drop zero-share invoices, but always keep at least one.
    let active = targets.filter((t) => t.shareCents > 0);
    if (active.length === 0) active = targets.slice(0, 1);

    const baseDescription = lines[0].description;
    const created = await prisma.$transaction(async (tx) => {
      const out: { id: string; number: string; totalCents: number }[] = [];
      for (const t of active) {
        const number = await nextInvoiceNumber(tx, {
          organizationId,
          issuerId: t.issuerId,
          invoicePrefix: t.issuerPrefix,
        });
        const effectiveRate = t.vatExempt ? 0 : vatRate;
        const vatCents = Math.round((t.shareCents * effectiveRate) / 100);
        // The line keeps the plain service description — the facilitator tag is
        // internal (payout tracking) and must stay invisible to the client.
        const description = baseDescription;
        const inv = await tx.invoice.create({
          data: {
            organizationId,
            clientId: input.clientId,
            issuerId: t.issuerId,
            billToType: 'CLIENT',
            number,
            status,
            currency: input.currency ?? 'EUR',
            subtotalCents: t.shareCents,
            vatRate: effectiveRate,
            vatCents,
            totalCents: t.shareCents + vatCents,
            issueDate,
            dueDate: input.dueDate ?? null,
            notes: input.notes ?? null,
            lines: {
              create: [
                {
                  description,
                  quantity: 1,
                  unitPriceCents: t.shareCents,
                  amountCents: t.shareCents,
                  vatRate: t.vatExempt ? 0 : null,
                  vatCents,
                  enrollmentId,
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

    for (const inv of created) {
      void auditLog.record({
        action: 'CREATE',
        entityType: 'Invoice',
        entityId: inv.id,
        after: { number: inv.number, totalCents: inv.totalCents, multiBiller: true },
      });
    }

    await this.attachPayment(
      input,
      enrollmentId,
      created.map((c) => ({ id: c.id, totalCents: c.totalCents })),
    );

    return this.loadAll(created.map((c) => c.id));
  }

  /**
   * Record the optional inline payment and apportion it across the issued
   * invoices (one payment row per invoice, summing to the tender). Reuses
   * PaymentService.recordManual so status / cheque lifecycle / allocations /
   * audit all behave exactly as a hand-recorded payment.
   */
  private async attachPayment(
    input: IssueBillingInput,
    enrollmentId: string | null,
    invoices: { id: string; totalCents: number }[],
  ): Promise<void> {
    const pm = input.payment;
    if (!pm) return;
    if (!MANUAL_METHODS.has(pm.method)) {
      throw httpError('Mode de paiement invalide pour cette facturation.', 400);
    }

    const fullTotal = invoices.reduce((s, i) => s + i.totalCents, 0);
    const tender = pm.amountCents != null ? Math.round(pm.amountCents) : fullTotal;
    if (!Number.isFinite(tender) || tender <= 0) return;

    const parts = allocateProRata(tender, invoices.map((i) => i.totalCents));
    const paymentService = new PaymentService();
    for (let i = 0; i < invoices.length; i++) {
      const amountCents = parts[i];
      if (amountCents <= 0) continue;
      await paymentService.recordManual({
        clientId: input.clientId,
        invoiceId: invoices[i].id,
        amountCents,
        method: pm.method,
        currency: input.currency,
        receivedAt: pm.receivedAt ?? null,
        reference: pm.reference ?? null,
        payerName: pm.payerName ?? null,
        note: pm.note ?? null,
        relatedEnrollmentId: enrollmentId,
        chequeNumber: pm.chequeNumber ?? null,
        chequeBank: pm.chequeBank ?? null,
        chequeDrawerName: pm.chequeDrawerName ?? null,
        expectedDepositDate: pm.expectedDepositDate ?? null,
      });
    }
  }

  private async loadAll(ids: string[]) {
    const invoices = await Promise.all(ids.map((id) => invoiceService.get(id)));
    return { invoices };
  }
}

export const issueBillingService = new IssueBillingService();
