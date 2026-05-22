import prisma from '../../prisma';
import { getContext, getOrganizationId } from '../../auth/context';
import { diffSnapshots } from './snapshots';

/**
 * Audit log service. See docs/AUDIT_LOG_DESIGN.md.
 *
 * Writes are fire-and-forget at the call site:
 *
 *   void auditLog.record({
 *     action: 'UPDATE',
 *     entityType: 'ScheduledEvent',
 *     entityId: id,
 *     before: snapshotScheduledEvent(beforeRow),
 *     after:  snapshotScheduledEvent(afterRow),
 *   });
 *
 * A failed audit insert must NEVER fail the user's action — internal
 * error handler swallows + logs to stderr.
 */

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

export type AuditActor = {
  /** null when the action is system-driven (cron / webhook). */
  id: string | null;
  email: string | null;
  role: string | null;
};

export type RecordArgs = {
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: object | null;
  after?: object | null;
  /**
   * Override the actor. Use for cron / webhook driven mutations where
   * the request context isn't a real user. Convention: set
   * `email = "system:<job-name>"` so the admin UI can render a system
   * icon.
   */
  actor?: AuditActor;
};

export type AuditLogEntryDto = {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Computed server-side so the admin UI doesn't need to recompute. */
  diff: string[];
  createdAt: string;
};

export type AuditLogPage = {
  items: AuditLogEntryDto[];
  total: number;
  page: number;
  pageSize: number;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function resolveActor(override: AuditActor | undefined): AuditActor {
  if (override) return override;
  const ctx = getContext();
  if (!ctx) {
    // No context AND no override — typically only happens during seed
    // scripts. Record as fully anonymous; better than nothing.
    return { id: null, email: null, role: null };
  }
  // Phase 0.3: store the per-org Role name (e.g. 'Propriétaire',
  // 'Administrateur', or any custom role) rather than the old
  // 'OWNER | ADMIN | …' bucket. Historical audit rows keep their
  // original bucket strings — diff renderers tolerate either.
  return {
    id: ctx.userId ?? null,
    email: ctx.email ?? null,
    role: ctx.roleName ?? null,
  };
}

function rowToDto(row: any): AuditLogEntryDto {
  return {
    id: row.id,
    actorId: row.actorId,
    actorEmail: row.actorEmail,
    actorRole: row.actorRole,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before ?? null,
    after: row.after ?? null,
    diff: diffSnapshots(row.before ?? null, row.after ?? null),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export class AuditLogService {
  /**
   * Record a single mutation. Fire-and-forget at the call site; never
   * throws (swallows internally + logs to stderr).
   */
  async record(args: RecordArgs): Promise<void> {
    try {
      const organizationId =
        getOrganizationId() ??
        // Allow cron / webhook flows that explicitly pass an actor to
        // also pass the organizationId via a side channel — for now, if
        // we have no org context AND no override, we can't safely write.
        null;

      if (!organizationId) {
        console.warn(
          `[audit] no organization context for ${args.action} ${args.entityType} ${args.entityId} — skipping`,
        );
        return;
      }

      const actor = resolveActor(args.actor);

      // Cast to any: the Prisma client may not have been regenerated yet
      // on every dev machine. Behavior at runtime is identical.
      await (prisma as any).auditLogEntry.create({
        data: {
          organizationId,
          actorId: actor.id,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: args.action,
          entityType: args.entityType,
          entityId: args.entityId,
          before: (args.before as any) ?? null,
          after: (args.after as any) ?? null,
        },
      });
    } catch (err) {
      console.error('[audit] record failed:', err);
    }
  }

  /**
   * Paginated org-wide activity feed for the admin /admin/audit-log page.
   */
  async recent(args: {
    page?: number;
    pageSize?: number;
    entityType?: string;
    actorId?: string;
    from?: Date;
    to?: Date;
  } = {}): Promise<AuditLogPage> {
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)),
    );

    const organizationId = getOrganizationId();
    if (!organizationId) {
      throw new Error('No organization context');
    }

    const where = {
      organizationId,
      ...(args.entityType ? { entityType: args.entityType } : {}),
      ...(args.actorId ? { actorId: args.actorId } : {}),
      ...(args.from || args.to
        ? {
            createdAt: {
              ...(args.from ? { gte: args.from } : {}),
              ...(args.to ? { lte: args.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      (prisma as any).auditLogEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      (prisma as any).auditLogEntry.count({ where }),
    ]);

    return {
      items: rows.map(rowToDto),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Per-entity history. Used by entity detail pages (Phase 3.3) to show
   * the full change timeline for one row. Returns oldest first so the
   * UI can render top-to-bottom chronologically.
   */
  async forEntity(
    entityType: string,
    entityId: string,
  ): Promise<AuditLogEntryDto[]> {
    const rows = await (prisma as any).auditLogEntry.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(rowToDto);
  }
}

/** Module-level singleton — callers use `auditLog.record(...)`. */
export const auditLog = new AuditLogService();
