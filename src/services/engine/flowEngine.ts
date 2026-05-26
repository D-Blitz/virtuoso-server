// Workflow engine — public API (Phase 2.0 Commit 2).
//
// Four operations cover the BOOKING-flow lifecycle:
//   startRun()    → create a WidgetRun, return the first step
//   advanceStep() → return current step (used for resume / polling)
//   submitStep()  → validate + apply a submission, advance currentStepId
//   completeRun() → explicit COMPLETED transition (e.g. abandoned cleanup)
//
// Design notes:
//
//   - No HTTP. This file is pure service code. Routes land in Commit 3.
//   - No JSONLogic / conditions. Every step is always visible; the
//     engine walks steps in `order`. Conditions ship Phase 2.1.
//   - No actions (SEND_EMAIL / ISSUE_REFUND / etc.). They land Commit 2.2.
//   - Multi-tenancy: every public-facing method takes `organizationId`
//     explicitly. The WidgetRun table is not in the auto-scoped set
//     (see prisma.ts) because the engine runs in an unauthenticated
//     visitor context — the orgId is resolved upstream from the
//     widget's publishableKey.
//   - Idempotency: submitStep() writes a WidgetRunSubmit row under a
//     (runId, clientSubmitId) unique. A duplicate clientSubmitId is
//     detected via that unique constraint and returns the cached
//     response without re-running validation or applying vars.
//
// Error model: invalid INPUT (unknown flow, wrong step, run already
// completed) throws an `EngineError`. Validation failures (visitor
// typed an invalid email) are NOT errors — they return as
// `result.errors` so the client can re-render the form.

import prisma from '../../prisma';
import { isStepVisible, type EvaluationContext } from './expressionEvaluator';
import { recordEngineAction } from './metering';
import { getStepHandler } from './stepHandlers';
import type {
  FlowWithSteps,
  RunStatus,
  StepSubmission,
  StepWithFields,
  SubmitResponseCache,
  SubmitResult,
  ValidationError,
} from './types';

// ─── Errors ───────────────────────────────────────────────────────

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'FLOW_NOT_FOUND'
      | 'FLOW_NOT_PUBLISHED'
      | 'RUN_NOT_FOUND'
      | 'RUN_NOT_IN_PROGRESS'
      | 'STEP_NOT_FOUND'
      | 'STEP_NOT_CURRENT'
      | 'NO_HANDLER',
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

const FLOW_WITH_STEPS_INCLUDE = {
  steps: {
    orderBy: { order: 'asc' as const },
    include: { fields: { orderBy: { order: 'asc' as const } } },
  },
};

/**
 * Build the context object every visibility expression evaluates
 * against. Stable contract — additions are backward compatible,
 * removals break flows in the wild.
 *
 *   vars  = the run's captured values (vars.<varName>)
 *   now   = current ISO timestamp (for time-based conditions like
 *           "show step only if start > now + 48h")
 *   org   = future hook for org-level constants (locale / timezone /
 *           currency); empty for now until we plumb the org row down.
 *
 * organizationId is passed in so future ops (entityRef) can resolve
 * scoped lookups without a separate context fetch.
 */
function buildEvaluationContext(
  vars: Record<string, unknown>,
  organizationId: string,
): EvaluationContext {
  return {
    vars,
    now: new Date().toISOString(),
    org: { id: organizationId },
  };
}

/**
 * Find the first step AFTER `fromStep` (in order) whose visibleWhen
 * expression evaluates truthy against the run's current vars. Steps
 * with null visibleWhen are always visible. Returns null if there's
 * no visible next step (= COMPLETED).
 *
 * Skipping hidden steps here (rather than at submitStep time) means
 * the visitor never sees a step that's been gated out — the engine
 * simply advances past it.
 */
function findNextStep(
  flow: FlowWithSteps,
  fromStep: StepWithFields,
  vars: Record<string, unknown>,
  organizationId: string,
): StepWithFields | null {
  const ctx = buildEvaluationContext(vars, organizationId);
  for (const step of flow.steps) {
    if (step.order <= fromStep.order) continue;
    if (isStepVisible(step.visibleWhen, ctx)) return step;
  }
  return null;
}

/**
 * Find the first visible step IN the flow (for startRun). Same skip
 * rules as findNextStep — a flow whose entire first run of steps is
 * gated out starts in COMPLETED immediately.
 */
function findFirstVisibleStep(
  flow: FlowWithSteps,
  vars: Record<string, unknown>,
  organizationId: string,
): StepWithFields | null {
  const ctx = buildEvaluationContext(vars, organizationId);
  for (const step of flow.steps) {
    if (isStepVisible(step.visibleWhen, ctx)) return step;
  }
  return null;
}

function findStepById(flow: FlowWithSteps, stepId: string): StepWithFields | undefined {
  return flow.steps.find((s) => s.id === stepId);
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Start a new run. The caller resolves the flowId + organizationId
 * upstream (BOOKING flows from publishableKey lookup; EVENT_REACTION
 * flows from the event bus — not wired yet).
 *
 * Returns the created run along with the first step the visitor should
 * see. firstStep is null for flows with zero steps (a sanity edge case
 * — publish should reject these in Commit 3).
 */
export async function startRun(params: {
  flowId: string;
  organizationId: string;
}): Promise<{ run: Awaited<ReturnType<typeof prisma.widgetRun.create>>; firstStep: StepWithFields | null }> {
  const t0 = Date.now();

  const flow = await prisma.widgetFlow.findFirst({
    where: { id: params.flowId, organizationId: params.organizationId },
    include: FLOW_WITH_STEPS_INCLUDE,
  });

  if (!flow) {
    throw new EngineError(`Flow ${params.flowId} not found`, 'FLOW_NOT_FOUND');
  }
  if (!flow.isPublished && flow.kind === 'BOOKING') {
    // BOOKING flows must be Published to serve a public visitor.
    // EVENT_REACTION flows skip this check — they run server-internal.
    throw new EngineError(
      `Flow ${params.flowId} is not published`,
      'FLOW_NOT_PUBLISHED',
    );
  }

  // Phase 2.1: respect visibleWhen on the first step too — a flow
  // whose opener is gated out skips to the next visible step, or
  // completes immediately if none are visible.
  const firstStep = findFirstVisibleStep(
    flow,
    {},
    params.organizationId,
  );

  const run = await prisma.widgetRun.create({
    data: {
      organizationId: params.organizationId,
      flowId: params.flowId,
      vars: {},
      currentStepId: firstStep?.id ?? null,
      status: firstStep
        ? ('IN_PROGRESS' satisfies RunStatus)
        : ('COMPLETED' satisfies RunStatus),
      completedAt: firstStep ? null : new Date(),
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
  });

  return { run, firstStep };
}

/**
 * Return the current state of a run — used by clients that need to
 * resume after a reload, or to poll while we add server-driven
 * transitions later. For Commit 2 this is a thin read; later phases
 * (conditional steps) will compute the next-visible step here.
 */
export async function advanceStep(params: {
  runId: string;
}): Promise<{
  run: Awaited<ReturnType<typeof prisma.widgetRun.findUnique>> & object;
  currentStep: StepWithFields | null;
}> {
  const run = await prisma.widgetRun.findUnique({
    where: { id: params.runId },
    include: { flow: { include: FLOW_WITH_STEPS_INCLUDE } },
  });

  if (!run) {
    throw new EngineError(`Run ${params.runId} not found`, 'RUN_NOT_FOUND');
  }

  const currentStep = run.currentStepId
    ? findStepById(run.flow as FlowWithSteps, run.currentStepId) ?? null
    : null;

  // Strip the flow relation from the returned run to keep the API
  // contract narrow — callers asked for run state, not the whole flow.
  const { flow: _flow, ...runWithoutFlow } = run;
  return { run: runWithoutFlow, currentStep };
}

/**
 * Submit a step. The single hot path of the engine.
 *
 * Flow:
 *   1. Check the (runId, clientSubmitId) idempotency record. If it
 *      exists, return a SubmitResult rebuilt from the cached response
 *      + the run's current state — no validation, no apply.
 *   2. Load run + flow + steps. Bail if the run isn't IN_PROGRESS or
 *      the step isn't the run's current step.
 *   3. Run the kind-specific handler's validate(). If errors, persist
 *      the WidgetRunSubmit row with errors cached, log a
 *      STEP_VALIDATION_FAILED metering event, return the errors.
 *   4. Otherwise run apply() to compute new vars, find the next step,
 *      and update the run + write the WidgetRunSubmit row in a single
 *      transaction. Log STEP_SUBMIT (or RUN_COMPLETE when no next).
 *
 * Race note: two concurrent submits with the SAME clientSubmitId race
 * to insert the WidgetRunSubmit row. One wins (Postgres unique
 * constraint), the other gets a P2002 — we catch that and replay the
 * winner's cached response instead. See the catch block at the bottom.
 */
export async function submitStep(params: {
  runId: string;
  stepId: string;
  submission: StepSubmission;
}): Promise<SubmitResult> {
  const t0 = Date.now();
  const { runId, stepId, submission } = params;
  const { clientSubmitId } = submission;

  // ── Step 1: idempotency short-circuit (no transaction needed —
  // the read is single-row, indexed, and a stale read here is safe
  // because we'll catch the unique-constraint conflict below).
  const cached = await prisma.widgetRunSubmit.findUnique({
    where: { runId_clientSubmitId: { runId, clientSubmitId } },
  });
  if (cached) {
    return await replayCached(runId, cached);
  }

  // ── Step 2: load + validate state.
  const run = await prisma.widgetRun.findUnique({
    where: { id: runId },
    include: { flow: { include: FLOW_WITH_STEPS_INCLUDE } },
  });
  if (!run) {
    throw new EngineError(`Run ${runId} not found`, 'RUN_NOT_FOUND');
  }
  if (run.status !== ('IN_PROGRESS' satisfies RunStatus)) {
    throw new EngineError(
      `Run ${runId} is ${run.status}, not IN_PROGRESS`,
      'RUN_NOT_IN_PROGRESS',
    );
  }

  const flow = run.flow as FlowWithSteps;
  const step = findStepById(flow, stepId);
  if (!step) {
    throw new EngineError(`Step ${stepId} not on flow ${run.flowId}`, 'STEP_NOT_FOUND');
  }
  if (step.id !== run.currentStepId) {
    throw new EngineError(
      `Step ${stepId} is not the current step (${run.currentStepId})`,
      'STEP_NOT_CURRENT',
    );
  }

  const handler = getStepHandler(step.kind);

  // ── Step 3: validate.
  const errors = handler.validate(submission, step);

  // ── Step 4: persist (errors or success) in one transaction.
  try {
    if (errors.length > 0) {
      // Validation failed — cache the errors so a retry returns the
      // same result, but DO NOT advance the run.
      const cache: SubmitResponseCache = { errors, advancedToStepId: null };
      await prisma.widgetRunSubmit.create({
        data: {
          runId,
          stepId,
          clientSubmitId,
          response: cache as unknown as object,
        },
      });

      await recordEngineAction({
        organizationId: run.organizationId,
        flowId: run.flowId,
        runId: run.id,
        actionKind: 'STEP_VALIDATION_FAILED',
        status: 'OK',
        durationMs: Date.now() - t0,
      });

      return { run, nextStep: step, errors, replayed: false };
    }

    // Validation passed — apply + advance.
    // Phase 2.1: compute new vars FIRST, then evaluate the next
    // visible step against THOSE vars. Visibility conditions on later
    // steps frequently reference values just captured by this step
    // (e.g. "show payment step only if vars.attendees > 0"), so
    // evaluating against post-apply vars is the correct semantic.
    const newVars = handler.apply(submission, step, run.vars as Record<string, unknown>);
    const nextStep = findNextStep(flow, step, newVars, run.organizationId);
    const completing = nextStep == null;

    const newHistory = [
      ...((run.stepHistory as Array<Record<string, unknown>>) ?? []),
      { stepId: step.id, submittedAt: new Date().toISOString() },
    ];

    const [updatedRun] = await prisma.$transaction([
      prisma.widgetRun.update({
        where: { id: runId },
        data: {
          vars: newVars as object,
          currentStepId: nextStep?.id ?? null,
          status: completing
            ? ('COMPLETED' satisfies RunStatus)
            : ('IN_PROGRESS' satisfies RunStatus),
          completedAt: completing ? new Date() : null,
          stepHistory: newHistory as unknown as object,
        },
      }),
      prisma.widgetRunSubmit.create({
        data: {
          runId,
          stepId,
          clientSubmitId,
          response: {
            errors: [],
            advancedToStepId: nextStep?.id ?? null,
          } satisfies SubmitResponseCache as unknown as object,
        },
      }),
    ]);

    await recordEngineAction({
      organizationId: run.organizationId,
      flowId: run.flowId,
      runId: run.id,
      actionKind: completing ? 'RUN_COMPLETE' : 'STEP_SUBMIT',
      status: 'OK',
      durationMs: Date.now() - t0,
    });

    return { run: updatedRun, nextStep, errors: [], replayed: false };
  } catch (err) {
    // P2002: unique constraint conflict on (runId, clientSubmitId) —
    // a concurrent retry won. Read the winner's row and replay.
    if (isUniqueConstraintError(err)) {
      const winner = await prisma.widgetRunSubmit.findUnique({
        where: { runId_clientSubmitId: { runId, clientSubmitId } },
      });
      if (winner) return await replayCached(runId, winner);
    }
    // Anything else: log + bubble up.
    await recordEngineAction({
      organizationId: run.organizationId,
      flowId: run.flowId,
      runId: run.id,
      actionKind: 'RUN_ERROR',
      status: 'ERROR',
      durationMs: Date.now() - t0,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Mark a run COMPLETED explicitly. Most runs reach COMPLETED via the
 * last submitStep() call. This entry point exists for:
 *   - admin force-completion (rare, debug surface)
 *   - background cleanup jobs (future: WidgetRun.status='ABANDONED'
 *     for runs that hit a TTL with no activity)
 *
 * Idempotent: calling on an already-COMPLETED run is a no-op.
 */
export async function completeRun(params: {
  runId: string;
}): Promise<Awaited<ReturnType<typeof prisma.widgetRun.update>>> {
  const t0 = Date.now();
  const existing = await prisma.widgetRun.findUnique({
    where: { id: params.runId },
    select: { id: true, organizationId: true, flowId: true, status: true },
  });

  if (!existing) {
    throw new EngineError(`Run ${params.runId} not found`, 'RUN_NOT_FOUND');
  }

  if (existing.status === ('COMPLETED' satisfies RunStatus)) {
    // Re-read full row for return shape consistency.
    return (await prisma.widgetRun.findUniqueOrThrow({
      where: { id: params.runId },
    }));
  }

  const updated = await prisma.widgetRun.update({
    where: { id: params.runId },
    data: {
      status: 'COMPLETED' satisfies RunStatus,
      currentStepId: null,
      completedAt: new Date(),
    },
  });

  await recordEngineAction({
    organizationId: existing.organizationId,
    flowId: existing.flowId,
    runId: existing.id,
    actionKind: 'RUN_COMPLETE',
    status: 'OK',
    durationMs: Date.now() - t0,
  });

  return updated;
}

// ─── Internals ────────────────────────────────────────────────────

async function replayCached(
  runId: string,
  submitRow: { response: unknown; stepId: string },
): Promise<SubmitResult> {
  // The cache row plus the current run state is enough to rebuild a
  // SubmitResult. No metering write — we deliberately don't bill
  // replays (the work was already counted on the original submit).
  const cache = submitRow.response as SubmitResponseCache;

  const run = await prisma.widgetRun.findUniqueOrThrow({
    where: { id: runId },
    include: { flow: { include: FLOW_WITH_STEPS_INCLUDE } },
  });
  const flow = run.flow as FlowWithSteps;
  const nextStep = cache.advancedToStepId
    ? findStepById(flow, cache.advancedToStepId) ?? null
    : // Validation-failure replay: nextStep is the step they're still on
      findStepById(flow, submitRow.stepId) ?? null;

  const { flow: _flow, ...runWithoutFlow } = run;
  return {
    run: runWithoutFlow,
    nextStep,
    errors: cache.errors,
    replayed: true,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  // Prisma's PrismaClientKnownRequestError carries `code: 'P2002'`
  // for unique constraint violations. Duck-typed to avoid importing
  // the class (would require runtime-only import gymnastics).
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}
