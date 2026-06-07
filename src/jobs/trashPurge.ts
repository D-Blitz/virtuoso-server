import prisma from '../prisma';
import { auditLog } from '../services/audit/audit.service';
import {
  SOFT_DELETABLE_ENTITY_TYPES,
  type SoftDeletableEntityType,
} from '../services/trash/trash.service';
import { ARCHIVABLE_ENTITY_TYPES } from '../services/archive/archive.service';
import { transitionTrashToArchive } from '../services/archive/archive';
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
  snapshotUnavailability,
  snapshotWidgetFlow,
} from '../services/audit/snapshots';

/**
 * Daily TTL purge for soft-deleted rows. See docs/TRASH_BIN_DESIGN.md.
 *
 * Reads `TRASH_TTL_DAYS` env var (default 30). Set to 0 to disable —
 * trash will grow forever in that case, which is fine if the school
 * wants long-tail recovery.
 *
 * Each purge writes an audit entry with `system:trash-purge` actor.
 */

const TTL_DAYS = (() => {
  const raw = process.env.TRASH_TTL_DAYS;
  if (raw === undefined) return 30;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();

const RUN_EVERY_MS = 24 * 60 * 60 * 1000; // daily

const PURGE_ACTOR = {
  id: null,
  email: 'system:trash-purge',
  role: 'SYSTEM',
};

const FALLBACK_ACTOR = {
  id: null,
  email: 'system:trash-purge-fallback-archive',
  role: 'SYSTEM',
};

// Set of archivable entity type names (matches ArchivableEntityType but
// stored as a Set so it's cheap to lookup at runtime). Used by the
// fallback path below to decide whether a P2003-blocked purge can be
// redirected into archive instead.
const ARCHIVABLE_TYPE_SET = new Set<string>(ARCHIVABLE_ENTITY_TYPES);

function modelName(entityType: SoftDeletableEntityType): string {
  return entityType.charAt(0).toLowerCase() + entityType.slice(1);
}

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
    case 'WidgetFlow':
      return snapshotWidgetFlow;
    case 'Unavailability':
      return snapshotUnavailability;
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Heuristic: was this error a Postgres FK violation? Reuses the same
 * pattern detection as controllers/httpErrors.ts. We can't always
 * rely on `instanceof Prisma.PrismaClientKnownRequestError` because
 * Prisma sometimes wraps the engine error as the Unknown variant
 * (user_facing_error: None in the ConnectorError).
 */
function isFKViolation(err: unknown): boolean {
  if (!err) return false;
  const code = (err as any)?.code;
  if (code === 'P2003') return true;
  const msg = (err as any)?.message ?? '';
  if (typeof msg !== 'string') return false;
  return (
    /foreign key constraint/i.test(msg) ||
    /violates RESTRICT setting/i.test(msg) ||
    // The constraint-name shape <Model>_<col>_fkey is itself a strong
    // signal of an FK violation.
    /[A-Z][A-Za-z0-9]+_[A-Za-z0-9]+_fkey/.test(msg)
  );
}

async function runPurge(): Promise<void> {
  if (TTL_DAYS === 0) return;
  const cutoff = new Date(Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000);
  let totalPurged = 0;
  let totalArchived = 0;
  let errors = 0;

  for (const entityType of SOFT_DELETABLE_ENTITY_TYPES) {
    const client = (prisma as any)[modelName(entityType)];
    if (!client) continue;
    try {
      const expired = await client.findMany({
        where: { deletedAt: { lt: cutoff } },
      });
      const snap = snapshotterFor(entityType);
      for (const row of expired) {
        try {
          await client.deleteMany({
            where: { id: row.id, deletedAt: { not: null } },
          });
          void auditLog.record({
            action: 'DELETE',
            entityType,
            entityId: row.id,
            before: snap(row),
            actor: PURGE_ACTOR,
          });
          totalPurged++;
        } catch (rowErr) {
          // Fallback: if a hard-purge is blocked by an FK (typical
          // case: Client/Facilitator with Payment rows) AND the entity
          // is archivable, transition the row from trash into archive
          // so it stops blocking the cron forever. Anonymization
          // (0.5a) is the proper end-state for these — this just
          // keeps the trash from clogging until that ships.
          if (
            isFKViolation(rowErr) &&
            ARCHIVABLE_TYPE_SET.has(entityType)
          ) {
            try {
              await transitionTrashToArchive(
                modelName(entityType),
                row.id,
                FALLBACK_ACTOR.email,
              );
              void auditLog.record({
                action: 'UPDATE',
                entityType,
                entityId: row.id,
                before: snap(row),
                actor: FALLBACK_ACTOR,
              });
              totalArchived++;
              continue;
            } catch (fallbackErr) {
              console.error(
                `[trash-purge] archive fallback failed for ${entityType} ${row.id}:`,
                fallbackErr,
              );
            }
          }
          console.error(
            `[trash-purge] failed for ${entityType} ${row.id}:`,
            rowErr,
          );
          errors++;
        }
      }
    } catch (err) {
      console.error(`[trash-purge] scan failed for ${entityType}:`, err);
      errors++;
    }
  }

  if (totalPurged > 0 || totalArchived > 0 || errors > 0) {
    console.log(
      `[trash-purge] purged ${totalPurged}, archived (FK fallback) ${totalArchived}, errors ${errors} (TTL ${TTL_DAYS}d)`,
    );
  }
}

export function startTrashPurgeJob(): void {
  if (timer) return;
  if (TTL_DAYS === 0) {
    console.log('[trash-purge] disabled (TRASH_TTL_DAYS=0)');
    return;
  }
  console.log(
    `[trash-purge] enabled — purges trash older than ${TTL_DAYS} days every 24h`,
  );
  // Kick off once on boot, then daily.
  void runPurge();
  timer = setInterval(() => void runPurge(), RUN_EVERY_MS);
}

export function stopTrashPurgeJob(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
