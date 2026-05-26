// Step handler: SINGLE_SELECT (Phase 2.0 Commit 2).
//
// Visitor picks exactly one option from a fixed list. Used for service
// picker, level picker, single-pick category questions.
//
// Config shape (WidgetStep.config Json):
//   {
//     "varName": "<vars.X to write into>",
//     "options": [{ "value": "string", "label": "string" }, ...]
//   }
//
// Submission shape:
//   { selected: "<one of options[].value>" }
//
// Future evolution: optionsExpr (dynamic option list from JSONLogic
// against ctx.facilitators / ctx.services) lands in Phase 2.1. For
// v1, options is hardcoded in the flow config.

import type { StepHandler, StepSubmission, StepWithFields, ValidationError } from '../types';

type SingleSelectConfig = {
  varName: string;
  options: { value: string; label: string }[];
};

function parseConfig(step: StepWithFields): SingleSelectConfig {
  const raw = step.config as unknown;
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof (raw as any).varName !== 'string' ||
    !Array.isArray((raw as any).options)
  ) {
    throw new Error(
      `[engine] SINGLE_SELECT step ${step.id} has malformed config — ` +
        `expected { varName: string, options: [{value, label}] }`,
    );
  }
  return raw as SingleSelectConfig;
}

export const singleSelectHandler: StepHandler<'SINGLE_SELECT'> = {
  kind: 'SINGLE_SELECT',

  validate(submission: StepSubmission, step: StepWithFields): ValidationError[] {
    const config = parseConfig(step);
    const selected = submission.values?.selected;

    if (typeof selected !== 'string' || selected.length === 0) {
      return [{ field: 'selected', message: 'Veuillez sélectionner une option.' }];
    }

    const known = config.options.some((o) => o.value === selected);
    if (!known) {
      return [
        {
          field: 'selected',
          message: `La valeur "${selected}" n'est pas une option valide.`,
        },
      ];
    }

    return [];
  },

  apply(
    submission: StepSubmission,
    step: StepWithFields,
    currentVars: Record<string, unknown>,
  ): Record<string, unknown> {
    const config = parseConfig(step);
    const selected = submission.values.selected as string;
    return { ...currentVars, [config.varName]: selected };
  },
};
