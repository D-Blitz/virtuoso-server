-- Phase 6.11 — Archive feature: add archivedAt + archivedById to the 6
-- soft-archivable models (Client, Facilitator, Term, Service, Location,
-- Room). Mirrors the 0.5 trash-bin schema; the two states are mutually
-- exclusive (a row is in trash OR archive, never both — the TTL cron
-- enforces this by moving trashed-with-FK rows into archive instead of
-- leaving them stuck).
--
-- Pure additive; defaults null; safe to apply on a populated DB.

-- Client
ALTER TABLE "Client" ADD COLUMN "archivedAt"   TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "archivedById" TEXT;
CREATE INDEX "Client_archivedAt_idx" ON "Client" ("archivedAt");

-- Facilitator
ALTER TABLE "Facilitator" ADD COLUMN "archivedAt"   TIMESTAMP(3);
ALTER TABLE "Facilitator" ADD COLUMN "archivedById" TEXT;
CREATE INDEX "Facilitator_archivedAt_idx" ON "Facilitator" ("archivedAt");

-- Term
ALTER TABLE "Term" ADD COLUMN "archivedAt"   TIMESTAMP(3);
ALTER TABLE "Term" ADD COLUMN "archivedById" TEXT;
CREATE INDEX "Term_archivedAt_idx" ON "Term" ("archivedAt");

-- Service
ALTER TABLE "Service" ADD COLUMN "archivedAt"   TIMESTAMP(3);
ALTER TABLE "Service" ADD COLUMN "archivedById" TEXT;
CREATE INDEX "Service_archivedAt_idx" ON "Service" ("archivedAt");

-- Location
ALTER TABLE "Location" ADD COLUMN "archivedAt"   TIMESTAMP(3);
ALTER TABLE "Location" ADD COLUMN "archivedById" TEXT;
CREATE INDEX "Location_archivedAt_idx" ON "Location" ("archivedAt");

-- Room
ALTER TABLE "Room" ADD COLUMN "archivedAt"   TIMESTAMP(3);
ALTER TABLE "Room" ADD COLUMN "archivedById" TEXT;
CREATE INDEX "Room_archivedAt_idx" ON "Room" ("archivedAt");
