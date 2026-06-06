import { Request, Response } from 'express';
import {
  invoiceService,
  type InvoiceLineInput,
  type ListInvoicesFilters,
} from '../services/invoice/invoice.service';
import { invoiceSplitService } from '../services/invoice/invoiceSplit.service';
import {
  issueBillingService,
  type IssueBillingLineInput,
  type IssueBillingPaymentInput,
} from '../services/invoice/issueBilling.service';
import { invoicePdfService } from '../services/invoice/invoicePdf.service';
import { resolveInvoiceFacilitatorScope } from '../middleware/permission';
import { sendServiceError } from './httpErrors';

/**
 * Invoice REST surface (Phase 1.9). Money crosses the wire in CENTS
 * (`unitPriceCents`) to match the read DTOs and the DB — the frontend
 * converts euros → cents at the input boundary. Reads are gated on
 * PAYMENT_VIEW, writes on PAYMENT_MANAGE (reusing the payment perms so
 * no role-seeding migration is needed).
 */

const VALID_INVOICE_STATUSES = new Set([
  'DRAFT',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'VOID',
]);

function parseDate(raw: unknown): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t);
}

function parsePagingInt(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Invoice-level default VAT rate. undefined = not provided (keep/derive). */
function parseRate(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Per-line VAT override. null = inherit; number = explicit override. */
function parseLineRate(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseLines(raw: unknown): InvoiceLineInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l: any) => ({
    description: typeof l?.description === 'string' ? l.description : '',
    quantity: l?.quantity != null ? Number(l.quantity) : undefined,
    unitPriceCents: Math.round(Number(l?.unitPriceCents)),
    vatRate: parseLineRate(l?.vatRate),
    enrollmentId: typeof l?.enrollmentId === 'string' ? l.enrollmentId : null,
    facilitatorId:
      typeof l?.facilitatorId === 'string' && l.facilitatorId
        ? l.facilitatorId
        : null,
  }));
}

function parseFilters(req: Request): ListInvoicesFilters {
  const status =
    typeof req.query.status === 'string' &&
    VALID_INVOICE_STATUSES.has(req.query.status)
      ? req.query.status
      : undefined;
  const clientId =
    typeof req.query.clientId === 'string' && req.query.clientId
      ? req.query.clientId
      : undefined;
  const from = parseDate(req.query.from) ?? undefined;
  const to = parseDate(req.query.to) ?? undefined;
  return { status, clientId, from: from ?? undefined, to: to ?? undefined };
}

export class InvoiceController {
  async list(req: Request, res: Response) {
    try {
      const filters = parseFilters(req);
      const page = parsePagingInt(req.query.page, 1);
      const pageSize = parsePagingInt(req.query.pageSize, 50);
      // Invoice-access scope: null = full, string[] = facilitator allowlist.
      const facilitatorScope = await resolveInvoiceFacilitatorScope();
      const result = await invoiceService.list({
        ...filters,
        page,
        pageSize,
        facilitatorScope,
      });
      res.json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to list invoices');
    }
  }

  async get(req: Request, res: Response) {
    try {
      const facilitatorScope = await resolveInvoiceFacilitatorScope();
      const result = await invoiceService.get(req.params.id, facilitatorScope);
      res.json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to load invoice');
    }
  }

  async create(req: Request, res: Response) {
    try {
      const b = req.body ?? {};
      const status = b.status === 'SENT' ? 'SENT' : 'DRAFT';
      const result = await invoiceService.create({
        clientId: typeof b.clientId === 'string' ? b.clientId : '',
        lines: parseLines(b.lines),
        vatRate: parseRate(b.vatRate),
        issuerId:
          typeof b.issuerId === 'string' && b.issuerId ? b.issuerId : undefined,
        status,
        currency: typeof b.currency === 'string' ? b.currency : undefined,
        issueDate: parseDate(b.issueDate),
        dueDate: parseDate(b.dueDate),
        notes: typeof b.notes === 'string' ? b.notes : undefined,
      });
      res.status(201).json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to create invoice');
    }
  }

  /**
   * POST /api/invoices/issue — multi-biller issuance. Body carries a
   * `billers` array (["SCHOOL", <facilitatorId>, …]) and optional inline
   * `payment`. Returns { invoices: [...] } — one entry per issued invoice.
   */
  async issue(req: Request, res: Response) {
    try {
      const b = req.body ?? {};
      const billers = Array.isArray(b.billers)
        ? b.billers.filter((x: unknown): x is string => typeof x === 'string' && !!x)
        : [];
      const lines: IssueBillingLineInput[] = Array.isArray(b.lines)
        ? b.lines.map((l: any) => ({
            description: typeof l?.description === 'string' ? l.description : '',
            quantity: l?.quantity != null ? Number(l.quantity) : undefined,
            unitPriceCents: Math.round(Number(l?.unitPriceCents)),
            facilitatorId:
              typeof l?.facilitatorId === 'string' && l.facilitatorId
                ? l.facilitatorId
                : null,
            enrollmentId:
              typeof l?.enrollmentId === 'string' && l.enrollmentId
                ? l.enrollmentId
                : null,
          }))
        : [];

      let payment: IssueBillingPaymentInput | null = null;
      if (b.payment && typeof b.payment === 'object') {
        const p = b.payment;
        payment = {
          method: p.method,
          amountCents:
            p.amountCents != null && Number.isFinite(Number(p.amountCents))
              ? Math.round(Number(p.amountCents))
              : null,
          receivedAt: parseDate(p.receivedAt) ?? null,
          reference: typeof p.reference === 'string' ? p.reference : null,
          payerName: typeof p.payerName === 'string' ? p.payerName : null,
          note: typeof p.note === 'string' ? p.note : null,
          chequeNumber: typeof p.chequeNumber === 'string' ? p.chequeNumber : null,
          chequeBank: typeof p.chequeBank === 'string' ? p.chequeBank : null,
          chequeDrawerName:
            typeof p.chequeDrawerName === 'string' ? p.chequeDrawerName : null,
          expectedDepositDate: parseDate(p.expectedDepositDate) ?? null,
        };
      }

      const result = await issueBillingService.issue({
        clientId: typeof b.clientId === 'string' ? b.clientId : '',
        lines,
        billers,
        vatRate: parseRate(b.vatRate),
        currency: typeof b.currency === 'string' ? b.currency : undefined,
        status: b.status === 'DRAFT' ? 'DRAFT' : 'SENT',
        issueDate: parseDate(b.issueDate),
        dueDate: parseDate(b.dueDate),
        notes: typeof b.notes === 'string' ? b.notes : undefined,
        enrollmentId:
          typeof b.enrollmentId === 'string' && b.enrollmentId
            ? b.enrollmentId
            : null,
        payment,
      });
      res.status(201).json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to issue invoices');
    }
  }

  async update(req: Request, res: Response) {
    try {
      const b = req.body ?? {};
      const result = await invoiceService.update(req.params.id, {
        clientId: typeof b.clientId === 'string' ? b.clientId : undefined,
        lines: b.lines !== undefined ? parseLines(b.lines) : undefined,
        vatRate: parseRate(b.vatRate),
        status:
          b.status === 'DRAFT' || b.status === 'SENT' || b.status === 'VOID'
            ? b.status
            : undefined,
        issueDate: parseDate(b.issueDate),
        dueDate: parseDate(b.dueDate),
        notes: b.notes !== undefined ? (b.notes === null ? null : String(b.notes)) : undefined,
      });
      res.json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to update invoice');
    }
  }

  async void(req: Request, res: Response) {
    try {
      const result = await invoiceService.voidInvoice(req.params.id);
      res.json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to void invoice');
    }
  }

  /**
   * Phase E — render this invoice as a themeable PDF. Inline by default
   * (opens in the browser's viewer); `?download=1` forces a file download.
   */
  async pdf(req: Request, res: Response) {
    try {
      // Enforce invoice-access scope before rendering: get() 404s a scoped user
      // on an invoice outside their facilitator allowlist.
      const facilitatorScope = await resolveInvoiceFacilitatorScope();
      await invoiceService.get(req.params.id, facilitatorScope);
      const { buffer, filename } = await invoicePdfService.generate(req.params.id);
      const download =
        req.query.download === '1' || req.query.download === 'true';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader(
        'Content-Disposition',
        `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      );
      res.end(buffer);
    } catch (err) {
      sendServiceError(res, err, 'Failed to generate invoice PDF');
    }
  }

  // ── Phase D — teacher split ─────────────────────────────────────────────

  /** Preview the teacher split (read-only) before committing it. */
  async splitPreview(req: Request, res: Response) {
    try {
      const result = await invoiceSplitService.preview(req.params.id);
      res.json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to preview invoice split');
    }
  }

  /** Generate the teacher split invoices from this source invoice. */
  async split(req: Request, res: Response) {
    try {
      const result = await invoiceSplitService.generateSplit(req.params.id);
      res.json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to split invoice');
    }
  }

  /** Per-teacher money summary (held by school / paid out / owed / direct). */
  async teacherBalances(req: Request, res: Response) {
    try {
      const result = await invoiceSplitService.teacherBalances();
      res.json({ items: result });
    } catch (err) {
      sendServiceError(res, err, 'Failed to load teacher balances');
    }
  }
}
