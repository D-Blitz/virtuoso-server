import { Router } from 'express';
import { WidgetController } from '../controllers/widget.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new WidgetController();

router.get('/', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.list(req, res),
);
router.post('/', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.get('/:id', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.getById(req, res),
);
router.put('/:id', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

router.post('/:id/publish', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.publish(req, res),
);
router.post('/:id/unpublish', requirePermission('WIDGET_MANAGE'), (req, res) =>
  controller.unpublish(req, res),
);

export default router;
