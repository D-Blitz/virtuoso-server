import { randomUUID } from 'crypto';

import prisma from '../../prisma';
import { getContext, getOrganizationId } from '../../auth/context';
import { auditLog } from '../audit/audit.service';
import { EmailService } from '../email.service';

/**
 * M.1/M.2 — Messaging center service.
 *
 * Outbound, broadcast-style messaging: an admin composes a message,
 * picks recipients (clients and/or facilitators), and sends. Each send
 * is delivered through the existing channel layer (email today) and
 * logged as one Message row per recipient. A single compose-and-send
 * to N recipients shares a `batchId` so the history can group it.
 *
 * The recipient contact is snapshotted onto the row (name/email/phone)
 * so the log is a faithful permanent record of what went to which
 * address, surviving later edits / anonymisation of the source.
 */

const emailService = new EmailService();

// ── Types ──────────────────────────────────────────────────────────

export type RecipientType = 'CLIENT' | 'FACILITATOR';
export type MessageChannel = 'EMAIL'; // v1; SMS / IN_APP slot in later
export type MessageStatus = 'SENT' | 'FAILED';

export type RecipientRef = { type: RecipientType; id: string };

export type SendMessageInput = {
  recipients: RecipientRef[];
  subject: string;
  body: string;
  channel?: MessageChannel;
};

export type MessageDto = {
  id: string;
  recipientType: RecipientType;
  recipientId: string | null;
  recipientName: string;
  recipientEmail: string | null;
  recipientPhone: string | null;
  channel: string;
  subject: string | null;
  body: string;
  status: MessageStatus;
  error: string | null;
  batchId: string | null;
  sentAt: string | null;
  createdAt: string;
};

export type SendSummary = {
  batchId: string;
  total: number;
  sent: number;
  failed: number;
  messages: MessageDto[];
};

export type MessageTemplateDto = {
  id: string;
  name: string;
  subject: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
};

// ── Helpers ────────────────────────────────────────────────────────

const SUBJECT_MAX = 300;
const BODY_MAX = 20000;

function rowToDto(row: any): MessageDto {
  return {
    id: row.id,
    recipientType: row.recipientType,
    recipientId: row.recipientId,
    recipientName: row.recipientName,
    recipientEmail: row.recipientEmail,
    recipientPhone: row.recipientPhone,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    status: row.status,
    error: row.error,
    batchId: row.batchId,
    sentAt: row.sentAt instanceof Date ? row.sentAt.toISOString() : row.sentAt,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

function templateToDto(row: any): MessageTemplateDto {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

/** Replace {variable} placeholders with per-recipient values. Unknown keys are left as-is. */
function renderVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Plain-text body → minimal safe HTML (escape + newlines to <br>). */
function bodyToHtml(text: string): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;white-space:normal;">${escapeHtml(
    text,
  ).replace(/\n/g, '<br>')}</div>`;
}

function badRequest(message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = 400;
  return e;
}

// ── Service ────────────────────────────────────────────────────────

export class MessageService {
  /**
   * List history, newest first. Filters compose with AND:
   *   - recipientType / status / channel (exact)
   *   - recipientId (a specific client/facilitator's thread)
   *   - batchId (one send)
   *   - search (recipient name/email or subject, case-insensitive)
   * Simple offset pagination (limit/offset).
   */
  async list(args: {
    recipientType?: RecipientType;
    recipientId?: string;
    status?: MessageStatus;
    batchId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: MessageDto[]; total: number }> {
    const organizationId = getOrganizationId();
    if (!organizationId) throw new Error('No organization context');

    const where: Record<string, any> = { organizationId };
    if (args.recipientType) where.recipientType = args.recipientType;
    if (args.recipientId) where.recipientId = args.recipientId;
    if (args.status) where.status = args.status;
    if (args.batchId) where.batchId = args.batchId;
    if (args.search && args.search.trim()) {
      const q = args.search.trim();
      where.OR = [
        { recipientName: { contains: q, mode: 'insensitive' } },
        { recipientEmail: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
      ];
    }

    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const offset = Math.max(args.offset ?? 0, 0);

    const [rows, total] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.message.count({ where }),
    ]);

    return { items: rows.map(rowToDto), total };
  }

  /**
   * Compose & send to N recipients. Resolves each ref to a contact
   * snapshot, merges {variables}, delivers via the channel, and logs a
   * Message row per recipient (status SENT / FAILED). All rows of one
   * send share a batchId. A single recipient failure never aborts the
   * batch — its row is logged FAILED with the error.
   */
  async send(input: SendMessageInput): Promise<SendSummary> {
    const organizationId = getOrganizationId();
    if (!organizationId) throw new Error('No organization context');
    const ctx = getContext();

    const channel: MessageChannel = input.channel ?? 'EMAIL';
    const subject = (input.subject ?? '').trim();
    const body = input.body ?? '';

    if (!subject) throw badRequest('Le sujet est requis.');
    if (subject.length > SUBJECT_MAX) {
      throw badRequest(`Le sujet ne peut pas dépasser ${SUBJECT_MAX} caractères.`);
    }
    if (!body.trim()) throw badRequest('Le message est requis.');
    if (body.length > BODY_MAX) {
      throw badRequest(`Le message est trop long (max ${BODY_MAX} caractères).`);
    }
    if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
      throw badRequest('Sélectionnez au moins un destinataire.');
    }

    // Resolve contacts in two scoped queries, deduping ids per type.
    const clientIds = [
      ...new Set(
        input.recipients.filter((r) => r.type === 'CLIENT').map((r) => r.id),
      ),
    ];
    const facilitatorIds = [
      ...new Set(
        input.recipients
          .filter((r) => r.type === 'FACILITATOR')
          .map((r) => r.id),
      ),
    ];

    const [clients, facilitators, org] = await Promise.all([
      clientIds.length
        ? prisma.client.findMany({
            where: { id: { in: clientIds }, organizationId },
            select: { id: true, firstname: true, lastname: true, email: true, phone: true },
          })
        : Promise.resolve([]),
      facilitatorIds.length
        ? prisma.facilitator.findMany({
            where: { id: { in: facilitatorIds }, organizationId },
            select: { id: true, firstname: true, lastname: true, email: true, phone: true },
          })
        : Promise.resolve([]),
      prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true },
      }),
    ]);

    const clientMap = new Map(clients.map((c) => [c.id, c]));
    const facilitatorMap = new Map(facilitators.map((f) => [f.id, f]));
    const orgName = org?.name ?? '';

    const batchId = randomUUID();
    const messages: MessageDto[] = [];
    let sent = 0;
    let failed = 0;

    // Sequential to stay friendly with the email provider's rate limits.
    for (const ref of input.recipients) {
      const src =
        ref.type === 'CLIENT' ? clientMap.get(ref.id) : facilitatorMap.get(ref.id);

      const name = src
        ? `${src.firstname} ${src.lastname}`.trim()
        : '(introuvable)';
      const email = src?.email ?? null;
      const phone = src?.phone ?? null;

      const vars: Record<string, string> = {
        firstname: src?.firstname ?? '',
        lastname: src?.lastname ?? '',
        fullname: name,
        email: email ?? '',
        phone: phone ?? '',
        orgName,
      };
      const renderedSubject = renderVars(subject, vars);
      const renderedBody = renderVars(body, vars);

      let status: MessageStatus = 'SENT';
      let error: string | null = null;

      try {
        if (!src) throw new Error('Destinataire introuvable dans cette organisation.');
        if (channel === 'EMAIL') {
          if (!email) throw new Error("Ce destinataire n'a pas d'adresse e-mail.");
          await emailService.sendCustomEmail({
            to: email,
            subject: renderedSubject,
            bodyHtml: bodyToHtml(renderedBody),
            bodyText: renderedBody,
          });
        } else {
          throw new Error(`Canal ${channel} non pris en charge.`);
        }
      } catch (err) {
        status = 'FAILED';
        failed += 1;
        error = err instanceof Error ? err.message : String(err);
      }
      if (status === 'SENT') sent += 1;

      const row = await prisma.message.create({
        data: {
          organizationId,
          senderUserId: ctx?.userId ?? null,
          recipientType: ref.type,
          recipientId: ref.id,
          recipientName: name,
          recipientEmail: email,
          recipientPhone: phone,
          channel,
          subject: renderedSubject,
          body: renderedBody,
          status,
          error,
          batchId,
          sentAt: status === 'SENT' ? new Date() : null,
        },
      });
      messages.push(rowToDto(row));
    }

    void auditLog.record({
      action: 'CREATE',
      entityType: 'Message',
      entityId: batchId,
      after: { channel, subject, total: messages.length, sent, failed },
    });

    return { batchId, total: messages.length, sent, failed, messages };
  }

  // ── Templates ─────────────────────────────────────────────────────

  async listTemplates(): Promise<MessageTemplateDto[]> {
    const organizationId = getOrganizationId();
    if (!organizationId) throw new Error('No organization context');
    const rows = await prisma.messageTemplate.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
    return rows.map(templateToDto);
  }

  async createTemplate(input: {
    name: string;
    subject?: string | null;
    body: string;
  }): Promise<MessageTemplateDto> {
    const organizationId = getOrganizationId();
    if (!organizationId) throw new Error('No organization context');
    const name = (input.name ?? '').trim();
    if (!name) throw badRequest('Le nom du modèle est requis.');
    if (!(input.body ?? '').trim()) throw badRequest('Le contenu du modèle est requis.');

    const row = await prisma.messageTemplate.create({
      data: {
        organizationId,
        name,
        subject: input.subject?.trim() || null,
        body: input.body,
      },
    });
    return templateToDto(row);
  }

  async updateTemplate(
    id: string,
    input: { name?: string; subject?: string | null; body?: string },
  ): Promise<MessageTemplateDto> {
    const organizationId = getOrganizationId();
    if (!organizationId) throw new Error('No organization context');
    const existing = await prisma.messageTemplate.findFirst({
      where: { id, organizationId },
    });
    if (!existing) {
      const e = new Error('Modèle introuvable.') as Error & { statusCode: number };
      e.statusCode = 404;
      throw e;
    }
    const data: Record<string, any> = {};
    if (input.name !== undefined) {
      const n = input.name.trim();
      if (!n) throw badRequest('Le nom du modèle est requis.');
      data.name = n;
    }
    if (input.subject !== undefined) data.subject = input.subject?.trim() || null;
    if (input.body !== undefined) {
      if (!input.body.trim()) throw badRequest('Le contenu du modèle est requis.');
      data.body = input.body;
    }
    const row = await prisma.messageTemplate.update({ where: { id }, data });
    return templateToDto(row);
  }

  async deleteTemplate(id: string): Promise<void> {
    const organizationId = getOrganizationId();
    if (!organizationId) throw new Error('No organization context');
    const existing = await prisma.messageTemplate.findFirst({
      where: { id, organizationId },
    });
    if (!existing) {
      const e = new Error('Modèle introuvable.') as Error & { statusCode: number };
      e.statusCode = 404;
      throw e;
    }
    await prisma.messageTemplate.delete({ where: { id } });
  }
}
