// v2-native SINGLE_SELECT handler (Phase 3.5).
//
// Migrated from the legacy stepHandlers/singleSelect.ts when the v1
// engine was retired. Same config + submission shape as v1 so existing
// flows keep working without re-authoring.
//
// Config shape (WidgetNode.config):
//   {
//     "varName": "<vars.X to write into>",
//     "options": [{ "value": "string", "label": "string" }, ...]
//   }
//
// Submission shape: { selected: "<one of options[].value>" }

import type { StepSubmission, ValidationError } from '../types';
import type { NodeHandler } from './index';

type SingleSelectConfig = {
  varName: string;
  options: { value: string; label: string }[];
};

function readConfig(node: { id: string; config: unknown }): SingleSelectConfig {
  const raw = node.config as unknown;
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof (raw as { varName?: unknown }).varName !== 'string' ||
    !Array.isArray((raw as { options?: unknown }).options)
  ) {
    throw new Error(
      `[engine] SINGLE_SELECT node ${node.id} has malformed config — ` +
        `expected { varName: string, options: [{value, label}] }`,
    );
  }
  return raw as SingleSelectConfig;
}

export const singleSelectNodeHandler: NodeHandler = {
  kind: 'SINGLE_SELECT',
  category: 'UI',

  validateConfig(config) {
    if (config == null) return null; // empty config tolerated during drafting
    if (typeof config !== 'object' || Array.isArray(config)) {
      return 'SINGLE_SELECT config must be an object';
    }
    const c = config as { varName?: unknown; options?: unknown };
    if (c.varName !== undefined && typeof c.varName !== 'string') {
      return 'SINGLE_SELECT config.varName must be a string';
    }
    if (c.options !== undefined && !Array.isArray(c.options)) {
      return 'SINGLE_SELECT config.options must be an array';
    }
    return null;
  },

  validateSubmission(submission: StepSubmission, node): ValidationError[] {
    const config = readConfig(node);
    const selected = submission.values?.selected;

    if (typeof selected !== 'string' || selected.length === 0) {
      return [
        { field: 'selected', message: 'Veuillez sélectionner une option.' },
      ];
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

  applySubmission(submission, node, currentVars) {
    const config = readConfig(node);
    const selected = submission.values.selected as string;
    return { ...currentVars, [config.varName]: selected };
  },
};
