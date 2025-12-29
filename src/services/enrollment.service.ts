import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class EnrollmentService {
  async create(data: any) {
    return prisma.enrollment.create({
      data,
      include: {
        client: true,
        facilitator: true,
        room: true,
        location: true,
        term: true,
        service: {
          include: {
            serviceCategory: true,
          },
        },
        events: true,
      },
    });
  }

  async getAll() {
    return prisma.enrollment.findMany({
      include: {
        client: true,
        facilitator: true,
        room: true,
        location: true,
        term: true,
        service: {
          include: {
            serviceCategory: true,
          },
        },
        events: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, data: any) {
    return prisma.enrollment.update({
      where: { id },
      data,
      include: {
        client: true,
        facilitator: true,
        room: true,
        location: true,
        term: true,
        service: {
          include: {
            serviceCategory: true,
          },
        },
        events: true,
      },
    });
  }

  async delete(id: string) {
    return prisma.enrollment.delete({
      where: { id },
    });
  }
}
