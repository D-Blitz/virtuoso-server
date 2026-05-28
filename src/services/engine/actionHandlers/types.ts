// Action handler internal types.
//
// One handler per action `kind` value. Handlers are async (they hit
// outbound services like Resend) and return either OK or an error
// description. The v2 graph runtime (graphRuntime.ts) wraps them
// inside the unified node-handler dispatch.

import type { Prisma } from '@prisma/client';
import type { EvaluationContext } from '../expressionEvaluator';

/**
 * Loaded action input. Structurally compatible with v2 WidgetNode
 * (id / kind / config / flowId) so the runtime can pass node rows
 * directly. The Phase 2.2 tree-shaped LoadedAction has been retired
 * with the v1 WidgetAction table (Phase 3.5) — handlers see one
 * action at a time + ignore `children`. The field is kept on the
 * type so a hypothetical future "sub-tree action" can repopulate it
 * without breaking handler signatures.
 */
export type LoadedAction = {
  id: string;
  flowId: string;
  kind: string;
  config: Prisma.JsonValue;
  children?: LoadedAction[];
};

/**
 * Context handed to every handler. flowId + organizationId + runId
 * are surfaced for metering and audit; vars + the rest of the
 * evaluation context come from the run.
 */
export type ActionExecutionContext = {
  organizationId: string;
  flowId: string;
  runId: string | null;
  /** Built from buildEvaluationContext in the engine. */
  evaluationContext: EvaluationContext;
};

export type ActionResult =
  | { status: 'OK' }
  | { status: 'SKIPPED'; reason: string }
  | { status: 'ERROR'; message: string };

export type ActionHandler = {
  readonly kind: string;
  /**
   * Validate the action's config WITHOUT side effects. Returns null
   * if valid, an error string otherwise. Called once before execute()
   * so configuration bugs surface as ERROR + a clear message.
   */
  validateConfig(config: Prisma.JsonValue): string | null;
  /**
   * Run the action. Throwing is OK — the executor catches + records
   * as ERROR. Returning {status: 'SKIPPED'} signals "no-op" without
   * a metering failure (used by CONDITIONAL when the gate is false).
   */
  execute(
    action: LoadedAction,
    context: ActionExecutionContext,
  ): Promise<ActionResult>;
};
