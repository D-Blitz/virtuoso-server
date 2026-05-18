import { Router } from 'express';
import { WebhookController } from '../controllers/webhook.controller';

const router = Router();
const controller = new WebhookController();

// The raw body parser for this route is mounted in `src/index.ts` before
// `express.json()` so signature verification has the unparsed bytes.
router.post('/stripe', (req, res) => controller.stripe(req, res));

export default router;
