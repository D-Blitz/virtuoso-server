import prisma from '../prisma';
import type { StripeEvent } from './stripe.service';
import { EnrollmentInviteCheckoutService } from './enrollmentInviteCheckout.service';
import { EmailService } from './email.service';
import { generateOpaqueToken } from '../auth/tokens';
import { auditLog } from './audit/audit.service';
import { snapshotScheduledEvent } from './audit/snapshots';
import * as bus from './events/bus';

/** System actor for webhook-driven mutations. See AUDIT_LOG_DESIGN.md. */
function webhookActor(eventType: string) {
  return {
    id: null,
    email: `system:webhook:${eventType}`,
    role: 'SYSTEM',
  };
}

/**
 * Webhook handler. Runs OUTSIDE any request org context — receives global
 * Stripe events and routes them based on PaymentIntent metadata.
 *
 * Idempotent: every event is stamped in StripeEvent on receipt; replay just
 * returns OK without reapplying state.
 */

const enrollmentCheckout = new EnrollmentInviteCheckoutService();
const emailService = new EmailService();

function getWidgetBaseUrl(): string {
  return (
    process.env.WIDGET_PUBLIC_URL ??
    process.env.ADMIN_ORIGINS?.split(',')[0]?.trim() ??
    'http://localhost:3000'
  );
}

function formatTrialDateLabel(d: Date): string {
  const date = d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${date} à ${time}`;
}

function formatRecurringSlotLabel(
  weekday: number | null,
  time: string,
  minutes: number,
): string {
  // June 2026: weekday is nullable on Enrollment (DAILY / CUSTOM
  // frequencies don't have one). Fall back to a generic label
  // rather than crashing — the email recipient still gets the
  // time / duration.
  if (weekday == null) return `à ${time} (${minutes} min)`;
  const days = ['dimanches', 'lundis', 'mardis', 'mercredis', 'jeudis', 'vendredis', 'samedis'];
  const dayLabel = days[weekday] ?? '—';
  return `tous les ${dayLabel} à ${time} (${minutes} min)`;
}

function formatLessonLabel(d: Date): string {
  const date = d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${date} à ${time}`;
}

function formatEurosLabel(amountCents: number, currency: string): string {
  const value = (amountCents / 100).toFixed(2).replace('.', ',');
  return `${value} ${currency === 'EUR' ? '€' : currency}`;
}

/**
 * After an enrollment is activated, send the student confirmation (with
 * full schedule + .ics) and a lighter notification to the assigned teacher.
 * Failures are logged but never thrown — the enrollment is already valid.
 */
async function sendEnrollmentConfirmationsAsync(
  enrollmentId: string,
  paymentId: string,
): Promise<void> {
  try {
    const enrollment = await prisma.enrollment.findFirst({
      where: { id: enrollmentId },
      include: {
        client: { select: { firstname: true, lastname: true, email: true } },
        service: { select: { name: true } },
        location: { select: { name: true } },
        term: { select: { name: true } },
        facilitator: { select: { firstname: true, lastname: true, email: true } },
        events: {
          select: { id: true, startTime: true, endTime: true },
          orderBy: { startTime: 'asc' },
        },
      },
    });
    if (!enrollment) {
      console.warn(`[webhook] enrollment ${enrollmentId} missing — skipping confirmations`);
      return;
    }
    if (enrollment.events.length === 0) {
      console.warn(`[webhook] enrollment ${enrollmentId} has no events — skipping confirmations`);
      return;
    }

    const payment = await prisma.payment.findFirst({
      where: { id: paymentId },
      select: { amountCents: true, currency: true },
    });
    const totalCents = payment?.amountCents ?? 0;
    const currency = payment?.currency ?? 'EUR';

    const first = enrollment.events[0];
    const last = enrollment.events[enrollment.events.length - 1];

    const facilitatorName = enrollment.facilitator
      ? `${enrollment.facilitator.firstname} ${enrollment.facilitator.lastname}`
      : '—';

    const slotLabel = formatRecurringSlotLabel(
      enrollment.weekday,
      enrollment.startTime,
      enrollment.durationMinutes,
    );

    // Student confirmation (with ICS + admin BCC if configured)
    console.log(
      `[webhook] dispatching enrollment confirmation to ${enrollment.client.email} (enrollment ${enrollment.id})`,
    );
    void emailService
      .sendEnrollmentConfirmation({
        to: enrollment.client.email,
        studentFirstname: enrollment.client.firstname,
        serviceName: enrollment.service.name,
        facilitatorName,
        termName: enrollment.term.name,
        recurringSlotLabel: slotLabel,
        locationName: enrollment.location.name,
        totalPaidLabel: formatEurosLabel(totalCents, currency),
        lessonCount: enrollment.events.length,
        firstLessonLabel: formatLessonLabel(first.startTime),
        lastLessonLabel: formatLessonLabel(last.startTime),
        lessons: enrollment.events.map((e) => ({
          id: e.id,
          startTime: e.startTime,
          endTime: e.endTime,
        })),
      })
      .then(() => {
        console.log(`[webhook] enrollment confirmation sent to ${enrollment.client.email}`);
      })
      .catch((err) => {
        console.error('[webhook] enrollment confirmation email failed:', err);
      });

    // Teacher notification (lighter, no ICS)
    if (enrollment.facilitator?.email) {
      console.log(
        `[webhook] dispatching teacher notification to ${enrollment.facilitator.email}`,
      );
      void emailService
        .sendTeacherNewStudent({
          to: enrollment.facilitator.email,
          teacherFirstname: enrollment.facilitator.firstname,
          studentName: `${enrollment.client.firstname} ${enrollment.client.lastname}`.trim(),
          studentEmail: enrollment.client.email,
          serviceName: enrollment.service.name,
          recurringSlotLabel: slotLabel,
          locationName: enrollment.location.name,
          firstLessonLabel: formatLessonLabel(first.startTime),
          lessonCount: enrollment.events.length,
          termName: enrollment.term.name,
        })
        .then(() => {
          console.log(
            `[webhook] teacher notification sent to ${enrollment.facilitator!.email}`,
          );
        })
        .catch((err) => {
          console.error('[webhook] teacher notification email failed:', err);
        });
    } else {
      console.warn(
        `[webhook] enrollment ${enrollment.id} has no facilitator email — skipping teacher notification`,
      );
    }
  } catch (err) {
    console.error('[webhook] enrollment confirmations setup failed:', err);
  }
}

/**
 * After a trial-lesson payment succeeds, generate a reschedule token + send
 * the confirmation email. Failures here don't fail the webhook — the
 * confirmation is best-effort, the booking is already valid.
 */
async function sendTrialConfirmationAsync(scheduledEventId: string): Promise<void> {
  try {
    const event = await prisma.scheduledEvent.findFirst({
      where: { id: scheduledEventId },
      include: {
        facilitators: {
          take: 1,
          select: { firstname: true, lastname: true },
        },
        clients: {
          take: 1,
          select: { firstname: true, email: true },
        },
        service: { select: { name: true } },
        location: { select: { name: true } },
      },
    });
    if (!event) return;
    const client = event.clients[0];
    if (!client) return;
    const facilitator = event.facilitators[0];

    const token = generateOpaqueToken();
    await prisma.scheduledEventRescheduleToken.create({
      data: {
        organizationId: event.organizationId,
        scheduledEventId: event.id,
        token,
      },
    });

    const rescheduleUrl = `${getWidgetBaseUrl()}/widget/reschedule/${token}`;

    await emailService.sendTrialConfirmation({
      to: client.email,
      studentFirstname: client.firstname,
      serviceName: event.service.name,
      facilitatorName: facilitator
        ? `${facilitator.firstname} ${facilitator.lastname}`
        : '',
      trialDateLabel: formatTrialDateLabel(event.startTime),
      locationName: event.location.name,
      rescheduleUrl,
    });
  } catch (err) {
    console.error('[webhook] trial confirmation email failed:', err);
  }
}

export class WebhookService {
  async handle(event: StripeEvent): Promise<{ ok: boolean; duplicate: boolean }> {
    // Idempotency: insert by event id. If we've seen it before, bail.
    try {
      await prisma.stripeEvent.create({
        data: {
          id: event.id,
          type: event.type,
          payload: event as unknown as object,
        },
      });
    } catch (e: any) {
      // P2002 = unique violation = we already saw this event.
      if (e?.code === 'P2002') {
        return { ok: true, duplicate: true };
      }
      throw e;
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentSucceeded(event.data.object);
        break;
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
        await this.handlePaymentFailedOrCanceled(event.data.object);
        break;
      case 'charge.refunded':
        await this.handleRefund(event.data.object);
        break;
      default:
        // Unhandled event type — still mark processed so we don't retry forever.
        break;
    }

    await prisma.stripeEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    });

    return { ok: true, duplicate: false };
  }

  private async handlePaymentSucceeded(pi: any): Promise<void> {
    const meta = pi?.metadata ?? {};
    const paymentId = meta.paymentId as string | undefined;
    const scheduledEventId = meta.scheduledEventId as string | undefined;
    const submissionId = meta.widgetSubmissionId as string | undefined;
    const enrollmentInviteId = meta.enrollmentInviteId as string | undefined;
    const purpose = meta.purpose as string | undefined;

    if (!paymentId) {
      console.warn(
        '[webhook] payment_intent.succeeded with no paymentId in metadata',
        pi?.id,
      );
      return;
    }

    // Mark the payment SUCCEEDED in all cases.
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'SUCCEEDED' },
    });

    // Route by purpose:
    //   ENROLLMENT_BALANCE → activate enrollment (handles event/invite state)
    //   TRIAL_LESSON (or default) → flip trial event to PAID_TRIAL
    if (purpose === 'ENROLLMENT_BALANCE' && enrollmentInviteId) {
      try {
        const result = await enrollmentCheckout.activateFromPayment({
          paymentId,
          enrollmentInviteId,
        });
        if (result) {
          console.log(
            `[webhook] activated enrollment ${result.enrollmentId} (${result.eventsGenerated} events generated)`,
          );
          // Fire-and-forget: student confirmation (with ICS + admin BCC)
          // + teacher notification.
          void sendEnrollmentConfirmationsAsync(result.enrollmentId, paymentId);
        }
      } catch (err) {
        console.error('[webhook] enrollment activation failed:', err);
        // Payment is still marked SUCCEEDED — admin will see the discrepancy
        // and can manually intervene. Better than re-throwing and getting
        // Stripe to retry, because retries would create duplicate enrollments.
      }
      return;
    }

    // Trial lesson path (default)
    if (scheduledEventId) {
      const before = await prisma.scheduledEvent.findUnique({
        where: { id: scheduledEventId },
      });
      const updated = await prisma.scheduledEvent.update({
        where: { id: scheduledEventId },
        data: { status: 'PAID_TRIAL' },
      });
      if (before) {
        void auditLog.record({
          action: 'UPDATE',
          entityType: 'ScheduledEvent',
          entityId: scheduledEventId,
          before: snapshotScheduledEvent(before),
          after: snapshotScheduledEvent(updated),
          actor: webhookActor('payment_succeeded'),
        });
      }
      // Fire-and-forget: confirmation email with reschedule link.
      void sendTrialConfirmationAsync(scheduledEventId);
    }

    if (submissionId) {
      await prisma.widgetSubmission.update({
        where: { id: submissionId },
        data: { status: 'CONFIRMED' },
      });
    }

    // Phase 2.0a — emit lifecycle event AFTER all transactional
    // writes succeed. Subscribers (future engine, additional handlers)
    // are fire-and-forget; nothing they do can affect the webhook
    // response or roll back the DB changes above.
    const orgId = await resolveOrgIdForPayment(paymentId);
    bus.emit(
      'payment.succeeded',
      {
        paymentId,
        scheduledEventId: scheduledEventId ?? null,
        submissionId: submissionId ?? null,
        enrollmentInviteId: enrollmentInviteId ?? null,
        purpose: purpose ?? null,
        amount: typeof pi?.amount === 'number' ? pi.amount / 100 : 0,
      },
      {
        actor: { userId: null, email: 'system:stripe-webhook', source: 'webhook' },
        organizationId: orgId,
      },
    );
  }

  private async handlePaymentFailedOrCanceled(pi: any): Promise<void> {
    const meta = pi?.metadata ?? {};
    const paymentId = meta.paymentId as string | undefined;
    const scheduledEventId = meta.scheduledEventId as string | undefined;
    const submissionId = meta.widgetSubmissionId as string | undefined;
    const purpose = meta.purpose as string | undefined;

    if (paymentId) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'FAILED' },
      });
    }

    // For ENROLLMENT_BALANCE we don't cancel anything else — the invite is
    // still PENDING and the student can retry checkout. Don't touch the
    // ScheduledEvent (the trial already happened).
    if (purpose === 'ENROLLMENT_BALANCE') return;

    // Trial lesson path
    if (scheduledEventId) {
      const before = await prisma.scheduledEvent.findUnique({
        where: { id: scheduledEventId },
      });
      const updated = await prisma.scheduledEvent.update({
        where: { id: scheduledEventId },
        data: { status: 'CANCELED' },
      });
      if (before) {
        void auditLog.record({
          action: 'UPDATE',
          entityType: 'ScheduledEvent',
          entityId: scheduledEventId,
          before: snapshotScheduledEvent(before),
          after: snapshotScheduledEvent(updated),
          actor: webhookActor('payment_failed'),
        });
      }
    }
    if (submissionId) {
      await prisma.widgetSubmission.update({
        where: { id: submissionId },
        data: { status: 'REJECTED' },
      });
    }

    // Phase 2.0a — emit `payment.failed` so subscribers (recovery
    // email, future engine triggers) can react. ENROLLMENT_BALANCE
    // doesn't touch the ScheduledEvent path above but still emits;
    // a "retry your enrollment payment" email is still relevant.
    if (paymentId) {
      const orgId = await resolveOrgIdForPayment(paymentId);
      bus.emit(
        'payment.failed',
        {
          paymentId,
          scheduledEventId: scheduledEventId ?? null,
          submissionId: submissionId ?? null,
          enrollmentInviteId: undefined as any, // not extracted in this branch
          purpose: purpose ?? null,
          amount: typeof pi?.amount === 'number' ? pi.amount / 100 : 0,
        },
        {
          actor: { userId: null, email: 'system:stripe-webhook', source: 'webhook' },
          organizationId: orgId,
        },
      );
    }
  }

  private async handleRefund(charge: any): Promise<void> {
    const paymentIntentId =
      typeof charge?.payment_intent === 'string'
        ? charge.payment_intent
        : charge?.payment_intent?.id;
    if (!paymentIntentId) return;

    const refunded = await prisma.payment.findFirst({
      where: { stripePaymentIntentId: paymentIntentId },
      select: {
        id: true,
        organizationId: true,
        relatedScheduledEventId: true,
      },
    });

    await prisma.payment.updateMany({
      where: { stripePaymentIntentId: paymentIntentId },
      data: { status: 'REFUNDED' },
    });

    // Phase 2.0a — emit so future engine triggers can react. Amount
    // is in Stripe cents on the charge object; convert to EUR (or
    // whatever the org currency is — Stripe handles the unit).
    if (refunded) {
      const refundedAmount =
        typeof charge?.amount_refunded === 'number'
          ? charge.amount_refunded / 100
          : 0;
      bus.emit(
        'payment.refunded',
        {
          paymentId: refunded.id,
          refundedAmount,
          scheduledEventId: refunded.relatedScheduledEventId ?? null,
        },
        {
          actor: { userId: null, email: 'system:stripe-webhook', source: 'webhook' },
          organizationId: refunded.organizationId,
        },
      );
    }
  }
}

/**
 * Resolves the org id for a Payment by its app id. Used by the
 * webhook to set `organizationId` on emitted events — the webhook
 * runs with no RequestContext, so the bus can't derive it itself.
 */
async function resolveOrgIdForPayment(
  paymentId: string,
): Promise<string | null> {
  const row = await prisma.payment.findFirst({
    where: { id: paymentId },
    select: { organizationId: true },
  });
  return row?.organizationId ?? null;
}
