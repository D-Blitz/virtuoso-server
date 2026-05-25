import prisma from '../../prisma';
import { dispatch } from '../notifications/dispatcher';

/**
 * Phase 1.2 — pre-event reminder sender.
 *
 * Finds events approaching their start time that haven't been
 * reminded yet, sends via the NotificationDispatcher, stamps the
 * row to prevent double-send. Idempotent within a polling window
 * because the eligibility query joins on `<stamp> IS NULL`.
 *
 * Eligibility:
 *   - status IN ('SCHEDULED', 'PAID_TRIAL') — only events that
 *     actually will happen. SKIP: PENDING_PAYMENT (not paid),
 *     CANCELED, LAPSED, AWAITING_ENROLLMENT_DECISION (post-event),
 *     CONVERTED_TO_ENROLLMENT (already in a term).
 *   - has at least one client with a non-empty email (no point in
 *     reminding an admin-created event with no booked party).
 *   - deletedAt / archivedAt = null (Prisma extension auto-filters).
 *
 * Window: chosen to be wider than the cron interval so missed
 * polls don't drop reminders. T-24h reminder window = [now+23h,
 * now+25h]; T-48h = [now+47h, now+49h]. Cron at 10-min interval
 * → each event in-window gets ~12 polling opportunities; the
 * idempotency stamp ensures one send.
 */

const WINDOW_HOURS = 1; // ± hours around the target offset

type ReminderKind = 'first-48h' | 'second-24h';

export type ReminderCycleStats = {
  sent48h: number;
  sent24h: number;
  errors: number;
};

export class ReminderService {
  async runCycle(): Promise<ReminderCycleStats> {
    const stats: ReminderCycleStats = { sent48h: 0, sent24h: 0, errors: 0 };

    // Two passes, one per stamp. Sequential for simpler error reporting;
    // volumes are tiny (a few rows per cron tick).
    const a = await this.processWindow('first-48h', 48);
    const b = await this.processWindow('second-24h', 24);

    stats.sent48h = a.sent;
    stats.sent24h = b.sent;
    stats.errors = a.errors + b.errors;

    return stats;
  }

  private async processWindow(
    kind: ReminderKind,
    hoursBefore: number,
  ): Promise<{ sent: number; errors: number }> {
    const now = Date.now();
    const center = now + hoursBefore * 60 * 60 * 1000;
    const lower = new Date(center - WINDOW_HOURS * 60 * 60 * 1000);
    const upper = new Date(center + WINDOW_HOURS * 60 * 60 * 1000);

    const stampField =
      kind === 'first-48h' ? 'firstReminderSentAt' : 'secondReminderSentAt';

    // Cron lookups are intentionally org-scoped-free: the
    // ReminderService runs as `system:reminder-cron` with no
    // RequestContext, so the prisma extension doesn't auto-scope
    // by organizationId. We need cross-tenant visibility to drive
    // reminders for every org's events.
    const candidates = await (prisma as any).scheduledEvent.findMany({
      where: {
        status: { in: ['SCHEDULED', 'PAID_TRIAL'] },
        startTime: { gte: lower, lte: upper },
        [stampField]: null,
      },
      include: {
        facilitators: {
          take: 1,
          select: { firstname: true, lastname: true },
        },
        clients: {
          select: { firstname: true, email: true },
        },
        service: { select: { name: true } },
        location: { select: { name: true } },
      },
    });

    let sent = 0;
    let errors = 0;

    for (const event of candidates) {
      // Filter out events whose client either has no email at all or
      // is an admin-created event with no booked party. Stamp the row
      // anyway so we don't keep re-querying these every cycle for the
      // remaining hours of the window — there's nothing to send.
      const validClients = event.clients.filter(
        (c: any) => typeof c.email === 'string' && c.email.length > 0,
      );
      if (validClients.length === 0) {
        await this.stampSent(event.id, stampField);
        continue;
      }

      const facilitator = event.facilitators[0];
      const dateLabel = formatDateLabel(event.startTime);

      const rescheduleUrl =
        kind === 'first-48h'
          ? await this.findRescheduleUrl(event.id, event.organizationId)
          : undefined;

      let allSent = true;
      for (const client of validClients) {
        try {
          await dispatch(
            {
              kind:
                kind === 'first-48h'
                  ? 'trial-reminder-48h'
                  : 'trial-reminder-24h',
              vars: {
                recipientFirstname: client.firstname,
                serviceName: event.service?.name ?? '',
                facilitatorName: facilitator
                  ? `${facilitator.firstname} ${facilitator.lastname}`
                  : '',
                dateLabel,
                locationName: event.location?.name ?? '',
                rescheduleUrl,
              },
            },
            { email: client.email },
          );
        } catch (err) {
          allSent = false;
          errors += 1;
          console.error(
            `[reminders] ${kind} send failed for event=${event.id} client=${client.email}:`,
            err,
          );
        }
      }

      // Only stamp when EVERY recipient got the email — partial
      // failures get retried on the next cycle (still in window).
      // If the window passes with the row unsteamped, the email
      // is missed; that's the cost of strict idempotency over
      // best-effort. Accept it for v1.
      if (allSent) {
        await this.stampSent(event.id, stampField);
        sent += 1;
      }
    }

    return { sent, errors };
  }

  private async stampSent(eventId: string, field: string): Promise<void> {
    await (prisma as any).scheduledEvent.update({
      where: { id: eventId },
      data: { [field]: new Date() },
    });
  }

  /**
   * Look up an existing reschedule token for this event. We don't
   * create one for the reminder — the trial-confirmation email
   * (sent post-payment) already created the token and emailed it to
   * the client. Reminders just re-surface that same link. If no
   * token exists (admin-created event, legacy data), reminder still
   * sends but without the link.
   */
  private async findRescheduleUrl(
    eventId: string,
    organizationId: string,
  ): Promise<string | undefined> {
    const token = await (prisma as any).scheduledEventRescheduleToken.findFirst({
      where: {
        scheduledEventId: eventId,
        organizationId,
        consumedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: { token: true },
    });
    if (!token) return undefined;
    const baseUrl =
      process.env.WIDGET_PUBLIC_URL ??
      process.env.ADMIN_ORIGINS?.split(',')[0]?.trim() ??
      'http://localhost:3000';
    return `${baseUrl}/widget/reschedule/${token.token}`;
  }
}

function formatDateLabel(d: Date): string {
  return d.toLocaleString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
