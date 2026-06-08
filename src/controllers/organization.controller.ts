import { Request, Response } from 'express';
import { OrganizationService } from '../services/organization/organization.service';
import { orgInsightsService } from '../services/orgInsights.service';
import { sendError } from './httpErrors';

const service = new OrganizationService();

function parseDateOr(raw: unknown, fallback: Date): Date {
  if (typeof raw !== 'string' || !raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export class OrganizationController {
  /** GET /api/organizations/me — current org settings */
  async getMe(_req: Request, res: Response) {
    try {
      const row = await service.getSettings();
      res.json(row);
    } catch (err) {
      sendError(res, err, 'Failed to load organization settings');
    }
  }

  /** PATCH /api/organizations/me — partial update */
  async updateMe(req: Request, res: Response) {
    try {
      const row = await service.updateSettings(req.body ?? {});
      res.json(row);
    } catch (err) {
      sendError(res, err, 'Failed to update organization settings');
    }
  }

  /**
   * N.6.9 — GET /api/organizations/me/insights. Org-wide aggregated
   * dashboard payload for /admin/dashboard. Defaults to the last 90
   * days. Optional filters: locationId / serviceId / facilitatorId.
   */
  async insights(req: Request, res: Response) {
    try {
      const now = new Date();
      const from = parseDateOr(
        req.query.from,
        new Date(now.getTime() - 90 * 24 * 3600_000),
      );
      const to = parseDateOr(req.query.to, now);
      const str = (raw: unknown): string | undefined =>
        typeof raw === 'string' && raw.length > 0 ? raw : undefined;
      const payload = await orgInsightsService.get({
        from,
        to,
        locationId: str(req.query.locationId),
        serviceId: str(req.query.serviceId),
        facilitatorId: str(req.query.facilitatorId),
      });
      res.json(payload);
    } catch (err) {
      sendError(res, err, 'Failed to compute organization insights');
    }
  }
}
