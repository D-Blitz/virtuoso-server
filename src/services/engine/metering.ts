// Workflow engine — usage metering (Phase 2.0 Commit 2).
//
// Writes one EngineActionEvent row per non-trivial engine action.
// Aggregates feed the per-org "IA" usage panel (Phase 8 surfaces it)
// and the future pricing/quota system. v1 records measurement only —
// no quota enforcement.
//
// What counts as non-trivial: RUN_START / STEP_SUBMIT (regardless of
// validation outcome) / RUN_COMPLETE / RUN_ERROR. Future kinds:
// SEND_EMAIL, ISSUE_REFUND, AI generation — all per Phase 2.2+.
//
// Cheap ops (var assignment, condition eval) are intentionally NOT
// logged here. Adding them would 10-100x the row count for no business
// signal.

import prisma from '../../prisma';
import type { EngineActionKind } from './types';

export type RecordEngineActionParams = {
  organizationId: string;
  flowId?: string | null;
  runId?: string | null;
  /**
   * Action kind string. Includes the runtime kinds (EngineActionKind
   * union) AND the post-completion action kinds (SEND_EMAIL,
   * CONDITIONAL, WAIT, etc.) that ship as engine actions land in
   * Phase 2.2+. Loose `string` here because the DB column is also
   * String — the union narrowing was a stale v1 constraint.
   */
  actionKind: EngineActionKind | string;
  status: 'OK' | 'ERROR' | 'SKIPPED';
  /** Duration of the operation. Pass 0 for instantaneous markers. */
  durationMs: number;
  /** Free-text reason on ERROR / SKIPPED. Truncated to 500 chars. */
  errorMessage?: string;
};

/**
 * Best-effort metering write. Wrapped in try/catch because failing to
 * log usage must NEVER take down a flow run — the run is the value the
 * visitor cares about, the metering row is back-office data.
 *
 * Errors are logged to the server console so we notice systematic
 * failures (DB outage, etc.) without breaking the user-facing path.
 */
export async function recordEngineAction(
  params: RecordEngineActionParams,
): Promise<void> {
  try {
    await prisma.engineActionEvent.create({
      data: {
        organizationId: params.organizationId,
        flowId: params.flowId ?? null,
        runId: params.runId ?? null,
        actionKind: params.actionKind,
        status: params.status,
        durationMs: Math.max(0, Math.round(params.durationMs)),
        errorMessage: params.errorMessage
          ? params.errorMessage.slice(0, 500)
          : null,
      },
    });
  } catch (err) {
    console.error('[engine:metering] failed to record action', {
      params,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
