import { Request, Response } from 'express';
import { ClientService } from '../services/client.service';
import { clientInsightsService } from '../services/clientInsights.service';
import { sendError } from './httpErrors';

const clientService = new ClientService();

function parseDateOr(raw: unknown, fallback: Date): Date {
  if (typeof raw !== 'string' || !raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export class ClientController {
  async create(req: Request, res: Response) {
    try {
      const client = await clientService.create(req.body);
      res.status(201).json(client);
    } catch (error) {
      sendError(res, error, 'Failed to create client');
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const clients = await clientService.getAll();
      res.json(clients);
    } catch (error) {
      sendError(res, error, 'Failed to fetch clients');
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await clientService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      sendError(res, error, 'Failed to update client');
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await clientService.delete(id);
      res.status(204).send();
    } catch (error) {
      sendError(res, error, 'Failed to delete client');
    }
  }

  /**
   * N.6.8 — aggregated spending + activity insights for the UID page.
   * Defaults to the last 90 days when no `from` / `to` query params.
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
      const payload = await clientInsightsService.get({
        clientId: id,
        from,
        to,
        facilitatorId: str(req.query.facilitatorId),
        locationId: str(req.query.locationId),
        serviceId: str(req.query.serviceId),
        roomId: str(req.query.roomId),
      });
      res.json(payload);
    } catch (error) {
      sendError(res, error, 'Failed to compute client insights');
    }
  }
}
