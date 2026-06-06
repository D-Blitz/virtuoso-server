-- Backfill: the owner (Propriétaire / isSystem=true) role must hold EVERY
-- permission, otherwise the privilege-escalation guard in
-- role.service.assertCanGrantPermissions() blocks the owner from granting
-- a permission they don't themselves hold.
--
-- The INVOICE_VIEW_ALL / INVOICE_VIEW_SCOPED permissions (added in
-- 20260606113047) and EVENT_MANAGE_SCOPED were never present in the
-- originally-seeded Propriétaire row, so editing any role and trying to
-- include them failed with "Vous ne pouvez accorder que des permissions
-- que vous possédez vous-même".
--
-- This one-time data migration resets every system role to the complete
-- permission set. Going forward, seedOrgRoles derives Propriétaire from
-- the Prisma enum (ALL_PERMISSIONS) so new orgs are correct automatically;
-- existing orgs are corrected here.

UPDATE "Role"
SET "permissions" = ARRAY[
  'ADMIN_ACCESS', 'ORG_MANAGE', 'USER_MANAGE', 'ROLE_MANAGE',
  'CLIENT_VIEW', 'CLIENT_MANAGE', 'CLIENT_ANONYMIZE',
  'FACILITATOR_VIEW', 'FACILITATOR_MANAGE',
  'SERVICE_MANAGE', 'SERVICE_CATEGORY_MANAGE',
  'LOCATION_MANAGE', 'ROOM_MANAGE', 'TAG_MANAGE',
  'TERM_MANAGE', 'CLOSURE_MANAGE',
  'EVENT_VIEW', 'EVENT_MANAGE_ALL', 'EVENT_MANAGE_SCOPED', 'EVENT_CANCEL',
  'SERIES_MANAGE', 'ENROLLMENT_MANAGE',
  'PAYMENT_VIEW', 'PAYMENT_MANAGE', 'REFUND_ISSUE',
  'INVOICE_VIEW_ALL', 'INVOICE_VIEW_SCOPED',
  'ARCHIVE_ACCESS', 'TRASH_ACCESS', 'PURGE_PERMANENTLY', 'AUDIT_LOG_VIEW',
  'WIDGET_MANAGE'
]::"Permission"[]
WHERE "isSystem" = true;
