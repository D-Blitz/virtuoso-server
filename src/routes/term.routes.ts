import { Router } from 'express';
import { TermController } from '../controllers/term.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new TermController();

router.get('/', requirePermission('TERM_MANAGE'), (req, res) =>
  controller.getAll(req, res),
);
router.post('/', requirePermission('TERM_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requirePermission('TERM_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('TERM_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

export default router;
