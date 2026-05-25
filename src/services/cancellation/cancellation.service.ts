import prisma from '../../prisma';
import { getContext } from '../../auth/context';
import { auditLog } from '../audit/audit.service';
import { snapshotScheduledEvent } from '../audit/snapshots';
import * as bus from '../events/bus';

/**
 * Phase 1.1 — admin-initiated event cancellation.
 *
 * Cancels a single ScheduledEvent. Does NOT touch payments — refunds
 * are a separate concern on the payments surface (RefundService +
 * /admin/payments). The previous version of this service handled
 * refunds inline; that conflated two different semantic objects
 * (the event = scheduled time/place/people; the payment = money
 * that moved) and broke down for non-Stripe payments, multi-event
 * enrollment payments, manually-recorded events, etc.
 *
 * Permission: route-level `requirePermission('EVENT_CANCEL')` plus
 * `requireEventManage()` so a scoped user can still only cancel
 * events they can otherwise manage.
 */

export type CancelEventInput = {
  eventId: string;
  reason: string | null;
};

export type CancelEventResult = {
  scheduledEventId: string;
};

export class CancellationService {
  async cancelEvent(input: CancelEventInput): Promise<CancelEventResult> {
    const ctx = getContext();
    if (!ctx) throw new Error('No request context');

    const before = await prisma.scheduledEvent.findFirst({
      where: { id: input.eventId },
    });
    if (!before) {
      const err = new Error('Réservation introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    if (before.status === 'CANCELED') {
      const err = new Error('Cette réservation est déjà annulée.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }

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
    });

    return { scheduledEventId: input.eventId };
  }
}
