import { Request, Response } from 'express';

import { ChatService } from '../services/chat/chat.service';
import { sendServiceError } from './httpErrors';

const service = new ChatService();

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string') as string[];
}

export class ChatController {
  /** GET /api/chat/heartbeat — presence ping (requireUser already stamps it). */
  async heartbeat(_req: Request, res: Response) {
    res.status(204).send();
  }

  /** GET /api/chat/users — directory to start a chat with. */
  async listUsers(_req: Request, res: Response) {
    try {
      res.json({ items: await service.listUsers() });
    } catch (err) {
      sendServiceError(res, err, 'Failed to list chat users');
    }
  }

  /** GET /api/chat/conversations — the caller's inbox. */
  async listConversations(_req: Request, res: Response) {
    try {
      res.json({ items: await service.listConversations() });
    } catch (err) {
      sendServiceError(res, err, 'Failed to list conversations');
    }
  }

  /** POST /api/chat/conversations/direct — find/create a 1:1. */
  async createDirect(req: Request, res: Response) {
    try {
      const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
      const conv = await service.getOrCreateDirect(userId);
      res.status(201).json(conv);
    } catch (err) {
      sendServiceError(res, err, 'Failed to open conversation');
    }
  }

  /** POST /api/chat/conversations/group — create a group. */
  async createGroup(req: Request, res: Response) {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title : '';
      const conv = await service.createGroup(
        asStringList(req.body?.userIds),
        title,
      );
      res.status(201).json(conv);
    } catch (err) {
      sendServiceError(res, err, 'Failed to create group');
    }
  }

  /** GET /api/chat/conversations/:id */
  async getConversation(req: Request, res: Response) {
    try {
      res.json(await service.getConversation(req.params.id));
    } catch (err) {
      sendServiceError(res, err, 'Failed to load conversation');
    }
  }

  /** GET /api/chat/conversations/:id/messages */
  async getMessages(req: Request, res: Response) {
    try {
      const result = await service.getMessages(req.params.id, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        before:
          typeof req.query.before === 'string' ? req.query.before : undefined,
      });
      res.json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to load messages');
    }
  }

  /** POST /api/chat/conversations/:id/messages */
  async sendMessage(req: Request, res: Response) {
    try {
      const body = typeof req.body?.body === 'string' ? req.body.body : '';
      const msg = await service.sendMessage(req.params.id, body);
      res.status(201).json(msg);
    } catch (err) {
      sendServiceError(res, err, 'Failed to send message');
    }
  }

  /** POST /api/chat/conversations/:id/read */
  async markRead(req: Request, res: Response) {
    try {
      await service.markRead(req.params.id);
      res.status(204).send();
    } catch (err) {
      sendServiceError(res, err, 'Failed to mark read');
    }
  }
}
