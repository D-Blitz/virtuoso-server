import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class FacilitatorService {
  async create(data: any) {
    return prisma.facilitator.create({
      data,
      include: {
        locations: true,
        tags: true,
      },
    });
  }

  async getAll() {
    return prisma.facilitator.findMany({
      include: {
        locations: true,
        tags: true,
      },
    });
  }

  async update(id: string, data: any) {
    return prisma.facilitator.update({
      where: { id },
      data,
      include: {
        locations: true,
        tags: true,
      },
    });
  }

  async delete(id: string) {
    return prisma.facilitator.delete({
      where: { id },
    });
  }
}
