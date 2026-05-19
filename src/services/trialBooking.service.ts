import prisma from '../prisma';
import { StripeService } from './stripe.service';

/**
 * Orchestrates a "trial booking" submission:
 *  1. Resolve / upsert the Client (by email within the org).
 *  2. Verify the SlotHold is still valid and owned by this session.
 *  3. Create a PENDING_PAYMENT ScheduledEvent for the slot.
 *  4. Create a Stripe Customer + PaymentIntent.
 *  5. Persist a Payment (PENDING) + WidgetSubmission (PENDING).
 *  6. Consume the SlotHold (mark consumedAt).
 *  7. Return the Stripe client secret for the widget to confirm payment.
 *
 * Lifecycle then continues in the webhook handler:
 *  - payment_intent.succeeded → Payment SUCCEEDED, Event PAID_TRIAL,
 *    Submission CONFIRMED.
 *  - payment_intent.payment_failed / canceled → Payment FAILED,
 *    Submission REJECTED, ScheduledEvent CANCELED.
 */

const stripeService = new StripeService();

export type TrialBookingInput = {
  widgetId: string;
  holdId: string;
  sessionId: string;
  serviceId: string;
  facilitatorId: string;
  startTime: Date;
  endTime: Date;
  student: {
    firstname: string;
    lastname: string;
    email: string;
    phone?: string;
    address?: string;
    birthdate?: string; // ISO date
  };
  languages: string[];
  level: string;
  acceptedCgv: boolean;
  cgvVersion: string;
  marketingOptIn: boolean;
  ip?: string;
  userAgent?: string;
  organizationId: string;
};

export type TrialBookingOutput = {
  submissionId: string;
  paymentId: string;
  scheduledEventId: string;
  stripeClientSecret: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
};

export class TrialBookingService {
  async submit(input: TrialBookingInput): Promise<TrialBookingOutput> {
    if (!input.acceptedCgv) {
      throw new Error('CGV acceptance is required.');
    }

    // 1. Service + facilitator + widget sanity check
    const [service, facilitator, widget] = await Promise.all([
      prisma.service.findFirst({
        where: { id: input.serviceId },
        select: {
          id: true,
          defaultPrice: true,
          defaultDurationMinutes: true,
          serviceCategoryId: true,
          name: true,
        },
      }),
      prisma.facilitator.findFirst({
        where: { id: input.facilitatorId, isBookable: true },
        select: { id: true },
      }),
      prisma.bookingWidget.findFirst({
        where: { id: input.widgetId },
        select: { id: true, locationId: true },
      }),
    ]);

    if (!service) throw new Error('Service not found.');
    if (!facilitator) throw new Error('Facilitator not bookable.');
    if (!widget) throw new Error('Widget not found.');

    // 2. Verify the hold belongs to this session and is still alive
    const hold = await prisma.slotHold.findFirst({
      where: {
        id: input.holdId,
        sessionId: input.sessionId,
        facilitatorId: input.facilitatorId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!hold) {
      throw new Error('Slot hold expired or invalid. Please re-select your slot.');
    }
    if (
      hold.startTime.getTime() !== input.startTime.getTime() ||
      hold.endTime.getTime() !== input.endTime.getTime()
    ) {
      throw new Error('Hold times do not match the submitted slot.');
    }

    // 3. Resolve location for the ScheduledEvent.
    // Prefer the widget's locationId if set; else use any location the
    // facilitator is at; else any location in the org.
    let locationId = widget.locationId;
    if (!locationId) {
      const fLoc = await prisma.facilitator.findFirst({
        where: { id: input.facilitatorId },
        select: { locations: { select: { id: true }, take: 1 } },
      });
      locationId = fLoc?.locations[0]?.id ?? null;
    }
    if (!locationId) {
      throw new Error('No location available for this booking.');
    }

    // 4. Resolve a room at that location for the slot (pick first free).
    const rooms = await prisma.room.findMany({
      where: { locationId },
      select: { id: true },
    });
    if (rooms.length === 0) {
      throw new Error('No rooms available at this location.');
    }
    // For v1 just pick the first room. PR 6+ may add smarter room assignment.
    const roomId = rooms[0].id;

    // 5. Upsert Client by (orgId, email)
    const client = await prisma.client.findFirst({
      where: { email: input.student.email },
    });
    const clientRow = client
      ? await prisma.client.update({
          where: { id: client.id },
          data: {
            firstname: input.student.firstname,
            lastname: input.student.lastname,
            phone: input.student.phone ?? client.phone ?? '',
            address: input.student.address ?? client.address ?? '',
          },
        })
      : await prisma.client.create({
          data: {
            firstname: input.student.firstname,
            lastname: input.student.lastname,
            email: input.student.email,
            phone: input.student.phone ?? '',
            address: input.student.address ?? '',
            birthdate: input.student.birthdate
              ? new Date(input.student.birthdate)
              : new Date('1970-01-01'),
            organizationId: input.organizationId,
          },
        });

    // 6. Compute price in cents. Prices stored TTC; one-line conversion.
    const amountCents = Math.round(service.defaultPrice * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw new Error('Invalid service price.');
    }

    // 7. Create a PENDING_PAYMENT ScheduledEvent locking the slot. Until
    //    payment confirms, the event shows as PENDING_PAYMENT in admin views.
    const scheduledEvent = await prisma.scheduledEvent.create({
      data: {
        organizationId: input.organizationId,
        startTime: input.startTime,
        endTime: input.endTime,
        color: '#7c3aed',
        price: service.defaultPrice,
        notes: 'Trial booking via widget — awaiting payment confirmation.',
        status: 'PENDING_PAYMENT',
        roomId,
        locationId,
        serviceId: service.id,
        serviceCategoryId: service.serviceCategoryId,
        facilitators: { connect: [{ id: input.facilitatorId }] },
        clients: { connect: [{ id: clientRow.id }] },
      },
    });

    // 8. Create the WidgetSubmission (PENDING)
    const submission = await prisma.widgetSubmission.create({
      data: {
        organizationId: input.organizationId,
        widgetId: input.widgetId,
        payload: {
          serviceId: input.serviceId,
          facilitatorId: input.facilitatorId,
          startTime: input.startTime.toISOString(),
          endTime: input.endTime.toISOString(),
          student: input.student,
          languages: input.languages,
          level: input.level,
          marketingOptIn: input.marketingOptIn,
        } as object,
        status: 'PENDING',
        ip: input.ip,
        userAgent: input.userAgent,
        acceptedCgvAt: input.acceptedCgv ? new Date() : null,
        cgvVersion: input.cgvVersion,
        resultingScheduledEventId: scheduledEvent.id,
      },
    });

    // 9. Create Stripe Customer + PaymentIntent
    const customerId = await stripeService.getOrCreateCustomer({
      email: input.student.email,
      name: `${input.student.firstname} ${input.student.lastname}`.trim(),
      phone: input.student.phone,
    });

    // Create the Payment row first so we have a paymentId to thread through
    // the PI metadata for webhook routing. The stripePaymentIntentId field is
    // filled in immediately after the Stripe call.
    const paymentDraft = await prisma.payment.create({
      data: {
        organizationId: input.organizationId,
        clientId: clientRow.id,
        amountCents,
        currency: 'EUR',
        stripePaymentIntentId: `pending-${submission.id}`, // overwritten below
        stripeCustomerId: customerId,
        status: 'PENDING',
        purpose: 'TRIAL_LESSON',
        relatedScheduledEventId: scheduledEvent.id,
      },
    });

    const paymentIntent = await stripeService.createPaymentIntent({
      amountCents,
      currency: 'EUR',
      customerId,
      metadata: {
        organizationId: input.organizationId,
        widgetId: input.widgetId,
        widgetSubmissionId: submission.id,
        scheduledEventId: scheduledEvent.id,
        paymentId: paymentDraft.id,
        purpose: 'TRIAL_LESSON',
      },
      idempotencyKey: `submission-${submission.id}`,
    });

    await prisma.payment.update({
      where: { id: paymentDraft.id },
      data: { stripePaymentIntentId: paymentIntent.id },
    });

    // 10. Consume the SlotHold (no one else can race onto this slot now).
    await prisma.slotHold.update({
      where: { id: hold.id },
      data: { consumedAt: new Date() },
    });

    return {
      submissionId: submission.id,
      paymentId: paymentDraft.id,
      scheduledEventId: scheduledEvent.id,
      stripeClientSecret: paymentIntent.client_secret!,
      paymentIntentId: paymentIntent.id,
      amountCents,
      currency: 'EUR',
    };
  }

  /**
   * Public read for the confirmation screen. Returns the current status of
   * the submission + its event + payment so the widget can poll/render.
   */
  async getStatus(submissionId: string) {
    const submission = await prisma.widgetSubmission.findFirst({
      where: { id: submissionId },
      include: {
        resultingScheduledEvent: {
          select: {
            id: true,
            startTime: true,
            endTime: true,
            status: true,
            facilitators: {
              select: { id: true, firstname: true, lastname: true },
            },
            location: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!submission) return null;

    let payment = null;
    if (submission.resultingScheduledEvent) {
      payment = await prisma.payment.findFirst({
        where: { relatedScheduledEventId: submission.resultingScheduledEvent.id },
        select: { status: true, amountCents: true, currency: true },
      });
    }

    return {
      submissionId: submission.id,
      status: submission.status,
      scheduledEvent: submission.resultingScheduledEvent,
      payment,
    };
  }
}
