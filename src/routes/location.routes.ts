import { Router } from 'express';
import { LocationController } from '../controllers/location.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new LocationController();

router.get('/', requirePermission('LOCATION_MANAGE'), (req, res) =>
  controller.getAll(req, res),
);
// N.6.9 — aggregated activity + revenue for the location UID page.
router.get('/:id/insights', requirePermission('LOCATION_MANAGE'), (req, res) =>
  controller.insights(req, res),
);
router.post('/', requirePermission('LOCATION_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requirePermission('LOCATION_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('LOCATION_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

export default router;
