// Step handler: FORM (Phase 2.0 Commit 2).
//
// Composite step with multiple WidgetField children. Each field has a
// kind (TEXT / EMAIL / NUMBER / DATE / BOOLEAN / SELECT / etc.) and a
// binding that determines where the captured value lands at submit.
//
// Bindings supported in Commit 2:
//   VAR          ✅  writes into vars[bindingTarget]
//   DB_COLUMN    ⏸️   deferred to Commit 2.2 (writes via UPDATE_ENTITY)
//   CUSTOM_FIELD ⏸️   deferred to Commit 2.5a (needs CustomFieldDefinition)
//
// Non-VAR bindings reach validate() and pass through (we don't reject
// the flow author for using a feature that isn't wired yet) but their
// values are not persisted in apply(). Commit 2.2/2.5a will retire
// that gap.
//
// Submission shape:
//   { "<bindingTarget1>": "value1", "<bindingTarget2>": 42, ... }

import type { WidgetField, WidgetFieldKind } from '@prisma/client';
import type { StepHandler, StepSubmission, StepWithFields, ValidationError } from '../types';

// Email regex matching the rest of the codebase's loose-but-defensible
// "looks like an email" check. Server-side; we're not enforcing RFC
// 5322 — just ruling out the obvious junk.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateField(field: WidgetField, raw: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  const present = raw !== undefined && raw !== null && raw !== '';

  if (field.required && !present) {
    errors.push({ field: field.bindingTarget, message: `${field.label} est requis.` });
    return errors; // don't bother type-checking missing values
  }

  if (!present) {
    return errors; // optional + empty is fine
  }

  // Type checks per kind. Each kind validates raw against its expected
  // primitive shape. Failures produce a single field-scoped error.
  const kindCheck = (kind: WidgetFieldKind): string | null => {
    switch (kind) {
      case 'TEXT':
      case 'TEXTAREA':
        return typeof raw === 'string' ? null : 'doit être du texte';
      case 'EMAIL':
        return typeof raw === 'string' && EMAIL_RE.test(raw)
          ? null
          : "n'est pas une adresse email valide";
      case 'PHONE':
        // Loose: any string with at least 6 digits. Real phone parsing
        // (libphonenumber) is heavy and locale-specific; can layer on
        // later if needed.
        return typeof raw === 'string' && (raw.match(/\d/g)?.length ?? 0) >= 6
          ? null
          : "n'est pas un numéro de téléphone valide";
      case 'NUMBER':
        return typeof raw === 'number' && Number.isFinite(raw)
          ? null
          : 'doit être un nombre';
      case 'DATE':
        // Accept ISO date strings (yyyy-mm-dd or full ISO). Reject if
        // Date can't parse it. NaN check covers "Invalid Date".
        if (typeof raw !== 'string') return 'doit être une date (chaîne ISO)';
        return Number.isNaN(new Date(raw).getTime())
          ? "n'est pas une date valide"
          : null;
      case 'BOOLEAN':
        return typeof raw === 'boolean' ? null : 'doit être vrai ou faux';
      case 'SELECT':
        // Options live in field.config.options (same shape as
        // SINGLE_SELECT). Validated below — kindCheck only checks the
        // type here.
        return typeof raw === 'string' ? null : 'doit être une chaîne';
      case 'MULTI_SELECT':
        return Array.isArray(raw) && raw.every((v) => typeof v === 'string')
          ? null
          : 'doit être un tableau de chaînes';
      default: {
        // Exhaustiveness check — adding a new kind without updating
        // this switch produces a TS error at build time.
        const _exhaustive: never = kind;
        return `type de champ inconnu: ${_exhaustive as string}`;
      }
    }
  };

  const typeError = kindCheck(field.kind);
  if (typeError) {
    errors.push({
      field: field.bindingTarget,
      message: `${field.label} ${typeError}.`,
    });
    return errors;
  }

  // SELECT / MULTI_SELECT: check membership in field.config.options.
  if (field.kind === 'SELECT' || field.kind === 'MULTI_SELECT') {
    const config = field.config as unknown;
    const options =
      config && typeof config === 'object' && Array.isArray((config as any).options)
        ? ((config as any).options as { value: string }[])
        : [];

    if (options.length === 0) {
      // Misconfigured field — refuse rather than silently accepting any
      // value. Surfaces during admin flow building.
      errors.push({
        field: field.bindingTarget,
        message: `${field.label} : configuration manquante (aucune option définie).`,
      });
      return errors;
    }

    const validValues = new Set(options.map((o) => o.value));
    const submitted = field.kind === 'SELECT' ? [raw as string] : (raw as string[]);
    const invalid = submitted.filter((v) => !validValues.has(v));
    if (invalid.length > 0) {
      errors.push({
        field: field.bindingTarget,
        message: `${field.label} : valeur(s) invalide(s) ${invalid.join(', ')}.`,
      });
    }
  }

  return errors;
}

export const formHandler: StepHandler<'FORM'> = {
  kind: 'FORM',

  validate(submission: StepSubmission, step: StepWithFields): ValidationError[] {
    const errors: ValidationError[] = [];
    for (const field of step.fields) {
      const raw = submission.values?.[field.bindingTarget];
      errors.push(...validateField(field, raw));
    }
    return errors;
  },

  apply(
    submission: StepSubmission,
    step: StepWithFields,
    currentVars: Record<string, unknown>,
  ): Record<string, unknown> {
    const next: Record<string, unknown> = { ...currentVars };
    for (const field of step.fields) {
      const raw = submission.values?.[field.bindingTarget];
      // VAR binding writes into the run's vars namespace. Other
      // bindings are deferred (see file header) — skip silently for
      // now; admin gets a "feature not wired" surface later.
      if (field.binding === 'VAR' && raw !== undefined) {
        next[field.bindingTarget] = raw;
      }
    }
    return next;
  },
};
