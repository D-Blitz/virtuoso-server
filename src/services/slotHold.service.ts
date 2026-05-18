import prisma from '../prisma';
import { getOrganizationId } from '../auth/context';

const HOLD_DURATION_MS = 10 * 60 * 1000; // 10 minutes

export type CreateHoldInput = {
  facilitatorId: string;
  startTime: Date;
  endTime: Date;
  sessionId: string;
};

export type HoldResult =
  | { ok: true; hold: { id: string; expiresAt: Date } }
  | { ok: false; reason: 'CONFLICT' | 'INVALID' };

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export class SlotHoldService {
  /**
   * Create a hold IF the slot is currently free. Optimistic check — there is
   * a small race window where two concurrent calls could both succeed; the
   * actual booking step (PR 5) will re-verify under a transaction.
   */
  async create(input: CreateHoldInput): Promise<HoldResult> {
    const organizationId = getOrganizationId();
    if (!organizationId) return { ok: false, reason: 'INVALID' };

    if (input.endTime <= input.startTime) return { ok: false, reason: 'INVALID' };

    // Check conflicts (events, closures, holds — but ignore this session's own holds).
    const [events, closures, holds, facilitator] = await Promise.all([
      prisma.scheduledEvent.findMany({
        where: {
          facilitators: { some: { id: input.facilitatorId } },
          startTime: { lt: input.endTime },
          endTime: { gt: input.startTime },
        },
        select: { startTime: true, endTime: true },
      }),
      prisma.closure.findMany({
        where: {
          startDate: { lt: input.endTime },
          endDate: { gt: input.startTime },
        },
        select: { startDate: true, endDate: true },
      }),
      prisma.slotHold.findMany({
        where: {
          facilitatorId: input.facilitatorId,
          consumedAt: null,
          expiresAt: { gt: new Date() },
          startTime: { lt: input.endTime },
          endTime: { gt: input.startTime },
          NOT: { sessionId: input.sessionId },
        },
        select: { startTime: true, endTime: true },
      }),
      prisma.facilitator.findFirst({
        where: { id: input.facilitatorId, isBookable: true },
        select: { id: true },
      }),
    ]);

    if (!facilitator) return { ok: false, reason: 'INVALID' };

    const conflict =
      events.some((e) =>
        overlaps(e.startTime, e.endTime, input.startTime, input.endTime),
      ) ||
      closures.some((c) =>
        overlaps(c.startDate, c.endDate, input.startTime, input.endTime),
      ) ||
      holds.some((h) =>
        overlaps(h.startTime, h.endTime, input.startTime, input.endTime),
      );

    if (conflict) return { ok: false, reason: 'CONFLICT' };

    // Drop any prior holds from the same session for this facilitator
    // (user picked a different slot — release the old one).
    await prisma.slotHold.deleteMany({
      where: {
        sessionId: input.sessionId,
        facilitatorId: input.facilitatorId,
        consumedAt: null,
      },
    });

    const hold = await prisma.slotHold.create({
      data: {
        organizationId,
        facilitatorId: input.facilitatorId,
        startTime: input.startTime,
        endTime: input.endTime,
        sessionId: input.sessionId,
        expiresAt: new Date(Date.now() + HOLD_DURATION_MS),
      },
      select: { id: true, expiresAt: true },
    });

    return { ok: true, hold };
  }

  async release(holdId: string, sessionId: string): Promise<{ ok: boolean }> {
    // Only allow releasing your own session's holds.
    const result = await prisma.slotHold.deleteMany({
      where: {
        id: holdId,
        sessionId,
        consumedAt: null,
      },
    });
    return { ok: result.count > 0 };
  }
}
