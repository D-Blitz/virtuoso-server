import prisma from '../../prisma';
import { getContext } from '../../auth/context';

/**
 * Phase 0.5a — Anonymization.
 *
 * The escape hatch for "we can't hard-delete this row (FK references)
 * but the data subject has exercised their GDPR right to be forgotten,
 * or the legal retention period is up". Overwrites the personally-
 * identifying columns with placeholders while keeping the row's
 * primary key + tenant + relations intact, so downstream FKs (Payment,
 * Enrollment, etc.) keep their audit trail.
 *
 * Reasoning lives in BACKLOG 0.5a. Quick summary:
 *   - We cannot hard-delete (Postgres FK Restrict on Payment.clientId).
 *   - We cannot SetNull/Cascade Payment (10-year accounting retention).
 *   - We CAN redact the Client row's PII while keeping the link.
 *
 * Operates on rows that are ALREADY in trash or archive — the
 * admin is expected to put the row out of the active view first
 * (the UI flow handles this naturally; "Anonymiser" buttons live in
 * /admin/corbeille and /admin/archives, not on active lists).
 *
 * Only Client and Facilitator have meaningful PII to redact. Other
 * archivable/trashable entities (Term, Service, Location, Room, etc.)
 * don't carry personal data — anonymize() will refuse them.
 */

export type AnonymizableEntityType = 'Client' | 'Facilitator';

export const ANONYMIZABLE_ENTITY_TYPES: AnonymizableEntityType[] = [
  'Client',
  'Facilitator',
];

/**
 * Per-entity field-redaction map. Returns the patch object passed to
 * Prisma `update.data`. The `metadata` field is special — we merge
 * an `anonymized` marker into the existing JSON so the UI can detect
 * and surface the state.
 */
function redactionPatch(
  entityType: AnonymizableEntityType,
  id: string,
  userId: string | null,
): Record<string, unknown> {
  const idShort = id.slice(0, 8);
  const stamp = {
    anonymized: true,
    anonymizedAt: new Date().toISOString(),
    anonymizedById: userId,
  };
  const placeholderEmail = `anonymized+${idShort}@deleted.local`;

  switch (entityType) {
    case 'Client':
      return {
        firstname: 'Anonymisé',
        lastname: '',
        email: placeholderEmail,
        phone: '',
        address: '',
        // birthdate is required + non-nullable in the schema. Use a
        // sentinel date (1900-01-01) that's clearly not a real DoB.
        birthdate: new Date('1900-01-01'),
        notes: null,
        metadata: stamp,
      };
    case 'Facilitator':
      return {
        firstname: 'Anonymisé',
        lastname: '',
        email: placeholderEmail,
        phone: '',
        address: null,
        bio: null,
        profilePictureUrl: null,
        notes: null,
        metadata: stamp,
      };
  }
}

function modelName(entityType: AnonymizableEntityType): string {
  return entityType.charAt(0).toLowerCase() + entityType.slice(1);
}

/**
 * Find the row regardless of whether it's trashed or archived,
 * bypassing the Prisma extension's default scope. Returns null if
 * the row is fully active OR doesn't exist — anonymize() requires
 * the row to be in one of the hidden states first.
 */
async function findHiddenRow(
  entityType: AnonymizableEntityType,
  id: string,
): Promise<any | null> {
  const client = (prisma as any)[modelName(entityType)];
  // OR filter expressed as findFirst with explicit deletedAt-or-
  // archivedAt: not-null. Both columns exist on the 2 anonymizable
  // entities (added by the 0.5 trash migration + 6.11 archive
  // migration respectively).
  return client.findFirst({
    where: {
      id,
      OR: [{ deletedAt: { not: null } }, { archivedAt: { not: null } }],
    },
  });
}

/**
 * Apply the redaction. Returns the BEFORE snapshot so the caller can
 * write an audit entry that captures what was redacted (the after-
 * snapshot's PII fields are all placeholders — useful diff context).
 *
 * Does NOT change the row's lifecycle state (deletedAt /
 * archivedAt stay as-is). The row was already hidden before this
 * runs; the redaction just removes the PII while keeping every FK
 * link intact.
 */
export async function anonymize<T = any>(
  entityType: AnonymizableEntityType,
  id: string,
): Promise<{ before: T; after: T }> {
  const ctx = getContext();
  const client = (prisma as any)[modelName(entityType)];

  const before = await findHiddenRow(entityType, id);
  if (!before) {
    throw new Error(
      `${entityType} ${id} is not in trash or archive — anonymize only operates on hidden rows.`,
    );
  }
  if (
    before.metadata &&
    typeof before.metadata === 'object' &&
    (before.metadata as any).anonymized === true
  ) {
    throw new Error(`${entityType} ${id} is already anonymized.`);
  }

  const patch = redactionPatch(entityType, id, ctx?.userId ?? null);

  // updateMany bypasses the extension's `deletedAt: null` /
  // `archivedAt: null` injection (which would prevent us from
  // touching the hidden row). Targeted by id + the hidden-state
  // condition so we never match a stray active row.
  const result = await client.updateMany({
    where: {
      id,
      OR: [{ deletedAt: { not: null } }, { archivedAt: { not: null } }],
    },
    data: patch,
  });
  if (result.count === 0) {
    throw new Error(`Failed to anonymize ${entityType} ${id} (no rows updated)`);
  }

  const after = await client.findFirst({
    where: {
      id,
      OR: [{ deletedAt: { not: null } }, { archivedAt: { not: null } }],
    },
  });

  return { before: before as T, after: after as T };
}
