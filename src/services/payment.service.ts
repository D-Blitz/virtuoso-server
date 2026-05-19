import prisma from '../prisma';

/**
 * Admin-side read of the Payment table, scoped to the requesting user's org
 * via the Prisma extension. Paginated; trimmed `include` shape (only what the
 * admin table actually renders).
 *
 * Stats are computed via a separate query so the dashboard's summary cards
 * reflect the entire filter-set rather than just the current page.
 */
export type ListPaymentsFilters = {
  status?: string;     // PENDING | SUCCEEDED | FAILED | REFUNDED
  purpose?: string;    // TRIAL_LESSON | ENROLLMENT_BALANCE
  from?: Date;
  to?: Date;
};

export type ListPaymentsArgs = ListPaymentsFilters & {
  page?: number;     // 1-indexed
  pageSize?: number; // capped to MAX_PAGE_SIZE
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class PaymentService {
  private buildWhere(filters: ListPaymentsFilters) {
    return {
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
    };
  }

  async list(
    args: ListPaymentsArgs = {},
  ): Promise<{ items: any[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)),
    );
    const where = this.buildWhere(args);

    // Run page + count in parallel — both hit the same indexed where clause.
    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        where,
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
              service: { select: { id: true, name: true } },
              facilitators: {
                select: { id: true, firstname: true, lastname: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.payment.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /**
   * Aggregate stats for the dashboard summary cards. Independent of paging
   * so the cards reflect every row that matches the filters, not just the
   * page currently rendered.
   */
  async stats(filters: ListPaymentsFilters = {}): Promise<{
    succeededCents: number;
    succeededCount: number;
    pendingCount: number;
    failedCount: number;
    refundedCount: number;
    currency: string;
  }> {
    const baseWhere = this.buildWhere(filters);

    const [succeededAgg, byStatus, anyForCurrency] = await Promise.all([
      prisma.payment.aggregate({
        where: { ...baseWhere, status: 'SUCCEEDED' },
        _sum: { amountCents: true },
      }),
      prisma.payment.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
      // We don't store a per-org currency — sample any matching row to pick
      // a label. Fallback to EUR if there are no rows.
      prisma.payment.findFirst({
        where: baseWhere,
        select: { currency: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const countsByStatus = new Map<string, number>();
    for (const row of byStatus) {
      countsByStatus.set(row.status, row._count._all);
    }

    return {
      succeededCents: succeededAgg._sum.amountCents ?? 0,
      succeededCount: countsByStatus.get('SUCCEEDED') ?? 0,
      pendingCount: countsByStatus.get('PENDING') ?? 0,
      failedCount: countsByStatus.get('FAILED') ?? 0,
      refundedCount: countsByStatus.get('REFUNDED') ?? 0,
      currency: anyForCurrency?.currency ?? 'EUR',
    };
  }
}
