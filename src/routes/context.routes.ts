import { Router } from 'express';
import { ContextController } from '../controllers/context.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new ContextController();

// Phase 0.3: /api/context is the "current user + org" identity
// endpoint. Any authenticated user with ADMIN_ACCESS may read; only
// ORG_MANAGE may mutate org settings via this surface.
router.get('/', requirePermission('ADMIN_ACCESS'), (req, res) =>
  controller.get(req, res),
);
router.post('/', requirePermission('ORG_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requirePermission('ORG_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('ORG_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

export default router;
