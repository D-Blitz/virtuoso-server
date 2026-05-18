-- =========================================================================
-- PR 2: Facilitator scoring fields for the booking widget recommender.
-- All columns have defaults so existing rows are unaffected.
-- =========================================================================

ALTER TABLE "Facilitator" ADD COLUMN "ageScores"      JSONB             NOT NULL DEFAULT '[]';
ALTER TABLE "Facilitator" ADD COLUMN "levelScores"    JSONB             NOT NULL DEFAULT '{}';
ALTER TABLE "Facilitator" ADD COLUMN "languages"      TEXT[]            NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Facilitator" ADD COLUMN "priorityWeight" DOUBLE PRECISION  NOT NULL DEFAULT 1.0;
