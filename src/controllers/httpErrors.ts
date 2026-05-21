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
      case 'P2003':
        res.status(409).json({
          error:
            'Suppression bloquée par une référence existante (clé étrangère).',
          code: err.code,
        });
        return;
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
