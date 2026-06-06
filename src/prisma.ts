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
  // Phase 1.9 — invoicing. Auto-scope so every invoice read/write is
  // pinned to the caller's org (defence-in-depth on top of the explicit
  // organizationId filters in InvoiceService). InvoiceLine is NOT listed:
  // it has no organizationId column and is only ever reached via its
  // parent Invoice relation, which is already scoped. Payment is also
  // deliberately left out — its rows are created by the unauthenticated
  // Stripe webhook (no request context), so auto-injection can't apply;
  // PaymentService scopes its own queries explicitly instead.
  'Invoice',
  // Phase A — billing identities (school + per-facilitator invoicing
  // parties). Always created via authenticated admin requests, so
  // auto-injection of organizationId applies cleanly. The service also
  // scopes explicitly (defence-in-depth, like Invoice).
  'BillingIdentity',
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
  // Phase 2.2 follow-up — flows trash with the rest of the org's
  // soft-deletable entities. Public engine routes auto-skip trashed
  // flows because the extension scopes findUnique/findFirst by
  // deletedAt: null by default.
  'WidgetFlow',
]);

/**
 * Models that have an `archivedAt` column for the Archive feature
 * (Phase 6.11). Archive is the "keep forever, just hide" counterpart
 * of the trash bin's "delete with TTL" semantic.
 *
 * Scoping mirrors SOFT_DELETE_MODELS: reads default to
 * `archivedAt: null` unless the caller explicitly filters on it (the
 * /admin/archives page is the only intended escape hatch).
 *
 * Mutually exclusive with the trash state by convention: a row has at
 * most one of (deletedAt, archivedAt) set. The TTL purge cron is the
 * one place that actively transitions a row from trash → archive,
 * when FK constraints block a hard delete (see jobs/trashPurge.ts).
 *
 * Subset of SOFT_DELETE_MODELS — only the entities a school actually
 * wants to "retire but keep" (Tag/Closure/Enrollment/Event/etc. don't
 * have an archive use-case worth the scoping complexity).
 */
const ARCHIVABLE_MODELS = new Set<string>([
  'Client',
  'Facilitator',
  'Term',
  'Service',
  'Location',
  'Room',
  'ScheduledEvent',
  // Phase 2.2 follow-up — archive a retired flow without deleting it.
  // Useful for seasonal flows (holiday booking, summer camp) the admin
  // wants to recall later without keeping in the active list.
  'WidgetFlow',
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

/**
 * Same shape as withSoftDeleteFilter, but for the Phase-6.11 archive
 * state. The /admin/archives listing opts in by passing
 * `archivedAt: { not: null }`; everything else gets the default
 * archivedAt: null filter so archived rows are invisible.
 */
function withArchiveFilter(where: Record<string, any> | undefined) {
  if (where && 'archivedAt' in where) return where;
  return { ...(where ?? {}), archivedAt: null };
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
          (!TENANT_SCOPED_MODELS.has(model) &&
            !SOFT_DELETE_MODELS.has(model) &&
            !ARCHIVABLE_MODELS.has(model))
        ) {
          return query(args);
        }

        const isOrgScoped = TENANT_SCOPED_MODELS.has(model);
        const isSoftDeletable = SOFT_DELETE_MODELS.has(model);
        const isArchivable = ARCHIVABLE_MODELS.has(model);

        const ctx = getContext();
        const orgId = ctx?.organizationId;
        const a = args as Record<string, any>;

        // Helper: apply all three scopings to a where clause where
        // appropriate. Archive filter layers on top of soft-delete —
        // ordinary reads exclude both trashed AND archived rows.
        const scopeWhere = (where: Record<string, any> | undefined) => {
          let next: Record<string, any> = { ...(where ?? {}) };
          if (isOrgScoped && orgId !== undefined) {
            next.organizationId = orgId;
          }
          if (isSoftDeletable) {
            next = withSoftDeleteFilter(next);
          }
          if (isArchivable) {
            next = withArchiveFilter(next);
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
            // Caller opts in to seeing trashed/archived rows by
            // including `deletedAt: true` / `archivedAt: true` in
            // their select. Without that, both trashed and archived
            // rows are treated as not-found.
            const selectClause = a.select;
            const callerWantsDeletedAt =
              isSoftDeletable &&
              selectClause &&
              typeof selectClause === 'object' &&
              selectClause.deletedAt === true;
            const callerWantsArchivedAt =
              isArchivable &&
              selectClause &&
              typeof selectClause === 'object' &&
              selectClause.archivedAt === true;

            // Force-add organizationId + deletedAt + archivedAt to
            // the select (if select is used) so we can post-filter,
            // then strip from the returned shape.
            let stripOrgId = false;
            let stripDeletedAt = false;
            let stripArchivedAt = false;
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
              if (isArchivable && next.archivedAt !== true) {
                next.archivedAt = true;
                stripArchivedAt = true;
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

            // Trashed → not found (unless caller opted in).
            if (
              isSoftDeletable &&
              !callerWantsDeletedAt &&
              result &&
              result.deletedAt != null
            ) {
              if (operation === 'findUniqueOrThrow') {
                throw new Prisma.PrismaClientKnownRequestError('Record not found', {
                  code: 'P2025',
                  clientVersion: Prisma.prismaVersion.client,
                });
              }
              return null;
            }

            // Archived → not found (unless caller opted in).
            // Same opt-in pattern as soft-delete; the /admin/archives
            // listing is the only consumer that asks to see them.
            if (
              isArchivable &&
              !callerWantsArchivedAt &&
              result &&
              result.archivedAt != null
            ) {
              if (operation === 'findUniqueOrThrow') {
                throw new Prisma.PrismaClientKnownRequestError('Record not found', {
                  code: 'P2025',
                  clientVersion: Prisma.prismaVersion.client,
                });
              }
              return null;
            }

            if (result && (stripOrgId || stripDeletedAt || stripArchivedAt)) {
              const cleaned = { ...result };
              if (stripOrgId) delete cleaned.organizationId;
              if (stripDeletedAt) delete cleaned.deletedAt;
              if (stripArchivedAt) delete cleaned.archivedAt;
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
