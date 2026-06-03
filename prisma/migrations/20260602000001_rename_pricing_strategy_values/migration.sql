-- Rename Enrollment.pricingStrategy stored values to drop the
-- "TERM_" prefix (terms can be any duration — semester, monthly
-- subscription, recital block — not just trimesters).
--
-- Pre-rename → post-rename:
--   TERM_FIXED_PRORATED       → PERIOD_PRORATED
--   TERM_PRORATED_BY_LESSONS  → PERIOD_PRORATED   (was a synonym
--                                                   used by the
--                                                   widget checkout)
--   TERM_FIXED                → PERIOD_FIXED
--   PER_OCCURRENCE            → PER_OCCURRENCE    (unchanged — was
--                                                   already neutral)
--
-- pricingStrategy is a free-text String column (not a Postgres
-- enum), so this is a straight UPDATE over existing rows.

UPDATE "Enrollment"
SET "pricingStrategy" = 'PERIOD_PRORATED'
WHERE "pricingStrategy" IN ('TERM_FIXED_PRORATED', 'TERM_PRORATED_BY_LESSONS');

UPDATE "Enrollment"
SET "pricingStrategy" = 'PERIOD_FIXED'
WHERE "pricingStrategy" = 'TERM_FIXED';
