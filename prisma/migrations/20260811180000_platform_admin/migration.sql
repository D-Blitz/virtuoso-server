-- Platform operator flag. Not a Permission on purpose: permissions are
-- granted through per-org Role rows, so a platform permission could be
-- self-granted by any tenant admin holding ROLE_MANAGE. A column that no
-- tenant-facing surface writes stays out of reach.
--
-- Defaults to false, so this migration grants nobody anything. Use
-- scripts/grantPlatformAdmin.ts to set it.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;
