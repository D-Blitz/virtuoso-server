import { Router } from 'express';
import { PaymentController } from '../controllers/payment.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new PaymentController();

// Phase 0.3: PAYMENT_VIEW gates read endpoints. Refund issuing /
// payment mutations will live in dedicated routes guarded by
// PAYMENT_MANAGE / REFUND_ISSUE when they're added (Phase 6.x).
router.get('/', requirePermission('PAYMENT_VIEW'), (req, res) =>
  controller.list(req, res),
);
router.get('/stats', requirePermission('PAYMENT_VIEW'), (req, res) =>
  controller.stats(req, res),
);

export default router;
