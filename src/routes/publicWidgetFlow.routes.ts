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

router.post(
  '/by-key/:publishableKey/runs/:runId/steps/:stepId/submit',
  requireWidgetFlow,
  (req, res) => controller.submitStep(req, res),
);

export default router;
