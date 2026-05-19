import { Request, Response } from 'express';
import { ScheduledEventService } from '../services/scheduledEvent.service';

const scheduledEventService = new ScheduledEventService();

function parseScope(req: Request): 'THIS' | 'ALL' {
  const raw =
    typeof req.query.scope === 'string' ? req.query.scope.toUpperCase() : '';
  return raw === 'ALL' ? 'ALL' : 'THIS';
}

export class ScheduledEventController {
  async create(req: Request, res: Response) {
    try {
      const events = await scheduledEventService.create(req.body);
      res.status(201).json(events);
    } catch (error: any) {
      console.error(error);
      const msg = error?.message ?? 'Failed to create event';
      const lower = msg.toLowerCase();
      const status =
        lower.includes('invalid') ||
        lower.includes('must be') ||
        lower.includes('cap') ||
        lower.includes('missing')
          ? 400
          : 500;
      res.status(status).json({ error: msg });
    }
  }

  async getAll(req: Request, res: Response) {
    try {
      const from =
        typeof req.query.from === 'string' &&
        !Number.isNaN(Date.parse(req.query.from))
          ? new Date(req.query.from)
          : undefined;
      const to =
        typeof req.query.to === 'string' &&
        !Number.isNaN(Date.parse(req.query.to))
          ? new Date(req.query.to)
          : undefined;

      const events = await scheduledEventService.getAll({ from, to });
      res.json(events);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch events' });
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await scheduledEventService.update(
        id,
        req.body,
        parseScope(req),
      );
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to update event' });
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await scheduledEventService.delete(id, parseScope(req));
      res.status(204).send();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete event' });
    }
  }
}
