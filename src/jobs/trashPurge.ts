import prisma from '../prisma';
import { auditLog } from '../services/audit/audit.service';
import {
  SOFT_DELETABLE_ENTITY_TYPES,
  type SoftDeletableEntityType,
} from '../services/trash/trash.service';
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
  }
}

let timer: NodeJS.Timeout | null = null;

async function runPurge(): Promise<void> {
  if (TTL_DAYS === 0) return;
  const cutoff = new Date(Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000);
  let totalPurged = 0;
  let errors = 0;

  for (const entityType of SOFT_DELETABLE_ENTITY_TYPES) {
    const client = (prisma as any)[modelName(entityType)];
    if (!client) continue;
    try {
      // Per-row purge so we can audit each. The N=expired rows per type
      // is typically small (TTL acts as a ratchet); cron runs daily.
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

  if (totalPurged > 0 || errors > 0) {
    console.log(
      `[trash-purge] purged ${totalPurged} rows older than ${TTL_DAYS}d (errors: ${errors})`,
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
