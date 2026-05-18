import Stripe from 'stripe';

/**
 * Thin wrapper around the Stripe SDK. All other services should go through
 * this module — keeps the SDK import path and config in one place.
 *
 * NOTE: we deliberately type Stripe-returned shapes as `any` here. The SDK
 * exposes nested types via `Stripe.PaymentIntent` etc., but the access
 * pattern is inconsistent across SDK major versions and TS strictness modes.
 * Since these types don't leak into our public API (TrialBookingService
 * returns plain primitives), the loss of internal typing is acceptable.
 */

let stripeClient: InstanceType<typeof Stripe> | null = null;

export function getStripe(): InstanceType<typeof Stripe> {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY env var is required (use a test key in dev).',
    );
  }
  stripeClient = new Stripe(key);
  return stripeClient;
}

export function getWebhookSecret(): string {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s) {
    throw new Error('STRIPE_WEBHOOK_SECRET env var is required for webhooks.');
  }
  return s;
}

export type PaymentIntentMetadata = {
  organizationId: string;
  widgetId: string;
  widgetSubmissionId: string;
  scheduledEventId: string;
  paymentId: string;
  purpose: string;
};

export class StripeService {
  /**
   * Idempotent customer lookup-or-create by email. Stripe doesn't expose a
   * native upsert, so we list-by-email and create if missing.
   */
  async getOrCreateCustomer(args: {
    email: string;
    name: string;
    phone?: string;
  }): Promise<string> {
    const stripe = getStripe();
    const existing = await stripe.customers.list({ email: args.email, limit: 1 });
    if (existing.data.length > 0) {
      return existing.data[0].id;
    }
    const created = await stripe.customers.create({
      email: args.email,
      name: args.name,
      phone: args.phone,
    });
    return created.id;
  }

  /**
   * Create a PaymentIntent. `idempotencyKey` should be the WidgetSubmission id
   * so retrying the trial-booking POST doesn't create duplicate PIs.
   *
   * Returns the raw Stripe PaymentIntent (loose type) — callers access
   * `.id` and `.client_secret`.
   */
  async createPaymentIntent(args: {
    amountCents: number;
    currency: string;
    customerId: string;
    metadata: PaymentIntentMetadata;
    idempotencyKey: string;
  }): Promise<{ id: string; client_secret: string | null }> {
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.create(
      {
        amount: args.amountCents,
        currency: args.currency.toLowerCase(),
        customer: args.customerId,
        metadata: args.metadata as unknown as Record<string, string>,
        automatic_payment_methods: { enabled: true },
        description: `${args.metadata.purpose} for submission ${args.metadata.widgetSubmissionId}`,
      },
      { idempotencyKey: args.idempotencyKey },
    );
    return { id: pi.id, client_secret: pi.client_secret };
  }

  /**
   * Verify the webhook signature and parse the event. Throws if invalid.
   * `rawBody` MUST be the unparsed request body (Buffer).
   */
  verifyWebhookSignature(args: {
    rawBody: Buffer | string;
    signature: string;
  }): StripeEvent {
    const stripe = getStripe();
    return stripe.webhooks.constructEvent(
      args.rawBody,
      args.signature,
      getWebhookSecret(),
    ) as StripeEvent;
  }
}

/**
 * Loose typing of the parts of a Stripe Event we actually inspect. Avoids
 * fighting the SDK's nested type exports while still keeping the handler
 * code typed.
 */
export type StripeEvent = {
  id: string;
  type: string;
  data: { object: any };
};
