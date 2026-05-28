// v2-native RECAP handler (Phase 3.5).
//
// Migrated from the legacy stepHandlers/recap.ts when the v1 engine
// was retired. Read-only summary of captured vars — the submission is
// just a "confirm" signal so there's nothing to validate and no vars
// to write. Typically the last node before COMPLETED.
//
// The display layer (visitor renderer) reads WidgetNode.config to know
// which vars to show. The engine doesn't care about that — it only
// knows the visitor pressed "confirmer".

import type { NodeHandler } from './index';

export const recapNodeHandler: NodeHandler = {
  kind: 'RECAP',
  category: 'UI',

  validateConfig() {
    return null;
  },

  validateSubmission() {
    return [];
  },

  applySubmission(_submission, _node, currentVars) {
    return currentVars;
  },
};
