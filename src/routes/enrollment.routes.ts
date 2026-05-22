import { Router } from 'express';
import { EnrollmentController } from '../controllers/enrollment.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new EnrollmentController();

router.get('/', requirePermission('ENROLLMENT_MANAGE'), (req, res) =>
  controller.getAll(req, res),
);
router.post('/', requirePermission('ENROLLMENT_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requirePermission('ENROLLMENT_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('ENROLLMENT_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

export default router;
