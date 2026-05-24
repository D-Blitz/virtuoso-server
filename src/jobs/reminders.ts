import { ReminderService } from '../services/reminders/reminder.service';

/**
 * Phase 1.2 — periodic pre-event reminder cron.
 *
 * Polls every 10 minutes (same cadence as enrollment-invites). Each
 * cycle scans events in the [now+47h, now+49h] / [now+23h, now+25h]
 * windows that haven't been reminded yet, sends via the
 * NotificationDispatcher, stamps the row.
 *
 * Single-instance assumption: runs in-process via setInterval, same
 * as the invite cron + slot-hold sweep. If we ever horizontally
 * scale, the cron moves to a Redis-locked job runner.
 *
 * Stop via stopReminderJob() in tests.
 */

const CYCLE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const service = new ReminderService();

let timer: NodeJS.Timeout | null = null;

async function runCycle(): Promise<void> {
  try {
    const stats = await service.runCycle();
    if (stats.sent48h || stats.sent24h || stats.errors) {
      console.log(
        `[reminders] cycle: sent48h=${stats.sent48h} sent24h=${stats.sent24h} errors=${stats.errors}`,
      );
    }
  } catch (err) {
    console.error('[reminders] cycle error:', err);
  }
}

export function startReminderJob(): void {
  if (timer) return;
  // Kick off once on boot, then on interval.
  void runCycle();
  timer = setInterval(() => void runCycle(), CYCLE_INTERVAL_MS);
}

export function stopReminderJob(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
