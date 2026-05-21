import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotFacilitator } from './audit/snapshots';
import { softDelete } from './trash/softDelete';

export class FacilitatorService {
  async create(data: any) {
    const created = await prisma.facilitator.create({
      data,
      include: {
        locations: true,
        tags: true,
      },
    });
    void auditLog.record({
      action: 'CREATE',
      entityType: 'Facilitator',
      entityId: created.id,
      after: snapshotFacilitator(created),
    });
    return created;
  }

  async getAll() {
    return prisma.facilitator.findMany({
      include: {
        locations: true,
        tags: true,
      },
    });
  }

  async update(id: string, data: any) {
    const before = await prisma.facilitator.findUniqueOrThrow({
      where: { id },
    });
    const updated = await prisma.facilitator.update({
      where: { id },
      data,
      include: {
        locations: true,
        tags: true,
      },
    });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Facilitator',
      entityId: id,
      before: snapshotFacilitator(before),
      after: snapshotFacilitator(updated),
    });
    return updated;
  }

  async delete(id: string) {
    // Soft-delete via the trash bin (Phase 0.5). Audit log still records
    // a DELETE entry — that's the user-facing semantic, even though the
    // mechanism is an UPDATE setting deletedAt.
    const before = await softDelete<any>('facilitator', id);
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Facilitator',
      entityId: id,
      before: snapshotFacilitator(before),
    });
    return before;
  }
}
