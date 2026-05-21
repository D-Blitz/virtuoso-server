import prisma from '../../prisma';
import { auditLog } from '../audit/audit.service';
import {
  snapshotClient,
  snapshotClosure,
  snapshotEnrollment,
  snapshotFacilitator,
  snapshotLocation,
  snapshotRecurrenceSeries,
  snapshotRoom,
  snapshotScheduledEvent,
  snapshotService,
  snapshotServiceCategory,
  snapshotTag,
  snapshotTerm,
} from '../audit/snapshots';
import { hardPurgeTrashed, restoreSoftDeleted } from './softDelete';

/**
 * Trash bin admin service. Surfaces the 12 soft-deletable entity types,
 * supports restore + hard-purge.
 */

export type SoftDeletableEntityType =
  | 'ScheduledEvent'
  | 'RecurrenceSeries'
  | 'Facilitator'
  | 'Client'
  | 'Service'
  | 'ServiceCategory'
  | 'Location'
  | 'Room'
  | 'Tag'
  | 'Term'
  | 'Closure'
  | 'Enrollment';

export const SOFT_DELETABLE_ENTITY_TYPES: SoftDeletableEntityType[] = [
  'ScheduledEvent',
  'RecurrenceSeries',
  'Facilitator',
  'Client',
  'Service',
  'ServiceCategory',
  'Location',
  'Room',
  'Tag',
  'Term',
  'Closure',
  'Enrollment',
];

/**
 * Entity type → Prisma client property name (lowercase first letter).
 */
function modelName(entityType: SoftDeletableEntityType): string {
  return entityType.charAt(0).toLowerCase() + entityType.slice(1);
}

/**
 * Entity type → snapshot helper.
 * Returns the appropriate `snapshot*` function so audit entries are
 * consistent across the codebase.
 */
function snapshotterFor(
  entityType: SoftDeletableEntityType,
): (row: any) => object | null {
  switch (entityType) {
    case 'ScheduledEvent':
      return snapshotScheduledEvent;
    case 'RecurrenceSeries':
      return snapshotRecurrenceSeries;
    case 'Facilitator':
      return snapshotFacilitator;
    case 'Client':
      return snapshotClient;
    case 'Service':
      return snapshotService;
    case 'ServiceCategory':
      return snapshotServiceCategory;
    case 'Location':
      return snapshotLocation;
    case 'Room':
      return snapshotRoom;
    case 'Tag':
      return snapshotTag;
    case 'Term':
      return snapshotTerm;
    case 'Closure':
      return snapshotClosure;
    case 'Enrollment':
      return snapshotEnrollment;
  }
}

export type TrashedItem = {
  id: string;
  entityType: SoftDeletableEntityType;
  /** A short, human-readable label per entity type for display. */
  label: string;
  deletedAt: string;
  deletedById: string | null;
  /** Snapshot of the row's scalar fields — useful for "preview before restore". */
  snapshot: object;
};

export type TrashPage = {
  items: TrashedItem[];
  total: number;
  page: number;
  pageSize: number;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Build a friendly label per entity type for the trash UI. */
function labelFor(entityType: SoftDeletableEntityType, row: any): string {
  switch (entityType) {
    case 'ScheduledEvent':
      return `${new Date(row.startTime).toLocaleString('fr-FR', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}`;
    case 'RecurrenceSeries':
      return `Série ${row.frequency} jusqu'au ${new Date(
        row.endDate,
      ).toLocaleDateString('fr-FR')}`;
    case 'Facilitator':
      return `${row.firstname} ${row.lastname}`;
    case 'Client':
      return `${row.firstname} ${row.lastname}`;
    case 'Service':
      return row.name;
    case 'ServiceCategory':
      return row.name;
    case 'Location':
      return row.name;
    case 'Room':
      return row.name;
    case 'Tag':
      return row.label;
    case 'Term':
      return row.name;
    case 'Closure':
      return row.name;
    case 'Enrollment':
      return `Inscription ${row.id.slice(0, 8)}`;
  }
}

export class TrashService {
  /**
   * Paginated list of trashed rows of a single entity type.
   *
   * Why per-type: the row shapes differ enough that a unified "all
   * trashed items" feed would have inconsistent columns/labels.
   * Frontend uses a type tabset; each tab calls this with its type.
   */
  async list(args: {
    entityType: SoftDeletableEntityType;
    page?: number;
    pageSize?: number;
  }): Promise<TrashPage> {
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)),
    );

    const client = (prisma as any)[modelName(args.entityType)];
    if (!client) {
      throw new Error(`Unknown entityType: ${args.entityType}`);
    }

    const where = { deletedAt: { not: null } };
    const [rows, total] = await Promise.all([
      client.findMany({
        where,
        orderBy: { deletedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      client.count({ where }),
    ]);

    const snap = snapshotterFor(args.entityType);
    const items: TrashedItem[] = rows.map((r: any) => ({
      id: r.id,
      entityType: args.entityType,
      label: labelFor(args.entityType, r),
      deletedAt:
        r.deletedAt instanceof Date ? r.deletedAt.toISOString() : r.deletedAt,
      deletedById: r.deletedById ?? null,
      snapshot: snap(r) ?? {},
    }));

    return { items, total, page, pageSize };
  }

  /**
   * Counts of trashed items per entity type — for the trash bin
   * landing page / sidebar badges.
   */
  async countsByType(): Promise<Record<SoftDeletableEntityType, number>> {
    const out = {} as Record<SoftDeletableEntityType, number>;
    await Promise.all(
      SOFT_DELETABLE_ENTITY_TYPES.map(async (t) => {
        const client = (prisma as any)[modelName(t)];
        out[t] = await client.count({ where: { deletedAt: { not: null } } });
      }),
    );
    return out;
  }

  /**
   * Cross-type trash listing — every soft-deleted row across all 12
   * entity types, merged and sorted by deletedAt desc.
   *
   * Implementation note: we fetch every trashed row from every type
   * into memory, then sort + slice. This is fine for v1 because the
   * trash is bounded by the TTL purge cron (default 30 days) and only
   * admins use this surface. If trash sizes grow to thousands per type,
   * revisit with a SQL UNION-based approach (Prisma doesn't support it
   * natively across models, so it would need `prisma.$queryRaw`).
   */
  async listAll(args: {
    page?: number;
    pageSize?: number;
  }): Promise<TrashPage> {
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)),
    );

    const perType = await Promise.all(
      SOFT_DELETABLE_ENTITY_TYPES.map(async (t) => {
        const client = (prisma as any)[modelName(t)];
        const rows = await client.findMany({
          where: { deletedAt: { not: null } },
          orderBy: { deletedAt: 'desc' },
        });
        const snap = snapshotterFor(t);
        return rows.map(
          (r: any): TrashedItem => ({
            id: r.id,
            entityType: t,
            label: labelFor(t, r),
            deletedAt:
              r.deletedAt instanceof Date
                ? r.deletedAt.toISOString()
                : r.deletedAt,
            deletedById: r.deletedById ?? null,
            snapshot: snap(r) ?? {},
          }),
        );
      }),
    );

    const all: TrashedItem[] = perType.flat();
    all.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));

    const total = all.length;
    const start = (page - 1) * pageSize;
    const items = all.slice(start, start + pageSize);

    return { items, total, page, pageSize };
  }

  /** Restore a single trashed row. Audited as UPDATE. */
  async restore(
    entityType: SoftDeletableEntityType,
    id: string,
  ): Promise<void> {
    const client = (prisma as any)[modelName(entityType)];
    if (!client) throw new Error(`Unknown entityType: ${entityType}`);

    // Capture before-snapshot (trashed state) so audit shows the diff.
    const before = await client.findFirst({
      where: { id, deletedAt: { not: null } },
    });
    if (!before) {
      throw new Error(`No trashed ${entityType} found with id ${id}`);
    }

    await restoreSoftDeleted(modelName(entityType), id);

    // Fetch the restored row for the after-snapshot.
    const after = await client.findUniqueOrThrow({ where: { id } });

    const snap = snapshotterFor(entityType);
    void auditLog.record({
      action: 'UPDATE',
      entityType,
      entityId: id,
      before: snap(before),
      after: snap(after),
    });
  }

  /**
   * Cascading restore for a trashed ScheduledEvent that belongs to a
   * series. Restores:
   *   - The RecurrenceSeries row (if currently trashed)
   *   - Every trashed ScheduledEvent that shares the same seriesId
   *
   * Each restored row is audited individually as an UPDATE so the audit
   * log explains why a batch of rows came back at the same timestamp.
   *
   * The input is a ScheduledEvent id (matching the trash UI's row id),
   * not a seriesId — the trash page only knows about events by id, and
   * the seriesId lives in the event's snapshot.
   */
  async restoreSeriesFromEvent(
    scheduledEventId: string,
  ): Promise<{ restoredEvents: number; restoredSeries: boolean }> {
    // Find the trashed event (bypassing the default scope) so we can
    // read its seriesId.
    const eventBefore = await prisma.scheduledEvent.findFirst({
      where: { id: scheduledEventId, deletedAt: { not: null } },
    });
    if (!eventBefore) {
      throw new Error(
        `No trashed ScheduledEvent found with id ${scheduledEventId}`,
      );
    }
    const seriesId = eventBefore.seriesId;
    if (!seriesId) {
      throw new Error(
        `ScheduledEvent ${scheduledEventId} is not part of a series; use a regular restore instead.`,
      );
    }

    // Restore the series row first (if it's trashed) — events without a
    // live series row would be orphaned and the scoping extension would
    // hide them.
    const seriesBefore = await prisma.recurrenceSeries.findFirst({
      where: { id: seriesId, deletedAt: { not: null } },
    });
    let restoredSeries = false;
    if (seriesBefore) {
      await restoreSoftDeleted('recurrenceSeries', seriesId);
      const seriesAfter = await prisma.recurrenceSeries.findUniqueOrThrow({
        where: { id: seriesId },
      });
      void auditLog.record({
        action: 'UPDATE',
        entityType: 'RecurrenceSeries',
        entityId: seriesId,
        before: snapshotRecurrenceSeries(seriesBefore),
        after: snapshotRecurrenceSeries(seriesAfter),
      });
      restoredSeries = true;
    }

    // Restore every trashed event in the series. We re-query rather
    // than reuse `eventBefore` so a series with multiple trashed events
    // (e.g. the user deleted the whole series in bulk) all come back.
    const trashedEvents = await prisma.scheduledEvent.findMany({
      where: { seriesId, deletedAt: { not: null } },
    });
    let restoredEvents = 0;
    for (const before of trashedEvents) {
      try {
        await restoreSoftDeleted('scheduledEvent', before.id);
        const after = await prisma.scheduledEvent.findUniqueOrThrow({
          where: { id: before.id },
        });
        void auditLog.record({
          action: 'UPDATE',
          entityType: 'ScheduledEvent',
          entityId: before.id,
          before: snapshotScheduledEvent(before),
          after: snapshotScheduledEvent(after),
        });
        restoredEvents++;
      } catch (err) {
        console.error(
          `[trash] restoreSeriesFromEvent: failed to restore event ${before.id}:`,
          err,
        );
      }
    }

    return { restoredEvents, restoredSeries };
  }

  /** Hard-delete a trashed row. Audited as DELETE. */
  async purge(
    entityType: SoftDeletableEntityType,
    id: string,
  ): Promise<void> {
    // Pre-purge safety check for indirect Payment references.
    //
    // - Client: the FK Payment_clientId_fkey already blocks at the DB
    //   level with P2003 (the proper fix is anonymization — see
    //   BACKLOG 0.5a). No manual check needed.
    // - Facilitator: there's NO direct Payment.facilitatorId column,
    //   only the chain Facilitator ↔ ScheduledEvent (m2m) ←
    //   Payment.relatedScheduledEventId (optional, SetNull). Postgres
    //   wouldn't refuse the delete, but the result would be a
    //   Payment row whose related event is gone AND whose facilitator
    //   audit trail is lost (the m2m link is cascade-deleted). We
    //   refuse with a clear message so the admin doesn't accidentally
    //   sever an accounting paper trail.
    //
    // This is a stop-gap. The real fix is the same anonymization
    // flow we need for Client (BACKLOG 0.5a) — redact the personal
    // columns while keeping the row + relations intact.
    if (entityType === 'Facilitator') {
      const paymentCount = await prisma.payment.count({
        where: {
          relatedScheduledEvent: {
            facilitators: { some: { id } },
          },
        },
      });
      if (paymentCount > 0) {
        throw new Error(
          `Des paiements sont liés à des événements de cet intervenant (${paymentCount}). ` +
            `La suppression définitive briserait la traçabilité comptable. ` +
            `Utilisez "Anonymiser" plutôt que la suppression définitive ` +
            `(fonctionnalité à venir — pour l'instant gardez l'intervenant dans la corbeille).`,
        );
      }
    }

    const before = await hardPurgeTrashed(modelName(entityType), id);
    const snap = snapshotterFor(entityType);
    void auditLog.record({
      action: 'DELETE',
      entityType,
      entityId: id,
      before: snap(before),
    });
  }

  /**
   * Cascading hard-purge for a series — symmetric counterpart of
   * restoreSeriesFromEvent. Given an input id that is either:
   *   - a trashed ScheduledEvent with a seriesId, or
   *   - a trashed RecurrenceSeries
   * permanently deletes the series row AND every trashed sibling
   * occurrence that shares the same seriesId. Audited as one DELETE
   * per row.
   *
   * Live (non-trashed) events of the series are NOT touched — purge is
   * only ever about clearing the trash. If a series has any live event,
   * the series row itself is also expected to be live (we keep them in
   * sync at delete time), so the series purge below is a no-op in
   * that case and only the trashed siblings get purged.
   */
  async purgeSeriesCascade(args: {
    /** 'ScheduledEvent' | 'RecurrenceSeries' */
    entityType: 'ScheduledEvent' | 'RecurrenceSeries';
    id: string;
  }): Promise<{ purgedEvents: number; purgedSeries: boolean }> {
    let seriesId: string;
    if (args.entityType === 'ScheduledEvent') {
      const ev = await prisma.scheduledEvent.findFirst({
        where: { id: args.id, deletedAt: { not: null } },
      });
      if (!ev) {
        throw new Error(`No trashed ScheduledEvent found with id ${args.id}`);
      }
      if (!ev.seriesId) {
        throw new Error(
          `ScheduledEvent ${args.id} is not part of a series; use a regular purge instead.`,
        );
      }
      seriesId = ev.seriesId;
    } else {
      // Caller already passed the series id directly. Verify it exists
      // in the trash so we don't silently no-op for typos.
      const ser = await prisma.recurrenceSeries.findFirst({
        where: { id: args.id, deletedAt: { not: null } },
      });
      if (!ser) {
        throw new Error(
          `No trashed RecurrenceSeries found with id ${args.id}`,
        );
      }
      seriesId = args.id;
    }

    // Purge every trashed event in the series first. We don't have a
    // safe way to atomically delete-cascade these via Prisma without
    // FK cascades configured, so loop + audit each.
    const trashedEvents = await prisma.scheduledEvent.findMany({
      where: { seriesId, deletedAt: { not: null } },
    });
    let purgedEvents = 0;
    for (const ev of trashedEvents) {
      try {
        await hardPurgeTrashed('scheduledEvent', ev.id);
        void auditLog.record({
          action: 'DELETE',
          entityType: 'ScheduledEvent',
          entityId: ev.id,
          before: snapshotScheduledEvent(ev),
        });
        purgedEvents++;
      } catch (err) {
        console.error(
          `[trash] purgeSeriesCascade: failed to purge event ${ev.id}:`,
          err,
        );
      }
    }

    // Then the series row, if it's also trashed. A live series can't
    // exist alongside all-trashed events in normal flow but we still
    // guard against it.
    let purgedSeries = false;
    const ser = await prisma.recurrenceSeries.findFirst({
      where: { id: seriesId, deletedAt: { not: null } },
    });
    if (ser) {
      try {
        await hardPurgeTrashed('recurrenceSeries', seriesId);
        void auditLog.record({
          action: 'DELETE',
          entityType: 'RecurrenceSeries',
          entityId: seriesId,
          before: snapshotRecurrenceSeries(ser),
        });
        purgedSeries = true;
      } catch (err) {
        console.error(
          `[trash] purgeSeriesCascade: failed to purge series ${seriesId}:`,
          err,
        );
      }
    }

    return { purgedEvents, purgedSeries };
  }

  /**
   * Hard-delete every trashed row across all entity types. Audited as
   * one DELETE entry per row.
   */
  async purgeAll(): Promise<{ purged: number }> {
    let purged = 0;
    for (const t of SOFT_DELETABLE_ENTITY_TYPES) {
      const client = (prisma as any)[modelName(t)];
      const rows = await client.findMany({
        where: { deletedAt: { not: null } },
      });
      for (const row of rows) {
        try {
          await this.purge(t, row.id);
          purged++;
        } catch (err) {
          console.error(`[trash] purgeAll failed for ${t} ${row.id}:`, err);
        }
      }
    }
    return { purged };
  }
}
