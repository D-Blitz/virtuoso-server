// EVENT_REACTION flow runner (Phase 2.3).
//
// When a bus event matches a WidgetTrigger, this module:
//   1. Materializes a WidgetRun for the flow (kind = EVENT_REACTION,
//      no UI), with vars = the event payload + bus envelope context
//   2. Executes the action tree synchronously against those vars
//   3. Marks the run COMPLETED (or ERRORED if execution failed)
//
// Distinct from the BOOKING flow runtime in flowEngine.ts because:
//   - No steps to walk → straight to actions
//   - vars come from an EXTERNAL event, not visitor input
//   - No idempotency via clientSubmitId — the dispatcher dedupes via
//     a per-(flowId × eventId) rate limit instead (not perfect
//     idempotency but bounds runaway loops)
//
// Rate limit: 100 runs per (flowId, eventName) per hour, computed
// from WidgetRun.startedAt. Beyond that, the trigger is dropped + a
// SKIPPED metering event is recorded so admins see throttling in the
// usage panel.

import prisma from '../../prisma';
import { fireFlowCompletionActions } from './actionExecutor';
import { recordEngineAction } from './metering';

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 100;

/**
 * Drive an EVENT_REACTION flow given an event envelope. Called by
 * the trigger dispatcher after `eventName` matched and the trigger's
 * filter (if any) evaluated true.
 *
 * Throws are caught + recorded as RUN_ERROR; never propagates back
 * to the EventBus subscriber (which would log + ignore anyway).
 */
export async function runEventReactionFlow(params: {
  flowId: string;
  organizationId: string;
  eventName: string;
  eventPayload: Record<string, unknown>;
}): Promise<{ ran: boolean; reason?: string }> {
  const t0 = Date.now();

  // Rate-limit check: count runs of this (flowId, eventName) pair in
  // the last hour. EventName isn't a WidgetRun column, so we filter
  // by flowId + the time window only — strictly more conservative
  // (limits ALL runs of the flow, not just this event kind). If a
  // flow has multiple triggers and one is hot, the others share the
  // budget. Acceptable for v1; a per-event counter table can land
  // later if needed.
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const recentRuns = await prisma.widgetRun.count({
    where: {
      flowId: params.flowId,
      startedAt: { gte: windowStart },
    },
  });
  if (recentRuns >= RATE_LIMIT_MAX) {
    await recordEngineAction({
      organizationId: params.organizationId,
      flowId: params.flowId,
      runId: null,
      actionKind: 'TRIGGER_RATE_LIMITED',
      status: 'SKIPPED',
      durationMs: Date.now() - t0,
      errorMessage: `${recentRuns} runs in the last hour ≥ ${RATE_LIMIT_MAX}`,
    });
    return {
      ran: false,
      reason: `rate-limited (${recentRuns}/${RATE_LIMIT_MAX} this hour)`,
    };
  }

  // Materialize the WidgetRun. Vars seed from the event payload so
  // action configs can interpolate {vars.paymentId} etc. directly.
  // `event` mirror is the canonical access path documented in flow
  // examples — kept alongside `vars` for clarity.
  const run = await prisma.widgetRun.create({
    data: {
      organizationId: params.organizationId,
      flowId: params.flowId,
      vars: {
        ...params.eventPayload,
        event: {
          name: params.eventName,
          ...params.eventPayload,
        },
      },
      currentStepId: null,
      status: 'IN_PROGRESS',
      stepHistory: [],
    },
  });

  await recordEngineAction({
    organizationId: params.organizationId,
    flowId: params.flowId,
    runId: run.id,
    actionKind: 'RUN_START',
    status: 'OK',
    durationMs: Date.now() - t0,
    errorMessage: `triggered by ${params.eventName}`,
  });

  // Execute the action tree against the seeded vars. Wrapped in its
  // own try/catch so we can mark the run ERRORED on failure +
  // surface a metering event.
  try {
    await fireFlowCompletionActions({
      organizationId: params.organizationId,
      flowId: params.flowId,
      runId: run.id,
      vars: run.vars as Record<string, unknown>,
    });

    await prisma.widgetRun.update({
      where: { id: run.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    await recordEngineAction({
      organizationId: params.organizationId,
      flowId: params.flowId,
      runId: run.id,
      actionKind: 'RUN_COMPLETE',
      status: 'OK',
      durationMs: Date.now() - t0,
    });

    return { ran: true };
  } catch (err) {
    await prisma.widgetRun.update({
      where: { id: run.id },
      data: { status: 'ERRORED', completedAt: new Date() },
    });
    await recordEngineAction({
      organizationId: params.organizationId,
      flowId: params.flowId,
      runId: run.id,
      actionKind: 'RUN_ERROR',
      status: 'ERROR',
      durationMs: Date.now() - t0,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ran: true, reason: 'errored — see RUN_ERROR metering event' };
  }
}
