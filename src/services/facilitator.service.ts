import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotFacilitator } from './audit/snapshots';

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
    const before = await prisma.facilitator.findUniqueOrThrow({ where: { id } });
    const deleted = await prisma.facilitator.delete({ where: { id } });
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Facilitator',
      entityId: id,
      before: snapshotFacilitator(before),
    });
    return deleted;
  }
}
