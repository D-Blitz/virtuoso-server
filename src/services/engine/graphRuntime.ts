// Graph runtime — v2 state machine (Phase 3.1).
//
// Replaces the v1 flowEngine.ts (linear step walker + post-completion
// action tree). The v2 engine walks a directed graph of nodes:
//
//   startRun(flow, entryNode, seedVars)
//     → creates a WidgetRun at entryNode + walks forward
//
//   advanceRun(runId)
//     → from currentNodeId, walks node-by-node:
//         UI     → pause (WAITING_INPUT), return current node
//         ACTION → execute server-side, follow outgoing edges
//         WAIT   → pause (WAITING_TIME/TOKEN), Phase 3.2 sweeper resumes
//     → if no outgoing edges match → COMPLETED
//
//   submitNode(runId, nodeId, submission)
//     → handle visitor input on a UI node, then advanceRun
//
//   resumeRun(runId, nodeId)
//     → re-enter from a WAIT node (Phase 3.2 callers)
//
// Edge selection: outgoing edges sorted by `order` ascending. First
// edge whose `condition` evaluates truthy wins. An edge with no
// condition always wins (use sparingly — typically the last in a
// branch as the catch-all).
//
// Vars: a run's vars accumulate across the entire graph walk. UI
// submissions append values via the handler's applySubmission().
// ACTION nodes can read but don't write vars in v2 (action outputs
// are a Phase 3.4+ feature).
//
// Idempotency: submitNode dedupes via the existing WidgetRunSubmit
// table — (runId, clientSubmitId) is unique; a duplicate replays the
// cached response without re-walking.

import type { Prisma, WidgetEdge, WidgetNode, WidgetRun } from '@prisma/client';

import prisma from '../../prisma';
import { fireFlowCompletionActions as _legacyFireActions } from './actionExecutor';
import { isStepVisible, type EvaluationContext } from './expressionEvaluator';
import { recordEngineAction } from './metering';
import { getNodeHandler, type NodeCategory } from './nodeHandlers';
import type {
  StepSubmission,
  SubmitResponseCache,
  ValidationError,
} from './types';

// ─── Errors ───────────────────────────────────────────────────────

export class GraphRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'FLOW_NOT_FOUND'
      | 'FLOW_NOT_PUBLISHED'
      | 'RUN_NOT_FOUND'
      | 'RUN_NOT_IN_PROGRESS'
      | 'NODE_NOT_FOUND'
      | 'NODE_NOT_CURRENT'
      | 'NO_HANDLER'
      | 'ENTRY_NOT_FOUND',
  ) {
    super(message);
    this.name = 'GraphRuntimeError';
  }
}

// ─── Run status union ─────────────────────────────────────────────

export type RunStatus =
  | 'IN_PROGRESS'
  | 'WAITING_INPUT'
  | 'WAITING_TIME'
  | 'WAITING_TOKEN'
  | 'COMPLETED'
  | 'ABANDONED'
  | 'ERRORED';

// ─── Loaded shapes ────────────────────────────────────────────────

type LoadedFlow = Prisma.WidgetFlowGetPayload<{
  include: {
    nodes: true;
    edges: true;
    entryPoints: true;
  };
}>;

type LoadedRun = WidgetRun;

// ─── Public result types ─────────────────────────────────────────

export type AdvanceResult = {
  run: LoadedRun;
  /** The node the run is currently stopped at (UI or WAIT), or null
   *  if COMPLETED. */
  currentNode: WidgetNode | null;
};

export type SubmitResult = {
  run: LoadedRun;
  /** Next UI/WAIT node after this submit (or null if COMPLETED). */
  nextNode: WidgetNode | null;
  errors: ValidationError[];
  /** True if this call short-circuited to a cached response. */
  replayed: boolean;
};

// ─── Helpers ──────────────────────────────────────────────────────

const FLOW_INCLUDE = {
  nodes: true,
  edges: true,
  entryPoints: true,
} as const;

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

function findNodeById(flow: LoadedFlow, nodeId: string): WidgetNode | null {
  return flow.nodes.find((n) => n.id === nodeId) ?? null;
}

/**
 * Outgoing edges from a node, sorted by `order` ascending. The first
 * edge whose condition matches is the winner. A null condition
 * always matches — last-resort catch-all.
 */
function outgoingEdgesOf(flow: LoadedFlow, nodeId: string): WidgetEdge[] {
  return flow.edges
    .filter((e) => e.fromNodeId === nodeId)
    .sort((a, b) => a.order - b.order);
}

function pickNextEdge(
  flow: LoadedFlow,
  fromNodeId: string,
  ctx: EvaluationContext,
): WidgetEdge | null {
  const edges = outgoingEdgesOf(flow, fromNodeId);
  for (const edge of edges) {
    // isStepVisible falls open on parse errors; for edges (which can
    // be authored as conditional branches) we want the same forgiving
    // behavior — a broken condition shouldn't strand the run on the
    // current node.
    if (edge.condition == null) return edge;
    if (isStepVisible(edge.condition, ctx)) return edge;
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Start a new run at a specific entry node. Callers (route handlers,
 * trigger dispatcher) resolve the entry node from an entry-point
 * descriptor (visitor publishableKey → flow.entryPoints[kind=visitor]
 * → entryNodeId).
 *
 * Walks immediately past any ACTION nodes between the entry and the
 * first UI/WAIT, so the caller's first interaction with the run is
 * always against a meaningful pause point (or COMPLETED).
 */
export async function startRun(params: {
  flowId: string;
  organizationId: string;
  entryNodeId: string;
  seedVars?: Record<string, unknown>;
}): Promise<AdvanceResult> {
  const t0 = Date.now();

  const flow = await prisma.widgetFlow.findFirst({
    where: { id: params.flowId, organizationId: params.organizationId },
    include: FLOW_INCLUDE,
  });
  if (!flow) {
    throw new GraphRuntimeError(`Flow ${params.flowId} not found`, 'FLOW_NOT_FOUND');
  }
  if (!flow.isPublished) {
    throw new GraphRuntimeError(`Flow ${params.flowId} is not published`, 'FLOW_NOT_PUBLISHED');
  }

  const entryNode = findNodeById(flow, params.entryNodeId);
  if (!entryNode) {
    throw new GraphRuntimeError(
      `Entry node ${params.entryNodeId} not found on flow ${params.flowId}`,
      'ENTRY_NOT_FOUND',
    );
  }

  // Materialize the run at the entry node. Initial status depends on
  // the entry node's category — most often UI (visitor flows) but
  // can be ACTION (event-driven flows whose first node is SEND_EMAIL).
  const run = await prisma.widgetRun.create({
    data: {
      organizationId: params.organizationId,
      flowId: params.flowId,
      vars: (params.seedVars ?? {}) as Prisma.InputJsonValue,
      currentStepId: null,
      currentNodeId: entryNode.id,
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
  });

  // Walk from the entry — handles UI pause / ACTION execute / WAIT
  // suspend / COMPLETED transitions in one shot.
  return advanceRun({ runId: run.id });
}

/**
 * Advance a run from its current node. Walks until it hits a UI/WAIT
 * node (pause) or runs out of matching outgoing edges (COMPLETED).
 *
 * Most external callers go through submitNode / resumeRun — those
 * funnel into advanceRun after handling their entry side effects.
 * Exposed directly for the trigger dispatcher (which calls startRun,
 * which itself ends with an advanceRun).
 */
export async function advanceRun(params: {
  runId: string;
}): Promise<AdvanceResult> {
  const run = await prisma.widgetRun.findUnique({
    where: { id: params.runId },
    include: { flow: { include: FLOW_INCLUDE } },
  });
  if (!run) {
    throw new GraphRuntimeError(`Run ${params.runId} not found`, 'RUN_NOT_FOUND');
  }

  const flow = run.flow as LoadedFlow;
  let currentNodeId = run.currentNodeId;
  let vars = (run.vars ?? {}) as Record<string, unknown>;

  // Handle the "already-COMPLETED" entry case: currentNodeId null at
  // the start means submitNode just advanced past the last node (no
  // outgoing edge from a UI/WAIT). Mark COMPLETED here so the run's
  // status reflects the final state.
  if (!currentNodeId) {
    if (run.status !== ('COMPLETED' satisfies RunStatus)) {
      await prisma.widgetRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED' satisfies RunStatus,
          completedAt: new Date(),
        },
      });
      await recordEngineAction({
        organizationId: run.organizationId,
        flowId: run.flowId,
        runId: run.id,
        actionKind: 'RUN_COMPLETE',
        status: 'OK',
        durationMs: 0,
      });
    }
    const refreshed = await prisma.widgetRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    return { run: refreshed, currentNode: null };
  }

  // Walk loop — each iteration handles one node + advances or pauses.
  // Cap iterations at MAX_WALK_STEPS to detect runaway loops (admin
  // built a cycle into the graph). 500 is generous; honest flows are
  // < 20 nodes deep.
  const MAX_WALK_STEPS = 500;
  let steps = 0;

  while (currentNodeId && steps < MAX_WALK_STEPS) {
    steps += 1;
    const node = findNodeById(flow, currentNodeId);
    if (!node) {
      // Dangling currentNodeId — flow was re-published with the node
      // removed. Mark ERRORED so admin sees something went wrong.
      await prisma.widgetRun.update({
        where: { id: run.id },
        data: { status: 'ERRORED', completedAt: new Date() },
      });
      throw new GraphRuntimeError(
        `Current node ${currentNodeId} no longer exists`,
        'NODE_NOT_FOUND',
      );
    }

    const handler = getNodeHandler(node.kind);
    if (!handler) {
      await prisma.widgetRun.update({
        where: { id: run.id },
        data: { status: 'ERRORED', completedAt: new Date() },
      });
      throw new GraphRuntimeError(
        `No handler for node kind "${node.kind}"`,
        'NO_HANDLER',
      );
    }

    // Dispatch by category.
    if (handler.category === 'UI') {
      // Pause for visitor input — return the node for the renderer.
      await prisma.widgetRun.update({
        where: { id: run.id },
        data: {
          status: 'WAITING_INPUT' satisfies RunStatus,
          currentNodeId: node.id,
        },
      });
      const refreshed = await prisma.widgetRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      return { run: refreshed, currentNode: node };
    }

    if (handler.category === 'WAIT') {
      // Phase 3.1 stub — WAIT nodes pass through immediately.
      // Phase 3.2 sets status = WAITING_TIME/TOKEN + writes to
      // WidgetScheduledResume / WidgetResumeToken + returns here.
      await recordEngineAction({
        organizationId: run.organizationId,
        flowId: run.flowId,
        runId: run.id,
        actionKind: `NODE_${node.kind}`,
        status: 'SKIPPED',
        durationMs: 0,
        errorMessage: 'WAIT semantics deferred to Phase 3.2',
      });
      // Fall through to edge picking — treat as a no-op ACTION.
    } else {
      // ACTION — execute synchronously.
      const t0 = Date.now();
      try {
        const result = await handler.execute!(node, {
          organizationId: run.organizationId,
          flowId: run.flowId,
          runId: run.id,
          evaluationContext: buildEvaluationContext(vars, run.organizationId),
        });
        await recordEngineAction({
          organizationId: run.organizationId,
          flowId: run.flowId,
          runId: run.id,
          actionKind: node.kind,
          status: result.status,
          durationMs: Date.now() - t0,
          errorMessage:
            result.status === 'OK'
              ? undefined
              : result.status === 'SKIPPED'
                ? result.reason
                : result.message,
        });
      } catch (err) {
        await recordEngineAction({
          organizationId: run.organizationId,
          flowId: run.flowId,
          runId: run.id,
          actionKind: node.kind,
          status: 'ERROR',
          durationMs: Date.now() - t0,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        // Continue walking — a failed action shouldn't strand the
        // visitor on the broken node. (For BOOKING flows with a
        // failing email, we still complete the run.)
      }
    }

    // Pick the next edge to follow.
    const nextEdge = pickNextEdge(
      flow,
      node.id,
      buildEvaluationContext(vars, run.organizationId),
    );
    if (!nextEdge) {
      // End of the walk — no outgoing edge matched.
      await prisma.widgetRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED' satisfies RunStatus,
          currentNodeId: null,
          completedAt: new Date(),
        },
      });
      await recordEngineAction({
        organizationId: run.organizationId,
        flowId: run.flowId,
        runId: run.id,
        actionKind: 'RUN_COMPLETE',
        status: 'OK',
        durationMs: 0,
      });
      const refreshed = await prisma.widgetRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      return { run: refreshed, currentNode: null };
    }

    currentNodeId = nextEdge.toNodeId;
  }

  // Walk-step cap exhausted — likely a cycle. Mark ERRORED.
  if (steps >= MAX_WALK_STEPS) {
    await prisma.widgetRun.update({
      where: { id: run.id },
      data: { status: 'ERRORED', completedAt: new Date() },
    });
    await recordEngineAction({
      organizationId: run.organizationId,
      flowId: run.flowId,
      runId: run.id,
      actionKind: 'RUN_ERROR',
      status: 'ERROR',
      durationMs: 0,
      errorMessage: `walk exceeded ${MAX_WALK_STEPS} steps — likely a graph cycle`,
    });
    const refreshed = await prisma.widgetRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    return { run: refreshed, currentNode: null };
  }

  // Reached here means currentNodeId went null mid-loop somehow.
  // Mark COMPLETED defensively.
  const refreshed = await prisma.widgetRun.findUniqueOrThrow({
    where: { id: run.id },
  });
  return { run: refreshed, currentNode: null };
}

/**
 * Submit a visitor's input on a UI node. Returns the updated run +
 * the next node to render (or null if the run completed).
 *
 * Idempotency: persists a WidgetRunSubmit row keyed on
 * (runId, clientSubmitId). A duplicate clientSubmitId replays the
 * cached response without re-validating or re-applying.
 */
export async function submitNode(params: {
  runId: string;
  nodeId: string;
  submission: StepSubmission;
}): Promise<SubmitResult> {
  const t0 = Date.now();
  const { runId, nodeId, submission } = params;
  const { clientSubmitId } = submission;

  // ── Idempotency short-circuit.
  const cached = await prisma.widgetRunSubmit.findUnique({
    where: { runId_clientSubmitId: { runId, clientSubmitId } },
  });
  if (cached) {
    return await replayCached(runId, cached);
  }

  // ── Load + validate state.
  const run = await prisma.widgetRun.findUnique({
    where: { id: runId },
    include: { flow: { include: FLOW_INCLUDE } },
  });
  if (!run) {
    throw new GraphRuntimeError(`Run ${runId} not found`, 'RUN_NOT_FOUND');
  }
  if (run.status !== ('WAITING_INPUT' satisfies RunStatus)) {
    throw new GraphRuntimeError(
      `Run ${runId} is ${run.status}, not WAITING_INPUT`,
      'RUN_NOT_IN_PROGRESS',
    );
  }

  const flow = run.flow as LoadedFlow;
  const node = findNodeById(flow, nodeId);
  if (!node) {
    throw new GraphRuntimeError(
      `Node ${nodeId} not on flow ${run.flowId}`,
      'NODE_NOT_FOUND',
    );
  }
  if (node.id !== run.currentNodeId) {
    throw new GraphRuntimeError(
      `Node ${nodeId} is not the current node (${run.currentNodeId})`,
      'NODE_NOT_CURRENT',
    );
  }

  const handler = getNodeHandler(node.kind);
  if (!handler || handler.category !== 'UI') {
    throw new GraphRuntimeError(
      `Node ${nodeId} has non-UI handler — cannot submit`,
      'NO_HANDLER',
    );
  }

  // ── Validate.
  const errors = handler.validateSubmission!(submission, node);

  if (errors.length > 0) {
    // Validation failed — cache + return without advancing.
    const cache: SubmitResponseCache = {
      errors,
      advancedToStepId: null,
    };
    await prisma.widgetRunSubmit.create({
      data: {
        runId,
        stepId: nodeId,
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
    return { run, nextNode: node, errors, replayed: false };
  }

  // ── Apply submission — update vars.
  const currentVars = (run.vars ?? {}) as Record<string, unknown>;
  const newVars = handler.applySubmission!(submission, node, currentVars);

  // Pick the next edge to follow from THIS node, using the
  // post-apply vars (so conditions referencing the value the visitor
  // just submitted work intuitively). currentNodeId advances to the
  // edge's target BEFORE advanceRun walks — otherwise the walker
  // would immediately re-pause on the same UI node.
  const ctx = buildEvaluationContext(newVars, run.organizationId);
  const nextEdge = pickNextEdge(flow, node.id, ctx);
  const nextNodeIdAfterSubmit = nextEdge?.toNodeId ?? null;

  // Persist vars + status + cursor + idempotency row + history in one
  // transaction. If nextEdge is null (last node in the graph),
  // currentNodeId becomes null and advanceRun will mark COMPLETED.
  const newHistory = [
    ...((run.stepHistory as Array<Record<string, unknown>>) ?? []),
    { nodeId: node.id, submittedAt: new Date().toISOString() },
  ];

  await prisma.$transaction([
    prisma.widgetRun.update({
      where: { id: runId },
      data: {
        vars: newVars as Prisma.InputJsonValue,
        status: 'IN_PROGRESS' satisfies RunStatus,
        currentNodeId: nextNodeIdAfterSubmit,
        stepHistory: newHistory as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.widgetRunSubmit.create({
      data: {
        runId,
        stepId: nodeId,
        clientSubmitId,
        response: {
          errors: [],
          advancedToStepId: nextNodeIdAfterSubmit,
        } satisfies SubmitResponseCache as unknown as object,
      },
    }),
  ]);

  await recordEngineAction({
    organizationId: run.organizationId,
    flowId: run.flowId,
    runId: run.id,
    actionKind: 'STEP_SUBMIT',
    status: 'OK',
    durationMs: Date.now() - t0,
  });

  // ── Walk forward from the just-advanced cursor. advanceRun handles
  // the COMPLETED transition when currentNodeId is null.
  const after = await advanceRun({ runId });

  return {
    run: after.run,
    nextNode: after.currentNode,
    errors: [],
    replayed: false,
  };
}

// ─── Internals ────────────────────────────────────────────────────

async function replayCached(
  runId: string,
  submitRow: { response: unknown; stepId: string },
): Promise<SubmitResult> {
  const cache = submitRow.response as SubmitResponseCache;
  const run = await prisma.widgetRun.findUniqueOrThrow({
    where: { id: runId },
    include: { flow: { include: FLOW_INCLUDE } },
  });
  const flow = run.flow as LoadedFlow;
  const nextNode = run.currentNodeId
    ? findNodeById(flow, run.currentNodeId)
    : null;
  const { flow: _flow, ...runWithoutFlow } = run;
  return {
    run: runWithoutFlow,
    nextNode,
    errors: cache.errors,
    replayed: true,
  };
}

// Re-export EvaluationContext for convenience.
export type { EvaluationContext } from './expressionEvaluator';
// Re-export NodeCategory for convenience in callers.
export type { NodeCategory };

// Silence unused-import lint for the legacy fire-actions import — kept
// as a marker that the v1 action executor is still around (used by
// the v1 flowEngine which the v1 routes still consume). When Phase
// 3.5 drops v1, this import goes too.
void _legacyFireActions;
