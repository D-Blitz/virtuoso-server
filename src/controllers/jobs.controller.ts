import { Request, Response } from 'express';
import { EnrollmentInviteService } from '../services/enrollmentInvite.service';

const inviteService = new EnrollmentInviteService();

/**
 * Admin-only endpoints to trigger background jobs on demand (testing /
 * manual intervention). Mounted behind `requireUser` + role gate.
 */
export class JobsController {
  async runInviteCycle(_req: Request, res: Response) {
    try {
      const stats = await inviteService.runFullCycle();
      res.json(stats);
    } catch (error) {
      console.error('runInviteCycle error:', error);
      res.status(500).json({ error: 'Failed to run invite cycle' });
    }
  }

  async resendInvite(req: Request, res: Response) {
    try {
      await inviteService.resend(req.params.id);
      res.status(204).send();
    } catch (error: any) {
      console.error('resendInvite error:', error);
      const msg = error?.message ?? 'Unknown error';
      const status = msg.includes('not found') || msg.includes('not pending') ? 404 : 500;
      res.status(status).json({ error: msg });
    }
  }
}
