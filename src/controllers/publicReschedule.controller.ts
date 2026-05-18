import { Request, Response } from 'express';
import { z } from 'zod';
import { ScheduledEventRescheduleService } from '../services/scheduledEventReschedule.service';

const service = new ScheduledEventRescheduleService();

const applyBodySchema = z.object({
  startTime: z.string().datetime(),
});

export class PublicRescheduleController {
  async get(req: Request, res: Response) {
    try {
      const summary = await service.getByToken(req.params.token);
      if (!summary) {
        res.status(404).json({ error: 'Lien invalide' });
        return;
      }
      res.json(summary);
    } catch (error) {
      console.error('publicReschedule get error:', error);
      res.status(500).json({ error: 'Failed to load reschedule' });
    }
  }

  async apply(req: Request, res: Response) {
    try {
      const parsed = applyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid input',
          details: parsed.error.flatten(),
        });
        return;
      }
      await service.apply(req.params.token, new Date(parsed.data.startTime));
      res.status(204).send();
    } catch (error: any) {
      console.error('publicReschedule apply error:', error);
      const msg = error?.message ?? 'Erreur';
      const lower = msg.toLowerCase();
      const status =
        lower.includes('invalide') ? 404 :
        lower.includes('déjà') || lower.includes('trop tard') || lower.includes('pris') ? 409 :
        400;
      res.status(status).json({ error: msg });
    }
  }
}
