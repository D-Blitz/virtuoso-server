import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotRoom } from './audit/snapshots';

export class RoomService {
  async create(data: any) {
    const created = await prisma.room.create({ data });
    void auditLog.record({
      action: 'CREATE',
      entityType: 'Room',
      entityId: created.id,
      after: snapshotRoom(created),
    });
    return created;
  }

  async getAll() {
    return prisma.room.findMany();
  }

  async update(id: string, data: any) {
    const before = await prisma.room.findUniqueOrThrow({ where: { id } });
    const updated = await prisma.room.update({ where: { id }, data });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Room',
      entityId: id,
      before: snapshotRoom(before),
      after: snapshotRoom(updated),
    });
    return updated;
  }

  async delete(id: string) {
    const before = await prisma.room.findUniqueOrThrow({ where: { id } });
    const deleted = await prisma.room.delete({ where: { id } });
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Room',
      entityId: id,
      before: snapshotRoom(before),
    });
    return deleted;
  }
}
