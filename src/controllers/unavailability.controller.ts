import { Request, Response } from 'express';
import {
  unavailabilityService,
  type UnavailabilityScope,
} from '../services/unavailability.service';
import { sendError } from './httpErrors';

function parseScope(raw: unknown): UnavailabilityScope {
  return raw === 'ALL' ? 'ALL' : 'THIS';
}

function parseDateParam(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export class UnavailabilityController {
  async list(req: Request, res: Response) {
    try {
      const rows = await unavailabilityService.list({
        from: parseDateParam(req.query.from),
        to: parseDateParam(req.query.to),
        facilitatorId:
          typeof req.query.facilitatorId === 'string'
            ? req.query.facilitatorId
            : undefined,
        roomId:
          typeof req.query.roomId === 'string' ? req.query.roomId : undefined,
      });
      res.json(rows);
    } catch (error) {
      sendError(res, error, 'Failed to list unavailabilities');
    }
  }

  async create(req: Request, res: Response) {
    try {
      const rows = await unavailabilityService.create(req.body);
      res.status(201).json(rows);
    } catch (error) {
      sendError(res, error, 'Failed to create unavailability');
    }
  }

  async update(req: Request, res: Response) {
    try {
      const scope = parseScope(req.query.scope);
      const row = await unavailabilityService.update(
        req.params.id,
        req.body,
        scope,
      );
      res.json(row);
    } catch (error) {
      sendError(res, error, 'Failed to update unavailability');
    }
  }

  async remove(req: Request, res: Response) {
    try {
      const scope = parseScope(req.query.scope);
      const result = await unavailabilityService.delete(req.params.id, scope);
      res.json(result);
    } catch (error) {
      sendError(res, error, 'Failed to delete unavailability');
    }
  }
}
