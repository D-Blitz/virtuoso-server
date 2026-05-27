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

import { formHandler as legacyFormHandler } from '../stepHandlers/form';
import { recapHandler as legacyRecapHandler } from '../stepHandlers/recap';
import { singleSelectHandler as legacySingleSelectHandler } from '../stepHandlers/singleSelect';
import { sendEmailHandler as legacySendEmailHandler } from '../actionHandlers/sendEmail';
import type { ActionExecutionContext, ActionResult } from '../actionHandlers/types';
import type {
  StepHandler,
  StepSubmission,
  ValidationError,
} from '../types';

// ─── Category + handler shape ─────────────────────────────────────

export type NodeCategory = 'UI' | 'ACTION' | 'WAIT';

/**
 * Unified node handler. Different categories implement different
 * subsets:
 *   UI     → validateConfig, validateSubmission, applySubmission
 *   ACTION → validateConfig, execute
 *   WAIT   → validateConfig, scheduleResume
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
  validateSubmission?(
    submission: StepSubmission,
    node: WidgetNode,
  ): ValidationError[];
  applySubmission?(
    submission: StepSubmission,
    node: WidgetNode,
    currentVars: Record<string, unknown>,
  ): Record<string, unknown>;

  // ACTION-only methods ---------------------------------------------
  execute?(
    node: WidgetNode,
    context: ActionExecutionContext,
  ): Promise<ActionResult>;

  // WAIT-only methods (Phase 3.2 stubs) -----------------------------
  // Implementations return descriptors the runtime uses to enqueue
  // resume events. For Phase 3.1, every WAIT handler returns a no-op
  // so the runtime can ignore WAIT semantics and treat them as pass-
  // through ACTION nodes.
};

// ─── Adapters: bridge v1 step/action handlers to the v2 shape ────
//
// The v1 stepHandlers expect a `StepWithFields` (their second arg).
// v2 has a flat WidgetNode whose config can bundle fields. The
// adapter constructs a StepWithFields-like object from the node for
// the legacy handler's apply / validate calls.

function nodeAsStepWithFields(node: WidgetNode): {
  id: string;
  flowId: string;
  order: number;
  kind: string;
  label: string;
  description: string | null;
  config: Prisma.JsonValue;
  visibleWhen: Prisma.JsonValue | null;
  fields: Array<{
    id: string;
    stepId: string;
    order: number;
    kind: string;
    label: string;
    placeholder: string | null;
    required: boolean;
    binding: string;
    bindingTarget: string;
    config: Prisma.JsonValue;
  }>;
} {
  // FORM nodes bundle their fields under config.fields. Synthesize the
  // shape the legacy StepWithFields expects.
  const cfg = (node.config ?? {}) as { fields?: unknown };
  const rawFields = Array.isArray(cfg.fields) ? cfg.fields : [];

  return {
    id: node.id,
    flowId: node.flowId,
    order: 0, // legacy field, unused by handlers
    kind: node.kind,
    label: node.label,
    description: node.description,
    config: node.config as Prisma.JsonValue,
    visibleWhen: null, // v2 routes visibility via edges, not visibleWhen
    fields: rawFields.map((raw: any, i: number) => ({
      id: raw.id ?? `${node.id}.field.${i}`,
      stepId: node.id,
      order: typeof raw.order === 'number' ? raw.order : i,
      kind: raw.kind,
      label: raw.label,
      placeholder: raw.placeholder ?? null,
      required: !!raw.required,
      binding: raw.binding ?? 'VAR',
      bindingTarget: raw.bindingTarget,
      config: (raw.config ?? {}) as Prisma.JsonValue,
    })),
  };
}

function uiAdapter(legacy: StepHandler): NodeHandler {
  return {
    kind: legacy.kind,
    category: 'UI',
    validateConfig() {
      // Legacy step handlers don't expose validateConfig — config is
      // validated implicitly via their validate() at runtime. For v2
      // publish-time checks, accept any config shape and let runtime
      // surface issues.
      return null;
    },
    validateSubmission(submission, node) {
      return legacy.validate(submission, nodeAsStepWithFields(node) as any);
    },
    applySubmission(submission, node, currentVars) {
      return legacy.apply(submission, nodeAsStepWithFields(node) as any, currentVars);
    },
  };
}

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

// ─── WAIT handlers (Phase 3.1 stubs) ──────────────────────────────
//
// Phase 3.2 wires real wait semantics. For 3.1, these no-op so a
// flow author can drop a WAIT node and the runtime treats it as a
// pass-through that records an ENGINE event.

function waitStub(kind: string): NodeHandler {
  return {
    kind,
    category: 'WAIT',
    validateConfig() {
      return null;
    },
  };
}

// ─── Registry ─────────────────────────────────────────────────────

export const nodeHandlers: Record<string, NodeHandler> = {
  // UI kinds
  SINGLE_SELECT: uiAdapter(legacySingleSelectHandler),
  FORM: uiAdapter(legacyFormHandler),
  RECAP: uiAdapter(legacyRecapHandler),

  // ACTION kinds
  SEND_EMAIL: actionAdapter(legacySendEmailHandler),

  // WAIT kinds — stubs for Phase 3.1; real impl in Phase 3.2.
  WAIT_DURATION: waitStub('WAIT_DURATION'),
  WAIT_UNTIL: waitStub('WAIT_UNTIL'),
  WAIT_TOKEN: waitStub('WAIT_TOKEN'),
};

export function getNodeHandler(kind: string): NodeHandler | null {
  return nodeHandlers[kind] ?? null;
}

/** Convenience helper for the runtime's category-based dispatch. */
export function nodeCategoryOf(kind: string): NodeCategory | null {
  return nodeHandlers[kind]?.category ?? null;
}
