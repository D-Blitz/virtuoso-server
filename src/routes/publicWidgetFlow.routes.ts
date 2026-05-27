import { Router } from 'express';
import { PublicWidgetFlowController } from '../controllers/publicWidgetFlow.controller';
import { requireWidgetFlow } from '../middleware/widgetFlow';

const router = Router();
const controller = new PublicWidgetFlowController();

// All public engine endpoints resolve a flow via :publishableKey and
// run inside that flow's org context (see requireWidgetFlow).

router.post('/by-key/:publishableKey/runs', requireWidgetFlow, (req, res) =>
  controller.createRun(req, res),
);

router.get(
  '/by-key/:publishableKey/runs/:runId',
  requireWidgetFlow,
  (req, res) => controller.getRun(req, res),
);

// Phase 3.4 — visitor-facing entity list for ENTITY_REF fields. Scoped
// to the flow's organization via requireWidgetFlow; the entity
// registry's safeFields whitelist gates which fields are exposed.
router.get(
  '/by-key/:publishableKey/entities/:entityType',
  requireWidgetFlow,
  (req, res) => controller.listEntities(req, res),
);

// Phase 3.1 — v2 canonical submit URL: nodes/:nodeId
router.post(
  '/by-key/:publishableKey/runs/:runId/nodes/:nodeId/submit',
  requireWidgetFlow,
  (req, res) => controller.submitNode(req, res),
);

// Legacy v1 alias: steps/:stepId — same handler, the controller
// reads either param. Kept until the visitor renderer is updated +
// any embeds in the wild migrate to the new URL.
router.post(
  '/by-key/:publishableKey/runs/:runId/steps/:stepId/submit',
  requireWidgetFlow,
  (req, res) => controller.submitNode(req, res),
);

// Phase 3.2b — resume a paused run via a single-use token URL.
// Distinct from the publishable-key-scoped routes above: the token
// itself encodes which flow + run to resume, so requireWidgetFlow
// isn't appropriate here. The controller resolves the org context
// from the token's run row.
//
// GET (idempotency via the token's `consumed` flag) so the URL
// works in email clients that pre-fetch links + on any plain click.
router.get(
  '/resume/:tokenId',
  (req, res) => controller.consumeResume(req, res),
);

export default router;
