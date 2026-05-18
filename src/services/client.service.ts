import prisma from '../prisma';

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
