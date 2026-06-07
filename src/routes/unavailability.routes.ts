import { Router } from 'express';
import { UnavailabilityController } from '../controllers/unavailability.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new UnavailabilityController();

// Reads: any admin who can see the calendar. The unavailability block IS
// part of the calendar.
router.get('/', requirePermission('EVENT_VIEW'), (req, res) =>
  controller.list(req, res),
);

// Mutations: EVENT_MANAGE_ALL. Scoped (per-facilitator) management is a
// future refinement; for v1 anyone editing the schedule edits blocks too.
router.post('/', requirePermission('EVENT_MANAGE_ALL'), (req, res) =>
  controller.create(req, res),
);
router.patch('/:id', requirePermission('EVENT_MANAGE_ALL'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('EVENT_MANAGE_ALL'), (req, res) =>
  controller.remove(req, res),
);

export default router;
