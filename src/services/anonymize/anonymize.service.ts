import { auditLog } from '../audit/audit.service';
import { snapshotClient, snapshotFacilitator } from '../audit/snapshots';
import {
  ANONYMIZABLE_ENTITY_TYPES,
  anonymize as anonymizePrimitive,
  type AnonymizableEntityType,
} from './anonymize';
import { scrubAuditLogForEntity } from './auditScrub';

export { ANONYMIZABLE_ENTITY_TYPES, type AnonymizableEntityType };

function snapshotterFor(
  entityType: AnonymizableEntityType,
): (row: any) => object | null {
  switch (entityType) {
    case 'Client':
      return snapshotClient;
    case 'Facilitator':
      return snapshotFacilitator;
  }
}

export class AnonymizeService {
  /**
   * Redact the personally-identifying columns of a Client or
   * Facilitator. The row must already be in trash or archive
   * (`/admin/corbeille` or `/admin/archives` are the call sites).
   *
   * Three operations happen in this order:
   *   1. Row redaction — PII columns replaced with placeholders,
   *      metadata stamped with { anonymized: true, … }. If the row
   *      was trashed, it ALSO transitions to archive (anonymize is
   *      irreversible, so the trash bin's "might restore" semantic
   *      no longer applies). See anonymize.ts.
   *   2. Audit-log scrub — every past AuditLogEntry referencing this
   *      row has its `before` / `after` snapshots scrubbed of PII.
   *      Closes the GDPR gap where the audit log would otherwise
   *      retain the data subject's identifying values forever.
   *      See auditScrub.ts.
   *   3. Audit entry for the anonymize action itself — UPDATE entry
   *      whose diff lists the redacted fields. This is the record
   *      that the GDPR action was performed; it's NOT scrubbed
   *      because it IS the audit trail of the scrub.
   *
   * Payment / Enrollment FKs survive untouched through all of this.
   */
  async anonymize(
    entityType: AnonymizableEntityType,
    id: string,
  ): Promise<void> {
    const { before, after } = await anonymizePrimitive(entityType, id);

    // Step 2 — scrub past audit-log entries for this entity. Done
    // BEFORE writing the anonymize audit entry so the new entry isn't
    // itself a candidate for scrubbing on its own first read.
    let scrubbedCount = 0;
    try {
      scrubbedCount = await scrubAuditLogForEntity(entityType, id);
    } catch (err) {
      // If the audit scrub fails, log loudly but don't fail the
      // overall anonymize — the row's PII is already gone, and the
      // admin can retry the scrub if needed. Better than leaving the
      // row in an inconsistent state.
      console.error(
        `[anonymize] auditScrub failed for ${entityType} ${id}:`,
        err,
      );
    }

    const snap = snapshotterFor(entityType);
    void auditLog.record({
      action: 'UPDATE',
      entityType,
      entityId: id,
      before: snap(before),
      after: snap(after),
    });

    if (scrubbedCount > 0) {
      console.log(
        `[anonymize] ${entityType} ${id}: scrubbed PII from ${scrubbedCount} past audit entries`,
      );
    }
  }
}
