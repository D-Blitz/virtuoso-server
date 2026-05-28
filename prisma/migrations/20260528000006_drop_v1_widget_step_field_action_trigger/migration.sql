-- Phase 3.5 — drop the v1 widget-flow tables.
--
-- The v2 graph engine (WidgetNode / WidgetEdge / WidgetEntryPoint,
-- introduced in Phase 3.0) is now the only consumer of widget-flow
-- state. The v1 normalized tables (WidgetStep / WidgetField /
-- WidgetAction / WidgetTrigger) have been coexisting since Phase
-- 3.0 for migration safety; nothing on the live path references
-- them after the Phase 3.5 source purge.
--
-- This migration is destructive — any rows in these tables are
-- lost. Pre-Phase-3.5 flows authored against v1 must be re-created
-- via the canvas editor (the Phase 3.1 admin UI silently presents
-- them as empty graphs, so this isn't a silent data loss — admins
-- see immediately that the flow is empty).

-- Cascade drop the child rows first to avoid FK issues across the
-- WidgetStep -> WidgetField cascade + WidgetAction self-FK tree.
DROP TABLE IF EXISTS "WidgetField" CASCADE;
DROP TABLE IF EXISTS "WidgetAction" CASCADE;
DROP TABLE IF EXISTS "WidgetTrigger" CASCADE;
DROP TABLE IF EXISTS "WidgetStep" CASCADE;

-- Drop the v1-only enums. v2 stores `kind` as a String column so the
-- engine's handler registry is the authoritative whitelist —
-- adding a new kind is purely app-layer work.
DROP TYPE IF EXISTS "WidgetStepKind";
DROP TYPE IF EXISTS "WidgetFieldKind";
DROP TYPE IF EXISTS "WidgetFieldBinding";
