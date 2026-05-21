import { Router } from 'express';
import { AnonymizeController } from '../controllers/anonymize.controller';

const router = Router();
const controller = new AnonymizeController();

router.post('/:entityType/:id', (req, res) => controller.anonymize(req, res));

export default router;
