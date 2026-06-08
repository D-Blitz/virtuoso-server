import { Router } from 'express';
import { ClientController } from '../controllers/client.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new ClientController();

// Phase 0.3: CLIENT_VIEW gates read endpoints; CLIENT_MANAGE gates writes.
// Anonymize lives on its own route file and gates with CLIENT_ANONYMIZE.
router.get(
  '/',
  requirePermission('CLIENT_VIEW'),
  (req, res) => controller.getAll(req, res),
);
// N.6.8 — aggregated metrics for the UID page's chart panel.
router.get(
  '/:id/insights',
  requirePermission('CLIENT_VIEW'),
  (req, res) => controller.insights(req, res),
);
router.post(
  '/',
  requirePermission('CLIENT_MANAGE'),
  (req, res) => controller.create(req, res),
);
router.put(
  '/:id',
  requirePermission('CLIENT_MANAGE'),
  (req, res) => controller.update(req, res),
);
router.delete(
  '/:id',
  requirePermission('CLIENT_MANAGE'),
  (req, res) => controller.remove(req, res),
);

export default router;
