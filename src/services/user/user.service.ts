import prisma from '../../prisma';
import { auditLog } from '../audit/audit.service';
import { hashPassword } from '../../auth/password';
import { getContext, getOrganizationId } from '../../auth/context';
import type { Permission } from '@prisma/client';

/**
 * Phase 0.3 — User CRUD service.
 *
 * Soft-disable, not soft-delete: the row stays in the User table with
 * its roleId / facilitatorId / scope rows intact, but `disabledAt` is
 * set so login + permission checks treat the account as gone.
 *
 * Self-protection invariants:
 *   - A user can't disable themselves (locks them out of their own UI)
 *   - A user can't strip their own ROLE_MANAGE (would brick the org's
 *     ability to fix it after the next refresh)
 *   - The org must always have at least one active user with ROLE_MANAGE
 *
 * Hard delete is NOT exposed — disable is the only removal path. If
 * an admin truly needs to wipe a row they can do it via DB tooling.
 */

export type UserScopeDto = {
  permission: Permission;
  resourceType: string;
  resourceId: string;
};

export type UserDto = {
  id: string;
  email: string;
  roleId: string | null;
  roleName: string | null;
  facilitatorId: string | null;
  facilitatorLabel: string | null;
  disabledAt: string | null;
  scopes: UserScopeDto[];
  createdAt: string;
  updatedAt: string;
};

export type CurrentUserDto = UserDto & {
  permissions: Permission[];
};

function rowToDto(row: any): UserDto {
  return {
    id: row.id,
    email: row.email,
    roleId: row.roleId,
    roleName: row.roleRef?.name ?? null,
    facilitatorId: row.facilitatorId,
    facilitatorLabel: row.facilitator
      ? `${row.facilitator.firstname} ${row.facilitator.lastname}`.trim()
      : null,
    disabledAt:
      row.disabledAt instanceof Date
        ? row.disabledAt.toISOString()
        : row.disabledAt,
    scopes: (row.permissionScopes ?? []).map((s: any) => ({
      permission: s.permission,
      resourceType: s.resourceType,
      resourceId: s.resourceId,
    })),
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

const userIncludes = {
  roleRef: { select: { id: true, name: true } },
  facilitator: { select: { id: true, firstname: true, lastname: true } },
  permissionScopes: {
    select: { permission: true, resourceType: true, resourceId: true },
  },
} as const;

export class UserService {
  /** List users in the current org. Active first, then disabled. */
  async list(args: { includeDisabled?: boolean } = {}): Promise<UserDto[]> {
    const where: Record<string, any> = {};
    if (!args.includeDisabled) where.disabledAt = null;

    const rows = await prisma.user.findMany({
      where,
      orderBy: [{ disabledAt: 'asc' }, { email: 'asc' }],
      include: userIncludes,
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<UserDto | null> {
    const row = await prisma.user.findFirst({
      where: { id },
      include: userIncludes,
    });
    return row ? rowToDto(row) : null;
  }

  /**
   * Returns the current authenticated user with the full Permission[]
   * resolved from their Role. Used by /api/users/me — the only User
   * endpoint that doesn't require USER_MANAGE.
   */
  async getMe(): Promise<CurrentUserDto | null> {
    const ctx = getContext();
    if (!ctx) return null;
    const row = await prisma.user.findFirst({
      where: { id: ctx.userId },
      include: {
        ...userIncludes,
        roleRef: { select: { id: true, name: true, permissions: true } },
      },
    });
    if (!row) return null;
    const dto = rowToDto(row);
    const permissions = (row.roleRef?.permissions ?? []) as Permission[];
    return { ...dto, permissions };
  }

  /**
   * Create a user. Password is hashed with bcrypt. The created user's
   * role + initial scope rows are wired in the same transaction so a
   * half-created user can never exist.
   */
  async create(input: {
    email: string;
    password: string;
    roleId: string | null;
    facilitatorId: string | null;
    /** Manageable facilitator ids for EVENT_MANAGE_SCOPED. */
    manageableFacilitatorIds: string[];
  }): Promise<UserDto> {
    const organizationId = getOrganizationId();
    if (!organizationId) throw new Error('No organization context');

    const email = input.email.trim().toLowerCase();
    if (!email) {
      const err = new Error("L'email est requis.") as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }
    if (input.password.length < 8) {
      const err = new Error(
        'Le mot de passe doit faire au moins 8 caractères.',
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const passwordHash = await hashPassword(input.password);

    const row = await prisma.user.create({
      data: {
        organizationId,
        email,
        passwordHash,
        roleId: input.roleId,
        facilitatorId: input.facilitatorId,
        permissionScopes: {
          create: input.manageableFacilitatorIds.map((id) => ({
            permission: 'EVENT_MANAGE_SCOPED' as Permission,
            resourceType: 'Facilitator',
            resourceId: id,
          })),
        },
      },
      include: userIncludes,
    });

    void auditLog.record({
      action: 'CREATE',
      entityType: 'User',
      entityId: row.id,
      after: { email: row.email, roleId: row.roleId },
    });

    return rowToDto(row);
  }

  /**
   * Update a user. Email, role, facilitator link, and scope list are
   * all editable. Password changes go through changePassword (separate
   * endpoint so the audit log can distinguish "password rotated" from
   * "profile edited"). Disable / reactivate are also separate.
   */
  async update(
    id: string,
    input: {
      email?: string;
      roleId?: string | null;
      facilitatorId?: string | null;
      manageableFacilitatorIds?: string[];
    },
  ): Promise<UserDto> {
    const existing = await prisma.user.findFirst({
      where: { id },
      include: userIncludes,
    });
    if (!existing) {
      const err = new Error('Utilisateur introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }

    // Self-protection: can't strip your own ROLE_MANAGE.
    const ctx = getContext();
    if (ctx && ctx.userId === id && input.roleId && input.roleId !== existing.roleId) {
      const newRole = await prisma.role.findUnique({
        where: { id: input.roleId },
        select: { permissions: true },
      });
      if (!newRole?.permissions.includes('ROLE_MANAGE')) {
        const err = new Error(
          "Vous ne pouvez pas vous retirer vous-même la permission de gérer les rôles.",
        ) as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
    }

    const data: Record<string, any> = {};
    if (input.email !== undefined) {
      const trimmed = input.email.trim().toLowerCase();
      if (!trimmed) {
        const err = new Error("L'email est requis.") as Error & {
          statusCode?: number;
        };
        err.statusCode = 400;
        throw err;
      }
      data.email = trimmed;
    }
    if (input.roleId !== undefined) data.roleId = input.roleId;
    if (input.facilitatorId !== undefined) {
      data.facilitatorId = input.facilitatorId;
    }

    // Rewriting the scope list: drop the old EVENT_MANAGE_SCOPED rows
    // and write the new ones. Other scope permissions (if/when added
    // later) are left alone.
    if (input.manageableFacilitatorIds !== undefined) {
      await prisma.userPermissionScope.deleteMany({
        where: {
          userId: id,
          permission: 'EVENT_MANAGE_SCOPED',
          resourceType: 'Facilitator',
        },
      });
      if (input.manageableFacilitatorIds.length > 0) {
        await prisma.userPermissionScope.createMany({
          data: input.manageableFacilitatorIds.map((fid) => ({
            userId: id,
            permission: 'EVENT_MANAGE_SCOPED' as Permission,
            resourceType: 'Facilitator',
            resourceId: fid,
          })),
        });
      }
    }

    const row = await prisma.user.update({
      where: { id },
      data,
      include: userIncludes,
    });

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'User',
      entityId: row.id,
      before: { email: existing.email, roleId: existing.roleId },
      after: { email: row.email, roleId: row.roleId },
    });

    return rowToDto(row);
  }

  /** Reset / rotate a user's password. */
  async changePassword(id: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) {
      const err = new Error(
        'Le mot de passe doit faire au moins 8 caractères.',
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    const existing = await prisma.user.findFirst({
      where: { id },
      select: { id: true, email: true },
    });
    if (!existing) {
      const err = new Error('Utilisateur introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id }, data: { passwordHash } });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'User',
      entityId: id,
      // Don't store the hash in the audit log; just record that
      // a password change happened.
      after: { passwordChanged: true },
    });
  }

  /**
   * Disable a user. Blocks if it's the caller (can't lock themselves
   * out) or if disabling would leave the org without any active
   * ROLE_MANAGE-capable user.
   */
  async disable(id: string): Promise<void> {
    const ctx = getContext();
    if (!ctx) throw new Error('No request context');
    if (ctx.userId === id) {
      const err = new Error(
        "Vous ne pouvez pas désactiver votre propre compte.",
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const target = await prisma.user.findFirst({
      where: { id },
      include: { roleRef: { select: { permissions: true } } },
    });
    if (!target) {
      const err = new Error('Utilisateur introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    if (target.disabledAt) {
      // Already disabled; idempotent.
      return;
    }

    // Last-admin guard.
    if (target.roleRef?.permissions.includes('ROLE_MANAGE')) {
      const remaining = await prisma.user.count({
        where: {
          id: { not: id },
          disabledAt: null,
          roleRef: { permissions: { has: 'ROLE_MANAGE' } },
        },
      });
      if (remaining === 0) {
        const err = new Error(
          "Impossible de désactiver le dernier utilisateur capable de gérer les rôles. Attribuez ROLE_MANAGE à un autre utilisateur d'abord.",
        ) as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
    }

    await prisma.user.update({
      where: { id },
      data: { disabledAt: new Date(), disabledById: ctx.userId },
    });

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'User',
      entityId: id,
      before: { disabledAt: null },
      after: { disabledAt: new Date().toISOString(), disabledById: ctx.userId },
    });
  }

  /** Reactivate a disabled user. */
  async reactivate(id: string): Promise<void> {
    const existing = await prisma.user.findFirst({ where: { id } });
    if (!existing) {
      const err = new Error('Utilisateur introuvable.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    if (!existing.disabledAt) return;

    await prisma.user.update({
      where: { id },
      data: { disabledAt: null, disabledById: null },
    });

    void auditLog.record({
      action: 'UPDATE',
      entityType: 'User',
      entityId: id,
      before: {
        disabledAt: existing.disabledAt?.toISOString() ?? null,
      },
      after: { disabledAt: null },
    });
  }
}
