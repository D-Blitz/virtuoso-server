import prisma from '../prisma';
import { RescheduleOptionsService } from './rescheduleOptions.service';

/**
 * Enrollment-side reschedule. Stores a per-invite override of the recurring
 * (weekday, startTime) that will be used when activation happens (at trimester
 * payment time).
 *
 * The student can change their mind as many times as they want UNTIL they pay
 * — only payment (which flips the invite to CONSUMED) locks the slot in. So
 * we don't gate on `rescheduledAt`; we just stamp it as a "last modified at"
 * timestamp for auditing.
 */

const options = new RescheduleOptionsService();

export class EnrollmentInviteRescheduleService {
  /**
   * List valid (weekday, startTime) recurring slot options for this invite's
   * facilitator + service, that work for every remaining occurrence in the
   * active term.
   */
  async getOptions(token: string) {
    const invite = await prisma.enrollmentInvite.findFirst({
      where: { token, status: 'PENDING' },
      include: {
        scheduledEvent: {
          include: {
            facilitators: { take: 1, select: { id: true } },
            service: { select: { defaultDurationMinutes: true } },
          },
        },
      },
    });
    if (!invite) throw new Error('Invite introuvable ou expirée');

    const facilitator = invite.scheduledEvent.facilitators[0];
    if (!facilitator) throw new Error('Aucun enseignant associé');

    const now = new Date();
    const term = await prisma.term.findFirst({
      where: {
        OR: [
          { locationId: invite.scheduledEvent.locationId },
          { locationId: null },
        ],
        startDate: { lte: now },
        endDate: { gte: now },
      },
      orderBy: { startDate: 'desc' },
    });
    if (!term) throw new Error('Aucun trimestre actif');

    // Start from day-after-trial so we don't double-book the trial slot.
    const startFrom = new Date(invite.scheduledEvent.endTime);
    startFrom.setDate(startFrom.getDate() + 1);

    return options.enrollmentOptions({
      facilitatorId: facilitator.id,
      durationMinutes: invite.scheduledEvent.service.defaultDurationMinutes,
      startFrom,
      until: term.endDate,
      locationId: invite.scheduledEvent.locationId,
    });
  }

  /**
   * Apply the recurring-slot override on the invite. Re-validates the slot
   * is currently valid (no race), updates the override, and stamps
   * `rescheduledAt`. Re-callable — the student can change their pick any
   * number of times until the invite becomes CONSUMED (at payment).
   */
  async apply(token: string, weekday: number, startTime: string): Promise<void> {
    const invite = await prisma.enrollmentInvite.findFirst({
      where: { token, status: 'PENDING' },
      include: {
        scheduledEvent: {
          include: {
            facilitators: { take: 1, select: { id: true } },
            service: { select: { defaultDurationMinutes: true } },
          },
        },
      },
    });
    if (!invite) throw new Error('Invite introuvable ou expirée');

    if (weekday < 0 || weekday > 6) throw new Error('Jour invalide');
    if (!/^\d{2}:\d{2}$/.test(startTime)) throw new Error('Heure invalide');

    const facilitator = invite.scheduledEvent.facilitators[0];
    if (!facilitator) throw new Error('Aucun enseignant associé');

    const validOptions = await this.getOptions(token);
    const isValid = validOptions.some(
      (o) => o.weekday === weekday && o.startTime === startTime,
    );
    if (!isValid) {
      throw new Error('Ce créneau n’est plus disponible');
    }

    await prisma.enrollmentInvite.update({
      where: { id: invite.id },
      data: {
        overrideWeekday: weekday,
        overrideStartTime: startTime,
        rescheduledAt: new Date(),
      },
    });
  }

  /**
   * Reset any pending override so the student goes back to the trial slot.
   * Idempotent — does nothing if no override is set.
   */
  async revert(token: string): Promise<void> {
    const invite = await prisma.enrollmentInvite.findFirst({
      where: { token, status: 'PENDING' },
      select: { id: true, overrideWeekday: true, overrideStartTime: true },
    });
    if (!invite) throw new Error('Invite introuvable ou expirée');
    if (invite.overrideWeekday === null && invite.overrideStartTime === null) {
      return;
    }
    await prisma.enrollmentInvite.update({
      where: { id: invite.id },
      data: {
        overrideWeekday: null,
        overrideStartTime: null,
        rescheduledAt: new Date(),
      },
    });
  }
}
