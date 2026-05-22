import { Router } from 'express';
import { TrashController } from '../controllers/trash.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new TrashController();

// Phase 0.3 — TRASH_ACCESS gates view + reversible ops (restore,
// archive). PURGE_PERMANENTLY gates hard delete (single + purgeAll).
router.get('/', requirePermission('TRASH_ACCESS'), (req, res) =>
  controller.list(req, res),
);
router.get('/counts', requirePermission('TRASH_ACCESS'), (req, res) =>
  controller.counts(req, res),
);
router.post(
  '/purge-all',
  requirePermission('PURGE_PERMANENTLY'),
  (req, res) => controller.purgeAll(req, res),
);
router.post(
  '/:entityType/:id/restore',
  requirePermission('TRASH_ACCESS'),
  (req, res) => controller.restore(req, res),
);
router.post(
  '/:entityType/:id/archive',
  requirePermission('TRASH_ACCESS'),
  (req, res) => controller.archive(req, res),
);
router.delete(
  '/:entityType/:id',
  requirePermission('PURGE_PERMANENTLY'),
  (req, res) => controller.purge(req, res),
);

export default router;
