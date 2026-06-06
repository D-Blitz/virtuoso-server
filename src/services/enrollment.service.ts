import prisma from '../prisma';
import { getContext, getOrganizationId } from '../auth/context';
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

  /**
   * Enrollment detail + its billing footprint, for the enrollment detail
   * page. The link to money is LOOSE (no hard FK): an invoice belongs to the
   * enrollment when one of its lines is tagged with this enrollmentId; a
   * payment belongs when its `relatedEnrollmentId` matches. We surface both
   * sides plus a small summary (agreed price vs. billed vs. settled).
   *
   * Org-scoped explicitly (the detail page is reachable by URL id) so a
   * crafted id can never read another tenant's enrollment or billing.
   */
  async getOneWithBilling(id: string) {
    const organizationId = getOrganizationId();
    if (!organizationId) return null;

    const enrollment = await prisma.enrollment.findFirst({
      where: { id, organizationId },
      include: ENROLLMENT_INCLUDE,
    });
    if (!enrollment) return null;

    const [invoiceRows, paymentRows] = await Promise.all([
      prisma.invoice.findMany({
        where: { organizationId, lines: { some: { enrollmentId: id } } },
        include: {
          // Only the line(s) tied to THIS enrollment — so we can show how
          // much of a (possibly multi-line) invoice the enrollment drove.
          lines: {
            where: { enrollmentId: id },
            select: { id: true, description: true, amountCents: true },
          },
          payments: { select: { amountCents: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payment.findMany({
        where: { organizationId, relatedEnrollmentId: id },
        include: { invoice: { select: { id: true, number: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const invoices = invoiceRows.map((inv) => {
      // Balance is derived: only SETTLED payments (SUCCEEDED) count, so an
      // uncashed cheque doesn't inflate the paid figure — same rule as the
      // invoice service.
      const paidCents = inv.payments
        .filter((p) => p.status === 'SUCCEEDED')
        .reduce((sum, p) => sum + p.amountCents, 0);
      return {
        id: inv.id,
        number: inv.number,
        status: inv.status,
        currency: inv.currency,
        issueDate: inv.issueDate,
        createdAt: inv.createdAt,
        totalCents: inv.totalCents,
        paidCents,
        balanceCents: inv.totalCents - paidCents,
        enrollmentLineCents: inv.lines.reduce((s, l) => s + l.amountCents, 0),
      };
    });

    const payments = paymentRows.map((p) => ({
      id: p.id,
      method: p.method,
      status: p.status,
      amountCents: p.amountCents,
      currency: p.currency,
      chequeStatus: p.chequeStatus,
      receivedAt: p.receivedAt,
      createdAt: p.createdAt,
      invoice: p.invoice
        ? { id: p.invoice.id, number: p.invoice.number }
        : null,
    }));

    const invoicedCents = invoices.reduce((s, i) => s + i.totalCents, 0);
    const settledCents = payments
      .filter((p) => p.status === 'SUCCEEDED')
      .reduce((s, p) => s + p.amountCents, 0);
    const currency = invoices[0]?.currency ?? payments[0]?.currency ?? 'EUR';

    return {
      enrollment,
      invoices,
      payments,
      summary: { invoicedCents, settledCents, currency },
    };
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
