import { Request, Response } from 'express';
import { FacilitatorService } from '../services/facilitator.service';
import { facilitatorInsightsService } from '../services/facilitatorInsights.service';
import { sendError } from './httpErrors';

const facilitatorService = new FacilitatorService();

function parseDateOr(raw: unknown, fallback: Date): Date {
  if (typeof raw !== 'string' || !raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export class FacilitatorController {
  async create(req: Request, res: Response) {
    try {
      const facilitator = await facilitatorService.create(req.body);
      res.status(201).json(facilitator);
    } catch (error) {
      sendError(res, error, 'Failed to create facilitator');
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const facilitators = await facilitatorService.getAll();
      res.json(facilitators);
    } catch (error) {
      sendError(res, error, 'Failed to fetch facilitators');
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await facilitatorService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      sendError(res, error, 'Failed to update facilitator');
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await facilitatorService.delete(id);
      res.status(204).send();
    } catch (error) {
      sendError(res, error, 'Failed to delete facilitator');
    }
  }

  /**
   * N.6.3 — aggregated insights for the facilitator UID page. Defaults
   * to the last 90 days when no `from` / `to` are supplied.
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
      const payload = await facilitatorInsightsService.get({
        facilitatorId: id,
        from,
        to,
        locationId: str(req.query.locationId),
        serviceId: str(req.query.serviceId),
        roomId: str(req.query.roomId),
        clientId: str(req.query.clientId),
      });
      res.json(payload);
    } catch (error) {
      sendError(res, error, 'Failed to compute facilitator insights');
    }
  }
}
