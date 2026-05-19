import { Router } from 'express';
import { PaymentController } from '../controllers/payment.controller';

const router = Router();
const controller = new PaymentController();

router.get('/', (req, res) => controller.list(req, res));
router.get('/stats', (req, res) => controller.stats(req, res));

export default router;
