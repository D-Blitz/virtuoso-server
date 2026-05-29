// CSV bulk-import admin routes.

import { Router, raw } from 'express';

import { ImportController } from '../controllers/import.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new ImportController();

// Permission gate: imports change a lot of rows at once, so we gate
// on a broad write permission. Adjust as the permission model grows.
const requireImport = requirePermission('FACILITATOR_MANAGE');

// Body parser for the CSV endpoints — accept raw text up to a
// reasonable cap. Large imports (>10MB) would need streaming, which
// is a future enhancement.
const csvBody = raw({
  type: ['text/csv', 'text/plain', 'application/octet-stream'],
  limit: '10mb',
});

router.get('/registry', requireImport, (req, res) =>
  controller.list(req, res),
);

router.get('/template/:type', requireImport, (req, res) =>
  controller.template(req, res),
);

router.post(
  '/preview/:type',
  requireImport,
  csvBody,
  (req, res, next) => {
    // express raw() gives us a Buffer — convert to utf-8 string
    // before the controller sees it.
    if (Buffer.isBuffer(req.body)) {
      req.body = req.body.toString('utf-8');
    }
    next();
  },
  (req, res) => controller.preview(req, res),
);

router.post(
  '/commit/:type',
  requireImport,
  csvBody,
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.body = req.body.toString('utf-8');
    }
    next();
  },
  (req, res) => controller.commit(req, res),
);

// Export — round-trips back through commit so admins can edit
// existing rows in a spreadsheet + re-upload.
router.get('/export/:type', requireImport, (req, res) =>
  controller.export(req, res),
);

export default router;
