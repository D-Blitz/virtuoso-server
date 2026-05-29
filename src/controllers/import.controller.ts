// Admin-surface controller for CSV bulk import.
//
// Five endpoints, all gated by requirePermission (mounted via routes):
//   GET    /api/import/registry        — list importable entity types
//   GET    /api/import/template/:type  — download CSV template
//   GET    /api/import/export/:type    — download CSV of all rows
//   POST   /api/import/preview/:type   — dry-run, return per-row status
//   POST   /api/import/commit/:type    — write to the DB
//
// The preview + commit endpoints accept the CSV as a plain text
// body (Content-Type: text/csv or text/plain). We chose this over
// multipart/form-data because the payloads are textual + the admin
// UI parses the file client-side anyway.
//
// Earlier iterations also shipped a multi-file "all" surface and a
// unified single-CSV format. Both were dropped (May 2026) — admins
// found one-CSV-per-entity (via the import/export buttons on each
// list page) the clearest workflow.

import type { Request, Response } from 'express';

import { getOrganizationId } from '../auth/context';
import { sendError } from './httpErrors';
import {
  buildCsvTemplate,
  commitImport,
  exportEntityCsv,
  previewImport,
} from '../services/import/csvImport';
import { listImportSpecs } from '../services/import/registry';

function requireOrgId(res: Response): string | null {
  const orgId = getOrganizationId();
  if (!orgId) {
    res.status(401).json({ error: 'Missing organization context' });
    return null;
  }
  return orgId;
}

export class ImportController {
  /** GET /api/import/registry */
  list(_req: Request, res: Response) {
    try {
      res.json({ entities: listImportSpecs() });
    } catch (err) {
      sendError(res, err, 'Failed to list import registry');
    }
  }

  /** GET /api/import/template/:type — text/csv response */
  template(req: Request, res: Response) {
    try {
      const { type } = req.params;
      const csv = buildCsvTemplate(type);
      if (csv == null) {
        res.status(404).json({ error: `Unknown entity type: ${type}` });
        return;
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${type}-template.csv"`,
      );
      // BOM so Excel opens accented chars correctly on Windows.
      res.send('﻿' + csv);
    } catch (err) {
      sendError(res, err, 'Failed to build template');
    }
  }

  /** POST /api/import/preview/:type — body: raw CSV text */
  async preview(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const csvText = typeof req.body === 'string' ? req.body : '';
      if (csvText.trim().length === 0) {
        res.status(400).json({ error: 'CSV body is empty' });
        return;
      }
      const result = await previewImport({
        organizationId: orgId,
        entityType: req.params.type,
        csvText,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err, 'Failed to preview import');
    }
  }

  /** POST /api/import/commit/:type — body: raw CSV text */
  async commit(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const csvText = typeof req.body === 'string' ? req.body : '';
      if (csvText.trim().length === 0) {
        res.status(400).json({ error: 'CSV body is empty' });
        return;
      }
      const result = await commitImport({
        organizationId: orgId,
        entityType: req.params.type,
        csvText,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err, 'Failed to commit import');
    }
  }

  /** GET /api/import/export/:type — text/csv response (or 404). */
  async export(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const { type } = req.params;
      const csv = await exportEntityCsv({
        organizationId: orgId,
        entityType: type,
      });
      if (csv == null) {
        res.status(404).json({ error: `Unknown entity type: ${type}` });
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${type}-${stamp}.csv"`,
      );
      // BOM so Excel handles accented characters correctly on Windows.
      res.send('﻿' + csv);
    } catch (err) {
      sendError(res, err, 'Failed to export entity');
    }
  }
}
