// Workflow engine — internal types (Phase 3.5 — post-v1 cleanup).
//
// Pared down from the v1 surface: StepHandler / StepWithFields /
// FlowWithSteps were removed when the v1 engine (flowEngine.ts +
// stepHandlers/) was deleted. The v2 node handler shape lives in
// nodeHandlers/index.ts.
//
// What remains here is the cross-version "submission contract" —
// the in-memory shapes the v2 graph runtime + node handlers + admin
// validation share. Names keep the historical "Step" prefix for
// continuity (the contract didn't change between v1 and v2, only
// where it's implemented).

import type { WidgetNode, WidgetRun } from '@prisma/client';

// ─── Submission contract ──────────────────────────────────────────

/**
 * A visitor's submission for a single UI node.
 *
 * `values` is intentionally untyped at this layer — each handler knows
 * how to shape-check its own kind's payload. Examples:
 *   SINGLE_SELECT  → { selected: string }
 *   FORM           → { [bindingTarget: string]: unknown }
 *   RECAP          → {} (just a confirm signal)
 *
 * `clientSubmitId` is the idempotency key. Clients should generate a
 * fresh UUIDv4 on first call and reuse it on every retry. The engine
 * stores it in WidgetRunSubmit with a (runId, clientSubmitId) unique
 * — duplicates short-circuit to the cached response.
 */
export type StepSubmission = {
  values: Record<string, unknown>;
  clientSubmitId: string;
};

// ─── Validation ───────────────────────────────────────────────────

/**
 * One validation issue. `field` references a FORM field's
 * bindingTarget for field-level errors, or is omitted for whole-node
 * errors (e.g. "your selection is no longer valid").
 */
export type ValidationError = {
  field?: string;
  message: string;
};

// ─── Engine action kinds (metering) ───────────────────────────────

/**
 * Strings written into EngineActionEvent.actionKind. The set grew
 * alongside the engine; metering treats every value as opaque, so
 * adding a new kind doesn't require a code change here — this union
 * exists only for typecheck-time discipline at the call sites.
 */
export type EngineActionKind =
  | 'RUN_START'
  | 'STEP_SUBMIT'
  | 'STEP_VALIDATION_FAILED'
  | 'RUN_COMPLETE'
  | 'RUN_ERROR'
  | 'TRIGGER_RATE_LIMITED';

// ─── Run status string union ──────────────────────────────────────

/**
 * The WidgetRun.status column is a free String in the DB (deliberate —
 * keeps adding states cheap as the engine grows). v2 added the
 * WAITING_TIME / WAITING_TOKEN states for paused runs.
 */
export type RunStatus =
  | 'IN_PROGRESS'
  | 'WAITING_INPUT'
  | 'WAITING_TIME'
  | 'WAITING_TOKEN'
  | 'COMPLETED'
  | 'ABANDONED'
  | 'ERRORED';

// ─── Cached idempotency response ──────────────────────────────────

/**
 * Shape stored in WidgetRunSubmit.response Json. Small on purpose —
 * a retry rebuilds the full result by re-loading the run + node from
 * the DB, using this row to recover the validation outcome the
 * original call returned.
 */
export type SubmitResponseCache = {
  errors: ValidationError[];
  /**
   * For successful submits, the id of the node we advanced to (or
   * null if the run completed). The "Step" name is historical — the
   * value is a WidgetNode.id in v2.
   */
  advancedToStepId: string | null;
};

// ─── Public submit result ─────────────────────────────────────────

/**
 * What submitNode() returns. The HTTP controller projects this to
 * the public-safe shape before responding.
 */
export type SubmitResult = {
  run: WidgetRun;
  nextNode: WidgetNode | null;
  errors: ValidationError[];
  /**
   * True when this call short-circuited to a cached response because
   * the (runId, clientSubmitId) row already existed. Useful for the
   * client to distinguish a successful retry from a fresh submit.
   */
  replayed: boolean;
};
