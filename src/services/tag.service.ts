import prisma from '../prisma';

export class TagService {
  async create(data: any) {
    return prisma.tag.create({ data });
  }

  async getAll() {
    return prisma.tag.findMany();
  }

  async update(id: string, data: any) {
    return prisma.tag.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return prisma.tag.delete({
      where: { id },
    });
  }
}
