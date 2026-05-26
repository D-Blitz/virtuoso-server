// SEND_EMAIL action handler (Phase 2.2).
//
// Config shape (WidgetAction.config Json):
//   {
//     "to":       "<email | {vars.email}>",
//     "subject":  "<string with {var} placeholders>",
//     "bodyHtml": "<html string with {var} placeholders>",
//     "bodyText": "<optional plaintext fallback>"
//   }
//
// All four fields support {path} interpolation. `to` is the most
// common interpolation target — admin sets it to `{vars.email}` to
// route the email to the value the visitor typed in step 2 of a
// BOOKING flow.

import { EmailService } from '../../email.service';
import { interpolate } from './interpolate';
import type { ActionHandler, ActionResult } from './types';

type SendEmailConfig = {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
};

const emailService = new EmailService();

// Basic email shape — same loose regex used elsewhere in the codebase.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const sendEmailHandler: ActionHandler = {
  kind: 'SEND_EMAIL',

  validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return 'SEND_EMAIL config must be an object';
    }
    const c = config as Record<string, unknown>;
    if (typeof c.to !== 'string' || c.to.length === 0) {
      return 'SEND_EMAIL config.to is required (use {vars.X} for visitor email)';
    }
    if (typeof c.subject !== 'string' || c.subject.length === 0) {
      return 'SEND_EMAIL config.subject is required';
    }
    if (typeof c.bodyHtml !== 'string' || c.bodyHtml.length === 0) {
      return 'SEND_EMAIL config.bodyHtml is required';
    }
    if (c.bodyText !== undefined && typeof c.bodyText !== 'string') {
      return 'SEND_EMAIL config.bodyText must be a string when set';
    }
    return null;
  },

  async execute(action, context): Promise<ActionResult> {
    const cfg = action.config as unknown as SendEmailConfig;

    const to = interpolate(cfg.to, context.evaluationContext);
    const subject = interpolate(cfg.subject, context.evaluationContext);
    const bodyHtml = interpolate(cfg.bodyHtml, context.evaluationContext);
    const bodyText = cfg.bodyText
      ? interpolate(cfg.bodyText, context.evaluationContext)
      : undefined;

    // Post-interpolation validation: the address can only be checked
    // after vars are substituted. Refuse rather than send a broken
    // message to nobody-in-particular.
    if (!EMAIL_RE.test(to)) {
      return {
        status: 'ERROR',
        message: `Invalid recipient address after interpolation: "${to.slice(0, 80)}"`,
      };
    }

    await emailService.sendCustomEmail({ to, subject, bodyHtml, bodyText });
    return { status: 'OK' };
  },
};
