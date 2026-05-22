import { Router } from 'express';
import { TagController } from '../controllers/tag.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new TagController();

router.get('/', requirePermission('TAG_MANAGE'), (req, res) =>
  controller.getAll(req, res),
);
router.post('/', requirePermission('TAG_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requirePermission('TAG_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('TAG_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

export default router;
