import prisma from '../../prisma';
import type { AnonymizableEntityType } from './anonymize';

/**
 * GDPR audit-log scrub.
 *
 * When a Client or Facilitator is anonymized, the AuditLogEntry rows
 * referencing that entity still contain the original PII in their
 * `before` / `after` JSON snapshots (firstname, email, phone, …
 * captured at CREATE / UPDATE time, preserved by the append-only
 * audit log). CNIL's reading of GDPR Article 17 is that those
 * snapshots ALSO have to be reduced to the minimum personal data
 * necessary for the audit's legitimate purpose — keep the "what
 * happened" (action, timestamp, actor, diff fields list) but drop
 * the specific PII values.
 *
 * Strategy: in-place update of audit rows where entityType + entityId
 * match the anonymized row. For each row, replace the PII fields in
 * the snapshots with the same placeholders the Client / Facilitator
 * row already uses. Keep every other field (action, actorId,
 * createdAt, ids, dates that aren't birthdate, ids of related rows).
 *
 * Indirect references (e.g., an Enrollment audit row that captured
 * `clientId: X`) are NOT scrubbed — they only carry the opaque id,
 * which isn't PII once the Client row itself is anonymized. The
 * snapshots in this codebase deliberately don't denormalize names
 * across entity types (snapshotEnrollment lists IDs, not names) so
 * this stays simple.
 *
 * Mutating the audit log is a documented exception to its append-only
 * convention. It's reserved for this specific GDPR-anonymize action.
 * If we ever ship an audit-log viewer that highlights tampering, this
 * is the one operation it should treat as legitimate (matched against
 * the corresponding anonymize entry's createdAt + actor).
 */

const PII_PLACEHOLDERS: Record<string, unknown> = {
  firstname: 'Anonymisé',
  lastname: '',
  email: '[redacted]',
  phone: '',
  address: '',
  // Date sentinel — birthdate is non-null in the Client schema, so we
  // keep the same 1900-01-01 sentinel the row redaction uses. For
  // nullable birthdates on other entities we'd use null.
  birthdate: '1900-01-01T00:00:00.000Z',
  notes: null,
  bio: null,
  profilePictureUrl: null,
};

const PII_FIELDS_BY_TYPE: Record<AnonymizableEntityType, string[]> = {
  Client: [
    'firstname',
    'lastname',
    'email',
    'phone',
    'address',
    'birthdate',
    'notes',
  ],
  Facilitator: [
    'firstname',
    'lastname',
    'email',
    'phone',
    'address',
    'bio',
    'profilePictureUrl',
    'notes',
  ],
};

/**
 * Apply the PII placeholder map to one snapshot blob (the `before` or
 * `after` of an audit row). Returns a new object only if at least one
 * field actually changed; otherwise returns the same reference so the
 * caller can skip the DB write.
 */
function scrubSnapshot(
  snapshot: unknown,
  fields: string[],
): { changed: boolean; value: unknown } {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { changed: false, value: snapshot };
  }
  const src = snapshot as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = { ...src };
  for (const field of fields) {
    if (!(field in src)) continue;
    const current = src[field];
    if (current === null || current === '' || current === undefined) continue;
    const placeholder = PII_PLACEHOLDERS[field] ?? null;
    if (current === placeholder) continue;
    out[field] = placeholder;
    changed = true;
  }
  return { changed, value: changed ? out : snapshot };
}

/**
 * Scrub every past AuditLogEntry whose `entityType` + `entityId` match
 * the just-anonymized row. Returns the count of rows updated.
 *
 * Called from AnonymizeService.anonymize right after the row's own
 * redaction succeeds, inside the same logical operation. We don't
 * write a separate audit entry per scrubbed row — the anonymize
 * UPDATE entry on the entity itself records when + by whom; the
 * scrubbed audit rows share the same trail by inspection.
 */
export async function scrubAuditLogForEntity(
  entityType: AnonymizableEntityType,
  entityId: string,
): Promise<number> {
  const fields = PII_FIELDS_BY_TYPE[entityType];
  if (!fields || fields.length === 0) return 0;

  // The AuditLogEntry table isn't in TENANT_SCOPED_MODELS or
  // SOFT_DELETE_MODELS in prisma.ts, so the extension is a no-op for
  // this query — straight `findMany` returns everything.
  const entries = await (prisma as any).auditLogEntry.findMany({
    where: { entityType, entityId },
  });

  let scrubbed = 0;
  for (const entry of entries) {
    const beforeScrub = scrubSnapshot(entry.before, fields);
    const afterScrub = scrubSnapshot(entry.after, fields);
    if (!beforeScrub.changed && !afterScrub.changed) continue;

    await (prisma as any).auditLogEntry.update({
      where: { id: entry.id },
      data: {
        before: beforeScrub.changed ? beforeScrub.value : entry.before,
        after: afterScrub.changed ? afterScrub.value : entry.after,
      },
    });
    scrubbed++;
  }

  return scrubbed;
}
