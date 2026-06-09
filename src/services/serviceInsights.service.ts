/**
 * Service insights (N.7.14) — aggregated metrics for the
 * /admin/services/:id UID page's chart + stats panel.
 *
 * Parallel to facilitator / client / resource insights but oriented
 * around a SERVICE (a kind of class / product the school sells).
 *
 *  - Headline charts:
 *      revenueOverTime       — daily event-price aggregate
 *      revenueByDimension    — per facilitator / client / room / location
 *
 *  - Stat cards:
 *      eventCount            — sessions delivered (status != CANCELED)
 *      uniqueFacilitatorCount — distinct facilitators delivering this
 *      uniqueClientCount     — distinct clients attending
 *      hoursDelivered        — sum of event durations, hours
 *      cancellationRate      — CANCELED / total (%)
 *      revenueCents          — Σ event.price × 100
 *      averagePerEventCents  — revenueCents / eventCount
 *
 *  - topFacilitators / topClients — top 10 each by revenue.
 *
 * Org-scoping is automatic via the Prisma extension.
 */

import prisma from '../prisma';

export interface ServiceInsightsParams {
  serviceId: string;
  from: Date;
  to: Date;
  /**
   * Optional dimension filters. Compose with AND across event-driven
   * aggregates.
   */
  facilitatorId?: string;
  clientId?: string;
  roomId?: string;
  locationId?: string;
}

interface BucketRow {
  date: string;
  amountCents: number;
}

interface DimensionRow {
  id: string;
  name: string;
  amountCents: number;
  eventCount: number;
}

export interface ServiceInsights {
  range: { from: string; to: string };
  revenueOverTime: BucketRow[];
  revenueByDimension: {
    byFacilitator: DimensionRow[];
    byClient: DimensionRow[];
    byRoom: DimensionRow[];
    byLocation: DimensionRow[];
  };
  stats: {
    eventCount: number;
    uniqueFacilitatorCount: number;
    uniqueClientCount: number;
    hoursDelivered: number;
    cancellationRate: number;
    revenueCents: number;
    averagePerEventCents: number;
  };
  topFacilitators: DimensionRow[];
  topClients: DimensionRow[];
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export class ServiceInsightsService {
  async get(params: ServiceInsightsParams): Promise<ServiceInsights> {
    const { serviceId, from, to, facilitatorId, clientId, roomId, locationId } =
      params;

    // ── 1. Events using this service within the window. ──────────────
    const eventFilter: any = {
      serviceId,
      startTime: { lte: to },
      endTime: { gte: from },
    };
    if (facilitatorId)
      eventFilter.facilitators = { some: { id: facilitatorId } };
    if (clientId) eventFilter.clients = { some: { id: clientId } };
    if (roomId) eventFilter.roomId = roomId;
    if (locationId) eventFilter.locationId = locationId;

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
        facilitators: {
          select: { id: true, firstname: true, lastname: true },
        },
        clients: { select: { id: true, firstname: true, lastname: true } },
        room: { select: { name: true } },
        location: { select: { name: true } },
      },
    });

    // ── 2. Aggregate per day + per dimension. ────────────────────────
    const inWindow = (start: Date, end: Date) =>
      start.getTime() <= to.getTime() && end.getTime() >= from.getTime();

    const buckets = new Map<string, number>();
    const byFacilitator = new Map<
      string,
      { name: string; amountCents: number; eventCount: number }
    >();
    const byClient = new Map<
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

    let eventCount = 0;
    let canceledCount = 0;
    let hoursDelivered = 0;
    let revenueCents = 0;
    const facIdSet = new Set<string>();
    const clientIdSet = new Set<string>();

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
      hoursDelivered += (end.getTime() - start.getTime()) / 3600_000;
      revenueCents += priceCents;

      // Per-day bucket.
      const k = ymd(start);
      buckets.set(k, (buckets.get(k) ?? 0) + priceCents);

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
    }

    const revenueOverTime: BucketRow[] = Array.from(buckets.entries())
      .map(([date, amountCents]) => ({ date, amountCents }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

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
      revenueByDimension: {
        byFacilitator: toSortedRows(byFacilitator),
        byClient: toSortedRows(byClient),
        byRoom: toSortedRows(byRoom),
        byLocation: toSortedRows(byLocation),
      },
      stats: {
        eventCount,
        uniqueFacilitatorCount: facIdSet.size,
        uniqueClientCount: clientIdSet.size,
        hoursDelivered: Math.round(hoursDelivered * 100) / 100,
        cancellationRate: Math.round(cancellationRate * 1000) / 1000,
        revenueCents,
        averagePerEventCents:
          eventCount > 0 ? Math.round(revenueCents / eventCount) : 0,
      },
      topFacilitators: toSortedRows(byFacilitator).slice(0, 10),
      topClients: toSortedRows(byClient).slice(0, 10),
    };
  }
}

export const serviceInsightsService = new ServiceInsightsService();
