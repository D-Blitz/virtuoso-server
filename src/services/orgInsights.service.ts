/**
 * Org-wide dashboard insights (N.6.9). Aggregates everything across the
 * whole organisation for the headline `/admin/dashboard` page:
 *
 *   - revenueOverTime    — daily school + intervenant split (paired
 *                          PaymentAllocations bucketed by createdAt)
 *   - revenueSplit       — donut totals
 *   - cashFlow           — payments grouped by method (STRIPE / CHECK /
 *                          CASH / BANK_TRANSFER / OTHER)
 *   - topFacilitators    — top 10 by FAC-allocation revenue
 *   - topClients         — top 10 by payment volume
 *   - topServices        — top 10 by event price aggregate
 *   - topLocations       — top 10 by event price aggregate
 *   - stats              — eventCount, hoursBooked, activeClientCount,
 *                          activeFacilitatorCount, revenueCents,
 *                          balanceDueCents, chequesPendingCount,
 *                          chequesPendingCents, cancellationRate,
 *                          avgEventValueCents
 *   - upcomingEvents     — light array of the next 14 days
 *
 * Filter contract mirrors the per-resource endpoints — accept
 * locationId / serviceId / facilitatorId to drill in. roomId is
 * deliberately absent at the org level (drill all the way down to a
 * room via the room UID page).
 */

import prisma from '../prisma';

export interface OrgInsightsParams {
  from: Date;
  to: Date;
  locationId?: string;
  serviceId?: string;
  facilitatorId?: string;
}

interface BucketRow {
  date: string;
  school: number;
  facilitator: number;
}

interface DimensionRow {
  id: string;
  name: string;
  amountCents: number;
  eventCount: number;
}

interface CashFlowRow {
  method: string;
  amountCents: number;
  paymentCount: number;
}

interface UpcomingEvent {
  id: string;
  startTime: string;
  endTime: string;
  status: string;
  facilitatorName: string | null;
  clientName: string | null;
  serviceName: string | null;
  locationName: string | null;
  roomName: string | null;
}

export interface OrgInsights {
  range: { from: string; to: string };
  revenueOverTime: BucketRow[];
  revenueSplit: { school: number; facilitator: number; total: number };
  cashFlow: CashFlowRow[];
  topFacilitators: DimensionRow[];
  topClients: DimensionRow[];
  topServices: DimensionRow[];
  topLocations: DimensionRow[];
  stats: {
    eventCount: number;
    hoursBooked: number;
    activeClientCount: number;
    activeFacilitatorCount: number;
    revenueCents: number;
    balanceDueCents: number;
    chequesPendingCount: number;
    chequesPendingCents: number;
    cancellationRate: number;
    averageEventValueCents: number;
  };
  upcomingEvents: UpcomingEvent[];
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export class OrgInsightsService {
  async get(params: OrgInsightsParams): Promise<OrgInsights> {
    const { from, to, locationId, serviceId, facilitatorId } = params;
    const hasDimFilter = !!(locationId || serviceId || facilitatorId);

    // Event-side filter (drives the dimension breakdowns + stats).
    const eventFilter: any = {
      startTime: { lte: to },
      endTime: { gte: from },
    };
    if (locationId) eventFilter.locationId = locationId;
    if (serviceId) eventFilter.serviceId = serviceId;
    if (facilitatorId)
      eventFilter.facilitators = { some: { id: facilitatorId } };

    // Payment-side filter (drives revenue series + cash flow).
    const paymentFilter: any = {
      status: 'SUCCEEDED',
      createdAt: { gte: from, lte: to },
    };
    if (hasDimFilter) {
      const relatedEvent: any = {};
      if (locationId) relatedEvent.locationId = locationId;
      if (serviceId) relatedEvent.serviceId = serviceId;
      if (facilitatorId)
        relatedEvent.facilitators = { some: { id: facilitatorId } };
      paymentFilter.relatedScheduledEvent = relatedEvent;
    }

    // ── 1. Events + payments + cheques in parallel ─────────────────────
    const [events, payments, openInvoices, pendingCheques] = await Promise.all([
      prisma.scheduledEvent.findMany({
        where: eventFilter,
        select: {
          id: true,
          startTime: true,
          endTime: true,
          price: true,
          status: true,
          locationId: true,
          serviceId: true,
          roomId: true,
          facilitators: {
            select: { id: true, firstname: true, lastname: true },
          },
          clients: { select: { id: true, firstname: true, lastname: true } },
          service: { select: { name: true } },
          location: { select: { name: true } },
          room: { select: { name: true } },
        },
      }),
      prisma.payment.findMany({
        where: paymentFilter,
        select: {
          id: true,
          amountCents: true,
          createdAt: true,
          method: true,
          clientId: true,
          client: { select: { firstname: true, lastname: true } },
          allocations: {
            select: {
              beneficiaryType: true,
              facilitatorId: true,
              amountCents: true,
              createdAt: true,
              facilitator: { select: { firstname: true, lastname: true } },
            },
          },
        },
      }),
      // Open invoices for balance due — ignored by window because admins
      // want what's owed *now*.
      prisma.invoice.findMany({
        where: { status: { in: ['SENT', 'PARTIALLY_PAID'] } },
        select: {
          totalCents: true,
          payments: {
            where: { status: 'SUCCEEDED' },
            select: { amountCents: true },
          },
        },
      }),
      // Cheques that have been registered but haven't cleared yet —
      // chequeStatus pre-CASHED (PENDING_DEPOSIT + DEPOSITED).
      prisma.payment.findMany({
        where: {
          method: 'CHECK',
          chequeStatus: { in: ['PENDING_DEPOSIT', 'DEPOSITED'] },
        },
        select: { amountCents: true },
      }),
    ]);

    // ── 2. Revenue series (paired allocations) + cash-flow + top
    // facilitators (FAC allocations) + top clients (payment totals). ──
    const buckets = new Map<string, { school: number; facilitator: number }>();
    const cashByMethod = new Map<
      string,
      { amountCents: number; paymentCount: number }
    >();
    const byFacilitator = new Map<
      string,
      { name: string; amountCents: number; eventCount: number }
    >();
    const byClient = new Map<
      string,
      { name: string; amountCents: number; eventCount: number }
    >();

    let facTotal = 0;
    let schoolTotal = 0;

    for (const p of payments) {
      // cash flow by method
      const m = cashByMethod.get(p.method) ?? {
        amountCents: 0,
        paymentCount: 0,
      };
      m.amountCents += p.amountCents;
      m.paymentCount += 1;
      cashByMethod.set(p.method, m);

      // by client
      if (p.clientId && p.client) {
        const cur = byClient.get(p.clientId) ?? {
          name: `${p.client.firstname ?? ''} ${p.client.lastname ?? ''}`.trim(),
          amountCents: 0,
          eventCount: 0,
        };
        cur.amountCents += p.amountCents;
        cur.eventCount += 1; // payment count, displayed as "transactions"
        byClient.set(p.clientId, cur);
      }

      // allocations → revenue series + by facilitator
      for (const a of p.allocations) {
        const k = ymd(a.createdAt);
        const b = buckets.get(k) ?? { school: 0, facilitator: 0 };
        if (a.beneficiaryType === 'SCHOOL') {
          b.school += a.amountCents;
          schoolTotal += a.amountCents;
        } else if (a.beneficiaryType === 'FACILITATOR') {
          b.facilitator += a.amountCents;
          facTotal += a.amountCents;
          if (a.facilitatorId && a.facilitator) {
            const cur = byFacilitator.get(a.facilitatorId) ?? {
              name: `${a.facilitator.firstname ?? ''} ${a.facilitator.lastname ?? ''}`.trim(),
              amountCents: 0,
              eventCount: 0,
            };
            cur.amountCents += a.amountCents;
            cur.eventCount += 1;
            byFacilitator.set(a.facilitatorId, cur);
          }
        }
        buckets.set(k, b);
      }
    }

    const revenueOverTime: BucketRow[] = Array.from(buckets.entries())
      .map(([date, v]) => ({ date, school: v.school, facilitator: v.facilitator }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const revenueSplit = {
      school: schoolTotal,
      facilitator: facTotal,
      total: schoolTotal + facTotal,
    };
    const cashFlow: CashFlowRow[] = Array.from(cashByMethod.entries())
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.amountCents - a.amountCents);

    // ── 3. Event-driven aggregates: services + locations + activity
    // stats. ────────────────────────────────────────────────────────────
    const byService = new Map<
      string,
      { name: string; amountCents: number; eventCount: number }
    >();
    const byLocation = new Map<
      string,
      { name: string; amountCents: number; eventCount: number }
    >();

    let eventCount = 0;
    let canceledCount = 0;
    let hoursBooked = 0;
    let eventPriceTotal = 0;
    const activeFacIds = new Set<string>();
    const activeClientIds = new Set<string>();

    for (const e of events) {
      if (e.status === 'CANCELED') {
        canceledCount += 1;
        continue;
      }
      eventCount += 1;
      const priceCents = Math.round((e.price ?? 0) * 100);
      eventPriceTotal += priceCents;
      hoursBooked +=
        (new Date(e.endTime).getTime() - new Date(e.startTime).getTime()) /
        3600_000;

      for (const f of e.facilitators) activeFacIds.add(f.id);
      for (const c of e.clients) activeClientIds.add(c.id);

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
    }

    const balanceDueCents = openInvoices.reduce((s, inv) => {
      const paid = inv.payments.reduce((p, pay) => p + pay.amountCents, 0);
      return s + Math.max(0, inv.totalCents - paid);
    }, 0);
    const chequesPendingCents = pendingCheques.reduce(
      (s, p) => s + p.amountCents,
      0,
    );

    const totalForRate = eventCount + canceledCount;
    const cancellationRate =
      totalForRate > 0 ? canceledCount / totalForRate : 0;

    const toSortedRows = (
      m: Map<string, { name: string; amountCents: number; eventCount: number }>,
    ): DimensionRow[] =>
      Array.from(m.entries())
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => b.amountCents - a.amountCents);

    // ── 4. Upcoming events (next 14 days from now). ────────────────────
    const now = new Date();
    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + 14);
    const upcomingRaw = await prisma.scheduledEvent.findMany({
      where: {
        startTime: { gte: now, lte: horizon },
        status: { not: 'CANCELED' },
        ...(locationId ? { locationId } : {}),
        ...(serviceId ? { serviceId } : {}),
        ...(facilitatorId
          ? { facilitators: { some: { id: facilitatorId } } }
          : {}),
      },
      orderBy: { startTime: 'asc' },
      take: 50,
      select: {
        id: true,
        startTime: true,
        endTime: true,
        status: true,
        facilitators: {
          select: { firstname: true, lastname: true },
        },
        clients: { select: { firstname: true, lastname: true } },
        service: { select: { name: true } },
        location: { select: { name: true } },
        room: { select: { name: true } },
      },
    });
    const upcomingEvents: UpcomingEvent[] = upcomingRaw.map((e) => {
      const fac = e.facilitators[0];
      const cli = e.clients[0];
      return {
        id: e.id,
        startTime: e.startTime.toISOString(),
        endTime: e.endTime.toISOString(),
        status: e.status,
        facilitatorName: fac
          ? `${fac.firstname ?? ''} ${fac.lastname ?? ''}`.trim()
          : null,
        clientName: cli
          ? `${cli.firstname ?? ''} ${cli.lastname ?? ''}`.trim()
          : null,
        serviceName: e.service?.name ?? null,
        locationName: e.location?.name ?? null,
        roomName: e.room?.name ?? null,
      };
    });

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      revenueOverTime,
      revenueSplit,
      cashFlow,
      topFacilitators: toSortedRows(byFacilitator).slice(0, 10),
      topClients: toSortedRows(byClient).slice(0, 10),
      topServices: toSortedRows(byService).slice(0, 10),
      topLocations: toSortedRows(byLocation).slice(0, 10),
      stats: {
        eventCount,
        hoursBooked: Math.round(hoursBooked * 100) / 100,
        activeClientCount: activeClientIds.size,
        activeFacilitatorCount: activeFacIds.size,
        revenueCents: facTotal + schoolTotal,
        balanceDueCents,
        chequesPendingCount: pendingCheques.length,
        chequesPendingCents,
        cancellationRate: Math.round(cancellationRate * 1000) / 1000,
        averageEventValueCents:
          eventCount > 0 ? Math.round(eventPriceTotal / eventCount) : 0,
      },
      upcomingEvents,
    };
  }
}

export const orgInsightsService = new OrgInsightsService();
