import { AsyncLocalStorage } from 'node:async_hooks';
import type { Permission } from '@prisma/client';

/**
 * Per-request authenticated identity. Populated by the `requireUser`
 * middleware before any route handler runs.
 *
 * `role` (string) is kept for backward compat with the pre-0.3 guards
 * (`requireMutationRole`, the 4 `guardAdminOnly` helpers). It carries
 * a derived `OWNER | ADMIN | STAFF | FACILITATOR` synonym computed
 * from the user's Permission set, so existing role-name checks keep
 * working until Step 2 replaces them with permission-based checks.
 *
 * `roleId` / `roleName` / `permissions` are the new (Phase 0.3) source
 * of truth. Use `hasPermission(p)` rather than reading `permissions`
 * directly.
 */
export type RequestContext = {
  userId: string;
  organizationId: string;
  email: string;

  // New (0.3)
  roleId: string | null;
  roleName: string | null;
  permissions: Set<Permission>;

  // Legacy synonym — see deriveLegacyRole() below.
  role: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function getOrganizationId(): string | undefined {
  return requestContext.getStore()?.organizationId;
}

/**
 * Bridge from a user's Permission set back to the four legacy role
 * strings the older guards check for. Once Step 2 rips out those
 * guards, this function can be deleted.
 *
 * Mapping:
 *   - has ROLE_MANAGE + ORG_MANAGE → OWNER
 *   - has ADMIN_ACCESS + CLIENT_MANAGE → ADMIN
 *   - has ADMIN_ACCESS                 → STAFF
 *   - otherwise                        → FACILITATOR (no admin access)
 */
export function deriveLegacyRole(perms: Set<Permission>): string {
  if (perms.has('ROLE_MANAGE') && perms.has('ORG_MANAGE')) return 'OWNER';
  if (perms.has('ADMIN_ACCESS') && perms.has('CLIENT_MANAGE')) return 'ADMIN';
  if (perms.has('ADMIN_ACCESS')) return 'STAFF';
  return 'FACILITATOR';
}

/**
 * Permission-check shortcut. Returns true if the current request's
 * user has the permission, false otherwise. Safe to call without a
 * request context (returns false).
 */
export function hasPermission(perm: Permission): boolean {
  return requestContext.getStore()?.permissions.has(perm) ?? false;
}
