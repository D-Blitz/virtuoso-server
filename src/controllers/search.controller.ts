import { Request, Response } from 'express';
import { searchService } from '../services/search.service';
import { getContext } from '../auth/context';
import { sendError } from './httpErrors';

export class SearchController {
  async search(req: Request, res: Response) {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const ctx = getContext();
      const permissions = ctx?.permissions ?? new Set();
      const out = await searchService.search(q, permissions);
      res.json(out);
    } catch (error) {
      sendError(res, error, 'Failed to search');
    }
  }
}
