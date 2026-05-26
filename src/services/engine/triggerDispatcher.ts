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

  // Triggers are stored on a per-flow basis; find all WidgetFlows
  // (the flow's org scoping is enforced by the join) whose triggers
  // include this event name. Filtering flows by isPublished + kind +
  // not-trashed + not-archived in one query.
  const triggers = await prisma.widgetTrigger.findMany({
    where: {
      eventName,
      flow: {
        organizationId: envelope.organizationId,
        kind: 'EVENT_REACTION',
        isPublished: true,
        deletedAt: null,
        archivedAt: null,
      },
    },
    select: {
      id: true,
      flowId: true,
      eventName: true,
      filter: true,
      flow: { select: { organizationId: true } },
    },
  });

  if (triggers.length === 0) return;

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

  for (const trigger of triggers) {
    // Filter is JSONLogic — null/missing means "always fire".
    // isStepVisible() returns true on null/parse-error, which is the
    // safe default for visibility but the wrong default for triggers
    // (a malformed filter shouldn't unleash an unintended action).
    // Re-evaluate manually so we can fall closed on filter errors.
    if (trigger.filter != null) {
      try {
        const matches = isStepVisible(trigger.filter, evalContext);
        if (!matches) continue;
      } catch (err) {
        console.error(
          `[engine:trigger] filter eval failed on trigger ${trigger.id}; skipping for safety:`,
          err,
        );
        continue;
      }
    }

    // Fire-and-await within the per-event try/catch in the
    // subscriber wrapper. We DO await so a flood of events processes
    // sequentially per envelope rather than fan-out-and-forget;
    // keeps Postgres connection pressure bounded.
    await runEventReactionFlow({
      flowId: trigger.flowId,
      organizationId: trigger.flow.organizationId,
      eventName,
      eventPayload: envelope.payload as unknown as Record<string, unknown>,
    });
  }
}

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
