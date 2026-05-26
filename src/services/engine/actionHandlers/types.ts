// Action handler internal types (Phase 2.2).
//
// One handler per action `kind` value. Handlers are async (they hit
// outbound services like Resend) and return either OK or an error
// description. The executor wraps them in metering writes.

import type { Prisma, WidgetAction } from '@prisma/client';
import type { EvaluationContext } from '../expressionEvaluator';

/**
 * Loaded WidgetAction tree — children pre-fetched and ordered by
 * order asc. Handlers only see their own action; the executor walks
 * the tree.
 */
export type LoadedAction = WidgetAction & {
  children: LoadedAction[];
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
