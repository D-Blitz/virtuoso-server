import { Router } from 'express';
import { PublicInviteController } from '../controllers/publicInvite.controller';

const router = Router();
const controller = new PublicInviteController();

// Token-scoped public routes — no user auth, no publishable key.
// The opaque single-use token is the access credential.
router.get('/:token', (req, res) => controller.get(req, res));
router.post('/:token/checkout', (req, res) => controller.checkout(req, res));

export default router;
