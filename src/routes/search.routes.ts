import { Router } from 'express';
import { SearchController } from '../controllers/search.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new SearchController();

// Any admin gets to use the navbar search. The PER-KIND result groups are
// filtered inside the service against the user's permission set — a user
// without PAYMENT_VIEW sees no payment hits, etc.
router.get('/', requirePermission('ADMIN_ACCESS'), (req, res) =>
  controller.search(req, res),
);

export default router;
