import { Request, Response } from 'express';
import { z } from 'zod';
import { EnrollmentInviteCheckoutService } from '../services/enrollmentInviteCheckout.service';
import { EnrollmentInviteRescheduleService } from '../services/enrollmentInviteReschedule.service';

const service = new EnrollmentInviteCheckoutService();
const rescheduleService = new EnrollmentInviteRescheduleService();

const rescheduleBodySchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Format HH:MM requis'),
});

export class PublicInviteController {
  async get(req: Request, res: Response) {
    try {
      const summary = await service.getByToken(req.params.token);
      if (!summary) {
        res.status(404).json({ error: 'Invite not found' });
        return;
      }
      res.json(summary);
    } catch (error) {
      console.error('publicInvite get error:', error);
      res.status(500).json({ error: 'Failed to load invite' });
    }
  }

  async checkout(req: Request, res: Response) {
    try {
      const result = await service.createCheckout(req.params.token);
      res.status(201).json(result);
    } catch (error: any) {
      console.error('publicInvite checkout error:', error);
      const msg = error?.message ?? 'Unknown error';
      const lower = msg.toLowerCase();
      const status =
        lower.includes('not found') ? 404 :
        lower.includes('expired') || lower.includes('already used') ? 409 :
        lower.includes('no active term') || lower.includes('balance is zero') ? 400 :
        500;
      res.status(status).json({ error: msg });
    }
  }

  /** List valid recurring-slot options for a non-rescheduled invite. */
  async rescheduleOptions(req: Request, res: Response) {
    try {
      const options = await rescheduleService.getOptions(req.params.token);
      res.json({ options });
    } catch (error: any) {
      console.error('publicInvite rescheduleOptions error:', error);
      const msg = error?.message ?? 'Erreur';
      const status =
        msg.toLowerCase().includes('introuvable') ? 404 :
        msg.toLowerCase().includes('déjà') ? 409 :
        400;
      res.status(status).json({ error: msg });
    }
  }

  /** Apply the recurring-slot override on the invite (once-only). */
  async reschedule(req: Request, res: Response) {
    try {
      const parsed = rescheduleBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid input',
          details: parsed.error.flatten(),
        });
        return;
      }
      await rescheduleService.apply(
        req.params.token,
        parsed.data.weekday,
        parsed.data.startTime,
      );
      res.status(204).send();
    } catch (error: any) {
      console.error('publicInvite reschedule error:', error);
      const msg = error?.message ?? 'Erreur';
      const lower = msg.toLowerCase();
      const status =
        lower.includes('introuvable') ? 404 :
        lower.includes('déjà') || lower.includes('disponible') ? 409 :
        400;
      res.status(status).json({ error: msg });
    }
  }
}
