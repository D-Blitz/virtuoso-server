import { Request, Response } from 'express';
import { getContext } from '../auth/context';
import {
  ANONYMIZABLE_ENTITY_TYPES,
  AnonymizeService,
  type AnonymizableEntityType,
} from '../services/anonymize/anonymize.service';
import { sendError } from './httpErrors';

const service = new AnonymizeService();
const VALID_TYPES: Set<string> = new Set(ANONYMIZABLE_ENTITY_TYPES);

/**
 * Anonymization is a GDPR / retention operation — OWNER/ADMIN only.
 * Same guard as trash + archive; will tighten once 0.3 permissions
 * formalizes a dedicated `can_manage_pii`.
 */
function guardAdminOnly(res: Response): boolean {
  const ctx = getContext();
  const role = ctx?.role;
  if (role !== 'OWNER' && role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

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
    if (!guardAdminOnly(res)) return;
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
