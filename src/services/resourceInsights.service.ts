/**
 * Resource insights (N.6.9) — aggregated metrics for the room + location
 * UID pages. One service covers both because rooms and locations share
 * the same shape of question: "what activity happens here?"
 *
 *   - Room: aggregate events where roomId = X
 *   - Location: aggregate events where locationId = X (across all rooms)
 *
 * Returns:
 *  - activityOverTime  — daily event count + revenue series
 *  - revenueByDimension — by facilitator / service / client (+ room for
 *                         locations)
 *  - stats             — eventCount, hoursBooked, utilizationRate,
 *                        uniqueFacilitatorCount, uniqueClientCount,
 *                        revenueCents, averagePerEventCents,
 *                        cancellationRate
 *  - topFacilitators   — top 10 by activity
 *  - topServices       — top 10 by activity
 *  - topRooms          — top 10 by activity (LOCATION only)
 *
 * Utilization heuristic: total booked hours ÷ a baseline of 8 hours/day
 * across the window. Rough but useful; the real model would weight by
 * each room's weekly availability minus closures + unavailabilities.
 * Flagged in the BACKLOG for follow-up.
 */

import prisma from '../prisma';

export type ResourceKind = 'room' | 'location';

export interface ResourceInsightsParams {
  kind: ResourceKind;
  id: string;
  from: Date;
  to: Date;
  facilitatorId?: string;
  serviceId?: string;
  clientId?: string;
  /** Only meaningful for kind=location: narrow to a single room. */
  roomId?: string;
}

interface BucketRow {
  date: string; // YYYY-MM-DD
  eventCount: number;
  amountCents: number;
}

interface DimensionRow {
  id: string;
  name: string;
  amountCents: number;
  eventCount: number;
}

export interface ResourceInsights {
  range: { from: string; to: string };
  activityOverTime: BucketRow[];
  revenueByDimension: {
    byFacilitator: DimensionRow[];
    byService: DimensionRow[];
    byClient: DimensionRow[];
    /** Only populated for kind=location. */
    byRoom?: DimensionRow[];
  };
  stats: {
    eventCount: number;
    uniqueFacilitatorCount: number;
    uniqueClientCount: number;
    hoursBooked: number;
    utilizationRate: number;
    cancellationRate: number;
    revenueCents: number;
    averagePerEventCents: number;
    /** Only populated for kind=location. */
    roomCount?: number;
  };
  topFacilitators: DimensionRow[];
  topServices: DimensionRow[];
  /** Only populated for kind=location. */
  topRooms?: DimensionRow[];
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export class ResourceInsightsService {
  async get(params: ResourceInsightsParams): Promise<ResourceInsights> {
    const { kind, id, from, to, facilitatorId, serviceId, clientId, roomId } =
      params;

    // ── 1. Events at the resource within the window. ───────────────────
    const eventFilter: any = {
      startTime: { lte: to },
      endTime: { gte: from },
    };
    if (kind === 'room') eventFilter.roomId = id;
    else eventFilter.locationId = id;

    if (facilitatorId)
      eventFilter.facilitators = { some: { id: facilitatorId } };
    if (serviceId) eventFilter.serviceId = serviceId;
    if (clientId) eventFilter.clients = { some: { id: clientId } };
    if (kind === 'location' && roomId) eventFilter.roomId = roomId;

    const events = await prisma.scheduledEvent.findMany({
      where: eventFilter,
      select: {
        id: true,
        startTime: true,
        endTime: true,
        price: true,
        status: true,
        roomId: true,
        serviceId: true,
        facilitators: {
          select: { id: true, firstname: true, lastname: true },
        },
        clients: { select: { id: true, firstname: true, lastname: true } },
        room: { select: { name: true } },
        service: { select: { name: true } },
      },
    });

    // ── 2. Room count for location. ─────────────────────────────────────
    let roomCount: number | undefined;
    if (kind === 'location') {
      roomCount = await prisma.room.count({ where: { locationId: id } });
    }

    // ── 3. Aggregate per day + per dimension. ───────────────────────────
    const inWindow = (start: Date, end: Date) =>
      start.getTime() <= to.getTime() && end.getTime() >= from.getTime();

    const buckets = new Map<string, { eventCount: number; amountCents: number }>();
    const byFacilitator = new Map<
      string,
      { name: string; amountCents: number; eventCount: number }
    >();
    const byService = new Map<
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

    let eventCount = 0;
    let canceledCount = 0;
    let hoursBooked = 0;
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
      hoursBooked += (end.getTime() - start.getTime()) / 3600_000;
      revenueCents += priceCents;

      // Per-day bucket.
      const k = ymd(start);
      const cur = buckets.get(k) ?? { eventCount: 0, amountCents: 0 };
      cur.eventCount += 1;
      cur.amountCents += priceCents;
      buckets.set(k, cur);

      // By facilitator.
      for (const f of e.facilitators) {
        facIdSet.add(f.id);
        const fcur = byFacilitator.get(f.id) ?? {
          name: `${f.firstname ?? ''} ${f.lastname ?? ''}`.trim(),
          amountCents: 0,
          eventCount: 0,
        };
        fcur.amountCents += priceCents;
        fcur.eventCount += 1;
        byFacilitator.set(f.id, fcur);
      }

      // By client.
      for (const c of e.clients) {
        clientIdSet.add(c.id);
        const ccur = byClient.get(c.id) ?? {
          name: `${c.firstname ?? ''} ${c.lastname ?? ''}`.trim(),
          amountCents: 0,
          eventCount: 0,
        };
        ccur.amountCents += priceCents;
        ccur.eventCount += 1;
        byClient.set(c.id, ccur);
      }

      // By service.
      if (e.serviceId) {
        const scur = byService.get(e.serviceId) ?? {
          name: e.service?.name ?? '—',
          amountCents: 0,
          eventCount: 0,
        };
        scur.amountCents += priceCents;
        scur.eventCount += 1;
        byService.set(e.serviceId, scur);
      }

      // By room — only for location.
      if (kind === 'location' && e.roomId) {
        const rcur = byRoom.get(e.roomId) ?? {
          name: e.room?.name ?? '—',
          amountCents: 0,
          eventCount: 0,
        };
        rcur.amountCents += priceCents;
        rcur.eventCount += 1;
        byRoom.set(e.roomId, rcur);
      }
    }

    const activityOverTime: BucketRow[] = Array.from(buckets.entries())
      .map(([date, v]) => ({ date, ...v }))
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

    // Rough utilization: booked hours over the window, baseline of
    // (days × 8 hours) per room. For locations, scale by the room count.
    const days = Math.max(
      1,
      Math.ceil((to.getTime() - from.getTime()) / 86_400_000),
    );
    const rooms = kind === 'location' ? Math.max(1, roomCount ?? 1) : 1;
    const baselineHours = days * 8 * rooms;
    const utilizationRate =
      baselineHours > 0
        ? Math.min(1, hoursBooked / baselineHours)
        : 0;

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      activityOverTime,
      revenueByDimension: {
        byFacilitator: toSortedRows(byFacilitator),
        byService: toSortedRows(byService),
        byClient: toSortedRows(byClient),
        ...(kind === 'location' ? { byRoom: toSortedRows(byRoom) } : {}),
      },
      stats: {
        eventCount,
        uniqueFacilitatorCount: facIdSet.size,
        uniqueClientCount: clientIdSet.size,
        hoursBooked: Math.round(hoursBooked * 100) / 100,
        utilizationRate: Math.round(utilizationRate * 1000) / 1000,
        cancellationRate: Math.round(cancellationRate * 1000) / 1000,
        revenueCents,
        averagePerEventCents:
          eventCount > 0 ? Math.round(revenueCents / eventCount) : 0,
        ...(kind === 'location' ? { roomCount } : {}),
      },
      topFacilitators: toSortedRows(byFacilitator).slice(0, 10),
      topServices: toSortedRows(byService).slice(0, 10),
      ...(kind === 'location'
        ? { topRooms: toSortedRows(byRoom).slice(0, 10) }
        : {}),
    };
  }
}

export const resourceInsightsService = new ResourceInsightsService();
