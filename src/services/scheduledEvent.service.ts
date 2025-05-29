import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class ScheduledEventService {
  async create(data: any) {
    return prisma.scheduledEvent.create({ data });
  }

  async getAll() {
    return prisma.scheduledEvent.findMany({
      include: {
        clients: true,
        facilitators: true,
        room: true,
        tags: true,
        service: true,
      },
    });
  }

  async update(id: string, data: any) {
    return prisma.scheduledEvent.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return prisma.scheduledEvent.delete({
      where: { id },
    });
  }
}
