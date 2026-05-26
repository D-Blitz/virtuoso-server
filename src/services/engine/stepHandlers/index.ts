// Step handler registry (Phase 2.0 Commit 2).
//
// Maps WidgetStepKind values to their handler implementations. The
// engine looks up by kind; missing kinds throw at runtime (the schema
// allows 17 kinds but Commit 2 only wires three — the rest land in
// later commits / phases).
//
// Phase 2.0 Commit 2:  SINGLE_SELECT, FORM, RECAP
// Phase 2.2:           STRIPE_CHECKOUT (needs Payment integration)
// Phase 2.5+:          MULTI_SELECT, TEXT_INPUT, EMAIL, PHONE, NUMBER,
//                      DATE_PICKER, TIME_PICKER, SLOT_PICKER, etc.

import type { WidgetStepKind } from '@prisma/client';
import type { StepHandler } from '../types';

import { singleSelectHandler } from './singleSelect';
import { formHandler } from './form';
import { recapHandler } from './recap';

// Partial because not every WidgetStepKind has a handler yet. The
// engine surfaces missing kinds as a clear error instead of silently
// no-oping.
export const stepHandlers: Partial<Record<WidgetStepKind, StepHandler>> = {
  SINGLE_SELECT: singleSelectHandler,
  FORM: formHandler,
  RECAP: recapHandler,
};

export function getStepHandler(kind: WidgetStepKind): StepHandler {
  const handler = stepHandlers[kind];
  if (!handler) {
    throw new Error(
      `[engine] No handler for step kind "${kind}". ` +
        `Only SINGLE_SELECT, FORM, and RECAP are supported in Phase 2.0 Commit 2.`,
    );
  }
  return handler;
}
