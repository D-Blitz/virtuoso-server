-- Phase 1.1 follow-up — separate EVENT_CANCEL from EVENT_MANAGE_*.
--
-- Cancellation is a destructive ops decision (the event doesn't
-- happen, the client gets notified, downstream side effects fire).
-- Bundling it with EVENT_MANAGE_SCOPED meant any facilitator with
-- "edit my own events" could also cancel them solo — too broad a
-- default for what's effectively an admin call.
--
-- New permission lives between EVENT_MANAGE_SCOPED and REFUND_ISSUE
-- in the privilege hierarchy. Seeded templates:
--   Propriétaire    → granted (gets everything)
--   Administrateur  → granted (operational admin)
--   Intervenant     → NOT granted (can edit own events, can't cancel)
--
-- Same idea as REFUND_ISSUE: a separate dial admins can grant or
-- withhold per-role rather than coupling it to broader categories.

ALTER TYPE "Permission" ADD VALUE 'EVENT_CANCEL';
