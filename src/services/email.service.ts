/**
 * Email delivery wrapper around Resend.
 *
 * If `RESEND_API_KEY` is unset (dev convenience), emails are logged to
 * stdout instead of sent. This lets you develop the invite flow without
 * setting up an account.
 */
import { Resend } from 'resend';
import { buildIcsCalendar } from './ics';

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

/**
 * Optional admin BCC for transactional confirmations — set ADMIN_BCC_EMAIL
 * to receive a copy of every student-facing confirmation. Returns `undefined`
 * when unset so we can spread it directly without sending an empty array.
 */
function adminBcc(): string | undefined {
  const e = process.env.ADMIN_BCC_EMAIL?.trim();
  return e && e.length > 0 ? e : undefined;
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

export type TrialConfirmationEmailParams = {
  to: string;
  studentFirstname: string;
  serviceName: string;
  facilitatorName: string;
  trialDateLabel: string;       // e.g. "lundi 19 mai à 14:00"
  locationName: string;
  rescheduleUrl: string;
};

export type TrialRescheduleEmailParams = {
  to: string;
  studentFirstname: string;
  serviceName: string;
  facilitatorName: string;
  previousDateLabel: string;    // e.g. "lundi 19 mai à 14:00"
  newDateLabel: string;
  locationName: string;
};

/** Phase 1.1 — sent when an admin cancels a booking. */
export type EventCancellationEmailParams = {
  to: string;
  studentFirstname: string;
  serviceName: string;
  facilitatorName: string;
  trialDateLabel: string;
  reason: string | null;
  refundIssued: boolean;
  refundedAmount: number;
};

/** Phase 1.3 — sent on payment_intent.payment_failed. */
export type PaymentFailureEmailParams = {
  to: string;
  studentFirstname: string;
  serviceName: string;
  amount: number;
  /** Retry / contact URL the student can click to fix their payment. */
  retryUrl?: string;
};

/**
 * Phase 1.2 — pre-event reminder email.
 * `hoursBefore` is the cron window (typically 24 or 48). Subject +
 * lead copy vary based on the window so the email reads naturally
 * ("dans 2 jours" at 48h, "demain" at 24h). The reschedule link is
 * only honored for the 48h reminder (24h is past the cutoff anyway).
 */
export type TrialReminderEmailParams = {
  to: string;
  studentFirstname: string;
  serviceName: string;
  facilitatorName: string;
  trialDateLabel: string;
  locationName: string;
  hoursBefore: number;
  rescheduleUrl?: string;
};

export type EnrollmentLesson = {
  /** Used as the ICS UID. */
  id: string;
  startTime: Date;
  endTime: Date;
};

export type EnrollmentConfirmationEmailParams = {
  to: string;
  studentFirstname: string;
  serviceName: string;
  facilitatorName: string;
  termName: string;
  recurringSlotLabel: string;       // e.g. "tous les lundis à 14:00 (60 min)"
  locationName: string;
  totalPaidLabel: string;           // e.g. "270,00 €"
  lessonCount: number;
  firstLessonLabel: string;         // e.g. "lundi 26 mai à 14:00"
  lastLessonLabel: string;
  lessons: EnrollmentLesson[];      // for both the body list and the .ics file
};

export type TeacherNewStudentEmailParams = {
  to: string;
  teacherFirstname: string;
  studentName: string;
  studentEmail: string;
  serviceName: string;
  recurringSlotLabel: string;
  locationName: string;
  firstLessonLabel: string;
  lessonCount: number;
  termName: string;
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

  async sendTrialConfirmation(params: TrialConfirmationEmailParams): Promise<void> {
    const subject = `Confirmation : votre cours d'essai du ${params.trialDateLabel}`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
        <h1 style="margin:0 0 16px 0;font-size:22px">Bonjour ${escape(params.studentFirstname)},</h1>
        <p style="line-height:1.55;color:#333">
          Votre cours d&rsquo;essai
          <strong>${escape(params.serviceName)}</strong> avec
          <strong>${escape(params.facilitatorName)}</strong> est confirmé.
        </p>
        <div style="padding:16px;background:#f5f5f5;border-radius:8px;margin:16px 0">
          <div style="font-size:15px;color:#555"><strong>Date :</strong> ${escape(params.trialDateLabel)}</div>
          <div style="font-size:15px;color:#555;margin-top:6px"><strong>Lieu :</strong> ${escape(params.locationName)}</div>
        </div>
        <p style="line-height:1.55;color:#333">
          Un imprévu ? Vous pouvez décaler votre cours une fois, jusqu&rsquo;à
          48 h avant la séance.
        </p>
        <p style="margin:32px 0">
          <a href="${params.rescheduleUrl}"
             style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">
            Modifier mon créneau
          </a>
        </p>
        <hr style="margin:32px 0;border:none;border-top:1px solid #eee" />
        <p style="font-size:12px;color:#999">
          À très vite !
        </p>
      </div>
    `.trim();

    const text = [
      `Bonjour ${params.studentFirstname},`,
      ``,
      `Votre cours d'essai ${params.serviceName} avec ${params.facilitatorName} est confirmé.`,
      `Date : ${params.trialDateLabel}`,
      `Lieu : ${params.locationName}`,
      ``,
      `Un imprévu ? Vous pouvez décaler votre cours une fois, jusqu'à 48 h avant la séance :`,
      params.rescheduleUrl,
      ``,
      `À très vite !`,
    ].join('\n');

    const r = getResend();
    if (!r) {
      console.log('--- [email-stub] trial-confirmation ---');
      console.log('To:', params.to);
      console.log('Subject:', subject);
      console.log('Reschedule URL:', params.rescheduleUrl);
      console.log('---------------------------------------');
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

  async sendTrialReschedule(params: TrialRescheduleEmailParams): Promise<void> {
    const subject = `Cours d'essai reprogrammé : ${params.newDateLabel}`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
        <h1 style="margin:0 0 16px 0;font-size:22px">Bonjour ${escape(params.studentFirstname)},</h1>
        <p style="line-height:1.55;color:#333">
          Votre cours d&rsquo;essai
          <strong>${escape(params.serviceName)}</strong> avec
          <strong>${escape(params.facilitatorName)}</strong> a bien été reprogrammé.
        </p>
        <div style="padding:16px;background:#f5f5f5;border-radius:8px;margin:16px 0">
          <div style="font-size:15px;color:#555">
            <strong>Nouvelle date :</strong> ${escape(params.newDateLabel)}
          </div>
          <div style="font-size:14px;color:#888;margin-top:6px;text-decoration:line-through">
            Ancienne date : ${escape(params.previousDateLabel)}
          </div>
          <div style="font-size:15px;color:#555;margin-top:10px">
            <strong>Lieu :</strong> ${escape(params.locationName)}
          </div>
        </div>
        <p style="line-height:1.55;color:#333">
          Cette modification est définitive : un cours d&rsquo;essai ne peut être
          reprogrammé qu&rsquo;une seule fois en ligne. Pour toute autre demande,
          contactez l&rsquo;école.
        </p>
        <hr style="margin:32px 0;border:none;border-top:1px solid #eee" />
        <p style="font-size:12px;color:#999">
          À très vite !
        </p>
      </div>
    `.trim();

    const text = [
      `Bonjour ${params.studentFirstname},`,
      ``,
      `Votre cours d'essai ${params.serviceName} avec ${params.facilitatorName} a bien été reprogrammé.`,
      ``,
      `Nouvelle date : ${params.newDateLabel}`,
      `Ancienne date : ${params.previousDateLabel}`,
      `Lieu : ${params.locationName}`,
      ``,
      `Cette modification est définitive : un cours d'essai ne peut être reprogrammé qu'une seule fois en ligne.`,
      `Pour toute autre demande, contactez l'école.`,
    ].join('\n');

    const r = getResend();
    if (!r) {
      console.log('--- [email-stub] trial-reschedule ---');
      console.log('To:', params.to);
      console.log('Subject:', subject);
      console.log('Previous:', params.previousDateLabel);
      console.log('New:', params.newDateLabel);
      console.log('-------------------------------------');
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

  /**
   * Pre-event reminder. One template, two delivery windows (T-24h
   * and T-48h before startTime). The 48h version includes the
   * reschedule link; the 24h version omits it because the reschedule
   * token validity already requires ≥48h notice.
   *
   * Dispatched via NotificationDispatcher (not called directly by
   * the cron) so SMS can drop in later as a second channel without
   * touching the trigger logic.
   */
  async sendTrialReminder(
    params: TrialReminderEmailParams,
  ): Promise<void> {
    const isFar = params.hoursBefore >= 48;
    const subject = isFar
      ? `Rappel : votre cours d'essai dans 2 jours (${params.trialDateLabel})`
      : `Rappel : votre cours d'essai demain (${params.trialDateLabel})`;

    const lead = isFar
      ? `a lieu dans <strong>2 jours</strong>`
      : `a lieu <strong>demain</strong>`;
    const leadText = isFar ? 'a lieu dans 2 jours' : 'a lieu demain';

    const rescheduleBlock =
      params.rescheduleUrl && isFar
        ? `
        <p style="line-height:1.55;color:#333">
          Un imprévu ? Vous pouvez encore décaler votre cours une fois
          (avant les 48 h précédant la séance).
        </p>
        <p style="margin:32px 0">
          <a href="${params.rescheduleUrl}"
             style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">
            Modifier mon créneau
          </a>
        </p>`
        : '';

    const rescheduleText =
      params.rescheduleUrl && isFar
        ? [
            ``,
            `Un imprévu ? Vous pouvez décaler votre cours une fois (avant 48 h) :`,
            params.rescheduleUrl,
          ].join('\n')
        : '';

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
        <h1 style="margin:0 0 16px 0;font-size:22px">Bonjour ${escape(params.studentFirstname)},</h1>
        <p style="line-height:1.55;color:#333">
          Votre cours d&rsquo;essai
          <strong>${escape(params.serviceName)}</strong> avec
          <strong>${escape(params.facilitatorName)}</strong> ${lead}.
        </p>
        <div style="padding:16px;background:#f5f5f5;border-radius:8px;margin:16px 0">
          <div style="font-size:15px;color:#555"><strong>Date :</strong> ${escape(params.trialDateLabel)}</div>
          <div style="font-size:15px;color:#555;margin-top:6px"><strong>Lieu :</strong> ${escape(params.locationName)}</div>
        </div>
        ${rescheduleBlock}
        <hr style="margin:32px 0;border:none;border-top:1px solid #eee" />
        <p style="font-size:12px;color:#999">
          À très vite !
        </p>
      </div>
    `.trim();

    const text = [
      `Bonjour ${params.studentFirstname},`,
      ``,
      `Votre cours d'essai ${params.serviceName} avec ${params.facilitatorName} ${leadText}.`,
      `Date : ${params.trialDateLabel}`,
      `Lieu : ${params.locationName}`,
      rescheduleText,
      ``,
      `À très vite !`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    const r = getResend();
    if (!r) {
      console.log(`--- [email-stub] trial-reminder-${params.hoursBefore}h ---`);
      console.log('To:', params.to);
      console.log('Subject:', subject);
      console.log('--------------------------------------------------');
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

  /**
   * Phase 1.1 — student-facing notice that their booking was cancelled
   * by the school. Tells them whether a refund was issued (and how
   * much) so they don't have to ask.
   */
  async sendEventCancellation(
    params: EventCancellationEmailParams,
  ): Promise<void> {
    const subject = `Votre cours du ${params.trialDateLabel} a été annulé`;

    const refundLine = params.refundIssued
      ? `<p style="line-height:1.55;color:#333">
           Un remboursement de
           <strong>${params.refundedAmount.toFixed(2)} €</strong>
           a été lancé. Il devrait apparaître sur votre compte sous
           quelques jours ouvrés.
         </p>`
      : '';

    const reasonBlock = params.reason
      ? `<div style="padding:16px;background:#f5f5f5;border-radius:8px;margin:16px 0;font-size:14px;color:#555">
           <strong>Raison communiquée :</strong> ${escape(params.reason)}
         </div>`
      : '';

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
        <h1 style="margin:0 0 16px 0;font-size:22px">Bonjour ${escape(params.studentFirstname)},</h1>
        <p style="line-height:1.55;color:#333">
          Votre cours <strong>${escape(params.serviceName)}</strong> avec
          <strong>${escape(params.facilitatorName)}</strong>, prévu le
          <strong>${escape(params.trialDateLabel)}</strong>, a été annulé.
        </p>
        ${reasonBlock}
        ${refundLine}
        <p style="line-height:1.55;color:#333">
          Pour toute question, n&rsquo;hésitez pas à nous contacter.
        </p>
        <hr style="margin:32px 0;border:none;border-top:1px solid #eee" />
        <p style="font-size:12px;color:#999">Désolés pour le dérangement.</p>
      </div>
    `.trim();

    const refundText = params.refundIssued
      ? `\nUn remboursement de ${params.refundedAmount.toFixed(2)} € a été lancé.\n`
      : '';
    const reasonText = params.reason ? `\nRaison : ${params.reason}\n` : '';

    const text = [
      `Bonjour ${params.studentFirstname},`,
      ``,
      `Votre cours ${params.serviceName} avec ${params.facilitatorName}, prévu le ${params.trialDateLabel}, a été annulé.`,
      reasonText,
      refundText,
      `Pour toute question, contactez-nous.`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    const r = getResend();
    if (!r) {
      console.log('--- [email-stub] event-cancellation ---');
      console.log('To:', params.to);
      console.log('Subject:', subject);
      console.log('Refund issued:', params.refundIssued, params.refundedAmount);
      console.log('---------------------------------------');
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

  /**
   * Phase 1.3 — sent on `payment.failed`. Friendly "réessayez" email;
   * doesn't expire the booking. Retry URL is optional.
   */
  async sendPaymentFailure(
    params: PaymentFailureEmailParams,
  ): Promise<void> {
    const subject = `Le paiement de votre inscription n'a pas abouti`;

    const retryBlock = params.retryUrl
      ? `<p style="margin:32px 0">
           <a href="${params.retryUrl}"
              style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">
             Réessayer le paiement
           </a>
         </p>`
      : '';
    const retryText = params.retryUrl
      ? `\nLien pour réessayer : ${params.retryUrl}\n`
      : '';

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
        <h1 style="margin:0 0 16px 0;font-size:22px">Bonjour ${escape(params.studentFirstname)},</h1>
        <p style="line-height:1.55;color:#333">
          Votre paiement pour
          <strong>${escape(params.serviceName)}</strong>
          (${params.amount.toFixed(2)} €) n&rsquo;a pas pu être finalisé.
        </p>
        <p style="line-height:1.55;color:#333">
          Causes les plus fréquentes : carte bancaire refusée, plafond
          atteint, ou problème ponctuel avec votre banque. Votre
          réservation n&rsquo;est pas perdue, vous pouvez réessayer
          immédiatement.
        </p>
        ${retryBlock}
        <p style="line-height:1.55;color:#333">
          Si le problème persiste, contactez-nous, nous trouverons une
          solution ensemble.
        </p>
        <hr style="margin:32px 0;border:none;border-top:1px solid #eee" />
        <p style="font-size:12px;color:#999">À très vite !</p>
      </div>
    `.trim();

    const text = [
      `Bonjour ${params.studentFirstname},`,
      ``,
      `Votre paiement pour ${params.serviceName} (${params.amount.toFixed(2)} €) n'a pas pu être finalisé.`,
      ``,
      `Causes fréquentes : carte refusée, plafond atteint, ou souci ponctuel avec votre banque.`,
      `Votre réservation n'est pas perdue, vous pouvez réessayer.`,
      retryText,
      `Si le problème persiste, contactez-nous.`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    const r = getResend();
    if (!r) {
      console.log('--- [email-stub] payment-failure ---');
      console.log('To:', params.to);
      console.log('Subject:', subject);
      console.log('-----------------------------------');
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

  /**
   * Student-facing confirmation after a paid trimester enrollment activation.
   * Includes the full lesson schedule and an .ics attachment so the student
   * can one-click add the term to their calendar. BCCs ADMIN_BCC_EMAIL if set.
   */
  async sendEnrollmentConfirmation(
    params: EnrollmentConfirmationEmailParams,
  ): Promise<void> {
    const subject = `Inscription confirmée — ${params.serviceName} (${params.termName})`;

    const scheduleHtml = params.lessons
      .map((l) => {
        const date = l.startTime.toLocaleDateString('fr-FR', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        });
        const time = l.startTime.toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
        });
        return `<li style="text-transform:capitalize">${escape(date)} · ${escape(time)}</li>`;
      })
      .join('');

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">
        <h1 style="margin:0 0 16px 0;font-size:22px">Bonjour ${escape(params.studentFirstname)},</h1>
        <p style="line-height:1.55;color:#333">
          Votre inscription au <strong>${escape(params.termName)}</strong> est confirmée.
          Bienvenue (ou bon retour) chez Art &amp; Cetera !
        </p>

        <div style="padding:16px;background:#f5f5f5;border-radius:8px;margin:20px 0">
          <div style="font-size:15px;color:#333;margin-bottom:6px">
            <strong>Cours :</strong> ${escape(params.serviceName)}
          </div>
          <div style="font-size:15px;color:#333;margin-bottom:6px">
            <strong>Enseignant·e :</strong> ${escape(params.facilitatorName)}
          </div>
          <div style="font-size:15px;color:#333;margin-bottom:6px">
            <strong>Créneau :</strong> ${escape(params.recurringSlotLabel)}
          </div>
          <div style="font-size:15px;color:#333;margin-bottom:6px">
            <strong>Lieu :</strong> ${escape(params.locationName)}
          </div>
          <div style="font-size:15px;color:#333;margin-bottom:6px">
            <strong>Premier cours :</strong> ${escape(params.firstLessonLabel)}
          </div>
          <div style="font-size:15px;color:#333">
            <strong>Total réglé :</strong> ${escape(params.totalPaidLabel)}
            (${params.lessonCount} séance${params.lessonCount > 1 ? 's' : ''})
          </div>
        </div>

        <h2 style="font-size:16px;margin:24px 0 8px 0;color:#111">
          Calendrier complet
        </h2>
        <ul style="line-height:1.7;color:#444;padding-left:20px;margin:0 0 8px 0;font-size:14px">
          ${scheduleHtml}
        </ul>
        <p style="font-size:13px;color:#666;margin:8px 0 24px 0">
          Un fichier <strong>.ics</strong> est joint à cet email — ouvrez-le
          pour ajouter toutes les séances à votre calendrier en un clic.
        </p>

        <p style="line-height:1.55;color:#333">
          Pour toute modification après inscription (changement de créneau,
          absence, etc.), contactez directement l&rsquo;école — les changements
          en ligne ne sont plus possibles à ce stade.
        </p>

        <hr style="margin:32px 0;border:none;border-top:1px solid #eee" />
        <p style="font-size:12px;color:#999">
          À bientôt en cours !
        </p>
      </div>
    `.trim();

    const text = [
      `Bonjour ${params.studentFirstname},`,
      ``,
      `Votre inscription au ${params.termName} est confirmée.`,
      ``,
      `Cours : ${params.serviceName}`,
      `Enseignant·e : ${params.facilitatorName}`,
      `Créneau : ${params.recurringSlotLabel}`,
      `Lieu : ${params.locationName}`,
      `Premier cours : ${params.firstLessonLabel}`,
      `Total réglé : ${params.totalPaidLabel} (${params.lessonCount} séance${params.lessonCount > 1 ? 's' : ''})`,
      ``,
      `Calendrier :`,
      ...params.lessons.map((l) => {
        const date = l.startTime.toLocaleDateString('fr-FR', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        });
        const time = l.startTime.toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
        });
        return `  - ${date} · ${time}`;
      }),
      ``,
      `Un fichier .ics est joint pour ajouter le trimestre à votre calendrier en un clic.`,
      ``,
      `Pour toute modification après inscription, contactez l'école.`,
    ].join('\n');

    const icsContent = buildIcsCalendar({
      prodId: '-//Art & Cetera//Enrollment//FR',
      calendarName: `${params.serviceName} — ${params.termName}`,
      events: params.lessons.map((l) => ({
        id: l.id,
        startTime: l.startTime,
        endTime: l.endTime,
        summary: `${params.serviceName} avec ${params.facilitatorName}`,
        location: params.locationName,
        description: `Cours régulier — inscription confirmée au ${params.termName}.`,
      })),
    });
    const icsBase64 = Buffer.from(icsContent, 'utf-8').toString('base64');
    const icsFilename = `art-cetera-${params.termName.replace(/\s+/g, '-').toLowerCase()}.ics`;
    const bcc = adminBcc();

    const r = getResend();
    if (!r) {
      console.log('--- [email-stub] enrollment-confirmation ---');
      console.log('To:', params.to);
      if (bcc) console.log('BCC:', bcc);
      console.log('Subject:', subject);
      console.log('Lessons:', params.lessons.length);
      console.log('ICS bytes:', icsContent.length);
      console.log('--------------------------------------------');
      return;
    }

    const { error } = await r.emails.send({
      from: defaultFrom(),
      to: params.to,
      ...(bcc ? { bcc } : {}),
      subject,
      html,
      text,
      attachments: [
        {
          filename: icsFilename,
          content: icsBase64,
        },
      ],
    });
    if (error) {
      throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
    }
  }

  /**
   * Teacher-facing notification when a new student joins one of their
   * recurring slots. Lighter than the student email — no .ics, no full
   * schedule, just the key facts.
   */
  async sendTeacherNewStudent(params: TeacherNewStudentEmailParams): Promise<void> {
    const subject = `Nouvel·le élève : ${params.studentName} — ${params.serviceName}`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
        <h1 style="margin:0 0 16px 0;font-size:20px">
          Bonjour ${escape(params.teacherFirstname)},
        </h1>
        <p style="line-height:1.55;color:#333">
          Un·e nouvel·le élève vient de s&rsquo;inscrire à l&rsquo;un de vos
          créneaux pour le <strong>${escape(params.termName)}</strong>.
        </p>
        <div style="padding:16px;background:#f5f5f5;border-radius:8px;margin:16px 0">
          <div style="font-size:15px;color:#333;margin-bottom:6px">
            <strong>Élève :</strong> ${escape(params.studentName)}
            (<a href="mailto:${escape(params.studentEmail)}" style="color:#7c3aed">${escape(params.studentEmail)}</a>)
          </div>
          <div style="font-size:15px;color:#333;margin-bottom:6px">
            <strong>Cours :</strong> ${escape(params.serviceName)}
          </div>
          <div style="font-size:15px;color:#333;margin-bottom:6px">
            <strong>Créneau :</strong> ${escape(params.recurringSlotLabel)}
          </div>
          <div style="font-size:15px;color:#333;margin-bottom:6px">
            <strong>Lieu :</strong> ${escape(params.locationName)}
          </div>
          <div style="font-size:15px;color:#333">
            <strong>Premier cours :</strong> ${escape(params.firstLessonLabel)}
            (${params.lessonCount} séance${params.lessonCount > 1 ? 's' : ''} au total)
          </div>
        </div>
        <p style="line-height:1.55;color:#333;font-size:14px">
          Les séances sont déjà ajoutées à votre planning Art &amp; Cetera.
        </p>
      </div>
    `.trim();

    const text = [
      `Bonjour ${params.teacherFirstname},`,
      ``,
      `Un·e nouvel·le élève vient de s'inscrire à l'un de vos créneaux pour le ${params.termName}.`,
      ``,
      `Élève : ${params.studentName} (${params.studentEmail})`,
      `Cours : ${params.serviceName}`,
      `Créneau : ${params.recurringSlotLabel}`,
      `Lieu : ${params.locationName}`,
      `Premier cours : ${params.firstLessonLabel} (${params.lessonCount} séance${params.lessonCount > 1 ? 's' : ''} au total)`,
      ``,
      `Les séances sont déjà ajoutées à votre planning Art & Cetera.`,
    ].join('\n');

    const r = getResend();
    if (!r) {
      console.log('--- [email-stub] teacher-new-student ---');
      console.log('To:', params.to);
      console.log('Subject:', subject);
      console.log('Student:', params.studentName, '<', params.studentEmail, '>');
      console.log('----------------------------------------');
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
