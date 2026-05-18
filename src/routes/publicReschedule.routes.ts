import { Router } from 'express';
import { PublicRescheduleController } from '../controllers/publicReschedule.controller';

const router = Router();
const controller = new PublicRescheduleController();

router.get('/:token', (req, res) => controller.get(req, res));
router.post('/:token/apply', (req, res) => controller.apply(req, res));

export default router;
