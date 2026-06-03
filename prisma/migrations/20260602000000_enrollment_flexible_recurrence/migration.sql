-- Enrollment: flexible recurrence.
--
-- Until June 2026 Enrollment hardcoded weekly recurrence via a
-- required `weekday Int` column. To support DAILY / BIWEEKLY /
-- MONTHLY / and arbitrary CUSTOM date lists, we:
--   1. Add `frequency String NOT NULL DEFAULT 'WEEKLY'`.
--      Existing rows backfill cleanly via the default (they were
--      weekly by definition).
--   2. Make `weekday` nullable (DAILY / CUSTOM don't need it).
--      Existing rows keep their value — the new generator still
--      reads it when frequency='WEEKLY'.
--   3. Add `customDates JSONB NULL` for CUSTOM-frequency rows.
--      JSON array of ISO datetime strings, one per occurrence.

ALTER TABLE "Enrollment"
  ADD COLUMN "frequency" TEXT NOT NULL DEFAULT 'WEEKLY';

ALTER TABLE "Enrollment"
  ALTER COLUMN "weekday" DROP NOT NULL;

ALTER TABLE "Enrollment"
  ADD COLUMN "customDates" JSONB;
