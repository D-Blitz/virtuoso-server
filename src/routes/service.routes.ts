import { Router } from 'express';
import { ServiceController } from '../controllers/service.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new ServiceController();

router.get('/', requirePermission('SERVICE_MANAGE'), (req, res) =>
  controller.getAll(req, res),
);
// N.7.14 — aggregated activity + revenue for the service UID page.
router.get('/:id/insights', requirePermission('SERVICE_MANAGE'), (req, res) =>
  controller.insights(req, res),
);
router.post('/', requirePermission('SERVICE_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requirePermission('SERVICE_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('SERVICE_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

export default router;
