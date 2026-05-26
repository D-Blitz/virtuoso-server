// CONDITIONAL action handler (Phase 2.2).
//
// Config shape:
//   { "condition": <JSONLogic expression> }
//
// Behavior: evaluates `condition` against the run's evaluation
// context. If truthy, the executor walks the action's children. If
// falsy, the executor skips the entire child subtree.
//
// This handler's execute() only signals the gate's outcome via its
// return shape; the EXECUTOR (actionExecutor.ts) is responsible for
// reading the result + dispatching children. Keeps the tree-walking
// concentrated in one place.

import { evaluate } from '../expressionEvaluator';
import type { ActionHandler, ActionResult } from './types';

type ConditionalConfig = {
  condition: unknown;
};

export const conditionalHandler: ActionHandler = {
  kind: 'CONDITIONAL',

  validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return 'CONDITIONAL config must be an object';
    }
    const c = config as Record<string, unknown>;
    if (c.condition === undefined) {
      return 'CONDITIONAL config.condition is required';
    }
    // Don't deep-validate the expression here — the evaluator's own
    // size/depth checks fire at execute time.
    return null;
  },

  async execute(action, context): Promise<ActionResult> {
    const cfg = action.config as unknown as ConditionalConfig;
    const result = evaluate(cfg.condition, context.evaluationContext);
    if (Boolean(result)) {
      // Children execution is the executor's job (it has the tree
      // walk). OK signals "gate passed; please run children".
      return { status: 'OK' };
    }
    return {
      status: 'SKIPPED',
      reason: 'condition evaluated to false',
    };
  },
};
