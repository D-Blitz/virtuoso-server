-- Phase 0.7 — strip the settings panel to truly universal fields.
--
-- The 20260523000003 migration added five billing-flavored columns,
-- 20260523000004 already dropped two as too school-specific
-- (trialFeeCreditsTerm1, holidayZone). This migration drops the
-- remaining three because they each belong to a more specific concept,
-- not org-wide settings:
--
--   - membershipFee + membershipFeeEnabled
--       Assumes a subscription / club / association billing model.
--       Many service businesses (one-shot bookings, project-based
--       coaching, ad-hoc therapy) don't have any recurring annual
--       fee. Re-land in a future subscription/billing surface where
--       it makes sense as a feature, not as a global toggle.
--
--   - trialFee
--       "Trial" as a baked-in concept doesn't generalize. If a user
--       wants a discovery/intro/trial offering, they can create a
--       regular service with whatever price they want. The platform
--       shouldn't elevate one service archetype to first-class
--       status — that's how products end up vertical-locked.
--
--   - outstandingReminderThreshold
--       The threshold for dunning is per-service / per-invoice, not
--       org-wide. A 50€ unpaid lesson and a 2000€ unpaid term
--       enrollment warrant different reminder cadences. Belongs in
--       a future dunning-config surface or as a per-service field.
--
-- No downstream code consumes any of these yet (verified by grep),
-- so this is a clean removal.

ALTER TABLE "Organization" DROP COLUMN "membershipFee";
ALTER TABLE "Organization" DROP COLUMN "membershipFeeEnabled";
ALTER TABLE "Organization" DROP COLUMN "trialFee";
ALTER TABLE "Organization" DROP COLUMN "outstandingReminderThreshold";
