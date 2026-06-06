import { Permission } from '@prisma/client';

/**
 * The complete permission set, derived directly from the Prisma enum so
 * it can never drift. This is the single source of truth for "full
 * access" — i.e. what the Propriétaire (owner) role and the dev auth
 * bypass are granted.
 *
 * Why this exists: the privilege-escalation guard (role.service /
 * user.service) only lets a caller grant permissions they themselves
 * hold. If the owner role is missing a permission, the owner can't grant
 * it to anyone — so the owner MUST hold every permission. We used to
 * hand-maintain that list in two places (here-style arrays in
 * seedOrgRoles + the dev bypass); every time a new permission was added
 * to the enum, those lists silently fell behind and the owner lost the
 * ability to grant the new permission ("Vous ne pouvez accorder que des
 * permissions que vous possédez vous-même"). Deriving from
 * `Object.values(Permission)` removes the foot-gun: a new enum value is
 * automatically included.
 *
 * NOTE: this fixes NEW orgs (seed) and the dev bypass automatically.
 * EXISTING orgs still need a one-time data migration to backfill their
 * Propriétaire row whenever a permission is added — see
 * prisma/migrations/*_backfill_owner_full_permissions for the pattern.
 */
export const ALL_PERMISSIONS: Permission[] = Object.values(Permission);
