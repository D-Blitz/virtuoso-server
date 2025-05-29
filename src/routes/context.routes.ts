import { Router } from 'express';
import { ContextController } from '../controllers/context.controller';

const router = Router();
const controller = new ContextController();

router.get('/', (req, res) => controller.get(req, res));
router.post('/', (req, res) => controller.create(req, res));
router.put('/:id', (req, res) => controller.update(req, res));
router.delete('/:id', (req, res) => controller.remove(req, res));

export default router;
