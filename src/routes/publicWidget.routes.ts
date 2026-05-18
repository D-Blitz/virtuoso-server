import { Router } from 'express';
import { requireWidget } from '../middleware/widget';
import { PublicWidgetController } from '../controllers/publicWidget.controller';

const router = Router();
const controller = new PublicWidgetController();

router.get(
  '/by-key/:publishableKey/config',
  requireWidget,
  (req, res) => controller.getConfig(req, res),
);

router.post(
  '/by-key/:publishableKey/recommendations',
  requireWidget,
  (req, res) => controller.recommendations(req, res),
);

router.get(
  '/by-key/:publishableKey/availability',
  requireWidget,
  (req, res) => controller.availability(req, res),
);

router.post(
  '/by-key/:publishableKey/holds',
  requireWidget,
  (req, res) => controller.createHold(req, res),
);

router.delete(
  '/by-key/:publishableKey/holds/:holdId',
  requireWidget,
  (req, res) => controller.releaseHold(req, res),
);

router.post(
  '/by-key/:publishableKey/trial-bookings',
  requireWidget,
  (req, res) => controller.createTrialBooking(req, res),
);

router.get(
  '/by-key/:publishableKey/trial-bookings/:submissionId',
  requireWidget,
  (req, res) => controller.getTrialBooking(req, res),
);

export default router;
