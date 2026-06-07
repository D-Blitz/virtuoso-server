/**
 * Unavailability — N.4. One-time or recurring time ranges during which a
 * single resource (one facilitator OR one room) is blocked from booking.
 *
 * Recurrence is delivered by eager materialization, mirroring lessons: a
 * single "every Tuesday morning until June" declaration writes N rows in
 * one transaction, all sharing the same `recurrenceGroupId`. There is no
 * RecurrenceSeries row — that table is bound to lesson defaults (price,
 * color, room, location, service) that don't generalize to a blocking
 * range. The pure `generateOccurrences` generator is reused so the
 * recurrence RULES are identical to those of lessons.
 *
 * Scope semantics on update/delete mirror ScheduledEvent:
 *   - THIS (default): the single row only.
 *   - ALL: every sibling sharing `recurrenceGroupId` (including this one).
 *
 * Trash is honoured: soft delete via the shared softDelete helper. The
 * Prisma scoping extension auto-excludes trashed rows from all conflict
 * checks (`getOverlapping`) and listings.
 */

import prisma from '../prisma';
import { auditLog } from './audit/audit.service';
import { snapshotUnavailability } from './audit/snapshots';
import { softDelete } from './trash/softDelete';
import {
  generateOccurrences,
  isFrequency,
  type Frequency,
} from './recurrence/recurrence';
import { getOrganizationId } from '../auth/context';
import { randomUUID } from 'crypto';

export type UnavailabilityScope = 'THIS' | 'ALL';

export interface UnavailabilityRecurrenceInput {
  /** WEEKLY / BIWEEKLY / MONTHLY / BIMONTHLY / TRIMESTRAL / SEMIANNUAL / YEARLY */
  frequency: Frequency;
  /** Inclusive last occurrence boundary (ISO). */
  endDate: string;
}

export interface CreateUnavailabilityInput {
  startTime: string; // ISO
  endTime: string; // ISO
  reason?: string | null;
  /** Exactly one of facilitatorId / roomId. */
  facilitatorId?: string | null;
  roomId?: string | null;
  /** Optional rule — when present, N rows are materialized. */
  recurrence?: UnavailabilityRecurrenceInput | null;
}

export interface UpdateUnavailabilityInput {
  startTime?: string;
  endTime?: string;
  reason?: string | null;
  facilitatorId?: string | null;
  roomId?: string | null;
}

export interface ListUnavailabilityFilters {
  /** Inclusive lower bound (ISO). Matches rows whose `endTime > from`. */
  from?: Date;
  /** Inclusive upper bound (ISO). Matches rows whose `startTime < to`. */
  to?: Date;
  facilitatorId?: string;
  roomId?: string;
}

function parseDateStrict(s: string, label: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${label}: ${s}`);
  }
  return d;
}

function assertSingleResource(facilitatorId?: string | null, roomId?: string | null) {
  const hasFac = !!facilitatorId;
  const hasRoom = !!roomId;
  if (hasFac === hasRoom) {
    throw new Error(
      'Unavailability targets exactly one resource: facilitatorId XOR roomId.',
    );
  }
}

export class UnavailabilityService {
  /**
   * Create one row, or N rows when a recurrence rule is supplied. Returns
   * the materialized row(s) in `startTime` order.
   */
  async create(input: CreateUnavailabilityInput) {
    assertSingleResource(input.facilitatorId, input.roomId);
    const startTime = parseDateStrict(input.startTime, 'startTime');
    const endTime = parseDateStrict(input.endTime, 'endTime');
    if (endTime <= startTime) {
      throw new Error('endTime must be after startTime');
    }
    const durationMs = endTime.getTime() - startTime.getTime();

    const sharedScalar = {
      reason: input.reason ?? null,
      facilitatorId: input.facilitatorId ?? null,
      roomId: input.roomId ?? null,
    };

    // One-shot block. `organizationId` is auto-injected by the scoping
    // extension at runtime; the cast keeps the compiler from demanding it
    // up-front (same pattern as ClosureService.create).
    if (!input.recurrence) {
      const created = await prisma.unavailability.create({
        data: { ...sharedScalar, startTime, endTime } as any,
      });
      void auditLog.record({
        action: 'CREATE',
        entityType: 'Unavailability',
        entityId: created.id,
        after: snapshotUnavailability(created),
      });
      return [created];
    }

    // Series — materialize every occurrence eagerly.
    if (!isFrequency(input.recurrence.frequency)) {
      throw new Error(`Invalid recurrence.frequency: ${input.recurrence.frequency}`);
    }
    const recEndDate = parseDateStrict(input.recurrence.endDate, 'recurrence.endDate');
    if (recEndDate.getTime() < startTime.getTime()) {
      throw new Error('recurrence.endDate must be on or after startTime');
    }
    const occurrences = generateOccurrences({
      frequency: input.recurrence.frequency,
      startDate: startTime,
      endDate: recEndDate,
      durationMs,
    });

    const recurrenceGroupId = randomUUID();
    const created = await prisma.$transaction((tx) =>
      Promise.all(
        occurrences.map((occ) =>
          tx.unavailability.create({
            data: {
              ...sharedScalar,
              startTime: occ.startTime,
              endTime: occ.endTime,
              recurrenceGroupId,
              recurrenceFrequency: input.recurrence!.frequency,
              recurrenceEndDate: recEndDate,
              // Auto-injection of organizationId only fires outside a
              // transaction — pin it explicitly here.
              organizationId: getOrganizationId()!,
            },
          }),
        ),
      ),
    );

    for (const row of created) {
      void auditLog.record({
        action: 'CREATE',
        entityType: 'Unavailability',
        entityId: row.id,
        after: snapshotUnavailability(row),
      });
    }
    return created;
  }

  /**
   * List blocks overlapping `[from, to)`. Both bounds optional; defaults
   * mirror the ScheduledEvent listing window if neither is supplied
   * (caller usually provides them via a calendar fetch).
   */
  async list(filters: ListUnavailabilityFilters = {}) {
    const where: Record<string, any> = {};
    if (filters.from) where.endTime = { gt: filters.from };
    if (filters.to) where.startTime = { lt: filters.to };
    if (filters.facilitatorId) where.facilitatorId = filters.facilitatorId;
    if (filters.roomId) where.roomId = filters.roomId;
    return prisma.unavailability.findMany({
      where,
      include: {
        facilitator: { select: { id: true, firstname: true, lastname: true } },
        room: { select: { id: true, name: true } },
      },
      orderBy: { startTime: 'asc' },
    });
  }

  /**
   * Find every Unavailability row that conflicts with the candidate slot for
   * the named resource. Used by:
   *   - the admin event-create validator (raises FACILITATOR_BLOCKED /
   *     ROOM_BLOCKED warnings),
   *   - the booking-widget slot suggester (drops the slot),
   *   - the import room-conflict pass.
   *
   * Trashed rows are filtered out by the Prisma scoping extension.
   */
  async findConflicts(params: {
    startTime: Date;
    endTime: Date;
    facilitatorIds?: string[];
    roomId?: string;
    /** Exclude a row from the conflict list (e.g. self on update). */
    excludeId?: string;
  }) {
    const orClauses: Record<string, any>[] = [];
    if (params.facilitatorIds && params.facilitatorIds.length > 0) {
      orClauses.push({ facilitatorId: { in: params.facilitatorIds } });
    }
    if (params.roomId) {
      orClauses.push({ roomId: params.roomId });
    }
    if (orClauses.length === 0) return [];

    return prisma.unavailability.findMany({
      where: {
        ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
        startTime: { lt: params.endTime },
        endTime: { gt: params.startTime },
        OR: orClauses,
      },
      include: {
        facilitator: { select: { id: true, firstname: true, lastname: true } },
        room: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Patch a single row (`THIS`) or every sibling sharing the
   * recurrenceGroupId (`ALL`). The resource and the recurrence-rule fields
   * are NOT editable here — admins delete the group and create a fresh one
   * if the targeted facilitator/room/frequency needs to change.
   */
  async update(id: string, patch: UpdateUnavailabilityInput, scope: UnavailabilityScope = 'THIS') {
    if (patch.facilitatorId !== undefined || patch.roomId !== undefined) {
      assertSingleResource(
        patch.facilitatorId ?? undefined,
        patch.roomId ?? undefined,
      );
    }

    const before = await prisma.unavailability.findUniqueOrThrow({ where: { id } });

    const scalarPatch: Record<string, any> = {};
    if (patch.startTime !== undefined) {
      scalarPatch.startTime = parseDateStrict(patch.startTime, 'startTime');
    }
    if (patch.endTime !== undefined) {
      scalarPatch.endTime = parseDateStrict(patch.endTime, 'endTime');
    }
    if (patch.reason !== undefined) scalarPatch.reason = patch.reason;
    if (patch.facilitatorId !== undefined) scalarPatch.facilitatorId = patch.facilitatorId;
    if (patch.roomId !== undefined) scalarPatch.roomId = patch.roomId;

    if (
      scalarPatch.startTime &&
      scalarPatch.endTime &&
      scalarPatch.endTime <= scalarPatch.startTime
    ) {
      throw new Error('endTime must be after startTime');
    }

    if (scope === 'ALL' && before.recurrenceGroupId) {
      // Apply to every sibling row. Updating time-of-day inside a series is
      // ambiguous (different days) so reject explicit start/end on ALL.
      if (scalarPatch.startTime || scalarPatch.endTime) {
        throw new Error(
          'startTime / endTime cannot be edited on ALL scope — delete the group and create a new one.',
        );
      }
      const siblings = await prisma.unavailability.findMany({
        where: { recurrenceGroupId: before.recurrenceGroupId },
      });
      await prisma.unavailability.updateMany({
        where: { recurrenceGroupId: before.recurrenceGroupId },
        data: scalarPatch,
      });
      for (const s of siblings) {
        const after = { ...s, ...scalarPatch };
        void auditLog.record({
          action: 'UPDATE',
          entityType: 'Unavailability',
          entityId: s.id,
          before: snapshotUnavailability(s),
          after: snapshotUnavailability(after),
        });
      }
      return prisma.unavailability.findUniqueOrThrow({ where: { id } });
    }

    // THIS — patch just this row. Detach from the group so future ALL-edits
    // on siblings stop affecting it (mirrors ScheduledEvent's THIS detach).
    const detach = before.recurrenceGroupId
      ? {
          recurrenceGroupId: null,
          recurrenceFrequency: null,
          recurrenceEndDate: null,
        }
      : {};
    const updated = await prisma.unavailability.update({
      where: { id },
      data: { ...scalarPatch, ...detach },
    });
    void auditLog.record({
      action: 'UPDATE',
      entityType: 'Unavailability',
      entityId: id,
      before: snapshotUnavailability(before),
      after: snapshotUnavailability(updated),
    });
    return updated;
  }

  /**
   * Soft-delete one row (`THIS`) or every sibling sharing the
   * recurrenceGroupId (`ALL`). Rows go to the trash bin and can be
   * restored from `/admin/corbeille`.
   */
  async delete(id: string, scope: UnavailabilityScope = 'THIS') {
    if (scope === 'ALL') {
      const before = await prisma.unavailability.findUniqueOrThrow({ where: { id } });
      if (before.recurrenceGroupId) {
        const siblings = await prisma.unavailability.findMany({
          where: { recurrenceGroupId: before.recurrenceGroupId },
        });
        for (const s of siblings) {
          await softDelete<any>('unavailability', s.id);
          void auditLog.record({
            action: 'DELETE',
            entityType: 'Unavailability',
            entityId: s.id,
            before: snapshotUnavailability(s),
          });
        }
        return { deletedIds: siblings.map((s) => s.id) };
      }
      // No group — fall through to single-row delete.
    }
    const before = await softDelete<any>('unavailability', id);
    void auditLog.record({
      action: 'DELETE',
      entityType: 'Unavailability',
      entityId: id,
      before: snapshotUnavailability(before),
    });
    return { deletedIds: [id] };
  }
}

export const unavailabilityService = new UnavailabilityService();
