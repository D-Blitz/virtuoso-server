import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotClosure } from './audit/snapshots';
import { softDelete } from './trash/softDelete';

export class ClosureService {
  async create(data: any) {
    const created = await prisma.closure.create({
      data,
      include: { location: true },
    });
    void auditLog.record({
      action: 'CREATE',
      entityType: 'Closure',
      entityId: created.id,
      after: snapshotClosure(created),
    });
    return created;
  }

  async getAll() {
    return prisma.closure.findMany({
      include: { location: true },
      orderBy: { startDate: 'asc' },
    });
  }

  async update(id: string, data: any) {
    const before = await prisma.closure.findUniqueOrThrow({ where: { id } });
    const updated = await prisma.closure.update({
      where: { id },
      data,
      include: { location: true },
    });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Closure',
      entityId: id,
      before: snapshotClosure(before),
      after: snapshotClosure(updated),
    });
    return updated;
  }

  async delete(id: string) {
    const before = await softDelete<any>('closure', id);
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Closure',
      entityId: id,
      before: snapshotClosure(before),
    });
    return before;
  }
}
