import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class ServiceService {
  async create(data: any) {
    return prisma.service.create({ data });
  }

  async getAll() {
    return prisma.service.findMany();
  }

  async update(id: string, data: any) {
    return prisma.service.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return prisma.service.delete({
      where: { id },
    });
  }
}
