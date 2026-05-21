import { Router } from 'express';
import { TrashController } from '../controllers/trash.controller';

const router = Router();
const controller = new TrashController();

router.get('/', (req, res) => controller.list(req, res));
router.get('/counts', (req, res) => controller.counts(req, res));
router.post('/purge-all', (req, res) => controller.purgeAll(req, res));
router.post('/:entityType/:id/restore', (req, res) =>
  controller.restore(req, res),
);
router.post('/:entityType/:id/archive', (req, res) =>
  controller.archive(req, res),
);
router.delete('/:entityType/:id', (req, res) => controller.purge(req, res));

export default router;
