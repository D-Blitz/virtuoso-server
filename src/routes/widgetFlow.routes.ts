import { Router } from 'express';
import { WidgetFlowController } from '../controllers/widgetFlow.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new WidgetFlowController();

// All admin engine endpoints require WIDGET_MANAGE — the same
// permission that gates the legacy BookingWidget admin. Splitting into
// a more granular FLOW_MANAGE permission can come later if we want
// admins to manage flows without legacy widgets (or vice-versa).

// Import takes precedence over /:id/... routes via Express's first-
// match policy. Keep the literal /import path BEFORE any /:id route
// to avoid the import body being parsed as an id.
router.post('/import', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.importFlow(req, res),
);

router.get('/', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.list(req, res),
);
router.post('/', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.create(req, res),
);

router.get('/:id', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.getById(req, res),
);
router.delete('/:id', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

router.get('/:id/draft', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.getDraft(req, res),
);
router.patch('/:id/draft', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.patchDraft(req, res),
);

router.post('/:id/publish', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.publish(req, res),
);

router.get('/:id/export', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.exportFlow(req, res),
);

export default router;
