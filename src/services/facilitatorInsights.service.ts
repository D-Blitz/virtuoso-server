/**
 * Facilitator insights (N.6.3) — aggregated metrics for the
 * /admin/prestataires/:id UID page's chart + stats panel.
 *
 * Inputs: a facilitator id and a [from, to] date window. Outputs a
 * payload tailored to the four insight buckets shipped in v1:
 *
 *  - Headline charts:
 *      revenueOverTime       — daily buckets, school + facilitator
 *      revenueSplit          — donut: school vs intervenant total
 *      revenueByDimension    — per client / room / location / service
 *
 *  - Stat cards:
 *      eventCount            — sessions in range, status != CANCELED
 *      uniqueClientCount     — distinct clients across those events
 *      hoursWorked           — sum of event durations, hours
 *      cancellationRate      — CANCELED / total (%)
 *      revenueCents          — facilitator's share total
 *      averagePerEvent       — revenueCents / eventCount
 *
 *  - topClients              — top 10 by revenue
 *
 * Org-scoping is automatic via the Prisma extension. The caller's
 * permission is checked at the route layer; this service only assumes
 * a valid request context.
 */

import prisma from '../prisma';

export interface InsightsParams {
  facilitatorId: string;
  from: Date;
  to: Date;
}

interface BucketRow {
  date: string; // YYYY-MM-DD
  school: number;
  facilitator: number;
}

interface DimensionRow {
  id: string;
  name: string;
  amountCents: number;
  eventCount: number;
}

export interface FacilitatorInsights {
  range: { from: string; to: string };
  revenueOverTime: BucketRow[];
  revenueSplit: { school: number; facilitator: number; total: number };
  revenueByDimension: {
    byClient: DimensionRow[];
    byRoom: DimensionRow[];
    byLocation: DimensionRow[];
    byService: DimensionRow[];
  };
  stats: {
    eventCount: number;
    uniqueClientCount: number;
    hoursWorked: number;
    cancellationRate: number;
    revenueCents: number;
    averagePerEventCents: number;
  };
  topClients: DimensionRow[];
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export class FacilitatorInsightsService {
  /**
   * Build the full insights payload for one facilitator over [from, to].
   * Designed as a single read pass: a small number of focused queries,
   * with all aggregation done in JS so the shape stays explicit.
   */
  async get(params: InsightsParams): Promise<FacilitatorInsights> {
    const { facilitatorId, from, to } = params;

    // ── 1. Events the facilitator is on within the window ─────────────
    const events = await prisma.scheduledEvent.findMany({
      where: {
        facilitators: { some: { id: facilitatorId } },
        startTime: { lte: to },
        endTime: { gte: from },
      },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        price: true,
        status: true,
        roomId: true,
        locationId: true,
        serviceId: true,
        clients: { select: { id: true, firstname: true, lastname: true } },
        room: { select: { name: true } },
        location: { select: { name: true } },
        service: { select: { name: true } },
      },
    });

    // ── 2. PaymentAllocations attributed to the facilitator (FAC share)
    // and to the school FOR INVOICES involving this facilitator. We use
    // these for the headline revenue numbers.
    //
    // (a) FAC slices that name this facilitator.
    const facAllocations = await prisma.paymentAllocation.findMany({
      where: {
        facilitatorId,
        beneficiaryType: 'FACILITATOR',
        createdAt: { gte: from, lte: to },
      },
      select: {
        amountCents: true,
        createdAt: true,
        invoiceId: true,
      },
    });

    // (b) Invoices touched by a FAC allocation in (a) — we sum the SCHOOL
    // slices on the SAME invoices so the donut compares the FAC's share
    // against the school's share for the same body of work.
    const invoiceIds = Array.from(
      new Set(facAllocations.map((a) => a.invoiceId).filter(Boolean)),
    ) as string[];
    const schoolAllocations =
      invoiceIds.length > 0
        ? await prisma.paymentAllocation.findMany({
            where: {
              invoiceId: { in: invoiceIds },
              beneficiaryType: 'SCHOOL',
            },
            select: { amountCents: true, createdAt: true },
          })
        : [];

    // ── 3. revenueOverTime: bucket FAC + SCHOOL allocations by day. ──
    const dayKey = (d: Date) => ymd(d);
    const buckets = new Map<string, { school: number; facilitator: number }>();
    for (const a of facAllocations) {
      const k = dayKey(a.createdAt);
      const cur = buckets.get(k) ?? { school: 0, facilitator: 0 };
      cur.facilitator += a.amountCents;
      buckets.set(k, cur);
    }
    for (const a of schoolAllocations) {
      const k = dayKey(a.createdAt);
      const cur = buckets.get(k) ?? { school: 0, facilitator: 0 };
      cur.school += a.amountCents;
      buckets.set(k, cur);
    }
    const revenueOverTime: BucketRow[] = Array.from(buckets.entries())
      .map(([date, v]) => ({ date, school: v.school, facilitator: v.facilitator }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    // ── 4. revenueSplit: aggregate of the same. ──────────────────────
    const facTotal = facAllocations.reduce((s, a) => s + a.amountCents, 0);
    const schoolTotal = schoolAllocations.reduce((s, a) => s + a.amountCents, 0);
    const revenueSplit = {
      school: schoolTotal,
      facilitator: facTotal,
      total: schoolTotal + facTotal,
    };

    // ── 5. Dimensions: aggregate ScheduledEvent prices grouped by
    // client / room / location / service. The `price` column is the
    // catalog price of the event — it represents the volume of work
    // routed through each dimension. The donut covers the split.
    const byClient = new Map<string, { name: string; amountCents: number; eventCount: number }>();
    const byRoom = new Map<string, { name: string; amountCents: number; eventCount: number }>();
    const byLocation = new Map<string, { name: string; amountCents: number; eventCount: number }>();
    const byService = new Map<string, { name: string; amountCents: number; eventCount: number }>();

    const inWindow = (start: Date, end: Date) =>
      start.getTime() <= to.getTime() && end.getTime() >= from.getTime();

    let eventCount = 0;
    let canceledCount = 0;
    let hoursWorked = 0;
    const clientIdSet = new Set<string>();

    for (const e of events) {
      const start = new Date(e.startTime);
      const end = new Date(e.endTime);
      if (!inWindow(start, end)) continue;

      const priceCents = Math.round((e.price ?? 0) * 100);

      if (e.status === 'CANCELED') {
        canceledCount += 1;
        continue; // canceled events don't count toward dimension totals
      }
      eventCount += 1;
      hoursWorked += (end.getTime() - start.getTime()) / 3600_000;

      // By client (one event may have multiple clients).
      for (const c of e.clients) {
        clientIdSet.add(c.id);
        const cur = byClient.get(c.id) ?? {
          name: `${c.firstname ?? ''} ${c.lastname ?? ''}`.trim(),
          amountCents: 0,
          eventCount: 0,
        };
        cur.amountCents += priceCents;
        cur.eventCount += 1;
        byClient.set(c.id, cur);
      }

      // By room.
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

      // By location.
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

      // By service.
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
      revenueOverTime,
      revenueSplit,
      revenueByDimension: {
        byClient: toSortedRows(byClient),
        byRoom: toSortedRows(byRoom),
        byLocation: toSortedRows(byLocation),
        byService: toSortedRows(byService),
      },
      stats: {
        eventCount,
        uniqueClientCount: clientIdSet.size,
        hoursWorked: Math.round(hoursWorked * 100) / 100,
        cancellationRate: Math.round(cancellationRate * 1000) / 1000,
        revenueCents: facTotal,
        averagePerEventCents:
          eventCount > 0 ? Math.round(facTotal / eventCount) : 0,
      },
      topClients: toSortedRows(byClient).slice(0, 10),
    };
  }
}

export const facilitatorInsightsService = new FacilitatorInsightsService();
