// Template interpolation for the engine's action handlers
// (Phase 2.2).
//
// Replaces `{vars.X}`, `{run.Y}`, `{org.Z}` placeholders in admin-
// authored email subjects + bodies with values from the run context.
//
// Format: `{path.to.value}` — dot-path lookup against a flat-ish
// context object. Missing paths render as empty string (NOT the
// literal `{vars.X}` placeholder) so the visitor never sees raw
// template syntax in a delivered email.
//
// Intentionally minimal — no conditionals, no loops. Anything more
// complex belongs in JSONLogic via a CONDITIONAL action gate.

import type { EvaluationContext } from '../expressionEvaluator';

/**
 * Look up `path` (e.g. "vars.firstname" or "org.id") against a
 * deeply-nested context object. Returns undefined for missing paths.
 */
function lookup(context: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let value: unknown = context;
  for (const segment of segments) {
    if (value == null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/**
 * Coerce arbitrary values to a string fit for plaintext substitution.
 * null/undefined → ""; objects → JSON.stringify; primitives → String(v).
 */
function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9_.]*)\}/g;

/**
 * Substitute `{path}` placeholders in `template` with looked-up
 * values from `context`. Safe against XSS at THIS layer (no html
 * escaping done) — callers that emit html should pre-escape their
 * values before constructing the template, OR pass an html-escaped
 * `template` and trust the substitutions to be plaintext.
 *
 * For SEND_EMAIL: the admin writes raw html in the body template.
 * Substitutions get inserted raw. If a visitor's submitted value
 * contains html, it'll render. For v1 this is acceptable — the
 * admin owns both the template and the field validation that
 * shapes the variables; production-grade XSS hardening can layer
 * on later with a per-action "escape strategy" flag.
 */
export function interpolate(
  template: string,
  context: EvaluationContext,
): string {
  return template.replace(PLACEHOLDER_RE, (_match, path: string) => {
    const value = lookup(context as Record<string, unknown>, path);
    return stringify(value);
  });
}
