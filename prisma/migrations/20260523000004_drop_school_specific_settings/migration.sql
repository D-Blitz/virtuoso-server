-- Phase 0.7 — generify the annual settings panel.
--
-- The previous migration (20260523000003_org_annual_settings) added
-- two columns that turned out to be too vertical-specific for a
-- product meant to ship across music schools, coaching businesses,
-- therapy practices, etc.:
--
--   - trialFeeCreditsTerm1: assumes a school-trimestre billing model
--     where the discovery-session price is deducted from the first-
--     term enrollment. Most service businesses don't have terms.
--   - holidayZone: French school holiday zones (A/B/C). Useful for an
--     auto-import of FR school vacations, but useless for any non-
--     French org or any non-school context.
--
-- Both columns are dropped here. No downstream code consumed them
-- yet (verified by grep) so this is a clean removal. The discovery-
-- session price (trialFee) and recurring annual fee (membershipFee)
-- stay — both translate cleanly across verticals; only their labels
-- got generified on the frontend.

ALTER TABLE "Organization" DROP COLUMN "trialFeeCreditsTerm1";
ALTER TABLE "Organization" DROP COLUMN "holidayZone";
