-- Phase 0.5 step 1 — Trash bin: add deletedAt + deletedById to 12 models.
-- Pure additive; defaults null; safe to apply on a populated DB.
-- See docs/TRASH_BIN_DESIGN.md.

-- ScheduledEvent
ALTER TABLE "ScheduledEvent" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "ScheduledEvent" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "ScheduledEvent_deletedAt_idx" ON "ScheduledEvent" ("deletedAt");

-- RecurrenceSeries
ALTER TABLE "RecurrenceSeries" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "RecurrenceSeries" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "RecurrenceSeries_deletedAt_idx" ON "RecurrenceSeries" ("deletedAt");

-- Facilitator
ALTER TABLE "Facilitator" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "Facilitator" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Facilitator_deletedAt_idx" ON "Facilitator" ("deletedAt");

-- Client
ALTER TABLE "Client" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Client_deletedAt_idx" ON "Client" ("deletedAt");

-- Service
ALTER TABLE "Service" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "Service" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Service_deletedAt_idx" ON "Service" ("deletedAt");

-- ServiceCategory
ALTER TABLE "ServiceCategory" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "ServiceCategory" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "ServiceCategory_deletedAt_idx" ON "ServiceCategory" ("deletedAt");

-- Location
ALTER TABLE "Location" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "Location" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Location_deletedAt_idx" ON "Location" ("deletedAt");

-- Room
ALTER TABLE "Room" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "Room" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Room_deletedAt_idx" ON "Room" ("deletedAt");

-- Tag
ALTER TABLE "Tag" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "Tag" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Tag_deletedAt_idx" ON "Tag" ("deletedAt");

-- Term
ALTER TABLE "Term" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "Term" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Term_deletedAt_idx" ON "Term" ("deletedAt");

-- Closure
ALTER TABLE "Closure" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "Closure" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Closure_deletedAt_idx" ON "Closure" ("deletedAt");

-- Enrollment
ALTER TABLE "Enrollment" ADD COLUMN "deletedAt"   TIMESTAMP(3);
ALTER TABLE "Enrollment" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Enrollment_deletedAt_idx" ON "Enrollment" ("deletedAt");
