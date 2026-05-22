import { Router } from 'express';
import { ScheduledEventController } from '../controllers/scheduledEvent.controller';
import {
  requirePermission,
  requireEventManage,
} from '../middleware/permission';

const router = Router();
const controller = new ScheduledEventController();

// Reads: EVENT_VIEW. Writes: gated by requireEventManage which prefers
// EVENT_MANAGE_ALL but falls back to EVENT_MANAGE_SCOPED + a
// UserPermissionScope check against the event's facilitators. POST
// has no event id to inspect so the middleware lets it through and
// the controller re-checks against the request body via
// assertEventManageable() (see middleware/permission.ts).
router.get('/', requirePermission('EVENT_VIEW'), (req, res) =>
  controller.getAll(req, res),
);
router.post('/', requireEventManage(), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requireEventManage(), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requireEventManage(), (req, res) =>
  controller.remove(req, res),
);

export default router;
