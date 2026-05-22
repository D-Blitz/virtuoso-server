-- Phase 0.3 — Granular permission system.
--
-- Replaces the freeform `User.role` string with a custom-role-per-org
-- model. Each Organization gets `Role` rows with a `permissions[]`
-- array; every User links to one. Per-user resource scoping (e.g.
-- "Sarah manages events for facilitators X, Y") lives in
-- `UserPermissionScope` rather than on the role itself, so two
-- teachers can share the same Enseignant role yet have different
-- managed-facilitator lists.
--
-- Data migration: seeds three default roles per org (Propriétaire /
-- Administrateur / Enseignant) with deterministic IDs derived from
-- the org id, maps the existing User.role strings to those rows,
-- then drops the legacy column.

-- ---------------------------------------------------------------------
-- 1. Permission enum
-- ---------------------------------------------------------------------
CREATE TYPE "Permission" AS ENUM (
  -- Org-level admin
  'ADMIN_ACCESS',
  'ORG_MANAGE',
  'USER_MANAGE',
  'ROLE_MANAGE',
  -- People
  'CLIENT_VIEW',
  'CLIENT_MANAGE',
  'CLIENT_ANONYMIZE',
  'FACILITATOR_VIEW',
  'FACILITATOR_MANAGE',
  -- Catalog
  'SERVICE_MANAGE',
  'SERVICE_CATEGORY_MANAGE',
  'LOCATION_MANAGE',
  'ROOM_MANAGE',
  'TAG_MANAGE',
  -- Schedule
  'TERM_MANAGE',
  'CLOSURE_MANAGE',
  'EVENT_VIEW',
  'EVENT_MANAGE_ALL',
  'EVENT_MANAGE_SCOPED',
  'SERIES_MANAGE',
  'ENROLLMENT_MANAGE',
  -- Money
  'PAYMENT_VIEW',
  'PAYMENT_MANAGE',
  'REFUND_ISSUE',
  -- Ops
  'ARCHIVE_ACCESS',
  'TRASH_ACCESS',
  'PURGE_PERMANENTLY',
  'AUDIT_LOG_VIEW',
  -- Widget
  'WIDGET_MANAGE'
);

-- ---------------------------------------------------------------------
-- 2. Role table — per org
-- ---------------------------------------------------------------------
CREATE TABLE "Role" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "color"          TEXT,
  "isSystem"       BOOLEAN NOT NULL DEFAULT false,
  "permissions"    "Permission"[] NOT NULL DEFAULT ARRAY[]::"Permission"[],
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Role_organizationId_name_key"
  ON "Role"("organizationId", "name");
CREATE INDEX "Role_organizationId_idx"
  ON "Role"("organizationId");

ALTER TABLE "Role"
  ADD CONSTRAINT "Role_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 3. UserPermissionScope — per-user resource grants
-- ---------------------------------------------------------------------
CREATE TABLE "UserPermissionScope" (
  "id"           TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "permission"   "Permission" NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId"   TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserPermissionScope_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserPermissionScope_userId_permission_resourceType_resourceId_key"
  ON "UserPermissionScope"("userId", "permission", "resourceType", "resourceId");
CREATE INDEX "UserPermissionScope_userId_permission_idx"
  ON "UserPermissionScope"("userId", "permission");

ALTER TABLE "UserPermissionScope"
  ADD CONSTRAINT "UserPermissionScope_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 4. Add User.roleId (nullable while we backfill)
-- ---------------------------------------------------------------------
ALTER TABLE "User" ADD COLUMN "roleId" TEXT;

ALTER TABLE "User"
  ADD CONSTRAINT "User_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "User_roleId_idx" ON "User"("roleId");

-- ---------------------------------------------------------------------
-- 5. Seed default roles per org (deterministic IDs so we can target
--    them in the User UPDATE below). isSystem = true on all three so
--    the UI knows not to expose a delete button.
-- ---------------------------------------------------------------------

-- Propriétaire — full access. Keeps PURGE_PERMANENTLY + ORG_MANAGE +
-- USER_MANAGE / ROLE_MANAGE that the lesser roles don't.
INSERT INTO "Role"
  ("id", "organizationId", "name", "description", "color", "isSystem", "permissions", "createdAt", "updatedAt")
SELECT
  'role_owner_' || "id",
  "id",
  'Propriétaire',
  'Accès complet à toute la plateforme. Ne peut pas être supprimé.',
  '#7C3AED',
  true,
  ARRAY[
    'ADMIN_ACCESS', 'ORG_MANAGE', 'USER_MANAGE', 'ROLE_MANAGE',
    'CLIENT_VIEW', 'CLIENT_MANAGE', 'CLIENT_ANONYMIZE',
    'FACILITATOR_VIEW', 'FACILITATOR_MANAGE',
    'SERVICE_MANAGE', 'SERVICE_CATEGORY_MANAGE',
    'LOCATION_MANAGE', 'ROOM_MANAGE', 'TAG_MANAGE',
    'TERM_MANAGE', 'CLOSURE_MANAGE',
    'EVENT_VIEW', 'EVENT_MANAGE_ALL', 'SERIES_MANAGE', 'ENROLLMENT_MANAGE',
    'PAYMENT_VIEW', 'PAYMENT_MANAGE', 'REFUND_ISSUE',
    'ARCHIVE_ACCESS', 'TRASH_ACCESS', 'PURGE_PERMANENTLY', 'AUDIT_LOG_VIEW',
    'WIDGET_MANAGE'
  ]::"Permission"[],
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization";

-- Administrateur — everything except org/user/role admin + hard purge.
-- Day-to-day operator role; matches what a "manager" typically gets.
INSERT INTO "Role"
  ("id", "organizationId", "name", "description", "color", "isSystem", "permissions", "createdAt", "updatedAt")
SELECT
  'role_admin_' || "id",
  "id",
  'Administrateur',
  'Accès complet aux données. Ne peut pas modifier les utilisateurs, les rôles, ni les paramètres de l’organisation, et ne peut pas supprimer définitivement.',
  '#0EA5E9',
  true,
  ARRAY[
    'ADMIN_ACCESS',
    'CLIENT_VIEW', 'CLIENT_MANAGE', 'CLIENT_ANONYMIZE',
    'FACILITATOR_VIEW', 'FACILITATOR_MANAGE',
    'SERVICE_MANAGE', 'SERVICE_CATEGORY_MANAGE',
    'LOCATION_MANAGE', 'ROOM_MANAGE', 'TAG_MANAGE',
    'TERM_MANAGE', 'CLOSURE_MANAGE',
    'EVENT_VIEW', 'EVENT_MANAGE_ALL', 'SERIES_MANAGE', 'ENROLLMENT_MANAGE',
    'PAYMENT_VIEW', 'PAYMENT_MANAGE', 'REFUND_ISSUE',
    'ARCHIVE_ACCESS', 'TRASH_ACCESS', 'AUDIT_LOG_VIEW',
    'WIDGET_MANAGE'
  ]::"Permission"[],
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization";

-- Enseignant — read-only on people/catalog, scoped event management.
-- Admins must wire UserPermissionScope rows (resourceType='Facilitator')
-- to list which facilitators this teacher can manage events for.
INSERT INTO "Role"
  ("id", "organizationId", "name", "description", "color", "isSystem", "permissions", "createdAt", "updatedAt")
SELECT
  'role_teacher_' || "id",
  "id",
  'Enseignant',
  'Gestion des événements des intervenants assignés (configurable par utilisateur). Lecture seule sur les clients et la fiche intervenants.',
  '#10B981',
  true,
  ARRAY[
    'ADMIN_ACCESS',
    'CLIENT_VIEW',
    'FACILITATOR_VIEW',
    'EVENT_VIEW', 'EVENT_MANAGE_SCOPED'
  ]::"Permission"[],
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization";

-- ---------------------------------------------------------------------
-- 6. Backfill User.roleId from the legacy `role` string. The
--    deterministic role IDs above let us join without a CTE.
-- ---------------------------------------------------------------------
UPDATE "User"
  SET "roleId" = 'role_owner_' || "organizationId"
  WHERE "role" = 'OWNER';

UPDATE "User"
  SET "roleId" = 'role_admin_' || "organizationId"
  WHERE "role" = 'ADMIN';

-- Legacy TEACHER / STAFF / FACILITATOR all map to Enseignant — none of
-- the existing strings carried enough info to distinguish them.
UPDATE "User"
  SET "roleId" = 'role_teacher_' || "organizationId"
  WHERE "role" IN ('TEACHER', 'STAFF', 'FACILITATOR');

-- Fallback: anything left (unknown / typo'd role strings) gets Admin
-- rather than locking the user out. Should be zero in well-maintained orgs.
UPDATE "User"
  SET "roleId" = 'role_admin_' || "organizationId"
  WHERE "roleId" IS NULL;

-- ---------------------------------------------------------------------
-- 7. Drop the legacy column. Frontend types + auth middleware will
--    rebuild role/permission state from User.roleId → Role.permissions.
-- ---------------------------------------------------------------------
ALTER TABLE "User" DROP COLUMN "role";
