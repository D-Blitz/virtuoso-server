import { Request, Response } from 'express';

import {
  MessageService,
  type RecipientRef,
  type RecipientType,
  type MessageStatus,
} from '../services/message/message.service';
import { sendError, sendServiceError } from './httpErrors';

const service = new MessageService();

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

/** Parse the recipients array from the request body, ignoring malformed entries. */
function parseRecipients(v: unknown): RecipientRef[] {
  if (!Array.isArray(v)) return [];
  const out: RecipientRef[] = [];
  for (const r of v) {
    const type = (r as any)?.type;
    const id = (r as any)?.id;
    if ((type === 'CLIENT' || type === 'FACILITATOR') && typeof id === 'string' && id) {
      out.push({ type, id });
    }
  }
  return out;
}

export class MessageController {
  /** GET /api/messages — history (filters + offset pagination). */
  async list(req: Request, res: Response) {
    try {
      const recipientType = asString(req.query.recipientType) as
        | RecipientType
        | undefined;
      const status = asString(req.query.status) as MessageStatus | undefined;
      const items = await service.list({
        recipientType:
          recipientType === 'CLIENT' || recipientType === 'FACILITATOR'
            ? recipientType
            : undefined,
        recipientId: asString(req.query.recipientId),
        status: status === 'SENT' || status === 'FAILED' ? status : undefined,
        batchId: asString(req.query.batchId),
        search: asString(req.query.search),
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(items);
    } catch (err) {
      sendError(res, err, 'Failed to list messages');
    }
  }

  /** POST /api/messages/send — compose & send to N recipients. */
  async send(req: Request, res: Response) {
    try {
      const { subject, body, channel } = req.body ?? {};
      const summary = await service.send({
        recipients: parseRecipients(req.body?.recipients),
        subject: typeof subject === 'string' ? subject : '',
        body: typeof body === 'string' ? body : '',
        channel: channel === 'EMAIL' ? 'EMAIL' : undefined,
      });
      res.status(201).json(summary);
    } catch (err) {
      sendServiceError(res, err, 'Failed to send message');
    }
  }

  // ── Templates ─────────────────────────────────────────────────────

  async listTemplates(_req: Request, res: Response) {
    try {
      const items = await service.listTemplates();
      res.json({ items });
    } catch (err) {
      sendError(res, err, 'Failed to list templates');
    }
  }

  async createTemplate(req: Request, res: Response) {
    try {
      const { name, subject, body } = req.body ?? {};
      const row = await service.createTemplate({
        name: typeof name === 'string' ? name : '',
        subject: typeof subject === 'string' ? subject : null,
        body: typeof body === 'string' ? body : '',
      });
      res.status(201).json(row);
    } catch (err) {
      sendServiceError(res, err, 'Failed to create template');
    }
  }

  async updateTemplate(req: Request, res: Response) {
    try {
      const { name, subject, body } = req.body ?? {};
      const row = await service.updateTemplate(req.params.id, {
        name: typeof name === 'string' ? name : undefined,
        subject:
          subject === undefined ? undefined : typeof subject === 'string' ? subject : null,
        body: typeof body === 'string' ? body : undefined,
      });
      res.json(row);
    } catch (err) {
      sendServiceError(res, err, 'Failed to update template');
    }
  }

  async deleteTemplate(req: Request, res: Response) {
    try {
      await service.deleteTemplate(req.params.id);
      res.status(204).send();
    } catch (err) {
      sendServiceError(res, err, 'Failed to delete template');
    }
  }
}
