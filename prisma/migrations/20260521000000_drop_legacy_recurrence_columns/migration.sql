-- Phase 0.2 step 10 — Drop legacy recurrence columns from ScheduledEvent.
-- Nothing reads or writes them anymore (steps 3-8 ported every code path
-- to the RecurrenceSeries + seriesId model).
-- See docs/RECURRENCE_DESIGN.md.

ALTER TABLE "ScheduledEvent" DROP COLUMN "recurrence";
ALTER TABLE "ScheduledEvent" DROP COLUMN "recurrenceEnd";
