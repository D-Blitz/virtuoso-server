import prisma from '../prisma';

export class ClosureService {
  async create(data: any) {
    return prisma.closure.create({
      data,
      include: { location: true },
    });
  }

  async getAll() {
    return prisma.closure.findMany({
      include: { location: true },
      orderBy: { startDate: 'asc' },
    });
  }

  async update(id: string, data: any) {
    return prisma.closure.update({
      where: { id },
      data,
      include: { location: true },
    });
  }

  async delete(id: string) {
    return prisma.closure.delete({ where: { id } });
  }
}
