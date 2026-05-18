import prisma from '../prisma';
import { generateOpaqueToken } from '../auth/tokens';
import { EmailService } from './email.service';

const INVITE_TTL_DAYS = 14;

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
  lapsed: number;
  sendErrors: number;
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
   * For every AWAITING_ENROLLMENT_DECISION event that has no PENDING invite:
   * create one and send the email. Per-event try/catch so one failure
   * doesn't block the rest.
   */
  async sendPendingInvites(): Promise<{ sent: number; errors: number }> {
    const events = await prisma.scheduledEvent.findMany({
      where: {
        status: 'AWAITING_ENROLLMENT_DECISION',
        enrollmentInvites: { none: { status: 'PENDING' } },
      },
      include: {
        service: { select: { name: true, defaultPrice: true } },
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

    for (const event of events) {
      const client = event.clients[0];
      if (!client) {
        // No client attached — skip (shouldn't happen via the widget flow).
        continue;
      }

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
      const trialPayment = event.payments[0];
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

    return { sent, errors };
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
    const { sent, errors } = await this.sendPendingInvites();
    const lapsed = await this.lapseExpiredInvites();
    return { advanced, sent, lapsed, sendErrors: errors };
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
