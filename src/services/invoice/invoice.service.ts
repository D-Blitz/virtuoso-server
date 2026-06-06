import prisma from '../../prisma';
import { getOrganizationId } from '../../auth/context';
import { auditLog } from '../audit/audit.service';
import { nextInvoiceNumber } from './invoiceNumber';

/**
 * Phase 1.9 — Invoicing (the billing container for the multi-tender
 * transactional loop).
 *
 * An Invoice is the anchor for "money a client owes". It carries N
 * lines (HT amounts), snapshots the org VAT rate at creation, and is
 * settled by one or more Payments of any tender (card / cheque / cash /
 * transfer — see PaymentService.recordManual).
 *
 * Derived money:
 *   - subtotal/vat/total are STORED, recomputed from the lines on every
 *     write so list queries never have to aggregate lines.
 *   - `paidCents` / `balanceCents` are DERIVED at read time from the
 *     settled payments (status = SUCCEEDED). A cheque only becomes
 *     "settled" once it is CASHED (PaymentService flips its status), so
 *     uncashed cheques never inflate the paid figure — that is the
 *     "cheque is income only when cleared" rule, for free.
 *   - `status` (DRAFT | SENT | PARTIALLY_PAID | PAID | VOID) is
 *     recomputed by `recomputeStatus()` whenever a payment changes.
 *
 * Org scoping is explicit (organizationId in every where / data) AND
 * belt-and-suspenders via the Prisma tenant-scope extension (Invoice is
 * in TENANT_SCOPED_MODELS).
 */

const clientSelect = {
  id: true,
  firstname: true,
  lastname: true,
  email: true,
} as const;

// Slim issuer summary embedded on every invoice DTO (who billed it).
const issuerSelect = {
  id: true,
  ownerType: true,
  legalName: true,
  facilitatorId: true,
  invoicePrefix: true,
} as const;

export type InvoiceLineInput = {
  description: string;
  quantity?: number; // default 1
  unitPriceCents: number;
  /** Per-line VAT override (%). null/undefined = inherit invoice default. */
  vatRate?: number | null;
  enrollmentId?: string | null;
  /** Phase D — revenue owner (freelance teacher). null = the school's line. */
  facilitatorId?: string | null;
};

export type CreateInvoiceInput = {
  clientId: string;
  lines: InvoiceLineInput[];
  /** Invoice default VAT rate (%). Defaults to the org rate when omitted. */
  vatRate?: number;
  /**
   * The BillingIdentity issuing this invoice. Omit (or null) to default to
   * the org's SCHOOL identity. Drives which per-issuer number sequence the
   * invoice draws from.
   */
  issuerId?: string | null;
  /** Initial status. Only DRAFT or SENT are valid on create. */
  status?: 'DRAFT' | 'SENT';
  currency?: string; // default EUR
  issueDate?: Date | null;
  dueDate?: Date | null;
  notes?: string | null;
};

export type UpdateInvoiceInput = {
  clientId?: string;
  /** When provided, REPLACES all lines (only allowed pre-settlement). */
  lines?: InvoiceLineInput[];
  /** Invoice default VAT rate (%). Recomputes totals (pre-settlement only). */
  vatRate?: number;
  /** Manual transitions only: DRAFT | SENT | VOID. Paid states derive. */
  status?: 'DRAFT' | 'SENT' | 'VOID';
  issueDate?: Date | null;
  dueDate?: Date | null;
  notes?: string | null;
};

export type ListInvoicesFilters = {
  status?: string;
  clientId?: string;
  /**
   * Filter to invoices touching this facilitator — a line tagged to them, or
   * issued under their billing identity. Distinct from `facilitatorScope`
   * (a permission-derived allowlist): both can apply at once, combined with AND.
   */
  facilitatorId?: string;
  from?: Date;
  to?: Date;
};

export type ListInvoicesArgs = ListInvoicesFilters & {
  page?: number;
  pageSize?: number;
  /**
   * Invoice-access scope (resolved by the controller). `null`/omitted = full
   * access; a string[] restricts results to invoices touching one of those
   * facilitators (a tagged line, or the issuer's own facilitator). An empty
   * array therefore matches nothing (deny-all).
   */
  facilitatorScope?: string[] | null;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function httpError(message: string, statusCode = 400): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** Validate a VAT rate (%) — finite and non-negative. */
function assertRate(rate: number, label = 'Le taux de TVA'): number {
  if (!Number.isFinite(rate) || rate < 0) {
    throw httpError(`${label} doit être un nombre positif ou nul.`);
  }
  return rate;
}

type NormalizedLine = {
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  vatRate: number | null; // per-line override; null = inherit invoice default
  enrollmentId: string | null;
  facilitatorId: string | null; // Phase D — revenue owner; null = school
};

function normalizeLines(lines: InvoiceLineInput[] | undefined): NormalizedLine[] {
  if (!lines || lines.length === 0) {
    throw httpError('Une facture doit comporter au moins une ligne.');
  }
  return lines.map((l, i) => {
    const description = (l.description ?? '').trim();
    if (!description) {
      throw httpError(`La ligne ${i + 1} doit avoir une description.`);
    }
    const quantity = l.quantity ?? 1;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw httpError(`La quantité de la ligne ${i + 1} doit être un entier positif.`);
    }
    if (!Number.isFinite(l.unitPriceCents)) {
      throw httpError(`Le prix unitaire de la ligne ${i + 1} est invalide.`);
    }
    const unitPriceCents = Math.round(l.unitPriceCents);
    const amountCents = Math.round(quantity * unitPriceCents);
    const vatRate =
      l.vatRate === null || l.vatRate === undefined
        ? null
        : assertRate(l.vatRate, `Le taux de TVA de la ligne ${i + 1}`);
    return {
      description,
      quantity: Math.round(quantity),
      unitPriceCents,
      amountCents,
      vatRate,
      enrollmentId: l.enrollmentId ?? null,
      facilitatorId: l.facilitatorId ?? null,
    };
  });
}

type BuiltLine = NormalizedLine & { vatCents: number };

/**
 * Resolve each line's effective VAT rate (its override, else the invoice
 * default), compute per-line VAT, and roll up the invoice money. VAT is
 * rounded per line and summed — so a mixed-rate invoice's `vatCents` is
 * the exact sum of what each line prints.
 */
function buildLineData(
  lines: NormalizedLine[],
  defaultRate: number,
): {
  rows: BuiltLine[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
} {
  const rows = lines.map((l) => {
    const effectiveRate = l.vatRate ?? defaultRate;
    const vatCents = Math.round(l.amountCents * (effectiveRate / 100));
    return { ...l, vatCents };
  });
  const subtotalCents = rows.reduce((sum, l) => sum + l.amountCents, 0);
  const vatCents = rows.reduce((sum, l) => sum + l.vatCents, 0);
  return { rows, subtotalCents, vatCents, totalCents: subtotalCents + vatCents };
}

/** Map a stored line row back to a NormalizedLine (for rate-only recompute). */
function storedToNormalized(l: {
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  vatRate: number | null;
  enrollmentId: string | null;
  facilitatorId: string | null;
}): NormalizedLine {
  return {
    description: l.description,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    amountCents: l.amountCents,
    vatRate: l.vatRate,
    enrollmentId: l.enrollmentId,
    facilitatorId: l.facilitatorId,
  };
}

export class InvoiceService {
  private requireOrg(): string {
    const organizationId = getOrganizationId();
    if (!organizationId) {
      throw httpError('Contexte organisation manquant.', 401);
    }
    return organizationId;
  }

  /**
   * Sum of SETTLED payments (status = SUCCEEDED) for a set of invoices,
   * keyed by invoiceId. Uncashed cheques (status = PENDING) are excluded
   * by construction.
   */
  private async paidMap(
    organizationId: string,
    invoiceIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (invoiceIds.length === 0) return map;
    const grouped = await prisma.payment.groupBy({
      by: ['invoiceId'],
      where: {
        organizationId,
        invoiceId: { in: invoiceIds },
        status: 'SUCCEEDED',
      },
      _sum: { amountCents: true },
    });
    for (const row of grouped) {
      if (row.invoiceId) map.set(row.invoiceId, row._sum.amountCents ?? 0);
    }
    return map;
  }

  private toDto(invoice: any, paidCents: number) {
    return {
      ...invoice,
      paidCents,
      balanceCents: invoice.totalCents - paidCents,
    };
  }

  async create(input: CreateInvoiceInput) {
    const organizationId = this.requireOrg();

    // Client must exist in this org (Client is tenant-scoped → auto-filtered).
    const client = await prisma.client.findFirst({
      where: { id: input.clientId },
      select: { id: true },
    });
    if (!client) throw httpError('Client introuvable.', 404);

    const lineRows = normalizeLines(input.lines);

    // Invoice default VAT rate: the caller's chosen rate when provided,
    // otherwise the org rate (snapshotted at creation so later org-rate
    // changes don't retro-edit issued invoices). Per-line overrides on top.
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { vatRate: true },
    });
    const vatRate =
      input.vatRate !== undefined
        ? assertRate(input.vatRate)
        : org?.vatRate ?? 0;
    const built = buildLineData(lineRows, vatRate);
    const { subtotalCents, vatCents, totalCents } = built;

    const status = input.status === 'SENT' ? 'SENT' : 'DRAFT';

    // Resolve the issuing identity: the caller's choice when given, otherwise
    // the org's SCHOOL singleton. BillingIdentity is tenant-scoped, so these
    // reads are auto-filtered to this org. issuerId stays null only when the
    // org has no SCHOOL identity yet (pre-Phase-A) — then numbering falls
    // back to the plain per-org namespace.
    let issuer: { id: string; invoicePrefix: string | null } | null = null;
    if (input.issuerId) {
      issuer = await prisma.billingIdentity.findFirst({
        where: { id: input.issuerId },
        select: { id: true, invoicePrefix: true },
      });
      if (!issuer) throw httpError('Émetteur de facture introuvable.', 404);
    } else {
      issuer = await prisma.billingIdentity.findFirst({
        where: { ownerType: 'SCHOOL' },
        select: { id: true, invoicePrefix: true },
      });
    }
    const issuerId = issuer?.id ?? null;

    const created = await prisma.$transaction(async (tx) => {
      // Per-(issuer, year) sequential number, e.g. "2026-0001" — or
      // "<prefix>-2026-0001" when the issuer sets a prefix. Read-then-write
      // inside the tx; @@unique([organizationId, issuerId, number]) is the
      // backstop against the (vanishingly rare) concurrent-create race.
      const number = await nextInvoiceNumber(tx, {
        organizationId,
        issuerId,
        invoicePrefix: issuer?.invoicePrefix ?? null,
      });

      return tx.invoice.create({
        data: {
          organizationId,
          clientId: input.clientId,
          issuerId,
          number,
          status,
          currency: input.currency ?? 'EUR',
          subtotalCents,
          vatRate,
          vatCents,
          totalCents,
          issueDate: input.issueDate ?? (status === 'SENT' ? new Date() : null),
          dueDate: input.dueDate ?? null,
          notes: input.notes ?? null,
          lines: { create: built.rows },
        },
        include: {
          lines: { orderBy: { createdAt: 'asc' } },
          client: { select: clientSelect },
          issuer: { select: issuerSelect },
        },
      });
    });

    void auditLog.record({
      action: 'CREATE',
      entityType: 'Invoice',
      entityId: created.id,
      after: {
        number: created.number,
        status: created.status,
        clientId: created.clientId,
        totalCents: created.totalCents,
        currency: created.currency,
      },
    });

    return this.toDto(created, 0);
  }

  async list(args: ListInvoicesArgs = {}) {
    const organizationId = this.requireOrg();
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)),
    );

    // Both the access scope and the facilitator FILTER are "line tag OR issuer"
    // disjunctions. They must intersect (a scoped user filtering by facilitator
    // sees only invoices satisfying BOTH), so each goes in its own AND clause —
    // a single shared `OR` key would let one silently overwrite the other.
    const andClauses: any[] = [];
    // Invoice-access scope: a restricted user only sees invoices that carry a
    // line tagged to one of their allowed facilitators OR are issued under one
    // of their billing identities. null = unrestricted (skip it).
    if (args.facilitatorScope) {
      andClauses.push({
        OR: [
          { lines: { some: { facilitatorId: { in: args.facilitatorScope } } } },
          { issuer: { facilitatorId: { in: args.facilitatorScope } } },
        ],
      });
    }
    // Explicit facilitator filter from the ledger filter bar.
    if (args.facilitatorId) {
      andClauses.push({
        OR: [
          { lines: { some: { facilitatorId: args.facilitatorId } } },
          { issuer: { facilitatorId: args.facilitatorId } },
        ],
      });
    }

    const where = {
      organizationId,
      ...(args.status ? { status: args.status } : {}),
      ...(args.clientId ? { clientId: args.clientId } : {}),
      ...(args.from || args.to
        ? {
            createdAt: {
              ...(args.from ? { gte: args.from } : {}),
              ...(args.to ? { lte: args.to } : {}),
            },
          }
        : {}),
      ...(andClauses.length > 0 ? { AND: andClauses } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          client: { select: clientSelect },
          issuer: { select: issuerSelect },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.invoice.count({ where }),
    ]);

    const paid = await this.paidMap(organizationId, rows.map((r) => r.id));
    return {
      items: rows.map((r) => this.toDto(r, paid.get(r.id) ?? 0)),
      total,
      page,
      pageSize,
    };
  }

  async get(id: string, facilitatorScope: string[] | null = null) {
    const organizationId = this.requireOrg();
    const invoice = await prisma.invoice.findFirst({
      where: { id, organizationId },
      include: {
        lines: {
          orderBy: { createdAt: 'asc' },
          include: {
            facilitator: {
              select: { id: true, firstname: true, lastname: true },
            },
          },
        },
        client: { select: clientSelect },
        issuer: { select: issuerSelect },
        payments: { orderBy: { createdAt: 'desc' } },
        // Phase D — the teacher invoices spun off this one (when it is the
        // school's source invoice), and the parent it was spun off from
        // (when it is itself a teacher's split invoice).
        childInvoices: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            number: true,
            status: true,
            billToType: true,
            totalCents: true,
            issuer: { select: issuerSelect },
          },
        },
        parentInvoice: {
          select: { id: true, number: true, status: true },
        },
        // Phase D — how each settled payment was divided across beneficiaries.
        allocations: {
          orderBy: { createdAt: 'asc' },
          include: {
            facilitator: {
              select: { id: true, firstname: true, lastname: true },
            },
          },
        },
      },
    });
    if (!invoice) throw httpError('Facture introuvable.', 404);

    // Invoice-access scope: a restricted user may only open an invoice that
    // touches one of their allowed facilitators (a tagged line, or the issuer's
    // own facilitator). Hidden invoices 404 so existence can't be probed.
    if (facilitatorScope) {
      const allowed = new Set(facilitatorScope);
      const lineMatch = invoice.lines.some(
        (l) => l.facilitatorId && allowed.has(l.facilitatorId),
      );
      const issuerFacId = invoice.issuer?.facilitatorId ?? null;
      const issuerMatch = issuerFacId != null && allowed.has(issuerFacId);
      if (!lineMatch && !issuerMatch) {
        throw httpError('Facture introuvable.', 404);
      }
    }

    const paidCents = invoice.payments
      .filter((p) => p.status === 'SUCCEEDED')
      .reduce((sum, p) => sum + p.amountCents, 0);
    return this.toDto(invoice, paidCents);
  }

  async update(id: string, input: UpdateInvoiceInput) {
    const organizationId = this.requireOrg();
    const existing = await prisma.invoice.findFirst({
      where: { id, organizationId },
      include: { lines: true },
    });
    if (!existing) throw httpError('Facture introuvable.', 404);
    if (existing.status === 'VOID') {
      throw httpError('Une facture annulée ne peut plus être modifiée.', 409);
    }

    const data: Record<string, unknown> = {};

    if (input.clientId && input.clientId !== existing.clientId) {
      const client = await prisma.client.findFirst({
        where: { id: input.clientId },
        select: { id: true },
      });
      if (!client) throw httpError('Client introuvable.', 404);
      data.clientId = input.clientId;
    }
    if (input.issueDate !== undefined) data.issueDate = input.issueDate;
    if (input.dueDate !== undefined) data.dueDate = input.dueDate;
    if (input.notes !== undefined) data.notes = input.notes;

    if (input.status !== undefined) {
      // Paid states (PARTIALLY_PAID/PAID) are derived — never set by hand.
      if (!['DRAFT', 'SENT', 'VOID'].includes(input.status)) {
        throw httpError('Statut de facture invalide.', 400);
      }
      data.status = input.status;
      if (input.status === 'SENT' && !existing.issueDate && input.issueDate === undefined) {
        data.issueDate = new Date();
      }
    }

    // Money-affecting edits (the lines and/or the default VAT rate) are
    // only allowed before any payment has settled — otherwise the balance
    // and the derived status would desync.
    const lineRowsProvided = input.lines !== undefined;
    const vatRateProvided = input.vatRate !== undefined;

    let recompute = false;
    if (lineRowsProvided || vatRateProvided) {
      if (existing.status === 'PARTIALLY_PAID' || existing.status === 'PAID') {
        throw httpError(
          'Les montants d’une facture déjà réglée ne peuvent pas être modifiés.',
          409,
        );
      }

      const defaultRate = vatRateProvided
        ? assertRate(input.vatRate as number)
        : existing.vatRate;
      data.vatRate = defaultRate;

      if (lineRowsProvided) {
        // Full line replacement (recomputes per-line VAT under defaultRate).
        const built = buildLineData(normalizeLines(input.lines), defaultRate);
        data.subtotalCents = built.subtotalCents;
        data.vatCents = built.vatCents;
        data.totalCents = built.totalCents;
        data.lines = { deleteMany: {}, create: built.rows };
      } else {
        // Default-rate-only change: recompute from the existing lines and
        // patch each line's vatCents in place (preserving ids). Lines that
        // carry their own override are unchanged by the default; recomputing
        // them is harmless.
        const built = buildLineData(
          existing.lines.map(storedToNormalized),
          defaultRate,
        );
        data.subtotalCents = built.subtotalCents;
        data.vatCents = built.vatCents;
        data.totalCents = built.totalCents;
        data.lines = {
          update: existing.lines.map((l, i) => ({
            where: { id: l.id },
            data: { vatCents: built.rows[i].vatCents },
          })),
        };
      }
      recompute = true;
    }

    const updated = await prisma.invoice.update({
      where: { id },
      data,
      include: {
        lines: { orderBy: { createdAt: 'asc' } },
        client: { select: clientSelect },
        issuer: { select: issuerSelect },
        payments: { orderBy: { createdAt: 'desc' } },
      },
    });

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Invoice',
      entityId: id,
      before: {
        status: existing.status,
        totalCents: existing.totalCents,
        clientId: existing.clientId,
      },
      after: {
        status: updated.status,
        totalCents: updated.totalCents,
        clientId: updated.clientId,
      },
    });

    // If the total changed, the derived status may need to catch up
    // (e.g. shrinking the total could flip PARTIALLY_PAID → PAID).
    if (recompute) {
      await this.recomputeStatus(id);
      return this.get(id);
    }

    const paidCents = updated.payments
      .filter((p) => p.status === 'SUCCEEDED')
      .reduce((sum, p) => sum + p.amountCents, 0);
    return this.toDto(updated, paidCents);
  }

  /** Void an invoice. Blocked once any money has been settled (refund first). */
  async voidInvoice(id: string) {
    const organizationId = this.requireOrg();
    const existing = await prisma.invoice.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true },
    });
    if (!existing) throw httpError('Facture introuvable.', 404);
    if (existing.status === 'VOID') {
      return this.get(id);
    }

    const settled = await prisma.payment.aggregate({
      where: { organizationId, invoiceId: id, status: 'SUCCEEDED' },
      _sum: { amountCents: true },
    });
    if ((settled._sum.amountCents ?? 0) > 0) {
      throw httpError(
        'Impossible d’annuler une facture déjà (partiellement) réglée. Remboursez les paiements d’abord.',
        409,
      );
    }

    await prisma.invoice.update({ where: { id }, data: { status: 'VOID' } });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Invoice',
      entityId: id,
      before: { status: existing.status },
      after: { status: 'VOID' },
    });
    return this.get(id);
  }

  /**
   * Recompute the derived `status` from settled payments. Called by
   * PaymentService after a payment is recorded or a cheque is cashed.
   * A VOID invoice is left untouched.
   */
  async recomputeStatus(id: string): Promise<void> {
    const organizationId = this.requireOrg();
    const invoice = await prisma.invoice.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true, totalCents: true },
    });
    if (!invoice || invoice.status === 'VOID') return;

    const settled = await prisma.payment.aggregate({
      where: { organizationId, invoiceId: id, status: 'SUCCEEDED' },
      _sum: { amountCents: true },
    });
    const paid = settled._sum.amountCents ?? 0;

    let next: string;
    if (paid <= 0) {
      // No settled money yet — keep DRAFT if it was a draft, otherwise the
      // invoice has at least been issued, so it sits at SENT.
      next = invoice.status === 'DRAFT' ? 'DRAFT' : 'SENT';
    } else if (paid < invoice.totalCents) {
      next = 'PARTIALLY_PAID';
    } else {
      next = 'PAID';
    }

    if (next !== invoice.status) {
      await prisma.invoice.update({ where: { id }, data: { status: next } });
    }
  }
}

export const invoiceService = new InvoiceService();
