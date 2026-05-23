-- Phase 0.3.1 — Rename the default 'Enseignant' template role to
-- 'Intervenant'. Matches the terminology used throughout the rest of
-- the admin UI ("Intervenants gérés", "Intervenant lié", role
-- description copy) instead of the more school-specific "Enseignant".
--
-- The role's permission set + isSystem flag + every existing user
-- assignment carries through untouched — only the display name changes.
-- Admins who already renamed the seeded role to something else are
-- unaffected (the UPDATE filters on the literal old name).

UPDATE "Role"
   SET "name" = 'Intervenant'
 WHERE "name" = 'Enseignant';
