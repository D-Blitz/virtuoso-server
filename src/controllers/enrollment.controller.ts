import { Request, Response } from 'express';
import { EnrollmentService } from '../services/enrollment.service';

const enrollmentService = new EnrollmentService();

export class EnrollmentController {
  async create(req: Request, res: Response) {
    try {
      const {
        serviceId,
        clientId,
        locationId,
        roomId,
        termId,
        weekday,
        startTime,
        durationMinutes,
        startDate,
        endDate,
        priceCharged,
        pricingStrategy,
        status,
      } = req.body;

      if (
        !serviceId ||
        !clientId ||
        !locationId ||
        !roomId ||
        !termId ||
        weekday == null ||
        !startTime ||
        !startDate ||
        !endDate ||
        priceCharged == null ||
        !pricingStrategy ||
        !status
      ) {
        res.status(400).json({
          error:
            'Missing required fields: serviceId, clientId, locationId, roomId, termId, weekday, startTime, startDate, endDate, priceCharged, pricingStrategy, status',
        });
        return;
      }

      const created = await enrollmentService.create(req.body);
      res.status(201).json(created);
      return;
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to create enrollment' });
      return;
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const enrollments = await enrollmentService.getAll();
      res.json(enrollments);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch enrollments' });
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;

    try {
      if ('roomId' in req.body && !req.body.roomId) {
        res.status(400).json({ error: 'roomId is required and cannot be null/empty' });
        return;
      }

      const updated = await enrollmentService.update(id, req.body);
      res.json(updated);
      return;
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to update enrollment' });
      return;
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;

    try {
      await enrollmentService.delete(id);
      res.status(204).send();
      return;
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete enrollment' });
      return;
    }
  }
}
