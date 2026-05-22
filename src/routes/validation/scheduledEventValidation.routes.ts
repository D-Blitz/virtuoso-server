import { Router } from 'express';
import { ScheduledEventValidationController } from '@/controllers/validation/scheduledEventValidation.controller';
import { requirePermission } from '@/middleware/permission';

const router = Router();
const controller = new ScheduledEventValidationController();

// Read-only conflict checker. EVENT_VIEW is enough since the response
// doesn't change any state — write checks gate at the actual mutate
// routes.
router.post('/', requirePermission('EVENT_VIEW'), controller.validate.bind(controller));

export default router;
