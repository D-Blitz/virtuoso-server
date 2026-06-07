import { Request, Response } from 'express';
import {
  isSearchKind,
  SEARCH_PAGE_SIZE,
  searchService,
} from '../services/search.service';
import { getContext } from '../auth/context';
import { sendError } from './httpErrors';

function parseIntOr(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export class SearchController {
  async search(req: Request, res: Response) {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const ctx = getContext();
      const permissions = ctx?.permissions ?? new Set();

      // Single-kind paginated load (palette "Load more"). When `kind` is
      // supplied, the response is one group with the requested page;
      // otherwise it's the initial all-groups payload.
      const kindParam = req.query.kind;
      if (typeof kindParam === 'string' && kindParam.length > 0) {
        if (!isSearchKind(kindParam)) {
          res.status(400).json({ error: `Unknown kind: ${kindParam}` });
          return;
        }
        const offset = parseIntOr(req.query.offset, 0);
        const limit = parseIntOr(req.query.limit, SEARCH_PAGE_SIZE);
        const group = await searchService.searchKind(
          q,
          kindParam,
          permissions,
          { offset, limit },
        );
        res.json({ query: q, group });
        return;
      }

      const out = await searchService.search(q, permissions);
      res.json(out);
    } catch (error) {
      sendError(res, error, 'Failed to search');
    }
  }
}
