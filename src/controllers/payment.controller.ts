import { Request, Response } from 'express';
import {
  PaymentService,
  type ListPaymentsFilters,
} from '../services/payment.service';

const paymentService = new PaymentService();

const VALID_STATUSES = new Set(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED']);
const VALID_PURPOSES = new Set(['TRIAL_LESSON', 'ENROLLMENT_BALANCE']);

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
  return { status, purpose, from, to };
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
}
