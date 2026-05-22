import prisma from '../../prisma';
import { getContext } from '../../auth/context';

/**
 * Shared archive primitives — mirror image of trash/softDelete.ts.
 *
 * The archive feature (Phase 6.11) is the "keep forever, just hide
 * it" counterpart of the trash bin's "delete with TTL" semantic.
 * Same column shape (archivedAt + archivedById), same scoping
 * pattern in the Prisma extension, but archived rows never auto-
 * purge and are restorable indefinitely.
 *
 * Mutually exclusive with trash by convention: a row has at most
 * one of (deletedAt, archivedAt) set. The TTL purge cron is the
 * one transition path that touches both columns in a single
 * operation (clears deletedAt + sets archivedAt) when FK constraints
 * block a hard delete.
 *
 * `modelName` is a Prisma client property name (lowercase camelCase),
 * e.g. 'client', 'facilitator'.
 */
export async function archive<T = any>(
  modelName: string,
  id: string,
): Promise<T> {
  const ctx = getContext();
  const client = (prisma as any)[modelName];
  if (!client) {
    throw new Error(`Unknown archivable model: ${modelName}`);
  }

  // Fetch via the default scope: this errors P2025 for already-
  // trashed or already-archived rows, which is the right behavior
  // (don't double-archive, don't archive a trashed row directly —
  // the trash flow handles that separately).
  const before = (await client.findUniqueOrThrow({ where: { id } })) as T;

  await client.update({
    where: { id },
    data: {
      archivedAt: new Date(),
      archivedById: ctx?.userId ?? null,
    },
  });

  return before;
}

/**
 * Restore an archived row. The caller must look up the archived row
 * first via the archive service (which bypasses the default scope).
 *
 * Returns the restored row (with archivedAt nulled).
 */
export async function unarchive<T = any>(
  modelName: string,
  id: string,
): Promise<T> {
  const client = (prisma as any)[modelName];
  if (!client) {
    throw new Error(`Unknown archivable model: ${modelName}`);
  }

  const result = await client.updateMany({
    where: {
      id,
      archivedAt: { not: null },
    },
    data: {
      archivedAt: null,
      archivedById: null,
    },
  });

  if (result.count === 0) {
    throw new Error(`No archived ${modelName} found with id ${id}`);
  }

  return (await client.findUniqueOrThrow({ where: { id } })) as T;
}

/**
 * Move a trashed row directly into archive — the path used by the
 * TTL purge cron when FK constraints block hard delete. Atomically:
 *   - clears deletedAt + deletedById (so it stops counting as trash)
 *   - stamps archivedAt + archivedById with the system actor
 *
 * Returns the row before the transition (so callers can write the
 * audit entry from the trash-state snapshot).
 */
export async function transitionTrashToArchive<T = any>(
  modelName: string,
  id: string,
  archivedByLabel: string,
): Promise<T> {
  const client = (prisma as any)[modelName];
  if (!client) {
    throw new Error(`Unknown archivable model: ${modelName}`);
  }

  // Look up via findFirst with explicit deletedAt filter so the row
  // is returned even though it's trashed.
  const before = (await client.findFirst({
    where: { id, deletedAt: { not: null } },
  })) as T | null;
  if (!before) {
    throw new Error(
      `No trashed ${modelName} found with id ${id} (transitionTrashToArchive)`,
    );
  }

  await client.updateMany({
    where: { id, deletedAt: { not: null } },
    data: {
      deletedAt: null,
      deletedById: null,
      archivedAt: new Date(),
      archivedById: archivedByLabel,
    },
  });

  return before;
}

/**
 * Reverse of `transitionTrashToArchive`: move an archived row into
 * trash. Used by the /admin/archives "Supprimer" button so deleting
 * from archive routes through the trash bin's 30-day recovery
 * window instead of hard-deleting on the spot.
 *
 * Atomically:
 *   - clears archivedAt + archivedById
 *   - stamps deletedAt + deletedById with the caller's id
 *
 * Returns the row before the transition for the audit before-snapshot.
 */
export async function transitionArchiveToTrash<T = any>(
  modelName: string,
  id: string,
): Promise<T> {
  const ctx = getContext();
  const client = (prisma as any)[modelName];
  if (!client) {
    throw new Error(`Unknown archivable model: ${modelName}`);
  }

  const before = (await client.findFirst({
    where: { id, archivedAt: { not: null } },
  })) as T | null;
  if (!before) {
    throw new Error(
      `No archived ${modelName} found with id ${id} (transitionArchiveToTrash)`,
    );
  }

  await client.updateMany({
    where: { id, archivedAt: { not: null } },
    data: {
      archivedAt: null,
      archivedById: null,
      deletedAt: new Date(),
      deletedById: ctx?.userId ?? null,
    },
  });

  return before;
}
