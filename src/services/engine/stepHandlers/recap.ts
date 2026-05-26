// Step handler: RECAP (Phase 2.0 Commit 2).
//
// Read-only summary of captured vars. The submission is just a
// "confirm" signal — there's nothing to validate and no new vars to
// write. Typically the last step before COMPLETED.
//
// The display layer (Commit 4 admin viewer + Commit 3 public API)
// reads WidgetStep.config to know which vars to show. Engine doesn't
// care about that side; it only knows the visitor pressed "confirmer".
//
// Submission shape: {} — anything sent is silently ignored.

import type { StepHandler, StepSubmission, StepWithFields, ValidationError } from '../types';

export const recapHandler: StepHandler<'RECAP'> = {
  kind: 'RECAP',

  validate(_submission: StepSubmission, _step: StepWithFields): ValidationError[] {
    return [];
  },

  apply(
    _submission: StepSubmission,
    _step: StepWithFields,
    currentVars: Record<string, unknown>,
  ): Record<string, unknown> {
    return currentVars;
  },
};
