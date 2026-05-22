import prisma from '../../prisma';
import type { Permission } from '@prisma/client';

/**
 * Phase 0.3 — seed the three system roles for an organization.
 *
 * Idempotent: skips creation for roles that already exist (matched by
 * `isSystem=true + name`). Used by:
 *
 *   1. The granular_permissions migration's SQL `INSERT … FROM
 *      Organization` (one-time backfill at schema upgrade time —
 *      see prisma/migrations/20260526000000_granular_permissions).
 *
 *   2. Any future organization-creation flow. The migration covers
 *      existing orgs only; the helper covers new orgs going forward.
 *      Multi-tenant onboarding (Phase 8 self-serve signup) MUST call
 *      this immediately after creating the Organization row, otherwise
 *      the new org has zero roles and no one can log in.
 *
 *   3. An ops-time fixer in case a role was accidentally deleted from
 *      the DB (admins can't delete system roles via the UI, but a
 *      manual SQL `DELETE` would punch through). Re-running this
 *      helper restores the missing system rows without touching any
 *      custom roles the org already created.
 *
 * Role definitions mirror the migration exactly. If you change a role's
 * default permission set, update BOTH this file AND the migration's
 * SQL — they're the two entry points and we want them to agree.
 */

type SeedRole = {
  name: string;
  description: string;
  color: string;
  permissions: Permission[];
};

const SEEDED_ROLES: SeedRole[] = [
  {
    name: 'Propriétaire',
    description:
      'Accès complet à toute la plateforme. Ne peut pas être supprimé.',
    color: '#7C3AED',
    permissions: [
      'ADMIN_ACCESS', 'ORG_MANAGE', 'USER_MANAGE', 'ROLE_MANAGE',
      'CLIENT_VIEW', 'CLIENT_MANAGE', 'CLIENT_ANONYMIZE',
      'FACILITATOR_VIEW', 'FACILITATOR_MANAGE',
      'SERVICE_MANAGE', 'SERVICE_CATEGORY_MANAGE',
      'LOCATION_MANAGE', 'ROOM_MANAGE', 'TAG_MANAGE',
      'TERM_MANAGE', 'CLOSURE_MANAGE',
      'EVENT_VIEW', 'EVENT_MANAGE_ALL', 'SERIES_MANAGE', 'ENROLLMENT_MANAGE',
      'PAYMENT_VIEW', 'PAYMENT_MANAGE', 'REFUND_ISSUE',
      'ARCHIVE_ACCESS', 'TRASH_ACCESS', 'PURGE_PERMANENTLY', 'AUDIT_LOG_VIEW',
      'WIDGET_MANAGE',
    ],
  },
  {
    name: 'Administrateur',
    description:
      'Accès complet aux données. Ne peut pas modifier les utilisateurs, les rôles, ni les paramètres de l’organisation, et ne peut pas supprimer définitivement.',
    color: '#0EA5E9',
    permissions: [
      'ADMIN_ACCESS',
      'CLIENT_VIEW', 'CLIENT_MANAGE', 'CLIENT_ANONYMIZE',
      'FACILITATOR_VIEW', 'FACILITATOR_MANAGE',
      'SERVICE_MANAGE', 'SERVICE_CATEGORY_MANAGE',
      'LOCATION_MANAGE', 'ROOM_MANAGE', 'TAG_MANAGE',
      'TERM_MANAGE', 'CLOSURE_MANAGE',
      'EVENT_VIEW', 'EVENT_MANAGE_ALL', 'SERIES_MANAGE', 'ENROLLMENT_MANAGE',
      'PAYMENT_VIEW', 'PAYMENT_MANAGE', 'REFUND_ISSUE',
      'ARCHIVE_ACCESS', 'TRASH_ACCESS', 'AUDIT_LOG_VIEW',
      'WIDGET_MANAGE',
    ],
  },
  {
    name: 'Enseignant',
    description:
      'Gestion des événements des intervenants assignés (configurable par utilisateur). Lecture seule sur les clients et la fiche intervenants.',
    color: '#10B981',
    permissions: [
      'ADMIN_ACCESS',
      'CLIENT_VIEW',
      'FACILITATOR_VIEW',
      'EVENT_VIEW', 'EVENT_MANAGE_SCOPED',
    ],
  },
];

export type SeedResult = {
  created: string[];
  skipped: string[];
};

/**
 * Ensure the three system roles exist for `organizationId`. Returns
 * which were created vs. skipped (already present). Safe to re-run.
 */
export async function seedOrgRoles(
  organizationId: string,
): Promise<SeedResult> {
  const existing = await prisma.role.findMany({
    where: { organizationId, isSystem: true },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((r) => r.name));

  const result: SeedResult = { created: [], skipped: [] };

  for (const role of SEEDED_ROLES) {
    if (existingNames.has(role.name)) {
      result.skipped.push(role.name);
      continue;
    }
    await prisma.role.create({
      data: {
        organizationId,
        name: role.name,
        description: role.description,
        color: role.color,
        isSystem: true,
        permissions: role.permissions,
      },
    });
    result.created.push(role.name);
  }

  return result;
}

/**
 * Run `seedOrgRoles` against every Organization. Used to fix orgs
 * that were created before the granular_permissions migration but
 * whose system roles got deleted, OR to add new system roles
 * introduced after a v1 → v2 schema bump.
 *
 * Returns a summary indexed by org id. Safe to re-run.
 */
export async function seedAllOrgs(): Promise<Record<string, SeedResult>> {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const out: Record<string, SeedResult> = {};
  for (const o of orgs) {
    out[o.id] = await seedOrgRoles(o.id);
  }
  return out;
}
