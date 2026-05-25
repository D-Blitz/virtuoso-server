import { Request, Response } from 'express';
import { CancellationService } from '../services/cancellation/cancellation.service';
import { sendError } from './httpErrors';

const service = new CancellationService();

export class CancellationController {
  /**
   * POST /api/scheduled-events/:id/cancel
   *
   * Body:
   *   reason?: string
   *
   * Refunds live on /admin/payments now (RefundService) — cancellation
   * doesn't touch payments. If the admin needs to refund the associated
   * Stripe payment, they do so separately from the payments surface.
   */
  async cancelEvent(req: Request, res: Response) {
    try {
      const { reason } = req.body ?? {};
      const result = await service.cancelEvent({
        eventId: req.params.id,
        reason: typeof reason === 'string' ? reason : null,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err, 'Failed to cancel event');
    }
  }
}
