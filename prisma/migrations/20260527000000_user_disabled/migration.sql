-- Phase 0.3 — Soft-disable users.
--
-- Adds `disabledAt` + `disabledById` columns to User so admins can
-- deactivate accounts without losing the row. A disabled user is
-- treated as unauthenticated by the auth middleware (and by login);
-- their roleId / facilitatorId / scope rows are preserved so a future
-- reactivation restores the exact prior state.
--
-- Distinct from the trash bin: this is a status flag specific to
-- User (which isn't a soft-deletable entity). No TTL purge, no audit-
-- chain cleanup — reactivation is meant to be cheap.

ALTER TABLE "User" ADD COLUMN "disabledAt"   TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "disabledById" TEXT;

-- Used by login's "is this user still active?" check and the listing
-- page's filter (active / disabled / all).
CREATE INDEX "User_disabledAt_idx" ON "User"("disabledAt");
