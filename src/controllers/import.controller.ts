// Admin-surface controller for CSV bulk import.
//
// Four endpoints, all gated by requirePermission (mounted via routes):
//   GET    /api/import/registry        — list importable entity types
//   GET    /api/import/template/:type  — download CSV template
//   POST   /api/import/preview/:type   — dry-run, return per-row status
//   POST   /api/import/commit/:type    — write to the DB
//
// The preview + commit endpoints accept the CSV as a plain text
// body (Content-Type: text/csv or text/plain). We chose this over
// multipart/form-data because the payloads are textual + the admin
// UI parses the file client-side anyway.

import type { Request, Response } from 'express';

import { getOrganizationId } from '../auth/context';
import { sendError } from './httpErrors';
import {
  buildCsvTemplate,
  commitImport,
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
}
