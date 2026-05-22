import { Router } from 'express';
import { ClosureController } from '../controllers/closure.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new ClosureController();

router.get('/', requirePermission('CLOSURE_MANAGE'), (req, res) =>
  controller.getAll(req, res),
);
router.post('/', requirePermission('CLOSURE_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requirePermission('CLOSURE_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('CLOSURE_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

export default router;
