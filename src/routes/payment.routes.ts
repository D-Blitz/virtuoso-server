import { Router } from 'express';
import { PaymentController } from '../controllers/payment.controller';
import { RefundController } from '../controllers/refund.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new PaymentController();
const refundController = new RefundController();

router.get('/', requirePermission('PAYMENT_VIEW'), (req, res) =>
  controller.list(req, res),
);
router.get('/stats', requirePermission('PAYMENT_VIEW'), (req, res) =>
  controller.stats(req, res),
);

// Phase 1.1 (revised) — admin-initiated refunds live here, on the
// payment surface. Cancellation lives on the event surface. The two
// are decoupled because a payment and an event are different objects:
// one payment can cover many events, one event can have many or zero
// payments, and only Stripe payments are refundable through this
// route at all.
router.post(
  '/:id/refund',
  requirePermission('REFUND_ISSUE'),
  (req, res) => refundController.issue(req, res),
);

export default router;
