import { Router } from 'express';
import { AuditLogController } from '../controllers/auditLog.controller';

const router = Router();
const controller = new AuditLogController();

router.get('/', (req, res) => controller.recent(req, res));
router.get('/:entityType/:entityId', (req, res) =>
  controller.forEntity(req, res),
);

export default router;
