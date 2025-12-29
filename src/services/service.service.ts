import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class ServiceService {
  async create(data: any) {
    return prisma.service.create({ 
      data,
      include: {
        facilitators: true,
        tags: true,
        serviceCategory: true,
      },
     });
  }

  async getAll() {
    return prisma.service.findMany({
      include: {
        facilitators: true,
        tags: true,
        serviceCategory: true,
      },
    });
  }

  async update(id: string, data: any) {
    return prisma.service.update({
      where: { id },
      data,
      include: {
        facilitators: true,
        tags: true,
        serviceCategory: true,
      },
    });
  }

  async delete(id: string) {
    return prisma.service.delete({
      where: { id },
    });
  }
}
