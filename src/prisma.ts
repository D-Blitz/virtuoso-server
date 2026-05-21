import { PrismaClient, Prisma } from '@prisma/client';
import { getContext } from './auth/context';

const TENANT_SCOPED_MODELS = new Set<string>([
  'Location',
  'Facilitator',
  'Room',
  'Client',
  'Tag',
  'Service',
  'ServiceCategory',
  'ScheduledEvent',
  'Term',
  'Enrollment',
  'Closure',
]);

/**
 * Models that have a `deletedAt` column for soft-delete (Phase 0.5).
 * Reads on these models default to `deletedAt: null` unless the caller
 * explicitly filters on `deletedAt` themselves (escape hatch for the
 * trash bin UI, the restore flow, and the TTL purge cron).
 *
 * Kept separate from TENANT_SCOPED_MODELS because:
 *   - Not every tenant-scoped model is soft-deletable
 *     (though right now they happen to overlap entirely).
 *   - RecurrenceSeries is soft-deletable but tenant-scoping for it is
 *     implicit (always accessed via ScheduledEvent.seriesId).
 */
const SOFT_DELETE_MODELS = new Set<string>([
  'Location',
  'Facilitator',
  'Room',
  'Client',
  'Tag',
  'Service',
  'ServiceCategory',
  'ScheduledEvent',
  'RecurrenceSeries',
  'Term',
  'Enrollment',
  'Closure',
]);

/**
 * Slow-query logging.
 *
 * Threshold (ms) is configurable via `SLOW_QUERY_MS` env var. Default
 * is 250ms in production, 500ms in development (chattier `prisma migrate`
 * runs and DDL would otherwise spam the log). Set to 0 to disable.
 *
 * Implemented via Prisma's `query` event emitter (cheap — no extension
 * middleware in the hot path). Each slow query logs duration + the
 * query text (params are interpolated by Prisma for the event payload).
 */
const slowQueryThresholdMs = (() => {
  const raw = process.env.SLOW_QUERY_MS;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 250;
  }
  return process.env.NODE_ENV === 'production' ? 250 : 500;
})();

const base =
  slowQueryThresholdMs > 0
    ? new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
    : new PrismaClient();

if (slowQueryThresholdMs > 0) {
  // The `query` event type isn't in the static PrismaClient signature
  // without the matching `log` option in scope — cast to attach.
  (base as any).$on('query', (e: { duration: number; query: string; params: string }) => {
    if (e.duration >= slowQueryThresholdMs) {
      console.warn(
        `[prisma:slow] ${e.duration}ms — ${e.query}${e.params ? ` | params: ${e.params}` : ''}`,
      );
    }
  });
  console.log(`[prisma] slow-query logging enabled (≥${slowQueryThresholdMs}ms)`);
}

/**
 * Apply soft-delete scoping to a Prisma `where` clause.
 *
 * If the caller already mentioned `deletedAt` (e.g. `deletedAt: { not: null }`
 * for the trash listing, or `deletedAt: { lt: cutoff }` for the TTL purge
 * cron), we leave their filter intact — that's the escape hatch.
 * Otherwise we add the default `deletedAt: null` filter so trashed rows
 * are invisible to ordinary queries.
 */
function withSoftDeleteFilter(where: Record<string, any> | undefined) {
  if (where && 'deletedAt' in where) return where;
  return { ...(where ?? {}), deletedAt: null };
}

const prisma = base.$extends({
  name: 'scoping',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        // Early return for models the extension doesn't touch — keep it as
        // one combined check so TS can narrow `model` for the rest of the
        // function (otherwise `query(args)` infers as `never`).
        if (
          !model ||
          (!TENANT_SCOPED_MODELS.has(model) && !SOFT_DELETE_MODELS.has(model))
        ) {
          return query(args);
        }

        const isOrgScoped = TENANT_SCOPED_MODELS.has(model);
        const isSoftDeletable = SOFT_DELETE_MODELS.has(model);

        const ctx = getContext();
        const orgId = ctx?.organizationId;
        const a = args as Record<string, any>;

        // Helper: apply both scopings to a where clause where appropriate.
        const scopeWhere = (where: Record<string, any> | undefined) => {
          let next: Record<string, any> = { ...(where ?? {}) };
          if (isOrgScoped && orgId !== undefined) {
            next.organizationId = orgId;
          }
          if (isSoftDeletable) {
            next = withSoftDeleteFilter(next);
          }
          return next;
        };

        switch (operation) {
          case 'create': {
            // Soft-delete: no scoping on create (new rows have deletedAt=null).
            if (isOrgScoped && orgId !== undefined) {
              const existing = a.data ?? {};
              // Skip injection if relation syntax (`organization`) is already used,
              // to avoid Prisma's "both organization and organizationId set" error.
              if (existing.organization === undefined) {
                a.data = {
                  ...existing,
                  organizationId: existing.organizationId ?? orgId,
                };
              }
            }
            break;
          }
          case 'createMany':
          case 'createManyAndReturn': {
            if (isOrgScoped && orgId !== undefined) {
              const data = a.data;
              const items = Array.isArray(data) ? data : [data];
              a.data = items.map((d: any) => ({
                ...d,
                organizationId: d?.organizationId ?? orgId,
              }));
            }
            break;
          }
          case 'findFirst':
          case 'findFirstOrThrow':
          case 'findMany':
          case 'count':
          case 'aggregate':
          case 'groupBy':
          case 'updateMany':
          case 'deleteMany': {
            a.where = scopeWhere(a.where);
            break;
          }
          case 'update':
          case 'delete': {
            // Prisma 5+ accepts non-unique fields in WhereUniqueInput.
            a.where = scopeWhere(a.where);
            break;
          }
          case 'upsert': {
            a.where = scopeWhere(a.where);
            if (isOrgScoped && orgId !== undefined) {
              const createData = a.create ?? {};
              if (createData.organization === undefined) {
                a.create = {
                  ...createData,
                  organizationId: createData.organizationId ?? orgId,
                };
              }
            }
            break;
          }
          case 'findUnique':
          case 'findUniqueOrThrow': {
            // Force-add organizationId + deletedAt to the select (if select is
            // used) so we can post-filter on them, then strip from the
            // returned shape. Track which fields the caller actually wanted.
            const selectClause = a.select;
            let stripOrgId = false;
            let stripDeletedAt = false;
            if (selectClause && typeof selectClause === 'object') {
              const next: any = { ...selectClause };
              if (isOrgScoped && next.organizationId !== true) {
                next.organizationId = true;
                stripOrgId = true;
              }
              if (isSoftDeletable && next.deletedAt !== true) {
                next.deletedAt = true;
                stripDeletedAt = true;
              }
              a.select = next;
            }

            const result: any = await query(a as any);

            // Wrong org → not found
            if (
              isOrgScoped &&
              orgId !== undefined &&
              result &&
              result.organizationId !== orgId
            ) {
              if (operation === 'findUniqueOrThrow') {
                throw new Prisma.PrismaClientKnownRequestError('Record not found', {
                  code: 'P2025',
                  clientVersion: Prisma.prismaVersion.client,
                });
              }
              return null;
            }

            // Trashed → not found (unless caller explicitly asked for deletedAt
            // in their select, which signals "I'm handling the trash semantics")
            if (
              isSoftDeletable &&
              result &&
              result.deletedAt != null &&
              stripDeletedAt
            ) {
              if (operation === 'findUniqueOrThrow') {
                throw new Prisma.PrismaClientKnownRequestError('Record not found', {
                  code: 'P2025',
                  clientVersion: Prisma.prismaVersion.client,
                });
              }
              return null;
            }

            if (result && (stripOrgId || stripDeletedAt)) {
              const cleaned = { ...result };
              if (stripOrgId) delete cleaned.organizationId;
              if (stripDeletedAt) delete cleaned.deletedAt;
              return cleaned;
            }
            return result;
          }
        }

        return query(a as any);
      },
    },
  },
});

export default prisma;
