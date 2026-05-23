import { Request, Response } from 'express';
import { OrganizationService } from '../services/organization/organization.service';
import { sendError } from './httpErrors';

const service = new OrganizationService();

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
}
