import { Request, Response } from 'express';
import { ScheduledEventValidationService } from '@/services/validation/scheduledEventValidation.service';

const service = new ScheduledEventValidationService();

export class ScheduledEventValidationController {
  async validate(req: Request, res: Response) {
    try {
      const excludeId = req.query.excludeEventId as string | undefined;
      const result = await service.validate(req.body);
      res.json(result);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur lors de la validation." });
    }
  }
}
