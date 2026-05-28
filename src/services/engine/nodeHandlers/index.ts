// Node handler registry (Phase 3.1 — graph engine v2).
//
// Maps node `kind` strings to their handler implementations and
// surfaces a `category` for each kind so the runtime knows whether
// to pause for visitor input (UI), execute server-side (ACTION), or
// suspend until resumed (WAIT).
//
// Under the hood, UI kinds delegate to the existing stepHandlers/
// module and ACTION kinds delegate to actionHandlers/. WAIT kinds
// are stubbed in Phase 3.1; full implementation lands in Phase 3.2
// when the cron sweeper + resume token routes ship.
//
// Adding a new kind: register it here + ship a handler that matches
// the NodeHandler shape below. No schema migration needed (DB stores
// kind as String).

import type { Prisma, WidgetNode } from '@prisma/client';

import { sendEmailHandler as legacySendEmailHandler } from '../actionHandlers/sendEmail';
import { createResumeLinkHandler as legacyCreateResumeLinkHandler } from '../actionHandlers/createResumeLink';
import { formNodeHandler } from './form';
import { recapNodeHandler } from './recap';
import { singleSelectNodeHandler } from './singleSelect';
import type { ActionExecutionContext, ActionResult } from '../actionHandlers/types';
import { evaluate, ExpressionError, type EvaluationContext } from '../expressionEvaluator';
import type { StepSubmission, ValidationError } from '../types';

// ─── Category + handler shape ─────────────────────────────────────

export type NodeCategory = 'UI' | 'ACTION' | 'WAIT';

/**
 * Descriptor returned by WAIT handlers so the runtime knows when /
 * how to resume the run.
 *
 *   time  → resume at `fireAt`. Runtime writes a WidgetScheduledResume
 *           row + sets run.nextResumeAt + status = WAITING_TIME.
 *   token → resume when an external URL is clicked. Runtime writes a
 *           WidgetResumeToken row + sets run.status = WAITING_TOKEN.
 *           (Phase 3.2b)
 *
 * `varsPatch` is merged into run.vars before the wait — useful for
 * WAIT_TOKEN to inject the resume URL into a var the upstream email
 * could not have known about (Phase 3.2b).
 */
export type WaitDescriptor =
  | {
      kind: 'time';
      fireAt: Date;
      varsPatch?: Record<string, unknown>;
    }
  | {
      kind: 'token';
      expirationDays?: number;
      varsPatch?: Record<string, unknown>;
    };

/**
 * Per-submission contextual data that the runtime threads into UI
 * handler hooks. The flow's organizationId is the critical piece —
 * handlers that fetch tenant-scoped data (ENTITY_REF, future DB-
 * column bindings) need it to scope their queries.
 */
export type SubmissionContext = {
  organizationId: string;
  runId: string;
  flowId: string;
};

/**
 * Unified node handler. Different categories implement different
 * subsets:
 *   UI     → validateConfig, validateSubmission, applySubmission
 *   ACTION → validateConfig, execute
 *   WAIT   → validateConfig, scheduleWait
 *
 * The runtime checks category before calling the kind-specific
 * method, so handlers don't need to implement all methods.
 */
export type NodeHandler = {
  readonly kind: string;
  readonly category: NodeCategory;
  /**
   * Publish-time config validation. Returns null if config is
   * acceptable, an error message otherwise.
   */
  validateConfig(config: Prisma.JsonValue): string | null;

  // UI-only methods --------------------------------------------------
  //
  // validate + apply MAY return a Promise so handlers that need DB
  // lookups (e.g. ENTITY_REF field resolution in FORM, Phase 3.4) can
  // do them inline. The runtime always awaits.
  validateSubmission?(
    submission: StepSubmission,
    node: WidgetNode,
    context: SubmissionContext,
  ): ValidationError[] | Promise<ValidationError[]>;
  applySubmission?(
    submission: StepSubmission,
    node: WidgetNode,
    currentVars: Record<string, unknown>,
    context: SubmissionContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;

  // ACTION-only methods ---------------------------------------------
  execute?(
    node: WidgetNode,
    context: ActionExecutionContext,
  ): Promise<ActionResult>;

  // WAIT-only methods (Phase 3.2) -----------------------------------
  /**
   * Compute the wait descriptor — when / how to resume. Receives the
   * current evaluation context so config expressions can reference
   * vars / event / now.
   */
  scheduleWait?(
    node: WidgetNode,
    context: EvaluationContext,
  ): WaitDescriptor;
};

// ─── Action adapter ───────────────────────────────────────────────
//
// The remaining action handlers (sendEmail, createResumeLink) still
// implement the v1 ActionHandler shape — they get a LoadedAction-like
// arg + a context. Wrap them to satisfy NodeHandler. UI handlers are
// all v2-native now (Phase 3.5 retired the legacy StepHandler shape).

function actionAdapter(legacy: {
  kind: string;
  validateConfig(config: Prisma.JsonValue): string | null;
  execute(action: any, context: ActionExecutionContext): Promise<ActionResult>;
}): NodeHandler {
  return {
    kind: legacy.kind,
    category: 'ACTION',
    validateConfig: legacy.validateConfig.bind(legacy),
    async execute(node, context) {
      // Legacy action handler expects a LoadedAction shape (id, kind,
      // config, children). For v2, children are expressed as outgoing
      // edges — the runtime walks them after execute() returns. So
      // synthesize an empty-children action shell.
      return legacy.execute(
        {
          id: node.id,
          flowId: node.flowId,
          parentId: null,
          order: 0,
          kind: node.kind,
          config: node.config,
          children: [],
        } as any,
        context,
      );
    },
  };
}

// ─── WAIT handlers (Phase 3.2) ────────────────────────────────────
//
// WAIT_DURATION  → wait N milliseconds (config.durationMs).
// WAIT_UNTIL     → wait until a specific datetime resolved at runtime
//                  via a JSONLogic expression that produces an ISO
//                  string OR a ms-since-epoch number.
// WAIT_TOKEN     → wait until a resume URL is clicked. Phase 3.2b
//                  ships the consumer route + the CREATE_RESUME_LINK
//                  action; for 3.2a this handler stubs as a 1-day
//                  WAIT_DURATION fallback so existing flows that
//                  reference it don't 500.

const waitDurationHandler: NodeHandler = {
  kind: 'WAIT_DURATION',
  category: 'WAIT',
  validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return 'WAIT_DURATION config must be an object';
    }
    const c = config as Record<string, unknown>;
    if (typeof c.durationMs !== 'number' || c.durationMs < 0) {
      return 'WAIT_DURATION config.durationMs is required (positive number, milliseconds)';
    }
    if (c.durationMs > 365 * 24 * 60 * 60 * 1000) {
      return 'WAIT_DURATION config.durationMs cannot exceed 1 year (sanity cap)';
    }
    return null;
  },
  scheduleWait(node) {
    const cfg = node.config as unknown as { durationMs: number };
    return {
      kind: 'time',
      fireAt: new Date(Date.now() + cfg.durationMs),
    };
  },
};

const waitUntilHandler: NodeHandler = {
  kind: 'WAIT_UNTIL',
  category: 'WAIT',
  validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return 'WAIT_UNTIL config must be an object';
    }
    const c = config as Record<string, unknown>;
    if (c.datetimeExpr === undefined) {
      return 'WAIT_UNTIL config.datetimeExpr is required (JSONLogic producing ISO string or ms)';
    }
    return null;
  },
  scheduleWait(node, context) {
    const cfg = node.config as unknown as { datetimeExpr: unknown };
    let resolved: unknown;
    try {
      resolved = evaluate(cfg.datetimeExpr, context);
    } catch (err) {
      if (err instanceof ExpressionError) {
        throw new Error(`WAIT_UNTIL: ${err.message}`);
      }
      throw err;
    }

    // Accept ISO string OR ms-since-epoch number. Anything else falls
    // through to "wait 1 minute" so a broken expression doesn't stall
    // the run forever — admin sees the truncated wait in the run feed
    // and can fix the expression.
    let fireAt: Date;
    if (typeof resolved === 'string') {
      const t = new Date(resolved).getTime();
      if (!Number.isFinite(t)) {
        console.warn(
          `[engine:wait] WAIT_UNTIL got unparseable string "${resolved}" — falling back to 60s`,
        );
        fireAt = new Date(Date.now() + 60_000);
      } else {
        fireAt = new Date(t);
      }
    } else if (typeof resolved === 'number' && Number.isFinite(resolved)) {
      fireAt = new Date(resolved);
    } else {
      console.warn(
        `[engine:wait] WAIT_UNTIL expression resolved to ${typeof resolved} — falling back to 60s`,
      );
      fireAt = new Date(Date.now() + 60_000);
    }

    // Clamp: if the resolved time is in the past, fire immediately.
    // Helps with "wait until 9am today" expressions evaluated after 9am.
    if (fireAt.getTime() < Date.now()) {
      fireAt = new Date(Date.now() + 1_000);
    }
    return { kind: 'time', fireAt };
  },
};

const waitTokenHandler: NodeHandler = {
  kind: 'WAIT_TOKEN',
  category: 'WAIT',
  validateConfig(config) {
    // expirationDays optional — defaults to 30 in the runtime.
    if (config && typeof config !== 'object') {
      return 'WAIT_TOKEN config must be an object (or empty)';
    }
    return null;
  },
  scheduleWait(node) {
    const cfg = (node.config ?? {}) as { expirationDays?: number };
    return {
      kind: 'token',
      expirationDays: cfg.expirationDays ?? 30,
    };
  },
};

// ─── Registry ─────────────────────────────────────────────────────

export const nodeHandlers: Record<string, NodeHandler> = {
  // UI kinds — all v2-native after Phase 3.5.
  SINGLE_SELECT: singleSelectNodeHandler,
  // FORM resolves ENTITY_REF fields against the org-scoped entity
  // registry during validate + apply.
  FORM: formNodeHandler,
  RECAP: recapNodeHandler,

  // ACTION kinds
  SEND_EMAIL: actionAdapter(legacySendEmailHandler),
  // Phase 3.2b — pairs with WAIT_TOKEN to enable email-link resume.
  CREATE_RESUME_LINK: actionAdapter(legacyCreateResumeLinkHandler),

  // WAIT kinds — real handlers (Phase 3.2). WAIT_TOKEN's resume
  // route lands in Phase 3.2b; this handler still pauses the run
  // correctly so the schema is exercised end-to-end.
  WAIT_DURATION: waitDurationHandler,
  WAIT_UNTIL: waitUntilHandler,
  WAIT_TOKEN: waitTokenHandler,
};

export function getNodeHandler(kind: string): NodeHandler | null {
  return nodeHandlers[kind] ?? null;
}

/** Convenience helper for the runtime's category-based dispatch. */
export function nodeCategoryOf(kind: string): NodeCategory | null {
  return nodeHandlers[kind]?.category ?? null;
}
