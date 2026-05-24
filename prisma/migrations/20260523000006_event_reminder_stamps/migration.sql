-- Phase 1.2 — pre-event reminder timestamps on ScheduledEvent.
--
-- Two stamps support the T-48h and T-24h reminder cron jobs. Naming:
--   firstReminderSentAt  → 48h-before send (chronologically earlier)
--   secondReminderSentAt → 24h-before send (chronologically later)
--
-- The cron's query joins on `<stamp> IS NULL` so the same row can't
-- double-send within a polling window. No backfill needed — existing
-- events default to NULL and the cron's `startTime` window means past
-- events naturally fall outside its scope.
--
-- Partial index on each stamp (WHERE NULL) keeps the cron's hot-path
-- query cheap: the worker only scans rows that haven't been
-- reminded yet, which shrinks fast as events get reminded.

ALTER TABLE "ScheduledEvent" ADD COLUMN "firstReminderSentAt"  TIMESTAMP(3);
ALTER TABLE "ScheduledEvent" ADD COLUMN "secondReminderSentAt" TIMESTAMP(3);

CREATE INDEX "ScheduledEvent_firstReminderSentAt_startTime_idx"
  ON "ScheduledEvent" ("startTime")
  WHERE "firstReminderSentAt" IS NULL;

CREATE INDEX "ScheduledEvent_secondReminderSentAt_startTime_idx"
  ON "ScheduledEvent" ("startTime")
  WHERE "secondReminderSentAt" IS NULL;
