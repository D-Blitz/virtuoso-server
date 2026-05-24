import { Request, Response } from 'express';
import { EnrollmentInviteService } from '../services/enrollmentInvite.service';
import { ReminderService } from '../services/reminders/reminder.service';

const inviteService = new EnrollmentInviteService();
const reminderService = new ReminderService();

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

  async diagnoseInvites(_req: Request, res: Response) {
    try {
      const report = await inviteService.diagnose();
      res.json(report);
    } catch (error) {
      console.error('diagnoseInvites error:', error);
      res.status(500).json({ error: 'Failed to diagnose invites' });
    }
  }

  /**
   * Manually trigger the T-24h / T-48h reminder cron cycle. Same
   * idempotency guarantees as the periodic run — events with a
   * stamp already set are skipped.
   */
  async runReminderCycle(_req: Request, res: Response) {
    try {
      const stats = await reminderService.runCycle();
      res.json(stats);
    } catch (error) {
      console.error('runReminderCycle error:', error);
      res.status(500).json({ error: 'Failed to run reminder cycle' });
    }
  }
}
