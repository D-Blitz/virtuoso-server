-- M.1 — grant the messaging-center permissions to system (Propriétaire)
-- roles on existing orgs. New orgs derive Propriétaire from the Prisma
-- enum (ALL_PERMISSIONS), so they already include these; this only
-- corrects orgs seeded before the messaging center landed. Idempotent.
UPDATE "Role"
SET "permissions" = "permissions" || ARRAY['MESSAGE_VIEW', 'MESSAGE_SEND']::"Permission"[]
WHERE "isSystem" = true
  AND NOT ('MESSAGE_VIEW' = ANY ("permissions"));
