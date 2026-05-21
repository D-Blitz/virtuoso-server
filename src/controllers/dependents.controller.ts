import { Request, Response } from 'express';
import { DependentsService } from '../services/dependents.service';
import { sendError } from './httpErrors';

const service = new DependentsService();

export class DependentsController {
  /**
   * GET /api/dependents/:entityType/:id
   *
   * Returns the active references that depend on the target row, used
   * by the admin "delete impact preview" modal. The endpoint is read-
   * only; the soft-delete policy itself isn't changing in v1 — this is
   * purely informational so the admin sees the impact before confirming.
   */
  async list(req: Request, res: Response) {
    try {
      const { entityType, id } = req.params;
      const rows = await service.countFor(entityType, id);
      res.json({ dependents: rows });
    } catch (error) {
      sendError(res, error, 'Failed to load dependents');
    }
  }
}
