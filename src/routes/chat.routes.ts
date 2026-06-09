import { Router } from 'express';

import { ChatController } from '../controllers/chat.controller';

const router = Router();
const controller = new ChatController();

// M — chat center. Available to any authenticated user (it's messaging
// between colleagues); the parent app.use('/api', requireUser) already
// enforces auth. Membership is checked per-conversation in the service.

router.get('/users', (req, res) => controller.listUsers(req, res));

router.get('/conversations', (req, res) =>
  controller.listConversations(req, res),
);
router.post('/conversations/direct', (req, res) =>
  controller.createDirect(req, res),
);
router.post('/conversations/group', (req, res) =>
  controller.createGroup(req, res),
);
router.get('/conversations/:id', (req, res) =>
  controller.getConversation(req, res),
);
router.get('/conversations/:id/messages', (req, res) =>
  controller.getMessages(req, res),
);
router.post('/conversations/:id/messages', (req, res) =>
  controller.sendMessage(req, res),
);
router.post('/conversations/:id/read', (req, res) =>
  controller.markRead(req, res),
);

export default router;
