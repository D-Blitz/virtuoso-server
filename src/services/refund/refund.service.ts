import prisma from '../../prisma';
import { auditLog } from '../audit/audit.service';
import { StripeService } from '../stripe.service';

/**
 * Phase 1.1 (revised) — admin-initiated refunds.
 *
 * Refunds are now their own surface, decoupled from event
 * cancellation. They live on `/admin/payments` because:
 *
 *   1. A payment is the right semantic anchor for "money that
 *      should come back" — not an event.
 *   2. One payment can span multiple events (term enrollment) or
 *      none (manual cash recording — Phase 1.9). Bundling refund
 *      with cancel only made sense for the trivial trial-booking
 *      case.
 *   3. Only Stripe-backed payments are refundable through this
 *      service. Cash / cheque / virement refunds will go through
 *      a separate manual-recording flow once 1.9 lands.
 *
 * Permission: route-level `requirePermission('REFUND_ISSUE')`.
 *
 * Side-effect propagation: this service calls Stripe + writes the
 * audit log entry, but does NOT flip `Payment.status` to REFUNDED.
 * The Stripe webhook (`charge.refunded` → handleRefund) is the
 * source of truth for that state change; it also emits the
 * `payment.refunded` bus event. Avoids race conditions where the
 * admin call thinks the refund succeeded but the webhook hasn't
 * confirmed yet.
 */

export type IssueRefundInput = {
  paymentId: string;
  /** Cents. Omit for a full refund. */
  amountCents?: number;
  reason?: string;
};

export type IssueRefundResult = {
  paymentId: string;
  stripeRefundId: string;
  refundedAmountCents: number;
  /** Stripe's refund status: pending | succeeded | failed | canceled */
  status: string;
};

const stripeService = new StripeService();

export class RefundService {
  async issueRefund(input: IssueRefundInput): Promise<IssueRefundResult> {
    const payment = await prisma.payment.findFirst({
      where: { id: input.paymentId },
    });
    if (!payment) {
      const err = new Error('Paiement introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    if (payment.status !== 'SUCCEEDED') {
      const err = new Error(
        'Seuls les paiements en statut SUCCEEDED peuvent être remboursés.',
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const requestedCents = input.amountCents ?? payment.amountCents;
    if (requestedCents <= 0 || requestedCents > payment.amountCents) {
      const err = new Error(
        `Le montant à rembourser doit être compris entre 0 et ${(
          payment.amountCents / 100
        ).toFixed(2)} €.`,
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    let refund;
    try {
      refund = await stripeService.refundPaymentIntent({
        paymentIntentId: payment.stripePaymentIntentId,
        amountCents: requestedCents,
        reason: 'requested_by_customer',
      });
    } catch (err: any) {
      const stripeCode = err?.code ?? err?.raw?.code;
      if (stripeCode === 'charge_already_refunded') {
        const wrapped = new Error(
          'Ce paiement a déjà été (entièrement ou partiellement) remboursé sur Stripe.',
        ) as Error & { statusCode?: number };
        wrapped.statusCode = 400;
        throw wrapped;
      }
      throw err;
    }

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Payment',
      entityId: payment.id,
      before: { status: payment.status, amountCents: payment.amountCents },
      after: {
        refundQueued: true,
        stripeRefundId: refund.id,
        refundedAmountCents: refund.amountRefundedCents,
        reason: input.reason ?? null,
      },
    });

    return {
      paymentId: payment.id,
      stripeRefundId: refund.id,
      refundedAmountCents: refund.amountRefundedCents,
      status: refund.status,
    };
  }
}
