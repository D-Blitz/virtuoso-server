/**
 * Email delivery wrapper around Resend.
 *
 * If `RESEND_API_KEY` is unset (dev convenience), emails are logged to
 * stdout instead of sent. This lets you develop the invite flow without
 * setting up an account.
 */
import { Resend } from 'resend';

let resendClient: Resend | null = null;
let initialized = false;

function getResend(): Resend | null {
  if (initialized) return resendClient;
  initialized = true;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(
      '[email] RESEND_API_KEY not set — emails will be logged to stdout instead of sent.',
    );
    return null;
  }
  resendClient = new Resend(key);
  return resendClient;
}

function defaultFrom(): string {
  return (
    process.env.EMAIL_FROM ?? 'Art & Cetera <onboarding@resend.dev>'
  );
}

export type EnrollmentInviteEmailParams = {
  to: string;
  studentFirstname: string;
  serviceName: string;
  facilitatorName: string;
  trialDateLabel: string; // e.g. "lundi 19 mai 14:00"
  inviteUrl: string;
  trialPaidAmount: string; // e.g. "30.00 €"
  expiresAtLabel: string;  // e.g. "31 mai 2026"
};

export class EmailService {
  async sendEnrollmentInvite(params: EnrollmentInviteEmailParams): Promise<void> {
    const subject = `Votre cours du ${params.trialDateLabel} — Inscription au trimestre`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
        <h1 style="margin:0 0 16px 0;font-size:22px">Bonjour ${escape(params.studentFirstname)},</h1>
        <p style="line-height:1.55;color:#333">
          Nous espérons que votre cours d&rsquo;essai
          <strong>${escape(params.serviceName)}</strong> avec
          <strong>${escape(params.facilitatorName)}</strong> s&rsquo;est bien passé.
        </p>
        <p style="line-height:1.55;color:#333">
          Vous pouvez maintenant vous inscrire au trimestre complet. Les
          <strong>${escape(params.trialPaidAmount)}</strong> que vous avez
          déjà réglés seront déduits du tarif total.
        </p>
        <p style="margin:32px 0">
          <a href="${params.inviteUrl}"
             style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">
            S&rsquo;inscrire au trimestre
          </a>
        </p>
        <p style="font-size:13px;color:#666">
          Ce lien est valable jusqu&rsquo;au ${escape(params.expiresAtLabel)}.
        </p>
        <hr style="margin:32px 0;border:none;border-top:1px solid #eee" />
        <p style="font-size:12px;color:#999">
          Si vous ne souhaitez pas poursuivre, vous pouvez ignorer cet email.
        </p>
      </div>
    `.trim();

    const text = [
      `Bonjour ${params.studentFirstname},`,
      ``,
      `Nous espérons que votre cours d'essai ${params.serviceName} avec ${params.facilitatorName} s'est bien passé.`,
      ``,
      `Vous pouvez vous inscrire au trimestre complet. Les ${params.trialPaidAmount} déjà réglés seront déduits du tarif.`,
      ``,
      `Lien d'inscription (valable jusqu'au ${params.expiresAtLabel}):`,
      params.inviteUrl,
      ``,
      `Si vous ne souhaitez pas poursuivre, vous pouvez ignorer cet email.`,
    ].join('\n');

    const r = getResend();
    if (!r) {
      // No API key — log instead of sending.
      console.log('--- [email-stub] enrollment-invite ---');
      console.log('To:', params.to);
      console.log('Subject:', subject);
      console.log('URL:', params.inviteUrl);
      console.log('--------------------------------------');
      return;
    }

    const { error } = await r.emails.send({
      from: defaultFrom(),
      to: params.to,
      subject,
      html,
      text,
    });
    if (error) {
      throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
    }
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
