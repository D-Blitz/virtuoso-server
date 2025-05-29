import { Request, Response } from 'express';
import { ContextService } from '../services/context.service';

const contextService = new ContextService();

export class ContextController {
  async get(_req: Request, res: Response) {
    try {
      const data = await contextService.getFullContext();
      res.json(data);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch context' });
    }
  }

  async create(_req: Request, res: Response) {
    res.status(501).json({ error: 'Creating context is not supported.' });
  }

  async update(_req: Request, res: Response) {
    res.status(501).json({ error: 'Updating context is not supported.' });
  }

  async remove(_req: Request, res: Response) {
    res.status(501).json({ error: 'Deleting context is not supported.' });
  }
}
