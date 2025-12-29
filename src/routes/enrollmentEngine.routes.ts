import { Router } from 'express';
import { EnrollmentEngineController } from '../controllers/enrollmentEngine.controller';

const router = Router();
const controller = new EnrollmentEngineController();

router.post('/quote', (req, res) => controller.quote(req, res));
router.post('/:id/generate-events', (req, res) => controller.generateEvents(req, res));
router.delete('/:id/events', (req, res) =>
  controller.deleteEventsForEnrollment(req, res),
);

export default router;
