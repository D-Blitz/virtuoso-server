import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

// services
import { EnrollmentQuoteService } from '../services/enrollment/enrollmentQuote.service';

// domain
import { generateWeeklyOccurrences } from '../domain/recurrence/weeklyRecurrence.utils';
import { isInAnyClosure } from '../domain/recurrence/closures.utils';

const prisma = new PrismaClient();
const quoteService = new EnrollmentQuoteService();

export class EnrollmentEngineController {
  async quote(req: Request, res: Response) {
    try {
      const { serviceId, locationId, startDate, weekday, startTime, durationMinutes, termId } =
        req.body;

      if (!serviceId || !locationId || !startDate || weekday == null || !startTime) {
        res.status(400).json({
          error: 'Missing required fields: serviceId, locationId, startDate, weekday, startTime',
        });
        return;
      }

      const start = new Date(startDate);
      if (Number.isNaN(start.getTime())) {
        res.status(400).json({ error: 'Invalid startDate' });
        return;
      }

      const service = await prisma.service.findUnique({ where: { id: serviceId } });
      if (!service) {
        res.status(404).json({ error: 'Service not found' });
        return;
      }

      const term = termId
        ? await prisma.term.findUnique({ where: { id: termId } })
        : await prisma.term.findFirst({
            where: {
              locationId,
              startDate: { lte: start },
              endDate: { gte: start },
            },
            orderBy: { startDate: 'desc' },
          });

      if (!term) {
        res.status(404).json({ error: 'No term found for this date/location' });
        return;
      }

      const finalDuration =
        typeof durationMinutes === 'number' && durationMinutes > 0
          ? durationMinutes
          : service.defaultDurationMinutes;

      const result = quoteService.quote({
        service,
        term,
        startDate: start,
        weekday: Number(weekday),
        startTime: String(startTime),
        durationMinutes: finalDuration,
      });

      res.status(200).json(result);
      return;
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to quote enrollment' });
      return;
    }
  }

  async generateEvents(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const enrollment = await prisma.enrollment.findUnique({
        where: { id },
        include: {
          service: true,
        },
      });

      if (!enrollment) {
        res.status(404).json({ error: 'Enrollment not found' });
        return;
      }

      const existingCount = await prisma.scheduledEvent.count({
        where: { enrollmentId: enrollment.id },
      });

      if (existingCount > 0) {
        res.status(409).json({
          error: 'Events already generated for this enrollment',
          existingCount,
        });
        return;
      }

      const occurrences = generateWeeklyOccurrences({
        startDate: enrollment.startDate,
        endDate: enrollment.endDate,
        weekday: enrollment.weekday,
        startTimeHHmm: enrollment.startTime,
        durationMinutes: enrollment.durationMinutes,
      });

      if (!occurrences.length) {
        res.status(400).json({ error: 'No occurrences generated (check dates/weekday)' });
        return;
      }

      // ✅ Fetch closures overlapping the enrollment window (location-specific + global)
      const closures = await prisma.closure.findMany({
        where: {
          OR: [{ locationId: enrollment.locationId }, { locationId: null }],
          startDate: { lte: enrollment.endDate },
          endDate: { gte: enrollment.startDate },
        },
        select: {
          startDate: true,
          endDate: true,
        },
      });

      // ✅ Filter out occurrences that fall inside a closure range
      const filteredOccurrences = occurrences.filter((o) => !isInAnyClosure(o.startTime, closures));

      if (!filteredOccurrences.length) {
        res.status(400).json({
          error: 'All occurrences fall on closure days. Nothing to generate.',
        });
        return;
      }

      const createdEvents = await prisma.$transaction(
        filteredOccurrences.map((o) =>
          prisma.scheduledEvent.create({
            data: {
              startTime: o.startTime,
              endTime: o.endTime,
              recurrence: null,
              recurrenceEnd: null,
              color: '#8b5cf6',
              price: 0,
              notes: null,

              roomId: enrollment.roomId,
              locationId: enrollment.locationId,
              serviceId: enrollment.serviceId,
              serviceCategoryId: enrollment.service.serviceCategoryId,

              enrollmentId: enrollment.id,

              clients: {
                connect: [{ id: enrollment.clientId }],
              },

              ...(enrollment.facilitatorId
                ? {
                    facilitators: {
                      connect: [{ id: enrollment.facilitatorId }],
                    },
                  }
                : {}),
            },
            include: {
              clients: true,
              facilitators: true,
            },
          }),
        ),
      );

      res.status(201).json({
        createdCount: createdEvents.length,
        skippedDueToClosures: occurrences.length - filteredOccurrences.length,
        enrollmentId: enrollment.id,
        sample: createdEvents[0],
      });
      return;
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to generate events' });
      return;
    }
  }

  async deleteEventsForEnrollment(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const deleted = await prisma.scheduledEvent.deleteMany({
        where: { enrollmentId: id },
      });

      res.status(200).json({ deletedCount: deleted.count, enrollmentId: id });
      return;
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete events for enrollment' });
      return;
    }
  }
}
