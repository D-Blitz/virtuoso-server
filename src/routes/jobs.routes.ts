import { Router } from 'express';
import { JobsController } from '../controllers/jobs.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new JobsController();

// Phase 0.3: manual cron triggers are owner-level — ORG_MANAGE is the
// proxy for "this person can run platform jobs against the whole org".
router.post(
  '/run-invite-cycle',
  requirePermission('ORG_MANAGE'),
  (req, res) => controller.runInviteCycle(req, res),
);
router.get(
  '/diagnose-invites',
  requirePermission('ORG_MANAGE'),
  (req, res) => controller.diagnoseInvites(req, res),
);
router.post(
  '/enrollment-invites/:id/resend',
  requirePermission('ENROLLMENT_MANAGE'),
  (req, res) => controller.resendInvite(req, res),
);

export default router;
