import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class ClientService {
  async create(data: any) {
    return prisma.client.create({ data });
  }

  async getAll() {
    return prisma.client.findMany();
  }

  async update(id: string, data: any) {
    return prisma.client.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return prisma.client.delete({
      where: { id },
    });
  }
}
