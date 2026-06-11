import { Request, Response } from 'express';

import { InAppNotificationService } from '../services/notifications/inApp.service';
import { sendServiceError } from './httpErrors';

const service = new InAppNotificationService();

export class NotificationController {
  /** GET /api/notifications?filter=unread|all&limit&offset */
  async list(req: Request, res: Response) {
    try {
      const filter = req.query.filter === 'unread' ? 'unread' : 'all';
      const result = await service.list({
        filter,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(result);
    } catch (err) {
      sendServiceError(res, err, 'Failed to list notifications');
    }
  }

  /** GET /api/notifications/unread-count */
  async unreadCount(_req: Request, res: Response) {
    try {
      res.json({ count: await service.unreadCount() });
    } catch (err) {
      sendServiceError(res, err, 'Failed to count notifications');
    }
  }

  /** POST /api/notifications/read { ids: string[] } */
  async markRead(req: Request, res: Response) {
    try {
      const ids = Array.isArray(req.body?.ids)
        ? (req.body.ids.filter((x: unknown) => typeof x === 'string') as string[])
        : [];
      await service.markRead(ids);
      res.status(204).send();
    } catch (err) {
      sendServiceError(res, err, 'Failed to mark notifications read');
    }
  }

  /** POST /api/notifications/read-all */
  async markAllRead(_req: Request, res: Response) {
    try {
      await service.markAllRead();
      res.status(204).send();
    } catch (err) {
      sendServiceError(res, err, 'Failed to mark all notifications read');
    }
  }
}
