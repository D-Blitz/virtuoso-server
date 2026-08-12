import { Request, Response } from 'express';
import { LocationService } from '../services/location.service';
import { resourceInsightsService } from '../services/resourceInsights.service';
import { sendError } from './httpErrors';

const locationService = new LocationService();

function parseDateOr(raw: unknown, fallback: Date): Date {
  if (typeof raw !== 'string' || !raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export class LocationController {
  /** GET /api/locations/:id/rooms-with-custom-hours */
  async roomsWithCustomHours(req: Request, res: Response) {
    try {
      const rooms = await locationService.getRoomsWithCustomHours(
        req.params.id,
      );
      res.json({ rooms });
    } catch (error) {
      sendError(res, error, 'Failed to list rooms with custom hours');
    }
  }

  /** POST /api/locations/:id/apply-opening-hours */
  async applyOpeningHours(req: Request, res: Response) {
    try {
      const result = await locationService.applyOpeningHoursToRooms(
        req.params.id,
      );
      res.json(result);
    } catch (error) {
      sendError(res, error, 'Failed to apply opening hours to rooms');
    }
  }

  async create(req: Request, res: Response) {
    try {
      const location = await locationService.create(req.body);
      res.status(201).json(location);
    } catch (error) {
      sendError(res, error, 'Failed to create location');
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const locations = await locationService.getAll();
      res.json(locations);
    } catch (error) {
      sendError(res, error, 'Failed to fetch locations');
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await locationService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      sendError(res, error, 'Failed to update location');
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await locationService.delete(id);
      res.status(204).send();
    } catch (error) {
      sendError(res, error, 'Failed to delete location');
    }
  }

  /**
   * N.6.9 — aggregated activity + revenue insights for the UID page.
   * Aggregates across every room in the location.
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
        kind: 'location',
        id,
        from,
        to,
        facilitatorId: str(req.query.facilitatorId),
        serviceId: str(req.query.serviceId),
        clientId: str(req.query.clientId),
        roomId: str(req.query.roomId),
      });
      res.json(payload);
    } catch (error) {
      sendError(res, error, 'Failed to compute location insights');
    }
  }
}
