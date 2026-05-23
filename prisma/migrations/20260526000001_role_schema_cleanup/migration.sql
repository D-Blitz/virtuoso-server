-- Phase 0.3 — Cleanup against granular_permissions (auto-generated).
--
-- Originally Prisma named this `20260522094628_user_disabled` from a
-- timestamp that placed it BEFORE 20260526000000_granular_permissions,
-- which creates the tables this alters — breaking any fresh-DB replay
-- (shadow DB, CI, prod bootstrap). Renamed to sort after its
-- dependencies; effects already applied on existing DBs.
--
-- Changes:
--   - Role.updatedAt: drop the CURRENT_TIMESTAMP default that my
--     manually-written granular_permissions migration set. Prisma's
--     @updatedAt directive manages this column at the app layer; the
--     DB default was redundant and Prisma's schema-diff flagged it.
--   - UserPermissionScope unique index: rename to fit Postgres's 63-char
--     identifier cap (the original name was truncated mid-word).

ALTER TABLE "Role" ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER INDEX "UserPermissionScope_userId_permission_resourceType_resourceId_k"
  RENAME TO "UserPermissionScope_userId_permission_resourceType_resource_key";
