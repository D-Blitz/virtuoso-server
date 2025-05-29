import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class LocationService {
  async create(data: any) {
    return prisma.location.create({ data });
  }

  async getAll() {
    return prisma.location.findMany();
  }

  async update(id: string, data: any) {
    return prisma.location.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return prisma.location.delete({
      where: { id },
    });
  }
}
