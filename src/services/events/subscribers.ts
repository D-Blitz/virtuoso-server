import prisma from '../../prisma';
import * as bus from './bus';
import { EmailService } from '../email.service';

/**
 * Phase 2.0a — default bus subscribers.
 *
 * These are the hardcoded reactions that ship in v1: they preserve
 * the user-visible behavior of each lifecycle event. When the engine
 * (Phase 2.x) lands, an additional subscriber routes events to
 * user-configured flow triggers. These default subscribers stay too
 * — they're the safety net for orgs that haven't configured
 * anything custom.
 *
 * Adding a new subscriber: declare it as `bus.on('event.kind', fn)`
 * at module load. The bus runs handlers async on the microtask queue;
 * a subscriber that throws is logged but doesn't break the emitter.
 */

const emailService = new EmailService();

// ---------- event.cancelled (Phase 1.1) -----------------------------------
//
// Sends a cancellation notice to each client linked to the event.
// Doesn't mention refunds — those are a separate workflow on the
// payments surface, not tied to event cancellation. If the admin
// also issued a refund, the client gets a separate refund notice
// driven by `payment.refunded`.
//
// Doesn't notify the facilitator here — facilitator notifications
// land with Phase 4 (notification center) where they get proper
// per-user preferences.
bus.on('event.cancelled', async (env) => {
  const ev = await prisma.scheduledEvent.findFirst({
    where: { id: env.payload.scheduledEventId },
    include: {
      facilitators: { take: 1, select: { firstname: true, lastname: true } },
      clients: { select: { firstname: true, email: true } },
      service: { select: { name: true } },
    },
  });
  if (!ev) return;
  const facilitator = ev.facilitators[0];
  const dateLabel = ev.startTime.toLocaleString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });

  for (const client of ev.clients) {
    if (!client.email) continue;
    try {
      await emailService.sendEventCancellation({
        to: client.email,
        recipientFirstname: client.firstname,
        serviceName: ev.service?.name ?? '',
        facilitatorName: facilitator
          ? `${facilitator.firstname} ${facilitator.lastname}`
          : '',
        dateLabel,
        reason: env.payload.reason,
      });
    } catch (err) {
      console.error(
        `[bus] event.cancelled email failed for ${client.email}:`,
        err,
      );
    }
  }
});

// ---------- payment.failed (Phase 1.3) ------------------------------------
//
// Sends a "réessayez" email to the paying client. Reuses the existing
// reschedule-token URL when available (the original booking flow
// created one); otherwise falls back to no link, letting the student
// contact the school. Retry-by-URL is fire-and-forget; the booking
// row stays in PENDING_PAYMENT for ENROLLMENT_BALANCE or CANCELED
// for TRIAL_LESSON (set by the webhook handler before this subscriber
// runs).
bus.on('payment.failed', async (env) => {
  const { paymentId, scheduledEventId, amount } = env.payload;

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId },
    include: {
      client: { select: { firstname: true, email: true } },
      relatedScheduledEvent: {
        select: {
          service: { select: { name: true } },
        },
      },
    },
  });
  if (!payment) return;
  if (!payment.client?.email) return;

  // For trials we point the student back at the widget origin; the
  // server doesn't know the per-org widget URL deeply (yet), so we
  // fall back to WIDGET_PUBLIC_URL if set, no link otherwise.
  let retryUrl: string | undefined;
  if (scheduledEventId) {
    const base = process.env.WIDGET_PUBLIC_URL;
    if (base) {
      retryUrl = `${base}/widget`;
    }
  }

  try {
    await emailService.sendPaymentFailure({
      to: payment.client.email,
      recipientFirstname: payment.client.firstname,
      serviceName: payment.relatedScheduledEvent?.service?.name ?? '',
      amount,
      retryUrl,
    });
  } catch (err) {
    console.error(
      `[bus] payment.failed email failed for ${payment.client.email}:`,
      err,
    );
  }
});

/**
 * Side-effect import: importing this module wires the subscribers.
 * `registerSubscribers()` exists as an explicit hook for callers who
 * prefer not to rely on import side-effects (tests, future engine
 * code that conditionally enables defaults).
 */
export function registerSubscribers(): void {
  // No-op — subscribers register at module load above. Calling this
  // function just ensures the module gets imported.
}
