import prisma from '../prisma';

/**
 * Common slot-options computation for both reschedule flows:
 *   - Trial reschedule: enumerate (date, startTime) slots in a window
 *   - Enrollment reschedule: enumerate (weekday, startTime) tuples that work
 *     for EVERY remaining occurrence in the term
 *
 * Both honor:
 *   - facilitator's weekly availability windows
 *   - service duration (slot must fit fully inside a window)
 *   - 30-minute step granularity on slot starts
 *   - existing ScheduledEvents the facilitator is on
 *   - Closures (location-scoped or global)
 */

type AvailabilityWindow = { start: string; end: string }; // "HH:MM"

const STEP_MINUTES = 30;

function parseHHmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

function minutesToHHmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export type TrialSlotOption = {
  startTime: string; // ISO
  endTime: string;   // ISO
};

export type EnrollmentSlotOption = {
  weekday: number;       // 0..6
  startTime: string;     // "HH:MM"
  // For UI display — first valid occurrence under this slot, so the user
  // sees a concrete "Lundi 25 mai à 10:00".
  firstOccurrence: string; // ISO
};

export class RescheduleOptionsService {
  /**
   * Trial reschedule: list of single available slots for a facilitator
   * between [from, to], duration = service.defaultDurationMinutes.
   * Excludes the original event itself (so the student can pick the same
   * time on a different day, just not stay on the original).
   */
  async trialOptions(args: {
    facilitatorId: string;
    durationMinutes: number;
    from: Date;
    to: Date;
    locationId?: string;
    excludeEventId?: string;
  }): Promise<TrialSlotOption[]> {
    const { facilitatorId, durationMinutes, from, to, locationId, excludeEventId } = args;
    if (from >= to) return [];

    const fac = await prisma.facilitator.findFirst({
      where: { id: facilitatorId, isBookable: true },
      select: { availability: true },
    });
    if (!fac) return [];

    const events = await prisma.scheduledEvent.findMany({
      where: {
        facilitators: { some: { id: facilitatorId } },
        startTime: { lt: to },
        endTime: { gt: from },
        ...(excludeEventId ? { id: { not: excludeEventId } } : {}),
      },
      select: { startTime: true, endTime: true },
    });

    const closures = await prisma.closure.findMany({
      where: {
        ...(locationId
          ? { OR: [{ locationId }, { locationId: null }] }
          : {}),
        startDate: { lt: to },
        endDate: { gt: from },
      },
      select: { startDate: true, endDate: true },
    });

    const holds = await prisma.slotHold.findMany({
      where: {
        facilitatorId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        startTime: { lt: to },
        endTime: { gt: from },
      },
      select: { startTime: true, endTime: true },
    });

    const availability =
      (fac.availability as Record<string, AvailabilityWindow[]> | null) ?? {};

    const durationMs = durationMinutes * 60_000;
    const out: TrialSlotOption[] = [];

    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);
    while (cursor < to) {
      const weekday = cursor.getDay().toString();
      const windows = availability[weekday] ?? [];

      for (const w of windows) {
        const windowStartMin = parseHHmmToMinutes(w.start);
        const windowEndMin = parseHHmmToMinutes(w.end);

        for (
          let startMin = windowStartMin;
          startMin + durationMinutes <= windowEndMin;
          startMin += STEP_MINUTES
        ) {
          const slotStart = new Date(cursor);
          slotStart.setHours(0, 0, 0, 0);
          slotStart.setMinutes(startMin);
          const slotEnd = new Date(slotStart.getTime() + durationMs);

          if (slotStart < from || slotEnd > to) continue;

          const conflict =
            events.some((e) => overlaps(e.startTime, e.endTime, slotStart, slotEnd)) ||
            closures.some((c) => overlaps(c.startDate, c.endDate, slotStart, slotEnd)) ||
            holds.some((h) => overlaps(h.startTime, h.endTime, slotStart, slotEnd));

          if (!conflict) {
            out.push({
              startTime: slotStart.toISOString(),
              endTime: slotEnd.toISOString(),
            });
          }
        }
      }

      cursor.setDate(cursor.getDate() + 1);
    }

    return out;
  }

  /**
   * Enrollment reschedule: list of (weekday, startTime) tuples that work for
   * the ENTIRE remaining term window — i.e., every weekly occurrence under
   * that recurring slot must be conflict-free.
   *
   * `startFrom` is typically the day AFTER the trial so we don't re-book
   * the trial slot in the new recurring pattern.
   */
  async enrollmentOptions(args: {
    facilitatorId: string;
    durationMinutes: number;
    startFrom: Date;
    until: Date;
    locationId?: string;
  }): Promise<EnrollmentSlotOption[]> {
    const { facilitatorId, durationMinutes, startFrom, until, locationId } = args;
    if (startFrom >= until) return [];

    const fac = await prisma.facilitator.findFirst({
      where: { id: facilitatorId, isBookable: true },
      select: { availability: true },
    });
    if (!fac) return [];

    const events = await prisma.scheduledEvent.findMany({
      where: {
        facilitators: { some: { id: facilitatorId } },
        startTime: { lt: until },
        endTime: { gt: startFrom },
      },
      select: { startTime: true, endTime: true },
    });

    const closures = await prisma.closure.findMany({
      where: {
        ...(locationId
          ? { OR: [{ locationId }, { locationId: null }] }
          : {}),
        startDate: { lt: until },
        endDate: { gt: startFrom },
      },
      select: { startDate: true, endDate: true },
    });

    const availability =
      (fac.availability as Record<string, AvailabilityWindow[]> | null) ?? {};

    const durationMs = durationMinutes * 60_000;
    const out: EnrollmentSlotOption[] = [];

    for (let weekday = 0; weekday < 7; weekday++) {
      const windows = availability[weekday.toString()] ?? [];

      for (const w of windows) {
        const windowStartMin = parseHHmmToMinutes(w.start);
        const windowEndMin = parseHHmmToMinutes(w.end);

        for (
          let startMin = windowStartMin;
          startMin + durationMinutes <= windowEndMin;
          startMin += STEP_MINUTES
        ) {
          // Generate every occurrence of this (weekday, startMin) in [startFrom, until]
          const occurrences = generateWeeklyOccurrencesAt(
            startFrom,
            until,
            weekday,
            startMin,
            durationMs,
          );

          if (occurrences.length === 0) continue;

          const allClear = occurrences.every((occ) => {
            const occEnd = new Date(occ.getTime() + durationMs);
            const ec = events.some((e) => overlaps(e.startTime, e.endTime, occ, occEnd));
            if (ec) return false;
            const cc = closures.some((c) => overlaps(c.startDate, c.endDate, occ, occEnd));
            if (cc) return false;
            return true;
          });

          if (allClear) {
            out.push({
              weekday,
              startTime: minutesToHHmm(startMin),
              firstOccurrence: occurrences[0].toISOString(),
            });
          }
        }
      }
    }

    // Sort by weekday then time for a stable UI.
    out.sort((a, b) =>
      a.weekday !== b.weekday
        ? a.weekday - b.weekday
        : a.startTime.localeCompare(b.startTime),
    );
    return out;
  }
}

/**
 * Generate weekly occurrence start datetimes for (weekday, startMin) between
 * [from, until). Walks forward day-by-day from `from`, picking the matching
 * weekday and setting the start time.
 */
function generateWeeklyOccurrencesAt(
  from: Date,
  until: Date,
  weekday: number,
  startMin: number,
  durationMs: number,
): Date[] {
  const out: Date[] = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);

  // Fast-forward to the next matching weekday on/after `from`.
  while (cursor.getDay() !== weekday) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor >= until) return [];
  }

  while (cursor < until) {
    const occ = new Date(cursor);
    occ.setHours(0, 0, 0, 0);
    occ.setMinutes(startMin);
    if (occ >= from && occ.getTime() + durationMs <= until.getTime()) {
      out.push(occ);
    }
    cursor.setDate(cursor.getDate() + 7);
  }
  return out;
}
