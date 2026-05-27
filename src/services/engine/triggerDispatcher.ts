// Trigger dispatcher (Phase 2.3).
//
// Bridges the typed EventBus (services/events/bus.ts) to engine
// EVENT_REACTION flows. On boot, registerEngineTriggers() subscribes
// one handler per supported event name. Each handler:
//   1. Looks up WidgetTriggers matching the event name
//   2. Evaluates each trigger's filter (JSONLogic) against the
//      envelope payload — drops the trigger if false
//   3. Calls runEventReactionFlow() per surviving trigger
//
// Each subscriber runs in a per-event try/catch so one flow's
// failure can't cascade to others. The bus itself also catches +
// logs at the dispatcher boundary.

import { on, type EventName, type EventPayload } from '../events/bus';
import prisma from '../../prisma';
import { isStepVisible } from './expressionEvaluator';
import { runEventReactionFlow } from './eventReactionRunner';
import { startRun } from './graphRuntime';
import { recordEngineAction } from './metering';

/**
 * Event names the engine knows about. Keep in sync with the
 * validatePublishable() whitelist in flowSerialization.ts.
 */
const SUPPORTED_EVENTS: EventName[] = [
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  'event.cancelled',
];

/**
 * Look up + dispatch matching triggers for a single event envelope.
 * Public for testability; the bus subscribers in registerEngineTriggers
 * are thin wrappers around this.
 */
async function dispatch<N extends EventName>(
  eventName: N,
  envelope: {
    payload: EventPayload<N>;
    organizationId: string | null;
  },
): Promise<void> {
  // Scope to a single org if the bus envelope provides one. Webhook
  // events without an org context (rare in v1) are intentionally
  // skipped — a flow-level trigger that fires "across all orgs" would
  // be a footgun; the bus already attributes most events to an org.
  if (!envelope.organizationId) {
    console.warn(
      `[engine:trigger] ${eventName} fired with null organizationId — no triggers will run`,
    );
    return;
  }

  // Phase 3.1 — v2 entry-point dispatch. Looks up WidgetEntryPoints
  // of kind='event' whose config.eventName matches. The v1
  // WidgetTrigger table is no longer consulted; the migration script
  // (Phase 3.5) converts legacy triggers to v2 entry points.
  const entryPoints = await prisma.widgetEntryPoint.findMany({
    where: {
      kind: 'event',
      flow: {
        organizationId: envelope.organizationId,
        isPublished: true,
        deletedAt: null,
        archivedAt: null,
      },
    },
    select: {
      id: true,
      flowId: true,
      config: true,
      entryNodeId: true,
      flow: { select: { organizationId: true } },
    },
  });

  // Filter to the matching event name (config.eventName).
  const matching = entryPoints.filter((ep) => {
    const cfg = ep.config as { eventName?: string; filter?: unknown };
    return cfg.eventName === eventName;
  });

  if (matching.length === 0) return;

  // Build the evaluation context once — same shape for every trigger
  // of this event. `event.*` mirrors the payload for the
  // documented access path in flow examples.
  const evalContext = {
    vars: envelope.payload as unknown as Record<string, unknown>,
    event: {
      name: eventName,
      ...(envelope.payload as Record<string, unknown>),
    },
    now: new Date().toISOString(),
    org: { id: envelope.organizationId },
  };

  for (const ep of matching) {
    const cfg = ep.config as { filter?: unknown };
    // Filter is JSONLogic — null/missing means "always fire".
    // Re-evaluate manually so we can fall closed on filter errors
    // (visibility falls open by default; triggers should fall closed
    // so a malformed filter never unleashes an unintended action).
    if (cfg.filter != null) {
      try {
        const matches = isStepVisible(cfg.filter, evalContext);
        if (!matches) continue;
      } catch (err) {
        console.error(
          `[engine:trigger] filter eval failed on entry point ${ep.id}; skipping for safety:`,
          err,
        );
        continue;
      }
    }

    // Need a defined entryNodeId to start the v2 graph walk.
    if (!ep.entryNodeId) {
      console.warn(
        `[engine:trigger] entry point ${ep.id} has null entryNodeId — skipping`,
      );
      continue;
    }

    // Fire-and-await within the per-event try/catch in the subscriber
    // wrapper. Sequential per envelope to bound Postgres pressure.
    try {
      await startRun({
        flowId: ep.flowId,
        organizationId: ep.flow.organizationId,
        entryNodeId: ep.entryNodeId,
        // Seed vars with the event payload so action configs can
        // interpolate {vars.paymentId} etc. directly.
        seedVars: {
          ...(envelope.payload as Record<string, unknown>),
          event: {
            name: eventName,
            ...(envelope.payload as Record<string, unknown>),
          },
        },
      });
    } catch (err) {
      console.error(
        `[engine:trigger] startRun failed for entry point ${ep.id}:`,
        err,
      );
      await recordEngineAction({
        organizationId: ep.flow.organizationId,
        flowId: ep.flowId,
        runId: null,
        actionKind: 'RUN_ERROR',
        status: 'ERROR',
        durationMs: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Legacy v1 runner — kept callable for the eventReactionRunner module
// that hasn't been retired yet. New dispatcher path above uses
// graphRuntime.startRun directly.
void runEventReactionFlow;

/**
 * Register engine subscribers for every supported event. Idempotent —
 * a second call no-ops because `on()` adds to a Set; duplicate handler
 * functions would clash though, so we keep state with a registered
 * flag to be defensive.
 */
let registered = false;
export function registerEngineTriggers(): void {
  if (registered) return;
  registered = true;

  for (const eventName of SUPPORTED_EVENTS) {
    on(eventName, async (envelope) => {
      try {
        await dispatch(eventName, envelope);
      } catch (err) {
        // The bus catches subscriber throws but we add a contextual
        // log here so engine-flavored failures are easy to grep.
        console.error(
          `[engine:trigger] dispatch failed for ${eventName}:`,
          err,
        );
      }
    });
  }
}

// Exported for the smoke test — bypasses the bus and drives dispatch
// directly with a constructed envelope. Real code paths should emit
// via the bus instead.
export const _dispatchForTests = dispatch;
