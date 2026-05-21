import prisma from '../prisma';
import { getContext } from '../auth/context';
import { auditLog } from './audit/audit.service';
import { snapshotEnrollment, snapshotScheduledEvent } from './audit/snapshots';
import { softDelete } from './trash/softDelete';

const ENROLLMENT_INCLUDE = {
  client: true,
  facilitator: true,
  room: true,
  location: true,
  term: true,
  service: {
    include: {
      serviceCategory: true,
    },
  },
  events: true,
} as const;

export class EnrollmentService {
  async create(data: any) {
    const created = await prisma.enrollment.create({
      data,
      include: ENROLLMENT_INCLUDE,
    });
    void auditLog.record({
      action: 'CREATE',
      entityType: 'Enrollment',
      entityId: created.id,
      after: snapshotEnrollment(created),
    });
    return created;
  }

  async getAll() {
    return prisma.enrollment.findMany({
      include: ENROLLMENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, data: any) {
    const before = await prisma.enrollment.findUniqueOrThrow({
      where: { id },
    });
    const updated = await prisma.enrollment.update({
      where: { id },
      data,
      include: ENROLLMENT_INCLUDE,
    });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Enrollment',
      entityId: id,
      before: snapshotEnrollment(before),
      after: snapshotEnrollment(updated),
    });
    return updated;
  }

  async delete(id: string) {
    // Cascade: deleting an enrollment should also soft-delete every
    // ScheduledEvent linked to it. Each event row gets its own audit
    // DELETE entry so the audit trail is complete.
    const ctx = getContext();
    const deletedAt = new Date();
    const deletedById = ctx?.userId ?? null;

    const result = await prisma.$transaction(async (tx) => {
      // Snapshot the enrollment + its events BEFORE the soft-delete so
      // we can populate audit before-snapshots.
      const before = await tx.enrollment.findUniqueOrThrow({
        where: { id },
        include: ENROLLMENT_INCLUDE,
      });
      const eventRows = await tx.scheduledEvent.findMany({
        where: { enrollmentId: id } as any,
      });

      // Soft-delete every linked event (updateMany bypasses the default
      // deletedAt:null scope because we mention deletedAt explicitly).
      await tx.scheduledEvent.updateMany({
        where: { enrollmentId: id } as any,
        data: { deletedAt, deletedById } as any,
      });

      // Soft-delete the enrollment itself.
      await tx.enrollment.update({
        where: { id },
        data: { deletedAt, deletedById } as any,
      });

      return { before, eventRows };
    });

    // Audit the enrollment DELETE + one DELETE per cascaded event.
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Enrollment',
      entityId: id,
      before: snapshotEnrollment(result.before),
    });
    for (const ev of result.eventRows) {
      void auditLog.record({
        action: 'DELETE',
        entityType: 'ScheduledEvent',
        entityId: (ev as any).id,
        before: snapshotScheduledEvent(ev),
      });
    }

    return result.before;
  }
}
