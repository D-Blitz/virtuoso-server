import prisma from '../prisma';
import { RescheduleOptionsService } from './rescheduleOptions.service';

/**
 * Enrollment-side reschedule. Stores a per-invite override of the recurring
 * (weekday, startTime) that will be used when activation happens (at trimester
 * payment time). Once-only — the UI prevents re-edit if `rescheduledAt` is set.
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
    if (invite.rescheduledAt) {
      // Already rescheduled once — UI should prevent reaching here.
      throw new Error('Vous avez déjà modifié votre créneau');
    }

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
   * is currently valid (no race), and bumps `rescheduledAt`.
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
    if (invite.rescheduledAt) throw new Error('Vous avez déjà modifié votre créneau');

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
}
