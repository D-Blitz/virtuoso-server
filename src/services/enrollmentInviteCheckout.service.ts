import prisma from '../prisma';
import { StripeService } from './stripe.service';
import { EnrollmentQuoteService } from './enrollment/enrollmentQuote.service';
import { EnrollmentEventGeneratorService } from './enrollment/enrollmentGenerator.service';

/**
 * Handles the post-trial "second form" flow:
 *  1. GET → load invite + compute trimester quote (with trial credit)
 *  2. POST checkout → create Stripe PaymentIntent for the balance
 *  3. Webhook (called from webhook.service) → activate Enrollment +
 *     materialize weekly events when payment succeeds
 */

const stripeService = new StripeService();
const quoteService = new EnrollmentQuoteService();
const eventGenerator = new EnrollmentEventGeneratorService();

export type InviteSummary = {
  invite: {
    id: string;
    status: string;
    expiresAt: string;
    createdAt: string;
    expired: boolean;
    consumed: boolean;
    rescheduled: boolean;
    overrideWeekday: number | null;
    overrideStartTime: string | null;
  };
  client: {
    id: string;
    firstname: string;
    lastname: string;
    email: string;
  };
  trial: {
    scheduledEventId: string;
    startTime: string;
    endTime: string;
    service: {
      id: string;
      name: string;
      defaultDurationMinutes: number;
      defaultPrice: number;
      bookingMode: string;
    };
    facilitator: {
      id: string;
      firstname: string;
      lastname: string;
      bio: string | null;
      profilePictureUrl: string | null;
    } | null;
    location: { id: string; name: string };
    trialPaidCents: number;
    trialPaidCurrency: string;
  };
  quote: {
    term: { id: string; name: string; startDate: string; endDate: string };
    totalCents: number;       // prorated full term cost
    trialCreditCents: number;
    balanceCents: number;     // what we'll actually charge
    currency: string;
    lessons: { totalInTerm: number; remaining: number };
    preview: {
      firstLesson: string | null;
      lastLesson: string | null;
      occurrences: { startTime: string; endTime: string }[];
    };
  } | null;
  /** Filled when quote is null (no active term, etc.) */
  quoteError?: string;
};

export class EnrollmentInviteCheckoutService {
  /**
   * Public read by token — used to render the second-form page.
   * Never reveals tokens of other invites, only the one matching the token.
   */
  async getByToken(token: string): Promise<InviteSummary | null> {
    const invite = await prisma.enrollmentInvite.findFirst({
      where: { token },
      include: {
        client: {
          select: { id: true, firstname: true, lastname: true, email: true },
        },
        scheduledEvent: {
          include: {
            service: {
              select: {
                id: true,
                name: true,
                defaultDurationMinutes: true,
                defaultPrice: true,
                bookingMode: true,
                serviceCategoryId: true,
              },
            },
            facilitators: {
              take: 1,
              select: {
                id: true,
                firstname: true,
                lastname: true,
                bio: true,
                profilePictureUrl: true,
              },
            },
            location: { select: { id: true, name: true } },
            payments: {
              where: { status: 'SUCCEEDED', purpose: 'TRIAL_LESSON' },
              take: 1,
              select: { amountCents: true, currency: true },
            },
          },
        },
      },
    });

    if (!invite) return null;

    const now = new Date();
    const expired = invite.status === 'EXPIRED' || invite.expiresAt < now;
    const consumed = invite.status === 'CONSUMED';

    const event = invite.scheduledEvent;
    const facilitator = event.facilitators[0] ?? null;
    const trialPayment = event.payments[0];

    const base: Omit<InviteSummary, 'quote' | 'quoteError'> = {
      invite: {
        id: invite.id,
        status: invite.status,
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
        expired,
        consumed,
        rescheduled: !!invite.rescheduledAt,
        overrideWeekday: invite.overrideWeekday,
        overrideStartTime: invite.overrideStartTime,
      },
      client: invite.client,
      trial: {
        scheduledEventId: event.id,
        startTime: event.startTime.toISOString(),
        endTime: event.endTime.toISOString(),
        service: {
          id: event.service.id,
          name: event.service.name,
          defaultDurationMinutes: event.service.defaultDurationMinutes,
          defaultPrice: event.service.defaultPrice,
          bookingMode: event.service.bookingMode,
        },
        facilitator,
        location: event.location,
        trialPaidCents: trialPayment?.amountCents ?? 0,
        trialPaidCurrency: trialPayment?.currency ?? 'EUR',
      },
    };

    // Don't bother quoting if the invite is dead.
    if (expired || consumed) {
      return { ...base, quote: null };
    }

    // Resolve the active term for this location.
    const term = await prisma.term.findFirst({
      where: {
        OR: [{ locationId: event.locationId }, { locationId: null }],
        startDate: { lte: now },
        endDate: { gte: now },
      },
      orderBy: { startDate: 'desc' },
    });

    if (!term) {
      return {
        ...base,
        quote: null,
        quoteError:
          "Aucun trimestre actif n'est configuré pour cet établissement.",
      };
    }

    // Recurring slot — use invite override if the student picked a new
    // weekday/time on the second form; otherwise derive from the trial.
    const weekday =
      invite.overrideWeekday !== null
        ? invite.overrideWeekday
        : event.startTime.getDay();
    const startTime =
      invite.overrideStartTime ?? event.startTime.toTimeString().slice(0, 5);
    const durationMinutes = event.service.defaultDurationMinutes;

    // Start from the day after the trial so we don't double-book the trial slot.
    const enrollmentStart = new Date(event.endTime);
    enrollmentStart.setDate(enrollmentStart.getDate() + 1);

    const quoteResult = quoteService.quote({
      service: {
        id: event.service.id,
        name: event.service.name,
        defaultPrice: event.service.defaultPrice,
        defaultDurationMinutes: durationMinutes,
      },
      term: {
        id: term.id,
        name: term.name,
        startDate: term.startDate,
        endDate: term.endDate,
      },
      startDate: enrollmentStart,
      weekday,
      startTime,
      durationMinutes,
    });

    // Pricing model for invite checkout (per the school's business rule):
    // the student pays for the remaining lessons of the term in one shot —
    // pricePerSession × remainingLessons. Trial credit is then deducted.
    const totalCents = Math.round(
      event.service.defaultPrice * quoteResult.lessons.remaining * 100,
    );
    const trialCreditCents = trialPayment?.amountCents ?? 0;
    const balanceCents = Math.max(0, totalCents - trialCreditCents);

    return {
      ...base,
      quote: {
        term: {
          id: term.id,
          name: term.name,
          startDate: term.startDate.toISOString(),
          endDate: term.endDate.toISOString(),
        },
        totalCents,
        trialCreditCents,
        balanceCents,
        currency: trialPayment?.currency ?? 'EUR',
        lessons: quoteResult.lessons,
        preview: {
          firstLesson:
            quoteResult.preview.firstLesson?.toISOString() ?? null,
          lastLesson:
            quoteResult.preview.lastLesson?.toISOString() ?? null,
          occurrences: quoteResult.preview.occurrences.map((o) => ({
            startTime: o.startTime.toISOString(),
            endTime: o.endTime.toISOString(),
          })),
        },
      },
    };
  }

  /**
   * Create a PaymentIntent for the trimester balance. Returns the Stripe
   * client secret so the second-form page can render Stripe Elements.
   */
  async createCheckout(token: string): Promise<{
    paymentId: string;
    stripeClientSecret: string;
    paymentIntentId: string;
    amountCents: number;
    currency: string;
  }> {
    const summary = await this.getByToken(token);
    if (!summary) throw new Error('Invite not found');
    if (summary.invite.expired) throw new Error('Invite has expired');
    if (summary.invite.consumed) throw new Error('Invite already used');
    if (!summary.quote) {
      throw new Error(summary.quoteError ?? 'No active term');
    }
    if (summary.quote.balanceCents <= 0) {
      throw new Error('Nothing to charge — balance is zero');
    }

    // Look up the invite again to get organizationId + relation ids
    const invite = await prisma.enrollmentInvite.findFirst({
      where: { token },
      select: {
        id: true,
        organizationId: true,
        clientId: true,
        scheduledEventId: true,
      },
    });
    if (!invite) throw new Error('Invite not found');

    const customerId = await stripeService.getOrCreateCustomer({
      email: summary.client.email,
      name: `${summary.client.firstname} ${summary.client.lastname}`.trim(),
    });

    // Pre-create the Payment row so we can put paymentId in the PI metadata
    const paymentDraft = await prisma.payment.create({
      data: {
        organizationId: invite.organizationId,
        clientId: invite.clientId,
        amountCents: summary.quote.balanceCents,
        currency: summary.quote.currency,
        stripePaymentIntentId: `pending-invite-${invite.id}-${Date.now()}`,
        stripeCustomerId: customerId,
        status: 'PENDING',
        purpose: 'ENROLLMENT_BALANCE',
        relatedScheduledEventId: invite.scheduledEventId,
      },
    });

    const paymentIntent = await stripeService.createPaymentIntent({
      amountCents: summary.quote.balanceCents,
      currency: summary.quote.currency,
      customerId,
      metadata: {
        organizationId: invite.organizationId,
        widgetId: '',
        widgetSubmissionId: '',
        scheduledEventId: invite.scheduledEventId,
        paymentId: paymentDraft.id,
        purpose: 'ENROLLMENT_BALANCE',
        // Custom field outside the standard PaymentIntentMetadata type
        // so the webhook can find the invite for activation.
        enrollmentInviteId: invite.id,
      } as any,
      // Use a per-checkout idempotency key to allow re-checkout if user retries.
      idempotencyKey: `invite-checkout-${invite.id}-${Date.now()}`,
    });

    await prisma.payment.update({
      where: { id: paymentDraft.id },
      data: { stripePaymentIntentId: paymentIntent.id },
    });

    return {
      paymentId: paymentDraft.id,
      stripeClientSecret: paymentIntent.client_secret!,
      paymentIntentId: paymentIntent.id,
      amountCents: summary.quote.balanceCents,
      currency: summary.quote.currency,
    };
  }

  /**
   * Called from the webhook when payment_intent.succeeded fires for an
   * ENROLLMENT_BALANCE payment. Idempotent — checks if already activated.
   */
  async activateFromPayment(args: {
    paymentId: string;
    enrollmentInviteId: string;
  }): Promise<{ enrollmentId: string; eventsGenerated: number } | null> {
    const invite = await prisma.enrollmentInvite.findFirst({
      where: { id: args.enrollmentInviteId },
      include: {
        scheduledEvent: {
          include: {
            service: {
              select: { id: true, serviceCategoryId: true, defaultDurationMinutes: true },
            },
            facilitators: { take: 1, select: { id: true } },
          },
        },
      },
    });
    if (!invite) {
      console.warn(`[activate] invite ${args.enrollmentInviteId} not found`);
      return null;
    }

    if (invite.status === 'CONSUMED') {
      // Already activated — webhook replay, fine.
      return null;
    }

    const event = invite.scheduledEvent;
    const facilitator = event.facilitators[0];

    // Resolve the term again (may have changed since GET).
    const now = new Date();
    const term = await prisma.term.findFirst({
      where: {
        OR: [{ locationId: event.locationId }, { locationId: null }],
        startDate: { lte: now },
        endDate: { gte: now },
      },
      orderBy: { startDate: 'desc' },
    });
    if (!term) {
      throw new Error(
        `[activate] no active term for invite ${invite.id}; manual intervention needed`,
      );
    }

    // Honor the per-invite override if the student picked a new recurring
    // slot on the second form. Otherwise fall back to the trial's weekday/time.
    const weekday =
      invite.overrideWeekday !== null
        ? invite.overrideWeekday
        : event.startTime.getDay();
    const startTimeStr =
      invite.overrideStartTime ?? event.startTime.toTimeString().slice(0, 5);
    const durationMinutes = event.service.defaultDurationMinutes;

    const enrollmentStart = new Date(event.endTime);
    enrollmentStart.setDate(enrollmentStart.getDate() + 1);

    const enrollmentEnd = term.endDate;

    // Pricing snapshot at activation time.
    const payment = await prisma.payment.findFirst({
      where: { id: args.paymentId },
      select: { amountCents: true, currency: true },
    });
    if (!payment) throw new Error(`[activate] payment ${args.paymentId} missing`);

    // Build the Enrollment + flip event status + mark invite + generate events
    // as a single transaction to keep the world consistent.
    const result = await prisma.$transaction(async (tx) => {
      const enrollment = await tx.enrollment.create({
        data: {
          organizationId: invite.organizationId,
          serviceId: event.service.id,
          clientId: invite.clientId,
          locationId: event.locationId,
          facilitatorId: facilitator?.id ?? null,
          roomId: event.roomId,
          termId: term.id,
          weekday,
          startTime: startTimeStr,
          durationMinutes,
          startDate: enrollmentStart,
          endDate: enrollmentEnd,
          priceCharged: payment.amountCents / 100,
          pricingStrategy: 'TERM_PRORATED_BY_LESSONS',
          status: 'ACTIVE',
        },
      });

      await tx.enrollmentInvite.update({
        where: { id: invite.id },
        data: { status: 'CONSUMED', consumedAt: new Date() },
      });

      await tx.scheduledEvent.update({
        where: { id: event.id },
        data: { status: 'CONVERTED_TO_ENROLLMENT', enrollmentId: enrollment.id },
      });

      await tx.payment.update({
        where: { id: args.paymentId },
        data: { relatedEnrollmentId: enrollment.id },
      });

      // Materialize the weekly events for the term window
      const newEvents = eventGenerator.generate({
        enrollment: {
          id: enrollment.id,
          weekday,
          startTime: startTimeStr,
          durationMinutes,
          startDate: enrollmentStart,
          endDate: enrollmentEnd,
          serviceId: event.service.id,
          serviceCategoryId: event.service.serviceCategoryId,
          locationId: event.locationId,
          roomId: event.roomId,
          facilitatorId: facilitator?.id ?? null,
          color: event.color,
        },
      });

      // If the student rescheduled the recurring slot on the second form, stamp
      // each materialized event so admins see the audit trail on the calendar.
      const enrollmentNote = invite.rescheduledAt
        ? `Créneau choisi par le client lors de l'inscription (différent du cours d'essai du ${event.startTime.toLocaleString(
            'fr-FR',
            {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            },
          )})`
        : null;

      if (newEvents.length > 0) {
        // Bulk-create using createMany doesn't support nested connects, so
        // we map to a relations-friendly shape and create one at a time.
        for (const ev of newEvents) {
          await tx.scheduledEvent.create({
            data: {
              organizationId: invite.organizationId,
              startTime: ev.startTime,
              endTime: ev.endTime,
              color: ev.color,
              price: ev.price,
              status: 'SCHEDULED',
              notes: enrollmentNote,
              roomId: ev.roomId ?? event.roomId,
              locationId: ev.locationId,
              serviceId: ev.serviceId,
              serviceCategoryId: ev.serviceCategoryId,
              enrollmentId: enrollment.id,
              facilitators: facilitator
                ? { connect: [{ id: facilitator.id }] }
                : undefined,
              clients: {
                connect: [{ id: invite.clientId }],
              },
            },
          });
        }
      }

      return { enrollmentId: enrollment.id, eventsGenerated: newEvents.length };
    });

    return result;
  }
}
