import { Request, Response } from 'express';
import { ScheduledEventService } from '../services/scheduledEvent.service';

const scheduledEventService = new ScheduledEventService();

export class ScheduledEventController {
  async create(req: Request, res: Response) {
    try {
      const event = await scheduledEventService.create(req.body);
      res.status(201).json(event);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to create event' });
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const events = await scheduledEventService.getAll();
      res.json(events);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch events' });
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await scheduledEventService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to update event' });
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await scheduledEventService.delete(id);
      res.status(204).send();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete event' });
    }
  }
}
