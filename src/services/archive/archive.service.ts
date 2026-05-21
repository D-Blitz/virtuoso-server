import prisma from '../../prisma';
import { auditLog } from '../audit/audit.service';
import {
  snapshotClient,
  snapshotFacilitator,
  snapshotLocation,
  snapshotRoom,
  snapshotScheduledEvent,
  snapshotService,
  snapshotTerm,
} from '../audit/snapshots';
import { archive, unarchive } from './archive';

/**
 * Archive admin service. Counterpart of `TrashService` — same shape,
 * different intent. Surfaces the 6 archivable entity types (Client,
 * Facilitator, Term, Service, Location, Room), supports list /
 * archive / unarchive / hard-purge.
 *
 * Why only 6 vs trash's 12: archive is "keep forever, just hide" —
 * only meaningful for entities a school actually wants to retire but
 * preserve (former students, retired teachers, discontinued
 * services, closed locations, etc.). ScheduledEvent / Enrollment /
 * Tag / Closure don't have an archive use-case worth the scoping
 * complexity.
 */

export type ArchivableEntityType =
  | 'Client'
  | 'Facilitator'
  | 'Term'
  | 'Service'
  | 'Location'
  | 'Room'
  | 'ScheduledEvent';

export const ARCHIVABLE_ENTITY_TYPES: ArchivableEntityType[] = [
  'Client',
  'Facilitator',
  'Term',
  'Service',
  'Location',
  'Room',
  'ScheduledEvent',
];

function modelName(entityType: ArchivableEntityType): string {
  return entityType.charAt(0).toLowerCase() + entityType.slice(1);
}

function snapshotterFor(
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

export type ArchivedItem = {
  id: string;
  entityType: ArchivableEntityType;
  label: string;
  archivedAt: string;
  archivedById: string | null;
  snapshot: object;
};

export type ArchivePage = {
  items: ArchivedItem[];
  total: number;
  page: number;
  pageSize: number;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function labelFor(entityType: ArchivableEntityType, row: any): string {
  switch (entityType) {
    case 'Client':
      return `${row.firstname} ${row.lastname}`;
    case 'Facilitator':
      return `${row.firstname} ${row.lastname}`;
    case 'Term':
      return row.name;
    case 'Service':
      return row.name;
    case 'Location':
      return row.name;
    case 'Room':
      return row.name;
    case 'ScheduledEvent':
      return new Date(row.startTime).toLocaleString('fr-FR', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
  }
}

export class ArchiveService {
  /**
   * Paginated list of archived rows of a single entity type.
   *
   * Bypasses the Prisma extension's archive-scope filter by passing
   * `archivedAt: { not: null }` — the extension's escape hatch.
   */
  async list(args: {
    entityType: ArchivableEntityType;
    page?: number;
    pageSize?: number;
  }): Promise<ArchivePage> {
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)),
    );

    const client = (prisma as any)[modelName(args.entityType)];
    if (!client) {
      throw new Error(`Unknown entityType: ${args.entityType}`);
    }

    const where = { archivedAt: { not: null } };
    const [rows, total] = await Promise.all([
      client.findMany({
        where,
        orderBy: { archivedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      client.count({ where }),
    ]);

    const snap = snapshotterFor(args.entityType);
    const items: ArchivedItem[] = rows.map((r: any) => ({
      id: r.id,
      entityType: args.entityType,
      label: labelFor(args.entityType, r),
      archivedAt:
        r.archivedAt instanceof Date
          ? r.archivedAt.toISOString()
          : r.archivedAt,
      archivedById: r.archivedById ?? null,
      snapshot: snap(r) ?? {},
    }));

    return { items, total, page, pageSize };
  }

  /**
   * Counts of archived items per entity type — for the archive
   * landing page sidebar badges.
   */
  async countsByType(): Promise<Record<ArchivableEntityType, number>> {
    const out = {} as Record<ArchivableEntityType, number>;
    await Promise.all(
      ARCHIVABLE_ENTITY_TYPES.map(async (t) => {
        const client = (prisma as any)[modelName(t)];
        out[t] = await client.count({ where: { archivedAt: { not: null } } });
      }),
    );
    return out;
  }

  /**
   * Cross-type archive listing — same shape as TrashService.listAll.
   * In-memory merge + sort + paginate; archive volume is bounded by
   * the school's organic decisions to archive, so the cost is fine.
   */
  async listAll(args: {
    page?: number;
    pageSize?: number;
  }): Promise<ArchivePage> {
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)),
    );

    const perType = await Promise.all(
      ARCHIVABLE_ENTITY_TYPES.map(async (t) => {
        const client = (prisma as any)[modelName(t)];
        const rows = await client.findMany({
          where: { archivedAt: { not: null } },
          orderBy: { archivedAt: 'desc' },
        });
        const snap = snapshotterFor(t);
        return rows.map(
          (r: any): ArchivedItem => ({
            id: r.id,
            entityType: t,
            label: labelFor(t, r),
            archivedAt:
              r.archivedAt instanceof Date
                ? r.archivedAt.toISOString()
                : r.archivedAt,
            archivedById: r.archivedById ?? null,
            snapshot: snap(r) ?? {},
          }),
        );
      }),
    );

    const all: ArchivedItem[] = perType.flat();
    all.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1));

    const total = all.length;
    const start = (page - 1) * pageSize;
    const items = all.slice(start, start + pageSize);

    return { items, total, page, pageSize };
  }

  /** Archive a row. Audited as UPDATE (the row's lifecycle changed). */
  async archive(
    entityType: ArchivableEntityType,
    id: string,
  ): Promise<void> {
    const before = await archive<any>(modelName(entityType), id);

    // Refetch via the escape hatch so we see the archivedAt stamp.
    const client = (prisma as any)[modelName(entityType)];
    const after = await client.findFirst({
      where: { id, archivedAt: { not: null } },
    });

    const snap = snapshotterFor(entityType);
    void auditLog.record({
      action: 'UPDATE',
      entityType,
      entityId: id,
      before: snap(before),
      after: snap(after),
    });
  }

  /** Restore an archived row. Audited as UPDATE. */
  async unarchive(
    entityType: ArchivableEntityType,
    id: string,
  ): Promise<void> {
    const client = (prisma as any)[modelName(entityType)];
    if (!client) throw new Error(`Unknown entityType: ${entityType}`);

    const before = await client.findFirst({
      where: { id, archivedAt: { not: null } },
    });
    if (!before) {
      throw new Error(`No archived ${entityType} found with id ${id}`);
    }

    await unarchive(modelName(entityType), id);

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
   * Hard-delete an archived row. Same FK constraints apply as the
   * trash bin's purge — if the row is referenced (e.g. Client with
   * Payments), this throws and the controller surfaces the friendly
   * message via httpErrors.sendError → describeBlockingReference.
   * Anonymization (0.5a) is the real fix when that hits.
   */
  async purge(
    entityType: ArchivableEntityType,
    id: string,
  ): Promise<void> {
    const client = (prisma as any)[modelName(entityType)];
    if (!client) throw new Error(`Unknown entityType: ${entityType}`);

    const before = await client.findFirst({
      where: { id, archivedAt: { not: null } },
    });
    if (!before) {
      throw new Error(`No archived ${entityType} found with id ${id}`);
    }

    await client.deleteMany({
      where: { id, archivedAt: { not: null } },
    });

    const snap = snapshotterFor(entityType);
    void auditLog.record({
      action: 'DELETE',
      entityType,
      entityId: id,
      before: snap(before),
    });
  }
}
