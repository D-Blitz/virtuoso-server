import { Router } from 'express';
import { BillingIdentityController } from '../controllers/billingIdentity.controller';
import { requirePermission } from '../middleware/permission';

/**
 * Phase A — billing identities.
 *
 * Reads are gated on ADMIN_ACCESS: identities are not secret (they print
 * on every invoice) and both the parametres screen and the facilitator
 * form need to read them, so the broadest "is an admin user" gate avoids
 * locking out either editor. Writes map to the natural management
 * permission for where each identity is edited:
 *   - SCHOOL identity      → ORG_MANAGE       (edited in /admin/parametres)
 *   - FACILITATOR identity → FACILITATOR_MANAGE (edited in the teacher form)
 *
 * Both writes are PUT with create-or-update semantics (singletons), so
 * there is no separate POST/DELETE.
 */
const router = Router();
const controller = new BillingIdentityController();

router.get('/', requirePermission('ADMIN_ACCESS'), (req, res) =>
  controller.list(req, res),
);

router.get('/school', requirePermission('ADMIN_ACCESS'), (req, res) =>
  controller.getSchool(req, res),
);
router.put('/school', requirePermission('ORG_MANAGE'), (req, res) =>
  controller.upsertSchool(req, res),
);

router.get(
  '/facilitator/:facilitatorId',
  requirePermission('ADMIN_ACCESS'),
  (req, res) => controller.getForFacilitator(req, res),
);
router.put(
  '/facilitator/:facilitatorId',
  requirePermission('FACILITATOR_MANAGE'),
  (req, res) => controller.upsertForFacilitator(req, res),
);

export default router;
