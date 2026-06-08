import { Router } from 'express';
import { FacilitatorController } from '../controllers/facilitator.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new FacilitatorController();

router.get(
  '/',
  requirePermission('FACILITATOR_VIEW'),
  (req, res) => controller.getAll(req, res),
);
// N.6.3 — aggregated metrics for the UID page's chart panel.
router.get(
  '/:id/insights',
  requirePermission('FACILITATOR_VIEW'),
  (req, res) => controller.insights(req, res),
);
router.post(
  '/',
  requirePermission('FACILITATOR_MANAGE'),
  (req, res) => controller.create(req, res),
);
router.put(
  '/:id',
  requirePermission('FACILITATOR_MANAGE'),
  (req, res) => controller.update(req, res),
);
router.delete(
  '/:id',
  requirePermission('FACILITATOR_MANAGE'),
  (req, res) => controller.remove(req, res),
);

export default router;
