import { auditLog } from '../audit/audit.service';
import { snapshotClient, snapshotFacilitator } from '../audit/snapshots';
import {
  ANONYMIZABLE_ENTITY_TYPES,
  anonymize as anonymizePrimitive,
  type AnonymizableEntityType,
} from './anonymize';

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
   * Audited as UPDATE so the diff carries the redacted-field list;
   * Payment / Enrollment FKs survive untouched.
   */
  async anonymize(
    entityType: AnonymizableEntityType,
    id: string,
  ): Promise<void> {
    const { before, after } = await anonymizePrimitive(entityType, id);
    const snap = snapshotterFor(entityType);
    void auditLog.record({
      action: 'UPDATE',
      entityType,
      entityId: id,
      before: snap(before),
      after: snap(after),
    });
  }
}
