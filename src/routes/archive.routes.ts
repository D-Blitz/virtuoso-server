import { Router } from 'express';
import { ArchiveController } from '../controllers/archive.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new ArchiveController();

// Phase 0.3 — ARCHIVE_ACCESS gates view + reversible operations
// (archive, unarchive, sendToTrash). PURGE_PERMANENTLY gates the
// hard-delete; the admin UI no longer calls that by default.
router.get('/', requirePermission('ARCHIVE_ACCESS'), (req, res) =>
  controller.list(req, res),
);
router.get('/counts', requirePermission('ARCHIVE_ACCESS'), (req, res) =>
  controller.counts(req, res),
);
router.post(
  '/:entityType/:id',
  requirePermission('ARCHIVE_ACCESS'),
  (req, res) => controller.archive(req, res),
);
router.post(
  '/:entityType/:id/unarchive',
  requirePermission('ARCHIVE_ACCESS'),
  (req, res) => controller.unarchive(req, res),
);
router.post(
  '/:entityType/:id/trash',
  requirePermission('ARCHIVE_ACCESS'),
  (req, res) => controller.sendToTrash(req, res),
);
router.delete(
  '/:entityType/:id',
  requirePermission('PURGE_PERMANENTLY'),
  (req, res) => controller.purge(req, res),
);

export default router;
