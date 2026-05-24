import { EmailService } from '../email.service';

/**
 * Phase 1.2 — NotificationDispatcher.
 *
 * Thin abstraction over the actual delivery channels (email today,
 * SMS in Phase 6.12). The cron and the per-event trigger logic call
 * this dispatcher; they don't know about Resend, Twilio, or whatever
 * future channel lands. The dispatcher routes by the recipient's
 * preferred channel and a per-template registry.
 *
 * Cheap to add now, expensive to retrofit later — once a dozen
 * services scatter `emailService.sendX()` calls, plugging in SMS
 * means rewriting every one of them.
 *
 * Design notes:
 *   - Templates are TYPED variant objects, not free-string keys, so
 *     the compiler catches missing vars per kind.
 *   - Recipients are intentionally NOT a User reference — flow inputs
 *     come from many sources (Client.email, Facilitator.email, an
 *     ad-hoc invite address). The dispatcher just needs the address +
 *     channel preference.
 *   - Idempotency is the caller's responsibility (a cron stamps a
 *     timestamp on the row before/after sending); the dispatcher itself
 *     is fire-on-call.
 */

export type Channel = 'EMAIL' | 'SMS';

export type Recipient = {
  email?: string | null;
  phone?: string | null;
  preferredChannel?: Channel;
};

export type TrialReminderVars = {
  studentFirstname: string;
  serviceName: string;
  facilitatorName: string;
  trialDateLabel: string;
  locationName: string;
  /** Reschedule link only included in the 48h reminder (past cutoff at 24h). */
  rescheduleUrl?: string;
};

/**
 * Tagged union of every template the dispatcher knows about. Adding
 * a new template kind = adding a case in `sendViaEmail` (and any
 * future channel-specific senders). Compiler enforces exhaustiveness.
 */
export type NotificationTemplate =
  | { kind: 'trial-reminder-48h'; vars: TrialReminderVars }
  | { kind: 'trial-reminder-24h'; vars: TrialReminderVars };

const emailService = new EmailService();

function resolveChannel(recipient: Recipient): Channel {
  return recipient.preferredChannel ?? 'EMAIL';
}

/**
 * Send a templated notification through the recipient's preferred
 * channel. Throws on:
 *   - Missing address for the chosen channel (no email when channel = EMAIL)
 *   - Channel not implemented yet (SMS in v1)
 *   - Underlying delivery error (re-thrown so the caller can decide
 *     to swallow + log, or fail loudly)
 */
export async function dispatch(
  template: NotificationTemplate,
  recipient: Recipient,
): Promise<{ channel: Channel }> {
  const channel = resolveChannel(recipient);

  if (channel === 'EMAIL') {
    if (!recipient.email) {
      throw new Error('Recipient has no email address');
    }
    await sendViaEmail(template, recipient.email);
    return { channel: 'EMAIL' };
  }

  // SMS adapter lands with Phase 6.12 (TwilioAdapter).
  throw new Error(`Channel ${channel} not implemented`);
}

async function sendViaEmail(
  template: NotificationTemplate,
  to: string,
): Promise<void> {
  switch (template.kind) {
    case 'trial-reminder-48h':
      await emailService.sendTrialReminder({
        to,
        hoursBefore: 48,
        ...template.vars,
      });
      return;
    case 'trial-reminder-24h':
      await emailService.sendTrialReminder({
        to,
        hoursBefore: 24,
        // 24h reminder is past the reschedule cutoff (token validity
        // requires ≥48h), so the link doesn't apply even if vars carries it.
        ...template.vars,
        rescheduleUrl: undefined,
      });
      return;
  }
}
