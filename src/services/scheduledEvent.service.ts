import prisma from '../prisma';
import { getOrganizationId } from '../auth/context';

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

export class ScheduledEventService {
  async create(data: any) {
    if (!data.serviceId) throw new Error('Missing serviceId');
    const organizationId = getOrganizationId()!;

    const service = await prisma.service.findUniqueOrThrow({
      where: { id: data.serviceId },
      select: { serviceCategoryId: true },
    });

    return prisma.scheduledEvent.create({
      data: {
        organizationId,
        color: data.color,
        price: data.price,
        notes: data.notes,
        recurrence: data.recurrence || undefined,
        startTime: data.startTime,
        endTime: data.endTime,
        roomId: data.roomId,
        locationId: data.locationId,
        serviceId: data.serviceId,
        serviceCategoryId: service.serviceCategoryId,
        clients: {
          connect: data.clientIds?.map((id: string) => ({ id })) || [],
        },
        facilitators: {
          connect: data.facilitatorIds?.map((id: string) => ({ id })) || [],
        },
        tags: {
          connect: data.tagIds?.map((id: string) => ({ id })) || [],
        },
      },
      include: {
        clients: true,
        facilitators: true,
        room: true,
        tags: true,
        service: true,
        location: true,
        serviceCategory: true,
      },
    });
  }

  /**
   * List events overlapping a date window.
   *
   * "Overlap" means: the event happens (or its recurrence series could
   * generate an occurrence) inside [from, to]. Concretely we keep an event
   * row if either:
   *   - it's a single event (`recurrence` null) with startTime <= to AND
   *     endTime >= from
   *   - it's a recurring series whose first occurrence is on/before `to`
   *     AND whose recurrenceEnd (if set) is on/after `from`
   *
   * Caller is still responsible for expanding the series into concrete
   * occurrences via `generateRecurringInstancesInRange` on the frontend.
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
        // Single events overlap the window OR recurring series overlap it.
        OR: [
          {
            recurrence: null,
            startTime: { lte: to },
            endTime: { gte: from },
          },
          {
            recurrence: { not: null },
            startTime: { lte: to },
            OR: [
              { recurrenceEnd: null },
              { recurrenceEnd: { gte: from } },
            ],
          },
        ],
      },
      include: {
        clients: true,
        facilitators: true,
        room: true,
        tags: true,
        service: true,
        location: true,
        serviceCategory: true,
      },
      orderBy: { startTime: 'asc' },
    });
  }

  async update(id: string, data: any) {
    try {
      const {
        clientIds,
        facilitatorIds,
        tagIds,
        roomId,
        locationId,
        serviceId,
        ...rest
      } = data;

      const service = await prisma.service.findUniqueOrThrow({
        where: { id: serviceId },
        select: { serviceCategoryId: true },
      });

      return await prisma.scheduledEvent.update({
        where: { id },
        data: {
          ...rest,
          roomId,
          locationId,
          serviceId,
          serviceCategoryId: service.serviceCategoryId,
          clients: {
            set: clientIds?.map((id: string) => ({ id })) || [],
          },
          facilitators: {
            set: facilitatorIds?.map((id: string) => ({ id })) || [],
          },
          tags: {
            set: tagIds?.map((id: string) => ({ id })) || [],
          },
        },
      });
    } catch (error) {
      console.error('Prisma Update Error:', error);
      throw error;
    }
  }

  async delete(id: string) {
    return prisma.scheduledEvent.delete({
      where: { id },
    });
  }
}
