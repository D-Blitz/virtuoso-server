import { Request, Response } from 'express';
import {
  ARCHIVABLE_ENTITY_TYPES,
  ArchiveService,
  type ArchivableEntityType,
} from '../services/archive/archive.service';
import { sendError } from './httpErrors';

const archiveService = new ArchiveService();

const VALID_TYPES: Set<string> = new Set(ARCHIVABLE_ENTITY_TYPES);

function parsePagingInt(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Phase 0.3: the in-controller guardAdminOnly helper used to live here.
// It has been replaced by per-route `requirePermission(...)` middleware
// declared in `routes/archive.routes.ts`: ARCHIVE_ACCESS for view /
// unarchive / sendToTrash, PURGE_PERMANENTLY for the hard-delete.

function parseEntityType(
  raw: unknown,
  res: Response,
): ArchivableEntityType | null {
  if (typeof raw !== 'string' || !VALID_TYPES.has(raw)) {
    res.status(400).json({
      error: `Invalid entityType. Allowed: ${Array.from(VALID_TYPES).join(', ')}`,
    });
    return null;
  }
  return raw as ArchivableEntityType;
}

export class ArchiveController {
  /**
   * GET /api/archive?entityType=...&page=&pageSize=
   *
   * entityType=ALL returns the merged cross-type feed; any of the 6
   * concrete types returns only that type.
   */
  async list(req: Request, res: Response) {

    try {
      const page = parsePagingInt(req.query.page, 1);
      const pageSize = parsePagingInt(req.query.pageSize, 50);
      if (req.query.entityType === 'ALL') {
        const result = await archiveService.listAll({ page, pageSize });
        res.json(result);
        return;
      }
      const entityType = parseEntityType(req.query.entityType, res);
      if (!entityType) return;
      const result = await archiveService.list({ entityType, page, pageSize });
      res.json(result);
    } catch (err) {
      sendError(res, err, 'Failed to load archive');
    }
  }

  /** GET /api/archive/counts — counts per entity type. */
  async counts(_req: Request, res: Response) {

    try {
      const counts = await archiveService.countsByType();
      res.json({ counts });
    } catch (err) {
      sendError(res, err, 'Failed to load archive counts');
    }
  }

  /** POST /api/archive/:entityType/:id — archive an active row. */
  async archive(req: Request, res: Response) {

    try {
      const entityType = parseEntityType(req.params.entityType, res);
      if (!entityType) return;
      await archiveService.archive(entityType, req.params.id);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to archive');
    }
  }

  /** POST /api/archive/:entityType/:id/unarchive — restore archived. */
  async unarchive(req: Request, res: Response) {

    try {
      const entityType = parseEntityType(req.params.entityType, res);
      if (!entityType) return;
      await archiveService.unarchive(entityType, req.params.id);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to unarchive');
    }
  }

  /**
   * DELETE /api/archive/:entityType/:id — hard-delete from archive.
   * FK-blocked rows surface the same friendly summary as the trash
   * bin's purge (Client+Payment → "Anonymiser" guidance).
   *
   * The admin UI no longer calls this by default — `sendToTrash`
   * (below) is the friendlier path that gives a 30-day recovery
   * window. This endpoint stays for the cron and power-user flows.
   */
  async purge(req: Request, res: Response) {

    try {
      const entityType = parseEntityType(req.params.entityType, res);
      if (!entityType) return;
      await archiveService.purge(entityType, req.params.id);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to purge from archive');
    }
  }

  /**
   * POST /api/archive/:entityType/:id/trash — move an archived row
   * back into the trash bin, where the 30-day TTL applies again.
   * The admin's "Supprimer" button in /admin/archives points here.
   */
  async sendToTrash(req: Request, res: Response) {

    try {
      const entityType = parseEntityType(req.params.entityType, res);
      if (!entityType) return;
      await archiveService.sendToTrash(entityType, req.params.id);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to move archive to trash');
    }
  }
}
