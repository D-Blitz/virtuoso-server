import { Request, Response } from 'express';
import { getContext } from '../auth/context';
import {
  SOFT_DELETABLE_ENTITY_TYPES,
  TrashService,
  type SoftDeletableEntityType,
} from '../services/trash/trash.service';
import {
  ARCHIVABLE_ENTITY_TYPES,
  type ArchivableEntityType,
} from '../services/archive/archive.service';
import { transitionTrashToArchive } from '../services/archive/archive';
import { auditLog } from '../services/audit/audit.service';
import {
  snapshotClient,
  snapshotFacilitator,
  snapshotLocation,
  snapshotRoom,
  snapshotScheduledEvent,
  snapshotService,
  snapshotTerm,
} from '../services/audit/snapshots';
import { sendError } from './httpErrors';

const ARCHIVABLE_TYPE_SET = new Set<string>(ARCHIVABLE_ENTITY_TYPES);

function snapshotterForArchive(
  entityType: ArchivableEntityType,
): (row: any) => object | null {
  switch (entityType) {
    case 'Client':
      return snapshotClient;
    case 'Facilitator':
      return snapshotFacilitator;
    case 'Term':
      return snapshotTerm;
    case 'Service':
      return snapshotService;
    case 'Location':
      return snapshotLocation;
    case 'Room':
      return snapshotRoom;
    case 'ScheduledEvent':
      return snapshotScheduledEvent;
  }
}

const trashService = new TrashService();

const VALID_TYPES: Set<string> = new Set(SOFT_DELETABLE_ENTITY_TYPES);

function parsePagingInt(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Trash is sensitive: shows soft-deleted rows from across the org.
 * Restrict to OWNER/ADMIN until the Phase 0.3 permission system
 * formalizes a `can_manage_trash` permission.
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
): SoftDeletableEntityType | null {
  if (typeof raw !== 'string' || !VALID_TYPES.has(raw)) {
    res.status(400).json({
      error: `Invalid entityType. Allowed: ${Array.from(VALID_TYPES).join(', ')}`,
    });
    return null;
  }
  return raw as SoftDeletableEntityType;
}

export class TrashController {
  /**
   * GET /api/trash?entityType=...&page=&pageSize=
   *
   * entityType=ALL returns a merged cross-type feed; any of the 12
   * concrete types returns only that type. Restore + purge endpoints
   * never accept ALL — those always target one row of one type.
   */
  async list(req: Request, res: Response) {
    if (!guardAdminOnly(res)) return;
    try {
      const page = parsePagingInt(req.query.page, 1);
      const pageSize = parsePagingInt(req.query.pageSize, 50);
      if (req.query.entityType === 'ALL') {
        const result = await trashService.listAll({ page, pageSize });
        res.json(result);
        return;
      }
      const entityType = parseEntityType(req.query.entityType, res);
      if (!entityType) return;
      const result = await trashService.list({ entityType, page, pageSize });
      res.json(result);
    } catch (err) {
      console.error('trash list error:', err);
      res.status(500).json({ error: 'Failed to load trash' });
    }
  }

  /** GET /api/trash/counts — counts per entity type. */
  async counts(_req: Request, res: Response) {
    if (!guardAdminOnly(res)) return;
    try {
      const counts = await trashService.countsByType();
      res.json({ counts });
    } catch (err) {
      console.error('trash counts error:', err);
      res.status(500).json({ error: 'Failed to load trash counts' });
    }
  }

  /**
   * POST /api/trash/:entityType/:id/restore?scope=THIS|ALL
   *
   * `scope` defaults to THIS (single-row restore). `scope=ALL` is only
   * valid for ScheduledEvent ids that belong to a series and triggers a
   * cascading restore of the parent RecurrenceSeries + all sibling
   * trashed events.
   */
  async restore(req: Request, res: Response) {
    if (!guardAdminOnly(res)) return;
    try {
      const entityType = parseEntityType(req.params.entityType, res);
      if (!entityType) return;
      const scope = req.query.scope === 'ALL' ? 'ALL' : 'THIS';
      if (scope === 'ALL') {
        if (entityType !== 'ScheduledEvent') {
          res.status(400).json({
            error: 'scope=ALL is only supported for ScheduledEvent.',
          });
          return;
        }
        const result = await trashService.restoreSeriesFromEvent(
          req.params.id,
        );
        res.json(result);
        return;
      }
      await trashService.restore(entityType, req.params.id);
      res.status(204).send();
    } catch (err: any) {
      console.error('trash restore error:', err);
      const msg = err?.message ?? 'Failed to restore';
      const status = msg.toLowerCase().includes('no trashed') ? 404 : 500;
      res.status(status).json({ error: msg });
    }
  }

  /**
   * DELETE /api/trash/:entityType/:id?scope=THIS|ALL
   *
   * scope=ALL cascades for series-related rows:
   *   - ScheduledEvent with a seriesId → purges the parent series row
   *     (if also trashed) + every trashed sibling event.
   *   - RecurrenceSeries → purges the series + every trashed event of
   *     the series.
   * scope=ALL on any other entity type returns 400.
   */
  async purge(req: Request, res: Response) {
    if (!guardAdminOnly(res)) return;
    try {
      const entityType = parseEntityType(req.params.entityType, res);
      if (!entityType) return;
      const scope = req.query.scope === 'ALL' ? 'ALL' : 'THIS';
      if (scope === 'ALL') {
        if (
          entityType !== 'ScheduledEvent' &&
          entityType !== 'RecurrenceSeries'
        ) {
          res.status(400).json({
            error:
              'scope=ALL is only supported for ScheduledEvent and RecurrenceSeries.',
          });
          return;
        }
        const result = await trashService.purgeSeriesCascade({
          entityType,
          id: req.params.id,
        });
        res.json(result);
        return;
      }
      await trashService.purge(entityType, req.params.id);
      res.status(204).send();
    } catch (err) {
      // sendError now handles every case we care about:
      //   - Prisma KnownRequestError (P2025/P2003/P2002)
      //   - Prisma UnknownRequestError + raw ConnectorError (FK
      //     violation pattern in the message → 409 with the same
      //     friendly summary as the Known variant). This is what
      //     fired on the Client+Payment hard-delete: Prisma was
      //     emitting Unknown, so the old `instanceof Known` check
      //     missed it.
      //   - Manual policy throws (no trashed / paiement / anonymiser)
      sendError(res, err, 'La suppression définitive a échoué.');
    }
  }

  /**
   * POST /api/trash/:entityType/:id/archive
   *
   * Move a trashed row directly into archive — used by the "Archiver
   * à la place" fallback when a hard-delete is blocked by an FK
   * constraint. Atomic via `transitionTrashToArchive`: clears
   * deletedAt + sets archivedAt in a single updateMany so the row
   * never appears in the active list (which it would briefly do if
   * the admin did restore-then-archive in two calls).
   *
   * Only valid for archivable entity types (Client, Facilitator,
   * Term, Service, Location, Room). Non-archivable types return 400.
   */
  async archive(req: Request, res: Response) {
    if (!guardAdminOnly(res)) return;
    try {
      const entityType = parseEntityType(req.params.entityType, res);
      if (!entityType) return;
      if (!ARCHIVABLE_TYPE_SET.has(entityType)) {
        res.status(400).json({
          summary: 'Ce type d’élément ne peut pas être archivé.',
          error: `Archive is only supported for ${Array.from(
            ARCHIVABLE_TYPE_SET,
          ).join(', ')}.`,
        });
        return;
      }
      const archivable = entityType as ArchivableEntityType;
      const modelName =
        archivable.charAt(0).toLowerCase() + archivable.slice(1);
      const before = await transitionTrashToArchive(
        modelName,
        req.params.id,
        getContext()?.email ?? 'unknown',
      );
      const snap = snapshotterForArchive(archivable);
      void auditLog.record({
        action: 'UPDATE',
        entityType: archivable,
        entityId: req.params.id,
        before: snap(before),
      });
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to archive from trash');
    }
  }

  /** POST /api/trash/purge-all — empty the whole trash. Destructive. */
  async purgeAll(_req: Request, res: Response) {
    if (!guardAdminOnly(res)) return;
    try {
      const result = await trashService.purgeAll();
      res.json(result);
    } catch (err) {
      console.error('trash purgeAll error:', err);
      res.status(500).json({ error: 'Failed to empty trash' });
    }
  }
}
