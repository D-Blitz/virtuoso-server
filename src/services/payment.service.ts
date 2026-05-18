import prisma from '../prisma';

/**
 * Admin-side read of the Payment table, scoped to the requesting user's org
 * via the Prisma extension. Optional filters: status, purpose, date range.
 */
export type ListPaymentsFilters = {
  status?: string;     // PENDING | SUCCEEDED | FAILED | REFUNDED
  purpose?: string;    // TRIAL_LESSON | ENROLLMENT_BALANCE
  from?: Date;
  to?: Date;
};

export class PaymentService {
  async list(filters: ListPaymentsFilters = {}) {
    return prisma.payment.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.purpose ? { purpose: filters.purpose } : {}),
        ...(filters.from || filters.to
          ? {
              createdAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
      include: {
        client: {
          select: { id: true, firstname: true, lastname: true, email: true },
        },
        relatedScheduledEvent: {
          select: {
            id: true,
            startTime: true,
            endTime: true,
            status: true,
            service: {
              select: {
                id: true,
                name: true,
                serviceCategory: { select: { id: true, name: true } },
              },
            },
            facilitators: {
              select: { id: true, firstname: true, lastname: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
