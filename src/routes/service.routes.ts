
import { Router } from 'express';
import { ServiceController } from '../controllers/service.controller';

const router = Router();
const controller = new ServiceController();

router.post('/', (req, res) => controller.create(req, res));
router.get('/', (req, res) => controller.getAll(req, res));
router.put('/:id', (req, res) => controller.update(req, res));
router.delete('/:id', (req, res) => controller.remove(req, res));

export default router;