// Workflow engine — internal types (Phase 2.0 Commit 2).
//
// These shapes are the contract between the engine core (flowEngine.ts)
// and the per-kind step handlers (stepHandlers/*). Public HTTP routes
// (Commit 3) and the admin UI (Commit 4) consume them too.
//
// Nothing in this file is persisted directly. Persistence lives in
// Prisma's generated types; this layer is the in-memory shape we work
// with while running a flow.

import type {
  WidgetField,
  WidgetFlow,
  WidgetRun,
  WidgetStep,
  WidgetStepKind,
} from '@prisma/client';

// ─── Loaded-flow shapes ───────────────────────────────────────────

export type StepWithFields = WidgetStep & { fields: WidgetField[] };

export type FlowWithSteps = WidgetFlow & {
  steps: StepWithFields[];
};

// ─── Submission contract ──────────────────────────────────────────

/**
 * A visitor's submission for a single step.
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
 * One validation issue. `field` references a WidgetField.bindingTarget
 * for field-level errors, or is omitted for whole-step errors (e.g.
 * "your selection is no longer valid").
 */
export type ValidationError = {
  field?: string;
  message: string;
};

// ─── Step handler interface ───────────────────────────────────────

/**
 * One handler per WidgetStepKind. Handlers are pure — no DB access —
 * so they're trivial to unit-test in isolation. The engine wraps them
 * in the transactional write path.
 */
export type StepHandler<K extends WidgetStepKind = WidgetStepKind> = {
  readonly kind: K;

  /**
   * Returns an empty array if the submission is acceptable, otherwise
   * the list of issues to display. Handlers MUST NOT mutate the
   * submission or step.
   */
  validate(submission: StepSubmission, step: StepWithFields): ValidationError[];

  /**
   * Returns the NEW vars object after applying this step's contribution.
   * Handlers SHOULD spread `currentVars` to preserve other steps' data.
   * Called only after validate() returned an empty array.
   */
  apply(
    submission: StepSubmission,
    step: StepWithFields,
    currentVars: Record<string, unknown>,
  ): Record<string, unknown>;
};

// ─── Engine action kinds (metering) ───────────────────────────────

/**
 * Strings written into EngineActionEvent.actionKind for runtime ops.
 * Kept narrow on purpose — the post-submit action engine (Commit 2.2)
 * will extend this with SEND_EMAIL / ISSUE_REFUND / etc.
 */
export type EngineActionKind =
  | 'RUN_START'
  | 'STEP_SUBMIT'
  | 'STEP_VALIDATION_FAILED'
  | 'RUN_COMPLETE'
  | 'RUN_ERROR';

// ─── Run status string union ──────────────────────────────────────

/**
 * The WidgetRun.status column is a free String in the DB (deliberate —
 * keeps adding states cheap as the engine grows). This union is the
 * authoritative list for v1. Anything else in the column is a bug.
 */
export type RunStatus =
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'ABANDONED'
  | 'ERRORED';

// ─── Cached idempotency response ──────────────────────────────────

/**
 * Shape stored in WidgetRunSubmit.response Json. Small on purpose —
 * a retry rebuilds the full result by re-loading the run + step from
 * the DB, using this row to recover the validation outcome the
 * original call returned.
 */
export type SubmitResponseCache = {
  errors: ValidationError[];
  advancedToStepId: string | null;
};

// ─── Public submit result ─────────────────────────────────────────

/**
 * What submitStep() returns. The HTTP route in Commit 3 will serialize
 * this near-verbatim (run gets pruned to non-internal fields).
 */
export type SubmitResult = {
  run: WidgetRun;
  nextStep: StepWithFields | null;
  errors: ValidationError[];
  /**
   * True when this call short-circuited to a cached response because
   * the (runId, clientSubmitId) row already existed. Useful for the
   * client to distinguish a successful retry from a fresh submit.
   */
  replayed: boolean;
};
