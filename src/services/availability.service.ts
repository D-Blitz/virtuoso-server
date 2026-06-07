import prisma from '../prisma';

/**
 * Computes available booking slots by intersecting:
 *   - the service's slot duration (defaultDurationMinutes)
 *   - each facilitator's weekly availability windows
 *   - existing ScheduledEvents (any event the facilitator is on)
 *   - active SlotHolds (other clients holding the slot)
 *   - Closures (location-scoped or global)
 *
 * Times are interpreted in the server's local timezone. For multi-timezone
 * support we'd thread the org's `timezone` through here — out of scope for v1.
 */

export type Slot = {
  facilitatorId: string;
  startTime: string; // ISO
  endTime: string;   // ISO
};

export type AvailabilityParams = {
  serviceId: string;
  facilitatorIds: string[];
  from: Date;
  to: Date;
  locationId?: string;
};

type AvailabilityWindow = { start: string; end: string }; // "HH:MM"

function parseHHmmToParts(s: string): { h: number; m: number } {
  const [h, m] = s.split(':').map((n) => parseInt(n, 10));
  return { h: h || 0, m: m || 0 };
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export class AvailabilityService {
  async getAvailableSlots(params: AvailabilityParams): Promise<Slot[]> {
    if (params.facilitatorIds.length === 0) return [];
    if (params.from >= params.to) return [];

    const service = await prisma.service.findFirst({
      where: { id: params.serviceId },
      select: { defaultDurationMinutes: true },
    });
    if (!service) throw new Error('Service not found');
    const durationMin = service.defaultDurationMinutes;
    const durationMs = durationMin * 60_000;

    const facilitators = await prisma.facilitator.findMany({
      where: { id: { in: params.facilitatorIds }, isBookable: true },
      select: { id: true, availability: true },
    });

    const events = await prisma.scheduledEvent.findMany({
      where: {
        facilitators: { some: { id: { in: params.facilitatorIds } } },
        startTime: { lt: params.to },
        endTime: { gt: params.from },
      },
      select: {
        startTime: true,
        endTime: true,
        facilitators: { select: { id: true } },
      },
    });

    const closures = await prisma.closure.findMany({
      where: {
        ...(params.locationId
          ? { OR: [{ locationId: params.locationId }, { locationId: null }] }
          : {}),
        startDate: { lt: params.to },
        endDate: { gt: params.from },
      },
      select: { startDate: true, endDate: true },
    });

    const holds = await prisma.slotHold.findMany({
      where: {
        facilitatorId: { in: params.facilitatorIds },
        consumedAt: null,
        expiresAt: { gt: new Date() },
        startTime: { lt: params.to },
        endTime: { gt: params.from },
      },
      select: { facilitatorId: true, startTime: true, endTime: true },
    });

    // N.4 — unavailabilities for the candidate facilitator(s) overlapping
    // the requested window. Trashed rows are filtered by the scoping
    // extension. A room-targeted block doesn't surface here because slot
    // suggestion is room-agnostic — the room is picked later in the flow;
    // the room-conflict pass catches it then.
    const unavailabilities = await prisma.unavailability.findMany({
      where: {
        facilitatorId: { in: params.facilitatorIds },
        startTime: { lt: params.to },
        endTime: { gt: params.from },
      },
      select: { facilitatorId: true, startTime: true, endTime: true },
    });

    const slots: Slot[] = [];

    for (const f of facilitators) {
      const fAvailability =
        (f.availability as Record<string, AvailabilityWindow[]> | null) ?? {};

      // Iterate one calendar day at a time.
      const dayCursor = new Date(params.from);
      dayCursor.setHours(0, 0, 0, 0);
      const endOfRange = new Date(params.to);

      while (dayCursor < endOfRange) {
        const weekday = dayCursor.getDay().toString(); // "0".."6"
        const windows = fAvailability[weekday] ?? [];

        for (const w of windows) {
          const start = parseHHmmToParts(w.start);
          const end = parseHHmmToParts(w.end);

          const windowStart = new Date(dayCursor);
          windowStart.setHours(start.h, start.m, 0, 0);
          const windowEnd = new Date(dayCursor);
          windowEnd.setHours(end.h, end.m, 0, 0);

          let slotStart = new Date(windowStart);
          while (slotStart.getTime() + durationMs <= windowEnd.getTime()) {
            const slotEnd = new Date(slotStart.getTime() + durationMs);

            // Range bound check
            if (slotStart >= params.from && slotEnd <= params.to) {
              const conflictEvent = events.some(
                (e) =>
                  e.facilitators.some((ef) => ef.id === f.id) &&
                  overlaps(e.startTime, e.endTime, slotStart, slotEnd),
              );
              const conflictClosure = closures.some((c) =>
                overlaps(c.startDate, c.endDate, slotStart, slotEnd),
              );
              const conflictHold = holds.some(
                (h) =>
                  h.facilitatorId === f.id &&
                  overlaps(h.startTime, h.endTime, slotStart, slotEnd),
              );
              const conflictUnavailability = unavailabilities.some(
                (u) =>
                  u.facilitatorId === f.id &&
                  overlaps(u.startTime, u.endTime, slotStart, slotEnd),
              );

              if (
                !conflictEvent &&
                !conflictClosure &&
                !conflictHold &&
                !conflictUnavailability
              ) {
                slots.push({
                  facilitatorId: f.id,
                  startTime: slotStart.toISOString(),
                  endTime: slotEnd.toISOString(),
                });
              }
            }

            slotStart = new Date(slotStart.getTime() + durationMs);
          }
        }

        dayCursor.setDate(dayCursor.getDate() + 1);
      }
    }

    return slots;
  }
}
