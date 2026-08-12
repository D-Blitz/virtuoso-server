-- Venue-level weekly opening hours. Rooms inherit these unless they set
-- their own, so a school with one schedule across ten rooms configures
-- it once.
-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "openingHours" JSONB;

-- Room.availability becomes nullable: NULL now means "inherit the
-- location's openingHours". A non-null value is an explicit override
-- that a change at the location never touches.
-- AlterTable
ALTER TABLE "Room" ALTER COLUMN "availability" DROP NOT NULL;

-- Backfill. An empty object was never a deliberate "this room is open at
-- no time" — it's what the form and the CSV import wrote when nobody
-- filled the field in. Those rooms become NULL so they start inheriting.
-- Rooms holding real windows keep them, as explicit overrides.
-- ('null'::jsonb is included because Prisma's non-nullable Json allowed
-- a JSON null to be stored in the NOT NULL column.)
UPDATE "Room"
SET "availability" = NULL
WHERE "availability" = '{}'::jsonb
   OR "availability" = 'null'::jsonb;
