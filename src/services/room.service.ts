import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class RoomService {
  async create(data: any) {
    return prisma.room.create({ data });
  }

  async getAll() {
    return prisma.room.findMany();
  }

  async update(id: string, data: any) {
    return prisma.room.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return prisma.room.delete({
      where: { id },
    });
  }
}
