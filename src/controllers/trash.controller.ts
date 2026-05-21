import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { getContext } from '../auth/context';
import {
  SOFT_DELETABLE_ENTITY_TYPES,
  TrashService,
  type SoftDeletableEntityType,
} from '../services/trash/trash.service';
import { sendError } from './httpErrors';

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
    } catch (err: any) {
      console.error('trash purge error:', err);
      // Try the shared mapper first — it correctly handles Prisma's
      // P2003 / P2025 codes (P2003 fires for blocked hard-deletes like
      // the Client + Payment FK case). For non-Prisma errors thrown
      // by the service (e.g. the facilitator-payment safety check)
      // we fall back to keyword-based status mapping so the user
      // sees the actual message instead of "Failed to purge".
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        sendError(res, err, 'Failed to purge');
        return;
      }
      const msg = err?.message ?? 'Failed to purge';
      const lower = msg.toLowerCase();
      if (lower.includes('no trashed')) {
        res.status(404).json({
          summary: 'Cet élément n’est plus dans la corbeille.',
          error: msg,
        });
        return;
      }
      if (lower.includes('paiement') || lower.includes('anonymiser')) {
        res.status(409).json({
          summary:
            'Cet intervenant a des paiements liés et ne peut pas être supprimé définitivement.',
          error: msg,
        });
        return;
      }
      res.status(500).json({
        summary: 'La suppression définitive a échoué.',
        error: msg,
      });
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
