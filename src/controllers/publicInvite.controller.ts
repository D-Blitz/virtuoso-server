import { Request, Response } from 'express';
import { EnrollmentInviteCheckoutService } from '../services/enrollmentInviteCheckout.service';

const service = new EnrollmentInviteCheckoutService();

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
}
