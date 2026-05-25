/**
 * Phase 2.0a — typed event bus.
 *
 * In-process pub/sub for lifecycle events. The engine layer (Phase 2)
 * doesn't replace the EVENT layer — only the REACTION layer. By
 * extracting events now, every future feature is automatically
 * engine-ready: hardcoded subscribers preserve current behavior;
 * when the engine ships it adds itself as another subscriber and
 * the admin starts wiring user-configured flow triggers.
 *
 * Design constraints:
 *   - **Typed payloads** via tagged-union event registry. Compiler
 *     enforces that emit + on use the same payload shape.
 *   - **Fire-and-forget** at the emitter. Subscribers run async; a
 *     subscriber that throws never breaks the emitter (caught + logged).
 *   - **Synchronous registration, async dispatch**. Subscribers
 *     registered at module load; dispatch runs on next tick (microtask).
 *   - **In-process only** for v1. Single Node instance. If we ever
 *     horizontally scale, swap in Redis pubsub behind the same API
 *     — subscribers don't need to know.
 *
 * The trigger vocabulary deliberately stays small in v1; new event
 * kinds get added as features ship. The engine in Phase 2 will
 * inherit whatever has accumulated.
 */

import { getContext } from '../../auth/context';

/**
 * Tagged-union registry. Every emit call's `name` must match a key
 * here, and `payload` must match the corresponding type. Add new
 * events by extending this map — the compiler will then enforce
 * shape across every emit + on call site.
 */
export type EventRegistry = {
  // Payment lifecycle (Stripe webhook origin)
  'payment.succeeded': {
    paymentId: string;
    scheduledEventId: string | null;
    submissionId: string | null;
    enrollmentInviteId: string | null;
    purpose: string | null; // TRIAL_LESSON | ENROLLMENT_BALANCE | null
    amount: number;
  };
  'payment.failed': {
    paymentId: string;
    scheduledEventId: string | null;
    submissionId: string | null;
    enrollmentInviteId: string | null;
    purpose: string | null;
    amount: number;
  };
  'payment.refunded': {
    paymentId: string;
    refundedAmount: number;
    scheduledEventId: string | null;
  };

  // Event lifecycle (admin-driven)
  'event.cancelled': {
    scheduledEventId: string;
    reason: string | null;
    cancelledByUserId: string | null;
    refundIssued: boolean;
    refundedAmount: number;
  };
};

export type EventName = keyof EventRegistry;
export type EventPayload<N extends EventName> = EventRegistry[N];

/**
 * The actor context the event was emitted under. Captured at emit
 * time (not subscribe time) so audit-flavored subscribers can attribute
 * the action correctly. Null when emitted from a webhook / cron with
 * no RequestContext (Stripe webhook actor, scheduled jobs, etc.).
 */
export type EventActor = {
  userId: string | null;
  email: string | null;
  source: 'user' | 'webhook' | 'cron' | 'system';
};

export type EventEnvelope<N extends EventName> = {
  name: N;
  payload: EventPayload<N>;
  actor: EventActor;
  organizationId: string | null;
  /** ms since epoch. Useful for ordering + debugging dropped events. */
  emittedAt: number;
};

export type Subscriber<N extends EventName> = (
  envelope: EventEnvelope<N>,
) => void | Promise<void>;

type AnySubscriber = (envelope: EventEnvelope<any>) => void | Promise<void>;

const subscribers = new Map<EventName, Set<AnySubscriber>>();

/**
 * Register a subscriber for an event kind. Subscriptions are
 * permanent for the lifetime of the process; we don't ship
 * `unsubscribe` because there's no real use case in our current
 * architecture (subscribers registered at module load).
 */
export function on<N extends EventName>(
  name: N,
  handler: Subscriber<N>,
): void {
  const existing = subscribers.get(name) ?? new Set();
  existing.add(handler as AnySubscriber);
  subscribers.set(name, existing);
}

/**
 * Emit an event. Returns immediately — subscribers run async on the
 * microtask queue. A subscriber that throws is logged but never
 * propagates back to the emitter. The emitter is decoupled from
 * subscriber failure by design (same pattern as audit-log writes).
 */
export function emit<N extends EventName>(
  name: N,
  payload: EventPayload<N>,
  overrides?: {
    actor?: EventActor;
    organizationId?: string | null;
  },
): void {
  const ctx = getContext();
  const envelope: EventEnvelope<N> = {
    name,
    payload,
    actor:
      overrides?.actor ??
      (ctx
        ? { userId: ctx.userId, email: ctx.email, source: 'user' }
        : { userId: null, email: null, source: 'system' }),
    organizationId: overrides?.organizationId ?? ctx?.organizationId ?? null,
    emittedAt: Date.now(),
  };

  const handlers = subscribers.get(name);
  if (!handlers || handlers.size === 0) return;

  // Dispatch on next tick so the emitter doesn't pay the subscriber's
  // latency. Each subscriber is independently try/caught so one
  // failure doesn't cascade.
  queueMicrotask(() => {
    handlers.forEach((handler) => {
      Promise.resolve()
        .then(() => handler(envelope))
        .catch((err) => {
          console.error(
            `[bus] subscriber for ${name} threw:`,
            err,
          );
        });
    });
  });
}

/**
 * Test helper — clear every subscriber. Production code should never
 * call this; tests use it between cases to keep subscriber state isolated.
 */
export function _resetForTests(): void {
  subscribers.clear();
}
