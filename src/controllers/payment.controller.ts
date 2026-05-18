import { Request, Response } from 'express';
import { PaymentService } from '../services/payment.service';

const paymentService = new PaymentService();

const VALID_STATUSES = new Set(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED']);
const VALID_PURPOSES = new Set(['TRIAL_LESSON', 'ENROLLMENT_BALANCE']);

export class PaymentController {
  async list(req: Request, res: Response) {
    try {
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
        typeof req.query.from === 'string' && !Number.isNaN(Date.parse(req.query.from))
          ? new Date(req.query.from)
          : undefined;
      const to =
        typeof req.query.to === 'string' && !Number.isNaN(Date.parse(req.query.to))
          ? new Date(req.query.to)
          : undefined;

      const payments = await paymentService.list({ status, purpose, from, to });
      res.json(payments);
    } catch (error) {
      console.error('list payments error:', error);
      res.status(500).json({ error: 'Failed to list payments' });
    }
  }
}
