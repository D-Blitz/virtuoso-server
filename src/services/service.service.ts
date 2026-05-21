import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotService } from './audit/snapshots';
import { softDelete } from './trash/softDelete';

const SERVICE_INCLUDE = {
  facilitators: true,
  tags: true,
  serviceCategory: true,
} as const;

export class ServiceService {
  async create(data: any) {
    const created = await prisma.service.create({
      data,
      include: SERVICE_INCLUDE,
    });
    void auditLog.record({
      action: 'CREATE',
      entityType: 'Service',
      entityId: created.id,
      after: snapshotService(created),
    });
    return created;
  }

  async getAll() {
    return prisma.service.findMany({ include: SERVICE_INCLUDE });
  }

  async update(id: string, data: any) {
    const before = await prisma.service.findUniqueOrThrow({ where: { id } });
    const updated = await prisma.service.update({
      where: { id },
      data,
      include: SERVICE_INCLUDE,
    });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Service',
      entityId: id,
      before: snapshotService(before),
      after: snapshotService(updated),
    });
    return updated;
  }

  async delete(id: string) {
    const before = await softDelete<any>('service', id);
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Service',
      entityId: id,
      before: snapshotService(before),
    });
    return before;
  }
}
