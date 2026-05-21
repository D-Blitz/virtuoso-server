import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotLocation } from './audit/snapshots';
import { softDelete } from './trash/softDelete';

export class LocationService {
  async create(data: any) {
    const created = await prisma.location.create({ data });
    void auditLog.record({
      action: 'CREATE',
      entityType: 'Location',
      entityId: created.id,
      after: snapshotLocation(created),
    });
    return created;
  }

  async getAll() {
    return prisma.location.findMany();
  }

  async update(id: string, data: any) {
    const before = await prisma.location.findUniqueOrThrow({ where: { id } });
    const updated = await prisma.location.update({ where: { id }, data });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Location',
      entityId: id,
      before: snapshotLocation(before),
      after: snapshotLocation(updated),
    });
    return updated;
  }

  async delete(id: string) {
    const before = await softDelete<any>('location', id);
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Location',
      entityId: id,
      before: snapshotLocation(before),
    });
    return before;
  }
}
