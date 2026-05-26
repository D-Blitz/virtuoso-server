-- Phase 0.3.1 — Demote Administrateur + Enseignant to deletable templates.
--
-- The original granular_permissions migration seeded three system roles
-- per org (Propriétaire / Administrateur / Enseignant) with isSystem=true,
-- making them undeletable. Feedback: only Propriétaire actually needs to
-- be permanently locked (it's the bootstrap — the org always needs at
-- least one owner). Administrateur and Enseignant are useful as starter
-- TEMPLATES, but admins should be free to rename, retune, or delete them
-- once they've cloned what they need.
--
-- Effect: flips isSystem to false on Administrateur + Enseignant rows
-- across every org. Existing user assignments are untouched. The Role
-- service's "cannot delete system roles" guard will now only apply to
-- Propriétaire.
--
-- Going forward, seedOrgRoles (services/role/seedOrgRoles.ts) will only
-- mark Propriétaire as isSystem=true. Administrateur and Enseignant are
-- still seeded for first-run UX, but as ordinary deletable roles.

UPDATE "Role"
   SET "isSystem" = false
 WHERE "name" IN ('Administrateur', 'Enseignant')
   AND "isSystem" = true;
