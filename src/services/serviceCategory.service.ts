
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class ServiceCategoryService {
  async create(data: any) {
    return prisma.serviceCategory.create({ data });
  }

  async getAll() {
    return prisma.serviceCategory.findMany();
  }

  async update(id: string, data: any) {
    return prisma.serviceCategory.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return prisma.serviceCategory.delete({
      where: { id },
    });
  }
}