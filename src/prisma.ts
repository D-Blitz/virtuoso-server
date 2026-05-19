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

const prisma = base.$extends({
  name: 'orgScope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || !TENANT_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        const ctx = getContext();
        // No context = script/seed/cron path. Pass through unscoped.
        if (!ctx) return query(args);

        const orgId = ctx.organizationId;
        const a = args as Record<string, any>;

        switch (operation) {
          case 'create': {
            const existing = a.data ?? {};
            // Skip injection if relation syntax (`organization`) is already used,
            // to avoid Prisma's "both organization and organizationId set" error.
            if (existing.organization === undefined) {
              a.data = { ...existing, organizationId: existing.organizationId ?? orgId };
            }
            break;
          }
          case 'createMany':
          case 'createManyAndReturn': {
            const data = a.data;
            const items = Array.isArray(data) ? data : [data];
            a.data = items.map((d: any) => ({
              ...d,
              organizationId: d?.organizationId ?? orgId,
            }));
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
            a.where = { ...(a.where ?? {}), organizationId: orgId };
            break;
          }
          case 'update':
          case 'delete': {
            // Prisma 5+ accepts non-unique fields in WhereUniqueInput.
            a.where = { ...(a.where ?? {}), organizationId: orgId };
            break;
          }
          case 'upsert': {
            a.where = { ...(a.where ?? {}), organizationId: orgId };
            const createData = a.create ?? {};
            if (createData.organization === undefined) {
              a.create = {
                ...createData,
                organizationId: createData.organizationId ?? orgId,
              };
            }
            break;
          }
          case 'findUnique':
          case 'findUniqueOrThrow': {
            // If `select` is used without organizationId, force-add it so
            // we can post-filter, then strip it from the returned shape.
            const selectClause = a.select;
            let stripOrgId = false;
            if (
              selectClause &&
              typeof selectClause === 'object' &&
              selectClause.organizationId !== true
            ) {
              a.select = { ...selectClause, organizationId: true };
              stripOrgId = true;
            }

            const result: any = await query(a as any);

            if (result && result.organizationId !== orgId) {
              if (operation === 'findUniqueOrThrow') {
                throw new Prisma.PrismaClientKnownRequestError('Record not found', {
                  code: 'P2025',
                  clientVersion: Prisma.prismaVersion.client,
                });
              }
              return null;
            }

            if (stripOrgId && result) {
              const { organizationId: _omit, ...rest } = result;
              return rest;
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
