import { Request, Response } from 'express';
import { AuditLogService } from '../services/audit/audit.service';

const auditLogService = new AuditLogService();

function parsePagingInt(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Phase 0.3: the in-controller guardAdminOnly helper has been replaced
// by `requirePermission('AUDIT_LOG_VIEW')` in routes/auditLog.routes.ts.

export class AuditLogController {
  /** Org-wide recent activity feed for /admin/audit-log. */
  async recent(req: Request, res: Response) {

    try {
      const page = parsePagingInt(req.query.page, 1);
      const pageSize = parsePagingInt(req.query.pageSize, 50);
      const entityType =
        typeof req.query.entityType === 'string'
          ? req.query.entityType
          : undefined;
      const actorId =
        typeof req.query.actorId === 'string' ? req.query.actorId : undefined;
      const from =
        typeof req.query.from === 'string' &&
        !Number.isNaN(Date.parse(req.query.from))
          ? new Date(req.query.from)
          : undefined;
      const to =
        typeof req.query.to === 'string' &&
        !Number.isNaN(Date.parse(req.query.to))
          ? new Date(req.query.to)
          : undefined;

      const result = await auditLogService.recent({
        page,
        pageSize,
        entityType,
        actorId,
        from,
        to,
      });
      res.json(result);
    } catch (err) {
      console.error('audit recent error:', err);
      res.status(500).json({ error: 'Failed to load audit log' });
    }
  }

  /** Per-entity history. Used by entity detail pages (Phase 3.3). */
  async forEntity(req: Request, res: Response) {

    try {
      const { entityType, entityId } = req.params;
      if (!entityType || !entityId) {
        res.status(400).json({ error: 'entityType + entityId required' });
        return;
      }
      const items = await auditLogService.forEntity(entityType, entityId);
      res.json({ items });
    } catch (err) {
      console.error('audit forEntity error:', err);
      res.status(500).json({ error: 'Failed to load entity history' });
    }
  }
}
