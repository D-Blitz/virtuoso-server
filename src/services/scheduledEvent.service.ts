import prisma from '../prisma';
import { getOrganizationId } from '../auth/context';

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

  async getAll() {
    return prisma.scheduledEvent.findMany({
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
