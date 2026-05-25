import prisma from '../../prisma';
import { getContext } from '../../auth/context';
import { auditLog } from '../audit/audit.service';
import { snapshotScheduledEvent } from '../audit/snapshots';
import { StripeService } from '../stripe.service';
import * as bus from '../events/bus';

/**
 * Phase 1.1 — admin-initiated cancellation + optional refund.
 *
 * Cancels a single ScheduledEvent. If a refund is requested,
 * forwards to Stripe; the webhook handler later updates Payment.status
 * and emits `payment.refunded` when the refund settles. This service
 * itself does NOT mark the Payment row as REFUNDED — it only kicks
 * off the Stripe call. The webhook is the source of truth for
 * payment status.
 *
 * Permission contract:
 *   - cancel without refund   → requires the route's existing
 *     EVENT_MANAGE (ALL or SCOPED) gate.
 *   - cancel WITH refund      → additionally requires REFUND_ISSUE.
 *     Service-level check so an admin with EVENT_MANAGE but no
 *     REFUND_ISSUE can still cancel for free.
 */

export type RefundMode = 'NONE' | 'FULL' | 'PARTIAL';

export type CancelEventInput = {
  eventId: string;
  reason: string | null;
  refundMode: RefundMode;
  /** EUR, required when refundMode === 'PARTIAL'. */
  refundAmount?: number;
};

export type CancelEventResult = {
  scheduledEventId: string;
  refundIssued: boolean;
  refundedAmount: number;
  stripeRefundId: string | null;
};

const stripeService = new StripeService();

export class CancellationService {
  async cancelEvent(input: CancelEventInput): Promise<CancelEventResult> {
    const ctx = getContext();
    if (!ctx) throw new Error('No request context');

    // Permission: REFUND_ISSUE required for any refund.
    if (input.refundMode !== 'NONE' && !ctx.permissions.has('REFUND_ISSUE')) {
      const err = new Error(
        "Vous n'avez pas la permission d'émettre un remboursement (REFUND_ISSUE).",
      ) as Error & { statusCode?: number };
      err.statusCode = 403;
      throw err;
    }

    // Load event + the successful payment (if any). Cancellation
    // is allowed regardless of whether a payment exists; refund
    // path requires one.
    const event = await prisma.scheduledEvent.findFirst({
      where: { id: input.eventId },
      include: {
        payments: {
          where: { status: 'SUCCEEDED' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!event) {
      const err = new Error('Événement introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    if (event.status === 'CANCELED') {
      const err = new Error('Cet événement est déjà annulé.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }

    // Refund processing — done BEFORE the cancellation write so a
    // Stripe failure doesn't leave the event canceled-with-unrefunded.
    let stripeRefundId: string | null = null;
    let refundedAmount = 0;

    if (input.refundMode !== 'NONE') {
      const payment = event.payments[0];
      if (!payment) {
        const err = new Error(
          "Aucun paiement réussi n'est associé à cet événement.",
        ) as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
      const paidAmount = payment.amountCents / 100;
      const amountToRefund =
        input.refundMode === 'FULL'
          ? paidAmount
          : Math.min(input.refundAmount ?? 0, paidAmount);
      if (amountToRefund <= 0) {
        const err = new Error(
          'Le montant à rembourser doit être supérieur à 0.',
        ) as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }

      try {
        const refund = await stripeService.refundPaymentIntent({
          paymentIntentId: payment.stripePaymentIntentId,
          amountCents: Math.round(amountToRefund * 100),
          reason: 'requested_by_customer',
        });
        stripeRefundId = refund.id;
        refundedAmount = refund.amountRefundedCents / 100;
      } catch (err: any) {
        // Stripe error codes: charge_already_refunded means the PI
        // was already (partially) refunded for the requested amount.
        // Surface a friendly 400 instead of a generic 500.
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
    }

    // Update event row (atomic with the audit + emit below — same tick).
    const before = event;
    const updated = await prisma.scheduledEvent.update({
      where: { id: input.eventId },
      data: {
        status: 'CANCELED',
        canceledAt: new Date(),
        cancellationReason: input.reason?.trim() || null,
        canceledById: ctx.userId,
      },
    });

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'ScheduledEvent',
      entityId: input.eventId,
      before: snapshotScheduledEvent(before),
      after: snapshotScheduledEvent(updated),
    });

    bus.emit('event.cancelled', {
      scheduledEventId: input.eventId,
      reason: input.reason?.trim() || null,
      cancelledByUserId: ctx.userId,
      refundIssued: refundedAmount > 0,
      refundedAmount,
    });

    return {
      scheduledEventId: input.eventId,
      refundIssued: refundedAmount > 0,
      refundedAmount,
      stripeRefundId,
    };
  }
}
