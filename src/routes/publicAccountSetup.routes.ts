// Public "set your own password" endpoints.
//
// Unauthenticated by nature: the single-use token in the URL is the
// proof. Mounted under /api/public so it sits OUTSIDE the requireUser
// gate — the whole point is that the visitor has no session yet, and in
// the invite case no password to make one with.

import { Router } from 'express';

import { PlatformController } from '../controllers/platform.controller';

const router = Router();
const controller = new PlatformController();

router.get('/:token', (req, res) => controller.inspectSetupToken(req, res));
router.post('/:token', (req, res) => controller.completeSetup(req, res));

export default router;
