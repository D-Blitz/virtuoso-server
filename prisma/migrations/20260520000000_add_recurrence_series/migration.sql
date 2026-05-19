-- Phase 0.2 — Recurrence series + occurrence linking.
-- Design: docs/RECURRENCE_DESIGN.md
--
-- Pre-launch shortcut: we DELETE existing recurring test rows rather than
-- translating them into the new model. There is no production data to
-- protect. Code path that wrote the legacy `recurrence` / `recurrenceEnd`
-- columns is removed in a follow-up commit; those columns are dropped in
-- a separate later migration once nothing reads them.

-- 1. Nuke any existing recurring test events.
DELETE FROM "ScheduledEvent" WHERE "recurrence" IS NOT NULL;

-- 2. New table: RecurrenceSeries
CREATE TABLE "RecurrenceSeries" (
    "id"               TEXT NOT NULL,
    "frequency"        TEXT NOT NULL,
    "startDate"        TIMESTAMP(3) NOT NULL,
    "endDate"          TIMESTAMP(3) NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'ACTIVE',
    "defaultColor"     TEXT NOT NULL,
    "defaultPrice"     DOUBLE PRECISION NOT NULL,
    "defaultNotes"     TEXT,
    "defaultRoomId"    TEXT NOT NULL,
    "defaultLocationId" TEXT NOT NULL,
    "defaultServiceId" TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    "organizationId"   TEXT NOT NULL,

    CONSTRAINT "RecurrenceSeries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecurrenceSeries_organizationId_startDate_idx"
  ON "RecurrenceSeries" ("organizationId", "startDate");

ALTER TABLE "RecurrenceSeries"
  ADD CONSTRAINT "RecurrenceSeries_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Link from ScheduledEvent → RecurrenceSeries (nullable; null = standalone).
ALTER TABLE "ScheduledEvent"
  ADD COLUMN "seriesId" TEXT;

CREATE INDEX "ScheduledEvent_seriesId_idx" ON "ScheduledEvent" ("seriesId");

ALTER TABLE "ScheduledEvent"
  ADD CONSTRAINT "ScheduledEvent_seriesId_fkey"
  FOREIGN KEY ("seriesId") REFERENCES "RecurrenceSeries"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
