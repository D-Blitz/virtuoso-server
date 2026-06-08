import { Request, Response } from 'express';
import { RoomService } from '../services/room.service';
import { resourceInsightsService } from '../services/resourceInsights.service';
import { sendError } from './httpErrors';

const roomService = new RoomService();

function parseDateOr(raw: unknown, fallback: Date): Date {
  if (typeof raw !== 'string' || !raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export class RoomController {
  async create(req: Request, res: Response) {
    try {
      const room = await roomService.create(req.body);
      res.status(201).json(room);
    } catch (error) {
      sendError(res, error, 'Failed to create room');
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const rooms = await roomService.getAll();
      res.json(rooms);
    } catch (error) {
      sendError(res, error, 'Failed to fetch rooms');
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await roomService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      sendError(res, error, 'Failed to update room');
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await roomService.delete(id);
      res.status(204).send();
    } catch (error) {
      sendError(res, error, 'Failed to delete room');
    }
  }

  /**
   * N.6.9 — aggregated activity + revenue insights for the UID page.
   * Defaults to the last 90 days.
   */
  async insights(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const now = new Date();
      const from = parseDateOr(
        req.query.from,
        new Date(now.getTime() - 90 * 24 * 3600_000),
      );
      const to = parseDateOr(req.query.to, now);
      const str = (raw: unknown): string | undefined =>
        typeof raw === 'string' && raw.length > 0 ? raw : undefined;
      const payload = await resourceInsightsService.get({
        kind: 'room',
        id,
        from,
        to,
        facilitatorId: str(req.query.facilitatorId),
        serviceId: str(req.query.serviceId),
        clientId: str(req.query.clientId),
      });
      res.json(payload);
    } catch (error) {
      sendError(res, error, 'Failed to compute room insights');
    }
  }
}
