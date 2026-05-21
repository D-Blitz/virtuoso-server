import { Request, Response } from 'express';
import { ClosureService } from '../services/closure.service';
import { sendError } from './httpErrors';

const closureService = new ClosureService();

export class ClosureController {
  async create(req: Request, res: Response) {
    try {
      const closure = await closureService.create(req.body);
      res.status(201).json(closure);
    } catch (error) {
      sendError(res, error, 'Failed to create closure');
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const closures = await closureService.getAll();
      res.json(closures);
    } catch (error) {
      sendError(res, error, 'Failed to fetch closures');
    }
  }

  async update(req: Request, res: Response) {
    try {
      const updated = await closureService.update(req.params.id, req.body);
      res.json(updated);
    } catch (error) {
      sendError(res, error, 'Failed to update closure');
    }
  }

  async remove(req: Request, res: Response) {
    try {
      await closureService.delete(req.params.id);
      res.status(204).send();
    } catch (error) {
      sendError(res, error, 'Failed to delete closure');
    }
  }
}
