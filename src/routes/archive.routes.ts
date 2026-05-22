import { Router } from 'express';
import { ArchiveController } from '../controllers/archive.controller';

const router = Router();
const controller = new ArchiveController();

router.get('/', (req, res) => controller.list(req, res));
router.get('/counts', (req, res) => controller.counts(req, res));
router.post('/:entityType/:id', (req, res) => controller.archive(req, res));
router.post('/:entityType/:id/unarchive', (req, res) =>
  controller.unarchive(req, res),
);
router.post('/:entityType/:id/trash', (req, res) =>
  controller.sendToTrash(req, res),
);
router.delete('/:entityType/:id', (req, res) => controller.purge(req, res));

export default router;
