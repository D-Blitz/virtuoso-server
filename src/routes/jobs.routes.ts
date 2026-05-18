import { Router } from 'express';
import { JobsController } from '../controllers/jobs.controller';

const router = Router();
const controller = new JobsController();

router.post('/run-invite-cycle', (req, res) => controller.runInviteCycle(req, res));
router.post('/enrollment-invites/:id/resend', (req, res) =>
  controller.resendInvite(req, res),
);

export default router;
