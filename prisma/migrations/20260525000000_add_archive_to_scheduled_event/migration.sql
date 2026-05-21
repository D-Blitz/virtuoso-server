-- Phase 6.11 follow-up — add archive columns to ScheduledEvent so
-- past events can be archived from the calendar (right-click → Archiver).
-- Mirrors the existing trash columns on the same table; same indexing
-- pattern.

ALTER TABLE "ScheduledEvent" ADD COLUMN "archivedAt"   TIMESTAMP(3);
ALTER TABLE "ScheduledEvent" ADD COLUMN "archivedById" TEXT;
CREATE INDEX "ScheduledEvent_archivedAt_idx" ON "ScheduledEvent" ("archivedAt");
