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
// N.6.9 — org-wide aggregated dashboard payload for /admin/dashboard.
router.get('/me/insights', requirePermission('ADMIN_ACCESS'), (req, res) =>
  controller.insights(req, res),
);

export default router;
