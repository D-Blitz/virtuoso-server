import { Request, Response } from 'express';
import { ServiceService } from '../services/service.service';
import { serviceInsightsService } from '../services/serviceInsights.service';
import { sendError } from './httpErrors';

const serviceService = new ServiceService();

function parseDateOr(raw: unknown, fallback: Date): Date {
  if (typeof raw !== 'string' || !raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export class ServiceController {
  async create(req: Request, res: Response) {
    try {
      const service = await serviceService.create(req.body);
      res.status(201).json(service);
    } catch (error) {
      sendError(res, error, 'Failed to create service');
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const services = await serviceService.getAll();
      res.json(services);
    } catch (error) {
      sendError(res, error, 'Failed to fetch services');
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await serviceService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      sendError(res, error, 'Failed to update service');
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await serviceService.delete(id);
      res.status(204).send();
    } catch (error) {
      sendError(res, error, 'Failed to delete service');
    }
  }

  /**
   * N.7.14 — aggregated insights for the service UID page. Default
   * window: last 90 days.
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
      const payload = await serviceInsightsService.get({
        serviceId: id,
        from,
        to,
        facilitatorId: str(req.query.facilitatorId),
        clientId: str(req.query.clientId),
        roomId: str(req.query.roomId),
        locationId: str(req.query.locationId),
      });
      res.json(payload);
    } catch (error) {
      sendError(res, error, 'Failed to compute service insights');
    }
  }
}
