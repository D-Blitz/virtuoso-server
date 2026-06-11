import { Router } from 'express';

import { NotificationController } from '../controllers/notification.controller';

const router = Router();
const controller = new NotificationController();

// N — in-app notification center. Any authenticated user; rows are
// always scoped to the caller in the service.

router.get('/', (req, res) => controller.list(req, res));
router.get('/unread-count', (req, res) => controller.unreadCount(req, res));
router.post('/read', (req, res) => controller.markRead(req, res));
router.post('/read-all', (req, res) => controller.markAllRead(req, res));

export default router;
