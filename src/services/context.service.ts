import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class ContextService {
  async getFullContext() {
    const [events, rooms, facilitators, tags, services, clients, serviceCategories, locations] = await Promise.all([
      prisma.scheduledEvent.findMany({
        include: {
          facilitators: true,
          clients: true,
          tags: true,
          room: true,
          service: true,
          serviceCategory: true,
          location: true,
        },
      }),
      prisma.room.findMany(),
      prisma.facilitator.findMany({ include: { tags: true, services: true } }),
      prisma.tag.findMany(),
      prisma.service.findMany({ include: { tags: true, facilitators: true } }),
      prisma.client.findMany(),
      prisma.serviceCategory.findMany(),
      prisma.location.findMany(),
    ]);

    return {
      events,
      rooms,
      facilitators,
      tags,
      services,
      clients,
      serviceCategories,
      locations,
    };
  }

  // Optional placeholder methods
  async createContextSnapshot(_data: any) {
    throw new Error("Not implemented. Context is read-only.");
  }

  async updateContextSnapshot(_id: string, _data: any) {
    throw new Error("Not implemented. Context is read-only.");
  }

  async deleteContextSnapshot(_id: string) {
    throw new Error("Not implemented. Context is read-only.");
  }
}
