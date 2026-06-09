import { Router } from 'express';

import { MessageController } from '../controllers/message.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new MessageController();

// M.2 — messaging center. VIEW gates reading the history + templates;
// SEND gates composing/sending and managing templates.

// Templates — declared before '/:id'-style routes (none here) and
// before the history list so the literal segment can't be shadowed.
router.get('/templates', requirePermission('MESSAGE_VIEW'), (req, res) =>
  controller.listTemplates(req, res),
);
router.post('/templates', requirePermission('MESSAGE_SEND'), (req, res) =>
  controller.createTemplate(req, res),
);
router.patch('/templates/:id', requirePermission('MESSAGE_SEND'), (req, res) =>
  controller.updateTemplate(req, res),
);
router.delete('/templates/:id', requirePermission('MESSAGE_SEND'), (req, res) =>
  controller.deleteTemplate(req, res),
);

// Send + history.
router.post('/send', requirePermission('MESSAGE_SEND'), (req, res) =>
  controller.send(req, res),
);
router.get('/', requirePermission('MESSAGE_VIEW'), (req, res) =>
  controller.list(req, res),
);

export default router;
