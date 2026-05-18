import prisma from '../prisma';

export class TermService {
  async create(data: any) {
    return prisma.term.create({
      data,
      include: {
        location: true,
      },
    });
  }

  async getAll() {
    return prisma.term.findMany({
      include: {
        location: true,
      },
      orderBy: { startDate: 'asc' },
    });
  }

  async update(id: string, data: any) {
    return prisma.term.update({
      where: { id },
      data,
      include: {
        location: true,
      },
    });
  }

  async delete(id: string) {
    return prisma.term.delete({
      where: { id },
    });
  }
}
