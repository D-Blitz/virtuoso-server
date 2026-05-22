import { Router } from 'express';
import { EnrollmentEngineController } from '../controllers/enrollmentEngine.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new EnrollmentEngineController();

// Quote is a pure simulation — read-only, gated by ENROLLMENT_MANAGE
// since callers always pair it with create/edit flows.
router.post('/quote', requirePermission('ENROLLMENT_MANAGE'), (req, res) =>
  controller.quote(req, res),
);
router.post(
  '/:id/generate-events',
  requirePermission('ENROLLMENT_MANAGE'),
  (req, res) => controller.generateEvents(req, res),
);
router.delete(
  '/:id/events',
  requirePermission('ENROLLMENT_MANAGE'),
  (req, res) => controller.deleteEventsForEnrollment(req, res),
);

export default router;
