// Engine resume sweeper (Phase 3.2).
//
// Picks up WidgetScheduledResume rows whose fireAt <= now() and
// consumed = false, resumes each run, marks the row consumed.
//
// Tick interval: 30 seconds. Bounded by the sweeper's batch size
// (default 100) per tick so a flood of due rows doesn't monopolize
// the event loop or DB connection pool. Anything over the batch
// limit waits for the next tick.
//
// Token-based resumes (WAIT_TOKEN) are NOT swept — those fire from
// the public resume route when the URL is clicked. Phase 3.2b.

import prisma from '../prisma';
import { resumeRun } from '../services/engine/graphRuntime';
import { recordEngineAction } from '../services/engine/metering';

const TICK_INTERVAL_MS = 30 * 1000; // 30 seconds
const BATCH_SIZE = 100;

let timer: NodeJS.Timeout | null = null;

/**
 * One sweeper tick. Loads up to BATCH_SIZE due rows + resumes each
 * inside its own try/catch so one bad row doesn't strand the rest.
 *
 * Each row is marked consumed AFTER resumeRun returns. A row that
 * errors during resume stays unconsumed so the next tick retries —
 * the run's status flips ERRORED on hard failures (caught inside
 * resumeRun / advanceRun), at which point we mark the row consumed
 * so we don't loop forever.
 *
 * Returns the number of rows successfully consumed.
 */
async function tickOnce(): Promise<number> {
  const due = await prisma.widgetScheduledResume.findMany({
    where: {
      consumed: false,
      fireAt: { lte: new Date() },
    },
    orderBy: { fireAt: 'asc' },
    take: BATCH_SIZE,
    select: {
      id: true,
      runId: true,
      flowId: true,
      nodeId: true,
    },
  });

  if (due.length === 0) return 0;

  let consumed = 0;
  for (const row of due) {
    try {
      // Cross-check: the run should still be at the same node and
      // still WAITING_TIME. If not (admin re-published the flow,
      // some other process advanced the run), skip + mark consumed.
      const run = await prisma.widgetRun.findUnique({
        where: { id: row.runId },
        select: { status: true, currentNodeId: true, organizationId: true },
      });
      if (
        !run ||
        run.status !== 'WAITING_TIME' ||
        run.currentNodeId !== row.nodeId
      ) {
        await prisma.widgetScheduledResume.update({
          where: { id: row.id },
          data: { consumed: true, consumedAt: new Date() },
        });
        continue;
      }

      await resumeRun({ runId: row.runId });

      await prisma.widgetScheduledResume.update({
        where: { id: row.id },
        data: { consumed: true, consumedAt: new Date() },
      });
      consumed += 1;
    } catch (err) {
      console.error(
        `[engine:resume] resume failed for scheduled row ${row.id} (run ${row.runId}):`,
        err,
      );
      // Mark consumed anyway so the sweeper doesn't loop on a broken
      // run forever. The metering event written by resumeRun /
      // advanceRun captures the failure for admins to investigate.
      try {
        await prisma.widgetScheduledResume.update({
          where: { id: row.id },
          data: { consumed: true, consumedAt: new Date() },
        });
        await recordEngineAction({
          organizationId:
            (
              await prisma.widgetRun.findUnique({
                where: { id: row.runId },
                select: { organizationId: true },
              })
            )?.organizationId ?? 'unknown',
          flowId: row.flowId,
          runId: row.runId,
          actionKind: 'RUN_RESUME',
          status: 'ERROR',
          durationMs: 0,
          errorMessage:
            err instanceof Error
              ? `sweep resume failed: ${err.message}`
              : `sweep resume failed: ${String(err)}`,
        });
      } catch (markErr) {
        console.error(
          `[engine:resume] also failed to mark scheduled row ${row.id} consumed:`,
          markErr,
        );
      }
    }
  }

  if (consumed > 0) {
    console.log(`[engine:resume] resumed ${consumed} run(s)`);
  }
  return consumed;
}

export function startEngineResumeSweep(): void {
  if (timer) return;
  // Tick immediately on boot to catch anything that came due while
  // the server was down, then on interval.
  void tickOnce();
  timer = setInterval(() => void tickOnce(), TICK_INTERVAL_MS);
}

export function stopEngineResumeSweep(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// Exposed for the smoke test — drives one tick on-demand so the test
// doesn't have to sleep 30s. Production code uses startEngineResumeSweep.
export const _tickOnceForTests = tickOnce;
