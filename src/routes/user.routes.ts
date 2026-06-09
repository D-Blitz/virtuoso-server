import { Router } from 'express';
import { UserController } from '../controllers/user.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new UserController();

// GET /api/users/me — the only User endpoint that any authenticated
// user can call (no USER_MANAGE required). Returns the caller's
// profile + their resolved permission set; powers the frontend
// useCurrentUser hook from Phase 0.3 Step 5.
router.get('/me', (req, res) => controller.me(req, res));

// N.9 — self-service UI preferences (theme + interface language).
// No USER_MANAGE gate: a user edits only their own row, and the
// target userId comes from the auth context, not the URL/body. Sits
// above the '/:id' routes so "me" can't be swallowed as an id param.
router.get('/me/preferences', (req, res) =>
  controller.getMyPreferences(req, res),
);
router.patch('/me/preferences', (req, res) =>
  controller.updateMyPreferences(req, res),
);

// All other User endpoints are gated by USER_MANAGE.
router.get('/', requirePermission('USER_MANAGE'), (req, res) =>
  controller.list(req, res),
);
router.get('/:id', requirePermission('USER_MANAGE'), (req, res) =>
  controller.getById(req, res),
);
router.post('/', requirePermission('USER_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requirePermission('USER_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.post(
  '/:id/password',
  requirePermission('USER_MANAGE'),
  (req, res) => controller.changePassword(req, res),
);
router.post(
  '/:id/disable',
  requirePermission('USER_MANAGE'),
  (req, res) => controller.disable(req, res),
);
router.post(
  '/:id/reactivate',
  requirePermission('USER_MANAGE'),
  (req, res) => controller.reactivate(req, res),
);

export default router;
