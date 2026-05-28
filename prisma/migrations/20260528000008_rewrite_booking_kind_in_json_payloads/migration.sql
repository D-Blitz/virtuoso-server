-- Data migration: rewrite kind='BOOKING' → 'VISITOR' inside the JSON
-- payloads of WidgetFlowDraft + WidgetFlowSnapshot.
--
-- Companion to 20260528000007_rename_booking_to_visitor which renamed
-- the enum value but didn't touch the JSON blobs stored in those two
-- tables (the enum only constrains scalar columns). Existing drafts +
-- snapshots authored before the rename still carry the literal string
-- "BOOKING" inside `payload->>'kind'`, which makes the admin editor's
-- autosave fail Zod validation with the new VISITOR-only enum.
--
-- This migration is destructive in the sense that it overwrites the
-- existing JSON blobs in place, but the change is semantic-equivalent:
-- the enum was renamed; this just propagates the rename to the JSON
-- copies of the enum value.

UPDATE "WidgetFlowDraft"
SET payload = jsonb_set(payload::jsonb, '{kind}', '"VISITOR"'::jsonb)
WHERE payload->>'kind' = 'BOOKING';

UPDATE "WidgetFlowSnapshot"
SET payload = jsonb_set(payload::jsonb, '{kind}', '"VISITOR"'::jsonb)
WHERE payload->>'kind' = 'BOOKING';
