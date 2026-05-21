import { Request, Response } from 'express';
import { getContext } from '../auth/context';
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

/**
 * Same admin-only guard as the trash controller. Archive is a sensitive
 * surface: it shows organization-wide rows the school has retired but
 * preserved — visible only to OWNER/ADMIN until the Phase 0.3
 * permission system formalizes a dedicated `can_manage_archive`.
 */
function guardAdminOnly(res: Response): boolean {
  const ctx = getContext();
  const role = ctx?.role;
  if (role !== 'OWNER' && role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

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
    if (!guardAdminOnly(res)) return;
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
    if (!guardAdminOnly(res)) return;
    try {
      const counts = await archiveService.countsByType();
      res.json({ counts });
    } catch (err) {
      sendError(res, err, 'Failed to load archive counts');
    }
  }

  /** POST /api/archive/:entityType/:id — archive an active row. */
  async archive(req: Request, res: Response) {
    if (!guardAdminOnly(res)) return;
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
    if (!guardAdminOnly(res)) return;
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
   */
  async purge(req: Request, res: Response) {
    if (!guardAdminOnly(res)) return;
    try {
      const entityType = parseEntityType(req.params.entityType, res);
      if (!entityType) return;
      await archiveService.purge(entityType, req.params.id);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to purge from archive');
    }
  }
}
