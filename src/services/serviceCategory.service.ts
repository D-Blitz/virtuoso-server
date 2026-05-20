import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotServiceCategory } from './audit/snapshots';

export class ServiceCategoryService {
  async create(data: any) {
    const created = await prisma.serviceCategory.create({ data });
    void auditLog.record({
      action: 'CREATE',
      entityType: 'ServiceCategory',
      entityId: created.id,
      after: snapshotServiceCategory(created),
    });
    return created;
  }

  async getAll() {
    return prisma.serviceCategory.findMany();
  }

  async update(id: string, data: any) {
    const before = await prisma.serviceCategory.findUniqueOrThrow({
      where: { id },
    });
    const updated = await prisma.serviceCategory.update({
      where: { id },
      data,
    });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'ServiceCategory',
      entityId: id,
      before: snapshotServiceCategory(before),
      after: snapshotServiceCategory(updated),
    });
    return updated;
  }

  async delete(id: string) {
    const before = await prisma.serviceCategory.findUniqueOrThrow({
      where: { id },
    });
    const deleted = await prisma.serviceCategory.delete({ where: { id } });
    void auditLog.record({
      action: 'DELETE',
      entityType: 'ServiceCategory',
      entityId: id,
      before: snapshotServiceCategory(before),
    });
    return deleted;
  }
}
