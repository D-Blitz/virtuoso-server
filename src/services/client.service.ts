import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotClient } from './audit/snapshots';
import { softDelete } from './trash/softDelete';

export class ClientService {
  async create(data: any) {
    const created = await prisma.client.create({ data });
    void auditLog.record({
      action: 'CREATE',
      entityType: 'Client',
      entityId: created.id,
      after: snapshotClient(created),
    });
    return created;
  }

  async getAll() {
    return prisma.client.findMany();
  }

  async update(id: string, data: any) {
    const before = await prisma.client.findUniqueOrThrow({ where: { id } });
    const updated = await prisma.client.update({ where: { id }, data });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Client',
      entityId: id,
      before: snapshotClient(before),
      after: snapshotClient(updated),
    });
    return updated;
  }

  async delete(id: string) {
    const before = await softDelete<any>('client', id);
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Client',
      entityId: id,
      before: snapshotClient(before),
    });
    return before;
  }
}
