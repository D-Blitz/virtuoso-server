import { Request, Response } from 'express';
import {
  PaymentService,
  type ListPaymentsFilters,
  type RecordManualPaymentInput,
} from '../services/payment.service';
import { sendServiceError } from './httpErrors';

const paymentService = new PaymentService();

const VALID_STATUSES = new Set(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED']);
const VALID_PURPOSES = new Set(['TRIAL_LESSON', 'ENROLLMENT_BALANCE']);
const VALID_METHODS = new Set(['STRIPE', 'CHECK', 'CASH', 'BANK_TRANSFER', 'OTHER']);
const VALID_CHEQUE_STATUSES = new Set(['PENDING_DEPOSIT', 'DEPOSITED', 'CASHED']);

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t);
}

function parseFilters(req: Request): ListPaymentsFilters {
  const status =
    typeof req.query.status === 'string' &&
    VALID_STATUSES.has(req.query.status)
      ? req.query.status
      : undefined;
  const purpose =
    typeof req.query.purpose === 'string' &&
    VALID_PURPOSES.has(req.query.purpose)
      ? req.query.purpose
      : undefined;
  const from =
    typeof req.query.from === 'string' &&
    !Number.isNaN(Date.parse(req.query.from))
      ? new Date(req.query.from)
      : undefined;
  const to =
    typeof req.query.to === 'string' && !Number.isNaN(Date.parse(req.query.to))
      ? new Date(req.query.to)
      : undefined;
  const method =
    typeof req.query.method === 'string' && VALID_METHODS.has(req.query.method)
      ? req.query.method
      : undefined;
  const chequeStatus =
    typeof req.query.chequeStatus === 'string' &&
    VALID_CHEQUE_STATUSES.has(req.query.chequeStatus)
      ? req.query.chequeStatus
      : undefined;
  const invoiceId =
    typeof req.query.invoiceId === 'string' && req.query.invoiceId
      ? req.query.invoiceId
      : undefined;
  const clientId =
    typeof req.query.clientId === 'string' && req.query.clientId
      ? req.query.clientId
      : undefined;
  const facilitatorId =
    typeof req.query.facilitatorId === 'string' && req.query.facilitatorId
      ? req.query.facilitatorId
      : undefined;
  return {
    status,
    purpose,
    method,
    chequeStatus,
    invoiceId,
    clientId,
    facilitatorId,
    from,
    to,
  };
}

function parsePagingInt(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class PaymentController {
  async list(req: Request, res: Response) {
    try {
      const filters = parseFilters(req);
      const page = parsePagingInt(req.query.page, 1);
      const pageSize = parsePagingInt(req.query.pageSize, 50);
      const result = await paymentService.list({ ...filters, page, pageSize });
      res.json(result);
    } catch (error) {
      console.error('list payments error:', error);
      res.status(500).json({ error: 'Failed to list payments' });
    }
  }

  async stats(req: Request, res: Response) {
    try {
      const filters = parseFilters(req);
      const stats = await paymentService.stats(filters);
      res.json(stats);
    } catch (error) {
      console.error('stats payments error:', error);
      res.status(500).json({ error: 'Failed to load payment stats' });
    }
  }

  /** POST /api/payments/manual — record a cheque / cash / transfer. */
  async recordManual(req: Request, res: Response) {
    try {
      const b = req.body ?? {};
      // "Encaissé pour le compte de" — optional direct facilitator shares, kept
      // only when well-formed (string id + positive cents). Applied solely when
      // no invoice is generated; the service validates the sum vs the amount.
      const allocations = Array.isArray(b.allocations)
        ? b.allocations
            .map((a: any) => ({
              facilitatorId: typeof a?.facilitatorId === 'string' ? a.facilitatorId : '',
              amountCents: Math.round(Number(a?.amountCents)),
            }))
            .filter(
              (a: { facilitatorId: string; amountCents: number }) =>
                a.facilitatorId && Number.isFinite(a.amountCents) && a.amountCents > 0,
            )
        : undefined;
      const input: RecordManualPaymentInput = {
        clientId: typeof b.clientId === 'string' ? b.clientId : '',
        invoiceId: typeof b.invoiceId === 'string' && b.invoiceId ? b.invoiceId : null,
        amountCents: Math.round(Number(b.amountCents)),
        method: b.method as RecordManualPaymentInput['method'],
        currency: typeof b.currency === 'string' ? b.currency : undefined,
        purpose: typeof b.purpose === 'string' ? b.purpose : undefined,
        receivedAt: parseDate(b.receivedAt) ?? null,
        reference: typeof b.reference === 'string' ? b.reference : null,
        payerName: typeof b.payerName === 'string' ? b.payerName : null,
        note: typeof b.note === 'string' ? b.note : null,
        relatedEnrollmentId:
          typeof b.relatedEnrollmentId === 'string' ? b.relatedEnrollmentId : null,
        allocations: allocations && allocations.length > 0 ? allocations : undefined,
        chequeNumber: typeof b.chequeNumber === 'string' ? b.chequeNumber : null,
        chequeBank: typeof b.chequeBank === 'string' ? b.chequeBank : null,
        chequeDrawerName:
          typeof b.chequeDrawerName === 'string' ? b.chequeDrawerName : null,
        expectedDepositDate: parseDate(b.expectedDepositDate) ?? null,
      };
      const result = await paymentService.recordManual(input);
      res.status(201).json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to record payment');
    }
  }

  /** GET /api/payments/cheques — the "chèques en attente" tracker. */
  async listCheques(req: Request, res: Response) {
    try {
      const chequeStatus =
        typeof req.query.chequeStatus === 'string' &&
        VALID_CHEQUE_STATUSES.has(req.query.chequeStatus)
          ? req.query.chequeStatus
          : undefined;
      const includeCashed =
        req.query.includeCashed === 'true' || req.query.includeCashed === '1';
      const clientId =
        typeof req.query.clientId === 'string' && req.query.clientId
          ? req.query.clientId
          : undefined;
      const facilitatorId =
        typeof req.query.facilitatorId === 'string' && req.query.facilitatorId
          ? req.query.facilitatorId
          : undefined;
      const result = await paymentService.listCheques({
        chequeStatus,
        includeCashed,
        clientId,
        facilitatorId,
        from: parseDate(req.query.from),
        to: parseDate(req.query.to),
      });
      res.json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to list cheques');
    }
  }

  /** PATCH /api/payments/:id/cheque-status — advance a cheque's lifecycle. */
  async setChequeStatus(req: Request, res: Response) {
    try {
      const status = (req.body ?? {}).status;
      if (typeof status !== 'string') {
        res.status(400).json({ error: 'Le statut du chèque est requis.' });
        return;
      }
      const result = await paymentService.setChequeStatus(req.params.id, status);
      res.json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to update cheque status');
    }
  }

  /**
   * POST /api/payments/:id/generate-invoice — payment-first billing. Create
   * one or more numbered invoices for a standalone payment and attach the
   * payment to them. An optional `billers` array (["SCHOOL", <facilitatorId>,
   * …]) drives a teacher split: the existing tender is apportioned across the
   * issued invoices into one Payment row each. Returns `{ invoices: [...] }`.
   */
  async generateInvoice(req: Request, res: Response) {
    try {
      const b = req.body ?? {};
      const billers = Array.isArray(b.billers)
        ? b.billers.filter(
            (x: unknown): x is string => typeof x === 'string' && !!x,
          )
        : undefined;
      // Optional per-biller shares (cents), keyed by biller id. Keep only
      // finite numbers so a malformed blob can't poison the split.
      const shares =
        b.shares && typeof b.shares === 'object' && !Array.isArray(b.shares)
          ? Object.fromEntries(
              Object.entries(b.shares as Record<string, unknown>).filter(
                (e): e is [string, number] =>
                  typeof e[1] === 'number' && Number.isFinite(e[1]),
              ),
            )
          : undefined;
      // singleInvoice=true → one org invoice + facilitator shares as internal
      // debt (sous-traitance); false/omitted → one invoice per biller.
      const singleInvoice = b.singleInvoice === true;
      const result = await paymentService.generateInvoiceFromPayment(
        req.params.id,
        billers,
        shares,
        singleInvoice,
      );
      res.status(201).json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to generate invoice from payment');
    }
  }
}
