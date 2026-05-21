import { Router } from 'express';
import { DependentsController } from '../controllers/dependents.controller';

const router = Router();
const controller = new DependentsController();

router.get('/:entityType/:id', (req, res) => controller.list(req, res));

export default router;
