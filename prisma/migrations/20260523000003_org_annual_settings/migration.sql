-- Phase 0.7 — annual settings panel.
--
-- Adds the seven org-wide tunables the school typically edits once
-- per season. Replaces the previous workflow of changing values in
-- the Excel CLEFS sheet → code change.
--
-- All fields ship with sensible defaults so existing orgs work
-- unchanged. The frontend `/admin/parametres` page pre-fills with
-- current values. Each field's behavior lands in its respective
-- phase ticket (1.7 dunning, 6.5 invoicing, 6.5 membership/trial
-- billing); this migration is purely the storage + admin surface.

ALTER TABLE "Organization"
  ADD COLUMN "vatRate"                       DOUBLE PRECISION NOT NULL DEFAULT 20,
  ADD COLUMN "membershipFee"                 DOUBLE PRECISION NOT NULL DEFAULT 50,
  ADD COLUMN "membershipFeeEnabled"          BOOLEAN          NOT NULL DEFAULT true,
  ADD COLUMN "trialFee"                      DOUBLE PRECISION NOT NULL DEFAULT 28,
  ADD COLUMN "trialFeeCreditsTerm1"          BOOLEAN          NOT NULL DEFAULT true,
  ADD COLUMN "outstandingReminderThreshold"  DOUBLE PRECISION NOT NULL DEFAULT 10,
  ADD COLUMN "holidayZone"                   TEXT;
