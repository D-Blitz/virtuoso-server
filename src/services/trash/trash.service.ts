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

  /** Hard-delete a trashed row. Audited as DELETE. */
  async purge(
    entityType: SoftDeletableEntityType,
    id: string,
  ): Promise<void> {
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
