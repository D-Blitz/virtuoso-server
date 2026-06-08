/**
 * Client insights (N.6.8) — aggregated metrics for the
 * /admin/clients/:id UID page's chart + stats panel.
 *
 * Parallel to `facilitatorInsights.service` but oriented around
 * SPENDING rather than revenue:
 *
 *  - Headline charts:
 *      spendingOverTime      — daily spending buckets
 *      spendingByDimension   — per facilitator / room / location / service
 *
 *  - Stat cards:
 *      eventCount            — sessions attended (status != CANCELED)
 *      hoursTaken            — sum of event durations, hours
 *      uniqueFacilitatorCount — distinct facilitators worked with
 *      cancellationRate      — CANCELED / total (%)
 *      totalSpentCents       — Σ SUCCEEDED payments
 *      balanceDueCents       — Σ open invoice balances
 *
 *  - topFacilitators         — top 10 by spending
 *
 * Org-scoping is automatic via the Prisma extension. The route layer
 * checks permissions (CLIENT_VIEW); this service trusts the context.
 */

import prisma from '../prisma';

export interface ClientInsightsParams {
  clientId: string;
  from: Date;
  to: Date;
  /**
   * Optional dimension filters. Compose with AND — passing facilitatorId
   * + locationId scopes to events with THAT facilitator AT that location.
   */
  facilitatorId?: string;
  locationId?: string;
  serviceId?: string;
  roomId?: string;
}

interface BucketRow {
  date: string; // YYYY-MM-DD
  amountCents: number;
}

interface DimensionRow {
  id: string;
  name: string;
  amountCents: number;
  eventCount: number;
}

export interface ClientInsights {
  range: { from: string; to: string };
  spendingOverTime: BucketRow[];
  spendingByDimension: {
    byFacilitator: DimensionRow[];
    byRoom: DimensionRow[];
    byLocation: DimensionRow[];
    byService: DimensionRow[];
  };
  stats: {
    eventCount: number;
    uniqueFacilitatorCount: number;
    hoursTaken: number;
    cancellationRate: number;
    totalSpentCents: number;
    balanceDueCents: number;
    averagePerEventCents: number;
  };
  topFacilitators: DimensionRow[];
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export class ClientInsightsService {
  /**
   * Build the full insights payload for one client over [from, to].
   * One ScheduledEvent fetch + one Payment fetch + one Invoice fetch,
   * aggregated in JS. Indexed lookups throughout.
   */
  async get(params: ClientInsightsParams): Promise<ClientInsights> {
    const { clientId, from, to, facilitatorId, locationId, serviceId, roomId } =
      params;

    // ── 1. Events the client attended within the window ────────────────
    const eventFilter: any = {
      clients: { some: { id: clientId } },
      startTime: { lte: to },
      endTime: { gte: from },
    };
    if (locationId) eventFilter.locationId = locationId;
    if (serviceId) eventFilter.serviceId = serviceId;
    if (roomId) eventFilter.roomId = roomId;
    if (facilitatorId)
      eventFilter.facilitators = { some: { id: facilitatorId } };

    const events = await prisma.scheduledEvent.findMany({
      where: eventFilter,
      select: {
        id: true,
        startTime: true,
        endTime: true,
        price: true,
        status: true,
        roomId: true,
        locationId: true,
        serviceId: true,
        facilitators: {
          select: { id: true, firstname: true, lastname: true },
        },
        room: { select: { name: true } },
        location: { select: { name: true } },
        service: { select: { name: true } },
      },
    });

    // ── 2. Payments the client made within the window ──────────────────
    // The headline "totalSpent" + spending-over-time come from these. The
    // dimension filter narrows via the related event so the chart and the
    // bar breakdowns stay in sync.
    const paymentFilter: any = {
      clientId,
      status: 'SUCCEEDED',
      createdAt: { gte: from, lte: to },
    };
    const hasDimFilter = !!(locationId || serviceId || roomId || facilitatorId);
    if (hasDimFilter) {
      const relatedEvent: any = {};
      if (locationId) relatedEvent.locationId = locationId;
      if (serviceId) relatedEvent.serviceId = serviceId;
      if (roomId) relatedEvent.roomId = roomId;
      if (facilitatorId)
        relatedEvent.facilitators = { some: { id: facilitatorId } };
      paymentFilter.relatedScheduledEvent = relatedEvent;
    }
    const payments = await prisma.payment.findMany({
      where: paymentFilter,
      select: { amountCents: true, createdAt: true },
    });

    // ── 3. Invoices: outstanding balance across all invoices for the
    // client. We ignore the window for the balance because admins want
    // to see what's owed *now*, not what was owed in a past period.
    // `paidCents` isn't a stored column — derive it from each invoice's
    // settled (SUCCEEDED) payments.
    const invoices = await prisma.invoice.findMany({
      where: { clientId, status: { in: ['SENT', 'PARTIALLY_PAID'] } },
      select: {
        totalCents: true,
        payments: {
          where: { status: 'SUCCEEDED' },
          select: { amountCents: true },
        },
      },
    });
    const balanceDueCents = invoices.reduce((s, inv) => {
      const paid = inv.payments.reduce((p, pay) => p + pay.amountCents, 0);
      return s + Math.max(0, inv.totalCents - paid);
    }, 0);

    // ── 4. Spending over time + total. ─────────────────────────────────
    const dayKey = (d: Date) => ymd(d);
    const buckets = new Map<string, number>();
    for (const p of payments) {
      const k = dayKey(p.createdAt);
      buckets.set(k, (buckets.get(k) ?? 0) + p.amountCents);
    }
    const spendingOverTime: BucketRow[] = Array.from(buckets.entries())
      .map(([date, amountCents]) => ({ date, amountCents }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const totalSpentCents = payments.reduce((s, p) => s + p.amountCents, 0);

    // ── 5. Dimensions: aggregate ScheduledEvent prices grouped by
    // facilitator / room / location / service. The `price` column is the
    // catalog price of the event — represents the volume of activity per
    // dimension. The headline "Total dépensé" is from payments.
    const byFacilitator = new Map<
      string,
      { name: string; amountCents: number; eventCount: number }
    >();
    const byRoom = new Map<
      string,
      { name: string; amountCents: number; eventCount: number }
    >();
    const byLocation = new Map<
      string,
      { name: string; amountCents: number; eventCount: number }
    >();
    const byService = new Map<
      string,
      { name: string; amountCents: number; eventCount: number }
    >();

    const inWindow = (start: Date, end: Date) =>
      start.getTime() <= to.getTime() && end.getTime() >= from.getTime();

    let eventCount = 0;
    let canceledCount = 0;
    let hoursTaken = 0;
    const facIdSet = new Set<string>();

    for (const e of events) {
      const start = new Date(e.startTime);
      const end = new Date(e.endTime);
      if (!inWindow(start, end)) continue;

      const priceCents = Math.round((e.price ?? 0) * 100);

      if (e.status === 'CANCELED') {
        canceledCount += 1;
        continue;
      }
      eventCount += 1;
      hoursTaken += (end.getTime() - start.getTime()) / 3600_000;

      // By facilitator (one event can have several).
      for (const f of e.facilitators) {
        facIdSet.add(f.id);
        const cur = byFacilitator.get(f.id) ?? {
          name: `${f.firstname ?? ''} ${f.lastname ?? ''}`.trim(),
          amountCents: 0,
          eventCount: 0,
        };
        cur.amountCents += priceCents;
        cur.eventCount += 1;
        byFacilitator.set(f.id, cur);
      }

      if (e.roomId) {
        const cur = byRoom.get(e.roomId) ?? {
          name: e.room?.name ?? '—',
          amountCents: 0,
          eventCount: 0,
        };
        cur.amountCents += priceCents;
        cur.eventCount += 1;
        byRoom.set(e.roomId, cur);
      }

      if (e.locationId) {
        const cur = byLocation.get(e.locationId) ?? {
          name: e.location?.name ?? '—',
          amountCents: 0,
          eventCount: 0,
        };
        cur.amountCents += priceCents;
        cur.eventCount += 1;
        byLocation.set(e.locationId, cur);
      }

      if (e.serviceId) {
        const cur = byService.get(e.serviceId) ?? {
          name: e.service?.name ?? '—',
          amountCents: 0,
          eventCount: 0,
        };
        cur.amountCents += priceCents;
        cur.eventCount += 1;
        byService.set(e.serviceId, cur);
      }
    }

    const toSortedRows = (
      m: Map<string, { name: string; amountCents: number; eventCount: number }>,
    ): DimensionRow[] =>
      Array.from(m.entries())
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => b.amountCents - a.amountCents);

    const totalForRate = eventCount + canceledCount;
    const cancellationRate =
      totalForRate > 0 ? canceledCount / totalForRate : 0;

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      spendingOverTime,
      spendingByDimension: {
        byFacilitator: toSortedRows(byFacilitator),
        byRoom: toSortedRows(byRoom),
        byLocation: toSortedRows(byLocation),
        byService: toSortedRows(byService),
      },
      stats: {
        eventCount,
        uniqueFacilitatorCount: facIdSet.size,
        hoursTaken: Math.round(hoursTaken * 100) / 100,
        cancellationRate: Math.round(cancellationRate * 1000) / 1000,
        totalSpentCents,
        balanceDueCents,
        averagePerEventCents:
          eventCount > 0 ? Math.round(totalSpentCents / eventCount) : 0,
      },
      topFacilitators: toSortedRows(byFacilitator).slice(0, 10),
    };
  }
}

export const clientInsightsService = new ClientInsightsService();
