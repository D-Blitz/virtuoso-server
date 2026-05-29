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
  buildUnifiedTemplate,
  commitAll,
  commitImport,
  commitUnifiedCsv,
  exportEntityCsv,
  exportUnifiedCsv,
  listAllEntityTypes,
  previewAll,
  previewImport,
  previewUnifiedCsv,
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

  /**
   * GET /api/import/all/types — return the dependency-ordered list
   * of entity types the 'all' surfaces operate on. Used by the
   * admin UI to render one upload row per entity.
   */
  allTypes(_req: Request, res: Response) {
    try {
      res.json({ types: listAllEntityTypes() });
    } catch (err) {
      sendError(res, err, 'Failed to list all-import types');
    }
  }

  /**
   * POST /api/import/all/preview — body: { [entityType]: csvText }
   * Dry-run every provided file in dependency order, return a
   * per-type preview result map.
   */
  async previewAll(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const payloads = (req.body ?? {}) as Record<string, string>;
      if (typeof payloads !== 'object' || payloads == null) {
        res.status(400).json({ error: 'Body must be an object of CSV strings keyed by entity type' });
        return;
      }
      const results = await previewAll({
        organizationId: orgId,
        payloads,
      });
      res.json({ results });
    } catch (err) {
      sendError(res, err, 'Failed to preview all');
    }
  }

  /** POST /api/import/all/commit — body: { [entityType]: csvText } */
  async commitAll(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const payloads = (req.body ?? {}) as Record<string, string>;
      if (typeof payloads !== 'object' || payloads == null) {
        res.status(400).json({ error: 'Body must be an object of CSV strings keyed by entity type' });
        return;
      }
      const results = await commitAll({
        organizationId: orgId,
        payloads,
      });
      res.json({ results });
    } catch (err) {
      sendError(res, err, 'Failed to commit all');
    }
  }

  // ─── Unified single-CSV surfaces ─────────────────────────────
  //
  // One CSV file holds rows for every entity type, discriminated by
  // a leading `type` column. Export produces it from the DB; preview
  // + commit parse + route per row.

  /** GET /api/import/unified/template */
  unifiedTemplate(_req: Request, res: Response) {
    try {
      const csv = buildUnifiedTemplate();
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="all-entities-template.csv"`,
      );
      res.send('﻿' + csv);
    } catch (err) {
      sendError(res, err, 'Failed to build unified template');
    }
  }

  /** GET /api/import/unified/export */
  async unifiedExport(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const csv = await exportUnifiedCsv({ organizationId: orgId });
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="all-entities-${stamp}.csv"`,
      );
      res.send('﻿' + csv);
    } catch (err) {
      sendError(res, err, 'Failed to export unified CSV');
    }
  }

  /** POST /api/import/unified/preview — body: raw CSV text */
  async unifiedPreview(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const csvText = typeof req.body === 'string' ? req.body : '';
      if (csvText.trim().length === 0) {
        res.status(400).json({ error: 'CSV body is empty' });
        return;
      }
      const result = await previewUnifiedCsv({
        organizationId: orgId,
        csvText,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err, 'Failed to preview unified CSV');
    }
  }

  /** POST /api/import/unified/commit — body: raw CSV text */
  async unifiedCommit(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const csvText = typeof req.body === 'string' ? req.body : '';
      if (csvText.trim().length === 0) {
        res.status(400).json({ error: 'CSV body is empty' });
        return;
      }
      const result = await commitUnifiedCsv({
        organizationId: orgId,
        csvText,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err, 'Failed to commit unified CSV');
    }
  }
}
