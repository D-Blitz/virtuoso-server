import { Response } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Shared error mapping for entity controller catch blocks. The previous
 * pattern — bare catch → 500 → generic message — hid the real cause of
 * failures and made every operational issue look identical to the
 * frontend (cf. the "client delete 500" debugging session). This helper
 * centralizes the mapping so all entity controllers behave consistently
 * and the response body always carries the actual error message.
 *
 * Mapping rules:
 *   - Prisma P2025 (record not found / scoping miss) → 404
 *   - Prisma P2003 (FK constraint) → 409 (would only fire on hard delete
 *     today, but keep it future-proof)
 *   - Prisma P2002 (unique constraint) → 409
 *   - Other PrismaClientKnownRequestError → 400 (caller's fault)
 *   - Anything else → 500 with the error's message
 *
 * Always logs the full error to stderr first so the server log has the
 * stack trace; the response body only carries the message string.
 */
export function sendError(
  res: Response,
  err: unknown,
  fallbackMessage: string,
): void {
  // Log first so the server-side trail is always complete, even when the
  // mapping below picks a non-500 status that callers might filter.
  console.error(fallbackMessage, err);

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2025':
        res
          .status(404)
          .json({ error: err.message || 'Élément introuvable ou déjà supprimé.' });
        return;
      case 'P2003': {
        // P2003 fires on hard-deletes (and updates that violate FKs)
        // when the row is still referenced. The most useful detail is
        // which constraint blocked us — that tells the admin *what* is
        // pointing at the row. Prisma exposes this as `meta.field_name`
        // (newer versions) or `meta.constraint` (older). We try both
        // and translate the few constraint names admins are likely to
        // encounter into plain French.
        const meta = (err.meta ?? {}) as Record<string, unknown>;
        const constraint =
          (typeof meta.field_name === 'string' && meta.field_name) ||
          (typeof meta.constraint === 'string' && meta.constraint) ||
          '';
        const what = describeBlockingReference(constraint);
        const detail = what
          ? ` ${what}`
          : constraint
            ? ` (contrainte : ${constraint})`
            : '';
        res.status(409).json({
          error:
            `Suppression bloquée — cet élément est encore référencé.${detail}`,
          code: err.code,
        });
        return;
      }
      case 'P2002':
        res.status(409).json({
          error:
            'Conflit d’unicité — un élément avec cette valeur existe déjà.',
          code: err.code,
        });
        return;
      default:
        res
          .status(400)
          .json({ error: err.message || fallbackMessage, code: err.code });
        return;
    }
  }

  // Non-Prisma exception: surface the message so we stop debugging blind
  // 500s. The original behavior used a hardcoded string here, which is
  // what hid the "client delete 500" root cause for so long.
  const msg =
    err instanceof Error && err.message ? err.message : fallbackMessage;
  res.status(500).json({ error: msg });
}

/**
 * Maps the few FK constraint names admins actually encounter into
 * plain-French descriptions. Returning '' falls back to the generic
 * "(contrainte : X)" suffix so we never hide info the admin might need
 * to grep the schema for.
 *
 * Constraint names follow Postgres conventions:
 *   <ChildTable>_<columnName>_fkey
 * e.g. "Payment_clientId_fkey" means rows in Payment with this clientId
 * are blocking the delete.
 */
function describeBlockingReference(constraint: string): string {
  switch (constraint) {
    case 'Payment_clientId_fkey':
      return 'Des paiements lui sont liés (conservés pour la comptabilité). Utilisez "Anonymiser" plutôt que la suppression définitive.';
    case 'Payment_relatedScheduledEventId_fkey':
      return 'Des paiements référencent cet événement.';
    case 'Enrollment_clientId_fkey':
      return 'Des inscriptions sont liées à ce client.';
    case 'Enrollment_facilitatorId_fkey':
      return 'Des inscriptions sont liées à cet intervenant.';
    case 'Enrollment_roomId_fkey':
      return 'Des inscriptions utilisent cette salle.';
    case 'Enrollment_locationId_fkey':
      return 'Des inscriptions sont liées à cet établissement.';
    case 'Enrollment_serviceId_fkey':
      return 'Des inscriptions utilisent ce service.';
    case 'Enrollment_termId_fkey':
      return 'Des inscriptions sont liées à ce trimestre.';
    case 'ScheduledEvent_roomId_fkey':
      return 'Des événements utilisent cette salle.';
    case 'ScheduledEvent_locationId_fkey':
      return 'Des événements sont liés à cet établissement.';
    case 'ScheduledEvent_serviceId_fkey':
      return 'Des événements utilisent ce service.';
    case 'ScheduledEvent_serviceCategoryId_fkey':
      return 'Des événements utilisent cette catégorie.';
    case 'Room_locationId_fkey':
      return 'Des salles dépendent de cet établissement.';
    default:
      return '';
  }
}
