import { Router } from 'express';
import { RoomController } from '../controllers/room.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new RoomController();

router.get('/', requirePermission('ROOM_MANAGE'), (req, res) =>
  controller.getAll(req, res),
);
router.post('/', requirePermission('ROOM_MANAGE'), (req, res) =>
  controller.create(req, res),
);
router.put('/:id', requirePermission('ROOM_MANAGE'), (req, res) =>
  controller.update(req, res),
);
router.delete('/:id', requirePermission('ROOM_MANAGE'), (req, res) =>
  controller.remove(req, res),
);

export default router;
