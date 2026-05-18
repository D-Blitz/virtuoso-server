import { Router } from 'express';
import { WidgetController } from '../controllers/widget.controller';

const router = Router();
const controller = new WidgetController();

router.get('/', (req, res) => controller.list(req, res));
router.post('/', (req, res) => controller.create(req, res));
router.get('/:id', (req, res) => controller.getById(req, res));
router.put('/:id', (req, res) => controller.update(req, res));
router.delete('/:id', (req, res) => controller.remove(req, res));

router.post('/:id/publish', (req, res) => controller.publish(req, res));
router.post('/:id/unpublish', (req, res) => controller.unpublish(req, res));

export default router;
