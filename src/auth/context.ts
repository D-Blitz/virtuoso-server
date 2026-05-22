import { AsyncLocalStorage } from 'node:async_hooks';
import type { Permission } from '@prisma/client';

/**
 * Per-request authenticated identity. Populated by the `requireUser`
 * middleware before any route handler runs.
 *
 * Phase 0.3: the freeform `role` string is gone. Authorization is
 * permission-based — every gated route calls `requirePermission(...)`
 * which reads from the `permissions` set below. `roleName` is kept
 * for audit-log denormalization (display name of the role at action
 * time) and for surfaces that want to render a role badge.
 */
export type RequestContext = {
  userId: string;
  organizationId: string;
  email: string;

  roleId: string | null;
  roleName: string | null;
  permissions: Set<Permission>;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function getOrganizationId(): string | undefined {
  return requestContext.getStore()?.organizationId;
}

/**
 * Permission-check shortcut. Returns true if the current request's
 * user has the permission, false otherwise. Safe to call without a
 * request context (returns false). Prefer `requirePermission()`
 * middleware at the route level; this helper is for in-handler checks
 * (e.g. conditional response-shaping based on capability).
 */
export function hasPermission(perm: Permission): boolean {
  return requestContext.getStore()?.permissions.has(perm) ?? false;
}
