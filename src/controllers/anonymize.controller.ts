import { Request, Response } from 'express';
import {
  ANONYMIZABLE_ENTITY_TYPES,
  AnonymizeService,
  type AnonymizableEntityType,
} from '../services/anonymize/anonymize.service';
import { sendError } from './httpErrors';

const service = new AnonymizeService();
const VALID_TYPES: Set<string> = new Set(ANONYMIZABLE_ENTITY_TYPES);

// Phase 0.3: the in-controller guardAdminOnly helper has been replaced
// by `requirePermission('CLIENT_ANONYMIZE')` in routes/anonymize.routes.ts.

function parseEntityType(
  raw: unknown,
  res: Response,
): AnonymizableEntityType | null {
  if (typeof raw !== 'string' || !VALID_TYPES.has(raw)) {
    res.status(400).json({
      error: `Invalid entityType. Allowed: ${Array.from(VALID_TYPES).join(', ')}`,
    });
    return null;
  }
  return raw as AnonymizableEntityType;
}

export class AnonymizeController {
  /**
   * POST /api/anonymize/:entityType/:id
   *
   * Redacts personal columns on a trashed or archived Client /
   * Facilitator. Returns 204 on success, 400 if the row is still
   * active (admin must trash or archive first), 409 if already
   * anonymized.
   */
  async anonymize(req: Request, res: Response) {

    try {
      const entityType = parseEntityType(req.params.entityType, res);
      if (!entityType) return;
      await service.anonymize(entityType, req.params.id);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to anonymize');
    }
  }
}
