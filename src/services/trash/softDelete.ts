import prisma from '../../prisma';
import { getContext } from '../../auth/context';

/**
 * Shared soft-delete primitive used by every service that wants
 * delete-as-trash semantics (Phase 0.5).
 *
 * Behavior:
 *   - Fetches the row (post-extension, which scopes to deletedAt: null
 *     and the right org), so trying to soft-delete an already-trashed
 *     or missing row throws P2025.
 *   - Stamps `deletedAt` + `deletedById` (denormalized from the request
 *     context's userId).
 *   - Returns the pre-delete row so callers can write the audit
 *     before-snapshot without an extra round-trip.
 *
 * `modelName` is a Prisma client property name (e.g. 'client',
 * 'facilitator') — lowercase camelCase.
 */
export async function softDelete<T = any>(
  modelName: string,
  id: string,
): Promise<T> {
  const ctx = getContext();
  const client = (prisma as any)[modelName];
  if (!client) {
    throw new Error(`Unknown soft-delete model: ${modelName}`);
  }

  // Fetch first — the scoping extension throws P2025 if the row is
  // already trashed, which is the right behavior (don't soft-delete
  // twice).
  const before = (await client.findUniqueOrThrow({ where: { id } })) as T;

  await client.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      deletedById: ctx?.userId ?? null,
    },
  });

  return before;
}

/**
 * Restore a soft-deleted row. The caller must look up the trashed row
 * first via the trash service (which bypasses the default scope).
 *
 * Returns the restored row (with deletedAt nulled).
 */
export async function restoreSoftDeleted<T = any>(
  modelName: string,
  id: string,
): Promise<T> {
  const client = (prisma as any)[modelName];
  if (!client) {
    throw new Error(`Unknown soft-delete model: ${modelName}`);
  }

  // Use updateMany with explicit deletedAt filter (bypasses the default
  // scope) and target our exact id. updateMany doesn't throw on
  // not-found; we check the count.
  const result = await client.updateMany({
    where: {
      id,
      deletedAt: { not: null },
    },
    data: {
      deletedAt: null,
      deletedById: null,
    },
  });

  if (result.count === 0) {
    throw new Error(`No trashed ${modelName} found with id ${id}`);
  }

  // Fetch the now-restored row to return.
  return (await client.findUniqueOrThrow({ where: { id } })) as T;
}

/**
 * Hard-delete a trashed row from the DB. Used by:
 *   - admin "Supprimer définitivement" action
 *   - TTL purge cron
 *
 * Returns the row that was about to be deleted (before snapshot) so the
 * caller can write the audit entry.
 */
export async function hardPurgeTrashed<T = any>(
  modelName: string,
  id: string,
): Promise<T> {
  const client = (prisma as any)[modelName];
  if (!client) {
    throw new Error(`Unknown trash model: ${modelName}`);
  }

  // Look up via findFirst with explicit deletedAt filter so the row is
  // returned even though it's trashed.
  const before = (await client.findFirst({
    where: { id, deletedAt: { not: null } },
  })) as T | null;
  if (!before) {
    throw new Error(`No trashed ${modelName} found with id ${id}`);
  }

  // Hard delete bypasses the soft-delete extension because we're targeting
  // by id directly with `delete`. The scoping middleware adds
  // `deletedAt: null` to the where; that won't match a trashed row. So
  // we use deleteMany with the explicit deletedAt filter to bypass.
  await client.deleteMany({
    where: { id, deletedAt: { not: null } },
  });

  return before;
}
