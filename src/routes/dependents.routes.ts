import { Router } from 'express';
import { DependentsController } from '../controllers/dependents.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new DependentsController();

// Phase 0.3: dependents endpoint surfaces what FK-references a row —
// powers "this can't be deleted because X uses it" hints. Any user
// with ADMIN_ACCESS may consult it; it doesn't expose sensitive data.
router.get(
  '/:entityType/:id',
  requirePermission('ADMIN_ACCESS'),
  (req, res) => controller.list(req, res),
);

export default router;
