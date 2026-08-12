import prisma from '../../prisma';
import { auditLog } from '../audit/audit.service';
import type { Permission } from '@prisma/client';
import { getContext, getOrganizationId } from '../../auth/context';

/**
 * Phase 0.3.1 — privilege-escalation guard.
 *
 * Standard RBAC defense: a user can only grant a permission they
 * themselves hold. Without this, anyone with ROLE_MANAGE could create
 * a role with every permission (including ROLE_MANAGE itself) and
 * either assign someone to it or assign themselves to it — bypassing
 * any tier the org tried to maintain.
 *
 * Exception: full bypass when the caller has every permission they're
 * about to grant. Propriétaire naturally passes for any input.
 */
function assertCanGrantPermissions(perms: Permission[]): void {
  const ctx = getContext();
  if (!ctx) throw new Error('No request context');
  const missing = perms.filter((p) => !ctx.permissions.has(p));
  if (missing.length === 0) return;
  const err = new Error(
    `Vous ne pouvez accorder que des permissions que vous possédez vous-même. Permissions refusées : ${missing.join(', ')}.`,
  ) as Error & { statusCode?: number };
  err.statusCode = 400;
  throw err;
}

/**
 * Phase 0.3 — Role CRUD service.
 *
 * System roles (`isSystem = true`, seeded per-org at migration time)
 * can have their permission list edited but cannot be renamed or
 * deleted — the middleware role-name allowlist (Propriétaire /
 * Administrateur / Enseignant) relies on those names being stable.
 *
 * Custom roles (`isSystem = false`) are fully editable + deletable.
 * Deleting a role sets `roleId = null` on every linked User via the
 * SetNull FK behavior; admins are expected to reassign before deleting,
 * but the database doesn't block them.
 */

export type RoleDto = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  isSystem: boolean;
  permissions: Permission[];
  userCount: number;
  createdAt: string;
  updatedAt: string;
};

function rowToDto(row: any): RoleDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    isSystem: row.isSystem,
    permissions: row.permissions,
    userCount: row._count?.users ?? 0,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.createdAt,
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : row.updatedAt,
  };
}

export class RoleService {
  /** List roles in the current org, sorted system-first then by name. */
  async list(): Promise<RoleDto[]> {
    // Scoped by the prisma extension as well; named here for the same
    // defence-in-depth reason as UserService.list.
    const organizationId = getOrganizationId();
    const rows = await prisma.role.findMany({
      where: organizationId ? { organizationId } : {},
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { users: true } } },
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<RoleDto | null> {
    const row = await prisma.role.findFirst({
      where: { id },
      include: { _count: { select: { users: true } } },
    });
    return row ? rowToDto(row) : null;
  }

  async create(input: {
    name: string;
    description?: string | null;
    color?: string | null;
    permissions: Permission[];
  }): Promise<RoleDto> {
    const organizationId = getOrganizationId();
    if (!organizationId) throw new Error('No organization context');

    const name = input.name.trim();
    if (!name) {
      const err = new Error('Le nom du rôle est requis.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }

    assertCanGrantPermissions(input.permissions);

    const row = await prisma.role.create({
      data: {
        organizationId,
        name,
        description: input.description?.trim() || null,
        color: input.color?.trim() || null,
        isSystem: false,
        permissions: input.permissions,
      },
      include: { _count: { select: { users: true } } },
    });

    void auditLog.record({
      action: 'CREATE',
      entityType: 'Role',
      entityId: row.id,
      after: { name: row.name, permissions: row.permissions },
    });

    return rowToDto(row);
  }

  /**
   * Update a role. Constraints:
   * - System roles: only `description`, `color`, `permissions` are editable.
   *   Trying to change `name` is rejected.
   * - Custom roles: every field is editable.
   */
  async update(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      color?: string | null;
      permissions?: Permission[];
    },
  ): Promise<RoleDto> {
    const existing = await prisma.role.findFirst({ where: { id } });
    if (!existing) {
      const err = new Error('Rôle introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }

    if (
      existing.isSystem &&
      input.name !== undefined &&
      input.name.trim() !== existing.name
    ) {
      const err = new Error(
        'Le nom des rôles système ne peut pas être modifié.',
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const data: Record<string, any> = {};
    if (input.name !== undefined && !existing.isSystem) {
      const trimmed = input.name.trim();
      if (!trimmed) {
        const err = new Error('Le nom du rôle est requis.') as Error & {
          statusCode?: number;
        };
        err.statusCode = 400;
        throw err;
      }
      data.name = trimmed;
    }
    if (input.description !== undefined) {
      data.description = input.description?.trim() || null;
    }
    if (input.color !== undefined) {
      data.color = input.color?.trim() || null;
    }
    if (input.permissions !== undefined) {
      // Privilege-escalation guard: only check the DELTA against the
      // caller's perms. Adding a permission you don't have is blocked;
      // keeping permissions the role already had (set by someone with
      // higher privilege) is fine — otherwise an Admin couldn't tweak
      // an Administrateur template's color/description without also
      // having every permission that template includes.
      const previousSet = new Set(existing.permissions);
      const added = input.permissions.filter((p) => !previousSet.has(p));
      if (added.length > 0) assertCanGrantPermissions(added);
      data.permissions = input.permissions;
    }

    const row = await prisma.role.update({
      where: { id },
      data,
      include: { _count: { select: { users: true } } },
    });

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Role',
      entityId: row.id,
      before: {
        name: existing.name,
        permissions: existing.permissions,
      },
      after: { name: row.name, permissions: row.permissions },
    });

    return rowToDto(row);
  }

  /**
   * Delete a role. Blocks deletion of system roles and surfaces the
   * user count so the admin can see what they're about to orphan.
   * The DB-level FK is SetNull, so linked users keep their account
   * but their roleId becomes null — admins should reassign before
   * deleting, but the system doesn't force it.
   */
  async remove(id: string): Promise<void> {
    const existing = await prisma.role.findFirst({
      where: { id },
      include: { _count: { select: { users: true } } },
    });
    if (!existing) {
      const err = new Error('Rôle introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    if (existing.isSystem) {
      const err = new Error(
        'Les rôles système ne peuvent pas être supprimés.',
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    await prisma.role.delete({ where: { id } });

    void auditLog.record({
      action: 'DELETE',
      entityType: 'Role',
      entityId: id,
      before: {
        name: existing.name,
        permissions: existing.permissions,
        userCount: existing._count.users,
      },
    });
  }
}
