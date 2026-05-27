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

export default router;
