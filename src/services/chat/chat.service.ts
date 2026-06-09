import prisma from '../../prisma';
import { getContext, getOrganizationId } from '../../auth/context';
import { isOnline } from '../../presence/presence';

/**
 * M — Chat center service (user ↔ user messaging within an org).
 *
 * Conversations are 1:1 DMs or named groups. A user only ever sees
 * conversations they participate in. Unread counts come from comparing
 * each message's createdAt against the participant's lastReadAt.
 *
 * Users are surfaced with a display identity resolved from their linked
 * Facilitator (name / colour / photo) when present, else their email —
 * the User row itself carries no name.
 */

// ── Types ──────────────────────────────────────────────────────────

export type ChatUserDto = {
  id: string;
  name: string;
  email: string;
  color: string | null;
  avatarUrl: string | null;
  online: boolean;
};

export type ChatMessageDto = {
  id: string;
  conversationId: string;
  senderUserId: string;
  body: string;
  createdAt: string;
  sender: ChatUserDto;
};

export type ConversationDto = {
  id: string;
  isGroup: boolean;
  /** Display title: group name, or the other participant's name for a DM. */
  title: string;
  participants: ChatUserDto[];
  lastMessage: {
    body: string;
    createdAt: string;
    senderUserId: string;
  } | null;
  unreadCount: number;
  lastMessageAt: string;
  createdById: string | null;
};

// ── User identity resolution ───────────────────────────────────────

function userToDto(row: any): ChatUserDto {
  const f = row.facilitator;
  const name = f
    ? `${f.firstname} ${f.lastname}`.trim()
    : row.email.split('@')[0];
  return {
    id: row.id,
    name: name || row.email,
    email: row.email,
    color: f?.color ?? null,
    avatarUrl: f?.profilePictureUrl ?? null,
    online: isOnline(row.id),
  };
}

const userInclude = {
  facilitator: {
    select: { firstname: true, lastname: true, color: true, profilePictureUrl: true },
  },
} as const;

function notFound(message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = 404;
  return e;
}
function badRequest(message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = 400;
  return e;
}

// ── Service ────────────────────────────────────────────────────────

export class ChatService {
  /** Directory of org users to start a chat with (active, excludes self). */
  async listUsers(): Promise<ChatUserDto[]> {
    const organizationId = getOrganizationId();
    const ctx = getContext();
    if (!organizationId || !ctx) throw new Error('No context');

    const rows = await prisma.user.findMany({
      where: { organizationId, disabledAt: null, id: { not: ctx.userId } },
      include: userInclude,
    });
    return rows
      .map(userToDto)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Build a userId → ChatUserDto map for the given ids (org-scoped). */
  private async resolveUsers(ids: string[]): Promise<Map<string, ChatUserDto>> {
    const organizationId = getOrganizationId();
    if (!ids.length) return new Map();
    const rows = await prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] }, organizationId },
      include: userInclude,
    });
    return new Map(rows.map((r) => [r.id, userToDto(r)]));
  }

  /** The caller's conversations, most-recent first, with unread counts. */
  async listConversations(): Promise<ConversationDto[]> {
    const organizationId = getOrganizationId();
    const ctx = getContext();
    if (!organizationId || !ctx) throw new Error('No context');

    const myParts = await prisma.conversationParticipant.findMany({
      where: { userId: ctx.userId, conversation: { organizationId } },
      select: { conversationId: true, lastReadAt: true },
    });
    const lastReadByConv = new Map(
      myParts.map((p) => [p.conversationId, p.lastReadAt]),
    );
    const convIds = myParts.map((p) => p.conversationId);
    if (!convIds.length) return [];

    const convs = await prisma.conversation.findMany({
      where: { id: { in: convIds } },
      include: { participants: { select: { userId: true } } },
      orderBy: { lastMessageAt: 'desc' },
    });

    const allUserIds = convs.flatMap((c) => c.participants.map((p) => p.userId));
    const userMap = await this.resolveUsers(allUserIds);

    const result = await Promise.all(
      convs.map(async (c) => {
        const [last, unreadCount] = await Promise.all([
          prisma.chatMessage.findFirst({
            where: { conversationId: c.id },
            orderBy: { createdAt: 'desc' },
          }),
          prisma.chatMessage.count({
            where: {
              conversationId: c.id,
              senderUserId: { not: ctx.userId },
              ...(lastReadByConv.get(c.id)
                ? { createdAt: { gt: lastReadByConv.get(c.id) as Date } }
                : {}),
            },
          }),
        ]);

        const participants = c.participants
          .map((p) => userMap.get(p.userId))
          .filter((u): u is ChatUserDto => !!u);

        const others = participants.filter((u) => u.id !== ctx.userId);
        const title = c.isGroup
          ? c.title || 'Groupe'
          : others[0]?.name || 'Conversation';

        return {
          id: c.id,
          isGroup: c.isGroup,
          title,
          participants,
          lastMessage: last
            ? {
                body: last.body,
                createdAt: last.createdAt.toISOString(),
                senderUserId: last.senderUserId,
              }
            : null,
          unreadCount,
          lastMessageAt: c.lastMessageAt.toISOString(),
          createdById: c.createdById,
        } satisfies ConversationDto;
      }),
    );

    return result;
  }

  /** Assert the caller participates in a conversation; returns its row. */
  private async assertParticipant(conversationId: string) {
    const organizationId = getOrganizationId();
    const ctx = getContext();
    if (!organizationId || !ctx) throw new Error('No context');
    const conv = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        organizationId,
        participants: { some: { userId: ctx.userId } },
      },
      include: { participants: { select: { userId: true } } },
    });
    if (!conv) throw notFound('Conversation introuvable.');
    return { conv, ctx };
  }

  /** Find-or-create a 1:1 DM between the caller and another user. */
  async getOrCreateDirect(otherUserId: string): Promise<ConversationDto> {
    const organizationId = getOrganizationId();
    const ctx = getContext();
    if (!organizationId || !ctx) throw new Error('No context');
    if (otherUserId === ctx.userId) {
      throw badRequest('Impossible de démarrer une conversation avec soi-même.');
    }

    const other = await prisma.user.findFirst({
      where: { id: otherUserId, organizationId, disabledAt: null },
    });
    if (!other) throw notFound('Utilisateur introuvable.');

    // Existing DM with exactly these two participants?
    const existing = await prisma.conversation.findFirst({
      where: {
        organizationId,
        isGroup: false,
        AND: [
          { participants: { some: { userId: ctx.userId } } },
          { participants: { some: { userId: otherUserId } } },
        ],
      },
    });
    const conv =
      existing ??
      (await prisma.conversation.create({
        data: {
          organizationId,
          isGroup: false,
          createdById: ctx.userId,
          participants: {
            create: [{ userId: ctx.userId }, { userId: otherUserId }],
          },
        },
      }));

    return this.getConversation(conv.id);
  }

  /** Create a named group conversation. */
  async createGroup(userIds: string[], title: string): Promise<ConversationDto> {
    const organizationId = getOrganizationId();
    const ctx = getContext();
    if (!organizationId || !ctx) throw new Error('No context');
    const name = (title ?? '').trim();
    if (!name) throw badRequest('Le nom du groupe est requis.');

    const members = [...new Set([ctx.userId, ...userIds])];
    if (members.length < 2) {
      throw badRequest('Ajoutez au moins un autre participant.');
    }
    // Keep all members within the org.
    const valid = await prisma.user.findMany({
      where: { id: { in: members }, organizationId, disabledAt: null },
      select: { id: true },
    });
    const validIds = new Set(valid.map((v) => v.id));

    const conv = await prisma.conversation.create({
      data: {
        organizationId,
        isGroup: true,
        title: name,
        createdById: ctx.userId,
        participants: {
          create: members
            .filter((id) => validIds.has(id))
            .map((id) => ({ userId: id, isAdmin: id === ctx.userId })),
        },
      },
    });
    return this.getConversation(conv.id);
  }

  /** Full conversation detail (membership enforced). */
  async getConversation(id: string): Promise<ConversationDto> {
    const { conv, ctx } = await this.assertParticipant(id);
    const userMap = await this.resolveUsers(conv.participants.map((p) => p.userId));
    const participants = conv.participants
      .map((p) => userMap.get(p.userId))
      .filter((u): u is ChatUserDto => !!u);
    const others = participants.filter((u) => u.id !== ctx.userId);

    const full = await prisma.conversation.findUnique({ where: { id } });
    return {
      id,
      isGroup: full!.isGroup,
      title: full!.isGroup
        ? full!.title || 'Groupe'
        : others[0]?.name || 'Conversation',
      participants,
      lastMessage: null,
      unreadCount: 0,
      lastMessageAt: full!.lastMessageAt.toISOString(),
      createdById: full!.createdById,
    };
  }

  /** Messages in a conversation, oldest → newest (membership enforced). */
  async getMessages(
    conversationId: string,
    args: { limit?: number; before?: string } = {},
  ): Promise<{ items: ChatMessageDto[]; hasMore: boolean }> {
    await this.assertParticipant(conversationId);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);

    const rows = await prisma.chatMessage.findMany({
      where: {
        conversationId,
        ...(args.before ? { createdAt: { lt: new Date(args.before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse(); // oldest → newest

    const userMap = await this.resolveUsers(page.map((m) => m.senderUserId));
    const items: ChatMessageDto[] = page.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderUserId: m.senderUserId,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      sender:
        userMap.get(m.senderUserId) ?? {
          id: m.senderUserId,
          name: '(inconnu)',
          email: '',
          color: null,
          avatarUrl: null,
          online: false,
        },
    }));
    return { items, hasMore };
  }

  /** Post a message; bumps lastMessageAt and marks the sender read. */
  async sendMessage(conversationId: string, body: string): Promise<ChatMessageDto> {
    const { ctx } = await this.assertParticipant(conversationId);
    const text = (body ?? '').trim();
    if (!text) throw badRequest('Le message est vide.');
    if (text.length > 5000) throw badRequest('Message trop long (max 5000).');

    const now = new Date();
    const [msg] = await prisma.$transaction([
      prisma.chatMessage.create({
        data: { conversationId, senderUserId: ctx.userId, body: text },
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: now },
      }),
      prisma.conversationParticipant.updateMany({
        where: { conversationId, userId: ctx.userId },
        data: { lastReadAt: now },
      }),
    ]);

    const userMap = await this.resolveUsers([ctx.userId]);
    return {
      id: msg.id,
      conversationId,
      senderUserId: ctx.userId,
      body: msg.body,
      createdAt: msg.createdAt.toISOString(),
      sender: userMap.get(ctx.userId) ?? {
        id: ctx.userId,
        name: 'Moi',
        email: '',
        color: null,
        avatarUrl: null,
        online: true,
      },
    };
  }

  /** Mark a conversation read up to now for the caller. */
  async markRead(conversationId: string): Promise<void> {
    const { ctx } = await this.assertParticipant(conversationId);
    await prisma.conversationParticipant.updateMany({
      where: { conversationId, userId: ctx.userId },
      data: { lastReadAt: new Date() },
    });
  }
}
