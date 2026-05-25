import { Request, Response } from 'express';
import {
  CancellationService,
  type RefundMode,
} from '../services/cancellation/cancellation.service';
import { sendError } from './httpErrors';

const service = new CancellationService();

const VALID_MODES: ReadonlySet<RefundMode> = new Set(['NONE', 'FULL', 'PARTIAL']);

export class CancellationController {
  /**
   * POST /api/scheduled-events/:id/cancel
   *
   * Body:
   *   reason?: string
   *   refundMode: 'NONE' | 'FULL' | 'PARTIAL'
   *   refundAmount?: number   // EUR, required when refundMode = 'PARTIAL'
   *
   * Returns:
   *   { scheduledEventId, refundIssued, refundedAmount, stripeRefundId }
   */
  async cancelEvent(req: Request, res: Response) {
    try {
      const { reason, refundMode, refundAmount } = req.body ?? {};

      if (!VALID_MODES.has(refundMode)) {
        res.status(400).json({
          error: 'refundMode doit être NONE, FULL ou PARTIAL.',
        });
        return;
      }
      if (
        refundMode === 'PARTIAL' &&
        (typeof refundAmount !== 'number' || refundAmount <= 0)
      ) {
        res.status(400).json({
          error: 'Le montant du remboursement partiel est requis.',
        });
        return;
      }

      const result = await service.cancelEvent({
        eventId: req.params.id,
        reason: typeof reason === 'string' ? reason : null,
        refundMode,
        refundAmount:
          typeof refundAmount === 'number' ? refundAmount : undefined,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err, 'Failed to cancel event');
    }
  }
}
