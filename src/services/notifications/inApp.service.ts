import prisma from '../../prisma';
import { getContext, getOrganizationId } from '../../auth/context';

/**
 * N — in-app notification center (admin-facing).
 *
 * Distinct from the outbound dispatcher (dispatcher.ts) which delivers
 * customer comms (email/SMS): these rows feed the bell in the admin
 * navbar. Emitters call `notifyOrgUsers` from business services; it
 * fans out one row per active org user (minus the acting user — you
 * don't need a bell for what you just did yourself).
 */

export type NotificationDto = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  linkUrl: string | null;
  readAt: string | null;
  createdAt: string;
};

function toDto(row: {
  id: string;
  type: string;
  title: string;
  body: string | null;
  linkUrl: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    linkUrl: row.linkUrl,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Fan a notification out to every active user of an org. Fire-and-
 * forget friendly: callers should `void ... .catch()` so a failure
 * never breaks the business operation that triggered it.
 */
export async function notifyOrgUsers(args: {
  organizationId: string;
  type: string;
  title: string;
  body?: string;
  linkUrl?: string;
  /** Skip the acting user (they performed the action themselves). */
  excludeUserId?: string | null;
}): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      organizationId: args.organizationId,
      disabledAt: null,
      ...(args.excludeUserId ? { id: { not: args.excludeUserId } } : {}),
    },
    select: { id: true },
  });
  if (!users.length) return;

  await prisma.notification.createMany({
    data: users.map((u) => ({
      organizationId: args.organizationId,
      userId: u.id,
      type: args.type,
      title: args.title,
      body: args.body ?? null,
      linkUrl: args.linkUrl ?? null,
    })),
  });
}

export class InAppNotificationService {
  /** The caller's notifications, newest first. */
  async list(args: { filter?: 'unread' | 'all'; limit?: number; offset?: number }) {
    const ctx = getContext();
    const organizationId = getOrganizationId();
    if (!ctx || !organizationId) throw new Error('No context');

    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    const offset = Math.max(args.offset ?? 0, 0);
    const where = {
      userId: ctx.userId,
      organizationId,
      ...(args.filter === 'unread' ? { readAt: null } : {}),
    };

    const [rows, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: { userId: ctx.userId, organizationId, readAt: null },
      }),
    ]);

    return { items: rows.map(toDto), total, unread };
  }

  /** Unread count only (cheap badge poll). */
  async unreadCount(): Promise<number> {
    const ctx = getContext();
    const organizationId = getOrganizationId();
    if (!ctx || !organizationId) throw new Error('No context');
    return prisma.notification.count({
      where: { userId: ctx.userId, organizationId, readAt: null },
    });
  }

  /** Mark specific notifications read (own rows only). */
  async markRead(ids: string[]): Promise<void> {
    const ctx = getContext();
    if (!ctx || !ids.length) return;
    await prisma.notification.updateMany({
      where: { id: { in: ids }, userId: ctx.userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /** Mark everything read for the caller. */
  async markAllRead(): Promise<void> {
    const ctx = getContext();
    if (!ctx) return;
    await prisma.notification.updateMany({
      where: { userId: ctx.userId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
