import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotEnrollment } from './audit/snapshots';

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
    const before = await prisma.enrollment.findUniqueOrThrow({
      where: { id },
    });
    const deleted = await prisma.enrollment.delete({ where: { id } });
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Enrollment',
      entityId: id,
      before: snapshotEnrollment(before),
    });
    return deleted;
  }
}
