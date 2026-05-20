import prisma from '../prisma';
import { RescheduleOptionsService } from './rescheduleOptions.service';
import { EmailService } from './email.service';
import { auditLog } from './audit/audit.service';
import { snapshotScheduledEvent } from './audit/snapshots';

/** Public-reschedule actor — token-driven (the client), not a logged-in user. */
const PUBLIC_RESCHEDULE_ACTOR = {
  id: null,
  email: 'system:public-reschedule',
  role: 'SYSTEM',
};

const RESCHEDULE_CUTOFF_HOURS = 48;
const OPTIONS_WINDOW_DAYS = 30;

const options = new RescheduleOptionsService();
const emailService = new EmailService();

function formatTrialDateLabel(d: Date): string {
  const date = d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${date} à ${time}`;
}

function appendNote(existing: string | null | undefined, line: string): string {
  const prev = (existing ?? '').trim();
  return prev.length === 0 ? line : `${prev}\n${line}`;
}

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
   *
   * Side effects:
   *   - appends an audit line to `ScheduledEvent.notes` recording the previous
   *     start/end and the reschedule timestamp (never overwrites prior notes);
   *   - fire-and-forget confirmation email to the student (failures logged
   *     but never thrown — the booking is already updated).
   */
  async apply(token: string, newStartTime: Date): Promise<void> {
    const tokenRow = await prisma.scheduledEventRescheduleToken.findFirst({
      where: { token },
      include: {
        scheduledEvent: {
          include: {
            facilitators: {
              take: 1,
              select: { id: true, firstname: true, lastname: true },
            },
            service: { select: { name: true, defaultDurationMinutes: true } },
            location: { select: { name: true } },
            clients: { take: 1, select: { email: true, firstname: true } },
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

    const previousStartTime = event.startTime;
    const noteLine = `Reprogrammé le ${now.toLocaleString('fr-FR')} — créneau initial : ${formatTrialDateLabel(previousStartTime)} (par le client via lien email)`;
    const nextNotes = appendNote(event.notes, noteLine);

    const reschedResult = await prisma.$transaction(async (tx) => {
      const updated = await tx.scheduledEvent.update({
        where: { id: event.id },
        data: {
          startTime: newStartTime,
          endTime: newEndTime,
          rescheduleCount: { increment: 1 },
          originalStartTime: event.originalStartTime ?? previousStartTime,
          notes: nextNotes,
        },
      });
      await tx.scheduledEventRescheduleToken.update({
        where: { id: tokenRow.id },
        data: { consumedAt: new Date() },
      });
      return updated;
    });

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'ScheduledEvent',
      entityId: event.id,
      before: snapshotScheduledEvent(event),
      after: snapshotScheduledEvent(reschedResult),
      actor: PUBLIC_RESCHEDULE_ACTOR,
    });

    // Fire-and-forget confirmation email. Don't fail the API call if it bounces.
    const client = event.clients[0];
    if (!client?.email) {
      console.warn(
        `[reschedule] event ${event.id} has no client/email — skipping confirmation email`,
      );
    } else {
      console.log(
        `[reschedule] dispatching confirmation email to ${client.email} (event ${event.id}, new start ${newStartTime.toISOString()})`,
      );
      void emailService
        .sendTrialReschedule({
          to: client.email,
          studentFirstname: client.firstname,
          serviceName: event.service.name,
          facilitatorName: `${facilitator.firstname} ${facilitator.lastname}`,
          previousDateLabel: formatTrialDateLabel(previousStartTime),
          newDateLabel: formatTrialDateLabel(newStartTime),
          locationName: event.location.name,
        })
        .then(() => {
          console.log(`[reschedule] confirmation email sent to ${client.email}`);
        })
        .catch((err) => {
          console.error('[reschedule] confirmation email failed:', err);
        });
    }
  }
}
