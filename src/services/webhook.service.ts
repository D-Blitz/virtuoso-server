import prisma from '../prisma';
import type { StripeEvent } from './stripe.service';
import { EnrollmentInviteCheckoutService } from './enrollmentInviteCheckout.service';

/**
 * Webhook handler. Runs OUTSIDE any request org context — receives global
 * Stripe events and routes them based on PaymentIntent metadata.
 *
 * Idempotent: every event is stamped in StripeEvent on receipt; replay just
 * returns OK without reapplying state.
 */

const enrollmentCheckout = new EnrollmentInviteCheckoutService();

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
      await prisma.scheduledEvent.update({
        where: { id: scheduledEventId },
        data: { status: 'PAID_TRIAL' },
      });
    }

    if (submissionId) {
      await prisma.widgetSubmission.update({
        where: { id: submissionId },
        data: { status: 'CONFIRMED' },
      });
    }
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
      await prisma.scheduledEvent.update({
        where: { id: scheduledEventId },
        data: { status: 'CANCELED' },
      });
    }
    if (submissionId) {
      await prisma.widgetSubmission.update({
        where: { id: submissionId },
        data: { status: 'REJECTED' },
      });
    }
  }

  private async handleRefund(charge: any): Promise<void> {
    const paymentIntentId =
      typeof charge?.payment_intent === 'string'
        ? charge.payment_intent
        : charge?.payment_intent?.id;
    if (!paymentIntentId) return;

    await prisma.payment.updateMany({
      where: { stripePaymentIntentId: paymentIntentId },
      data: { status: 'REFUNDED' },
    });
  }
}
