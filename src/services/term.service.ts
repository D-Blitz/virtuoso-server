import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotTerm } from './audit/snapshots';

export class TermService {
  async create(data: any) {
    const created = await prisma.term.create({
      data,
      include: { location: true },
    });
    void auditLog.record({
      action: 'CREATE',
      entityType: 'Term',
      entityId: created.id,
      after: snapshotTerm(created),
    });
    return created;
  }

  async getAll() {
    return prisma.term.findMany({
      include: { location: true },
      orderBy: { startDate: 'asc' },
    });
  }

  async update(id: string, data: any) {
    const before = await prisma.term.findUniqueOrThrow({ where: { id } });
    const updated = await prisma.term.update({
      where: { id },
      data,
      include: { location: true },
    });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Term',
      entityId: id,
      before: snapshotTerm(before),
      after: snapshotTerm(updated),
    });
    return updated;
  }

  async delete(id: string) {
    const before = await prisma.term.findUniqueOrThrow({ where: { id } });
    const deleted = await prisma.term.delete({ where: { id } });
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Term',
      entityId: id,
      before: snapshotTerm(before),
    });
    return deleted;
  }
}
