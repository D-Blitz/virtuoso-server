-- Rename WidgetFlowKind enum value BOOKING → VISITOR.
--
-- The original name overpromised: WidgetFlow.kind = BOOKING covered
-- not just bookings but enrollment, contact, trial-signup, and any
-- other visitor-driven flow with a public URL. VISITOR is the
-- correct generic.
--
-- Postgres ALTER TYPE ... RENAME VALUE renames the symbol in place;
-- existing rows + column defaults referencing it transparently see
-- the new name. No data migration needed.

ALTER TYPE "WidgetFlowKind" RENAME VALUE 'BOOKING' TO 'VISITOR';
