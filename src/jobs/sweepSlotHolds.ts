import prisma from '../prisma';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let timer: NodeJS.Timeout | null = null;

async function sweepOnce(): Promise<void> {
  try {
    // No request context = unscoped (extension passes through). We want to
    // sweep across all orgs.
    const result = await prisma.slotHold.deleteMany({
      where: {
        consumedAt: null,
        expiresAt: { lt: new Date() },
      },
    });
    if (result.count > 0) {
      console.log(`[sweepSlotHolds] deleted ${result.count} expired holds`);
    }
  } catch (e) {
    console.error('[sweepSlotHolds] error:', e);
  }
}

export function startSlotHoldSweep(): void {
  if (timer) return;
  // Run once at startup, then on interval.
  void sweepOnce();
  timer = setInterval(() => void sweepOnce(), SWEEP_INTERVAL_MS);
}

export function stopSlotHoldSweep(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
