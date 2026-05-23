import { Router } from 'express';
import { OrganizationController } from '../controllers/organization.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new OrganizationController();

// GET requires ADMIN_ACCESS — every admin user needs to see org
// settings (e.g. to know the TVA rate when manually building an
// invoice). PATCH requires ORG_MANAGE — only Propriétaire by default.
router.get('/me', requirePermission('ADMIN_ACCESS'), (req, res) =>
  controller.getMe(req, res),
);
router.patch('/me', requirePermission('ORG_MANAGE'), (req, res) =>
  controller.updateMe(req, res),
);

export default router;
