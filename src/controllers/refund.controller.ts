import { Request, Response } from 'express';
import { RefundService } from '../services/refund/refund.service';
import { sendError } from './httpErrors';

const service = new RefundService();

export class RefundController {
  /**
   * POST /api/payments/:id/refund
   *
   * Body:
   *   amount?: number  // EUR; omit for full refund
   *   reason?: string  // audit-only; not sent to Stripe directly
   *
   * Gated by REFUND_ISSUE permission at the route level. Returns
   * the queued refund — Payment.status flips to REFUNDED once the
   * Stripe webhook confirms (usually within a few seconds).
   */
  async issue(req: Request, res: Response) {
    try {
      const { amount, reason } = req.body ?? {};
      let amountCents: number | undefined;
      if (amount !== undefined && amount !== null) {
        const n = typeof amount === 'number' ? amount : Number(amount);
        if (!Number.isFinite(n) || n <= 0) {
          res.status(400).json({
            error: 'Le montant à rembourser doit être un nombre positif.',
          });
          return;
        }
        amountCents = Math.round(n * 100);
      }
      const result = await service.issueRefund({
        paymentId: req.params.id,
        amountCents,
        reason: typeof reason === 'string' ? reason : undefined,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err, 'Failed to issue refund');
    }
  }
}
