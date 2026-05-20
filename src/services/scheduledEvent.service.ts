import prisma from '../prisma';
import { getOrganizationId } from '../auth/context';
import {
  generateOccurrences,
  isFrequency,
  type Frequency,
} from './recurrence/recurrence';

/**
 * Default window when the caller doesn't pass from/to. Bounded so we never
 * return "all events ever". The full audit (docs/PERF_AUDIT.md) recommends
 * the admin pass an explicit window for everything except smoke-tests.
 */
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_LOOKAHEAD_DAYS = 90;

export type ListEventsFilters = {
  from?: Date;
  to?: Date;
};

/** New recurrence rule shape accepted on event create. */
export type RecurrenceInputPayload = {
  frequency: Frequency;
  /** ISO datetime string or Date — the last possible occurrence boundary. */
  endDate: string | Date;
};

const FULL_EVENT_INCLUDE = {
  clients: true,
  facilitators: true,
  room: true,
  tags: true,
  service: true,
  location: true,
  serviceCategory: true,
} as const;

export class ScheduledEventService {
  /**
   * Create a standalone event, or a recurring series + all its occurrences.
   *
   * Always returns an array — `[event]` for a single create, or the full
   * list of materialized occurrences for a series.
   */
  async create(data: any) {
    if (!data.serviceId) throw new Error('Missing serviceId');
    const organizationId = getOrganizationId()!;

    const service = await prisma.service.findUniqueOrThrow({
      where: { id: data.serviceId },
      select: { serviceCategoryId: true },
    });

    const startTime = new Date(data.startTime);
    const endTime = new Date(data.endTime);
    const durationMs = endTime.getTime() - startTime.getTime();
    if (
      Number.isNaN(startTime.getTime()) ||
      Number.isNaN(endTime.getTime())
    ) {
      throw new Error('Invalid startTime / endTime');
    }
    if (durationMs <= 0) {
      throw new Error('endTime must be after startTime');
    }

    const clientConnects = (data.clientIds ?? []).map((id: string) => ({ id }));
    const facilitatorConnects = (data.facilitatorIds ?? []).map((id: string) => ({
      id,
    }));
    const tagConnects = (data.tagIds ?? []).map((id: string) => ({ id }));

    const occurrencePayload = {
      organizationId,
      color: data.color,
      price: data.price,
      notes: data.notes ?? null,
      roomId: data.roomId,
      locationId: data.locationId,
      serviceId: data.serviceId,
      serviceCategoryId: service.serviceCategoryId,
    };

    const rec = data.recurrence;
    const hasRecurrence =
      rec && typeof rec === 'object' && rec.frequency && rec.endDate;

    if (!hasRecurrence) {
      const created = await prisma.scheduledEvent.create({
        data: {
          ...occurrencePayload,
          startTime,
          endTime,
          clients: { connect: clientConnects },
          facilitators: { connect: facilitatorConnects },
          tags: { connect: tagConnects },
        },
        include: FULL_EVENT_INCLUDE,
      });
      return [created];
    }

    // Series + occurrences.
    if (!isFrequency(rec.frequency)) {
      throw new Error(`Invalid recurrence.frequency: ${rec.frequency}`);
    }
    const recEndDate = new Date(rec.endDate);
    if (Number.isNaN(recEndDate.getTime())) {
      throw new Error('Invalid recurrence.endDate');
    }
    if (recEndDate.getTime() < startTime.getTime()) {
      throw new Error('recurrence.endDate must be on or after startTime');
    }

    const occurrences = generateOccurrences({
      frequency: rec.frequency,
      startDate: startTime,
      endDate: recEndDate,
      durationMs,
    });

    return prisma.$transaction(async (tx) => {
      // `as any` here is a temporary scaffold: the new RecurrenceSeries model
      // and ScheduledEvent.seriesId field exist in schema.prisma but the
      // generated Prisma client may not have caught up on the developer's
      // machine yet (Windows DLL lock on `prisma generate`). Once
      // regenerated, these casts are harmless no-ops.
      const series = await (tx as any).recurrenceSeries.create({
        data: {
          organizationId,
          frequency: rec.frequency,
          startDate: startTime,
          endDate: recEndDate,
          defaultColor: data.color,
          defaultPrice: data.price,
          defaultNotes: data.notes ?? null,
          defaultRoomId: data.roomId,
          defaultLocationId: data.locationId,
          defaultServiceId: data.serviceId,
        },
      });

      // createMany doesn't support nested connects on many-to-many, so we
      // create each occurrence individually. N writes per series; bounded
      // by MAX_OCCURRENCES (500) in the generator.
      const created: unknown[] = [];
      for (const occ of occurrences) {
        const row = await tx.scheduledEvent.create({
          data: {
            ...occurrencePayload,
            startTime: occ.startTime,
            endTime: occ.endTime,
            seriesId: series.id,
            clients: { connect: clientConnects },
            facilitators: { connect: facilitatorConnects },
            tags: { connect: tagConnects },
          } as any,
          include: FULL_EVENT_INCLUDE,
        });
        created.push(row);
      }
      return created;
    });
  }

  /**
   * List events overlapping a date window.
   *
   * Now that every recurrence occurrence is a real row (Phase 0.2), the
   * overlap test is simply `startTime <= to AND endTime >= from`. No need
   * for the previous OR clause that handled virtual recurring rows.
   *
   * If from/to aren't supplied, defaults to [now-30d, now+90d].
   */
  async getAll(filters: ListEventsFilters = {}) {
    const now = new Date();
    const from =
      filters.from ??
      new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const to =
      filters.to ??
      new Date(now.getTime() + DEFAULT_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

    return prisma.scheduledEvent.findMany({
      where: {
        startTime: { lte: to },
        endTime: { gte: from },
      },
      include: FULL_EVENT_INCLUDE,
      orderBy: { startTime: 'asc' },
    });
  }

  /**
   * Update with a mutation scope:
   *   - 'THIS' (default): updates this row only. If the row was attached
   *     to a series (`seriesId != null`), this is also a DETACH: the row
   *     becomes a standalone event and stops being affected by future
   *     ALL-scope edits on that series.
   *   - 'ALL': updates every occurrence still attached to the same series
   *     plus the series's own default columns. Already-detached rows
   *     (seriesId = null) are NOT affected — they've left the series.
   */
  async update(id: string, data: any, scope: 'THIS' | 'ALL' = 'THIS') {
    try {
      const {
        clientIds,
        facilitatorIds,
        tagIds,
        roomId,
        locationId,
        serviceId,
        recurrence: recurrenceInput,
        ...rest
      } = data;

      // Diagnostic — logs on every event update. Easy to grep for
      // "[evt:update]" in the server stdout. Helps confirm whether
      // promote-to-series fires when the admin adds recurrence to an
      // existing event. Remove (or downgrade to debug-level) once the
      // recurrence flows are battle-tested.
      console.log(
        `[evt:update] id=${id} scope=${scope} hasRecurrence=${!!recurrenceInput} ` +
          `frequency=${recurrenceInput?.frequency ?? '-'} endDate=${recurrenceInput?.endDate ?? '-'}`,
      );

      const service = await prisma.service.findUniqueOrThrow({
        where: { id: serviceId },
        select: { serviceCategoryId: true },
      });

      const sharedScalarPatch = {
        ...rest,
        roomId,
        locationId,
        serviceId,
        serviceCategoryId: service.serviceCategoryId,
      };

      const relationPatch = {
        clients: { set: clientIds?.map((id: string) => ({ id })) || [] },
        facilitators: {
          set: facilitatorIds?.map((id: string) => ({ id })) || [],
        },
        tags: { set: tagIds?.map((id: string) => ({ id })) || [] },
      };

      // Up-front lookup — we need the target's seriesId regardless of scope
      // to decide between promote / THIS / ALL paths.
      const target = await prisma.scheduledEvent.findUniqueOrThrow({
        where: { id },
        select: { seriesId: true, startTime: true, endTime: true } as any,
      });
      const targetSeriesId = (target as any).seriesId as string | null;

      // PROMOTE-TO-SERIES path: the user edited a standalone event and
      // added a recurrence rule. Create the series, attach the target as
      // its first occurrence, and materialize the extra occurrences.
      // Scope is irrelevant here — promotion is its own operation.
      const hasRecurrenceInput =
        recurrenceInput &&
        typeof recurrenceInput === 'object' &&
        recurrenceInput.frequency &&
        recurrenceInput.endDate;

      if (hasRecurrenceInput && !targetSeriesId) {
        console.log(`[evt:update] entering PROMOTE-TO-SERIES path for event ${id}`);
        if (!isFrequency(recurrenceInput.frequency)) {
          throw new Error(
            `Invalid recurrence.frequency: ${recurrenceInput.frequency}`,
          );
        }
        const recEndDate = new Date(recurrenceInput.endDate);
        if (Number.isNaN(recEndDate.getTime())) {
          throw new Error('Invalid recurrence.endDate');
        }

        // The "first occurrence" inherits the new (possibly edited) start /
        // end from the patch. Fall back to existing values if not present.
        const newStart = sharedScalarPatch.startTime
          ? new Date(sharedScalarPatch.startTime)
          : (target as any).startTime;
        const newEnd = sharedScalarPatch.endTime
          ? new Date(sharedScalarPatch.endTime)
          : (target as any).endTime;
        const durationMs = newEnd.getTime() - newStart.getTime();
        if (durationMs <= 0) {
          throw new Error('endTime must be after startTime');
        }
        if (recEndDate.getTime() < newStart.getTime()) {
          throw new Error('recurrence.endDate must be on or after startTime');
        }

        const occurrences = generateOccurrences({
          frequency: recurrenceInput.frequency,
          startDate: newStart,
          endDate: recEndDate,
          durationMs,
        });

        const organizationId = getOrganizationId()!;
        const occurrencePayload = {
          organizationId,
          color: rest.color,
          price: rest.price,
          notes: rest.notes ?? null,
          roomId,
          locationId,
          serviceId,
          serviceCategoryId: service.serviceCategoryId,
        };
        const clientConnects = (clientIds ?? []).map((cid: string) => ({
          id: cid,
        }));
        const facilitatorConnects = (facilitatorIds ?? []).map(
          (fid: string) => ({ id: fid }),
        );
        const tagConnects = (tagIds ?? []).map((tid: string) => ({ id: tid }));

        return await prisma.$transaction(async (tx) => {
          const series = await (tx as any).recurrenceSeries.create({
            data: {
              organizationId,
              frequency: recurrenceInput.frequency,
              startDate: newStart,
              endDate: recEndDate,
              defaultColor: rest.color ?? '#999999',
              defaultPrice: rest.price ?? 0,
              defaultNotes: rest.notes ?? null,
              defaultRoomId: roomId,
              defaultLocationId: locationId,
              defaultServiceId: serviceId,
            },
          });

          // Update the target row with the patch + attach it to the new
          // series. Becomes occurrences[0] of the new series.
          const updated = await tx.scheduledEvent.update({
            where: { id },
            data: {
              ...sharedScalarPatch,
              ...relationPatch,
              seriesId: series.id,
            } as any,
          });

          // Materialize occurrences[1..N-1]; occurrences[0] IS the target.
          for (let i = 1; i < occurrences.length; i++) {
            const occ = occurrences[i];
            await tx.scheduledEvent.create({
              data: {
                ...occurrencePayload,
                startTime: occ.startTime,
                endTime: occ.endTime,
                seriesId: series.id,
                clients: { connect: clientConnects },
                facilitators: { connect: facilitatorConnects },
                tags: { connect: tagConnects },
              } as any,
            });
          }

          console.log(
            `[evt:update] promoted event ${id} to series ${series.id} with ${occurrences.length} occurrence(s)`,
          );
          return updated;
        });
      }

      if (scope === 'THIS') {
        // Detach this occurrence from its series (no-op if seriesId is
        // already null) and apply the patch.
        return await prisma.scheduledEvent.update({
          where: { id },
          data: {
            ...sharedScalarPatch,
            ...relationPatch,
            seriesId: null,
          } as any,
        });
      }

      // scope === 'ALL': fan out to siblings, update series defaults.
      const seriesId = targetSeriesId;

      if (!seriesId) {
        // No series — ALL collapses to THIS.
        return await prisma.scheduledEvent.update({
          where: { id },
          data: { ...sharedScalarPatch, ...relationPatch } as any,
        });
      }

      // CRITICAL: time-of-day propagation, NOT full datetime overwrite.
      //
      // If we blindly applied `sharedScalarPatch.startTime` and `.endTime`
      // to every sibling, every occurrence would collapse to the single
      // datetime the user edited — visually deleting the whole series
      // except for one date. Instead:
      //
      //   - Extract the time-of-day (HH:mm:ss) from the new startTime.
      //   - Compute the new duration from new endTime − startTime.
      //   - For each sibling: keep its existing DATE, apply the new
      //     time-of-day, and set endTime = newStartTime + duration.
      //
      // Net effect: "move all my Monday lessons to 15:00" works; weekday
      // and date changes are silently ignored on ALL scope (per design:
      // changing the series pattern requires a separate flow).
      const newStartFromPatch =
        typeof sharedScalarPatch.startTime === 'string' ||
        sharedScalarPatch.startTime instanceof Date
          ? new Date(sharedScalarPatch.startTime as string | Date)
          : null;
      const newEndFromPatch =
        typeof sharedScalarPatch.endTime === 'string' ||
        sharedScalarPatch.endTime instanceof Date
          ? new Date(sharedScalarPatch.endTime as string | Date)
          : null;

      const newDurationMs =
        newStartFromPatch && newEndFromPatch
          ? newEndFromPatch.getTime() - newStartFromPatch.getTime()
          : null;

      // Strip startTime/endTime from the patch we apply to siblings —
      // they're recomputed per-sibling below.
      const {
        startTime: _patchStart,
        endTime: _patchEnd,
        ...siblingScalarPatch
      } = sharedScalarPatch as any;

      return await prisma.$transaction(async (tx) => {
        const siblings = await tx.scheduledEvent.findMany({
          where: { seriesId } as any,
          select: { id: true, startTime: true, endTime: true },
        });

        let last: any = null;
        for (const sib of siblings) {
          let nextStart = sib.startTime;
          let nextEnd = sib.endTime;
          if (newStartFromPatch && newDurationMs !== null) {
            // Preserve sibling's date; overwrite hours/minutes/seconds.
            const composed = new Date(sib.startTime);
            composed.setHours(
              newStartFromPatch.getHours(),
              newStartFromPatch.getMinutes(),
              newStartFromPatch.getSeconds(),
              newStartFromPatch.getMilliseconds(),
            );
            nextStart = composed;
            nextEnd = new Date(composed.getTime() + newDurationMs);
          }

          last = await tx.scheduledEvent.update({
            where: { id: sib.id },
            data: {
              ...siblingScalarPatch,
              startTime: nextStart,
              endTime: nextEnd,
              ...relationPatch,
            },
          });
        }

        // Sync the series defaults so future occurrences (e.g. if we ever
        // extend the series) would inherit consistently.
        await (tx as any).recurrenceSeries.update({
          where: { id: seriesId },
          data: {
            defaultColor: rest.color ?? undefined,
            defaultPrice: rest.price ?? undefined,
            defaultNotes: rest.notes ?? null,
            defaultRoomId: roomId,
            defaultLocationId: locationId,
            defaultServiceId: serviceId,
          },
        });
        return last;
      });
    } catch (error) {
      console.error('Prisma Update Error:', error);
      throw error;
    }
  }

  /**
   * Delete with a mutation scope:
   *   - 'THIS' (default): delete this row only.
   *   - 'ALL': delete every occurrence still attached to the same series,
   *     and mark the series CANCELED. Already-detached rows are not
   *     touched — they've left the series.
   */
  async delete(id: string, scope: 'THIS' | 'ALL' = 'THIS') {
    if (scope === 'THIS') {
      return prisma.scheduledEvent.delete({ where: { id } });
    }

    const target = await prisma.scheduledEvent.findUniqueOrThrow({
      where: { id },
      select: { seriesId: true } as any,
    });
    const seriesId = (target as any).seriesId as string | null;

    if (!seriesId) {
      // Standalone event — ALL collapses to THIS.
      return prisma.scheduledEvent.delete({ where: { id } });
    }

    return prisma.$transaction(async (tx) => {
      await tx.scheduledEvent.deleteMany({ where: { seriesId } as any });
      await (tx as any).recurrenceSeries.update({
        where: { id: seriesId },
        data: { status: 'CANCELED' },
      });
    });
  }
}
