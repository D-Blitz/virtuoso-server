import { Router } from 'express';
import { RoleController } from '../controllers/role.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new RoleController();

// All role CRUD is gated by ROLE_MANAGE (typically only Propriétaire).
router.get('/', requirePermission('ROLE_MANAGE'), (req, res) =>
  controller.list(req, res),
);
router.get('/:id', requirePermission('ROLE_MANAGE'), (req, res) =>
  controller.getById(req, res),
);
router.post('/', requirePermission('ROLE_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requirePermission('ROLE_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('ROLE_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

export default router;
