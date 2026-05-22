import { Router } from 'express';
import { AnonymizeController } from '../controllers/anonymize.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new AnonymizeController();

// Phase 0.3: anonymize is the GDPR-aware destructive op on Client /
// Facilitator personal data. CLIENT_ANONYMIZE gates it across both
// types — the dedicated permission lets admins grant the capability
// to someone who can't otherwise CLIENT_MANAGE.
router.post(
  '/:entityType/:id',
  requirePermission('CLIENT_ANONYMIZE'),
  (req, res) => controller.anonymize(req, res),
);

export default router;
