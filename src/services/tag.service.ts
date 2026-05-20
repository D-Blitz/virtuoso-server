import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotTag } from './audit/snapshots';

export class TagService {
  async create(data: any) {
    const created = await prisma.tag.create({ data });
    void auditLog.record({
      action: 'CREATE',
      entityType: 'Tag',
      entityId: created.id,
      after: snapshotTag(created),
    });
    return created;
  }

  async getAll() {
    return prisma.tag.findMany();
  }

  async update(id: string, data: any) {
    const before = await prisma.tag.findUniqueOrThrow({ where: { id } });
    const updated = await prisma.tag.update({ where: { id }, data });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Tag',
      entityId: id,
      before: snapshotTag(before),
      after: snapshotTag(updated),
    });
    return updated;
  }

  async delete(id: string) {
    const before = await prisma.tag.findUniqueOrThrow({ where: { id } });
    const deleted = await prisma.tag.delete({ where: { id } });
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Tag',
      entityId: id,
      before: snapshotTag(before),
    });
    return deleted;
  }
}
