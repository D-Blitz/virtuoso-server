import { Router } from 'express';
import { AuditLogController } from '../controllers/auditLog.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new AuditLogController();

router.get('/', requirePermission('AUDIT_LOG_VIEW'), (req, res) =>
  controller.recent(req, res),
);
router.get(
  '/:entityType/:entityId',
  requirePermission('AUDIT_LOG_VIEW'),
  (req, res) => controller.forEntity(req, res),
);

export default router;
