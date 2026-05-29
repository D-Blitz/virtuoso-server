// CSV bulk-import admin routes.

import { Router, json, raw } from 'express';

import { ImportController } from '../controllers/import.controller';
import { requirePermission } from '../middleware/permission';

const router = Router();
const controller = new ImportController();

// Larger limit on the 'all' surfaces since one request can carry
// multiple CSVs concatenated as JSON.
const jsonBody = json({ limit: '50mb' });

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

// 'all' surfaces — dependency-ordered batch processing of one CSV
// per entity. Single endpoint accepts a JSON object with CSV
// strings keyed by entity type.
router.get('/all/types', requireImport, (req, res) =>
  controller.allTypes(req, res),
);
router.post('/all/preview', requireImport, jsonBody, (req, res) =>
  controller.previewAll(req, res),
);
router.post('/all/commit', requireImport, jsonBody, (req, res) =>
  controller.commitAll(req, res),
);

// Unified single-CSV surfaces — one file holds every entity, with a
// `type` column discriminating each row. Same body parsing scheme
// as the per-entity preview/commit routes (raw text/csv).
router.get('/unified/template', requireImport, (req, res) =>
  controller.unifiedTemplate(req, res),
);
router.get('/unified/export', requireImport, (req, res) =>
  controller.unifiedExport(req, res),
);
router.post(
  '/unified/preview',
  requireImport,
  csvBody,
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.body = req.body.toString('utf-8');
    }
    next();
  },
  (req, res) => controller.unifiedPreview(req, res),
);
router.post(
  '/unified/commit',
  requireImport,
  csvBody,
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.body = req.body.toString('utf-8');
    }
    next();
  },
  (req, res) => controller.unifiedCommit(req, res),
);

export default router;
