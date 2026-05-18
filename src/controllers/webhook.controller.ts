import { Request, Response } from 'express';
import { StripeService } from '../services/stripe.service';
import { WebhookService } from '../services/webhook.service';

const stripeService = new StripeService();
const webhookService = new WebhookService();

export class WebhookController {
  /**
   * Stripe webhook entrypoint. Express must mount `express.raw({ type: '*' })`
   * (or 'application/json') for this route BEFORE `express.json()`, so the
   * signature can be verified against the unparsed body.
   */
  async stripe(req: Request, res: Response) {
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      res.status(400).json({ error: 'Missing Stripe-Signature header' });
      return;
    }

    let event;
    try {
      event = stripeService.verifyWebhookSignature({
        rawBody: req.body as Buffer,
        signature,
      });
    } catch (err) {
      console.error('[webhook] signature verification failed:', err);
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }

    try {
      const result = await webhookService.handle(event);
      res.json(result);
    } catch (err) {
      console.error('[webhook] handler error:', err);
      // Returning 5xx makes Stripe retry — fine, we're idempotent.
      res.status(500).json({ error: 'Handler error' });
    }
  }
}
