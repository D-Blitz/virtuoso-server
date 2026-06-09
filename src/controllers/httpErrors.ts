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
 *
 * Response shape (N.8.2):
 *   { messageCode, summary, error, code? }
 *
 *   - `messageCode`  — stable i18n key (preferred by the admin frontend
 *                      via the `errors` namespace in messages/{fr,en}.json).
 *                      One of the values in ERROR_MESSAGE_CODE below.
 *   - `summary`      — French fallback the frontend falls back to when
 *                      it doesn't recognise messageCode (e.g. a brand-new
 *                      code added by the server before the admin ships
 *                      its translation).
 *   - `error`        — technical detail line. NOT translated; the admin
 *                      surfaces it in a "details" expander.
 *   - `code`         — original Prisma error code (P2025, P2003, …) when
 *                      we're forwarding a Prisma exception.
 *
 * Adding a new code: add the literal to ERROR_MESSAGE_CODE here, then
 * mirror it in artcetera_admin/messages/{fr,en}.json under "errors".
 * No type wiring needed — the frontend hook reads it loosely with a
 * fallback path.
 */

/**
 * Closed set of message codes the backend produces. Keep this aligned
 * with the `errors` namespace in admin/messages/{fr,en}.json. When you
 * add a code here:
 *   1. Pick or extend a `summary` (French fallback) in the relevant
 *      branch below.
 *   2. Add the same key to fr.json AND en.json under "errors".
 *      (Both must exist — that's the same-shape rule from N.8.1.)
 */
export const ERROR_MESSAGE_CODE = {
  NOT_FOUND: 'NOT_FOUND',
  UNIQUE_CONFLICT: 'UNIQUE_CONFLICT',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL',
  TRASH_NOT_FOUND: 'TRASH_NOT_FOUND',
  FACILITATOR_HAS_PAYMENTS: 'FACILITATOR_HAS_PAYMENTS',
  FK_BLOCKED: 'FK_BLOCKED',
  FK_PAYMENT_CLIENT: 'FK_PAYMENT_CLIENT',
  FK_PAYMENT_EVENT: 'FK_PAYMENT_EVENT',
  FK_ENROLLMENT_CLIENT: 'FK_ENROLLMENT_CLIENT',
  FK_ENROLLMENT_FACILITATOR: 'FK_ENROLLMENT_FACILITATOR',
  FK_ENROLLMENT_ROOM: 'FK_ENROLLMENT_ROOM',
  FK_ENROLLMENT_LOCATION: 'FK_ENROLLMENT_LOCATION',
  FK_ENROLLMENT_SERVICE: 'FK_ENROLLMENT_SERVICE',
  FK_ENROLLMENT_TERM: 'FK_ENROLLMENT_TERM',
  FK_EVENT_ROOM: 'FK_EVENT_ROOM',
  FK_EVENT_LOCATION: 'FK_EVENT_LOCATION',
  FK_EVENT_SERVICE: 'FK_EVENT_SERVICE',
  FK_EVENT_CATEGORY: 'FK_EVENT_CATEGORY',
  FK_ROOM_LOCATION: 'FK_ROOM_LOCATION',
} as const;

export type ErrorMessageCode =
  (typeof ERROR_MESSAGE_CODE)[keyof typeof ERROR_MESSAGE_CODE];
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
        res.status(404).json({
          messageCode: ERROR_MESSAGE_CODE.NOT_FOUND,
          summary: 'Cet élément est introuvable ou a déjà été supprimé.',
          error: err.message || 'Élément introuvable ou déjà supprimé.',
          code: err.code,
        });
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
        const ref = describeBlockingReference(constraint);
        const detailSuffix = ref.detail
          ? ` ${ref.detail}`
          : constraint
            ? ` (contrainte : ${constraint})`
            : '';
        res.status(409).json({
          messageCode: ref.messageCode ?? ERROR_MESSAGE_CODE.FK_BLOCKED,
          summary:
            ref.summary ??
            'Cet élément ne peut pas être supprimé car il est lié à d’autres données.',
          error:
            `Suppression bloquée — cet élément est encore référencé.${detailSuffix}`,
          code: err.code,
        });
        return;
      }
      case 'P2002':
        res.status(409).json({
          messageCode: ERROR_MESSAGE_CODE.UNIQUE_CONFLICT,
          summary: 'Une autre entrée utilise déjà cette valeur.',
          error:
            'Conflit d’unicité — un élément avec cette valeur existe déjà.',
          code: err.code,
        });
        return;
      default:
        res.status(400).json({
          messageCode: ERROR_MESSAGE_CODE.BAD_REQUEST,
          summary: 'La requête a été refusée par la base de données.',
          error: err.message || fallbackMessage,
          code: err.code,
        });
        return;
    }
  }

  // Non-Prisma exception (or PrismaClientUnknownRequestError when the
  // connector failed to classify the underlying Postgres error — see
  // the "client + payment hard-delete" report: the user_facing_error
  // came back as `None`, which means Prisma threw the *Unknown*
  // variant, which our instanceof check above misses).
  //
  // Fall through to message-pattern detection so we still recognise
  // the common cases:
  //   - Postgres FK violation       → 409, with a tailored summary
  //   - Manual "paiement"/"anonymiser" throws (e.g. the facilitator
  //     guard in trash.service.purge) → 409
  //   - Manual "no trashed" throws (trash service)                  → 404
  // Everything else falls to a generic 500 with the raw message.
  const msg =
    err instanceof Error && err.message ? err.message : fallbackMessage;
  const lower = msg.toLowerCase();

  // Postgres FK violation pattern. We need to be permissive about
  // quoting because Prisma's error message embeds the raw Rust debug
  // output of the ConnectorError — which has its own escaped quotes,
  // so the actual JS string can contain \"X_fkey\" (literal backslash
  // + quote), not just "X_fkey". Strategy: scan for the constraint
  // name pattern <Model>_<column>_fkey anywhere in the message; the
  // surrounding quote/backslash chars are irrelevant.
  const fkMatch =
    msg.match(/foreign key constraint failed on the field:\s*([A-Za-z_]+)/i) ??
    msg.match(/([A-Z][A-Za-z0-9]+_[A-Za-z0-9]+_fkey)/);
  if (fkMatch) {
    const constraint = fkMatch[1];
    const ref = describeBlockingReference(constraint);
    res.status(409).json({
      messageCode: ref.messageCode ?? ERROR_MESSAGE_CODE.FK_BLOCKED,
      summary:
        ref.summary ??
        'Cet élément ne peut pas être supprimé car il est lié à d’autres données.',
      error: ref.detail
        ? `Suppression bloquée — ${ref.detail}`
        : `Suppression bloquée — référence existante (${constraint}).`,
      code: 'P2003',
    });
    return;
  }

  // Manual policy throws from services (e.g. the Facilitator+Payment
  // guard) — recognized by keywords in the French message.
  if (lower.includes('no trashed')) {
    res.status(404).json({
      messageCode: ERROR_MESSAGE_CODE.TRASH_NOT_FOUND,
      summary: 'Cet élément n’est plus dans la corbeille.',
      error: msg,
    });
    return;
  }
  if (lower.includes('paiement') || lower.includes('anonymiser')) {
    res.status(409).json({
      messageCode: ERROR_MESSAGE_CODE.FACILITATOR_HAS_PAYMENTS,
      summary:
        'Cet intervenant a des paiements liés et ne peut pas être supprimé définitivement.',
      error: msg,
    });
    return;
  }

  res.status(500).json({
    messageCode: ERROR_MESSAGE_CODE.INTERNAL,
    summary: 'Une erreur serveur est survenue.',
    error: msg,
  });
}

/**
 * Like `sendError`, but first honours an explicit `statusCode` set on the
 * thrown error. Services in the Phase-1.9 surface (InvoiceService,
 * PaymentService) throw plain `Error & { statusCode }` for validation /
 * not-found / conflict cases; this surfaces the intended HTTP status
 * directly instead of letting it fall through to the Prisma + message
 * pattern matching (which would mislabel, e.g., a 400 as 500).
 *
 * Kept as a separate helper so the existing `sendError` callers are
 * completely unaffected.
 */
export function sendServiceError(
  res: Response,
  err: unknown,
  fallbackMessage: string,
): void {
  const statusCode = (err as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) {
    console.error(fallbackMessage, err);
    // N.8.2 — service errors don't currently carry a code dimension
    // (they're throw-with-statusCode from validation paths). Pick a
    // matching messageCode by status family so the admin still gets a
    // translated message rather than the raw `error` line.
    const messageCode =
      statusCode === 404
        ? ERROR_MESSAGE_CODE.NOT_FOUND
        : statusCode === 409
          ? ERROR_MESSAGE_CODE.UNIQUE_CONFLICT
          : statusCode >= 500
            ? ERROR_MESSAGE_CODE.INTERNAL
            : ERROR_MESSAGE_CODE.BAD_REQUEST;
    res.status(statusCode).json({
      messageCode,
      error: err instanceof Error && err.message ? err.message : fallbackMessage,
    });
    return;
  }
  sendError(res, err, fallbackMessage);
}

/**
 * Maps the few FK constraint names admins actually encounter into
 * plain-French descriptions. Returns both a `summary` (for the modal's
 * primary headline, no jargon) and a `detail` (the explanation the
 * admin would want when troubleshooting).
 *
 * Constraint names follow Postgres conventions:
 *   <ChildTable>_<columnName>_fkey
 * e.g. "Payment_clientId_fkey" means rows in Payment with this clientId
 * are blocking the delete.
 */
export function describeBlockingReference(constraint: string): {
  messageCode?: ErrorMessageCode;
  summary?: string;
  detail?: string;
} {
  switch (constraint) {
    case 'Payment_clientId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_PAYMENT_CLIENT,
        summary: 'Ce client a des paiements liés et ne peut pas être supprimé définitivement.',
        detail:
          'Des paiements lui sont liés (conservés pour la comptabilité). Utilisez "Anonymiser" plutôt que la suppression définitive.',
      };
    case 'Payment_relatedScheduledEventId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_PAYMENT_EVENT,
        summary: 'Cet événement a des paiements liés et ne peut pas être supprimé définitivement.',
        detail: 'Des paiements référencent cet événement.',
      };
    case 'Enrollment_clientId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_ENROLLMENT_CLIENT,
        summary: 'Ce client a des inscriptions en cours.',
        detail: 'Des inscriptions sont liées à ce client.',
      };
    case 'Enrollment_facilitatorId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_ENROLLMENT_FACILITATOR,
        summary: 'Cet intervenant a des inscriptions en cours.',
        detail: 'Des inscriptions sont liées à cet intervenant.',
      };
    case 'Enrollment_roomId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_ENROLLMENT_ROOM,
        summary: 'Cette salle est utilisée par des inscriptions.',
        detail: 'Des inscriptions utilisent cette salle.',
      };
    case 'Enrollment_locationId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_ENROLLMENT_LOCATION,
        summary: 'Cet établissement a des inscriptions en cours.',
        detail: 'Des inscriptions sont liées à cet établissement.',
      };
    case 'Enrollment_serviceId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_ENROLLMENT_SERVICE,
        summary: 'Ce service a des inscriptions en cours.',
        detail: 'Des inscriptions utilisent ce service.',
      };
    case 'Enrollment_termId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_ENROLLMENT_TERM,
        summary: 'Ce trimestre a des inscriptions liées.',
        detail: 'Des inscriptions sont liées à ce trimestre.',
      };
    case 'ScheduledEvent_roomId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_EVENT_ROOM,
        summary: 'Cette salle est utilisée par des événements.',
        detail: 'Des événements utilisent cette salle.',
      };
    case 'ScheduledEvent_locationId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_EVENT_LOCATION,
        summary: 'Cet établissement a des événements programmés.',
        detail: 'Des événements sont liés à cet établissement.',
      };
    case 'ScheduledEvent_serviceId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_EVENT_SERVICE,
        summary: 'Ce service est utilisé par des événements.',
        detail: 'Des événements utilisent ce service.',
      };
    case 'ScheduledEvent_serviceCategoryId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_EVENT_CATEGORY,
        summary: 'Cette catégorie est utilisée par des événements.',
        detail: 'Des événements utilisent cette catégorie.',
      };
    case 'Room_locationId_fkey':
      return {
        messageCode: ERROR_MESSAGE_CODE.FK_ROOM_LOCATION,
        summary: 'Cet établissement contient des salles.',
        detail: 'Des salles dépendent de cet établissement.',
      };
    default:
      return {};
  }
}
