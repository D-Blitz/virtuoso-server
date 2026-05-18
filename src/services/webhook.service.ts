import prisma from '../prisma';
import type { StripeEvent } from './stripe.service';

/**
 * Webhook handler. Runs OUTSIDE any request org context — receives global
 * Stripe events and routes them based on PaymentIntent metadata.
 *
 * Idempotent: every event is stamped in StripeEvent on receipt; replay just
 * returns OK without reapplying state.
 */
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

    if (!paymentId) {
      console.warn(
        '[webhook] payment_intent.succeeded with no paymentId in metadata',
        pi?.id,
      );
      return;
    }

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'SUCCEEDED' },
    });

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

    if (paymentId) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'FAILED' },
      });
    }
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
