import { Prisma } from '@prisma/client';

import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotLocation } from './audit/snapshots';
import { softDelete } from './trash/softDelete';

export class LocationService {
  /**
   * Rooms in this location that currently override the venue's opening
   * hours. Powers the confirmation dialog behind "Appliquer à toutes
   * les salles" — these are exactly the rooms that would lose their own
   * schedule, so the admin sees them by name before deciding.
   */
  async getRoomsWithCustomHours(
    locationId: string,
  ): Promise<{ id: string; name: string }[]> {
    return prisma.room.findMany({
      // `{ not: DbNull }` targets SQL NULL specifically — a top-level
// NOT on a nullable Json column doesn't compile.
where: { locationId, availability: { not: Prisma.DbNull } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Make every room in this location follow the venue's opening hours,
   * by clearing their own overrides.
   *
   * Note this CLEARS rather than copies: a room is set back to null so
   * it inherits from here on, which means a later edit to the venue's
   * hours reaches it too. Copying the hours in would leave every room
   * looking hand-configured and put us right back where we started.
   */
  async applyOpeningHoursToRooms(
    locationId: string,
  ): Promise<{ reset: number; alreadyInheriting: number; total: number }> {
    const affected = await this.getRoomsWithCustomHours(locationId);
    const total = await prisma.room.count({ where: { locationId } });

    if (affected.length > 0) {
      await prisma.room.updateMany({
        // `{ not: DbNull }` targets SQL NULL specifically — a top-level
// NOT on a nullable Json column doesn't compile.
where: { locationId, availability: { not: Prisma.DbNull } },
        data: { availability: Prisma.DbNull },
      });
    }

    // One audit entry for the batch — the per-room before/after is the
    // same fact repeated, and the entry names the location that drove it.
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Location',
      entityId: locationId,
      after: {
        appliedOpeningHoursToRooms: affected.map((r) => r.name),
      },
    });

    return {
      reset: affected.length,
      alreadyInheriting: total - affected.length,
      total,
    };
  }
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
