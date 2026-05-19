import prisma from '../prisma';
import { generateOpaqueToken } from '../auth/tokens';
import { EmailService } from './email.service';
import { EnrollmentQuoteService } from './enrollment/enrollmentQuote.service';

const INVITE_TTL_DAYS = 14;
const quoteService = new EnrollmentQuoteService();

function getWidgetBaseUrl(): string {
  // Where the second-form widget lives (PR 6d). Defaults to local Next dev.
  return (
    process.env.WIDGET_PUBLIC_URL ??
    process.env.ADMIN_ORIGINS?.split(',')[0]?.trim() ??
    'http://localhost:3000'
  );
}

function formatDateLabel(d: Date): string {
  const date = d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const time = d.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${date} à ${time}`;
}

function formatExpiresLabel(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

const emailService = new EmailService();

export type InviteCycleStats = {
  advanced: number;
  sent: number;
  /** Re-attempted sends for PENDING invites whose original send threw. */
  retried: number;
  lapsed: number;
  sendErrors: number;
  /** Trials we didn't bother inviting because the balance would be ≤ 0
   *  (trial credit already covers the remaining lessons). Marked LAPSED. */
  zeroBalanceSkipped: number;
};

export class EnrollmentInviteService {
  /**
   * Flip PAID_TRIAL → AWAITING_ENROLLMENT_DECISION for lessons whose endTime
   * has passed. Only applies to services with bookingMode === 'LESSON'.
   * ONE_OFF services stay PAID and never get invited.
   */
  async advanceTrialStatuses(): Promise<number> {
    // Prisma `updateMany` doesn't filter through relations — find + update.
    const events = await prisma.scheduledEvent.findMany({
      where: {
        status: 'PAID_TRIAL',
        endTime: { lt: new Date() },
        service: { bookingMode: 'LESSON' },
      },
      select: { id: true },
    });
    if (events.length === 0) return 0;

    const result = await prisma.scheduledEvent.updateMany({
      where: { id: { in: events.map((e) => e.id) } },
      data: { status: 'AWAITING_ENROLLMENT_DECISION' },
    });
    return result.count;
  }

  /**
   * Retry any PENDING invite whose `sentAt` is null — the row was created
   * but the previous send attempt threw (Resend down, network blip, etc.).
   * Without this the cron would silently never retry, because the
   * "needs invite" finder treats any PENDING invite (even unsent) as
   * "already taken care of".
   */
  async retryUnsentInvites(): Promise<{ sent: number; errors: number }> {
    const unsent = await prisma.enrollmentInvite.findMany({
      where: { status: 'PENDING', sentAt: null },
      include: {
        client: { select: { firstname: true, email: true } },
        scheduledEvent: {
          select: {
            startTime: true,
            service: { select: { name: true } },
            facilitators: {
              take: 1,
              select: { firstname: true, lastname: true },
            },
            payments: {
              where: { status: 'SUCCEEDED', purpose: 'TRIAL_LESSON' },
              take: 1,
              select: { amountCents: true, currency: true },
            },
          },
        },
      },
    });

    let sent = 0;
    let errors = 0;
    for (const invite of unsent) {
      const facilitator = invite.scheduledEvent.facilitators[0];
      const trialPayment = invite.scheduledEvent.payments[0];
      const inviteUrl = `${getWidgetBaseUrl()}/widget/enroll/${invite.token}`;
      try {
        console.log(
          `[invites] retrying unsent invite ${invite.id} to ${invite.client.email}`,
        );
        await emailService.sendEnrollmentInvite({
          to: invite.client.email,
          studentFirstname: invite.client.firstname,
          serviceName: invite.scheduledEvent.service.name,
          facilitatorName: facilitator
            ? `${facilitator.firstname} ${facilitator.lastname}`
            : '',
          trialDateLabel: formatDateLabel(invite.scheduledEvent.startTime),
          inviteUrl,
          trialPaidAmount: trialPayment
            ? `${(trialPayment.amountCents / 100).toFixed(2)} ${trialPayment.currency}`
            : '',
          expiresAtLabel: formatExpiresLabel(invite.expiresAt),
        });
        await prisma.enrollmentInvite.update({
          where: { id: invite.id },
          data: { sentAt: new Date() },
        });
        sent++;
      } catch (err) {
        console.error(`[invites] retry failed for invite ${invite.id}:`, err);
        errors++;
      }
    }
    return { sent, errors };
  }

  /**
   * For every AWAITING_ENROLLMENT_DECISION event that has no PENDING invite:
   *   - compute the projected balance (pricePerSession × remainingLessons − trialCredit)
   *   - if balance ≤ 0, mark the event LAPSED and skip — no point inviting the
   *     student to "pay" when they actually owe nothing
   *   - else, create an EnrollmentInvite and send the email
   * Per-event try/catch so one failure doesn't block the rest.
   */
  async sendPendingInvites(): Promise<{
    sent: number;
    errors: number;
    zeroBalanceSkipped: number;
  }> {
    const events = await prisma.scheduledEvent.findMany({
      where: {
        status: 'AWAITING_ENROLLMENT_DECISION',
        enrollmentInvites: { none: { status: 'PENDING' } },
      },
      include: {
        service: {
          select: {
            id: true,
            name: true,
            defaultPrice: true,
            defaultDurationMinutes: true,
          },
        },
        facilitators: {
          take: 1,
          select: { firstname: true, lastname: true },
        },
        clients: {
          take: 1,
          select: { id: true, firstname: true, email: true },
        },
        payments: {
          where: { status: 'SUCCEEDED', purpose: 'TRIAL_LESSON' },
          take: 1,
          select: { amountCents: true, currency: true },
        },
      },
    });

    let sent = 0;
    let errors = 0;
    let zeroBalanceSkipped = 0;

    const now = new Date();

    for (const event of events) {
      const client = event.clients[0];
      if (!client) {
        // No client attached — skip (shouldn't happen via the widget flow).
        console.warn(`[invites] skip event ${event.id}: no client attached`);
        continue;
      }

      const trialPayment = event.payments[0];

      // ----- balance gate -----
      // Look up the active term for this location, compute remaining lessons,
      // and skip-with-LAPSED if balance ≤ 0.
      const term = await prisma.term.findFirst({
        where: {
          OR: [{ locationId: event.locationId }, { locationId: null }],
          startDate: { lte: now },
          endDate: { gte: now },
        },
        orderBy: { startDate: 'desc' },
      });

      if (!term) {
        // No active term — can't compute balance. Leave the event AWAITING so
        // a future cron tick (after admin sets up a term) can pick it up.
        console.warn(
          `[invites] skip event ${event.id}: no active term covers ${now.toISOString()} for location ${event.locationId}`,
        );
        continue;
      }

      const weekday = event.startTime.getDay();
      const startTimeStr = event.startTime.toTimeString().slice(0, 5);
      const enrollmentStart = new Date(event.endTime);
      enrollmentStart.setDate(enrollmentStart.getDate() + 1);

      const quote = quoteService.quote({
        service: {
          id: event.service.id,
          name: event.service.name,
          defaultPrice: event.service.defaultPrice,
          defaultDurationMinutes: event.service.defaultDurationMinutes,
        },
        term: {
          id: term.id,
          name: term.name,
          startDate: term.startDate,
          endDate: term.endDate,
        },
        startDate: enrollmentStart,
        weekday,
        startTime: startTimeStr,
        durationMinutes: event.service.defaultDurationMinutes,
      });

      const totalCents = Math.round(
        event.service.defaultPrice * quote.lessons.remaining * 100,
      );
      const trialCreditCents = trialPayment?.amountCents ?? 0;
      const balanceCents = Math.max(0, totalCents - trialCreditCents);

      if (balanceCents <= 0) {
        // Trial credit already covers the rest of the term — no second form.
        await prisma.scheduledEvent.update({
          where: { id: event.id },
          data: { status: 'LAPSED' },
        });
        zeroBalanceSkipped++;
        continue;
      }
      // ----- end balance gate -----

      const token = generateOpaqueToken();
      const expiresAt = new Date(
        Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
      );

      const invite = await prisma.enrollmentInvite.create({
        data: {
          organizationId: event.organizationId,
          scheduledEventId: event.id,
          clientId: client.id,
          token,
          expiresAt,
        },
      });

      const facilitator = event.facilitators[0];
      const inviteUrl = `${getWidgetBaseUrl()}/widget/enroll/${token}`;

      try {
        await emailService.sendEnrollmentInvite({
          to: client.email,
          studentFirstname: client.firstname,
          serviceName: event.service.name,
          facilitatorName: facilitator
            ? `${facilitator.firstname} ${facilitator.lastname}`
            : '',
          trialDateLabel: formatDateLabel(event.startTime),
          inviteUrl,
          trialPaidAmount: trialPayment
            ? `${(trialPayment.amountCents / 100).toFixed(2)} ${trialPayment.currency}`
            : '',
          expiresAtLabel: formatExpiresLabel(expiresAt),
        });

        await prisma.enrollmentInvite.update({
          where: { id: invite.id },
          data: { sentAt: new Date() },
        });
        sent++;
      } catch (err) {
        console.error(
          `[invites] failed to send for invite ${invite.id}:`,
          err,
        );
        errors++;
      }
    }

    return { sent, errors, zeroBalanceSkipped };
  }

  /**
   * Mark PENDING invites whose expiresAt has passed as EXPIRED, and flip
   * their related event to LAPSED (if it's still AWAITING — admin may have
   * cancelled or converted in the meantime).
   */
  async lapseExpiredInvites(): Promise<number> {
    const expired = await prisma.enrollmentInvite.findMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
      select: { id: true, scheduledEventId: true },
    });
    if (expired.length === 0) return 0;

    await prisma.enrollmentInvite.updateMany({
      where: { id: { in: expired.map((e) => e.id) } },
      data: { status: 'EXPIRED' },
    });

    const eventIds = expired.map((e) => e.scheduledEventId);
    await prisma.scheduledEvent.updateMany({
      where: {
        id: { in: eventIds },
        status: 'AWAITING_ENROLLMENT_DECISION',
      },
      data: { status: 'LAPSED' },
    });

    return expired.length;
  }

  /**
   * Run all three jobs once. Used by the cron timer and by the admin
   * "run now" endpoint.
   */
  async runFullCycle(): Promise<InviteCycleStats> {
    const advanced = await this.advanceTrialStatuses();
    // Retry first, so any rows the previous tick failed on get another
    // attempt before we consider creating brand-new ones.
    const retryResult = await this.retryUnsentInvites();
    const { sent, errors, zeroBalanceSkipped } = await this.sendPendingInvites();
    const lapsed = await this.lapseExpiredInvites();
    return {
      advanced,
      sent: sent + retryResult.sent,
      retried: retryResult.sent,
      lapsed,
      sendErrors: errors + retryResult.errors,
      zeroBalanceSkipped,
    };
  }

  /**
   * Diagnostic: for every event that could plausibly be in-flight in the
   * invite pipeline, return a row explaining what the next cron cycle would
   * do with it. Used when the school wonders "why didn't X get the email?"
   *
   * Covers events with status in (PAID_TRIAL, AWAITING_ENROLLMENT_DECISION)
   * plus any PENDING invite, regardless of event status.
   */
  async diagnose(): Promise<{
    now: string;
    events: Array<{
      id: string;
      status: string;
      startTime: string;
      endTime: string;
      serviceName: string;
      bookingMode: string | null;
      clientEmail: string | null;
      hasActiveTerm: boolean;
      pendingInviteCount: number;
      pendingInvites: Array<{
        id: string;
        createdAt: string;
        sentAt: string | null;
        expiresAt: string;
        emailDelivered: boolean;
      }>;
      balanceCents: number | null;
      nextAction: string;
    }>;
  }> {
    const now = new Date();
    const events = await prisma.scheduledEvent.findMany({
      where: {
        OR: [
          { status: 'PAID_TRIAL' },
          { status: 'AWAITING_ENROLLMENT_DECISION' },
          { enrollmentInvites: { some: { status: 'PENDING' } } },
        ],
      },
      include: {
        service: {
          select: {
            id: true,
            name: true,
            defaultPrice: true,
            defaultDurationMinutes: true,
            bookingMode: true,
          },
        },
        clients: { take: 1, select: { email: true } },
        payments: {
          where: { status: 'SUCCEEDED', purpose: 'TRIAL_LESSON' },
          take: 1,
          select: { amountCents: true },
        },
        enrollmentInvites: {
          where: { status: 'PENDING' },
          select: {
            id: true,
            createdAt: true,
            sentAt: true,
            expiresAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { startTime: 'desc' },
      take: 50,
    });

    const rows = [] as Awaited<ReturnType<typeof this.diagnose>>['events'];

    for (const event of events) {
      const client = event.clients[0];
      const pendingInviteCount = event.enrollmentInvites.length;
      const unsentInvite = event.enrollmentInvites.find((i) => i.sentAt === null);

      const term = await prisma.term.findFirst({
        where: {
          OR: [{ locationId: event.locationId }, { locationId: null }],
          startDate: { lte: now },
          endDate: { gte: now },
        },
        orderBy: { startDate: 'desc' },
      });

      let balanceCents: number | null = null;
      if (term && event.service) {
        const weekday = event.startTime.getDay();
        const startTimeStr = event.startTime.toTimeString().slice(0, 5);
        const enrollmentStart = new Date(event.endTime);
        enrollmentStart.setDate(enrollmentStart.getDate() + 1);
        try {
          const quote = quoteService.quote({
            service: {
              id: event.service.id,
              name: event.service.name,
              defaultPrice: event.service.defaultPrice,
              defaultDurationMinutes: event.service.defaultDurationMinutes,
            },
            term: {
              id: term.id,
              name: term.name,
              startDate: term.startDate,
              endDate: term.endDate,
            },
            startDate: enrollmentStart,
            weekday,
            startTime: startTimeStr,
            durationMinutes: event.service.defaultDurationMinutes,
          });
          const totalCents = Math.round(
            event.service.defaultPrice * quote.lessons.remaining * 100,
          );
          const trialCreditCents = event.payments[0]?.amountCents ?? 0;
          balanceCents = Math.max(0, totalCents - trialCreditCents);
        } catch {
          balanceCents = null;
        }
      }

      // Reason narrative
      let nextAction = '';
      if (event.status === 'PAID_TRIAL') {
        if (event.endTime >= now) {
          nextAction = `Will advance once endTime (${event.endTime.toISOString()}) passes.`;
        } else if (event.service?.bookingMode !== 'LESSON') {
          nextAction = `BLOCKED: service.bookingMode is "${event.service?.bookingMode ?? 'null'}", cron only advances LESSON.`;
        } else {
          nextAction = 'Will advance to AWAITING_ENROLLMENT_DECISION on next cycle.';
        }
      } else if (event.status === 'AWAITING_ENROLLMENT_DECISION') {
        if (unsentInvite) {
          nextAction = `Invite ${unsentInvite.id} was CREATED at ${unsentInvite.createdAt.toISOString()} but the email never went out (sentAt is null). Next cycle will retry. You can also POST /api/jobs/enrollment-invites/${unsentInvite.id}/resend.`;
        } else if (pendingInviteCount > 0) {
          nextAction = `Already has ${pendingInviteCount} PENDING invite(s), email already sent — nothing to do.`;
        } else if (!client) {
          nextAction = 'BLOCKED: no client attached to event.';
        } else if (!term) {
          nextAction = 'BLOCKED: no active term covers today for this location.';
        } else if (balanceCents !== null && balanceCents <= 0) {
          nextAction = `Will be marked LAPSED — trial credit already covers the balance (${balanceCents}¢).`;
        } else {
          nextAction = `Will send invite to ${client.email} on next cycle.`;
        }
      } else {
        // pending invite path
        nextAction = `Event status is ${event.status}; invite present.`;
      }

      rows.push({
        id: event.id,
        status: event.status,
        startTime: event.startTime.toISOString(),
        endTime: event.endTime.toISOString(),
        serviceName: event.service?.name ?? '—',
        bookingMode: event.service?.bookingMode ?? null,
        clientEmail: client?.email ?? null,
        hasActiveTerm: !!term,
        pendingInviteCount,
        pendingInvites: event.enrollmentInvites.map((i) => ({
          id: i.id,
          createdAt: i.createdAt.toISOString(),
          sentAt: i.sentAt ? i.sentAt.toISOString() : null,
          expiresAt: i.expiresAt.toISOString(),
          emailDelivered: i.sentAt !== null,
        })),
        balanceCents,
        nextAction,
      });
    }

    return { now: now.toISOString(), events: rows };
  }

  /**
   * Admin "Resend invite" — re-fire the email for an existing PENDING invite.
   * Doesn't create a new invite (token stays the same).
   */
  async resend(inviteId: string): Promise<void> {
    const invite = await prisma.enrollmentInvite.findFirst({
      where: { id: inviteId, status: 'PENDING' },
      include: {
        client: { select: { firstname: true, email: true } },
        scheduledEvent: {
          select: {
            startTime: true,
            service: { select: { name: true, defaultPrice: true } },
            facilitators: {
              take: 1,
              select: { firstname: true, lastname: true },
            },
            payments: {
              where: { status: 'SUCCEEDED', purpose: 'TRIAL_LESSON' },
              take: 1,
              select: { amountCents: true, currency: true },
            },
          },
        },
      },
    });
    if (!invite) throw new Error('Invite not found or not pending');

    const facilitator = invite.scheduledEvent.facilitators[0];
    const trialPayment = invite.scheduledEvent.payments[0];
    const inviteUrl = `${getWidgetBaseUrl()}/widget/enroll/${invite.token}`;

    await emailService.sendEnrollmentInvite({
      to: invite.client.email,
      studentFirstname: invite.client.firstname,
      serviceName: invite.scheduledEvent.service.name,
      facilitatorName: facilitator
        ? `${facilitator.firstname} ${facilitator.lastname}`
        : '',
      trialDateLabel: formatDateLabel(invite.scheduledEvent.startTime),
      inviteUrl,
      trialPaidAmount: trialPayment
        ? `${(trialPayment.amountCents / 100).toFixed(2)} ${trialPayment.currency}`
        : '',
      expiresAtLabel: formatExpiresLabel(invite.expiresAt),
    });

    await prisma.enrollmentInvite.update({
      where: { id: invite.id },
      data: { sentAt: new Date() },
    });
  }
}
