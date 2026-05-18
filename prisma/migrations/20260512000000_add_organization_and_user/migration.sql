-- =========================================================================
-- PR 1: Multi-tenant foundation + Auth.js User model
-- Strategy: in-place backfill (path B). Existing data is preserved by
-- attaching every row to a single default Organization.
-- =========================================================================

-- ---------- 1. Create Organization ----------
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'fr-FR',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- ---------- 2. Insert default org (the only tenant for v1) ----------
INSERT INTO "Organization" ("id", "slug", "name")
VALUES ('clxorg000000000000000001', 'artcetera', 'Art & Cetera');

-- ---------- 3. Create User ----------
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "facilitatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_facilitatorId_key" ON "User"("facilitatorId");
CREATE UNIQUE INDEX "User_organizationId_email_key" ON "User"("organizationId", "email");

ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "User" ADD CONSTRAINT "User_facilitatorId_fkey"
    FOREIGN KEY ("facilitatorId") REFERENCES "Facilitator"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- 4. Add organizationId (nullable) to every tenant table ----------
ALTER TABLE "Location"        ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Facilitator"     ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Room"            ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Client"          ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Tag"             ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Service"         ADD COLUMN "organizationId" TEXT;
ALTER TABLE "ServiceCategory" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "ScheduledEvent"  ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Term"            ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Enrollment"      ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Closure"         ADD COLUMN "organizationId" TEXT;

-- ---------- 5. Backfill every row to the default org ----------
UPDATE "Location"        SET "organizationId" = 'clxorg000000000000000001';
UPDATE "Facilitator"     SET "organizationId" = 'clxorg000000000000000001';
UPDATE "Room"            SET "organizationId" = 'clxorg000000000000000001';
UPDATE "Client"          SET "organizationId" = 'clxorg000000000000000001';
UPDATE "Tag"             SET "organizationId" = 'clxorg000000000000000001';
UPDATE "Service"         SET "organizationId" = 'clxorg000000000000000001';
UPDATE "ServiceCategory" SET "organizationId" = 'clxorg000000000000000001';
UPDATE "ScheduledEvent"  SET "organizationId" = 'clxorg000000000000000001';
UPDATE "Term"            SET "organizationId" = 'clxorg000000000000000001';
UPDATE "Enrollment"      SET "organizationId" = 'clxorg000000000000000001';
UPDATE "Closure"         SET "organizationId" = 'clxorg000000000000000001';

-- ---------- 6. Lock organizationId to NOT NULL ----------
ALTER TABLE "Location"        ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Facilitator"     ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Room"            ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Client"          ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Tag"             ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Service"         ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ServiceCategory" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ScheduledEvent"  ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Term"            ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Enrollment"      ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Closure"         ALTER COLUMN "organizationId" SET NOT NULL;

-- ---------- 7. Add FK constraints ----------
ALTER TABLE "Location" ADD CONSTRAINT "Location_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Facilitator" ADD CONSTRAINT "Facilitator_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Room" ADD CONSTRAINT "Room_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Client" ADD CONSTRAINT "Client_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Tag" ADD CONSTRAINT "Tag_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Service" ADD CONSTRAINT "Service_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ServiceCategory" ADD CONSTRAINT "ServiceCategory_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduledEvent" ADD CONSTRAINT "ScheduledEvent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Term" ADD CONSTRAINT "Term_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Closure" ADD CONSTRAINT "Closure_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- 8. Repair Room.name unique constraint to be per-org ----------
DROP INDEX "Room_name_key";
CREATE UNIQUE INDEX "Room_organizationId_name_key" ON "Room"("organizationId", "name");
