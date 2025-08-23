import { Router } from 'express';
import { ScheduledEventValidationController } from '@/controllers/validation/scheduledEventValidation.controller';

const router = Router();
const controller = new ScheduledEventValidationController();

router.post('/', controller.validate.bind(controller));

export default router;
