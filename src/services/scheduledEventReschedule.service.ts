import prisma from '../prisma';
import { RescheduleOptionsService } from './rescheduleOptions.service';

const RESCHEDULE_CUTOFF_HOURS = 48;
const OPTIONS_WINDOW_DAYS = 30;

const options = new RescheduleOptionsService();

export type TrialRescheduleSummary = {
  token: { value: string; consumed: boolean };
  event: {
    id: string;
    startTime: string;
    endTime: string;
    status: string;
    rescheduleCount: number;
    canReschedule: boolean;
    cannotRescheduleReason?: string;
  };
  facilitator: {
    id: string;
    firstname: string;
    lastname: string;
    profilePictureUrl: string | null;
  } | null;
  service: { name: string; defaultDurationMinutes: number };
  location: { id: string; name: string };
  options: { startTime: string; endTime: string }[];
};

export class ScheduledEventRescheduleService {
  async getByToken(token: string): Promise<TrialRescheduleSummary | null> {
    const tokenRow = await prisma.scheduledEventRescheduleToken.findFirst({
      where: { token },
      include: {
        scheduledEvent: {
          include: {
            facilitators: {
              take: 1,
              select: {
                id: true,
                firstname: true,
                lastname: true,
                profilePictureUrl: true,
              },
            },
            service: {
              select: { name: true, defaultDurationMinutes: true },
            },
            location: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!tokenRow) return null;

    const event = tokenRow.scheduledEvent;
    const facilitator = event.facilitators[0] ?? null;

    // Gate the reschedule
    const now = new Date();
    const cutoffMs = RESCHEDULE_CUTOFF_HOURS * 60 * 60 * 1000;
    let canReschedule = true;
    let cannotRescheduleReason: string | undefined;

    if (tokenRow.consumedAt) {
      canReschedule = false;
      cannotRescheduleReason = 'Vous avez déjà reprogrammé ce cours.';
    } else if (event.rescheduleCount >= 1) {
      canReschedule = false;
      cannotRescheduleReason = 'Ce cours a déjà été reprogrammé une fois.';
    } else if (event.startTime.getTime() - now.getTime() < cutoffMs) {
      canReschedule = false;
      cannotRescheduleReason =
        'Le cours est dans moins de 48 heures, il n’est plus modifiable en ligne.';
    } else if (
      event.status === 'CANCELED' ||
      event.status === 'CONVERTED_TO_ENROLLMENT' ||
      event.status === 'LAPSED'
    ) {
      canReschedule = false;
      cannotRescheduleReason = 'Ce cours n’est plus disponible.';
    }

    // Only compute options if rescheduling is allowed.
    let slotOptions: { startTime: string; endTime: string }[] = [];
    if (canReschedule && facilitator) {
      const from = new Date(Math.max(Date.now() + cutoffMs, Date.now()));
      const to = new Date(Date.now() + OPTIONS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      slotOptions = await options.trialOptions({
        facilitatorId: facilitator.id,
        durationMinutes: event.service.defaultDurationMinutes,
        from,
        to,
        locationId: event.locationId,
        excludeEventId: event.id,
      });
    }

    return {
      token: { value: token, consumed: !!tokenRow.consumedAt },
      event: {
        id: event.id,
        startTime: event.startTime.toISOString(),
        endTime: event.endTime.toISOString(),
        status: event.status,
        rescheduleCount: event.rescheduleCount,
        canReschedule,
        cannotRescheduleReason,
      },
      facilitator,
      service: event.service,
      location: event.location,
      options: slotOptions,
    };
  }

  /**
   * Apply the reschedule. Re-validates everything server-side — token alone
   * is not authorization to bypass the 48h / once-only rules.
   */
  async apply(token: string, newStartTime: Date): Promise<void> {
    const tokenRow = await prisma.scheduledEventRescheduleToken.findFirst({
      where: { token },
      include: {
        scheduledEvent: {
          include: {
            facilitators: { take: 1, select: { id: true } },
            service: { select: { defaultDurationMinutes: true } },
          },
        },
      },
    });
    if (!tokenRow) throw new Error('Token invalide');
    if (tokenRow.consumedAt) throw new Error('Ce lien a déjà été utilisé');

    const event = tokenRow.scheduledEvent;
    const cutoffMs = RESCHEDULE_CUTOFF_HOURS * 60 * 60 * 1000;
    const now = new Date();

    if (event.rescheduleCount >= 1) throw new Error('Déjà reprogrammé une fois');
    if (event.startTime.getTime() - now.getTime() < cutoffMs) {
      throw new Error('Trop tard pour reprogrammer (< 48 h)');
    }
    if (newStartTime.getTime() - now.getTime() < cutoffMs) {
      throw new Error('Le nouveau créneau doit être à plus de 48 h');
    }

    const facilitator = event.facilitators[0];
    if (!facilitator) throw new Error('Aucun enseignant associé');

    const durationMs = event.service.defaultDurationMinutes * 60_000;
    const newEndTime = new Date(newStartTime.getTime() + durationMs);

    // Re-check that the new slot is currently valid (no race conflict).
    const conflict = await prisma.scheduledEvent.findFirst({
      where: {
        id: { not: event.id },
        facilitators: { some: { id: facilitator.id } },
        startTime: { lt: newEndTime },
        endTime: { gt: newStartTime },
      },
      select: { id: true },
    });
    if (conflict) throw new Error('Ce créneau vient d’être pris');

    await prisma.$transaction(async (tx) => {
      await tx.scheduledEvent.update({
        where: { id: event.id },
        data: {
          startTime: newStartTime,
          endTime: newEndTime,
          rescheduleCount: { increment: 1 },
          originalStartTime: event.originalStartTime ?? event.startTime,
        },
      });
      await tx.scheduledEventRescheduleToken.update({
        where: { id: tokenRow.id },
        data: { consumedAt: new Date() },
      });
    });
  }
}
