// JSONLogic expression evaluator (Phase 2.1).
//
// Thin wrapper around json-logic-js with three layers of safety:
//   1. Size + depth limits at parse time — refuse expressions that
//      would take too long to evaluate (cheap upfront vs expensive
//      runtime guess).
//   2. Custom op registry — extends the stock vocabulary with a
//      handful of helpers the engine specifically needs (count, sum,
//      avg, formatDate, diffMinutes). Future phases extend this with
//      entityRef + customField when the corresponding storage lands.
//   3. Wall-clock measurement around each eval — logs a warning when
//      an expression exceeds 50ms (warning) or 500ms (hard cap —
//      anything past that is a runaway expression). The 500ms cap is
//      a measured threshold, NOT enforced via thread interruption
//      (json-logic-js is synchronous; true CPU timeout would need
//      worker threads). The pre-eval size/depth limits are the real
//      defense; the wall-clock check is monitoring.
//
// See WORKFLOW_ENGINE_DESIGN.md §6 for the locked op vocabulary and
// the rationale for choosing JSONLogic over alternatives.

import jsonLogic from 'json-logic-js';

// ─── Limits ───────────────────────────────────────────────────────

/** Max bytes when serialized — guards against pathological payloads. */
const MAX_EXPR_BYTES = 8 * 1024;
/** Max nesting depth — bounds eval recursion. */
const MAX_EXPR_DEPTH = 20;
/** Soft duration threshold — log a warning if any eval exceeds this. */
const SOFT_DURATION_MS = 50;
/** Hard duration ceiling — log an error if exceeded; future revisions
 * may auto-disable the offending flow. */
const HARD_DURATION_MS = 500;

// ─── Custom op registration (idempotent) ──────────────────────────

let opsRegistered = false;

function registerCustomOps(): void {
  if (opsRegistered) return;

  /**
   * count(list) → number
   * Length of an array. Tolerates non-array input (returns 0).
   */
  jsonLogic.add_operation('count', (list: unknown) =>
    Array.isArray(list) ? list.length : 0,
  );

  /**
   * sum(list) → number
   * sum(list, expr) → number
   *
   * Single-arg form: sums each element (assumed numeric, NaN-tolerant).
   * Two-arg form: applies `expr` to each element and sums the results.
   * Useful for "total of (line item × quantity)" patterns.
   */
  jsonLogic.add_operation('sum', (list: unknown, expr?: unknown) => {
    if (!Array.isArray(list)) return 0;
    if (expr === undefined) {
      return list.reduce(
        (acc: number, v: unknown) => acc + (typeof v === 'number' ? v : 0),
        0,
      );
    }
    return list.reduce((acc: number, item: unknown) => {
      const evaluated = jsonLogic.apply(expr as object, item as object);
      return acc + (typeof evaluated === 'number' ? evaluated : 0);
    }, 0);
  });

  /**
   * avg(list) → number | null
   * avg(list, expr) → number | null
   *
   * Mean of a numeric list. Returns null for empty input rather than
   * NaN so admins can guard with `== null`.
   */
  jsonLogic.add_operation('avg', (list: unknown, expr?: unknown) => {
    if (!Array.isArray(list) || list.length === 0) return null;
    if (expr === undefined) {
      const total = list.reduce(
        (acc: number, v: unknown) => acc + (typeof v === 'number' ? v : 0),
        0,
      );
      return total / list.length;
    }
    const total = list.reduce((acc: number, item: unknown) => {
      const evaluated = jsonLogic.apply(expr as object, item as object);
      return acc + (typeof evaluated === 'number' ? evaluated : 0);
    }, 0);
    return total / list.length;
  });

  /**
   * formatDate(input, format) → string
   *
   * Format an ISO date string or Date object using a small subset of
   * tokens: YYYY MM DD HH mm. Locale-agnostic — for locale-aware
   * formatting use the future `localizedDate` op (Phase 2.2+).
   */
  jsonLogic.add_operation('formatDate', (input: unknown, format: unknown) => {
    const d =
      typeof input === 'string'
        ? new Date(input)
        : input instanceof Date
          ? input
          : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    const fmt = typeof format === 'string' ? format : 'YYYY-MM-DD';
    const pad = (n: number) => String(n).padStart(2, '0');
    return fmt
      .replace('YYYY', String(d.getFullYear()))
      .replace('MM', pad(d.getMonth() + 1))
      .replace('DD', pad(d.getDate()))
      .replace('HH', pad(d.getHours()))
      .replace('mm', pad(d.getMinutes()));
  });

  /**
   * diffMinutes(a, b) → number
   *
   * Minutes between two date-like inputs (a - b). Useful for cutoff
   * conditions like "refund eligible only if cancellation > 48h
   * before start".
   */
  jsonLogic.add_operation('diffMinutes', (a: unknown, b: unknown) => {
    const toMs = (input: unknown): number | null => {
      if (typeof input === 'string') {
        const t = new Date(input).getTime();
        return Number.isNaN(t) ? null : t;
      }
      if (input instanceof Date) return input.getTime();
      if (typeof input === 'number') return input;
      return null;
    };
    const ma = toMs(a);
    const mb = toMs(b);
    if (ma == null || mb == null) return 0;
    return Math.floor((ma - mb) / 60_000);
  });

  opsRegistered = true;
}

// Register at module load so callers don't need to remember to call it.
registerCustomOps();

// ─── Limits enforcement ───────────────────────────────────────────

function exprDepth(value: unknown, depth = 0): number {
  if (depth > MAX_EXPR_DEPTH) return depth;
  if (value == null) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const v of value) max = Math.max(max, exprDepth(v, depth + 1));
    return max;
  }
  if (typeof value === 'object') {
    let max = depth;
    for (const v of Object.values(value)) {
      max = Math.max(max, exprDepth(v, depth + 1));
    }
    return max;
  }
  return depth;
}

function exprSize(value: unknown): number {
  // Approximate — JSON.stringify is fine here, the limit is generous.
  try {
    return JSON.stringify(value).length;
  } catch {
    return Infinity;
  }
}

// ─── Public API ───────────────────────────────────────────────────

export class ExpressionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'EXPR_TOO_LARGE'
      | 'EXPR_TOO_DEEP'
      | 'EXPR_EVAL_FAILED',
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/**
 * Context shape passed to every evaluation. Stable contract for flow
 * authors; new fields are additive.
 *
 *   vars  — captured values from the run (vars.<varName>)
 *   now   — current ISO timestamp (for time-based conditions)
 *   org   — basic org info (no PII, no secrets)
 *
 * Future phases extend with:
 *   ctx.facilitators, ctx.services (Phase 2.5)
 *   ctx.event (Phase 2.2 — for EVENT_REACTION flows)
 */
export type EvaluationContext = {
  vars: Record<string, unknown>;
  now?: string;
  org?: {
    id: string;
    locale?: string;
    timezone?: string;
    currency?: string;
  };
  /** Allow flow-specific extras without breaking the type. */
  [key: string]: unknown;
};

/**
 * Evaluate a JSONLogic expression against a context.
 *
 * Returns the raw result (boolean / number / string / object as
 * defined by the expression). The caller is responsible for coercing
 * to the expected shape (e.g. visibleWhen consumers call
 * `Boolean(evaluate(...))`).
 *
 * Throws ExpressionError on:
 *   - oversized payload (>8KB serialized)
 *   - over-deep nesting (>20 levels)
 *   - eval failures from json-logic-js (malformed operator, etc.)
 */
export function evaluate(
  expression: unknown,
  context: EvaluationContext,
): unknown {
  // Empty / null expressions are treated as `true` — useful default
  // for visibleWhen (no condition = always visible).
  if (expression == null) return true;

  // ── Pre-eval size + depth check.
  const size = exprSize(expression);
  if (size > MAX_EXPR_BYTES) {
    throw new ExpressionError(
      `Expression too large (${size} bytes, max ${MAX_EXPR_BYTES})`,
      'EXPR_TOO_LARGE',
    );
  }
  const depth = exprDepth(expression);
  if (depth > MAX_EXPR_DEPTH) {
    throw new ExpressionError(
      `Expression too deep (${depth} levels, max ${MAX_EXPR_DEPTH})`,
      'EXPR_TOO_DEEP',
    );
  }

  // ── Eval with wall-clock measurement.
  const t0 = Date.now();
  let result: unknown;
  try {
    result = jsonLogic.apply(expression as object, context as object);
  } catch (err) {
    throw new ExpressionError(
      `Evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      'EXPR_EVAL_FAILED',
    );
  }
  const elapsed = Date.now() - t0;

  if (elapsed > HARD_DURATION_MS) {
    console.error(
      `[engine:expression] eval took ${elapsed}ms (hard cap ${HARD_DURATION_MS}ms) — flow may need review`,
    );
  } else if (elapsed > SOFT_DURATION_MS) {
    console.warn(
      `[engine:expression] slow eval: ${elapsed}ms (soft threshold ${SOFT_DURATION_MS}ms)`,
    );
  }

  return result;
}

/**
 * Specialized for step visibility: evaluates the expression and
 * coerces the result to boolean. Empty expression = visible.
 *
 * Catches ExpressionError and logs it, returning `true` (= visible)
 * as a safe default. A broken visibility expression should NOT hide a
 * step silently — admins would have no way to debug. Future: surface
 * the error in the Activity feed so admins can find broken flows.
 */
export function isStepVisible(
  expression: unknown,
  context: EvaluationContext,
): boolean {
  if (expression == null) return true;
  try {
    const result = evaluate(expression, context);
    return Boolean(result);
  } catch (err) {
    console.error('[engine:expression] visibility eval failed:', err);
    return true;
  }
}
