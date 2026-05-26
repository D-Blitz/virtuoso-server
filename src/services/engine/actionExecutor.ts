// Action executor (Phase 2.2).
//
// Walks a flow's WidgetAction tree and dispatches each action via its
// kind-specific handler. Top-level (parentId = null) actions run in
// `order`. CONDITIONAL actions gate their children — children run
// only when the gate returns OK.
//
// Every action's outcome writes one EngineActionEvent row for the
// usage meter + future billing. Failures are caught and logged but
// do NOT abort the rest of the action tree (one broken email
// shouldn't stop a refund from firing). A future "stopOnError" flag
// could opt into stricter semantics.

import prisma from '../../prisma';
import { recordEngineAction } from './metering';
import { getActionHandler } from './actionHandlers';
import type {
  ActionExecutionContext,
  LoadedAction,
} from './actionHandlers/types';
import type { EvaluationContext } from './expressionEvaluator';

/**
 * Recursively load a flow's full action tree, ordered by `order`
 * at every level. Single query (Prisma's nested include handles the
 * tree because we cap depth — see comment in include shape).
 *
 * Cap depth at 5 levels for v1. Real-world flows shouldn't nest more
 * than 2-3 CONDITIONALs deep; the cap exists to bound query cost +
 * runtime tree traversal.
 */
export async function loadFlowActions(flowId: string): Promise<LoadedAction[]> {
  const rows = await prisma.widgetAction.findMany({
    where: { flowId },
    orderBy: { order: 'asc' },
  });

  // Build the tree in-memory: O(n) two-pass. Simpler than Prisma's
  // recursive include + works for arbitrary depth.
  const byId = new Map<string, LoadedAction>();
  const roots: LoadedAction[] = [];
  for (const row of rows) {
    byId.set(row.id, { ...row, children: [] });
  }
  for (const row of rows) {
    const node = byId.get(row.id)!;
    if (row.parentId == null) {
      roots.push(node);
    } else {
      const parent = byId.get(row.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphan — parent was deleted but the row dangled. Treat as
        // root so it still runs; log for audit.
        console.warn(
          `[engine:actions] orphaned action ${row.id} (parentId=${row.parentId} missing) — running as root`,
        );
        roots.push(node);
      }
    }
  }

  // Sort children by order (Prisma's orderBy only handled the flat
  // result; per-parent sort is in-memory).
  for (const node of byId.values()) {
    node.children.sort((a, b) => a.order - b.order);
  }

  return roots.sort((a, b) => a.order - b.order);
}

/**
 * Walk + execute an action tree.
 *
 * Per-action behavior:
 *   - Unknown kind → log + record SKIPPED metering (admin used a
 *     not-yet-shipped action kind; don't crash the run).
 *   - validateConfig() fails → record ERROR + skip children.
 *   - execute() returns OK → record OK + recurse into children.
 *   - execute() returns SKIPPED → record SKIPPED + skip children
 *     (CONDITIONAL's gate-false path).
 *   - execute() returns ERROR or throws → record ERROR + skip
 *     children (children might depend on the failed action's output).
 *
 * The tree walk is sequential — actions might depend on side effects
 * of prior actions (an email might confirm a refund). Parallel exec
 * is an opt-in future flag.
 */
export async function executeActionTree(
  actions: LoadedAction[],
  context: ActionExecutionContext,
): Promise<void> {
  for (const action of actions) {
    const t0 = Date.now();
    const handler = getActionHandler(action.kind);

    if (!handler) {
      console.warn(
        `[engine:actions] unknown action kind "${action.kind}" — skipping`,
      );
      await recordEngineAction({
        organizationId: context.organizationId,
        flowId: context.flowId,
        runId: context.runId,
        actionKind: action.kind,
        status: 'SKIPPED',
        durationMs: Date.now() - t0,
        errorMessage: 'unknown action kind',
      });
      continue;
    }

    // Pre-flight config validation.
    const configError = handler.validateConfig(action.config);
    if (configError) {
      await recordEngineAction({
        organizationId: context.organizationId,
        flowId: context.flowId,
        runId: context.runId,
        actionKind: action.kind,
        status: 'ERROR',
        durationMs: Date.now() - t0,
        errorMessage: `config: ${configError}`,
      });
      continue;
    }

    let result;
    try {
      result = await handler.execute(action, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordEngineAction({
        organizationId: context.organizationId,
        flowId: context.flowId,
        runId: context.runId,
        actionKind: action.kind,
        status: 'ERROR',
        durationMs: Date.now() - t0,
        errorMessage: message,
      });
      continue;
    }

    await recordEngineAction({
      organizationId: context.organizationId,
      flowId: context.flowId,
      runId: context.runId,
      actionKind: action.kind,
      status: result.status,
      durationMs: Date.now() - t0,
      errorMessage:
        result.status === 'OK'
          ? undefined
          : result.status === 'SKIPPED'
            ? result.reason
            : result.message,
    });

    // Recurse into children only on OK (CONDITIONAL gate passed) AND
    // when the action actually has children. SEND_EMAIL etc. have no
    // children — the iteration just skips the recursive call.
    if (result.status === 'OK' && action.children.length > 0) {
      await executeActionTree(action.children, context);
    }
  }
}

/**
 * Convenience entry point used by flowEngine.submitStep after a
 * BOOKING run reaches COMPLETED. Loads the tree, builds the context,
 * and walks it. Failures are swallowed (logged via recordEngineAction)
 * so a flaky action never breaks the visitor's COMPLETED view.
 */
export async function fireFlowCompletionActions(params: {
  organizationId: string;
  flowId: string;
  runId: string;
  vars: Record<string, unknown>;
}): Promise<void> {
  try {
    const actions = await loadFlowActions(params.flowId);
    if (actions.length === 0) return;

    const evaluationContext: EvaluationContext = {
      vars: params.vars,
      now: new Date().toISOString(),
      org: { id: params.organizationId },
    };

    await executeActionTree(actions, {
      organizationId: params.organizationId,
      flowId: params.flowId,
      runId: params.runId,
      evaluationContext,
    });
  } catch (err) {
    // Top-level swallow — every per-action failure is already
    // recorded. This catches structural errors (DB outage during
    // loadFlowActions, etc.) — log without re-throwing so the
    // visitor's COMPLETED state still ships back to the browser.
    console.error('[engine:actions] tree execution failed:', err);
  }
}
