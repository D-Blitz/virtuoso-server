import { EnrollmentInviteService } from '../services/enrollmentInvite.service';

/**
 * Periodic cycle that:
 *  1. promotes PAID_TRIAL events past their endTime → AWAITING_ENROLLMENT_DECISION
 *  2. sends enrollment-invite emails for newly-awaiting events
 *  3. marks expired invites + their events as LAPSED
 *
 * Runs in-process via setInterval (single-instance assumption — see
 * sweepSlotHolds.ts for the same pattern).
 */

const CYCLE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const service = new EnrollmentInviteService();

let timer: NodeJS.Timeout | null = null;

async function runCycle(): Promise<void> {
  try {
    const stats = await service.runFullCycle();
    if (stats.advanced || stats.sent || stats.lapsed || stats.sendErrors) {
      console.log(
        `[invites] cycle: advanced=${stats.advanced} sent=${stats.sent} lapsed=${stats.lapsed} sendErrors=${stats.sendErrors}`,
      );
    }
  } catch (err) {
    console.error('[invites] cycle error:', err);
  }
}

export function startEnrollmentInviteJobs(): void {
  if (timer) return;
  // Kick off once on boot, then on interval.
  void runCycle();
  timer = setInterval(() => void runCycle(), CYCLE_INTERVAL_MS);
}

export function stopEnrollmentInviteJobs(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
