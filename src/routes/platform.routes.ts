// Platform-operator routes — creating and administering organizations
// across the whole install.
//
// Gated by requirePlatformAdmin, which reads User.isPlatformAdmin from
// the database rather than trusting a session claim. Mounted under
// /api, so requireUser has already run and established the context.

import { Router } from 'express';

import { PlatformController } from '../controllers/platform.controller';
import { requirePlatformAdmin } from '../middleware/platform';

const router = Router();
const controller = new PlatformController();

router.use(requirePlatformAdmin);

router.get('/organizations', (req, res) =>
  controller.listOrganizations(req, res),
);
router.post('/organizations', (req, res) =>
  controller.createOrganization(req, res),
);

export default router;
