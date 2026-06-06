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

// Phase 1.9 — manual multi-tender recording + cheque clearance tracker.
// `/cheques` and `/manual` are literal segments declared before the
// `/:id/*` action routes so they can never be shadowed by an id match.
router.get('/cheques', requirePermission('PAYMENT_VIEW'), (req, res) =>
  controller.listCheques(req, res),
);
router.post('/manual', requirePermission('PAYMENT_MANAGE'), (req, res) =>
  controller.recordManual(req, res),
);
router.patch('/:id/cheque-status', requirePermission('PAYMENT_MANAGE'), (req, res) =>
  controller.setChequeStatus(req, res),
);
// Payment-first billing — generate a numbered invoice from a standalone payment.
router.post('/:id/generate-invoice', requirePermission('PAYMENT_MANAGE'), (req, res) =>
  controller.generateInvoice(req, res),
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
